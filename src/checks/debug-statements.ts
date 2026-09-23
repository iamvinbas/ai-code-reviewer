import { isGenerated } from "../review/filter.js";
import type { Check, FileDiff, Issue, Severity } from "../types.js";
import { addedLines, checkIssue, extension, isTestFile } from "./util.js";

interface DebugRule {
  ruleId: string;
  extensions: ReadonlySet<string>;
  regex: RegExp;
  severity: Severity;
  label: string;
  /** Allowed in test files (e.g. console.log / print). */
  skipInTests: boolean;
}

const JS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte"]);
const PY = new Set(["py", "pyw"]);
const RB = new Set(["rb", "erb", "rake"]);
const PHP = new Set(["php", "phtml"]);

const RULES: DebugRule[] = [
  {
    ruleId: "debug-statements/debugger",
    extensions: JS,
    regex: /(?:^|[\s;{}])debugger\s*(?:;|$)/,
    severity: "warning",
    label: "`debugger` statement",
    skipInTests: false,
  },
  {
    ruleId: "debug-statements/console-log",
    extensions: JS,
    regex: /\bconsole\.(?:log|debug|trace|dir)\s*\(/,
    severity: "suggestion",
    label: "`console.log` call",
    skipInTests: true,
  },
  {
    ruleId: "debug-statements/pdb",
    extensions: PY,
    regex: /^\s*(?:import\s+i?pdb\b|from\s+i?pdb\s+import\b)|\bi?pdb\.set_trace\s*\(|(?<![\w.])breakpoint\s*\(\s*\)/,
    severity: "warning",
    label: "Python debugger breakpoint",
    skipInTests: false,
  },
  {
    ruleId: "debug-statements/print",
    extensions: PY,
    regex: /^\s*print\s*\(/,
    severity: "suggestion",
    label: "`print` call",
    skipInTests: true,
  },
  {
    ruleId: "debug-statements/pry",
    extensions: RB,
    regex: /\bbinding\.(?:pry|irb)\b|^\s*byebug\b/,
    severity: "warning",
    label: "Ruby debugger breakpoint",
    skipInTests: false,
  },
  {
    ruleId: "debug-statements/php-dump",
    extensions: PHP,
    regex: /(?<![\w$>:])(?:var_dump|dd)\s*\(/,
    severity: "warning",
    label: "`var_dump`/`dd` call",
    skipInTests: false,
  },
];

const COMMENT: Record<string, RegExp> = {
  js: /^\s*(?:\/\/|\/?\*)/,
  py: /^\s*#/,
  rb: /^\s*#/,
  php: /^\s*(?:\/\/|#|\/?\*)/,
};

function commentPattern(ext: string): RegExp | undefined {
  if (JS.has(ext)) return COMMENT.js;
  if (PY.has(ext)) return COMMENT.py;
  if (RB.has(ext)) return COMMENT.rb;
  if (PHP.has(ext)) return COMMENT.php;
  return undefined;
}

function scanFile(file: FileDiff): Issue[] {
  const ext = extension(file.path);
  const test = isTestFile(file.path);
  const rules = RULES.filter((r) => r.extensions.has(ext) && !(test && r.skipInTests));
  if (rules.length === 0) return [];
  const comment = commentPattern(ext);
  const issues: Issue[] = [];
  for (const { line, content } of addedLines(file)) {
    if (comment?.test(content)) continue;
    const rule = rules.find((r) => r.regex.test(content));
    if (!rule) continue;
    issues.push(
      checkIssue(
        {
          ruleId: rule.ruleId,
          severity: rule.severity,
          file: file.path,
          line,
          title: `Leftover ${rule.label}`,
          message: "Debugging code was added; it will run for everyone (noisy output, possible data leaks, or a process that stops at a breakpoint).",
          suggestion:
            rule.severity === "warning"
              ? "Remove the breakpoint before committing."
              : "Remove it, or use the project's logger if the output is intentional.",
        },
        content,
      ),
    );
  }
  return issues;
}

export const debugStatementsCheck: Check = {
  id: "debug-statements",
  description: "Detects leftover debugging code (debugger, console.log, pdb, print, binding.pry, var_dump, dd) by file type.",
  // Minified, built and vendored code is not the author's: its logging is not a leftover.
  run: (files) => files.filter((f) => !f.binary && !isGenerated(f.path)).flatMap(scanFile),
};
