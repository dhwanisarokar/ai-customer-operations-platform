import { describe, expect, it } from "vitest";
import { SCENARIOS, auth } from "../../../tests/helpers/email-auth";
import { sampleInbound } from "../../../tests/helpers/email-provider-contract";
import { normalizedInboundEmailSchema } from "./provider";
import { evaluateSenderAuth, isAligned, senderAuthSchema } from "./sender-auth";

describe("senderAuthSchema: ambiguous or non-contract results are rejected", () => {
  it.each([
    [
      "a pass without a domain (cannot be aligned)",
      { spf: { result: "pass", domain: null }, dkim: [] },
    ],
    ["a pass with an empty domain", { spf: { result: "pass", domain: "" }, dkim: [] }],
    [
      "a pass with a malformed domain",
      { spf: { result: "pass", domain: "not a domain" }, dkim: [] },
    ],
    [
      "a pass with an address instead of a domain",
      { spf: { result: "pass", domain: "a@b.test" }, dkim: [] },
    ],
    ["a pass with a URL", { spf: { result: "pass", domain: "https://customer.test" }, dkim: [] }],
    [
      "a 'none' that claims a domain",
      { spf: { result: "none", domain: "customer.test" }, dkim: [] },
    ],
    [
      "a result the contract does not know (softfail)",
      { spf: { result: "softfail", domain: null }, dkim: [] },
    ],
    ["an upper-case result", { spf: { result: "PASS", domain: "customer.test" }, dkim: [] }],
    ["a bare verdict string (the old shape)", { spf: "pass", dkim: "pass" }],
    [
      "dkim as a single object instead of a list",
      { spf: auth.none.spf, dkim: { result: "none", domain: null } },
    ],
    ["a missing dkim list", { spf: auth.none.spf }],
    ["a missing spf", { dkim: [] }],
    [
      "more than 10 DKIM signatures",
      { spf: auth.none.spf, dkim: Array.from({ length: 11 }, () => auth.pass("customer.test")) },
    ],
    ["an unknown extra field (dmarc)", { spf: auth.none.spf, dkim: [], dmarc: "pass" }],
    [
      "an unknown field on a result",
      { spf: { result: "pass", domain: "customer.test", aligned: true }, dkim: [] },
    ],
    ["null", null],
    ["a string", "pass"],
  ])("rejects %s", (_label, input) => {
    expect(senderAuthSchema.safeParse(input).success).toBe(false);
  });

  it("accepts the contract shapes and lower-cases domains", () => {
    const parsed = senderAuthSchema.parse({
      spf: { result: "pass", domain: "Customer.TEST" },
      dkim: [
        { result: "fail", domain: null },
        { result: "none", domain: null },
      ],
    });
    expect(parsed.spf).toEqual({ result: "pass", domain: "customer.test" });
  });

  it("a whole inbound email with an ambiguous senderAuth is a malformed message", () => {
    const email = {
      ...sampleInbound(),
      senderAuth: { spf: { result: "pass", domain: null }, dkim: [] },
    };
    expect(normalizedInboundEmailSchema.safeParse(email).success).toBe(false);
  });
});

describe("isAligned", () => {
  it.each([
    ["customer.test", "customer.test", true],
    ["customer.test", "news.customer.test", true],
    ["customer.test", "a.b.customer.test", true],
    ["mail.customer.test", "customer.test", false], // child of From: stricter than relaxed DMARC
    ["customer.test", "evilcustomer.test", false], // no dot boundary
    ["customer.test", "customer.test.evil.test", false],
    ["evil.test", "customer.test", false],
    ["test", "customer.test", false], // a bare TLD never aligns anything
    ["com", "example.com", false],
  ])("auth %s vs From %s -> %s", (authDomain, fromDomain, expected) => {
    expect(isAligned(authDomain, fromDomain)).toBe(expected);
  });
});

describe("evaluateSenderAuth on realistic scenarios", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, scenario) => {
    // Through the schema first, exactly as in production (this also lower-cases domains).
    const parsed = senderAuthSchema.parse(scenario.senderAuth);
    const result = evaluateSenderAuth(scenario.from, parsed);
    expect(result.authenticated).toBe(scenario.authenticated);
    expect(result.spf).toBe(scenario.spf);
    expect(result.dkim).toBe(scenario.dkim);
    expect(result.detail.via).toBe(scenario.via);
    expect(result.detail.fromDomain).toBe(scenario.from.split("@")[1]);
  });

  it("an unaligned pass is never stored as 'pass'", () => {
    const parsed = senderAuthSchema.parse(auth.aligned("evil.test"));
    const result = evaluateSenderAuth("ceo@customer.test", parsed);
    expect(result).toMatchObject({ authenticated: false, spf: "fail", dkim: "fail" });
    expect(result.detail.spf).toMatchObject({ result: "pass", aligned: false });
  });

  it("records, per signature, what was seen and whether it aligned", () => {
    const parsed = senderAuthSchema.parse({
      spf: auth.none.spf,
      dkim: [auth.pass("esp.test"), auth.pass("customer.test"), auth.fail("customer.test")],
    });
    const { detail } = evaluateSenderAuth("ana@customer.test", parsed);
    expect(detail.dkim.map((d) => [d.domain, d.result, d.aligned])).toEqual([
      ["esp.test", "pass", false],
      ["customer.test", "pass", true],
      ["customer.test", "fail", false],
    ]);
  });
});
