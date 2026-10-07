"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { NativeSelect } from "@/components/shared/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, type FieldErrors } from "@/lib/api-client";
import { priorityLabel } from "../event-text";
import { CONVERSATION_PRIORITIES, createConversationSchema, MAX_MESSAGE_LENGTH } from "../schemas";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";

export function NewConversationForm({
  initialCustomer,
}: {
  initialCustomer: PickedCustomer | null;
}) {
  const router = useRouter();
  const [customer, setCustomer] = useState<PickedCustomer | null>(initialCustomer);
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<(typeof CONVERSATION_PRIORITIES)[number]>("NORMAL");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const payload = {
      customerId: customer?.id ?? "",
      subject,
      priority,
      ...(message.trim() ? { initialMessage: { body: message, from: "CUSTOMER" as const } } : {}),
    };
    // Same schema as the server so messages match.
    const parsed = createConversationSchema.safeParse(payload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "customerId" ? "customerId" : String(issue.path[0] ?? "");
        if (!next[key]) next[key] = key === "customerId" ? "Choose a customer" : issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await apiRequest<{ conversation: { id: string } }>("/api/conversations", {
      method: "POST",
      body: payload,
    });
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fieldErrors);
      setFormError(result.message);
      return;
    }
    startTransition(() => {
      router.push(`/dashboard/inbox?view=all&c=${result.data.conversation.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <CustomerPicker value={customer} onChange={setCustomer} error={errors.customerId} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="subject">Subject</Label>
        <Input
          id="subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          maxLength={200}
          placeholder="e.g. Billing question"
          aria-invalid={errors.subject ? true : undefined}
          aria-describedby={errors.subject ? "subject-error" : undefined}
        />
        {errors.subject ? (
          <p id="subject-error" role="alert" className="text-destructive text-sm">
            {errors.subject}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5 sm:w-48">
        <Label htmlFor="priority">Priority</Label>
        <NativeSelect
          id="priority"
          value={priority}
          onChange={(event) => setPriority(event.target.value as typeof priority)}
        >
          {CONVERSATION_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {priorityLabel(value)}
            </option>
          ))}
        </NativeSelect>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="first-message">Customer&apos;s first message (optional)</Label>
        <Textarea
          id="first-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={4}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="What did the customer write or say?"
          aria-describedby={errors["initialMessage.body"] ? "message-error" : undefined}
        />
        {errors["initialMessage.body"] ? (
          <p id="message-error" role="alert" className="text-destructive text-sm">
            {errors["initialMessage.body"]}
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Creating..." : "Create conversation"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
