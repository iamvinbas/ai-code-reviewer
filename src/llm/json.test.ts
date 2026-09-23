import { describe, expect, it } from "vitest";
import { LLMError } from "../types.js";
import { estimateTokens, extractJson } from "./index.js";

describe("extractJson", () => {
  it("parses raw JSON", () => {
    expect(extractJson('{"issues":[]}')).toEqual({ issues: [] });
    expect(extractJson("  [1, 2]\n")).toEqual([1, 2]);
  });

  it("parses ```json fenced blocks", () => {
    const text = 'Here you go:\n```json\n{"issues":[{"line":3}]}\n```\nDone.';
    expect(extractJson(text)).toEqual({ issues: [{ line: 3 }] });
  });

  it("parses unlabeled fences", () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("finds JSON embedded in prose, skipping invalid bracketed text", () => {
    const text = 'I reviewed [the diff] and found: {"issues":[{"title":"x"}]} — hope it helps {bye}';
    expect(extractJson(text)).toEqual({ issues: [{ title: "x" }] });
  });

  it("is string-aware (brackets and escaped quotes inside strings)", () => {
    const text = 'Result: {"msg":"use } and ] carefully \\" {","n":1} trailing';
    expect(extractJson(text)).toEqual({ msg: 'use } and ] carefully " {', n: 1 });
  });

  it("strips <think> blocks from reasoning models", () => {
    const text = '<think>maybe {"wrong": true} ... </think>\n{"issues":[]}';
    expect(extractJson(text)).toEqual({ issues: [] });
  });

  it("throws bad_response with an excerpt when no JSON is present", () => {
    try {
      extractJson("Sorry, I cannot help with that.");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).code).toBe("bad_response");
      expect((err as LLMError).message).toContain("Sorry, I cannot help");
    }
  });

  it("throws on truncated JSON", () => {
    expect(() => extractJson('{"issues":[{"title":"x"')).toThrow(LLMError);
  });

  it("throws on empty text", () => {
    expect(() => extractJson("")).toThrow(/empty/);
  });
});

describe("estimateTokens", () => {
  it("is ~chars/3.5 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("a".repeat(35))).toBe(10);
    expect(estimateTokens("a".repeat(36))).toBe(11);
  });

  it("is fast on large inputs", () => {
    const big = "x".repeat(5_000_000);
    const t = performance.now();
    expect(estimateTokens(big)).toBe(Math.ceil(5_000_000 / 3.5));
    expect(performance.now() - t).toBeLessThan(50);
  });
});
