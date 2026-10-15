import { isUniqueViolation } from "@/db/errors";
import { collapseWhitespace } from "@/features/customers/normalize";
import type { EmailAddressInput } from "@/features/email/schemas";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { buildSupportAddress, checkLocalPart, isSafeHeaderValue } from "./address";
import { emailAvailable, getEmailPlatformDomain, getEmailProvider } from "./index";

const log = createLogger("email");

/** What staff see. No provider details, no secrets, nothing about other organizations. */
export type EmailSettingsDto = {
  /** The deployment has a provider and a platform domain: email can be set up at all. */
  available: boolean;
  platformDomain: string | null;
  enabled: boolean;
  status: "UNCONFIGURED" | "PENDING_VERIFICATION" | "ACTIVE" | "FAILED";
  /** Short machine code of the last verification failure. */
  statusDetail: string | null;
  localPart: string | null;
  supportAddress: string | null;
  fromName: string | null;
  /** A starting point for the address name, from the organization's slug. */
  suggestedLocalPart: string;
};

function suggestLocalPart(slug: string): string {
  const candidate = checkLocalPart(slug);
  return candidate.ok ? candidate.value : "support";
}

async function load(ctx: OrganizationContext): Promise<EmailSettingsDto> {
  const row = await emailSettingsRepository.findByOrganization(ctx.organization.id);
  return {
    available: emailAvailable(),
    platformDomain: getEmailPlatformDomain(),
    enabled: row?.enabled ?? false,
    status: row?.status ?? "UNCONFIGURED",
    statusDetail: row?.statusDetail ?? null,
    localPart: row?.localPart ?? null,
    supportAddress: row?.supportAddress ?? null,
    fromName: row?.fromName ?? null,
    suggestedLocalPart: suggestLocalPart(ctx.organization.slug),
  };
}

/**
 * Email is OFF by default: with no row nothing is enabled, and reading never creates one. All of these
 * need `manage_email` (ADMIN/OWNER) and act on the caller's own organization only.
 */
export async function getEmailSettings(ctx: OrganizationContext): Promise<EmailSettingsDto> {
  ctx.require("manage_email");
  return load(ctx);
}

/**
 * Chooses the organization's support address (`<name>@<platform domain>`) and the sender display name. A
 * new address starts unverified and disabled; changing only the display name keeps the verification.
 */
export async function saveEmailAddress(
  ctx: OrganizationContext,
  input: EmailAddressInput,
): Promise<EmailSettingsDto> {
  ctx.require("manage_email");
  const organizationId = ctx.organization.id;
  const domain = getEmailPlatformDomain();
  if (!emailAvailable() || !domain) {
    throw new ConflictError("Email is not available on this platform yet");
  }

  const local = checkLocalPart(input.localPart);
  if (!local.ok) {
    throw new ValidationError(
      local.reason === "reserved"
        ? "That address name is reserved. Choose another."
        : "Use 1-32 lowercase letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.",
    );
  }
  // Checked BEFORE whitespace is collapsed, so a line break is refused instead of quietly turned into a space.
  const fromName = collapseWhitespace(input.fromName);
  if (!fromName || !isSafeHeaderValue(input.fromName)) {
    throw new ValidationError("The sender name cannot contain line breaks or control characters");
  }
  const supportAddress = buildSupportAddress(local.value, domain);
  if (!supportAddress) throw new ConflictError("Email is not available on this platform yet");

  const existing = await emailSettingsRepository.findByOrganization(organizationId);
  try {
    if (!existing) {
      await emailSettingsRepository.create({
        organizationId,
        localPart: local.value,
        supportAddress,
        fromName,
      });
    } else if (existing.supportAddress === supportAddress) {
      await emailSettingsRepository.updateFromName(organizationId, fromName);
    } else {
      await emailSettingsRepository.changeAddress(organizationId, {
        localPart: local.value,
        supportAddress,
        fromName,
      });
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Either another organization owns that address, or two admins saved first at the same moment.
      const row = await emailSettingsRepository.findByOrganization(organizationId);
      if (row?.supportAddress === supportAddress) return load(ctx);
      throw new ConflictError("That address is already taken. Choose another.");
    }
    throw error;
  }
  log.info({ organizationId, actorId: ctx.user.id }, "email address saved");
  return load(ctx);
}

/**
 * Asks the provider to confirm the address. ACTIVE on success; FAILED with a short code otherwise. A
 * failure never exposes provider output and switches the integration off.
 */
export async function verifyEmailAddress(ctx: OrganizationContext): Promise<EmailSettingsDto> {
  ctx.require("manage_email");
  const organizationId = ctx.organization.id;
  const provider = getEmailProvider();
  if (!provider || !emailAvailable()) {
    throw new ConflictError("Email is not available on this platform yet");
  }
  const row = await emailSettingsRepository.findByOrganization(organizationId);
  if (!row) throw new NotFoundError("Choose an address first");

  let code: string | null = null;
  try {
    const result = await provider.ensureAddress(row.supportAddress);
    if (!result.ok) code = /^[a-z0-9_]{1,64}$/.test(result.code) ? result.code : "provider_error";
  } catch (error) {
    log.warn(
      { organizationId, err: error instanceof Error ? error.name : "unknown" },
      "email address verification failed",
    );
    code = "provider_error";
  }

  await emailSettingsRepository.setStatus(
    organizationId,
    code === null ? "ACTIVE" : "FAILED",
    code,
  );
  log.info({ organizationId, actorId: ctx.user.id, ok: code === null }, "email address verified");
  return load(ctx);
}

/** Turns the integration on (only for a verified address) or off. */
export async function setEmailEnabled(
  ctx: OrganizationContext,
  enabled: boolean,
): Promise<EmailSettingsDto> {
  ctx.require("manage_email");
  const organizationId = ctx.organization.id;
  const row = await emailSettingsRepository.findByOrganization(organizationId);
  if (!row) throw new NotFoundError("Choose an address first");
  if (enabled && !emailAvailable()) {
    throw new ConflictError("Email is not available on this platform yet");
  }
  const applied = await emailSettingsRepository.setEnabled(organizationId, enabled);
  if (!applied) throw new ConflictError("Verify the address before turning email on");
  log.info({ organizationId, actorId: ctx.user.id, enabled }, "email enabled changed");
  return load(ctx);
}
