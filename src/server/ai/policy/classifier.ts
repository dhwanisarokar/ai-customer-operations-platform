import type { ConversationIntent } from "./types";

/**
 * Deterministic, dependency-free intent classification (no model call, no retrieval).
 *
 * Principles:
 * - Fail towards SUPPORT: anything not clearly conversational, off-topic or hostile goes through
 *   the normal RAG pipeline, which stays the single source of truth for factual answers.
 * - CONVERSATIONAL requires the WHOLE message to be small talk, so "hello, what is your refund
 *   policy?" is SUPPORT.
 * - Prompt-injection matching is a cheap first filter, NOT complete protection. Model-level
 *   instructions, input sanitization and output validation still apply to everything that
 *   reaches the model.
 */

/** Lowercases, strips punctuation/emoji and collapses whitespace. The original text is untouched. */
export function normalizeForPolicy(message: string): string {
  return message
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b.{0,30}\b(instructions?|rules|prompts?|guidelines|knowledge base|restrictions)\b/,
  /\b(reveal|show|print|display|repeat|leak|tell me|share|give me|what is|whats)\b.{0,30}\b(system prompt|system message|initial prompt|hidden instructions?|secret instructions?|developer message|your instructions|your prompt|internal configuration|your configuration)\b/,
  /\bsystem prompt\b/,
  /\b(your|the (ai|bot|system|server)s?|internal)\b.{0,15}\b(api keys?|secret keys?|secrets?|credentials|access tokens?|environment variables?|env vars?)\b/,
  /\b(environment variables?|env vars?)\b/,
  /\b(you are now|from now on you|pretend (to be|you are)|jailbreak|developer mode|dan mode)\b/,
];

const SMALL_TALK_FILLER = "(there|team|everyone|all|again|friend|support|assistant|ai|bot)";
const CONVERSATIONAL_PATTERNS: RegExp[] = [
  new RegExp(`^(hello|hi|hey|hiya|howdy|yo|greetings|hola)( ${SMALL_TALK_FILLER})?$`),
  /^good (morning|afternoon|evening|day)( (there|team|everyone|all))?$/,
  /^(thanks|thank you|thank u|thx|ty|cheers|many thanks|thanks a lot|thank you so much|thanks so much|thank you very much)( (a lot|so much|again|very much))?$/,
  /^(ok|okay|great|perfect|got it|understood|cool|awesome|sounds good)( (thanks|thank you))?$/,
  /^(bye|goodbye|good bye|see you|see ya|take care|have a (good|nice|great) (day|one|evening|weekend))( (now|later|soon))?$/,
  /^(youre welcome|no problem|no worries|np)$/,
  /^(hello|hi|hey) (how are you|hows it going)( today)?$/,
  /^(how are you|how are you doing|hows it going|how do you do|whats up|sup)( today)?$/,
  /^(can|could) you (please )?help( me| us)?$/,
  /^i (need|want) (some )?help$/,
  /^(help|help me|are you there|anyone there|is anyone there)$/,
];

const OUT_OF_SCOPE_PATTERNS: RegExp[] = [
  /\b(tell|say|crack)( me)? (a|an|another)? ?(joke|story|riddle|poem|fun fact)\b/,
  /\b(joke|riddle|poem|limerick|song lyrics)\b/,
  /\b(sing|rap) (me )?(a )?(song)?\b/,
  /\bwhat(s| is) the weather\b|\bweather (today|tomorrow|forecast|in)\b/,
  /\bwho (is|was) the (current )?(president|prime minister|king|queen)\b/,
  /\bwho (won|wins) (the|a|last)\b.*\b(match|game|race|election|cup|final)\b/,
  /\b(cricket|football|soccer|basketball|baseball|tennis|nba|nfl|ipl)\b.*\b(score|match|result|won|winner)\b/,
  /\b(stock price|bitcoin price|horoscope|lottery numbers)\b/,
  /\b(write|generate) (me )?(a |an )?(poem|essay|story|song|code|script|program)\b/,
  /\b(capital of|translate this|solve this equation|meaning of life)\b/,
];

export function classifyIntent(message: string): ConversationIntent {
  const normalized = normalizeForPolicy(message);
  if (normalized === "") return "SUPPORT";

  if (INJECTION_PATTERNS.some((pattern) => pattern.test(normalized))) return "PROMPT_INJECTION";
  if (CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(normalized))) return "CONVERSATIONAL";
  // Off-topic only applies to short, self-contained requests; long messages mixing in a real
  // question must reach the support pipeline.
  if (
    normalized.length <= 80 &&
    OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return "OUT_OF_SCOPE";
  }
  return "SUPPORT";
}

export type ConversationalKind = "greeting" | "thanks" | "farewell" | "wellbeing" | "help" | "ack";

export function conversationalKind(message: string): ConversationalKind {
  const n = normalizeForPolicy(message);
  if (/\b(thanks|thank|thx|ty|cheers)\b/.test(n)) return "thanks";
  if (/^(bye|goodbye|good bye|see you|see ya|take care|have a)/.test(n)) return "farewell";
  if (/\b(how are you|hows it going|how do you do|whats up|sup)\b/.test(n)) return "wellbeing";
  if (/\bhelp\b|\b(are you there|anyone there)\b/.test(n)) return "help";
  if (
    /^(ok|okay|great|perfect|got it|understood|cool|awesome|sounds good|youre welcome|no problem|no worries|np)/.test(
      n,
    )
  ) {
    return "ack";
  }
  return "greeting";
}
