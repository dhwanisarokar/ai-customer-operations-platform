# 013 - Explicit handling mode for customer-facing AI

Status: accepted

## Context

Customer-facing AI replies (ADR 012) were silenced by inference: a visitor request, an assignee, or any earlier
staff message. Agents could not switch the AI back on, the rules were scattered over several checks, and a reply
being generated could still be stored after a takeover.

## Decision

- Add `conversations.handlingMode` (`AI | HUMAN`), a field of its own, distinct from status, assignee and
  `humanRequestedAt`. New web chats start in `AI` only when customer AI is enabled for the organization;
  everything else (including all existing conversations) is `HUMAN`.
- The domain operations that mean "a person is handling this" switch it themselves, in their own transaction:
  the visitor's handoff, assignment/claim, and an agent's customer-facing reply. Unassigning never re-enables the
  AI. Agents with `change_handling_mode` (ADMIN, OWNER) can switch either way; AI only when eligible, and
  switching sends nothing.
- Enforce it at three points: before queueing, when the job runs, and atomically when the reply is stored (a
  conditional `UPDATE` that takes the row lock and checks `handlingMode = 'AI' AND status <> 'RESOLVED'`). The
  last one is the guarantee against races with takeovers; the others save work.
- Record `HANDLING_MODE_CHANGED` with the reason and actor; keep the handoff history.

## Alternatives considered

- **Keep inferring from assignee / humanRequestedAt / staff replies:** cannot express "an agent switched back to
  AI", and breaks when those fields change for other reasons. Rejected.
- **A new table or per-message flags:** a single column on the conversation is enough. Rejected.
- **Only the pre-checks (queue time and job time):** leaves a window where a late answer is stored after a
  takeover. Rejected; the atomic claim closes it.
- **Let every member change the mode:** deciding that an AI speaks to customers is organization-level; members can
  still take over by claiming or replying. Rejected for now.

## Consequences

- One additive migration (enum, column with default, enum value, a backfill that preserves current behavior).
- The visitor widget derives who is answering from the mode, so its "thinking" and handoff UI follow it.
- Re-enabling AI never sends anything; the next visitor message may be answered.
