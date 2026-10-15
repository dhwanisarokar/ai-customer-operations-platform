import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";
import { FakeEmailProvider } from "./fake-provider";
import { assessProvider } from "./provider-policy";

/**
 * Production boundaries of the email integration (Phase 9.7): nothing in the application can select a real provider, and
 * nothing claims a provider is verified. These tests read the source on purpose: they fail the day someone adds an
 * adapter or flips a readiness without going through the evidence process in docs/email-provider-readiness.md.
 */

const root = join(__dirname, "..", "..", "..");
const base = { DATABASE_URL: "postgresql://x" };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "generated" || name === "node_modules") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const rel = (file: string) => file.slice(root.length + 1).replaceAll("\\", "/");

describe("a real provider cannot be selected", () => {
  it("EMAIL_PROVIDER accepts only 'fake' (every real provider name is refused at startup)", () => {
    expect(() => parseServerEnv({ ...base, EMAIL_PROVIDER: "fake" })).not.toThrow();
    expect(parseServerEnv({ ...base, EMAIL_PROVIDER: "" }).EMAIL_PROVIDER).toBeUndefined();
    for (const name of [
      "mailgun",
      "resend",
      "sendgrid",
      "ses",
      "postmark",
      "smtp",
      "FAKE",
      "real",
    ]) {
      expect(() => parseServerEnv({ ...base, EMAIL_PROVIDER: name })).toThrow();
    }
  });

  it("the fake provider cannot run in production: refused by the environment and by the capability policy", () => {
    expect(() =>
      parseServerEnv({ ...base, NODE_ENV: "production", EMAIL_PROVIDER: "fake" }),
    ).toThrow(/EMAIL_PROVIDER/);
    expect(assessProvider(new FakeEmailProvider("s"), { production: true })).toEqual({
      ok: false,
      reasons: ["fake_in_production"],
    });
  });

  it("the fake provider says what it is: readiness 'fake', never 'verified'", () => {
    expect(new FakeEmailProvider("s").readiness).toEqual({ status: "fake", evidence: null });
  });

  it("the only EmailProvider implementation in the application is the fake", () => {
    const implementations = sourceFiles(join(root, "src"))
      .filter((file) => /\bimplements\s+EmailProvider\b/.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(implementations).toEqual(["src/server/email/fake-provider.ts"]);
  });

  it("the provider factory constructs nothing but the fake", () => {
    const factory = readFileSync(join(root, "src/server/email/index.ts"), "utf8");
    expect([...factory.matchAll(/new\s+(\w+EmailProvider)\b/g)].map((m) => m[1])).toEqual([
      "FakeEmailProvider",
    ]);
  });
});

describe("nothing is marked verified without evidence", () => {
  it("no application code (outside tests) declares a provider as 'verified'", () => {
    const offenders = sourceFiles(join(root, "src"))
      .filter((file) => /status:\s*"verified"/.test(readFileSync(file, "utf8")))
      // The type definition and the policy (which only compares against it) are the only places the word appears.
      .map(rel)
      .filter((file) => !["src/server/email/provider.ts"].includes(file));
    expect(offenders).toEqual([]);
  });

  it("production accepts a provider only with status 'verified' AND a non-empty evidence path", () => {
    const caps = new FakeEmailProvider("s").sending;
    const make = (readiness: Parameters<typeof assessProvider>[0]["readiness"]) =>
      assessProvider({ name: "acme-mail", sending: caps, readiness }, { production: true });
    expect(make({ status: "declared", evidence: null }).ok).toBe(false);
    expect(make({ status: "declared", evidence: "docs/x.md" }).ok).toBe(false);
    expect(make({ status: "verified", evidence: "" }).ok).toBe(false);
    expect(make({ status: "verified", evidence: "docs/email-provider-acme.md" }).ok).toBe(true);
  });
});
