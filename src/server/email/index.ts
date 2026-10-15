import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { metrics } from "@/server/observability/metrics";
import { FakeEmailProvider } from "./fake-provider";
import { assessProvider } from "./provider-policy";
import type { EmailProvider } from "./provider";

const log = createLogger("email-provider");

let provider: EmailProvider | undefined;

/**
 * The deployment's email provider, chosen by `EMAIL_PROVIDER`; null when none is configured (the email
 * integration is then unavailable and every organization stays on "off"). Services call this, never an
 * adapter directly.
 */
export function getEmailProvider(): EmailProvider | null {
  if (provider) return provider;
  const env = getServerEnv();
  if (env.EMAIL_PROVIDER === "fake") provider = new FakeEmailProvider();
  return provider ?? null;
}

const reported = new WeakMap<object, string>();

/**
 * The provider that may SEND mail: the configured one, only when `assessProvider` accepts its declared capabilities and
 * readiness in this environment. A provider that is refused is never used in a weaker mode: outbound email is simply
 * unavailable (nothing is queued, nothing is sent) and the reasons are logged once and counted. Inbound handling and
 * address setup keep using `getEmailProvider()`.
 */
export function getSendingProvider(): EmailProvider | null {
  const candidate = getEmailProvider();
  if (!candidate) return null;
  const assessment = assessProvider(candidate, {
    production: getServerEnv().NODE_ENV === "production",
  });
  if (assessment.ok) return candidate;
  const signature = assessment.reasons.join(",");
  if (reported.get(candidate) !== signature) {
    reported.set(candidate, signature);
    log.error(
      { provider: candidate.name, reasons: assessment.reasons },
      "the email provider is refused for sending; outbound email is unavailable",
    );
  }
  for (const reason of assessment.reasons) {
    metrics.increment("email_provider_rejected_total", { reason });
  }
  return null;
}

/** The domain organizations' support addresses live on, or null when the platform has none configured. */
export function getEmailPlatformDomain(): string | null {
  return getServerEnv().EMAIL_PLATFORM_DOMAIN ?? null;
}

/** Email can only be set up when both a provider and a platform domain are configured. */
export function emailAvailable(): boolean {
  return getEmailProvider() !== null && getEmailPlatformDomain() !== null;
}

/** Test hook: swap the provider (or pass undefined to reset). */
export function setEmailProviderForTesting(next: EmailProvider | undefined): void {
  provider = next;
}

export type { EmailProvider } from "./provider";
