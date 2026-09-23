import { describe, expect, it } from "vitest";
import { buildChunks, truncationMarker } from "./chunk.js";
import { renderFileForPrompt } from "./index.js";
import { addedFile, makeFile } from "./testing.js";
import { estimateTokens } from "./tokens.js";

const content = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("renderFileForPrompt", () => {
  const file = makeFile("src/a.ts", [
    { oldStart: 3, newStart: 3, lines: [" line 3", "-old 4", "+line 4", " line 5"] },
    { oldStart: 20, newStart: 20, lines: [" line 20", "+line 21", " line 22"] },
  ]);

  it("renders numbered added/context lines and unnumbered deletions", () => {
    expect(renderFileForPrompt(file, null, 3)).toBe(
      [
        "### src/a.ts (modified)",
        "    3   line 3",
        "      - old 4",
        "    4 + line 4",
        "    5   line 5",
        "        ⋮",
        "   20   line 20",
        "   21 + line 21",
        "   22   line 22",
      ].join("\n"),
    );
  });

  it("adds surrounding lines from the full file, merged and never duplicated", () => {
    const out = renderFileForPrompt(file, content(24), 2);
    expect(out).toBe(
      [
        "### src/a.ts (modified)",
        "    1   line 1",
        "    2   line 2",
        "    3   line 3",
        "      - old 4",
        "    4 + line 4",
        "    5   line 5",
        "    6   line 6",
        "    7   line 7",
        "        ⋮",
        "   18   line 18",
        "   19   line 19",
        "   20   line 20",
        "   21 + line 21",
        "   22   line 22",
        "   23   line 23",
        "   24   line 24",
      ].join("\n"),
    );
    const merged = renderFileForPrompt(file, content(24), 20);
    expect(merged).not.toContain("⋮");
    const numbers = merged.split("\n").flatMap((l) => /^\s+(\d+) /.exec(l)?.[1] ?? []).map(Number);
    expect(numbers).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it("shows renames and wide line numbers", () => {
    const f = makeFile("b.ts", [{ newStart: 1234, lines: ["+x"] }], { status: "renamed", oldPath: "a.ts" });
    expect(renderFileForPrompt(f, null, 0)).toBe("### b.ts (renamed from a.ts)\n  1234 + x");
  });
});

describe("buildChunks", () => {
  const small = (name: string): ReturnType<typeof addedFile> => addedFile(name, ["const a = 1;", "const b = 2;"]);

  it("packs several small files into one chunk and starts a new one when full", () => {
    const files = [small("a.ts"), small("b.ts"), small("c.ts")];
    const one = estimateTokens(renderFileForPrompt(small("a.ts"), null, 0));
    const packed = buildChunks(files, new Map(), 0, 1000);
    expect(packed.chunks).toHaveLength(1);
    expect(packed.chunks[0]?.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(packed.chunks[0]?.text).toContain("### b.ts (added)");

    const split = buildChunks(files, new Map(), 0, one * 2 + 1);
    expect(split.chunks.map((c) => c.files)).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
    for (const c of split.chunks) expect(c.tokens).toBeLessThanOrEqual(one * 2 + 1);
    expect(split.errors).toEqual([]);
  });

  it("splits a large file by hunk groups without reporting errors", () => {
    const hunks = Array.from({ length: 6 }, (_, i) => ({
      newStart: i * 100 + 1,
      lines: Array.from({ length: 10 }, (_, k) => `+const v${i}_${k} = compute(${k});`),
    }));
    const file = makeFile("big.ts", hunks);
    const full = estimateTokens(renderFileForPrompt(file, null, 0));
    const { chunks, errors } = buildChunks([file], new Map(), 0, Math.ceil(full / 2.5));
    expect(errors).toEqual([]);
    expect(chunks.length).toBeGreaterThan(1);
    const shown = chunks.flatMap((c) => c.parts.flatMap((p) => p.hunks));
    expect(shown).toHaveLength(6);
    for (const c of chunks) {
      expect(c.files).toEqual(["big.ts"]);
      expect(c.text.startsWith("### big.ts (modified)")).toBe(true);
    }
  });

  it("never shows another group's hunk lines as extra context when splitting", () => {
    const file = makeFile("near.ts", [
      { newStart: 5, lines: Array.from({ length: 8 }, (_, k) => `+first ${k}`) },
      { newStart: 15, lines: Array.from({ length: 8 }, (_, k) => `+second ${k}`) },
    ]);
    const contents = new Map([["near.ts", content(40)]]);
    const whole = estimateTokens(renderFileForPrompt(file, content(40), 10));
    const { chunks } = buildChunks([file], contents, 10, whole - 5);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).not.toMatch(/^\s+1[5-9]\s/m);
    expect(chunks[1]?.text).not.toMatch(/^\s+(?:[5-9]|1[0-2])\s/m);
  });

  it("truncates a single oversized hunk and reports an error", () => {
    const file = addedFile("huge.ts", Array.from({ length: 200 }, (_, k) => `const value${k} = ${k} * 2;`));
    const { chunks, errors } = buildChunks([file], new Map(), 0, 300);
    expect(chunks).toHaveLength(1);
    const text = chunks[0]?.text ?? "";
    expect(estimateTokens(text)).toBeLessThanOrEqual(300);
    const kept = chunks[0]?.parts[0]?.hunks[0]?.lines.length ?? 0;
    expect(kept).toBeGreaterThan(10);
    expect(text).toContain(truncationMarker(200 - kept));
    expect(errors).toEqual([
      expect.objectContaining({ stage: "llm", file: "huge.ts", message: expect.stringContaining("diff too large, partially reviewed") }),
    ]);
  });
});
