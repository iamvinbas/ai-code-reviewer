import { EXIT, SEVERITY_RANK, type Config, type ReviewResult } from "../types.js";

export { formatPretty, type PrettyOptions } from "./pretty.js";
export { formatMarkdown } from "./markdown.js";
export { describeTarget } from "./common.js";

export const JSON_REPORT_VERSION = 1;

/** Stable, pretty-printed JSON: `{ version, target, complete, issues, errors, stats }`. */
export function formatJson(result: ReviewResult): string {
  const { target, complete, issues, errors, stats } = result;
  return JSON.stringify({ version: JSON_REPORT_VERSION, target, complete, issues, errors, stats }, null, 2);
}

/** Blocking issues win over an incomplete review. */
export function exitCodeFor(result: ReviewResult, config: Config): number {
  const { failOn, onError } = config;
  if (failOn !== "never") {
    const threshold = SEVERITY_RANK[failOn];
    if (result.issues.some((i) => SEVERITY_RANK[i.severity] >= threshold)) return EXIT.ISSUES;
  }
  if (!result.complete && onError === "fail") return EXIT.INCOMPLETE;
  return EXIT.OK;
}
