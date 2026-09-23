import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "../helpers/cli.js";
import { FakeLLM, filesInPrompt, issuesReply } from "../helpers/fake-llm.js";

let fake: FakeLLM;
let sb: Sandbox;

beforeAll(async () => {
  fake = await FakeLLM.start();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  sb = await Sandbox.create();
  await sb.repo.commit({ "README.md": "# demo\n" }, "init");
  await sb.configure(null, { provider: { preset: "ollama", model: "fake", maxRetries: 0, timeoutMs: 5000 } });
  await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\nexport const b = a / 0;\n" });
  fake.onChat((_req, messages) =>
    issuesReply(filesInPrompt(messages).map((file) => ({ severity: "warning", file, line: 2, title: "Division by zero" }))),
  );
});
afterEach(async () => {
  await sb.cleanup();
});

const ollamaEnv = () => ({ OLLAMA_HOST: fake.origin });

describe("Ollama native API (preset ollama + OLLAMA_HOST)", () => {
  it("sends reviews to /api/chat with options.num_ctx and JSON format", async () => {
    const res = await sb.reviewJson([], ollamaEnv());
    expect(res.json.complete, JSON.stringify(res.json.errors)).toBe(true);
    expect(res.json.stats).toMatchObject({ provider: "ollama", model: "fake" });
    expect(res.json.issues.map((i) => [i.file, i.line, i.title])).toEqual([["src/a.ts", 2, "Division by zero"]]);

    expect(fake.chatRequests.map((r) => r.path)).toEqual(["/api/chat"]);
    const body = fake.chatRequests[0]?.body;
    expect(body.model).toBe("fake");
    expect(body.stream).toBe(false);
    expect(body.format).toBe("json");
    expect(typeof body.options?.num_ctx).toBe("number");
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(4096);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("ACR_OLLAMA_NUM_CTX pins num_ctx", async () => {
    await sb.reviewJson([], { ...ollamaEnv(), ACR_OLLAMA_NUM_CTX: "16384" });
    expect(fake.chatRequests[0]?.body.options.num_ctx).toBe(16384);
  });

  it("an invalid ACR_OLLAMA_NUM_CTX is a usage error (exit 3)", async () => {
    const res = await sb.acr(["review"], { ...ollamaEnv(), ACR_OLLAMA_NUM_CTX: "lots" });
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/ACR_OLLAMA_NUM_CTX/);
    expect(fake.chatRequests).toHaveLength(0);
  });

  it("hook mode pings /api/tags before reviewing", async () => {
    const res = await sb.acr(["review", "--hook", "--format", "json"], ollamaEnv());
    expect(res.code).toBe(0);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/tags", "POST /api/chat"]);
  });

  it("a model missing from /api/tags → hook reports `ollama pull` and does not block", async () => {
    fake.models = ["other-model"];
    const res = await sb.acr(["review", "--hook", "--format", "json"], ollamaEnv());
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as { complete: boolean; errors: Array<{ message: string }> };
    expect(json.complete).toBe(false);
    expect(json.errors[0]?.message).toMatch(/ollama pull fake/);
    expect(fake.chatRequests).toHaveLength(0);
  });

  it("falls back to /v1/chat/completions when /api/chat is 404 (OpenAI-only proxy)", async () => {
    fake.onChat((req, messages) =>
      req.path === "/api/chat"
        ? { status: 404 }
        : issuesReply(filesInPrompt(messages).map((file) => ({ severity: "warning", file, line: 2, title: "Via v1" }))),
    );
    const res = await sb.reviewJson([], ollamaEnv());
    expect(res.json.complete, JSON.stringify(res.json.errors)).toBe(true);
    expect(fake.chatRequests.map((r) => r.path)).toEqual(["/api/chat", "/v1/chat/completions"]);
    expect(res.json.issues.map((i) => i.title)).toEqual(["Via v1"]);
  });

  it("an explicit provider.baseUrl (…/v1) also uses the native API on the same host", async () => {
    await sb.configure(null, { provider: { preset: "ollama", model: "fake", baseUrl: fake.baseUrl, maxRetries: 0 } });
    const res = await sb.reviewJson();
    expect(res.json.complete).toBe(true);
    expect(fake.chatRequests.map((r) => r.path)).toEqual(["/api/chat"]);
  });
});
