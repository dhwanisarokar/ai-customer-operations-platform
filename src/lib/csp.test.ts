import { describe, expect, it } from "vitest";
import {
  FRAME_DENY_HEADER,
  WIDGET_PAGE_PATTERN,
  appCspDirectives,
  baselineHeaders,
  clerkFrontendOrigin,
  generateNonce,
  widgetCsp,
} from "./csp";

const keyFor = (host: string, kind: "test" | "live" = "live") =>
  `pk_${kind}_${Buffer.from(`${host}$`).toString("base64")}`;

describe("clerkFrontendOrigin", () => {
  it("decodes the Frontend API host from a publishable key", () => {
    expect(clerkFrontendOrigin(keyFor("clerk.example.com"))).toBe("https://clerk.example.com");
    expect(clerkFrontendOrigin(keyFor("fond-cat-12.clerk.accounts.dev", "test"))).toBe(
      "https://fond-cat-12.clerk.accounts.dev",
    );
  });

  it.each([undefined, "", "sk_live_abc", "pk_live_", "pk_live_!!!", "not-a-key", keyFor("nodots")])(
    "returns null for %s (nothing is added to the policy)",
    (value) => {
      expect(clerkFrontendOrigin(value as string | undefined)).toBeNull();
    },
  );

  it("never accepts a decoded value that is not a plain host name", () => {
    for (const host of ["evil.com/path", "a b.com", "x.com;script-src *", "https://x.com"]) {
      expect(clerkFrontendOrigin(keyFor(host))).toBeNull();
    }
  });
});

describe("appCspDirectives (added to Clerk's strict policy)", () => {
  it("forbids framing, plugins and <base> changes, and allows data images and the Clerk API origin", () => {
    expect(appCspDirectives(keyFor("clerk.example.com"))).toEqual({
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "img-src": ["data:", "blob:"],
      "connect-src": ["https://clerk.example.com"],
    });
  });

  it("adds no connect-src entry when the key is unusable, and never a wildcard", () => {
    const directives = appCspDirectives(undefined);
    expect(directives["connect-src"]).toEqual([]);
    expect(JSON.stringify(directives)).not.toContain("*");
  });
});

describe("widgetCsp (the page other websites embed)", () => {
  const policy = widgetCsp("NONCE123");
  const directive = (name: string) =>
    policy
      .split("; ")
      .find((part) => part.startsWith(`${name} `))
      ?.slice(name.length + 1);

  it("is nonce-based with strict-dynamic and allows no other script source", () => {
    expect(directive("script-src")).toBe("'self' 'nonce-NONCE123' 'strict-dynamic'");
  });

  it("is same-origin for everything else, with no plugins and no nested frames", () => {
    expect(directive("default-src")).toBe("'self'");
    expect(directive("connect-src")).toBe("'self'"); // the visitor API and server-sent events are same-origin
    expect(directive("frame-src")).toBe("'none'");
    expect(directive("object-src")).toBe("'none'");
    expect(directive("base-uri")).toBe("'self'");
    expect(directive("form-action")).toBe("'self'");
  });

  it("does NOT restrict who may embed it (that is the widget's allowed-websites check)", () => {
    expect(policy).not.toContain("frame-ancestors");
  });

  it("has no wildcard, no http(s) allowlist and no unsafe-eval in production", () => {
    expect(policy).not.toMatch(/\*|https?:|unsafe-eval/);
    // 'unsafe-inline' exists only for styles (React style attributes cannot carry a nonce), never for scripts.
    expect(directive("script-src")).not.toContain("unsafe-inline");
  });

  it("allows unsafe-eval only in development (React's debugging needs it)", () => {
    expect(widgetCsp("N", { development: true })).toContain("'unsafe-eval'");
  });

  it("a nonce is unpredictable and unique", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("baseline headers and framing", () => {
  it("sends the safe headers everywhere, and HSTS only in production", () => {
    const dev = Object.fromEntries(
      baselineHeaders({ production: false }).map((h) => [h.key, h.value]),
    );
    const prod = Object.fromEntries(
      baselineHeaders({ production: true }).map((h) => [h.key, h.value]),
    );
    expect(dev["X-Content-Type-Options"]).toBe("nosniff");
    expect(dev["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(dev["Permissions-Policy"]).toContain("camera=()");
    expect(dev["Strict-Transport-Security"]).toBeUndefined();
    expect(prod["Strict-Transport-Security"]).toBe("max-age=31536000"); // no includeSubDomains, no preload
  });

  it("never puts X-Frame-Options in the baseline (it would break the embeddable widget)", () => {
    for (const production of [true, false]) {
      expect(baselineHeaders({ production }).map((h) => h.key)).not.toContain("X-Frame-Options");
    }
    expect(FRAME_DENY_HEADER).toEqual({ key: "X-Frame-Options", value: "DENY" });
  });

  it("identifies exactly the widget page", () => {
    for (const path of ["/widget/wk_1", "/widget/wk_1/", "/widget"]) {
      expect(WIDGET_PAGE_PATTERN.test(path)).toBe(true);
    }
    for (const path of ["/widget.js", "/widgets/x", "/api/widget/session", "/dashboard/widget"]) {
      expect(WIDGET_PAGE_PATTERN.test(path)).toBe(false);
    }
  });
});
