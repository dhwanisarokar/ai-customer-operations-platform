"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { MAX_PORTAL_MESSAGE_LENGTH } from "../schemas";
import { useCreateConversation } from "../hooks";
import { usePortalInfo } from "../portal-context";
import { NotLinked } from "./portal-states";

export function NewConversationForm() {
  const { slug } = usePortalInfo();
  const router = useRouter();
  const create = useCreateConversation();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // One id per attempt: retrying after a failure reuses it, so the server never creates two conversations.
  const [clientMessageId, setClientMessageId] = useState(() => crypto.randomUUID());

  const error = create.error;
  if (error instanceof ApiError && error.code === "portal_not_linked") return <NotLinked />;
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.fieldErrors[name] : undefined;

  return (
    <form
      className="flex max-w-xl flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { subject: subject.trim(), body: body.trim(), clientMessageId },
          {
            onSuccess: (data) => {
              setClientMessageId(crypto.randomUUID());
              router.push(`/portal/${slug}/conversations/${data.conversation.id}`);
            },
          },
        );
      }}
    >
      <h1 className="text-2xl font-semibold tracking-tight">New support conversation</h1>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="portal-subject">Subject</Label>
        <Input
          id="portal-subject"
          value={subject}
          maxLength={120}
          onChange={(event) => setSubject(event.target.value)}
        />
        {fieldError("subject") ? (
          <p className="text-destructive text-sm">{fieldError("subject")}</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="portal-body">How can we help?</Label>
        <Textarea
          id="portal-body"
          rows={6}
          value={body}
          maxLength={MAX_PORTAL_MESSAGE_LENGTH}
          onChange={(event) => setBody(event.target.value)}
        />
        {fieldError("body") ? (
          <p className="text-destructive text-sm">{fieldError("body")}</p>
        ) : null}
      </div>
      {create.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof ApiError && error.status === 429
              ? "You are sending too fast. Please wait a moment."
              : "Your message was not sent. Try again."}
          </AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="submit"
        disabled={!subject.trim() || !body.trim() || create.isPending}
        className="self-start"
      >
        {create.isPending ? "Sending…" : create.isError ? "Retry" : "Send"}
      </Button>
    </form>
  );
}
