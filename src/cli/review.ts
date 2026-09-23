import pc from "picocolors";
import { loadConfig, ConfigError } from "../config/index.js";
import { createGit } from "../git/index.js";
import { createProvider } from "../llm/index.js";
import { exitCodeFor, formatJson, formatMarkdown, formatPretty } from "../report/index.js";
import { sanitize } from "../report/common.js";
import { runReview } from "../review/index.js";
import {
  EXIT,
  LLMError,
  type Config,
  type DiffTarget,
  type LLMProvider,
  type ReviewError,
  type ReviewResult,
} from "../types.js";
import { resolveTarget, reviewOverrides, type ReviewCliOptions } from "./options.js";
import { createProgress, describeProgress } from "./progress.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const processIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

function emptyResult(target: DiffTarget): ReviewResult {
  return {
    target,
    issues: [],
    errors: [],
    complete: true,
    stats: {
      filesInDiff: 0,
      filesReviewed: 0,
      filesSkipped: 0,
      chunks: 0,
      cacheHits: 0,
      durationMs: 0,
      provider: null,
      model: null,
    },
  };
}

function nothingToReview(target: DiffTarget): string {
  switch (target.kind) {
    case "staged":
      return "Nothing staged to review. Stage changes with `git add`, or review all uncommitted changes with `acr review --working`.";
    case "working":
      return "No uncommitted changes to review.";
    case "range":
      return `No changes between ${target.base} and ${target.head ?? "HEAD"}.`;
    case "commit":
      return `Commit ${target.sha} has no reviewable changes.`;
  }
}

/** Builds the provider; a missing key or an unreachable endpoint (hook mode) degrades to checks only. */
async function buildProvider(
  config: Config,
  ping: boolean,
): Promise<{ provider: LLMProvider | null; errors: ReviewError[] }> {
  if (!config.ai.enabled) return { provider: null, errors: [] };
  let provider: LLMProvider;
  try {
    provider = createProvider(config.provider);
  } catch (err) {
    if (err instanceof LLMError && err.code !== "config") {
      return { provider: null, errors: [{ stage: "llm", message: err.message }] };
    }
    throw new ConfigError(`provider: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ping) {
    try {
      await provider.ping();
    } catch (err) {
      if (err instanceof LLMError) return { provider: null, errors: [{ stage: "llm", message: err.message }] };
      throw err;
    }
  }
  return { provider, errors: [] };
}

function hookHint(result: ReviewResult, code: number, config: Config): string | null {
  const action = result.target.kind === "range" ? "push" : "commit";
  if (code === EXIT.ISSUES) {
    return (
      `acr: ${action} blocked (issues at or above failOn: ${config.failOn}). ` +
      `Fix them, run \`acr ignore <id>\` for false positives, or skip once with \`git ${action} --no-verify\`.`
    );
  }
  if (code === EXIT.INCOMPLETE) {
    return `acr: ${action} blocked because the review is incomplete (onError: fail). Skip once with \`git ${action} --no-verify\`.`;
  }
  if (!result.complete) return `acr: review incomplete, continuing (onError: warn).`;
  return null;
}

export async function reviewCommand(opts: ReviewCliOptions, cwd: string, io: Io = processIo): Promise<number> {
  const format = opts.format ?? "pretty";
  const color = opts.color !== false && pc.isColorSupported;
  const c = pc.createColors(color);

  const { config, warnings } = await loadConfig({ cwd, flags: reviewOverrides(opts) });
  for (const warning of warnings) io.err(`${c.yellow("warning:")} ${warning}`);

  try {
    const git = createGit(cwd);
    const target = await resolveTarget(opts, git);

    const files = await git.getDiff(target, { contextLines: 0 });
    if (files.length === 0) {
      if (format === "json") io.out(formatJson(emptyResult(target)));
      else if (format === "markdown") io.out(formatMarkdown(emptyResult(target)));
      else if (!opts.hook) io.err(nothingToReview(target));
      return EXIT.OK;
    }

    const progress = createProgress(process.stderr, format === "pretty");
    const onSigint = () => {
      progress.stop();
      process.exit(130);
    };
    process.once("SIGINT", onSigint);

    let result: ReviewResult;
    try {
      if (config.ai.enabled) progress.update(opts.hook ? "Checking AI provider…" : "Preparing review…");
      const { provider, errors } = await buildProvider(config, Boolean(opts.hook));
      result = await runReview({
        config,
        target,
        git,
        provider,
        onProgress: (e) => progress.update(sanitize(describeProgress(e))),
      });
      if (errors.length) result = { ...result, errors: [...errors, ...result.errors], complete: false };
    } finally {
      progress.stop();
      process.off("SIGINT", onSigint);
    }

    if (format === "json") io.out(formatJson(result));
    else if (format === "markdown") io.out(formatMarkdown(result));
    else io.out(formatPretty(result, { color, verbose: opts.verbose, compact: opts.hook }));

    const code = exitCodeFor(result, config);
    if (opts.hook) {
      const hint = hookHint(result, code, config);
      if (hint) io.err(code === EXIT.OK ? c.yellow(hint) : c.red(hint));
    } else if (format === "pretty" && result.issues.length) {
      io.out(c.dim("False positive? `acr ignore <id>` · more detail: --verbose"));
    }
    return code;
  } catch (err) {
    if (!opts.hook || err instanceof ConfigError) throw err;
    // A broken hook must not lock people out of committing: degrade according to onError.
    const message = err instanceof Error ? err.message : String(err);
    const code = config.onError === "fail" ? EXIT.INCOMPLETE : EXIT.OK;
    io.err(c.yellow(`acr: review failed (${message}); ${code === EXIT.OK ? "not blocking" : "blocking (onError: fail)"}.`));
    return code;
  }
}
