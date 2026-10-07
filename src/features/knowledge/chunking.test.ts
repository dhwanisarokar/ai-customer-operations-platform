import { describe, expect, it } from "vitest";
import {
  APPROX_CHARS_PER_TOKEN,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkText,
  estimateTokens,
  normalizeContent,
} from "./chunking";

const paragraph = (label: string, length: number) =>
  `${label} ` + "word ".repeat(Math.ceil(length / 5)).slice(0, length - label.length - 1);

describe("normalizeContent", () => {
  it("normalizes line endings and collapses blank lines", () => {
    expect(normalizeContent("a  \r\n\r\n\r\n\r\nb\t\n")).toBe("a\n\nb");
  });
});

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n  ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("Refunds are available within 30 days.");
    expect(chunks).toEqual([
      { chunkIndex: 0, content: "Refunds are available within 30 days.", estimatedTokens: 10 },
    ]);
  });

  it("is deterministic: the same input yields identical chunks and indexes", () => {
    const text = [1, 2, 3, 4, 5].map((n) => paragraph(`P${n}`, 1500)).join("\n\n");
    expect(chunkText(text)).toEqual(chunkText(text));
    expect(chunkText(text).map((c) => c.chunkIndex)).toEqual(chunkText(text).map((_, i) => i));
  });

  it("packs paragraphs up to the target size without splitting them", () => {
    const text = [paragraph("A", 1000), paragraph("B", 1000), paragraph("C", 1000)].join("\n\n");
    const chunks = chunkText(text, { overlap: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain("A ");
    expect(chunks[0].content).toContain("B ");
    expect(chunks[1].content.startsWith("C ")).toBe(true);
    for (const chunk of chunks)
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
  });

  it("starts each later chunk with the tail of the previous one (overlap)", () => {
    const text = [paragraph("A", 2000), paragraph("B", 2000)].join("\n\n");
    const [first, second] = chunkText(text);
    const tail = first.content.slice(-CHUNK_OVERLAP_CHARS).trim();
    // The overlap is snapped to a word boundary, so it is a suffix of the tail window.
    const carried = second.content.slice(0, second.content.indexOf("\n\n"));
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.length).toBeLessThanOrEqual(CHUNK_OVERLAP_CHARS);
    expect(tail.endsWith(carried)).toBe(true);
    expect(second.content.endsWith(paragraph("B", 2000))).toBe(true);
  });

  it("splits a very long paragraph at sentence boundaries first", () => {
    const sentence = "This is a sentence about our product policy and nothing else. ";
    const text = sentence.repeat(120).trim(); // ~7400 chars, one paragraph
    const chunks = chunkText(text, { overlap: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      expect(chunk.content.endsWith(".")).toBe(true);
    }
  });

  it("hard-splits text that has no spaces or sentences without looping forever", () => {
    const chunks = chunkText("x".repeat(10_000), { overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.map((c) => c.content).join("")).toBe("x".repeat(10_000));
  });

  it("estimates tokens from length (about 4 characters per token), never zero", () => {
    expect(estimateTokens("x".repeat(400))).toBe(400 / APPROX_CHARS_PER_TOKEN);
    expect(estimateTokens("")).toBe(1);
    const [chunk] = chunkText("x ".repeat(100));
    expect(chunk.estimatedTokens).toBe(Math.ceil(chunk.content.length / 4));
  });

  it("produces chunks of roughly the documented size for long documents", () => {
    const text = Array.from({ length: 40 }, (_, i) => paragraph(`P${i}`, 700)).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(5);
    // 2800 chars + 300 overlap is about 775 estimated tokens at most.
    for (const chunk of chunks) expect(chunk.estimatedTokens).toBeLessThanOrEqual(800);
  });
});
