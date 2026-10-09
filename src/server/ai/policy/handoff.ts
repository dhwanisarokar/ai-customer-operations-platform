/**
 * Deterministic detection of a visitor's request for a person. The model never decides this: a handoff
 * changes how the conversation is handled, so it needs the visitor's own words, not an AI sentence.
 *
 *  - explicit request:  "I want to talk to a person", "connect me with support", "human agent please"
 *  - acceptance:        "yes, please connect me", "sure", "please do that" - ONLY when the previous
 *                       customer-facing message was an AI message the system flagged as offering a person
 *                       (`metadata.handoffSuggested`, see customer-ai); the words alone never count.
 *
 * Both functions look at the visitor's message only. Unrelated questions that merely mention
 * "support" ("what are your support hours?") are not handoff requests.
 */

const normalize = (text: string) =>
  text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

const TARGET =
  "(?:person|people|human|agent|representative|rep|someone|somebody|operator|advisor|manager|support|team|staff|customer service|customer support|colleague)";

const EXPLICIT_PATTERNS: RegExp[] = [
  // talk / speak / chat / connect ... to / with ... a person / support
  new RegExp(
    `\\b(?:talk|speak|chat|connect|transfer|escalate|put me through|hand me over|pass me|get me)\\b[^.?!]{0,30}\\b(?:to|with|through|over to|onto)\\b[^.?!]{0,20}\\b${TARGET}\\b`,
  ),
  // I want / I need / can I have ... a human / a real person
  new RegExp(
    `\\b(?:i want|i need|i would like|i'd like|i wanna|can i have|can i get|let me have)\\b[^.?!]{0,25}\\b(?:human|real person|live agent|live person|person|agent|representative|manager|someone from)\\b`,
  ),
  /\b(?:human|live|real) (?:agent|person|being|support)\b/,
  /\b(?:agent|representative|human) please\b/,
];

// "I don't want to talk to anyone", "no need for a human"
const NEGATED =
  /\b(?:don't|do not|dont|no need to|no need for|not)\s+(?:want|need|wish|going)?\s*(?:to\s+)?(?:talk|speak|chat|connect|a human|a person|an agent|human|person|agent)\b/;

export function isExplicitHumanRequest(message: string): boolean {
  const text = normalize(message);
  if (!text || text.length > 300) return false;
  if (NEGATED.test(text)) return false;
  return EXPLICIT_PATTERNS.some((pattern) => pattern.test(text));
}

// The WHOLE message must be an acceptance: "yes", "yes, please connect me", "sure", "please do that".
// Anything else in the message ("yes, but what about shipping?") is a normal message.
const AFFIRMATIVE = "(?:yes|yeah|yep|yup|sure|ok|okay|alright|please)";
const FILLER =
  "(?:please|do that|do it|go ahead|connect me|connect me please|that would be (?:great|good|helpful)|sounds good|thanks|thank you|talk to a person|speak to a person|talk to someone|a person|a human|a team member|the team)";
const ACCEPTANCE = new RegExp(
  `^(?:${AFFIRMATIVE}(?:[ ,.!]+${FILLER})*|please do(?: that)?|go ahead|do it|sounds good|that would be (?:great|good|helpful)|i would like that|i'd like that|connect me(?: please)?)$`,
);

export function isAcceptance(message: string): boolean {
  const text = normalize(message).replace(/[.!]+$/g, "");
  return text.length > 0 && text.length <= 60 && ACCEPTANCE.test(text);
}

/** Said by the system when it hands the conversation to a person because the visitor asked. */
export const HANDOFF_ACKNOWLEDGEMENT =
  "Okay, I've asked our support team to join this conversation. Someone will reply here as soon as possible.";

/** Appended to an unanswerable reply that does not already offer a person, so the offer is explicit. */
export const HANDOFF_OFFER_SENTENCE = "If you'd like, I can connect you with our support team.";

/** True when the text already offers or mentions a person (no need to add the offer sentence). */
export function mentionsPerson(text: string): boolean {
  return /\b(person|human|team member|support team|our team|the team|agent|colleague)\b/i.test(
    text,
  );
}
