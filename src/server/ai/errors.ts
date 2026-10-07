import { AppError } from "@/server/errors";

/**
 * AI failures are mapped to safe client messages. Provider details (status codes, raw messages,
 * request ids) are logged server-side from `cause` and never returned to clients.
 */
export class AiNotConfiguredError extends AppError {
  constructor() {
    super(503, "ai_not_configured", "AI features are not configured for this deployment");
  }
}

export class AiProviderError extends AppError {
  constructor(readonly cause?: unknown) {
    super(502, "ai_unavailable", "The AI service is temporarily unavailable. Please try again.");
  }
}

export class AiTimeoutError extends AppError {
  constructor(readonly cause?: unknown) {
    super(504, "ai_timeout", "The AI service took too long to respond. Please try again.");
  }
}

/** The model answered, but not in a form the application can safely use. */
export class AiInvalidResponseError extends AppError {
  constructor(readonly reason: string) {
    super(502, "ai_invalid_response", "The AI response could not be validated. Please try again.");
  }
}

export class AiEmbeddingError extends AppError {
  constructor(readonly reason: string) {
    super(502, "ai_embedding_failed", "Could not generate embeddings. Please try again.");
  }
}
