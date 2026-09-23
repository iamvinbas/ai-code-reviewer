import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../types.js";
import {
  ConfigError,
  FAIL_ON_VALUES,
  LANGUAGES,
  PRESET_NAMES,
  isHttpUrl,
  parseOverrides,
  type ConfigOverrides,
} from "./schema.js";

export { ConfigError, type ConfigOverrides, type DeepPartial } from "./schema.js";
export { configTemplate } from "./template.js";

export const DEFAULT_CONFIG: Config = {
  provider: { preset: "ollama" },
  failOn: "critical",
  onError: "warn",
  include: [],
  exclude: [],
  rules: [],
  language: "en",
  maxFiles: 50,
  maxChunkTokens: 4000,
  contextLines: 10,
  ai: { enabled: true },
  checks: {
    secrets: true,
    conflictMarkers: true,
    debugStatements: true,
    largeFiles: { enabled: true, maxKb: 500 },
  },
  cache: { enabled: true },
  ignore: [],
};

export const REPO_CONFIG_FILES = [".acr.yml", ".acr.yaml"] as const;
export const IGNORE_FILE = join(".acr", "ignore");

export interface LoadedConfig {
  config: Config;
  /** Human-readable list of what contributed to the config, lowest precedence first. */
  sources: string[];
  /** Non-fatal notices for stderr (e.g. repo config sending code to an unknown host). */
  warnings: string[];
  /** Repo root (dir containing `.git`), or null outside a repository. */
  repoRoot: string | null;
}

export interface LoadConfigOptions {
  cwd: string;
  flags?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
}

/** Walks up from `cwd` to the directory containing `.git` (dir, or file for worktrees/submodules). */
export function findRepoRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function userConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return [join(base, "acr", "config.yml"), join(base, "acr", "config.yaml")];
}

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const repoRoot = findRepoRoot(opts.cwd);
  const sources: string[] = [];
  const warnings: string[] = [];
  let config = structuredClone(DEFAULT_CONFIG);

  const userFile = firstExisting(userConfigPaths(env));
  if (userFile) {
    config = applyLayer(config, await readConfigFile(userFile, userFile));
    sources.push(userFile);
  }

  let repoLayer: ConfigOverrides | null = null;
  if (repoRoot) {
    const repoFile = firstExisting(REPO_CONFIG_FILES.map((f) => join(repoRoot, f)));
    if (repoFile) {
      const label = repoFile.slice(repoRoot.length + 1);
      repoLayer = await readConfigFile(repoFile, label);
      checkRepoProvider(repoLayer, label);
      config = applyLayer(config, repoLayer);
      sources.push(repoFile);
    }
  }

  const envLayer = envOverrides(env);
  if (envLayer.used.length) {
    config = applyLayer(config, envLayer.overrides);
    sources.push(`env (${envLayer.used.join(", ")})`);
  }

  if (opts.flags && Object.keys(opts.flags).length) {
    config = applyLayer(config, parseOverrides(opts.flags, "flags"));
    sources.push("command-line flags");
  }

  if (repoRoot) {
    const ignorePath = join(repoRoot, IGNORE_FILE);
    const ids = await readIgnoreFile(ignorePath);
    if (ids.length) {
      config.ignore = [...new Set([...config.ignore, ...ids])];
      sources.push(ignorePath);
    }
  }

  const repoBaseUrl = repoLayer?.provider?.baseUrl;
  if (repoBaseUrl && config.provider.baseUrl === repoBaseUrl && !isTrustedEndpoint(repoBaseUrl)) {
    warnings.push(
      `the repository config sets provider.baseUrl to ${repoBaseUrl} — your code changes will be sent there. ` +
        `If you do not trust it, run with --provider ollama (or ACR_PROVIDER=ollama).`,
    );
  }

  return { config, sources, warnings, repoRoot };
}

// ─── Layers ──────────────────────────────────────────────────────────────────

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

async function readConfigFile(path: string, label: string): Promise<ConfigOverrides> {
  const text = await readFile(path, "utf8");
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new ConfigError(`${label}: invalid YAML — ${detail}`);
  }
  return parseOverrides(data, label);
}

/** A shared repo file must not redirect arbitrary secrets (e.g. AWS_SECRET_ACCESS_KEY) to a custom endpoint. */
function checkRepoProvider(layer: ConfigOverrides, label: string): void {
  const keyEnv = layer.provider?.apiKeyEnv;
  if (keyEnv !== undefined && !/^[A-Z0-9_]+_API_KEY$/.test(keyEnv)) {
    throw new ConfigError(
      `${label}: provider.apiKeyEnv must be an env var name ending in _API_KEY (got "${keyEnv}"). ` +
        `Set other names in your user config (~/.config/acr/config.yml).`,
    );
  }
}

const TRUSTED_HOSTS = new Set([
  "api.groq.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.cerebras.ai",
]);

export function isLocalUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "0.0.0.0" ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

function isTrustedEndpoint(value: string): boolean {
  if (isLocalUrl(value)) return true;
  try {
    return TRUSTED_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function envOverrides(env: NodeJS.ProcessEnv): { overrides: ConfigOverrides; used: string[] } {
  const overrides: ConfigOverrides = {};
  const used: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    if (!value) return undefined;
    used.push(name);
    return value;
  };
  const oneOf = <T extends string>(name: string, value: string, allowed: readonly T[]): T => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new ConfigError(`${name} must be one of ${allowed.join("|")} (got "${value}")`);
    }
    return value as T;
  };

  const preset = read("ACR_PROVIDER");
  const model = read("ACR_MODEL");
  const baseUrl = read("ACR_BASE_URL");
  const language = read("ACR_LANGUAGE");
  const failOn = read("ACR_FAIL_ON");

  if (preset || model || baseUrl) {
    overrides.provider = {};
    if (preset) overrides.provider.preset = oneOf("ACR_PROVIDER", preset, PRESET_NAMES);
    if (model) overrides.provider.model = model;
    if (baseUrl) {
      if (!isHttpUrl(baseUrl)) throw new ConfigError(`ACR_BASE_URL must be an http(s) URL (got "${baseUrl}")`);
      overrides.provider.baseUrl = baseUrl;
    }
  }
  if (language) overrides.language = oneOf("ACR_LANGUAGE", language, LANGUAGES);
  if (failOn) overrides.failOn = oneOf("ACR_FAIL_ON", failOn, FAIL_ON_VALUES);
  return { overrides, used };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges objects; arrays and scalars replace; undefined is skipped. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/**
 * Applies one layer. Switching to a different preset drops the lower layers' model/baseUrl/apiKeyEnv,
 * which belong to the previous provider (e.g. `--provider groq` must not reuse an Ollama model name).
 */
export function applyLayer(config: Config, layer: ConfigOverrides): Config {
  let base = config;
  const preset = layer.provider?.preset;
  if (preset && preset !== config.provider.preset) {
    const { timeoutMs, maxRetries } = config.provider;
    const provider: Config["provider"] = { preset };
    if (timeoutMs !== undefined) provider.timeoutMs = timeoutMs;
    if (maxRetries !== undefined) provider.maxRetries = maxRetries;
    base = { ...config, provider };
  }
  return deepMerge(base, layer);
}

// ─── Ignore file ─────────────────────────────────────────────────────────────

export function parseIgnoreFile(text: string): string[] {
  const ids = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

export async function readIgnoreFile(path: string): Promise<string[]> {
  try {
    return parseIgnoreFile(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

const IGNORE_HEADER = "# Issue ids ignored by acr (one per line, # for comments). Commit this file to share it.\n";

/** Appends ids to `<repoRoot>/.acr/ignore`, skipping those already present. */
export async function addIgnoreIds(
  repoRoot: string,
  ids: string[],
): Promise<{ path: string; added: string[]; existing: string[] }> {
  const path = join(repoRoot, IGNORE_FILE);
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const present = new Set(parseIgnoreFile(text));
  const added: string[] = [];
  const existing: string[] = [];
  for (const id of ids) {
    if (present.has(id)) existing.push(id);
    else {
      present.add(id);
      added.push(id);
    }
  }
  if (added.length) {
    await mkdir(dirname(path), { recursive: true });
    const prefix = text ? (text.endsWith("\n") ? text : `${text}\n`) : IGNORE_HEADER;
    await writeFile(path, `${prefix}${added.join("\n")}\n`);
  }
  return { path, added, existing };
}
