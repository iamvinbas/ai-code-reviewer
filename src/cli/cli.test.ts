import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../config/index.js";
import { EXIT } from "../types.js";
import { ignoreCommand, initCommand } from "./commands.js";
import { resolveTarget, reviewOverrides, UsageError, validateIgnoreIds } from "./options.js";
import { run } from "./program.js";
import { describeProgress } from "./progress.js";
import { reviewCommand, type Io } from "./review.js";
import { readVersion } from "./version.js";

const git = { defaultBase: async () => "origin/main" };

describe("resolveTarget", () => {
  it("defaults to staged", async () => {
    expect(await resolveTarget({}, git)).toEqual({ kind: "staged" });
    expect(await resolveTarget({ staged: true }, git)).toEqual({ kind: "staged" });
  });

  it("maps --working and --commit", async () => {
    expect(await resolveTarget({ working: true }, git)).toEqual({ kind: "working" });
    expect(await resolveTarget({ commit: "abc123" }, git)).toEqual({ kind: "commit", sha: "abc123" });
  });

  it("maps --range with and without a base", async () => {
    expect(await resolveTarget({ range: true }, git)).toEqual({ kind: "range", base: "origin/main" });
    expect(await resolveTarget({ range: "develop" }, git)).toEqual({ kind: "range", base: "develop" });
    expect(await resolveTarget({ range: "main..feature" }, git)).toEqual({ kind: "range", base: "main", head: "feature" });
    expect(await resolveTarget({ range: "main..." }, git)).toEqual({ kind: "range", base: "main" });
  });

  it("rejects conflicting or empty targets", async () => {
    await expect(resolveTarget({ staged: true, working: true }, git)).rejects.toThrow(UsageError);
    await expect(resolveTarget({ range: "main", commit: "x" }, git)).rejects.toThrow("choose only one of --range, --commit");
    await expect(resolveTarget({ commit: " " }, git)).rejects.toThrow(UsageError);
    await expect(resolveTarget({ range: "..HEAD" }, git)).rejects.toThrow(/missing base/);
  });
});

describe("reviewOverrides", () => {
  it("is empty when no config flags were passed (commander defaults are ignored)", () => {
    expect(reviewOverrides({ ai: true, cache: true, color: true, format: "pretty", verbose: true })).toEqual({});
  });

  it("maps passed flags to config overrides", () => {
    expect(
      reviewOverrides({
        ai: false,
        cache: false,
        failOn: "warning",
        provider: "groq",
        model: "llama",
        lang: "it",
      }),
    ).toEqual({
      ai: { enabled: false },
      cache: { enabled: false },
      failOn: "warning",
      provider: { preset: "groq", model: "llama" },
      language: "it",
    });
    expect(reviewOverrides({ model: "m" })).toEqual({ provider: { model: "m" } });
  });
});

describe("validateIgnoreIds", () => {
  it("trims, strips brackets and dedupes", () => {
    expect(validateIgnoreIds([" abc123 ", "[def456]", "abc123"])).toEqual(["abc123", "def456"]);
  });

  it("rejects ids that could corrupt the ignore file", () => {
    expect(() => validateIgnoreIds(["abc # x"])).toThrow(UsageError);
    expect(() => validateIgnoreIds(["a\nb"])).toThrow(UsageError);
    expect(() => validateIgnoreIds([""])).toThrow(UsageError);
  });
});

describe("describeProgress", () => {
  it("shows 1-based chunk numbers and truncated file lists", () => {
    expect(describeProgress({ type: "chunk:start", index: 1, total: 5, files: ["a", "b", "c", "d", "e"] })).toBe(
      "Reviewing chunk 2/5 (a, b, c +2 more)…",
    );
    expect(describeProgress({ type: "diff", files: 1 })).toBe("Found 1 changed file…");
  });
});

describe("readVersion", () => {
  it("reads package.json from src", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });
});

// ─── Commands against a temporary repository ─────────────────────────────────

let repo: string;
let io: Io & { stdout: string[]; stderr: string[] };

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "acr-cli-")));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  sh("init", "-q");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "t");
  sh("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "a.txt"), "hello\n");
  sh("add", ".");
  sh("commit", "-qm", "init");
  // Isolate from the developer's own ~/.config/acr and ACR_* variables.
  vi.stubEnv("XDG_CONFIG_HOME", join(repo, ".xdg"));
  for (const name of ["ACR_PROVIDER", "ACR_MODEL", "ACR_BASE_URL", "ACR_LANGUAGE", "ACR_FAIL_ON"]) vi.stubEnv(name, "");
  const stdout: string[] = [];
  const stderr: string[] = [];
  io = { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
});

describe("init", () => {
  it("writes .acr.yml and refuses to overwrite without --force", async () => {
    expect(await initCommand({}, repo, io)).toBe(EXIT.OK);
    const path = join(repo, ".acr.yml");
    expect(await readFile(path, "utf8")).toContain("preset: ollama");
    await writeFile(path, "failOn: never\n");
    await expect(initCommand({}, repo, io)).rejects.toThrow(/already exists/);
    await initCommand({ force: true }, repo, io);
    expect(await readFile(path, "utf8")).toContain("preset: ollama");
  });
});

describe("ignore", () => {
  it("appends ids to .acr/ignore", async () => {
    await ignoreCommand(["abc123", "def456"], repo, io);
    await ignoreCommand(["abc123"], repo, io);
    expect(io.stdout.at(-1)).toBe("Already ignored: abc123");
    expect(await readFile(join(repo, ".acr", "ignore"), "utf8")).toMatch(/abc123\ndef456\n$/);
  });
});

describe("review", () => {
  it("explains when nothing is staged", async () => {
    expect(await reviewCommand({ ai: false }, repo, io)).toBe(EXIT.OK);
    expect(io.stderr.join("\n")).toContain("acr review --working");
    expect(io.stdout).toEqual([]);
  });

  it("prints valid JSON even when there is nothing to review", async () => {
    expect(await reviewCommand({ ai: false, format: "json" }, repo, io)).toBe(EXIT.OK);
    expect(JSON.parse(io.stdout.join("\n"))).toMatchObject({ version: 1, complete: true, issues: [] });
  });

  it("runs offline checks on staged changes and sets the exit code", async () => {
    // Built by concatenation so acr's own secrets check stays quiet when it reviews this repo.
    const fakeKey = "AKIA" + "IOSFODNN7EXAMPLF";
    await writeFile(join(repo, "config.js"), `const key = "${fakeKey}";\n`);
    execFileSync("git", ["add", "config.js"], { cwd: repo });
    const code = await reviewCommand({ ai: false, format: "json" }, repo, io);
    const report = JSON.parse(io.stdout.join("\n")) as { issues: { severity: string; file: string }[] };
    expect(report.issues.some((i) => i.severity === "critical" && i.file === "config.js")).toBe(true);
    expect(code).toBe(EXIT.ISSUES);

    io.stdout.length = 0;
    expect(await reviewCommand({ ai: false, failOn: "never", color: false }, repo, io)).toBe(EXIT.OK);
    expect(io.stdout.join("\n")).toContain("config.js:1");
  });

  it("marks the review incomplete when the provider key is missing", async () => {
    await writeFile(join(repo, "b.txt"), "change\n");
    execFileSync("git", ["add", "b.txt"], { cwd: repo });
    vi.stubEnv("GROQ_API_KEY", "");
    const code = await reviewCommand({ provider: "groq", format: "json" }, repo, io);
    const report = JSON.parse(io.stdout.join("\n")) as { complete: boolean; errors: { stage: string }[] };
    expect(report.complete).toBe(false);
    expect(report.errors[0]?.stage).toBe("llm");
    expect(code).toBe(EXIT.OK);
  });

  it("treats invalid provider config as a usage error", async () => {
    await writeFile(join(repo, "b.txt"), "change\n");
    execFileSync("git", ["add", "b.txt"], { cwd: repo });
    await writeFile(join(repo, ".acr.yml"), "provider:\n  preset: openai-compatible\n");
    await expect(reviewCommand({}, repo, io)).rejects.toBeInstanceOf(ConfigError);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await run(["node", "acr", "--cwd", repo, "review"])).toBe(EXIT.USAGE);
    expect(stderr.mock.calls.flat().join("")).toContain("acr: provider:");
  });
});

describe("run", () => {
  it("maps usage and config errors to EXIT.USAGE", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await run(["node", "acr", "review", "--format", "xml"])).toBe(EXIT.USAGE);
    expect(await run(["node", "acr", "nope"])).toBe(EXIT.USAGE);
    await writeFile(join(repo, ".acr.yml"), "failOn: loud\n");
    expect(await run(["node", "acr", "--cwd", repo, "review"])).toBe(EXIT.USAGE);
    expect(stderr.mock.calls.flat().join("")).toContain(".acr.yml: failOn must be one of");
  });

  it("prints the version and exits 0", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await run(["node", "acr", "--version"])).toBe(EXIT.OK);
    expect(stdout.mock.calls.flat().join("")).toContain(readVersion());
  });

  it("installs hooks via --cwd", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await run(["node", "acr", "--cwd", repo, "hook", "install", "pre-push"])).toBe(EXIT.OK);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(true);
    expect(await run(["node", "acr", "--cwd", repo, "hook", "uninstall"])).toBe(EXIT.OK);
    expect(existsSync(join(repo, ".git", "hooks", "pre-push"))).toBe(false);
  });
});
