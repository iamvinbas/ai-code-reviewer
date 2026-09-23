import { fingerprint } from "../review/fingerprint.js";
import type { FileDiff, Issue } from "../types.js";

export interface AddedLine {
  line: number;
  content: string;
}

export function* addedLines(file: FileDiff): Generator<AddedLine> {
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === "add" && l.newLine !== null) yield { line: l.newLine, content: l.content };
    }
  }
}

export function extension(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isTestFile(path: string): boolean {
  const p = `/${path}`;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return (
    /\/(__tests__|__mocks__|tests?|spec)\//.test(p) ||
    /\.(test|spec)\.[^.]+$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    base === "conftest.py"
  );
}

export function checkIssue(fields: Omit<Issue, "id" | "source">, codeLine?: string): Issue {
  const issue: Omit<Issue, "id"> = { source: "check", ...fields };
  return { id: fingerprint(issue, codeLine), ...issue };
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function mask(secret: string): string {
  return `${secret.slice(0, 4)}****`;
}
