import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/email-settings/route";
import { PUT as enabledPut } from "@/app/api/email-settings/enabled/route";
import { POST as verifyPost } from "@/app/api/email-settings/verify/route";
import { customerAiEnabledFor } from "@/server/services/customer-ai";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { setEmailProviderForTesting } from "@/server/email";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { signOut } from "../helpers/mocks";
import { as, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";

describeDb("email foundation: settings, state machine, constraints and isolation", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  const db = async () => (await import("@/db/client")).getDb();

  const save = (localPart: string, fromName = "Acme Support", extra: object = {}) =>
    call(settingsPut, { method: "PUT", body: { localPart, fromName, ...extra } });
  const verify = () => call(verifyPost, { method: "POST" });
  const enable = (enabled: boolean) => call(enabledPut, { method: "PUT", body: { enabled } });
  const read = () => call(settingsGet);

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("test-secret");
    setEmailProviderForTesting(provider);
    as(t.adminA);
  });

  afterEach(() => {
    setEmailProviderForTesting(undefined);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  describe("defaults", () => {
    it("is disabled and unconfigured by default, and reading creates no row", async () => {
      const res = await read();
      expect(res.status).toBe(200);
      expect(res.body.settings).toMatchObject({
        available: true,
        platformDomain: DOMAIN,
        enabled: false,
        status: "UNCONFIGURED",
        supportAddress: null,
        localPart: null,
      });
      expect(await (await db()).emailSettings.count()).toBe(0);
    });

    it("suggests a local part from the organization slug", async () => {
      const res = await read();
      expect(res.body.settings.suggestedLocalPart).toMatch(/^[a-z0-9]/);
    });
  });

  describe("authorization", () => {
    it("rejects unauthenticated callers", async () => {
      signOut();
      for (const res of [await read(), await save("acme"), await verify(), await enable(true)]) {
        expect(res.status).toBe(401);
      }
    });

    it("forbids MEMBER on every endpoint", async () => {
      as(t.memberA);
      for (const res of [await read(), await save("acme"), await verify(), await enable(true)]) {
        expect(res.status).toBe(403);
      }
      expect(await (await db()).emailSettings.count()).toBe(0);
    });

    it("allows ADMIN and OWNER", async () => {
      expect((await save("acme")).status).toBe(200);
      as(t.ownerA);
      expect((await read()).status).toBe(200);
      expect((await verify()).status).toBe(200);
    });
  });

  describe("state machine", () => {
    it("save -> pending -> verify -> active -> enable -> disable", async () => {
      const saved = await save("Acme-Help", "  Acme   Support ");
      expect(saved.status).toBe(200);
      expect(saved.body.settings).toMatchObject({
        status: "PENDING_VERIFICATION",
        enabled: false,
        localPart: "acme-help",
        supportAddress: `acme-help@${DOMAIN}`,
        fromName: "Acme Support",
      });

      const verified = await verify();
      expect(verified.body.settings).toMatchObject({ status: "ACTIVE", statusDetail: null });
      expect(provider.ensured).toContain(`acme-help@${DOMAIN}`);

      const on = await enable(true);
      expect(on.body.settings.enabled).toBe(true);
      const off = await enable(false);
      expect(off.body.settings.enabled).toBe(false);
    });

    it("cannot be enabled before it is verified", async () => {
      await save("acme");
      const res = await enable(true);
      expect(res.status).toBe(409);
      expect((await read()).body.settings.enabled).toBe(false);
    });

    it("cannot be enabled with no address at all", async () => {
      expect((await enable(true)).status).toBe(404);
    });

    it("changing the address resets verification and switches the channel off", async () => {
      await save("acme");
      await verify();
      await enable(true);
      const changed = await save("acme-two");
      expect(changed.body.settings).toMatchObject({
        status: "PENDING_VERIFICATION",
        enabled: false,
        supportAddress: `acme-two@${DOMAIN}`,
      });
    });

    it("changing only the sender name keeps verification and the enabled flag", async () => {
      await save("acme");
      await verify();
      await enable(true);
      const renamed = await save("acme", "Acme Care");
      expect(renamed.body.settings).toMatchObject({
        status: "ACTIVE",
        enabled: true,
        fromName: "Acme Care",
      });
    });

    it("a provider refusal marks the address FAILED, switches it off and leaks no provider text", async () => {
      await save("acme");
      provider.rejectAddresses.add(`acme@${DOMAIN}`);
      const res = await verify();
      expect(res.status).toBe(200);
      expect(res.body.settings).toMatchObject({
        status: "FAILED",
        enabled: false,
        statusDetail: "provider_rejected",
      });
      expect((await enable(true)).status).toBe(409);
    });

    it("a provider exception becomes provider_error without leaking the message", async () => {
      await save("acme");
      provider.ensureAddress = async () => {
        throw new Error("secret-token-abc leaked in provider error");
      };
      const res = await verify();
      expect(res.status).toBe(200);
      expect(res.body.settings).toMatchObject({ status: "FAILED", statusDetail: "provider_error" });
      expect(JSON.stringify(res.body)).not.toContain("secret-token-abc");
    });

    it("an ACTIVE address that later fails verification is switched off", async () => {
      await save("acme");
      await verify();
      await enable(true);
      provider.rejectAddresses.add(`acme@${DOMAIN}`);
      const res = await verify();
      expect(res.body.settings).toMatchObject({ status: "FAILED", enabled: false });
    });

    it("verify with no address is a 404", async () => {
      expect((await verify()).status).toBe(404);
    });
  });

  describe("validation", () => {
    it.each(["", "-bad", "bad-", "has space", "a@b", "x".repeat(33), "ünï"])(
      "rejects local part %j",
      async (value) => {
        const res = await save(value);
        expect(res.status).toBe(400);
      },
    );

    it.each(["postmaster", "abuse", "noreply", "Admin"])(
      "rejects reserved name %s",
      async (value) => {
        const res = await save(value);
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toMatch(/reserved/i);
      },
    );

    it.each(["", "   ", "Line\r\nBcc: x@y.com", "tab\tname", "x".repeat(81)])(
      "rejects sender name %j",
      async (value) => {
        const res = await save("acme", value);
        expect(res.status).toBe(400);
      },
    );

    it.each(["organizationId", "status", "supportAddress", "enabled"])(
      "rejects the unexpected field %s (strict body)",
      async (field) => {
        const res = await save("acme", "Acme", { [field]: field === "enabled" ? true : "x" });
        expect(res.status).toBe(400);
        expect(await (await db()).emailSettings.count()).toBe(0);
      },
    );

    it("rejects an unexpected field on the enable endpoint", async () => {
      await save("acme");
      const res = await call(enabledPut, {
        method: "PUT",
        body: { enabled: true, status: "ACTIVE" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON", async () => {
      const res = await call(settingsPut, { method: "PUT", rawBody: "{nope" });
      expect(res.status).toBe(400);
    });
  });

  describe("platform availability", () => {
    it("reports unavailable and refuses changes when no provider is configured", async () => {
      setEmailProviderForTesting(undefined);
      vi.stubEnv("EMAIL_PROVIDER", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      expect((await read()).body.settings).toMatchObject({ available: false, enabled: false });
      expect((await save("acme")).status).toBe(409);
      expect((await verify()).status).toBe(409);
    });
  });

  describe("tenant isolation and uniqueness", () => {
    it("each organization sees only its own settings", async () => {
      await save("acme");
      as(t.ownerB);
      expect((await read()).body.settings).toMatchObject({
        status: "UNCONFIGURED",
        supportAddress: null,
      });
      await save("beta");
      as(t.adminA);
      expect((await read()).body.settings.supportAddress).toBe(`acme@${DOMAIN}`);
    });

    it("an address is globally unique across organizations, case-insensitively", async () => {
      await save("acme");
      as(t.ownerB);
      const clash = await save("ACME");
      expect(clash.status).toBe(409);
      expect(JSON.stringify(clash.body)).toMatch(/taken/i);
      expect((await read()).body.settings.supportAddress).toBeNull();
    });

    it("a client cannot act on another organization by sending its id", async () => {
      as(t.ownerB);
      await save("beta");
      as(t.adminA);
      const res = await save("alpha", "A", { organizationId: t.orgB.id });
      expect(res.status).toBe(400);
      const rows = await (await db()).emailSettings.findMany();
      expect(rows.map((r) => r.organizationId)).toEqual([t.orgB.id]);
    });

    it("enabling in one organization never touches another", async () => {
      await save("acme");
      await verify();
      as(t.ownerB);
      await save("beta");
      expect((await enable(true)).status).toBe(409);
      as(t.adminA);
      expect((await enable(true)).body.settings.enabled).toBe(true);
      as(t.ownerB);
      expect((await read()).body.settings.enabled).toBe(false);
    });

    it("deleting an organization removes its settings (cascade)", async () => {
      await save("acme");
      await (await db()).organization.delete({ where: { id: t.orgA.id } });
      expect(await (await db()).emailSettings.count()).toBe(0);
    });
  });

  describe("database constraints (bypassing the service)", () => {
    const insert = async (data: Record<string, unknown>) =>
      (await db()).emailSettings.create({
        data: {
          organizationId: t.orgA.id,
          localPart: "acme",
          supportAddress: `acme@${DOMAIN}`,
          fromName: "Acme",
          ...data,
        } as never,
      });

    it("refuses enabled=true unless the status is ACTIVE", async () => {
      await expect(insert({ enabled: true, status: "PENDING_VERIFICATION" })).rejects.toThrow();
      await expect(insert({ enabled: true, status: "FAILED" })).rejects.toThrow();
      await expect(insert({ enabled: true, status: "ACTIVE" })).resolves.toBeTruthy();
    });

    it.each([
      ["upper-case local part", { localPart: "Acme", supportAddress: `Acme@${DOMAIN}` }],
      ["local part with a space", { localPart: "a b", supportAddress: `a b@${DOMAIN}` }],
      ["address not matching local part", { supportAddress: `other@${DOMAIN}` }],
      ["upper-case address", { supportAddress: `acme@MAIL.platform.test` }],
      ["blank sender name", { fromName: "   " }],
      ["sender name with a line break", { fromName: "A\nB" }],
      ["sender name over 80 characters", { fromName: "x".repeat(81) }],
      ["free-text status detail", { statusDetail: "Provider said: nope!" }],
    ])("refuses %s", async (_label, data) => {
      await expect(insert(data)).rejects.toThrow();
      expect(await (await db()).emailSettings.count()).toBe(0);
    });

    it("accepts a coded status detail", async () => {
      await expect(
        insert({ status: "FAILED", statusDetail: "provider_error" }),
      ).resolves.toBeTruthy();
    });
  });

  describe("channel enum and existing behavior", () => {
    it("EMAIL is a valid conversation channel and existing channels still work", async () => {
      const client = await db();
      const customer = await client.customer.create({
        data: { organizationId: t.orgA.id, firstName: "Eve", email: "eve@customer.test" },
      });
      for (const channel of ["EMAIL", "WEB_CHAT", "PORTAL", "IN_APP"] as const) {
        const created = await client.conversation.create({
          data: {
            organizationId: t.orgA.id,
            customerId: customer.id,
            subject: channel,
            channel,
            lastMessageAt: new Date(),
          } as never,
        });
        expect(created.channel).toBe(channel);
      }
    });

    it("never enables automatic customer AI replies on the email channel", () => {
      const settings = { enabled: true } as never;
      expect(customerAiEnabledFor(settings, "EMAIL")).toBe(false);
    });
  });
});
