/* Temporary git repositories for e2e tests. Never touches the user's global git config. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Env vars that would redirect git (e.g. when the suite itself runs inside a git hook). */
const GIT_LEAK_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
];

/** Env for any git process in tests: no global/system config, no prompts, stable output. */
export function isolatedGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of GIT_LEAK_VARS) delete env[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    LC_ALL: "C",
    ...extra,
  };
}

export async function makeTempDir(prefix = "acr-e2e-"): Promise<string> {
  // realpath: macOS /var → /private/var, so paths printed by git match ours.
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class TempRepo {
  private constructor(
    readonly dir: string,
    readonly env: NodeJS.ProcessEnv,
  ) {}

  static async create(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<TempRepo> {
    const dir = await makeTempDir();
    const repo = new TempRepo(dir, isolatedGitEnv(opts.env));
    await repo.git("init", "-q", "-b", "main");
    await repo.git("config", "user.name", "acr test");
    await repo.git("config", "user.email", "acr-test@example.invalid");
    await repo.git("config", "commit.gpgsign", "false");
    await repo.git("config", "core.autocrlf", "false");
    return repo;
  }

  path(rel: string): string {
    return join(this.dir, rel);
  }

  /** Runs git; throws on non-zero exit. */
  async git(...args: string[]): Promise<string> {
    const res = await this.gitRaw(args);
    if (res.code !== 0) throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr || res.stdout}`);
    return res.stdout;
  }

  /** Runs git (async: an in-process fake server keeps serving); never throws on exit code. */
  async gitRaw(args: string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.dir,
        env: { ...this.env, ...env },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string; message: string };
      if (typeof e.code !== "number") throw err;
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  async write(files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const abs = this.path(rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
  }

  async stage(...paths: string[]): Promise<void> {
    await this.git("add", "--", ...(paths.length ? paths : ["."]));
  }

  async writeAndStage(files: Record<string, string>): Promise<void> {
    await this.write(files);
    await this.stage(...Object.keys(files));
  }

  /** Writes, stages and commits; returns the new commit sha. */
  async commit(files: Record<string, string>, message = "commit"): Promise<string> {
    if (Object.keys(files).length) await this.writeAndStage(files);
    await this.git("commit", "-q", "--no-verify", "--allow-empty", "-m", message);
    return (await this.git("rev-parse", "HEAD")).trim();
  }

  async branch(name: string): Promise<void> {
    await this.git("checkout", "-q", "-b", name);
  }

  async checkout(name: string): Promise<void> {
    await this.git("checkout", "-q", name);
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
