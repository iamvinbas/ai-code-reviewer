import { describe, expect, it } from "vitest";
import { createRedactor, REDACTED_KEY_MATERIAL, redactSecrets } from "../checks/secrets.js";
import type { Config } from "../types.js";
import { renderFileForPrompt, runReview } from "./index.js";
import { addedFile, fakeGit, fakeProvider, makeFile, testConfig } from "./testing.js";

// Assembled at runtime so no literal credential lives in the repo.
const j = (...p: string[]): string => p.join("");
const SECRETS = {
  github: j("gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
  aws: j("AK", "IA", "Z3MHALQ5T7XK2P4B"),
  stripe: j("sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  openai: j("sk", "-proj-", "Ab3dEf6hIj9kLm2nOp5qRs8t"),
  jwt: j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  password: j("Tr0ub4", "dor&3xQ"),
  weakPassword: j("hunter", "22"),
  pemBody: j("MIIEowIBAAKCAQEA", "u1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun"),
  inlinePem: j("MIIEvQIBADANBgkq", "hkiG9w0BAQEFAASC"),
};

/** Substrings long enough to identify each secret (the 4-char mask prefix is allowed). */
const fragments = Object.values(SECRETS).map((s) => s.slice(4));

describe("redactSecrets", () => {
  it("masks provider tokens and credential literals, keeping the rest of the line", () => {
    expect(redactSecrets(`const t = "${SECRETS.github}"; call(t);`)).toBe('const t = "ghp_****[REDACTED]"; call(t);');
    expect(redactSecrets(`password = "${SECRETS.weakPassword}"`)).toBe('password = "****[REDACTED]"');
    expect(redactSecrets(`DB_PASSWORD=${SECRETS.password}`)).toBe("DB_PASSWORD=****[REDACTED]");
    expect(redactSecrets(`keys: ${SECRETS.aws} ${SECRETS.stripe}`)).toBe("keys: AKIA****[REDACTED] sk_l****[REDACTED]");
  });

  it("leaves placeholders and ordinary code untouched", () => {
    for (const line of [
      'password = "your_password_here"',
      "const apiKey = process.env.API_KEY;",
      "const token = getToken(user);",
      "const x = compute(a, b);",
    ]) {
      expect(redactSecrets(line)).toBe(line);
    }
  });

  it("hides PEM key material, inline and multi-line", () => {
    const inline = `"private_key": "-----BEGIN PRIVATE KEY-----\\n${SECRETS.inlinePem}\\n-----END PRIVATE KEY-----\\n"`;
    expect(redactSecrets(inline)).toBe('"private_key": "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----\\n"');
    const redact = createRedactor();
    const out = ["-----BEGIN RSA PRIVATE KEY-----", SECRETS.pemBody, SECRETS.pemBody, "-----END RSA PRIVATE KEY-----", "ok"].map(redact);
    expect(out).toEqual(["-----BEGIN RSA PRIVATE KEY-----", REDACTED_KEY_MATERIAL, REDACTED_KEY_MATERIAL, "-----END RSA PRIVATE KEY-----", "ok"]);
  });
});

describe("secrets never reach the provider", () => {
  const lines = [
    `const gh = "${SECRETS.github}";`,
    `aws_access_key_id = ${SECRETS.aws}`,
    `stripe.setKey('${SECRETS.stripe}')`,
    `OPENAI_API_KEY="${SECRETS.openai}"`,
    `auth = "Bearer ${SECRETS.jwt}"`,
    `const dbPassword = "${SECRETS.password}";`,
    `password: "${SECRETS.weakPassword}"`,
    "-----BEGIN PRIVATE KEY-----",
    SECRETS.pemBody,
    "-----END PRIVATE KEY-----",
    `{"private_key": "-----BEGIN PRIVATE KEY-----\\n${SECRETS.inlinePem}\\n-----END PRIVATE KEY-----\\n"}`,
  ];

  const expectClean = (text: string): void => {
    for (const f of fragments) expect(text).not.toContain(f);
  };

  it("redacts added, deleted and full-file context lines while keeping line numbers", async () => {
    const context = [`const oldToken = "${SECRETS.github}";`, "x();", "y();", "z();"];
    const file = makeFile("src/cfg.ts", [
      { oldStart: 5, newStart: 5, lines: [`-const legacy = "${SECRETS.stripe}";`, ...lines.map((l) => `+${l}`)] },
    ]);
    const full = [...context, ...lines, "tail();"].join("\n");
    const provider = fakeProvider(['{"issues":[]}']);
    const config: Config = testConfig({ contextLines: 10, cache: { enabled: false } });
    const result = await runReview({ config, target: { kind: "staged" }, git: fakeGit([file], { "src/cfg.ts": full }), provider });

    const sent = provider.calls.flatMap((c) => c.messages.map((m) => m.content)).join("\n");
    expectClean(sent);
    expect(sent).toContain("    1   const oldToken = \"ghp_****[REDACTED]\";");
    expect(sent).toContain("    5 + const gh = \"ghp_****[REDACTED]\";");
    expect(sent).toMatch(/- const legacy = "sk_l\*{4}\[REDACTED\]";/);
    expect(result.issues.filter((i) => i.ruleId?.startsWith("secrets/")).length).toBeGreaterThanOrEqual(7);
  });

  it("redacts in the retry echo and in truncated hunks too", async () => {
    const file = addedFile("src/big.ts", [...lines, ...Array.from({ length: 400 }, (_, k) => `const v${k} = ${k};`)]);
    const provider = fakeProvider(["not json", '{"issues":[]}']);
    await runReview({
      config: testConfig({ maxChunkTokens: 1500 }),
      target: { kind: "staged" },
      git: fakeGit([file]),
      provider,
    });
    expectClean(provider.calls.flatMap((c) => c.messages.map((m) => m.content)).join("\n"));
    expectClean(renderFileForPrompt(file, lines.join("\n"), 3));
  });
});
