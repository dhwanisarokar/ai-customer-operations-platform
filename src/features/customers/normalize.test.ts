import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  emptyToNull,
  normalizeEmail,
  normalizePhone,
  normalizeTagName,
} from "./normalize";

describe("normalizeEmail", () => {
  it("lowercases and trims so casing never creates duplicates", () => {
    expect(normalizeEmail("  USER@Example.COM ")).toBe("user@example.com");
  });
});

describe("normalizePhone", () => {
  it.each([
    ["+1 (555) 010-9999", "+15550109999"],
    ["555.010.9999", "5550109999"],
    ["+44 20 7946 0958", "+442079460958"],
    ["  07946 000000 ", "07946000000"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["abc", "12", "+1234567890123456", "555-CALL-NOW", "1+2345678", ""])(
    "rejects %s",
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe("text helpers", () => {
  it("turns blank input into null", () => {
    expect(emptyToNull("   ")).toBeNull();
    expect(emptyToNull(undefined)).toBeNull();
    expect(emptyToNull(" Acme ")).toBe("Acme");
  });

  it("normalizes tag names case-insensitively and collapses whitespace", () => {
    expect(normalizeTagName("  High   Value ")).toEqual({
      name: "High Value",
      normalizedName: "high value",
    });
    expect(collapseWhitespace("a \n b")).toBe("a b");
  });
});
