// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, mockApi, renderWithQuery } from "../../../../tests/helpers/query";
import { embedSnippet, WidgetSettingsForm } from "./widget-settings-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = {
  publicKey: "wk_abcdefabcdefabcdef",
  enabled: false,
  displayName: "Support",
  welcomeMessage: "Hi!",
  accentColor: null,
  allowedOrigins: [],
  aiRepliesEnabled: false,
};

describe("WidgetSettingsForm", () => {
  it("shows the embed snippet with the public key", async () => {
    mockApi({ "GET /api/widget-settings": () => json(200, { settings }) });
    renderWithQuery(<WidgetSettingsForm origin="https://app.example.com" />);
    const snippet = (await screen.findByLabelText(
      "Install on your website",
    )) as HTMLTextAreaElement;
    expect(snippet.value).toBe(embedSnippet("https://app.example.com", settings.publicKey));
    expect(snippet.value).toContain('data-key="wk_abcdefabcdefabcdef"');
  });

  it("saves the settings and sends only editable fields", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/widget-settings": () => json(200, { settings }),
      "PUT /api/widget-settings": () => json(200, { settings: { ...settings, enabled: true } }),
    });
    renderWithQuery(<WidgetSettingsForm origin="https://app.example.com" />);
    await user.click(await screen.findByLabelText("Enable the chat widget"));
    await user.click(screen.getByLabelText("Answer visitors automatically with AI"));
    await user.type(screen.getByLabelText(/Allowed websites/), "https://shop.example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      enabled: true,
      aiRepliesEnabled: true,
      displayName: "Support",
      welcomeMessage: "Hi!",
      accentColor: null,
      allowedOrigins: ["https://shop.example.com"],
    });
  });

  it("explains when the caller is not an admin", async () => {
    mockApi({ "GET /api/widget-settings": () => apiError(403, "forbidden", "no") });
    renderWithQuery(<WidgetSettingsForm />);
    await waitFor(() => expect(screen.getByText(/Only admins can manage/)).toBeTruthy());
  });
});
