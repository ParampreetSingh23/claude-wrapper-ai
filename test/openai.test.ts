import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createOpenAIService, OpenAIError } from "../src/openai.ts";
import { openDb } from "../src/db.ts";

const goodKey = "sk-good-xxxxxxxxxxxxxxxxxxxx";
const limitedKey = "sk-limited-xxxxxxxxxxxxxxxxx";
const adminCreds = { clientId: "admin", clientSecret: "9f2c4e7a1b8d3f6e0a5c9b2d7e4f1a8c" };
const port = 43000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}/api/assistant`;
const dir = mkdtempSync(join(tmpdir(), "openai-gateway-"));
const dbPath = join(dir, "gateway.db");
const hits: { key: string; body: any }[] = [];
let gateway: ChildProcess;
let admin: string;

const fake = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  const key = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  hits.push({ key, body });
  assert.equal(req.url, "/v1/responses");
  res.setHeader("content-type", "application/json");
  if (key === limitedKey || body.input === "all-limited") {
    res.writeHead(429, { "retry-after": "60" });
    return res.end(JSON.stringify({ error: { message: "do not expose " + key } }));
  }
  if (body.input === "bad-request") {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: { message: "do not expose " + key } }));
  }
  if (/^error-(401|403|500|503)$/.test(body.input)) {
    res.writeHead(Number(body.input.slice(6)));
    return res.end(JSON.stringify({ error: { message: "do not expose " + key } }));
  }
  if (body.input === "timeout") await sleep(500);
  if (body.input === "malformed") return res.end(JSON.stringify({ status: "completed", output: [], usage: null }));
  res.end(JSON.stringify({
    model: "gpt-4.1-mini-2025-04-14",
    status: body.input === "incomplete" ? "incomplete" : "completed",
    incomplete_details: body.input === "incomplete" ? { reason: "max_output_tokens" } : null,
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: body.input === "refuse" ? [{ type: "refusal", refusal: "Declined" }] : [{ type: "output_text", text: "Hello " }, { type: "output_text", text: "OpenAI" }] },
    ],
    usage: body.input === "tiny"
      ? { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 1 } }
      : { input_tokens: 1000, output_tokens: 500, total_tokens: 1500, input_tokens_details: { cached_tokens: 200 } },
  }));
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function startGateway(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), DB_PATH: dbPath,
      REAL_KEY_1: "unused-claude-key", JWT_SECRET: "x".repeat(40), ADMIN_ID: adminCreds.clientId,
      ADMIN_SECRET: adminCreds.clientSecret,
      OPENAI_BASE_URL: `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`, OPENAI_TIMEOUT_MS: "150", ...extraEnv },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + "/health").then((r) => r.ok, () => false)) return child;
    if (child.exitCode !== null) throw new Error("gateway exited during startup");
    await sleep(50);
  }
  child.kill();
  throw new Error("gateway did not start");
}

async function stopGateway() {
  const stopped = new Promise<void>((resolve) => gateway.once("exit", () => resolve()));
  gateway.kill();
  await stopped;
}

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  gateway = await startGateway();
  admin = (await call("POST", "/token", adminCreds)).body.accessToken;
});

after(async () => {
  if (gateway?.exitCode === null && !gateway.killed) await stopGateway();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

test("OpenAI flow: environment keys, grants, failover, shared limits, errors and restart", async () => {
  const creds = (await call("POST", "/admin/clients", { name: "OpenAI test" }, admin)).body;
  let token = (await call("POST", "/token", creds)).body.accessToken;
  const send = (prompt = "hi") => call("POST", "/openai/send", { prompt, systemPrompt: "Be brief" }, token);
  assert.equal((await call("POST", "/openai/send", { prompt: "hi" })).status, 401);
  assert.equal((await call("POST", "/openai/send", { prompt: "hi" }, admin)).status, 403);
  const blockedOrigin = await fetch(base + "/openai/send", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: "http://evil.test" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(blockedOrigin.status, 403);
  assert.equal((await send()).status, 403);
  assert.equal(hits.length, 0);
  assert.equal((await call("GET", "/admin/openai/keys", undefined, token)).status, 403);
  assert.equal((await call("PATCH", `/admin/clients/${creds.clientId}`, { openaiEnabled: true }, admin)).status, 200);
  assert.equal((await send()).status, 503);
  // No key management routes; changing .env takes effect on restart.
  assert.equal((await call("POST", "/admin/openai/keys", { label: "No admin entry", apiKey: goodKey }, admin)).status, 404);
  assert.equal((await call("PATCH", "/admin/openai/keys/1", { enabled: false }, admin)).status, 404);
  const page = await (await fetch(base + "/admin")).text();
  assert.ok(!page.includes('id="openaiKeyForm"'));
  await stopGateway();
  gateway = await startGateway({ OPENAI_KEY_1: limitedKey, OPENAI_KEY_2: "", OPENAI_KEY_5: goodKey, OPENAI_KEY_6: goodKey,
    OPENAI_KEY_ENCRYPTION_SECRET: "obsolete-and-ignored" });
  admin = (await call("POST", "/token", adminCreds)).body.accessToken;
  const raw = new DatabaseSync(dbPath);
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'openai_keys'").get(), undefined);
  raw.close();
  assert.ok(!readFileSync(dbPath).includes(Buffer.from(goodKey)));

  const result = await send();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.output, "Hello OpenAI");
  assert.deepEqual(result.body.usage, { inputTokens: 800, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0, totalTokens: 1500, costUsd: 0.00114 });
  assert.equal(hits.length, 2);
  assert.equal(hits[1]!.key, goodKey);
  assert.deepEqual(hits[1]!.body, { model: "gpt-4.1-mini", input: "hi", instructions: "Be brief", max_output_tokens: 4096, store: false });
  const listed = (await call("GET", "/admin/openai/keys", undefined, admin)).body;
  assert.ok(listed.keys[0].restingUntil);
  assert.deepEqual(listed.keys.map((k: any) => k.id), [1, 5]);
  assert.ok(!JSON.stringify(listed).includes(goodKey));
  assert.equal(listed.keys[1].masked_key, "…xxxx");
  assert.equal((await call("GET", "/me/usage", undefined, token)).body.spentUsd, 0.00114);

  // Preserve fractional-cent precision in responses, monthly totals, and admin summaries.
  assert.equal((await send("tiny")).body.usage.costUsd, 0.0000017);
  assert.equal((await call("GET", "/me/usage", undefined, token)).body.spentUsd, 0.0011417);
  const preciseSummary = (await call("GET", "/admin/usage?groupBy=client", undefined, admin)).body.rows;
  assert.equal(preciseSummary.find((r: any) => r.grp === creds.clientId).cost_usd, 0.0011417);

  // Both routes draw from the same budget and per-minute counter.
  await call("PATCH", `/admin/clients/${creds.clientId}`, { monthlyBudgetUsd: 0.001 }, admin);
  assert.equal((await send()).status, 402);
  assert.equal((await call("POST", "/send", { prompt: "hi" }, token)).status, 402);
  await call("PATCH", `/admin/clients/${creds.clientId}`, { monthlyBudgetUsd: null, requestsPerMinute: 1 }, admin);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  assert.equal((await call("POST", "/send", { prompt: "hi" }, token)).status, 429);
  await call("PATCH", `/admin/clients/${creds.clientId}`, { requestsPerMinute: null, openaiEnabled: false }, admin);
  const beforeDenied = hits.length;
  assert.equal((await send()).status, 403);
  assert.equal(hits.length, beforeDenied);
  await call("PATCH", `/admin/clients/${creds.clientId}`, { openaiEnabled: true }, admin);
  assert.equal((await send("")).status, 400);
  assert.equal((await send("x".repeat(50001))).status, 400);
  assert.equal((await send("refuse")).status, 422);
  const incomplete = await send("incomplete");
  assert.equal(incomplete.status, 200);
  assert.equal(incomplete.body.stopReason, "max_output_tokens");
  assert.equal((await send("malformed")).status, 502);
  const beforeBad = hits.length;
  const bad = await send("bad-request");
  assert.equal(bad.status, 502);
  assert.equal(hits.length, beforeBad + 1);
  assert.ok(!JSON.stringify(bad).includes(goodKey));
  const beforeTimeout = hits.length;
  assert.equal((await send("timeout")).status, 502);
  assert.equal(hits.length, beforeTimeout + 1);

  const rows = (await call("GET", `/admin/usage/${creds.clientId}`, undefined, admin)).body;
  assert.ok(rows.every((u: any) => u.provider === "openai"));
  assert.ok(rows.some((u: any) => u.http_status === 422 && u.cost_usd > 0));
  const byKey = (await call("GET", "/admin/usage?groupBy=realKey&provider=openai", undefined, admin)).body.rows;
  assert.ok(byKey.every((u: any) => u.provider === "openai"));
  assert.equal((await call("GET", "/admin/usage?provider=invalid", undefined, admin)).status, 400);
  assert.equal((await call("GET", "/admin/usage?groupBy=provider", undefined, admin)).body.rows[0].grp, "openai");

  // Grants and client tokens survive restart; replacing an env key keeps its slot number.
  await stopGateway();
  const replacedKey = "sk-replaced-yyyyyyyyyyyyyyyy";
  gateway = await startGateway({ OPENAI_KEY_5: replacedKey });
  admin = (await call("POST", "/token", adminCreds)).body.accessToken;
  assert.equal((await send()).status, 200);
  assert.equal(hits.at(-1)!.key, replacedKey);
  assert.deepEqual((await call("GET", "/admin/openai/keys", undefined, admin)).body.keys.map((k: any) => k.id), [5]);
  const rotated = (await call("POST", `/admin/clients/${creds.clientId}/rotate-secret`, {}, admin)).body;
  assert.equal((await send()).status, 401);
  token = (await call("POST", "/token", { clientId: creds.clientId, clientSecret: rotated.clientSecret })).body.accessToken;
  await call("PATCH", `/admin/clients/${creds.clientId}`, { status: "disabled" }, admin);
  assert.equal((await send()).status, 401);

  // Removing the env keys disables OpenAI without breaking Claude startup.
  await stopGateway();
  gateway = await startGateway();
  admin = (await call("POST", "/token", adminCreds)).body.accessToken;
  assert.equal((await call("GET", "/admin/openai/keys", undefined, admin)).body.configured, false);
  const allowed = (await call("POST", "/admin/clients", { name: "No configured keys", openaiEnabled: true }, admin)).body;
  token = (await call("POST", "/token", allowed)).body.accessToken;
  assert.equal((await send()).status, 503);
});

test("explicit upstream failures rest keys; an upstream 503 is not a missing configuration", async () => {
  for (const status of [401, 403, 500, 503]) {
    const service = createOpenAIService([{ id: 1, apiKey: goodKey }], { model: "gpt-4.1-mini", maxTokens: 10, timeoutMs: 1000,
      baseUrl: `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1` });
    const count = hits.length;
    await assert.rejects(service.send(`error-${status}`), (e: unknown) => e instanceof OpenAIError && e.status === status && e.keyId === 1 && e.message === "Upstream OpenAI error");
    assert.ok(service.status()[0]!.restingUntil);
    await assert.rejects(service.send("hi"), OpenAIError);
    assert.equal(hits.length, count + 1);
  }
});

test("legacy migration preserves data, defaults grants off, and separates equal key IDs", () => {
  const path = join(dir, "legacy.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE clients (client_id TEXT PRIMARY KEY, name TEXT, secret_hash TEXT, status TEXT DEFAULT 'active',
      monthly_budget_usd REAL, requests_per_minute INTEGER, created_at TEXT, last_used_at TEXT);
    CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT, real_key INTEGER, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      cost_usd REAL, duration_ms INTEGER, http_status INTEGER, created_at TEXT);
    CREATE TABLE openai_keys (id INTEGER PRIMARY KEY, encrypted_key TEXT);
    INSERT INTO openai_keys VALUES (77, 'old-ciphertext-kept');
    INSERT INTO clients VALUES ('old', 'Original', 'hash', 'active', 10, 5, '2026-01-01', NULL);
    INSERT INTO usage VALUES (1, 'old', 1, 'claude', 1, 1, 0, 0, 1, 10, 200, '2026-01-01');
  `);
  legacy.close();
  const db = openDb(path);
  assert.equal(db.getClient("old")!.openai_enabled, 0);
  assert.equal(db.getClient("old")!.name, "Original");
  assert.equal((db.recentUsage("old", 1)[0] as any).provider, "anthropic");
  db.insertUsage({ provider: "openai", client_id: "old", real_key: 1, model: "gpt-4.1-mini", input_tokens: 800, output_tokens: 500,
    cache_read_tokens: 200, cache_write_tokens: 0, cost_usd: 0.00114, duration_ms: 10, http_status: 200, created_at: "2026-01-02" });
  const rows = db.usageSummary("2026", "2027", "realKey") as any[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.grp, r.provider]), [[1, "anthropic"], [1, "openai"]]);
  assert.equal(db.spendSince("old", "2026").spend, 1.00114);
  // Reopening an already migrated database is safe.
  assert.equal(openDb(path).getClient("old")!.openai_enabled, 0);
  const preserved = new DatabaseSync(path);
  assert.equal((preserved.prepare("SELECT encrypted_key FROM openai_keys WHERE id = 77").get() as any).encrypted_key, "old-ciphertext-kept");
  preserved.close();
  assert.throws(() => createOpenAIService([], { model: "unknown", maxTokens: 10, timeoutMs: 100, baseUrl: "https://api.openai.com/v1" }), /no price entry/);
});

test("five configured keys rotate and invalid keys are rejected without exposing values", async () => {
  const options = { model: "gpt-4.1-mini", maxTokens: 10, timeoutMs: 1000,
    baseUrl: `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1` };
  const keys = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, apiKey: `sk-test-${String(i).repeat(20)}` }));
  const service = createOpenAIService(keys, options);
  const start = hits.length;
  for (let i = 0; i < 5; i++) assert.equal((await service.send("hi")).keyId, i + 1);
  assert.deepEqual(hits.slice(start).map((h) => h.key), keys.map((k) => k.apiKey));
  assert.throws(() => createOpenAIService([{ id: 3, apiKey: "invalid-do-not-expose" }], options), {
    message: "OPENAI_KEY_3 has an invalid API key format",
  });
  await assert.rejects(createOpenAIService([], options).send("hi"), (e: unknown) => e instanceof OpenAIError && e.status === 503 && e.keyId === null);
});

test("documented env command appends missing settings without overwriting or duplicating existing content", () => {
  const script = /node <<'NODE'\n([\s\S]*?)\nNODE/.exec(readFileSync("README.md", "utf8"))![1]!;
  const cwd = join(dir, "env-command");
  const temp = mkdtempSync(cwd);
  const path = join(temp, ".env");
  const original = '# Keep comments and existing secrets\nREAL_KEY_1=existing-claude-key\nADMIN_SECRET=existing-admin\nOPENAI_KEY_1=\nexport OPENAI_MODEL = "gpt-4.1-mini"\n# OPENAI_KEY_5=commented-only';
  writeFileSync(path, original);
  const run = () => spawnSync(process.execPath, ["-e", script], { cwd: temp, encoding: "utf8" });
  assert.equal(run().status, 0);
  const updated = readFileSync(path, "utf8");
  assert.ok(updated.startsWith(original + "\n"));
  assert.ok(updated.includes("\nOPENAI_KEY_5=\n"));
  assert.equal(updated.match(/^OPENAI_KEY_1=/gm)!.length, 1);
  assert.equal(updated.match(/^(?:export )?OPENAI_MODEL\s*=/gm)!.length, 1);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(path, "utf8"), updated);
  const absent = mkdtempSync(join(dir, "no-env-"));
  assert.notEqual(spawnSync(process.execPath, ["-e", script], { cwd: absent }).status, 0);
  assert.equal(existsSync(join(absent, ".env")), false);
});
