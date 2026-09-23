import {
  SEVERITIES,
  SEVERITY_RANK,
  type DiffTarget,
  type Issue,
  type ReviewResult,
  type Severity,
} from "../types.js";

export function describeTarget(target: DiffTarget): string {
  switch (target.kind) {
    case "staged":
      return "staged changes";
    case "working":
      return "uncommitted changes";
    case "range":
      return `${target.base}..${target.head ?? "HEAD"}`;
    case "commit":
      return `commit ${target.sha.slice(0, 12)}`;
  }
}

/** "checks only" label: AI disabled on purpose vs. AI wanted but unavailable (no provider + llm error). */
export function aiModeLabel(result: ReviewResult): string {
  return result.errors.some((e) => e.stage === "llm") ? "AI unavailable, checks only" : "checks only (AI off)";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function countBySeverity(issues: Issue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 || word === "critical" ? "" : "s"}`;
}

/** Issues grouped by file (sorted by path), each group sorted by line (file-level first), then severity. */
export function groupByFile(issues: Issue[]): [string, Issue[]][] {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const list = groups.get(issue.file);
    if (list) list.push(issue);
    else groups.set(issue.file, [issue]);
  }
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        (a.line ?? 0) - (b.line ?? 0) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    );
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function location(issue: Issue): string {
  if (issue.line === null) return issue.file;
  const end = issue.endLine && issue.endLine > issue.line ? `-${issue.endLine}` : "";
  return `${issue.file}:${issue.line}${end}`;
}

/** Strips terminal control sequences from untrusted (model-generated) text; keeps newlines and tabs. */
export function sanitize(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export { SEVERITIES };
