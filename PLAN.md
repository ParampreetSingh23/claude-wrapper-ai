# GenAI Gateway: implementation decisions

Status: implemented. Claude remains at `/api/assistant/send`; OpenAI is added at `/api/assistant/openai/send`. See [README.md](README.md) for setup and the full route list.

## Decisions

| Area | Implementation |
|---|---|
| Client API | Same `{prompt, systemPrompt?}` body and normalized output/usage envelope |
| OpenAI upstream | Responses API through native `fetch`, `store: false` |
| Authentication | Client `/token` returns `409` until its current token expires; atomic DB claim; admin session replacement unchanged |
| Authorization | `clients.openai_enabled`, off by default; checked on every OpenAI request |
| Limits | Existing monthly budget and sliding per-minute counter, shared across providers |
| Admin | Existing dashboard, access from any IP, 2FA, roles and session controls |
| OpenAI keys | `OPENAI_KEY_1` through `OPENAI_KEY_5` in `.env`; unused slots empty |
| Key operations | Edit or clear environment slots and restart; read-only masked status in admin |
| Models | Server-selected `gpt-4.1-mini` or its dated snapshot; verified price entries required |
| Reporting | `usage.provider`, defaults to `anthropic`; combined totals plus provider filtering |
| Dependencies | No new package |

## Request flow

1. Apply existing origin checks and verify the client JWT.
2. Read the active client and validate the current token ID.
3. Reject an absent OpenAI grant with `403` before spending or checking keys.
4. Validate prompt fields, then enforce combined budget and rate limits.
5. Select the next ready key from the pool loaded from the environment at startup.
6. Call OpenAI with a bounded timeout.
7. Validate response token counts and output blocks, extract text, and calculate cost.
8. Write usage with provider/key/model/status and update the client's last-use timestamp.
9. Return output/usage, `422` for a refusal, or a sanitized upstream error.

OpenAI's input count includes cached tokens; the gateway stores and returns uncached `inputTokens` separately from `cacheReadTokens`, so their sum plus output equals `totalTokens`. Cache reads receive the discounted input price. Refusals and partial responses with usage are billed in reports.

## Migration and compatibility

- Existing clients keep their IDs, secrets, limits, grants, and Claude access. New OpenAI grants default to off. Adding token expiry tracking revokes legacy client tokens once; clients must log in again. Later restarts preserve token IDs and expiry locks.
- Existing usage is labeled `anthropic`; Claude inserts continue to default to that provider.
- New databases store clients and usage only. Existing databases receive missing columns in place; startup is repeatable. Old `openai_keys` rows are preserved but ignored. Only legacy token IDs are cleared by the expiry migration; client and usage records are retained.
- Shared budget and client totals include both providers once OpenAI is used.
- Key-group rows keep numeric `grp` and add `provider`, preventing collisions between Claude key 1 and OpenAI key 1.
- No OpenAI key is required to keep serving Claude. Invalid explicitly supplied OpenAI configuration fails startup.

## Failure behavior and limits

- No configured environment key: `503`. Nonempty keys are format-validated at startup.
- Rest keys for explicit 401/403, 429, or 5xx; retry another ready key. Do not retry ordinary 4xx requests on other keys.
- Skip resting keys until their cooldown expires. If none can run, return a sanitized `429` or `502` according to the last key status.
- Do not replay timeouts/disconnects or malformed responses; they may already have incurred upstream cost.
- Refusals return `422` with usage. Output-cap truncation returns partial output with `stopReason: max_output_tokens`.
- Unknown upstream usage is recorded as zero estimated cost; reconcile provider bills. Budgets use completed recorded spend, so concurrent/in-flight calls may exceed the allowance.
- State remains single-process. Key cooldowns and rate counters reset on restart.
- In-flight requests can complete after grant revocation.

## Verification

`npm test` covers client expiry conflicts, concurrent login, renewal, secret-rotation recovery, restart persistence, migration, unchanged admin replacement, and the existing Claude/fake OpenAI flow: grants, role restrictions, five-key rotation, empty slots, key replacement on restart, failover, shared limits, errors, accounting, and the non-overwriting environment append command. `npm run typecheck` checks source types. No real upstream calls are needed for these tests.

## Deferred

OpenAI SDK-compatible routes, browser streaming, tools, images/audio, conversations, separate provider budgets, Anthropic key migration, arbitrary per-request models, multi-process coordination are outside this change.
