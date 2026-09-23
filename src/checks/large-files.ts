import { isLockfile } from "../review/filter.js";
import type { Check, Config, FileDiff, Issue } from "../types.js";
import { addedLines, checkIssue, extension } from "./util.js";

/** Images and fonts are expected binaries in a repo: no "new binary" warning for them. */
const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "ico", "icns", "svg",
  "woff", "woff2", "ttf", "otf", "eot",
]);

/** Size is approximated by the UTF-8 bytes of the added lines (the diff does not carry blob sizes). */
export function addedBytes(file: FileDiff): number {
  let bytes = 0;
  for (const { content } of addedLines(file)) bytes += Buffer.byteLength(content, "utf8") + 1;
  return bytes;
}

function scanFile(file: FileDiff, maxKb: number): Issue[] {
  if (file.binary) {
    if (file.status !== "added" || ASSET_EXTENSIONS.has(extension(file.path))) return [];
    return [
      checkIssue({
        ruleId: "large-files/binary",
        severity: "warning",
        file: file.path,
        line: null,
        title: "New binary file",
        message: "A binary file is being added. Binaries stay in the repository history forever and inflate every clone.",
        suggestion: "Make sure it belongs in git; consider Git LFS or an artifact store for large binaries.",
      }),
    ];
  }
  if (isLockfile(file.path)) return [];
  const bytes = addedBytes(file);
  if (bytes <= maxKb * 1024) return [];
  const kb = Math.round(bytes / 1024);
  return [
    checkIssue({
      ruleId: "large-files/size",
      severity: "warning",
      file: file.path,
      line: null,
      title: `Large change: ~${kb} KB added (limit ${maxKb} KB)`,
      message: `This file adds about ${kb} KB. Generated, vendored or data files bloat the repository and are hard to review.`,
      suggestion: "If it is generated or data, exclude it from git (or use Git LFS); otherwise consider splitting the change.",
    }),
  ];
}

export function largeFilesCheck(config: Config): Check {
  const { maxKb } = config.checks.largeFiles;
  return {
    id: "large-files",
    description: `Flags new binary files and files adding more than ${maxKb} KB.`,
    run: (files) => files.flatMap((f) => scanFile(f, maxKb)),
  };
}
