import { describe, expect, it } from "vitest";
import {
  assertSafeHeaderValue,
  buildSupportAddress,
  checkLocalPart,
  isSafeHeaderValue,
  normalizeEmailAddress,
} from "./address";

describe("normalizeEmailAddress", () => {
  it("lowercases and trims a plain address", () => {
    expect(normalizeEmailAddress("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
  });

  it("does not strip plus tags or dots (those can be different mailboxes)", () => {
    expect(normalizeEmailAddress("a.b+tag@example.com")).toBe("a.b+tag@example.com");
  });

  it.each([
    "",
    "no-at-sign",
    "a@b",
    "two@@example.com",
    "Jane <jane@example.com>",
    "jane@example.com, bob@example.com",
    "jane@exa mple.com",
    "jane@example.com\r\nBcc: x@y.com",
    "@example.com",
    "jane@",
  ])("rejects %j", (raw) => {
    expect(normalizeEmailAddress(raw)).toBeNull();
  });

  it("rejects addresses longer than 254 characters", () => {
    expect(normalizeEmailAddress(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("checkLocalPart", () => {
  it("accepts and lowercases valid names", () => {
    expect(checkLocalPart("Support")).toEqual({ ok: true, value: "support" });
    expect(checkLocalPart("acme-help")).toEqual({ ok: true, value: "acme-help" });
    expect(checkLocalPart("a.b_c-d")).toEqual({ ok: true, value: "a.b_c-d" });
    expect(checkLocalPart("a")).toEqual({ ok: true, value: "a" });
  });

  it.each(["", "-a", "a-", ".a", "a.", "a b", "a@b", "ünï", "a/b", "a+b"])(
    "rejects %j as invalid",
    (raw) => {
      expect(checkLocalPart(raw)).toEqual({ ok: false, reason: "invalid" });
    },
  );

  it("rejects names longer than 32 characters", () => {
    expect(checkLocalPart("a".repeat(33))).toEqual({ ok: false, reason: "invalid" });
    expect(checkLocalPart("a".repeat(32)).ok).toBe(true);
  });

  it.each(["postmaster", "abuse", "noreply", "no-reply", "mailer-daemon", "admin", "root"])(
    "reserves %s",
    (raw) => {
      expect(checkLocalPart(raw)).toEqual({ ok: false, reason: "reserved" });
      expect(checkLocalPart(raw.toUpperCase())).toEqual({ ok: false, reason: "reserved" });
    },
  );
});

describe("buildSupportAddress", () => {
  it("joins a local part and a domain", () => {
    expect(buildSupportAddress("acme", "mail.example.com")).toBe("acme@mail.example.com");
  });

  it("refuses an invalid result", () => {
    expect(buildSupportAddress("acme", "not a domain")).toBeNull();
  });
});

describe("header safety", () => {
  it("accepts ordinary text", () => {
    expect(isSafeHeaderValue("Acme Support")).toBe(true);
    expect(assertSafeHeaderValue("From", "Acme Support")).toBe("Acme Support");
  });

  it.each(["a\r\nBcc: x@y.com", "a\nb", "a\rb", "a\u0000b", "a\u007fb", "a b", "a b"])(
    "rejects control characters and line separators (%j)",
    (value) => {
      expect(isSafeHeaderValue(value)).toBe(false);
      expect(() => assertSafeHeaderValue("Subject", value)).toThrow();
    },
  );
});
