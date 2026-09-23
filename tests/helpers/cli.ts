/*
 * Runs the acr CLI against a temp repo, either in-process (fast: calls `run(argv)` with captured
 * stdout/stderr and a swapped process.env) or as a real subprocess through tsx.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { run } from "../../src/cli/program.js";
import type { FakeLLM } from "./fake-llm.js";
import { isolatedGitEnv, makeTempDir, TempRepo } from "./repo.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_ENTRY = join(PROJECT_ROOT, "src", "cli", "index.ts");
export const TSX_LOADER = pathToFileURL(join(PROJECT_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

/** Env vars from the developer's machine that would change acr's behaviour. */
const SCRUB = /^(ACR_|OLLAMA_|OPENAI_|GROQ_|GEMINI_|OPENROUTER_|CEREBRAS_|ANTHROPIC_|XDG_|FORCE_COLOR$|NO_COLOR$|CI$)/;

/** Base env for acr: isolated git, private XDG config/cache dirs, no provider env from the host. */
export function acrEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = isolatedGitEnv();
  for (const k of Object.keys(env)) if (SCRUB.test(k)) delete env[k];
  return {
    ...env,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    NO_COLOR: "1",
    ...extra,
  };
}

let lock: Promise<unknown> = Promise.resolve();

/**
 * In-process run of `acr <args>`. process.env is replaced for the duration of the call and
 * stdout/stderr writes are captured. Calls are serialized (process-global state).
 */
export function runCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CliResult> {
  const task = lock.then(() => runCliUnlocked(args, opts));
  lock = task.catch(() => undefined);
  return task;
}

async function runCliUnlocked(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<CliResult> {
  const savedEnv = { ...process.env };
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture =
    (sink: string[]) =>
    (chunk: unknown, encOrCb?: unknown, cb?: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      const done = typeof encOrCb === "function" ? encOrCb : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, opts.env);
  process.stdout.write = capture(out) as typeof process.stdout.write;
  process.stderr.write = capture(err) as typeof process.stderr.write;
  try {
    const code = await run(["node", "acr", "-C", opts.cwd, ...args]);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
}

/** Real subprocess: `node --import tsx src/cli/index.ts <args>` with cwd = the temp repo. */
export function spawnCli(
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ["--import", TSX_LOADER, CLI_ENTRY, ...args],
      { cwd: opts.cwd, env: opts.env, encoding: "utf8", timeout: opts.timeoutMs ?? 20_000 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") return reject(error);
        const code = error ? ((error as { code?: number }).code ?? 1) : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

/**
 * A bin dir with an `acr` shim (runs this checkout through tsx) and an `npx` shim that always
 * fails, so installed hooks take their `command -v acr` branch deterministically and offline.
 */
export async function makeShimBin(parent: string): Promise<string> {
  const bin = join(parent, "bin");
  await mkdir(bin, { recursive: true });
  const acr = join(bin, "acr");
  await writeFile(acr, `#!/bin/sh\nexec "${process.execPath}" --import "${TSX_LOADER}" "${CLI_ENTRY}" "$@"\n`);
  await chmod(acr, 0o755);
  const npx = join(bin, "npx");
  await writeFile(npx, "#!/bin/sh\nexit 1\n");
  await chmod(npx, 0o755);
  return bin;
}

/** One isolated e2e world: temp repo + private HOME-ish dir for XDG config/cache. */
export class Sandbox {
  private constructor(
    readonly repo: TempRepo,
    readonly home: string,
  ) {}

  static async create(): Promise<Sandbox> {
    const home = await makeTempDir("acr-home-");
    const repo = await TempRepo.create();
    return new Sandbox(repo, home);
  }

  get cacheDir(): string {
    return join(this.home, "cache", "acr");
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return acrEnv(this.home, extra);
  }

  /** In-process `acr <args>` in the repo. */
  acr(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
    return runCli(args, { cwd: this.repo.dir, env: this.env(extraEnv) });
  }

  /** `acr review --format json ...`, parsed. */
  async reviewJson(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult & { json: JsonReport }> {
    const res = await this.acr(["review", "--format", "json", ...args], extraEnv);
    let json: JsonReport;
    try {
      json = JSON.parse(res.stdout) as JsonReport;
    } catch {
      throw new Error(`stdout is not JSON (exit ${res.code}):\n${res.stdout}\n--- stderr:\n${res.stderr}`);
    }
    return { ...res, json };
  }

  /** Writes .acr.yml pointing at the fake server (openai-compatible), plus extra options. */
  async configure(fake: FakeLLM | null, extra: Record<string, unknown> = {}): Promise<void> {
    const provider = fake
      ? { preset: "openai-compatible", baseUrl: fake.baseUrl, model: "fake", maxRetries: 0, timeoutMs: 5000 }
      : undefined;
    const extraProvider = (extra.provider ?? {}) as Record<string, unknown>;
    const doc: Record<string, unknown> = { ...extra };
    if (provider || extra.provider) doc.provider = { ...provider, ...extraProvider };
    await this.repo.write({ ".acr.yml": stringify(doc) });
  }

  async cleanup(): Promise<void> {
    await this.repo.cleanup();
    await rm(this.home, { recursive: true, force: true });
  }
}

export interface JsonIssue {
  id: string;
  source: "ai" | "check";
  ruleId?: string;
  severity: "critical" | "warning" | "suggestion";
  file: string;
  line: number | null;
  endLine?: number | null;
  title: string;
  message: string;
  suggestion?: string;
  fix?: { startLine: number; endLine: number; replacement: string };
}

export interface JsonReport {
  version: number;
  target: { kind: string; base?: string; head?: string; sha?: string };
  complete: boolean;
  issues: JsonIssue[];
  errors: Array<{ stage: string; file?: string; message: string }>;
  stats: {
    filesInDiff: number;
    filesReviewed: number;
    filesSkipped: number;
    chunks: number;
    cacheHits: number;
    durationMs: number;
    provider: string | null;
    model: string | null;
  };
}
