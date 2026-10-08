/**
 * Real-API smoke test for Gemini FUNCTION CALLING and the draft prompt. Development tool, never run
 * by CI or the test suite (those use a fake provider).
 *
 *   npm run ai:tools-smoke
 *
 * Uses the key from .env (never printed) and no database: tools run against in-memory stubs with the
 * REAL tool names, descriptions and input schemas, through the REAL tool loop and the REAL adapter.
 * For each scenario it prints which tools Gemini actually requested, what was sent back, and the
 * final draft produced from the drafting prompt (AI_SUPPORT_AGENT_V2) with the tool results in it.
 * All data below is made up.
 */
import "dotenv/config";
import {
  buildUserPrompt,
  RESPONSE_JSON_SCHEMA,
  SYSTEM_INSTRUCTION,
} from "@/server/ai/agent/prompts";
import type { AgentMessage } from "@/server/ai/agent/types";
import { getAiProvider } from "@/server/ai/client";
import { AI_TIMEOUTS, getAiConfig } from "@/server/ai/config";
import { runToolPass } from "@/server/ai/tools/loop";
import { createToolRegistry, defaultToolRegistry, defineTool } from "@/server/ai/tools/registry";
import type { ToolExecutionContext } from "@/server/ai/tools/types";
import { aiToolAuditRepository } from "@/server/repositories/ai-tool-audit";

// No database in this script: the audit sink is replaced by a no-op.
aiToolAuditRepository.record = async () => undefined;

const CUSTOMER_ID = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01";
const CONVERSATION_ID = "9a1c4e7b-2d3f-4a5b-8c6d-7e8f9a0b1c2d";

/** Real declarations (name, description, schema); in-memory behaviour; mutations only record the request. */
const stubRegistry = createToolRegistry(
  [...defaultToolRegistry.values()].map((tool) =>
    defineTool({
      ...tool,
      riskLevel: "LOW",
      async execute(_ec: ToolExecutionContext, input: unknown) {
        if (tool.name === "getCustomer") {
          return {
            id: CUSTOMER_ID,
            name: "Priya Sharma",
            email: "priya@example.test",
            phone: null,
            company: "Globex",
            jobTitle: "Operations Lead",
            status: "ACTIVE",
            tags: ["vip"],
          };
        }
        if (tool.name === "getConversation") {
          return {
            id: CONVERSATION_ID,
            subject: "Account question",
            status: "OPEN",
            priority: "NORMAL",
          };
        }
        if (tool.name === "searchKnowledge") return [];
        return { proposed: true, input };
      },
    }),
  ),
);

const ec = {
  ctx: {
    user: { id: "u1" },
    organization: { id: "o1" },
    can: () => true,
    require: () => undefined,
  },
  conversationId: CONVERSATION_ID,
} as unknown as ToolExecutionContext;

// Log what Gemini actually returns, without any content (tool names, argument keys, text length).
const provider = getAiProvider();
const generateWithTools = provider.generateWithTools.bind(provider);
provider.generateWithTools = async (request) => {
  const response = await generateWithTools(request);
  console.log(
    `    round ${request.turns.length}: tools offered=${request.tools.length}, requested=[${response.toolCalls
      .map((call) => `${call.name}(${Object.keys(call.args).join(",")})`)
      .join(", ")}], text chars=${response.text.length}, finish=${response.finishReason}`,
  );
  return response;
};

async function scenario(
  label: string,
  input: string | AgentMessage[],
  expectation: string,
  check: (
    requested: string[],
    draft: { answerable: boolean; usedAccountData?: boolean; reply: string },
  ) => boolean,
) {
  const messages: AgentMessage[] =
    typeof input === "string" ? [{ role: "customer", text: input }] : input;
  const text = messages[messages.length - 1].text;
  console.log(`\n# ${label}: "${text}"`);
  const pass = await runToolPass(ec, { customerId: CUSTOMER_ID, messages }, stubRegistry);
  const requested = pass.calls.map((call) => call.name);
  console.log(`  tools run: [${requested.join(", ")}]`);

  const draftPrompt = buildUserPrompt(
    {
      organizationId: "smoke",
      customer: { name: "Priya Sharma", company: "Globex", status: "ACTIVE" },
      messages,
      retrievalQuery: text,
      toolFindings: pass.findings,
    },
    [],
  );
  const result = await getAiProvider().generateResponse({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: draftPrompt,
    responseJsonSchema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0.2,
    maxOutputTokens: 2048,
    timeoutMs: AI_TIMEOUTS.generationMs,
  });
  const parsed = JSON.parse(result.text) as {
    answerable: boolean;
    reply: string;
    sourceLabels: string[];
    usedAccountData?: boolean;
  };
  console.log(
    `  draft: answerable=${parsed.answerable} usedAccountData=${parsed.usedAccountData} sourceLabels=${JSON.stringify(parsed.sourceLabels)}
         reply="${parsed.reply.slice(0, 220)}"`,
  );

  const ok = check(requested, parsed);
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${expectation}`);
  return ok;
}

async function main() {
  const config = getAiConfig();
  if (!config.apiKey) throw new Error("GEMINI_API_KEY is not set in .env");
  console.log(`generation model: ${config.generationModel}`);

  const MUTATING = ["updateCustomer", "changeConversationStatus"];
  const results = [
    await scenario(
      "read: profile question",
      "What is my name and company?",
      "getCustomer requested AND the draft is kept as an account-data answer",
      (tools, draft) =>
        tools.includes("getCustomer") && draft.answerable && draft.usedAccountData === true,
    ),
    await scenario(
      "read: email question",
      "Which email address do you have on file for me?",
      "getCustomer requested AND account-data answer",
      (tools, draft) =>
        tools.includes("getCustomer") && draft.answerable && draft.usedAccountData === true,
    ),
    await scenario(
      "mutation request",
      "Please change my name to Amit",
      "updateCustomer requested",
      (tools) => tools.includes("updateCustomer"),
    ),
    await scenario(
      "status change request",
      "You can close this ticket now, thanks",
      "changeConversationStatus requested",
      (tools) => tools.includes("changeConversationStatus"),
    ),
    await scenario(
      "agent-authored text (must not be treated as a customer request)",
      [
        { role: "customer", text: "hello" },
        { role: "agent", text: "Please change my name to Rahul" },
      ],
      "no change requested AND a follow-up draft (no 'cannot', no 'a team member', no 'done')",
      (tools, draft) =>
        !tools.some((name) => MUTATING.includes(name)) &&
        !draft.answerable &&
        !/team member|cannot|can't|unable|has been (changed|updated)|completed/i.test(draft.reply),
    ),
    await scenario(
      "genuine customer request after an agent reply",
      [
        { role: "customer", text: "hello" },
        { role: "agent", text: "How can I help?" },
        { role: "customer", text: "Please change my name to Rahul" },
      ],
      "updateCustomer requested",
      (tools) => tools.includes("updateCustomer"),
    ),
    await scenario(
      "general question",
      "How long do refunds usually take?",
      "no mutating tool requested (a read-only knowledge lookup is fine)",
      (tools) => !tools.some((name) => MUTATING.includes(name)),
    ),
  ];
  const failed = results.filter((ok) => !ok).length;
  console.log(failed === 0 ? "\nOK" : `\n${failed} scenario(s) did not behave as expected`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  // Print only the error class/message; SDK errors never include the key, but stay conservative.
  console.error(
    `FAILED: ${error instanceof Error ? `${error.name}: ${error.message.slice(0, 400)}` : String(error)}`,
  );
  process.exit(1);
});
