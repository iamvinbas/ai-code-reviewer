# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-23

A rewrite. `ai-code-reviewer` is now `acr` (npm package `acr-review`), a local command-line reviewer that you run before you commit, push or merge, instead of a GitHub Action that commented on pull requests.

### Why

The previous version was a GitHub Action that sent each pull request's diff to **GitHub Models** and posted inline review comments. GitHub retired GitHub Models on **2026-07-30**, which left the Action without a model or a free, keyless way to call one. Instead of moving the Action to a paid API, the project now runs where the code is written:

- feedback arrives before colleagues see the change, not after the PR is opened
- it is free and private by default with a local model (Ollama), so no code leaves the machine
- it is not tied to one provider: any OpenAI-compatible endpoint works, including several hosted free tiers
- it still runs in CI when you want a pipeline gate (`acr review --range origin/main --format markdown`)

### Added

- `acr review` for staged changes (default), `--working`, `--range [base]` (`merge-base..HEAD`, and `base..head`) or `--commit <sha>`, with `--format pretty|json|markdown`, `--no-ai`, `--fail-on`, `--provider`, `--model`, `--lang en|it`, `--no-cache`, `--verbose`, `--hook` and `--no-color`.
- Offline checks that need no AI and inspect only added lines: `secrets/*` (AWS, GitHub, Slack, Stripe, Google, Anthropic, OpenAI-style keys, JWTs, PEM private keys, high-entropy password/token assignments), `conflict-markers`, `debug-statements/*` (JS/TS, Python, Ruby, PHP) and `large-files/*`.
- An AI review engine: line-numbered diff rendering with surrounding context, token-budgeted chunking, a prompt that treats the diff as untrusted data, validated JSON output with one correction retry, line numbers snapped to the diff, deduplication against the offline checks, and an on-disk cache.
- Secret redaction on every line sent to any AI provider.
- Provider presets: `ollama` (default, `qwen2.5-coder:14b`), `groq`, `gemini`, `openrouter`, `cerebras` and generic `openai-compatible`. The fetch-based client uses the native Ollama API with automatic `num_ctx` sizing (`ACR_OLLAMA_NUM_CTX` to pin it), retries with backoff and `retry-after`, timeouts, and actionable error messages.
- Layered configuration: built-in defaults, then `~/.config/acr/config.yml`, then `.acr.yml`, then `ACR_*` environment variables, then flags. It is validated strictly, with readable errors. Repository configs may only name `*_API_KEY` variables, and a non-local `baseUrl` in a repository config triggers a warning.
- `acr init` (commented `.acr.yml`), `acr doctor` (git, config, provider and model, hooks) and `acr ignore <id...>` (`.acr/ignore`, stable fingerprints that survive code moving).
- `acr hook install|uninstall [pre-commit|pre-push]`: an idempotent marked block that keeps existing hook content and honors `core.hooksPath` and husky. It can be bypassed with `--no-verify`, and it never blocks because the AI is unavailable unless `onError: fail`.
- Exit codes: `0` ok, `1` issues ≥ `failOn`, `2` incomplete review with `onError: fail`, `3` usage/config error.

### Removed

- The GitHub Action: `.github/workflows/review.yml` and its `src/*.js` implementation (model client, diff analyzer, PR comment poster), plus `.env.example` and the README screenshots. Replace the Action with `acr` in CI as described in [docs/CI.md](docs/CI.md), or run it locally.
- `GITHUB_TOKEN` / personal access token setup. No GitHub credentials are needed any more.

[0.1.0]: https://github.com/iamvinbas/ai-code-reviewer/releases/tag/v0.1.0
