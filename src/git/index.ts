import type { GitApi } from "../types.js";
import { createGitClient } from "./client.js";

export { GitError } from "./errors.js";
export { parseUnifiedDiff } from "./parse.js";

/** GitApi backed by the `git` executable, for the repository containing `cwd`. */
export function createGit(cwd: string): GitApi {
  return createGitClient(cwd);
}
