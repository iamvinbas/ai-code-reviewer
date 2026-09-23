import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Sandbox } from "../helpers/cli.js";
import { FakeLLM, filesInPrompt, issuesReply } from "../helpers/fake-llm.js";

let fake: FakeLLM;
let sb: Sandbox;

/** Handler: one warning at line 1 of every file shown in the prompt. */
function issuePerFile(): void {
  fake.onChat((_req, messages) =>
    issuesReply(filesInPrompt(messages).map((file) => ({ severity: "warning", file, line: 1, title: `issue in ${file}` }))),
  );
}

const promptedFiles = (): string[] => fake.chatRequests.flatMap((r) => filesInPrompt(r.body.messages)).sort();

beforeAll(async () => {
  fake = await FakeLLM.start();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  sb = await Sandbox.create();
  await sb.repo.commit({ "README.md": "# demo\n", "src/base.ts": "export const base = 1;\n" }, "init");
  await sb.configure(fake);
  issuePerFile();
});
afterEach(async () => {
  await sb.cleanup();
});

describe("diff targets", () => {
  it("--staged (default) only sees the index, --working sees index + worktree", async () => {
    await sb.repo.writeAndStage({ "src/staged.ts": "export const s = 1;\n" });
    await sb.repo.write({ "src/base.ts": "export const base = 2;\n" }); // unstaged edit

    const staged = await sb.reviewJson();
    expect(staged.json.target).toEqual({ kind: "staged" });
    expect(promptedFiles()).toEqual(["src/staged.ts"]);

    fake.requests.length = 0;
    const working = await sb.reviewJson(["--working"]);
    expect(working.json.target).toEqual({ kind: "working" });
    expect(promptedFiles()).toEqual(["src/base.ts", "src/staged.ts"]);
    expect(working.json.issues.map((i) => i.file).sort()).toEqual(["src/base.ts", "src/staged.ts"]);
  });

  it("--commit <sha> reviews exactly that commit", async () => {
    const first = await sb.repo.commit({ "src/one.ts": "export const one = 1;\n" }, "one");
    await sb.repo.commit({ "src/two.ts": "export const two = 2;\n" }, "two");
    const res = await sb.reviewJson(["--commit", first]);
    expect(res.json.target).toEqual({ kind: "commit", sha: first });
    expect(promptedFiles()).toEqual(["src/one.ts"]);
    expect(res.json.issues.map((i) => i.file)).toEqual(["src/one.ts"]);

    fake.requests.length = 0;
    const byRef = await sb.reviewJson(["--commit", "HEAD", "--no-cache"]);
    expect(byRef.json.issues.map((i) => i.file)).toEqual(["src/two.ts"]);
  });

  it("--commit on an unknown ref → usage error, exit 3", async () => {
    const res = await sb.acr(["review", "--commit", "deadbeefdeadbeef"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/^acr: /);
  });

  it("--range main on a feature branch reviews only the branch's changes (merge-base)", async () => {
    await sb.repo.branch("feature");
    await sb.repo.commit({ "src/feature.ts": "export const feature = 1;\n" }, "feature work");
    await sb.repo.checkout("main");
    await sb.repo.commit({ "src/main-only.ts": "export const later = 1;\n" }, "main moves on");
    await sb.repo.checkout("feature");

    const res = await sb.reviewJson(["--range", "main"]);
    expect(res.json.target).toEqual({ kind: "range", base: "main" });
    expect(promptedFiles()).toEqual(["src/feature.ts"]);
    expect(res.json.issues.map((i) => i.file)).toEqual(["src/feature.ts"]);

    // `--range` without a base falls back to the default branch (main here: no remote).
    fake.requests.length = 0;
    const dflt = await sb.reviewJson(["--range", "--no-cache"]);
    expect(dflt.json.target).toEqual({ kind: "range", base: "main" });
    expect(promptedFiles()).toEqual(["src/feature.ts"]);

    // base..head syntax
    fake.requests.length = 0;
    const explicit = await sb.reviewJson(["--range", "main..feature", "--no-cache"]);
    expect(explicit.json.target).toEqual({ kind: "range", base: "main", head: "feature" });
    expect(promptedFiles()).toEqual(["src/feature.ts"]);
  });

  it("conflicting target flags → usage error, exit 3", async () => {
    const res = await sb.acr(["review", "--working", "--commit", "HEAD"]);
    expect(res.code).toBe(3);
  });
});

describe("filters", () => {
  it("include/exclude from .acr.yml apply to both AI and checks; lockfiles skipped by default", async () => {
    await sb.configure(fake, { include: ["src/**", "lib/**"], exclude: ["**/*.gen.ts"] });
    await sb.repo.writeAndStage({
      "src/app.ts": "export const app = 1;\n",
      "src/api.gen.ts": "debugger;\n",
      "docs/notes.ts": "debugger;\n",
      "lib/package-lock.json": '{ "lockfileVersion": 3 }\n',
      "package-lock.json": '{ "lockfileVersion": 3 }\n',
    });
    const res = await sb.reviewJson();
    expect(promptedFiles()).toEqual(["src/app.ts"]);
    expect(res.json.issues.map((i) => i.file)).toEqual(["src/app.ts"]);
    expect(res.json.stats).toMatchObject({ filesInDiff: 5, filesReviewed: 1, filesSkipped: 4 });
  });

  it("default config skips package-lock.json and friends", async () => {
    await sb.repo.writeAndStage({
      "package-lock.json": '{ "lockfileVersion": 3 }\n',
      "yarn.lock": "# yarn\n",
      "dist/bundle.min.js": "debugger;\n",
      "src/index.ts": "export {};\n",
    });
    await sb.reviewJson();
    expect(promptedFiles()).toEqual(["src/index.ts"]);
  });

  it("maxFiles caps how many files go to the AI", async () => {
    await sb.configure(fake, { maxFiles: 2 });
    await sb.repo.writeAndStage(
      Object.fromEntries(["a", "b", "c", "d"].map((n) => [`src/${n}.ts`, `export const ${n} = 1;\n`])),
    );
    const res = await sb.reviewJson();
    expect(promptedFiles()).toHaveLength(2);
    expect(res.json.stats).toMatchObject({ filesInDiff: 4, filesReviewed: 2, filesSkipped: 2 });
  });

  it("deleted files are not reviewed", async () => {
    await sb.repo.git("rm", "-q", "src/base.ts");
    await sb.repo.writeAndStage({ "src/new.ts": "export const n = 1;\n" });
    await sb.reviewJson();
    expect(promptedFiles()).toEqual(["src/new.ts"]);
  });
});

describe("chunking", () => {
  it("splits many files over several requests and merges every issue", async () => {
    await sb.configure(fake, { maxChunkTokens: 500, contextLines: 0 });
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      files[`src/mod${String(i).padStart(2, "0")}.ts`] =
        Array.from({ length: 6 }, (_, j) => `export const value${i}_${j} = computeSomething(${i}, ${j});`).join("\n") + "\n";
    }
    await sb.repo.writeAndStage(files);
    const res = await sb.reviewJson();

    expect(fake.chatRequests.length).toBeGreaterThan(1);
    expect(res.json.stats.chunks).toBe(fake.chatRequests.length);
    expect(res.json.complete).toBe(true);
    // Every file sent exactly once, and every file's issue survives the merge.
    expect(promptedFiles()).toEqual(Object.keys(files).sort());
    expect(res.json.issues.map((i) => i.file).sort()).toEqual(Object.keys(files).sort());
    // Each response only mentions files from its own chunk; nothing leaks across chunks.
    for (const r of fake.chatRequests) expect(filesInPrompt(r.body.messages).length).toBeGreaterThan(0);
  });

  it("a failing chunk marks the review incomplete but keeps the other chunks' issues", async () => {
    await sb.configure(fake, { maxChunkTokens: 500, contextLines: 0 });
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      files[`src/m${i}.ts`] = Array.from({ length: 6 }, (_, j) => `export const v${i}_${j} = compute(${i}, ${j});`).join("\n") + "\n";
    }
    await sb.repo.writeAndStage(files);
    let n = 0;
    fake.onChat((_req, messages) => {
      n++;
      if (n === 1) return { status: 500 };
      return issuesReply(filesInPrompt(messages).map((file) => ({ severity: "warning", file, line: 1, title: `issue in ${file}` })));
    });
    const res = await sb.reviewJson();
    expect(res.json.stats.chunks).toBeGreaterThan(1);
    expect(res.json.complete).toBe(false);
    expect(res.json.errors.some((e) => /HTTP 500/.test(e.message))).toBe(true);
    expect(res.json.issues.length).toBeGreaterThan(0);
    expect(res.json.issues.length).toBeLessThan(8);
  });
});

describe("cache", () => {
  it("a second identical run makes zero LLM requests; --no-cache asks again", async () => {
    await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    const first = await sb.reviewJson();
    const firstCalls = fake.chatRequests.length;
    expect(firstCalls).toBeGreaterThan(0);
    expect(first.json.stats.cacheHits).toBe(0);
    expect(existsSync(sb.cacheDir)).toBe(true);
    expect(readdirSync(sb.cacheDir).filter((f) => f.endsWith(".json")).length).toBe(first.json.stats.chunks);

    fake.requests.length = 0;
    const second = await sb.reviewJson();
    expect(fake.chatRequests).toHaveLength(0);
    expect(second.json.stats.cacheHits).toBe(second.json.stats.chunks);
    expect(second.json.issues).toEqual(first.json.issues);

    const noCache = await sb.reviewJson(["--no-cache"]);
    expect(fake.chatRequests).toHaveLength(firstCalls);
    expect(noCache.json.stats.cacheHits).toBe(0);
  });

  it("a failed chunk is not cached (the next run asks again)", async () => {
    await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\n" });
    fake.onChat(() => "not json");
    const bad = await sb.reviewJson();
    expect(bad.json.complete).toBe(false);
    issuePerFile();
    fake.requests.length = 0;
    const good = await sb.reviewJson();
    expect(fake.chatRequests).toHaveLength(1);
    expect(good.json.complete).toBe(true);
  });

  it("changing rules or the model invalidates the cache", async () => {
    await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\n" });
    await sb.reviewJson();
    fake.requests.length = 0;
    await sb.configure(fake, { rules: ["No magic numbers"] });
    await sb.reviewJson();
    expect(fake.chatRequests).toHaveLength(1);
  });

  it("cache.enabled: false in config disables it", async () => {
    await sb.configure(fake, { cache: { enabled: false } });
    await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\n" });
    await sb.reviewJson();
    await sb.reviewJson();
    expect(fake.chatRequests).toHaveLength(2);
    expect(existsSync(sb.cacheDir)).toBe(false);
  });
});

describe("acr ignore", () => {
  it("ignoring an AI issue and a check issue removes them from the next run", async () => {
    await sb.repo.writeAndStage({ "src/a.ts": "export const a = 1;\ndebugger;\n" });
    const before = await sb.reviewJson(["--fail-on", "warning"]);
    expect(before.code).toBe(1);
    const ai = before.json.issues.find((i) => i.source === "ai");
    const check = before.json.issues.find((i) => i.ruleId === "debug-statements/debugger");
    expect(ai && check).toBeTruthy();

    const ign = await sb.acr(["ignore", `[${ai!.id}]`, check!.id]);
    expect(ign.code).toBe(0);
    expect(ign.stdout).toContain(ai!.id);
    const file = readFileSync(sb.repo.path(".acr/ignore"), "utf8");
    expect(file).toContain(ai!.id);
    expect(file).toContain(check!.id);

    const after = await sb.reviewJson(["--fail-on", "warning"]);
    expect(after.json.issues).toEqual([]);
    expect(after.code).toBe(0);

    const again = await sb.acr(["ignore", ai!.id]);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/Already ignored/);
  });

  it("ids survive the code moving to another line", async () => {
    await sb.repo.writeAndStage({ "src/a.ts": "debugger;\n" });
    const before = await sb.reviewJson(["--no-ai"]);
    const id = before.json.issues[0]!.id;
    await sb.acr(["ignore", id]);
    await sb.repo.writeAndStage({ "src/a.ts": "// moved\n\ndebugger;\n" });
    const after = await sb.reviewJson(["--no-ai"]);
    expect(after.json.issues).toEqual([]);
  });

  it("rejects ids that could corrupt the ignore file (exit 3)", async () => {
    const res = await sb.acr(["ignore", "abc def\nxyz"]);
    expect(res.code).toBe(3);
    expect(res.stderr).toMatch(/invalid issue id/);
    expect(existsSync(sb.repo.path(".acr/ignore"))).toBe(false);
  });
});
