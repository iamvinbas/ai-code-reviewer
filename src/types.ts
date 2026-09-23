/**
 * Shared contracts between modules. Owned by the PM.
 * Workstream agents MUST NOT change this file — request changes from the PM.
 */

// ─── Severity ────────────────────────────────────────────────────────────────

export type Severity = "critical" | "warning" | "suggestion";

export const SEVERITIES: readonly Severity[] = ["critical", "warning", "suggestion"];

/** Higher = more severe. */
export const SEVERITY_RANK: Record<Severity, number> = {
  suggestion: 0,
  warning: 1,
  critical: 2,
};

// ─── Git / diff ──────────────────────────────────────────────────────────────

/** What to review. */
export type DiffTarget =
  /** Changes in the index (what `git commit` would record). Default. */
  | { kind: "staged" }
  /** All uncommitted changes (index + working tree) vs HEAD. */
  | { kind: "working" }
  /** Pre-merge / pre-push: merge-base(base, head)..head. head defaults to HEAD. */
  | { kind: "range"; base: string; head?: string }
  /** A single commit vs its first parent. */
  | { kind: "commit"; sha: string };

export type DiffLineKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line text without the leading +/-/space marker and without trailing newline. */
  content: string;
  /** Line number in the old file; null for "add". */
  oldLine: number | null;
  /** Line number in the new file; null for "del". */
  newLine: number | null;
}

export interface Hunk {
  /** Raw "@@ -a,b +c,d @@ ctx" header line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileDiff {
  /** Path in the new tree (for deleted files: the old path). Repo-root relative, forward slashes. */
  path: string;
  /** Previous path for renames, else null. */
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

/** Where to read full file content from, for extra context. */
export type FileSource = "HEAD" | "INDEX" | "WORKTREE" | { ref: string };

/** Git access used by the review engine (injectable for tests). */
export interface GitApi {
  repoRoot(): Promise<string>;
  getDiff(target: DiffTarget, opts?: { contextLines?: number }): Promise<FileDiff[]>;
  /** Returns null if the file does not exist at that source. */
  readFile(path: string, source: FileSource): Promise<string | null>;
  /** Best-guess default base branch for range reviews (e.g. "origin/main"). */
  defaultBase(): Promise<string>;
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionOptions {
  /** Ask the provider for JSON output (response_format json_object) when supported. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMProvider {
  /** Preset name, e.g. "ollama". */
  readonly name: string;
  readonly model: string;
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
  /** Cheap reachability/auth/model check used by `acr doctor`. Throws LLMError on failure. */
  ping(): Promise<void>;
}

export type LLMErrorCode =
  | "unreachable" // connection refused / DNS / timeout
  | "auth" // 401/403 / missing api key
  | "rate_limit" // 429 after retries exhausted
  | "model_not_found"
  | "bad_response" // non-JSON, empty, malformed
  | "context_length"
  | "config" // invalid provider config (unknown preset, missing baseUrl/model)
  | "server"; // 5xx after retries exhausted

export class LLMError extends Error {
  constructor(
    public readonly code: LLMErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export type ProviderPreset =
  | "ollama"
  | "groq"
  | "gemini"
  | "openrouter"
  | "cerebras"
  | "openai-compatible";

export interface ProviderConfig {
  preset: ProviderPreset;
  /** Overrides the preset base URL (OpenAI-compatible, e.g. "http://localhost:11434/v1"). */
  baseUrl?: string;
  /** Overrides the preset default model. */
  model?: string;
  /** Name of the env var holding the API key. Overrides the preset default. Never the key itself. */
  apiKeyEnv?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

// ─── Issues & checks ─────────────────────────────────────────────────────────

export interface Issue {
  /**
   * Stable fingerprint (no line number, survives code moving): hash(source, rule, file, normalized code line),
   * where rule = ruleId for checks and the normalized title for AI issues. Used for dedupe/ignore.
   */
  id: string;
  source: "ai" | "check";
  /** For checks: e.g. "secrets/aws-access-key". For AI: optional category, e.g. "security". */
  ruleId?: string;
  severity: Severity;
  file: string;
  /** New-file line number, validated against the diff. null = file-level issue. */
  line: number | null;
  endLine?: number | null;
  /** One-line summary. */
  title: string;
  /** Explanation: what is wrong and why it matters. */
  message: string;
  /** How to fix, in prose. */
  suggestion?: string;
  /** Optional exact replacement for new-file lines [startLine, endLine] (inclusive). */
  fix?: { startLine: number; endLine: number; replacement: string };
}

export interface CheckContext {
  config: Config;
  git: GitApi;
}

/** Deterministic, offline check (no AI). */
export interface Check {
  id: string;
  description: string;
  run(files: FileDiff[], ctx: CheckContext): Issue[] | Promise<Issue[]>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export type FailOn = Severity | "never";

export interface Config {
  provider: ProviderConfig;
  /** Exit non-zero if any issue >= this severity. */
  failOn: FailOn;
  /** What to do when the review could not complete (LLM down, parse error...). */
  onError: "warn" | "fail";
  /** Glob patterns (picomatch). Empty include = everything. */
  include: string[];
  exclude: string[];
  /** Team conventions in natural language, injected into the prompt. */
  rules: string[];
  /** Language of AI explanations. */
  language: "en" | "it";
  /** Hard cap on files sent to the AI. */
  maxFiles: number;
  /** Token budget per AI request (diff + context). Larger diffs are chunked. */
  maxChunkTokens: number;
  /** Lines of surrounding context from the full file added around each hunk. */
  contextLines: number;
  ai: { enabled: boolean };
  checks: {
    secrets: boolean;
    conflictMarkers: boolean;
    debugStatements: boolean;
    largeFiles: { enabled: boolean; maxKb: number };
  };
  cache: { enabled: boolean; dir?: string };
  /** Issue ids to ignore (from .acr/ignore or config). */
  ignore: string[];
}

// ─── Review ──────────────────────────────────────────────────────────────────

export interface ReviewError {
  stage: "git" | "llm" | "parse" | "check" | "config";
  file?: string;
  message: string;
}

export interface ReviewStats {
  filesInDiff: number;
  filesReviewed: number;
  filesSkipped: number;
  chunks: number;
  cacheHits: number;
  durationMs: number;
  provider: string | null;
  model: string | null;
}

export interface ReviewResult {
  target: DiffTarget;
  issues: Issue[];
  errors: ReviewError[];
  /** True if every file that should have been reviewed by AI was reviewed. */
  complete: boolean;
  stats: ReviewStats;
}

export type ProgressEvent =
  | { type: "diff"; files: number }
  | { type: "checks:done"; issues: number }
  | { type: "chunk:start"; index: number; total: number; files: string[] }
  | { type: "chunk:done"; index: number; total: number; issues: number; cached: boolean }
  | { type: "chunk:error"; index: number; total: number; message: string };

export interface ReviewOptions {
  config: Config;
  target: DiffTarget;
  git: GitApi;
  /** null when AI is disabled (checks only). */
  provider: LLMProvider | null;
  onProgress?: (e: ProgressEvent) => void;
  signal?: AbortSignal;
}

// ─── Exit codes (CLI) ────────────────────────────────────────────────────────

export const EXIT = {
  OK: 0,
  /** Blocking issues found (>= failOn). */
  ISSUES: 1,
  /** Review incomplete and onError = "fail". */
  INCOMPLETE: 2,
  /** Usage / config error. */
  USAGE: 3,
} as const;
