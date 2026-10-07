# AI tools, authorization and human approval

> The model may **request** an action, but only deterministic application code can **authorize** and
> **execute** it.

Phase 5 lets the AI agent request a small, fixed set of tools while it prepares a draft. The model
never executes anything and never decides who may do what.

```text
AI (Gemini)  --function call-->  Tool runner (application code)
                                   1. known tool?              -> else UNKNOWN_TOOL
                                   2. strict Zod input?        -> else VALIDATION_ERROR
                                   3. caller's RBAC permission? -> else FORBIDDEN (audited)
                                   4. risk policy
                                        LOW    -> execute now (audited)
                                        MEDIUM/HIGH -> pending approval (nothing executes)
                                                          |
                          human clicks Approve / Reject    v
                                   re-authorize -> claim atomically -> execute -> audit
```

## Where it plugs in

`POST /api/conversations/:id/ai-draft` ([ai-agent.md](ai-agent.md)) runs the conversation policy first
(small talk, off-topic and obvious injection never reach tools). For support questions it then runs a
**tool pass** (`src/server/ai/tools/loop.ts`) before the normal RAG draft:

1. The model gets the conversation (as untrusted data), the trusted ids it may use, and the tool
   declarations. It may request tools.
2. Each request goes through `runTool`. Read results are returned to the model; changes become pending
   approvals and the model is told they have **not** been applied.
3. At most **5 tool calls** run per request (`MAX_TOOL_CALLS`); the loop then stops.
4. The existing RAG draft is generated as before. Tool results (and the "awaiting approval" notes) are
   added to its prompt in a delimited `<tool_results>` data section (prompt `AI_SUPPORT_AGENT_V3`).

If the tool pass itself fails (provider error) it is skipped and the draft continues without tool
results. Set `AI_TOOLS_ENABLED=false` to turn the tool pass off entirely (knowledge-only drafts).

The human flow of Phase 4.9 is unchanged: the suggested reply is an editable draft that is only sent
when a person sends it. Tools are an additional capability, not an autonomous agent.

## Answers from the customer's own record

Draft validation requires a cited knowledge source for company facts. Facts about the customer's own
record (name, company, email, ...) come from `<customer_profile>` and `<tool_results>`, which the
application filled from its database, so the draft schema has `usedAccountData`. A reply is kept when
it cites knowledge **or** the model reports `usedAccountData: true`; the draft then carries
`accountData: true` and the UI says "Based on: customer record". An answer with neither is still
replaced by the safe fallback, so a model cannot assert policies without a source. Limitation: the flag
is the model's own report; policy claims are still only trustworthy when they cite a source.

## Verifying against real Gemini

`npm run ai:tools-smoke` (development tool, never run by tests) sends real function-calling requests
with the real tool declarations through the real loop and adapter, using in-memory stubs and no
database, and prints which tools Gemini requested for five sample messages.

## Tool registry

`src/server/ai/tools/registry.ts`. Every tool defines `name`, `description`, a strict Zod
`inputSchema`, `riskLevel`, `requiredPermission` and `execute()`; mutating tools also define
`preview()`.

| Tool                       | Risk   | Permission (existing RBAC) | Behaviour                                                                 |
| -------------------------- | ------ | -------------------------- | ------------------------------------------------------------------------- |
| `getCustomer`              | LOW    | `view_customers`           | Explicit shape: id, name, email, phone, company, job title, status, tags. |
| `getConversation`          | LOW    | `view_conversations`       | Status, priority, customer, assignee, last 10 customer-facing messages.   |
| `searchKnowledge`          | LOW    | `view_knowledge`           | Reuses the single retrieval service: this organization, published only.   |
| `updateCustomer`           | MEDIUM | `update_customers`         | Explicit fields only; normalized by the same schema as the customer API.  |
| `changeConversationStatus` | MEDIUM | `update_conversations`     | Calls the existing `updateConversation` (transition rules, audit event).  |

Tools call the existing **services** with the caller's `OrganizationContext`; there is no second
authorization system. Services re-check permissions and tenant scope, so a tool can never do more than
the person on whose behalf it runs.

## The authorization boundary

- **Tenant and user come from the session.** `ToolExecutionContext` = `requireOrganizationContext()`
  result + the conversation the AI was invoked from. Tool inputs are `.strict()` schemas without
  organization, user, role or permission fields, so a model that invents `organizationId`, `allow` or
  `approved` gets `VALIDATION_ERROR`.
- **Cross-tenant ids look like "not found."** `NOT_FOUND` has the same message for missing and foreign
  records, so existence is not revealed.
- **Internal notes never reach the AI** (not even through `getConversation` for a staff member).
- **Prompt injection cannot grant anything.** The model can be talked into _requesting_ a tool; the
  runner still applies validation, RBAC, tenant scope and the risk policy. Pattern filtering in the
  conversation policy is an extra layer, not the protection.
- **Button visibility is not security.** Every approval endpoint independently verifies authentication,
  organization membership, the tool's permission, tenant ownership of the approval, its status and its
  expiry.

## Risk policy

Defined per tool by the application (`LOW`, `MEDIUM`, `HIGH`). `LOW` executes immediately. Anything
else requires a human approval; there is no model-controlled override. Today both mutating tools are
`MEDIUM`.

## Approval lifecycle

`ai_action_approvals` stores the **validated tool input** and a **preview** (what the approver sees,
built by the application from current data), never prompts or reasoning.

```text
PENDING --approve--> APPROVED --> EXECUTED
   |                      \-----> FAILED   (not retried automatically)
   |--reject--> REJECTED
   \--expires--> EXPIRED
```

- **Expiry:** `expiresAt` = request time + 15 minutes. An expired approval is marked `EXPIRED` and can
  never execute.
- **Atomic claim:** approve is a guarded `UPDATE ... WHERE status = 'PENDING' AND expiresAt > now`;
  concurrent clicks cannot both win, so a mutation runs at most once.
- **Terminal states are final:** `EXECUTED`, `FAILED`, `REJECTED` and `EXPIRED` never change again.
  CHECK constraints reject impossible combinations (e.g. `EXECUTED` without `executedAt`).
- **Executed as the approver:** execution uses the approver's context, so the services re-check that
  person's permissions and attribute the change (activity/event actor) to them. The approver must hold
  the tool's permission; the requester or a permitted member may reject.
- **De-duplication:** requesting the identical change again returns the existing pending approval;
  at most 10 pending approvals per conversation.
- The stored input is re-validated before execution.

## Audit

`ai_tool_audits`: one row per tool attempt: organization, conversation, actor, tool, risk level,
approval id, outcome (`SUCCESS`, `FAILURE`, `DENIED`, `APPROVAL_REQUESTED`) and a safe error code.
No inputs, results, prompts or customer data. Executed changes also appear in the usual places
(`STATUS_CHANGED` conversation events, `CUSTOMER_UPDATED` customer activities). Structured logs carry
ids and tool names only.

## Errors

Structured and safe: `UNKNOWN_TOOL`, `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`,
`APPROVAL_REQUIRED`, `APPROVAL_EXPIRED`, `EXECUTION_FAILED`, `TOOL_LIMIT_REACHED`. Unexpected errors
are logged in full on the server and replaced by a generic message; database errors never reach the
model or the UI.

## API

- `POST /api/conversations/:id/ai-draft` now also returns `approvals` (pending actions created by the
  request).
- `GET /api/conversations/:id/ai-approvals` - pending, unexpired actions of a conversation.
- `POST /api/ai-approvals/:id/approve` and `/reject` - no body; return `{ approval }`.

See [api.md](api.md).

## UI

`AiApprovalCards` (above the compose box) shows each pending action with the exact change
("Status: Open -> Resolved", "Company: Acme -> Acme Inc."), Approve and Reject, a loading state,
the server's refusal (expired, already handled, forbidden) and the final result. Approval is **not**
optimistic: the server executes and may refuse.

## Limitations

- Approvals are pending-only in the UI; there is no approvals history page.
- The preview is a snapshot: if the data changes before approval, execution re-validates and may end
  `FAILED` (nothing is retried).
- The tool pass is one extra model call per support draft (use `AI_TOOLS_ENABLED=false` to disable).
- One draft at a time per conversation is enforced in-process only.
- No tools beyond the five above; no autonomous background actions.
