# GenAI Gateway: Client Guide

This guide is for **people and apps that send prompts** to the company GenAI Gateway.
You don't need an Anthropic or OpenAI account or API key. The gateway handles that. Claude uses `/send`; OpenAI uses `/openai/send` and requires an admin grant. Both use the same client login and token. Your monthly budget and requests-per-minute limit are shared across providers.

---

## 1. What you get from the admin

| Item | Looks like | Keep it secret? |
|---|---|---|
| **Base URL** | `https://claude.parampreetsingh.dev/api/assistant` | No |
| **Client ID** | `cl_7f3a9c...` | Not really, but don't post it publicly |
| **Client secret** | `cs_Q2xhdWRl...` | **Yes. Treat it like a password.** |
| **Your limits** | e.g. $50 per month, 20 requests per minute | No |

Lost the secret? Ask the admin to **rotate** it. They can't look it up; only a hash is stored.

---

## 2. How it works in 30 seconds

1. **Log in:** send your client ID + secret to `/token`. You get an **access token** valid for **60 minutes**.
2. **Ask:** send prompts to `/send` (Claude) or `/openai/send` (OpenAI) with the token in the `Authorization` header. Reuse the same token for every request. The diagrams below illustrate the Claude path.
3. **Renew:** after the token expires (or you get `401 Token expired`), log in again. Earlier logins return `409`; keep using your current token.

```mermaid
sequenceDiagram
    autonumber
    participant You as Your app / Postman
    participant G as GenAI Gateway

    rect rgb(230, 240, 255)
    Note over You,G: STEP 1: log in (once per 60 min)
    You->>G: POST /token {clientId, clientSecret}
    G-->>You: {accessToken, expiresAt}
    You->>You: save accessToken + expiresAt
    end

    rect rgb(230, 255, 235)
    Note over You,G: STEP 2: ask Claude (as often as you want, within your limits)
    You->>G: POST /send {prompt}<br/>Authorization: Bearer accessToken
    G-->>You: {output, usage, costUsd, timestamp}
    You->>G: POST /send {prompt} (same token)
    G-->>You: {output, ...}
    end

    rect rgb(255, 240, 230)
    Note over You,G: STEP 3: after 60 min
    You->>G: POST /send (old token)
    G-->>You: 401 Token expired
    You->>G: back to STEP 1
    end
```

### What your code should do before every request

```mermaid
flowchart TD
    A(["Need to ask Claude"]) --> B{"Do I have a token<br/>that has not expired?"}
    B -- yes --> D["POST /send<br/>Authorization: Bearer token"]
    B -- no --> C["POST /token<br/>save accessToken + expiresAt"]
    C -- "200" --> D
    C -- "409" --> L["Use your saved token, or wait<br/>retryAfterSeconds before login"]
    D --> E{"Response status?"}
    E -- "200" --> F(["✅ Use output"])
    E -- "401 Token expired" --> C
    E -- "429" --> W["Wait retryAfterSeconds,<br/>then try again"] --> D
    E -- "402 / 401 Client disabled" --> X(["⛔ Stop: contact the admin"])
    E -- "400" --> Y(["Fix your request body"])
    E -- "502" --> Z(["Try again later"])
```

---

## 3. Quick start with curl

Replace `BASE`, `cl_...` and `cs_...` with your values.

```bash
BASE=https://claude.parampreetsingh.dev/api/assistant
```

**Step 1: get a token**

```bash
curl -X POST $BASE/token \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"cl_...","clientSecret":"cs_..."}'
```

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tokenType": "Bearer",
  "role": "client",
  "expiresIn": 3600,
  "expiresAt": "2026-11-04T11:15:00.000Z"
}
```

**Step 2: ask Claude**

```bash
curl -X POST $BASE/send \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer eyJhbGciOi...' \
  -d '{"prompt":"Explain what an API is in 2 lines","systemPrompt":"You are a concise teacher."}'
```

```json
{
  "output": "An API is a set of rules that lets programs talk to each other...",
  "model": "claude-haiku-5-5",
  "stopReason": "end_turn",
  "usage": {
    "inputTokens": 24,
    "outputTokens": 61,
    "cacheWriteTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 85,
    "costUsd": 0.000033
  },
  "timestamp": "2026-11-04T10:15:32.481Z",
  "durationMs": 1240
}
```

**Step 3: check your spend**

```bash
curl $BASE/me/usage -H 'Authorization: Bearer eyJhbGciOi...'
```

**Ask OpenAI with the same token** (after the admin grants access):

```bash
curl -X POST $BASE/openai/send \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer eyJhbGciOi...' \
  -d '{"prompt":"Explain what an API is in 2 lines","systemPrompt":"Be concise."}'
```

---

## 4. Quick start with Postman

For admin, client, security, limits, key failover and reporting checks, follow [POSTMAN_GUIDE.md](POSTMAN_GUIDE.md).

1. **Token request**
   - `POST {{BASE}}/token`
   - Body → raw → JSON: `{"clientId":"cl_...","clientSecret":"cs_..."}`
   - Send, copy `accessToken`.
2. **Send request**
   - `POST {{BASE}}/send`
   - **Authorization** tab → Type **Bearer Token** → paste the token.
   - Body → raw → JSON: `{"prompt":"Hello"}`
3. After 60 minutes, repeat step 1 and paste the new token.

Tip: save `BASE`, `clientId` and `clientSecret` as Postman **environment variables** (mark the secret as *secret* type), so they aren't stored in the request itself.

---

## 5. Endpoint reference

All paths are relative to the base URL. Requests and responses are JSON. Send `Content-Type: application/json` on POST requests.

### 5.1 `POST /token`: log in

| | |
|---|---|
| Auth | none (your ID + secret are in the body) |
| Body | `clientId` (string, required), `clientSecret` (string, required) |

**200 response**

| Field | Type | Meaning |
|---|---|---|
| `accessToken` | string | Send it as `Authorization: Bearer <accessToken>` |
| `tokenType` | `"Bearer"` | |
| `role` | `"client"` | |
| `expiresIn` | number | Seconds until expiry (3600 = 60 min) |
| `expiresAt` | string | Expiry time, ISO 8601 UTC |

**Errors:** `401 Invalid credentials` (wrong ID or secret, **or** your client is disabled; the message is the same on purpose), `400` (body missing fields).

### 5.2 `POST /send`: ask Claude

| | |
|---|---|
| Auth | `Authorization: Bearer <accessToken>` |
| Body | `prompt` (string, required, not empty), `systemPrompt` (string, optional) |

- `prompt`: what you want to ask.
- `systemPrompt`: instructions for how Claude should behave (role, tone, format). If you leave it out, the gateway's default is used.
- Any other fields in the body are ignored.
- There's a maximum length for `prompt` + `systemPrompt` (ask the admin; default 50,000 characters each).

**200 response**

| Field | Type | Meaning |
|---|---|---|
| `output` | string | Claude's answer |
| `model` | string | Model that answered |
| `stopReason` | string | `end_turn` = finished normally; `max_tokens` = answer was cut off at the length limit |
| `usage.inputTokens` | number | Tokens in your prompt + system prompt |
| `usage.outputTokens` | number | Tokens Claude generated (includes its hidden reasoning, which is billed) |
| `usage.cacheWriteTokens` / `cacheReadTokens` | number | Usually 0 |
| `usage.totalTokens` | number | Sum of the above |
| `usage.costUsd` | number | What this request cost, in US dollars |
| `timestamp` | string | When Claude finished, ISO 8601 UTC |
| `durationMs` | number | How long Claude took, in milliseconds |

**422 response:** Claude declined the request (`"error": "Request declined by model"`). It still includes `usage`, because those tokens are billed.

### 5.3 `GET /me/usage`: your spend this month

| | |
|---|---|
| Auth | `Authorization: Bearer <accessToken>` |

```json
{
  "clientId": "cl_7f3a...",
  "name": "Priya - data team",
  "monthStart": "2026-11-01T00:00:00.000Z",
  "spentUsd": 1.2345,
  "requests": 87,
  "monthlyBudgetUsd": 50,
  "remainingUsd": 48.7655,
  "requestsPerMinute": 20
}
```

`monthlyBudgetUsd` / `requestsPerMinute` = `null` means no limit. Months are calendar months in **UTC**.
`spentUsd`, `requests`, and `remainingUsd` include both Claude and OpenAI. The budget check uses completed recorded spend; in-flight requests can exceed the remaining allowance.

### 5.4 `GET /health`: is the gateway up

No auth. Returns `{"status":"ok", ...}`.

### 5.5 `POST /openai/send`: ask OpenAI

Uses the same token and `{prompt, systemPrompt?}` body as `/send`, with the same per-field character limits. The admin must enable OpenAI access for your client; a valid token alone is insufficient. Access changes take effect on the next request without logging in again.

The success response has the same fields as `/send`. Differences:

- `model`: the configured OpenAI model (default `gpt-4.1-mini`, which may be returned as its dated snapshot).
- `stopReason`: `completed` for a finished answer; `max_output_tokens` for partial output at the output cap. Other incomplete reasons may also be returned.
- `usage.inputTokens`: uncached input tokens. `cacheReadTokens` records cached input separately; `cacheWriteTokens` is zero. Their sum plus `outputTokens` equals `totalTokens`.
- `usage.costUsd`: estimated cost using cached/uncached input and output prices. Refusals return `422` with usage and cost.
- `503`: OpenAI has no configured keys; contact the admin.

Each request is independent. There is no OpenAI SDK compatibility, client streaming, tools, file/image inputs, conversation ID, or per-request model selection. To adapt the JavaScript/Python examples below for OpenAI, replace `/send` with `/openai/send`.

---

## 6. Errors and what to do

Every error has a JSON body with an `error` message.

| Status | `error` message | Why | What to do |
|---|---|---|---|
| 400 | (validation message) | Body is wrong, e.g. empty or missing `prompt` | Fix the request |
| 401 | `Invalid credentials` | Wrong ID/secret at `/token`, or client disabled | Check values; if correct, ask the admin |
| 401 | `Missing or invalid token` | No `Authorization` header, a typo, or a changed token | Send `Bearer <accessToken>` exactly as received |
| 401 | `Token expired` | Token is older than 60 min | Call `/token` again |
| 401 | `Token revoked` | Admin rotated your secret, or a deployment revoked legacy tokens | Log in with your current credentials; obtain the new secret from the admin after rotation |
| 401 | `Client disabled` | Admin disabled your client | Ask the admin |
| 402 | `Monthly budget exceeded` | You've used your monthly budget (`budgetUsd`, `spentUsd` included) | Ask the admin to raise it, or wait for next month (UTC) |
| 403 | `Origin not allowed` | Called from a web page on a site that isn't approved | Ask the admin to add your site, or call from your backend |
| 403 | `Use a client account for this route` | Used an admin token on `/send` | Use a client ID + secret |
| 403 | `OpenAI access is not enabled for this client` | Admin has not granted access or revoked it | Ask the admin |
| 409 | `Client already has an active token` | Valid credentials, but the current token has not expired | Keep using your saved token. Otherwise wait `retryAfterSeconds` until `expiresAt`, or ask the admin to rotate your secret |
| 429 | `Too many failed logins. Try again later.` | 5 failed `/token` attempts from your IP in 15 min | Wait `retryAfterSeconds`; check your ID and secret |
| 429 | `Rate limit: N requests per minute` | You sent too many requests in the last minute | Wait `retryAfterSeconds` (also in the `retry-after` header) |
| 429 | `All real keys are rate limited, retry later` | Company-wide Anthropic limit hit | Wait ~30–60 s and retry |
| 429 | `OpenAI keys are rate limited, retry later` | OpenAI keys are throttled or cooling down | Wait before retrying |
| 502 | `Upstream AI error` | Provider failure, timeout, disconnect, or invalid response | Check before resubmitting; the provider may already have charged |
| 503 | `OpenAI has no configured keys` | No numbered OpenAI keys configured in the server environment | Contact the admin |

**Automatic retries:** `401 Token expired` (after a new login), or `429` after waiting. For `/token` returning `409`, reuse your existing token or wait the returned `retryAfterSeconds` before trying login again. A `502` can mean the provider processed the request before a timeout/disconnect; resubmitting may incur another charge.
**Don't retry:** `400`, `401 Invalid credentials`, `401 Client disabled`, `402`, `403`.

---

## 7. Code examples

### 7.1 JavaScript / TypeScript (Node 18+)

```ts
const BASE = process.env.GATEWAY_URL!;          // e.g. https://claude.parampreetsingh.dev/api/assistant
const CLIENT_ID = process.env.GATEWAY_CLIENT_ID!;
const CLIENT_SECRET = process.env.GATEWAY_CLIENT_SECRET!;

let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  // Early renewal returns 409; reuse the token until expiry.
  if (token && token.expiresAt > Date.now()) return token.value;

  const res = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${(await res.json()).error}`);
  const body = await res.json();
  token = { value: body.accessToken, expiresAt: new Date(body.expiresAt).getTime() };
  return token.value;
}

export async function ask(prompt: string, systemPrompt?: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${BASE}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
      body: JSON.stringify({ prompt, systemPrompt }),
    });
    const body = await res.json();

    if (res.ok) return body; // { output, usage, timestamp, ... }
    if (res.status === 401 && body.error === "Token expired") { token = null; continue; }
    if (res.status === 429) { await sleep((body.retryAfterSeconds ?? 30) * 1000); continue; }
    throw new Error(`${res.status}: ${body.error ?? body.message}`); // 400, 402, 403, other 401
  }
  throw new Error("Gave up after 3 attempts");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Usage
const r = await ask("Summarize: the meeting moved to Friday.", "Answer in one sentence.");
console.log(r.output, `($${r.usage.costUsd})`);
```

### 7.2 Python (requests)

```python
import os, time, requests
from datetime import datetime, timezone

BASE = os.environ["GATEWAY_URL"]                # e.g. https://claude.parampreetsingh.dev/api/assistant
CLIENT_ID = os.environ["GATEWAY_CLIENT_ID"]
CLIENT_SECRET = os.environ["GATEWAY_CLIENT_SECRET"]

_token = {"value": None, "expires_at": 0.0}

def get_token() -> str:
    # Early renewal returns 409; reuse the token until expiry.
    if _token["value"] and _token["expires_at"] > time.time():
        return _token["value"]
    r = requests.post(f"{BASE}/token", json={"clientId": CLIENT_ID, "clientSecret": CLIENT_SECRET}, timeout=30)
    r.raise_for_status()
    body = r.json()
    _token["value"] = body["accessToken"]
    _token["expires_at"] = datetime.fromisoformat(body["expiresAt"].replace("Z", "+00:00")).timestamp()
    return _token["value"]

def ask(prompt: str, system_prompt: str | None = None) -> dict:
    payload = {"prompt": prompt, **({"systemPrompt": system_prompt} if system_prompt else {})}
    for attempt in range(1, 4):
        r = requests.post(f"{BASE}/send", json=payload,
                          headers={"Authorization": f"Bearer {get_token()}"}, timeout=600)
        body = r.json()
        if r.ok:
            return body  # {"output", "usage", "timestamp", ...}
        if r.status_code == 401 and body.get("error") == "Token expired":
            _token["value"] = None
            continue
        if r.status_code == 429:
            time.sleep(body.get("retryAfterSeconds", 30))
            continue
        raise RuntimeError(f"{r.status_code}: {body.get('error') or body.get('message')}")  # 400, 402, 403, other 401
    raise RuntimeError("Gave up after 3 attempts")

if __name__ == "__main__":
    res = ask("Give me 3 names for a coffee shop.", "Be creative, one line each.")
    print(res["output"], f"(${res['usage']['costUsd']})")
```

---

## 8. Rules and good practice

**Security**
- ⛔ **Never put the client secret in browser or mobile app code.** Anyone can read it there. Keep it on a server, in environment variables or a secrets manager.
- ⛔ Never commit the secret or a token to git, or paste them into chat, tickets or websites.
- If you think your secret leaked, tell the admin right away. They can rotate it, and disable your client instantly if needed.
- Use `https://` for the base URL outside your own machine.

**Tokens**
- **Only one unexpired token per client.** Repeated `/token` calls return `409` and leave the existing token and expiry unchanged. Don't call `/token` before every prompt.
- Renew **after** `expiresAt` or `401 Token expired`. Responses use the token's exact expiry; allow for clock differences if login still returns `409`.
- Running several copies of your app? Ask the admin for **one client per copy**, or securely share one token. Serialize token acquisition within each app so parallel requests don't compete to log in. The examples above assume sequential calls; concurrent callers must share the in-flight login too.
- If you lose the token or restart an app that only cached it in memory, wait until expiry or ask the admin to rotate your client secret. A `409` response never returns the existing token.

**Cost**
- Every response tells you its `costUsd`. Check `/me/usage` to see your monthly total.
- Shorter prompts and asking for shorter answers cost less.
- A `502` is recorded with zero estimated cost when usage is unknown; the provider may still have charged. Ask the admin to reconcile upstream billing.

**Timeouts**
- Long answers can take a while. Allow at least **60 seconds** (up to 10 minutes for very long outputs) before your HTTP client gives up.

---

## 9. FAQ

**Can I see which provider key or model was used?** The model is in the `model` field. The key is internal; the admin sees only masked OpenAI key details.

**Does the gateway keep my prompts?** No. It stores only token counts, cost, timing and status for each request, not the text.

**Can I have a conversation (multiple turns)?** Each `/send` or `/openai/send` is independent. Include the relevant earlier text in your `prompt`.

**Can I pick the model or settings (temperature, etc.)?** Not per request. The admin sets the model and settings for the whole gateway.

**My answer ends mid-sentence.** `stopReason` may be `max_tokens` (Claude) or `max_output_tokens` (OpenAI): the answer hit the output limit. Ask for a shorter answer, or ask the admin about the limit.

**Who do I contact?** Your gateway admin: _<add name / channel here>_.
