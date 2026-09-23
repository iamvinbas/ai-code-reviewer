import { builtinChecks } from "../checks/index.js";
import {
  LLMError,
  SEVERITY_RANK,
  type ChatMessage,
  type Config,
  type DiffTarget,
  type FileDiff,
  type FileSource,
  type GitApi,
  type Issue,
  type LLMErrorCode,
  type LLMProvider,
  type ProgressEvent,
  type ReviewError,
  type ReviewOptions,
  type ReviewResult,
  type ReviewStats,
} from "../types.js";
import { cacheKey, resolveCacheDir, ReviewCache } from "./cache.js";
import { buildChunks, type Chunk } from "./chunk.js";
import { dropAiDuplicatesOfChecks } from "./cross-dedupe.js";
import { createUserFilter, isDefaultSkipped } from "./filter.js";
import { type ParseOutcome, parseResponse } from "./parse.js";
import { buildMessages, buildSystemPrompt, correctionMessage, promptOverhead } from "./prompt.js";
import { resolveIssues } from "./validate.js";

export { fingerprint } from "./fingerprint.js";
export { PROMPT_VERSION } from "./prompt.js";
export { renderFileForPrompt } from "./render.js";

/** Floor for the diff budget per chunk, whatever maxChunkTokens says. */
const MIN_DIFF_BUDGET = 256;
/** Max chars of a bad reply echoed back in the correction retry. */
const MAX_ECHO_CHARS = 4000;

/** Errors that will repeat for every chunk: stop instead of hammering the provider. */
const FATAL_LLM_CODES: ReadonlySet<LLMErrorCode> = new Set(["unreachable", "auth", "config"]);

const listFiles = (files: readonly string[], max = 10): string =>
  files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function sourceFor(target: DiffTarget): FileSource {
  switch (target.kind) {
    case "staged":
      return "INDEX";
    case "working":
      return "WORKTREE";
    case "range":
      return { ref: target.head ?? "HEAD" };
    case "commit":
      return { ref: target.sha };
  }
}

async function repoRootOrCwd(git: GitApi): Promise<string> {
  try {
    return await git.repoRoot();
  } catch {
    return process.cwd();
  }
}

function finalizeIssues(issues: readonly Issue[], ignore: readonly string[]): Issue[] {
  const ignored = new Set(ignore);
  const byId = new Map<string, Issue>();
  for (const issue of dropAiDuplicatesOfChecks(issues)) {
    if (ignored.has(issue.id)) continue;
    const existing = byId.get(issue.id);
    if (!existing || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[existing.severity]) byId.set(issue.id, issue);
  }
  return [...byId.values()].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

async function readContents(
  git: GitApi,
  files: readonly FileDiff[],
  source: FileSource,
  contextLines: number,
): Promise<Map<string, string | null>> {
  const contents = new Map<string, string | null>();
  if (contextLines <= 0) return contents;
  for (const file of files) {
    try {
      contents.set(file.path, await git.readFile(file.path, source));
    } catch {
      contents.set(file.path, null);
    }
  }
  return contents;
}

async function askModel(
  provider: LLMProvider,
  systemPrompt: string,
  chunk: Chunk,
  language: Config["language"],
  signal: AbortSignal | undefined,
): Promise<ParseOutcome> {
  const messages = buildMessages(systemPrompt, chunk.text, language);
  const opts = { json: true, temperature: 0, ...(signal ? { signal } : {}) };
  const first = await provider.complete(messages, opts);
  const firstOutcome = parseResponse(first.text);
  if (firstOutcome.ok && firstOutcome.dropped.length === 0) return firstOutcome;

  const problem = firstOutcome.ok ? `invalid issues: ${firstOutcome.dropped.join(" | ")}` : firstOutcome.error;
  const retry: ChatMessage[] = [
    ...messages,
    { role: "assistant", content: first.text.slice(0, MAX_ECHO_CHARS) },
    { role: "user", content: correctionMessage(problem, language) },
  ];
  const second = parseResponse((await provider.complete(retry, opts)).text);
  return second.ok || !firstOutcome.ok ? second : firstOutcome;
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const { config, target, git, signal } = opts;
  const provider = config.ai.enabled ? opts.provider : null;
  const emit = (event: ProgressEvent): void => {
    try {
      opts.onProgress?.(event);
    } catch {
      // progress reporting must never break the review
    }
  };
  const errors: ReviewError[] = [];
  const issues: Issue[] = [];
  let complete = true;
  const stats: ReviewStats = {
    filesInDiff: 0,
    filesReviewed: 0,
    filesSkipped: 0,
    chunks: 0,
    cacheHits: 0,
    durationMs: 0,
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
  };
  const finish = (): ReviewResult => ({
    target,
    issues: finalizeIssues(issues, config.ignore),
    errors,
    complete,
    stats: { ...stats, durationMs: Date.now() - started },
  });

  let diff: FileDiff[];
  try {
    diff = await git.getDiff(target, { contextLines: 3 });
  } catch (e) {
    errors.push({ stage: "git", message: errorMessage(e) });
    complete = false;
    return finish();
  }
  stats.filesInDiff = diff.length;
  emit({ type: "diff", files: diff.length });

  const present = diff.filter((f) => f.status !== "deleted");
  const accept = createUserFilter(config);
  const checked = present.filter((f) => accept(f.path));

  for (const check of builtinChecks(config)) {
    try {
      issues.push(...(await check.run(checked, { config, git })));
    } catch (e) {
      errors.push({ stage: "check", message: `${check.id}: ${errorMessage(e)}` });
      complete = false;
    }
  }
  emit({ type: "checks:done", issues: issues.length });

  if (!provider) {
    stats.filesReviewed = checked.length;
    stats.filesSkipped = present.length - checked.length;
    return finish();
  }

  const aiFiles = checked
    .filter((f) => !f.binary && f.hunks.length > 0 && !isDefaultSkipped(f.path))
    .slice(0, Math.max(0, config.maxFiles));
  stats.filesReviewed = aiFiles.length;
  stats.filesSkipped = present.length - aiFiles.length;
  if (aiFiles.length === 0) return finish();

  const contents = await readContents(git, aiFiles, sourceFor(target), config.contextLines);
  const systemPrompt = buildSystemPrompt(config);
  const budget = Math.max(MIN_DIFF_BUDGET, config.maxChunkTokens - promptOverhead(systemPrompt, config.language));
  const { chunks, errors: chunkErrors } = buildChunks(aiFiles, contents, config.contextLines, budget);
  if (chunkErrors.length > 0) {
    errors.push(...chunkErrors);
    complete = false;
  }
  stats.chunks = chunks.length;

  const cache = config.cache.enabled ? new ReviewCache(resolveCacheDir(config, await repoRootOrCwd(git))) : null;
  const total = chunks.length;

  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted) {
      errors.push({ stage: "llm", message: `review aborted: ${total - index} chunk(s) not reviewed` });
      complete = false;
      break;
    }
    emit({ type: "chunk:start", index, total, files: chunk.files });
    const chunkFile = chunk.files.length === 1 ? chunk.files[0] : undefined;
    const fail = (stage: ReviewError["stage"], message: string, perFile: boolean): void => {
      if (perFile) for (const file of chunk.files) errors.push({ stage, file, message });
      else errors.push({ stage, message, ...(chunkFile ? { file: chunkFile } : {}) });
      complete = false;
      emit({ type: "chunk:error", index, total, message });
    };

    const key = cacheKey({
      provider: provider.name,
      model: provider.model,
      language: config.language,
      rules: config.rules,
      chunkText: chunk.text,
    });
    const cached = cache ? await cache.get(key) : null;
    if (cached) {
      const resolved = resolveIssues(cached, chunk.parts);
      issues.push(...resolved);
      stats.cacheHits++;
      emit({ type: "chunk:done", index, total, issues: resolved.length, cached: true });
      continue;
    }

    let outcome: ParseOutcome;
    try {
      outcome = await askModel(provider, systemPrompt, chunk, config.language, signal);
    } catch (e) {
      if (signal?.aborted) {
        fail("llm", `review aborted: ${total - index} chunk(s) not reviewed`, false);
        break;
      }
      fail("llm", errorMessage(e), true);
      if (!(e instanceof LLMError && FATAL_LLM_CODES.has(e.code))) continue;
      const skipped = [...new Set(chunks.slice(index + 1).flatMap((c) => c.files))];
      if (skipped.length > 0) {
        errors.push({
          stage: "llm",
          message: `${total - index - 1} remaining chunk(s) skipped after this error; not reviewed: ${listFiles(skipped)}`,
        });
      }
      break;
    }

    if (!outcome.ok) {
      fail("parse", `invalid AI response after retry: ${outcome.error}`, true);
      continue;
    }
    if (outcome.dropped.length > 0) {
      errors.push({
        stage: "parse",
        ...(chunkFile ? { file: chunkFile } : {}),
        message: `${outcome.dropped.length} malformed AI issue(s) discarded: ${outcome.dropped.join(" | ")}`,
      });
    } else if (cache) {
      await cache.set(key, outcome.issues);
    }
    const resolved = resolveIssues(outcome.issues, chunk.parts);
    issues.push(...resolved);
    emit({ type: "chunk:done", index, total, issues: resolved.length, cached: false });
  }

  return finish();
}

