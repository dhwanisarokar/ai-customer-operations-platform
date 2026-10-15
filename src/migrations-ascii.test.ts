import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration files are pure ASCII. A literal invisible or non-ASCII character (a bidi override, a line separator, a
 * C1 control) inside a SQL string is unreviewable and is mangled by editors, terminals and client encodings; such
 * code points must be written as \uXXXX escapes, which the PostgreSQL regex engine interprets. (A real incident:
 * a migration containing the literal characters failed to apply through a WIN1252 client.)
 */
const DIR = join(process.cwd(), "prisma", "migrations");
const files = readdirSync(DIR)
  .map((name) => join(DIR, name, "migration.sql"))
  .filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });

describe("prisma migrations", () => {
  it("finds the migrations", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.split(/[\\/]/).slice(-2)[0], f] as const))(
    "%s contains only ASCII characters",
    (_name, file) => {
      const bad = [...readFileSync(file, "utf8")].filter((ch) => ch.charCodeAt(0) > 127);
      expect(bad.map((ch) => `U+${ch.charCodeAt(0).toString(16).toUpperCase()}`)).toEqual([]);
    },
  );
});
