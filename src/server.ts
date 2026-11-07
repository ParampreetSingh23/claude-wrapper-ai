import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import fastifyJwt from "@fastify/jwt";
import type Anthropic from "@anthropic-ai/sdk";
import { openDb } from "./db.ts";
import type { Client, GroupBy, Provider } from "./db.ts";
import { costUsd, createKeyPool, UpstreamError } from "./claude.ts";
import { createTotpVerifier } from "./totp.ts";
import { createOpenAIService, OpenAIError } from "./openai.ts";

const env = process.env;
const optionalNumber = (v: string | undefined) => (v ? Number(v) : null);

// REAL_KEY_1, REAL_KEY_2, ... in number order. ANTHROPIC_API_KEY alone still works (as real key 1).
const realKeys = Object.keys(env)
  .filter((k) => /^REAL_KEY_\d+$/.test(k) && env[k])
  .sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
  .map((k) => env[k]!);
if (!realKeys.length && env.ANTHROPIC_API_KEY) realKeys.push(env.ANTHROPIC_API_KEY);

// Server-side refusal fallbacks only exist on these models; sending the parameter to others (e.g. Haiku) is rejected.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const model = env.CLAUDE_MODEL ?? "claude-opus-5-5";

const config = {
  port: Number(env.PORT ?? 3000),
  dbPath: env.DB_PATH ?? "./data/gateway.db",
  allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  model,
  maxTokens: Number(env.CLAUDE_MAX_TOKENS ?? 16000),
  effort: (env.CLAUDE_EFFORT || undefined) as Anthropic.OutputConfig["effort"], // low | medium | high | xhigh | max
  // "default" = reroute refused requests server-side; empty = off. Ignored on models without fallback support.
  fallbacks: env.CLAUDE_FALLBACKS === "default" && FALLBACK_MODELS.has(model),
  timeoutMs: Number(env.CLAUDE_TIMEOUT_MS ?? 600000),
  defaultSystemPrompt: env.DEFAULT_SYSTEM_PROMPT || undefined,
  maxPromptChars: Number(env.MAX_PROMPT_CHARS ?? 50000),
  jwtSecret: env.JWT_SECRET ?? "",
  tokenTtlMinutes: Number(env.TOKEN_TTL_MINUTES ?? 60),
  adminId: env.ADMIN_ID ?? "",
  adminSecret: env.ADMIN_SECRET ?? "",
  adminTotpSecret: env.ADMIN_TOTP_SECRET || undefined,
  adminTokenTtlMinutes: Number(env.ADMIN_TOKEN_TTL_MINUTES ?? 15),
  loginMaxFailures: Number(env.LOGIN_MAX_FAILURES ?? 5),
  loginLockoutMinutes: Number(env.LOGIN_LOCKOUT_MINUTES ?? 15),
  // Only "true" behind a reverse proxy you control (Caddy/nginx); otherwise clients could fake their IP.
  trustProxy: env.TRUST_PROXY === "true",
  // One live token per client: a new login cancels the previous token. Set "false" only if several
  // app instances must share one clientId and each logs in on its own.
  oneTokenPerClient: env.ONE_TOKEN_PER_CLIENT !== "false",
  // Limits given to new clients when the admin doesn't set them. Empty = unlimited.
  defaultMonthlyBudgetUsd: optionalNumber(env.DEFAULT_MONTHLY_BUDGET_USD),
  defaultRequestsPerMinute: optionalNumber(env.DEFAULT_REQUESTS_PER_MINUTE),
};

if (!realKeys.length) throw new Error("Set REAL_KEY_1 (and REAL_KEY_2, REAL_KEY_3...) in .env");
if (config.jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
if (!config.adminId || config.adminSecret.length < 24 || /replace|change|secret|password/i.test(config.adminSecret)) {
  throw new Error("ADMIN_ID and a random ADMIN_SECRET (at least 24 characters, e.g. `openssl rand -hex 32`) must be set in .env");
}
const verifyAdminTotp = config.adminTotpSecret ? createTotpVerifier(config.adminTotpSecret) : null;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Constant-time compare of two sha256 hex strings, so response time doesn't leak how much of a secret matched.
const sameHash = (a: string, b: string) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const DUMMY_HASH = sha256("no-such-client"); // compared against when clientId is unknown, so that case takes the same time
const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};
const roundUsd = (n: number) => Math.round(n * 1e8) / 1e8;

const db = openDb(config.dbPath);
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, trustProxy: config.trustProxy });
const pool = createKeyPool(realKeys, config.timeoutMs, (msg, extra) => app.log.warn(extra, msg));
const openaiKeys = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, apiKey: env[`OPENAI_KEY_${i + 1}`]?.trim() || "" }))
  .filter((key) => key.apiKey);
const openai = createOpenAIService(openaiKeys, {
  model: env.OPENAI_MODEL || "gpt-4.1-mini",
  maxTokens: Number(env.OPENAI_MAX_TOKENS || 4096),
  timeoutMs: Number(env.OPENAI_TIMEOUT_MS || 60000),
  baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
});
const adminPage = readFileSync(new URL("./admin.html", import.meta.url), "utf8");

type Role = "admin" | "client";
type TokenPayload = { sub: string; role: Role; jti: string };
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}
declare module "fastify" {
  interface FastifyRequest {
    client: Client | null;
  }
}
app.decorateRequest("client", null);

// HS256 pinned on both sides so a token can't pick a weaker algorithm (e.g. "none").
app.register(fastifyJwt, {
  secret: config.jwtSecret,
  sign: { algorithm: "HS256", expiresIn: `${config.tokenTtlMinutes}m` },
  verify: { algorithms: ["HS256"] },
});

// Browsers always send Origin, so only allowed sites (and the dashboard on this same host) can call from a browser.
// Scripts, Postman and other servers send no Origin; the token is what protects those.
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (!origin) return;
  let sameHost = false;
  try {
    sameHost = new URL(origin).host === req.headers.host;
  } catch {}
  if (!sameHost && !config.allowedOrigins.includes(origin)) {
    return reply.code(403).send({ error: "Origin not allowed" });
  }
  reply.headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    vary: "Origin",
  });
});
app.options("*", async (req, reply) => reply.code(204).send());

app.addHook("onSend", async (req, reply, payload) => {
  reply.headers({
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  // Tokens, secrets and admin data must never land in a browser or proxy cache.
  if (/\/(token|admin)/.test(req.url)) reply.header("cache-control", "no-store");
  return payload;
});

// ---------- login protection ----------

// ponytail: in-memory, per process; a restart clears lockouts. Fine for one server.
const failedLogins = new Map<string, number[]>(); // ip -> failure times
const lockoutMs = config.loginLockoutMinutes * 60_000;

/** Seconds until this IP may try again, or 0. Failures age out; a success does NOT reset them. */
function loginLockedFor(ip: string) {
  const now = Date.now();
  const recent = (failedLogins.get(ip) ?? []).filter((t) => t > now - lockoutMs);
  if (recent.length) failedLogins.set(ip, recent);
  else failedLogins.delete(ip);
  return recent.length >= config.loginMaxFailures ? Math.ceil((recent[0] + lockoutMs - now) / 1000) : 0;
}
function recordLoginFailure(ip: string) {
  if (failedLogins.size > 10_000) failedLogins.clear(); // bound memory under a spray from many IPs
  failedLogins.set(ip, [...(failedLogins.get(ip) ?? []), Date.now()]);
}

// ---------- auth hooks ----------

async function verifyToken(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
    return true;
  } catch (err) {
    const expired = (err as { code?: string }).code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED";
    reply.code(401).send({ error: expired ? "Token expired" : "Missing or invalid token" });
    return false;
  }
}

// Admin isn't in the DB, so its single live token id is kept in memory (a restart signs the admin out).
let adminTokenId: string | null = null;
const REPLACED = { error: "Token replaced by a newer login" };

async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!(await verifyToken(req, reply))) return reply;
  if (req.user.role !== "admin") return reply.code(403).send({ error: "Admin only" });
  if (req.user.jti !== adminTokenId) return reply.code(401).send(REPLACED);
}

// The token proves who you were at login; the DB lookup makes a disable take effect on the very next request.
async function requireClient(req: FastifyRequest, reply: FastifyReply) {
  if (!(await verifyToken(req, reply))) return reply;
  if (req.user.role !== "client") return reply.code(403).send({ error: "Use a client account for this route" });
  const client = db.getClient(req.user.sub);
  if (!client || client.status !== "active") return reply.code(401).send({ error: "Client disabled" });
  // Same DB row also says which token is the current one; any older (or cancelled) token stops here.
  if (config.oneTokenPerClient && req.user.jti !== client.token_id) return reply.code(401).send(REPLACED);
  req.client = client;
}

async function requireOpenAI(req: FastifyRequest, reply: FastifyReply) {
  if (!req.client!.openai_enabled) return reply.code(403).send({ error: "OpenAI access is not enabled for this client" });
}

// ponytail: in-memory sliding window, per process; resets on restart. Move to Redis if you run several instances.
const recentRequests = new Map<string, number[]>();

async function enforceLimits(req: FastifyRequest, reply: FastifyReply) {
  const c = req.client!;
  if (c.monthly_budget_usd !== null) {
    const { spend } = db.spendSince(c.client_id, monthStart());
    if (spend >= c.monthly_budget_usd) {
      return reply.code(402).send({ error: "Monthly budget exceeded", budgetUsd: c.monthly_budget_usd, spentUsd: roundUsd(spend) });
    }
  }
  if (c.requests_per_minute !== null) {
    const now = Date.now();
    const times = (recentRequests.get(c.client_id) ?? []).filter((t) => t > now - 60_000);
    if (times.length >= c.requests_per_minute) {
      recentRequests.set(c.client_id, times);
      const retryAfter = Math.ceil((times[0] + 60_000 - now) / 1000);
      return reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .send({ error: `Rate limit: ${c.requests_per_minute} requests per minute`, retryAfterSeconds: retryAfter });
    }
    times.push(now);
    recentRequests.set(c.client_id, times);
  }
}

// ---------- routes ----------

type TokenBody = { clientId: string; clientSecret: string; otp?: string };
type SendBody = { prompt: string; systemPrompt?: string };
type CreateClientBody = { name: string; monthlyBudgetUsd?: number | null; requestsPerMinute?: number | null; openaiEnabled?: boolean };
type PatchClientBody = {
  name?: string;
  status?: "active" | "disabled";
  monthlyBudgetUsd?: number | null;
  requestsPerMinute?: number | null;
  openaiEnabled?: boolean;
};

const limitProps = {
  monthlyBudgetUsd: { type: ["number", "null"], minimum: 0 },
  requestsPerMinute: { type: ["integer", "null"], minimum: 1 },
};

app.register(
  async (r) => {
    r.get("/health", async () => ({ status: "ok", model: config.model, realKeys: realKeys.length }));

    // Login: clientId + secret (or the admin's) -> token valid TOKEN_TTL_MINUTES.
    r.post<{ Body: TokenBody }>(
      "/token",
      {
        schema: {
          body: {
            type: "object",
            required: ["clientId", "clientSecret"],
            properties: {
              clientId: { type: "string", maxLength: 200 },
              clientSecret: { type: "string", maxLength: 200 },
              otp: { type: "string", maxLength: 10 },
            },
          },
        },
      },
      async (req, reply) => {
        const { clientId, clientSecret, otp } = req.body;
        // Locked IPs are refused before any check, so even the right password can't be confirmed by guessing.
        const wait = loginLockedFor(req.ip);
        if (wait) {
          return reply
            .code(429)
            .header("retry-after", String(wait))
            .send({ error: "Too many failed logins. Try again later.", retryAfterSeconds: wait });
        }
        const fail = (why: string) => {
          recordLoginFailure(req.ip);
          req.log.warn({ ip: req.ip, clientId: clientId.slice(0, 40), why }, "failed login");
          return reply.code(401).send({ error: "Invalid credentials" });
        };

        const given = sha256(clientSecret);
        let role: Role;
        if (clientId === config.adminId) {
          const secretOk = sameHash(given, sha256(config.adminSecret));
          // One generic error so a guesser learns nothing about which credential was wrong.
          const otpOk = verifyAdminTotp ? secretOk && verifyAdminTotp(otp) : true;
          if (!secretOk || !otpOk) return fail(!secretOk ? "admin secret" : "admin otp");
          role = "admin";
        } else {
          const c = db.getClient(clientId);
          const secretOk = sameHash(given, c?.secret_hash ?? DUMMY_HASH);
          if (!c || !secretOk || c.status !== "active") return fail("client credentials");
          role = "client";
        }
        const expiresIn = (role === "admin" ? config.adminTokenTtlMinutes : config.tokenTtlMinutes) * 60;
        // Remembering only the newest token id is what cancels every token issued before it.
        const jti = randomUUID();
        if (role === "admin") adminTokenId = jti;
        else if (config.oneTokenPerClient) db.updateClient(clientId, { token_id: jti });
        return {
          accessToken: await reply.jwtSign({ sub: clientId, role, jti }, { expiresIn }),
          tokenType: "Bearer",
          role,
          expiresIn,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        };
      },
    );

    r.post<{ Body: SendBody }>(
      "/send",
      {
        onRequest: [requireClient, enforceLimits],
        schema: {
          body: {
            type: "object",
            required: ["prompt"],
            additionalProperties: false,
            properties: {
              prompt: { type: "string", minLength: 1, maxLength: config.maxPromptChars },
              systemPrompt: { type: "string", maxLength: config.maxPromptChars },
            },
          },
        },
      },
      async (req, reply) => {
        const client = req.client!;
        const { prompt, systemPrompt } = req.body;
        const startedAt = Date.now();
        const base = { client_id: client.client_id, duration_ms: 0, created_at: "" };

        try {
          const { message, keyId } = await pool.send({
            model: config.model,
            max_tokens: config.maxTokens,
            system: systemPrompt || config.defaultSystemPrompt,
            messages: [{ role: "user", content: prompt }],
            ...(config.effort && { output_config: { effort: config.effort } }),
            ...(config.fallbacks && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
          });

          const timestamp = new Date().toISOString();
          const durationMs = Date.now() - startedAt;
          const u = message.usage;
          const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          const cacheReadTokens = u.cache_read_input_tokens ?? 0;
          let cost = costUsd(message.model, u);
          if (cost === null) {
            req.log.warn({ model: message.model }, "model missing from price table; cost logged as 0");
            cost = 0;
          }
          const refused = message.stop_reason === "refusal";

          db.insertUsage({
            ...base,
            real_key: keyId,
            model: message.model,
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_read_tokens: cacheReadTokens,
            cache_write_tokens: cacheWriteTokens,
            cost_usd: cost,
            duration_ms: durationMs,
            http_status: refused ? 422 : 200,
            created_at: timestamp,
          });
          db.touchClient(client.client_id, timestamp);

          const usage = {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheWriteTokens,
            cacheReadTokens,
            totalTokens: u.input_tokens + cacheWriteTokens + cacheReadTokens + u.output_tokens,
            costUsd: roundUsd(cost),
          };
          if (refused) {
            return reply.code(422).send({ error: "Request declined by model", details: message.stop_details, usage, timestamp, durationMs });
          }

          let output = "";
          for (const block of message.content) if (block.type === "text") output += block.text;
          return { output, model: message.model, stopReason: message.stop_reason, usage, timestamp, durationMs };
        } catch (err) {
          if (!(err instanceof UpstreamError)) throw err;
          const status = err.status === 429 ? 429 : 502;
          req.log.error({ status: err.status, realKey: err.keyId, msg: err.message }, "Anthropic API error");
          // Failed calls are logged too (cost 0) so the dashboard shows error rates per client and per real key.
          db.insertUsage({
            ...base,
            real_key: err.keyId,
            model: config.model,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: 0,
            duration_ms: Date.now() - startedAt,
            http_status: status,
            created_at: new Date().toISOString(),
          });
          // Upstream details (bad model, key problems) stay in the server log.
          return reply.code(status).send({ error: status === 429 ? "All real keys are rate limited, retry later" : "Upstream AI error" });
        }
      },
    );

    r.get("/me/usage", { onRequest: requireClient }, async (req) => {
      const c = req.client!;
      const since = monthStart();
      const { spend, requests } = db.spendSince(c.client_id, since);
      return {
        clientId: c.client_id,
        name: c.name,
        monthStart: since,
        spentUsd: roundUsd(spend),
        requests,
        monthlyBudgetUsd: c.monthly_budget_usd,
        remainingUsd: c.monthly_budget_usd === null ? null : roundUsd(Math.max(0, c.monthly_budget_usd - spend)),
        requestsPerMinute: c.requests_per_minute,
      };
    });

    r.post<{ Body: SendBody }>("/openai/send", {
      onRequest: [requireClient, requireOpenAI],
      preHandler: enforceLimits,
      schema: {
        body: {
          type: "object", required: ["prompt"], additionalProperties: false,
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: config.maxPromptChars },
            systemPrompt: { type: "string", maxLength: config.maxPromptChars },
          },
        },
      },
    }, async (req, reply) => {
      const client = req.client!;
      const startedAt = Date.now();
      try {
        const result = await openai.send(req.body.prompt, req.body.systemPrompt || config.defaultSystemPrompt);
        const timestamp = new Date().toISOString();
        const durationMs = Date.now() - startedAt;
        db.insertUsage({
          provider: "openai", client_id: client.client_id, real_key: result.keyId, model: result.model,
          input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens,
          cache_read_tokens: result.usage.cacheReadTokens, cache_write_tokens: 0,
          cost_usd: result.usage.costUsd, duration_ms: durationMs, http_status: result.httpStatus, created_at: timestamp,
        });
        db.touchClient(client.client_id, timestamp);
        const usage = { ...result.usage, costUsd: roundUsd(result.usage.costUsd) };
        if (result.httpStatus === 422) return reply.code(422).send({ error: "Request declined by model", usage, timestamp, durationMs });
        return { output: result.output, model: result.model, stopReason: result.stopReason, usage, timestamp, durationMs };
      } catch (err) {
        if (!(err instanceof OpenAIError)) throw err;
        const status = err.status === 503 && err.keyId === null ? 503 : err.status === 429 ? 429 : 502;
        req.log.warn({ status: err.status, realKey: err.keyId }, "OpenAI request failed");
        db.insertUsage({
          provider: "openai", client_id: client.client_id, real_key: err.keyId, model: openai.model,
          input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0,
          duration_ms: Date.now() - startedAt, http_status: status, created_at: new Date().toISOString(),
        });
        return reply.code(status).send({ error: status === 503 ? err.message : status === 429 ? "OpenAI keys are rate limited, retry later" : "Upstream AI error" });
      }
    });

    // ---------- admin ----------

    r.get("/admin", async (req, reply) => {
      // Only this response's own inline script may run: blocks injected scripts from stealing the admin token.
      const nonce = randomBytes(16).toString("base64");
      return reply
        .type("text/html")
        .header(
          "content-security-policy",
          [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "style-src 'unsafe-inline' https://fonts.googleapis.com",
            "font-src https://fonts.gstatic.com",
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join("; "),
        )
        .send(adminPage.replace("__CSP_NONCE__", nonce));
    });

    r.register(async (a) => {
      a.addHook("onRequest", requireAdmin);

      a.get("/admin/clients", async () => db.listClients(monthStart()));

      a.post<{ Body: CreateClientBody }>(
        "/admin/clients",
        {
          schema: {
            body: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string", minLength: 1, maxLength: 100 }, openaiEnabled: { type: "boolean" }, ...limitProps },
            },
          },
        },
        async (req, reply) => {
          const { name, monthlyBudgetUsd, requestsPerMinute } = req.body;
          const clientId = `cl_${randomBytes(8).toString("hex")}`;
          const clientSecret = `cs_${randomBytes(32).toString("base64url")}`;
          const client = {
            client_id: clientId,
            name,
            secret_hash: sha256(clientSecret),
            monthly_budget_usd: monthlyBudgetUsd === undefined ? config.defaultMonthlyBudgetUsd : monthlyBudgetUsd,
            requests_per_minute: requestsPerMinute === undefined ? config.defaultRequestsPerMinute : requestsPerMinute,
            created_at: new Date().toISOString(),
          };
          db.insertClient(client);
          if (req.body.openaiEnabled) db.updateClient(clientId, { openai_enabled: 1 });
          return reply.code(201).send({
            clientId,
            clientSecret,
            name,
            monthlyBudgetUsd: client.monthly_budget_usd,
            requestsPerMinute: client.requests_per_minute,
            openaiEnabled: Boolean(req.body.openaiEnabled),
            note: "Store clientSecret now. It is never shown again.",
          });
        },
      );

      a.patch<{ Params: { id: string }; Body: PatchClientBody }>(
        "/admin/clients/:id",
        {
          schema: {
            body: {
              type: "object",
              minProperties: 1,
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
                status: { type: "string", enum: ["active", "disabled"] },
                openaiEnabled: { type: "boolean" },
                ...limitProps,
              },
            },
          },
        },
        async (req, reply) => {
          if (!db.getClient(req.params.id)) return reply.code(404).send({ error: "No such client" });
          const b = req.body;
          db.updateClient(req.params.id, {
            ...(b.name !== undefined && { name: b.name }),
            ...(b.status !== undefined && { status: b.status }),
            ...(b.monthlyBudgetUsd !== undefined && { monthly_budget_usd: b.monthlyBudgetUsd }),
            ...(b.requestsPerMinute !== undefined && { requests_per_minute: b.requestsPerMinute }),
            ...(b.openaiEnabled !== undefined && { openai_enabled: b.openaiEnabled ? 1 : 0 }),
          });
          const { secret_hash, token_id, ...client } = db.getClient(req.params.id)!;
          return client;
        },
      );

      a.post<{ Params: { id: string } }>("/admin/clients/:id/rotate-secret", async (req, reply) => {
        if (!db.getClient(req.params.id)) return reply.code(404).send({ error: "No such client" });
        const clientSecret = `cs_${randomBytes(32).toString("base64url")}`;
        // Clearing token_id also cancels the token already issued with the old secret.
        db.updateClient(req.params.id, { secret_hash: sha256(clientSecret), token_id: null });
        return { clientId: req.params.id, clientSecret, note: "Old secret and its token no longer work. Store this one now." };
      });

      a.get<{ Querystring: { from?: string; to?: string; groupBy?: GroupBy; provider?: Provider } }>(
        "/admin/usage",
        {
          schema: {
            querystring: {
              type: "object",
              properties: {
                from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}" },
                to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}" },
                groupBy: { type: "string", enum: ["client", "realKey", "day", "model", "provider"], default: "client" },
                provider: { type: "string", enum: ["anthropic", "openai"] },
              },
            },
          },
        },
        async (req) => {
          const from = req.query.from ?? monthStart();
          const to = req.query.to ?? "9999-12-31";
          const groupBy = req.query.groupBy ?? "client";
          return { from, to, groupBy, rows: db.usageSummary(from, to, groupBy, req.query.provider) };
        },
      );

      a.get<{ Params: { id: string } }>("/admin/usage/:id", async (req) => db.recentUsage(req.params.id, 50));

      a.get("/admin/keys", async () => pool.status());

      a.get("/admin/openai/keys", async () => ({ configured: openai.configured, model: openai.model, keys: openai.status() }));


    });
  },
  { prefix: "/api/assistant" },
);

if (!verifyAdminTotp) app.log.warn("ADMIN_TOTP_SECRET is not set: admin login is password-only (run `npm run admin:2fa`)");

await app.listen({ port: config.port, host: env.HOST ?? "127.0.0.1" });
