import { describe, expect, it } from "vitest";
import {
  widgetCreateConversationSchema,
  widgetIdentitySchema,
  widgetSessionRequestSchema,
  widgetSettingsInputSchema,
} from "@/features/widget/schemas";
import { MemoryRateLimiter } from "@/server/rate-limit";
import {
  canAgentSubscribe,
  canVisitorSubscribe,
  inboxChannel,
  visitorChannel,
} from "@/server/realtime/channels";
import { generatePublicKey, generateSessionToken, hashToken } from "./keys";
import { normalizeEmbedOrigin } from "./session";

describe("widget keys and tokens", () => {
  it("generates unguessable, distinct values and a stable one-way hash", () => {
    expect(generatePublicKey()).toMatch(/^wk_[\w-]{20,}$/);
    expect(generateSessionToken()).toMatch(/^vs_[\w-]{40,}$/);
    expect(generateSessionToken()).not.toBe(generateSessionToken());
    const token = generateSessionToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});

describe("widget schemas", () => {
  it("normalizes email and origins, and rejects unknown (privileged) fields", () => {
    expect(widgetIdentitySchema.parse({ email: " A@B.Com " }).email).toBe("a@b.com");
    expect(widgetIdentitySchema.safeParse({}).success).toBe(false);
    expect(widgetIdentitySchema.safeParse({ email: "a@b.com", customerId: "x" }).success).toBe(
      false,
    );
    const settings = widgetSettingsInputSchema.parse({
      enabled: true,
      displayName: "Help",
      welcomeMessage: "Hi",
      allowedOrigins: ["https://a.com/path", "https://a.com"],
    });
    expect(settings.allowedOrigins).toEqual(["https://a.com"]);
    expect(
      widgetSettingsInputSchema.safeParse({
        enabled: true,
        displayName: "Help",
        welcomeMessage: "Hi",
        allowedOrigins: ["javascript:alert(1)"],
      }).success,
    ).toBe(false);
    expect(
      widgetCreateConversationSchema.safeParse({
        body: "hi",
        clientMessageId: crypto.randomUUID(),
        organizationId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(widgetSessionRequestSchema.safeParse({ key: "short" }).success).toBe(false);
  });

  it("normalizes the embedding origin", () => {
    expect(normalizeEmbedOrigin("https://shop.example.com/a?b=1")).toBe("https://shop.example.com");
    expect(normalizeEmbedOrigin("ftp://x.com")).toBeNull();
    expect(normalizeEmbedOrigin("garbage")).toBeNull();
    expect(normalizeEmbedOrigin(undefined)).toBeNull();
  });
});

describe("MemoryRateLimiter", () => {
  it("allows up to the limit per window, then resets", async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter(() => now);
    const rule = { limit: 2, windowSeconds: 10 };
    expect((await limiter.hit("k", rule)).allowed).toBe(true);
    expect((await limiter.hit("k", rule)).allowed).toBe(true);
    const blocked = await limiter.hit("k", rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect((await limiter.hit("other", rule)).allowed).toBe(true);
    now += 11_000;
    expect((await limiter.hit("k", rule)).allowed).toBe(true);
  });
});

describe("realtime channel authorization", () => {
  const ctx = (orgId: string, canView = true) =>
    ({ organization: { id: orgId }, can: () => canView }) as never;

  it("agents may only listen to their own organization's inbox", () => {
    expect(canAgentSubscribe(ctx("org-a"), inboxChannel("org-a"))).toBe(true);
    expect(canAgentSubscribe(ctx("org-a"), inboxChannel("org-b"))).toBe(false);
    expect(canAgentSubscribe(ctx("org-a"), visitorChannel("s1"))).toBe(false);
    expect(canAgentSubscribe(ctx("org-a", false), inboxChannel("org-a"))).toBe(false);
  });

  it("visitors may only listen to their own session channel", () => {
    expect(canVisitorSubscribe({ id: "s1" }, visitorChannel("s1"))).toBe(true);
    expect(canVisitorSubscribe({ id: "s1" }, visitorChannel("s2"))).toBe(false);
    expect(canVisitorSubscribe({ id: "s1" }, inboxChannel("org-a"))).toBe(false);
  });
});
