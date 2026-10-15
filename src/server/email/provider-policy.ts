import { reconciliationMode, requiredKeyRetentionMs, settleWindowMs } from "./outbound-state";
import type { EmailProvider, SendingCapabilities } from "./provider";

/**
 * The provider capability policy (Phase 9.6): which providers may SEND mail at all. A provider is refused, never
 * silently downgraded, when its declarations are inconsistent, too weak to build a safe retry on, or (in production)
 * not verified. Pure: the caller supplies the environment facts.
 *
 * What the checks do NOT do: they cannot know whether a declaration is TRUE. They only make a false or sloppy one
 * impossible to hide behind defaults. Truth comes from the evidence a person attaches (`readiness.evidence`, see
 * docs/email-provider-readiness.md) and from the fake provider's tests proving only that the PLATFORM reacts correctly
 * to what a provider declares, never that a real provider behaves that way.
 */

/** "Not found" is only useful for operators if the lookup still remembers for a while after the settle window. */
export const MIN_LOOKUP_RETENTION_AFTER_SETTLE_MS = 60 * 60 * 1000;

export type CapabilityProblem =
  | "invalid_duration"
  | "idempotent_retention_unknown"
  | "idempotent_retention_too_short"
  | "lookup_consistency_unspecified"
  | "lookup_consistency_without_lookup"
  | "lookup_retention_unknown"
  | "lookup_retention_too_short"
  | "lookup_settle_unknown"
  | "late_acceptance_ceiling_unknown";

const DURATION_FIELDS = [
  "keyRetentionMs",
  "lookupSettleMs",
  "lookupRetentionMs",
  "lateAcceptanceCeilingMs",
] as const satisfies readonly (keyof SendingCapabilities)[];

/** Everything wrong with a provider's declared sending capabilities (empty = internally consistent and usable). */
export function capabilityProblems(c: SendingCapabilities): CapabilityProblem[] {
  const problems = new Set<CapabilityProblem>();
  for (const field of DURATION_FIELDS) {
    const value = c[field];
    if (value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      problems.add("invalid_duration");
    }
  }
  if (c.idempotentByKey) {
    if (c.keyRetentionMs === null) problems.add("idempotent_retention_unknown");
    else if (c.keyRetentionMs < requiredKeyRetentionMs()) {
      problems.add("idempotent_retention_too_short");
    }
  }
  if (c.lookupByKey) {
    if (c.lookupConsistency === "none") problems.add("lookup_consistency_unspecified");
    if (c.lookupRetentionMs === null || c.lookupRetentionMs <= 0) {
      problems.add("lookup_retention_unknown");
    }
    if (
      c.lookupConsistency === "eventual" &&
      !(c.lookupSettleMs !== null && c.lookupSettleMs > 0)
    ) {
      problems.add("lookup_settle_unknown");
    }
    // A lookup-only provider (no usable idempotency) needs the late-acceptance bound; an idempotent one does not.
    if (c.lateAcceptanceCeilingMs === null && reconciliationMode(c) !== "idempotent") {
      problems.add("late_acceptance_ceiling_unknown");
    }
    if (
      c.lookupRetentionMs !== null &&
      c.lookupRetentionMs > 0 &&
      c.lookupRetentionMs < settleWindowMs(c) + MIN_LOOKUP_RETENTION_AFTER_SETTLE_MS
    ) {
      problems.add("lookup_retention_too_short");
    }
  } else if (c.lookupConsistency !== "none") {
    problems.add("lookup_consistency_without_lookup");
  }
  return [...problems];
}

export type ProviderRejection =
  CapabilityProblem | "fake_in_production" | "not_verified_for_production";

export type ProviderAssessment =
  | {
      ok: true;
      /** How an ambiguous send is resolved with this provider: see `reconciliationMode`. */
      mode: "idempotent" | "lookup" | "none";
      readiness: EmailProvider["readiness"]["status"];
    }
  | { ok: false; reasons: ProviderRejection[] };

/** Decides whether `provider` may send mail in this environment. */
export function assessProvider(
  provider: Pick<EmailProvider, "name" | "sending" | "readiness">,
  environment: { production: boolean },
): ProviderAssessment {
  const reasons: ProviderRejection[] = [...capabilityProblems(provider.sending)];
  if (environment.production) {
    if (provider.readiness.status === "fake" || provider.name === "fake") {
      reasons.push("fake_in_production");
    } else if (provider.readiness.status !== "verified" || !provider.readiness.evidence?.trim()) {
      reasons.push("not_verified_for_production");
    }
  }
  return reasons.length > 0
    ? { ok: false, reasons }
    : {
        ok: true,
        mode: reconciliationMode(provider.sending),
        readiness: provider.readiness.status,
      };
}
