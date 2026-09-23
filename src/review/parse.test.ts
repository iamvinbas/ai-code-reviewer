import { describe, expect, it } from "vitest";
import { createPathFilter, DEFAULT_SKIP } from "./filter.js";
import { extractJsonValue, parseResponse } from "./parse.js";

describe("extractJsonValue", () => {
  it("accepts plain, fenced and embedded JSON", () => {
    expect(extractJsonValue('{"issues":[]}')).toEqual({ issues: [] });
    expect(extractJsonValue('Sure!\n```json\n{"issues":[]}\n```')).toEqual({ issues: [] });
    expect(extractJsonValue('Here: {"issues":[{"t":"a } b"}]} done')).toEqual({ issues: [{ t: "a } b" }] });
    expect(() => extractJsonValue("no json here")).toThrow();
  });
});

describe("parseResponse", () => {
  it("validates, trims, coerces and drops unknown fields", () => {
    const out = parseResponse(
      JSON.stringify({
        issues: [
          { severity: " Warning ", line: "12", title: "  t  ", message: "m", extra: 1, fix: { startLine: 1 } },
          { severity: "critical", line: null, title: "x", category: "security" },
        ],
      }),
    );
    expect(out).toEqual({
      ok: true,
      dropped: [],
      issues: [
        { severity: "warning", line: 12, title: "t", message: "m", fix: null },
        { severity: "critical", line: null, title: "x", message: "", category: "security" },
      ],
    });
  });

  it("reports invalid issues and invalid envelopes", () => {
    const out = parseResponse('{"issues":[{"severity":"high","title":"x"},{"severity":"warning","title":"ok"}]}');
    expect(out.ok && out.issues.length).toBe(1);
    expect(out.ok && out.dropped[0]).toMatch(/issues\[0\]/);
    expect(parseResponse('{"result":[]}')).toMatchObject({ ok: false });
    expect(parseResponse("[]")).toEqual({ ok: true, issues: [], dropped: [] });
  });
});

describe("createPathFilter", () => {
  it("skips lockfiles, generated output, vendored code and assets by default", () => {
    const accept = createPathFilter({ include: [], exclude: [] });
    for (const p of [
      "package-lock.json",
      "web/yarn.lock",
      "go.sum",
      "public/app.min.js",
      "dist/index.js",
      "packages/x/build/out.js",
      "vendor/lib.php",
      "node_modules/a/index.js",
      "img/logo.png",
      "fonts/a.woff2",
      "a.js.map",
    ]) {
      expect(accept(p), p).toBe(false);
    }
    for (const p of [".github/workflows/ci.yml", "package.json", "README.md", "src/app.ts", ".env.example"]) {
      expect(accept(p), p).toBe(true);
    }
    expect(DEFAULT_SKIP.length).toBeGreaterThan(10);
  });

  it("applies include and exclude (basename patterns match anywhere)", () => {
    const accept = createPathFilter({ include: ["src/**"], exclude: ["*.gen.ts", "src/legacy/**"] });
    expect(accept("src/a.ts")).toBe(true);
    expect(accept("lib/a.ts")).toBe(false);
    expect(accept("src/deep/x.gen.ts")).toBe(false);
    expect(accept("src/legacy/old.ts")).toBe(false);
    expect(accept("src/.hidden/a.ts")).toBe(true);
  });
});
