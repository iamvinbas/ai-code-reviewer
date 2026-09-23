import type { Check, FileDiff, Issue } from "../types.js";
import { addedLines, checkIssue, extension } from "./util.js";

const START = /^<{7}(?: |$)/;
const MIDDLE = /^={7}$/;
const END = /^>{7}(?: |$)/;
const BASE = /^\|{7}(?: |$)/;

/** Where a lone "=======" is legitimate (setext heading underline). */
const PROSE_EXTENSIONS = new Set(["md", "markdown", "mdx", "rst", "adoc", "txt"]);

function scanFile(file: FileDiff): Issue[] {
  const issues: Issue[] = [];
  const prose = PROSE_EXTENSIONS.has(extension(file.path));
  let open = false;
  for (const { line, content } of addedLines(file)) {
    const text = content.trimEnd();
    let report = false;
    if (START.test(text)) {
      open = true;
      report = true;
    } else if (END.test(text)) {
      report = !open;
      open = false;
    } else if (!open && (BASE.test(text) || (MIDDLE.test(text) && !prose))) {
      report = true;
    }
    if (!report) continue;
    issues.push(
      checkIssue(
        {
          ruleId: "conflict-markers",
          severity: "critical",
          file: file.path,
          line,
          title: "Unresolved merge conflict marker",
          message: "A git conflict marker was added; the file still contains an unresolved merge conflict and will not work as intended.",
          suggestion: "Resolve the conflict, keep the intended code and delete the `<<<<<<<`, `=======` and `>>>>>>>` lines.",
        },
        content,
      ),
    );
  }
  return issues;
}

export const conflictMarkersCheck: Check = {
  id: "conflict-markers",
  description: "Detects unresolved git merge conflict markers in added lines.",
  run: (files) => files.filter((f) => !f.binary).flatMap(scanFile),
};
