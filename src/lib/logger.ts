import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.apiKey", "*.token"],
  base: { service: "ai-ops-platform" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Child logger bound to a module/feature for consistent structured fields. */
export function createLogger(module: string) {
  return logger.child({ module });
}
