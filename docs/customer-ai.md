# Customer-facing AI replies (web chat)

The web chat widget can answer visitors automatically. This is a **separate path** from the internal
assistant: in the Inbox the AI still only drafts and a person reviews and sends
([ai-agent](ai-agent.md), Phase 4.9) and that is unchanged. Here the answer is sent to the visitor
without review, so the boundary is much stricter.

Off by default: an owner/admin turns it on in **Web chat -> Answer visitors automatically with AI**
(`widget_settings.aiRepliesEnabled`). It also needs a configured AI provider (`GEMINI_API_KEY`).

## Flow

```text
visitor message stored (POST /api/widget/...)           <- returns immediately
  -> scheduleCustomerAiReply: one job per message (job id = customer-ai-<messageId>)
  -> BullMQ queue (the same queue and worker as automations)
  -> processCustomerAiJob (npm run worker, or in-process without Redis)
       skip checks -> deterministic policy -> RAG over PUBLISHED knowledge -> Gemini (structured JSON)
       -> validation -> persist the reply as a normal message (sender AI_AGENT)
  -> message.created domain event, published AFTER the commit
  -> visitor SSE stream -> the widget refetches and shows the answer
```

The visitor's request never waits for the model. The widget shows "AI is thinking..." until the answer
arrives (it offers a person after 45 s).

## What the AI may and may not do

- **Read-only.** No tools, no approvals, no Phase 5 mutation tools. It cannot change the customer, the
  conversation (status, assignment), or anything else; it can only add its own reply.
- **Input boundary.** The model receives: customer-visible messages of this conversation (visitor, team,
  earlier AI answers; never internal notes, events, approvals or metadata) and published knowledge of
  this organization. It receives **no customer record**: a visitor's email is unverified, so the profile is
  never sent (`mode: "customer"`, prompt `CUSTOMER_AI_V1`).
- **Policy first** (same deterministic policy as the internal assistant): greetings/thanks, off-topic
  messages and prompt-injection attempts get fixed text with no embedding, search or model call.
- **Grounding.** Company facts must come from cited knowledge. An answer without a valid citation is
  replaced by the safe fallback: "I'm having trouble finding that information. Would you like to talk to a
  person?". A reply that echoes the instructions is replaced too.
- **Actions** ("cancel my order", "change my email") are never performed or promised: the model answers
  that a person must handle it. It cannot trigger a handoff itself (see below).

## Persistence and what the visitor sees

The answer is an ordinary `messages` row (`senderType = AI_AGENT`, `messageType = MESSAGE`) with
provenance in `metadata` (provider, model, prompt version, intent, grounded, sources, handoffSuggested).
Staff see it in the Inbox like any AI message. The visitor API returns only
`{ from: "ai", body, createdAt, handoffSuggested }`: never the model, tokens, prompt, source ids or
metadata. If the model fails, no fake answer is created; after the last attempt the visitor gets the safe
fallback above (an internal error is never shown).

## Exactly one reply per message

1. Queue level: job id = `customer-ai-<messageId>` (BullMQ and the in-process queue ignore a known id).
2. Database level: the reply is stored with client id `ai-reply-<messageId>`; the unique
   `(conversationId, clientMessageId)` index lets only one worker's insert win (the loser stores
   nothing and publishes nothing).
3. Before generating: skip if the reply exists, a newer visitor message exists (its job answers with the
   full context) or a person is handling the conversation. After generating: re-check "person took
   over" and discard the late answer.
4. A visitor retry (same `clientMessageId`) re-queues the job, which covers a crash between storing the
   message and queueing it; the checks above make it a no-op if the answer already exists.

Failure handling: an attempt that fails is retried by the queue; the job gives up after 2 attempts and
stores the safe fallback. If Redis is down the message is still stored and the visitor can ask for a
person (no reply is queued).

## Human handoff: only the visitor asks for a person

Three cases, decided by deterministic code (`src/server/ai/policy/handoff.ts`), never by the model:

| Case                                          | Example                                                 | Result                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit request in the visitor's own words   | "I want to talk to a person", "connect me with support" | Handoff: `humanRequestedAt` set once, `HUMAN_REQUESTED` event (actor CUSTOMER), a fixed acknowledgement, no model call. The Inbox shows "Wants a person".                                                                                   |
| The AI cannot answer from published knowledge | "can it be done earlier?"                               | An honest fallback that **offers** the support team ("I couldn't find ... If you'd like, I can connect you with our support team."). **No marker, no event**; the conversation stays in AI mode.                                            |
| The visitor accepts that offer                | "Yes, please connect me."                               | Handoff, as in the first row, but only when the message right before is an AI message whose `metadata.handoffSuggested` was set by the system when it made the offer, and the reply is a bare acceptance ("yes", "sure", "please do that"). |

An unrelated "yes" (no offer outstanding, the offer was followed by another question, or the AI's text merely
contained "would you like a person?" without the system flag) is an ordinary message. The widget's
"Talk to a person" button is unchanged. The model's output has no handoff field (an earlier version had
`needsHuman`; it made the assistant escalate whenever it lacked knowledge and was removed).

## Handling mode (AI | HUMAN)

`conversations.handlingMode` says whether automatic AI replies are allowed. It is a distinct concept from
status (OPEN / PENDING / RESOLVED), the assignee (who owns it), and `humanRequestedAt` (the visitor asked for a
person: a "waiting for a person" badge). Nothing is inferred from those fields.

| Event                                                                                                                 | Mode                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| New web chat, customer AI enabled for the organization (and a provider configured)                                    | `AI`                                                                                                                                   |
| New web chat, customer AI off; any staff-created conversation; existing conversations (migration default)             | `HUMAN`                                                                                                                                |
| Visitor asks for a person (button, explicit words, accepted offer)                                                    | `AI -> HUMAN` (+ `humanRequestedAt`)                                                                                                   |
| Agent claims / is assigned the conversation                                                                           | `AI -> HUMAN` (clears `humanRequestedAt`)                                                                                              |
| Agent sends a customer-facing reply                                                                                   | `AI -> HUMAN` (internal notes do not)                                                                                                  |
| Agent switches (ADMIN/OWNER, `change_handling_mode`)                                                                  | `HUMAN` always; `AI` only if customer AI is enabled for the organization and the conversation is a web chat; clears `humanRequestedAt` |
| Unassigning, status changes, a visitor message that reopens a resolved conversation, an AI fallback offering a person | unchanged                                                                                                                              |

Every change records a `HANDLING_MODE_CHANGED` event (from, to, reason, actor); the handoff history
(`HUMAN_REQUESTED` events) is never deleted. Switching modes sends no message: switching to AI only lets
_subsequent_ visitor messages be answered. A conversation taken over by a person stays `HUMAN` when the visitor
reopens it; a resolved conversation in `AI` mode is answered again once the visitor's message reopens it (never
while it is resolved).

### Enforcement (server side, three layers)

1. **Before queueing:** `scheduleCustomerAiReply` loads the conversation and queues nothing unless it is in
   `AI` mode, not resolved, and customer AI is enabled.
2. **When the job runs:** the worker re-reads the mode (and again after the model returned) and skips.
3. **When the reply is stored (the guarantee):** `persistMessage` for the AI actor first runs one
   `UPDATE conversations ... WHERE id AND organizationId AND handlingMode = 'AI' AND status <> 'RESOLVED'`
   in the same transaction. PostgreSQL takes the row lock and re-evaluates the predicate on the latest
   committed row: if a switch to HUMAN, an assignment or a resolve committed first, nothing matches and the
   reply is discarded; if the reply's transaction got the row first, the switch waits for it. So a reply can
   never be stored after a takeover has committed, whatever the queue or the model did (a test holds the row
   lock to prove it). The fixed handoff acknowledgement is the one AI message exempt from the gate (it
   announces the switch).

A mode change is a conditional update (`from -> to`), so concurrent identical changes record one event.
Duplicate or concurrent jobs still store one reply (job id + deterministic client message id).

## Cost guards

Per visitor session 10 AI replies/minute and per organization 300/hour (on top of the message rate
limits); beyond that no reply is queued.

## Limitations

- Answers are only as good as the published knowledge; there are no citations in the widget UI yet.
- No streaming: the answer appears when complete.
- A crash between storing the visitor message and queueing the job is only repaired when the visitor
  retries or sends another message.
- Rate-limited or disabled AI means the visitor gets no automatic answer (the widget then offers a
  person after the thinking timeout).
