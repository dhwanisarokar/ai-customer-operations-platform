import { describe, expect, it } from "vitest";
import { parseResolveArgs, RESOLVE_UNKNOWN_USAGE } from "./resolve-unknown-cli";

const ORG = "9a1b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c0a";
const SEND = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01";
const ok = [
  "--org",
  ORG,
  "--send",
  SEND,
  "--operator",
  "Dana Ops <dana@example.com>",
  "--reason",
  "Checked the provider dashboard: no record of this message id",
  "--confirm-not-sent",
];

describe("parseResolveArgs", () => {
  it("parses a complete, explicit attestation", () => {
    expect(parseResolveArgs(ok)).toEqual({
      organizationId: ORG,
      sendId: SEND,
      operator: "Dana Ops <dana@example.com>",
      reason: "Checked the provider dashboard: no record of this message id",
    });
  });

  it("requires the explicit confirmation flag (nothing happens by accident)", () => {
    expect(() => parseResolveArgs(ok.filter((a) => a !== "--confirm-not-sent"))).toThrow(
      /confirm-not-sent/,
    );
  });

  it.each([
    ["no operator identity", ["--operator", ""], /operator/],
    ["a reason that is too short", ["--reason", "ok"], /reason/],
    ["an organization that is not a uuid", ["--org", "not-a-uuid"], /org/],
    ["a send that is not a uuid", ["--send", "123"], /send/],
  ])("rejects %s", (_label, [flag, value], message) => {
    const argv = [...ok];
    argv[argv.indexOf(flag) + 1] = value;
    expect(() => parseResolveArgs(argv)).toThrow(message);
  });

  it.each([
    ["an unknown option", [...ok, "--outcome", "sent"]],
    ["an option that would mark it sent", [...ok, "--confirm-sent"]],
    ["a repeated option", [...ok, "--reason", "something else entirely here"]],
    ["a flag without its value", ["--org", ORG, "--send"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseResolveArgs(argv)).toThrow();
  });

  it("offers no way to mark an email as sent or to resend it", () => {
    expect(RESOLVE_UNKNOWN_USAGE).toMatch(/NOT sent/);
    expect(RESOLVE_UNKNOWN_USAGE).toMatch(/no option to mark an email\s+as sent/i);
    expect(RESOLVE_UNKNOWN_USAGE).not.toMatch(/--outcome|--resend|--sent\b/);
  });
});
