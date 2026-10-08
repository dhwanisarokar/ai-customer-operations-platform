# 010 - Deterministic automation rules, not LLM decisions

Status: accepted

## Context

Phase 6 lets organizations run actions automatically when something happens (tag, assign, change
status or priority, add a note). The platform also has an AI agent (Phases 4-5), so it is tempting to let
a model decide when to act. Automations change shared data without a human in the loop, repeatedly and
at volume.

## Decision

Automations are **data evaluated by deterministic code**: `WHEN <event> AND <conditions> THEN <actions>`.

- Matching is plain comparison (`equals`, `contains`, `exists`...) over minimal event data. No model is
  called to decide whether a rule matches or what it does.
- Actions are a small typed registry that calls the existing services, so RBAC, tenant isolation and
  business rules are the same as for a person.
- The AI keeps its separate role: drafting replies and _requesting_ tools that a human approves
  (ADR 009). It cannot create, change or trigger automations and is not on the execution path.
- Execution is asynchronous (BullMQ/Redis) but the **database is the source of truth**: the queue only
  carries an execution id; idempotency is a unique key in PostgreSQL; the run is claimed with one atomic
  update.
- The creator's permissions are re-checked on every run (no standing privilege).

## Why not an LLM in the loop

- **Predictability and audit:** the same event must always produce the same result, and the history must
  explain why ("priority equals URGENT: passed").
- **Safety:** model output cannot be trusted with authorization or unattended mutation, and customer
  text is untrusted input (prompt injection).
- **Cost, latency and reliability:** a model call per event adds spend, delay and a failure mode to a
  path that must be cheap and repeatable.
- **Testability:** rules are unit-testable without a provider.

An LLM may later _suggest_ an automation for a human to review, or a registered action may call a model
for content, but matching and execution stay deterministic.

## Consequences

- Good: explainable runs, deterministic tests, no new trust boundary.
- Good: new triggers/actions are catalog entries; the engine is unchanged.
- Cost: expressiveness is limited to what the catalog offers (AND conditions, a linear action list).
- Cost: Redis and a worker process are now operational dependencies for automation execution.
