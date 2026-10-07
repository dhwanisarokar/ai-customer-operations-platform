// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customersKeys, tagsKeys } from "@/lib/query/query-keys";
import {
  TEST_ORG,
  apiError,
  createTestQueryClient,
  deferred,
  json,
  mockApi,
  noContent,
  renderHookWithQuery,
} from "../../../../tests/helpers/query";
import { customer360, customerList, customerRow } from "../../../../tests/helpers/fixtures";
import type { Customer360Response, CustomerListResponse, CustomerTagsResponse } from "../api/types";
import { listCustomersQuerySchema } from "../schemas";
import {
  useAddCustomerNote,
  useAddCustomerTag,
  useArchiveCustomer,
  useCreateCustomer,
  useRemoveCustomerTag,
  useUpdateCustomer,
} from "./mutations";
import { useCustomer, useCustomers, useCustomerTags } from "./queries";

afterEach(() => vi.unstubAllGlobals());

const query = (extra: Record<string, string> = {}) => listCustomersQuerySchema.parse(extra);

describe("customer queries", () => {
  it("goes loading -> success and requests the API with the query's parameters", async () => {
    const api = mockApi({ "GET /api/customers": () => json(200, customerList([customerRow()])) });
    const { result } = renderHookWithQuery(() =>
      useCustomers(
        query({ q: "ada", page: "2", status: "ACTIVE,INACTIVE", sort: "name", order: "asc" }),
      ),
    );
    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0].firstName).toBe("Alice");

    const url = new URL(api.calls[0].url, "http://x");
    expect(url.pathname).toBe("/api/customers");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "ada",
      page: "2",
      status: "ACTIVE,INACTIVE",
      sort: "name",
      order: "asc",
    });
  });

  it("surfaces API errors with a safe message and does not repeat a rejected request", async () => {
    const api = mockApi({
      "GET /api/customers": () => apiError(403, "forbidden", "You do not have permission"),
    });
    const { result } = renderHookWithQuery(() => useCustomers(query()));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      status: 403,
      message: "You do not have permission",
    });
    expect(api.calls).toHaveLength(1);
  });

  it("gives each page/filter its own cache entry and keeps the previous page visible while the next loads", async () => {
    const gate = deferred<Response>();
    mockApi({
      "GET /api/customers?page=1": () => json(200, customerList([customerRow({ id: "p1" })])),
      "GET /api/customers?page=2": () => gate.promise,
    });
    const { result, rerender, client } = renderHookWithQuery(
      ({ page }: { page: string }) => useCustomers(query({ page })),
      {
        initialProps: { page: "1" },
      },
    );
    await waitFor(() => expect(result.current.data?.items[0].id).toBe("p1"));

    rerender({ page: "2" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.items[0].id).toBe("p1");

    gate.resolve(json(200, customerList([customerRow({ id: "p2" })])));
    await waitFor(() => expect(result.current.data?.items[0].id).toBe("p2"));
    expect(
      client.getQueryCache().findAll({ queryKey: customersKeys.lists(TEST_ORG) }),
    ).toHaveLength(2);
  });

  it("uses server-provided initialData without an immediate request", async () => {
    const api = mockApi({ "GET /api/customers": () => json(200, customerList([])) });
    const initialData = customerList([customerRow({ id: "ssr" })]);
    const { result } = renderHookWithQuery(() => useCustomers(query(), { initialData }));
    expect(result.current.data?.items[0].id).toBe("ssr");
    expect(result.current.isPending).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.calls).toHaveLength(0);
  });

  it("never shares cached data between organizations", async () => {
    const api = mockApi({ "GET /api/customers": () => json(200, customerList([customerRow()])) });
    const client = createTestQueryClient();
    const a = renderHookWithQuery(() => useCustomers(query()), { client, organizationId: "org-a" });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    const b = renderHookWithQuery(() => useCustomers(query()), { client, organizationId: "org-b" });
    expect(b.result.current.data).toBeUndefined(); // org-b did not inherit org-a's data
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));
    expect(api.calls).toHaveLength(2);
  });

  it("fetches a customer 360 and the customer's tags from their own endpoints", async () => {
    const api = mockApi({
      "GET /api/customers/cust1/tags": () =>
        json(200, { tags: [{ id: "t1", name: "VIP", createdAt: "x" }] }),
      "GET /api/customers/cust1": () => json(200, customer360()),
    });
    const { result } = renderHookWithQuery(() => ({
      detail: useCustomer("cust1"),
      tags: useCustomerTags("cust1"),
    }));
    await waitFor(() =>
      expect(result.current.detail.isSuccess && result.current.tags.isSuccess).toBe(true),
    );
    expect(result.current.detail.data?.customer.firstName).toBe("Alice");
    expect(result.current.tags.data?.tags[0].name).toBe("VIP");
    expect(api.calls.map((c) => c.url).sort()).toEqual([
      "/api/customers/cust1",
      "/api/customers/cust1/tags",
    ]);
  });
});

describe("archive customer (optimistic)", () => {
  function seed() {
    const client = createTestQueryClient();
    const defaultList = query();
    const archivedList = query({ status: "ARCHIVED" });
    const allList = query({ includeArchived: "true" });
    const both = customerList([
      customerRow({ id: "cust1" }),
      customerRow({ id: "cust2", firstName: "Bob" }),
    ]);
    client.setQueryData(customersKeys.list(TEST_ORG, defaultList), both);
    client.setQueryData(customersKeys.list(TEST_ORG, archivedList), customerList([]));
    client.setQueryData(customersKeys.list(TEST_ORG, allList), both);
    client.setQueryData(customersKeys.detail(TEST_ORG, "cust1"), customer360());
    return { client, defaultList, archivedList, allList };
  }
  const list = (client: ReturnType<typeof createTestQueryClient>, q: object) =>
    client.getQueryData<CustomerListResponse>(customersKeys.list(TEST_ORG, q))!;

  it("removes the customer from lists that hide archived ones, marks it archived where shown, and flips the detail - before the server answers", async () => {
    const { client, defaultList, allList } = seed();
    const gate = deferred<Response>();
    mockApi({ "DELETE /api/customers/cust1": () => gate.promise });
    const { result } = renderHookWithQuery(() => useArchiveCustomer(), { client });

    act(() => result.current.mutate({ customerId: "cust1" }));
    await waitFor(() =>
      expect(list(client, defaultList).items.map((c) => c.id)).toEqual(["cust2"]),
    );
    expect(list(client, defaultList).total).toBe(1);
    expect(list(client, allList).items.find((c) => c.id === "cust1")?.status).toBe("ARCHIVED");
    expect(
      client.getQueryData<Customer360Response>(customersKeys.detail(TEST_ORG, "cust1"))?.customer
        .status,
    ).toBe("ARCHIVED");

    gate.resolve(noContent());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores everything and exposes the error when the server rejects it", async () => {
    const { client, defaultList, allList } = seed();
    mockApi({
      "DELETE /api/customers/cust1": () =>
        apiError(403, "forbidden", "You do not have permission to perform this action"),
    });
    const { result } = renderHookWithQuery(() => useArchiveCustomer(), { client });

    act(() => result.current.mutate({ customerId: "cust1" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain("do not have permission");
    expect(list(client, defaultList).items.map((c) => c.id)).toEqual(["cust1", "cust2"]);
    expect(list(client, defaultList).total).toBe(2);
    expect(list(client, allList).items.find((c) => c.id === "cust1")?.status).toBe("ACTIVE");
    expect(
      client.getQueryData<Customer360Response>(customersKeys.detail(TEST_ORG, "cust1"))?.customer
        .status,
    ).toBe("ACTIVE");
  });

  it("refetches the authoritative list and detail afterwards (only the affected queries)", async () => {
    const { client, defaultList } = seed();
    const api = mockApi({
      "DELETE /api/customers/cust1": () => noContent(),
      "GET /api/customers/cust1": () => json(200, customer360({ status: "ARCHIVED" })),
      "GET /api/customers?": () =>
        json(200, customerList([customerRow({ id: "cust2", firstName: "Bob" })])),
    });
    const { result } = renderHookWithQuery(
      () => ({
        archive: useArchiveCustomer(),
        list: useCustomers(defaultList),
        detail: useCustomer("cust1"),
      }),
      { client },
    );
    await waitFor(() =>
      expect(result.current.list.isFetching || result.current.list.isSuccess).toBe(true),
    );
    api.calls.length = 0;

    act(() => result.current.archive.mutate({ customerId: "cust1" }));
    await waitFor(() => expect(result.current.archive.isSuccess).toBe(true));
    await waitFor(() => expect(api.count("GET", "/api/customers?")).toBe(1));
    await waitFor(() => expect(api.count("GET", "/api/customers/cust1")).toBe(1));
    expect(api.calls.some((c) => c.url.includes("/tags") || c.url.includes("/notes"))).toBe(false);
  });
});

describe("customer tags (optimistic)", () => {
  const seed = () => {
    const client = createTestQueryClient();
    client.setQueryData<CustomerTagsResponse>(customersKeys.tags(TEST_ORG, "cust1"), {
      tags: [{ id: "t1", name: "VIP", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    client.setQueryData(customersKeys.detail(TEST_ORG, "cust1"), {
      ...customer360(),
      tags: [{ id: "t1", name: "VIP", createdAt: "2026-01-01T00:00:00.000Z" }],
    });
    return client;
  };
  const tags = (client: ReturnType<typeof createTestQueryClient>) =>
    client
      .getQueryData<CustomerTagsResponse>(customersKeys.tags(TEST_ORG, "cust1"))!
      .tags.map((t) => t.name);

  it("adds the tag immediately in the tags list and the 360, with a clearly temporary id for a new tag", async () => {
    const client = seed();
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/customers/cust1/tags": () => gate.promise });
    const { result } = renderHookWithQuery(() => useAddCustomerTag("cust1"), { client });

    act(() => result.current.mutate({ name: "Trial" }));
    await waitFor(() => expect(tags(client)).toEqual(["VIP", "Trial"]));
    const pending = client.getQueryData<CustomerTagsResponse>(
      customersKeys.tags(TEST_ORG, "cust1"),
    )!.tags[1];
    expect(pending.id.startsWith("pending:")).toBe(true);
    expect(
      client
        .getQueryData<Customer360Response>(customersKeys.detail(TEST_ORG, "cust1"))!
        .tags.map((t) => t.name),
    ).toEqual(["VIP", "Trial"]);

    gate.resolve(
      json(201, { tag: { id: "t2", name: "Trial", createdAt: "2026-01-02T00:00:00.000Z" } }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls[0].body).toEqual({ name: "Trial" });
  });

  it("sends the id when an existing tag is chosen", async () => {
    const client = seed();
    const api = mockApi({
      "POST /api/customers/cust1/tags": () =>
        json(201, { tag: { id: "t9", name: "Gold", createdAt: "x" } }),
    });
    const { result } = renderHookWithQuery(() => useAddCustomerTag("cust1"), { client });
    act(() => result.current.mutate({ name: "Gold", tagId: "t9" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls[0].body).toEqual({ tagId: "t9" });
  });

  it("does not add a duplicate optimistically", async () => {
    const client = seed();
    mockApi({
      "POST /api/customers/cust1/tags": () =>
        apiError(409, "conflict", "Tag is already assigned to this customer"),
    });
    const { result } = renderHookWithQuery(() => useAddCustomerTag("cust1"), { client });
    act(() => result.current.mutate({ name: "vip" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(tags(client)).toEqual(["VIP"]);
  });

  it("rolls the tag back and shows the error when adding fails", async () => {
    const client = seed();
    mockApi({
      "POST /api/customers/cust1/tags": () =>
        apiError(403, "forbidden", "You do not have permission to perform this action"),
    });
    const { result } = renderHookWithQuery(() => useAddCustomerTag("cust1"), { client });
    act(() => result.current.mutate({ name: "Trial" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(tags(client)).toEqual(["VIP"]);
    expect(
      client
        .getQueryData<Customer360Response>(customersKeys.detail(TEST_ORG, "cust1"))!
        .tags.map((t) => t.name),
    ).toEqual(["VIP"]);
    expect(result.current.error?.message).toContain("do not have permission");
  });

  it("invalidates tags, detail, the tag catalogue, lists and the activity timeline after settling", async () => {
    const client = seed();
    mockApi({
      "POST /api/customers/cust1/tags": () =>
        json(201, { tag: { id: "t2", name: "Trial", createdAt: "x" } }),
    });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useAddCustomerTag("cust1"), { client });
    act(() => result.current.mutate({ name: "Trial" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(5));
    const keys = spy.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(tagsKeys.list(TEST_ORG)));
    expect(keys).toContain(JSON.stringify(customersKeys.lists(TEST_ORG)));
    expect(keys).toContain(JSON.stringify(customersKeys.tags(TEST_ORG, "cust1")));
    expect(keys).toContain(JSON.stringify(customersKeys.detail(TEST_ORG, "cust1")));
  });

  it("removes a tag optimistically and restores it when the request fails", async () => {
    const client = seed();
    const gate = deferred<Response>();
    mockApi({ "DELETE /api/customers/cust1/tags/t1": () => gate.promise });
    const { result } = renderHookWithQuery(() => useRemoveCustomerTag("cust1"), { client });
    act(() => result.current.mutate({ tagId: "t1" }));
    await waitFor(() => expect(tags(client)).toEqual([]));
    gate.resolve(apiError(500, "internal_error", "Something went wrong"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(tags(client)).toEqual(["VIP"]);
  });
});

describe("other customer mutations", () => {
  it("creating a customer invalidates every customer list, nothing else", async () => {
    const client = createTestQueryClient();
    mockApi({ "POST /api/customers": () => json(201, { customer: { id: "new" } }) });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useCreateCustomer(), { client });
    act(() =>
      result.current.mutate({
        firstName: "Eve",
        lastName: "",
        email: "",
        phone: "",
        company: "",
        jobTitle: "",
        source: "",
        status: "ACTIVE",
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ queryKey: customersKeys.lists(TEST_ORG) });
  });

  it("updating a customer refreshes lists and that customer's queries", async () => {
    const client = createTestQueryClient();
    mockApi({ "PATCH /api/customers/cust1": () => json(200, { customer: {} }) });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useUpdateCustomer("cust1"), { client });
    act(() =>
      result.current.mutate({
        firstName: "Eve",
        lastName: "",
        email: "",
        phone: "",
        company: "",
        jobTitle: "",
        source: "",
        status: "ACTIVE",
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toEqual([customersKeys.lists(TEST_ORG), customersKeys.item(TEST_ORG, "cust1")]);
  });

  it("adding a note refreshes notes, the timeline and the 360 counts, and surfaces failures", async () => {
    const client = createTestQueryClient();
    const api = mockApi({
      "POST /api/customers/cust1/notes": () => json(201, { note: { id: "n1" } }),
    });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useAddCustomerNote("cust1"), { client });
    act(() => result.current.mutate({ content: "Called back" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls[0].body).toEqual({ content: "Called back" });
    expect(spy).toHaveBeenCalledTimes(3);

    mockApi({
      "POST /api/customers/cust1/notes": () => apiError(400, "validation_error", "Invalid request"),
    });
    act(() => result.current.mutate({ content: "" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Invalid request");
  });
});
