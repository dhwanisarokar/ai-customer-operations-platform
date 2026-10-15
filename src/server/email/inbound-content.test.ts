import { describe, expect, it } from "vitest";
import {
  cleanAttachments,
  cleanBody,
  cleanSubject,
  displayFirstName,
  EMPTY_BODY,
  EMPTY_SUBJECT,
  isSystemSender,
  rawSubject,
  validRfcId,
  validRfcIds,
} from "./inbound-content";

describe("cleanBody", () => {
  it("normalizes line endings and trims", () => {
    expect(cleanBody("  a\r\nb\rc  ")).toBe("a\nb\nc");
  });

  it("removes control characters but keeps tabs and newlines", () => {
    expect(cleanBody("a\u0000b\u0007c\td\ne f\u007fg")).toBe("abc\td\nefg");
  });

  it("collapses long runs of blank lines", () => {
    expect(cleanBody("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  it("uses a placeholder for an empty body", () => {
    expect(cleanBody("   \n ")).toBe(EMPTY_BODY);
    expect(cleanBody("\u0000\u0001")).toBe(EMPTY_BODY);
  });

  it("truncates to the message limit with a note and never exceeds it", () => {
    const out = cleanBody("x".repeat(50_000));
    expect(out.length).toBeLessThanOrEqual(10_000);
    expect(out.endsWith("[Message truncated]")).toBe(true);
  });

  it("does not leave half of an emoji when cutting", () => {
    const out = cleanBody("😀".repeat(9_990));
    expect(out).not.toMatch(/[\ud800-\udbff]\s*\n*\[Message truncated\]$/);
    expect(out.length).toBeLessThanOrEqual(10_000);
  });

  it("leaves markup as plain text", () => {
    expect(cleanBody("<b>hi</b> <script>x</script>")).toBe("<b>hi</b> <script>x</script>");
  });
});

describe("cleanSubject", () => {
  it.each([
    ["Re: Hello", "Hello"],
    ["RE: Re: FW: fwd: Hello", "Hello"],
    ["  Hello   world  ", "Hello world"],
    ["Hi\r\nBcc: x@y.test", "Hi Bcc: x@y.test"],
    ["Regarding my order", "Regarding my order"],
    ["Re:", EMPTY_SUBJECT],
    ["", EMPTY_SUBJECT],
  ])("%j -> %j", (input, expected) => {
    expect(cleanSubject(input)).toBe(expected);
  });

  it("is at most 200 characters", () => {
    expect(cleanSubject("s".repeat(400)).length).toBe(200);
  });
});

describe("rawSubject", () => {
  it("keeps the prefix but is one bounded line", () => {
    expect(rawSubject("Re: a\nb")).toBe("Re: a b");
    expect(rawSubject("s".repeat(900)).length).toBe(500);
  });
});

describe("displayFirstName", () => {
  it("uses the display name without quotes or angle brackets", () => {
    expect(displayFirstName('"Eve <Example>"', "eve@x.test")).toBe("Eve Example");
  });

  it("falls back to the local part, then to Unknown", () => {
    expect(displayFirstName(null, "jane.doe@x.test")).toBe("jane.doe");
    expect(displayFirstName("   ", "jane@x.test")).toBe("jane");
    expect(displayFirstName(null, "@x.test")).toBe("Unknown");
  });

  it("is at most 100 characters and one line", () => {
    const name = displayFirstName("A\r\nB".repeat(100), "a@x.test");
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).not.toMatch(/[\r\n]/);
  });
});

describe("RFC ids", () => {
  it("accepts a bracketed id", () => {
    expect(validRfcId(" <abc.123@mail.example.com> ")).toBe("<abc.123@mail.example.com>");
  });

  it.each([
    null,
    undefined,
    "",
    "abc@x",
    "<>",
    "<a b@x>",
    "<a<b@x>",
    "<a\u0000@x>",
    `<${"a".repeat(600)}>`,
  ])("rejects %j", (value) => {
    expect(validRfcId(value as string | null | undefined)).toBeNull();
  });

  it("filters, dedupes and bounds a References list", () => {
    expect(validRfcIds(["<a@x>", "bad", "<a@x>", "<b@x>"])).toEqual(["<a@x>", "<b@x>"]);
    const many = Array.from({ length: 80 }, (_, i) => `<${i}@x>`);
    expect(validRfcIds(many)).toHaveLength(50);
  });
});

describe("cleanAttachments", () => {
  it("keeps metadata only, sanitized and bounded", () => {
    const out = cleanAttachments([
      { filename: "a\r\nb.pdf", contentType: "application/pdf", size: 10.9 },
      { filename: "", contentType: "", size: -5 },
    ]);
    expect(out).toEqual([
      { filename: "a b.pdf", contentType: "application/pdf", size: 10 },
      { filename: "attachment", contentType: "application/octet-stream", size: 0 },
    ]);
  });
});

describe("system senders", () => {
  it("recognizes mail systems", () => {
    expect(isSystemSender("mailer-daemon@x.test")).toBe(true);
    expect(isSystemSender("postmaster@x.test")).toBe(true);
    expect(isSystemSender("eve@x.test")).toBe(false);
  });
});
