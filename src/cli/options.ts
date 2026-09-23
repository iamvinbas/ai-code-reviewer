import type { ConfigOverrides } from "../config/index.js";
import type { DiffTarget, FailOn, GitApi, ProviderPreset } from "../types.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type OutputFormat = "pretty" | "json" | "markdown";

/** Options as parsed by commander for `acr review`. */
export interface ReviewCliOptions {
  staged?: boolean;
  working?: boolean;
  /** `--range` alone → true; `--range main` → "main"; also accepts "base..head". */
  range?: string | boolean;
  commit?: string;
  format?: OutputFormat;
  /** `--no-ai` → false. */
  ai?: boolean;
  failOn?: FailOn;
  provider?: ProviderPreset;
  model?: string;
  lang?: "en" | "it";
  /** `--no-cache` → false. */
  cache?: boolean;
  verbose?: boolean;
  hook?: boolean;
  /** `--no-color` → false. */
  color?: boolean;
}

/** Maps target flags to a DiffTarget; `--range` without a base uses the repo's default branch. */
export async function resolveTarget(
  opts: Pick<ReviewCliOptions, "staged" | "working" | "range" | "commit">,
  git: Pick<GitApi, "defaultBase">,
): Promise<DiffTarget> {
  const chosen = [
    opts.staged && "--staged",
    opts.working && "--working",
    opts.range !== undefined && opts.range !== false && "--range",
    opts.commit !== undefined && "--commit",
  ].filter(Boolean);
  if (chosen.length > 1) throw new UsageError(`choose only one of ${chosen.join(", ")}`);

  if (opts.working) return { kind: "working" };
  if (opts.commit !== undefined) {
    const sha = opts.commit.trim();
    if (!sha) throw new UsageError("--commit needs a commit sha or ref");
    return { kind: "commit", sha };
  }
  if (opts.range !== undefined && opts.range !== false) {
    if (opts.range === true || !opts.range.trim()) return { kind: "range", base: await git.defaultBase() };
    const spec = opts.range.trim();
    const match = /^(.*?)\.{2,3}(.*)$/.exec(spec);
    if (!match) return { kind: "range", base: spec };
    const [, base = "", head = ""] = match;
    if (!base) throw new UsageError(`invalid range "${spec}": missing base`);
    return head ? { kind: "range", base, head } : { kind: "range", base };
  }
  return { kind: "staged" };
}

/** Only flags the user actually passed become overrides (config files keep their values otherwise). */
export function reviewOverrides(opts: ReviewCliOptions): ConfigOverrides {
  const out: ConfigOverrides = {};
  if (opts.provider || opts.model) {
    out.provider = {};
    if (opts.provider) out.provider.preset = opts.provider;
    if (opts.model) out.provider.model = opts.model;
  }
  if (opts.failOn) out.failOn = opts.failOn;
  if (opts.lang) out.language = opts.lang;
  if (opts.ai === false) out.ai = { enabled: false };
  if (opts.cache === false) out.cache = { enabled: false };
  return out;
}

/** Issue ids are hex fingerprints; reject anything that could corrupt the ignore file. */
export function validateIgnoreIds(ids: string[]): string[] {
  const clean = ids.map((id) => id.trim().replace(/^\[|\]$/g, "")).filter(Boolean);
  const bad = clean.filter((id) => !/^[A-Za-z0-9._:/-]+$/.test(id));
  if (bad.length) throw new UsageError(`invalid issue id: ${bad.join(", ")}`);
  if (!clean.length) throw new UsageError("give at least one issue id (shown as [id] in the review output)");
  return [...new Set(clean)];
}
