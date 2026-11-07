import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

test("expiry migration revokes legacy tokens once; atomic claims respect expiry, credentials and status", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-lock-"));
  try {
    const path = join(dir, "legacy.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE clients (
        client_id TEXT PRIMARY KEY, name TEXT, secret_hash TEXT, status TEXT,
        monthly_budget_usd REAL, requests_per_minute INTEGER, created_at TEXT, last_used_at TEXT,
        token_id TEXT, openai_enabled INTEGER);
      INSERT INTO clients VALUES ('old', 'Original', 'hash', 'active', 10, 5, '2026-01-01', NULL, 'legacy-token', 1);
    `);
    legacy.close();
    const db = openDb(path);
    assert.deepEqual({ ...db.getClient("old") }, {
      client_id: "old", name: "Original", secret_hash: "hash", status: "active",
      monthly_budget_usd: 10, requests_per_minute: 5, created_at: "2026-01-01", last_used_at: null,
      token_id: null, token_expires_at: null, openai_enabled: 1,
    });
    assert.equal(db.claimToken("old", "hash", "first", 200, 100), true);
    const reopened = openDb(path);
    assert.equal(reopened.getClient("old")!.token_id, "first");
    assert.equal(reopened.getClient("old")!.token_expires_at, 200);
    assert.equal(reopened.claimToken("old", "hash", "duplicate", 300, 199.999), false);
    assert.equal(db.getClient("old")!.token_id, "first");
    assert.equal(reopened.claimToken("old", "wrong-hash", "wrong", 300, 200), false);
    assert.equal(reopened.claimToken("old", "hash", "renewed", 300, 200), true);
    db.updateClient("old", { status: "disabled" });
    assert.equal(reopened.claimToken("old", "hash", "disabled", 400, 300), false);
    db.updateClient("old", { status: "active", secret_hash: "new-hash", token_id: null, token_expires_at: null });
    assert.equal(reopened.claimToken("old", "hash", "stale-credentials", 400, 250), false);
    assert.equal(reopened.claimToken("old", "new-hash", "recovered", 400, 250), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
