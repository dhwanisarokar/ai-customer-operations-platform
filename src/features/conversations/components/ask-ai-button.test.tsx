// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiError,
  deferred,
  json,
  mockApi,
  renderWithQuery,
} from "../../../../tests/helpers/query";
import { message } from "../../../../tests/helpers/fixtures";
import { AskAiButton } from "./ask-ai-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AskAiButton", () => {
  it("calls the server API (never an AI provider) with no parameters", async () => {
    const api = mockApi({
      "POST /api/conversations/c1/ai-reply": () =>
        json(201, { message: message({ senderType: "AI_AGENT" }) }),
      "GET /api/conversations": () => json(200, {}),
    });
    const user = userEvent.setup();
    renderWithQuery(<AskAiButton conversationId="c1" />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/ai-reply")).toBe(1));
    expect(api.calls[0].body).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask AI" })).toBeEnabled());
  });

  it("shows 'Generating AI reply...' while the server works and blocks double clicks", async () => {
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/conversations/c1/ai-reply": () => gate.promise });
    const user = userEvent.setup();
    renderWithQuery(<AskAiButton conversationId="c1" />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    const busy = await screen.findByRole("button", { name: /Generating AI reply/ });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(api.count("POST", "/api/conversations/c1/ai-reply")).toBe(1);

    gate.resolve(json(201, { message: message({ senderType: "AI_AGENT" }) }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask AI" })).toBeEnabled());
  });

  it("shows the safe API error when generation fails, then lets the user try again", async () => {
    mockApi({
      "POST /api/conversations/c1/ai-reply": () =>
        apiError(
          502,
          "ai_unavailable",
          "The AI service is temporarily unavailable. Please try again.",
        ),
    });
    const user = userEvent.setup();
    renderWithQuery(<AskAiButton conversationId="c1" />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeEnabled();
  });

  it("is disabled when told so (resolved conversations)", () => {
    renderWithQuery(<AskAiButton conversationId="c1" disabled />);
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeDisabled();
  });
});
