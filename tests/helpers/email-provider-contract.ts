import { describe, expect, it } from "vitest";
import type { EmailProvider, NormalizedInboundEmail, OutboundEmail } from "@/server/email/provider";
import { WEBHOOK_EVENT_RETENTION_DAYS } from "@/server/email/inbound-webhook";
import { assertReplayPolicy, requiredLedgerRetentionDays } from "@/server/email/replay-policy";
import { auth, domainOf } from "./email-auth";

/**
 * What every EmailProvider adapter must satisfy, independent of the provider. A real adapter (Mailgun,
 * Resend...) runs this same suite against a test harness that can produce signed requests and seed mail.
 */
export type ContractHarness = {
  provider: EmailProvider;
  /** A correctly signed webhook request for an inbound message that exists at the provider. */
  validInbound(): { headers: Record<string, string>; rawBody: string; ref: string };
  /** The same request signed at a given time. */
  validInboundAt(at: Date): { headers: Record<string, string>; rawBody: string };
  /** The provider will fail the next send with this classification. */
  failNextSend(failure: { retryable: boolean }): void;
  /** The next send is AMBIGUOUS (the answer is lost); `delivered` is what really happened at the provider. */
  ambiguousNextSend(options: { delivered: boolean }): void;
  /** Number of distinct emails the provider accepted for delivery. */
  deliveredCount(): number;
};

export const sampleInbound = (
  overrides: Partial<NormalizedInboundEmail> = {},
): NormalizedInboundEmail => ({
  providerMessageId: "pm-1",
  messageId: "<abc@mail.customer.test>",
  inReplyTo: null,
  references: [],
  from: "customer@customer.test",
  fromName: "Customer",
  deliveredTo: ["support@mail.platform.test"],
  to: ["support@mail.platform.test"],
  cc: [],
  subject: "Help",
  text: "Hello",
  receivedAt: new Date("2026-10-13T10:00:00Z"),
  automated: false,
  // Authenticated for the From domain (overridable); a spoofer's result must be built explicitly.
  senderAuth: auth.aligned(domainOf(overrides.from ?? "customer@customer.test")),
  attachments: [],
  ...overrides,
});

export const sampleOutbound = (overrides: Partial<OutboundEmail> = {}): OutboundEmail => ({
  from: { address: "support@mail.platform.test", name: "Acme Support" },
  to: "customer@customer.test",
  subject: "Re: Help",
  text: "We can help.",
  messageId: "<out-1@mail.platform.test>",
  inReplyTo: "<abc@mail.customer.test>",
  references: ["<abc@mail.customer.test>"],
  idempotencyKey: "outbox-1",
  ...overrides,
});

export function emailProviderContract(name: string, make: () => ContractHarness) {
  describe(`EmailProvider contract: ${name}`, () => {
    describe("webhook verification", () => {
      it("accepts a correctly signed, fresh inbound notification and returns a reference + replay key", () => {
        const h = make();
        const { headers, rawBody, ref } = h.validInbound();
        const result = h.provider.verifyWebhook({ headers, rawBody });
        expect(result).toMatchObject({ ok: true, kind: "inbound", providerRef: ref });
        expect(result.ok && result.replayKey.length).toBeGreaterThan(0);
      });

      it("rejects a request with no signature headers", () => {
        const h = make();
        const { rawBody } = h.validInbound();
        expect(h.provider.verifyWebhook({ headers: {}, rawBody })).toEqual({
          ok: false,
          reason: "malformed",
        });
      });

      it("rejects a wrong signature", () => {
        const h = make();
        const { headers, rawBody } = h.validInbound();
        const forged = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [
            k,
            /signature/i.test(k) ? "0".repeat(v.length) : v,
          ]),
        );
        expect(h.provider.verifyWebhook({ headers: forged, rawBody })).toMatchObject({
          ok: false,
          reason: "bad_signature",
        });
      });

      it("rejects a signature of the wrong length without throwing", () => {
        const h = make();
        const { headers, rawBody } = h.validInbound();
        const short = Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [k, /signature/i.test(k) ? v.slice(0, 6) : v]),
        );
        expect(h.provider.verifyWebhook({ headers: short, rawBody })).toMatchObject({ ok: false });
      });

      it("rejects a body that was changed after signing (the body is covered by the signature)", () => {
        const h = make();
        const { headers, rawBody } = h.validInbound();
        const tampered = rawBody.replace(/"ref":"[^"]*"/, '"ref":"someone-elses-message"');
        expect(tampered).not.toBe(rawBody);
        expect(h.provider.verifyWebhook({ headers, rawBody: tampered })).toMatchObject({
          ok: false,
          reason: "bad_signature",
        });
      });

      it("rejects a stale notification (replay of an old capture)", () => {
        const h = make();
        const old = h.validInboundAt(new Date(Date.now() - 3600_000));
        expect(h.provider.verifyWebhook(old)).toEqual({ ok: false, reason: "stale" });
      });

      it("rejects a notification dated far in the future", () => {
        const h = make();
        const future = h.validInboundAt(new Date(Date.now() + 3600_000));
        expect(h.provider.verifyWebhook(future)).toEqual({ ok: false, reason: "stale" });
      });

      it("never throws on garbage", () => {
        const h = make();
        expect(() =>
          h.provider.verifyWebhook({ headers: { a: "b" }, rawBody: "\u0000{{{" }),
        ).not.toThrow();
        expect(h.provider.verifyWebhook({ headers: {}, rawBody: "" })).toMatchObject({ ok: false });
      });
    });

    describe("replay keys and replay policy", () => {
      it("declares a replay policy that fits together (freshness covers the retry horizon unless retries are re-signed)", () => {
        const h = make();
        expect(() => assertReplayPolicy(h.provider.replay)).not.toThrow();
      });

      it("the configured ledger retention outlives twice the longest replay span", () => {
        const h = make();
        expect(requiredLedgerRetentionDays(h.provider.replay)).toBeLessThanOrEqual(
          WEBHOOK_EVENT_RETENTION_DAYS,
        );
      });

      it("the replay key is namespaced by the provider, bounded and free of whitespace/control characters", () => {
        const h = make();
        const { headers, rawBody } = h.validInbound();
        const verified = h.provider.verifyWebhook({ headers, rawBody });
        if (!verified.ok) throw new Error("expected ok");
        expect(verified.replayKey.startsWith(`${h.provider.name}:`)).toBe(true);
        expect(verified.replayKey.length).toBeLessThanOrEqual(300);
        expect(verified.replayKey).not.toMatch(new RegExp("[\\s\\u0000-\\u001f\\u007f]"));
      });

      it("the replay key of the SAME notification is identical every time (a retry must hit the ledger)", () => {
        const h = make();
        const { headers, rawBody } = h.validInbound();
        const a = h.provider.verifyWebhook({ headers, rawBody });
        const b = h.provider.verifyWebhook({ headers, rawBody });
        expect(a.ok && b.ok && a.replayKey === b.replayKey).toBe(true);
      });

      it("different notifications never share a replay key", () => {
        const h = make();
        const one = h.validInbound();
        const two = h.validInbound();
        const a = h.provider.verifyWebhook({ headers: one.headers, rawBody: one.rawBody });
        const b = h.provider.verifyWebhook({ headers: two.headers, rawBody: two.rawBody });
        expect(a.ok && b.ok && a.replayKey !== b.replayKey).toBe(true);
      });
    });

    describe("fetching inbound mail", () => {
      it("returns data that satisfies the platform's bounded schema", async () => {
        const h = make();
        const { headers, rawBody } = h.validInbound();
        const verified = h.provider.verifyWebhook({ headers, rawBody });
        if (!verified.ok || verified.kind !== "inbound") throw new Error("expected inbound");
        const email = await h.provider.fetchInboundEmail(verified.providerRef);
        expect(email).not.toBeNull();
        expect(email?.text.length).toBeLessThanOrEqual(100_000);
        expect(email?.to.length).toBeGreaterThan(0);
      });

      it("returns null for an unknown reference", async () => {
        const h = make();
        expect(await h.provider.fetchInboundEmail("does-not-exist")).toBeNull();
      });
    });

    describe("sending", () => {
      it("sends and returns the provider message id", async () => {
        const h = make();
        const result = await h.provider.sendEmail(sampleOutbound());
        expect(result).toMatchObject({ ok: true });
        expect(h.deliveredCount()).toBe(1);
      });

      it("is idempotent per idempotency key: a repeat returns the same id and sends nothing new", async () => {
        const h = make();
        const first = await h.provider.sendEmail(sampleOutbound());
        const again = await h.provider.sendEmail(sampleOutbound());
        expect(again).toEqual(first);
        expect(h.deliveredCount()).toBe(1);
        await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "outbox-2" }));
        expect(h.deliveredCount()).toBe(2);
      });

      it.each([
        ["subject", { subject: "Hi\r\nBcc: attacker@evil.test" }],
        ["sender name", { from: { address: "support@mail.platform.test", name: "A\nB" } }],
        ["message id", { messageId: "<a\r\nb@x>" }],
        ["in-reply-to", { inReplyTo: "<a\nb@x>" }],
        ["references", { references: ["<a\r\nb@x>"] }],
      ])("refuses header injection in the %s, without retrying", async (_label, patch) => {
        const h = make();
        const result = await h.provider.sendEmail(sampleOutbound(patch));
        expect(result).toEqual({ ok: false, retryable: false, code: "unsafe_header" });
        expect(h.deliveredCount()).toBe(0);
      });

      it("classifies provider failures instead of throwing", async () => {
        const h = make();
        h.failNextSend({ retryable: true });
        const temporary = await h.provider.sendEmail(sampleOutbound());
        expect(temporary).toMatchObject({ ok: false, retryable: true });
        h.failNextSend({ retryable: false });
        const permanent = await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "k2" }));
        expect(permanent).toMatchObject({ ok: false, retryable: false });
        expect(h.deliveredCount()).toBe(0);
      });

      it("a failed attempt does not consume the idempotency key", async () => {
        const h = make();
        h.failNextSend({ retryable: true });
        await h.provider.sendEmail(sampleOutbound());
        const retry = await h.provider.sendEmail(sampleOutbound());
        expect(retry).toMatchObject({ ok: true });
        expect(h.deliveredCount()).toBe(1);
      });
    });

    describe("outbound: capabilities, ambiguous outcomes and lookup", () => {
      it("declares what it promises about duplicate sends, as booleans (real adapters default to false until verified)", () => {
        const h = make();
        expect(typeof h.provider.sending.idempotentByKey).toBe("boolean");
        expect(typeof h.provider.sending.lookupByKey).toBe("boolean");
      });

      it("a provider that declares a lookup implements it", () => {
        const h = make();
        if (h.provider.sending.lookupByKey)
          expect(typeof h.provider.findSendByKey).toBe("function");
      });

      it("an ambiguous attempt is reported as ambiguous with a short code, never thrown and never a plain failure", async () => {
        const h = make();
        h.ambiguousNextSend({ delivered: false });
        const result = await h.provider.sendEmail(sampleOutbound());
        expect(result).toMatchObject({ ok: false, ambiguous: true });
        expect((result as { code: string }).code).toMatch(/^[a-z0-9_]{1,64}$/);
      });

      it("the lookup agrees with what really happened: found after a delivery, not found otherwise", async () => {
        const h = make();
        if (!h.provider.sending.lookupByKey || !h.provider.findSendByKey) return;
        expect(await h.provider.findSendByKey("never-sent")).toEqual({ status: "not_found" });

        const ok = await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "k-ok" }));
        expect(await h.provider.findSendByKey("k-ok")).toEqual({
          status: "found",
          providerMessageId: (ok as { providerMessageId: string }).providerMessageId,
        });

        h.ambiguousNextSend({ delivered: true });
        await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "k-lost-but-delivered" }));
        expect(await h.provider.findSendByKey("k-lost-but-delivered")).toMatchObject({
          status: "found",
        });

        h.ambiguousNextSend({ delivered: false });
        await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "k-lost-and-dropped" }));
        expect(await h.provider.findSendByKey("k-lost-and-dropped")).toEqual({
          status: "not_found",
        });
      });

      it("a provider that declares idempotency refuses a repeat of the same key (same id, one delivery)", async () => {
        const h = make();
        if (!h.provider.sending.idempotentByKey) return;
        const first = await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "same" }));
        const again = await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "same" }));
        expect(again).toEqual(first);
        expect(h.deliveredCount()).toBe(1);
      });

      it("a failed or ambiguous-and-dropped attempt does not consume the key", async () => {
        const h = make();
        h.ambiguousNextSend({ delivered: false });
        await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "retry-me" }));
        const retry = await h.provider.sendEmail(sampleOutbound({ idempotencyKey: "retry-me" }));
        expect(retry).toMatchObject({ ok: true });
        expect(h.deliveredCount()).toBe(1);
      });
    });

    describe("address provisioning", () => {
      it("ensureAddress succeeds for a platform address and is idempotent", async () => {
        const h = make();
        expect(await h.provider.ensureAddress("support@mail.platform.test")).toEqual({ ok: true });
        expect(await h.provider.ensureAddress("support@mail.platform.test")).toEqual({ ok: true });
      });
    });
  });
}
