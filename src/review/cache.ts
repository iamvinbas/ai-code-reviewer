import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../types.js";
import { PROMPT_VERSION } from "./prompt.js";
import { rawIssuesSchema, type RawIssue } from "./parse.js";

/** A relative `cache.dir` is resolved against the repository root, not the process cwd. */
export function resolveCacheDir(
  config: Pick<Config, "cache">,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (config.cache.dir) return resolve(repoRoot, config.cache.dir);
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "acr");
  return join(homedir(), ".cache", "acr");
}

export function cacheKey(parts: {
  provider: string;
  model: string;
  language: string;
  rules: readonly string[];
  chunkText: string;
}): string {
  const payload = JSON.stringify([
    PROMPT_VERSION,
    parts.provider,
    parts.model,
    parts.language,
    parts.rules,
    parts.chunkText,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** On-disk cache of validated model output per chunk. All I/O errors are ignored. */
export class ReviewCache {
  constructor(private readonly dir: string) {}

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<RawIssue[] | null> {
    try {
      const data = JSON.parse(await readFile(this.path(key), "utf8")) as { issues?: unknown };
      const parsed = rawIssuesSchema.safeParse(data.issues);
      return parsed.success ? (parsed.data as RawIssue[]) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, issues: readonly RawIssue[]): Promise<void> {
    const target = this.path(key);
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, JSON.stringify({ v: 1, issues }), "utf8");
      await rename(tmp, target);
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}
