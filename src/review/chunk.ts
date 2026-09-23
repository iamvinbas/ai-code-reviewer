import type { FileDiff, Hunk, ReviewError } from "../types.js";
import { hunkNewRange, renderHunks, splitLines } from "./render.js";
import { estimateTokens } from "./tokens.js";

/** A file (or part of it) as shown to the model in a chunk. `hunks` are exactly the lines shown. */
export interface ChunkPart {
  file: FileDiff;
  hunks: Hunk[];
  text: string;
  tokens: number;
}

export interface Chunk {
  parts: ChunkPart[];
  files: string[];
  text: string;
  tokens: number;
}

const PART_SEPARATOR = "\n\n";

const part = (file: FileDiff, hunks: Hunk[], text: string): ChunkPart => ({
  file,
  hunks,
  text,
  tokens: estimateTokens(text),
});

export const truncationMarker = (n: number): string => `[… truncated ${n} lines …]`;

/** Largest prefix of the hunk (at least one line) that fits the budget; rendered without extra context. */
function truncateHunk(file: FileDiff, hunk: Hunk, budget: number): { part: ChunkPart; dropped: number } {
  const n = hunk.lines.length;
  const render = (k: number): string => {
    const body = renderHunks(file, [{ ...hunk, lines: hunk.lines.slice(0, k) }], null, 0);
    return k < n ? `${body}\n${truncationMarker(n - k)}` : body;
  };
  let lo = 1;
  let hi = n;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(render(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { part: part(file, [{ ...hunk, lines: hunk.lines.slice(0, lo) }], render(lo)), dropped: n - lo };
}

function splitFile(
  file: FileDiff,
  fullLines: string[] | null,
  contextLines: number,
  budget: number,
  errors: ReviewError[],
): ChunkPart[] {
  const parts: ChunkPart[] = [];
  const hunks = file.hunks;
  let i = 0;
  while (i < hunks.length) {
    const min = i === 0 ? 1 : hunkNewRange(hunks[i - 1] as Hunk).end + 1;
    let group: Hunk[] = [];
    let text = "";
    let j = i;
    for (; j < hunks.length; j++) {
      const candidate = [...group, hunks[j] as Hunk];
      const next = hunks[j + 1];
      const max = next ? hunkNewRange(next).start - 1 : Infinity;
      const rendered = renderHunks(file, candidate, fullLines, contextLines, { min, max });
      if (estimateTokens(rendered) > budget) break;
      group = candidate;
      text = rendered;
    }
    if (group.length > 0) {
      parts.push(part(file, group, text));
      i = j;
      continue;
    }
    const hunk = hunks[i] as Hunk;
    const { part: truncated, dropped } = truncateHunk(file, hunk, budget);
    parts.push(truncated);
    i++;
    if (dropped === 0) continue;
    errors.push({
      stage: "llm",
      file: file.path,
      message: `diff too large, partially reviewed: ${dropped} of ${hunk.lines.length} lines of the hunk at line ${hunkNewRange(hunk).start} were not sent to the AI (raise maxChunkTokens to review them)`,
    });
  }
  return parts;
}

/**
 * Greedily packs rendered files into chunks of at most `budget` estimated tokens.
 * Oversized files are split by hunk groups; an oversized single hunk is truncated (with an error).
 */
export function buildChunks(
  files: readonly FileDiff[],
  contents: ReadonlyMap<string, string | null>,
  contextLines: number,
  budget: number,
): { chunks: Chunk[]; errors: ReviewError[] } {
  const errors: ReviewError[] = [];
  const parts: ChunkPart[] = [];
  for (const file of files) {
    const content = contents.get(file.path) ?? null;
    const fullLines = content === null ? null : splitLines(content);
    const whole = part(file, file.hunks, renderHunks(file, file.hunks, fullLines, contextLines));
    if (whole.tokens <= budget) parts.push(whole);
    else parts.push(...splitFile(file, fullLines, contextLines, budget, errors));
  }

  const chunks: Chunk[] = [];
  let current: ChunkPart[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((p) => p.text).join(PART_SEPARATOR);
    chunks.push({
      parts: current,
      files: [...new Set(current.map((p) => p.file.path))],
      text,
      tokens: estimateTokens(text),
    });
    current = [];
  };
  let used = 0;
  for (const p of parts) {
    const cost = p.tokens + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && used + cost > budget) {
      flush();
      used = 0;
    }
    used += current.length > 0 ? p.tokens + 1 : p.tokens;
    current.push(p);
  }
  flush();
  return { chunks, errors };
}
