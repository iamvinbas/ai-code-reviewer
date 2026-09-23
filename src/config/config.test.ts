import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addIgnoreIds,
  ConfigError,
  configTemplate,
  DEFAULT_CONFIG,
  findRepoRoot,
  loadConfig,
  parseIgnoreFile,
} from "./index.js";
import { parseOverrides } from "./schema.js";

let tmp: string;
let repo: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "acr-config-"));
  repo = join(tmp, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "src", "deep"), { recursive: true });
  env = { XDG_CONFIG_HOME: join(tmp, "xdg"), HOME: join(tmp, "home") };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeUser(yaml: string) {
  await mkdir(join(tmp, "xdg", "acr"), { recursive: true });
  await writeFile(join(tmp, "xdg", "acr", "config.yml"), yaml);
}
const writeRepo = (yaml: string, name = ".acr.yml") => writeFile(join(repo, name), yaml);

describe("loadConfig", () => {
  it("returns defaults with no files, env or flags", async () => {
    const { config, sources, warnings, repoRoot } = await loadConfig({ cwd: repo, env });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources).toEqual([]);
    expect(warnings).toEqual([]);
    expect(repoRoot).toBe(repo);
  });

  it("does not mutate DEFAULT_CONFIG", async () => {
    await writeRepo("checks:\n  largeFiles:\n    maxKb: 10\nignore: [x]\n");
    await loadConfig({ cwd: repo, env });
    expect(DEFAULT_CONFIG.checks.largeFiles.maxKb).toBe(500);
    expect(DEFAULT_CONFIG.ignore).toEqual([]);
  });

  it("layers defaults < user < repo < env < flags", async () => {
    await writeUser("failOn: warning\nlanguage: it\nmaxFiles: 10\nrules: [user rule]\n");
    await writeRepo("failOn: suggestion\nrules: [repo rule]\ncontextLines: 3\n");
    const { config, sources } = await loadConfig({
      cwd: join(repo, "src", "deep"),
      env: { ...env, ACR_LANGUAGE: "en", ACR_FAIL_ON: "never" },
      flags: { failOn: "critical" },
    });
    expect(config.failOn).toBe("critical");
    expect(config.language).toBe("en");
    expect(config.maxFiles).toBe(10);
    expect(config.contextLines).toBe(3);
    expect(config.rules).toEqual(["repo rule"]);
    expect(sources).toEqual([
      join(tmp, "xdg", "acr", "config.yml"),
      join(repo, ".acr.yml"),
      "env (ACR_LANGUAGE, ACR_FAIL_ON)",
      "command-line flags",
    ]);
  });

  it("deep-merges objects and replaces arrays", async () => {
    await writeUser("checks:\n  secrets: false\n  largeFiles:\n    maxKb: 100\nexclude: [a, b]\n");
    await writeRepo("checks:\n  largeFiles:\n    enabled: false\nexclude: [c]\n");
    const { config } = await loadConfig({ cwd: repo, env });
    expect(config.checks).toEqual({
      secrets: false,
      conflictMarkers: true,
      debugStatements: true,
      largeFiles: { enabled: false, maxKb: 100 },
    });
    expect(config.exclude).toEqual(["c"]);
  });

  it("reads the user file from ~/.config when XDG_CONFIG_HOME is unset", async () => {
    await mkdir(join(tmp, "home", ".config", "acr"), { recursive: true });
    await writeFile(join(tmp, "home", ".config", "acr", "config.yml"), "maxFiles: 7\n");
    const { config } = await loadConfig({ cwd: repo, env: { HOME: join(tmp, "home") } });
    expect(config.maxFiles).toBe(7);
  });

  it("accepts .acr.yaml", async () => {
    await writeRepo("maxFiles: 3\n", ".acr.yaml");
    expect((await loadConfig({ cwd: repo, env })).config.maxFiles).toBe(3);
  });

  it("maps ACR_* env vars", async () => {
    const { config } = await loadConfig({
      cwd: repo,
      env: { ...env, ACR_PROVIDER: "groq", ACR_MODEL: "m1", ACR_BASE_URL: "http://localhost:1234/v1" },
    });
    expect(config.provider).toEqual({ preset: "groq", model: "m1", baseUrl: "http://localhost:1234/v1" });
  });

  it("rejects invalid env values", async () => {
    await expect(loadConfig({ cwd: repo, env: { ...env, ACR_FAIL_ON: "loud" } })).rejects.toThrow(
      "ACR_FAIL_ON must be one of critical|warning|suggestion|never",
    );
    await expect(loadConfig({ cwd: repo, env: { ...env, ACR_BASE_URL: "file:///etc" } })).rejects.toThrow(ConfigError);
  });

  it("switching preset drops model/baseUrl from lower layers but keeps timeouts", async () => {
    await writeRepo("provider:\n  preset: ollama\n  model: qwen\n  baseUrl: http://localhost:1/v1\n  timeoutMs: 5000\n");
    const { config } = await loadConfig({ cwd: repo, env, flags: { provider: { preset: "groq" } } });
    expect(config.provider).toEqual({ preset: "groq", timeoutMs: 5000 });

    const same = await loadConfig({ cwd: repo, env, flags: { provider: { model: "other" } } });
    expect(same.config.provider).toMatchObject({ preset: "ollama", model: "other", baseUrl: "http://localhost:1/v1" });
  });

  it("works outside a git repository (no repo file, no ignore file)", async () => {
    const outside = join(tmp, "plain");
    await mkdir(outside);
    const { config, repoRoot } = await loadConfig({ cwd: outside, env });
    expect(repoRoot).toBeNull();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("treats empty keys (only commented examples) as unset", async () => {
    await writeRepo("rules:\n  # - a rule\nexclude:\n");
    const { config } = await loadConfig({ cwd: repo, env });
    expect(config.rules).toEqual([]);
    expect(config.exclude).toEqual([]);
  });
});

describe("validation errors", () => {
  const load = () => loadConfig({ cwd: repo, env });

  it("reports enum errors with the file name", async () => {
    await writeRepo("failOn: blocker\n");
    await expect(load()).rejects.toThrow(
      new ConfigError(".acr.yml: failOn must be one of critical|warning|suggestion|never"),
    );
  });

  it("rejects unknown keys, including nested ones", async () => {
    await writeRepo("failon: critical\nchecks:\n  secret: true\n");
    await expect(load()).rejects.toThrow('unknown option "failon"');
    await expect(load()).rejects.toThrow('unknown option "checks.secret"');
  });

  it("reports types and ranges with paths", async () => {
    await writeRepo("maxFiles: 0\ninclude: [1]\nai:\n  enabled: yes please\n");
    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("maxFiles must be >= 1");
    expect((err as Error).message).toContain("include[0] must be a string");
    expect((err as Error).message).toContain("ai.enabled must be a boolean");
  });

  it("reports invalid YAML", async () => {
    await writeRepo("failOn: [unclosed\n");
    await expect(load()).rejects.toThrow(/\.acr\.yml: invalid YAML/);
  });

  it("rejects a non-mapping document", async () => {
    await writeRepo("- a\n- b\n");
    await expect(load()).rejects.toThrow(".acr.yml: expected a mapping");
  });

  it("labels user file errors with their path", async () => {
    await writeUser("language: fr\n");
    await expect(load()).rejects.toThrow(`${join(tmp, "xdg", "acr", "config.yml")}: language must be one of en|it`);
  });

  it("rejects invalid flags", () => {
    expect(() => parseOverrides({ maxChunkTokens: 10 }, "flags")).toThrow("flags: maxChunkTokens must be >= 500");
  });

  it("rejects non-http baseUrl", async () => {
    await writeRepo("provider:\n  baseUrl: javascript:alert(1)\n");
    await expect(load()).rejects.toThrow("provider.baseUrl must be an http(s) URL");
  });
});

describe("repo config security", () => {
  it("only allows *_API_KEY env names for apiKeyEnv in the repo file", async () => {
    await writeRepo("provider:\n  preset: openai-compatible\n  apiKeyEnv: AWS_SECRET_ACCESS_KEY\n");
    await expect(loadConfig({ cwd: repo, env })).rejects.toThrow(/apiKeyEnv must be an env var name ending in _API_KEY/);

    await writeRepo("provider:\n  preset: groq\n  apiKeyEnv: TEAM_GROQ_API_KEY\n");
    const { config } = await loadConfig({ cwd: repo, env });
    expect(config.provider.apiKeyEnv).toBe("TEAM_GROQ_API_KEY");
  });

  it("allows any apiKeyEnv in the user file", async () => {
    await writeUser("provider:\n  preset: openai-compatible\n  baseUrl: https://llm.corp.example/v1\n  apiKeyEnv: CORP_TOKEN\n");
    const { config, warnings } = await loadConfig({ cwd: repo, env });
    expect(config.provider.apiKeyEnv).toBe("CORP_TOKEN");
    expect(warnings).toEqual([]);
  });

  it("warns when the repo file points to an unknown remote endpoint", async () => {
    await writeRepo("provider:\n  preset: openai-compatible\n  baseUrl: https://evil.example.com/v1\n");
    const { warnings } = await loadConfig({ cwd: repo, env });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("https://evil.example.com/v1");
  });

  it("does not warn for local or well-known endpoints, or when overridden", async () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "https://api.groq.com/openai/v1"]) {
      await writeRepo(`provider:\n  baseUrl: ${url}\n`);
      expect((await loadConfig({ cwd: repo, env })).warnings).toEqual([]);
    }
    await writeRepo("provider:\n  baseUrl: https://evil.example.com/v1\n");
    const overridden = await loadConfig({ cwd: repo, env, flags: { provider: { preset: "groq" } } });
    expect(overridden.warnings).toEqual([]);
    expect(overridden.config.provider.baseUrl).toBeUndefined();
  });
});

describe("ignore file", () => {
  it("parses ids, comments and blank lines", () => {
    expect(parseIgnoreFile("# header\nabc\n\n  def  # why\nabc\r\n")).toEqual(["abc", "def"]);
  });

  it("merges .acr/ignore with config ignore", async () => {
    await writeRepo("ignore: [fromyml, shared]\n");
    await mkdir(join(repo, ".acr"));
    await writeFile(join(repo, ".acr", "ignore"), "shared\nfromfile\n");
    const { config, sources } = await loadConfig({ cwd: repo, env });
    expect(config.ignore).toEqual(["fromyml", "shared", "fromfile"]);
    expect(sources).toContain(join(repo, ".acr", "ignore"));
  });

  it("appends ids with dedupe and keeps existing content", async () => {
    const first = await addIgnoreIds(repo, ["a1", "b2"]);
    expect(first.added).toEqual(["a1", "b2"]);
    await writeFile(first.path, `${await readFile(first.path, "utf8")}c3 # manual`);
    const second = await addIgnoreIds(repo, ["b2", "d4"]);
    expect(second).toMatchObject({ added: ["d4"], existing: ["b2"] });
    const text = await readFile(first.path, "utf8");
    expect(text).toMatch(/^# Issue ids ignored by acr/);
    expect(text).toContain("c3 # manual\nd4\n");
    expect(parseIgnoreFile(text)).toEqual(["a1", "b2", "c3", "d4"]);
  });
});

describe("findRepoRoot", () => {
  it("walks up to the dir containing .git (dir or file)", async () => {
    expect(findRepoRoot(join(repo, "src", "deep"))).toBe(repo);
    const wt = join(tmp, "worktree");
    await mkdir(join(wt, "x"), { recursive: true });
    await writeFile(join(wt, ".git"), "gitdir: /elsewhere\n");
    expect(findRepoRoot(join(wt, "x"))).toBe(wt);
  });
});

describe("configTemplate", () => {
  it("is valid config that matches the defaults", () => {
    const parsed = parseOverrides(parseYaml(configTemplate()), "template");
    expect(parsed.failOn).toBe(DEFAULT_CONFIG.failOn);
    expect(parsed.provider).toEqual({ preset: "ollama" });
    expect(parsed.checks).toEqual(DEFAULT_CONFIG.checks);
    expect(parsed.maxChunkTokens).toBe(DEFAULT_CONFIG.maxChunkTokens);
    expect(DEFAULT_CONFIG.maxChunkTokens).toBe(4000);
  });

  it("warns never to put keys in the file", () => {
    expect(configTemplate()).toMatch(/NEVER put API keys in this file/);
  });
});
