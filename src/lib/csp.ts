/**
 * Content-Security-Policy and baseline security headers, shared by `next.config.ts` (static headers) and `src/proxy.ts`
 * (per-request nonce policies). Pure functions: every rule is unit-tested in `csp.test.ts`.
 *
 * Two policies, because the application has two kinds of pages:
 *
 *  - the app (dashboard, portal, sign-in, API): behind Clerk. The policy is built by Clerk's own `contentSecurityPolicy`
 *    option in STRICT mode (a per-request nonce plus `strict-dynamic`, no `https:` / `http:` script allowlists), which
 *    already carries what Clerk's scripts, frames and API need. We only add what is ours: no framing at all, no plugins, a
 *    fixed `<base>`, `data:` images and Clerk's own Frontend API host.
 *  - the public chat widget (`/widget/*`): rendered inside an iframe on OTHER people's websites and deliberately free of
 *    Clerk. It gets its own nonce policy WITHOUT `frame-ancestors` (any site may embed it; WHICH sites may start a chat is
 *    enforced by the widget's allowed-websites check in `/api/widget/session`, not by the browser).
 *
 * Known, documented limits: `style-src` keeps `'unsafe-inline'` (React `style=` attributes, Tailwind runtime values and
 * Clerk's injected styles cannot be nonced); Clerk's defaults also list Stripe and Google Maps origins that this application
 * does not use (its merge cannot remove them). Neither lets a script run: `script-src` is nonce plus `strict-dynamic`.
 */

/** The Clerk Frontend API origin encoded in a publishable key (`pk_test_` / `pk_live_` + base64 of `host$`), or null. */
export function clerkFrontendOrigin(publishableKey: string | undefined): string | null {
  if (!publishableKey) return null;
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/_-]+={0,2})$/.exec(publishableKey);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const host = decoded.replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) && host.includes(".") ? `https://${host}` : null;
  } catch {
    return null;
  }
}

/** Directives we add to Clerk's strict policy for the app. */
type AppDirective = "frame-ancestors" | "object-src" | "base-uri" | "img-src" | "connect-src";

export function appCspDirectives(
  publishableKey: string | undefined,
): Partial<Record<AppDirective, string[]>> {
  const frontendApi = clerkFrontendOrigin(publishableKey);
  return {
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "img-src": ["data:", "blob:"],
    // Clerk's browser SDK talks to its Frontend API (a *.clerk.accounts.dev host in development, your own domain in production).
    "connect-src": frontendApi ? [frontendApi] : [],
  };
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** The policy of the public widget page: nonce plus strict-dynamic, same-origin everything, embeddable anywhere. */
export function widgetCsp(nonce: string, options: { development?: boolean } = {}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(options.development ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    // No frame-ancestors on purpose: the widget exists to be embedded.
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

export type SecurityHeader = { key: string; value: string };

/** Headers safe on every response (the widget iframe included). */
export function baselineHeaders(options: { production: boolean }): SecurityHeader[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    // HTTPS only, and only in production (never pin a development host). No includeSubDomains / preload: a portfolio
    // domain may share a parent domain with sites that are not ready for it.
    ...(options.production
      ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
      : []),
  ];
}

/** Everything except the widget page may never be framed (clickjacking). */
export const FRAME_DENY_HEADER: SecurityHeader = { key: "X-Frame-Options", value: "DENY" };

/** Paths that are the embeddable widget page: the only HTML that may be framed by another website. */
export const WIDGET_PAGE_PATTERN = /^\/widget(\/|$)/;
