import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/index.js";
import { EXIT, type Config, type FailOn, type Issue, type ReviewResult, type Severity } from "../types.js";
import { exitCodeFor, formatJson, formatMarkdown, formatPretty } from "./index.js";

function issue(over: Partial<Issue> & Pick<Issue, "id" | "severity" | "file">): Issue {
  return {
    source: "ai",
    line: 1,
    title: "Title",
    message: "Message",
    ...over,
  };
}

function result(over: Partial<ReviewResult> = {}): ReviewResult {
  return {
    target: { kind: "staged" },
    issues: [],
    errors: [],
    complete: true,
    stats: {
      filesInDiff: 2,
      filesReviewed: 2,
      filesSkipped: 0,
      chunks: 1,
      cacheHits: 0,
      durationMs: 4200,
      provider: "ollama",
      model: "qwen2.5-coder:14b",
    },
    ...over,
  };
}

const ISSUES: Issue[] = [
  issue({
    id: "bbb222",
    severity: "warning",
    file: "src/b.ts",
    line: 30,
    title: "Unchecked null",
    message: "`user` can be null here.",
    suggestion: "Guard with an early return.",
  }),
  issue({
    id: "aaa111",
    source: "check",
    ruleId: "secrets/aws-access-key",
    severity: "critical",
    file: "src/a.ts",
    line: 12,
    title: "Hardcoded AWS key",
    message: "Committed secrets must be considered leaked.",
    fix: { startLine: 12, endLine: 12, replacement: "const key = process.env.AWS_KEY;" },
  }),
  issue({
    id: "ccc333",
    severity: "suggestion",
    file: "src/b.ts",
    line: null,
    title: "File is getting long",
    message: "Consider splitting it.",
  }),
];

describe("formatPretty", () => {
  it("renders a full report without colors", () => {
    const text = formatPretty(result({ issues: ISSUES }), { color: false });
    expect(text).toBe(
      [
        "acr staged changes · ollama · qwen2.5-coder:14b · 2 files · 4.2s",
        "",
        "src/a.ts",
        "  CRITICAL   src/a.ts:12  Hardcoded AWS key  [aaa111]",
        "             Committed secrets must be considered leaked.",
        "",
        "src/b.ts",
        "  SUGGESTION src/b.ts  File is getting long  [ccc333]",
        "             Consider splitting it.",
        "  WARNING    src/b.ts:30  Unchecked null  [bbb222]",
        "             `user` can be null here.",
        "             → Guard with an early return.",
        "",
        "✖ 3 issues: 1 critical · 1 warning · 1 suggestion",
      ].join("\n"),
    );
  });

  it("uses ANSI colors only when enabled", () => {
    expect(formatPretty(result({ issues: ISSUES }), { color: false })).not.toMatch(/\u001b\[/);
    expect(formatPretty(result({ issues: ISSUES }), { color: true })).toMatch(/\u001b\[/);
  });

  it("shows fixes and rule ids in verbose mode", () => {
    const text = formatPretty(result({ issues: ISSUES }), { color: false, verbose: true });
    expect(text).toContain("rule: secrets/aws-access-key (check)");
    expect(text).toContain("fix (line 12):");
    expect(text).toContain("+ const key = process.env.AWS_KEY;");
    expect(formatPretty(result({ issues: ISSUES }), { color: false })).not.toContain("fix (");
  });

  it("compact mode prints one line per issue", () => {
    const text = formatPretty(result({ issues: ISSUES }), { color: false, compact: true });
    expect(text).not.toContain("Committed secrets");
    expect(text).toContain("  CRITICAL   src/a.ts:12  Hardcoded AWS key  [aaa111]");
  });

  it("says no issues found when complete", () => {
    const text = formatPretty(result(), { color: false });
    expect(text).toContain("✔ No issues found");
    expect(text).not.toContain("incomplete");
  });

  it("shows a prominent incomplete box with the errors", () => {
    const text = formatPretty(
      result({
        complete: false,
        errors: [{ stage: "llm", file: "src/a.ts", message: "Ollama is not reachable" }],
      }),
      { color: false },
    );
    expect(text).toContain("┌ Review incomplete");
    expect(text).toContain("│ [llm] src/a.ts: Ollama is not reachable");
    expect(text).not.toContain("✔ No issues found");
  });

  it("describes targets, checks-only runs and partial file counts", () => {
    const text = formatPretty(
      result({
        target: { kind: "range", base: "origin/main" },
        stats: { ...result().stats, provider: null, model: null, filesReviewed: 1, cacheHits: 1 },
      }),
      { color: false },
    );
    expect(text.split("\n")[0]).toBe("acr origin/main..HEAD · checks only (AI off) · 1/2 files · 4.2s · 1 cached");
  });

  it("shows non-fatal errors of a complete review as notes", () => {
    const text = formatPretty(
      result({ errors: [{ stage: "parse", file: "src/a.ts", message: "2 malformed AI issue(s) discarded" }] }),
      { color: false },
    );
    expect(text).toContain("Notes:\n  · [parse] src/a.ts: 2 malformed AI issue(s) discarded");
    expect(text).not.toContain("Review incomplete");
    expect(text).toContain("✔ No issues found");
  });

  it("distinguishes AI unavailable from AI disabled", () => {
    const noAi = { ...result().stats, provider: null, model: null };
    const unavailable = result({
      complete: false,
      stats: noAi,
      errors: [{ stage: "llm", message: "Ollama is not reachable" }],
    });
    expect(formatPretty(unavailable, { color: false }).split("\n")[0]).toContain("AI unavailable, checks only");
    expect(formatMarkdown(unavailable)).toContain("AI unavailable, checks only");
    expect(formatPretty(result({ stats: noAi }), { color: false }).split("\n")[0]).toContain("checks only (AI off)");
  });

  it("strips terminal escape sequences from model output", () => {
    const text = formatPretty(
      result({ issues: [issue({ id: "x", severity: "warning", file: "a.ts", title: "t\u001b[2J\u001b]0;pwn\u0007", message: "m" })] }),
      { color: false },
    );
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
  });
});

describe("formatJson", () => {
  it("is versioned, stable and round-trips", () => {
    const r = result({ issues: ISSUES });
    const json = formatJson(r);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["version", "target", "complete", "issues", "errors", "stats"]);
    expect(parsed).toEqual({ version: 1, ...r });
    expect(json).toContain('\n  "version": 1');
  });
});

describe("formatMarkdown", () => {
  const md = formatMarkdown(result({ issues: ISSUES }));

  it("has a header, summary table and per-file sections", () => {
    expect(md).toMatch(/^### acr review: staged changes\n/);
    expect(md).toContain("**3 issues** (1 critical, 1 warning, 1 suggestion)");
    expect(md).toContain("| File | Critical | Warning | Suggestion |");
    expect(md).toContain("| `src/a.ts` | 1 |  |  |");
    expect(md).toContain("| `src/b.ts` |  | 1 | 1 |");
    expect(md).toContain("| **Total** | **1** | **1** | **1** |");
    expect(md).toContain("#### `src/a.ts`");
    expect(md.indexOf("#### `src/a.ts`")).toBeLessThan(md.indexOf("#### `src/b.ts`"));
  });

  it("uses collapsible details, open for critical", () => {
    expect(md).toContain("<details open>\n<summary><b>Critical</b> · L12 · Hardcoded AWS key</summary>");
    expect(md).toContain("<details>\n<summary><b>Warning</b> · L30 · Unchecked null</summary>");
    expect(md).toContain("<summary><b>Suggestion</b> · file · File is getting long</summary>");
  });

  it("renders fixes as suggestion blocks", () => {
    expect(md).toContain("```suggestion\nconst key = process.env.AWS_KEY;\n```");
    expect(md).toContain("**Suggestion:** Guard with an early return.");
    expect(md).toContain("id: `aaa111` · rule: `secrets/aws-access-key` · source: check");
  });

  it("escapes HTML in titles and lengthens fences around backticks", () => {
    const out = formatMarkdown(
      result({
        issues: [
          issue({
            id: "x",
            severity: "critical",
            file: "a.md",
            title: "<script>alert(1)</script>",
            fix: { startLine: 1, endLine: 1, replacement: "```js\ncode\n```" },
          }),
        ],
      }),
    );
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("````suggestion\n```js\ncode\n```\n````");
  });

  it("lists non-fatal errors as a note", () => {
    const out = formatMarkdown(result({ errors: [{ stage: "parse", message: "1 malformed AI issue discarded" }] }));
    expect(out).toContain("> [!NOTE]\n> - [parse] 1 malformed AI issue discarded");
    expect(out).not.toContain("Review incomplete");
  });

  it("reports incomplete reviews and clean runs", () => {
    const out = formatMarkdown(
      result({ complete: false, errors: [{ stage: "llm", message: "rate limited" }] }),
    );
    expect(out).toContain("**No issues found**");
    expect(out).toContain("> [!WARNING]");
    expect(out).toContain("> - [llm] rate limited");
    expect(out).not.toContain("| File |");
  });
});

describe("exitCodeFor", () => {
  const cfg = (failOn: FailOn, onError: Config["onError"] = "warn"): Config => ({ ...DEFAULT_CONFIG, failOn, onError });
  const withSeverity = (s: Severity, complete = true) =>
    result({ complete, issues: [issue({ id: "i", severity: s, file: "f" })] });

  it.each<[FailOn, Severity, number]>([
    ["critical", "critical", EXIT.ISSUES],
    ["critical", "warning", EXIT.OK],
    ["critical", "suggestion", EXIT.OK],
    ["warning", "critical", EXIT.ISSUES],
    ["warning", "warning", EXIT.ISSUES],
    ["warning", "suggestion", EXIT.OK],
    ["suggestion", "suggestion", EXIT.ISSUES],
    ["never", "critical", EXIT.OK],
  ])("failOn %s with a %s issue → %i", (failOn, severity, code) => {
    expect(exitCodeFor(withSeverity(severity), cfg(failOn))).toBe(code);
  });

  it("no issues → OK", () => {
    expect(exitCodeFor(result(), cfg("suggestion"))).toBe(EXIT.OK);
  });

  it("incomplete → INCOMPLETE only with onError fail", () => {
    const incomplete = result({ complete: false });
    expect(exitCodeFor(incomplete, cfg("critical", "warn"))).toBe(EXIT.OK);
    expect(exitCodeFor(incomplete, cfg("critical", "fail"))).toBe(EXIT.INCOMPLETE);
    expect(exitCodeFor(incomplete, cfg("never", "fail"))).toBe(EXIT.INCOMPLETE);
  });

  it("blocking issues take precedence over incomplete", () => {
    expect(exitCodeFor(withSeverity("critical", false), cfg("critical", "fail"))).toBe(EXIT.ISSUES);
    expect(exitCodeFor(withSeverity("warning", false), cfg("critical", "fail"))).toBe(EXIT.INCOMPLETE);
  });
});
