# 009 - AI tools with deterministic authorization and human approval

Status: accepted

## Context

Phase 5 lets the AI do more than draft text: look up customer and conversation data and propose
changes (update a customer, change a conversation's status). A model can be manipulated by customer
text (prompt injection), so it cannot be trusted with authorization or execution.

## Decision

**The model may request an action; only deterministic application code authorizes and executes it.**

- A small typed **tool registry** (five tools) with strict Zod inputs that contain no organization,
  user or permission fields. Tenant and user come from the authenticated session.
- Tools call the **existing services** with the caller's context, so the existing RBAC, tenant scoping
  and business rules apply. No second authorization system.
- A deterministic **risk policy**: read-only tools run immediately; mutating tools become **pending
  approvals** that a human approves or rejects.
- Approvals are stored (validated input + application-built preview), expire after 15 minutes, are
  claimed with an atomic guarded update (no double execution) and are immutable once terminal. They
  execute as the approver.
- Every tool attempt is audited (who, tool, risk, approval, outcome; no payloads).
- A **bounded** tool loop (5 calls) inside the existing draft endpoint, using Gemini function calling
  through the provider abstraction. The human-reviewed draft flow is unchanged.
- No agent framework, workflow engine, queue or background agent.

## Alternatives considered

- **Let the model execute with a permissions prompt:** rejected; prompt text is not an access control.
- **Auto-execute low-risk mutations:** deferred. Both mutating tools are MEDIUM; the policy can later
  allow specific LOW mutations without changing the architecture.
- **Combine tools and drafting in one structured-output call:** rejected for now; Gemini models differ
  in supporting function calling together with a response schema. A separate tool pass keeps the
  proven RAG draft path intact at the cost of one extra call (configurable).

## Consequences

- Good: a manipulated or buggy model cannot change data, cross tenants or escalate privileges.
- Good: reuse of services means new tools inherit validation, RBAC, events and activity logging.
- Cost: one extra model call per support draft (configurable), approvals live 15 minutes, and there is
  no approvals history UI yet.
