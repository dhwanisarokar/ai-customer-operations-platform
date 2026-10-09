import { getAiConfig } from "./config";
import { GeminiProvider } from "./gemini/provider";
import type { AIProvider } from "./types";

let provider: AIProvider | undefined;

/**
 * The application's AI provider. Services call this (never a vendor SDK). Throws
 * AiNotConfiguredError (HTTP 503) when no API key is set.
 */
export function getAiProvider(): AIProvider {
  provider ??= new GeminiProvider(getAiConfig());
  return provider;
}

/** Whether a provider can be used at all (an API key is set, or a test provider was injected). */
export function aiProviderAvailable(): boolean {
  return provider !== undefined || Boolean(getAiConfig().apiKey);
}

/** Test hook: swap the provider (or pass undefined to reset). */
export function setAiProviderForTesting(next: AIProvider | undefined): void {
  provider = next;
}
