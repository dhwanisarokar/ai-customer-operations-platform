import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const embedContent = vi.fn();
const constructed = vi.fn();

// The real SDK is never called in automated tests.
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent, embedContent };
    constructor(options: unknown) {
      constructed(options);
    }
  },
}));
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { AiConfig } from "../config";
import {
  AiEmbeddingError,
  AiInvalidResponseError,
  AiNotConfiguredError,
  AiProviderError,
  AiTimeoutError,
} from "../errors";
import { formatForEmbedding } from "./embeddings";
import { GeminiProvider } from "./provider";

const config: AiConfig = {
  apiKey: "test-key-not-real",
  generationModel: "gen-model",
  embeddingModel: "gemini-embedding-2",
  embeddingDimensions: 768,
  minSimilarity: 0.5,
};

const vec = () => new Array<number>(768).fill(0.1);

beforeEach(() => {
  generateContent.mockReset();
  embedContent.mockReset();
  constructed.mockReset();
});

describe("GeminiProvider construction", () => {
  it("refuses to start without an API key", () => {
    expect(() => new GeminiProvider({ ...config, apiKey: undefined })).toThrow(
      AiNotConfiguredError,
    );
  });

  it("passes the key to the SDK server-side only", () => {
    new GeminiProvider(config);
    expect(constructed).toHaveBeenCalledWith({ apiKey: "test-key-not-real" });
  });
});

describe("generateResponse", () => {
  const request = {
    systemInstruction: "sys",
    prompt: "hello",
    responseJsonSchema: { type: "object" },
    timeoutMs: 1000,
  };

  it("returns text, model, latency and reported token usage", async () => {
    generateContent.mockResolvedValue({
      text: '{"ok":true}',
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    });
    const result = await new GeminiProvider(config).generateResponse(request);
    expect(result).toMatchObject({
      text: '{"ok":true}',
      model: "gen-model",
      provider: "gemini",
      finishReason: "STOP",
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe("gen-model");
    expect(call.config).toMatchObject({
      systemInstruction: "sys",
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
  });

  it("leaves usage fields null when the API reports none (never invents numbers)", async () => {
    generateContent.mockResolvedValue({ text: "hi", candidates: [] });
    const { usage } = await new GeminiProvider(config).generateResponse({
      systemInstruction: "s",
      prompt: "p",
      timeoutMs: 1000,
    });
    expect(usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it("maps SDK failures to a safe error without leaking provider details", async () => {
    generateContent.mockRejectedValue(
      Object.assign(new Error("429 RESOURCE_EXHAUSTED key=test-key-not-real"), { status: 429 }),
    );
    const error = await new GeminiProvider(config).generateResponse(request).catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("test-key-not-real");
    expect(error.message).not.toContain("429");
  });

  it("treats empty or blocked output as an invalid response", async () => {
    generateContent.mockResolvedValue({ text: "  ", promptFeedback: { blockReason: "SAFETY" } });
    await expect(new GeminiProvider(config).generateResponse(request)).rejects.toBeInstanceOf(
      AiInvalidResponseError,
    );
    generateContent.mockResolvedValue({ text: undefined });
    await expect(new GeminiProvider(config).generateResponse(request)).rejects.toBeInstanceOf(
      AiInvalidResponseError,
    );
  });

  it("times out via an abort signal and reports a timeout error", async () => {
    generateContent.mockImplementation(
      ({ config: c }: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_, reject) =>
          c.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    await expect(
      new GeminiProvider(config).generateResponse({ ...request, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(AiTimeoutError);
  });
});

describe("generateEmbeddings", () => {
  it("requests 768 dimensions and returns vectors in order", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: vec() }, { values: vec() }] });
    const result = await new GeminiProvider(config).generateEmbeddings({
      texts: ["a", "b"],
      purpose: "document",
      timeoutMs: 1000,
    });
    expect(result.embeddings).toHaveLength(2);
    expect(result.dimensions).toBe(768);
    expect(embedContent.mock.calls[0][0].config.outputDimensionality).toBe(768);
    expect(embedContent.mock.calls[0][0].model).toBe("gemini-embedding-2");
  });

  it("steers newer models with text prefixes and older models with taskType", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: vec() }] });
    await new GeminiProvider(config).generateEmbeddings({
      texts: ["how do refunds work"],
      purpose: "query",
      timeoutMs: 1000,
    });
    const newer = embedContent.mock.calls[0][0];
    expect(newer.contents[0].parts[0].text).toBe(
      "task: search result | query: how do refunds work",
    );
    expect(newer.config.taskType).toBeUndefined();

    embedContent.mockClear();
    embedContent.mockResolvedValue({ embeddings: [{ values: vec() }] });
    await new GeminiProvider({
      ...config,
      embeddingModel: "gemini-embedding-001",
    }).generateEmbeddings({
      texts: ["body"],
      titles: ["Refunds"],
      purpose: "document",
      timeoutMs: 1000,
    });
    const older = embedContent.mock.calls[0][0];
    expect(older.config.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(older.contents[0].parts[0].text).toBe("Refunds\n\nbody");
  });

  it("splits large inputs into batches", async () => {
    embedContent.mockImplementation(({ contents }: { contents: unknown[] }) =>
      Promise.resolve({ embeddings: contents.map(() => ({ values: vec() })) }),
    );
    const texts = Array.from({ length: 120 }, (_, i) => `t${i}`);
    const result = await new GeminiProvider(config).generateEmbeddings({
      texts,
      purpose: "document",
      timeoutMs: 1000,
    });
    expect(result.embeddings).toHaveLength(120);
    expect(embedContent).toHaveBeenCalledTimes(3);
  });

  it("sends one Content per text so models cannot merge a batch into a single embedding", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: vec() }, { values: vec() }] });
    await new GeminiProvider(config).generateEmbeddings({
      texts: ["first", "second"],
      purpose: "document",
      timeoutMs: 1000,
    });
    const { contents } = embedContent.mock.calls[0][0];
    expect(contents).toHaveLength(2);
    expect(contents.every((c: { parts: unknown[] }) => c.parts.length === 1)).toBe(true);
  });

  it("rejects a response whose embedding count does not match", async () => {
    embedContent.mockResolvedValue({ embeddings: [{ values: vec() }] });
    await expect(
      new GeminiProvider(config).generateEmbeddings({
        texts: ["a", "b"],
        purpose: "document",
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiEmbeddingError);
    embedContent.mockResolvedValue({ embeddings: undefined });
    await expect(
      new GeminiProvider(config).generateEmbeddings({
        texts: ["a"],
        purpose: "query",
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AiEmbeddingError);
  });

  it("maps API failures and timeouts to safe errors", async () => {
    embedContent.mockRejectedValue(new Error("500 internal key=test-key-not-real"));
    const error = await new GeminiProvider(config)
      .generateEmbeddings({ texts: ["a"], purpose: "query", timeoutMs: 1000 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.message).not.toContain("test-key-not-real");

    embedContent.mockImplementation(
      ({ config: c }: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_, reject) =>
          c.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    await expect(
      new GeminiProvider(config).generateEmbeddings({
        texts: ["a"],
        purpose: "query",
        timeoutMs: 20,
      }),
    ).rejects.toBeInstanceOf(AiTimeoutError);
  });
});

describe("formatForEmbedding", () => {
  it("formats documents with a title and queries with a task prefix for newer models", () => {
    expect(formatForEmbedding("gemini-embedding-2", "document", "text", "Title")).toBe(
      "title: Title | text: text",
    );
    expect(formatForEmbedding("gemini-embedding-2", "document", "text")).toBe(
      "title: none | text: text",
    );
  });
});

describe("generateWithTools (function calling)", () => {
  const tools = [
    {
      name: "getCustomer",
      description: "Look up a customer",
      parametersJsonSchema: { type: "object", properties: { customerId: { type: "string" } } },
    },
  ];
  const request = {
    systemInstruction: "sys",
    turns: [{ role: "user" as const, text: "hi" }],
    tools,
    timeoutMs: 1000,
  };

  it("sends declarations only, disables automatic function calling and returns the requested calls", async () => {
    generateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "getCustomer", args: { customerId: "c1" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    });
    const result = await new GeminiProvider(config).generateWithTools(request);

    const sent = generateContent.mock.calls[0][0];
    expect(sent.model).toBe("gen-model");
    expect(sent.config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "getCustomer",
            description: "Look up a customer",
            parametersJsonSchema: tools[0].parametersJsonSchema,
          },
        ],
      },
    ]);
    expect(sent.config.automaticFunctionCalling).toEqual({ disable: true });
    expect(result.toolCalls).toEqual([{ name: "getCustomer", args: { customerId: "c1" } }]);
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    expect(result.providerData).toMatchObject({ role: "model" });
  });

  it("returns plain text when the model asks for no tool, ignoring thought parts", async () => {
    generateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "secret thoughts", thought: true }, { text: "DONE" }],
          },
        },
      ],
    });
    const result = await new GeminiProvider(config).generateWithTools(request);
    expect(result).toMatchObject({ text: "DONE", toolCalls: [] });
  });

  it("maps tool results back as one user turn and replays the model content verbatim", async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const modelContent = {
      role: "model",
      parts: [{ functionCall: { name: "a", args: {} } }, { functionCall: { name: "b", args: {} } }],
    };
    await new GeminiProvider(config).generateWithTools({
      ...request,
      turns: [
        { role: "user", text: "hi" },
        { role: "model", text: "", toolCalls: [], providerData: modelContent },
        { role: "tool", name: "a", response: { result: 1 } },
        { role: "tool", name: "b", response: { result: 2 } },
      ],
    });
    const contents = generateContent.mock.calls[0][0].contents;
    expect(contents).toHaveLength(3);
    expect(contents[1]).toBe(modelContent);
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "a", response: { result: 1 } } },
        { functionResponse: { name: "b", response: { result: 2 } } },
      ],
    });
  });

  it("maps failures to the same safe errors as normal generation", async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [] } }] });
    await expect(new GeminiProvider(config).generateWithTools(request)).rejects.toBeInstanceOf(
      AiInvalidResponseError,
    );
    generateContent.mockRejectedValue(new Error("503 key=SECRET"));
    const error = await new GeminiProvider(config).generateWithTools(request).catch((e) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(String(error.message)).not.toContain("SECRET");
  });
});
