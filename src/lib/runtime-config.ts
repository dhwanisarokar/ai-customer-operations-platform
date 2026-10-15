import { parseServerEnv } from "./env";

/**
 * Production runtime configuration, checked at process start (not at build, not in tests, not in local development).
 *
 * The web service and the background worker are separate processes with their own environment, so each one checks only
 * what IT needs. Variables that are required in production are optional everywhere else on purpose: a developer can run the
 * app without Redis or Gemini, but a production deployment that silently lacks them would boot and then fail on the first
 * request. Errors list variable NAMES only: never a value, never a fragment of one.
 *
 * Categories (see docs/deployment.md for the table):
 *  - build-time:   `NEXT_PUBLIC_*` (inlined into the browser bundle by `next build`)
 *  - web runtime:  the `web` list below
 *  - worker:       the `worker` list below
 *  - optional:     everything else in `src/lib/env.ts` (has a default, or the feature is simply off)
 *  - test-only:    `TEST_DATABASE_URL`, `TEST_REDIS_URL` (never read by the application)
 */

export type ProcessRole = "web" | "worker";

/** Required in production, per process. Anything not listed here is optional for that process. */
export const REQUIRED_IN_PRODUCTION: Record<ProcessRole, readonly string[]> = {
  web: [
    "DATABASE_URL",
    "REDIS_URL",
    "CLERK_SECRET_KEY",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "GEMINI_API_KEY",
  ],
  // The worker never authenticates a person, so it needs no Clerk credentials.
  worker: ["DATABASE_URL", "REDIS_URL", "GEMINI_API_KEY"],
};

export class RuntimeConfigError extends Error {
  readonly problems: readonly string[];
  constructor(role: ProcessRole, problems: readonly string[]) {
    super(
      `Invalid production configuration for the ${role} process:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nSee docs/deployment.md (environment variables by process).",
    );
    this.name = "RuntimeConfigError";
    this.problems = problems;
  }
}

type Source = Record<string, string | undefined>;

const present = (source: Source, name: string) => (source[name] ?? "").trim().length > 0;

/** Everything wrong with `source` for a production `role`. Names only; empty = fine. */
export function productionConfigProblems(role: ProcessRole, source: Source): string[] {
  const problems: string[] = [];

  const missing = REQUIRED_IN_PRODUCTION[role].filter((name) => !present(source, name));
  if (missing.length > 0) problems.push(`missing required variables: ${missing.join(", ")}`);

  // The format checks of `env.ts` (key prefixes, enums, bounds) report invalid NAMES only.
  try {
    parseServerEnv(source);
  } catch (error) {
    if (error instanceof Error) problems.push(error.message.split("\n")[0]);
  }

  // A process-local queue or realtime bus cannot connect a separate web process and worker.
  if (source.AUTOMATION_QUEUE_DRIVER === "memory") {
    problems.push(
      "AUTOMATION_QUEUE_DRIVER=memory cannot be used in production (the web process and the worker must share Redis)",
    );
  }
  if (source.REALTIME_DRIVER === "memory") {
    problems.push(
      "REALTIME_DRIVER=memory cannot be used in production (events published by the worker would never reach browsers)",
    );
  }
  if (role === "web" && present(source, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")) {
    if (!source.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith("pk_")) {
      problems.push("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY has the wrong format");
    }
  }
  return problems;
}

/**
 * Throws a `RuntimeConfigError` when this process is a production process (`NODE_ENV=production`) and its configuration is
 * incomplete. A no-op in development and tests, so local setups and the test suite stay as relaxed as they were.
 */
export function assertRuntimeConfig(role: ProcessRole, source: Source = process.env): void {
  if (source.NODE_ENV !== "production") return;
  const problems = productionConfigProblems(role, source);
  if (problems.length > 0) throw new RuntimeConfigError(role, problems);
}
