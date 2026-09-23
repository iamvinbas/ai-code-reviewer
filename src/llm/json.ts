import { LLMError } from "../types.js";

const MAX_CANDIDATES = 64;

/** Parses JSON from model output: raw JSON, ```json fences, or the first valid balanced {...}/[...] in prose. */
export function extractJson(text: string): unknown {
  const cleaned = text
    .replace(/^﻿/, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const direct = tryParse(cleaned);
  if (direct.ok) return direct.value;

  for (const m of cleaned.matchAll(/```[ \t]*(?:json5?|jsonc)?[ \t]*\r?\n?([\s\S]*?)```/gi)) {
    const fenced = tryParse((m[1] ?? "").trim());
    if (fenced.ok) return fenced.value;
  }

  let attempts = 0;
  for (let i = 0; i < cleaned.length && attempts < MAX_CANDIDATES; i++) {
    const ch = cleaned[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = balancedEnd(cleaned, i);
    if (end === -1) continue;
    attempts++;
    const candidate = tryParse(cleaned.slice(i, end + 1));
    if (candidate.ok) return candidate.value;
  }

  throw new LLMError("bad_response", `Model did not return valid JSON: ${excerpt(text)}`);
}

/** Conservative token estimate (~3.5 chars/token): overestimates for English, roughly right for code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(empty)";
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}…` : flat);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Index of the bracket closing the one at `start`, ignoring brackets inside strings; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
