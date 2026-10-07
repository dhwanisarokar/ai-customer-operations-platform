import type { GoogleGenAI } from "@google/genai";
import { createLogger } from "@/lib/logger";
import { AiInvalidResponseError, AiProviderError, AiTimeoutError } from "../errors";
import type { GenerateRequest, GenerateResult, TokenUsage } from "../types";

const log = createLogger("ai.gemini");

export async function geminiGenerate(
  ai: GoogleGenAI,
  model: string,
  request: GenerateRequest,
): Promise<GenerateResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await ai.models.generateContent({
      model,
      contents: request.prompt,
      config: {
        systemInstruction: request.systemInstruction,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: controller.signal,
        ...(request.responseJsonSchema
          ? {
              responseMimeType: "application/json",
              responseJsonSchema: request.responseJsonSchema,
            }
          : {}),
      },
    });

    const text = response.text;
    if (!text || !text.trim()) {
      // Blocked or empty candidates. Log the reason (not any content) and surface a generic error.
      log.warn(
        {
          model,
          blockReason: response.promptFeedback?.blockReason ?? null,
          finishReason: response.candidates?.[0]?.finishReason ?? null,
        },
        "gemini returned no text",
      );
      throw new AiInvalidResponseError("empty_response");
    }

    return {
      text,
      model,
      provider: "gemini",
      latencyMs: Date.now() - startedAt,
      finishReason: response.candidates?.[0]?.finishReason ?? null,
      usage: toUsage(response.usageMetadata),
    };
  } catch (error) {
    if (error instanceof AiInvalidResponseError) throw error;
    if (controller.signal.aborted) throw new AiTimeoutError(error);
    log.error({ err: describeError(error), model }, "gemini generation failed");
    throw new AiProviderError(error);
  } finally {
    clearTimeout(timer);
  }
}

type Usage =
  | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
  | undefined;

/** Reports exactly what the API returned; missing values stay null (never estimated). */
function toUsage(usage: Usage): TokenUsage {
  return {
    inputTokens: usage?.promptTokenCount ?? null,
    outputTokens: usage?.candidatesTokenCount ?? null,
    totalTokens: usage?.totalTokenCount ?? null,
  };
}

/** Loggable error summary: name/status/message only. SDK errors can embed request details. */
export function describeError(error: unknown): { name: string; status?: number; message: string } {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return {
      name: error.name,
      ...(typeof status === "number" ? { status } : {}),
      message: error.message.slice(0, 300),
    };
  }
  return { name: "UnknownError", message: String(error).slice(0, 300) };
}
