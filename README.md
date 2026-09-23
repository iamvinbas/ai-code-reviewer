# acr: AI code review in your terminal

`acr` reviews your local git changes with an AI model **before** you commit, push or open a pull request, so bugs, leaked secrets and broken team conventions get caught before a colleague has to point them out.

- **Free**: runs a local model through [Ollama](https://ollama.com) by default. Hosted free tiers are optional.
- **Private by default**: with Ollama your code never leaves your machine. Secrets are redacted before any diff is sent to any provider.
- **Works offline too**: deterministic checks (secrets, merge-conflict markers, leftover debug code, large files) need no AI at all.
- **Fits your git workflow**: `pre-commit` / `pre-push` hooks, skipped as usual with `--no-verify`.
- **Shared by the team**: a committed `.acr.yml` gives everyone the same rules and thresholds.
- **Runs in CI too**: `acr review --range origin/main --format markdown` works in any pipeline.

> This project used to be a GitHub Action built on GitHub Models. GitHub retired GitHub Models on 2026-07-30, so `acr` is now a local CLI. See [CHANGELOG.md](CHANGELOG.md).

## Contents

- [Quick start](#quick-start)
- [Sample output](#sample-output)
- [Commands](#commands)
- [What it checks](#what-it-checks)
- [Providers](#providers)
- [Team setup](#team-setup)
- [CI](#ci)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Quick start

Requirements: Node.js 20 or newer, and git.

```sh
# 1. Install. In a team repo, add it as a dev dependency so everyone gets the same version:
npm i -D acr-review                # then run it with: npx acr ...
# ...or install it globally for all your repos:
npm i -g acr-review                # then run it with: acr ...

# 2. Get a local model (free and private). Install Ollama from https://ollama.com, then:
ollama pull qwen2.5-coder:14b      # default model, needs about 9 GB of disk and 16 GB of RAM to run well
# On smaller machines, use the 7b model and set provider.model in .acr.yml (or pass --model):
# ollama pull qwen2.5-coder:7b

# 3. Set it up in your repository
acr init                           # creates a commented .acr.yml at the repo root
acr doctor                         # checks git, config, provider reachability, model, hooks

# 4. Review
git add -p
acr review                         # reviews staged changes

# 5. Optional: run it automatically
acr hook install                   # before every commit (pre-commit)
acr hook install pre-push          # or once per push, which suits slow local models better
```

The examples below say `acr`. If you installed it as a dev dependency, prefix the commands with `npx`.

No GPU and no Ollama? Use `acr review --no-ai` for the offline checks, or pick a [hosted free tier](#providers).

## Sample output

This is a real run of `acr review` with the default `ollama` preset (`qwen2.5-coder:14b` on a laptop). The staged file adds a hardcoded Stripe key, a SQL query built with string interpolation, an off-by-one loop, an un-awaited `db.query(...)` and a `console.log`:

```text
acr staged changes · ollama · qwen2.5-coder:14b · 1 file · 38.9s

src/users.ts
  CRITICAL   src/users.ts:3  Hardcoded Stripe live key  [5911721c6dca]
             Possible Stripe live key added (`sk_l****`). Committed secrets must be considered leaked.
             → Remove it from the code, rotate the credential (it is in git history once committed) and load it from an environment variable or a secret manager.
  CRITICAL   src/users.ts:5-6  SQL Injection vulnerability in getUser function  [9457d60baf55]
             The query uses string interpolation to insert the user ID, which is vulnerable to SQL injection attacks. Using template literals directly with user input can lead to malicious queries.
             → Use parameterized queries to safely insert user IDs into SQL statements.
  WARNING    src/users.ts:11  Incorrect loop condition in lastItems function  [f6cd6c87237b]
             The loop condition 'i <= items.length' is incorrect and will cause an out-of-bounds error when accessing the array. The correct condition should be 'i < items.length'.
             → Change the loop condition to 'i < items.length' to avoid accessing elements outside the bounds of the array.
  WARNING    src/users.ts:15  Missing await in deleteUser function  [c83e639cad4f]
             The db.query call inside the deleteUser function is not awaited, which means any errors from the query will be unhandled. This could lead to silent failures.
             → Add 'await' before the db.query call to handle potential errors and ensure the delete operation completes successfully.
  SUGGESTION src/users.ts:16  Leftover `console.log` call  [5c63cc785fc7]
             Debugging code was added; it will run for everyone (noisy output, possible data leaks, or a process that stops at a breakpoint).
             → Remove it, or use the project's logger if the output is intentional.

✖ 5 issues: 2 critical · 2 warnings · 1 suggestion
False positive? `acr ignore <id>` · more detail: --verbose
```

The Stripe key and the `console.log` come from the offline checks. The other three come from the model. The exit code is `1` because an issue reached the default `failOn: critical` threshold. The value in `[brackets]` is the issue id, which you pass to `acr ignore`. AI output varies between models and runs.

With `--no-ai`, only the offline checks run. They finish in milliseconds (output shortened):

```text
$ acr review --no-ai
acr staged changes · checks only (AI off) · 2 files · 10ms

src/app.ts
  CRITICAL   src/app.ts:3  Hardcoded Stripe live key  [177226471949]
             Possible Stripe live key added (`sk_l****`). Committed secrets must be considered leaked.
             → Remove it from the code, rotate the credential (it is in git history once committed) and load it from an environment variable or a secret manager.
  SUGGESTION src/app.ts:6  Leftover `console.log` call  [ad0e53c2f408]
             ...
  WARNING    src/app.ts:7  Leftover `debugger` statement  [3e95a803085c]
             ...

src/config.py
  WARNING    src/config.py:1  Leftover Python debugger breakpoint  [eca5b67d12c6]
             ...
  CRITICAL   src/config.py:2  Hardcoded secret in `db_password`  [83ab86a7bb36]
             ...

✖ 5 issues: 2 critical · 2 warnings · 1 suggestion
```

In hook mode (`--hook`, which the installed git hooks use), each issue gets one line, followed by a hint about how to proceed:

```text
acr: commit blocked (issues at or above failOn: critical). Fix them, run `acr ignore <id>` for false positives, or skip once with `git commit --no-verify`.
```

## Commands

| Command | What it does |
|---|---|
| `acr review` | Review changes (staged changes by default). |
| `acr init [--force]` | Create a commented `.acr.yml` at the repo root. `--force` overwrites an existing one. |
| `acr doctor` | Check git, the repository, the config and which files it came from, provider reachability and model availability, and hook status. Exits `1` if a check fails. |
| `acr hook install [pre-commit\|pre-push] [--force]` | Add acr to a git hook (default: `pre-commit`). Existing hook content is kept. `--force` rewrites the whole hook file. |
| `acr hook uninstall [pre-commit\|pre-push]` | Remove acr's block from a hook (default: both hooks). |
| `acr ignore <id...>` | Mark issues as false positives by appending their ids to `.acr/ignore`. |

Global options: `-C, --cwd <dir>` (run as if started in `<dir>`), `-V, --version`, `-h, --help`.

### `acr review` targets

Use at most one target flag:

| Flag | Reviews | Typical use |
|---|---|---|
| `--staged` (default) | The index, which is what `git commit` would record | Before committing, and in the pre-commit hook |
| `--working` | All uncommitted changes (staged and unstaged) vs `HEAD`. Untracked files are not included until you `git add` them. | Quick check while you work |
| `--range [base]` | `merge-base(base, HEAD)..HEAD`. Also accepts `base..head`. | Before pushing or opening a PR, in the pre-push hook, and in CI |
| `--commit <sha>` | One commit vs its first parent | Reviewing a commit after the fact |

Without a base, `--range` picks the default branch in this order: `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`.

### `acr review` options

| Option | Description |
|---|---|
| `-f, --format <pretty\|json\|markdown>` | Output format (default `pretty`). The report goes to stdout. The progress spinner goes to stderr, and only in an interactive terminal. |
| `--no-ai` | Run only the offline checks. Fast, and needs no provider. |
| `--fail-on <critical\|warning\|suggestion\|never>` | Exit `1` if any issue is at least this severe. Overrides `failOn`. |
| `--provider <preset>` | `ollama`, `groq`, `gemini`, `openrouter`, `cerebras` or `openai-compatible` |
| `--model <model>` | Override the preset's default model |
| `--lang <en\|it>` | Language of the AI explanations |
| `--no-cache` | Do not read or write the review cache |
| `-v, --verbose` | Also show rule ids and exact fix replacements |
| `--hook` | Git hook mode: compact output. A missing API key or an unreachable provider never blocks you unless `onError: fail`. |
| `--no-color` | Disable colors. `NO_COLOR` and `FORCE_COLOR` are respected too. |

### Output formats

- **pretty**: grouped by file, colored by severity, for humans.
- **json**: a stable, machine-readable object: `{ version: 1, target, complete, issues, errors, stats }`. Each issue has `id`, `source` (`ai` or `check`), `ruleId`, `severity`, `file`, `line`, `title`, `message`, `suggestion` and an optional `fix`.
- **markdown**: a summary table plus collapsible issue details, ready to paste into a PR comment or chat. See [docs/CI.md](docs/CI.md).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | OK: no issue reached `failOn`, and the review was complete (or `onError: warn`) |
| `1` | At least one issue at or above `failOn` (`doctor`: at least one check failed) |
| `2` | The review was incomplete (provider down, bad AI response, etc.) and `onError: fail` |
| `3` | Usage or config error (bad flag, invalid `.acr.yml`, not a git repository, unknown ref, etc.) |

If issues are blocking and the review is also incomplete, the exit code is `1`.

## What it checks

### Offline checks (no AI, only on added lines)

| Rule id | Severity | Detects |
|---|---|---|
| `secrets/private-key` | critical | PEM private key headers |
| `secrets/aws-access-key`, `secrets/aws-secret-key` | critical | AWS access key ids (`AKIA`/`ASIA…`) and secret keys |
| `secrets/github-token` | critical | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_` tokens |
| `secrets/slack-token` | critical | `xox[baprs]-…` tokens |
| `secrets/stripe-key` | critical | Stripe live keys (`sk_live_`, `rk_live_`) |
| `secrets/google-api-key` | critical | `AIza…` keys |
| `secrets/anthropic-key`, `secrets/openai-key` | critical | `sk-ant-…` and `sk-…` style API keys |
| `secrets/jwt` | critical | JSON Web Tokens |
| `secrets/generic` | critical | High-entropy literals assigned to `password`, `secret`, `token`, `api_key` and similar names |
| `conflict-markers` | critical | Unresolved `<<<<<<<`, `=======`, `>>>>>>>` and `\|\|\|\|\|\|\|` markers |
| `debug-statements/debugger` | warning | `debugger` in JS/TS (also `.vue` and `.svelte`) |
| `debug-statements/console-log` | suggestion | `console.log/debug/trace/dir` in JS/TS (skipped in test files) |
| `debug-statements/pdb` | warning | `import pdb`, `pdb.set_trace()`, `breakpoint()` in Python |
| `debug-statements/print` | suggestion | `print(` at the start of a line in Python (skipped in test files) |
| `debug-statements/pry` | warning | `binding.pry`, `binding.irb`, `byebug` in Ruby |
| `debug-statements/php-dump` | warning | `var_dump(`, `dd(` in PHP |
| `large-files/size` | warning | A file adding more than `checks.largeFiles.maxKb` (default 500 KB). Lockfiles are exempt. |
| `large-files/binary` | warning | A newly added binary file (images and fonts are exempt) |

Obvious placeholders (`your_api_key`, `changeme`, `${VAR}`, `process.env…`, etc.) are ignored. Debug-statement checks skip minified, `dist/`, `build/`, `vendor/` and `node_modules/` paths. Each check family can be turned off in [`checks`](docs/CONFIGURATION.md#checks).

### AI review

The model is asked to focus, in order, on: bugs and logic errors; security vulnerabilities; data loss; concurrency problems; error handling; performance problems with real impact; and maintainability problems likely to cause bugs. It also checks the diff against your team `rules`. It is told not to report style nitpicks.

How it works:

- The model sees each changed line with its new line number, plus `contextLines` of surrounding code. It may cite only those line numbers. A line outside the diff is moved to the nearest changed line or reported file-level.
- The diff is treated as **untrusted data**: the prompt tells the model to ignore instructions found in code, comments or strings.
- **Secrets are redacted before any text reaches the provider**. This covers everything the secrets check detects, plus weaker credential literals and multi-line private key bodies. The redaction applies to every provider, including Ollama.
- Some files are never sent to the AI: lockfiles, minified files and source maps, `dist/`, `build/`, `vendor/`, `node_modules/`, images, fonts, binaries and deleted files. The offline checks still see them, except deleted files.
- Large diffs are split into chunks of about `maxChunkTokens` tokens. Results are cached per chunk (key: prompt version, provider, model, language, rules and chunk text), so unchanged code is not re-sent.
- If the model repeats an offline finding on the same line, you see only the offline finding.
- acr never fails open silently. If a chunk fails, the review is marked **incomplete**, the report says which files were not reviewed, and `onError` decides the exit code.

## Providers

Any OpenAI-compatible chat endpoint works. Presets:

| Preset | Default model | API key env | Notes |
|---|---|---|---|
| `ollama` (default) | `qwen2.5-coder:14b` | none | Local, free, private. Honors `OLLAMA_HOST`. |
| `groq` | `openai/gpt-oss-120b` | `GROQ_API_KEY` | Hosted free tier |
| `gemini` | `gemini-3.8-flash` | `GEMINI_API_KEY` | Hosted free tier |
| `openrouter` | `qwen/qwen3.8-27b:free` | `OPENROUTER_API_KEY` | Hosted free models |
| `cerebras` | `gpt-oss-120b` | `CEREBRAS_API_KEY` | Hosted free tier |
| `openai-compatible` | none (set `model`) | `OPENAI_API_KEY`, optional | LM Studio, llama.cpp, vLLM, any other endpoint (set `baseUrl`) |

```sh
export GROQ_API_KEY=...            # never put keys in .acr.yml
acr review --provider groq
```

**Privacy:** hosted providers receive the (redacted) diff of your changes. Free tiers often come with different data terms than paid plans. For example, Google's terms for the unpaid Gemini API allow it to use prompts to improve its products, and some free OpenRouter models are served by providers that log prompts. Check the provider's terms and your team's policy before using one on proprietary code. Ollama keeps everything on your machine.

Full details, including base URLs, custom endpoints and Ollama tuning, are in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Team setup

1. **Commit `.acr.yml`** so everyone shares the same provider, thresholds, scope and rules:

   ```yaml
   provider:
     preset: ollama
   failOn: critical          # critical | warning | suggestion | never
   onError: warn             # warn: never block because the AI is down; fail: exit 2
   include: []               # picomatch globs; empty = everything
   exclude:
     - "**/__snapshots__/**"
     - "fixtures/**"
   rules:
     - Use the logger from src/lib/log.ts instead of console.log.
     - Every new API route must validate its input with zod.
     - SQL must use parameterized queries, never string concatenation.
   ```

   All options: [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Precedence, from lowest to highest: built-in defaults, `~/.config/acr/config.yml`, `.acr.yml`, `ACR_*` environment variables, command-line flags. The repo file beats your user config. To override it just for yourself (for example to use a hosted provider or a smaller model), use `ACR_PROVIDER` / `ACR_MODEL` or `--provider` / `--model`.

2. **Commit `.acr/ignore`.** `acr ignore <id>` appends false-positive ids to it (one per line, `#` for comments). Ids are fingerprints of the rule, the file and the code line, not the line number, so they still match after the code moves.

3. **Install the hooks** (each developer runs this once, since hooks are not versioned):

   ```sh
   acr hook install            # pre-commit: acr review --staged --hook
   acr hook install pre-push   # pre-push:   acr review --range --hook
   ```

   - The hook adds a marked block (`# >>> acr >>>` … `# <<< acr <<<`) to any existing hook script and leaves the rest untouched. Re-running it is safe.
   - It honors `core.hooksPath`. With husky it writes to `.husky/<hook>`, so commit that file to share the hook.
   - The hook runs `node_modules/.bin/acr` if present, then a global `acr`, then `npx --no-install acr`. If none is found, it prints a notice and lets the commit through.
   - To skip it once: `git commit --no-verify` / `git push --no-verify`.
   - With `onError: warn` (the default), a hook never blocks you because the AI provider is down or a key is missing. Only real issues at or above `failOn` block.
   - Local models can take tens of seconds per review, so `pre-push` is often more comfortable than `pre-commit`.
   - The `pre-push` hook reviews what the current branch adds relative to the default branch (`acr review --range`), not only the commits being pushed.
   - An invalid `.acr.yml` makes the hook exit `3`, which blocks the commit. Run `acr doctor` to see the error.

4. **Security of the shared config.** A repo `.acr.yml` can only name API key variables ending in `_API_KEY`. If it points `provider.baseUrl` at a host that is neither local nor a known preset host, acr prints a warning, because your changes would be sent there. See [Security rules for the repository config](docs/CONFIGURATION.md#security-rules-for-the-repository-config).

## CI

`acr` works in any CI that has Node 20+ and a full git history:

```yaml
# GitHub Actions (excerpt)
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }                 # --range needs the merge base
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci
- run: npx acr review --range origin/${{ github.base_ref }} --format markdown > acr-report.md
  env:
    ACR_PROVIDER: groq
    GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

`npx acr` assumes `acr-review` is in your `devDependencies`. Otherwise use `npx --yes -p acr-review acr ...`. Without a key, use `--no-ai` for the offline checks only. The markdown report can be posted with `gh pr comment --body-file acr-report.md`. Full GitHub Actions and GitLab CI examples are in [docs/CI.md](docs/CI.md).

## Troubleshooting

Run `acr doctor` first. It reports which config files are loaded, the effective provider, model and base URL, whether the API key variable is set, and whether the model is available.

| Symptom | Fix |
|---|---|
| `Ollama is not reachable at localhost:11434` | Start it with `ollama serve` (or open the Ollama app). If it runs on another host or port, set `OLLAMA_HOST` or `provider.baseUrl`. |
| `Model "qwen2.5-coder:14b" not found` | `ollama pull qwen2.5-coder:14b`, or set `provider.model` to a model you have (`ollama list`). |
| Reviews are slow | Use a smaller model (`--model qwen2.5-coder:7b`), lower `maxChunkTokens` (for example 2500) or `contextLines`, review once per push instead of per commit, or use a hosted free tier. `--no-ai` is instant. |
| `did not respond within 300s` | Local models can be slow on big chunks: lower `maxChunkTokens`, use a smaller model, or raise `provider.timeoutMs` (default 300000 ms for Ollama, 120000 ms for other presets). |
| `exceeds the Ollama context window` | Lower `maxChunkTokens`, or pin a larger window with `ACR_OLLAMA_NUM_CTX=16384`. acr sizes the window per request (4096 to 32768 tokens) unless you pin it. Pinning also avoids model reloads when the size changes. |
| `GROQ_API_KEY is not set` (or similar) | Export the key in your shell. Without it, `acr review` falls back to the offline checks and marks the review incomplete. |
| `Rate limited ... (HTTP 429)` | The free-tier limit was reached. Wait a minute, lower `maxChunkTokens`, or switch provider. |
| `Review incomplete` box | Some chunks could not be reviewed (see the listed errors). With `onError: warn` the exit code ignores it. With `onError: fail` it is `2`. |
| `Nothing staged to review` | Stage changes with `git add`, or use `acr review --working`. |
| `Could not determine the default base branch` / `No common ancestor` | Pass the base explicitly (`--range origin/main`). In CI, fetch the full history (`fetch-depth: 0`). |
| Something else | Rerun with `ACR_DEBUG=1` to print the stack trace of an unexpected error. |

## Development

```sh
npm install
npm test             # vitest: unit tests + end-to-end tests on temporary git repos with a fake LLM server
npm run typecheck    # tsc --noEmit
npm run build        # tsup → dist/cli.js
npm run dev -- review --no-ai   # run from source with tsx
```

Layout:

```text
src/
  types.ts     shared contracts (DiffTarget, Issue, Config, ReviewResult, exit codes)
  cli/         commander program: review, hook, init, doctor, ignore
  config/      zod schema, layered loader, .acr.yml template, .acr/ignore
  git/         diff targets, unified diff parser, file reads at a ref/index/worktree
  checks/      offline checks: secrets (+ redaction), conflict markers, debug statements, large files
  review/      engine: filters, chunking, prompt, response parsing, line validation, dedupe, cache
  llm/         presets and a fetch-based OpenAI-compatible client (native Ollama API, retries, timeouts)
  report/      pretty / json / markdown formatters, exit codes
  hooks/       git hook install/uninstall (idempotent marked block, core.hooksPath, husky)
tests/         end-to-end tests (temporary repos, fake LLM server)
docs/          configuration, providers, CI
```

This repository reviews itself: see [.acr.yml](.acr.yml).

## License

[MIT](LICENSE) © 2026 Vincenzo Basile
