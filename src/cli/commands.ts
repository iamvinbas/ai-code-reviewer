import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import pc from "picocolors";
import {
  addIgnoreIds,
  configTemplate,
  findRepoRoot,
  loadConfig,
  REPO_CONFIG_FILES,
  type LoadedConfig,
} from "../config/index.js";
import { HOOK_KINDS, hookStatus, installHook, uninstallHook, type HookKind } from "../hooks/index.js";
import { createProvider, PRESETS } from "../llm/index.js";
import { EXIT, LLMError } from "../types.js";
import { UsageError, validateIgnoreIds } from "./options.js";
import { processIo, type Io } from "./review.js";

const execFileAsync = promisify(execFile);

function requireRepoRoot(cwd: string): string {
  const root = findRepoRoot(cwd);
  if (!root) throw new UsageError("not inside a git repository (run `git init`, or pass --cwd <repo>)");
  return root;
}

// ─── init ────────────────────────────────────────────────────────────────────

export async function initCommand(opts: { force?: boolean }, cwd: string, io: Io = processIo): Promise<number> {
  const c = pc.createColors(pc.isColorSupported);
  const root = requireRepoRoot(cwd);
  const existing = REPO_CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p));
  if (existing && !opts.force) {
    throw new UsageError(`${relative(cwd, existing) || existing} already exists (use --force to overwrite)`);
  }
  const path = existing ?? join(root, ".acr.yml");
  await writeFile(path, configTemplate());
  io.out(`${c.green("✔")} ${existing ? "Overwrote" : "Created"} ${path}`);
  io.out(
    [
      "",
      "Next steps:",
      `  1. Free & private (default): install Ollama (https://ollama.com), then ${c.bold("ollama pull qwen2.5-coder:14b")}`,
      "     or pick a hosted free tier in .acr.yml (groq, gemini, openrouter, cerebras) and export its API key.",
      `  2. ${c.bold("acr doctor")} to check git, config and provider`,
      `  3. ${c.bold("acr hook install")} to review staged changes before every commit`,
      "",
      c.dim("Commit .acr.yml (and .acr/ignore) to share the rules with your team."),
      c.dim("If you set cache.dir to a repo folder such as .acr/cache, add `.acr/cache/` to .gitignore."),
    ].join("\n"),
  );
  return EXIT.OK;
}

// ─── ignore ──────────────────────────────────────────────────────────────────

export async function ignoreCommand(ids: string[], cwd: string, io: Io = processIo): Promise<number> {
  const root = requireRepoRoot(cwd);
  const { path, added, existing } = await addIgnoreIds(root, validateIgnoreIds(ids));
  const file = relative(root, path);
  if (added.length) io.out(`Added ${added.join(", ")} to ${file}`);
  if (existing.length) io.out(`Already ignored: ${existing.join(", ")}`);
  return EXIT.OK;
}

// ─── hook ────────────────────────────────────────────────────────────────────

export async function hookInstallCommand(
  kind: HookKind,
  opts: { force?: boolean },
  cwd: string,
  io: Io = processIo,
): Promise<number> {
  const c = pc.createColors(pc.isColorSupported);
  const { path, action } = await installHook(kind, { cwd, force: opts.force });
  const verb = { created: "Installed", updated: "Updated", skipped: "Already up to date:" }[action];
  io.out(`${c.green("✔")} ${verb} ${kind} hook (${path})`);
  const bypass = kind === "pre-commit" ? "git commit --no-verify" : "git push --no-verify";
  io.out(c.dim(`Skip it once with \`${bypass}\`. Remove with \`acr hook uninstall ${kind}\`.`));
  if (kind === "pre-commit") {
    io.out(c.dim("Local models can be slow: `acr hook install pre-push` reviews once per push instead."));
  }
  return EXIT.OK;
}

export async function hookUninstallCommand(kind: HookKind | undefined, cwd: string, io: Io = processIo): Promise<number> {
  for (const k of kind ? [kind] : HOOK_KINDS) {
    const removed = await uninstallHook(k, { cwd });
    io.out(removed ? `Removed acr from ${k} hook` : `acr is not installed in ${k} hook`);
  }
  return EXIT.OK;
}

// ─── doctor ──────────────────────────────────────────────────────────────────

export async function doctorCommand(cwd: string, io: Io = processIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const c = pc.createColors(pc.isColorSupported);
  let failed = false;
  const ok = (text: string) => io.out(`${c.green("✔")} ${text}`);
  const bad = (text: string) => {
    failed = true;
    io.out(`${c.red("✖")} ${text}`);
  };
  const note = (text: string) => io.out(`  ${c.dim(text)}`);
  const warn = (text: string) => io.out(`  ${c.yellow("!")} ${text}`);

  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    ok(stdout.trim());
  } catch {
    bad("git not found on PATH");
  }

  const root = findRepoRoot(cwd);
  if (root) ok(`repository: ${root}`);
  else bad(`not inside a git repository (${cwd})`);

  let loaded: LoadedConfig | null = null;
  try {
    loaded = await loadConfig({ cwd, env });
    ok("config is valid");
    if (loaded.sources.length) for (const s of loaded.sources) note(`from ${s}`);
    else note("built-in defaults (run `acr init` to create .acr.yml)");
    for (const w of loaded.warnings) warn(w);
  } catch (err) {
    bad(`config: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (loaded) {
    const { provider: p, ai } = loaded.config;
    const preset = PRESETS[p.preset];
    const baseUrl =
      p.baseUrl ?? (p.preset === "ollama" && env.OLLAMA_HOST ? `from OLLAMA_HOST=${env.OLLAMA_HOST}` : preset.baseUrl);
    const model = p.model ?? preset.model;
    const keyEnv = p.apiKeyEnv ?? preset.apiKeyEnv;
    io.out(
      `${c.bold("provider")} ${p.preset} · model ${model || c.red("(not set)")} · ${baseUrl || c.red("(no baseUrl)")}`,
    );
    if (keyEnv) note(`API key env ${keyEnv}: ${env[keyEnv]?.trim() ? "set" : "not set"}`);
    if (p.preset === "ollama") {
      const numCtx = env.ACR_OLLAMA_NUM_CTX?.trim();
      note(
        numCtx
          ? `num_ctx ${numCtx} (ACR_OLLAMA_NUM_CTX)`
          : "num_ctx sized per request (pin it with ACR_OLLAMA_NUM_CTX)",
      );
    }

    if (!ai.enabled) {
      note("AI disabled (ai.enabled: false): only offline checks will run");
    } else {
      try {
        const provider = createProvider(p, env);
        const started = Date.now();
        await provider.ping();
        ok(`provider reachable, model available (${Date.now() - started}ms)`);
      } catch (err) {
        if (err instanceof LLMError && err.code !== "config") bad(`provider: ${err.message}`);
        else bad(`provider config: ${err instanceof Error ? err.message : String(err)}`);
        if (preset.docsUrl) note(`docs: ${preset.docsUrl}`);
      }
    }
  }

  if (root) {
    for (const kind of HOOK_KINDS) {
      try {
        const { installed, path } = await hookStatus(kind, { cwd });
        if (installed) ok(`${kind} hook installed (${path})`);
        else note(`${kind} hook not installed (acr hook install ${kind})`);
      } catch (err) {
        warn(`${kind} hook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return failed ? EXIT.ISSUES : EXIT.OK;
}
