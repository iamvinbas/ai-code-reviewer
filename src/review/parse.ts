import { z } from "zod";
import { SEVERITIES } from "../types.js";

const toNumber = (v: unknown): unknown => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v);
const lineNumber = z.preprocess(toNumber, z.number().int().positive());
const optionalText = z.string().trim().optional().catch(undefined);

const rawIssueSchema = z.object({
  severity: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.enum(SEVERITIES as [string, ...string[]]),
  ),
  file: optionalText,
  line: lineNumber.nullable().optional(),
  endLine: lineNumber.nullable().optional().catch(null),
  category: optionalText,
  title: z.string().trim().min(1),
  message: z.string().trim().default(""),
  suggestion: optionalText,
  fix: z
    .object({ startLine: lineNumber, endLine: lineNumber, replacement: z.string() })
    .nullable()
    .optional()
    .catch(null),
});

export type RawIssue = z.infer<typeof rawIssueSchema> & { severity: (typeof SEVERITIES)[number] };

export const rawIssuesSchema = z.array(rawIssueSchema);

export type ParseOutcome =
  | { ok: true; issues: RawIssue[]; dropped: string[] }
  | { ok: false; error: string };

/** Index just past the balanced JSON value starting at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Tolerant JSON extraction: plain JSON, ```json fences, or the first balanced {…}/[…] in the text. */
export function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  for (const candidate of [trimmed, fenced?.trim()]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to scanning
    }
  }
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = balancedEnd(trimmed, i);
    if (end === -1) continue;
    try {
      return JSON.parse(trimmed.slice(i, end));
    } catch {
      // keep scanning
    }
  }
  throw new Error("the reply does not contain valid JSON");
}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "value"}: ${i.message}`)
    .join("; ");
}

export function validateIssues(value: unknown): ParseOutcome {
  let list: unknown = value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    list = (value as Record<string, unknown>).issues;
  }
  if (!Array.isArray(list)) return { ok: false, error: 'expected an object with an "issues" array' };
  const issues: RawIssue[] = [];
  const dropped: string[] = [];
  list.forEach((item, index) => {
    const result = rawIssueSchema.safeParse(item);
    if (result.success) issues.push(result.data as RawIssue);
    else dropped.push(`issues[${index}]: ${describe(result.error)}`);
  });
  return { ok: true, issues, dropped };
}

export function parseResponse(text: string): ParseOutcome {
  let value: unknown;
  try {
    value = extractJsonValue(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return validateIssues(value);
}
