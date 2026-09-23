import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acrEnv, runCli, Sandbox, stripAnsi } from "../helpers/cli.js";
import { closedPort, FakeLLM } from "../helpers/fake-llm.js";
import { makeTempDir } from "../helpers/repo.js";

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
});
afterEach(async () => {
  await sb.cleanup();
});

describe("acr init", () => {
  it("creates a commented, valid .acr.yml; refuses to overwrite without --force", async () => {
    const res = await sb.acr(["init"]);
    expect(res.code).toBe(0);
    expect(stripAnsi(res.stdout)).toMatch(/Created .*\.acr\.yml/);
    expect(stripAnsi(res.stdout)).toMatch(/acr doctor/);
    const path = sb.repo.path(".acr.yml");
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^#/m);

    // The generated file must load cleanly (no warnings, no config error).
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const review = await sb.acr(["review", "--no-ai", "--format", "json"]);
    expect(review.code, review.stderr).toBe(0);
    expect(review.stderr).toBe("");

    await sb.repo.write({ ".acr.yml": `${text}\n# my edits\n` });
    const again = await sb.acr(["init"]);
    expect(again.code).toBe(3);
    expect(again.stderr).toMatch(/already exists \(use --force to overwrite\)/);
    expect(readFileSync(path, "utf8")).toContain("# my edits");

    const forced = await sb.acr(["init", "--force"]);
    expect(forced.code).toBe(0);
    expect(stripAnsi(forced.stdout)).toMatch(/Overwrote/);
    expect(readFileSync(path, "utf8")).not.toContain("# my edits");
  });

  it("outside a git repository → usage error (exit 3), no file written", async () => {
    const dir = await makeTempDir("acr-nogit-");
    try {
      const res = await runCli(["init"], { cwd: dir, env: sb.env() });
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/not inside a git repository/);
      expect(existsSync(`${dir}/.acr.yml`)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an invalid .acr.yml gives a readable config error (exit 3)", async () => {
    await sb.repo.write({ ".acr.yml": "failOn: sometimes\nmaxFiles: -1\nbogus: 1\n" });
    await sb.repo.writeAndStage({ "a.ts": "export const a = 1;\n" });
    const res = await sb.acr(["review", "--no-ai"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/\.acr\.yml: /);
    expect(res.stderr).toMatch(/failOn must be one of/);
    expect(res.stderr).toMatch(/unknown option "bogus"/);
  });
});

describe("acr doctor", () => {
  it("fake server up and model present → all green, exit 0", async () => {
    await sb.configure(fake);
    const res = await sb.acr(["doctor"]);
    const out = stripAnsi(res.stdout);
    expect(res.code, out).toBe(0);
    expect(out).toMatch(/git version/);
    expect(out).toMatch(/repository: /);
    expect(out).toMatch(/config is valid/);
    expect(out).toMatch(/provider openai-compatible · model fake · http:\/\/127\.0\.0\.1:\d+\/v1/);
    expect(out).toMatch(/provider reachable, model available/);
    expect(out).toMatch(/pre-commit hook not installed/);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
  });

  it("server down → non-zero with an actionable message", async () => {
    const port = await closedPort();
    await sb.configure(null, {
      provider: { preset: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", maxRetries: 0 },
    });
    const res = await sb.acr(["doctor"]);
    const out = stripAnsi(res.stdout);
    expect(res.code).not.toBe(0);
    expect(out).toMatch(/✖ provider: Cannot reach openai-compatible at http:\/\/127\.0\.0\.1:\d+\/v1/);
    expect(out).toMatch(/check your network connection and provider\.baseUrl/);
  });

  it("model not served → non-zero, names the model", async () => {
    await sb.configure(fake, { provider: { model: "nope" } });
    const res = await sb.acr(["doctor"]);
    expect(res.code).not.toBe(0);
    expect(stripAnsi(res.stdout)).toMatch(/Model "nope" is not available/);
  });

  it("ollama preset via OLLAMA_HOST: missing model → `ollama pull` hint", async () => {
    await sb.configure(null, { provider: { preset: "ollama", model: "qwen-missing" } });
    const res = await sb.acr(["doctor"], { OLLAMA_HOST: fake.origin });
    const out = stripAnsi(res.stdout);
    expect(res.code).not.toBe(0);
    expect(out).toMatch(/from OLLAMA_HOST=http:\/\/127\.0\.0\.1:\d+/);
    expect(out).toMatch(/ollama pull qwen-missing/);
  });

  it("ollama preset via OLLAMA_HOST with the model present → exit 0", async () => {
    await sb.configure(null, { provider: { preset: "ollama", model: "fake" } });
    const res = await sb.acr(["doctor"], { OLLAMA_HOST: fake.origin });
    expect(res.code, stripAnsi(res.stdout)).toBe(0);
  });

  it("a hosted preset without its API key → non-zero, names the env var", async () => {
    await sb.configure(null, { provider: { preset: "groq" } });
    const res = await sb.acr(["doctor"]);
    const out = stripAnsi(res.stdout);
    expect(res.code).not.toBe(0);
    expect(out).toMatch(/GROQ_API_KEY: not set/);
  });

  it("does not read the developer's real config: XDG_CONFIG_HOME is honoured", async () => {
    const env = acrEnv(sb.home);
    expect(env.XDG_CONFIG_HOME?.startsWith(sb.home)).toBe(true);
    await sb.repo.write({}); // no repo config at all
    const res = await sb.acr(["doctor"]);
    expect(stripAnsi(res.stdout)).toMatch(/built-in defaults/);
  });
});
