export interface GitErrorOptions {
  cause?: unknown;
  /** stderr of the failed git command, when there was one. */
  stderr?: string;
  /** Exit code of the failed git command, when there was one. */
  exitCode?: number;
}

/** Any failure talking to git: git missing, not a repository, unknown ref, oversized output... */
export class GitError extends Error {
  readonly stderr: string | undefined;
  readonly exitCode: number | undefined;

  constructor(message: string, options: GitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitError";
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
  }
}
