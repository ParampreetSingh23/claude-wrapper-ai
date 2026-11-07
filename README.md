# GenAI Gateway

Internal Claude and OpenAI gateway with one admin, client credentials, shared per-client limits, and a spend dashboard. Claude clients continue using `/api/assistant/send`. OpenAI uses a separate endpoint and requires an explicit grant for each client.

## Run

Requires Node.js 24+ (built-in TypeScript support and `node:sqlite`).

```bash
npm install
cp .env.example .env
# Fill in REAL_KEY_1, ADMIN_ID, ADMIN_SECRET and JWT_SECRET.
npm run dev
```

Generate separate random values for `ADMIN_SECRET` and `JWT_SECRET` with `openssl rand -hex 32`. SQLite at `data/gateway.db` is created on startup. Existing databases receive additive migrations preserving clients and usage.

```bash
npm test                # fake upstream APIs; no real API calls or charges
npm run typecheck
```

## Enable OpenAI

1. Set `OPENAI_KEY_1` through `OPENAI_KEY_5` in `.env`. Fill at least one slot; leave unused slots empty. Keys are loaded from `.env` only, like Claude's `REAL_KEY_1`, `REAL_KEY_2`, etc.
2. Restart the server after adding, replacing, or clearing keys. Each key keeps its slot number in usage reports (for example, `OPENAI_KEY_5` is always key 5).
3. Open `/api/assistant/admin` and click **Grant OpenAI** for a client, or select **Allow OpenAI** when creating one. Grants default to off. The dashboard shows masked key status and usage; keys cannot be added or edited there.
4. Use that client's existing credentials and token with `/openai/send`.

### Add missing settings without replacing your existing .env

Run this from the project directory. It requires an existing `.env`, preserves all existing contents and values (including blank settings), and appends only settings that are absent. Running it again adds no duplicates.

```bash
node <<'NODE'
const fs = require('node:fs');
const file = '.env';
const current = fs.readFileSync(file, 'utf8');
const settings = {
  OPENAI_KEY_1: '', OPENAI_KEY_2: '', OPENAI_KEY_3: '',
  OPENAI_KEY_4: '', OPENAI_KEY_5: '',
  OPENAI_MODEL: 'gpt-4.1-mini',
  OPENAI_MAX_TOKENS: '4096',
  OPENAI_TIMEOUT_MS: '60000'
};
const missing = Object.entries(settings)
  .filter(([name]) => !new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*=', 'm').test(current))
  .map(([name, value]) => name + '=' + value);
if (missing.length) fs.appendFileSync(file,
  (current.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
console.log('Added ' + missing.length + ' missing settings; existing values preserved.');
NODE
```

Then edit `.env` to fill your real keys and restart. Do not copy `.env.example` over an existing `.env`.

Default model: `gpt-4.1-mini`. `OPENAI_MODEL` also accepts `gpt-4.1-mini-2025-04-14`. Other models require a verified price entry in `src/openai.ts`; unpriced models cause startup to fail. Prices come from the [official model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini). Reconcile estimates with provider billing.

Settings: `OPENAI_MAX_TOKENS=4096` (1–32768), `OPENAI_TIMEOUT_MS=60000` (1–600000). `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`; change it only for a trusted upstream or local tests. That server receives your keys and prompts. HTTPS is required except on loopback.

Without a configured OpenAI key, authorized OpenAI requests return `503`; Claude remains available. Nonempty keys must match the expected `sk-...` format or startup fails without printing their values. The old `OPENAI_KEY_ENCRYPTION_SECRET` is ignored and can be removed. Old database key rows, if any, are preserved but no longer read; move the desired keys into the numbered environment slots.

## Client calls

```bash
curl -X POST http://localhost:3000/api/assistant/token \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"cl_...","clientSecret":"cs_..."}'

# For Claude, change /openai/send to /send.
curl -X POST http://localhost:3000/api/assistant/openai/send \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' \
  -d '{"prompt":"Say hi","systemPrompt":"Be brief."}'
```

Both routes return `output`, `model`, `stopReason`, `usage` including `costUsd`, `timestamp`, and `durationMs`. Refusals return `422` with usage. OpenAI returns partial output with `stopReason: "max_output_tokens"` at the output cap. These are simple prompt wrappers, not OpenAI SDK-compatible endpoints: no tools, conversation IDs, client streaming, or per-request model selection.

Budgets, requests-per-minute limits, `/me/usage`, and dashboard totals include **both providers**. Limits check recorded spend before a call; one call or concurrent calls can exceed the remaining budget. Configure provider-side limits too. Failures with unknown upstream usage record zero estimated cost, which does not guarantee no provider charge.
The dashboard and API reports retain up to eight decimal places for dollar amounts so short, low-cost requests remain visible. For example, a cost of `0.0000047` is displayed as `$0.0000047`, not zero.

## Endpoints (base `/api/assistant`)

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Server health and Claude configuration |
| POST | `/token` | Credentials | Admin/client login |
| POST | `/send` | Client | Claude prompt |
| POST | `/openai/send` | Client with OpenAI grant | OpenAI prompt |
| GET | `/me/usage` | Client | Combined monthly spend and remaining budget |
| GET | `/admin` | Public sign-in page | Dashboard; admin login required for data |
| GET / POST | `/admin/clients` | Admin | List/create clients; creation accepts `openaiEnabled` |
| PATCH | `/admin/clients/:id` | Admin | Name, status, limits, `openaiEnabled` |
| POST | `/admin/clients/:id/rotate-secret` | Admin | Replace secret and cancel its current token |
| GET | `/admin/usage` | Admin | Group by `client`, `realKey`, `day`, `model`, or `provider`; optional `provider=anthropic` or `openai`, `from`, `to` |
| GET | `/admin/usage/:id` | Admin | Last 50 client requests, including provider |
| GET | `/admin/keys` | Admin | Anthropic key readiness |
| GET | `/admin/openai/keys` | Admin | Read-only masked environment key status/configuration |

OpenAI key IDs are their `.env` slot numbers. Clear a slot and restart to stop using that key; keep remaining keys in their original slots for historical reporting. Replacing a slot keeps its accumulated usage under that slot ID. `groupBy=realKey` rows include `provider` to distinguish equal numeric IDs; other unfiltered reports combine providers.

## Security and operations

- The same admin login, 2FA, lockout, short sessions, and role checks protect OpenAI management. Clients cannot manage keys or grants. Disabling clients and revoking grants take effect on the next request; in-flight calls can finish.
- `ADMIN_SECRET` requires at least 24 random characters; `JWT_SECRET` at least 32. Client secrets are hashed and compared in constant time.
- Run `npm run admin:2fa`, set `ADMIN_TOTP_SECRET`, and restart. Codes are single-use. Admin sessions default to 15 minutes; client sessions to 60.
- Admin and client access accept any source IP with valid credentials. The old `ADMIN_ALLOWED_IPS` setting is ignored and can be removed. Keep `HOST=127.0.0.1` behind your public HTTPS reverse proxy; use `TRUST_PROXY=true` only behind a proxy you control. Failed-login lockouts still apply per IP.
- Clients can obtain a new token only after their current token expires. Earlier `/token` calls with valid credentials return `409` with `expiresAt` and `retryAfterSeconds`; the existing token keeps working. Reuse it for both providers. Admin login still replaces its previous session. The old `ONE_TOKEN_PER_CLIENT` setting is ignored and can be removed; no new environment setting is needed.
- Rotating a client secret revokes its token and clears the expiry lock, allowing immediate login with the new secret. If a client loses its token, it must wait until expiry or ask an admin to rotate its secret. Revoking OpenAI access leaves Claude available.
- Admin responses use `no-store`; the page uses a nonce CSP and frame protection. Browser origins must be same-host or in `ALLOWED_ORIGINS`.
- Back up SQLite using its backup mechanism and keep a secure backup of `.env`. Actual provider keys live only in server configuration; never commit `.env` or include it in shared exports.
- OpenAI rotates across configured ready keys, resting keys after explicit 401/403, 429, or 5xx responses. It never tries resting keys early or automatically replays a timeout, disconnect, or invalid response. Keys in one project may share provider limits.
- Rate counters, cooldowns, lockouts, and admin sessions reset on restart. Run one process; scaling requires shared state. Client tokens and grants persist in SQLite; keys reload from the environment.
- On the first upgrade to the client expiry lock, the database migration revokes existing client tokens once because their expiry was not stored. Clients must log in again. IDs, secrets, grants, limits, and usage are preserved; later restarts retain tokens and their original expiry locks.
- Claude's models, pricing, effort, and fallback behavior remain in `src/claude.ts` and its existing configuration. Set provider-side spend limits as a backstop.

## Files and guides

| File | Responsibility |
|---|---|
| `src/server.ts` | Routes, auth, grants, limits, usage logging |
| `src/claude.ts` | Existing Anthropic key pool and prices |
| `src/openai.ts` | Environment key pool, Responses calls and prices |
| `src/db.ts` | SQLite tables, migrations and queries |
| `src/admin.html` | Shared dashboard and key/grant controls |
| `src/totp.ts` | Admin authenticator setup and verification |
| `test/gateway.test.ts`, `test/openai.test.ts`, `test/token-lock.test.ts` | Fake-upstream regression/integration tests and token migration checks |

[Postman verification guide](POSTMAN_GUIDE.md) · [Client guide](CLIENT_GUIDE.md) · [Deployment](DEPLOY.md) · [Architecture](ARCHITECTURE.md) · [Implementation decisions](PLAN.md)
