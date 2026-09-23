import { createHash } from "node:crypto";
import type { Issue } from "../types.js";

const normalizeTitle = (title: string): string =>
  title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const normalizeCode = (code: string): string => code.trim().replace(/\s+/g, " ");

/**
 * Stable issue id: sha256(source | rule | file | normalized code line), first 12 hex chars.
 * Checks are keyed by ruleId; AI issues by normalized title (their category is too coarse).
 * The line number is deliberately excluded so ids survive code moving around.
 */
export function fingerprint(issue: Omit<Issue, "id">, codeLine?: string): string {
  const rule =
    issue.source === "check" && issue.ruleId ? issue.ruleId : normalizeTitle(issue.title);
  const payload = [issue.source, rule, issue.file, normalizeCode(codeLine ?? "")].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}
