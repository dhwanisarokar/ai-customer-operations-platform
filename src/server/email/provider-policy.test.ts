import { describe, expect, it } from "vitest";
import { FakeEmailProvider, NO_SENDING_GUARANTEES, sendingCapabilities } from "./fake-provider";
import { requiredKeyRetentionMs } from "./outbound-state";
import {
  MIN_LOOKUP_RETENTION_AFTER_SETTLE_MS,
  assessProvider,
  capabilityProblems,
} from "./provider-policy";
import type { EmailProvider, ProviderReadiness } from "./provider";

const MIN = 60_000;
const lookupOnly = sendingCapabilities({
  idempotentByKey: false,
  keyRetentionMs: null,
  lookupConsistency: "eventual",
  lookupSettleMs: 2 * MIN,
  lateAcceptanceCeilingMs: 3 * MIN,
  lookupRetentionMs: 24 * 60 * MIN,
});

const provider = (
  sending = sendingCapabilities(),
  readiness: ProviderReadiness = { status: "declared", evidence: null },
  name = "acme-mail",
): Pick<EmailProvider, "name" | "sending" | "readiness"> => ({ name, sending, readiness });

describe("capabilityProblems: declarations must be consistent and usable", () => {
  it("accepts the shapes that can be operated safely", () => {
    expect(capabilityProblems(sendingCapabilities())).toEqual([]); // idempotent + strong lookup
    expect(capabilityProblems(lookupOnly)).toEqual([]);
    expect(capabilityProblems(NO_SENDING_GUARANTEES)).toEqual([]); // promises nothing: every ambiguity is UNKNOWN
    expect(
      capabilityProblems(
        sendingCapabilities({
          lookupByKey: false,
          lookupConsistency: "none",
          lookupSettleMs: null,
          lookupRetentionMs: null,
          lateAcceptanceCeilingMs: null,
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "idempotent without a stated key memory",
      { keyRetentionMs: null },
      "idempotent_retention_unknown",
    ],
    [
      "idempotent with a key memory shorter than the retry horizon",
      { keyRetentionMs: requiredKeyRetentionMs() - 1 },
      "idempotent_retention_too_short",
    ],
    [
      "a lookup with no stated consistency",
      { lookupConsistency: "none" as const },
      "lookup_consistency_unspecified",
    ],
    ["a lookup with no stated retention", { lookupRetentionMs: null }, "lookup_retention_unknown"],
    ["a lookup that remembers nothing", { lookupRetentionMs: 0 }, "lookup_retention_unknown"],
    [
      "an eventual lookup with no stated lag",
      { ...lookupOnly, lookupSettleMs: null },
      "lookup_settle_unknown",
    ],
    [
      "a lookup-only provider with no bound on late acceptance",
      { ...lookupOnly, lateAcceptanceCeilingMs: null },
      "late_acceptance_ceiling_unknown",
    ],
    [
      "a lookup that forgets before an operator could use it",
      { ...lookupOnly, lookupRetentionMs: 5 * MIN + MIN_LOOKUP_RETENTION_AFTER_SETTLE_MS - 1 },
      "lookup_retention_too_short",
    ],
    [
      "a consistency declared for a lookup that does not exist",
      {
        lookupByKey: false,
        lookupConsistency: "strong" as const,
        lookupRetentionMs: null,
        lookupSettleMs: null,
      },
      "lookup_consistency_without_lookup",
    ],
    ["a negative duration", { lateAcceptanceCeilingMs: -1 }, "invalid_duration"],
    ["a non-finite duration", { lookupRetentionMs: Number.POSITIVE_INFINITY }, "invalid_duration"],
  ])("rejects %s", (_label, patch, problem) => {
    const base = problem.startsWith("idempotent") ? sendingCapabilities() : lookupOnly;
    expect(capabilityProblems({ ...base, ...patch })).toContain(problem);
  });

  it("an idempotent provider does not need a late-acceptance bound (a duplicate is refused by the provider)", () => {
    expect(capabilityProblems(sendingCapabilities({ lateAcceptanceCeilingMs: null }))).toEqual([]);
  });
});

describe("assessProvider: unsafe configurations are refused, never downgraded", () => {
  const dev = { production: false };
  const prod = { production: true };

  it("reports how ambiguity will be resolved with an accepted provider", () => {
    expect(assessProvider(provider(), dev)).toEqual({
      ok: true,
      mode: "idempotent",
      readiness: "declared",
    });
    expect(assessProvider(provider(lookupOnly), dev)).toMatchObject({ ok: true, mode: "lookup" });
    expect(assessProvider(provider(NO_SENDING_GUARANTEES), dev)).toMatchObject({
      ok: true,
      mode: "none",
    });
  });

  it("refuses inconsistent declarations everywhere, listing every reason", () => {
    const result = assessProvider(
      provider(sendingCapabilities({ keyRetentionMs: null, lookupConsistency: "none" })),
      dev,
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reasons).toEqual(
      expect.arrayContaining(["idempotent_retention_unknown", "lookup_consistency_unspecified"]),
    );
  });

  it("the fake provider is fine in development and tests, and never in production", () => {
    const fake = new FakeEmailProvider("s");
    expect(assessProvider(fake, dev)).toMatchObject({ ok: true, readiness: "fake" });
    expect(assessProvider(fake, prod)).toEqual({ ok: false, reasons: ["fake_in_production"] });
    // Renaming it does not help: the readiness says what it is.
    expect(assessProvider({ ...fake, name: "acme-mail" }, prod)).toMatchObject({ ok: false });
  });

  it("in production only a VERIFIED provider with evidence is accepted: declared is not enough", () => {
    expect(assessProvider(provider(), prod)).toEqual({
      ok: false,
      reasons: ["not_verified_for_production"],
    });
    expect(
      assessProvider(
        provider(sendingCapabilities(), { status: "declared", evidence: "docs/x.md" }),
        prod,
      ),
    ).toMatchObject({ ok: false });
    expect(
      assessProvider(provider(sendingCapabilities(), { status: "verified", evidence: "  " }), prod),
    ).toMatchObject({ ok: false });
    expect(
      assessProvider(
        provider(sendingCapabilities(), {
          status: "verified",
          evidence: "docs/email-provider-acme.md",
        }),
        prod,
      ),
    ).toEqual({ ok: true, mode: "idempotent", readiness: "verified" });
  });

  it("a verified provider with an unsafe declaration is still refused", () => {
    expect(
      assessProvider(
        provider(sendingCapabilities({ keyRetentionMs: 1000 }), {
          status: "verified",
          evidence: "docs/email-provider-acme.md",
        }),
        prod,
      ),
    ).toMatchObject({ ok: false });
  });
});
