// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerForm } from "./customer-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn() }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  push.mockReset();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("CustomerForm", () => {
  it("shows field errors and sends nothing when input is invalid", async () => {
    const user = userEvent.setup();
    render(<CustomerForm mode="create" />);

    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Create customer" }));

    expect(await screen.findByText("First name is required")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByLabelText(/First name/)).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a customer via POST and navigates to its page", async () => {
    fetchMock.mockResolvedValue(json(201, { customer: { id: "c-1" } }));
    const user = userEvent.setup();
    render(<CustomerForm mode="create" />);

    await user.type(screen.getByLabelText(/First name/), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create customer" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/customers/c-1"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/customers");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ firstName: "Ada", email: "ada@example.com" });
  });

  it("edits via PATCH using prefilled values", async () => {
    fetchMock.mockResolvedValue(json(200, { customer: {} }));
    const user = userEvent.setup();
    render(
      <CustomerForm
        mode="edit"
        customerId="c-9"
        initialValues={{
          firstName: "Grace",
          lastName: "",
          email: "",
          phone: "",
          company: "Navy",
          jobTitle: "",
          source: "",
          status: "ACTIVE",
        }}
      />,
    );
    expect(screen.getByLabelText("Company")).toHaveValue("Navy");

    await user.clear(screen.getByLabelText("Company"));
    await user.type(screen.getByLabelText("Company"), "US Navy");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/customers/c-9"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/customers/c-9");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
  });

  it("surfaces server errors such as a duplicate email without navigating", async () => {
    fetchMock.mockResolvedValue(
      json(409, {
        error: { code: "conflict", message: "A customer with this email already exists" },
      }),
    );
    const user = userEvent.setup();
    render(<CustomerForm mode="create" />);

    await user.type(screen.getByLabelText(/First name/), "Ada");
    await user.click(screen.getByRole("button", { name: "Create customer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(push).not.toHaveBeenCalled();
  });
});
