import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitClient } from "./client.js";
import { GitError, createGit } from "./index.js";

const exec = promisify(execFile);
const dirs: string[] = [];
const savedEnv = { ...process.env };

beforeAll(async () => {
  // Isolate from the developer's git config and from hook-provided env (e.g. GIT_INDEX_FILE).
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_CEILING_DIRECTORIES"]) {
    delete process.env[k];
  }
  const home = await tmp();
  const globalCfg = join(home, "gitconfig");
  await writeFile(globalCfg, "");
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(async () => {
  process.env = savedEnv;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "acr-git-test-")));
  dirs.push(d);
  return d;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

async function commitAll(root: string, msg: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD");
}

async function newRepo(): Promise<string> {
  const root = await tmp();
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "config", "core.autocrlf", "false");
  return root;
}

/** Repo with one commit on main: a.txt (5 lines), del.txt, mv-src.txt. */
async function seededRepo(): Promise<string> {
  const root = await newRepo();
  await write(root, "a.txt", "1\n2\n3\n4\n5\n");
  await write(root, "del.txt", "bye\n");
  await write(root, "mv-src.txt", "line a\nline b\nline c\nline d\n");
  await commitAll(root, "init");
  return root;
}

describe("createGit: repoRoot / errors", () => {
  it("returns the repository root from a subdirectory", async () => {
    const root = await seededRepo();
    await mkdir(join(root, "sub/dir"), { recursive: true });
    expect(await createGit(join(root, "sub/dir")).repoRoot()).toBe(root);
  });

  it("throws GitError outside a repository", async () => {
    const dir = await tmp();
    const g = createGit(dir);
    await expect(g.repoRoot()).rejects.toThrow(GitError);
    await expect(g.getDiff({ kind: "staged" })).rejects.toThrow(/Not a git repository/);
  });

  it("throws GitError for a missing directory", async () => {
    await expect(createGit(join(tmpdir(), "acr-definitely-missing-dir")).repoRoot()).rejects.toThrow(/Directory not found/);
  });

  it("throws an actionable GitError when git is not installed", async () => {
    const dir = await tmp();
    const g = createGitClient(dir, { bin: "git-does-not-exist-acr" });
    await expect(g.repoRoot()).rejects.toThrow(/git executable not found.*Install git/);
  });
});

describe("createGit: getDiff", () => {
  it("staged: only index changes, root-relative paths from a subdirectory", async () => {
    const root = await seededRepo();
    await write(root, "a.txt", "1\n2\nTHREE\n4\n5\n");
    await git(root, "add", "a.txt");
    await write(root, "a.txt", "1\n2\nTHREE\n4\n5\n6 unstaged\n");
    await mkdir(join(root, "sub"));
    const files = await createGit(join(root, "sub")).getDiff({ kind: "staged" });
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f).toMatchObject({ path: "a.txt", status: "modified", additions: 1, deletions: 1 });
    expect(f.hunks[0]!.lines).toContainEqual({ kind: "add", content: "THREE", oldLine: null, newLine: 3 });
  });

  it("working: index + worktree changes vs HEAD, honouring contextLines", async () => {
    const root = await seededRepo();
    await write(root, "a.txt", "1\n2\nTHREE\n4\n5\n6\n");
    await git(root, "rm", "-q", "del.txt");
    const g = createGit(root);
    const files = await g.getDiff({ kind: "working" }, { contextLines: 0 });
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["del.txt", "deleted"],
    ]);
    const a = files[0]!;
    expect(a.hunks.flatMap((h) => h.lines).every((l) => l.kind !== "context")).toBe(true);
    expect(a.additions).toBe(2);

    const wide = await g.getDiff({ kind: "working" });
    expect(wide[0]!.hunks[0]!.lines.some((l) => l.kind === "context")).toBe(true);
  });

  it("repo with no commits: staged and working both show added files", async () => {
    const root = await newRepo();
    await write(root, "first.txt", "hello\nworld\n");
    await git(root, "add", "first.txt");
    const g = createGit(root);
    for (const kind of ["staged", "working"] as const) {
      const files = await g.getDiff({ kind });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: "first.txt", status: "added", additions: 2 });
      expect(files[0]!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
    }
    await expect(g.defaultBase()).rejects.toThrow(GitError);
  });

  it("uses the right empty tree in a SHA-256 repository", async () => {
    const root = await tmp();
    await git(root, "init", "-q", "-b", "main", "--object-format=sha256");
    await write(root, "x.txt", "x\n");
    await git(root, "add", "x.txt");
    const files = await createGit(root).getDiff({ kind: "working" });
    expect(files).toMatchObject([{ path: "x.txt", status: "added", additions: 1 }]);
  });

  it("range: diffs merge-base..head, ignoring later commits on the base", async () => {
    const root = await seededRepo();
    await git(root, "checkout", "-q", "-b", "feature");
    await write(root, "feature.txt", "feat\n");
    await commitAll(root, "feature work");
    await git(root, "checkout", "-q", "main");
    await write(root, "main-only.txt", "main\n");
    await commitAll(root, "main moves on");
    await git(root, "checkout", "-q", "feature");

    const g = createGit(root);
    const viaHead = await g.getDiff({ kind: "range", base: "main" });
    expect(viaHead.map((f) => [f.path, f.status])).toEqual([["feature.txt", "added"]]);
    await git(root, "checkout", "-q", "main");
    const explicit = await g.getDiff({ kind: "range", base: "main", head: "feature" });
    expect(explicit.map((f) => f.path)).toEqual(["feature.txt"]);
  });

  it("range: unknown ref → GitError naming the ref", async () => {
    const root = await seededRepo();
    const g = createGit(root);
    await expect(g.getDiff({ kind: "range", base: "nope/branch" })).rejects.toThrow(/"nope\/branch"/);
    await expect(g.getDiff({ kind: "range", base: "main", head: "ghost" })).rejects.toThrow(/"ghost"/);
    await expect(g.getDiff({ kind: "range", base: "--output=/tmp/x" })).rejects.toThrow(GitError);
  });

  it("range: unrelated histories → GitError", async () => {
    const root = await seededRepo();
    await git(root, "checkout", "-q", "--orphan", "other");
    await git(root, "rm", "-rq", "--cached", ".");
    await write(root, "o.txt", "o\n");
    await git(root, "add", "o.txt");
    await git(root, "commit", "-q", "-m", "orphan");
    await expect(createGit(root).getDiff({ kind: "range", base: "main" })).rejects.toThrow(/No common ancestor/);
  });

  it("commit: single commit vs first parent, and root commit vs empty tree", async () => {
    const root = await seededRepo();
    const rootSha = await git(root, "rev-parse", "HEAD");
    await write(root, "a.txt", "1\n2\n3\n4\n5\nsix\n");
    const second = await commitAll(root, "second");
    await write(root, "later.txt", "later\n");
    await commitAll(root, "third");

    const g = createGit(root);
    const files = await g.getDiff({ kind: "commit", sha: second.slice(0, 8) });
    expect(files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(files[0]!.hunks[0]!.lines.at(-1)).toEqual({ kind: "add", content: "six", oldLine: null, newLine: 6 });

    const initial = await g.getDiff({ kind: "commit", sha: rootSha });
    expect(initial.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "added"],
      ["del.txt", "added"],
      ["mv-src.txt", "added"],
    ]);
    await expect(g.getDiff({ kind: "commit", sha: "deadbeef" })).rejects.toThrow(/"deadbeef"/);
  });

  it("commit on a merge commit diffs against the first parent", async () => {
    const root = await seededRepo();
    await git(root, "checkout", "-q", "-b", "side");
    await write(root, "side.txt", "side\n");
    await commitAll(root, "side");
    await git(root, "checkout", "-q", "main");
    await write(root, "mainfile.txt", "m\n");
    await commitAll(root, "main");
    await git(root, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const files = await createGit(root).getDiff({ kind: "commit", sha: "HEAD" });
    expect(files.map((f) => f.path)).toEqual(["side.txt"]);
  });

  it("detects renames, binaries, mode changes and odd file names", async () => {
    const root = await seededRepo();
    await mkdir(join(root, "moved dir"));
    await git(root, "mv", "mv-src.txt", "moved dir/mv dst.txt");
    await write(root, "logo.bin", Buffer.from([0, 1, 2, 3, 0, 255, 0, 10]));
    await write(root, "my notes.md", "spaced\n");
    await write(root, "caffè/ñandú 日本.txt", "unicode\n");
    await write(root, 'quote"tab\tname.txt', "weird\n");
    await write(root, "empty.txt", "");
    await chmod(join(root, "a.txt"), 0o755);
    await git(root, "add", "-A");

    const files = await createGit(root).getDiff({ kind: "staged" });
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(
      ["a.txt", "caffè/ñandú 日本.txt", "empty.txt", "logo.bin", "moved dir/mv dst.txt", "my notes.md", 'quote"tab\tname.txt'].sort(),
    );
    expect(byPath.get("moved dir/mv dst.txt")).toMatchObject({ status: "renamed", oldPath: "mv-src.txt", hunks: [] });
    expect(byPath.get("logo.bin")).toMatchObject({ status: "added", binary: true, hunks: [] });
    expect(byPath.get("a.txt")).toMatchObject({ status: "modified", hunks: [] });
    expect(byPath.get("empty.txt")).toMatchObject({ status: "added", hunks: [] });
    expect(byPath.get("my notes.md")).toMatchObject({ status: "added", additions: 1 });
    expect(byPath.get("caffè/ñandú 日本.txt")!.hunks[0]!.lines[0]!.content).toBe("unicode");
  });

  it("is not affected by diff.noprefix / mnemonicPrefix / external diff config", async () => {
    const root = await seededRepo();
    await git(root, "config", "diff.noprefix", "true");
    await git(root, "config", "diff.mnemonicPrefix", "true");
    await git(root, "config", "diff.external", "false");
    await git(root, "config", "color.ui", "always");
    await write(root, "a.txt", "1\n2\n3\n4\n5 changed\n");
    const files = await createGit(root).getDiff({ kind: "working" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "a.txt", additions: 1, deletions: 1 });
  });

  it("rejects an invalid contextLines", async () => {
    const root = await seededRepo();
    await expect(createGit(root).getDiff({ kind: "staged" }, { contextLines: -1 })).rejects.toThrow(GitError);
  });
});

describe("createGit: readFile", () => {
  it("reads from HEAD, INDEX, WORKTREE and a ref; null when missing", async () => {
    const root = await seededRepo();
    await git(root, "tag", "v1");
    await write(root, "a.txt", "staged\n");
    await git(root, "add", "a.txt");
    await write(root, "a.txt", "worktree\n");
    await write(root, "sp ace/ü.txt", "new\n");
    await git(root, "add", "sp ace/ü.txt");

    const g = createGit(join(root)); // paths are always repo-root relative
    expect(await g.readFile("a.txt", "HEAD")).toBe("1\n2\n3\n4\n5\n");
    expect(await g.readFile("a.txt", "INDEX")).toBe("staged\n");
    expect(await g.readFile("a.txt", "WORKTREE")).toBe("worktree\n");
    expect(await g.readFile("a.txt", { ref: "v1" })).toBe("1\n2\n3\n4\n5\n");
    expect(await g.readFile("sp ace/ü.txt", "INDEX")).toBe("new\n");
    expect(await g.readFile("sp ace/ü.txt", "WORKTREE")).toBe("new\n");

    expect(await g.readFile("sp ace/ü.txt", "HEAD")).toBeNull();
    expect(await g.readFile("missing.txt", "INDEX")).toBeNull();
    expect(await g.readFile("missing.txt", "WORKTREE")).toBeNull();
    expect(await g.readFile("a.txt", { ref: "no-such-ref" })).toBeNull();
    expect(await g.readFile("sp ace", "HEAD")).toBeNull(); // a directory
    expect(await g.readFile("sp ace", "WORKTREE")).toBeNull();
    expect(await g.readFile("../outside.txt", "WORKTREE")).toBeNull();
  });

  it("works from a subdirectory with root-relative paths", async () => {
    const root = await seededRepo();
    await mkdir(join(root, "nested"));
    const g = createGit(join(root, "nested"));
    expect(await g.readFile("a.txt", "WORKTREE")).toBe("1\n2\n3\n4\n5\n");
    expect(await g.readFile("a.txt", "HEAD")).toBe("1\n2\n3\n4\n5\n");
  });
});

describe("createGit: defaultBase", () => {
  it("prefers origin/HEAD, then origin/main, origin/master, main, master", async () => {
    const root = await seededRepo();
    const g = createGit(root);
    expect(await g.defaultBase()).toBe("main");

    await git(root, "branch", "-m", "main", "master");
    expect(await createGit(root).defaultBase()).toBe("master");
    await git(root, "branch", "-m", "master", "main");

    const sha = await git(root, "rev-parse", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/master", sha);
    expect(await g.defaultBase()).toBe("origin/master");
    await git(root, "update-ref", "refs/remotes/origin/main", sha);
    expect(await g.defaultBase()).toBe("origin/main");

    await git(root, "update-ref", "refs/remotes/origin/develop", sha);
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(await g.defaultBase()).toBe("origin/develop");
  });

  it("works with a real clone (origin/HEAD set by git clone)", async () => {
    const upstream = await seededRepo();
    await git(upstream, "branch", "-m", "main", "trunk");
    const parent = await tmp();
    await git(parent, "clone", "-q", upstream, "clone");
    expect(await createGit(join(parent, "clone")).defaultBase()).toBe("origin/trunk");
  });

  it("throws GitError when nothing matches", async () => {
    const root = await seededRepo();
    await git(root, "branch", "-m", "main", "trunk");
    await expect(createGit(root).defaultBase()).rejects.toThrow(/default base branch/);
  });
});
