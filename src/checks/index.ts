import type { Check, Config } from "../types.js";
import { conflictMarkersCheck } from "./conflict-markers.js";
import { debugStatementsCheck } from "./debug-statements.js";
import { largeFilesCheck } from "./large-files.js";
import { secretsCheck } from "./secrets.js";

/** Deterministic offline checks enabled by `config.checks`. They only inspect added lines. */
export function builtinChecks(config: Config): Check[] {
  const checks: Check[] = [];
  if (config.checks.secrets) checks.push(secretsCheck);
  if (config.checks.conflictMarkers) checks.push(conflictMarkersCheck);
  if (config.checks.debugStatements) checks.push(debugStatementsCheck);
  if (config.checks.largeFiles.enabled) checks.push(largeFilesCheck(config));
  return checks;
}
