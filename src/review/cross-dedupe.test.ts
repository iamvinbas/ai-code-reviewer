import { describe, expect, it } from "vitest";
import type { Issue } from "../types.js";
import { dropAiDuplicatesOfChecks } from "./cross-dedupe.js";

const check = (ruleId: string, line: number | null = 5, file = "src/a.ts"): Issue => ({
  id: `c-${ruleId}-${line}`,
  source: "check",
  ruleId,
  severity: "critical",
  file,
  line,
  title: "check",
  message: "check",
});

const ai = (title: string, over: Partial<Issue> = {}): Issue => ({
  id: `a-${title}`,
  source: "ai",
  ruleId: "bug",
  severity: "critical",
  file: "src/a.ts",
  line: 5,
  title,
  message: "",
  ...over,
});

const titles = (issues: Issue[]): string[] => issues.filter((i) => i.source === "ai").map((i) => i.title);

describe("dropAiDuplicatesOfChecks", () => {
  it("drops AI restatements of a secret finding on the same line", () => {
    const out = dropAiDuplicatesOfChecks([
      check("secrets/github-token"),
      ai("Hardcoded Credentials", { ruleId: "security" }),
      ai("Token esposto nel codice"),
      ai("Chiave API nel sorgente"),
      ai("SQL injection in query", { ruleId: "security" }),
      ai("Off-by-one in loop"),
    ]);
    expect(titles(out)).toEqual(["SQL injection in query", "Off-by-one in loop"]);
    expect(out.filter((i) => i.source === "check")).toHaveLength(1);
  });

  it("only merges on the same file and line", () => {
    const out = dropAiDuplicatesOfChecks([
      check("secrets/generic", 5),
      ai("Hardcoded password", { line: 6 }),
      ai("Hardcoded password", { file: "src/b.ts" }),
      ai("Hardcoded password", { line: null }),
    ]);
    expect(out).toHaveLength(4);
  });

  it("handles conflict markers", () => {
    const out = dropAiDuplicatesOfChecks([
      check("conflict-markers"),
      ai("Unresolved merge conflict"),
      ai("Conflitto di merge non risolto"),
      ai("Syntax error: unexpected token <<"),
    ]);
    expect(titles(out)).toEqual(["Syntax error: unexpected token <<"]);
  });

  it("handles debug statements but keeps sensitive-data leaks", () => {
    const out = dropAiDuplicatesOfChecks([
      check("debug-statements/console-log"),
      ai("Leftover console.log", { severity: "warning" }),
      ai("Debug logging left in production code"),
      ai("Password logged to console"),
      ai("Null dereference of user"),
    ]);
    expect(titles(out)).toEqual(["Password logged to console", "Null dereference of user"]);
  });

  it("does not cross concerns", () => {
    const out = dropAiDuplicatesOfChecks([check("debug-statements/console-log"), ai("Hardcoded API key")]);
    expect(titles(out)).toEqual(["Hardcoded API key"]);
  });
});
