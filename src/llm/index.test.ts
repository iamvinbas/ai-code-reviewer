import { describe, expect, it, vi } from "vitest";
import { LLMError, type ProviderConfig } from "../types.js";
import type { ClientDeps } from "./client.js";
import { ollamaNumCtx, ollamaPromptTokens, retryAfterMs } from "./client.js";
import { PRESETS, createProvider, estimateTokens, extractJson } from "./index.js";
import { ollamaBaseUrlFromHost } from "./presets.js";

type Step = Response | Error | ((url: string, init: RequestInit) => Promise<Response>);

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function ok(content: string, usage = { prompt_tokens: 12, completion_tokens: 5 }): Response {
  return res(200, { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage });
}

function nativeOk(content: string, extra: Record<string, unknown> = {}): Response {
  return res(200, {
    model: "qwen2.5-coder:14b",
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
    prompt_eval_count: 31,
    eval_count: 7,
    ...extra,
  });
}

function netError(code: string): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

function setup(cfg: Partial<ProviderConfig> = {}, steps: Step[] = [], env: NodeJS.ProcessEnv = {}) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | undefined }[] = [];
  const sleeps: number[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    const step = steps.shift();
    if (!step) throw new Error("unexpected fetch call");
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(url, init);
    return step;
  });
  const deps: Partial<ClientDeps> = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
  };
  const base: ProviderConfig =
    cfg.preset === undefined ? { preset: "openai-compatible", baseUrl: "http://llm.test/v1", model: "m" } : { preset: cfg.preset };
  const provider = createProvider({ ...base, ...cfg }, env, deps);
  return { provider, calls, sleeps, fetch };
}

async function caught(p: Promise<unknown>): Promise<LLMError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LLMError);
    return err as LLMError;
  }
  throw new Error("expected rejection");
}

const msgs = [{ role: "user" as const, content: "hi" }];

describe("createProvider", () => {
  it("uses preset defaults", () => {
    const p = createProvider({ preset: "ollama" }, {});
    expect(p.name).toBe("ollama");
    expect(p.model).toBe("qwen2.5-coder:14b");
  });

  it("applies overrides", () => {
    const p = createProvider({ preset: "groq", model: "llama-3.3-70b-versatile" }, { GROQ_API_KEY: "k" });
    expect(p.model).toBe("llama-3.3-70b-versatile");
  });

  it("throws auth with env var name and docs URL when the key is missing", () => {
    expect(() => createProvider({ preset: "groq" }, {})).toThrow(LLMError);
    try {
      createProvider({ preset: "gemini" }, {});
    } catch (err) {
      expect((err as LLMError).code).toBe("auth");
      expect((err as LLMError).message).toBe(
        `GEMINI_API_KEY is not set — get a free key at ${PRESETS.gemini.docsUrl}`,
      );
    }
  });

  it("honors a custom apiKeyEnv", () => {
    expect(() => createProvider({ preset: "groq", apiKeyEnv: "MY_KEY" }, { GROQ_API_KEY: "k" })).toThrow(/MY_KEY/);
    expect(createProvider({ preset: "groq", apiKeyEnv: "MY_KEY" }, { MY_KEY: "k" }).name).toBe("groq");
  });

  it("throws LLMError(config) for invalid configuration", () => {
    for (const cfg of [
      { preset: "nope" as ProviderConfig["preset"] },
      { preset: "openai-compatible" as const },
      { preset: "ollama" as const, baseUrl: "not a url" },
    ]) {
      expect(() => createProvider(cfg, {})).toThrow(expect.objectContaining({ code: "config" }));
    }
    expect(() => createProvider({ preset: "ollama" }, { ACR_OLLAMA_NUM_CTX: "lots" })).toThrow(
      expect.objectContaining({ code: "config", message: expect.stringContaining("ACR_OLLAMA_NUM_CTX") }),
    );
  });

  it("requires baseUrl and model for openai-compatible, key optional", () => {
    expect(() => createProvider({ preset: "openai-compatible" }, {})).toThrow(/baseUrl is required/);
    expect(() => createProvider({ preset: "openai-compatible", baseUrl: "http://x/v1" }, {})).toThrow(
      /model is required/,
    );
    expect(createProvider({ preset: "openai-compatible", baseUrl: "http://x/v1", model: "m" }, {}).model).toBe("m");
  });

  it("rejects invalid base URLs", () => {
    expect(() => createProvider({ preset: "ollama", baseUrl: "not a url" }, {})).toThrow(/Invalid provider.baseUrl/);
    expect(() => createProvider({ preset: "ollama", baseUrl: "ftp://x" }, {})).toThrow(/Invalid provider.baseUrl/);
  });

  it("honors OLLAMA_HOST, but cfg.baseUrl wins", async () => {
    const a = setup({ preset: "ollama" }, [nativeOk("x")], { OLLAMA_HOST: "http://gpu-box:11434" });
    await a.provider.complete(msgs);
    expect(a.calls[0]?.url).toBe("http://gpu-box:11434/api/chat");

    const b = setup({ preset: "ollama", baseUrl: "http://other:1/v1/" }, [nativeOk("x")], { OLLAMA_HOST: "gpu-box" });
    await b.provider.complete(msgs);
    expect(b.calls[0]?.url).toBe("http://other:1/api/chat");
  });
});

describe("ollamaBaseUrlFromHost", () => {
  it.each([
    ["http://host:11434", "http://host:11434/v1"],
    ["host:1234", "http://host:1234/v1"],
    ["host", "http://host:11434/v1"],
    ["0.0.0.0", "http://0.0.0.0:11434/v1"],
    ["https://ollama.example.com/", "https://ollama.example.com/v1"],
    ["http://host:11434/v1", "http://host:11434/v1"],
  ])("%s → %s", (input, expected) => {
    expect(ollamaBaseUrlFromHost(input)).toBe(expected);
  });
});

describe("complete", () => {
  it("posts an OpenAI chat completion and maps usage", async () => {
    const { provider, calls } = setup({}, [ok("hello")]);
    const out = await provider.complete(msgs);
    expect(out).toEqual({ text: "hello", usage: { inputTokens: 12, outputTokens: 5 } });
    expect(calls[0]?.url).toBe("http://llm.test/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      model: "m",
      messages: msgs,
      temperature: 0,
      max_tokens: 4096,
      stream: false,
    });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("sends the bearer key, options and json mode", async () => {
    const { provider, calls } = setup({ preset: "groq" }, [ok('{"a":1}')], { GROQ_API_KEY: "secret" });
    await provider.complete(msgs, { json: true, temperature: 0.2, maxTokens: 100 });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(calls[0]?.body).toMatchObject({
      temperature: 0.2,
      max_tokens: 100,
      response_format: { type: "json_object" },
    });
  });

  it("does not expose the key when inspected", async () => {
    const { inspect } = await import("node:util");
    const p = createProvider({ preset: "groq" }, { GROQ_API_KEY: "supersecret" });
    expect(inspect(p, { depth: 5 })).not.toContain("supersecret");
    expect(JSON.stringify(p)).not.toContain("supersecret");
  });

  it("retries once without response_format when rejected with 400", async () => {
    const { provider, calls } = setup({}, [
      res(400, { error: { message: "response_format json_object is not supported" } }),
      ok('{"a":1}'),
    ]);
    const out = await provider.complete(msgs, { json: true });
    expect(out.text).toBe('{"a":1}');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body?.response_format).toBeDefined();
    expect(calls[1]?.body?.response_format).toBeUndefined();
  });

  it("does not use the json fallback for context-length errors", async () => {
    const { provider, calls } = setup({}, [
      res(400, { error: { message: "This model's maximum context length is 8192 tokens" } }),
    ]);
    const err = await caught(provider.complete(msgs, { json: true }));
    expect(err.code).toBe("context_length");
    expect(err.message).toMatch(/maxChunkTokens/);
    expect(calls).toHaveLength(1);
  });

  it("maps 413 to context_length", async () => {
    const { provider } = setup({}, [res(413, { error: { message: "Request too large" } })]);
    expect((await caught(provider.complete(msgs))).code).toBe("context_length");
  });

  it("retries 429 honoring retry-after seconds", async () => {
    const { provider, sleeps } = setup({}, [
      res(429, { error: { message: "slow down" } }, { "retry-after": "7" }),
      ok("done"),
    ]);
    expect((await provider.complete(msgs)).text).toBe("done");
    expect(sleeps).toEqual([7000]);
  });

  it("caps retry-after waits and gives up on very long ones", async () => {
    const capped = setup({}, [res(429, "", { "retry-after": "45" }), ok("done")]);
    await capped.provider.complete(msgs);
    expect(capped.sleeps).toEqual([30_000]);

    const quota = setup({}, [res(429, { error: { message: "daily quota" } }, { "retry-after": "3600" })]);
    const err = await caught(quota.provider.complete(msgs));
    expect(err.code).toBe("rate_limit");
    expect(err.message).toMatch(/free-tier/);
    expect(quota.sleeps).toEqual([]);
  });

  it("returns rate_limit after exhausting retries with exponential backoff", async () => {
    const { provider, sleeps, calls } = setup({ maxRetries: 2 }, [res(429, ""), res(429, ""), res(429, "")]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("rate_limit");
    expect(err.status).toBe(429);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("retries 500 then succeeds", async () => {
    const { provider, calls } = setup({}, [res(500, "boom"), res(503, "busy"), ok("fine")]);
    expect((await provider.complete(msgs)).text).toBe("fine");
    expect(calls).toHaveLength(3);
  });

  it("maps exhausted 5xx to server", async () => {
    const { provider } = setup({ maxRetries: 1 }, [res(502, "bad gw"), res(502, "bad gw")]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("server");
    expect(err.message).toContain("bad gw");
  });

  it("does not retry 401 and names the env var", async () => {
    const { provider, calls } = setup({ preset: "openrouter" }, [res(401, { error: { message: "No auth" } })], {
      OPENROUTER_API_KEY: "k",
    });
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("auth");
    expect(err.status).toBe(401);
    expect(err.message).toContain("OPENROUTER_API_KEY");
    expect(calls).toHaveLength(1);
  });

  it("does not retry generic 400s", async () => {
    const { provider, calls } = setup({}, [res(400, { error: { message: "bad param" } })]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("server");
    expect(err.message).toContain("bad param");
    expect(calls).toHaveLength(1);
  });

  it("maps Ollama model-not-found to an `ollama pull` hint", async () => {
    const { provider, calls } = setup({ preset: "ollama", model: "llama9" }, [
      res(404, { error: "model 'llama9' not found" }),
    ]);
    const err = await caught(provider.complete(msgs, { json: true }));
    expect(err.code).toBe("model_not_found");
    expect(err.message).toBe('Model "llama9" not found — run `ollama pull llama9`');
    expect(calls).toHaveLength(1);
  });

  it("maps hosted model-not-found (400) without json fallback", async () => {
    const { provider, calls } = setup({ preset: "openrouter", model: "foo/bar:free" }, [
      res(400, { error: { message: "foo/bar:free is not a valid model ID" } }),
    ], { OPENROUTER_API_KEY: "k" });
    const err = await caught(provider.complete(msgs, { json: true }));
    expect(err.code).toBe("model_not_found");
    expect(calls).toHaveLength(1);
  });

  it("fails fast with unreachable on connection refused (Ollama hint)", async () => {
    const { provider, calls } = setup({ preset: "ollama" }, [netError("ECONNREFUSED"), netError("ECONNREFUSED")]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("unreachable");
    expect(err.message).toBe(
      "Ollama is not reachable at localhost:11434 — start it with `ollama serve` (or install from https://ollama.com)",
    );
    expect(calls).toHaveLength(2);
  });

  it("detects ECONNREFUSED inside AggregateError causes", async () => {
    const agg = Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]), {});
    const { provider, calls } = setup({ preset: "groq" }, [
      new TypeError("fetch failed", { cause: agg }),
      new TypeError("fetch failed", { cause: agg }),
    ], { GROQ_API_KEY: "k" });
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("unreachable");
    expect(err.message).toContain("ECONNREFUSED");
    expect(calls).toHaveLength(2);
  });

  it("retries transient network errors (ECONNRESET) up to maxRetries", async () => {
    const { provider, calls } = setup({}, [netError("ECONNRESET"), netError("ECONNRESET"), ok("back")]);
    expect((await provider.complete(msgs)).text).toBe("back");
    expect(calls).toHaveLength(3);
  });

  it("times out with an actionable unreachable error", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { provider, calls } = setup({ timeoutMs: 20 }, [hang]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("unreachable");
    expect(err.message).toMatch(/did not respond within .*timeoutMs/);
    expect(calls).toHaveLength(1);
  });

  it("gives Ollama timeouts actionable hints", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { provider } = setup({ preset: "ollama", timeoutMs: 20 }, [hang]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("unreachable");
    expect(err.message).toContain("lower maxChunkTokens in .acr.yml");
    expect(err.message).toContain("`qwen2.5-coder:7b`");
    expect(err.message).toContain("provider.timeoutMs");
  });

  it("defaults to 300s for ollama, 120s for hosted presets, explicit timeoutMs wins", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      await setup({ preset: "ollama" }, [nativeOk("x")]).provider.complete(msgs);
      await setup({ preset: "groq" }, [ok("x")], { GROQ_API_KEY: "k" }).provider.complete(msgs);
      await setup({ preset: "ollama", timeoutMs: 45_000 }, [nativeOk("x")]).provider.complete(msgs);
    } finally {
      spy.mockRestore();
    }
    expect(delays).toEqual([300_000, 120_000, 45_000]);
  });

  it("propagates the caller's abort signal without wrapping", async () => {
    const controller = new AbortController();
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => controller.abort(new Error("user cancelled")), 5);
      });
    const { provider } = setup({}, [hang]);
    await expect(provider.complete(msgs, { signal: controller.signal })).rejects.toThrow("user cancelled");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { provider, fetch } = setup({}, []);
    await expect(provider.complete(msgs, { signal: AbortSignal.abort(new Error("nope")) })).rejects.toThrow("nope");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps empty or malformed responses to bad_response", async () => {
    const empty = setup({}, [res(200, { choices: [] })]);
    expect((await caught(empty.provider.complete(msgs))).code).toBe("bad_response");

    const blank = setup({}, [res(200, { choices: [{ message: { content: "" }, finish_reason: "length" }] })]);
    const err = await caught(blank.provider.complete(msgs));
    expect(err.code).toBe("bad_response");
    expect(err.message).toMatch(/max_tokens/);

    const html = setup({}, [res(200, "<html>proxy</html>")]);
    expect((await caught(html.provider.complete(msgs))).code).toBe("bad_response");
  });

  it("maps 200 + error payloads (gateway style)", async () => {
    const { provider } = setup({}, [res(200, { error: { code: 429, message: "upstream rate limited" } })]);
    expect((await caught(provider.complete(msgs))).code).toBe("rate_limit");
  });

  it("joins array content parts and tolerates missing usage", async () => {
    const { provider } = setup({}, [
      res(200, { choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] }),
    ]);
    expect(await provider.complete(msgs)).toEqual({ text: "ab" });
  });
});

describe("ollama native API", () => {
  it("posts to /api/chat with num_ctx and maps usage", async () => {
    const { provider, calls } = setup({ preset: "ollama" }, [nativeOk('{"ok":true}')]);
    const out = await provider.complete(msgs, { json: true });
    expect(out).toEqual({ text: '{"ok":true}', usage: { inputTokens: 31, outputTokens: 7 } });
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]?.body).toEqual({
      model: "qwen2.5-coder:14b",
      messages: msgs,
      stream: false,
      format: "json",
      // "hi" → 1 + 4 template tokens; (5 + 4096) * 1.1 → 4512 → next multiple of 2048
      options: { temperature: 0, num_predict: 4096, num_ctx: 6144 },
    });
  });

  it("omits format when json is not requested and passes options", async () => {
    const { provider, calls } = setup({ preset: "ollama" }, [nativeOk("x")]);
    await provider.complete(msgs, { temperature: 0.3, maxTokens: 256 });
    expect(calls[0]?.body).not.toHaveProperty("format");
    expect(calls[0]?.body?.options).toEqual({ temperature: 0.3, num_predict: 256, num_ctx: 4096 });
  });

  it("never shrinks num_ctx within a provider (avoids Ollama model reloads)", async () => {
    const { provider, calls } = setup({ preset: "ollama" }, [nativeOk("a"), nativeOk("b")]);
    await provider.complete([{ role: "user", content: "x".repeat(35_000) }]);
    await provider.complete(msgs);
    const ctx = calls.map((c) => (c.body?.options as { num_ctx: number }).num_ctx);
    expect(ctx).toEqual([20480, 20480]);
  });

  it("honors ACR_OLLAMA_NUM_CTX", async () => {
    const { provider, calls } = setup({ preset: "ollama" }, [nativeOk("x")], { ACR_OLLAMA_NUM_CTX: "20000" });
    await provider.complete(msgs);
    expect((calls[0]?.body?.options as { num_ctx: number }).num_ctx).toBe(20000);
  });

  it("refuses prompts that cannot fit instead of letting Ollama truncate them", async () => {
    const { provider, fetch } = setup({ preset: "ollama" }, []);
    const err = await caught(provider.complete([{ role: "user", content: "x".repeat(200_000) }]));
    expect(err.code).toBe("context_length");
    expect(err.message).toMatch(/num_ctx 32768/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps empty native completions to bad_response", async () => {
    const { provider } = setup({ preset: "ollama" }, [nativeOk("", { done_reason: "length" })]);
    const err = await caught(provider.complete(msgs));
    expect(err.code).toBe("bad_response");
    expect(err.message).toMatch(/max_tokens/);
  });

  it("retries native 5xx like the OpenAI path", async () => {
    const { provider, calls } = setup({ preset: "ollama" }, [res(500, { error: "busy" }), nativeOk("ok")]);
    expect((await provider.complete(msgs)).text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("falls back to /v1/chat/completions once when /api/chat is 404 (proxy)", async () => {
    const { provider, calls } = setup({ preset: "ollama", baseUrl: "http://proxy/openai/v1" }, [
      res(404, "404 page not found"),
      ok("via v1"),
      ok("again"),
    ]);
    expect((await provider.complete(msgs, { json: true })).text).toBe("via v1");
    expect((await provider.complete(msgs)).text).toBe("again");
    expect(calls.map((c) => c.url)).toEqual([
      "http://proxy/openai/api/chat",
      "http://proxy/openai/v1/chat/completions",
      "http://proxy/openai/v1/chat/completions",
    ]);
    expect(calls[1]?.body?.response_format).toEqual({ type: "json_object" });
  });
});

describe("ollamaNumCtx", () => {
  it("adds output + 10%, rounds to 2048, clamps to [4096, 32768]", () => {
    expect(ollamaNumCtx(0, 100)).toBe(4096);
    expect(ollamaNumCtx(6900, 4096)).toBe(12288);
    expect(ollamaNumCtx(100_000, 4096)).toBe(32768);
  });

  it("sizes a full maxChunkTokens=6000 chunk + ~900-token system prompt to 16384", () => {
    const system = "s".repeat(Math.round(900 * 3.5));
    const chunk = "x".repeat(6000 * 3.5);
    expect(estimateTokens(chunk)).toBe(6000);
    const input = ollamaPromptTokens([
      { role: "system", content: system },
      { role: "user", content: chunk },
    ]);
    expect(ollamaNumCtx(input, 4096)).toBe(16384);
  });
});

describe("ping", () => {
  it("checks Ollama models via /api/tags (with :latest normalization)", async () => {
    const tags = {
      models: [
        { name: "qwen2.5-coder:14b", model: "qwen2.5-coder:14b" },
        { name: "llama3:latest", model: "llama3:latest" },
      ],
    };
    const a = setup({ preset: "ollama" }, [res(200, tags)]);
    await a.provider.ping();
    expect(a.calls[0]?.url).toBe("http://localhost:11434/api/tags");
    expect(a.calls[0]?.init.method).toBe("GET");
    await setup({ preset: "ollama", model: "llama3" }, [res(200, tags)]).provider.ping();
  });

  it("passes when the model is listed on an OpenAI-compatible /models", async () => {
    await setup({}, [res(200, { object: "list", data: [{ id: "m" }] })]).provider.ping();
  });

  it("falls back to /v1/models when /api/tags is missing (proxy)", async () => {
    const { provider, calls } = setup({ preset: "ollama", baseUrl: "http://proxy/openai/v1" }, [
      res(404, "404 page not found"),
      res(200, { data: [{ id: "qwen2.5-coder:14b" }] }),
    ]);
    await provider.ping();
    expect(calls.map((c) => c.url)).toEqual(["http://proxy/openai/api/tags", "http://proxy/openai/v1/models"]);
  });

  it("sends GET /models with auth", async () => {
    const { provider, calls } = setup({ preset: "gemini" }, [res(200, { data: [{ id: "models/gemini-3.8-flash" }] })], {
      GEMINI_API_KEY: "g",
    });
    await provider.ping();
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
    expect(calls[0]?.init.method).toBe("GET");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer g");
  });

  it("throws model_not_found when the model is missing", async () => {
    const { provider } = setup({ preset: "ollama" }, [res(200, { models: [{ name: "other:7b", model: "other:7b" }] })]);
    const err = await caught(provider.ping());
    expect(err.code).toBe("model_not_found");
    expect(err.message).toContain("ollama pull qwen2.5-coder:14b");
  });

  it("treats an empty Ollama list as missing model", async () => {
    const { provider } = setup({ preset: "ollama" }, [res(200, { models: [] })]);
    expect((await caught(provider.ping())).code).toBe("model_not_found");
  });

  it("treats a missing /models endpoint or unparseable list as OK", async () => {
    await setup({ preset: "openai-compatible", baseUrl: "http://x/v1", model: "m" }, [res(404, "not found")]).provider.ping();
    await setup({}, [res(200, "weird")]).provider.ping();
  });

  it("maps auth and unreachable failures", async () => {
    const auth = setup({ preset: "cerebras" }, [res(403, "forbidden")], { CEREBRAS_API_KEY: "c" });
    expect((await caught(auth.provider.ping())).code).toBe("auth");

    const down = setup({ preset: "ollama" }, [netError("ECONNREFUSED"), netError("ECONNREFUSED")]);
    expect((await caught(down.provider.ping())).code).toBe("unreachable");
  });
});

describe("retryAfterMs", () => {
  it("parses seconds, HTTP dates and retry-after-ms", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs(new Headers({ "retry-after": "2" }), now)).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }), now)).toBe(5000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250" }), now)).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after": "garbage" }), now)).toBeNull();
    expect(retryAfterMs(new Headers(), now)).toBeNull();
  });
});

describe.skipIf(!process.env.ACR_LIVE_OLLAMA)("live Ollama", () => {
  it("completes a tiny JSON prompt via the native API", { timeout: 180_000 }, async () => {
    const urls: string[] = [];
    const provider = createProvider({ preset: "ollama" }, process.env, {
      fetch: (input, init) => {
        urls.push(String(input));
        return globalThis.fetch(input, init);
      },
    });
    await provider.ping();
    const out = await provider.complete(
      [{ role: "user", content: 'Reply with the JSON object {"ok": true} and nothing else.' }],
      { json: true, maxTokens: 50 },
    );
    expect(urls.map((u) => new URL(u).pathname)).toEqual(["/api/tags", "/api/chat"]);
    expect(extractJson(out.text)).toEqual({ ok: true });
    expect(out.usage?.inputTokens).toBeGreaterThan(0);
  });
});
