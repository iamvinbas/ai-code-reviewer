import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLMError, type ChatMessage, type Issue, type ProgressEvent } from "../types.js";
import { fingerprint, PROMPT_VERSION, runReview } from "./index.js";
import { addedFile, fakeGit, fakeProvider, makeFile, testConfig } from "./testing.js";

const reply = (issues: unknown[]): string => JSON.stringify({ issues });

const aiIssue = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  severity: "warning",
  file: "src/app.ts",
  line: 2,
  category: "bug",
  title: "Possible null dereference",
  message: "user may be undefined",
  suggestion: "check it first",
  ...over,
});

const app = makeFile("src/app.ts", [
  { oldStart: 1, newStart: 1, lines: [" const user = find(id);", "+const name = user.name;", "+save(name);", " done();"] },
  { oldStart: 40, newStart: 41, lines: [" a();", "+b();", " c();"] },
]);

const userMessages = (calls: Array<{ messages: ChatMessage[] }>): string[] =>
  calls.map((c) => c.messages.find((m) => m.role === "user")?.content ?? "");

describe("runReview", () => {
  it("happy path: reviews, validates and reports stats/progress", async () => {
    const provider = fakeProvider([reply([aiIssue()])]);
    const events: ProgressEvent[] = [];
    const result = await runReview({
      config: testConfig(),
      target: { kind: "staged" },
      git: fakeGit([app]),
      provider,
      onProgress: (e) => events.push(e),
    });
    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.issues).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{12}$/),
        source: "ai",
        ruleId: "bug",
        severity: "warning",
        file: "src/app.ts",
        line: 2,
        title: "Possible null dereference",
        message: "user may be undefined",
        suggestion: "check it first",
      },
    ]);
    expect(result.stats).toMatchObject({
      filesInDiff: 1,
      filesReviewed: 1,
      filesSkipped: 0,
      chunks: 1,
      cacheHits: 0,
      provider: "fake",
      model: "fake-model",
    });
    expect(events.map((e) => e.type)).toEqual(["diff", "checks:done", "chunk:start", "chunk:done"]);
    expect(provider.calls[0]?.opts).toMatchObject({ json: true, temperature: 0 });
    expect(userMessages(provider.calls)[0]).toContain("    2 + const name = user.name;");
  });

  it("builds a hardened prompt with rules and language", async () => {
    const provider = fakeProvider([reply([])]);
    await runReview({
      config: testConfig({ rules: ["Use the logger, never console", "No default exports"], language: "it" }),
      target: { kind: "staged" },
      git: fakeGit([app]),
      provider,
    });
    const system = provider.calls[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("- Use the logger, never console\n- No default exports");
    expect(system?.content).toMatch(/- LANGUAGE: write "title", "message" and "suggestion" in Italian \(italiano\)/);
    expect(system?.content.trimEnd().split("\n").at(-1)).toMatch(/^- LANGUAGE:/);
    expect(system?.content).not.toContain('"suggestion" in English');
    expect(system?.content).toContain("UNTRUSTED DATA");
    expect(system?.content).toContain('{"issues":[]}');
    const user = userMessages(provider.calls)[0] ?? "";
    expect(user).toMatch(/===== BEGIN DIFF [0-9a-f]{8} =====\n### src\/app.ts/);
    expect(user).toMatch(/===== END DIFF [0-9a-f]{8} =====/);
    expect(user.trimEnd().split("\n").at(-1)).toBe(
      "Rispondi in italiano: scrivi title, message e suggestion in italiano (le chiavi JSON e i valori di severity e category restano in inglese).",
    );
  });

  it("adds no language reminder for English", async () => {
    const provider = fakeProvider([reply([])]);
    await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit([app]), provider });
    const system = provider.calls[0]?.messages[0]?.content ?? "";
    expect(system.trimEnd().split("\n").at(-1)).toBe('- Write "title", "message" and "suggestion" in English.');
    expect(userMessages(provider.calls)[0]?.trimEnd().split("\n").at(-1)).toBe("Respond now with the JSON object only.");
  });

  it("repeats the language reminder in the correction retry", async () => {
    const provider = fakeProvider(["not json", reply([])]);
    await runReview({ config: testConfig({ language: "it" }), target: { kind: "staged" }, git: fakeGit([app]), provider });
    expect(provider.calls[1]?.messages.at(-1)?.content).toMatch(/Rispondi in italiano/);
  });

  it("retries once on invalid JSON and succeeds", async () => {
    const provider = fakeProvider(["I think the code is fine!", reply([aiIssue()])]);
    const result = await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit([app]), provider });
    expect(provider.calls).toHaveLength(2);
    const retry = provider.calls[1]?.messages ?? [];
    expect(retry.at(-2)).toEqual({ role: "assistant", content: "I think the code is fine!" });
    expect(retry.at(-1)?.content).toMatch(/could not be used/);
    expect(result.complete).toBe(true);
    expect(result.issues).toHaveLength(1);
  });

  it("records a parse error per chunk file when the retry fails too", async () => {
    const other = addedFile("src/b.ts", ["export const b = 1;"]);
    const provider = fakeProvider(["nope", '{"issues": "none"}']);
    const events: ProgressEvent[] = [];
    const result = await runReview({
      config: testConfig(),
      target: { kind: "staged" },
      git: fakeGit([app, other]),
      provider,
      onProgress: (e) => events.push(e),
    });
    expect(provider.calls).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(result.errors.map((e) => [e.stage, e.file])).toEqual([
      ["parse", "src/app.ts"],
      ["parse", "src/b.ts"],
    ]);
    expect(events.some((e) => e.type === "chunk:error")).toBe(true);
  });

  it("keeps valid issues and reports malformed ones after retry", async () => {
    const bad = reply([aiIssue(), { severity: "urgent", title: "x" }]);
    const provider = fakeProvider([bad, bad]);
    const result = await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit([app]), provider });
    expect(result.issues).toHaveLength(1);
    expect(result.errors).toEqual([expect.objectContaining({ stage: "parse", message: expect.stringContaining("1 malformed") })]);
  });

  it("aborts remaining chunks when the provider is unreachable", async () => {
    const files = ["a", "b", "c"].map((n) => addedFile(`src/${n}.ts`, [`export const ${n} = "${n.repeat(900)}";`]));
    const provider = fakeProvider([new LLMError("unreachable", "Ollama is not reachable on localhost:11434")]);
    const result = await runReview({
      config: testConfig({ maxChunkTokens: 1200 }),
      target: { kind: "staged" },
      git: fakeGit(files),
      provider,
    });
    expect(result.stats.chunks).toBe(3);
    expect(provider.calls).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.errors).toEqual([
      { stage: "llm", file: "src/a.ts", message: "Ollama is not reachable on localhost:11434" },
      { stage: "llm", message: "2 remaining chunk(s) skipped after this error; not reviewed: src/b.ts, src/c.ts" },
    ]);
  });

  it.each(["auth", "config"] as const)("aborts remaining chunks on %s errors", async (code) => {
    const files = ["a", "b"].map((n) => addedFile(`src/${n}.ts`, [`export const ${n} = "${n.repeat(900)}";`]));
    const provider = fakeProvider([new LLMError(code, "bad setup"), reply([])]);
    const result = await runReview({
      config: testConfig({ maxChunkTokens: 1200 }),
      target: { kind: "staged" },
      git: fakeGit(files),
      provider,
    });
    expect(provider.calls).toHaveLength(1);
    expect(result.errors).toEqual([
      { stage: "llm", file: "src/a.ts", message: "bad setup" },
      { stage: "llm", message: "1 remaining chunk(s) skipped after this error; not reviewed: src/b.ts" },
    ]);
  });

  it("attributes a chunk-level LLM error to every file in the chunk", async () => {
    const files = [addedFile("src/a.ts", ["a();"]), addedFile("src/b.ts", ["b();"])];
    const provider = fakeProvider([new LLMError("server", "HTTP 500")]);
    const result = await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit(files), provider });
    expect(result.stats.chunks).toBe(1);
    expect(result.errors).toEqual([
      { stage: "llm", file: "src/a.ts", message: "HTTP 500" },
      { stage: "llm", file: "src/b.ts", message: "HTTP 500" },
    ]);
  });

  it("drops an AI issue that duplicates a check on the same line", async () => {
    const token = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const file = addedFile("src/cfg.ts", [`const token = "${token}";`, "run(token);"]);
    const provider = fakeProvider([
      reply([
        aiIssue({ file: "src/cfg.ts", line: 1, severity: "critical", category: "security", title: "Hardcoded Credentials" }),
        aiIssue({ file: "src/cfg.ts", line: 1, title: "Unused variable shadowing" }),
      ]),
    ]);
    const result = await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit([file]), provider });
    expect(result.issues.map((i) => [i.source, i.ruleId, i.title])).toEqual([
      ["check", "secrets/github-token", "Hardcoded GitHub token"],
      ["ai", "bug", "Unused variable shadowing"],
    ]);
  });

  it("continues after a non-fatal LLM error", async () => {
    const files = ["a", "b"].map((n) => addedFile(`src/${n}.ts`, [`export const ${n} = "${n.repeat(900)}";`]));
    const provider = fakeProvider([new LLMError("rate_limit", "rate limited"), reply([])]);
    const result = await runReview({
      config: testConfig({ maxChunkTokens: 1200 }),
      target: { kind: "staged" },
      git: fakeGit(files),
      provider,
    });
    expect(provider.calls).toHaveLength(2);
    expect(result.errors).toEqual([{ stage: "llm", file: "src/a.ts", message: "rate limited" }]);
    expect(result.complete).toBe(false);
  });

  it("snaps invalid lines to a nearby added line, else null; drops foreign files and bad fixes", async () => {
    const provider = fakeProvider([
      reply([
        aiIssue({ title: "exact", line: 1 }),
        aiIssue({ title: "snap", line: 44, endLine: 99 }),
        aiIssue({ title: "far", line: 20 }),
        aiIssue({ title: "foreign", file: "src/other.ts" }),
        aiIssue({ title: "prefixed path", file: "./src/app.ts", line: 3, fix: { startLine: 2, endLine: 3, replacement: "x" } }),
        aiIssue({ title: "bad fix", line: 3, fix: { startLine: 3, endLine: 4, replacement: "y" } }),
      ]),
    ]);
    const result = await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit([app]), provider });
    const byTitle = new Map(result.issues.map((i) => [i.title, i]));
    expect(byTitle.get("exact")?.line).toBe(1);
    expect(byTitle.get("snap")?.line).toBe(42);
    expect(byTitle.get("snap")?.endLine).toBeUndefined();
    expect(byTitle.get("far")?.line).toBeNull();
    expect(byTitle.has("foreign")).toBe(false);
    expect(byTitle.get("prefixed path")?.fix).toEqual({ startLine: 2, endLine: 3, replacement: "x" });
    expect(byTitle.get("bad fix")?.fix).toBeUndefined();
  });

  it("dedupes, applies ignore, and sorts by severity/file/line", async () => {
    const ts = addedFile("src/z.ts", ["debugger;", "console.log(1);"]);
    const dup = aiIssue({ file: "src/z.ts", line: 2, title: "Same thing" });
    const provider = fakeProvider([
      reply([dup, { ...dup, severity: "critical" }, aiIssue({ file: "src/z.ts", line: 1, title: "Other", severity: "suggestion" })]),
    ]);
    const first = await runReview({ config: testConfig(), target: { kind: "staged" }, git: fakeGit([ts]), provider });
    expect(first.issues.map((i) => [i.severity, i.title])).toEqual([
      ["critical", "Same thing"],
      ["warning", "Leftover `debugger` statement"],
      ["suggestion", "Other"],
      ["suggestion", "Leftover `console.log` call"],
    ]);

    const ignored = (first.issues[0] as Issue).id;
    const second = await runReview({
      config: testConfig({ ignore: [ignored] }),
      target: { kind: "staged" },
      git: fakeGit([ts]),
      provider,
    });
    expect(second.issues.map((i) => i.id)).not.toContain(ignored);
    expect(second.issues).toHaveLength(3);
  });

  it("filters deleted, binary, default-skipped and excluded files; caps maxFiles", async () => {
    const files = [
      makeFile("gone.ts", [{ newStart: 0, oldStart: 1, lines: ["-x"] }], { status: "deleted" }),
      { ...makeFile("tool.jar", [], { status: "added" }), binary: true },
      addedFile("package-lock.json", ['{"a": 1}']),
      addedFile("dist/out.js", ["console.log(1)"]),
      addedFile("src/skip.gen.ts", ["console.log(1)"]),
      addedFile("src/one.ts", ["one();"]),
      addedFile("src/two.ts", ["two();"]),
      addedFile(".github/workflows/ci.yml", ["on: push"]),
    ];
    const provider = fakeProvider([reply([])]);
    const result = await runReview({
      config: testConfig({ exclude: ["*.gen.ts"], maxFiles: 2 }),
      target: { kind: "staged" },
      git: fakeGit(files),
      provider,
    });
    const sent = userMessages(provider.calls).join("\n");
    expect(sent).toContain("### src/one.ts");
    expect(sent).toContain("### src/two.ts");
    expect(sent).not.toMatch(/ci\.yml|gone|jar|lock|dist|gen\.ts/);
    expect(result.issues.map((i) => [i.ruleId, i.file])).toEqual([["large-files/binary", "tool.jar"]]);
    expect(result.stats).toMatchObject({ filesInDiff: 8, filesReviewed: 2, filesSkipped: 5 });
    expect(result.complete).toBe(true);
  });

  it("runs offline checks on paths skipped for the AI by default, but not on user-excluded ones", async () => {
    const stripe = ["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");
    const files = [
      addedFile("build/deploy.sh", [`export STRIPE_KEY=${stripe}`]),
      addedFile("vendor/lib/x.js", [`const k = "${stripe}"; console.log(k);`]),
      addedFile("dist/app.min.js", ["<<<<<<< HEAD"]),
      addedFile("package-lock.json", Array.from({ length: 40 }, () => "x".repeat(40))),
      addedFile("secret/excluded.sh", [`export STRIPE_KEY=${stripe}`]),
      { ...makeFile("img/new.png", [], { status: "added" }), binary: true },
      { ...makeFile("build/app.zip", [], { status: "added" }), binary: true },
    ];
    const provider = fakeProvider([reply([])]);
    const result = await runReview({
      config: testConfig({
        exclude: ["secret/**"],
        checks: { secrets: true, conflictMarkers: true, debugStatements: true, largeFiles: { enabled: true, maxKb: 1 } },
      }),
      target: { kind: "staged" },
      git: fakeGit(files),
      provider,
    });
    expect(result.issues.map((i) => [i.file, i.ruleId])).toEqual([
      ["build/deploy.sh", "secrets/stripe-key"],
      ["dist/app.min.js", "conflict-markers"],
      ["vendor/lib/x.js", "secrets/stripe-key"],
      ["build/app.zip", "large-files/binary"],
    ]);
    expect(provider.calls).toHaveLength(0);
    expect(result.stats).toMatchObject({ filesReviewed: 0, filesSkipped: 7 });

    const offline = await runReview({ config: testConfig({ ai: { enabled: false } }), target: { kind: "staged" }, git: fakeGit(files), provider: null });
    expect(offline.stats).toMatchObject({ filesReviewed: 7, filesSkipped: 0 });
  });

  it("include restricts both checks and AI", async () => {
    const provider = fakeProvider([reply([])]);
    const result = await runReview({
      config: testConfig({ include: ["src/**"] }),
      target: { kind: "staged" },
      git: fakeGit([addedFile("scripts/x.js", ["debugger;"]), addedFile("src/y.js", ["debugger;"])]),
      provider,
    });
    expect(result.issues.map((i) => i.file)).toEqual(["src/y.js"]);
  });

  it("runs checks only when AI is disabled or there is no provider", async () => {
    const files = [addedFile("src/a.ts", ["debugger;"])];
    const provider = fakeProvider([reply([aiIssue()])]);
    for (const opts of [
      { config: testConfig({ ai: { enabled: false } }), provider },
      { config: testConfig(), provider: null },
    ]) {
      const result = await runReview({ ...opts, target: { kind: "staged" }, git: fakeGit(files) });
      expect(result.complete).toBe(true);
      expect(result.issues.map((i) => i.ruleId)).toEqual(["debug-statements/debugger"]);
      expect(result.stats).toMatchObject({ provider: null, model: null, chunks: 0, filesReviewed: 1 });
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("reports git failures as an incomplete review", async () => {
    const result = await runReview({
      config: testConfig(),
      target: { kind: "staged" },
      git: fakeGit(new Error("not a git repository")),
      provider: fakeProvider([reply([])]),
    });
    expect(result.complete).toBe(false);
    expect(result.errors).toEqual([{ stage: "git", message: "not a git repository" }]);
  });

  it("reads full content from the source matching the target", async () => {
    const contents = { "src/app.ts": Array.from({ length: 50 }, (_, i) => `l${i + 1}`).join("\n") };
    const cases = [
      [{ kind: "staged" }, "INDEX"],
      [{ kind: "working" }, "WORKTREE"],
      [{ kind: "range", base: "main" }, { ref: "HEAD" }],
      [{ kind: "range", base: "main", head: "feat" }, { ref: "feat" }],
      [{ kind: "commit", sha: "abc123" }, { ref: "abc123" }],
    ] as const;
    for (const [target, source] of cases) {
      const git = fakeGit([app], contents);
      const provider = fakeProvider([reply([])]);
      await runReview({ config: testConfig({ contextLines: 5 }), target, git, provider });
      expect(git.reads).toEqual([{ path: "src/app.ts", source }]);
      expect(userMessages(provider.calls)[0]).toContain("   46   l46");
    }
  });

  describe("cache", () => {
    let dir = "";
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it("serves the second identical run from disk", async () => {
      dir = await mkdtemp(join(tmpdir(), "acr-cache-"));
      const config = testConfig({ cache: { enabled: true, dir } });
      const provider = fakeProvider([reply([aiIssue()])]);
      const first = await runReview({ config, target: { kind: "staged" }, git: fakeGit([app]), provider });
      const events: ProgressEvent[] = [];
      const second = await runReview({
        config,
        target: { kind: "staged" },
        git: fakeGit([app]),
        provider,
        onProgress: (e) => events.push(e),
      });
      expect(provider.calls).toHaveLength(1);
      expect(second.stats.cacheHits).toBe(1);
      expect(second.issues).toEqual(first.issues);
      expect(events).toContainEqual({ type: "chunk:done", index: 0, total: 1, issues: 1, cached: true });
      expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);

      await runReview({ config: { ...config, rules: ["new rule"] }, target: { kind: "staged" }, git: fakeGit([app]), provider });
      expect(provider.calls).toHaveLength(2);
    });

    it("resolves a relative cache.dir against the repository root", async () => {
      dir = await mkdtemp(join(tmpdir(), "acr-root-"));
      const config = testConfig({ cache: { enabled: true, dir: ".acr/cache" } });
      await runReview({ config, target: { kind: "staged" }, git: fakeGit([app], {}, dir), provider: fakeProvider([reply([])]) });
      expect((await readdir(join(dir, ".acr/cache"))).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    });

    it("does not cache failed chunks", async () => {
      dir = await mkdtemp(join(tmpdir(), "acr-cache-"));
      const config = testConfig({ cache: { enabled: true, dir } });
      await runReview({ config, target: { kind: "staged" }, git: fakeGit([app]), provider: fakeProvider(["x", "y"]) });
      expect(await readdir(dir).catch(() => [])).toEqual([]);
    });
  });

  it("exposes a stable fingerprint without line numbers and a prompt version", () => {
    const base = { source: "ai" as const, severity: "warning" as const, file: "a.ts", title: "Null  deref!", message: "" };
    expect(fingerprint({ ...base, line: 1 }, "  x = 1 ")).toBe(fingerprint({ ...base, line: 9, title: "null deref" }, "x   =  1"));
    expect(fingerprint({ ...base, line: 1 }, "x = 1")).not.toBe(fingerprint({ ...base, line: 1 }, "x = 2"));
    expect(PROMPT_VERSION).toBe("2");
  });
});
