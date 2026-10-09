import { createLogger } from "@/lib/logger";
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/server/errors";
import {
  visitorSessionsRepository,
  type VisitorSessionRecord,
} from "@/server/repositories/visitor-sessions";
import { widgetSettingsRepository } from "@/server/repositories/widget-settings";
import { generateSessionToken, hashToken, SESSION_TTL_MS, TOUCH_INTERVAL_MS } from "./keys";
import { toPublicConfig, type PublicWidgetConfig } from "./settings";

const log = createLogger("widget");

/**
 * The visitor boundary. A visitor session is NOT a user: it has an organization (fixed when the
 * session was created from the public widget key), maybe a customer (chosen by the server), and a
 * bearer token. It can only reach its own conversations through the /api/widget API.
 */
export type VisitorContext = {
  session: VisitorSessionRecord;
  organizationId: string;
  widget: PublicWidgetConfig;
};

const unavailable = () => new NotFoundError("Chat is not available");

function isLive(session: VisitorSessionRecord, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt > now;
}

/** The website embedding the widget, normalized, or null when it is missing or not a URL. */
export function normalizeEmbedOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Starts (or resumes) a visitor session from the PUBLIC widget key. The organization is derived from
 * the key on the server. With a valid existing token for the same widget the session is reused
 * (`token: null`: the client keeps the token it has); otherwise a new one is created and its token is
 * returned exactly once.
 */
export async function openVisitorSession(input: {
  key: string;
  embedOrigin?: string;
  token?: string | null;
  now?: Date;
}): Promise<{
  token: string | null;
  sessionId: string;
  expiresAt: Date;
  widget: PublicWidgetConfig;
}> {
  const now = input.now ?? new Date();
  const settings = await widgetSettingsRepository.findByPublicKey(input.key);
  if (!settings || !settings.enabled) throw unavailable();

  // Embedding policy (not authentication): when the organization listed websites, only they may embed.
  if (settings.allowedOrigins.length > 0) {
    const origin = normalizeEmbedOrigin(input.embedOrigin);
    if (!origin || !settings.allowedOrigins.includes(origin)) {
      log.warn({ organizationId: settings.organizationId }, "widget embed origin not allowed");
      throw new AppError(
        403,
        "origin_not_allowed",
        "This website is not allowed to show this chat",
      );
    }
  }

  if (input.token) {
    const existing = await visitorSessionsRepository.findByTokenHash(hashToken(input.token));
    // A session of another organization's widget is never reused for this key.
    if (existing && existing.organizationId === settings.organizationId && isLive(existing, now)) {
      await touch(existing, now);
      return {
        token: null,
        sessionId: existing.id,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        widget: toPublicConfig(settings),
      };
    }
  }

  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const session = await visitorSessionsRepository.create(settings.organizationId, {
    tokenHash: hashToken(token),
    expiresAt,
  });
  log.info(
    { organizationId: settings.organizationId, visitorSessionId: session.id },
    "visitor session created",
  );
  return { token, sessionId: session.id, expiresAt, widget: toPublicConfig(settings) };
}

/**
 * Authenticates a visitor request from its bearer token. Unknown, expired and revoked tokens are all
 * 401 (the widget then starts a new session); a widget the organization disabled is 403.
 */
export async function authenticateVisitor(
  token: string,
  now: Date = new Date(),
): Promise<VisitorContext> {
  const session = await visitorSessionsRepository.findByTokenHash(hashToken(token));
  if (!session || !isLive(session, now)) {
    throw new UnauthorizedError("Your chat session has expired");
  }
  const settings = await widgetSettingsRepository.findByOrganization(session.organizationId);
  if (!settings || !settings.enabled) {
    throw new ForbiddenError("Chat is currently unavailable");
  }
  await touch(session, now);
  return { session, organizationId: session.organizationId, widget: toPublicConfig(settings) };
}

/** Sliding expiry, written at most once a minute so reads stay cheap. */
async function touch(session: VisitorSessionRecord, now: Date) {
  if (now.getTime() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  await visitorSessionsRepository.touch(session.id, now, new Date(now.getTime() + SESSION_TTL_MS));
}
