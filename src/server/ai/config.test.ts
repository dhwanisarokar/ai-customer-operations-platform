import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_LIMITS, EMBEDDING_DIMENSIONS } from "./config";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/test");
  return (await import("./config")).getAiConfig();
}

describe("AI config (single source of truth)", () => {
  it("stores 768-dimensional embeddings (a database fact, not an env setting)", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
  });

  it("uses the documented default models and threshold when nothing is overridden", async () => {
    const config = await load({
      GEMINI_API_KEY: "",
      GEMINI_GENERATION_MODEL: "",
      GEMINI_EMBEDDING_MODEL: "",
      RAG_MIN_SIMILARITY: "",
    });
    expect(config).toMatchObject({
      apiKey: undefined,
      embeddingModel: "gemini-embedding-2",
      embeddingDimensions: 768,
      minSimilarity: 0.6,
    });
    expect(config.generationModel).toMatch(/^gemini-/);
  });

  it("lets models and the threshold be overridden from the environment", async () => {
    const config = await load({
      GEMINI_API_KEY: "k",
      GEMINI_GENERATION_MODEL: "gemini-custom",
      GEMINI_EMBEDDING_MODEL: "gemini-embedding-001",
      RAG_MIN_SIMILARITY: "0.7",
    });
    expect(config).toMatchObject({
      apiKey: "k",
      generationModel: "gemini-custom",
      embeddingModel: "gemini-embedding-001",
      minSimilarity: 0.7,
    });
  });

  it("bounds the agent's context", () => {
    expect(AGENT_LIMITS.retrievalLimit).toBeLessThanOrEqual(10);
    expect(AGENT_LIMITS.maxConversationChars).toBeLessThanOrEqual(12_000);
  });
});
