import picomatch from "picomatch";
import type { Config } from "../types.js";

export const LOCKFILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
];

/** Minified/generated output and vendored code. */
export const GENERATED: readonly string[] = [
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/vendor/**",
  "**/node_modules/**",
];

export const ASSETS: readonly string[] = [
  "**/*.{png,jpg,jpeg,gif,webp,avif,bmp,tif,tiff,ico,icns,svg,psd}",
  "**/*.{woff,woff2,ttf,otf,eot}",
];

/**
 * Files never sent to the AI: lockfiles, generated/vendored code, images, fonts.
 * Offline checks still see them (only the user's include/exclude applies there).
 */
export const DEFAULT_SKIP: readonly string[] = [...LOCKFILES.map((f) => `**/${f}`), ...GENERATED, ...ASSETS];

type Matcher = (path: string) => boolean;

/** Patterns without a "/" also match the basename (gitignore-like: "*.gen.ts" matches anywhere). */
function matcher(patterns: readonly string[]): Matcher | null {
  if (patterns.length === 0) return null;
  const full = picomatch([...patterns], { dot: true });
  const basenamePatterns = patterns.filter((p) => !p.includes("/"));
  const base = basenamePatterns.length > 0 ? picomatch(basenamePatterns, { dot: true }) : null;
  return (path) => full(path) || (base !== null && base(path.slice(path.lastIndexOf("/") + 1)));
}

const never: Matcher = () => false;

export const isDefaultSkipped: Matcher = matcher(DEFAULT_SKIP) ?? never;
export const isLockfile: Matcher = matcher(LOCKFILES) ?? never;
export const isGenerated: Matcher = matcher(GENERATED) ?? never;

/** The user's include/exclude (applies to checks and AI). */
export function createUserFilter(config: Pick<Config, "include" | "exclude">): (path: string) => boolean {
  const include = matcher(config.include);
  const exclude = matcher(config.exclude);
  return (path) => (include === null || include(path)) && !exclude?.(path);
}

/** Files eligible for AI review: user filter + built-in skip list. */
export function createPathFilter(config: Pick<Config, "include" | "exclude">): (path: string) => boolean {
  const user = createUserFilter(config);
  return (path) => !isDefaultSkipped(path) && user(path);
}
