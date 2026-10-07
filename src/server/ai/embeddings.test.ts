import { afterEach, describe, expect, it } from "vitest";
import { installFakeAi, uninstallFakeAi } from "../../../tests/helpers/ai";
import { AiEmbeddingError } from "./errors";
import { EMBEDDING_DIMENSIONS } from "./config";
import { embedDocuments, embedQuery, normalizeVector, validateEmbedding } from "./embeddings";

afterEach(uninstallFakeAi);

const vectorOf = (value: number, size = EMBEDDING_DIMENSIONS) =>
  new Array<number>(size).fill(value);

describe("validateEmbedding", () => {
  it("accepts a correctly sized finite vector and normalizes it to unit length", () => {
    const result = validateEmbedding(vectorOf(2));
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...result)).toBeCloseTo(1, 6);
  });

  it.each([
    ["too short", vectorOf(1, 767)],
    ["too long", vectorOf(1, 3072)],
    ["empty", []],
    ["not an array", "nope"],
    ["null", null],
    ["NaN", [...vectorOf(1, 767), Number.NaN]],
    ["Infinity", [...vectorOf(1, 767), Number.POSITIVE_INFINITY]],
    ["strings", vectorOf(1).map(String)],
    ["all zeros", vectorOf(0)],
  ])("rejects %s", (_label, input) => {
    expect(() => validateEmbedding(input)).toThrow(AiEmbeddingError);
  });
});

describe("normalizeVector", () => {
  it("scales to unit length", () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8]);
  });
});

describe("embedDocuments / embedQuery", () => {
  it("returns validated unit vectors, one per text, and tags the purpose", async () => {
    const fake = installFakeAi();
    const vectors = await embedDocuments(["refund policy", "shipping times"], ["A", "B"]);
    expect(vectors).toHaveLength(2);
    expect(vectors.every((v) => Math.abs(Math.hypot(...v) - 1) < 1e-6)).toBe(true);
    expect(fake.embedCalls[0]).toMatchObject({ purpose: "document", titles: ["A", "B"] });

    await embedQuery("refund");
    expect(fake.embedCalls[1]).toMatchObject({ purpose: "query" });
  });

  it("does not call the provider for an empty batch", async () => {
    const fake = installFakeAi();
    expect(await embedDocuments([])).toEqual([]);
    expect(fake.embedCalls).toHaveLength(0);
  });

  it("rejects wrong dimensions returned by the provider", async () => {
    const fake = installFakeAi();
    fake.embeddingTransform = (vectors) => vectors.map((v) => v.slice(0, 100));
    await expect(embedQuery("anything")).rejects.toBeInstanceOf(AiEmbeddingError);
    await expect(embedDocuments(["x"])).rejects.toBeInstanceOf(AiEmbeddingError);
  });

  it("rejects a count mismatch from the provider", async () => {
    const fake = installFakeAi();
    fake.embeddingTransform = (vectors) => vectors.slice(1);
    await expect(embedDocuments(["a", "b"])).rejects.toBeInstanceOf(AiEmbeddingError);
  });

  it("propagates provider failures", async () => {
    const fake = installFakeAi();
    fake.embeddingError = new Error("boom");
    await expect(embedQuery("x")).rejects.toThrow("boom");
  });
});
