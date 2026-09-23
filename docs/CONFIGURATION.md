# Configuration

`acr` works with no configuration at all: it uses the built-in defaults below and the local `ollama` provider. `acr init` writes a commented `.acr.yml` with every option. `acr doctor` shows which files were loaded and whether the result is valid.

- [Files and precedence](#files-and-precedence)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Ignoring false positives](#ignoring-false-positives)
- [Security rules for the repository config](#security-rules-for-the-repository-config)

## Files and precedence

Layers are applied in this order. Each one overrides the layers before it:

1. Built-in defaults
2. **User config**: `$XDG_CONFIG_HOME/acr/config.yml` (or `config.yaml`). If `XDG_CONFIG_HOME` is unset, this is `~/.config/acr/config.yml` on every OS, macOS and Windows included.
3. **Repository config**: `.acr.yml` (or `.acr.yaml`) in the repository root, which is the directory containing `.git`. It is found from any subdirectory.
4. **Environment variables**: `ACR_PROVIDER`, `ACR_MODEL`, `ACR_BASE_URL`, `ACR_LANGUAGE`, `ACR_FAIL_ON`
5. **Command-line flags**: `--provider`, `--model`, `--fail-on`, `--lang`, `--no-ai`, `--no-cache`

Merge rules:

- Objects are merged key by key. Arrays (`include`, `exclude`, `rules`, `ignore`) and scalars **replace** the lower layer's value.
- **Switching provider preset resets the provider.** When a layer sets a different `provider.preset`, the `model`, `baseUrl` and `apiKeyEnv` from lower layers are dropped, because they belonged to the previous provider. `timeoutMs` and `maxRetries` are kept. For example, `--provider groq` uses Groq's default model even if `.acr.yml` sets an Ollama model.
- A key with no value (`exclude:` followed only by comments) means "not set", so it keeps the lower layer's value.
- Unknown keys, wrong types and out-of-range values are rejected with exit code `3` and a message naming the key, for example `.acr.yml: unknown option "provder"`.

The repo config beats your user config. Use the user config for defaults that apply to repos that do not set the option. To override a repo setting just for yourself, use an `ACR_*` variable or a flag.

## Options

Every option below can appear in both the user config and the repo config.

### `provider`

| Key | Type | Default | Description |
|---|---|---|---|
| `provider.preset` | `ollama` \| `groq` \| `gemini` \| `openrouter` \| `cerebras` \| `openai-compatible` | `ollama` | Provider preset. See [PROVIDERS.md](PROVIDERS.md). |
| `provider.model` | string | the preset's model | Model name, for example `qwen2.5-coder:7b`. Required for `openai-compatible`. |
| `provider.baseUrl` | http(s) URL | the preset's URL | OpenAI-compatible base URL (the part before `/chat/completions`, usually ending in `/v1`). Required for `openai-compatible`. |
| `provider.apiKeyEnv` | env var **name** | the preset's variable | Name of the environment variable that holds the API key. The key itself never goes in a config file. In a repo config it must end in `_API_KEY` (see [security rules](#security-rules-for-the-repository-config)). If you set it explicitly, the variable becomes required. |
| `provider.timeoutMs` | integer ≥ 1 | `300000` for `ollama`, `120000` for the others | Timeout per HTTP request, in milliseconds. Reachability checks (`acr doctor`, hook mode) time out after at most 15 s. |
| `provider.maxRetries` | integer 0–10 | `3` | Retries on HTTP 408, 429, 5xx and network errors, with exponential backoff and jitter. `retry-after` is honored for waits of up to 30 s. A `retry-after` longer than 60 s (for example a daily quota) fails immediately. If nothing is listening (connection refused, unknown host), acr retries at most once. |

### Behavior

| Key | Type | Default | Description |
|---|---|---|---|
| `failOn` | `critical` \| `warning` \| `suggestion` \| `never` | `critical` | Exit `1` (and block the git hook) if any issue is at least this severe. `never` never exits `1`. |
| `onError` | `warn` \| `fail` | `warn` | What happens when the review is incomplete (provider unreachable, missing key, bad AI response, failed chunk). `warn` prints the errors and does not change the exit code. `fail` exits `2`. Blocking issues (`1`) take priority over `2`. |
| `language` | `en` \| `it` | `en` | Language of the AI's titles, explanations and suggestions. The offline check messages are always in English. |
| `rules` | string[] | `[]` | Team conventions in plain language. They are added to the prompt, and violations are reported as issues. Changing them invalidates the cache. |

### Scope

| Key | Type | Default | Description |
|---|---|---|---|
| `include` | glob[] | `[]` | [picomatch](https://github.com/micromatch/picomatch) globs, relative to the repo root. If non-empty, only matching files are checked and reviewed. Empty means every file. |
| `exclude` | glob[] | `[]` | Files to skip entirely, for both the offline checks and the AI review. |
| `maxFiles` | integer ≥ 1 | `50` | Maximum number of files sent to the AI per review. Files beyond the limit are not sent. The header then shows `reviewed/total files`. |
| `maxChunkTokens` | integer ≥ 500 | `4000` | Token budget per AI request (prompt + diff + context). Larger diffs are split into several chunks, and a single oversized file is split by hunk. Lower it for slow local models. Hosted models handle 8000 or more comfortably. |
| `contextLines` | integer ≥ 0 | `10` | Unchanged lines of surrounding code sent with each hunk (read from the index, working tree or commit being reviewed). |

Glob notes: dotfiles are matched, and a pattern without `/` also matches the file name anywhere (`*.gen.ts` matches `src/a/b.gen.ts`). Quote patterns that start with `*` in YAML.

Some files are never sent to the AI, whatever `include` says: lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, etc.), `*.min.js`, `*.min.css`, `*.map`, `dist/`, `build/`, `vendor/`, `node_modules/`, images, fonts, binary files and deleted files. The offline checks still run on them (except deleted files) unless `exclude` matches them.

### `ai`

| Key | Type | Default | Description |
|---|---|---|---|
| `ai.enabled` | boolean | `true` | `false` runs only the offline checks, the same as `--no-ai`. |

### `checks`

All offline checks inspect **added lines only**.

| Key | Type | Default | Rule ids |
|---|---|---|---|
| `checks.secrets` | boolean | `true` | `secrets/private-key`, `secrets/aws-access-key`, `secrets/aws-secret-key`, `secrets/github-token`, `secrets/slack-token`, `secrets/stripe-key`, `secrets/google-api-key`, `secrets/anthropic-key`, `secrets/openai-key`, `secrets/jwt`, `secrets/generic` (all critical) |
| `checks.conflictMarkers` | boolean | `true` | `conflict-markers` (critical) |
| `checks.debugStatements` | boolean | `true` | `debug-statements/debugger`, `debug-statements/pdb`, `debug-statements/pry`, `debug-statements/php-dump` (warning); `debug-statements/console-log`, `debug-statements/print` (suggestion; skipped in test files) |
| `checks.largeFiles.enabled` | boolean | `true` | `large-files/size`, `large-files/binary` (warning) |
| `checks.largeFiles.maxKb` | integer ≥ 1 | `500` | Size limit in KB, measured on the added lines of a text file. Lockfiles are exempt. |

Turning off `checks.secrets` only disables the *report*. Redaction of secrets in the text sent to the AI always happens.

### `cache`

| Key | Type | Default | Description |
|---|---|---|---|
| `cache.enabled` | boolean | `true` | Reuse the AI results for chunks that have not changed. `--no-cache` disables reads and writes for one run. |
| `cache.dir` | string | `$XDG_CACHE_HOME/acr`, or `~/.cache/acr` | Cache directory. A relative path is resolved against the repo root. If you use a repo folder such as `.acr/cache`, add it to `.gitignore`. |

The cache key covers the prompt version, provider, model, language, team rules and the exact chunk text, so changing any of them triggers a fresh review. Responses in which the model returned malformed issues are not cached.

### `ignore`

| Key | Type | Default | Description |
|---|---|---|---|
| `ignore` | string[] | `[]` | Issue ids to hide. Merged with the ids in `.acr/ignore`. |

### Full example

```yaml
provider:
  preset: ollama
  model: qwen2.5-coder:7b
  timeoutMs: 300000
failOn: warning
onError: warn
include: ["src/**", "lib/**"]
exclude:
  - "**/__snapshots__/**"
  - "**/*.generated.ts"
rules:
  - Use the logger from src/lib/log.ts instead of console.log.
  - Do not use `any` in TypeScript; prefer `unknown` and narrow.
language: en
maxFiles: 50
maxChunkTokens: 3000
contextLines: 10
ai:
  enabled: true
checks:
  secrets: true
  conflictMarkers: true
  debugStatements: true
  largeFiles:
    enabled: true
    maxKb: 500
cache:
  enabled: true
ignore: []
```

## Environment variables

| Variable | Effect |
|---|---|
| `ACR_PROVIDER` | Sets `provider.preset`. Must be a valid preset name. |
| `ACR_MODEL` | Sets `provider.model` |
| `ACR_BASE_URL` | Sets `provider.baseUrl`. Must be an http(s) URL. |
| `ACR_LANGUAGE` | Sets `language` (`en` \| `it`) |
| `ACR_FAIL_ON` | Sets `failOn` (`critical` \| `warning` \| `suggestion` \| `never`) |
| `ACR_OLLAMA_NUM_CTX` | Ollama only: pin the context window (`num_ctx`, integer ≥ 512). If unset, acr sizes it per request. See [PROVIDERS.md](PROVIDERS.md#ollama-tuning). |
| `OLLAMA_HOST` | Ollama only: used as the base URL when `provider.baseUrl` is not set. Accepts `host`, `host:port` or `http://host:port`, and the port defaults to 11434. |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`, `OPENAI_API_KEY` | API keys read by the presets. Any other name can be used through `provider.apiKeyEnv`. |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | Locations of the user config and the cache |
| `NO_COLOR`, `FORCE_COLOR` | Disable or force colored output |
| `CI` | When set, the progress spinner is disabled |
| `ACR_DEBUG=1` | Print the stack trace of unexpected errors |

Empty or whitespace-only values are ignored. An invalid value, such as `ACR_FAIL_ON=high`, is a config error (exit `3`).

## Ignoring false positives

```sh
acr ignore 83ab86a7bb36 9457d60baf55
```

This appends the ids to `.acr/ignore` in the repo root and creates the file if needed. The file has one id per line, and `#` starts a comment. Commit it so the whole team skips the same findings.

An id is a fingerprint of the issue's source, its rule (the rule id for checks, the normalized title for AI issues), the file and the normalized code line. The line number is not part of it, so the id survives code moving around. It changes if the line's content changes or, for AI issues, if the model words the title differently.

## Security rules for the repository config

A `.acr.yml` comes from whoever last edited the repository, so acr limits what it can do:

- **`provider.apiKeyEnv` in a repo config must match `^[A-Z0-9_]+_API_KEY$`.** A repo file therefore cannot point acr at `AWS_SECRET_ACCESS_KEY` or any other unrelated secret in your environment. Other names are allowed only in your user config (`~/.config/acr/config.yml`).
- **Non-local `baseUrl` warning.** If the repo config sets `provider.baseUrl` and it is still in effect after all layers, acr prints a warning on every run unless the host is local (`localhost`, `*.localhost`, `127.x.x.x`, `::1`, `0.0.0.0`) or a known preset host (`api.groq.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.cerebras.ai`):

  ```text
  warning: the repository config sets provider.baseUrl to https://example.com/v1 — your code changes will be sent there. If you do not trust it, run with --provider ollama (or ACR_PROVIDER=ollama).
  ```

  This is a warning, not an error. The review still runs and sends the redacted diff, plus the API key from the configured variable if that variable is set (for `openai-compatible`, `OPENAI_API_KEY` by default), to that host. If you do not recognize the host, stop and override the provider (`ACR_PROVIDER=ollama`) before running acr in that repository.
- API keys are never read from config files. Only environment variable **names** are.
