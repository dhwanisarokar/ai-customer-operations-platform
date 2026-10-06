import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

describe("parseServerEnv", () => {
  it("applies defaults and accepts a valid config", () => {
    const env = parseServerEnv({ DATABASE_URL: "postgresql://localhost/db" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects a missing DATABASE_URL and names the key", () => {
    expect(() => parseServerEnv({ LOG_LEVEL: "info" })).toThrow(/DATABASE_URL/);
  });

  it("rejects an invalid LOG_LEVEL without leaking other values", () => {
    const attempt = () =>
      parseServerEnv({ DATABASE_URL: "postgresql://user:secret@localhost/db", LOG_LEVEL: "loud" });
    expect(attempt).toThrow(/LOG_LEVEL/);
    expect(attempt).not.toThrow(/secret/);
  });
});
