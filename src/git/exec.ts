import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitError } from "./errors.js";

const execFileAsync = promisify(execFile);

export const MAX_BUFFER = 64 * 1024 * 1024;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs git without a shell. Non-zero exits are returned (not thrown) so callers can decide;
 * spawn failures (git missing), oversized output and signals throw GitError.
 */
export async function execGit(bin: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["-c", "core.quotePath=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        // Don't take the index lock just to refresh stat info: avoids clashing with the user's git.
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: unknown; stdout?: unknown; stderr?: unknown; signal?: unknown };
    if (e.code === "ENOENT") {
      throw new GitError(
        `git executable not found ("${bin}"). Install git (https://git-scm.com/downloads) and make sure it is on your PATH.`,
        { cause: err },
      );
    }
    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new GitError(
        `git output exceeded ${MAX_BUFFER / 1024 / 1024} MB (git ${args.join(" ")}). Review a smaller change set.`,
        { cause: err },
      );
    }
    if (typeof e.code === "number") {
      return { code: e.code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
    const why = typeof e.signal === "string" ? `killed by ${e.signal}` : e.message;
    throw new GitError(`Failed to run git ${args.join(" ")}: ${why}`, { cause: err });
  }
}
