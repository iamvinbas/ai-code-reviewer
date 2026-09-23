import { createRedactor } from "../checks/secrets.js";
import type { FileDiff, Hunk } from "../types.js";

interface Row {
  marker: "+" | " " | "-" | "sep";
  line: number | null;
  text: string;
}

export const SEPARATOR = "⋮";

export function splitLines(content: string): string[] {
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** New-file range covered by a hunk; `end < start` when it has no new-side lines. */
export function hunkNewRange(hunk: Hunk): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const l of hunk.lines) {
    if (l.newLine === null) continue;
    start = Math.min(start, l.newLine);
    end = Math.max(end, l.newLine);
  }
  if (start === Infinity) {
    const pos = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    return { start: pos, end: pos - 1 };
  }
  return { start, end };
}

export function fileHeader(file: FileDiff): string {
  const status = file.status === "renamed" && file.oldPath ? `renamed from ${file.oldPath}` : file.status;
  return `### ${file.path} (${status})`;
}

export interface RenderBounds {
  /** Extra context lines are never taken outside [min, max] (used when a file is split). */
  min: number;
  max: number;
}

export function renderHunks(
  file: FileDiff,
  hunks: readonly Hunk[],
  fullLines: readonly string[] | null,
  contextLines: number,
  bounds: RenderBounds = { min: 1, max: Infinity },
): string {
  const ctx = fullLines ? Math.max(0, Math.floor(contextLines)) : 0;
  const total = fullLines ? Math.min(fullLines.length, bounds.max) : 0;
  const rows: Row[] = [];
  const pushContext = (from: number, to: number): void => {
    for (let n = from; n <= to; n++) rows.push({ marker: " ", line: n, text: fullLines?.[n - 1] ?? "" });
  };
  let last = bounds.min - 1;
  hunks.forEach((hunk, i) => {
    const { start, end } = hunkNewRange(hunk);
    const preFrom = Math.max(last + 1, start - ctx, bounds.min);
    if (rows.length > 0 && Math.min(preFrom, start) > last + 1) rows.push({ marker: "sep", line: null, text: "" });
    pushContext(preFrom, Math.min(start - 1, total));
    for (const l of hunk.lines) {
      const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      rows.push({ marker, line: l.kind === "del" ? null : l.newLine, text: l.content });
    }
    last = Math.max(last, end);
    const next = hunks[i + 1];
    const nextStart = next ? hunkNewRange(next).start : Infinity;
    const postTo = Math.min(end + ctx, total, nextStart - 1);
    pushContext(last + 1, postTo);
    last = Math.max(last, postTo);
  });

  const width = Math.max(3, ...rows.map((r) => String(r.line ?? "").length));
  const blank = " ".repeat(width);
  const redact = createRedactor();
  const out = [fileHeader(file)];
  for (const r of rows) {
    const text =
      r.marker === "sep"
        ? `  ${blank}   ${SEPARATOR}`
        : `  ${r.line === null ? blank : String(r.line).padStart(width)} ${r.marker} ${redact(r.text)}`;
    out.push(text.trimEnd());
  }
  return out.join("\n");
}

/**
 * Renders a file diff for the prompt: every added/context line carries its NEW line number
 * (`  42 + code` / `  42   code`), deletions have no number (`      - code`).
 * With `fullNewContent`, up to `contextLines` extra unchanged lines are shown around each hunk.
 * Secrets are redacted (see `redactSecrets`) so they never reach the provider.
 */
export function renderFileForPrompt(file: FileDiff, fullNewContent: string | null, contextLines: number): string {
  const fullLines = fullNewContent === null ? null : splitLines(fullNewContent);
  return renderHunks(file, file.hunks, fullLines, contextLines);
}
