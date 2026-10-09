import { describe, expect, it } from "vitest";
import { isAcceptance, isExplicitHumanRequest, mentionsPerson } from "./handoff";

describe("isExplicitHumanRequest", () => {
  it.each([
    "I want to talk to a person.",
    "Connect me with support",
    "Can I speak to a human agent?",
    "i need a real person please",
    "Please transfer me to a representative",
    "human agent please",
    "I'd like to speak with someone from your team",
    "let me talk to a manager",
  ])("is a request: %s", (text) => {
    expect(isExplicitHumanRequest(text)).toBe(true);
  });

  it.each([
    "can you tell me about refund policy?",
    "can it be done eariler?",
    "What are your support hours?",
    "How do I contact support by email?",
    "I don't want to talk to a person, just answer please",
    "no need for a human, thanks",
    "yes",
    "My agent told me refunds take 5 days",
    "",
  ])("is not a request: %s", (text) => {
    expect(isExplicitHumanRequest(text)).toBe(false);
  });
});

describe("isAcceptance", () => {
  it.each([
    "Yes, please connect me.",
    "Yes, talk to a person",
    "Please do that.",
    "yes",
    "Sure",
    "ok please",
    "yes please",
    "go ahead",
    "That would be great!",
  ])("accepts: %s", (text) => {
    expect(isAcceptance(text)).toBe(true);
  });

  it.each([
    "yes, but what about shipping?",
    "yes how long do refunds take",
    "no",
    "no thanks",
    "please tell me about the refund policy",
    "yes I also have a question about invoices",
  ])("does not accept: %s", (text) => {
    expect(isAcceptance(text)).toBe(false);
  });
});

describe("mentionsPerson", () => {
  it("recognizes an existing offer so the offer sentence is not added twice", () => {
    expect(mentionsPerson("Would you like to talk to a person?")).toBe(true);
    expect(mentionsPerson("I could not find that in our policy.")).toBe(false);
  });
});
