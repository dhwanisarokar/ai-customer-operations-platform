import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFakeAi,
  modelJson,
  uninstallFakeAi,
  type FakeAiProvider,
} from "../../../../tests/helpers/ai";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/knowledge-retrieval", () => ({ searchKnowledge: search }));
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { AiInvalidResponseError, AiProviderError } from "../errors";
import { runSupportAgent } from "./agent";
import { CUSTOMER_FALLBACK_REPLY, SYSTEM_INSTRUCTION } from "./prompts";

const chunk = (id: string, title: string, content: string, similarity = 0.8) => ({
  chunkId: id,
  documentId: `doc-${id}`,
  documentTitle: title,
  chunkIndex: 0,
  content,
  similarity,
});

const input = {
  organizationId: "org-a",
  customer: { name: "Alice Anders", company: "Acme", status: "ACTIVE" },
  messages: [{ role: "customer" as const, text: "How long do refunds take?" }],
  retrievalQuery: "How long do refunds take?",
};

let fake: FakeAiProvider;
beforeEach(() => {
  fake = installFakeAi();
  search.mockReset();
});
afterEach(uninstallFakeAi);

describe("runSupportAgent: customer mode (replies sent to a visitor without review)", () => {
  const visitorInput = { ...input, mode: "customer" as const };

  it("uses the customer prompt, sends NO customer record and leaves draft mode unchanged", async () => {
    search.mockResolvedValue([
      chunk("c1", "Refund policy", "Refunds are available within 30 days."),
    ]);
    fake.generation = modelJson({
      answerable: true,
      reply: "Within 30 days.",
      sourceLabels: ["S1"],
    });
    const result = await runSupportAgent(visitorInput);

    const call = fake.generateCalls[0];
    expect(call.systemInstruction).toContain("without review");
    expect(call.systemInstruction).not.toBe(SYSTEM_INSTRUCTION);
    expect(call.prompt).not.toMatch(/customer_profile|Alice|Acme/);
    // The model has no way to ask for a handoff: only the visitor can.
    expect(JSON.stringify(call.responseJsonSchema)).not.toContain("needsHuman");
    expect(call.systemInstruction).not.toContain("needsHuman");
    expect(result).toMatchObject({ grounded: true, promptVersion: "CUSTOMER_AI_V1" });

    // Draft mode is untouched: it still gets the profile and the draft prompt.
    fake.generateCalls.length = 0;
    await runSupportAgent(input);
    expect(fake.generateCalls[0].systemInstruction).toBe(SYSTEM_INSTRUCTION);
    expect(fake.generateCalls[0].prompt).toContain("customer_profile");
  });

  it("an answer without a valid citation becomes the customer-safe fallback offering a person", async () => {
    search.mockResolvedValue([]);
    fake.generation = modelJson({
      answerable: true,
      reply: "Invented policy.",
      sourceLabels: ["S1"],
    });
    const result = await runSupportAgent(visitorInput);
    expect(result.reply).toBe(CUSTOMER_FALLBACK_REPLY);
    expect(CUSTOMER_FALLBACK_REPLY).toMatch(/talk to a person/);
    expect(result.validation).toBe("ungrounded_answer_replaced");
    expect(result.grounded).toBe(false);
  });

  it("account data can never justify an answer in customer mode", async () => {
    search.mockResolvedValue([]);
    fake.generation = modelJson({
      answerable: true,
      reply: "Your account is active.",
      sourceLabels: [],
      usedAccountData: true,
    });
    const result = await runSupportAgent(visitorInput);
    expect(result.accountData).toBe(false);
    expect(result.reply).not.toContain("account is active");
  });

  it("ignores a needsHuman field from the model, and a leaked prompt is replaced", async () => {
    search.mockResolvedValue([]);
    fake.generation = JSON.stringify({
      answerable: false,
      reply: "A team member must do that.",
      sourceLabels: [],
      usedAccountData: false,
      needsHuman: true,
    });
    const ignored = await runSupportAgent(visitorInput);
    expect(ignored).not.toHaveProperty("needsHuman");

    fake.generation = modelJson({
      answerable: true,
      reply: "CUSTOMER_AI_V1 rules: GROUNDING",
      sourceLabels: [],
    });
    const leaked = await runSupportAgent(visitorInput);
    expect(leaked.reply).not.toContain("GROUNDING");
    expect(leaked.validation).toBe("prompt_leak_replaced");
  });

  it("malformed output and provider failure surface as errors for the caller to turn into a fallback", async () => {
    search.mockResolvedValue([]);
    fake.generation = "not json";
    await expect(runSupportAgent(visitorInput)).rejects.toBeInstanceOf(AiInvalidResponseError);
    fake.generation = undefined;
    fake.generationError = new AiProviderError("down");
    await expect(runSupportAgent(visitorInput)).rejects.toBeInstanceOf(AiProviderError);
  });
});
