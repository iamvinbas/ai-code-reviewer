import {
  LLMError,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type LLMProvider,
  type ProviderPreset,
} from "../types.js";
import { excerpt } from "./json.js";

export interface ClientDeps {
  fetch: typeof globalThis.fetch;
  /** Must reject with `signal.reason` when the signal aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

export interface ClientOptions {
  name: ProviderPreset;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  apiKeyEnv: string | null;
  docsUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Use Ollama's native /api/chat and /api/tags (needed to set num_ctx). */
  ollamaNative: boolean;
  /** Fixed num_ctx (ACR_OLLAMA_NUM_CTX); null = sized per request. */
  numCtx: number | null;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Local models are slow: ~86s measured for a full 6000-token chunk on qwen2.5-coder:14b. */
export const OLLAMA_DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_TOKENS = 4096;
const MAX_WAIT_MS = 30_000;
const BASE_DELAY_MS = 1_000;
const PING_TIMEOUT_MS = 15_000;
const MIN_NUM_CTX = 4096;
const MAX_NUM_CTX = 32_768;
/** Network errors where retrying for long is pointless (nothing is listening / host unknown). */
const FAST_FAIL_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export const defaultDeps: ClientDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  random: Math.random,
};

interface HttpResult {
  status: number;
  headers: Headers;
  body: string;
}

class NetworkFailure extends Error {
  constructor(
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(code ?? "network error", { cause });
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly #key: string | null;
  readonly #opts: ClientOptions;
  readonly #deps: ClientDeps;
  /** Set when the server answers 404 on Ollama's native API (e.g. an OpenAI-only proxy). */
  #nativeUnavailable = false;
  /** Largest num_ctx sent so far: Ollama reloads the model whenever num_ctx changes, so never shrink it. */
  #numCtx = 0;

  constructor(opts: ClientOptions, deps: ClientDeps) {
    this.name = opts.name;
    this.model = opts.model;
    this.#key = opts.apiKey;
    this.#opts = opts;
    this.#deps = deps;
  }

  async complete(messages: ChatMessage[], opts: CompletionOptions = {}): Promise<CompletionResult> {
    if (this.#opts.ollamaNative && !this.#nativeUnavailable) {
      const result = await this.#completeNative(messages, opts);
      if (result) return result;
    }
    return this.#completeOpenAI(messages, opts);
  }

  async ping(): Promise<void> {
    const timeout = Math.min(this.#opts.timeoutMs, PING_TIMEOUT_MS);
    if (this.#opts.ollamaNative && !this.#nativeUnavailable) {
      const res = await this.#request("GET", `${this.#ollamaHost()}/api/tags`, undefined, timeout);
      if (res.status !== 404) {
        if (res.status < 200 || res.status >= 300) throw this.#httpError(res);
        this.#assertModelListed(parseModelIds(res.body));
        return;
      }
      this.#nativeUnavailable = true;
    }

    const res = await this.#request("GET", `${this.#opts.baseUrl}/models`, undefined, timeout);
    // Endpoint without a model listing: reachability + auth is all we can check.
    if (res.status === 404 || res.status === 405) return;
    if (res.status < 200 || res.status >= 300) throw this.#httpError(res);
    this.#assertModelListed(parseModelIds(res.body));
  }

  /** Ollama's native /api/chat: unlike /v1, it lets us size the context window (num_ctx). */
  async #completeNative(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult | null> {
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const inputTokens = ollamaPromptTokens(messages);
    let numCtx = this.#opts.numCtx;
    if (numCtx === null) {
      numCtx = this.#numCtx = Math.max(this.#numCtx, ollamaNumCtx(inputTokens, maxTokens));
    }
    if (inputTokens > numCtx) {
      throw new LLMError(
        "context_length",
        `Prompt (~${inputTokens} tokens) exceeds the Ollama context window (num_ctx ${numCtx}) — lower maxChunkTokens or set ACR_OLLAMA_NUM_CTX`,
      );
    }
    const body = {
      model: this.model,
      messages,
      stream: false,
      ...(opts.json ? { format: "json" } : {}),
      options: { temperature: opts.temperature ?? 0, num_predict: maxTokens, num_ctx: numCtx },
    };
    const res = await this.#request("POST", `${this.#ollamaHost()}/api/chat`, body, this.#opts.timeoutMs, opts.signal);
    if (res.status === 404 && !this.#isModelNotFound(404, providerMessage(res.body))) {
      this.#nativeUnavailable = true;
      return null;
    }
    if (res.status < 200 || res.status >= 300) throw this.#httpError(res);

    const data = this.#parseJsonBody(res.body);
    if (typeof data.error === "string") throw this.#httpError({ status: 500, headers: new Headers(), body: res.body });
    const text = isRecord(data.message) ? contentText(data.message.content) : undefined;
    if (!text || text.trim() === "") throw this.#emptyCompletion(data.done_reason);
    return withUsage(text, data.prompt_eval_count, data.eval_count);
  }

  async #completeOpenAI(messages: ChatMessage[], opts: CompletionOptions): Promise<CompletionResult> {
    const url = `${this.#opts.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: false,
    };
    if (opts.json) body.response_format = { type: "json_object" };

    let res = await this.#request("POST", url, body, this.#opts.timeoutMs, opts.signal);
    if (opts.json && res.status === 400) {
      const msg = providerMessage(res.body);
      if (!isContextError(msg) && !this.#isModelNotFound(400, msg)) {
        // Some OpenAI-compatible servers reject response_format; the prompt still asks for JSON.
        delete body.response_format;
        res = await this.#request("POST", url, body, this.#opts.timeoutMs, opts.signal);
      }
    }
    if (res.status < 200 || res.status >= 300) throw this.#httpError(res);
    return this.#parseCompletion(res.body);
  }

  #ollamaHost(): string {
    return this.#opts.baseUrl.replace(/\/v1$/, "");
  }

  #assertModelListed(ids: string[] | null): void {
    if (ids === null) return;
    if (ids.length === 0 && this.name !== "ollama") return;
    const wanted = this.#normalizeModelId(this.model);
    if (!ids.some((id) => this.#normalizeModelId(id) === wanted)) {
      throw new LLMError("model_not_found", this.#modelNotFoundMessage(), 404);
    }
  }

  async #request(
    method: "GET" | "POST",
    url: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.#key) headers.Authorization = `Bearer ${this.#key}`;
    const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    const { maxRetries } = this.#opts;

    for (let attempt = 0; ; attempt++) {
      let res: HttpResult;
      try {
        res = await this.#attempt(url, init, timeoutMs, signal);
      } catch (err) {
        if (!(err instanceof NetworkFailure)) throw err;
        const limit = err.code && FAST_FAIL_CODES.has(err.code) ? Math.min(1, maxRetries) : maxRetries;
        if (attempt >= limit) throw this.#unreachable(err);
        await this.#deps.sleep(this.#backoff(attempt), signal);
        continue;
      }

      if (!isRetryableStatus(res.status) || attempt >= maxRetries) return res;
      const retryAfter = retryAfterMs(res.headers);
      // A long retry-after (e.g. daily quota) won't clear within our retry budget.
      if (retryAfter !== null && retryAfter > 2 * MAX_WAIT_MS) return res;
      await this.#deps.sleep(retryAfter !== null ? Math.min(retryAfter, MAX_WAIT_MS) : this.#backoff(attempt), signal);
    }
  }

  async #attempt(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<HttpResult> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await this.#deps.fetch(url, { ...init, signal: controller.signal });
      const body = await res.text();
      return { status: res.status, headers: res.headers, body };
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) {
        const secs = Math.round(timeoutMs / 1000);
        const hint =
          this.name === "ollama"
            ? "local models can be slow: lower maxChunkTokens in .acr.yml, use a smaller model (e.g. `qwen2.5-coder:7b`), or raise provider.timeoutMs"
            : "raise provider.timeoutMs or try again later";
        throw new LLMError("unreachable", `${this.name} did not respond within ${secs}s (${url}) — ${hint}`);
      }
      throw new NetworkFailure(networkCode(err), err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #backoff(attempt: number): number {
    const exp = Math.min(MAX_WAIT_MS, BASE_DELAY_MS * 2 ** attempt);
    return Math.round(exp * (0.5 + this.#deps.random() / 2));
  }

  #parseJsonBody(raw: string): Record<string, unknown> {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new LLMError("bad_response", `${this.name} returned a non-JSON response: ${excerpt(raw)}`);
    }
    if (!isRecord(data)) throw new LLMError("bad_response", `${this.name} returned an unexpected response: ${excerpt(raw)}`);
    return data;
  }

  #parseCompletion(raw: string): CompletionResult {
    const data = this.#parseJsonBody(raw);
    // Some gateways (e.g. OpenRouter) report upstream failures as 200 + { error }.
    if (data.error !== undefined && !Array.isArray(data.choices)) {
      const code = isRecord(data.error) && typeof data.error.code === "number" ? data.error.code : 502;
      throw this.#httpError({ status: code, headers: new Headers(), body: raw });
    }

    const choice: unknown = Array.isArray(data.choices) ? data.choices[0] : undefined;
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
    const text = contentText(message?.content);
    if (!text || text.trim() === "") throw this.#emptyCompletion(isRecord(choice) ? choice.finish_reason : undefined);

    const usage = isRecord(data.usage) ? data.usage : undefined;
    return withUsage(text, usage?.prompt_tokens, usage?.completion_tokens);
  }

  #emptyCompletion(finishReason: unknown): LLMError {
    const hint =
      finishReason === "length"
        ? " (output hit the max_tokens limit — raise maxTokens)"
        : finishReason === "content_filter"
          ? " (blocked by the provider's content filter)"
          : "";
    return new LLMError("bad_response", `${this.name} returned an empty completion${hint}`);
  }

  #httpError(res: HttpResult): LLMError {
    const { status } = res;
    const msg = providerMessage(res.body);
    const detail = msg ? `: ${truncate(msg)}` : "";
    const { name } = this;

    if (status === 401 || status === 403) {
      const fix = this.#opts.apiKeyEnv
        ? `check ${this.#opts.apiKeyEnv}${this.#key ? "" : " (it is not set)"} — get a free key at ${this.#opts.docsUrl}`
        : "this endpoint requires an API key: set provider.apiKeyEnv to the env var that holds it";
      return new LLMError("auth", `Authentication failed for ${name} (HTTP ${status}) — ${fix}${detail}`, status);
    }
    if ((status === 400 || status === 404 || status === 422) && this.#isModelNotFound(status, msg)) {
      return new LLMError("model_not_found", this.#modelNotFoundMessage(), status);
    }
    if (status === 413 || ((status === 400 || status === 422) && isContextError(msg))) {
      return new LLMError(
        "context_length",
        `Request too large for ${this.model} on ${name} (HTTP ${status}) — lower maxChunkTokens or contextLines${detail}`,
        status,
      );
    }
    if (status === 429) {
      return new LLMError(
        "rate_limit",
        `Rate limited by ${name} (HTTP 429) after ${this.#opts.maxRetries} retries — free-tier limits reached; wait a minute, lower maxChunkTokens, or switch provider (local Ollama has no limits)${detail}`,
        status,
      );
    }
    if (status === 404) {
      return new LLMError(
        "server",
        `${name} endpoint not found (HTTP 404) at ${this.#opts.baseUrl} — check provider.baseUrl (it should end with the OpenAI-compatible prefix, e.g. /v1)${detail}`,
        status,
      );
    }
    if (status >= 500) {
      return new LLMError("server", `${name} server error (HTTP ${status}) after ${this.#opts.maxRetries} retries${detail}`, status);
    }
    return new LLMError("server", `${name} rejected the request (HTTP ${status})${detail}`, status);
  }

  #isModelNotFound(status: number, msg: string): boolean {
    if (!/not found|does not exist|not exist|not a valid model|invalid model|unknown model|no such model|no endpoints found/i.test(msg)) {
      return false;
    }
    return msg.toLowerCase().includes(this.model.toLowerCase()) || (status === 404 && /model/i.test(msg));
  }

  #modelNotFoundMessage(): string {
    return this.name === "ollama"
      ? `Model "${this.model}" not found — run \`ollama pull ${this.model}\``
      : `Model "${this.model}" is not available on ${this.name} — check provider.model (see ${this.#opts.docsUrl})`;
  }

  #normalizeModelId(id: string): string {
    const bare = id.replace(/^models\//, "").toLowerCase();
    return this.name === "ollama" && !bare.includes(":") ? `${bare}:latest` : bare;
  }

  #unreachable(err: NetworkFailure): LLMError {
    if (this.name === "ollama") {
      let where = this.#opts.baseUrl;
      try {
        where = new URL(this.#opts.baseUrl).host;
      } catch {
        // keep the raw base URL
      }
      return new LLMError(
        "unreachable",
        `Ollama is not reachable at ${where} — start it with \`ollama serve\` (or install from https://ollama.com)`,
      );
    }
    const code = err.code ? ` (${err.code})` : "";
    return new LLMError(
      "unreachable",
      `Cannot reach ${this.name} at ${this.#opts.baseUrl}${code} — check your network connection and provider.baseUrl`,
    );
  }
}

/** Ollama context size: prompt + output + 10%, rounded up to 2048, within [4096, 32768]. */
export function ollamaNumCtx(inputTokens: number, maxTokens: number): number {
  const needed = Math.ceil((inputTokens + maxTokens) * 1.1);
  return Math.min(MAX_NUM_CTX, Math.max(MIN_NUM_CTX, Math.ceil(needed / 2048) * 2048));
}

/**
 * Prompt size for sizing num_ctx. Deliberately more pessimistic than estimateTokens():
 * qwen2.5-coder measured ~2.9 chars/token on line-numbered diffs and ~2.4 on digit-heavy code,
 * and underestimating here means Ollama silently truncates the prompt.
 */
export function ollamaPromptTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 2.5) + 4, 0);
}

function withUsage(text: string, input: unknown, output: unknown): CompletionResult {
  const inputTokens = typeof input === "number" ? input : undefined;
  const outputTokens = typeof output === "number" ? output : undefined;
  return inputTokens === undefined && outputTokens === undefined
    ? { text }
    : { text, usage: { inputTokens, outputTokens } };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isContextError(msg: string): boolean {
  return /context length|context window|context_length|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|request too large|exceeds? (the )?(max|maximum|token|context)/i.test(
    msg,
  );
}

/** retry-after (seconds or HTTP date) or retry-after-ms, in ms; null if absent/invalid. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function networkCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const e = queue.shift();
    if (!isRecord(e) || seen.has(e)) continue;
    seen.add(e);
    if (typeof e.code === "string" && /^E[A-Z]+$|^UND_ERR/.test(e.code)) return e.code;
    queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...(e.errors as unknown[]));
  }
  return undefined;
}

function providerMessage(body: string): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body.trim();
  }
  if (Array.isArray(data)) data = data[0];
  if (!isRecord(data)) return body.trim();
  const err = data.error;
  if (typeof err === "string") return err;
  if (isRecord(err) && typeof err.message === "string") {
    // OpenRouter nests the upstream provider's message in metadata.raw.
    const raw = isRecord(err.metadata) && typeof err.metadata.raw === "string" ? ` (${err.metadata.raw})` : "";
    return err.message + raw;
  }
  if (typeof data.message === "string") return data.message;
  if (typeof data.detail === "string") return data.detail;
  return body.trim();
}

function parseModelIds(body: string): string[] | null {
  try {
    const data: unknown = JSON.parse(body);
    const list = isRecord(data) ? ("data" in data ? data.data : data.models) : data;
    if (list === null) return [];
    if (!Array.isArray(list)) return null;
    return list.flatMap((m: unknown) => {
      if (typeof m === "string") return [m];
      if (!isRecord(m)) return [];
      return [m.id, m.name, m.model].filter((v): v is string => typeof v === "string");
    });
  } catch {
    return null;
  }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return undefined;
}

function truncate(s: string, max = 300): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
