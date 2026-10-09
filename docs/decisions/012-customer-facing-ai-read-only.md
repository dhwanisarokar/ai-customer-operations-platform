# 012 - Customer-facing AI is a separate, read-only path

Status: accepted

## Context

Phase 4.9 made the internal assistant draft-only (a person reviews and sends). Phase 7 added a public
web chat where visitors expect an immediate answer. Sending model output to an anonymous visitor without
review has a different risk profile: prompt injection by the visitor, hallucinated policy, and exposure of
internal or customer data.

## Decision

- Add an explicit **customer-facing path** and leave the internal draft workflow untouched. It is opt-in
  per organization (`widget_settings.aiRepliesEnabled`).
- **Read-only**: no tools and no Phase 5 mutation tools. The AI can only add its own reply; requests for
  actions end in a handoff to a person.
- **Smaller context boundary than the draft**: customer-visible messages and published knowledge only, and
  **no customer record** (a visitor's identity is unverified). A dedicated prompt (`CUSTOMER_AI_V1`) and
  output schema (`needsHuman`).
- **Reuse, not duplicate**: the same provider, embeddings, retrieval, deterministic conversation policy
  and grounding/leak validation as the internal assistant (`runSupportAgent` with `mode: "customer"`).
- **Asynchronous on the existing queue**: one job per visitor message on the BullMQ queue and worker that
  automations already use (a `kind: "customer-ai"` job, one dispatcher `processQueueJob`); no new queue.
- **Idempotent by construction**: job id from the message id, and the reply stored with a deterministic
  client message id under the existing unique constraint. PostgreSQL decides; the queue only delivers.
- **Persisted as a normal message** (`AI_AGENT`) and published after commit through the existing realtime
  path. Provenance stays in `metadata` for staff and never reaches the visitor API.
- **Only the visitor asks for a person**: handoff comes from the visitor's explicit words or acceptance of a
  system-recorded offer (deterministic code), never from the model or from a lack of knowledge.
- **Humans win**: the AI stops once a person is requested, assigned or has replied, and discards an
  answer that finishes after a takeover.

## Alternatives considered

- **Call the model inside the visitor's HTTP request:** simpler, but slow requests, no retries and a
  duplicate risk on client retries. Rejected.
- **A second queue / service:** more infrastructure for the same semantics. Rejected.
- **Give the customer AI the Phase 5 tools with approval:** the approval flow is for staff; exposing it to
  an anonymous visitor widens the attack surface. Rejected for the first version.
- **A new AI message table:** the existing `messages` model already has the author type, ordering,
  realtime and inbox rendering. Rejected.

## Consequences

- One more column (`aiRepliesEnabled`) and a queue job kind; the worker now also needs the AI provider.
- The model's cost is bounded by rate limits and the one-reply-per-message guarantee.
- The first version cannot do account-specific help; that needs verified identity first.
