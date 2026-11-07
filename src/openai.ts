// USD per 1M tokens: https://developers.openai.com/api/docs/models/gpt-4.1-mini
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6 },
  "gpt-4.1-mini-2025-04-14": { input: 0.4, cached: 0.1, output: 1.6 },
};

type ResponseBody = {
  model: string;
  status: string;
  incomplete_details?: { reason?: string } | null;
  output: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number } | null };
};

export class OpenAIError extends Error {
  status: number;
  keyId: number | null;
  constructor(status: number, keyId: number | null) {
    super(status === 503 && keyId === null ? "OpenAI has no configured keys" : "Upstream OpenAI error");
    this.status = status;
    this.keyId = keyId;
  }
}

function readResponse(value: unknown): ResponseBody {
  const r = value as ResponseBody | null;
  const u = r?.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  if (!r || typeof r.model !== "string" || !["completed", "incomplete"].includes(r.status) || !Array.isArray(r.output) ||
      !u || ![u.input_tokens, u.output_tokens, u.total_tokens, cached].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      cached > u.input_tokens || u.total_tokens !== u.input_tokens + u.output_tokens ||
      !r.output.every((item) => item && typeof item.type === "string" && (item.type !== "message" ||
        (Array.isArray(item.content) && item.content.every((c) => c &&
          ((c.type === "output_text" && typeof c.text === "string") || (c.type === "refusal" && typeof c.refusal === "string"))))))) {
    throw new Error("Invalid OpenAI response");
  }
  return r;
}

export function createOpenAIService(keys: { id: number; apiKey: string }[], options: {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  baseUrl: string;
}) {
  const price = Object.hasOwn(PRICES, options.model) ? PRICES[options.model] : undefined;
  if (!price) throw new Error("OPENAI_MODEL has no price entry; add verified pricing to src/openai.ts before using it");
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 32768) {
    throw new Error("OPENAI_MAX_TOKENS must be an integer from 1 to 32768");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600000) {
    throw new Error("OPENAI_TIMEOUT_MS must be an integer from 1 to 600000");
  }
  const url = new URL(options.baseUrl.replace(/\/$/, "") + "/responses");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("OPENAI_BASE_URL must use HTTPS (HTTP is allowed only on loopback for tests)");
  }
  for (const key of keys) {
    if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key.apiKey)) throw new Error(`OPENAI_KEY_${key.id} has an invalid API key format`);
  }
  const resting = new Map<number, { until: number; status: number }>();
  let next = 0;

  return {
    configured: keys.length > 0,
    model: options.model,
    status: () => keys.map((key) => ({
      id: key.id,
      masked_key: "…" + key.apiKey.slice(-4),
      restingUntil: (resting.get(key.id)?.until ?? 0) > Date.now() ? new Date(resting.get(key.id)!.until).toISOString() : null,
    })),

    async send(prompt: string, systemPrompt?: string) {
      if (!keys.length) throw new OpenAIError(503, null);
      const start = next++ % keys.length;
      const ordered = [...keys.slice(start), ...keys.slice(0, start)];
      let last = new OpenAIError(429, null);
      for (const key of ordered) {
        const rest = resting.get(key.id);
        if (rest && rest.until > Date.now()) {
          last = new OpenAIError(rest.status, key.id);
          continue;
        }
        try {
          const response = await fetch(url, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(options.timeoutMs),
            headers: { "content-type": "application/json", authorization: `Bearer ${key.apiKey}` },
            body: JSON.stringify({ model: options.model, input: prompt, instructions: systemPrompt, max_output_tokens: options.maxTokens, store: false }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            last = new OpenAIError(response.status, key.id);
            const retryable = [401, 403, 429].includes(response.status) || response.status >= 500;
            if (!retryable) throw last;
            const seconds = Number(response.headers.get("retry-after"));
            const delay = response.status === 429
              ? (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3600000) : 30000)
              : [401, 403].includes(response.status) ? 300000 : 10000;
            resting.set(key.id, { until: Date.now() + delay, status: response.status });
            continue;
          }
          const message = readResponse(await response.json());
          const blocks = message.output.filter((item) => item.type === "message").flatMap((item) => item.content!);
          const refused = blocks.some((c) => c.type === "refusal") || message.incomplete_details?.reason === "content_filter";
          const input = message.usage.input_tokens;
          const cached = message.usage.input_tokens_details?.cached_tokens ?? 0;
          const output = message.usage.output_tokens;
          return {
            keyId: key.id,
            httpStatus: refused ? 422 : 200,
            output: blocks.filter((c) => c.type === "output_text").map((c) => c.text).join(""),
            model: message.model,
            stopReason: refused ? "refusal" : message.status === "incomplete" ? message.incomplete_details?.reason ?? "incomplete" : "completed",
            usage: {
              inputTokens: input - cached,
              outputTokens: output,
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
              totalTokens: message.usage.total_tokens,
              costUsd: ((input - cached) * price.input + cached * price.cached + output * price.output) / 1000000,
            },
          };
        } catch (err) {
          if (err instanceof OpenAIError) throw err;
          // A timeout/disconnect may already have incurred cost; never blindly replay it on another key.
          throw new OpenAIError(502, key.id);
        }
      }
      throw last;
    },
  };
}
