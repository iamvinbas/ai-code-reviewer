import type { Issue } from "../types.js";

interface Concern {
  /** Check ruleIds belonging to this concern. */
  rule: RegExp;
  /** Matched against the AI issue's category, title and message. */
  ai: RegExp;
  /** AI text that signals a different, more specific concern (kept even if `ai` matches). */
  unless?: RegExp;
}

const CONCERNS: readonly Concern[] = [
  {
    rule: /^secrets\//,
    ai: /\b(?:secrets?|credentials?|tokens?|passwords?|passwd|api[ _-]?keys?|private[ _-]?keys?|keys?|segret[oi]|credenziali|chiav[ei])\b/i,
  },
  { rule: /^conflict-markers/, ai: /conflict|conflitt|merge markers?|<{7}|>{7}|={7}/i },
  {
    rule: /^debug-statements\//,
    ai: /console\.\w+|\bdebug\w*|\bprint\w*\b|\blog(?:s|ged|ging|ger)?\b|\bpdb\b|breakpoint|var_dump|\bdd\(|binding\.pry|\bstamp[ae]\w*/i,
    unless: /sensitive|sensibil|password|secret|segret|token|credential|credenzial|personal|pii|leak/i,
  },
];

/**
 * Drops AI issues that restate a deterministic check on the same file and line
 * (e.g. "Hardcoded credentials" next to secrets/github-token). Different concerns on
 * the same line are kept; file-level (line null) issues are never merged.
 */
export function dropAiDuplicatesOfChecks(issues: readonly Issue[]): Issue[] {
  const checkRules = new Map<string, string[]>();
  for (const i of issues) {
    if (i.source !== "check" || i.line === null || !i.ruleId) continue;
    const key = `${i.file}\0${i.line}`;
    checkRules.set(key, [...(checkRules.get(key) ?? []), i.ruleId]);
  }
  if (checkRules.size === 0) return [...issues];
  return issues.filter((i) => {
    if (i.source !== "ai" || i.line === null) return true;
    const rules = checkRules.get(`${i.file}\0${i.line}`);
    if (!rules) return true;
    const text = `${i.ruleId ?? ""} ${i.title} ${i.message}`;
    return !CONCERNS.some(
      (c) => c.ai.test(text) && !c.unless?.test(text) && rules.some((r) => c.rule.test(r)),
    );
  });
}
