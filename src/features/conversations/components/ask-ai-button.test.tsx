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
import { AskAiButton } from "./ask-ai-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draft = { draft: "Hi!", grounded: false, intent: "CONVERSATIONAL", sources: [] };

describe("AskAiButton", () => {
  it("calls the server API (never an AI provider) with no parameters and hands over the draft", async () => {
    const onDraft = vi.fn();
    const api = mockApi({ "POST /api/conversations/c1/ai-draft": () => json(200, draft) });
    const user = userEvent.setup();
    renderWithQuery(<AskAiButton conversationId="c1" onDraft={onDraft} />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    await waitFor(() => expect(onDraft).toHaveBeenCalledWith(draft));
    expect(api.count("POST", "/api/conversations/c1/ai-draft")).toBe(1);
    expect(api.calls[0].body).toBeUndefined();
    expect(api.calls.every((c) => !c.url.includes("/messages"))).toBe(true);
  });

  it("shows 'Generating AI draft...' while the server works and blocks double clicks", async () => {
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/conversations/c1/ai-draft": () => gate.promise });
    const user = userEvent.setup();
    renderWithQuery(<AskAiButton conversationId="c1" onDraft={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    const busy = await screen.findByRole("button", { name: /Generating AI draft/ });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(api.count("POST", "/api/conversations/c1/ai-draft")).toBe(1);

    gate.resolve(json(200, draft));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask AI" })).toBeEnabled());
  });

  it("shows the safe API error on failure, produces no draft, and lets the user try again", async () => {
    const onDraft = vi.fn();
    mockApi({
      "POST /api/conversations/c1/ai-draft": () =>
        apiError(
          502,
          "ai_unavailable",
          "The AI service is temporarily unavailable. Please try again.",
        ),
    });
    const user = userEvent.setup();
    renderWithQuery(<AskAiButton conversationId="c1" onDraft={onDraft} />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(onDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeEnabled();
  });

  it("is disabled when told so (resolved conversations)", () => {
    renderWithQuery(<AskAiButton conversationId="c1" disabled onDraft={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeDisabled();
  });
});
