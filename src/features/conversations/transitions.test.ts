import { describe, expect, it } from "vitest";
import type { ConversationStatus } from "./schemas";
import { allowedTransitions, canTransition, PREVIEW_LENGTH, previewOf } from "./transitions";

describe("status transitions", () => {
  it.each([
    ["OPEN", "PENDING", true],
    ["OPEN", "RESOLVED", true],
    ["PENDING", "OPEN", true],
    ["PENDING", "RESOLVED", true],
    ["RESOLVED", "OPEN", true],
    ["RESOLVED", "PENDING", false],
    ["OPEN", "OPEN", false],
  ] as const)("%s -> %s is %s", (from, to, allowed) => {
    expect(canTransition(from as ConversationStatus, to as ConversationStatus)).toBe(allowed);
  });

  it("exposes the allowed targets for building UI controls", () => {
    expect(allowedTransitions("RESOLVED")).toEqual(["OPEN"]);
    expect(allowedTransitions("OPEN")).toEqual(["PENDING", "RESOLVED"]);
  });
});

describe("previewOf", () => {
  it("flattens whitespace and truncates long text", () => {
    expect(previewOf("  Hello\n\n  world ")).toBe("Hello world");
    const long = previewOf("x".repeat(500));
    expect(long).toHaveLength(PREVIEW_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});
