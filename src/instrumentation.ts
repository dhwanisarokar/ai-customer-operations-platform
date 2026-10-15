/**
 * Runs once when the Next.js server starts (never during `next build`, which has no runtime secrets): a production web process
 * with incomplete configuration refuses to start, with an error that names the missing variables and nothing else.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { checkWebRuntimeConfig } = await import("./instrumentation-node");
  checkWebRuntimeConfig();
}
