import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "../helpers/cli.js";
import { closedPort, FakeLLM, issuesReply } from "../helpers/fake-llm.js";

// Secret-shaped fixtures are assembled at runtime so no literal credential lives in this repo.
const AWS_KEY = ["AK", "IA", "Z7Q2", "M4N8", "P3R6", "T5V9"].join("");
const GH_TOKEN = ["gh", "p_", "a1B2c3D4e5F6g7H8", "i9J0k1L2m3N4o5P6", "q7R8"].join("");
const CONFLICT = [["<<<<<<<", "HEAD"].join(" "), "const a = 1;", "=======", "const a = 2;", [">>>>>>>", "feature"].join(" ")];

const SECRET_FILE = [
  `export const awsKey = "${AWS_KEY}";`,
  `const token = "${GH_TOKEN}";`,
  "export function f() {",
  "  debugger;",
  "  return 1;",
  "}",
].join("\n");

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
});
afterEach(async () => {
  await sb.cleanup();
});

function assertNoFullSecret(...outputs: string[]): void {
  for (const out of outputs) {
    expect(out).not.toContain(AWS_KEY);
    expect(out).not.toContain(GH_TOKEN);
  }
}

describe("offline checks (--no-ai)", () => {
  it("finds secrets, conflict markers and debugger with the expected rule ids; never prints full secrets", async () => {
    // Even a configured-but-dead provider must not be contacted with --no-ai.
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "src/config.ts": `${SECRET_FILE}\n`, "src/merge.ts": `${CONFLICT.join("\n")}\n` });

    const res = await sb.reviewJson(["--no-ai"]);
    expect(res.code).toBe(1);
    expect(res.json.complete).toBe(true);
    expect(res.json.stats.provider).toBeNull();
    expect(fake.requests).toHaveLength(0);

    const found = res.json.issues.map((i) => `${i.ruleId}@${i.file}:${i.line}`).sort();
    expect(found).toEqual(
      expect.arrayContaining([
        "secrets/aws-access-key@src/config.ts:1",
        "secrets/github-token@src/config.ts:2",
        "debug-statements/debugger@src/config.ts:4",
        "conflict-markers@src/merge.ts:1",
      ]),
    );
    for (const i of res.json.issues) expect(i.source).toBe("check");
    expect(res.json.issues.find((i) => i.ruleId === "secrets/aws-access-key")?.severity).toBe("critical");
    expect(res.json.issues.find((i) => i.ruleId === "debug-statements/debugger")?.severity).toBe("warning");
    assertNoFullSecret(res.stdout, res.stderr);
    expect(res.stdout).toContain("AKIA****");

    const pretty = await sb.acr(["review", "--no-ai", "--no-color", "--verbose"]);
    expect(pretty.code).toBe(1);
    assertNoFullSecret(pretty.stdout, pretty.stderr);
    const md = await sb.acr(["review", "--no-ai", "--format", "markdown"]);
    assertNoFullSecret(md.stdout, md.stderr);
    expect(md.stdout).toMatch(/secrets\/aws-access-key/);
  });

  it("with AI on, secrets are reported, never echoed in full, and redacted from the prompt sent to the provider", async () => {
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "src/config.ts": `${SECRET_FILE}\n` });
    const res = await sb.reviewJson();
    expect(res.code).toBe(1);
    assertNoFullSecret(res.stdout, res.stderr);
    expect(fake.chatRequests).toHaveLength(1);
    expect(fake.chatRequests[0]?.raw).not.toContain(AWS_KEY);
    expect(fake.chatRequests[0]?.raw).toContain("[REDACTED]");
  });

  it("checks can be disabled from .acr.yml", async () => {
    await sb.configure(null, { checks: { secrets: false, debugStatements: false } });
    await sb.repo.writeAndStage({ "src/config.ts": `${SECRET_FILE}\n` });
    const res = await sb.reviewJson(["--no-ai"]);
    expect(res.code).toBe(0);
    expect(res.json.issues).toEqual([]);
  });

  it("only added lines are checked (a secret already in HEAD is not re-reported)", async () => {
    await sb.repo.commit({ "src/config.ts": `${SECRET_FILE}\n` }, "legacy");
    await sb.repo.writeAndStage({ "src/config.ts": `${SECRET_FILE}\nexport const ok = 1;\n` });
    const res = await sb.reviewJson(["--no-ai"]);
    expect(res.json.issues).toEqual([]);
    expect(res.code).toBe(0);
  });
});

describe("LLM failures", () => {
  it("unreachable provider: checks still run, complete:false with an actionable message", async () => {
    const port = await closedPort();
    await sb.configure(null, {
      provider: { preset: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", maxRetries: 0 },
    });
    await sb.repo.writeAndStage({ "src/config.ts": `${SECRET_FILE}\n` });
    const started = Date.now();
    const res = await sb.reviewJson();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.code).toBe(1); // blocking secret found by offline checks
    expect(res.json.complete).toBe(false);
    expect(res.json.issues.some((i) => i.ruleId === "secrets/aws-access-key")).toBe(true);
    expect(res.json.errors[0]).toMatchObject({ stage: "llm" });
    expect(res.json.errors[0]?.message).toMatch(new RegExp(`Cannot reach openai-compatible at http://127\\.0\\.0\\.1:${port}/v1`));
    assertNoFullSecret(res.stdout, res.stderr);
  });

  it("unreachable provider in --hook mode with clean code: does not block (onError warn)", async () => {
    const port = await closedPort();
    await sb.configure(null, {
      provider: { preset: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", maxRetries: 0 },
    });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    const res = await sb.acr(["review", "--staged", "--hook"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/review incomplete, continuing \(onError: warn\)/);

    await sb.configure(null, {
      onError: "fail",
      provider: { preset: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", maxRetries: 0 },
    });
    const strict = await sb.acr(["review", "--staged", "--hook"]);
    expect(strict.code).toBe(2);
    expect(strict.stderr).toMatch(/commit blocked because the review is incomplete/);
  });

  it("unreachable Ollama (default preset) gives the `ollama serve` hint", async () => {
    const port = await closedPort();
    await sb.configure(null, { provider: { preset: "ollama", maxRetries: 0 } });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    const res = await sb.reviewJson([], { OLLAMA_HOST: `127.0.0.1:${port}` });
    expect(res.code).toBe(0);
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/Ollama is not reachable at 127\.0\.0\.1:\d+ — start it with `ollama serve`/);
  });

  it("429 with retry-after is retried and then succeeds", async () => {
    await sb.configure(fake, { provider: { maxRetries: 2 } });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    fake.enqueue(
      { status: 429, headers: { "retry-after": "0" } },
      issuesReply([{ severity: "warning", file: "src/ok.ts", line: 1, title: "After rate limit" }]),
    );
    const res = await sb.reviewJson();
    expect(res.json.complete).toBe(true);
    expect(res.json.issues.map((i) => i.title)).toEqual(["After rate limit"]);
    expect(fake.chatRequests).toHaveLength(2);
  });

  it("429 persisting past maxRetries → rate_limit error, incomplete", async () => {
    await sb.configure(fake, { provider: { maxRetries: 1 } });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    fake.setFallback({ status: 429, headers: { "retry-after": "0" } });
    const res = await sb.reviewJson();
    expect(res.code).toBe(0);
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/Rate limited by openai-compatible \(HTTP 429\)/);
    expect(fake.chatRequests).toHaveLength(2);
  });

  it("HTTP 500 → server error, incomplete; exit 2 with onError fail", async () => {
    await sb.configure(fake, { onError: "fail" });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    fake.setFallback({ status: 500 });
    const res = await sb.reviewJson();
    expect(res.code).toBe(2);
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/server error \(HTTP 500\)/);
  });

  it("non-JSON HTTP body (broken server) → bad_response error, incomplete", async () => {
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    fake.setFallback({ raw: "<html>502 Bad Gateway</html>" });
    const res = await sb.reviewJson();
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/non-JSON response/);
  });

  it("slow provider beyond timeoutMs → timeout error, incomplete, fast", async () => {
    await sb.configure(fake, { provider: { timeoutMs: 300 } });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    fake.setFallback({ content: issuesReply([]), delayMs: 3000 });
    const started = Date.now();
    const res = await sb.reviewJson();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/did not respond within/);
  });

  it("a model that is not served → hook mode reports it and does not block", async () => {
    await sb.configure(fake, { provider: { model: "missing-model" } });
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    const res = await sb.acr(["review", "--hook", "--format", "json"]);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as { complete: boolean; errors: Array<{ message: string }> };
    expect(json.complete).toBe(false);
    expect(json.errors[0]?.message).toMatch(/missing-model/);
    expect(fake.chatRequests).toHaveLength(0);
  });
});
