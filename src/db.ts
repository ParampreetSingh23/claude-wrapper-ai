import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Client = {
  client_id: string;
  name: string;
  secret_hash: string;
  status: "active" | "disabled";
  monthly_budget_usd: number | null;
  requests_per_minute: number | null;
  created_at: string;
  last_used_at: string | null;
  token_id: string | null; // id of the only token currently allowed for this client
};

export type UsageInsert = {
  client_id: string;
  real_key: number | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  duration_ms: number;
  http_status: number;
  created_at: string;
};

export type GroupBy = "client" | "realKey" | "day" | "model";

// Whitelist: groupBy comes from the query string, so it must never be pasted into SQL directly.
const GROUP_COLUMNS: Record<GroupBy, string> = {
  client: "u.client_id",
  realKey: "u.real_key",
  day: "substr(u.created_at, 1, 10)",
  model: "u.model",
};

const CLIENT_FIELDS = ["name", "status", "monthly_budget_usd", "requests_per_minute", "secret_hash", "token_id"] as const;
type ClientPatch = Partial<Pick<Client, (typeof CLIENT_FIELDS)[number]>>;

export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS clients (
      client_id           TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      secret_hash         TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      monthly_budget_usd  REAL,
      requests_per_minute INTEGER,
      created_at          TEXT NOT NULL,
      last_used_at        TEXT,
      token_id            TEXT
    );
    CREATE TABLE IF NOT EXISTS usage (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id          TEXT NOT NULL REFERENCES clients(client_id),
      real_key           INTEGER,
      model              TEXT,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL NOT NULL DEFAULT 0,
      duration_ms        INTEGER,
      http_status        INTEGER NOT NULL,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_client_time ON usage (client_id, created_at);
    CREATE INDEX IF NOT EXISTS usage_time ON usage (created_at);
  `);

  // Databases created before token_id existed get the column added in place.
  const hasTokenId = (db.prepare("PRAGMA table_info(clients)").all() as { name: string }[]).some((c) => c.name === "token_id");
  if (!hasTokenId) db.exec("ALTER TABLE clients ADD COLUMN token_id TEXT");

  const getClient = db.prepare("SELECT * FROM clients WHERE client_id = ?");
  const insertClient = db.prepare(`
    INSERT INTO clients (client_id, name, secret_hash, monthly_budget_usd, requests_per_minute, created_at)
    VALUES ($client_id, $name, $secret_hash, $monthly_budget_usd, $requests_per_minute, $created_at)`);
  const touchClient = db.prepare("UPDATE clients SET last_used_at = ? WHERE client_id = ?");
  const listClients = db.prepare(`
    SELECT c.client_id, c.name, c.status, c.monthly_budget_usd, c.requests_per_minute, c.created_at, c.last_used_at,
           COALESCE(SUM(u.cost_usd), 0) AS month_spend_usd, COUNT(u.id) AS month_requests
    FROM clients c LEFT JOIN usage u ON u.client_id = c.client_id AND u.created_at >= ?
    GROUP BY c.client_id ORDER BY c.created_at`);
  const insertUsage = db.prepare(`
    INSERT INTO usage (client_id, real_key, model, input_tokens, output_tokens, cache_read_tokens,
                       cache_write_tokens, cost_usd, duration_ms, http_status, created_at)
    VALUES ($client_id, $real_key, $model, $input_tokens, $output_tokens, $cache_read_tokens,
            $cache_write_tokens, $cost_usd, $duration_ms, $http_status, $created_at)`);
  const spendSince = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS spend, COUNT(*) AS requests FROM usage WHERE client_id = ? AND created_at >= ?",
  );
  const recentUsage = db.prepare("SELECT * FROM usage WHERE client_id = ? ORDER BY id DESC LIMIT ?");

  return {
    getClient: (id: string) => getClient.get(id) as Client | undefined,
    insertClient: (c: Omit<Client, "status" | "last_used_at" | "token_id">) => void insertClient.run(c),
    touchClient: (id: string, at: string) => void touchClient.run(at, id),
    listClients: (monthStart: string) => listClients.all(monthStart),
    insertUsage: (u: UsageInsert) => void insertUsage.run(u),
    recentUsage: (id: string, limit: number) => recentUsage.all(id, limit),
    spendSince: (id: string, since: string) => spendSince.get(id, since) as { spend: number; requests: number },

    updateClient(id: string, patch: ClientPatch) {
      const keys = CLIENT_FIELDS.filter((k) => k in patch);
      if (!keys.length) return;
      const set = keys.map((k) => `${k} = $${k}`).join(", ");
      db.prepare(`UPDATE clients SET ${set} WHERE client_id = $id`).run({ ...pick(patch, keys), id });
    },

    usageSummary(from: string, to: string, groupBy: GroupBy) {
      const col = GROUP_COLUMNS[groupBy];
      return db
        .prepare(`
          SELECT ${col} AS grp, ${groupBy === "client" ? "MAX(c.name)" : "NULL"} AS name,
                 COUNT(*) AS requests, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
                 ROUND(SUM(u.cost_usd), 6) AS cost_usd, SUM(u.http_status <> 200) AS errors
          FROM usage u JOIN clients c ON c.client_id = u.client_id
          WHERE u.created_at >= ? AND u.created_at < ?
          GROUP BY grp ORDER BY ${groupBy === "day" ? "grp" : "cost_usd DESC"}`)
        .all(from, to);
    },
  };
}

function pick<T extends object>(obj: T, keys: readonly (keyof T)[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]])) as Record<string, string | number | null>;
}

export type Db = ReturnType<typeof openDb>;
