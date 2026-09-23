import { resolve } from "node:path";
import { Argument, Command, CommanderError, Option } from "commander";
import { ConfigError } from "../config/index.js";
import { GitError } from "../git/index.js";
import type { HookKind } from "../hooks/index.js";
import { EXIT, LLMError } from "../types.js";
import {
  doctorCommand,
  hookInstallCommand,
  hookUninstallCommand,
  ignoreCommand,
  initCommand,
} from "./commands.js";
import { UsageError, type ReviewCliOptions } from "./options.js";
import { reviewCommand } from "./review.js";
import { readVersion } from "./version.js";

const TARGETS = ["staged", "working", "range", "commit"];
const others = (name: string) => TARGETS.filter((t) => t !== name);

export function buildProgram(setExitCode: (code: number) => void): Command {
  const program = new Command("acr");
  program
    .description("Local AI code review before you commit, push or merge. Free and private by default (Ollama).")
    .version(readVersion(), "-V, --version", "print the version")
    .option("-C, --cwd <dir>", "run as if acr was started in <dir>")
    .helpOption("-h, --help", "show help")
    .showSuggestionAfterError()
    .exitOverride();

  const cwd = () => resolve(program.opts<{ cwd?: string }>().cwd ?? ".");

  program
    .command("review")
    .description("review changes (default: staged changes)")
    .addOption(new Option("--staged", "review staged changes (default)").conflicts(others("staged")))
    .addOption(new Option("--working", "review all uncommitted changes vs HEAD").conflicts(others("working")))
    .addOption(
      new Option("--range [base]", "review merge-base(base, HEAD)..HEAD; base defaults to the main branch").conflicts(
        others("range"),
      ),
    )
    .addOption(new Option("--commit <sha>", "review a single commit").conflicts(others("commit")))
    .addOption(new Option("-f, --format <format>", "output format").choices(["pretty", "json", "markdown"]).default("pretty"))
    .option("--no-ai", "offline checks only (fast, no provider needed)")
    .addOption(
      new Option("--fail-on <severity>", "exit 1 if an issue is at least this severe").choices([
        "critical",
        "warning",
        "suggestion",
        "never",
      ]),
    )
    .addOption(
      new Option("--provider <preset>", "AI provider preset").choices([
        "ollama",
        "groq",
        "gemini",
        "openrouter",
        "cerebras",
        "openai-compatible",
      ]),
    )
    .option("--model <model>", "model name (overrides the preset default)")
    .addOption(new Option("--lang <lang>", "language of the explanations").choices(["en", "it"]))
    .option("--no-cache", "do not read or write the review cache")
    .option("-v, --verbose", "show rule ids and exact fix replacements")
    .option("--hook", "git hook mode: compact output, never blocks on a missing or unreachable provider unless onError: fail")
    .option("--no-color", "disable colors")
    .addHelpText(
      "after",
      `
Exit codes: 0 ok · 1 issues >= failOn · 2 incomplete review with onError: fail · 3 usage/config error

Examples:
  acr review                           staged changes
  acr review --working --no-ai         quick offline checks on everything uncommitted
  acr review --range origin/main       what this branch adds, before opening a PR
  acr review --format markdown > r.md  paste into a PR or chat`,
    )
    .action(async (opts: ReviewCliOptions) => setExitCode(await reviewCommand(opts, cwd())));

  const hook = program.command("hook").description("manage the git hooks that run acr");
  const kindArg = () => new Argument("[kind]", "which hook").choices(["pre-commit", "pre-push"]);
  hook
    .command("install")
    .description("add acr to a git hook (default: pre-commit); keeps existing hook content")
    .addArgument(kindArg().default("pre-commit"))
    .option("--force", "overwrite the whole hook file")
    .action(async (kind: HookKind, opts: { force?: boolean }) =>
      setExitCode(await hookInstallCommand(kind, opts, cwd())),
    );
  hook
    .command("uninstall")
    .description("remove acr from a git hook (default: both)")
    .addArgument(kindArg())
    .action(async (kind: HookKind | undefined) => setExitCode(await hookUninstallCommand(kind, cwd())));

  program
    .command("init")
    .description("create a commented .acr.yml at the repository root")
    .option("--force", "overwrite an existing .acr.yml")
    .action(async (opts: { force?: boolean }) => setExitCode(await initCommand(opts, cwd())));

  program
    .command("doctor")
    .description("check git, config, provider reachability and hooks")
    .action(async () => setExitCode(await doctorCommand(cwd())));

  program
    .command("ignore")
    .description("mark issues as false positives (appends their ids to .acr/ignore)")
    .argument("<id...>", "issue ids, as shown in [brackets] in the review output")
    .action(async (ids: string[]) => setExitCode(await ignoreCommand(ids, cwd())));

  return program;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs the CLI and returns the exit code (never calls process.exit). */
export async function run(argv: string[] = process.argv): Promise<number> {
  let code: number = EXIT.OK;
  const program = buildProgram((c) => {
    code = c;
  });
  try {
    await program.parseAsync(argv);
    return code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already printed its message.
      const ok = ["commander.helpDisplayed", "commander.help", "commander.version"].includes(err.code);
      return ok ? EXIT.OK : EXIT.USAGE;
    }
    if (err instanceof ConfigError || err instanceof GitError || err instanceof UsageError) {
      process.stderr.write(`acr: ${errorMessage(err)}\n`);
      return EXIT.USAGE;
    }
    if (err instanceof LLMError && err.code === "config") {
      process.stderr.write(`acr: provider: ${err.message}\n`);
      return EXIT.USAGE;
    }
    if (process.env.ACR_DEBUG === "1") {
      process.stderr.write(`${err instanceof Error && err.stack ? err.stack : String(err)}\n`);
    } else {
      process.stderr.write(`acr: unexpected error: ${errorMessage(err)} (set ACR_DEBUG=1 for details)\n`);
    }
    return EXIT.USAGE;
  }
}
