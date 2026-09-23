import type { ProgressEvent } from "../types.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Progress {
  update(text: string): void;
  stop(): void;
}

const NOOP: Progress = { update() {}, stop() {} };

/** Spinner on stderr; a no-op unless stderr is an interactive terminal. */
export function createProgress(stream: NodeJS.WriteStream = process.stderr, enabled = true): Progress {
  if (!enabled || !stream.isTTY || process.env.CI) return NOOP;
  let text = "";
  let frame = 0;
  const render = () => {
    const width = Math.max(20, (stream.columns || 80) - 3);
    const line = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    stream.write(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${line}`);
  };
  let timer: NodeJS.Timeout | null = null;
  return {
    update(next) {
      text = next;
      if (!timer) {
        timer = setInterval(render, 80);
        timer.unref();
      }
      render();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      stream.write("\r\x1b[2K");
    },
  };
}

function listFiles(files: string[], max = 3): string {
  const shown = files.slice(0, max).join(", ");
  return files.length > max ? `${shown} +${files.length - max} more` : shown;
}

/** Human-readable progress line. Chunk indexes are 0-based in events and shown 1-based. */
export function describeProgress(e: ProgressEvent): string {
  switch (e.type) {
    case "diff":
      return `Found ${e.files} changed file${e.files === 1 ? "" : "s"}…`;
    case "checks:done":
      return `Offline checks done (${e.issues} issue${e.issues === 1 ? "" : "s"})…`;
    case "chunk:start":
      return `Reviewing chunk ${e.index + 1}/${e.total} (${listFiles(e.files)})…`;
    case "chunk:done":
      return `Reviewed chunk ${e.index + 1}/${e.total}${e.cached ? " (cached)" : ""}…`;
    case "chunk:error":
      return `Chunk ${e.index + 1}/${e.total} failed: ${e.message}`;
  }
}
