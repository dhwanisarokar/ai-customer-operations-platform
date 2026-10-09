"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { useOutbox } from "@/lib/query/outbox";
import type { VisitorMessageDto } from "@/server/widget/visitor";
import type { useWidgetSession } from "../hooks/use-widget-session";
import {
  ASSISTANT_PATIENCE_MS,
  widgetQueryKeys,
  type ConversationResponse,
  type SendInput,
} from "../types";
import { Composer } from "./composer";
import { MessageBubble, ThinkingBubble } from "./message-bubble";

type Api = ReturnType<typeof useWidgetSession>["api"];

const POLL_WHEN_DISCONNECTED_MS = 8000;

/** A clock that ticks only while `active` (used to time out "AI is thinking"). */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * ACTIVE_CONVERSATION: the messages, the composer ("Send") and the ways to reach a person. Never says
 * "Start chat". Messages the visitor just sent stay visible (sending / failed with retry) until the
 * server returns them.
 */
export function ConversationView({
  conversationId,
  api,
  live,
}: {
  conversationId: string;
  api: Api;
  live: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: widgetQueryKeys.conversation(conversationId),
    queryFn: ({ signal }) =>
      api<ConversationResponse>(`/api/widget/conversations/${conversationId}`, { signal }),
    refetchInterval: live ? false : POLL_WHEN_DISCONNECTED_MS,
  });

  const submit = useCallback(
    (input: SendInput) =>
      api<{ message: VisitorMessageDto }>(`/api/widget/conversations/${conversationId}/messages`, {
        method: "POST",
        body: input,
      }),
    [api, conversationId],
  );
  const confirmed = useCallback((result: { message: VisitorMessageDto }) => result.message.id, []);
  const outbox = useOutbox(submit, confirmed);

  const handoff = useMutation({
    mutationFn: () =>
      api<{ humanRequested: boolean }>(`/api/widget/conversations/${conversationId}/handoff`, {
        method: "POST",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: widgetQueryKeys.conversation(conversationId) }),
  });

  const [text, setText] = useState("");
  const [identityOpen, setIdentityOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const serverMessages = useMemo(() => query.data?.messages ?? [], [query.data]);
  const known = new Set(serverMessages.map((m) => m.clientMessageId).filter(Boolean));
  // Messages the server has not returned yet (sending / failed / just accepted) stay visible.
  const pending = outbox.items.filter((item) => !known.has(item.input.clientMessageId));
  const humanRequested = query.data?.conversation.humanRequested ?? false;
  const assistant = query.data?.conversation.assistant ?? "none";

  // Is the assistant working on an answer? The last thing said was the visitor's, and it answers.
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

  // ONE owner of the handoff UI: the footer. The AI's text may offer a person, but the only thing
  // that can ask for one is this control (or the visitor's own words), and it never renders twice.
  const handoffState: HandoffState =
    humanRequested || handoff.isSuccess
      ? "requested"
      : assistant === "human"
        ? "taken_over"
        : "available";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
      >
        {query.isPending ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : query.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              We could not load this chat.{" "}
              <button type="button" className="underline" onClick={() => void query.refetch()}>
                Try again
              </button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
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
            {query.data?.conversation.status === "RESOLVED" ? (
              <p className="text-muted-foreground text-center text-xs">
                This chat was marked resolved. Send a message to reopen it.
              </p>
            ) : null}
          </>
        )}
      </div>

      <Composer
        value={text}
        onChange={setText}
        submitLabel="Send"
        onSubmit={() => {
          const body = text.trim();
          setText("");
          void outbox.send({ body, clientMessageId: crypto.randomUUID() });
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <HandoffControl
            state={handoffState}
            pending={handoff.isPending}
            onRequest={() => handoff.mutate()}
          />
          <button
            type="button"
            onClick={() => setIdentityOpen((open) => !open)}
            className="text-primary text-xs underline"
          >
            {identityOpen ? "Hide" : "Share your email"}
          </button>
          {handoff.isError ? (
            <span className="text-destructive text-xs">Could not reach the team. Try again.</span>
          ) : null}
        </div>
        {identityOpen ? <IdentityForm api={api} onDone={() => setIdentityOpen(false)} /> : null}
      </Composer>
    </div>
  );
}

type HandoffState = "available" | "requested" | "taken_over";

/**
 * "Talk to a person", in one place. available: the link; requested: a non-interactive status (the
 * request exists, the visitor cannot repeat it); taken_over: a person already handles the chat, so no
 * stale action is shown.
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
      <span role="status" className="text-muted-foreground text-xs">
        A support agent has been requested.
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onRequest}
      disabled={pending}
      className="text-primary text-xs underline disabled:opacity-50"
    >
      Talk to a person
    </button>
  );
}

function IdentityForm({ api, onDone }: { api: Api; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const identify = useMutation({
    mutationFn: () =>
      api("/api/widget/identity", {
        method: "POST",
        body: { ...(name.trim() ? { name: name.trim() } : {}), email: email.trim() },
      }),
    onSuccess: onDone,
  });
  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label="Your name"
        placeholder="Name (optional)"
        value={name}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label="Your email"
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      {identify.isError ? (
        <p className="text-destructive text-xs">
          {identify.error instanceof ApiError && identify.error.fieldErrors.email
            ? identify.error.fieldErrors.email
            : "Could not save your details."}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        disabled={!email.trim() || identify.isPending}
        onClick={() => identify.mutate()}
      >
        {identify.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
