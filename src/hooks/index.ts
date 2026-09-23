import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { GitError } from "../git/index.js";

const execFileAsync = promisify(execFile);

export type HookKind = "pre-commit" | "pre-push";
export const HOOK_KINDS: readonly HookKind[] = ["pre-commit", "pre-push"];

export const BLOCK_START = "# >>> acr >>>";
export const BLOCK_END = "# <<< acr <<<";
const BLOCK_RE = /\n*# >>> acr >>>\n[\s\S]*?# <<< acr <<<\n?/;
const SHEBANG = "#!/bin/sh";

const REVIEW_ARGS: Record<HookKind, string> = {
  "pre-commit": "review --staged --hook",
  "pre-push": "review --range --hook",
};

const BYPASS: Record<HookKind, string> = {
  "pre-commit": "git commit --no-verify",
  "pre-push": "git push --no-verify",
};

export function hookBlock(kind: HookKind): string {
  const args = REVIEW_ARGS[kind];
  return [
    BLOCK_START,
    `# Managed by acr (AI code review). Remove with: acr hook uninstall ${kind}`,
    `# Skip once with: ${BYPASS[kind]}`,
    // Cheapest first: the repo's own install, then a global one. npx is probed (offline, fast) because
    // its "not installed" exit code (1) is indistinguishable from "issues found" and would block the commit.
    'acr_bin="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/node_modules/.bin/acr"',
    'if [ -x "$acr_bin" ]; then',
    `  "$acr_bin" ${args} || exit $?`,
    "elif command -v acr >/dev/null 2>&1; then",
    `  acr ${args} || exit $?`,
    "elif npx --no-install --offline acr --version >/dev/null 2>&1; then",
    `  npx --no-install acr ${args} || exit $?`,
    "else",
    `  echo "acr: not installed, skipping review (npm i -D acr-review)" >&2`,
    "fi",
    BLOCK_END,
    "",
  ].join("\n");
}

/** Hooks dir as git sees it: honours core.hooksPath and worktrees. Husky's `.husky/_` maps to `.husky`. */
export async function hooksDir(cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
    }));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new GitError(stderr ? stderr.replace(/^fatal: /, "") : "git is not installed or not on PATH", {
      cause: err,
      stderr,
    });
  }
  const dir = resolve(cwd, stdout.trim());
  if (basename(dir) === "_" && basename(dirname(dir)) === ".husky") return dirname(dir);
  return dir;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function makeExecutable(path: string): Promise<void> {
  const { mode } = await stat(path);
  await chmod(path, mode | 0o755);
}

export async function installHook(
  kind: HookKind,
  opts: { cwd: string; force?: boolean },
): Promise<{ path: string; action: "created" | "updated" | "skipped" }> {
  const dir = await hooksDir(opts.cwd);
  const path = join(dir, kind);
  const block = hookBlock(kind);
  const current = await readIfExists(path);

  let next: string;
  let action: "created" | "updated" | "skipped";
  if (current === null || opts.force) {
    next = `${SHEBANG}\n\n${block}`;
    action = current === null ? "created" : "updated";
  } else if (BLOCK_RE.test(current)) {
    next = current.replace(BLOCK_RE, (match) => `${match.match(/^\n*/)?.[0] ?? ""}${block}`);
    action = next === current ? "skipped" : "updated";
  } else {
    const base = current.length === 0 ? `${SHEBANG}\n` : current.endsWith("\n") ? current : `${current}\n`;
    next = `${base}\n${block}`;
    action = "updated";
  }

  if (action !== "skipped") {
    await mkdir(dir, { recursive: true });
    await writeFile(path, next);
  }
  await makeExecutable(path);
  return { path, action };
}

/** Removes only the acr block; deletes the file if nothing but the shebang is left. */
export async function uninstallHook(kind: HookKind, opts: { cwd: string }): Promise<boolean> {
  const path = join(await hooksDir(opts.cwd), kind);
  const current = await readIfExists(path);
  if (current === null || !BLOCK_RE.test(current)) return false;
  const next = current.replace(BLOCK_RE, "\n");
  const rest = next.replace(/^#!.*\n?/, "").trim();
  if (!rest) await rm(path);
  else await writeFile(path, next.replace(/\n+$/, "\n"));
  return true;
}

export async function hookStatus(
  kind: HookKind,
  opts: { cwd: string },
): Promise<{ path: string; installed: boolean }> {
  const path = join(await hooksDir(opts.cwd), kind);
  const current = await readIfExists(path);
  return { path, installed: current !== null && BLOCK_RE.test(current) };
}
