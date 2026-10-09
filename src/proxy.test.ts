import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "./proxy";

// Next.js compiles each matcher to an anchored regular expression.
const regexes = config.matcher.map((pattern) => new RegExp(`^${pattern}$`));
const runsClerk = (path: string) => regexes.some((regex) => regex.test(path));

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
    "/api/automations",
  ])("still runs for the internal path %s", (path) => {
    expect(runsClerk(path)).toBe(true);
  });

  it("only /dashboard pages are redirected to sign-in by the middleware", () => {
    const source = readFileSync(join(__dirname, "proxy.ts"), "utf8");
    expect(source).toContain('createRouteMatcher(["/dashboard(.*)"])');
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
