import type { Content, GoogleGenAI, Part } from "@google/genai";
import { createLogger } from "@/lib/logger";
import { AiInvalidResponseError, AiProviderError, AiTimeoutError } from "../errors";
import type { ToolGenerateRequest, ToolGenerateResult, ToolTurn } from "../types";
import { describeError } from "./generation";

const log = createLogger("ai.gemini");

/**
 * Gemini function calling. The SDK is given declarations only (no callables) and automatic
 * function calling is disabled: the model can only REQUEST calls, which the application runs.
 */
export async function geminiGenerateWithTools(
  ai: GoogleGenAI,
  model: string,
  request: ToolGenerateRequest,
): Promise<ToolGenerateResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await ai.models.generateContent({
      model,
      contents: toContents(request.turns),
      config: {
        systemInstruction: request.systemInstruction,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: controller.signal,
        tools: [
          {
            functionDeclarations: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parametersJsonSchema: tool.parametersJsonSchema,
            })),
          },
        ],
        automaticFunctionCalling: { disable: true },
      },
    });

    const content = response.candidates?.[0]?.content;
    const parts = content?.parts ?? [];
    const text = parts
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("");
    const toolCalls = parts.flatMap((part) =>
      part.functionCall?.name
        ? [
            {
              name: part.functionCall.name,
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            },
          ]
        : [],
    );

    if (!text.trim() && toolCalls.length === 0) {
      log.warn(
        {
          model,
          blockReason: response.promptFeedback?.blockReason ?? null,
          finishReason: response.candidates?.[0]?.finishReason ?? null,
        },
        "gemini returned no text or tool calls",
      );
      throw new AiInvalidResponseError("empty_response");
    }

    const usage = response.usageMetadata;
    return {
      text,
      toolCalls,
      providerData: content,
      model,
      provider: "gemini",
      latencyMs: Date.now() - startedAt,
      finishReason: response.candidates?.[0]?.finishReason ?? null,
      usage: {
        inputTokens: usage?.promptTokenCount ?? null,
        outputTokens: usage?.candidatesTokenCount ?? null,
        totalTokens: usage?.totalTokenCount ?? null,
      },
    };
  } catch (error) {
    if (error instanceof AiInvalidResponseError) throw error;
    if (controller.signal.aborted) throw new AiTimeoutError(error);
    log.error({ err: describeError(error), model }, "gemini tool generation failed");
    throw new AiProviderError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Provider-neutral turns -> Gemini contents. Consecutive tool results share one user turn. */
export function toContents(turns: ToolTurn[]): Content[] {
  const contents: Content[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      contents.push({ role: "user", parts: [{ text: turn.text }] });
    } else if (turn.role === "model") {
      if (turn.providerData) {
        contents.push(turn.providerData as Content);
      } else {
        const parts: Part[] = [];
        if (turn.text) parts.push({ text: turn.text });
        for (const call of turn.toolCalls) {
          parts.push({ functionCall: { name: call.name, args: call.args } });
        }
        contents.push({ role: "model", parts });
      }
    } else {
      const part: Part = { functionResponse: { name: turn.name, response: turn.response } };
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts?.every((p) => p.functionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
    }
  }
  return contents;
}
