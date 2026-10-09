"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApiError } from "@/lib/api-client";
import type { useWidgetSession } from "../hooks/use-widget-session";
import { widgetQueryKeys, type ConversationResponse } from "../types";
import { Composer } from "./composer";
import { MessageBubble } from "./message-bubble";

type Api = ReturnType<typeof useWidgetSession>["api"];

/**
 * NEW_CONVERSATION: the only screen with "Start chat". Creating the chat sends the first message and
 * opens the conversation.
 */
export function NewConversationView({
  api,
  welcome,
  onCreated,
}: {
  api: Api;
  welcome: string;
  onCreated: (conversationId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  // One id per attempt: retrying after a failure reuses it, so the server never creates two chats.
  const [clientMessageId, setClientMessageId] = useState(() => crypto.randomUUID());

  const create = useMutation({
    mutationFn: (body: string) =>
      api<ConversationResponse>("/api/widget/conversations", {
        method: "POST",
        body: { body, clientMessageId },
      }),
    onSuccess: (data) => {
      setText("");
      setClientMessageId(crypto.randomUUID());
      queryClient.setQueryData(widgetQueryKeys.conversation(data.conversation.id), data);
      void queryClient.invalidateQueries({ queryKey: widgetQueryKeys.conversations });
      onCreated(data.conversation.id);
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <MessageBubble from="team" body={welcome} />
      </div>
      <Composer
        value={text}
        onChange={setText}
        onSubmit={() => create.mutate(text.trim())}
        submitLabel={create.isError ? "Retry" : "Start chat"}
        busy={create.isPending}
      >
        {create.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {create.error instanceof ApiError && create.error.status === 429
                ? "You are sending too fast. Please wait a moment."
                : "Your message was not sent. Try again."}
            </AlertDescription>
          </Alert>
        ) : null}
      </Composer>
    </div>
  );
}
