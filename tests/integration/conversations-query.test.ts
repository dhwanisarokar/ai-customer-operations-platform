import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute } from "@/app/api/conversations/route";
import { call } from "../helpers/api";
import { seedConversation, seedMessage, setupConversationTenants } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, seedCustomer } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type Item = { id: string; subject: string; customer: { name: string }; unread: boolean };

describeDb("inbox list: search, filters, sorting, pagination", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;
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
  const subjects = (items: Item[]) => items.map((c) => c.subject);

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
    as(t.memberA);

    const bob = await seedCustomer(t.orgA.id, {
      firstName: "Bob",
      lastName: "Stone",
      email: "bob@globex.test",
      company: "Globex",
    });
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    const rows = [
      {
        key: "billing",
        subject: "Billing question",
        customer: t.customerA.id,
        status: "OPEN",
        priority: "NORMAL",
        assignee: t.memberA.id,
        n: 1,
      },
      {
        key: "login",
        subject: "Login problem",
        customer: bob.id,
        status: "OPEN",
        priority: "HIGH",
        assignee: null,
        n: 2,
      },
      {
        key: "refund",
        subject: "Refund request",
        customer: t.customerA.id,
        status: "PENDING",
        priority: "URGENT",
        assignee: t.adminA.id,
        n: 3,
      },
      {
        key: "feature",
        subject: "Feature idea",
        customer: bob.id,
        status: "RESOLVED",
        priority: "LOW",
        assignee: null,
        n: 4,
      },
      {
        key: "outage",
        subject: "Outage report",
        customer: bob.id,
        status: "OPEN",
        priority: "URGENT",
        assignee: t.memberA.id,
        n: 5,
      },
    ] as const;
    for (const r of rows) {
      const c = await seedConversation(t.orgA.id, r.customer, {
        subject: r.subject,
        status: r.status,
        priority: r.priority,
        assignedToUserId: r.assignee,
        lastMessageAt: day(r.n),
        createdAt: day(10 - r.n),
      });
      ids[r.key] = c.id;
    }
    // Same-looking data in another tenant must never show up.
    await seedConversation(t.orgB.id, t.customerB.id, { subject: "Billing question" });
  });
  afterAll(disconnectDatabase);

  describe("defaults and shape", () => {
    it("returns only the caller's organization, newest activity first, with list-only fields", async () => {
      const res = await list();
      expect(subjects(res.items)).toEqual([
        "Outage report",
        "Feature idea",
        "Refund request",
        "Login problem",
        "Billing question",
      ]);
      expect(res.total).toBe(5);
      const [first] = res.items;
      expect(first).toMatchObject({
        customer: { name: "Bob Stone" },
        assignee: { id: t.memberA.id },
      });
      expect(first).not.toHaveProperty("messages");
      expect(first).not.toHaveProperty("events");
    });
  });

  describe("pagination", () => {
    it("pages without overlap or gaps and reports totals", async () => {
      const p1 = await list({ pageSize: "2", page: "1" });
      const p2 = await list({ pageSize: "2", page: "2" });
      const p3 = await list({ pageSize: "2", page: "3" });
      expect(p1).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
      expect([...p1.items, ...p2.items, ...p3.items].map((c) => c.id)).toEqual([
        ids.outage,
        ids.feature,
        ids.refund,
        ids.login,
        ids.billing,
      ]);
      expect((await list({ page: "9" })).items).toEqual([]);
    });

    it("rejects invalid page parameters", async () => {
      expect((await call(listRoute, { query: { pageSize: "101" } })).status).toBe(400);
      expect((await call(listRoute, { query: { page: "0" } })).status).toBe(400);
    });
  });

  describe("search", () => {
    it.each([
      ["subject", "refund", ["Refund request"]],
      ["customer first name", "alice", ["Refund request", "Billing question"]],
      ["customer email", "globex", ["Outage report", "Feature idea", "Login problem"]],
      ["customer company", "acme", ["Refund request", "Billing question"]],
      ["terms across subject and customer", "login globex", ["Login problem"]],
    ])("matches %s", async (_label, q, expected) => {
      expect(subjects((await list({ q })).items)).toEqual(expected);
    });

    it("treats SQL wildcards literally and finds nothing for unmatched terms", async () => {
      expect((await list({ q: "%" })).total).toBe(0);
      expect((await list({ q: "_" })).total).toBe(0);
      expect((await list({ q: "zzz" })).total).toBe(0);
    });
  });

  describe("filters", () => {
    it("filters by status (single and multiple)", async () => {
      expect(subjects((await list({ status: "PENDING" })).items)).toEqual(["Refund request"]);
      expect((await list({ status: "OPEN,PENDING" })).total).toBe(4);
    });

    it("filters by priority", async () => {
      expect(subjects((await list({ priority: "URGENT" })).items)).toEqual([
        "Outage report",
        "Refund request",
      ]);
      expect((await list({ priority: "HIGH,URGENT" })).total).toBe(3);
    });

    it("filters by assignee: me, unassigned, or a specific member", async () => {
      expect(subjects((await list({ assignee: "me" })).items)).toEqual([
        "Outage report",
        "Billing question",
      ]);
      expect(subjects((await list({ assignee: "unassigned" })).items)).toEqual([
        "Feature idea",
        "Login problem",
      ]);
      expect(subjects((await list({ assignee: t.adminA.id })).items)).toEqual(["Refund request"]);
      as(t.adminA);
      expect(subjects((await list({ assignee: "me" })).items)).toEqual(["Refund request"]);
    });

    it("filters by customer and channel", async () => {
      expect((await list({ customerId: t.customerA.id })).total).toBe(2);
      expect((await list({ channel: "IN_APP" })).total).toBe(5);
      expect((await call(listRoute, { query: { channel: "EMAIL" } })).status).toBe(400);
    });

    it("combines filters with AND", async () => {
      const res = await list({ status: "OPEN", priority: "URGENT", assignee: "me" });
      expect(subjects(res.items)).toEqual(["Outage report"]);
    });

    it("never returns another organization's conversation for a customer or assignee filter", async () => {
      expect((await list({ customerId: t.customerB.id })).total).toBe(0);
      expect((await list({ assignee: t.ownerB.id })).total).toBe(0);
    });
  });

  describe("sorting", () => {
    it("sorts by last activity, creation time and priority in both directions", async () => {
      expect(subjects((await list({ sort: "lastMessageAt", order: "asc" })).items)[0]).toBe(
        "Billing question",
      );
      // createdAt was set to day(10 - n): the "billing" conversation (n=1) is the newest.
      expect(subjects((await list({ sort: "createdAt", order: "desc" })).items)[0]).toBe(
        "Billing question",
      );
      expect(
        subjects((await list({ sort: "priority", order: "desc" })).items)
          .slice(0, 2)
          .sort(),
      ).toEqual(["Outage report", "Refund request"]);
      expect(subjects((await list({ sort: "priority", order: "asc" })).items)[0]).toBe(
        "Feature idea",
      );
    });

    it("rejects unsupported sort fields", async () => {
      expect((await call(listRoute, { query: { sort: "subject" } })).status).toBe(400);
    });
  });

  describe("unread indicator in the list", () => {
    it("is computed per member for each row", async () => {
      await seedMessage(t.orgA.id, ids.login, { senderType: "CUSTOMER", body: "hello?" });
      const { getDb } = await import("@/db/client");
      await getDb().conversation.update({
        where: { id: ids.login },
        data: { lastCustomerMessageAt: new Date() },
      });

      const mine = await list();
      expect(mine.items.filter((c) => c.unread).map((c) => c.subject)).toEqual(["Login problem"]);

      await getDb().conversationReadState.create({
        data: {
          organizationId: t.orgA.id,
          conversationId: ids.login,
          userId: t.memberA.id,
          lastReadAt: new Date(Date.now() + 1000),
        },
      });
      expect((await list()).items.some((c) => c.unread)).toBe(false);
      as(t.adminA);
      expect((await list()).items.filter((c) => c.unread)).toHaveLength(1);
    });
  });

  describe("performance: no N+1 queries", () => {
    // Counts real round-trips to PostgreSQL by wrapping pg's client.
    async function countQueries(work: () => Promise<unknown>) {
      const original = pg.Client.prototype.query;
      let count = 0;
      pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
        count++;
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof original;
      try {
        await work();
      } finally {
        pg.Client.prototype.query = original;
      }
      return count;
    }

    it("uses the same number of queries for 2 rows as for 25 rows", async () => {
      await list(); // warm up the connection pool / client
      const small = await countQueries(() => list({ pageSize: "2" }));

      const extraCustomer = await seedCustomer(t.orgA.id, { firstName: "Many" });
      for (let i = 0; i < 25; i++) {
        const c = await seedConversation(t.orgA.id, extraCustomer.id, {
          subject: `Bulk ${i}`,
          assignedToUserId: t.memberA.id,
        });
        await seedMessage(t.orgA.id, c.id, { body: "x" });
      }
      const large = await countQueries(() => list({ pageSize: "25" }));

      expect(small).toBeGreaterThan(0);
      expect(large).toBe(small);
    });
  });
});
