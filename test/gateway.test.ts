// End-to-end check: real gateway process + fake Anthropic API. No real keys, no cost.
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { base32Decode, currentStep, totpCode } from "../src/totp.ts";

const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}/api/assistant`;
const ADMIN = { clientId: "admin", clientSecret: "9f2c4e7a1b8d3f6e0a5c9b2d7e4f1a8c" };
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const otpNow = () => totpCode(base32Decode(TOTP_SECRET), currentStep());
const hits: Record<string, number> = {};

// Fake Claude: "key-ratelimited" always gets 429, "key-good" streams a short answer
// (1000 input + 500 output tokens = $0.014 on claude-opus-5-5).
function sse(res: import("node:http").ServerResponse) {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 500 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

let fake: Server;
let fakeUrl: string;
let gateway: ChildProcess;
let dir: string;

async function startGateway(port: number, extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: {
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: String(port),
      DB_PATH: join(dir, `test-${port}.db`),
      ANTHROPIC_BASE_URL: fakeUrl,
      REAL_KEY_1: "key-ratelimited",
      REAL_KEY_2: "key-good",
      JWT_SECRET: "x".repeat(40),
      TOKEN_TTL_MINUTES: "0.05", // 3 seconds, to test expiry
      ADMIN_ID: ADMIN.clientId,
      ADMIN_SECRET: ADMIN.clientSecret,
      ALLOWED_ORIGINS: "http://allowed.test",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/api/assistant/health`).then((r) => r.ok, () => false)) return child;
    await sleep(100);
  }
  child.kill();
  throw new Error("gateway did not start");
}

before(async () => {
  fake = createServer((req, res) => {
    // The SDK may send the key as x-api-key or as a Bearer token depending on version.
    const key = String(req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, ""));
    hits[key] = (hits[key] ?? 0) + 1;
    req.resume().on("end", () => {
      if (key === "key-ratelimited") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
      }
      sse(res);
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  gateway = await startGateway(PORT, {
    ADMIN_TOTP_SECRET: TOTP_SECRET,
    LOGIN_MAX_FAILURES: "8",
  });
});

after(() => {
  gateway?.kill();
  fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const login = async (creds: object) => (await call("POST", "/token", creds)).body.accessToken as string;

test("full flow: admin, clients, limits, failover, expiry", async () => {
  // Admin login needs secret + authenticator code; a code works only once
  assert.equal((await call("POST", "/token", ADMIN)).status, 401); // no code (failure 1)
  assert.equal((await call("POST", "/token", { ...ADMIN, clientSecret: "wrong", otp: otpNow() })).status, 401); // failure 2
  const code = otpNow();
  const adminLogin = await call("POST", "/token", { ...ADMIN, otp: code });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  assert.equal(adminLogin.body.expiresIn, 15 * 60); // admin tokens are short-lived
  const admin = adminLogin.body.accessToken as string;
  assert.equal((await call("POST", "/token", { ...ADMIN, otp: code })).status, 401); // replayed code (failure 3)

  // Admin page: CSP with a fresh nonce, no caching
  const page = await fetch(`${BASE}/admin`);
  const csp = page.headers.get("content-security-policy") ?? "";
  const html = await page.text();
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce && html.includes(`nonce="${nonce}"`) && !html.includes("__CSP_NONCE__"));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const created = await call("POST", "/admin/clients", { name: "Budget client", monthlyBudgetUsd: 0.02 }, admin);
  assert.equal(created.status, 201);
  const { clientId, clientSecret } = created.body;
  assert.match(clientSecret, /^cs_/);

  // Client login; wrong secret and unknown id both rejected the same way (failures 4, 5)
  assert.equal((await call("POST", "/token", { clientId, clientSecret: "nope" })).status, 401);
  assert.equal((await call("POST", "/token", { clientId: "cl_missing", clientSecret })).status, 401);
  let token = await login({ clientId, clientSecret });

  // One live token per client: logging in again cancels the previous token
  const newer = await login({ clientId, clientSecret });
  const old = await call("GET", "/me/usage", undefined, token);
  assert.equal(old.status, 401);
  assert.equal(old.body.error, "Token replaced by a newer login");
  token = newer;
  assert.equal((await call("GET", "/me/usage", undefined, token)).status, 200);

  // Role separation
  assert.equal((await call("GET", "/admin/clients", undefined, token)).status, 403);
  assert.equal((await call("POST", "/send", { prompt: "hi" }, admin)).status, 403);
  assert.equal((await call("PATCH", `/admin/clients/${clientId}`, { openaiEnabled: true }, token)).status, 403);
  assert.equal((await call("PATCH", `/admin/clients/${clientId}`, { openaiEnabled: true })).status, 401);

  // Editing browser state or changing a token's role cannot grant server-side admin access.
  const [header, payload, signature] = token.split(".");
  const forgedPayload = { ...JSON.parse(Buffer.from(payload!, "base64url").toString()), role: "admin" };
  const forgedToken = [header, Buffer.from(JSON.stringify(forgedPayload)).toString("base64url"), signature].join(".");
  assert.equal((await call("GET", "/admin/clients", undefined, forgedToken)).status, 401);
  assert.equal((await call("PATCH", `/admin/clients/${clientId}`, { openaiEnabled: true }, forgedToken)).status, 401);
  const unchanged = (await call("GET", "/admin/clients", undefined, admin)).body.find((c: any) => c.client_id === clientId);
  assert.equal(unchanged.openai_enabled, 0);

  // Origin: none (script) ok, allowed ok, other site blocked
  assert.equal((await call("POST", "/send", { prompt: "hi" }, token, { origin: "http://evil.test" })).status, 403);

  // Send: real key 1 is rate limited, so the gateway fails over to real key 2
  const first = await call("POST", "/send", { prompt: "hi" }, token, { origin: "http://allowed.test" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.output, "Hello");
  assert.equal(first.body.usage.costUsd, 0.014);
  assert.equal(hits["key-ratelimited"], 1);
  assert.equal(hits["key-good"], 1);

  // Key 1 is now resting: next request goes straight to key 2
  assert.equal((await call("POST", "/send", { prompt: "hi" }, token)).status, 200);
  assert.equal(hits["key-ratelimited"], 1);

  // Spent $0.028 >= $0.02 budget -> blocked
  const over = await call("POST", "/send", { prompt: "hi" }, token);
  assert.equal(over.status, 402);

  // /me/usage reflects it
  const me = await call("GET", "/me/usage", undefined, token);
  assert.equal(me.body.spentUsd, 0.028);
  assert.equal(me.body.remainingUsd, 0);

  // Admin raises the budget -> works again immediately
  await call("PATCH", `/admin/clients/${clientId}`, { monthlyBudgetUsd: null }, admin);
  assert.equal((await call("POST", "/send", { prompt: "hi" }, token)).status, 200);

  // Requests-per-minute limit
  const rl = (await call("POST", "/admin/clients", { name: "Slow client", requestsPerMinute: 1 }, admin)).body;
  const rlToken = await login(rl);
  assert.equal((await call("POST", "/send", { prompt: "hi" }, rlToken)).status, 200);
  const limited = await call("POST", "/send", { prompt: "hi" }, rlToken);
  assert.equal(limited.status, 429);
  assert.ok(limited.body.retryAfterSeconds > 0);

  // Disable: the still-valid token stops working on the next request; login refused too
  await call("PATCH", `/admin/clients/${rl.clientId}`, { status: "disabled" }, admin);
  assert.equal((await call("GET", "/me/usage", undefined, rlToken)).body.error, "Client disabled");
  assert.equal((await call("POST", "/token", rl)).status, 401);

  // Rotate secret: old secret refused, the token issued with it is cancelled too, new secret works
  const rotated = (await call("POST", `/admin/clients/${clientId}/rotate-secret`, {}, admin)).body;
  assert.equal((await call("GET", "/me/usage", undefined, token)).body.error, "Token replaced by a newer login");
  assert.equal((await call("POST", "/token", { clientId, clientSecret })).status, 401);
  token = await login({ clientId, clientSecret: rotated.clientSecret });
  assert.ok(token);

  // Spend reporting
  const byKey = (await call("GET", "/admin/usage?groupBy=realKey", undefined, admin)).body.rows;
  assert.deepEqual(byKey.map((r: any) => [r.grp, r.requests]), [[2, 4]]);
  const byClient = (await call("GET", "/admin/usage?groupBy=client", undefined, admin)).body.rows;
  assert.equal(byClient.find((r: any) => r.grp === clientId).cost_usd, 0.042);

  // Body validation
  assert.equal((await call("POST", "/send", { prompt: "" }, token)).status, 400);

  // Token expiry (TTL is 3 s in this test)
  await sleep(3500);
  const expired = await call("POST", "/send", { prompt: "hi" }, token);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error, "Token expired");

  // Admin: a second sign-in (next 30 s code, since codes are single-use) cancels the first admin token
  const admin2 = await login({ ...ADMIN, otp: totpCode(base32Decode(TOTP_SECRET), currentStep() + 1) });
  assert.ok(admin2);
  assert.equal((await call("GET", "/admin/clients", undefined, admin)).body.error, "Token replaced by a newer login");
  assert.equal((await call("GET", "/admin/clients", undefined, admin2)).status, 200);

  // Brute force: 7 failures so far (6 = disabled client, 7 = old secret); the 8th locks this IP, then even a correct login is refused
  assert.equal((await call("POST", "/token", { clientId, clientSecret: "guess" })).status, 401);
  const locked = await call("POST", "/token", { clientId, clientSecret: "guess-again" });
  assert.equal(locked.status, 429);
  assert.ok(locked.body.retryAfterSeconds > 0);
  assert.equal((await call("POST", "/token", { clientId, clientSecret: rotated.clientSecret })).status, 429);
});

test("admin works from any IP, ignores the old allowlist, and still requires authentication", async () => {
  const port = PORT + 1;
  const other = await startGateway(port, { ADMIN_ALLOWED_IPS: "10.9.9.9", TRUST_PROXY: "true" });
  try {
    const base = `http://127.0.0.1:${port}/api/assistant`;
    const headers = { "content-type": "application/json", "x-forwarded-for": "198.51.100.10" };
    assert.equal((await fetch(`${base}/admin`, { headers })).status, 200);
    const wrong = await fetch(`${base}/token`, {
      method: "POST", headers, body: JSON.stringify({ ...ADMIN, clientSecret: "wrong" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(`${base}/admin/clients`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/admin/openai/keys`, { headers })).status, 401);
    const res = await fetch(`${base}/token`, {
      method: "POST",
      headers,
      body: JSON.stringify(ADMIN),
    });
    assert.equal(res.status, 200);
    const { accessToken } = await res.json() as { accessToken: string };
    for (const ip of ["198.51.100.10", "203.0.113.20"]) {
      const authHeaders = { authorization: `Bearer ${accessToken}`, "x-forwarded-for": ip };
      assert.equal((await fetch(`${base}/admin/clients`, { headers: authHeaders })).status, 200);
      assert.equal((await fetch(`${base}/admin/openai/keys`, { headers: authHeaders })).status, 200);
    }
  } finally {
    other.kill();
  }
});
