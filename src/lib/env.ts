import { z } from "zod";

/** Treats an empty value (e.g. `KEY=` copied from .env.example) as unset. */
const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1).optional(),
  // Read by Clerk's SDK directly; declared so misconfiguration is documented in one place.
  CLERK_SECRET_KEY: z.string().startsWith("sk_").optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  // AI (server-only: never expose through NEXT_PUBLIC_*). Optional so the app boots without AI;
  // AI features answer 503 until the key is configured. Model names have defaults in
  // src/server/ai/config.ts, the single source of truth.
  GEMINI_API_KEY: optionalString,
  GEMINI_GENERATION_MODEL: optionalString,
  GEMINI_EMBEDDING_MODEL: optionalString,
  // "false" turns the AI tool pass off (the draft then uses knowledge only). Default: on.
  AI_TOOLS_ENABLED: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).optional(),
  ),
  RAG_MIN_SIMILARITY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().min(0).max(1).optional(),
  ),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/** Parses and validates environment variables. Throws listing invalid keys (never values). */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverSchema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/** Lazily validated server env. Only import from server code. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
