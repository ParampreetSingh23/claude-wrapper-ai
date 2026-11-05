# Claude Gateway: Plan

Status: **built** (all steps in section 10). Decisions from section 11 are applied: requests spread across all real keys automatically with failover, and per-client limits.

---

## 0. The words used in this plan

| Word | What it is | How many |
|---|---|---|
| **Admin** | The one person who manages the gateway. Logs in with the admin ID + secret from `.env`. | **1** |
| **Client** (virtual key) | A name + `clientId` + `clientSecret` that the admin creates and gives to a person or app. | **Unlimited** |
| **Real key** | An actual Anthropic API key (`sk-ant-...`). Only the gateway knows them. Clients never see them. | **3** |
| **Access token** | A temporary pass the gateway gives a client after it logs in. Valid **60 minutes**. | 1 per login |

---

## 1. Big picture

```mermaid
flowchart LR
    ADMIN["👤 Admin<br/>(1)"]
    C1["Client A<br/>virtual key"]
    C2["Client B<br/>virtual key"]
    C3["Client ...N<br/>virtual key"]

    subgraph GW ["Claude Gateway"]
        TOKEN["POST /token<br/>check ID + secret,<br/>give 60-min token"]
        SEND["POST /send<br/>check token,<br/>call Claude"]
        ADMINAPI["/admin/*<br/>create / disable clients,<br/>see spend"]
        DB[("Database<br/>clients + usage")]
    end

    subgraph REAL ["3 real Anthropic keys (.env)"]
        K1["Real key 1"]
        K2["Real key 2"]
        K3["Real key 3"]
    end

    CLAUDE["Claude API"]

    ADMIN --> ADMINAPI
    C1 --> TOKEN
    C2 --> TOKEN
    C3 --> TOKEN
    C1 --> SEND
    C2 --> SEND
    C3 --> SEND
    ADMINAPI --> DB
    TOKEN --> DB
    SEND --> DB
    SEND --> K1 --> CLAUDE
    SEND --> K2 --> CLAUDE
    SEND --> K3 --> CLAUDE
```

In one sentence: **clients log in with their virtual key, get a 60-minute token, use the token to ask Claude, and the gateway pays with one of the 3 real keys and records the cost against that client.**

---

## 2. Setup: admin creates a client

This happens once per person/app.

```mermaid
sequenceDiagram
    autonumber
    participant AD as Admin
    participant G as Gateway
    participant D as Database

    Note over AD,G: STEP A1: admin logs in
    AD->>G: POST /token {clientId: ADMIN_ID, clientSecret: ADMIN_SECRET}
    G-->>AD: accessToken (role = admin, 60 min)

    Note over AD,G: STEP A2: admin creates a client
    AD->>G: POST /admin/clients {name: "Priya - data team",<br/>monthlyBudgetUsd: 20, requestsPerMinute: 10}<br/>Authorization: Bearer adminToken
    G->>G: generate clientId + random clientSecret
    G->>D: save name, clientId, HASH of secret, limits, status = active
    G-->>AD: {clientId, clientSecret}  ← secret shown ONLY this once

    Note over AD: STEP A3: admin gives clientId + clientSecret<br/>to Priya privately (password manager)
```

- The database never stores the secret itself, only a hash. If the admin loses it, they create a new secret (rotate), they can't look it up.
- The admin can later **disable** a client. It stops working on its very next request (see step 5 of the main flow).

---

## 3. ⭐ Main flow: a client sends a request

### 3.1 The whole journey, step by step

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (app / Postman)
    participant G as Gateway
    participant D as Database
    participant A as Claude API

    rect rgb(230, 240, 255)
    Note over C,D: PART 1: GET A TOKEN (once per 60 min)
    C->>G: STEP 1: POST /token {clientId, clientSecret}
    G->>D: STEP 2: find client by clientId
    D-->>G: client row (secret hash, status)
    G->>G: STEP 3: compare hash(secret) with stored hash,<br/>check status = active
    G-->>C: STEP 4: 200 {accessToken, expiresAt = now + 60 min}
    C->>C: save accessToken + expiresAt
    end

    rect rgb(230, 255, 235)
    Note over C,A: PART 2: USE THE TOKEN (every request, for 60 min)
    C->>G: STEP 5: POST /send {prompt, systemPrompt}<br/>Authorization: Bearer accessToken
    G->>G: STEP 6: check token signature + not expired
    G->>D: STEP 7: is this client still active? under budget + rate limit?
    G->>A: STEP 8: call Claude with the next real key<br/>(if it is rate limited, retry on the next one)
    A-->>G: answer + token counts
    G->>D: STEP 9: save usage + cost for this client
    G-->>C: STEP 10: 200 {output, usage, costUsd, timestamp}
    end

    rect rgb(255, 240, 230)
    Note over C,G: PART 3: AFTER 60 MINUTES
    C->>G: POST /send with old token
    G-->>C: 401 Token expired
    C->>G: go back to STEP 1 for a new token
    end
```

### 3.2 What the gateway checks on `POST /send` (in order)

Each check can stop the request. Nothing reaches Claude until all pass.

```mermaid
flowchart TD
    START(["STEP 5: POST /send arrives"]) --> H1

    H1{"Check 1<br/>Authorization: Bearer header present?"}
    H1 -- no --> E1["❌ 401 Missing token"]
    H1 -- yes --> H2

    H2{"Check 2<br/>Token signature valid?<br/>(signed with JWT_SECRET)"}
    H2 -- no --> E2["❌ 401 Invalid token"]
    H2 -- yes --> H3

    H3{"Check 3<br/>Token younger than 60 min?"}
    H3 -- no --> E3["❌ 401 Token expired<br/>→ client calls /token again"]
    H3 -- yes --> H4

    H4{"Check 4<br/>Client still active in DB?"}
    H4 -- no --> E4["❌ 401 Client disabled"]
    H4 -- yes --> H5

    H5{"Check 5<br/>Under monthly budget?<br/>(if the client has one)"}
    H5 -- no --> E5["❌ 402 Budget exceeded"]
    H5 -- yes --> H6

    H6{"Check 6<br/>Under requests per minute?<br/>(if the client has a limit)"}
    H6 -- no --> E6["❌ 429 Rate limit<br/>+ retryAfterSeconds"]
    H6 -- yes --> H7

    H7{"Check 7<br/>Body valid?<br/>prompt is non-empty text"}
    H7 -- no --> E7["❌ 400 Bad request"]
    H7 -- yes --> CALL

    CALL["STEP 8: call Claude<br/>next real key in rotation,<br/>switch key if rate limited (see section 4)"] --> R{"Claude answered?"}
    R -- "no (all keys failed)" --> E8["❌ 502 / 429<br/>(failure still logged)"]
    R -- yes --> LOG["STEP 9: save usage row<br/>client, real key, tokens, cost, time"]
    LOG --> OK(["✅ STEP 10: 200 output + usage + cost"])
```

> **Why check the DB in Check 4 when the token is already valid?**
> A token alone can't be cancelled; it's valid until it expires. Checking the client's status on each request means that when the admin disables a client, it is **locked out immediately**, not up to 60 minutes later. It's one fast DB lookup.

### 3.3 What `POST /token` checks

```mermaid
flowchart TD
    S(["STEP 1: POST /token {clientId, clientSecret}"]) --> T1
    T1{"clientId exists?"}
    T1 -- no --> X["❌ 401 Invalid credentials"]
    T1 -- yes --> T2{"hash(clientSecret) matches?"}
    T2 -- no --> X
    T2 -- yes --> T3{"status = active?"}
    T3 -- no --> X
    T3 -- yes --> T4["Create token:<br/>sub = clientId, role = client/admin,<br/>exp = now + 60 min<br/>signed with JWT_SECRET"]
    T4 --> T5(["✅ 200 {accessToken, tokenType: Bearer,<br/>expiresIn: 3600, expiresAt}"])
```

Same error message for all three failures on purpose: an attacker can't learn whether a `clientId` exists.

### 3.4 The 60-minute timeline of one token

```mermaid
flowchart LR
    T0["⏱ 0 min<br/>POST /token<br/>token created"] --> T1["0 to 60 min<br/>every /send uses<br/>the same token"]
    T1 --> T2["⏱ 60 min<br/>token expires"]
    T2 --> T3["next /send<br/>→ 401 Token expired"]
    T3 --> T4["client calls<br/>POST /token again"]
    T4 --> T0
```

No refresh tokens: after 60 minutes the client simply logs in again with its ID + secret. (This removes the `/refresh` code that exists today.)

### 3.5 What the client's code does (client side)

```mermaid
flowchart TD
    A(["Want to ask Claude"]) --> B{"Have a saved token<br/>and expiresAt is more than<br/>1 minute away?"}
    B -- yes --> D["POST /send with Bearer token"]
    B -- no --> C["POST /token with clientId + clientSecret<br/>save accessToken + expiresAt"]
    C --> D
    D --> E{"Response?"}
    E -- "200" --> F(["Use the answer"])
    E -- "401 Token expired" --> C
    E -- "401 Client disabled / 402" --> G(["Stop: contact admin"])
```

Getting a new token one minute **before** expiry avoids a failed request at the 60-minute mark.

---

## 4. The 3 real Anthropic keys: automatic spread + failover

Stored only in the gateway's `.env`:

```
REAL_KEY_1=sk-ant-...
REAL_KEY_2=sk-ant-...
REAL_KEY_3=sk-ant-...
```

Clients are **not** tied to a key. Every request takes the **next key in turn** (round robin), so load spreads evenly across all 3.

### 4.1 Normal case: round robin

```mermaid
flowchart LR
    R1["Request 1"] --> K1["Real key 1"]
    R2["Request 2"] --> K2["Real key 2"]
    R3["Request 3"] --> K3["Real key 3"]
    R4["Request 4"] --> K1
    K1 --> CL["Claude API"]
    K2 --> CL
    K3 --> CL
```

### 4.2 When a key is rate limited: switch and rest it

```mermaid
flowchart TD
    S(["STEP 8: request needs a real key"]) --> PICK["Pick next key in rotation<br/>(resting keys go to the back of the line)"]
    PICK --> TRY["Call Claude with that key"]
    TRY --> OK{"Result?"}
    OK -- "✅ answer" --> DONE(["Return answer<br/>log which real key served it"])
    OK -- "429 rate limited" --> REST1["Rest this key for Anthropic's<br/>retry-after time (default 30 s)"]
    OK -- "500 / 529 overloaded / network" --> REST2["Rest this key 10 s"]
    OK -- "401 / 403 key revoked" --> REST3["Rest this key 5 min"]
    OK -- "400 bad request" --> FAIL(["Stop: another key won't help<br/>→ 502"])
    REST1 --> MORE{"Another key<br/>not tried yet?"}
    REST2 --> MORE
    REST3 --> MORE
    MORE -- yes --> TRY2["Try the next key"] --> OK
    MORE -- no --> ALL(["All keys failed<br/>→ 429 or 502 to client"])
```

- A resting key is skipped by new requests until its rest time ends, so one throttled key doesn't slow everyone down.
- If **all** keys are resting, they're still tried (oldest first) rather than refusing outright.
- The admin dashboard shows each key's requests, spend, errors, and whether it is resting right now.

## 5. Spend tracking

After every Claude call (STEP 9), one row is saved:

| client | real key | model | input tokens | output tokens | cost USD | time | status |
|---|---|---|---|---|---|---|---|
| Priya - data team | 2 | claude-opus-5-5 | 420 | 1 180 | 0.0253 | 10:15:32 | 200 |

`cost = input × input price + output × output price` (price table in code, per model).

The admin can then see:

```mermaid
flowchart LR
    LOG[("usage rows")] --> Q1["Spend per client<br/>this month"]
    LOG --> Q2["Spend per real key<br/>(compare with Anthropic Console)"]
    LOG --> Q3["Spend per day<br/>(chart)"]
    LOG --> Q4["Last requests<br/>of one client"]
```

- `GET /admin/usage?groupBy=client|realKey|day` returns these numbers.
- A simple `/admin` web page shows them as a table + chart (later phase).
- Each client can see its own spend with `GET /me/usage`.

### 5.1 Limits per client

| Limit | Set where | When exceeded |
|---|---|---|
| Monthly budget (USD) | Admin, per client (`monthlyBudgetUsd`) or default from `DEFAULT_MONTHLY_BUDGET_USD` | `402 Budget exceeded` until next month or admin raises it |
| Requests per minute | Admin, per client (`requestsPerMinute`) or default from `DEFAULT_REQUESTS_PER_MINUTE` | `429` with `retryAfterSeconds` |
| Max output per request | `.env` `CLAUDE_MAX_TOKENS` | caps the cost of one call |
| Whole company | Anthropic Console spend limit on the workspace | Anthropic refuses calls |

`null` / empty = unlimited. Changes apply on the client's **next** request, no restart.

---

## 6. What is stored

```mermaid
erDiagram
    CLIENTS ||--o{ USAGE : "makes"
    CLIENTS {
        text client_id PK "cl_7f3a..."
        text name "Priya - data team"
        text secret_hash "never the secret itself"
        text status "active | disabled"
        real monthly_budget_usd "empty = no limit"
        int requests_per_minute "empty = no limit"
        text created_at
        text last_used_at
    }
    USAGE {
        int id PK
        text client_id FK
        int real_key "which of the 3 served it"
        text model
        int input_tokens
        int output_tokens
        real cost_usd
        int duration_ms
        int http_status
        text created_at
    }
```

- Database: SQLite (one file, built into Node 26, nothing extra to install).
- The admin is **not** in the database; their ID + secret live in `.env`.
- Prompts and answers are **not** stored.

`.env` after the change:

```
ADMIN_ID=admin
ADMIN_SECRET=<long random>
JWT_SECRET=<long random>
TOKEN_TTL_MINUTES=60
REAL_KEY_1=sk-ant-...
REAL_KEY_2=sk-ant-...
REAL_KEY_3=sk-ant-...
DEFAULT_MONTHLY_BUDGET_USD=     # empty = unlimited
DEFAULT_REQUESTS_PER_MINUTE=    # empty = unlimited
CLAUDE_MODEL=claude-opus-5-5
... (other Claude settings as today)
```

---

## 7. Endpoints

| # | Method | Path | Who | What |
|---|---|---|---|---|
| 1 | GET | `/health` | anyone | is the server up |
| 2 | POST | `/token` | admin + clients | ID + secret → 60-min token |
| 3 | POST | `/send` | clients | ask Claude (admin creates a client for itself to test) |
| 4 | GET | `/me/usage` | clients | own spend this month |
| 5 | POST | `/admin/clients` | admin | create client → returns secret once |
| 6 | GET | `/admin/clients` | admin | list clients (no secrets) |
| 7 | PATCH | `/admin/clients/:id` | admin | rename, budget, requests/min, disable/enable |
| 8 | POST | `/admin/clients/:id/rotate-secret` | admin | new secret, old one stops working |
| 9 | GET | `/admin/usage` | admin | spend per client / real key / day / model |
| 10 | GET | `/admin/usage/:id` | admin | last 50 requests of one client |
| 11 | GET | `/admin/keys` | admin | real keys: ready or resting |
| 12 | GET | `/admin` | admin | dashboard page (logs in with admin ID + secret) |

All under the base path `/api/assistant` as today.

---

## 8. Every error a client can get

| Code | Message | Meaning | What to do |
|---|---|---|---|
| 400 | Bad request | Body is wrong (e.g. empty prompt) | Fix the request |
| 401 | Invalid credentials | Wrong clientId/secret, or client disabled, at `/token` | Check credentials / ask admin |
| 401 | Missing / invalid token | No token or a changed token | Call `/token` |
| 401 | Token expired | Older than 60 min | Call `/token` again |
| 401 | Client disabled | Admin disabled you | Ask admin |
| 402 | Budget exceeded | Monthly budget used up | Ask admin |
| 403 | Forbidden | Client token used on `/admin/*` | Use the admin account |
| 429 | Rate limit: N requests per minute | Client went over its own requests/min | Wait `retryAfterSeconds` |
| 429 | All real keys are rate limited | All 3 Anthropic keys are throttled | Wait and retry |
| 502 | Upstream AI error | Anthropic failed | Retry later; admin checks logs |

---

## 9. What changes from today's code

| Today | After |
|---|---|
| One `CLIENT_ID` / `CLIENT_SECRET` in `.env` | Unlimited clients in the database, created by the admin |
| One `ANTHROPIC_API_KEY` | 3 real keys, requests spread across them, auto-switch on rate limit |
| `/refresh` + refresh tokens | **Removed**: log in again after 60 min |
| No record of who spent what | Every request saved with client, real key, tokens, cost |
| Origin check on every request | Optional (only useful for browser frontends) |
| Disabling a client: edit `.env` + restart | Admin API, effective on the next request |

---

## 10. Build steps

| Step | Build | Test that proves it works |
|---|---|---|
| 1 | SQLite database + `clients` and `usage` tables | Server starts and creates the file |
| 2 | Admin login via `/token` using `.env` admin creds; `role` inside the token | Admin gets a token; client token on `/admin/*` → 403 |
| 3 | `/admin/clients` create / list / update / rotate-secret | Create a client, get its secret once |
| 4 | `/token` for clients from the database; remove `/refresh` | New client gets a 60-min token; wrong secret → 401 |
| 5 | `/send`: checks 1 to 7 + key pool with failover | Disabled client → 401 on next request; rate-limited key → next key |
| 6 | Save usage + cost after each call; `costUsd` in response; `/me/usage` | Usage row appears with correct cost |
| 7 | `/admin/usage` + monthly budget (check 5) | Over budget → 402 |
| 8 | `/admin` dashboard page | Admin sees spend per client and per real key |
| 9 | README + diagrams updated, deploy notes | Someone new can run it from the README |

---

## 11. Decisions (resolved)

| # | Question | Decision |
|---|---|---|
| 1 | How to use the 3 real keys | **Spread automatically** (round robin) + switch to the next key when one is rate limited |
| 2 | Limits | **Per-client monthly budget + requests per minute**, with defaults from `.env` |
| 3 | Admin storage | `.env` (exactly 1 admin) |
| 4 | Dashboard | Built: `/api/assistant/admin` |
| 5 | Origin check | Browsers from other sites blocked unless in `ALLOWED_ORIGINS`; scripts/Postman (no Origin) rely on the token |
