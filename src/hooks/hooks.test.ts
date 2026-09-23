import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_END, BLOCK_START, hookBlock, hookStatus, hooksDir, installHook, uninstallHook } from "./index.js";

let repo: string;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "acr-hooks-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const hookPath = (kind = "pre-commit") => join(repo, ".git", "hooks", kind);
const isExecutable = async (path: string) => ((await stat(path)).mode & 0o111) === 0o111;

describe("installHook", () => {
  it("creates a new executable hook with shebang and block", async () => {
    const res = await installHook("pre-commit", { cwd: repo });
    expect(res).toEqual({ path: hookPath(), action: "created" });
    const text = await readFile(res.path, "utf8");
    expect(text).toBe(`#!/bin/sh\n\n${hookBlock("pre-commit")}`);
    expect(text).toContain("npx --no-install acr review --staged --hook");
    expect(await isExecutable(res.path)).toBe(true);
  });

  it("pre-push reviews the range", async () => {
    const res = await installHook("pre-push", { cwd: repo });
    expect(await readFile(res.path, "utf8")).toContain("acr review --range --hook");
  });

  it("appends to an existing hook without clobbering it", async () => {
    await writeFile(hookPath(), "#!/bin/bash\nnpm run lint\n", { mode: 0o644 });
    const res = await installHook("pre-commit", { cwd: repo });
    expect(res.action).toBe("updated");
    const text = await readFile(hookPath(), "utf8");
    expect(text).toBe(`#!/bin/bash\nnpm run lint\n\n${hookBlock("pre-commit")}`);
    expect(await isExecutable(hookPath())).toBe(true);
  });

  it("skips when the block is already up to date, updates a stale block", async () => {
    await installHook("pre-commit", { cwd: repo });
    expect((await installHook("pre-commit", { cwd: repo })).action).toBe("skipped");

    const stale = `#!/bin/sh\necho before\n\n${BLOCK_START}\nold stuff\n${BLOCK_END}\necho after\n`;
    await writeFile(hookPath(), stale);
    expect((await installHook("pre-commit", { cwd: repo })).action).toBe("updated");
    const text = await readFile(hookPath(), "utf8");
    expect(text).toBe(`#!/bin/sh\necho before\n\n${hookBlock("pre-commit")}echo after\n`);
    expect(text.match(/>>> acr >>>/g)).toHaveLength(1);
  });

  it("force rewrites the whole file", async () => {
    await writeFile(hookPath(), "#!/bin/sh\nexit 1\n");
    const res = await installHook("pre-commit", { cwd: repo, force: true });
    expect(res.action).toBe("updated");
    expect(await readFile(hookPath(), "utf8")).toBe(`#!/bin/sh\n\n${hookBlock("pre-commit")}`);
  });

  it("respects core.hooksPath (and creates the dir)", async () => {
    execFileSync("git", ["config", "core.hooksPath", "custom-hooks"], { cwd: repo });
    await mkdir(join(repo, "sub"));
    const res = await installHook("pre-commit", { cwd: join(repo, "sub") });
    expect(res.path).toBe(join(repo, "custom-hooks", "pre-commit"));
    expect(existsSync(res.path)).toBe(true);
  });

  it("maps husky's .husky/_ to .husky", async () => {
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: repo });
    expect(await hooksDir(repo)).toBe(join(repo, ".husky"));
  });

  it("fails clearly outside a git repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "acr-nogit-"));
    try {
      await expect(installHook("pre-commit", { cwd: outside })).rejects.toThrow(/not a git repository/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("uninstallHook", () => {
  it("deletes a hook that only contained acr", async () => {
    await installHook("pre-commit", { cwd: repo });
    expect(await uninstallHook("pre-commit", { cwd: repo })).toBe(true);
    expect(existsSync(hookPath())).toBe(false);
  });

  it("removes only the block from a shared hook", async () => {
    await writeFile(hookPath(), "#!/bin/sh\nnpm run lint\n");
    await installHook("pre-commit", { cwd: repo });
    expect(await uninstallHook("pre-commit", { cwd: repo })).toBe(true);
    expect(await readFile(hookPath(), "utf8")).toBe("#!/bin/sh\nnpm run lint\n");
  });

  it("returns false when there is nothing to remove", async () => {
    expect(await uninstallHook("pre-push", { cwd: repo })).toBe(false);
    await writeFile(hookPath("pre-push"), "#!/bin/sh\necho hi\n");
    expect(await uninstallHook("pre-push", { cwd: repo })).toBe(false);
    expect(await readFile(hookPath("pre-push"), "utf8")).toBe("#!/bin/sh\necho hi\n");
  });

  it("hookStatus reflects install state", async () => {
    expect((await hookStatus("pre-commit", { cwd: repo })).installed).toBe(false);
    await installHook("pre-commit", { cwd: repo });
    expect(await hookStatus("pre-commit", { cwd: repo })).toEqual({ path: hookPath(), installed: true });
  });
});

describe("hook script", () => {
  it("does not block when acr is not installed", async () => {
    await installHook("pre-commit", { cwd: repo });
    const out = execFileSync("sh", [hookPath()], {
      cwd: repo,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBe("");
  });

  it("runs the repo's node_modules/.bin/acr first and propagates its exit code", async () => {
    await installHook("pre-commit", { cwd: repo });
    const binDir = join(repo, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const log = join(repo, "acr-args.log");
    await writeFile(join(binDir, "acr"), `#!/bin/sh\necho "$@" > "${log}"\nexit \${ACR_FAKE_EXIT:-0}\n`, { mode: 0o755 });
    await mkdir(join(repo, "sub"));
    const runHook = (code: number) =>
      spawnSync("sh", [hookPath()], {
        cwd: join(repo, "sub"),
        env: { PATH: "/usr/bin:/bin", ACR_FAKE_EXIT: String(code) },
        encoding: "utf8",
      });

    expect(runHook(0).status).toBe(0);
    expect(await readFile(log, "utf8")).toBe("review --staged --hook\n");
    expect(runHook(1).status).toBe(1);
  });
});
