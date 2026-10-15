import { RuntimeConfigError, assertRuntimeConfig } from "@/lib/runtime-config";

/**
 * Node.js-only startup check of the web process (see `instrumentation.ts`). An incomplete production configuration makes the
 * process EXIT with a message that names the missing variables and nothing else, instead of serving errors: a deployment
 * platform then reports the release as failed and keeps the previous one, rather than routing traffic to a broken service.
 */
export function checkWebRuntimeConfig(): void {
  try {
    assertRuntimeConfig("web");
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
