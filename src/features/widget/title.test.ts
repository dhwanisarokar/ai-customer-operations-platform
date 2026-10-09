import { describe, expect, it } from "vitest";
import { conversationTitle, repeatsTitle } from "./title";

describe("conversationTitle", () => {
  it.each([
    ["can you tell me about refund policy?", "Refund policy"],
    ["Can you tell me about the refund policy?", "Refund policy"],
    ["What is your refund policy?", "Refund policy"],
    ["What's the shipping time?", "Shipping time"],
    ["How do I reset my password?", "Reset my password"],
    ["Hello, I need help with my order", "My order"],
    ["I would like to know about pricing for teams", "Pricing for teams"],
    ["Please change my billing address", "Change my billing address"],
    ["I have a question about invoices", "Invoices"],
    ["do you offer student discounts?", "Student discounts"],
  ])("%s -> %s", (subject, title) => {
    expect(conversationTitle(subject)).toBe(title);
  });

  it("keeps what the visitor wrote when nothing meaningful remains", () => {
    expect(conversationTitle("hello")).toBe("Hello");
    expect(conversationTitle("   ")).toBe("New conversation");
  });

  it("shortens very long subjects on a word boundary", () => {
    const title = conversationTitle(
      "my package arrived damaged and the courier left it outside in the rain yesterday afternoon",
    );
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith("…")).toBe(true);
  });

  it("is deterministic", () => {
    const a = conversationTitle("can you tell me about refund policy?");
    expect(conversationTitle("can you tell me about refund policy?")).toBe(a);
  });

  it("detects a preview that only repeats the title", () => {
    expect(repeatsTitle("Refund policy", "refund policy?")).toBe(true);
    expect(repeatsTitle("Refund policy", "can you tell me about refund policy?")).toBe(false);
    expect(repeatsTitle("Refund policy", null)).toBe(false);
  });
});
