import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import { WIDGET_PAGE_PATTERN } from "@/lib/csp";
import proxy, { appClerkOptions, config } from "./proxy";

// Next.js compiles each matcher to an anchored regular expression.
const regexes = config.matcher.map((pattern) => new RegExp(`^${pattern}$`));
const matched = (path: string) => regexes.some((regex) => regex.test(path));
// The proxy runs for the widget PAGE too (it sets its Content-Security-Policy) but hands it past Clerk.
const runsClerk = (path: string) => matched(path) && !WIDGET_PAGE_PATTERN.test(path);

describe("proxy (Clerk middleware) matcher", () => {
  it.each([
    "/widget/wk_abc123",
    "/widget/wk_abc123/",
    "/api/widget/session",
    "/api/widget/conversations",
    "/api/widget/conversations/3f2b/messages",
    "/api/widget/events",
    "/widget.js",
  ])("does not run for the public widget path %s", (path) => {
    expect(runsClerk(path)).toBe(false);
  });

  it.each(["/api/email/inbound", "/api/email/inbound/"])(
    "does not run for the provider webhook %s (server-to-server, signature-authenticated)",
    (path) => {
      expect(runsClerk(path)).toBe(false);
    },
  );

  it.each([
    "/",
    "/dashboard",
    "/dashboard/inbox",
    "/dashboard/widget",
    "/sign-in",
    "/api/me",
    "/api/organizations",
    "/api/conversations",
    "/api/customers",
    "/api/widget-settings",
    "/api/realtime/inbox",
    "/portal/acme",
    "/portal/acme/conversations",
    "/api/portal/acme/summary",
    "/api/portal-settings",
    "/api/automations",
    "/api/email-settings",
    "/api/email-settings/verify",
  ])("still runs for the internal path %s", (path) => {
    expect(runsClerk(path)).toBe(true);
  });

  it("only the dashboard and portal pages are redirected to sign-in by the middleware", () => {
    const source = readFileSync(join(__dirname, "proxy.ts"), "utf8");
    expect(source).toContain('createRouteMatcher(["/dashboard(.*)", "/portal(.*)"])');
  });
});

describe("the public widget does not depend on Clerk", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const sources = (dirs: string[]) =>
    dirs
      .flatMap((dir) => files(join(__dirname, dir)))
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file));

  it("the widget page, widget UI and public API import nothing from Clerk", () => {
    const dirs = [
      "app/widget",
      "app/api/widget",
      "features/widget/hooks",
      "features/widget/components",
    ];
    for (const file of sources(dirs)) {
      if (file.includes("widget-settings-form")) continue; // staff-only settings form (dashboard)
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@clerk\//);
    }
  });

  it("the root layout has no ClerkProvider; the (app) group has it", () => {
    expect(readFileSync(join(__dirname, "app/layout.tsx"), "utf8")).not.toMatch(
      /ClerkProvider|@clerk\//,
    );
    expect(readFileSync(join(__dirname, "app/(app)/layout.tsx"), "utf8")).toMatch(/ClerkProvider/);
  });
});

describe("security headers set by the proxy", () => {
  const event = {} as NextFetchEvent;
  const ask = (path: string) =>
    proxy(new NextRequest(`http://localhost${path}`), event) as Response;

  it("the widget PAGE is matched by the proxy (so it gets a nonce policy) but never handed to Clerk", () => {
    expect(matched("/widget/wk_abc123")).toBe(true);
    expect(runsClerk("/widget/wk_abc123")).toBe(false);
    // The visitor API, the static loader and the webhook are not touched by the proxy at all.
    for (const path of [
      "/api/widget/session",
      "/api/widget/events",
      "/widget.js",
      "/api/email/inbound",
    ]) {
      expect(matched(path)).toBe(false);
    }
  });

  it("answers the widget page with a nonce policy that allows embedding by any website (no frame-ancestors)", () => {
    const response = ask("/widget/wk_abc123");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(policy).not.toContain("frame-ancestors");
    expect(policy).not.toMatch(/unsafe-eval|'unsafe-inline'[^;]*script|\*/);
    expect(response.headers.get("x-frame-options")).toBeNull();
  });

  it("uses a different nonce for every request", () => {
    const nonce = (r: Response) =>
      /'nonce-([^']+)'/.exec(r.headers.get("content-security-policy")!)![1];
    expect(nonce(ask("/widget/a"))).not.toBe(nonce(ask("/widget/a")));
  });

  it("CSP_REPORT_ONLY switches the widget policy and the Clerk-managed policy to report-only", () => {
    const before = process.env.CSP_REPORT_ONLY;
    try {
      process.env.CSP_REPORT_ONLY = "true";
      const response = ask("/widget/wk_abc123");
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("content-security-policy-report-only")).toMatch(/script-src/);
      expect(appClerkOptions().contentSecurityPolicy.reportOnly).toBe(true);
      process.env.CSP_REPORT_ONLY = "false";
      expect(appClerkOptions().contentSecurityPolicy.reportOnly).toBe(false);
    } finally {
      if (before === undefined) delete process.env.CSP_REPORT_ONLY;
      else process.env.CSP_REPORT_ONLY = before;
    }
  });

  it("the Clerk-managed app policy is strict (nonce + strict-dynamic) and forbids framing", () => {
    const options = appClerkOptions().contentSecurityPolicy;
    expect(options.strict).toBe(true);
    expect(options.directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(options.directives["object-src"]).toEqual(["'none'"]);
  });
});
