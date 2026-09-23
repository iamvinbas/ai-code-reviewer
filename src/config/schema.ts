import { z } from "zod";
import type { Config } from "../types.js";

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Partial config as written in a YAML file, env or CLI flags. */
export type ConfigOverrides = DeepPartial<Config>;

export const PRESET_NAMES = ["ollama", "groq", "gemini", "openrouter", "cerebras", "openai-compatible"] as const;
export const FAIL_ON_VALUES = ["critical", "warning", "suggestion", "never"] as const;
export const LANGUAGES = ["en", "it"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const int = (min: number) => z.number().int().min(min);
const strings = z.array(z.string());

const providerSchema = z.strictObject({
  preset: z.enum(PRESET_NAMES).optional(),
  baseUrl: z.string().refine(isHttpUrl, "must be an http(s) URL").optional(),
  model: z.string().min(1).optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name (the key itself never goes in config)")
    .optional(),
  timeoutMs: int(1).optional(),
  maxRetries: int(0).max(10).optional(),
});

export const overridesSchema = z.strictObject({
  provider: providerSchema.optional(),
  failOn: z.enum(FAIL_ON_VALUES).optional(),
  onError: z.enum(["warn", "fail"]).optional(),
  include: strings.optional(),
  exclude: strings.optional(),
  rules: strings.optional(),
  language: z.enum(LANGUAGES).optional(),
  maxFiles: int(1).optional(),
  maxChunkTokens: int(500).optional(),
  contextLines: int(0).optional(),
  ai: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  checks: z
    .strictObject({
      secrets: z.boolean().optional(),
      conflictMarkers: z.boolean().optional(),
      debugStatements: z.boolean().optional(),
      largeFiles: z.strictObject({ enabled: z.boolean().optional(), maxKb: int(1).optional() }).optional(),
    })
    .optional(),
  cache: z.strictObject({ enabled: z.boolean().optional(), dir: z.string().min(1).optional() }).optional(),
  ignore: strings.optional(),
});

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

const article = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/** YAML `key:` with no value (e.g. only commented examples below) means "not set". */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const path = formatPath(issue.path);
  const subject = path || "config";
  switch (issue.code) {
    case "invalid_value":
      return `${subject} must be one of ${issue.values.map(String).join("|")}`;
    case "unrecognized_keys":
      return issue.keys
        .map((k) => `unknown option "${path ? `${path}.${k}` : k}"`)
        .join(", ");
    case "invalid_type":
      return `${subject} must be ${article(issue.expected === "int" ? "integer" : issue.expected)}`;
    case "too_small":
      return `${subject} must be >= ${String(issue.minimum)}`;
    case "too_big":
      return `${subject} must be <= ${String(issue.maximum)}`;
    default:
      return `${subject} ${issue.message}`;
  }
}

/** Validates a partial config; throws ConfigError prefixed with `label` (e.g. ".acr.yml"). */
export function parseOverrides(input: unknown, label: string): ConfigOverrides {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError(`${label}: expected a mapping of options (key: value)`);
  }
  const result = overridesSchema.safeParse(stripNulls(input));
  if (!result.success) {
    const messages = result.error.issues.map(describeIssue);
    throw new ConfigError(`${label}: ${messages.join("; ")}`);
  }
  return result.data as ConfigOverrides;
}
