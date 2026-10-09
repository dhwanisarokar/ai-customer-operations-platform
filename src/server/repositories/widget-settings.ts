import { getDb, type Db } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

const settingsSelect = {
  id: true,
  organizationId: true,
  publicKey: true,
  enabled: true,
  displayName: true,
  welcomeMessage: true,
  accentColor: true,
  allowedOrigins: true,
  aiRepliesEnabled: true,
  updatedAt: true,
} satisfies Prisma.WidgetSettingsSelect;

export type WidgetSettingsRecord = Prisma.WidgetSettingsGetPayload<{
  select: typeof settingsSelect;
}>;

export type WidgetSettingsData = {
  enabled: boolean;
  displayName: string;
  welcomeMessage: string;
  accentColor: string | null;
  allowedOrigins: string[];
  /** Omitted on update = unchanged. New settings start with it off. */
  aiRepliesEnabled?: boolean;
};

export const widgetSettingsRepository = {
  findByOrganization(organizationId: string, db: Db = getDb()) {
    return db.widgetSettings.findUnique({ where: { organizationId }, select: settingsSelect });
  },

  /** Public lookup by the embedded key. The only way an anonymous caller selects an organization. */
  findByPublicKey(publicKey: string, db: Db = getDb()) {
    return db.widgetSettings.findUnique({ where: { publicKey }, select: settingsSelect });
  },

  create(organizationId: string, publicKey: string, data: WidgetSettingsData, db: Db = getDb()) {
    return db.widgetSettings.create({
      data: { organizationId, publicKey, ...data },
      select: settingsSelect,
    });
  },

  update(organizationId: string, data: WidgetSettingsData, db: Db = getDb()) {
    return db.widgetSettings.update({
      where: { organizationId },
      data: {
        ...data,
        ...(data.aiRepliesEnabled === undefined ? {} : { aiRepliesEnabled: data.aiRepliesEnabled }),
        updatedAt: new Date(),
      },
      select: settingsSelect,
    });
  },
};
