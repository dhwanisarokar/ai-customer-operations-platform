import { NextResponse } from "next/server";
import { widgetSessionRequestSchema } from "@/features/widget/schemas";
import { apiHandler } from "@/server/http/handler";
import { clientIp, enforceRateLimit } from "@/server/rate-limit";
import { bearerToken, parsePublicBody } from "@/server/widget/http";
import { WIDGET_LIMITS } from "@/server/widget/route";
import { openVisitorSession } from "@/server/widget/session";

/**
 * Starts or resumes an anonymous visitor session from the PUBLIC widget key. The response never
 * contains an organization id: the client only learns its session and how to render the widget.
 */
export const POST = apiHandler(async (request) => {
  const ip = clientIp(request);
  const token = bearerToken(request);
  await enforceRateLimit(`widget-session-resume:ip:${ip}`, WIDGET_LIMITS.sessionResumePerIp);
  const body = await parsePublicBody(request, widgetSessionRequestSchema);

  // Creating sessions is the expensive, abusable path: limit it harder than resuming.
  if (!token) await enforceRateLimit(`widget-session:ip:${ip}`, WIDGET_LIMITS.sessionsPerIp);

  const result = await openVisitorSession({
    key: body.key,
    embedOrigin: body.embedOrigin,
    token,
  });
  return NextResponse.json({
    token: result.token,
    session: { id: result.sessionId, expiresAt: result.expiresAt.toISOString() },
    widget: {
      displayName: result.widget.displayName,
      welcomeMessage: result.widget.welcomeMessage,
      accentColor: result.widget.accentColor,
    },
  });
});
