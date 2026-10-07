import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A styled native <select>. Used where a plain GET form (no JavaScript) must work, such as list
 * filters; richer pickers use the shadcn Select.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "border-input bg-background h-9 w-full rounded-lg border px-2.5 text-sm outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
