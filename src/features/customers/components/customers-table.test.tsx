// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomerRow } from "../api/types";
import { CustomersTable } from "./customers-table";

afterEach(cleanup);

const row = (id: string, firstName: string, lastName: string | null, email: string): CustomerRow =>
  ({
    id,
    firstName,
    lastName,
    email,
    company: null,
    status: "ACTIVE",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as CustomerRow;

describe("CustomersTable row links", () => {
  it("links each customer to /dashboard/customers/{its own id}", () => {
    const ids = ["208fb26b-2484-4dc0-9a4b-11ce2dddfb6a", "9900eee0-df1e-4ef2-b837-dc0a87aa0bf0"];
    render(
      <CustomersTable
        customers={[
          row(ids[0], "Jhon", "Doe", "jhon@example.com"),
          row(ids[1], "Alice", "Anders", "alice@a.test"),
        ]}
        sort="createdAt"
        order="desc"
        params={{}}
      />,
    );
    expect(screen.getByRole("link", { name: "Jhon Doe" }).getAttribute("href")).toBe(
      `/dashboard/customers/${ids[0]}`,
    );
    expect(screen.getByRole("link", { name: "Alice Anders" }).getAttribute("href")).toBe(
      `/dashboard/customers/${ids[1]}`,
    );
  });
});
