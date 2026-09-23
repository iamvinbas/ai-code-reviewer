import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { DiffTarget, FileDiff, FileSource, GitApi } from "../types.js";
import { GitError } from "./errors.js";
import { execGit, type ExecResult } from "./exec.js";
import { parseUnifiedDiff } from "./parse.js";

const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;

/** Neutralise user config that would change the shape of the diff output. */
const DIFF_CONFIG = [
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false",
];

const DEFAULT_BASES: ReadonlyArray<readonly [name: string, fullRef: string]> = [
  ["origin/main", "refs/remotes/origin/main"],
  ["origin/master", "refs/remotes/origin/master"],
  ["main", "refs/heads/main"],
  ["master", "refs/heads/master"],
];

export interface GitClientOptions {
  /** git executable (tests use this to simulate a missing git). */
  bin?: string;
}

function describeFailure(args: string[], res: ExecResult): string {
  const msg = res.stderr.trim() || `exit code ${res.code}`;
  return `git ${args.join(" ")} failed: ${msg}`;
}

function assertRefSyntax(ref: string): void {
  if (ref.trim() === "" || ref.startsWith("-")) {
    throw new GitError(`Invalid git revision "${ref}".`);
  }
}

export function createGitClient(cwd: string, opts: GitClientOptions = {}): GitApi {
  const bin = opts.bin ?? "git";
  let rootPromise: Promise<string> | null = null;
  let emptyTreePromise: Promise<string> | null = null;

  const run = (args: string[], dir: string): Promise<ExecResult> => execGit(bin, args, dir);

  async function runOk(args: string[], dir: string): Promise<string> {
    const res = await run(args, dir);
    if (res.code !== 0) {
      throw new GitError(describeFailure(args, res), { stderr: res.stderr, exitCode: res.code });
    }
    return res.stdout;
  }

  async function resolveRoot(): Promise<string> {
    const dir = resolve(cwd);
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new GitError(`Directory not found: ${dir}`);

    const args = ["rev-parse", "--show-toplevel"];
    const res = await run(args, dir);
    if (res.code !== 0) {
      if (/not a git repository/i.test(res.stderr)) {
        throw new GitError(
          `Not a git repository: ${dir}. Run acr inside a git repository (or run \`git init\` first).`,
          { stderr: res.stderr, exitCode: res.code },
        );
      }
      throw new GitError(describeFailure(args, res), { stderr: res.stderr, exitCode: res.code });
    }
    const top = res.stdout.trim();
    if (!top) throw new GitError(`Not inside a git work tree: ${dir} (bare repository?).`);
    return top;
  }

  function repoRoot(): Promise<string> {
    rootPromise ??= resolveRoot().catch((err: unknown) => {
      rootPromise = null; // don't cache failures: the user may `git init` and retry
      throw err;
    });
    return rootPromise;
  }

  async function emptyTree(root: string): Promise<string> {
    emptyTreePromise ??= run(["rev-parse", "--show-object-format"], root).then((res) =>
      res.code === 0 && res.stdout.trim() === "sha256" ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1,
    );
    return emptyTreePromise;
  }

  /** Full commit id for `ref`, or null if it doesn't resolve to a commit. */
  async function tryResolveCommit(root: string, ref: string): Promise<string | null> {
    const res = await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
    return res.code === 0 ? res.stdout.trim() || null : null;
  }

  async function resolveCommit(root: string, ref: string): Promise<string> {
    assertRefSyntax(ref);
    const sha = await tryResolveCommit(root, ref);
    if (!sha) throw new GitError(`Unknown git revision "${ref}": no such branch, tag or commit.`);
    return sha;
  }

  /** Revision arguments for `git diff` for each target kind. */
  async function diffRevs(root: string, target: DiffTarget): Promise<string[]> {
    switch (target.kind) {
      case "staged":
        return ["--cached"]; // works on an unborn branch too
      case "working": {
        const head = await tryResolveCommit(root, "HEAD");
        return [head ?? (await emptyTree(root))];
      }
      case "range": {
        const headRef = target.head ?? "HEAD";
        const base = await resolveCommit(root, target.base);
        const head = await resolveCommit(root, headRef);
        const res = await run(["merge-base", base, head], root);
        if (res.code !== 0 || !res.stdout.trim()) {
          throw new GitError(`No common ancestor between "${target.base}" and "${headRef}".`, {
            stderr: res.stderr,
            exitCode: res.code,
          });
        }
        return [res.stdout.trim(), head];
      }
      case "commit": {
        const sha = await resolveCommit(root, target.sha);
        const parent = await tryResolveCommit(root, `${sha}^1`);
        return [parent ?? (await emptyTree(root)), sha];
      }
    }
  }

  async function getDiff(target: DiffTarget, opts: { contextLines?: number } = {}): Promise<FileDiff[]> {
    const contextLines = opts.contextLines ?? 3;
    if (!Number.isInteger(contextLines) || contextLines < 0) {
      throw new GitError(`contextLines must be a non-negative integer (got ${contextLines}).`);
    }
    const root = await repoRoot();
    const revs = await diffRevs(root, target);
    const out = await runOk(
      [
        ...DIFF_CONFIG,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        `--unified=${contextLines}`,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ...revs,
        "--",
      ],
      root,
    );
    return parseUnifiedDiff(out);
  }

  async function readWorktree(root: string, path: string): Promise<string | null> {
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null; // outside the repo
    try {
      const st = await lstat(abs);
      // Match git's view of a symlink: its content is the link target.
      if (st.isSymbolicLink()) return await readlink(abs, "utf8");
      if (!st.isFile()) return null;
      return await readFile(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
      throw err;
    }
  }

  async function readFileAt(path: string, source: FileSource): Promise<string | null> {
    const root = await repoRoot();
    const rel = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    if (source === "WORKTREE") return readWorktree(root, rel);

    let spec: string;
    if (source === "HEAD") spec = `HEAD:${rel}`;
    else if (source === "INDEX") spec = `:0:${rel}`; // explicit stage avoids ":1:foo"-style ambiguity
    else {
      assertRefSyntax(source.ref);
      spec = `${source.ref}:${rel}`;
    }
    // cat-file (plumbing) returns raw blob bytes: no textconv/filters, unlike `git show`.
    const res = await run(["cat-file", "blob", spec], root);
    return res.code === 0 ? res.stdout : null;
  }

  async function defaultBase(): Promise<string> {
    const root = await repoRoot();
    const sym = await run(["rev-parse", "--abbrev-ref", "origin/HEAD"], root);
    const target = sym.stdout.trim();
    if (sym.code === 0 && target && target !== "origin/HEAD" && (await tryResolveCommit(root, target))) {
      return target;
    }
    for (const [name, fullRef] of DEFAULT_BASES) {
      if (await tryResolveCommit(root, fullRef)) return name;
    }
    throw new GitError(
      "Could not determine the default base branch (tried origin/HEAD, origin/main, origin/master, main, master). " +
        "Pass it explicitly, e.g. `acr review --range <branch>`.",
    );
  }

  return { repoRoot, getDiff, readFile: readFileAt, defaultBase };
}
