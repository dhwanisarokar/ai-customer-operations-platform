/**
 * Deterministic text chunking for retrieval.
 *
 * Strategy (documented in docs/knowledge-base.md):
 * - Normalize line endings and whitespace.
 * - Split on blank lines (paragraphs); paragraphs longer than the chunk size are split at sentence
 *   boundaries, and sentences still longer are split at word boundaries.
 * - Pack consecutive units greedily up to TARGET characters.
 * - Each chunk after the first starts with the tail of the previous chunk (OVERLAP characters,
 *   snapped to a word boundary) so a sentence cut at a boundary stays retrievable from either side.
 *
 * Sizes are in characters because no tokenizer is bundled. At roughly 4 characters per token for
 * English prose, TARGET is about 700 tokens and OVERLAP about 75. Token counts are estimates.
 * The same input always yields identical chunks and indexes.
 */
export const CHUNK_TARGET_CHARS = 2800;
export const CHUNK_OVERLAP_CHARS = 300;
export const APPROX_CHARS_PER_TOKEN = 4;

export type TextChunk = {
  chunkIndex: number;
  content: string;
  /** Estimated from length (about 4 characters per token); not a tokenizer result. */
  estimatedTokens: number;
};

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

/** Normalizes line endings, trims line-end whitespace and collapses 3+ newlines to one blank line. */
export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkText(
  content: string,
  options: { target?: number; overlap?: number } = {},
): TextChunk[] {
  const target = options.target ?? CHUNK_TARGET_CHARS;
  const overlap = Math.min(options.overlap ?? CHUNK_OVERLAP_CHARS, Math.floor(target / 2));
  const normalized = normalizeContent(content);
  if (!normalized) return [];

  const units = normalized.split(/\n{2,}/).flatMap((paragraph) => splitLongUnit(paragraph, target));

  const bodies: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
    } else if (current.length + 2 + unit.length <= target) {
      current = `${current}\n\n${unit}`;
    } else {
      bodies.push(current);
      const carry = overlapTail(current, overlap);
      current = carry ? `${carry}\n\n${unit}` : unit;
    }
  }
  if (current) bodies.push(current);

  return bodies.map((body, chunkIndex) => ({
    chunkIndex,
    content: body,
    estimatedTokens: estimateTokens(body),
  }));
}

/** Splits text longer than `max` at sentence ends, then at word boundaries. */
function splitLongUnit(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    for (const part of hardSplit(sentence, max)) {
      if (!buffer) buffer = part;
      else if (buffer.length + 1 + part.length <= max) buffer = `${buffer} ${part}`;
      else {
        pieces.push(buffer);
        buffer = part;
      }
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

function hardSplit(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max; // no usable space: cut mid-token rather than loop forever
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Last `overlap` characters of a chunk, starting at a word boundary. */
function overlapTail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return "";
  const tail = text.slice(-overlap);
  const firstSpace = tail.search(/\s/);
  return (firstSpace >= 0 ? tail.slice(firstSpace) : tail).trim();
}
