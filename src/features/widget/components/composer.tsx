"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_WIDGET_MESSAGE_LENGTH } from "../schemas";

/**
 * The message box, anchored at the bottom of the widget (a flex child that never shrinks, so the
 * history above it scrolls on its own and nothing hides behind it). The text area takes the remaining
 * width (`min-w-0`) and the button keeps its size: they cannot overlap at any width.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  submitLabel,
  disabled = false,
  busy = false,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  disabled?: boolean;
  busy?: boolean;
  /** Extra controls shown above the box (errors, quick actions). */
  children?: React.ReactNode;
}) {
  const canSend = value.trim().length > 0 && !disabled && !busy;
  return (
    <form
      className="border-border bg-background flex shrink-0 flex-col gap-2 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
    >
      {children}
      <div className="flex items-end gap-2">
        <Textarea
          aria-label="Your message"
          placeholder="Type your message…"
          value={value}
          maxLength={MAX_WIDGET_MESSAGE_LENGTH}
          rows={1}
          className="max-h-32 min-h-10 min-w-0 flex-1 resize-none"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) onSubmit();
            }
          }}
        />
        <Button type="submit" className="shrink-0" disabled={!canSend}>
          {busy ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
