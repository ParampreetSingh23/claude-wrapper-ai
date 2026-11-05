# Claude Gateway

Small internal service that lets a team use Claude through **one admin**, **unlimited client credentials** and **3 real Anthropic keys**, with per-client limits and a spend dashboard.

**How it works, with step-by-step diagrams: [PLAN.md](PLAN.md).** Start with section 3 (what happens when a client sends a request).

## Run it

```bash
npm install
cp .env.example .env    # then fill in the values below
npm run dev             # http://localhost:3000/api/assistant
```

Fill in `.env`:

- `REAL_KEY_1..3`: your Anthropic API keys.
- `ADMIN_SECRET` and `JWT_SECRET`: run `openssl rand -hex 32` once for each.
- `DEFAULT_MONTHLY_BUDGET_USD` / `DEFAULT_REQUESTS_PER_MINUTE`: limits new clients get (empty = unlimited).

The database file (`data/gateway.db`) is created on first start. Back it up; it holds clients and all usage.

```bash
npm test                # end-to-end test against a fake Claude API (no cost)
npm run typecheck
```

## Daily use

**Admin: dashboard** at `http://localhost:3000/api/assistant/admin`. Log in with `ADMIN_ID` / `ADMIN_SECRET`. Create clients (the secret is shown once), set limits, disable, rotate secrets, see spend per client, per real key and per day.

**Client: two calls**

```bash
# 1. log in (once per 60 min)
curl -X POST http://localhost:3000/api/assistant/token \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"cl_...","clientSecret":"cs_..."}'
# → {"accessToken":"eyJ...","expiresAt":"..."}

# 2. ask Claude (repeat with the same token until it expires)
curl -X POST http://localhost:3000/api/assistant/send \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer eyJ...' \
  -d '{"prompt":"Say hi","systemPrompt":"Be brief."}'
# → {"output":"...","usage":{...,"costUsd":0.0123},"timestamp":"...","durationMs":2140}
```

After 60 minutes `/send` returns `401 Token expired`: log in again. `GET /me/usage` shows the client its own spend and remaining budget.

## Endpoints (base `/api/assistant`)

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/health` | anyone | server up, number of real keys |
| POST | `/token` | admin, clients | ID + secret → token (60 min) |
| POST | `/send` | clients | ask Claude |
| GET | `/me/usage` | clients | own spend this month, budget left |
| GET | `/admin` | admin | dashboard page |
| GET / POST | `/admin/clients` | admin | list / create clients |
| PATCH | `/admin/clients/:id` | admin | `name`, `status`, `monthlyBudgetUsd`, `requestsPerMinute` |
| POST | `/admin/clients/:id/rotate-secret` | admin | new secret, old one stops working |
| GET | `/admin/usage?groupBy=client\|realKey\|day\|model&from=&to=` | admin | spend totals |
| GET | `/admin/usage/:id` | admin | last 50 requests of a client |
| GET | `/admin/keys` | admin | real keys: ready or resting |

## Files

| File | What |
|---|---|
| [src/server.ts](src/server.ts) | routes, auth, limits |
| [src/claude.ts](src/claude.ts) | real-key pool (spread + failover), price table |
| [src/db.ts](src/db.ts) | SQLite tables and queries |
| [src/admin.html](src/admin.html) | dashboard |
| [src/totp.ts](src/totp.ts) | admin two-factor codes (`npm run admin:2fa`) |
| [test/gateway.test.ts](test/gateway.test.ts) | end-to-end test |

Hosting on the server (claude.parampreetsingh.dev): [DEPLOY.md](DEPLOY.md). Architecture (HLD, LLD, sequence): [ARCHITECTURE.md](ARCHITECTURE.md). Client-facing docs: [CLIENT_GUIDE.md](CLIENT_GUIDE.md).

## Admin security

Only you should be able to reach or use the admin side. Layers, outermost first:

| Layer | Setting | Stops |
|---|---|---|
| Network | `HOST=127.0.0.1` (default in `.env.example`); in production, put the server behind HTTPS on a VPN / office network | Strangers reaching the server at all |
| IP allowlist | `ADMIN_ALLOWED_IPS` | `/admin` page and admin API return **404** from any other IP; admin login from elsewhere fails even with the right password |
| Strong secret | `ADMIN_SECRET` must be ≥ 24 random characters (server refuses to start otherwise) | Guessing |
| Two-factor | `ADMIN_TOTP_SECRET` (run `npm run admin:2fa`) | A leaked or shoulder-surfed password: login also needs the 6-digit code from your phone; each code works once |
| Lockout | `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MINUTES` | Password guessing: after 5 failures an IP is blocked 15 min, even for correct passwords |
| Short sessions | `ADMIN_TOKEN_TTL_MINUTES` (15) | A stolen admin token stays useful only briefly |
| One live token | `ONE_TOKEN_PER_CLIENT` (on) | Piling up many valid tokens: each new login (client or admin) cancels the previous token; rotating a secret cancels its token too |
| Browser hardening | CSP with per-request nonce, `X-Frame-Options: DENY`, `no-store` | Injected scripts stealing the token, clickjacking, cached secrets |

Also: the database stores only hashes of client secrets; secrets are compared in constant time; failed logins are logged with IP (`"failed login"` in the server log).

**Turn on 2FA:**

```bash
npm run admin:2fa
```

Copy the printed `ADMIN_TOTP_SECRET=...` line into `.env`, add the secret to your authenticator app (Google Authenticator, 1Password, Authy: "enter a setup key"), restart, and enter the 6-digit code on the dashboard login.

**Behind a reverse proxy** (Caddy/nginx on the same machine): set `TRUST_PROXY=true` so the allowlist and lockout see the real client IP. Never set it when the server is reachable directly, or clients could fake their IP.

## Notes

- `temperature` / `top_p` / `top_k` are rejected by current Claude models, so they aren't settings. Use `CLAUDE_EFFORT`.
- Costs come from the price table in [src/claude.ts](src/claude.ts). Check it against Anthropic's pricing page, and compare monthly totals with the Anthropic Console.
- Per-minute counters and "resting" key state are kept in memory: fine for one server, reset on restart.
- Use HTTPS in production (e.g. Caddy in front); tokens and secrets travel in headers and bodies.
- Set a monthly spend limit on the Anthropic Console workspace too, as a company-wide backstop.
