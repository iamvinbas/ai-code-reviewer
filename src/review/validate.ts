import { REDACTED } from "../checks/secrets.js";
import type { Issue } from "../types.js";
import type { ChunkPart } from "./chunk.js";
import { fingerprint } from "./fingerprint.js";
import type { RawIssue } from "./parse.js";

/** Max distance (in lines) for snapping an invalid line number to the nearest added line. */
export const SNAP_DISTANCE = 3;

interface FileIndex {
  /** Added + context lines shown to the model, by new line number. */
  shown: Map<number, string>;
  added: Set<number>;
  addedSorted: number[];
}

function indexParts(parts: readonly ChunkPart[]): Map<string, FileIndex> {
  const index = new Map<string, FileIndex>();
  for (const p of parts) {
    let entry = index.get(p.file.path);
    if (!entry) {
      entry = { shown: new Map(), added: new Set(), addedSorted: [] };
      index.set(p.file.path, entry);
    }
    for (const hunk of p.hunks) {
      for (const l of hunk.lines) {
        if (l.newLine === null) continue;
        entry.shown.set(l.newLine, l.content);
        if (l.kind === "add") entry.added.add(l.newLine);
      }
    }
  }
  for (const entry of index.values()) entry.addedSorted = [...entry.added].sort((a, b) => a - b);
  return index;
}

function resolvePath(raw: string | undefined, index: Map<string, FileIndex>): string | null {
  if (raw === undefined || raw === "") return index.size === 1 ? ([...index.keys()][0] ?? null) : null;
  const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (index.has(cleaned)) return cleaned;
  const stripped = cleaned.replace(/^[ab]\//, "");
  return index.has(stripped) ? stripped : null;
}

function snapLine(line: number, file: FileIndex): number | null {
  if (file.shown.has(line)) return line;
  let best: number | null = null;
  for (const n of file.addedSorted) {
    const d = Math.abs(n - line);
    if (d > SNAP_DISTANCE) continue;
    if (best === null || d < Math.abs(best - line)) best = n;
  }
  return best;
}

function allAdded(start: number, end: number, file: FileIndex): boolean {
  if (start > end) return false;
  for (let n = start; n <= end; n++) if (!file.added.has(n)) return false;
  return true;
}

/**
 * Maps validated model output onto the lines actually shown in the chunk:
 * - issues on files not in the chunk are dropped;
 * - a line that is not a shown added/context line snaps to the nearest added line within
 *   ±SNAP_DISTANCE, else becomes null (file-level);
 * - `fix` is kept only if its whole range consists of added lines.
 */
export function resolveIssues(raw: readonly RawIssue[], parts: readonly ChunkPart[]): Issue[] {
  const index = indexParts(parts);
  const issues: Issue[] = [];
  for (const r of raw) {
    const path = resolvePath(r.file, index);
    const file = path === null ? undefined : index.get(path);
    if (path === null || !file) continue;
    const line = r.line == null ? null : snapLine(r.line, file);
    const endLine = line !== null && r.endLine != null && r.endLine > line && file.shown.has(r.endLine) ? r.endLine : undefined;
    const fix =
      r.fix && allAdded(r.fix.startLine, r.fix.endLine, file) && !r.fix.replacement.includes(REDACTED)
        ? r.fix
        : undefined;
    const base: Omit<Issue, "id"> = {
      source: "ai",
      severity: r.severity,
      file: path,
      line,
      title: r.title,
      message: r.message || r.title,
      ...(r.category ? { ruleId: r.category } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(r.suggestion ? { suggestion: r.suggestion } : {}),
      ...(fix ? { fix: { startLine: fix.startLine, endLine: fix.endLine, replacement: fix.replacement } } : {}),
    };
    issues.push({ id: fingerprint(base, line === null ? undefined : file.shown.get(line)), ...base });
  }
  return issues;
}
