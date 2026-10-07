import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute } from "@/app/api/customers/route";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, seedCustomer, seedTag, seedTagLink, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type Item = { id: string; firstName: string; lastName: string | null; tags: { name: string }[] };

describeDb("customer list: search, filters, sorting, pagination", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  const ids: Record<string, string> = {};

  async function list(query: Record<string, string> = {}) {
    const res = await call(listRoute, { query });
    expect(res.status).toBe(200);
    return res.body as {
      items: Item[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    };
  }
  const names = (items: Item[]) => items.map((c) => c.firstName);
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
    as(t.memberA);

    const fixtures = [
      {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@engines.test",
        company: "Analytical Engines",
        phone: "+15550100",
        source: "web",
        status: "ACTIVE",
      },
      {
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@navy.test",
        company: "US Navy",
        phone: "+15550101",
        source: "referral",
        status: "ACTIVE",
      },
      {
        firstName: "Alan",
        lastName: "Turing",
        email: "alan@bletchley.test",
        company: "Bletchley Park",
        phone: null,
        source: "web",
        status: "INACTIVE",
      },
      {
        firstName: "Linus",
        lastName: null,
        email: "linus@kernel.test",
        company: "Kernel Org",
        phone: null,
        source: "event",
        status: "ACTIVE",
      },
      {
        firstName: "Margaret",
        lastName: "Hamilton",
        email: "margaret@nasa.test",
        company: "NASA",
        phone: "+15550102",
        source: "web",
        status: "ACTIVE",
      },
    ] as const;
    for (const f of fixtures) ids[f.firstName] = (await seedCustomer(t.orgA.id, f)).id;
    ids.Old = (await seedCustomer(t.orgA.id, { firstName: "Archived", status: "ARCHIVED" })).id;
    // Same-named customer in another tenant must never appear.
    await seedCustomer(t.orgB.id, {
      firstName: "Ada",
      lastName: "Other",
      company: "Analytical Engines",
    });

    // Spread creation dates and activity so date filters and sorting are deterministic.
    const client = await db();
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    for (const [name, n] of [
      ["Ada", 1],
      ["Grace", 2],
      ["Alan", 3],
      ["Linus", 4],
      ["Margaret", 5],
    ] as const) {
      await client.customer.update({
        where: { id: ids[name] },
        data: { createdAt: day(n), lastActivityAt: day(10 - n) },
      });
    }

    const vip = await seedTag(t.orgA.id, "VIP");
    const trial = await seedTag(t.orgA.id, "Trial");
    ids.vip = vip.id;
    ids.trial = trial.id;
    await seedTagLink(t.orgA.id, ids.Ada, vip.id);
    await seedTagLink(t.orgA.id, ids.Ada, trial.id);
    await seedTagLink(t.orgA.id, ids.Grace, vip.id);
  });
  afterAll(disconnectDatabase);

  describe("defaults and shape", () => {
    it("excludes archived customers and other tenants by default", async () => {
      const res = await list({ sort: "createdAt", order: "asc" });
      expect(names(res.items)).toEqual(["Ada", "Grace", "Alan", "Linus", "Margaret"]);
      expect(res.total).toBe(5);
    });

    it("returns table fields and tags only, never notes or activities", async () => {
      const res = await list({ q: "ada" });
      const [ada] = res.items;
      expect(ada.tags.map((tag) => tag.name)).toEqual(["Trial", "VIP"]);
      expect(Object.keys(ada)).not.toEqual(expect.arrayContaining(["notes", "activities"]));
      expect(ada).not.toHaveProperty("metadata");
    });
  });

  describe("pagination", () => {
    it("pages without overlap or gaps and reports totals", async () => {
      const query = { sort: "createdAt", order: "asc", pageSize: "2" };
      const p1 = await list({ ...query, page: "1" });
      const p2 = await list({ ...query, page: "2" });
      const p3 = await list({ ...query, page: "3" });
      expect(p1).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
      expect([...p1.items, ...p2.items, ...p3.items].map((c) => c.firstName)).toEqual([
        "Ada",
        "Grace",
        "Alan",
        "Linus",
        "Margaret",
      ]);
      expect(p3.items).toHaveLength(1);
    });

    it("returns an empty page beyond the end and rejects invalid sizes", async () => {
      expect((await list({ page: "9" })).items).toEqual([]);
      expect((await call(listRoute, { query: { pageSize: "101" } })).status).toBe(400);
      expect((await call(listRoute, { query: { page: "0" } })).status).toBe(400);
    });

    it("keeps pages stable when the sort key has ties", async () => {
      const client = await db();
      await client.customer.updateMany({
        where: { organizationId: t.orgA.id },
        data: { createdAt: new Date(Date.UTC(2026, 5, 1)) },
      });
      const seen = new Set<string>();
      for (const page of ["1", "2", "3"]) {
        for (const item of (await list({ pageSize: "2", page })).items) seen.add(item.id);
      }
      expect(seen.size).toBe(5);
    });
  });

  describe("search (in the database)", () => {
    it.each([
      ["first name", "grac", ["Grace"]],
      ["last name, case-insensitive", "TURING", ["Alan"]],
      ["email fragment", "bletchley", ["Alan"]],
      ["company", "navy", ["Grace"]],
      ["formatted phone", "(555) 0101", ["Grace"]],
      ["multiple tokens must all match", "ada lovelace", ["Ada"]],
      ["tokens across different fields", "margaret nasa", ["Margaret"]],
    ])("matches %s", async (_label, q, expected) => {
      expect(names((await list({ q })).items)).toEqual(expected);
    });

    it("returns nothing when tokens do not match the same customer", async () => {
      expect((await list({ q: "ada hopper" })).total).toBe(0);
    });

    it("treats SQL wildcards literally", async () => {
      expect((await list({ q: "%" })).total).toBe(0);
      expect((await list({ q: "_" })).total).toBe(0);
    });

    it("combines search with archived inclusion", async () => {
      expect((await list({ q: "archived" })).total).toBe(0);
      expect((await list({ q: "archived", includeArchived: "true" })).total).toBe(1);
    });
  });

  describe("filters", () => {
    it("filters by status, including multiple statuses", async () => {
      expect(names((await list({ status: "INACTIVE" })).items)).toEqual(["Alan"]);
      expect((await list({ status: "ACTIVE,INACTIVE" })).total).toBe(5);
      expect(names((await list({ status: "ARCHIVED" })).items)).toEqual(["Archived"]);
    });

    it("filters by tag, requiring every selected tag", async () => {
      expect(
        names((await list({ tagIds: ids.vip, sort: "createdAt", order: "asc" })).items),
      ).toEqual(["Ada", "Grace"]);
      expect(names((await list({ tagIds: `${ids.vip},${ids.trial}` })).items)).toEqual(["Ada"]);
    });

    it("filters by company and source case-insensitively", async () => {
      expect(names((await list({ company: "us navy" })).items)).toEqual(["Grace"]);
      expect((await list({ source: "WEB" })).total).toBe(3);
    });

    it("filters by creation date range (inclusive)", async () => {
      const res = await list({
        createdFrom: "2026-01-02T00:00:00.000Z",
        createdTo: "2026-01-04T00:00:00.000Z",
        sort: "createdAt",
        order: "asc",
      });
      expect(names(res.items)).toEqual(["Grace", "Alan", "Linus"]);
    });

    it("combines filters with AND", async () => {
      const res = await list({ source: "web", status: "ACTIVE", q: "a" });
      expect(names(res.items).sort()).toEqual(["Ada", "Margaret"]);
    });
  });

  describe("sorting", () => {
    it("sorts by name with missing last names last, both directions", async () => {
      expect(names((await list({ sort: "name", order: "asc" })).items)).toEqual([
        "Ada",
        "Alan",
        "Grace",
        "Linus",
        "Margaret",
      ]);
      expect(names((await list({ sort: "name", order: "desc" })).items)).toEqual([
        "Margaret",
        "Linus",
        "Grace",
        "Alan",
        "Ada",
      ]);
    });

    it("sorts by createdAt, updatedAt and lastActivityAt", async () => {
      expect(names((await list({ sort: "createdAt", order: "desc" })).items)[0]).toBe("Margaret");
      // lastActivityAt was set to day(10 - n): Ada has the most recent activity.
      expect(names((await list({ sort: "lastActivityAt", order: "desc" })).items)[0]).toBe("Ada");
      expect(names((await list({ sort: "lastActivityAt", order: "asc" })).items)[0]).toBe(
        "Margaret",
      );

      const client = await db();
      await client.customer.update({ where: { id: ids.Alan }, data: { updatedAt: new Date() } });
      expect(names((await list({ sort: "updatedAt", order: "desc" })).items)[0]).toBe("Alan");
    });

    it("rejects unsupported sort fields", async () => {
      expect((await call(listRoute, { query: { sort: "email" } })).status).toBe(400);
    });
  });
});
