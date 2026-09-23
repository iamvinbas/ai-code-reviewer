import { rm, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { runCli, Sandbox, spawnCli, stripAnsi } from "../helpers/cli.js";
import { FakeLLM, filesInPrompt, issuesReply } from "../helpers/fake-llm.js";
import { makeTempDir, TempRepo } from "../helpers/repo.js";

const STRIPE = ["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");

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

describe("provider configuration end-to-end", () => {
  it("env-only config (ACR_PROVIDER / ACR_BASE_URL / ACR_MODEL) reaches the fake server", async () => {
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const res = await sb.reviewJson([], {
      ACR_PROVIDER: "openai-compatible",
      ACR_BASE_URL: fake.baseUrl,
      ACR_MODEL: "env-model",
    });
    expect(res.json.complete, JSON.stringify(res.json.errors)).toBe(true);
    expect(res.json.stats.model).toBe("env-model");
    expect(fake.chatRequests[0]?.body.model).toBe("env-model");
  });

  it("--model and --lang flags override the repo config", async () => {
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    fake.models = ["fake", "flag-model"];
    await sb.reviewJson(["--model", "flag-model", "--lang", "it"]);
    const body = fake.chatRequests[0]?.body;
    expect(body.model).toBe("flag-model");
    expect(body.messages[0].content).toContain("Italian");
  });

  it("--provider groq without GROQ_API_KEY degrades to checks with a clear error (no crash, no request)", async () => {
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const res = await sb.reviewJson(["--provider", "groq"]);
    expect(res.code).toBe(0);
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/GROQ_API_KEY is not set/);
    expect(fake.requests).toHaveLength(0);
  });

  it("warns when the repo config sends code to an unknown host", async () => {
    await sb.configure(null, { provider: { preset: "openai-compatible", baseUrl: "https://llm.evil.example/v1", model: "m" } });
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const res = await sb.acr(["review", "--no-ai", "--format", "json"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/your code changes will be sent there/);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("a repo config cannot point apiKeyEnv at an arbitrary secret (exit 3)", async () => {
    await sb.configure(fake, { provider: { apiKeyEnv: "AWS_SECRET_ACCESS_KEY" } });
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const res = await sb.acr(["review"], { AWS_SECRET_ACCESS_KEY: "do-not-send" });
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/apiKeyEnv must be an env var name ending in _API_KEY/);
    expect(fake.requests).toHaveLength(0);
  });

  it("sends the API key as a Bearer token when configured", async () => {
    await sb.configure(fake, { provider: { apiKeyEnv: "FAKE_API_KEY" } });
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    await sb.reviewJson([], { FAKE_API_KEY: "test-key-123" });
    expect(fake.chatRequests[0]?.headers.authorization).toBe("Bearer test-key-123");
  });
});

describe("model output robustness", () => {
  beforeEach(async () => {
    await sb.configure(fake);
  });

  it("terminal escape sequences from the model are stripped from pretty output", async () => {
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    fake.setFallback(
      issuesReply([
        { severity: "warning", file: "a.ts", line: 1, title: "Evil \u001b]0;pwned\u0007title \u001b[2J", message: "x\u001b[31mred" },
      ]),
    );
    const res = await sb.acr(["review", "--no-color", "--verbose"]);
    expect(res.stdout).toContain("Evil");
    expect(res.stdout).not.toMatch(/\u001b/);
    expect(res.stdout).not.toMatch(/\u0007/);
  });

  it("accepts ```json fenced replies without a retry", async () => {
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    fake.setFallback("```json\n" + issuesReply([{ severity: "warning", file: "a.ts", line: 1, title: "Fenced" }]) + "\n```");
    const res = await sb.reviewJson();
    expect(res.json.issues.map((i) => i.title)).toEqual(["Fenced"]);
    expect(fake.chatRequests).toHaveLength(1);
  });

  it("normalizes a/ b/ ./ prefixed paths and fills in the file for single-file chunks", async () => {
    await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\nexport const b = 2;\n" });
    fake.setFallback(
      issuesReply([
        { severity: "warning", file: "b/src/a.ts", line: 1, title: "b-prefixed" },
        { severity: "warning", file: "./src/a.ts", line: 2, title: "dot-prefixed" },
        { severity: "warning", line: 2, title: "no file" },
      ]),
    );
    const res = await sb.reviewJson();
    expect(res.json.issues.map((i) => `${i.file}:${i.line}:${i.title}`).sort()).toEqual([
      "src/a.ts:1:b-prefixed",
      "src/a.ts:2:dot-prefixed",
      "src/a.ts:2:no file",
    ]);
  });

  it("unknown severities are retried with a correction, then dropped with a parse error", async () => {
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    fake.setFallback(
      issuesReply([
        { severity: "high", file: "a.ts", line: 1, title: "Bad severity" },
        { severity: "warning", file: "a.ts", line: 1, title: "Good one" },
      ]),
    );
    const res = await sb.reviewJson();
    expect(fake.chatRequests).toHaveLength(2);
    expect(res.json.issues.map((i) => i.title)).toEqual(["Good one"]);
    expect(res.json.errors).toEqual([expect.objectContaining({ stage: "parse" })]);
    expect(res.json.errors[0]?.message).toMatch(/1 malformed AI issue\(s\) discarded/);
  });

  it("an empty completion is a bad_response error (incomplete), not 'no issues'", async () => {
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    fake.setFallback({ content: "" });
    const res = await sb.reviewJson();
    expect(res.json.complete).toBe(false);
    expect(res.json.errors[0]?.message).toMatch(/empty completion/);
  });

  it("a single oversized hunk is truncated and the review marked incomplete", async () => {
    await sb.configure(fake, { maxChunkTokens: 500, contextLines: 0 });
    const big = Array.from({ length: 400 }, (_, i) => `export const longVariableName${i} = someFunctionCall(${i}, "padding text");`);
    await sb.repo.writeAndStage({ "big.ts": `${big.join("\n")}\n` });
    const res = await sb.reviewJson();
    expect(res.json.complete).toBe(false);
    expect(res.json.errors.some((e) => /diff too large, partially reviewed/.test(e.message))).toBe(true);
    expect(fake.chatRequests.length).toBeGreaterThan(0);
  });
});

describe("git edge cases", () => {
  beforeEach(async () => {
    await sb.configure(fake);
    fake.onChat((_req, messages) =>
      issuesReply(filesInPrompt(messages).map((file) => ({ severity: "warning", file, line: 1, title: `in ${file}` }))),
    );
  });

  it("paths with spaces and unicode survive the round trip", async () => {
    await sb.repo.writeAndStage({ "src/my café file.ts": "export const x = 1;\n" });
    const res = await sb.reviewJson();
    expect(filesInPrompt(fake.chatRequests[0]?.body.messages)).toEqual(["src/my café file.ts"]);
    expect(res.json.issues.map((i) => i.file)).toEqual(["src/my café file.ts"]);
  });

  it("renamed files are reviewed under their new path", async () => {
    await sb.repo.commit({ "old.ts": Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n" });
    await sb.repo.git("mv", "old.ts", "new.ts");
    await sb.repo.write({ "new.ts": Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i === 5 ? 99 : i};`).join("\n") + "\n" });
    await sb.repo.stage("new.ts");
    const res = await sb.reviewJson();
    expect(fake.chatRequests[0]?.raw).toContain("### new.ts (renamed from old.ts)");
    expect(res.json.issues.map((i) => i.file)).toEqual(["new.ts"]);
  });

  it("binary files are not sent to the AI", async () => {
    await writeFile(sb.repo.path("img.dat"), Buffer.from([0, 1, 2, 0, 255, 0, 10, 0]));
    await sb.repo.stage("img.dat");
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const res = await sb.reviewJson();
    expect(filesInPrompt(fake.chatRequests[0]?.body.messages)).toEqual(["a.ts"]);
    expect(res.json.stats.filesInDiff).toBe(2);
  });

  it("CRLF files and files without a trailing newline are handled", async () => {
    await sb.repo.writeAndStage({ "crlf.ts": "export const a = 1;\r\nexport const b = 2;\r\n", "nonl.ts": "export const c = 3;" });
    const res = await sb.reviewJson();
    expect(res.json.complete).toBe(true);
    expect(res.json.issues.map((i) => i.file).sort()).toEqual(["crlf.ts", "nonl.ts"]);
  });

  it("works in a repository with no commits yet", async () => {
    const repo = await TempRepo.create();
    try {
      await repo.writeAndStage({ "a.ts": "debugger;\n" });
      const res = await runCli(["review", "--no-ai", "--format", "json"], { cwd: repo.dir, env: sb.env() });
      expect(res.code, res.stderr).toBe(0);
      const json = JSON.parse(res.stdout) as { issues: Array<{ ruleId: string }> };
      expect(json.issues.map((i) => i.ruleId)).toEqual(["debug-statements/debugger"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("--range without any main/master branch → usage error with a hint", async () => {
    await sb.repo.git("branch", "-m", "main", "trunk");
    const res = await sb.acr(["review", "--range"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/acr review --range <branch>/);
  });

  it("outside a git repository → usage error (exit 3)", async () => {
    const dir = await makeTempDir("acr-nogit-");
    try {
      const res = await runCli(["review", "--no-ai"], { cwd: dir, env: sb.env() });
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/^acr: /);
      expect(res.stderr).not.toMatch(/unexpected error/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("running from a subdirectory reviews the whole repo with repo-relative paths", async () => {
    await sb.repo.writeAndStage({ "pkg/sub/a.ts": "export const a = 1;\n", "root.ts": "export const r = 1;\n" });
    const res = await runCli(["review", "--format", "json"], { cwd: sb.repo.path("pkg"), env: sb.env() });
    const json = JSON.parse(res.stdout) as { issues: Array<{ file: string }> };
    expect(json.issues.map((i) => i.file).sort()).toEqual(["pkg/sub/a.ts", "root.ts"]);
  });
});

describe("cross-source dedupe (AI restating a deterministic check)", () => {
  it("drops the AI duplicate of a secret finding on the same line but keeps a different concern", async () => {
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "pay.ts": `export const key = "${STRIPE}";\nexport const q = "SELECT * FROM t WHERE id=" + id;\n` });
    fake.setFallback(
      issuesReply([
        { severity: "critical", file: "pay.ts", line: 1, title: "Hardcoded API key", category: "security" },
        { severity: "critical", file: "pay.ts", line: 2, title: "SQL injection", category: "security" },
      ]),
    );
    const res = await sb.reviewJson();
    const got = res.json.issues.map((i) => `${i.source}:${i.line}:${i.ruleId ?? ""}:${i.title}`).sort();
    expect(got).toEqual(["ai:2:security:SQL injection", "check:1:secrets/stripe-key:Hardcoded Stripe live key"]);
  });
});

describe("offline safety net coverage", () => {
  it("secrets in .env files are detected", async () => {
    await sb.repo.writeAndStage({ ".env": `STRIPE_KEY=${STRIPE}\n` });
    const res = await sb.reviewJson(["--no-ai"]);
    expect(res.json.issues.map((i) => i.ruleId)).toContain("secrets/stripe-key");
    expect(res.stdout).not.toContain(STRIPE);
  });

  // Regression: DEFAULT_SKIP (dist/, build/, vendor/, lockfiles…) applies to the AI only, never to checks.
  it("secrets check still scans paths that are skipped for the AI by default (build/, vendor/)", async () => {
    await sb.repo.writeAndStage({ "build/deploy.sh": `export STRIPE_KEY=${STRIPE}\n` });
    const res = await sb.reviewJson(["--no-ai"]);
    expect(res.json.issues.map((i) => i.ruleId)).toContain("secrets/stripe-key");
  });
});

describe("regressions", () => {
  // A relative cache.dir resolves against the repo root, not process.cwd().
  it("a relative cache.dir is resolved against the repository root", async () => {
    await sb.configure(fake, { cache: { dir: ".acr/cache" } });
    await sb.repo.writeAndStage({ "pkg/a.ts": "export const a = 1;\n" });
    const res = await spawnCli(["review", "--format", "json"], { cwd: sb.repo.path("pkg"), env: sb.env() });
    expect(res.code, res.stderr).toBe(0);
    const atRoot = sb.repo.path(".acr/cache");
    expect(existsSync(atRoot) && readdirSync(atRoot).length > 0).toBe(true);
  });

  // Non-fatal errors are shown by the pretty formatter even when the review is complete.
  it("pretty output mentions discarded malformed AI issues", async () => {
    await sb.configure(fake);
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    fake.setFallback(
      issuesReply([
        { severity: "high", file: "a.ts", line: 1, title: "Bad severity" },
        { severity: "warning", file: "a.ts", line: 1, title: "Good one" },
      ]),
    );
    const res = await sb.acr(["review", "--no-color"]);
    expect(stripAnsi(res.stdout + res.stderr)).toMatch(/malformed|discarded/);
  });
});

describe("pre-push style range review in hook mode", () => {
  it("no resolvable base branch → does not block the push (onError warn), explains why", async () => {
    await sb.repo.git("branch", "-m", "main", "trunk");
    const res = await sb.acr(["review", "--range", "--hook"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/review failed \(.*default base branch.*\); not blocking/);
  });
});
