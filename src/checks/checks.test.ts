import { describe, expect, it } from "vitest";
import { addedFile, fakeGit, makeFile, testConfig } from "../review/testing.js";
import type { Check, Config, FileDiff, Issue } from "../types.js";
import { builtinChecks } from "./index.js";
import { isTestFile, shannonEntropy } from "./util.js";

// Fixtures are assembled at runtime so this file never contains a literal credential.
const j = (...parts: string[]): string => parts.join("");
const GH = j("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
const GH_PAT = j("github", "_pat_", "11ABCDEFG0123456789_abcdefghijklmnopqrstuv");
const AWS_ID = j("AK", "IA", "Z3MHALQ5T7XK2P4B");
const AWS_SECRET = j("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYzq8Rt3Lm9W");
const SLACK = j("xo", "xb-", "1234567890-abcdefghij");
const STRIPE = j("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc");
const GOOGLE = j("AI", "za", "SyD8f3kL9qX2mN7pR4tV6wY1zB5cE0gH3jK");
const OPENAI = j("sk", "-proj-", "Ab3dEf6hIj9kLm2nOp5qRs8t");
const ANTHROPIC = j("sk", "-ant-", "api03-Zx9Yw8Vu7Ts6Rq5Po4Nm");
const JWT = j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
const PASS = j("Tr0ub4", "dor&3xQ");
const PEM = j("-----BEGIN ", "RSA PRIVATE KEY-----");

async function run(files: FileDiff[], config: Config = testConfig()): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const check of builtinChecks(config)) out.push(...(await check.run(files, { config, git: fakeGit(files) })));
  return out;
}

const only = (id: string, config: Config = testConfig()): Check => {
  const check = builtinChecks(config).find((c) => c.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check;
};

const runOne = async (id: string, files: FileDiff[], config = testConfig()): Promise<Issue[]> =>
  only(id, config).run(files, { config, git: fakeGit(files) });

describe("builtinChecks", () => {
  it("returns all checks with ids and descriptions, honoring toggles", () => {
    const all = builtinChecks(testConfig());
    expect(all.map((c) => c.id)).toEqual(["secrets", "conflict-markers", "debug-statements", "large-files"]);
    for (const c of all) expect(c.description.length).toBeGreaterThan(10);

    const none = builtinChecks(
      testConfig({
        checks: { secrets: false, conflictMarkers: false, debugStatements: false, largeFiles: { enabled: false, maxKb: 1 } },
      }),
    );
    expect(none).toEqual([]);
  });

  it("only inspects added lines and reports new-file line numbers", async () => {
    const file = makeFile("src/a.ts", [
      { oldStart: 10, newStart: 20, lines: [" const a = 1;", `-const t = "${GH}";`, "+console.log(a);", " return a;"] },
    ]);
    const issues = await run([file]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: "debug-statements/console-log", line: 21, source: "check" });
    expect(issues[0]?.id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("secrets", () => {
  const cases: Array<[string, string]> = [
    ["secrets/github-token", `const token = "${GH}";`],
    ["secrets/github-token", `GH=${GH_PAT}`],
    ["secrets/aws-access-key", `aws_access_key_id = ${AWS_ID}`],
    ["secrets/aws-secret-key", `aws_secret_access_key = "${AWS_SECRET}"`],
    ["secrets/slack-token", `slack: "${SLACK}"`],
    ["secrets/stripe-key", `stripe.setKey('${STRIPE}')`],
    ["secrets/google-api-key", `const key = "${GOOGLE}"`],
    ["secrets/openai-key", `OPENAI_API_KEY="${OPENAI}"`],
    ["secrets/anthropic-key", `client = Anthropic(api_key="${ANTHROPIC}")`],
    ["secrets/jwt", `headers.Authorization = "Bearer ${JWT}"`],
    ["secrets/private-key", PEM],
    ["secrets/generic", `const dbPassword = "${PASS}";`],
    ["secrets/generic", `"api_key": "${j("q8Zr2LmP", "0vX7nK4w")}"`],
    ["secrets/generic", `DB_PASSWORD=${j("Qm7vR2zX", "9pL4tK8w")}`],
  ];

  it.each(cases)("detects %s", async (ruleId, line) => {
    const issues = await runOne("secrets", [addedFile("config/app.ts", [line])]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId, severity: "critical", line: 1, file: "config/app.ts" });
  });

  it("masks the secret in the message", async () => {
    const issues = await runOne("secrets", [
      addedFile("a.ts", [`const token = "${GH}";`, `password = "${PASS}"`]),
    ]);
    expect(issues).toHaveLength(2);
    const text = JSON.stringify(issues);
    expect(text).not.toContain(GH);
    expect(text).not.toContain(PASS);
    expect(issues[0]?.message).toContain(`${GH.slice(0, 4)}****`);
    expect(issues[1]?.message).toContain("Tr0u****");
  });

  const negatives = [
    `password = "your_password_here"`,
    `api_key: "xxxxxxxxxxxxxxxx"`,
    `const secret = "changeme";`,
    `token = "<YOUR_TOKEN>"`,
    `password: "\${DB_PASSWORD}"`,
    `const apiKey = process.env.API_KEY;`,
    `API_KEY = os.environ["API_KEY"]`,
    `secret = "example-secret-value"`,
    `aws_access_key_id = ${j("AKIA", "IOSFODNN7EXAMPLE")}`,
    `const password = config.database.password;`,
    `const token = getToken(user);`,
    `password = "aaaaaaaaaaaa"`,
    `const passwordHash = "3f786850e387550fdab836ed7e6dc881de23001b";`,
    `const label = "Enter your password";`,
    `if (token === "abcdef12345678") {}`,
    `const tokenizer = "bert-base-uncased-v2";`,
    `const pwd = "short";`,
  ];

  it.each(negatives)("ignores %s", async (line) => {
    expect(await runOne("secrets", [addedFile("src/x.ts", [line])])).toEqual([]);
  });

  it("does not double-report a provider token also matched by the generic rule", async () => {
    const issues = await runOne("secrets", [addedFile("a.ts", [`GITHUB_TOKEN="${GH}"`])]);
    expect(issues.map((i) => i.ruleId)).toEqual(["secrets/github-token"]);
  });

  it("skips binary files", async () => {
    const bin = { ...addedFile("a.bin", []), binary: true };
    expect(await runOne("secrets", [bin])).toEqual([]);
  });
});

describe("conflict-markers", () => {
  it("reports each conflict once at the start marker", async () => {
    const issues = await runOne("conflict-markers", [
      addedFile("src/a.ts", ["<<<<<<< HEAD", "const a = 1;", "=======", "const a = 2;", ">>>>>>> feature", "ok();"]),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: "conflict-markers", severity: "critical", line: 1 });
  });

  it("reports stray markers", async () => {
    const issues = await runOne("conflict-markers", [addedFile("src/a.py", ["x = 1", "=======", ">>>>>>> main"])]);
    expect(issues.map((i) => i.line)).toEqual([2, 3]);
  });

  it("allows a lone ======= in markdown (setext heading)", async () => {
    expect(await runOne("conflict-markers", [addedFile("README.md", ["Title", "======="])])).toEqual([]);
  });

  it("ignores lookalikes", async () => {
    const lines = ["// <<<<<<< not at start", "======== eight", "a <<<<<<< b"];
    expect(await runOne("conflict-markers", [addedFile("src/a.ts", lines)])).toEqual([]);
  });
});

describe("debug-statements", () => {
  it("flags JS/TS debug code with the right severity", async () => {
    const issues = await runOne("debug-statements", [
      addedFile("src/app.tsx", ["debugger;", "console.log('x');", "  console.debug(y)", "// console.log('commented')", "logger.log(z);"]),
    ]);
    expect(issues.map((i) => [i.ruleId, i.severity, i.line])).toEqual([
      ["debug-statements/debugger", "warning", 1],
      ["debug-statements/console-log", "suggestion", 2],
      ["debug-statements/console-log", "suggestion", 3],
    ]);
  });

  it("flags Python breakpoints and print", async () => {
    const issues = await runOne("debug-statements", [
      addedFile("app/main.py", ["import pdb", "pdb.set_trace()", "breakpoint()", "print('hi')", "# print('no')", "self.breakpoint()"]),
    ]);
    expect(issues.map((i) => [i.ruleId, i.line])).toEqual([
      ["debug-statements/pdb", 1],
      ["debug-statements/pdb", 2],
      ["debug-statements/pdb", 3],
      ["debug-statements/print", 4],
    ]);
  });

  it("flags Ruby and PHP helpers", async () => {
    const issues = await runOne("debug-statements", [
      addedFile("app/models/user.rb", ["binding.pry", "puts 'x'"]),
      addedFile("src/Controller.php", ["var_dump($x);", "dd($request);", "$this->add($x);", "$obj->dd($y);"]),
    ]);
    expect(issues.map((i) => [i.file, i.ruleId, i.line])).toEqual([
      ["app/models/user.rb", "debug-statements/pry", 1],
      ["src/Controller.php", "debug-statements/php-dump", 1],
      ["src/Controller.php", "debug-statements/php-dump", 2],
    ]);
  });

  it("allows console.log/print in tests but still flags breakpoints", async () => {
    const issues = await runOne("debug-statements", [
      addedFile("src/a.test.ts", ["console.log(1);", "debugger;"]),
      addedFile("tests/test_api.py", ["print(1)"]),
      addedFile("src/__tests__/b.js", ["console.log(2)"]),
    ]);
    expect(issues.map((i) => i.ruleId)).toEqual(["debug-statements/debugger"]);
  });

  it("ignores other languages", async () => {
    expect(await runOne("debug-statements", [addedFile("main.go", ["print(1)", "console.log(1)"])])).toEqual([]);
  });
});

describe("large-files", () => {
  const config = testConfig({
    checks: { secrets: true, conflictMarkers: true, debugStatements: true, largeFiles: { enabled: true, maxKb: 1 } },
  });

  it("flags files adding more than maxKb", async () => {
    const big = addedFile("data/big.json", Array.from({ length: 30 }, () => "x".repeat(50)));
    const small = addedFile("src/small.ts", ["const a = 1;"]);
    const issues = await runOne("large-files", [big, small], config);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ruleId: "large-files/size", severity: "warning", line: null, file: "data/big.json" });
  });

  it("flags new binary files only", async () => {
    const added = { ...makeFile("lib/tool.jar", [], { status: "added" }), binary: true };
    const modified = { ...makeFile("lib/other.jar", []), binary: true };
    const issues = await runOne("large-files", [added, modified], config);
    expect(issues.map((i) => [i.file, i.ruleId])).toEqual([["lib/tool.jar", "large-files/binary"]]);
  });

  it("does not flag new images and fonts, but still flags other binaries", async () => {
    const bin = (path: string): FileDiff => ({ ...makeFile(path, [], { status: "added" }), binary: true });
    const assets = ["a.png", "b.svg", "c.ico", "d.jpg", "e.gif", "f.webp", "g.avif", "h.woff", "i.woff2", "j.ttf", "k.otf", "l.eot", "M.PNG"];
    const others = ["x.zip", "x.jar", "x.exe", "x.so", "x.dylib", "x.pdf", "x.db", "x.sqlite", "x.bin"];
    const issues = await runOne("large-files", [...assets, ...others].map(bin), config);
    expect(issues.map((i) => i.file)).toEqual(others);
  });
});

describe("util", () => {
  it("detects test files", () => {
    for (const p of ["a.test.ts", "src/b.spec.js", "src/__tests__/c.ts", "tests/d.py", "pkg/test_e.py", "f_test.py"]) {
      expect(isTestFile(p), p).toBe(true);
    }
    for (const p of ["src/testing.ts", "src/contest.ts", "latest/a.ts"]) expect(isTestFile(p), p).toBe(false);
  });

  it("computes entropy", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });

  it("gives ids that do not depend on the line number", async () => {
    const a = await runOne("debug-statements", [addedFile("a.ts", ["console.log(1);"])]);
    const b = await runOne("debug-statements", [addedFile("a.ts", ["", "", "  console.log(1);"])]);
    expect(a[0]?.id).toBeDefined();
    expect(a[0]?.id).toBe(b[0]?.id);
  });
});
