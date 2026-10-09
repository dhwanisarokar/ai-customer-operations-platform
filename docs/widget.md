# Web chat widget (Phase 7)

An embeddable chat for an organization's website. See also [customer-ai](customer-ai.md) for the optional automatic AI answers. Visitors message the team; the messages land in the
**existing inbox** as ordinary conversations (channel `WEB_CHAT`); agents reply with the **existing**
message flow. The internal assistant is unchanged (the AI only drafts, a human reviews). Visitors can additionally
get automatic, read-only AI answers when an organization opts in: [customer-ai](customer-ai.md).

## Install

1. As an owner/admin open **Web chat** (`/dashboard/widget`), set the name, welcome message and
   (optionally) allowed websites, enable the widget.
2. Paste the snippet shown there before `</body>`:

```html
<script src="https://YOUR-APP/widget.js" data-key="wk_..." async></script>
```

`public/widget.js` only draws a launcher and an iframe pointing at `/widget/{key}`. The chat and the
visitor session live **inside the iframe on the app's origin**; the host page never sees the token.
The session starts when the visitor first opens the chat, not on page load.

## Concepts

| Concept         | What it is                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Public key      | `wk_...`, stored in `widget_settings`. Public (it is in the snippet). Its only power is selecting an organization.       |
| Visitor session | A row in `visitor_sessions` (`vs_...` bearer token, only the SHA-256 hash is stored, 30 day sliding expiry, revocable).  |
| Visitor         | **Not** a Clerk user and **not** a membership. It has no role and no permissions; it can only use `/api/widget/*`.       |
| Placeholder     | An anonymous visitor gets a customer "Website visitor" (`source = web_chat`) when it first writes. Chosen by the server. |

The organization is **always derived on the server** (key → organization, token → session →
organization). `organizationId`, `customerId`, `senderId`, `visitorId` and similar are never accepted
from the client; the schemas are `strict()`, so sending them is a 400.

## Public API (`/api/widget/*`)

Errors use the normal envelope. Bodies are capped at 16 KB (413) and messages at 2000 characters.
Authenticated routes use `Authorization: Bearer <token>`.

| Endpoint                           | Purpose                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /session`                    | `{ key, embedOrigin? }` (+ optional bearer to resume). Returns `{ token \| null, session, widget }`. |
| `GET /conversations`               | The visitor's own conversations.                                                                     |
| `POST /conversations`              | `{ body, clientMessageId }` starts a chat (201; 200 when `clientMessageId` was already used).        |
| `GET /conversations/:id`           | Conversation + customer-facing messages. 404 unless this session owns it.                            |
| `POST /conversations/:id/messages` | `{ body, clientMessageId }`. Author is always the visitor. Idempotent.                               |
| `POST /conversations/:id/handoff`  | "Talk to a person" (no body).                                                                        |
| `POST /identity`                   | `{ name?, email? }`. The server resolves the customer.                                               |
| `GET /api/widget/events`           | Server-Sent Events for this session only (see [realtime](realtime.md)).                              |

Staff: `GET/PUT /api/widget-settings` (`manage_widget`: OWNER/ADMIN) and `GET /api/realtime/inbox`.

What a visitor sees is a dedicated DTO: `{ id, from: "visitor" | "team", body, createdAt,
clientMessageId, authorName }`. Internal notes, AI messages and drafts, tool/approval data, provenance,
metadata, assignees, emails and organization ids are never included.

## Identity resolution

- The visitor may share a name/email (`POST /identity`). The email is trimmed and lowercased.
- Within the organization only: if an active customer has that email, the visitor's conversations are
  **moved to that customer** and the unused placeholder is archived. An existing customer is **never
  edited** by a visitor (anyone can type any email). Archived customers are not linked.
- If no customer has the email, the session's own placeholder (created by the widget) is filled in.
  Two visitors with the same new email converge on one customer (no duplicates; unique `(organizationId, email)` on
  the already-normalized email).
- Customers of other organizations are unreachable (every query is org-scoped).

## Human handoff

`POST /handoff` sets `conversations.human_requested_at` (once), records a `HUMAN_REQUESTED` event
(actor type `CUSTOMER`) and publishes `conversation.updated`. The inbox shows a "Wants a person" badge
and a "Web chat" badge. When a person is assigned through the normal assign flow the marker is cleared.
No AI reply is generated.

## Reliability

- `clientMessageId` (UUID, unique per conversation) makes sends idempotent; a retry after a lost
  response never duplicates (a unique-violation race resolves to the existing message).
- The widget keeps an outbox: sending → sent, or failed with Retry/Discard (same id on retry).
- If the realtime stream is down the widget shows "Reconnecting…" and polls every 8 s; on reconnect it
  refetches everything.
- An expired session (401) is replaced transparently once.

## Limits and rate limiting

| Rule                              | Limit                         |
| --------------------------------- | ----------------------------- |
| New sessions per IP               | 20 / hour                     |
| Session resume per IP             | 300 / 10 min                  |
| New conversations per session     | 5 / hour (and 30 / hour / IP) |
| Messages per session              | 30 / minute (120 / min / IP)  |
| Identity updates per session      | 10 / hour                     |
| Handoff requests per session      | 10 / hour                     |
| Conversations per session (total) | 10                            |

Counters live in Redis when `REDIS_URL` is set (shared across instances), else in memory per process.
429 responses carry `Retry-After`. The IP comes from `x-forwarded-for` (see limitations).

## Threat model

| Threat                                    | Mitigation                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Impersonating staff / choosing the sender | Sender is derived from the session; body schemas are strict; visitor messages are `CUSTOMER`, type `MESSAGE`. |
| Reading someone else's conversation       | Every query filters by `(organizationId, visitorSessionId)`; mismatch is 404, same as non-existent.           |
| Cross-organization access                 | Organization comes from key/token; composite FKs; tests with two organizations.                               |
| Customer takeover via email               | Existing customers are linked but never modified; archived ones are not linked.                               |
| Leaking internal data                     | Dedicated DTO + repository `senderType IN (CUSTOMER, USER)` and `messageType = MESSAGE`.                      |
| Token theft from the host page            | Token lives only inside the iframe's origin; only its hash is stored; revocable; expires.                     |
| Spam / flooding / large payloads          | Rate limits, 16 KB body cap, 2000 char messages, conversation cap.                                            |
| Rogue sites embedding the widget          | Optional origin allowlist (a policy, not authentication: `embedOrigin` is client-reported).                   |
| Enumeration of keys                       | Unknown, disabled and wrong keys all answer 404.                                                              |
| Stored XSS via messages                   | Messages are rendered as text by React (no HTML), on both sides.                                              |
| Realtime eavesdropping                    | Channel derived from the authenticated identity, never client-supplied (see [realtime](realtime.md)).         |
| Sensitive data in logs                    | Pino logs ids and codes only; never tokens, keys, message bodies or emails.                                   |

## Automations

Visitor messages emit `message.created` (sender `CUSTOMER`) and new chats emit `conversation.created`
through the same domain events as staff actions, so existing automations see them. Loop prevention is
unchanged (events caused by an automation are ignored by the engine).

## Isolation from Clerk

The widget runs in visitors' browsers inside third-party iframes, where Clerk's development handshake
redirects forever ("redirected you too many times"). So it is kept completely outside Clerk:

- **Layouts:** `src/app/layout.tsx` (html/body, fonts, CSS) has no authentication. `ClerkProvider` lives in
  `src/app/(app)/layout.tsx`, the route group of the authenticated application (home, sign-in/up,
  dashboard). `/widget/[key]` is a sibling of `(app)`, so it never loads Clerk.
- **Middleware:** the matcher in `src/proxy.ts` excludes `/widget/` and `/api/widget/` (exact prefixes), so
  Clerk's middleware (and its handshake) never runs for them. `/api/widget-settings` (staff) and every
  other internal route are still matched and protected. `src/proxy.test.ts` pins both lists and checks that
  no widget code imports `@clerk/*`.
- Public does not mean open: the widget key, visitor session, ownership checks and rate limits still apply.

## Limitations

- The origin allowlist is a policy for honest embedders; it cannot stop a determined client from
  calling the API with a valid key.
- Rate limiting trusts `x-forwarded-for`; behind a proxy that does not set it all visitors share a bucket.
- No attachments, typing indicators, presence, read receipts for visitors or email notifications.
- No browser E2E tests are configured in this repository; the iframe loader (`public/widget.js`) was
  not exercised in a real browser by automated tests.
- Session revocation exists in the repository (`revoke`) but has no admin UI yet.

## Widget screens (UI)

The open widget has one local state, the view: `WELCOME` (intro and previous chats), `NEW_CONVERSATION`
(the only screen with "Start chat") and `ACTIVE_CONVERSATION` (messages and "Send"). With existing chats
the widget opens the most recent unresolved one; with only resolved chats it shows `WELCOME`; with none it
shows `NEW_CONVERSATION`. CLOSED is the launcher on the host page, which is hidden while the chat is open
(the chat header has its own close button). Server data stays in TanStack Query.

- Chat titles are derived from the first message ("can you tell me about refund policy?" -> "Refund
  policy", `src/features/widget/title.ts`); the list shows the last message as preview and never repeats the
  title. No database field.
- Messages look different per author: visitor (right, primary), AI (outlined, "AI assistant"), team
  (muted, "Name - Support team"). "AI is thinking..." shows while an answer is pending.
- The composer is a non-shrinking flex child below a scrolling history; the text area takes the remaining
  width and the button keeps its size, so they cannot overlap; it respects the mobile safe area.
- The round "N" some developers see over the composer is the **Next.js development indicator**
  (`<nextjs-portal>`), rendered inside the iframe in `next dev`. It is not part of the widget and does not
  exist in a production build.

## One handoff action

The "Talk to a person" control has a single owner, the footer above the composer, and three states:
available (the link), requested (non-interactive "A support agent has been requested."), and taken over by a
person (nothing). The AI's fallback text may offer help, but it is plain text. (Before, the link also rendered
under the last AI message flagged `handoffSuggested`, from a second code path; that flag now only lets a later
"yes" be read as accepting the offer.) The state comes from the server (`humanRequested`, `assistant`), so
reloads and realtime updates cannot produce a second action. "Share your email" is independent.
