import type { DiffLine, FileDiff, FileStatus, Hunk } from "../types.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Decodes a C-quoted string as emitted by git (`"a/\303\261 x.txt"`), starting at `s[0] === '"'`.
 * Octal escapes are raw bytes, so the result is re-assembled as UTF-8.
 * Returns the decoded value and the index just past the closing quote, or null if malformed.
 */
export function cUnquote(s: string): { value: string; end: number } | null {
  if (s[0] !== '"') return null;
  const bytes: number[] = [];
  let i = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === undefined) return null;
      const oct = /^[0-7]{3}/.exec(s.slice(i + 1, i + 4));
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += 4;
        continue;
      }
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const str = String.fromCodePoint(cp);
    for (const b of Buffer.from(str, "utf8")) bytes.push(b);
    i += str.length;
  }
  return null;
}

function stripPrefix(p: string, prefix: "a/" | "b/"): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Splits the part of `diff --git ` after the command into its (still prefixed) a/ and b/ paths. */
function splitGitHeaderPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const first = cUnquote(rest);
    if (!first || rest[first.end] !== " ") return null;
    const second = rest.slice(first.end + 1);
    const b = second.startsWith('"') ? cUnquote(second)?.value : second;
    return b === undefined ? null : [first.value, b];
  }
  if (rest.endsWith('"')) {
    // Unquoted names never contain '"', so the first ` "` is the separator.
    const sep = rest.indexOf(' "');
    const b = sep >= 0 ? cUnquote(rest.slice(sep + 1))?.value : undefined;
    return b === undefined ? null : [rest.slice(0, sep), b];
  }
  // Unquoted, possibly with spaces: when both sides name the same file the line is symmetric.
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === " " && a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) {
      return [a, b];
    }
  }
  const sep = rest.indexOf(" b/");
  return sep >= 0 ? [rest.slice(0, sep), rest.slice(sep + 1)] : null;
}

/** Path from a `---`/`+++` line (after the marker). null = /dev/null. */
function parseMarkerPath(s: string, prefix: "a/" | "b/"): string | null {
  let p: string;
  if (s.startsWith('"')) {
    p = cUnquote(s)?.value ?? s;
  } else {
    // git appends "\t" to names containing spaces; plain `diff -u` puts a timestamp after a tab.
    const tab = s.indexOf("\t");
    p = tab >= 0 ? s.slice(0, tab) : s;
  }
  return p === "/dev/null" ? null : stripPrefix(p, prefix);
}

/** Path from `rename from X` / `copy to X` lines: no a/ b/ prefix, possibly quoted. */
function parseBarePath(s: string): string {
  return s.startsWith('"') ? (cUnquote(s)?.value ?? s) : s;
}

interface FileBuilder {
  headerOld: string | null;
  headerNew: string | null;
  /** undefined = no `---` line seen; null = `/dev/null`. */
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  copyTo: string | null;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

function newBuilder(headerOld: string | null = null, headerNew: string | null = null): FileBuilder {
  return {
    headerOld,
    headerNew,
    minus: undefined,
    plus: undefined,
    renameFrom: null,
    renameTo: null,
    copyTo: null,
    isNew: false,
    isDeleted: false,
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

function finish(b: FileBuilder): FileDiff | null {
  let status: FileStatus;
  if (b.renameFrom !== null && b.renameTo !== null) status = "renamed";
  else if (b.isNew || b.minus === null || b.copyTo !== null) status = "added";
  else if (b.isDeleted || b.plus === null) status = "deleted";
  else status = "modified";

  const newPath = b.renameTo ?? b.copyTo ?? b.plus ?? b.headerNew;
  const oldPath = b.renameFrom ?? b.minus ?? b.headerOld;
  const path = status === "deleted" ? (oldPath ?? newPath) : (newPath ?? oldPath);
  if (!path) return null;

  return {
    path,
    oldPath: status === "renamed" ? b.renameFrom : null,
    status,
    binary: b.binary,
    hunks: b.hunks,
    additions: b.additions,
    deletions: b.deletions,
  };
}

function stripCR(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/**
 * Parses `git diff` (unified, `--git` format) output into FileDiffs.
 *
 * - Files with no hunks (mode-only changes, pure renames, empty new files, binaries) are kept.
 * - Copies (`copy from/to`, only with -C) are reported as "added" files.
 * - Combined diffs (`diff --cc`, merges) are skipped.
 * - Plain `diff -u` output without `diff --git` headers is accepted too.
 * - A trailing "\r" is stripped from every line (CRLF files render cleanly).
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const files: FileDiff[] = [];
  let cur: FileBuilder | null = null;
  let inCombined = false;
  const flush = (): void => {
    if (cur) {
      const f = finish(cur);
      if (f) files.push(f);
    }
    cur = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = stripCR(lines[i]!);

    if (line.startsWith("diff --git ")) {
      flush();
      inCombined = false;
      const paths = splitGitHeaderPaths(line.slice("diff --git ".length));
      cur = paths ? newBuilder(stripPrefix(paths[0], "a/"), stripPrefix(paths[1], "b/")) : newBuilder();
      i++;
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      flush();
      inCombined = true;
      i++;
      continue;
    }
    if (inCombined) {
      i++;
      continue;
    }

    const isFilePair = line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ");
    // Plain unified diff: a new `---`/`+++` pair starts a new file.
    if (isFilePair && (cur === null || (cur.minus !== undefined && cur.headerNew === null))) {
      flush();
      cur = newBuilder();
    }
    if (cur === null) {
      i++; // preamble (e.g. commit message from `git show`)
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      i = parseHunk(lines, i, line, m, cur);
      continue;
    }

    if (isFilePair) cur.minus = parseMarkerPath(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) cur.plus = parseMarkerPath(line.slice(4), "b/");
    else if (line.startsWith("new file mode ")) cur.isNew = true;
    else if (line.startsWith("deleted file mode ")) cur.isDeleted = true;
    else if (line.startsWith("rename from ")) cur.renameFrom = parseBarePath(line.slice(12));
    else if (line.startsWith("rename to ")) cur.renameTo = parseBarePath(line.slice(10));
    else if (line.startsWith("copy to ")) cur.copyTo = parseBarePath(line.slice(8));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    // Everything else (index, old/new mode, similarity, binary patch data...) carries nothing we need.
    i++;
  }
  flush();
  return files;
}

/** Consumes one hunk starting at `lines[start]` (its header); returns the index of the next unread line. */
function parseHunk(lines: string[], start: number, header: string, m: RegExpExecArray, file: FileBuilder): number {
  const oldStart = Number(m[1]);
  const oldLines = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newLines = m[4] === undefined ? 1 : Number(m[4]);
  const out: DiffLine[] = [];

  let oldRem = oldLines;
  let newRem = newLines;
  let o = oldStart;
  let n = newStart;
  let i = start + 1;

  // Driven by the header counts, so content that looks like a header ("+++ x", "diff --git") is safe.
  while (i < lines.length) {
    const raw = lines[i]!;
    const marker = raw[0];
    if (marker === "\\") {
      i++; // "\ No newline at end of file"
      continue;
    }
    if (oldRem <= 0 && newRem <= 0) break;
    const content = stripCR(raw.slice(1));
    if (marker === "+" && newRem > 0) {
      out.push({ kind: "add", content, oldLine: null, newLine: n++ });
      newRem--;
      file.additions++;
    } else if (marker === "-" && oldRem > 0) {
      out.push({ kind: "del", content, oldLine: o++, newLine: null });
      oldRem--;
      file.deletions++;
    } else if ((marker === " " || raw === "" || raw === "\r") && oldRem > 0 && newRem > 0) {
      // An empty line is a blank context line under `diff.suppressBlankEmpty`.
      out.push({ kind: "context", content, oldLine: o++, newLine: n++ });
      oldRem--;
      newRem--;
    } else {
      break; // truncated or malformed hunk: keep what we have
    }
    i++;
  }

  file.hunks.push({ header, oldStart, oldLines, newStart, newLines, lines: out });
  return i;
}
