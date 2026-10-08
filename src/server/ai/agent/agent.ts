import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { searchKnowledge } from "@/server/services/knowledge-retrieval";
import { getAiProvider } from "../client";
import { AGENT_LIMITS, AI_TIMEOUTS } from "../config";
import { AiInvalidResponseError } from "../errors";
import {
  buildUserPrompt,
  FALLBACK_REPLY,
  lastAuthor,
  STAFF_FALLBACK_REPLY,
  labelFor,
  looksLikePromptLeak,
  PROMPT_VERSION,
  RESPONSE_JSON_SCHEMA,
  SYSTEM_INSTRUCTION,
} from "./prompts";
import type { AgentInput, AgentResult, AgentSource } from "./types";

const log = createLogger("ai.agent");

const modelOutputSchema = z.object({
  answerable: z.boolean(),
  reply: z.string().trim().min(1).max(AGENT_LIMITS.maxReplyChars),
  sourceLabels: z.array(z.string()).max(20),
  // Optional so older-shaped output still parses; absent means false.
  usedAccountData: z.boolean().optional(),
});

/**
 * Retrieval-augmented reply generation:
 *   retrieve (this organization, published knowledge, above the relevance threshold)
 *   -> build a delimited prompt -> Gemini (structured output) -> validate -> result with sources.
 *
 * The agent has no tools and no database access: it receives only the context built by the caller
 * plus retrieved chunks, and returns text. It never decides authorization.
 */
export async function runSupportAgent(input: AgentInput): Promise<AgentResult> {
  const chunks = await searchKnowledge({
    organizationId: input.organizationId,
    query: input.retrievalQuery.slice(0, AGENT_LIMITS.maxQueryChars),
    limit: AGENT_LIMITS.retrievalLimit,
  });

  const generation = await getAiProvider().generateResponse({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildUserPrompt(input, chunks),
    responseJsonSchema: RESPONSE_JSON_SCHEMA,
    temperature: 0.2,
    maxOutputTokens: 2048,
    timeoutMs: AI_TIMEOUTS.generationMs,
  });

  const output = parseModelOutput(generation.text);

  // Only labels that were really offered can be cited. Unknown labels are dropped, never invented.
  const sources: AgentSource[] = [];
  for (const label of new Set(output.sourceLabels.map((l) => l.trim().toUpperCase()))) {
    const index = chunks.findIndex((_, i) => labelFor(i) === label);
    if (index === -1) continue;
    const chunk = chunks[index];
    sources.push({
      label,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      similarity: chunk.similarity,
    });
  }

  // When staff wrote last, the sender is the team: the fallback must not point at "a team member".
  const fallback = lastAuthor(input) === "customer" ? FALLBACK_REPLY : STAFF_FALLBACK_REPLY;
  let reply = output.reply;
  let validation: AgentResult["validation"] = "ok";
  let grounded = output.answerable && sources.length > 0;
  // A reply built from the customer's own record (profile / tool results) needs no knowledge
  // citation. It is never a policy claim: those still require a cited source to be kept.
  let accountData = output.answerable && !grounded && output.usedAccountData === true;

  if (looksLikePromptLeak(reply)) {
    // Best-effort guard against the model echoing its instructions.
    reply = fallback;
    grounded = false;
    accountData = false;
    validation = "prompt_leak_replaced";
    sources.length = 0;
    log.warn({ promptVersion: PROMPT_VERSION }, "reply replaced: possible prompt leak");
  } else if (output.answerable && !grounded && !accountData) {
    // The model claims to answer from knowledge but cited nothing valid (or nothing was retrieved).
    reply = fallback;
    validation = "ungrounded_answer_replaced";
    log.warn(
      { promptVersion: PROMPT_VERSION, retrieved: chunks.length },
      "reply replaced: answer was not grounded in retrieved knowledge",
    );
  } else if (!output.answerable) {
    sources.length = 0; // a declined answer cites nothing
  }

  return {
    reply,
    grounded,
    accountData,
    sources,
    retrievedChunkIds: chunks.map((chunk) => chunk.chunkId),
    promptVersion: PROMPT_VERSION,
    model: generation.model,
    provider: generation.provider,
    latencyMs: generation.latencyMs,
    usage: generation.usage,
    validation,
  };
}

function parseModelOutput(text: string) {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiInvalidResponseError("not_json");
  }
  const parsed = modelOutputSchema.safeParse(json);
  if (!parsed.success) throw new AiInvalidResponseError("schema_mismatch");
  return parsed.data;
}
