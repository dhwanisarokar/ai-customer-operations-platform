import { existsSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerDetailPage from "@/app/(app)/dashboard/customers/[customerId]/page";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { setupAiTenants } from "../helpers/knowledge";
import { resetSession } from "../helpers/mocks";
import { as, seedCustomer } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

/** Collects the props of every element of a React tree whose component is called `name`. */
function findProps(node: ReactNode, name: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: ReactNode) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isValidElement(value)) return;
    const type = value.type as { name?: string; displayName?: string } | string;
    if (typeof type !== "string" && (type.name === name || type.displayName === name)) {
      found.push(value.props as Record<string, unknown>);
    }
    visit((value.props as { children?: ReactNode }).children);
  };
  visit(node);
  return found;
}

const render = (customerId: string) =>
  CustomerDetailPage({ params: Promise.resolve({ customerId }) });

/** Next.js signals notFound() with an error whose digest is NEXT_HTTP_ERROR_FALLBACK;404. */
const isNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  String((error as { digest?: unknown }).digest).includes("404");

describe("the customer detail route exists for every customer row link", () => {
  it("has the dynamic page and its not-found boundary where the list links to", () => {
    const base = join(process.cwd(), "src/app/(app)/dashboard/customers/[customerId]");
    expect(existsSync(join(base, "page.tsx"))).toBe(true);
    expect(existsSync(join(base, "not-found.tsx"))).toBe(true);
    // The staff-only portal endpoints used by the detail page.
    for (const route of ["portal-invite", "portal-access"]) {
      expect(
        existsSync(join(process.cwd(), `src/app/api/customers/[customerId]/${route}/route.ts`)),
      ).toBe(true);
    }
  });
});

describeDb("customer detail page (what clicking a customer row renders)", () => {
  let t: Awaited<ReturnType<typeof setupAiTenants>>;

  beforeEach(async () => {
    resetSession();
    await resetDatabase();
    t = await setupAiTenants();
  });
  afterAll(disconnectDatabase);

  it("opens every customer of the organization, with the portal controls for admins", async () => {
    const jhon = await seedCustomer(t.orgA.id, {
      firstName: "Jhon",
      lastName: "Doe",
      email: "jhon@example.com",
    });
    for (const customer of [t.customerA, jhon]) {
      as(t.adminA);
      const page = await render(customer.id);
      const views = findProps(page, "CustomerDetailView");
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ customerId: customer.id });
      expect(findProps(page, "PortalAccessCard")).toEqual([{ customerId: customer.id }]);
    }
  });

  it("members (no manage_portal) see the customer but not the portal controls", async () => {
    as(t.memberA);
    const page = await render(t.customerA.id);
    expect(findProps(page, "CustomerDetailView")).toHaveLength(1);
    expect(findProps(page, "PortalAccessCard")).toHaveLength(0);
  });

  it("archived and inactive customers still open", async () => {
    const archived = await seedCustomer(t.orgA.id, {
      firstName: "Old",
      email: "old@a.test",
      status: "ARCHIVED",
    });
    as(t.adminA);
    expect(findProps(await render(archived.id), "CustomerDetailView")).toHaveLength(1);
  });

  it("another organization's customer, an unknown id and a malformed id are all not found", async () => {
    as(t.adminA);
    for (const id of [t.customerB.id, "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01", "not-a-uuid"]) {
      const result = await render(id).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isNotFound(result), `id ${id}`).toBe(true);
    }
    // ... and the reverse direction: organization B cannot open A's customer.
    as(t.ownerB);
    const cross = await render(t.customerA.id).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isNotFound(cross)).toBe(true);
  });

  it("a signed-out visitor is not given the page", async () => {
    const result = await render(t.customerA.id).then(
      () => null,
      (error: unknown) => error,
    );
    expect(result).not.toBeNull(); // redirected to sign-in (a redirect error), never rendered
    expect(isNotFound(result)).toBe(false);
  });
});
