import { describe, expect, it } from "vitest";
import {
  emailProviderContract,
  sampleInbound,
} from "../../../tests/helpers/email-provider-contract";
import { FakeEmailProvider, WEBHOOK_MAX_AGE_SECONDS } from "./fake-provider";

emailProviderContract("FakeEmailProvider", () => {
  const provider = new FakeEmailProvider("contract-secret");
  const make = (at: Date) => provider.receive(sampleInbound(), at);
  return {
    provider,
    validInbound: () => {
      const { ref, webhook } = make(new Date());
      return { ...webhook, ref };
    },
    validInboundAt: (at) => make(at).webhook,
    failNextSend: (failure) => provider.failNextSend(failure),
    ambiguousNextSend: (options) => provider.ambiguousNextSend(options),
    deliveredCount: () => provider.sent.length,
  };
});

describe("FakeEmailProvider specifics", () => {
  it("accepts a notification exactly at the edge of the freshness window and rejects just past it", () => {
    const provider = new FakeEmailProvider("s");
    const now = new Date("2026-10-13T12:00:00Z");
    const edge = provider.receive(
      sampleInbound(),
      new Date(now.getTime() - WEBHOOK_MAX_AGE_SECONDS * 1000),
    );
    expect(provider.verifyWebhook({ ...edge.webhook, now }).ok).toBe(true);
    const past = provider.receive(
      sampleInbound(),
      new Date(now.getTime() - (WEBHOOK_MAX_AGE_SECONDS + 5) * 1000),
    );
    expect(provider.verifyWebhook({ ...past.webhook, now })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("a signature made with a different secret is rejected", () => {
    const real = new FakeEmailProvider("one");
    const attacker = new FakeEmailProvider("two");
    const { webhook } = attacker.receive(sampleInbound());
    expect(real.verifyWebhook(webhook)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("header names are case-insensitive", () => {
    const provider = new FakeEmailProvider("s");
    const { webhook } = provider.receive(sampleInbound());
    const upper = Object.fromEntries(
      Object.entries(webhook.headers).map(([k, v]) => [k.toUpperCase(), v]),
    );
    expect(provider.verifyWebhook({ headers: upper, rawBody: webhook.rawBody }).ok).toBe(true);
  });

  it("a validly signed but structurally wrong body is malformed, not trusted", () => {
    const provider = new FakeEmailProvider("s");
    const { headers, rawBody } = provider.signedWebhook({ type: "inbound", id: "", ref: "" });
    expect(provider.verifyWebhook({ headers, rawBody })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("surfaces delivery events with machine codes only", () => {
    const provider = new FakeEmailProvider("s");
    const { headers, rawBody } = provider.signedWebhook({
      type: "delivery",
      id: "evt-1",
      providerMessageId: "pm-9",
      event: "bounced",
      code: "mailbox_full",
    });
    const result = provider.verifyWebhook({ headers, rawBody });
    expect(result).toMatchObject({
      ok: true,
      kind: "delivery",
      event: { eventId: "evt-1", providerMessageId: "pm-9", type: "bounced", code: "mailbox_full" },
    });
  });

  it("refuses an address it was told to reject", async () => {
    const provider = new FakeEmailProvider("s");
    provider.rejectAddresses.add("bad@mail.platform.test");
    expect(await provider.ensureAddress("bad@mail.platform.test")).toEqual({
      ok: false,
      code: "provider_rejected",
    });
  });

  it("hands out only schema-valid mail (oversized text is refused even from the fake)", async () => {
    const provider = new FakeEmailProvider("s");
    const { ref } = provider.receive(sampleInbound({ text: "x".repeat(100_001) }));
    await expect(provider.fetchInboundEmail(ref)).rejects.toThrow();
  });
});
