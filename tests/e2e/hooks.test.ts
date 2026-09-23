/*
 * Real `git commit` through an installed pre-commit hook. The hook calls `npx --no-install acr`
 * or a global `acr`; a shim bin dir on PATH provides `acr` (this checkout via tsx) and an `npx`
 * that always fails, so the hook deterministically takes the global-`acr` branch.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeShimBin, Sandbox, stripAnsi } from "../helpers/cli.js";
import { closedPort, FakeLLM, issuesReply } from "../helpers/fake-llm.js";

const AWS_KEY = ["AK", "IA", "H3J5", "K7L9", "M2N4", "P6Q8"].join("");

let fake: FakeLLM;
let sb: Sandbox;
let bin: string;

beforeAll(async () => {
  fake = await FakeLLM.start();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  sb = await Sandbox.create();
  bin = await makeShimBin(sb.home);
  await sb.repo.commit({ "README.md": "# demo\n" }, "init");
});
afterEach(async () => {
  await sb.cleanup();
});

const hookEnv = () => sb.env({ PATH: `${bin}:${process.env.PATH ?? ""}` });
const commit = (msg: string, ...extra: string[]) => sb.repo.gitRaw(["commit", "-m", msg, ...extra], hookEnv());
const head = () => sb.repo.git("rev-parse", "HEAD");

describe("acr hook install/uninstall", () => {
  it("installs an executable, idempotent, marked block and keeps existing hook content", async () => {
    const hookPath = sb.repo.path(".git/hooks/pre-commit");
    await sb.repo.write({ ".git/hooks/pre-commit": "#!/bin/sh\necho custom-hook\n" });

    const res = await sb.acr(["hook", "install", "pre-commit"]);
    expect(res.code).toBe(0);
    expect(stripAnsi(res.stdout)).toMatch(/Updated pre-commit hook/);
    const text = readFileSync(hookPath, "utf8");
    expect(text).toContain("echo custom-hook");
    expect(text).toContain("# >>> acr >>>");
    expect(text).toContain("acr review --staged --hook");
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);

    const again = await sb.acr(["hook", "install"]);
    expect(stripAnsi(again.stdout)).toMatch(/Already up to date/);
    expect(readFileSync(hookPath, "utf8")).toBe(text);

    const doctor = await sb.acr(["doctor"]);
    expect(stripAnsi(doctor.stdout)).toMatch(/pre-commit hook installed/);

    const un = await sb.acr(["hook", "uninstall", "pre-commit"]);
    expect(un.code).toBe(0);
    const after = readFileSync(hookPath, "utf8");
    expect(after).toContain("echo custom-hook");
    expect(after).not.toContain(">>> acr >>>");
  });

  it("pre-push hook reviews the range; uninstall of a pure acr hook deletes the file", async () => {
    const res = await sb.acr(["hook", "install", "pre-push"]);
    expect(res.code).toBe(0);
    const path = sb.repo.path(".git/hooks/pre-push");
    expect(readFileSync(path, "utf8")).toContain("acr review --range --hook");
    await sb.acr(["hook", "uninstall"]);
    expect(existsSync(path)).toBe(false);
  });

  it("honours core.hooksPath", async () => {
    await sb.repo.git("config", "core.hooksPath", ".githooks");
    const res = await sb.acr(["hook", "install"]);
    expect(res.code).toBe(0);
    expect(existsSync(sb.repo.path(".githooks/pre-commit"))).toBe(true);
    expect(existsSync(sb.repo.path(".git/hooks/pre-commit"))).toBe(false);
  });
});

describe("real git commit through the pre-commit hook", () => {
  it("blocks a staged secret, lets clean code through, and --no-verify bypasses", async () => {
    await sb.configure(fake);
    fake.onChat(() => issuesReply([]));
    expect((await sb.acr(["hook", "install", "pre-commit"])).code).toBe(0);
    const start = await head();

    // 1. Secret → blocked.
    await sb.repo.writeAndStage({ "src/aws.ts": `export const key = "${AWS_KEY}";\n` });
    const blocked = await commit("add key");
    expect(blocked.code, blocked.stderr).not.toBe(0);
    const out = stripAnsi(blocked.stdout + blocked.stderr);
    expect(out).toMatch(/secrets\/aws-access-key|Hardcoded AWS access key/);
    expect(out).toMatch(/commit blocked/);
    expect(out).toMatch(/--no-verify/);
    expect(out).not.toContain(AWS_KEY);
    expect(await head()).toBe(start);
    expect(fake.requests.some((r) => r.path === "/v1/models")).toBe(true); // hook mode pings first

    // 2. --no-verify bypasses the hook entirely (no acr run → no request).
    fake.requests.length = 0;
    const bypass = await commit("add key anyway", "--no-verify");
    expect(bypass.code, bypass.stderr).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(await head()).not.toBe(start);

    // 3. Clean code → commit succeeds, the AI was consulted.
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    const before = await head();
    const clean = await commit("clean change");
    expect(clean.code, clean.stderr).toBe(0);
    expect(await head()).not.toBe(before);
    expect(fake.chatRequests.length).toBeGreaterThan(0);
  });

  it("`git commit -a` (temporary index) is reviewed too: an unstaged secret in a tracked file is blocked", async () => {
    await sb.configure(null, { ai: { enabled: false } });
    await sb.repo.commit({ "src/cfg.ts": "export const x = 1;\n" }, "tracked");
    await sb.acr(["hook", "install"]);
    await sb.repo.write({ "src/cfg.ts": `export const x = 1;\nexport const key = "${AWS_KEY}";\n` }); // not staged
    const before = await head();
    const res = await commit("commit -a", "-a");
    expect(res.code).not.toBe(0);
    expect(stripAnsi(res.stderr + res.stdout)).toMatch(/commit blocked/);
    expect(await head()).toBe(before);

    // Partial commit of another path (`git commit -- path`) must not be blocked by the unstaged secret.
    await sb.repo.write({ "src/other.ts": "export const y = 2;\n" });
    await sb.repo.git("add", "-N", "src/other.ts");
    const partial = await sb.repo.gitRaw(["commit", "-m", "partial", "--", "src/other.ts"], hookEnv());
    expect(partial.code, partial.stderr).toBe(0);
  });

  it("works in a linked worktree", async () => {
    await sb.configure(null, { ai: { enabled: false } });
    await sb.repo.git("add", ".acr.yml");
    await sb.repo.git("commit", "-q", "--no-verify", "-m", "cfg");
    await sb.acr(["hook", "install"]);
    const wt = `${sb.home}/wt`;
    await sb.repo.git("worktree", "add", "-q", "-b", "wt-branch", wt);
    await writeFile(`${wt}/leak.ts`, `export const key = "${AWS_KEY}";\n`);
    const add = await sb.repo.gitRaw(["-C", wt, "add", "leak.ts"]);
    expect(add.code).toBe(0);
    const res = await sb.repo.gitRaw(["-C", wt, "commit", "-m", "leak"], hookEnv());
    expect(res.code).not.toBe(0);
    expect(stripAnsi(res.stderr + res.stdout)).toMatch(/commit blocked/);
  });

  it("an unreachable provider does not block a clean commit (onError: warn)", async () => {
    const port = await closedPort();
    await sb.configure(null, {
      provider: { preset: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", maxRetries: 0 },
    });
    await sb.acr(["hook", "install"]);
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    const before = await head();
    const res = await commit("clean, provider down");
    expect(res.code, res.stderr).toBe(0);
    expect(stripAnsi(res.stderr)).toMatch(/review incomplete, continuing/);
    expect(await head()).not.toBe(before);
  });

  it("without acr installed anywhere the hook skips with a notice instead of failing", async () => {
    await sb.acr(["hook", "install"]);
    await sb.repo.writeAndStage({ "src/ok.ts": "export const ok = 1;\n" });
    // PATH without the acr shim, but still with the failing npx shim first.
    const npxOnly = `${sb.home}/npx-only`;
    await mkdir(npxOnly, { recursive: true });
    await writeFile(`${npxOnly}/npx`, "#!/bin/sh\nexit 1\n");
    await chmod(`${npxOnly}/npx`, 0o755);
    const res = await sb.repo.gitRaw(["commit", "-m", "no acr"], sb.env({ PATH: `${npxOnly}:/usr/bin:/bin` }));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toMatch(/acr: not installed, skipping review/);
  });
});
