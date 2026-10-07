import { describe, expect, it } from "vitest";
import { AGENT_LIMITS } from "../config";
import { buildRetrievalQuery, toConversationContext, toCustomerContext } from "./context";

const msg = (senderType: string, body: string) => ({ senderType, body });

describe("toCustomerContext", () => {
  it("exposes only name, company and status", () => {
    const context = toCustomerContext({
      firstName: "Alice",
      lastName: "Anders",
      company: "Acme",
      status: "ACTIVE",
      // @ts-expect-error: extra fields must not survive
      email: "alice@a.test",
      phone: "+1555",
    });
    expect(context).toEqual({ name: "Alice Anders", company: "Acme", status: "ACTIVE" });
  });
});

describe("toConversationContext", () => {
  it("maps senders to roles and skips system messages and blanks", () => {
    expect(
      toConversationContext([
        msg("CUSTOMER", "Hi"),
        msg("SYSTEM", "internal"),
        msg("USER", "Hello!"),
        msg("AI_AGENT", "Hi from AI"),
        msg("CUSTOMER", "   "),
      ]),
    ).toEqual([
      { role: "customer", text: "Hi" },
      { role: "agent", text: "Hello!" },
      { role: "ai", text: "Hi from AI" },
    ]);
  });

  it("keeps only the most recent messages", () => {
    const many = Array.from({ length: 40 }, (_, i) => msg("CUSTOMER", `m${i}`));
    const result = toConversationContext(many);
    expect(result).toHaveLength(AGENT_LIMITS.maxContextMessages);
    expect(result[result.length - 1].text).toBe("m39");
    expect(result[0].text).toBe(`m${40 - AGENT_LIMITS.maxContextMessages}`);
  });

  it("truncates each message and enforces the total budget, preferring the newest", () => {
    const long = "x".repeat(5000);
    const result = toConversationContext([
      msg("CUSTOMER", "OLDEST " + long),
      ...Array.from({ length: 6 }, (_, k) => msg(k % 2 ? "CUSTOMER" : "USER", long)),
      msg("CUSTOMER", "NEWEST " + long),
    ]);
    const total = result.reduce((sum, m) => sum + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(AGENT_LIMITS.maxConversationChars);
    for (const m of result) expect(m.text.length).toBeLessThanOrEqual(AGENT_LIMITS.maxMessageChars);
    expect(result[result.length - 1].text.startsWith("NEWEST")).toBe(true);
    expect(result.some((m) => m.text.startsWith("OLDEST"))).toBe(false);
  });
});

describe("buildRetrievalQuery", () => {
  it("uses the latest customer message", () => {
    expect(
      buildRetrievalQuery([
        { role: "customer", text: "How do refunds work for annual plans in the EU region?" },
        { role: "agent", text: "Let me check." },
      ]),
    ).toBe("How do refunds work for annual plans in the EU region?");
  });

  it("adds the previous customer message when the latest is very short", () => {
    expect(
      buildRetrievalQuery([
        { role: "customer", text: "How do refunds work for annual plans?" },
        { role: "agent", text: "Within 30 days." },
        { role: "customer", text: "and monthly?" },
      ]),
    ).toBe("How do refunds work for annual plans?\nand monthly?");
  });

  it("returns null when the customer has not written anything", () => {
    expect(buildRetrievalQuery([{ role: "agent", text: "Hello" }])).toBeNull();
    expect(buildRetrievalQuery([])).toBeNull();
  });

  it("is bounded", () => {
    const query = buildRetrievalQuery([{ role: "customer", text: "x".repeat(10_000) }]);
    expect(query!.length).toBeLessThanOrEqual(AGENT_LIMITS.maxQueryChars);
  });
});
