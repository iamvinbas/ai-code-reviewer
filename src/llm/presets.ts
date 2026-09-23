import type { ProviderPreset } from "../types.js";

export interface PresetInfo {
  baseUrl: string;
  model: string;
  apiKeyEnv: string | null;
  docsUrl: string;
}

export const PRESETS: Record<ProviderPreset, PresetInfo> = {
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder:14b",
    apiKeyEnv: null,
    docsUrl: "https://ollama.com/download",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    apiKeyEnv: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/keys",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.8-27b:free",
    apiKeyEnv: "OPENROUTER_API_KEY",
    docsUrl: "https://openrouter.ai/keys",
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    apiKeyEnv: "CEREBRAS_API_KEY",
    docsUrl: "https://cloud.cerebras.ai",
  },
  "openai-compatible": {
    baseUrl: "",
    model: "",
    apiKeyEnv: "OPENAI_API_KEY",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
  },
};

/** Presets whose default key env var is optional (local servers, generic endpoints). */
export const KEY_OPTIONAL: ReadonlySet<ProviderPreset> = new Set(["ollama", "openai-compatible"]);

/** Turns an OLLAMA_HOST value ("host", "host:port", "http://host:port") into an OpenAI-compatible base URL. */
export function ollamaBaseUrlFromHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(raw);
  // Like the Ollama CLI: no explicit port means 11434, except for https.
  const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0] ?? "";
  if (!/:\d+$/.test(authority) && url.protocol === "http:") url.port = "11434";
  const base = url.toString().replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}
