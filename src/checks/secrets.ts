import type { Check, FileDiff, Issue } from "../types.js";
import { addedLines, checkIssue, mask, shannonEntropy } from "./util.js";

interface SecretRule {
  id: string;
  name: string;
  /** First capture group = the secret value. */
  regex: RegExp;
  validate?: (value: string) => boolean;
}

const hasDigitAndLetter = (v: string): boolean => /\d/.test(v) && /[A-Za-z]/.test(v);

const RULES: SecretRule[] = [
  {
    id: "secrets/private-key",
    name: "private key",
    regex: /(-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5})/,
  },
  { id: "secrets/aws-access-key", name: "AWS access key ID", regex: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/ },
  {
    id: "secrets/aws-secret-key",
    name: "AWS secret access key",
    regex: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/i,
  },
  {
    id: "secrets/github-token",
    name: "GitHub token",
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/,
  },
  { id: "secrets/slack-token", name: "Slack token", regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})/ },
  { id: "secrets/stripe-key", name: "Stripe live key", regex: /\b((?:sk|rk)_live_[A-Za-z0-9]{16,})/ },
  { id: "secrets/google-api-key", name: "Google API key", regex: /\b(AIza[0-9A-Za-z_-]{35})/ },
  {
    id: "secrets/anthropic-key",
    name: "Anthropic API key",
    regex: /\b(sk-ant-[A-Za-z0-9_-]{20,})/,
    validate: hasDigitAndLetter,
  },
  {
    id: "secrets/openai-key",
    name: "OpenAI-style API key",
    regex: /\b(sk-(?!ant-)[A-Za-z0-9_-]{20,})/,
    validate: hasDigitAndLetter,
  },
  {
    id: "secrets/jwt",
    name: "JSON Web Token",
    regex: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/,
  },
];

const PLACEHOLDER =
  /^(?:your|my|the|some)[_-]|x{4,}|\*{3,}|\.{3}|change[_-]?me|placeholder|example|sample|dummy|redacted|replace[_-]?me|fake|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|process\.env|import\.meta\.env|os\.environ|getenv|env\(|^%\w+%$|^\$[A-Za-z_]/i;

const TRIVIAL = /^(?:test|testing|secret|password|passwd|token|none|null|nil|undefined|true|false)$/i;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || TRIVIAL.test(value);
}

/** Assignment keys that suggest a credential (compared with separators removed, lowercase). */
const SECRET_KEY_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "secret",
  "secretkey",
  "apikey",
  "accesskey",
  "token",
  "privatekey",
];

const isSecretKey = (key: string): boolean => {
  const k = key.toLowerCase().replace(/[_.-]/g, "");
  return SECRET_KEY_SUFFIXES.some((s) => k.endsWith(s));
};

const QUOTED_ASSIGNMENT =
  /(["']?)([A-Za-z_][\w.-]*)\1\s*(?::=|=>|=(?!=)|:)\s*(["'`])([^"'`\s]+)\3/g;
const UNQUOTED_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s"'`#]+)\s*(?:#.*)?$/;

export const MIN_GENERIC_LENGTH = 8;
export const MIN_GENERIC_ENTROPY = 3;

function looksLikeSecretValue(value: string): boolean {
  if (value.length < MIN_GENERIC_LENGTH || value.length > 512) return false;
  if (isPlaceholder(value)) return false;
  // Identifier paths / calls (config.db.password, getToken()) are code, not literals.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /[()]/.test(value)) return false;
  return shannonEntropy(value) >= MIN_GENERIC_ENTROPY;
}

function genericMatch(content: string): { key: string; value: string } | null {
  for (const m of content.matchAll(QUOTED_ASSIGNMENT)) {
    const key = m[2] ?? "";
    const value = m[4] ?? "";
    if (isSecretKey(key) && looksLikeSecretValue(value)) return { key, value };
  }
  const u = UNQUOTED_ASSIGNMENT.exec(content);
  if (u) {
    const key = u[1] ?? "";
    const value = u[2] ?? "";
    if (isSecretKey(key) && looksLikeSecretValue(value)) return { key, value };
  }
  return null;
}

// ─── Redaction (for text sent to the AI) ──────────────────────────────────────

export const REDACTED = "[REDACTED]";
export const REDACTED_KEY_MATERIAL = "[REDACTED private key material]";

const PEM_BEGIN = /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}/;
const PEM_END = /-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}/;
/** Key material inlined on one line (e.g. JSON service-account files with literal "\n"). */
const PEM_INLINE = new RegExp(`(${PEM_BEGIN.source})(.+?)(?=${PEM_END.source}|$)`, "g");

const withIndices = (re: RegExp): RegExp => new RegExp(re.source, `${re.flags.replace(/[dg]/g, "")}dg`);
const PROVIDER_RULES = RULES.filter((r) => r.id !== "secrets/private-key").map((rule) => ({
  rule,
  global: withIndices(rule.regex),
}));
const QUOTED_ASSIGNMENT_D = withIndices(QUOTED_ASSIGNMENT);
const UNQUOTED_ASSIGNMENT_D = withIndices(UNQUOTED_ASSIGNMENT);

/** Redaction is more aggressive than detection: low-entropy passwords must not leave the machine either. */
function isRedactableValue(value: string): boolean {
  return (
    value.length >= 6 &&
    !isPlaceholder(value) &&
    !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) &&
    !/[()]/.test(value)
  );
}

interface Span {
  start: number;
  end: number;
  replacement: string;
}

function secretSpans(line: string): Span[] {
  const spans: Span[] = [];
  for (const { rule, global } of PROVIDER_RULES) {
    for (const m of line.matchAll(global)) {
      const value = m[1];
      const at = m.indices?.[1];
      if (!value || !at || isPlaceholder(value) || (rule.validate && !rule.validate(value))) continue;
      spans.push({ start: at[0], end: at[1], replacement: `${mask(value)}${REDACTED}` });
    }
  }
  const assignment = (key: string | undefined, value: string | undefined, at: [number, number] | undefined): void => {
    if (key && value && at && isSecretKey(key) && isRedactableValue(value)) {
      spans.push({ start: at[0], end: at[1], replacement: `****${REDACTED}` });
    }
  };
  for (const m of line.matchAll(QUOTED_ASSIGNMENT_D)) assignment(m[2], m[4], m.indices?.[4]);
  for (const m of line.matchAll(UNQUOTED_ASSIGNMENT_D)) assignment(m[1], m[2], m.indices?.[2]);
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Replaces every secret the secrets check would recognise (and weaker credential literals) with a mask. */
export function redactSecrets(line: string): string {
  const pem = line.replace(PEM_INLINE, (_m, begin: string) => `${begin}${REDACTED}`);
  let out = "";
  let pos = 0;
  for (const span of secretSpans(pem)) {
    if (span.start < pos) {
      pos = Math.max(pos, span.end);
      continue;
    }
    out += pem.slice(pos, span.start) + span.replacement;
    pos = span.end;
  }
  return out + pem.slice(pos);
}

/** Stateful line redactor: also hides the body lines of multi-line PEM private keys. */
export function createRedactor(): (line: string) => string {
  let inKey = false;
  return (line) => {
    if (inKey) {
      if (PEM_END.test(line)) {
        inKey = false;
        return line;
      }
      return REDACTED_KEY_MATERIAL;
    }
    if (PEM_BEGIN.test(line) && !PEM_END.test(line) && line.trim().replace(PEM_BEGIN, "").replace(/["',\s]/g, "") === "") {
      inKey = true;
      return line;
    }
    return redactSecrets(line);
  };
}

const SUGGESTION =
  "Remove it from the code, rotate the credential (it is in git history once committed) and load it from an environment variable or a secret manager.";

function scanFile(file: FileDiff): Issue[] {
  const issues: Issue[] = [];
  for (const { line, content } of addedLines(file)) {
    let matched = false;
    for (const rule of RULES) {
      const value = rule.regex.exec(content)?.[1];
      if (!value || isPlaceholder(value) || (rule.validate && !rule.validate(value))) continue;
      matched = true;
      const shown = rule.id === "secrets/private-key" ? "a PEM private key header" : `\`${mask(value)}\``;
      issues.push(
        checkIssue(
          {
            ruleId: rule.id,
            severity: "critical",
            file: file.path,
            line,
            title: `Hardcoded ${rule.name}`,
            message: `Possible ${rule.name} added (${shown}). Committed secrets must be considered leaked.`,
            suggestion: SUGGESTION,
          },
          content,
        ),
      );
    }
    if (matched) continue;
    const generic = genericMatch(content);
    if (generic) {
      issues.push(
        checkIssue(
          {
            ruleId: "secrets/generic",
            severity: "critical",
            file: file.path,
            line,
            title: `Hardcoded secret in \`${generic.key}\``,
            message: `\`${generic.key}\` is assigned a literal that looks like a real credential (\`${mask(generic.value)}\`). Committed secrets must be considered leaked.`,
            suggestion: SUGGESTION,
          },
          content,
        ),
      );
    }
  }
  return issues;
}

export const secretsCheck: Check = {
  id: "secrets",
  description: "Detects credentials (cloud/API keys, tokens, private keys, high-entropy passwords) in added lines.",
  run: (files) => files.filter((f) => !f.binary).flatMap(scanFile),
};
