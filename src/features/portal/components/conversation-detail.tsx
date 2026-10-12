"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/api-client";
import { useOutbox } from "@/lib/query/outbox";
import { MessageBubble, ThinkingBubble } from "@/features/widget/components/message-bubble";
import { portalApi } from "../api";
import { usePortalConversation, useRequestHuman } from "../hooks";
import { usePortalInfo } from "../portal-context";
import { MAX_PORTAL_MESSAGE_LENGTH } from "../schemas";
import { ASSISTANT_PATIENCE_MS, type PortalMessage, type SendInput } from "../types";
import { ErrorPanel, LoadingRows } from "./portal-states";

const STATUS_LABEL = { OPEN: "Open", PENDING: "Pending", RESOLVED: "Resolved" } as const;

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

type HandoffState = "available" | "requested" | "taken_over";

/**
 * "Talk to a person", in ONE place (below the messages): available (the link), requested (a
 * non-interactive status) or taken over by a person (nothing). The state comes from the server.
 */
function HandoffControl({
  state,
  pending,
  onRequest,
}: {
  state: HandoffState;
  pending: boolean;
  onRequest: () => void;
}) {
  if (state === "taken_over") return null;
  if (state === "requested") {
    return (
      <span role="status" className="text-muted-foreground text-sm">
        A support agent has been requested.
      </span>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={onRequest} disabled={pending}>
      Talk to a person
    </Button>
  );
}

/**
 * One conversation: the customer-visible history (customer, AI and support messages, clearly
 * distinguished), the status, the handoff state and a composer. Messages the customer just sent stay
 * visible (sending / failed with Retry) until the server returns them; retries reuse the same
 * clientMessageId, so they never duplicate.
 */
export function ConversationDetail({ conversationId }: { conversationId: string }) {
  const { slug, live } = usePortalInfo();
  const query = usePortalConversation(conversationId, live);
  const handoff = useRequestHuman(conversationId);

  const submit = useCallback(
    (input: SendInput) =>
      fetchJson<{ message: PortalMessage }>(
        portalApi(slug, `/conversations/${conversationId}/messages`),
        { method: "POST", body: input },
      ),
    [slug, conversationId],
  );
  const confirmed = useCallback((result: { message: PortalMessage }) => result.message.id, []);
  const outbox = useOutbox(submit, confirmed);

  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const serverMessages = useMemo(() => query.data?.messages ?? [], [query.data]);
  const known = new Set(serverMessages.map((m) => m.clientMessageId).filter(Boolean));
  const pending = outbox.items.filter((item) => !known.has(item.input.clientMessageId));

  const conversation = query.data?.conversation;
  const assistant = conversation?.assistant ?? "none";
  const handoffState: HandoffState =
    conversation?.humanRequested || handoff.isSuccess
      ? "requested"
      : assistant === "human"
        ? "taken_over"
        : "available";

  const lastPending = pending.at(-1);
  const lastServer = serverMessages.at(-1);
  const waitingSince =
    lastPending && lastPending.status !== "failed"
      ? lastPending.createdAt
      : !lastPending && lastServer?.from === "visitor"
        ? Date.parse(lastServer.createdAt)
        : null;
  const waiting = assistant === "ai" && waitingSince !== null;
  const now = useNow(waiting);
  const slow = waiting && now - (waitingSince ?? now) > ASSISTANT_PATIENCE_MS;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [serverMessages.length, pending.length, waiting]);

  if (query.isPending) return <LoadingRows />;
  if (query.isError) return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/portal/${slug}/conversations`} className="text-primary text-sm underline">
            &larr; All conversations
          </Link>
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {conversation?.subject}
          </h1>
        </div>
        {conversation ? (
          <Badge variant={conversation.status === "RESOLVED" ? "outline" : "secondary"}>
            {STATUS_LABEL[conversation.status]}
          </Badge>
        ) : null}
      </div>

      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="border-border bg-card flex max-h-[60vh] min-h-48 flex-col gap-3 overflow-y-auto rounded-xl border p-4"
      >
        {serverMessages.map((message) => (
          <MessageBubble
            key={message.id}
            from={message.from}
            body={message.body}
            author={message.authorName}
          />
        ))}
        {pending.map((item) => (
          <MessageBubble
            key={item.clientId}
            from="visitor"
            body={item.input.body}
            status={item.status}
            onRetry={() => void outbox.retry(item.clientId)}
            onDiscard={() => outbox.discard(item.clientId)}
          />
        ))}
        {waiting && !slow ? <ThinkingBubble /> : null}
        {slow ? (
          <p role="status" className="text-muted-foreground text-center text-xs">
            This is taking longer than usual. You can also talk to a person.
          </p>
        ) : null}
        {conversation?.status === "RESOLVED" ? (
          <p className="text-muted-foreground text-center text-xs">
            This conversation was marked resolved. Send a message to reopen it.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <HandoffControl
          state={handoffState}
          pending={handoff.isPending}
          onRequest={() => handoff.mutate()}
        />
        {handoff.isError ? (
          <span className="text-destructive text-sm">Could not reach support. Try again.</span>
        ) : null}
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const body = text.trim();
          if (!body) return;
          setText("");
          void outbox.send({ body, clientMessageId: crypto.randomUUID() });
        }}
      >
        <Textarea
          aria-label="Your message"
          placeholder="Type your message…"
          value={text}
          maxLength={MAX_PORTAL_MESSAGE_LENGTH}
          rows={2}
          className="min-w-0 flex-1 resize-none"
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" disabled={!text.trim()} className="shrink-0">
          Send
        </Button>
      </form>
      {outbox.items.some((item) => item.status === "failed") ? (
        <Alert variant="destructive">
          <AlertDescription>
            A message could not be sent. Use Retry on the message.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
