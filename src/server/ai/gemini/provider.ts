import { GoogleGenAI } from "@google/genai";
import type { AiConfig } from "../config";
import { AiNotConfiguredError } from "../errors";
import type {
  AIProvider,
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
} from "../types";
import { geminiEmbed } from "./embeddings";
import { geminiGenerate } from "./generation";

/** The only module (with its siblings) that talks to the Gemini SDK. */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: AiConfig) {
    if (!config.apiKey) throw new AiNotConfiguredError();
    this.ai = new GoogleGenAI({ apiKey: config.apiKey });
  }

  generateResponse(request: GenerateRequest): Promise<GenerateResult> {
    return geminiGenerate(this.ai, this.config.generationModel, request);
  }

  generateEmbeddings(request: EmbedRequest): Promise<EmbedResult> {
    return geminiEmbed(
      this.ai,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
      request,
    );
  }
}
