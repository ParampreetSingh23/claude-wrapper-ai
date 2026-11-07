# Verify the whole GenAI wrapper in Postman

Run the steps in order against your local server or staging deployment. Use a newly created test client so its limits and usage are isolated. Successful Claude/OpenAI requests use your real provider keys and can incur charges; use the short prompts below.

The app uses one login endpoint, client JWTs for prompts, and admin JWTs for management. OpenAI keys belong in server `.env`, never in Postman's Authorization field. Both providers share each client's budget and rate limit.

## 1. Prepare the server

Keep your current Claude/admin/JWT settings. Add the missing OpenAI settings with the [append-only command](README.md#add-missing-settings-without-replacing-your-existing-env), then fill at least one real key:

```ini
OPENAI_KEY_1=sk-your-first-real-key
OPENAI_KEY_2=
OPENAI_KEY_3=
OPENAI_KEY_4=
OPENAI_KEY_5=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_MAX_TOKENS=4096
OPENAI_TIMEOUT_MS=60000
```

Use up to five keys; leave unused slots empty. Restart after editing `.env` (stop/start `npm run dev`, or restart your deployed service). `OPENAI_KEY_ENCRYPTION_SECRET` is no longer needed. The admin key table is read-only.

Run the offline checks first if desired:

```bash
npm test
npm run typecheck
```

These checks use fake providers. They cover rotation, failover, timeout/error handling and migration without real charges.

## 2. Create a Postman environment

Create an environment named `GenAI local` and select it for your requests. Add:

| Variable | Value |
|---|---|
| `baseUrl` | `http://localhost:3000/api/assistant` (no trailing slash), or your deployed HTTPS base URL |
| `adminId` | Your existing `ADMIN_ID` |
| `adminSecret` | Your existing `ADMIN_SECRET` |
| `adminOtp` | Current six-digit authenticator code, only if 2FA is enabled |
| `adminToken` | Leave empty; filled after admin login |
| `clientId` | Leave empty; filled after client creation |
| `clientSecret` | Leave empty; filled after client creation |
| `clientToken` | Leave empty; filled after client login |

Keep secrets/tokens local and out of shared exports. Variables use `{{variableName}}` syntax. For authenticated requests select **Authorization → Bearer Token** and enter `{{adminToken}}` or `{{clientToken}}`; do not type `Bearer` into that field. For JSON requests choose **Body → raw → JSON** (`Content-Type: application/json`). These conventions follow [Postman's variables documentation](https://learning.postman.com/docs/use/send-requests/variables/managing-environments) and [Bearer Token documentation](https://learning.postman.com/docs/use/send-requests/authorization/authorization-types).

## 3. Health and public sign-in page

| Request | Authorization | Expected |
|---|---|---|
| `GET {{baseUrl}}/health` | No Auth | `200`, `status: "ok"`, Claude model and key count |
| `GET {{baseUrl}}/admin` | No Auth | `200`, HTML sign-in page |
| `GET {{baseUrl}}/admin/clients` | No Auth | `401` |

Health confirms the server is up; it does not call either provider. Any source IP can access the sign-in page, but data APIs still require authentication. Network/firewall and browser-origin restrictions are separate from source IP access.

## 4. Log in as admin

`POST {{baseUrl}}/token` — **No Auth**

```json
{
  "clientId": "{{adminId}}",
  "clientSecret": "{{adminSecret}}",
  "otp": "{{adminOtp}}"
}
```

Remove `otp` entirely if 2FA is not configured. Expected: `200`, `role: "admin"`, `accessToken` and `expiresAt`. Admin tokens normally expire in 15 minutes.

In this request's **Scripts → Post-response**, add:

```javascript
pm.test("Admin login succeeds", () => pm.response.to.have.status(200));
if (pm.response.code === 200) {
  pm.environment.set("adminToken", pm.response.json().accessToken);
}
```

Environment updates use the documented [pm.environment.set](https://learning.postman.com/docs/use/send-requests/variables/environment-variables) API. If you log in again, use a fresh authenticator code: codes are single-use. A new admin login cancels the previous admin token, including a dashboard session.

## 5. Create an isolated client

`POST {{baseUrl}}/admin/clients` — **Bearer `{{adminToken}}`**

```json
{
  "name": "Postman verification",
  "monthlyBudgetUsd": 1,
  "requestsPerMinute": null,
  "openaiEnabled": false
}
```

Expected: `201`, `clientId`, `clientSecret`, and `openaiEnabled: false`. A one-dollar budget is a pre-call check, not a strict reservation of provider cost. Keep prompts short.

Post-response script:

```javascript
pm.test("Client created", () => pm.response.to.have.status(201));
if (pm.response.code === 201) {
  const body = pm.response.json();
  pm.environment.set("clientId", body.clientId);
  pm.environment.set("clientSecret", body.clientSecret);
}
```

Save the secret now; list endpoints never show it again. Re-sending this creation request creates another client.

## 6. Log in as that client

`POST {{baseUrl}}/token` — **No Auth**

```json
{
  "clientId": "{{clientId}}",
  "clientSecret": "{{clientSecret}}"
}
```

Expected: `200`, `role: "client"`, token expiry normally 60 minutes. Post-response script:

```javascript
pm.test("Client login succeeds", () => pm.response.to.have.status(200));
if (pm.response.code === 200) {
  pm.environment.set("clientToken", pm.response.json().accessToken);
}
```

Reuse this token for both providers. Repeating client login before expiry returns `409` with `expiresAt` and `retryAfterSeconds`, and leaves the current token valid. No replacement token is returned. Admin login retains its existing replacement behavior.

## 7. Verify the OpenAI grant

`POST {{baseUrl}}/openai/send` — **Bearer `{{clientToken}}`**

```json
{"prompt":"Reply with only OK."}
```

Expected before the grant: `403`, `OpenAI access is not enabled for this client`. No provider call is made.

Grant access with `PATCH {{baseUrl}}/admin/clients/{{clientId}}` — **Bearer `{{adminToken}}`**:

```json
{"openaiEnabled":true}
```

Expected: `200`, `openai_enabled: 1`. No new client login is needed. Re-send the OpenAI prompt: expect `200` if the configured key/model has access and credits. A `503` means no numbered keys were loaded; a `502` means upstream failure; a `429` means throttling/cooldown or a client rate limit.

## 8. Verify both providers

Use **Bearer `{{clientToken}}`** and the same body for these two requests:

```json
{
  "prompt": "Reply with only OK.",
  "systemPrompt": "Be concise."
}
```

| Request | Expected |
|---|---|
| `POST {{baseUrl}}/send` | `200`, Claude model, text in `output` |
| `POST {{baseUrl}}/openai/send` | `200`, OpenAI model, text in `output` |

Both responses include `usage`, `timestamp`, `durationMs`, and `stopReason`. Check nonnegative token counts and cost. Costs and text vary; do not expect a fixed token count or literal output from a real model.

Optional Post-response checks on each successful prompt request:

```javascript
pm.test("Prompt succeeds with usage", () => {
  pm.response.to.have.status(200);
  const body = pm.response.json();
  pm.expect(body.output).to.be.a("string").and.not.empty;
  pm.expect(body.usage.costUsd).to.be.at.least(0);
  pm.expect(body.usage.totalTokens).to.equal(
    body.usage.inputTokens + body.usage.outputTokens +
    body.usage.cacheReadTokens + body.usage.cacheWriteTokens
  );
});
```

OpenAI's `inputTokens` is uncached input; cached input is counted separately in `cacheReadTokens`. `max_output_tokens` means a partial OpenAI output; `max_tokens` is Claude's equivalent. Refusals return `422` with usage and may be charged.

## 9. Usage and read-only key reports

| Request | Token | Expected |
|---|---|---|
| `GET {{baseUrl}}/me/usage` | Client | `200`, combined monthly spend, requests and remaining budget |
| `GET {{baseUrl}}/admin/clients` | Admin | Test client present, no secret/hash/token ID in list |
| `GET {{baseUrl}}/admin/usage/{{clientId}}` | Admin | Recent rows with `anthropic` and `openai` providers |
| `GET {{baseUrl}}/admin/usage?groupBy=provider` | Admin | Separate provider totals |
| `GET {{baseUrl}}/admin/usage?groupBy=client` | Admin | Test client's combined spend |
| `GET {{baseUrl}}/admin/usage?groupBy=realKey&provider=openai` | Admin | OpenAI key slot totals, `provider: "openai"` |
| `GET {{baseUrl}}/admin/usage?groupBy=day` | Admin | Daily totals |
| `GET {{baseUrl}}/admin/usage?groupBy=model` | Admin | Per-model totals |
| `GET {{baseUrl}}/admin/keys` | Admin | Claude key readiness |
| `GET {{baseUrl}}/admin/openai/keys` | Admin | `configured`, `model`, masked keys, IDs and cooldowns |

Provider/model/key reports include all clients for the selected date range. The test client's detail route isolates its own last 50 requests. Slot 5 stays key 5 even if slots 2–4 are empty. Read endpoints never return raw upstream keys. POST/PATCH key-management routes have been removed (`404`).

## 10. Verify grants and shared limits

Apply each patch to `PATCH {{baseUrl}}/admin/clients/{{clientId}}` with **admin auth**, then use **client auth** for prompt requests.

| Patch | Verification |
|---|---|
| `{"openaiEnabled":false}` | OpenAI prompt returns `403`; Claude prompt still works |
| `{"openaiEnabled":true,"monthlyBudgetUsd":0}` | Both prompt routes return `402`; no upstream call |
| `{"monthlyBudgetUsd":1,"requestsPerMinute":1}` | Send one short Claude prompt: normally `200`. Immediately send an OpenAI prompt: `429`, `Rate limit: 1 requests per minute`, with retry information |
| `{"requestsPerMinute":null}` | Removes that rate limit so later checks can proceed |

The rate test assumes this fresh client's rate limit was null earlier. If you already ran the test, wait at least 60 seconds before repeating it. Budget checks use combined recorded spend; a call or concurrent calls can exceed the remaining allowance.

## 11. Authentication and validation checks

| Check | Expected |
|---|---|
| Prompt request with **No Auth** | `401` |
| Prompt with Bearer `invalid-token` | `401` |
| Prompt with admin token | `403` |
| `GET /admin/clients` or `/admin/openai/keys` with client token | `403` |
| `POST /send` and `/openai/send` with `{"prompt":""}` or `{}` using the client token | `400` |
| `GET /admin/usage?provider=invalid` with admin token | `400` |
| Prompt request with header `Origin: https://unapproved.example` | `403` unless that origin is configured as allowed |

Remove the test Origin header afterward. Postman normally sends no Origin; this test deliberately simulates an unapproved browser origin. Other body fields are not a reliable rejection test: the framework can strip unknown properties.

To check the client expiry lock, keep the current `clientToken` and record its `expiresAt`, then run client login again before expiry. Expect `409 Client already has an active token`, the same `expiresAt`, a positive `retryAfterSeconds` (also in `Retry-After`), and no `accessToken`. Repeating this must not extend expiry. `GET /me/usage` with the saved token must still return `200`. Wrong credentials must still return `401`, without expiry information. For a concurrency check on an isolated new client, simultaneous logins should yield one `200` and the rest `409`.

To check expiry, wait until `expiresAt` and call `/me/usage` with that token: expect `401 Token expired`; log in again and expect `200` with a new token. On a local test instance you can temporarily lower `TOKEN_TTL_MINUTES`, restart, then create a new test client or rotate its secret before login. Existing tokens retain their original expiry. Restore the setting afterward. Restarting clears the admin session, so log in as admin again too. A second successful admin login still invalidates the prior admin token with `401 Token replaced by a newer login`.

## 12. Secret rotation and client disablement

Rotate only the test client's secret:

`POST {{baseUrl}}/admin/clients/{{clientId}}/rotate-secret` — **admin auth**, body `{}`.

Expected: `200` with a new `clientSecret`. The old secret and its existing token stop working immediately (`401 Token revoked` for an unexpired token). Rotation also clears the expiry lock. Copy the new secret into the Postman `clientSecret` variable, then log in immediately, even if the revoked token had time left, and confirm `/me/usage` returns `200`.

Disable the test client with an admin PATCH:

```json
{"status":"disabled"}
```

Both prompt routes must return `401 Client disabled`, even with its otherwise valid token. Client login returns `401 Invalid credentials`. Restore with `{"status":"active"}` if needed; leaving a completed test client disabled is sufficient cleanup. There is no client-delete endpoint.

## 13. Key rotation, failover and missing configuration

Use a local/staging instance for these configuration changes.

1. Fill two or more `OPENAI_KEY_n` slots and restart. Log in as admin again. Verify the read-only key report lists their actual slot numbers and only masked suffixes.
2. With a dedicated enabled client and sufficient budget/rate allowance, send several short OpenAI prompts. Check `/admin/usage/{{clientId}}` or OpenAI key-group reports: healthy slots rotate. Ignore rows from earlier test runs; no exact output/token counts are guaranteed.
3. For failover, temporarily replace one local slot with a deliberately invalid but syntactically valid key such as `sk-test-xxxxxxxxxxxxxxxxxxxx`, retaining another real working key. Restart and send a prompt. Expect success through the working key; the invalid key should show a cooldown after it is attempted. Real account issues can still cause both keys to fail.
4. Restore the real key and restart. Do not renumber other slots; reports identify slots, not distinct physical keys across replacements.
5. To test missing keys, clear all five slots on that local instance and restart. The health route stays `200`; an OpenAI-granted client gets `503 OpenAI has no configured keys`. Claude stays usable if its own key/configuration works. Restore the OpenAI slots and restart afterward.

Provider keys in one project may share rate/quota limits. Repeated requests cannot reliably force a real `429`, refusal, or timeout. `npm test` supplies deterministic fake-provider cases for those scenarios. Intermediate failed key attempts that later succeed on another key do not each get a separate usage row; the successful request records its final key.

## 14. Admin protection and final checks

- Sign in from a second network: the admin sign-in page and valid credentials should work. No IP allowlist is required.
- With 2FA enabled, a missing/wrong code is rejected, and reusing a successfully used code is rejected. Wait for a fresh code for the next successful login.
- Failed-login lockout is per IP. Test deliberately repeated wrong credentials only on an isolated local instance: it can also block your correct admin/client login temporarily. Default is five failures within 15 minutes; verify `429` and retry information.
- Open the dashboard and confirm provider totals, client grants and read-only key readiness. Admin responses should include `Cache-Control: no-store`; the page also has a nonce CSP and `X-Frame-Options: DENY`.
- Restart a local instance and verify client grants, current client token, expiry lock and usage persist. The first upgrade adding expiry tracking revokes legacy client tokens once; log in again after that migration. Admin login, rate windows and key cooldowns reset. Numbered keys reload from `.env`.
- A successful wrapper check includes both provider outputs, recorded usage, access-grant enforcement, shared limits and authenticated admin reporting. `200 /health` alone does not validate upstream credentials or billing access.

Live provider errors without usage are recorded with zero estimated cost; they can still incur provider charges. Do not automatically replay a timeout/`502` without considering duplicate processing. See [CLIENT_GUIDE.md](CLIENT_GUIDE.md) for detailed response semantics.
