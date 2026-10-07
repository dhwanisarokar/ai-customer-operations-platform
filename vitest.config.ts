import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    env: {
      LOG_LEVEL: "silent",
      // Automated tests must never reach the real Gemini API, even if a key exists in the shell.
      GEMINI_API_KEY: "",
      // Tests use a deterministic fake embedding (bag of words), whose similarities are lower than a
      // real model's, so the retrieval threshold is lowered for them.
      RAG_MIN_SIMILARITY: "0.2",
    },
    // Integration suites share one database.
    fileParallelism: false,
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
