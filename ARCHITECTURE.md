# Claude Gateway: Architecture

This document explains how the gateway is built, at two levels of detail, and walks through the main flows step by step.

- **Part 1, HLD (high-level design):** the big boxes and how they talk.
- **Part 2, LLD (low-level design):** the code modules, the request pipeline, the data model, and the key pool.
- **Part 3, sequence diagrams:** what happens, in order, for each main flow.

---

## Part 1: High-level design (HLD)

### 1.1 System context

```mermaid
flowchart LR
    subgraph USERS["Users"]
        CL["Client apps / scripts / Postman<br/>(hold clientId + clientSecret)"]
        AD["Admin in a browser<br/>(holds ADMIN_ID + secret + 2FA app)"]
    end

    subgraph SERVER["Gateway server (one Node.js process)"]
        SEC["[1] Security layer<br/>origin check, headers,<br/>admin IP allowlist, login lockout"]
        AUTH["[2] Auth<br/>/token: verify credentials<br/>issue 60-min JWT"]
        API["[3] API routes<br/>/send, /me/usage"]
        ADM["[4] Admin routes + dashboard<br/>/admin, /admin/*"]
        LIM["[5] Limits<br/>monthly budget, requests/min"]
        POOL["[6] Key pool<br/>round robin + failover"]
        COST["[7] Cost calculator<br/>tokens x price table"]
    end

    DB[("[8] SQLite file<br/>clients, usage")]
    ENV[/"[9] .env<br/>real keys, admin creds,<br/>JWT secret, settings"/]

    subgraph ANT["Anthropic"]
        K1["Real key 1"]
        K2["Real key 2"]
        K3["Real key 3"]
        CLAUDE["Claude API"]
    end

    CL -- "HTTPS" --> SEC
    AD -- "HTTPS" --> SEC
    SEC --> AUTH
    SEC --> API
    SEC --> ADM
    API --> LIM --> POOL
    POOL --> K1 --> CLAUDE
    POOL --> K2 --> CLAUDE
    POOL --> K3 --> CLAUDE
    POOL --> COST --> DB
    AUTH --> DB
    ADM --> DB
    LIM --> DB
    ENV -. "read at startup" .-> SERVER
```

### 1.2 What each box does

| # | Component | Responsibility | Lives in |
|---|---|---|---|
| 1 | Security layer | Rejects browser calls from unknown sites; adds security headers; hides admin from non-allowed IPs; blocks IPs after repeated failed logins | `src/server.ts` (hooks) |
| 2 | Auth | Checks client ID + secret (or admin ID + secret + 2FA code) and signs a short-lived JWT | `src/server.ts` (`/token`), `src/totp.ts` |
| 3 | API routes | `/send` forwards a prompt to Claude; `/me/usage` shows a client its spend | `src/server.ts` |
| 4 | Admin routes | Create, update, disable and rotate clients; usage reports; serves the dashboard page | `src/server.ts`, `src/admin.html` |
| 5 | Limits | Stops a client over its monthly budget (402) or per-minute limit (429) before any cost is spent | `src/server.ts` (`enforceLimits`) |
| 6 | Key pool | Picks the next real Anthropic key; on rate limit or outage, rests that key and retries on the next | `src/claude.ts` |
| 7 | Cost calculator | Turns token counts into US dollars using the price table | `src/claude.ts` |
| 8 | SQLite | Persists clients (secret **hashes** only) and one usage row per request | `src/db.ts`, `data/gateway.db` |
| 9 | `.env` | Configuration and secrets; never sent to clients | project root |

### 1.3 Trust boundaries

```mermaid
flowchart LR
    subgraph Z1["Zone A: untrusted (internet / office network)"]
        C["Clients"]
        B["Admin browser"]
    end
    subgraph Z2["Zone B: gateway server"]
        G["Gateway process"]
        D[("SQLite")]
        E[/".env"/]
    end
    subgraph Z3["Zone C: Anthropic"]
        A["Claude API"]
    end

    C -- "client secret once per hour,<br/>then JWT on every request" --> G
    B -- "admin secret + 2FA code,<br/>then 15-min JWT" --> G
    G -- "real Anthropic key<br/>(never leaves zone B except to Anthropic)" --> A
    G --- D
    G --- E
```

- Real Anthropic keys exist only in zone B and are sent only to Anthropic.
- Client secrets cross from zone A once (at login) and are stored only as SHA-256 hashes.
- Everything after login uses a signed token that expires (60 min for clients, 15 min for the admin).

---

## Part 2: Low-level design (LLD)

### 2.1 Modules and their main functions

```mermaid
classDiagram
    class server_ts {
        config (from .env)
        onRequest: origin check
        onSend: security headers
        verifyToken(req)
        requireClient(req) : looks up client in DB
        requireAdmin(req) : IP allowlist + role
        enforceLimits(req) : budget + requests/min
        loginLockedFor(ip) / recordLoginFailure(ip)
        POST /token
        POST /send
        GET /me/usage
        GET /admin (CSP nonce)
        /admin/clients, /admin/usage, /admin/keys
    }
    class claude_ts {
        PRICES table
        costUsd(model, usage)
        createKeyPool(keys)
        pool.send(params) : round robin + failover
        pool.status()
        cooldownMs(error)
        UpstreamError
    }
    class db_ts {
        openDb(path) : creates tables
        getClient / insertClient / updateClient
        listClients(monthStart)
        insertUsage(row)
        spendSince(clientId, since)
        usageSummary(from, to, groupBy)
        recentUsage(clientId, limit)
    }
    class totp_ts {
        createTotpVerifier(secret) : one use per code
        totpCode(key, step)
        base32Encode / base32Decode
        npm run admin:2fa
    }
    class admin_html {
        login form (ID, secret, 2FA code)
        stats, daily chart, clients table
        create client, limits dialog
        rotate / disable, recent requests
    }

    server_ts --> claude_ts : sends prompts, prices usage
    server_ts --> db_ts : reads clients, writes usage
    server_ts --> totp_ts : checks admin code
    server_ts --> admin_html : serves with CSP nonce
    admin_html ..> server_ts : fetch /token, /admin/*
```

### 2.2 Request pipeline for `POST /send`

Fastify runs these stages in a fixed order. Any stage can stop the request with an error; nothing reaches Anthropic until stage 7.

```mermaid
flowchart TD
    S0(["Request arrives"]) --> S1
    S1["Step 1: Global onRequest hook<br/>Origin header present and not allowed?"] -->|blocked| X1["403 Origin not allowed"]
    S1 -->|ok| S2
    S2["Step 2: requireClient<br/>verify JWT signature + expiry<br/>role must be client"] -->|bad / expired| X2["401 Missing / invalid / expired token"]
    S2 -->|ok| S3
    S3["Step 3: requireClient<br/>load client from DB<br/>status must be active<br/>token id must equal client.token_id"] -->|disabled| X3["401 Client disabled"]
    S3 -->|older token| X3b["401 Token replaced by a newer login"]
    S3 -->|ok| S4
    S4["Step 4: enforceLimits<br/>SUM(cost) this month vs budget"] -->|over| X4["402 Budget exceeded"]
    S4 -->|ok| S5
    S5["Step 5: enforceLimits<br/>requests in last 60 s vs limit"] -->|over| X5["429 Rate limit + retryAfterSeconds"]
    S5 -->|ok| S6
    S6["Step 6: JSON schema validation<br/>prompt: non-empty string"] -->|invalid| X6["400 Bad request"]
    S6 -->|ok| S7
    S7["Step 7: Handler<br/>pool.send(model, system, prompt)"] -->|all keys failed| X7["429 / 502<br/>usage row logged with cost 0"]
    S7 -->|answer| S8
    S8["Step 8: costUsd(model, usage)<br/>INSERT usage row<br/>UPDATE client.last_used_at"] --> S9
    S9["Step 9: onSend hook<br/>add security headers"] --> S10(["200 output, usage, costUsd,<br/>timestamp, durationMs"])
```

### 2.3 `POST /token` logic

```mermaid
flowchart TD
    T0(["POST /token {clientId, clientSecret, otp?}"]) --> T1{"Step 1: IP locked out?<br/>(5 failures in 15 min)"}
    T1 -->|yes| TX1["429 Too many failed logins"]
    T1 -->|no| T2{"Step 2: clientId == ADMIN_ID?"}

    T2 -->|yes| A1["Step 3a: compare secret hash (constant time)"]
    A1 --> A2["Step 4a: IP in ADMIN_ALLOWED_IPS?"]
    A2 --> A3["Step 5a: 2FA code valid and unused?<br/>(only if ADMIN_TOTP_SECRET set)"]
    A3 --> A4{"all three ok?"}
    A4 -->|no| F["record failure for IP<br/>log 'failed login'<br/>401 Invalid credentials"]
    A4 -->|yes| A5["Step 6a: new token id kept in memory<br/>sign JWT role = admin, exp = 15 min<br/>(older admin token stops working)"]

    T2 -->|no| C1["Step 3b: load client by id<br/>(compare against a dummy hash if missing)"]
    C1 --> C2{"exists, secret matches,<br/>status active?"}
    C2 -->|no| F
    C2 -->|yes| C3["Step 4b: new token id saved as client.token_id<br/>sign JWT role = client, exp = 60 min<br/>(older tokens stop working)"]

    A5 --> OK(["200 accessToken, expiresAt"])
    C3 --> OK
```

The error is always the same `401 Invalid credentials`, so a guesser can't tell whether the ID, the secret, the 2FA code or the IP was wrong.

### 2.4 Data model

```mermaid
erDiagram
    CLIENTS ||--o{ USAGE : "has many"
    CLIENTS {
        text client_id PK "cl_ + 16 hex"
        text name
        text secret_hash "sha256 of cs_... secret"
        text status "active or disabled"
        real monthly_budget_usd "null = unlimited"
        int requests_per_minute "null = unlimited"
        text created_at
        text last_used_at
        text token_id "only token allowed right now"
    }
    USAGE {
        int id PK
        text client_id FK
        int real_key "which key served it"
        text model
        int input_tokens
        int output_tokens
        int cache_read_tokens
        int cache_write_tokens
        real cost_usd
        int duration_ms
        int http_status "200, 422, 429, 502"
        text created_at "ISO UTC"
    }
```

Indexes: `usage(client_id, created_at)` for budget checks, `usage(created_at)` for reports.

In memory only (reset on restart): per-minute request counters, failed-login counters, which real keys are resting, last used 2FA step.

### 2.5 Key pool behaviour

```mermaid
stateDiagram-v2
    [*] --> Ready
    Ready --> Ready: request succeeds
    Ready --> Resting: 429 rate limited (retry-after, default 30 s)
    Ready --> Resting: 5xx / 529 / network error (10 s)
    Ready --> Resting: 401 / 403 key rejected (5 min)
    Resting --> Ready: rest time over
    Resting --> Resting: tried only when every key is resting
```

Order of keys for each request: start at the next key in rotation, Ready keys first, Resting keys last. A `400` (bad request) does not switch keys, because it would fail on every key.

---

## Part 3: Sequence diagrams

### 3.1 Client: log in, ask, renew

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as Gateway
    participant D as SQLite
    participant P as Key pool
    participant A as Claude API

    Note over C,G: Log in (once per 60 min)
    C->>G: POST /token {clientId, clientSecret}
    G->>G: IP locked out? no
    G->>D: SELECT client WHERE client_id
    D-->>G: secret_hash, status
    G->>G: sha256(secret) == secret_hash, status active
    G->>D: UPDATE client SET token_id = new id (older tokens now invalid)
    G-->>C: 200 {accessToken, expiresAt = now + 60 min}

    Note over C,A: Ask Claude (every request)
    C->>G: POST /send {prompt} + Bearer token
    G->>G: verify JWT signature + expiry
    G->>D: client still active? token id == token_id? month spend under budget?
    G->>G: under requests/min?
    G->>P: send(prompt)
    P->>A: Messages API with real key N
    A-->>P: answer + token counts
    P-->>G: message, keyId
    G->>G: cost = tokens x price
    G->>D: INSERT usage row, UPDATE last_used_at
    G-->>C: 200 {output, usage, costUsd, timestamp}

    Note over C,G: After 60 min
    C->>G: POST /send + old token
    G-->>C: 401 Token expired
    C->>G: POST /token again
```

### 3.2 Admin: sign in with 2FA, create a client

```mermaid
sequenceDiagram
    autonumber
    participant AD as Admin browser
    participant G as Gateway
    participant T as 2FA verifier
    participant D as SQLite

    AD->>G: GET /admin
    G->>G: IP in ADMIN_ALLOWED_IPS? (else 404)
    G-->>AD: dashboard HTML + CSP with fresh nonce
    AD->>G: POST /token {admin id, secret, otp}
    G->>G: IP locked out? no
    G->>G: secret hash matches (constant time)
    G->>T: code valid for this 30 s window and not used before?
    T-->>G: yes (step marked as used)
    G-->>AD: 200 {accessToken, role admin, 15 min}
    AD->>G: POST /admin/clients {name, limits} + Bearer
    G->>G: IP allowed, token valid, role admin
    G->>G: generate cl_ id + cs_ secret
    G->>D: INSERT client with sha256(secret)
    G-->>AD: 201 {clientId, clientSecret} (secret shown once)
```

### 3.3 Failover when a real key is rate limited

```mermaid
sequenceDiagram
    autonumber
    participant G as Gateway
    participant P as Key pool
    participant K1 as Real key 1
    participant K2 as Real key 2

    G->>P: send(prompt)
    P->>P: next in rotation: key 1
    P->>K1: Messages API
    K1-->>P: 429 rate limited, retry-after 60
    P->>P: key 1 rests 60 s
    P->>K2: same request
    K2-->>P: 200 answer
    P-->>G: message, keyId = 2
    Note over P: Next requests skip key 1 until its rest ends
```

### 3.4 Password guessing is blocked

```mermaid
sequenceDiagram
    autonumber
    participant X as Attacker
    participant G as Gateway

    loop 5 wrong guesses
        X->>G: POST /token {admin, guess}
        G-->>X: 401 Invalid credentials (failure logged with IP)
    end
    X->>G: POST /token {admin, correct password}
    G-->>X: 429 Too many failed logins (checked before the password)
    Note over X,G: Blocked for 15 min. Even with the password,<br/>the 2FA code and allowed IP are still required.
```
