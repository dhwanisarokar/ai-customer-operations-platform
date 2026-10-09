"use client";

import { Button } from "@/components/ui/button";
import { conversationTitle, repeatsTitle } from "../title";
import type { ConversationsResponse } from "../types";
import { MessageBubble } from "./message-bubble";

const FROM_PREFIX = { visitor: "You: ", ai: "AI: ", team: "" } as const;

/**
 * WELCOME: the intro and the visitor's previous chats. Shown when they have chats but none is open
 * (all resolved, or they went back). Starting a new chat is an explicit action: this screen never
 * says "Start chat" itself.
 */
export function WelcomeView({
  welcome,
  conversations,
  onOpen,
  onNew,
}: {
  welcome: string;
  conversations: ConversationsResponse["conversations"];
  onOpen: (conversationId: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <MessageBubble from="team" body={welcome} />
        {conversations.length > 0 ? (
          <section aria-label="Your chats" className="space-y-2">
            <h2 className="text-muted-foreground text-xs font-medium uppercase">Your chats</h2>
            <ul className="divide-border border-border bg-card divide-y rounded-lg border">
              {conversations.map((conversation) => {
                const title = conversationTitle(conversation.subject);
                const preview = conversation.lastMessagePreview;
                const showPreview = preview !== null && !repeatsTitle(title, preview);
                const from = conversation.lastMessageFrom;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(conversation.id)}
                      className="hover:bg-muted/60 flex w-full flex-col gap-0.5 px-3 py-2 text-left"
                    >
                      <span className="truncate text-sm font-medium">{title}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {conversation.status === "RESOLVED" ? "Resolved" : null}
                        {conversation.status === "RESOLVED" && showPreview ? " · " : null}
                        {showPreview ? `${from ? FROM_PREFIX[from] : ""}${preview}` : null}
                        {!showPreview && conversation.status !== "RESOLVED" ? "Open" : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="border-border bg-background shrink-0 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Button className="w-full" onClick={onNew}>
          New conversation
        </Button>
      </div>
    </div>
  );
}
