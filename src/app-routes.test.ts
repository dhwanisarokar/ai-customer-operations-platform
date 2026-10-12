import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every internal link written as a template string ("/dashboard/customers/${id}", "/portal/${slug}/help")
 * must resolve to a page of the App Router tree (route groups like "(app)" do not count as segments, and a
 * "[param]" folder matches any value). It catches links to routes that were moved or never created, which
 * would otherwise surface as a 404 in the browser.
 */
const SRC = join(process.cwd(), "src");
const APP = join(SRC, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Does the app tree contain a page.tsx for these URL segments? */
function hasPage(dir: string, segments: string[]): boolean {
  if (segments.length === 0) return existsSync(join(dir, "page.tsx"));
  const entries = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  const [head, ...rest] = segments;
  return entries.some((name) => {
    const child = join(dir, name);
    if (/^\(.+\)$/.test(name)) return hasPage(child, segments); // route group: not a URL segment
    if (/^\[\[\.\.\..+\]\]$/.test(name) || /^\[\.\.\..+\]$/.test(name)) return true; // catch-all
    if (/^\[.+\]$/.test(name)) return hasPage(child, rest); // dynamic segment
    return name === head && hasPage(child, rest);
  });
}

const files = walk(join(SRC, "features"))
  .concat(walk(APP))
  .filter((file) => /\.(tsx?)$/.test(file) && !/\.test\./.test(file));
const links = new Map<string, string>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/`(\/(?:dashboard|portal)\/[^`\s?"]*)/g)) {
    const url = match[1].replace(/\$\{[^}]*\}/g, "[x]");
    if (/^\/(dashboard|portal)(\/|$)/.test(url)) links.set(url, file);
  }
}

describe("internal links resolve to pages", () => {
  it("finds the customer detail link", () => {
    expect([...links.keys()]).toContain("/dashboard/customers/[x]");
  });

  it.each([...links.entries()])("%s", (url) => {
    const segments = url
      .split("/")
      .filter(Boolean)
      .map((s) => s.replace(/\[x\]/, "[x]"));
    // `${base}/conversations` style links start with an unknown prefix; only absolute links are checked.
    expect(hasPage(APP, segments), `no page for ${url}`).toBe(true);
  });
});
