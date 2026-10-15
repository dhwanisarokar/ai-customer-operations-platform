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

describe("parseServerEnv: email", () => {
  const base = { DATABASE_URL: "postgresql://localhost/db" };

  it("leaves email unset by default", () => {
    const env = parseServerEnv(base);
    expect(env.EMAIL_PROVIDER).toBeUndefined();
    expect(env.EMAIL_PLATFORM_DOMAIN).toBeUndefined();
  });

  it("treats empty values as unset", () => {
    const env = parseServerEnv({ ...base, EMAIL_PROVIDER: "", EMAIL_PLATFORM_DOMAIN: "" });
    expect(env.EMAIL_PROVIDER).toBeUndefined();
    expect(env.EMAIL_PLATFORM_DOMAIN).toBeUndefined();
  });

  it("accepts the fake provider and a valid domain outside production", () => {
    const env = parseServerEnv({
      ...base,
      NODE_ENV: "development",
      EMAIL_PROVIDER: "fake",
      EMAIL_PLATFORM_DOMAIN: "mail.example.com",
    });
    expect(env.EMAIL_PROVIDER).toBe("fake");
    expect(env.EMAIL_PLATFORM_DOMAIN).toBe("mail.example.com");
  });

  it("refuses the fake provider in production", () => {
    expect(() =>
      parseServerEnv({ ...base, NODE_ENV: "production", EMAIL_PROVIDER: "fake" }),
    ).toThrow(/EMAIL_PROVIDER/);
  });

  it("rejects an unknown provider", () => {
    expect(() => parseServerEnv({ ...base, EMAIL_PROVIDER: "carrier-pigeon" })).toThrow(
      /EMAIL_PROVIDER/,
    );
  });

  it.each([
    "not a domain",
    "http://mail.example.com",
    "mail.example.com/path",
    "localhost",
    "a@b.com",
  ])("rejects a malformed platform domain (%s)", (domain) => {
    expect(() => parseServerEnv({ ...base, EMAIL_PLATFORM_DOMAIN: domain })).toThrow(
      /EMAIL_PLATFORM_DOMAIN/,
    );
  });
});
