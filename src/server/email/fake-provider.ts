import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertSafeHeaderValue } from "./address";
import {
  normalizedInboundEmailSchema,
  type AddressCheck,
  type DeliveryEvent,
  type EmailProvider,
  type NormalizedInboundEmail,
  type OutboundEmail,
  type ProviderReadiness,
  type SendLookup,
  type SendResult,
  type SendingCapabilities,
  type VerifiedWebhook,
} from "./provider";

/**
 * The fake's declared sending capabilities by default: idempotent, with a strong lookup. A test overrides what it needs
 * (`sendingCapabilities({...})`); every field is explicit so none can be forgotten. These numbers describe a TEST DOUBLE
 * and prove nothing about any real provider.
 */
export function sendingCapabilities(over: Partial<SendingCapabilities> = {}): SendingCapabilities {
  return {
    idempotentByKey: true,
    keyRetentionMs: 24 * 3600_000,
    lookupByKey: true,
    lookupConsistency: "strong",
    lookupSettleMs: 0,
    lookupRetentionMs: 7 * 24 * 3600_000,
    lateAcceptanceCeilingMs: 0,
    ...over,
  };
}

/** A provider that promises nothing: no idempotency, no lookup. Every ambiguous send ends UNKNOWN. */
export const NO_SENDING_GUARANTEES: SendingCapabilities = {
  idempotentByKey: false,
  keyRetentionMs: null,
  lookupByKey: false,
  lookupConsistency: "none",
  lookupSettleMs: null,
  lookupRetentionMs: null,
  lateAcceptanceCeilingMs: null,
};

/** Webhooks older than this (or from the future by more than this) are refused. */
export const WEBHOOK_MAX_AGE_SECONDS = 300;

const webhookBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inbound"),
    id: z.string().min(1).max(200),
    ref: z.string().min(1).max(256),
  }),
  z.object({
    type: z.literal("delivery"),
    id: z.string().min(1).max(200),
    providerMessageId: z.string().min(1).max(256),
    event: z.enum(["delivered", "bounced", "complained", "failed"]),
    code: z.string().max(64).nullable(),
  }),
]);

/**
 * An in-memory provider for tests and local development. It behaves like a real provider would at the
 * adapter boundary and, deliberately, like the STRONGEST kind: its webhook signature covers the timestamp
 * AND the raw body (HMAC-SHA256 over `${timestamp}.${rawBody}`), compared in constant time, with a
 * freshness window. It stores "received" mail, records "sent" mail, and can inject failures.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  /** Every request is signed fresh by the test helpers, so retries are re-signed. */
  readonly replay = {
    freshnessSeconds: WEBHOOK_MAX_AGE_SECONDS,
    retryHorizonSeconds: 0,
    retriesResigned: true,
  } as const;
  readonly secret: string;
  /** Mail the "provider" received, by provider reference. */
  readonly mailbox = new Map<string, NormalizedInboundEmail>();
  /** Every email accepted for sending (a repeated idempotency key adds nothing). */
  readonly sent: (OutboundEmail & { providerMessageId: string })[] = [];
  readonly ensured: string[] = [];
  /** Addresses `ensureAddress` refuses (code "provider_rejected"). */
  rejectAddresses = new Set<string>();
  private readonly byKey = new Map<string, string>();
  /**
   * What the fake promises about duplicate sends. Mutable so a test can model a provider with no idempotency
   * and no lookup (the case that must end in UNKNOWN). The defaults model a well-behaved provider; they say
   * nothing about any real one.
   */
  sending: SendingCapabilities = sendingCapabilities();
  /** A test double is never "verified": production refuses it (see `provider-policy.ts`). */
  readonly readiness: ProviderReadiness = { status: "fake", evidence: null };
  /** The fake's clock (injectable, so lookup lag and late acceptance are deterministic). */
  now: () => Date = () => new Date();
  /** Eventual consistency: an accepted send is invisible to `findSendByKey` for this long after acceptance. */
  lookupLagMs = 0;
  /** Set to make `findSendByKey` fail (the lookup itself is unavailable). */
  lookupUnavailable = false;
  /** When each key was accepted (for `lookupLagMs`). */
  private readonly acceptedAt = new Map<string, Date>();
  /** Requests that timed out at the platform but that the "provider" will still accept (see `lateAcceptNextSend`). */
  private readonly pendingLate: OutboundEmail[] = [];
  /** `AbortSignal`s the platform handed to `sendEmail` that were aborted (it stopped waiting). */
  abortedCalls = 0;
  /** Number of `sendEmail` calls that reached the "provider" (including failed and ambiguous ones). */
  sendCalls = 0;
  private failures: (
    | { kind: "failure"; retryable: boolean; code: string }
    | { kind: "ambiguous"; delivered: boolean; code: string }
    | { kind: "hang"; delivered: boolean }
    | { kind: "late" }
  )[] = [];

  constructor(secret: string = randomBytes(24).toString("hex")) {
    this.secret = secret;
  }

  async ensureAddress(address: string): Promise<AddressCheck> {
    if (this.rejectAddresses.has(address)) return { ok: false, code: "provider_rejected" };
    this.ensured.push(address);
    return { ok: true };
  }

  verifyWebhook(input: {
    headers: Record<string, string>;
    rawBody: string;
    now?: Date;
  }): VerifiedWebhook {
    const headers = Object.fromEntries(
      Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const timestamp = headers["x-fake-timestamp"];
    const signature = headers["x-fake-signature"];
    if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
      return { ok: false, reason: "malformed" };
    }

    const expected = this.sign(timestamp, input.rawBody);
    const given = Buffer.from(signature, "hex");
    const wanted = Buffer.from(expected, "hex");
    // Constant time, and a different length is simply a mismatch (timingSafeEqual would throw).
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      return { ok: false, reason: "bad_signature" };
    }

    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_MAX_AGE_SECONDS) {
      return { ok: false, reason: "stale" };
    }

    let json: unknown;
    try {
      json = JSON.parse(input.rawBody);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const parsed = webhookBody.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "malformed" };

    const body = parsed.data;
    if (body.type === "inbound") {
      return { ok: true, kind: "inbound", providerRef: body.ref, replayKey: `fake:${body.id}` };
    }
    const event: DeliveryEvent = {
      eventId: body.id,
      providerMessageId: body.providerMessageId,
      type: body.event,
      code: body.code,
      occurredAt: new Date(Number(timestamp) * 1000),
    };
    return { ok: true, kind: "delivery", event, replayKey: `fake:${body.id}` };
  }

  async fetchInboundEmail(providerRef: string): Promise<NormalizedInboundEmail | null> {
    const stored = this.mailbox.get(providerRef);
    if (!stored) return null;
    // Defense in depth: even the fake hands out only data that passes the platform's schema.
    return normalizedInboundEmailSchema.parse(stored);
  }

  async sendEmail(message: OutboundEmail, options?: { signal?: AbortSignal }): Promise<SendResult> {
    // Aborting the signal drops OUR side of the call. Like a real socket close it does not undo what the provider read.
    options?.signal?.addEventListener("abort", () => (this.abortedCalls += 1), { once: true });
    for (const [name, value] of [
      ["From", message.from.name],
      ["Subject", message.subject],
      ["Message-ID", message.messageId],
      ["In-Reply-To", message.inReplyTo ?? ""],
      ...message.references.map((reference) => ["References", reference] as const),
    ] as const) {
      try {
        assertSafeHeaderValue(name, value);
      } catch {
        return { ok: false, retryable: false, code: "unsafe_header" };
      }
    }

    this.sendCalls += 1;
    const planned = this.failures.shift();
    if (planned?.kind === "failure") {
      return { ok: false, retryable: planned.retryable, code: planned.code };
    }
    if (planned?.kind === "late") {
      // The request is in flight: the provider will accept it LATER (`completeLateAcceptances`); nobody is told now.
      this.pendingLate.push(message);
      return new Promise<SendResult>(() => undefined);
    }
    if (planned?.kind === "ambiguous" || planned?.kind === "hang") {
      // The request reached the "provider", which may have accepted it, but the answer is lost.
      if (planned.delivered) this.accept(message);
      if (planned.kind === "hang") return new Promise<SendResult>(() => undefined); // never answers
      return { ok: false, ambiguous: true, code: planned.code };
    }

    const existing = this.byKey.get(message.idempotencyKey);
    // A provider WITHOUT idempotency delivers a repeat again: that is what makes a blind resend dangerous.
    if (existing && this.sending.idempotentByKey) return { ok: true, providerMessageId: existing };
    return { ok: true, providerMessageId: this.accept(message) };
  }

  /** The provider accepts (delivers) a message. Without idempotency every call adds a delivery. */
  private accept(message: OutboundEmail): string {
    const existing = this.byKey.get(message.idempotencyKey);
    if (existing && this.sending.idempotentByKey) return existing;
    const providerMessageId = `fake-${randomUUID()}`;
    this.byKey.set(message.idempotencyKey, providerMessageId);
    this.acceptedAt.set(message.idempotencyKey, this.now());
    this.sent.push({ ...message, providerMessageId });
    return providerMessageId;
  }

  async findSendByKey(idempotencyKey: string): Promise<SendLookup> {
    if (this.lookupUnavailable) return { status: "unavailable" };
    const found = this.byKey.get(idempotencyKey);
    const since = this.acceptedAt.get(idempotencyKey);
    // Eventual consistency: an accepted send is not visible yet.
    if (found && since && this.now().getTime() - since.getTime() < this.lookupLagMs) {
      return { status: "not_found" };
    }
    return found ? { status: "found", providerMessageId: found } : { status: "not_found" };
  }

  // ---- test helpers (not part of the EmailProvider interface) --------------------------------------

  /** The next `sendEmail` call fails with this classification. Calls queue up. */
  failNextSend(failure: { retryable: boolean; code?: string }) {
    this.failures.push({
      kind: "failure",
      retryable: failure.retryable,
      code: failure.code ?? "provider_error",
    });
  }

  /**
   * The next `sendEmail` call is AMBIGUOUS: the answer is lost. `delivered` says what really happened at the
   * "provider" (true = it accepted and would deliver the message), so a test can check both worlds.
   */
  ambiguousNextSend(options: { delivered: boolean; code?: string }) {
    this.failures.push({
      kind: "ambiguous",
      delivered: options.delivered,
      code: options.code ?? "timeout",
    });
  }

  /** The next `sendEmail` call never answers (a hung connection); `delivered` as for `ambiguousNextSend`. */
  hangNextSend(options: { delivered: boolean }) {
    this.failures.push({ kind: "hang", delivered: options.delivered });
  }

  /**
   * The next `sendEmail` call never answers, and the "provider" accepts it only LATER, when the test calls
   * `completeLateAcceptances()` (a request that outlives the platform's timeout and lands afterwards).
   */
  lateAcceptNextSend() {
    this.failures.push({ kind: "late" });
  }

  /** The late requests land now: each is accepted (or refused as a duplicate, when the provider is idempotent). */
  completeLateAcceptances(): number {
    const landed = this.pendingLate.splice(0);
    for (const message of landed) this.accept(message);
    return landed.length;
  }

  sign(timestamp: string, rawBody: string): string {
    return createHmac("sha256", this.secret).update(`${timestamp}.${rawBody}`).digest("hex");
  }

  /** A correctly signed webhook request, as the provider would send it. */
  signedWebhook(
    body: z.input<typeof webhookBody>,
    at: Date = new Date(),
  ): { headers: Record<string, string>; rawBody: string } {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(at.getTime() / 1000));
    return {
      headers: { "x-fake-timestamp": timestamp, "x-fake-signature": this.sign(timestamp, rawBody) },
      rawBody,
    };
  }

  /** "Receives" an email: stores it and returns the signed inbound notification for it. */
  receive(email: NormalizedInboundEmail, at: Date = new Date()) {
    const ref = `ref-${randomUUID()}`;
    this.mailbox.set(ref, email);
    return { ref, webhook: this.signedWebhook({ type: "inbound", id: randomUUID(), ref }, at) };
  }
}
