# Providers

`acr` talks to any **OpenAI-compatible** chat completions endpoint through plain `fetch`, with no SDKs. A preset is a named default for `baseUrl`, `model` and the API key variable. Each of them can be overridden in the config (see [CONFIGURATION.md](CONFIGURATION.md#provider)), and the preset and model can also be set with `--provider` / `--model` or `ACR_PROVIDER` / `ACR_MODEL` / `ACR_BASE_URL`.

```sh
acr doctor                       # shows the effective provider, model, base URL and key status, then pings the endpoint
acr review --provider groq       # one-off switch
ACR_PROVIDER=gemini acr review   # per shell
```

## Presets

| Preset | Base URL | Default model | API key env | Get a key |
|---|---|---|---|---|
| `ollama` (default) | `http://localhost:11434/v1` (or `OLLAMA_HOST`) | `qwen2.5-coder:14b` | none | [ollama.com/download](https://ollama.com/download) |
| `groq` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `openrouter` | `https://openrouter.ai/api/v1` | `qwen/qwen3.8-27b:free` | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `cerebras` | `https://api.cerebras.ai/v1` | `gpt-oss-120b` | `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| `openai-compatible` | none (set `baseUrl`) | none (set `model`) | `OPENAI_API_KEY` (optional) | your server's docs |

For `groq`, `gemini`, `openrouter` and `cerebras` the key is required. If the variable is not set, `acr review` runs only the offline checks, marks the review incomplete, and says which variable to set. With the default `onError: warn` this does not change the exit code. `acr doctor` reports the missing key as a failure.

Never put a key in `.acr.yml`. Export it in your shell, or store it as a CI secret.

### Free-tier notes and caveats

Hosted free tiers change often: models get renamed or retired, and quotas change. If a default model disappears, pick a current one with `--model` / `provider.model`. The presets exist so you are not locked in to any single provider.

- **Rate limits.** Free tiers have per-minute and per-day limits. acr retries HTTP 429 with backoff (honoring `retry-after` up to 30 s). It gives up immediately when the provider asks for a longer wait, which is typical of daily quotas. Each chunk is one request, plus one correction retry if the model's JSON is invalid, so a lower `maxChunkTokens` means more, smaller requests. On free tiers, per-minute *token* limits usually matter more than request counts.
- **Privacy and training.** Hosted providers receive the diff of your changes (secrets redacted) plus `contextLines` of surrounding code. Free tiers often come with different data terms than paid plans:
  - **Gemini**: under Google's terms for *unpaid* Gemini API usage, prompts and responses may be used to improve Google's products and may be seen by human reviewers. See the [Gemini API terms](https://ai.google.dev/gemini-api/terms).
  - **OpenRouter**: free (`:free`) models are served by third-party providers, and some of them log or train on prompts. Your [privacy settings](https://openrouter.ai/settings/privacy) control which providers can serve your requests.
  - **Groq, Cerebras**: read the current terms and data-retention policy before using them on proprietary code.

  If your code must not leave your machine, use `ollama` or another local server.

## Ollama (default)

```sh
# install from https://ollama.com, then:
ollama pull qwen2.5-coder:14b    # default model (~9 GB download)
ollama pull qwen2.5-coder:7b     # faster and lighter, for laptops with 8 to 16 GB of RAM
acr doctor
```

Use a model other than the default with `provider.model` (or `--model` / `ACR_MODEL`). Any model in `ollama list` works. Code-tuned models of 7B parameters or more give the most useful reviews.

### How acr uses Ollama

- acr calls Ollama's **native API** (`POST /api/chat`, and `GET /api/tags` for `doctor`) at the host of the base URL, because only the native API lets it set the context window (`num_ctx`). If the server returns 404 on the native API (for example an OpenAI-only proxy in front of Ollama), acr falls back to `/v1/chat/completions`.
- Requests use JSON mode, `temperature: 0` and up to 4096 output tokens.
- The endpoint comes from `provider.baseUrl` if set, then `OLLAMA_HOST` (`host`, `host:port` or `http://host:port`, port 11434 by default), then `http://localhost:11434/v1`.
- The default request timeout for Ollama is 300 s (`provider.timeoutMs`), because local models are slow on large chunks.

### Ollama tuning

| Problem | Knob |
|---|---|
| Reviews are slow | A smaller model (`qwen2.5-coder:7b`); a lower `maxChunkTokens` (for example 2500–3000); a lower `contextLines`; `pre-push` instead of `pre-commit`. For reference, a full 6000-token chunk takes about 1.5 min with `qwen2.5-coder:14b` on a laptop. |
| `did not respond within 300s` | The same knobs as above, or raise `provider.timeoutMs`. |
| `exceeds the Ollama context window` | Lower `maxChunkTokens`, or pin a bigger window with `ACR_OLLAMA_NUM_CTX`. |
| The model reloads between requests | Ollama reloads a model whenever `num_ctx` changes. Pin it: `export ACR_OLLAMA_NUM_CTX=16384`. |

**Context window.** Unless `ACR_OLLAMA_NUM_CTX` is set, acr computes `num_ctx` per request: the estimated prompt tokens plus 4096 output tokens plus 10%, rounded up to a multiple of 2048 and kept between 4096 and 32768. The value never shrinks during a run, to avoid reloads. If you pin it (an integer ≥ 512), it must fit `maxChunkTokens` plus the 4096-token answer. A prompt that does not fit fails the chunk with a clear error rather than being silently truncated.

**Remote Ollama.** Point `OLLAMA_HOST` (or `provider.baseUrl`) at another machine, for example a shared GPU box: `OLLAMA_HOST=gpu-box.lan:11434`. If a *repository* config sets a non-local `baseUrl`, acr prints a warning on every run (see [security rules](CONFIGURATION.md#security-rules-for-the-repository-config)).

## Custom OpenAI-compatible servers

Use the `openai-compatible` preset with a `baseUrl` (the part before `/chat/completions`) and a `model`.

**LM Studio** (start the local server in the Developer tab):

```yaml
provider:
  preset: openai-compatible
  baseUrl: http://localhost:1234/v1
  model: qwen2.5-coder-14b-instruct   # the model id shown by LM Studio
```

**llama.cpp** (`llama-server -m model.gguf --port 8080`):

```yaml
provider:
  preset: openai-compatible
  baseUrl: http://localhost:8080/v1
  model: local                        # llama-server serves the loaded model under any name
```

**vLLM** (`vllm serve Qwen/Qwen2.5-Coder-14B-Instruct`):

```yaml
provider:
  preset: openai-compatible
  baseUrl: http://localhost:8000/v1
  model: Qwen/Qwen2.5-Coder-14B-Instruct
```

**An endpoint that needs a key:**

```yaml
provider:
  preset: openai-compatible
  baseUrl: https://llm.internal.example.com/v1
  model: my-model
  apiKeyEnv: INTERNAL_LLM_API_KEY     # in a repo config the name must end in _API_KEY
```

Notes:

- With `openai-compatible`, the key is optional. If `apiKeyEnv` is not set and `OPENAI_API_KEY` is set in your environment, acr sends `OPENAI_API_KEY` as a Bearer token to `baseUrl`. If you set `apiKeyEnv` explicitly, that variable becomes required.
- acr sends `response_format: { "type": "json_object" }`. If the server rejects it with HTTP 400, acr retries once without it, and the prompt still asks for JSON.
- `acr doctor` checks `GET {baseUrl}/models` and verifies that the model is listed. If the server has no model listing (HTTP 404/405), only reachability and authentication are checked.
- `baseUrl` must be `http://` or `https://`. A trailing slash is ignored.

## Error messages

| Message | Meaning |
|---|---|
| `Ollama is not reachable at localhost:11434 — start it with ollama serve` | Nothing is listening. Start Ollama, or check `OLLAMA_HOST` / `baseUrl`. |
| `Model "X" not found — run ollama pull X` | Pull the model, or change `provider.model`. |
| `Model "X" is not available on <provider>` | The hosted model was renamed or retired. Set a current `provider.model`. |
| `Authentication failed for <provider> (HTTP 401/403)` | The key is wrong, expired or missing. Check the variable named in the message. |
| `Rate limited by <provider> (HTTP 429) after N retries` | The free-tier quota was reached. Wait, lower `maxChunkTokens`, or switch provider. |
| `Request too large for <model>` | Lower `maxChunkTokens` or `contextLines`. |
| `<provider> endpoint not found (HTTP 404)` | `baseUrl` is probably missing the OpenAI-compatible prefix (usually `/v1`). |

Errors that will repeat on every chunk (unreachable, auth, config) stop the review after the first failure. The remaining files are listed as not reviewed.
