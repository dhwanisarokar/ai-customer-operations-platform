import { isUniqueViolation } from "@/db/errors";
import type { WidgetSettingsInput } from "@/features/widget/schemas";
import { aiProviderAvailable } from "@/server/ai/client";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import {
  widgetSettingsRepository,
  type WidgetSettingsRecord,
} from "@/server/repositories/widget-settings";
import { generatePublicKey } from "./keys";

const log = createLogger("widget");

export type WidgetSettingsDto = Omit<WidgetSettingsRecord, "id" | "organizationId">;

function toDto(record: WidgetSettingsRecord): WidgetSettingsDto {
  return {
    publicKey: record.publicKey,
    enabled: record.enabled,
    displayName: record.displayName,
    welcomeMessage: record.welcomeMessage,
    accentColor: record.accentColor,
    allowedOrigins: record.allowedOrigins,
    aiRepliesEnabled: record.aiRepliesEnabled,
    updatedAt: record.updatedAt,
  };
}

/**
 * The organization's widget settings, created disabled on first use (with a fresh public key). Only
 * ADMIN/OWNER (`manage_widget`) can read or change them; the organization always comes from the
 * authenticated context.
 */
export async function getWidgetSettings(ctx: OrganizationContext): Promise<WidgetSettingsDto> {
  ctx.require("manage_widget");
  const organizationId = ctx.organization.id;
  const existing = await widgetSettingsRepository.findByOrganization(organizationId);
  if (existing) return toDto(existing);
  try {
    const created = await widgetSettingsRepository.create(organizationId, generatePublicKey(), {
      enabled: false,
      displayName: ctx.organization.name.slice(0, 60),
      welcomeMessage: "Hi! How can we help you today?",
      accentColor: null,
      allowedOrigins: [],
    });
    log.info({ organizationId, actorId: ctx.user.id }, "widget settings created");
    return toDto(created);
  } catch (error) {
    // Two admins opened the page at once: the other one created it.
    if (isUniqueViolation(error)) {
      const other = await widgetSettingsRepository.findByOrganization(organizationId);
      if (other) return toDto(other);
    }
    throw error;
  }
}

export async function updateWidgetSettings(
  ctx: OrganizationContext,
  input: WidgetSettingsInput,
): Promise<WidgetSettingsDto> {
  await getWidgetSettings(ctx); // checks permission and ensures the row exists
  const updated = await widgetSettingsRepository.update(ctx.organization.id, input);
  log.info(
    { organizationId: ctx.organization.id, actorId: ctx.user.id, enabled: updated.enabled },
    "widget settings updated",
  );
  return toDto(updated);
}

/** What the browser may learn about a widget. No organization id, no internal data. */
export type PublicWidgetConfig = {
  publicKey: string;
  displayName: string;
  welcomeMessage: string;
  accentColor: string | null;
  /** The assistant answers automatically (until a person takes over). Display only. */
  aiEnabled: boolean;
};

export function toPublicConfig(settings: WidgetSettingsRecord): PublicWidgetConfig {
  return {
    publicKey: settings.publicKey,
    displayName: settings.displayName,
    welcomeMessage: settings.welcomeMessage,
    accentColor: settings.accentColor,
    aiEnabled: settings.aiRepliesEnabled && aiProviderAvailable(),
  };
}

/** Public config for the widget page: only for an ENABLED widget (unknown and disabled look alike). */
export async function getPublicWidgetConfig(publicKey: string): Promise<PublicWidgetConfig | null> {
  const settings = await widgetSettingsRepository.findByPublicKey(publicKey);
  return settings?.enabled ? toPublicConfig(settings) : null;
}
