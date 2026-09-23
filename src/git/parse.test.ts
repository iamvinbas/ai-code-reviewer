import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./index.js";
import { cUnquote } from "./parse.js";

const d = (...lines: string[]): string => lines.join("\n") + "\n";

describe("parseUnifiedDiff", () => {
  it("returns [] for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n")).toEqual([]);
  });

  it("parses a modified file with correct line numbers and counts", () => {
    const [f, ...rest] = parseUnifiedDiff(
      d(
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -10,4 +10,5 @@ function main() {",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " const d = 5;",
        " return a;",
      ),
    );
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ path: "src/app.ts", oldPath: null, status: "modified", binary: false });
    expect(f!.additions).toBe(2);
    expect(f!.deletions).toBe(1);
    const h = f!.hunks[0]!;
    expect(h).toMatchObject({ header: "@@ -10,4 +10,5 @@ function main() {", oldStart: 10, oldLines: 4, newStart: 10, newLines: 5 });
    expect(h.lines).toEqual([
      { kind: "context", content: "const a = 1;", oldLine: 10, newLine: 10 },
      { kind: "del", content: "const b = 2;", oldLine: 11, newLine: null },
      { kind: "add", content: "const b = 3;", oldLine: null, newLine: 11 },
      { kind: "add", content: "const c = 4;", oldLine: null, newLine: 12 },
      { kind: "context", content: "const d = 5;", oldLine: 12, newLine: 13 },
      { kind: "context", content: "return a;", oldLine: 13, newLine: 14 },
    ]);
  });

  it("parses multiple files and multiple hunks", () => {
    const files = parseUnifiedDiff(
      d(
        "diff --git a/a.txt b/a.txt",
        "index 1..2 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,2 +1,2 @@",
        "-one",
        "+ONE",
        " two",
        "@@ -20,2 +20,3 @@ ctx",
        " twenty",
        "+new",
        " twentyone",
        "diff --git a/b.txt b/b.txt",
        "index 3..4 100644",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -5 +5 @@",
        "-x",
        "+y",
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[0]!.hunks[1]!.lines[1]).toEqual({ kind: "add", content: "new", oldLine: null, newLine: 21 });
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);
  });

  it("treats hunk headers without counts as count 1", () => {
    const [f] = parseUnifiedDiff(
      d("diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -3 +3 @@", "-old", "+new", "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -1 +1,2 @@", " keep", "+more"),
    );
    expect(f!.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
    expect(f!.hunks[0]!.lines).toEqual([
      { kind: "del", content: "old", oldLine: 3, newLine: null },
      { kind: "add", content: "new", oldLine: null, newLine: 3 },
    ]);
  });

  it("parses a new file", () => {
    const [f] = parseUnifiedDiff(
      d(
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "index 0000000..abcdef0",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,3 @@",
        "+a",
        "+b",
        "+c",
      ),
    );
    expect(f).toMatchObject({ path: "new.ts", oldPath: null, status: "added", additions: 3, deletions: 0 });
    expect(f!.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 });
    expect(f!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2, 3]);
  });

  it("parses a deleted file (path = old path)", () => {
    const [f] = parseUnifiedDiff(
      d("diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "index abcdef0..0000000", "--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b"),
    );
    expect(f).toMatchObject({ path: "gone.ts", oldPath: null, status: "deleted", additions: 0, deletions: 2 });
    expect(f!.hunks[0]!.lines.map((l) => l.oldLine)).toEqual([1, 2]);
  });

  it("parses a pure rename (no hunks) and a rename with changes", () => {
    const files = parseUnifiedDiff(
      d(
        "diff --git a/old name.ts b/new name.ts",
        "similarity index 100%",
        "rename from old name.ts",
        "rename to new name.ts",
        "diff --git a/lib/a.ts b/lib/b.ts",
        "similarity index 90%",
        "rename from lib/a.ts",
        "rename to lib/b.ts",
        "index 1..2 100644",
        "--- a/lib/a.ts",
        "+++ b/lib/b.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-x",
        "+y",
      ),
    );
    expect(files[0]).toEqual({ path: "new name.ts", oldPath: "old name.ts", status: "renamed", binary: false, hunks: [], additions: 0, deletions: 0 });
    expect(files[1]).toMatchObject({ path: "lib/b.ts", oldPath: "lib/a.ts", status: "renamed", additions: 1, deletions: 1 });
  });

  it("keeps mode-only changes as modified files without hunks", () => {
    const [f] = parseUnifiedDiff(d("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"));
    expect(f).toEqual({ path: "run.sh", oldPath: null, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 });
  });

  it("parses an empty new file (no ---/+++ lines) with spaces in its name", () => {
    const [f] = parseUnifiedDiff(d("diff --git a/dir/my file.txt b/dir/my file.txt", "new file mode 100644", "index 0000000..e69de29"));
    expect(f).toMatchObject({ path: "dir/my file.txt", status: "added", hunks: [] });
  });

  it("marks binary files", () => {
    const files = parseUnifiedDiff(
      d(
        "diff --git a/img.png b/img.png",
        "new file mode 100644",
        "index 0000000..1234567",
        "Binary files /dev/null and b/img.png differ",
        "diff --git a/data.bin b/data.bin",
        "index 1..2 100644",
        "GIT binary patch",
        "literal 3",
        "Kc${NkU;qFB0RR91",
        "",
        "literal 0",
        "HcmV?d00001",
        "",
      ),
    );
    expect(files[0]).toEqual({ path: "img.png", oldPath: null, status: "added", binary: true, hunks: [], additions: 0, deletions: 0 });
    expect(files[1]).toMatchObject({ path: "data.bin", status: "modified", binary: true, hunks: [] });
  });

  it("ignores '\\ No newline at end of file' markers", () => {
    const [f] = parseUnifiedDiff(
      d(
        "diff --git a/n.txt b/n.txt",
        "--- a/n.txt",
        "+++ b/n.txt",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "\\ No newline at end of file",
        "+b",
        "\\ No newline at end of file",
        "diff --git a/m.txt b/m.txt",
        "--- a/m.txt",
        "+++ b/m.txt",
        "@@ -1 +1 @@",
        "-z",
        "+z2",
      ),
    );
    expect(f!.hunks[0]!.lines).toEqual([
      { kind: "context", content: "a", oldLine: 1, newLine: 1 },
      { kind: "del", content: "b", oldLine: 2, newLine: null },
      { kind: "add", content: "b", oldLine: null, newLine: 2 },
    ]);
    expect(f!.additions).toBe(1);
    expect(f!.deletions).toBe(1);
  });

  it("decodes C-quoted paths (octal UTF-8 escapes) and strips the trailing tab", () => {
    const files = parseUnifiedDiff(
      d(
        'diff --git "a/caf\\303\\251 menu.txt" "b/caf\\303\\251 menu.txt"',
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/caf\\303\\251 menu.txt"',
        "@@ -0,0 +1 @@",
        "+x",
        "diff --git a/with space.txt b/with space.txt",
        "--- a/with space.txt\t",
        "+++ b/with space.txt\t",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/tab\\there" "b/quo\\"te"',
        "similarity index 100%",
        'rename from "tab\\there"',
        'rename to "quo\\"te"',
        "diff --git a/ñ.txt b/ñ.txt",
        "deleted file mode 100644",
        "--- a/ñ.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["café menu.txt", "with space.txt", 'quo"te', "ñ.txt"]);
    expect(files[2]!.oldPath).toBe("tab\there");
    expect(files[3]!.status).toBe("deleted");
  });

  it("takes the path from a quoted header when there are no ---/+++ lines", () => {
    const [f] = parseUnifiedDiff(d('diff --git "a/\\346\\227\\245.txt" "b/\\346\\227\\245.txt"', "new file mode 100644", "index 0000000..e69de29"));
    expect(f!.path).toBe("日.txt");
  });

  it("does not mistake header-looking content for headers", () => {
    const [f, g] = parseUnifiedDiff(
      d(
        "diff --git a/doc.md b/doc.md",
        "--- a/doc.md",
        "+++ b/doc.md",
        "@@ -1,3 +1,3 @@",
        "--- a/doc.md",
        "+++ b/doc.md",
        " diff --git a/x b/x",
        "-@@ -1 +1 @@",
        "+@@ -2 +2 @@",
        "diff --git a/z b/z",
        "--- a/z",
        "+++ b/z",
        "@@ -1 +1 @@",
        "-1",
        "+2",
      ),
    );
    expect(f!.hunks[0]!.lines.map((l) => [l.kind, l.content])).toEqual([
      ["del", "-- a/doc.md"],
      ["add", "++ b/doc.md"],
      ["context", "diff --git a/x b/x"],
      ["del", "@@ -1 +1 @@"],
      ["add", "@@ -2 +2 @@"],
    ]);
    expect(g!.path).toBe("z");
  });

  it("treats empty lines inside hunks as blank context (diff.suppressBlankEmpty)", () => {
    const [f] = parseUnifiedDiff(d("diff --git a/e b/e", "--- a/e", "+++ b/e", "@@ -1,3 +1,3 @@", " a", "", "-c", "+C"));
    expect(f!.hunks[0]!.lines[1]).toEqual({ kind: "context", content: "", oldLine: 2, newLine: 2 });
    expect(f!.hunks[0]!.lines[3]).toEqual({ kind: "add", content: "C", oldLine: null, newLine: 3 });
  });

  it("strips CR from CRLF lines", () => {
    const [f] = parseUnifiedDiff("diff --git a/w b/w\r\n--- a/w\r\n+++ b/w\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n");
    expect(f!.path).toBe("w");
    expect(f!.hunks[0]!.lines.map((l) => l.content)).toEqual(["a", "b"]);
  });

  it("skips preamble text and combined diffs", () => {
    const files = parseUnifiedDiff(
      d(
        "commit abc",
        "Author: X <x@y>",
        "",
        "    message --- with dashes",
        "",
        "diff --cc merged.txt",
        "index 1,2..3",
        "--- a/merged.txt",
        "+++ b/merged.txt",
        "@@@ -1,1 -1,1 +1,1 @@@",
        "- a",
        " -b",
        "++c",
        "diff --git a/k b/k",
        "--- a/k",
        "+++ b/k",
        "@@ -1 +1 @@",
        "-1",
        "+2",
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["k"]);
  });

  it("accepts plain `diff -u` output without git headers", () => {
    const files = parseUnifiedDiff(
      d(
        "--- a/one.txt\t2024-01-01 00:00:00",
        "+++ b/one.txt\t2024-01-01 00:00:01",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "--- a/two.txt",
        "+++ b/two.txt",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
      ),
    );
    expect(files.map((f) => [f.path, f.status, f.additions])).toEqual([
      ["one.txt", "modified", 1],
      ["two.txt", "modified", 1],
    ]);
  });

  it("keeps the parsed lines of a truncated hunk", () => {
    const [f] = parseUnifiedDiff(d("diff --git a/t b/t", "--- a/t", "+++ b/t", "@@ -1,5 +1,5 @@", " a", "-b"));
    expect(f!.hunks[0]!.lines).toHaveLength(2);
    expect(f!.deletions).toBe(1);
  });
});

describe("cUnquote", () => {
  it("decodes escapes and reports the end index", () => {
    expect(cUnquote('"a\\tb\\\\c\\"d\\n" rest')).toEqual({ value: 'a\tb\\c"d\n', end: 14 });
    expect(cUnquote('"\\303\\244"')?.value).toBe("ä");
    expect(cUnquote('"ä 😀"')?.value).toBe("ä 😀");
  });

  it("returns null for malformed input", () => {
    expect(cUnquote("no quote")).toBeNull();
    expect(cUnquote('"unterminated')).toBeNull();
  });
});
