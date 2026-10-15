// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, mockApi, renderWithQuery } from "../../../../tests/helpers/query";
import { EmailSettingsCard, type EmailSettingsJson } from "./email-settings-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = (overrides: Partial<EmailSettingsJson> = {}): { settings: EmailSettingsJson } => ({
  settings: {
    available: true,
    platformDomain: "mail.platform.test",
    enabled: false,
    status: "UNCONFIGURED",
    statusDetail: null,
    localPart: null,
    supportAddress: null,
    fromName: null,
    suggestedLocalPart: "acme",
    ...overrides,
  },
});

describe("EmailSettingsCard", () => {
  it("shows a loading state, then the unconfigured form with the suggested name and domain", async () => {
    mockApi({ "GET /api/email-settings": () => json(200, settings()) });
    renderWithQuery(<EmailSettingsCard />);
    expect(screen.getByText(/loading email settings/i)).toBeInTheDocument();
    expect(await screen.findByLabelText("Support address")).toHaveValue("acme");
    expect(screen.getByText("@mail.platform.test")).toBeInTheDocument();
    expect(screen.getByText("Not set up")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    // Nothing to verify or turn on until an address is saved.
    expect(screen.queryByRole("button", { name: /verify/i })).not.toBeInTheDocument();
  });

  it("explains when the platform has no email provider and offers no form", async () => {
    mockApi({
      "GET /api/email-settings": () =>
        json(200, settings({ available: false, platformDomain: null })),
    });
    renderWithQuery(<EmailSettingsCard />);
    expect(await screen.findByText(/not available on this platform yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Support address")).not.toBeInTheDocument();
  });

  it("saves the address and sender name", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/email-settings": () => json(200, settings()),
      "PUT /api/email-settings": () =>
        json(
          200,
          settings({
            status: "PENDING_VERIFICATION",
            localPart: "help",
            supportAddress: "help@mail.platform.test",
            fromName: "Acme Care",
          }),
        ),
    });
    renderWithQuery(<EmailSettingsCard />);
    const local = await screen.findByLabelText("Support address");
    await user.clear(local);
    await user.type(local, "help");
    await user.type(screen.getByLabelText("Sender name"), "Acme Care");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Waiting for verification")).toBeInTheDocument());
    expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
      localPart: "help",
      fromName: "Acme Care",
    });
  });

  it("keeps Save disabled until both fields are filled", async () => {
    mockApi({ "GET /api/email-settings": () => json(200, settings()) });
    renderWithQuery(<EmailSettingsCard />);
    await screen.findByLabelText("Support address");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("pending: the toggle is disabled until the address is verified", async () => {
    mockApi({
      "GET /api/email-settings": () =>
        json(
          200,
          settings({
            status: "PENDING_VERIFICATION",
            localPart: "help",
            supportAddress: "help@mail.platform.test",
            fromName: "Acme",
          }),
        ),
    });
    renderWithQuery(<EmailSettingsCard />);
    expect(await screen.findByRole("checkbox", { name: /turn email on/i })).toBeDisabled();
    expect(screen.getByText(/verify the address first/i)).toBeInTheDocument();
  });

  it("verifies, then lets the admin turn email on", async () => {
    const user = userEvent.setup();
    const base = {
      localPart: "help",
      supportAddress: "help@mail.platform.test",
      fromName: "Acme",
    };
    const api = mockApi({
      "GET /api/email-settings": () =>
        json(200, settings({ ...base, status: "PENDING_VERIFICATION" })),
      "POST /api/email-settings/verify": () => json(200, settings({ ...base, status: "ACTIVE" })),
      "PUT /api/email-settings/enabled": () =>
        json(200, settings({ ...base, status: "ACTIVE", enabled: true })),
    });
    renderWithQuery(<EmailSettingsCard />);
    await user.click(await screen.findByRole("button", { name: "Verify address" }));
    const toggle = await screen.findByRole("checkbox", { name: /turn email on/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.getByText("Verified")).toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() => expect(screen.getByText("On")).toBeInTheDocument());
    expect(api.calls.find((c) => c.url.endsWith("/enabled"))?.body).toEqual({ enabled: true });
  });

  it("shows a failed verification with its short code and keeps the toggle off", async () => {
    mockApi({
      "GET /api/email-settings": () =>
        json(
          200,
          settings({
            status: "FAILED",
            statusDetail: "provider_rejected",
            localPart: "help",
            supportAddress: "help@mail.platform.test",
            fromName: "Acme",
          }),
        ),
    });
    renderWithQuery(<EmailSettingsCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/provider_rejected/);
    expect(screen.getByRole("checkbox", { name: /turn email on/i })).toBeDisabled();
  });

  it("shows the server's message when saving is refused (address taken)", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/email-settings": () => json(200, settings({ suggestedLocalPart: "taken" })),
      "PUT /api/email-settings": () =>
        apiError(409, "CONFLICT", "That address is already taken. Choose another."),
    });
    renderWithQuery(<EmailSettingsCard />);
    await user.type(await screen.findByLabelText("Sender name"), "Acme");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already taken/i);
  });

  it("shows an error with a retry when loading fails", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockApi({
      "GET /api/email-settings": () =>
        fail ? apiError(500, "INTERNAL", "boom") : json(200, settings()),
    });
    renderWithQuery(<EmailSettingsCard />);
    expect(await screen.findByText(/could not load the email settings/i)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByLabelText("Support address")).toBeInTheDocument();
  });

  it("renders nothing when the server says the viewer lacks permission", async () => {
    mockApi({ "GET /api/email-settings": () => apiError(403, "FORBIDDEN", "Forbidden") });
    const { container } = renderWithQuery(<EmailSettingsCard />);
    await waitFor(() =>
      expect(screen.queryByText(/loading email settings/i)).not.toBeInTheDocument(),
    );
    expect(container).toBeEmptyDOMElement();
  });
});
