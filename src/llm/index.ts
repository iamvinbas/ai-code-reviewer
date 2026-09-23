import { LLMError, type LLMProvider, type ProviderConfig } from "../types.js";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  OpenAICompatibleProvider,
  defaultDeps,
  type ClientDeps,
} from "./client.js";
import { KEY_OPTIONAL, PRESETS, ollamaBaseUrlFromHost } from "./presets.js";

export { PRESETS } from "./presets.js";
export { extractJson, estimateTokens } from "./json.js";

/**
 * Builds a provider from preset defaults + config overrides.
 * Throws LLMError("auth") when a required API key is missing and LLMError("config") for
 * invalid configuration (unknown preset, missing/invalid baseUrl or model, bad ACR_OLLAMA_NUM_CTX).
 * `deps` is for tests only.
 */
export function createProvider(
  cfg: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<ClientDeps> = {},
): LLMProvider {
  const preset = Object.hasOwn(PRESETS, cfg.preset) ? PRESETS[cfg.preset] : undefined;
  if (!preset) {
    throw new LLMError("config", `Unknown provider preset "${cfg.preset}" — expected one of: ${Object.keys(PRESETS).join(", ")}`);
  }

  const ollamaHost = cfg.preset === "ollama" ? env.OLLAMA_HOST?.trim() : undefined;
  const rawBaseUrl = cfg.baseUrl?.trim() || (ollamaHost ? ollamaBaseUrlFromHost(ollamaHost) : preset.baseUrl);
  if (!rawBaseUrl) {
    throw new LLMError(
      "config",
      `provider.baseUrl is required for preset "${cfg.preset}" (e.g. http://localhost:1234/v1 for LM Studio)`,
    );
  }
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new LLMError("config", `Invalid provider.baseUrl "${baseUrl}" — expected an http(s) URL`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new LLMError("config", `Invalid provider.baseUrl "${baseUrl}" — expected an http(s) URL`);
  }

  const model = cfg.model?.trim() || preset.model;
  if (!model) throw new LLMError("config", `provider.model is required for preset "${cfg.preset}"`);

  const apiKeyEnv = cfg.apiKeyEnv?.trim() || preset.apiKeyEnv;
  const apiKey = (apiKeyEnv ? env[apiKeyEnv]?.trim() : undefined) || null;
  const keyRequired = Boolean(cfg.apiKeyEnv?.trim()) || (preset.apiKeyEnv !== null && !KEY_OPTIONAL.has(cfg.preset));
  if (keyRequired && !apiKey) {
    const where = KEY_OPTIONAL.has(cfg.preset)
      ? `set it to the API key for ${baseUrl}`
      : `get a free key at ${preset.docsUrl}`;
    throw new LLMError("auth", `${apiKeyEnv} is not set — ${where}`);
  }

  const ollamaNative = cfg.preset === "ollama";
  let numCtx: number | null = null;
  const rawNumCtx = ollamaNative ? env.ACR_OLLAMA_NUM_CTX?.trim() : undefined;
  if (rawNumCtx) {
    numCtx = Number(rawNumCtx);
    if (!Number.isInteger(numCtx) || numCtx < 512) {
      throw new LLMError("config", `Invalid ACR_OLLAMA_NUM_CTX "${rawNumCtx}" — expected an integer ≥ 512 (e.g. 16384)`);
    }
  }

  return new OpenAICompatibleProvider(
    {
      name: cfg.preset,
      baseUrl,
      model,
      apiKey,
      apiKeyEnv,
      docsUrl: preset.docsUrl,
      timeoutMs: positiveOr(cfg.timeoutMs, cfg.preset === "ollama" ? OLLAMA_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
      maxRetries:
        cfg.maxRetries !== undefined && Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0
          ? cfg.maxRetries
          : DEFAULT_MAX_RETRIES,
      ollamaNative,
      numCtx,
    },
    { ...defaultDeps, ...deps },
  );
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
