import Anthropic from "@anthropic-ai/sdk";

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

// USD per 1M tokens. Update when Anthropic changes prices (check the pricing page).
// Cache write assumed 1.25x input (5-minute cache); Haiku cache read assumed 0.1x input. Verify both.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/** Returns null for a model missing from the price table, so the caller can warn instead of logging $0. */
export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const cost =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite;
  return cost / 1_000_000;
}

/** All real keys failed (or the request itself was rejected). `keyId` is the last key tried. */
export class UpstreamError extends Error {
  status: number | undefined;
  keyId: number;
  constructor(cause: unknown, keyId: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.status = cause instanceof Anthropic.APIError ? cause.status : undefined;
    this.keyId = keyId;
  }
}

/**
 * How long to rest a key after this error, or null when another key wouldn't help
 * (e.g. 400 bad request: same request fails on every key).
 */
function cooldownMs(err: unknown): number | null {
  if (err instanceof Anthropic.APIConnectionError) return 10_000;
  if (!(err instanceof Anthropic.APIError)) return null;
  if (err.status === 429) {
    const retryAfter = Number(err.headers?.get("retry-after"));
    return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000;
  }
  if (err.status === 401 || err.status === 403) return 5 * 60_000; // key revoked or wrong: park it for a while
  if (err.status !== undefined && err.status >= 500) return 10_000; // includes 529 overloaded
  return null;
}

/**
 * Spreads requests across all real keys (round robin). If a key is rate-limited or failing,
 * it rests for a while and the same request is retried on the next key.
 */
export function createKeyPool(apiKeys: string[], timeoutMs: number, log: (msg: string, extra: object) => void) {
  const keys = apiKeys.map((apiKey, i) => ({
    id: i + 1,
    // Retries are done here across keys, not by the SDK on the same key.
    client: new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 }),
    coolUntil: 0,
  }));
  let next = 0;

  // Rotated so each request starts on the next key; resting keys go last (still tried if all are resting).
  function tryOrder() {
    const start = next++ % keys.length;
    const rotated = [...keys.slice(start), ...keys.slice(0, start)];
    const now = Date.now();
    return [...rotated.filter((k) => k.coolUntil <= now), ...rotated.filter((k) => k.coolUntil > now)];
  }

  return {
    async send(params: StreamParams) {
      let lastErr: UpstreamError | undefined;
      for (const key of tryOrder()) {
        try {
          // Streaming avoids HTTP timeouts on long outputs; finalMessage() collects it.
          const message = await key.client.beta.messages.stream(params).finalMessage();
          return { message, keyId: key.id };
        } catch (err) {
          const rest = cooldownMs(err);
          lastErr = new UpstreamError(err, key.id);
          if (rest === null) throw lastErr;
          key.coolUntil = Date.now() + rest;
          log("real key failed, trying next", { realKey: key.id, status: lastErr.status, restMs: rest });
        }
      }
      throw lastErr!;
    },

    status: () => keys.map((k) => ({ realKey: k.id, restingUntil: k.coolUntil > Date.now() ? new Date(k.coolUntil).toISOString() : null })),
  };
}

export type KeyPool = ReturnType<typeof createKeyPool>;
