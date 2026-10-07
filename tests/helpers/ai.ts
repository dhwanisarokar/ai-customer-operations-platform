import type {
  AIProvider,
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
} from "@/server/ai/provider";
import { setAiProviderForTesting } from "@/server/ai/client";

export const DIMENSIONS = 768;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % DIMENSIONS;
}

/**
 * Deterministic bag-of-words embedding: texts that share meaningful words are close in cosine
 * similarity, unrelated texts are near-orthogonal. Good enough to test retrieval ordering,
 * thresholds and tenant filtering without a real model.
 */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    vector[hash(word.replace(/(ing|ed|es|s)$/, ""))] += 1;
  }
  if (!vector.some((value) => value !== 0)) vector[0] = 1;
  return vector;
}

export type Scripted = string | ((request: GenerateRequest) => string | Promise<string>);

export class FakeAiProvider implements AIProvider {
  readonly name = "fake";
  generateCalls: GenerateRequest[] = [];
  embedCalls: EmbedRequest[] = [];

  /** Overrides (set per test). `undefined` means use the default behaviour. */
  generation: Scripted | undefined;
  generationError: Error | undefined;
  embeddingError: Error | undefined;
  embeddingTransform: ((vectors: number[][]) => number[][]) | undefined;
  usage: GenerateResult["usage"] = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  delayMs = 0;
  embedDelayMs = 0;

  async generateResponse(request: GenerateRequest): Promise<GenerateResult> {
    this.generateCalls.push(request);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.generationError) throw this.generationError;
    const scripted = this.generation;
    const text =
      scripted === undefined
        ? this.defaultAnswer(request.prompt)
        : typeof scripted === "string"
          ? scripted
          : await scripted(request);
    return {
      text,
      model: "fake-model",
      provider: "fake",
      latencyMs: 5,
      finishReason: "STOP",
      usage: this.usage,
    };
  }

  async generateEmbeddings(request: EmbedRequest): Promise<EmbedResult> {
    this.embedCalls.push(request);
    if (this.embedDelayMs) await new Promise((resolve) => setTimeout(resolve, this.embedDelayMs));
    if (this.embeddingError) throw this.embeddingError;
    let embeddings = request.texts.map((text, i) =>
      fakeEmbedding(
        request.purpose === "document" && request.titles ? `${request.titles[i]} ${text}` : text,
      ),
    );
    if (this.embeddingTransform) embeddings = this.embeddingTransform(embeddings);
    return {
      embeddings,
      model: "fake-embedding",
      provider: "fake",
      dimensions: DIMENSIONS,
      latencyMs: 1,
    };
  }

  /** Answers from the first knowledge source if there is one, otherwise declines. */
  private defaultAnswer(prompt: string): string {
    const match = prompt.match(/<source label="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/);
    if (!match) {
      return JSON.stringify({
        answerable: false,
        reply: "I do not have enough information about that, so a team member will follow up.",
        sourceLabels: [],
      });
    }
    return JSON.stringify({
      answerable: true,
      reply: `Here is what I found: ${match[2].slice(0, 120)}`,
      sourceLabels: [match[1]],
    });
  }

  /** The most recent generation prompt, split into the labelled sections for assertions. */
  lastPrompt(): string {
    return this.generateCalls[this.generateCalls.length - 1]?.prompt ?? "";
  }
}

/** Installs a fresh fake provider for the current test and returns it. */
export function installFakeAi(): FakeAiProvider {
  const provider = new FakeAiProvider();
  setAiProviderForTesting(provider);
  return provider;
}

export function uninstallFakeAi(): void {
  setAiProviderForTesting(undefined);
}

/** Convenience: model output JSON. */
export const modelJson = (output: { answerable: boolean; reply: string; sourceLabels: string[] }) =>
  JSON.stringify(output);
