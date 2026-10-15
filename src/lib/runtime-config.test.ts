import { describe, expect, it } from "vitest";
import {
  REQUIRED_IN_PRODUCTION,
  RuntimeConfigError,
  assertRuntimeConfig,
  productionConfigProblems,
} from "./runtime-config";

const SECRET = "sk_live_THIS_VALUE_MUST_NEVER_APPEAR_IN_AN_ERROR";
const complete = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pw-secret-value@db.example.test:5432/app",
  REDIS_URL: "rediss://default:redis-secret-value@redis.example.test:6379",
  CLERK_SECRET_KEY: SECRET,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_publishable",
  GEMINI_API_KEY: "gemini-secret-value",
};

describe("production runtime configuration", () => {
  it("accepts a complete web and a complete worker configuration", () => {
    expect(() => assertRuntimeConfig("web", complete)).not.toThrow();
    expect(() => assertRuntimeConfig("worker", complete)).not.toThrow();
  });

  it("the worker needs no Clerk credentials; the web process does", () => {
    const withoutClerk = {
      NODE_ENV: "production",
      DATABASE_URL: complete.DATABASE_URL,
      REDIS_URL: complete.REDIS_URL,
      GEMINI_API_KEY: complete.GEMINI_API_KEY,
    };
    expect(() => assertRuntimeConfig("worker", withoutClerk)).not.toThrow();
    expect(() => assertRuntimeConfig("web", withoutClerk)).toThrow(RuntimeConfigError);
    expect(REQUIRED_IN_PRODUCTION.worker).not.toContain("CLERK_SECRET_KEY");
    expect(REQUIRED_IN_PRODUCTION.web).toContain("CLERK_SECRET_KEY");
  });

  it.each(["DATABASE_URL", "REDIS_URL", "GEMINI_API_KEY"])(
    "a production %s that is missing, or only whitespace, stops both processes",
    (name) => {
      for (const value of [undefined, "", "   "]) {
        for (const role of ["web", "worker"] as const) {
          const source = { ...complete, [name]: value };
          expect(() => assertRuntimeConfig(role, source)).toThrow(name);
        }
      }
    },
  );

  it.each(["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"])(
    "a missing %s stops the web process",
    (name) => {
      expect(() => assertRuntimeConfig("web", { ...complete, [name]: undefined })).toThrow(name);
    },
  );

  it("lists every missing variable at once, so one deploy attempt shows the whole problem", () => {
    const problems = productionConfigProblems("web", { NODE_ENV: "production" });
    expect(problems.join(" ")).toMatch(
      /DATABASE_URL.*REDIS_URL.*CLERK_SECRET_KEY.*NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.*GEMINI_API_KEY/,
    );
  });

  it("never puts a value, or a fragment of one, into an error", () => {
    const attempts = [
      { ...complete, REDIS_URL: undefined },
      { ...complete, CLERK_SECRET_KEY: "not-a-clerk-key-with-secret-text" },
      { ...complete, AUTOMATION_QUEUE_DRIVER: "memory" },
      { ...complete, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "bad-format-secret-text" },
    ];
    for (const source of attempts) {
      let message = "";
      try {
        assertRuntimeConfig("web", source);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      expect(message).not.toBe("");
      for (const [name, value] of Object.entries(source)) {
        // NODE_ENV and the driver names are not secrets and may be named in the message.
        if (value && value.length > 8 && !["NODE_ENV", "AUTOMATION_QUEUE_DRIVER"].includes(name)) {
          expect(message).not.toContain(value);
        }
      }
      expect(message).not.toMatch(/secret-value|secret-text|THIS_VALUE_MUST_NEVER/);
    }
  });

  it("refuses the process-local queue and realtime drivers in production (web and worker must share Redis)", () => {
    for (const role of ["web", "worker"] as const) {
      expect(() =>
        assertRuntimeConfig(role, { ...complete, AUTOMATION_QUEUE_DRIVER: "memory" }),
      ).toThrow(/AUTOMATION_QUEUE_DRIVER/);
      expect(() => assertRuntimeConfig(role, { ...complete, REALTIME_DRIVER: "memory" })).toThrow(
        /REALTIME_DRIVER/,
      );
      expect(() =>
        assertRuntimeConfig(role, { ...complete, AUTOMATION_QUEUE_DRIVER: "bullmq" }),
      ).not.toThrow();
    }
  });

  it("keeps email disabled: the fake provider is refused in production and no real provider can be named", () => {
    expect(() => assertRuntimeConfig("web", { ...complete, EMAIL_PROVIDER: "fake" })).toThrow(
      /EMAIL_PROVIDER/,
    );
    expect(() => assertRuntimeConfig("web", { ...complete, EMAIL_PROVIDER: "resend" })).toThrow(
      /EMAIL_PROVIDER/,
    );
    expect(() =>
      assertRuntimeConfig("web", { ...complete, EMAIL_PROVIDER: undefined }),
    ).not.toThrow();
  });

  it("is a no-op outside production: development and tests stay as relaxed as before", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() => assertRuntimeConfig("web", { NODE_ENV })).not.toThrow();
      expect(() => assertRuntimeConfig("worker", { NODE_ENV })).not.toThrow();
    }
  });

  it("the web and worker configurations are independent: each is judged on its own list", () => {
    expect(
      productionConfigProblems("worker", { ...complete, CLERK_SECRET_KEY: undefined }),
    ).toEqual([]);
    expect(
      productionConfigProblems("web", { ...complete, CLERK_SECRET_KEY: undefined }),
    ).not.toEqual([]);
  });
});
