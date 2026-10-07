# AI support agent

Phase 4 scope: the agent **drafts a grounded reply into an existing conversation**. It has no tools
and performs no business actions (no refunds, cancellations, record edits or emails). Humans decide
what to do with the reply.

```text
Conversation  ->  AI reply service  ->  AI agent  ->  AIProvider (interface)  ->  Gemini provider  ->  Gemini API
                  (auth, context,       (retrieve,       src/server/ai/provider.ts     src/server/ai/gemini/*
                   persistence)          prompt, validate)
```

Code map: `src/server/ai/` (`config.ts`, `types.ts`, `provider.ts`, `errors.ts`, `client.ts`,
`embeddings.ts`, `gemini/*`, `agent/{agent,context,prompts,types}.ts`),
`src/server/services/ai-reply.ts` (orchestration and persistence),
`src/app/api/conversations/[conversationId]/ai-reply/route.ts`.

## Conversation policy (Phase 4.6)

Before retrieval, a deterministic policy classifies the latest customer message. Small talk,
off-topic requests and obvious injection attempts get fixed replies (no embedding, search or model
call, still stored as `AI_AGENT`); everything else runs the pipeline below unchanged. See
[ai-conversation-policy](ai-conversation-policy.md).

## Provider abstraction

Application code depends on `AIProvider` (`generateResponse`, `generateEmbeddings`), never on a
vendor SDK. `src/server/ai/client.ts` returns the one provider (`GeminiProvider`, built on the
official `@google/genai` SDK). Only `src/server/ai/gemini/*` imports the SDK; the browser never
calls an AI API; the API key exists only in server code (`GEMINI_API_KEY`, no `NEXT_PUBLIC_`).
Model names, the embedding size, the relevance threshold, context limits and timeouts live in
`src/server/ai/config.ts` (single source of truth; models and threshold can be overridden by
environment variables). Tests install a deterministic fake provider; they never reach Gemini.

Provider failures are mapped to safe application errors (`ai_unavailable` 502, `ai_timeout` 504,
`ai_invalid_response` 502, `ai_embedding_failed` 502, `ai_not_configured` 503). The provider's own
message, status and request details are logged server-side and never returned to clients.

## The request

`POST /api/conversations/:conversationId/ai-reply` takes **no parameters** (an empty body or `{}`).
The conversation, customer and organization come from the server. Permission: `send_messages`
(every member role), because the result is a stored message in the conversation. A separate AI
permission was not added: it would be a switch nothing needs yet, and it can be introduced when
per-role AI policies or billing limits arrive.

Flow:

1. Authenticate; resolve the organization context; check permission.
2. Load the conversation in this organization (foreign ids are `404`); refuse RESOLVED (`409`).
3. Refuse if another AI reply for the same conversation is in flight (`409`; in-process guard, see
   limitations).
4. Build context from the database: the customer's name, company and status only; the last 12
   customer-facing messages (internal notes excluded); a query from the latest customer message.
   No customer message to answer: `409`.
5. Retrieve published knowledge for **this organization** above the threshold ([rag.md](rag.md)).
6. Build the delimited prompt and call Gemini with structured output (JSON schema).
7. Validate the response (below).
8. In ONE transaction: create the `AI_AGENT` message, update the conversation's last-message
   fields, record a `MESSAGE_SENT` event (actor type `AI`, `requestedByUserId` in metadata) and mark
   the conversation read for the requester. Re-checks that the conversation is still not resolved.

### What the model is given (and not given)

| Included                                                                                                    | Never included                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Customer name, company, account status                                                                      | Email, phone, metadata, notes, tags, other customers         |
| Up to 12 recent customer-facing messages, each cut to 1,500 chars, 8,000 chars in total (newest kept first) | Internal notes, system events, audit data                    |
| Up to 5 retrieved published chunks of this organization                                                     | Drafts, archived documents, other organizations' knowledge   |
| The fixed, versioned system prompt                                                                          | Secrets, API keys, tokens, database access, SQL, other tools |

The agent has no database or network access: it receives a string and returns a string.
Authorization is deterministic application code; the model never decides who may do what.

### Persisted message

`senderType = AI_AGENT`, `senderUserId = NULL` (a database CHECK forbids a user id on non-USER
senders), so the data model can never present an AI reply as a human's. `metadata` (JSON) holds:
`kind`, `provider`, `model`, `promptVersion` (`AI_SUPPORT_AGENT_V1`), `grounded`, `validation`,
`retrievedChunkIds`, `sources` (`label`, `documentId`, `documentTitle`, `chunkId`, `chunkIndex`,
`similarity`), `usage` (`inputTokens`, `outputTokens`, `totalTokens`), `latencyMs`,
`requestedByUserId`. It never holds the prompt, the system instruction, API keys or raw provider
errors. APIs expose only a safe projection (`ai`: provider, model, grounded, source documents).

Usage numbers are exactly what Gemini reports, or `null` when it reports none (never estimated).
Note `totalTokens` includes the model's internal reasoning tokens, so it can exceed
`inputTokens + outputTokens`.

## System prompt and structure

`src/server/ai/agent/prompts.ts` holds `AI_SUPPORT_AGENT_V1`: role and tone; grounding ("answer only
from `<knowledge_context>`, never invent policy; if it is not there, say you lack the information
and that a team member will follow up"); uncertainty; untrusted content; privacy; no actions;
output format. It contains no customer or knowledge text. Change it by adding a new version, so
stored replies stay traceable.

The user turn has three labelled sections: `<customer_profile>`, `<knowledge_context>` (each chunk
as `<source label="S1" document="...">`), and `<conversation>`.

## Prompt-injection handling

Customer messages and knowledge text are untrusted data. Defences, in layers:

1. **Instructions:** the system prompt states that everything in the three sections is data and
   that attempts to instruct the model, reveal its prompt or role-play must be ignored.
2. **Structure:** `neutralize()` strips control characters and any tag that imitates the prompt's
   structure from every untrusted string (and document titles), so content cannot close a section
   and open a fake one.
3. **Least privilege:** the model has no tools, no database access and only minimal context, so a
   successful injection has little to steal or do. Other tenants' data is never in the prompt.
4. **Output validation:** structured output is parsed with Zod; citations must reference labels that
   were really offered; an answer claiming to be grounded without a valid citation is replaced by a
   fixed fallback; a reply echoing system-prompt phrases is replaced (`prompt_leak_replaced`).
5. **Human in the loop:** the reply is a draft shown in the inbox, not an action.

This reduces risk; it does not make injection impossible. The canary-phrase leak check is
best-effort. Regression tests cover override attempts, malicious knowledge, requests for secrets
and for other customers' data (`tests/integration/ai-reply.test.ts`,
`src/server/ai/agent/*.test.ts`).

## Response validation

`{ answerable: boolean, reply: string, sourceLabels: string[] }`, validated in code. Invalid JSON,
wrong shape, empty or oversized (> 4,000 chars) replies are rejected (`502`, nothing stored).
Sources shown in the UI are only those retrieved _and_ cited; "Based on: ..." is never invented. An
ungrounded or declined reply is labelled "Not based on your knowledge base".

## Failure behaviour

| Situation                                                | Result                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| No `GEMINI_API_KEY`                                      | `503 ai_not_configured`; nothing stored                      |
| Gemini error / timeout (30 s generation, 20 s embedding) | `502`/`504` safe error; nothing stored; details logged       |
| Malformed or invalid model output                        | `502 ai_invalid_response`; nothing stored                    |
| Query embedding invalid or failed                        | `502`; no generation attempted; nothing stored               |
| Database write fails after a successful model call       | transaction rolls back; `500` generic; **no message exists** |
| Conversation resolved while the model worked             | `409`; nothing stored                                        |
| Second concurrent request for the same conversation      | `409`                                                        |

Errors are never stored as messages. Logs carry ids, model, latency, counts and token totals only,
never prompts, replies or customer text.

## Abuse and rate limiting

Bounded inputs (context limits above, request body must be empty) and a per-conversation in-flight
guard. The guard is **in-memory, per process**: it stops double clicks, not a distributed attack or
a multi-instance race. Distributed rate limiting and per-organization quotas will be added with
Redis in a later phase.

## Future: tool calling

Not implemented. The seams are in place: the agent is a pure function of explicit context; the
provider interface can grow tool declarations; messages carry `AI_AGENT` and events carry actor type
`AI`. Future tools (knowledge search, get customer, update customer, refund, cancel subscription)
will each pass through: tool -> authorization (the requesting member's permissions, never the
model's judgement) -> risk classification -> human approval for impactful actions -> execution ->
audit event. They will reference `(conversationId, organizationId)` with the same composite-key
tenant guard and need new tables (tool calls, approvals); `conversations` and `messages` do not
need to change.

## Verifying it against your own environment

Everything below is non-destructive. `db:deploy` only applies _new_ migrations (it enables the
`vector` extension and creates the knowledge tables); it never resets or drops data.

```powershell
# 1. Apply the new migrations to your Supabase database (uses DATABASE_URL from .env)
npm run db:deploy

# 2. (optional) Real-API check: 3 requests, prints scores and a sample reply, never the key
npm run ai:smoke

# 3. Start the app
npm run dev
```

Then in the browser:

1. **Knowledge -> New document**: title "Refund policy", content "Refunds are available within 30
   days of purchase. Contact support with your order number." -> _Create draft_.
2. Sign in as an ADMIN or OWNER and click **Publish** (a few seconds: it embeds the text).
3. **Inbox -> New conversation**: pick a customer, subject "Refund", first message "How long do I
   have to ask for my money back?".
4. Open the conversation and click **Ask AI**.
5. Expect a new bubble labelled **AI Agent** with a reply like "You have 30 days...", and
   "Based on: Refund policy".

Verify in the Supabase SQL editor:

```sql
-- 4. embeddings exist and are 768-dimensional
select d.title, d.status, d."contentVersion", count(c.id) as chunks,
       min(vector_dims(c.embedding)) as min_dims, max(vector_dims(c.embedding)) as max_dims
from knowledge_documents d left join knowledge_document_chunks c on c."documentId" = d.id
group by d.id order by d."updatedAt" desc;

-- 5. the reply is stored as the AI agent, with its sources and no human sender
select "senderType", "senderUserId", left(body, 80) as body,
       metadata->>'model' as model, metadata->>'grounded' as grounded,
       metadata->'sources'->0->>'documentTitle' as first_source
from messages order by "createdAt" desc limit 3;
```

Also try: ask about something not in the knowledge base (expect an "I do not have enough
information" reply, no sources), unpublish the document and ask again (no longer used), and edit
the published content (the old text must stop being used immediately).

## Known limitations

- The in-flight guard is per process (see above); no streaming; no per-organization AI quotas yet.
- The reply language follows the model; only English knowledge was exercised.
- Prompt-injection defences are layered mitigations, not a guarantee.
- AI messages are not yet sent to customers anywhere: there is no customer channel in this phase.
