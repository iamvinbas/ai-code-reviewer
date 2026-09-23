import pc from "picocolors";
import type { Issue, ReviewError, ReviewResult, Severity } from "../types.js";
import {
  aiModeLabel,
  countBySeverity,
  describeTarget,
  formatDuration,
  groupByFile,
  location,
  plural,
  sanitize,
  SEVERITIES,
} from "./common.js";

export interface PrettyOptions {
  /** Default: auto-detected (TTY, NO_COLOR, FORCE_COLOR). */
  color?: boolean;
  /** Show exact fix replacements and rule ids. */
  verbose?: boolean;
  /** One line per issue, no explanations (used by git hooks). */
  compact?: boolean;
}

type Colors = ReturnType<typeof pc.createColors>;

const LABEL: Record<Severity, string> = { critical: "CRITICAL", warning: "WARNING", suggestion: "SUGGESTION" };
const LABEL_WIDTH = Math.max(...Object.values(LABEL).map((l) => l.length));

function badge(c: Colors, severity: Severity): string {
  const text = LABEL[severity].padEnd(LABEL_WIDTH);
  switch (severity) {
    case "critical":
      return c.bold(c.red(text));
    case "warning":
      return c.bold(c.yellow(text));
    case "suggestion":
      return c.cyan(text);
  }
}

function indent(text: string, prefix: string): string {
  return sanitize(text)
    .trimEnd()
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

function header(c: Colors, result: ReviewResult): string {
  const { stats } = result;
  const provider = stats.provider
    ? `${stats.provider}${stats.model ? ` · ${stats.model}` : ""}`
    : aiModeLabel(result);
  const files =
    stats.filesInDiff === stats.filesReviewed
      ? plural(stats.filesInDiff, "file")
      : `${stats.filesReviewed}/${stats.filesInDiff} files`;
  const parts = [describeTarget(result.target), provider, files, formatDuration(stats.durationMs)];
  if (stats.cacheHits) parts.push(`${stats.cacheHits} cached`);
  return `${c.bold("acr")} ${c.dim(parts.join(" · "))}`;
}

function formatIssue(c: Colors, issue: Issue, opts: PrettyOptions): string[] {
  const pad = " ".repeat(LABEL_WIDTH + 3);
  const title = `  ${badge(c, issue.severity)} ${c.bold(sanitize(location(issue)))}  ${sanitize(issue.title)}  ${c.dim(`[${issue.id}]`)}`;
  if (opts.compact) return [title];
  const lines = [title];
  if (issue.message.trim()) lines.push(indent(issue.message, pad));
  if (issue.suggestion?.trim()) lines.push(c.dim(indent(`→ ${issue.suggestion}`, pad)));
  if (opts.verbose) {
    if (issue.ruleId) lines.push(c.dim(`${pad}rule: ${sanitize(issue.ruleId)} (${issue.source})`));
    if (issue.fix) {
      const { startLine, endLine, replacement } = issue.fix;
      const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
      lines.push(c.dim(`${pad}fix (${range}):`));
      const body = sanitize(replacement).replace(/\n$/, "");
      for (const line of body.split("\n")) lines.push(`${pad}${c.green(`+ ${line}`)}`);
    }
  }
  return lines;
}

function summary(c: Colors, issues: Issue[]): string {
  const counts = countBySeverity(issues);
  const color = { critical: c.red, warning: c.yellow, suggestion: c.cyan } as const;
  const parts = SEVERITIES.map((s) => {
    const text = plural(counts[s], s);
    return counts[s] ? color[s](text) : c.dim(text);
  });
  const mark = counts.critical ? c.red("✖") : counts.warning ? c.yellow("▲") : c.cyan("●");
  return `${mark} ${plural(issues.length, "issue")}: ${parts.join(c.dim(" · "))}`;
}

function describeError(err: ReviewError): string {
  const where = err.file ? `${sanitize(err.file)}: ` : "";
  return `${where}${sanitize(err.message).replace(/\n/g, " ")}`;
}

/** Non-fatal errors of a complete review (e.g. malformed AI issues discarded). */
function notes(c: Colors, errors: ReviewError[]): string[] {
  return [c.yellow("Notes:"), ...errors.map((err) => c.dim(`  · [${err.stage}] ${describeError(err)}`))];
}

function incompleteBox(c: Colors, result: ReviewResult): string[] {
  const bar = c.yellow("│");
  const lines = [c.yellow(c.bold("┌ Review incomplete — the results below may be partial"))];
  const errors = result.errors.length
    ? result.errors
    : [{ stage: "llm" as const, message: "not every file could be reviewed" }];
  for (const err of errors) {
    lines.push(`${bar} ${c.dim(`[${err.stage}]`)} ${describeError(err)}`);
  }
  lines.push(c.yellow("└"));
  return lines;
}

export function formatPretty(result: ReviewResult, opts: PrettyOptions = {}): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const out: string[] = [header(c, result), ""];

  for (const [file, issues] of groupByFile(result.issues)) {
    if (!opts.compact) out.push(c.underline(sanitize(file)));
    for (const issue of issues) out.push(...formatIssue(c, issue, opts));
    if (!opts.compact) out.push("");
  }
  if (opts.compact && result.issues.length) out.push("");

  if (!result.complete) out.push(...incompleteBox(c, result), "");
  else if (result.errors.length) out.push(...notes(c, result.errors), "");

  if (result.issues.length) out.push(summary(c, result.issues));
  else if (result.complete) out.push(c.green("✔ No issues found"));
  else out.push(c.dim("No issues found in what could be reviewed."));

  return out.join("\n");
}
