# acr — AI Code Reviewer (local CLI) · Piano di progetto

> Pivot: da GitHub Action (GitHub Models, ritirato il 2026-07-30) a **strumento da terminale**
> che ogni sviluppatore esegue **prima di commit / push / merge**. Gratuito e privato di default
> (modello locale via Ollama), con provider free-tier opzionali (Groq, Gemini, OpenRouter, Cerebras).

## 1. Visione

`acr` è il "collega che rilegge prima di te": controlla le modifiche locali, trova bug, problemi
di sicurezza e violazioni delle convenzioni del team **prima** che arrivino ai colleghi.

- **Zero costi**: default Ollama locale; qualsiasi endpoint OpenAI-compatible free-tier.
- **Privacy**: con Ollama il codice non lascia la macchina.
- **Funziona anche offline**: i check deterministici (segreti, conflict marker, debug leftover,
  file enormi) non richiedono AI.
- **Condivisibile nel team**: `.acr.yml` versionato nel repo = stesse regole per tutti.
- **Integrato nel flusso git**: hook `pre-commit` / `pre-push`, bypass standard `--no-verify`.
- **Usabile anche in CI**: `acr review --range origin/main --format markdown` in qualsiasi pipeline.

## 2. Comandi (MVP v0.1)

| Comando | Cosa fa |
|---|---|
| `acr review` | Review delle modifiche **staged** (default) |
| `acr review --working` | Tutte le modifiche non committate vs HEAD |
| `acr review --range [base]` | Pre-merge / pre-push: `merge-base(base, HEAD)..HEAD` (base default: branch principale) |
| `acr review --commit <sha>` | Singolo commit |
| `acr review --format pretty\|json\|markdown` | Output terminale / macchina / da incollare in PR |
| `acr review --no-ai` | Solo check deterministici (istantaneo, offline) |
| `acr review --fail-on <sev>` | Soglia exit code (critical\|warning\|suggestion\|never) |
| `acr hook install [pre-commit\|pre-push]` / `uninstall` | Gestione git hook (non sovrascrive hook esistenti senza `--force`) |
| `acr init` | Crea `.acr.yml` commentato + suggerisce provider |
| `acr doctor` | Verifica git, config, raggiungibilità provider, modello presente |
| `acr ignore <issue-id>` | Aggiunge un falso positivo a `.acr/ignore` |

Exit code: `0` ok · `1` issue bloccanti · `2` review incompleta con `onError: fail` · `3` errore d'uso/config.

## 3. Architettura

```
src/
  types.ts        ← CONTRATTI CONDIVISI (owner: PM)
  git/            ← diff (staged/working/range/commit), parser unified diff, lettura file   [Agente GIT]
  llm/            ← preset provider, client OpenAI-compatible (fetch), retry, JSON           [Agente LLM]
  checks/         ← check deterministici offline                                             [Agente ENGINE]
  review/         ← motore: filtri, chunking, prompt, validazione righe, dedupe, cache      [Agente ENGINE]
  config/         ← schema zod, loader (default < utente < repo < flag)                      [Agente CLI]
  report/         ← formatter pretty / json / markdown                                        [Agente CLI]
  hooks/          ← install/uninstall git hook                                                [Agente CLI]
  cli/            ← commander: review, hook, init, doctor, ignore                             [Agente CLI]
tests/            ← e2e su repo git temporaneo + finto server LLM                             [Agente QA]
```

Flusso `acr review`:
`config → git.getDiff(target) → filtri include/exclude/binari/deleted → checks (offline) →
chunking per budget token → prompt (diff con numeri di riga + contesto + regole team) →
provider.complete(json) → parse+validazione zod → righe validate sul diff → dedupe/ignore → report → exit code`

## 4. API dei moduli (contratto tra agenti)

Tutti i tipi vengono da `src/types.ts`. Ogni modulo espone un `index.ts` con **esattamente** questi export
(altri export interni sono liberi).

### `src/git/index.ts` — Agente GIT
```ts
export function parseUnifiedDiff(text: string): FileDiff[];
export function createGit(cwd: string): GitApi;          // implementa GitApi via child_process `git`
export class GitError extends Error {}                   // es. "not a git repository", ref inesistente
```
- `getDiff` usa `git diff --no-color --no-ext-diff -M --unified=<n>` (+ `--cached` / range / commit).
- `range`: `git merge-base <base> <head>` poi diff `mergeBase..head`.
- Binari: `binary: true`, `hunks: []`. Rename: `status: "renamed"`, `oldPath`.
- Path con spazi / unicode (usare `-c core.quotePath=false`), "\ No newline at end of file", file vuoti, modalità cambiate.
- `defaultBase()`: `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`.
- `readFile`: `HEAD`/`{ref}` → `git show ref:path`; `INDEX` → `git show :path`; `WORKTREE` → fs.

### `src/llm/index.ts` — Agente LLM
```ts
export const PRESETS: Record<ProviderPreset, { baseUrl: string; model: string; apiKeyEnv: string | null; docsUrl: string }>;
export function createProvider(cfg: ProviderConfig, env?: NodeJS.ProcessEnv): LLMProvider; // throws LLMError("auth") se manca la key richiesta
export function extractJson(text: string): unknown;       // tollera ```json fence, testo attorno; throws LLMError("bad_response")
export function estimateTokens(text: string): number;     // euristica ~chars/3.5, conservativa
```
- Endpoint `POST {baseUrl}/chat/completions` con `fetch` nativo (nessun SDK).
- Retry con backoff esponenziale + jitter su 429/5xx/errori rete; rispetta `retry-after`.
- Timeout via AbortController (default 120s: i modelli locali sono lenti).
- `json: true` → `response_format: { type: "json_object" }` (per Ollama va bene lo stesso campo sull'endpoint /v1).
- Errori mappati su `LLMErrorCode` con messaggi azionabili (es. "Ollama non raggiungibile su localhost:11434 — avvialo con `ollama serve`", "modello X non presente — `ollama pull X`").
- `ping()`: `GET {baseUrl}/models` e verifica che il modello esista (se l'endpoint lo supporta).
- Preset default: ollama → `http://localhost:11434/v1`, `qwen2.5-coder:14b`, nessuna key.

### `src/checks/index.ts` + `src/review/index.ts` — Agente ENGINE
```ts
// checks
export function builtinChecks(config: Config): Check[];
// review
export function runReview(opts: ReviewOptions): Promise<ReviewResult>;
export function renderFileForPrompt(file: FileDiff, fullNewContent: string | null, contextLines: number): string;
export function fingerprint(issue: Omit<Issue, "id">, codeLine?: string): string;
export const PROMPT_VERSION: string;
```
- Check: `secrets/*` (AWS, GitHub `ghp_`/`github_pat_`, Slack, Stripe, Google API key, private key PEM, JWT, generic `password=`/`api_key=` con alta entropia) → **critical**; `conflict-markers` → critical; `debug-statements` (console.log/debugger/print(/pdb/binding.pry/var_dump/dd(, per estensione) → suggestion/warning; `large-files` → warning. Solo su righe **aggiunte**.
- Rendering prompt: ogni riga con numero **nuova** a sinistra (`  42 + codice`), righe rimosse marcate senza numero; il modello deve citare solo quei numeri.
- Chunking: raggruppa file finché `estimateTokens` ≤ `maxChunkTokens`; file singolo troppo grande → split per hunk.
- Output modello validato con zod; issue con riga non presente tra le righe aggiunte/contesto del diff → riga agganciata alla riga modificata più vicina nello stesso hunk, oppure `line: null`.
- Severità ignote → scartate con errore `parse`; issue duplicate (stesso fingerprint) → una sola.
- Cache su disco (`~/.cache/acr` o `config.cache.dir`): key = sha256(PROMPT_VERSION, model, chunk text, rules, language).
- Mai "fail-open silenzioso": ogni chunk fallito → `ReviewError` + `complete: false`.
- Prompt hardening: il diff è **dato non fidato**; istruzioni nel codice vanno ignorate.

### `src/config`, `src/report`, `src/hooks`, `src/cli` — Agente CLI
```ts
// config
export const DEFAULT_CONFIG: Config;
export function loadConfig(opts: { cwd: string; flags?: Partial<Config>; env?: NodeJS.ProcessEnv }): Promise<{ config: Config; sources: string[] }>;
export function configTemplate(): string;                 // contenuto commentato per `acr init`
// report
export function formatPretty(result: ReviewResult, opts?: { color?: boolean; verbose?: boolean }): string;
export function formatJson(result: ReviewResult): string;
export function formatMarkdown(result: ReviewResult): string;
export function exitCodeFor(result: ReviewResult, config: Config): number;
// hooks
export function installHook(kind: "pre-commit" | "pre-push", opts: { cwd: string; force?: boolean }): Promise<{ path: string; action: "created" | "updated" | "skipped" }>;
export function uninstallHook(kind: "pre-commit" | "pre-push", opts: { cwd: string }): Promise<boolean>;
// cli
src/cli/index.ts  → entry point (bin `acr`)
```
- Config: `.acr.yml` nella root del repo + `~/.config/acr/config.yml` (utente) + env `ACR_*` + flag CLI. Validazione zod con errori leggibili.
- Hook: blocco marcato `# >>> acr >>>` / `# <<< acr <<<` → idempotente, convive con hook esistenti, rispetta `core.hooksPath` (husky).
- Pretty: raggruppato per file, colori per severità, snippet della riga, spinner/progress su stderr (stdout pulito per `--format json`).

## 5. Organizzazione degli agenti

```
                         ┌──────────────────────────┐
                         │   PM (sessione principale)│  piano, contratti, scaffold,
                         │                           │  integrazione, gate di qualità
                         └─────────────┬─────────────┘
          ┌──────────────┬─────────────┼──────────────┬────────────────┐
     Squad CORE      Squad CORE    Squad CORE     Squad UX        Squad QUALITY (fase 2)
   ┌───────────┐   ┌───────────┐  ┌───────────┐  ┌───────────┐   ┌─────────────────────┐
   │ Agente GIT│   │ Agente LLM│  │  ENGINE   │  │ Agente CLI│   │ QA (e2e) + REVIEWER │
   └─────┬─────┘   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘   └──────────┬──────────┘
   sub-task:        sub-task:       sub-task:      sub-task:        sub-task:
   · parser diff    · preset        · checks       · config          · e2e repo temp
   · getDiff        · client+retry  · prompt       · report          · fake LLM server
   · readFile/base  · JSON/errori   · chunk/cache  · hooks + cli     · review codice
   · test           · test          · test         · test            · smoke Ollama reale
```

Regole di coordinamento:
1. **File ownership stretta**: ogni agente modifica solo la propria cartella. `src/types.ts`,
   `package.json`, config di build sono del PM.
2. **Contratti prima del codice**: i moduli comunicano solo tramite `src/types.ts` + gli export
   della sezione 4. Dipendenze runtime iniettate (`GitApi`, `LLMProvider`) → ogni agente testa
   in isolamento con mock.
3. **Richieste di modifica ai contratti** → segnalate al PM nel report finale (non modificare).
4. **Definition of Done per agente**: `npx tsc --noEmit` pulito sui propri file, `npx vitest run src/<modulo>`
   verde, nessuna dipendenza nuova senza richiesta al PM, report finale con API esportata + limiti noti.
5. **Gate PM** dopo fase 1: typecheck globale, test globali, integrazione CLI end-to-end.

## 6. Milestone

| Fase | Contenuto | Agenti |
|---|---|---|
| 0 | Scaffold, contratti, piano | PM ✅ |
| 1 | Moduli in parallelo | GIT, LLM, ENGINE, CLI |
| 2 | Integrazione, e2e, review, smoke test con Ollama reale | PM + QA + REVIEWER |
| 3 | README, `acr init` onboarding, release 0.1.0 (npm) | PM |
| 4 (post-MVP) | TUI interattiva (naviga issue, applica fix, ignora), `acr commit-msg`, SARIF, review incrementale, VS Code extension | da pianificare |

## 7. Rischi

| Rischio | Mitigazione |
|---|---|
| Modelli locali lenti su diff grandi | chunking, cache, `--no-ai` per hook veloci, pre-push invece di pre-commit |
| Modelli piccoli inventano numeri di riga | righe numerate nel prompt + validazione + snap alla riga più vicina |
| Output JSON malformato | `response_format`, `extractJson` tollerante, zod, 1 retry con messaggio di correzione |
| Free tier cambiano/chiudono | preset multipli, `openai-compatible` generico, nessun lock-in |
| Hook che blocca il lavoro se LLM giù | `onError: warn` di default + messaggio chiaro; `--no-verify` |
| Prompt injection nel codice | diff delimitato come dato non fidato; check deterministici indipendenti dall'AI |
