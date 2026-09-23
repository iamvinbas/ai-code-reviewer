/* Test-only helpers: hand-built diffs, fake GitApi and fake LLMProvider. */
import type {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  Config,
  DiffLine,
  FileDiff,
  FileSource,
  FileStatus,
  GitApi,
  Hunk,
  LLMProvider,
} from "../types.js";

export interface HunkSpec {
  oldStart?: number;
  newStart: number;
  /** Lines prefixed with "+", "-" or " ". */
  lines: string[];
}

export function makeHunk(spec: HunkSpec): Hunk {
  let oldN = spec.oldStart ?? spec.newStart;
  let newN = spec.newStart;
  const lines: DiffLine[] = spec.lines.map((raw) => {
    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") return { kind: "add", content, oldLine: null, newLine: newN++ };
    if (marker === "-") return { kind: "del", content, oldLine: oldN++, newLine: null };
    return { kind: "context", content, oldLine: oldN++, newLine: newN++ };
  });
  const oldLines = lines.filter((l) => l.kind !== "add").length;
  const newLines = lines.filter((l) => l.kind !== "del").length;
  const oldStart = spec.oldStart ?? spec.newStart;
  return {
    header: `@@ -${oldStart},${oldLines} +${spec.newStart},${newLines} @@`,
    oldStart,
    oldLines,
    newStart: spec.newStart,
    newLines,
    lines,
  };
}

export function makeFile(
  path: string,
  hunks: HunkSpec[],
  opts: { status?: FileStatus; binary?: boolean; oldPath?: string } = {},
): FileDiff {
  const built = hunks.map(makeHunk);
  const all = built.flatMap((h) => h.lines);
  return {
    path,
    oldPath: opts.oldPath ?? null,
    status: opts.status ?? "modified",
    binary: opts.binary ?? false,
    hunks: built,
    additions: all.filter((l) => l.kind === "add").length,
    deletions: all.filter((l) => l.kind === "del").length,
  };
}

/** A brand-new file whose lines are all additions. */
export function addedFile(path: string, lines: string[]): FileDiff {
  return makeFile(path, [{ oldStart: 0, newStart: 1, lines: lines.map((l) => `+${l}`) }], { status: "added" });
}

export function fakeGit(
  files: FileDiff[] | Error,
  contents: Record<string, string> = {},
  root = "/repo",
): GitApi & {
  reads: Array<{ path: string; source: FileSource }>;
} {
  const reads: Array<{ path: string; source: FileSource }> = [];
  return {
    reads,
    repoRoot: async () => root,
    getDiff: async () => {
      if (files instanceof Error) throw files;
      return files;
    },
    readFile: async (path, source) => {
      reads.push({ path, source });
      return contents[path] ?? null;
    },
    defaultBase: async () => "origin/main",
  };
}

export type FakeReply = string | Error | ((messages: ChatMessage[]) => string);

export function fakeProvider(replies: FakeReply[] | ((messages: ChatMessage[]) => string)): LLMProvider & {
  calls: Array<{ messages: ChatMessage[]; opts: CompletionOptions | undefined }>;
} {
  const calls: Array<{ messages: ChatMessage[]; opts: CompletionOptions | undefined }> = [];
  let i = 0;
  return {
    name: "fake",
    model: "fake-model",
    calls,
    async complete(messages, opts): Promise<CompletionResult> {
      calls.push({ messages, opts });
      const reply = typeof replies === "function" ? replies : replies[Math.min(i++, replies.length - 1)];
      if (reply === undefined) throw new Error("no fake reply configured");
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === "function" ? reply(messages) : reply };
    },
    async ping() {},
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: { preset: "ollama" },
    failOn: "critical",
    onError: "warn",
    include: [],
    exclude: [],
    rules: [],
    language: "en",
    maxFiles: 50,
    maxChunkTokens: 8000,
    contextLines: 0,
    ai: { enabled: true },
    checks: {
      secrets: true,
      conflictMarkers: true,
      debugStatements: true,
      largeFiles: { enabled: true, maxKb: 500 },
    },
    cache: { enabled: false },
    ignore: [],
    ...overrides,
  };
}
