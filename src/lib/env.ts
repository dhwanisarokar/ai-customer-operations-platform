import { z } from "zod";
import { isValidEmailDomain } from "./email-domain";

/** A bounded positive integer; an empty value is unset. The upper bound keeps a typo from disabling the control. */
const boundedInt = (max: number) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(max).optional(),
  );

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
  // Automation queue (Phase 6). Default: BullMQ when REDIS_URL is set, otherwise in-process.
  AUTOMATION_QUEUE_DRIVER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["bullmq", "memory"]).optional(),
  ),
  // Realtime fan-out between instances. Default: Redis when REDIS_URL is set; "memory" = this process only.
  REALTIME_DRIVER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["redis", "memory"]).optional(),
  ),
  // Email channel (Phase 9). The provider is chosen here; "fake" is an in-memory test double (never in
  // production). Unset = email integration unavailable on this deployment.
  EMAIL_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["fake"]).optional(),
  ),
  // The domain organizations' support addresses live on (platform-controlled addresses; custom domains are
  // deferred): <chosen name>@EMAIL_PLATFORM_DOMAIN. Lowercase host name, e.g. mail.example.com.
  EMAIL_PLATFORM_DOMAIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .refine(isValidEmailDomain, "must be a lowercase host name such as mail.example.com")
      .optional(),
  ),
  // Outbound email abuse limits (Phase 9.6), per organization unless noted. Each has a default and a hard ceiling in
  // src/server/email/outbound-limits.ts; values above the ceiling are refused at startup.
  EMAIL_OUTBOUND_ORG_PER_MINUTE: boundedInt(600),
  EMAIL_OUTBOUND_ORG_PER_DAY: boundedInt(100_000),
  EMAIL_OUTBOUND_USER_PER_MINUTE: boundedInt(120),
  EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: boundedInt(100),
  // "true" = browsers REPORT Content-Security-Policy violations instead of blocking them (read by src/proxy.ts). Default: enforce.
  CSP_REPORT_ONLY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["true", "false"]).optional(),
  ),
  RAG_MIN_SIMILARITY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().min(0).max(1).optional(),
  ),
});

const refinedServerSchema = serverSchema.refine(
  (env) => !(env.EMAIL_PROVIDER === "fake" && env.NODE_ENV === "production"),
  { message: "the fake email provider cannot be used in production", path: ["EMAIL_PROVIDER"] },
);

export type ServerEnv = z.infer<typeof serverSchema>;

/** Parses and validates environment variables. Throws listing invalid keys (never values). */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = refinedServerSchema.safeParse(source);
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

/** Test hook: forget the cached env so a test can change `process.env` and re-read it. */
export function resetServerEnvForTesting(): void {
  cached = undefined;
}
