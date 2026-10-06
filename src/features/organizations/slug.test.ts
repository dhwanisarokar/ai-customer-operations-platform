import { describe, expect, it } from "vitest";
import { SLUG_MAX, SLUG_PATTERN, slugify, withRandomSuffix } from "./slug";

describe("slugify", () => {
  it("normalizes names into valid slugs", () => {
    expect(slugify("Acme Inc")).toBe("acme-inc");
    expect(slugify("  Café --  Münch!! ")).toBe("cafe-munch");
  });

  it("falls back to a default when nothing usable remains", () => {
    expect(slugify("!!!")).toBe("org");
    expect(slugify("日本")).toBe("org");
  });

  it("never exceeds the maximum length or ends with a hyphen", () => {
    const slug = slugify("a".repeat(30) + " " + "b".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });
});

describe("withRandomSuffix", () => {
  it("stays valid and within the length limit", () => {
    const slug = withRandomSuffix("x".repeat(SLUG_MAX));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });
});
