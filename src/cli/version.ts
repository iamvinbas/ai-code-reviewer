import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Reads our package.json version, walking up from this file (works from src/ via tsx and from dist/). */
export function readVersion(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "acr-review" && pkg.version) return pkg.version;
    } catch {
      // not here, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return "0.0.0";
    dir = parent;
  }
}
