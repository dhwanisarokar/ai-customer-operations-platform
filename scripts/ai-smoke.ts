/**
 * Real-API smoke test for the Gemini integration. Development tool, never run by CI or the test
 * suite (those use a fake provider).
 *
 *   npm run ai:smoke
 *
 * Makes exactly 3 requests with the key from .env (it is never printed):
 *   1. embed two documents   2. embed one query   3. generate one structured reply
 * and checks: embedding size, similarity ordering (to inform RAG_MIN_SIMILARITY), and that the
 * model returns output our validation accepts. It does not touch the database.
 */
import "dotenv/config";
import {
  buildUserPrompt,
  RESPONSE_JSON_SCHEMA,
  SYSTEM_INSTRUCTION,
} from "@/server/ai/agent/prompts";
import { getAiProvider } from "@/server/ai/client";
import { AI_TIMEOUTS, EMBEDDING_DIMENSIONS, getAiConfig } from "@/server/ai/config";
import { validateEmbedding } from "@/server/ai/embeddings";

const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);

async function main() {
  const config = getAiConfig();
  if (!config.apiKey) throw new Error("GEMINI_API_KEY is not set in .env");
  console.log(`generation model: ${config.generationModel}`);
  console.log(`embedding model:  ${config.embeddingModel} (${EMBEDDING_DIMENSIONS} dimensions)`);
  console.log(`threshold:        ${config.minSimilarity}`);

  const provider = getAiProvider();

  const docs = [
    {
      title: "Refund policy",
      text: "Refunds are available within 30 days of purchase. To request a refund, contact support with your order number.",
    },
    {
      title: "Office hours",
      text: "Our support team is available Monday to Friday, 9am to 5pm Central European Time.",
    },
  ];
  const documents = await provider.generateEmbeddings({
    texts: docs.map((d) => d.text),
    titles: docs.map((d) => d.title),
    purpose: "document",
    timeoutMs: AI_TIMEOUTS.embeddingMs,
  });
  const query = await provider.generateEmbeddings({
    texts: ["How long do I have to ask for my money back?"],
    purpose: "query",
    timeoutMs: AI_TIMEOUTS.embeddingMs,
  });
  const [refund, hours] = documents.embeddings.map(validateEmbedding);
  const [q] = query.embeddings.map(validateEmbedding);
  const relevant = dot(q, refund);
  const unrelated = dot(q, hours);
  console.log(
    `embedding dims: ${documents.embeddings[0].length} (latency ${documents.latencyMs}ms / ${query.latencyMs}ms)`,
  );
  console.log(`cosine(query, refund policy)  = ${relevant.toFixed(3)}  <- relevant`);
  console.log(`cosine(query, office hours)   = ${unrelated.toFixed(3)}  <- unrelated`);
  if (!(relevant > unrelated))
    throw new Error("relevant document did not outrank the unrelated one");

  const prompt = buildUserPrompt(
    {
      organizationId: "smoke",
      customer: { name: "Test Customer", company: "Acme", status: "ACTIVE" },
      messages: [{ role: "customer", text: "How long do I have to ask for my money back?" }],
      retrievalQuery: "refund window",
    },
    [
      {
        chunkId: "c1",
        documentId: "d1",
        documentTitle: docs[0].title,
        chunkIndex: 0,
        content: docs[0].text,
        similarity: relevant,
      },
    ],
  );
  const result = await provider.generateResponse({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    responseJsonSchema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0.2,
    maxOutputTokens: 2048,
    timeoutMs: AI_TIMEOUTS.generationMs,
  });
  const parsed = JSON.parse(result.text) as {
    answerable: boolean;
    reply: string;
    sourceLabels: string[];
  };
  console.log(
    `generation: ${result.latencyMs}ms, finish=${result.finishReason}, usage=${JSON.stringify(result.usage)}`,
  );
  console.log(
    `answerable=${parsed.answerable} sourceLabels=${JSON.stringify(parsed.sourceLabels)}`,
  );
  console.log(`reply: ${parsed.reply}`);
  if (
    typeof parsed.answerable !== "boolean" ||
    typeof parsed.reply !== "string" ||
    !Array.isArray(parsed.sourceLabels)
  ) {
    throw new Error("structured output did not match the schema");
  }
  console.log("OK");
}

main().catch((error) => {
  // Print only the error class/message; SDK errors never include the key, but stay conservative.
  console.error(
    `FAILED: ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 400)}` : String(error)}`,
  );
  process.exit(1);
});
