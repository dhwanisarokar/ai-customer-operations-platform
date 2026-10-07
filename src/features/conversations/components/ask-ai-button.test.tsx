// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskAiButton } from "./ask-ai-button";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AskAiButton", () => {
  it("calls the server API (never an AI provider) with no parameters, then refreshes", async () => {
    fetchMock.mockResolvedValue(json(201, { message: { id: "m1" } }));
    const user = userEvent.setup();
    render(<AskAiButton conversationId="c1" />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/ai-reply");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("shows a busy state and blocks double clicks while generating", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<AskAiButton conversationId="c1" />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));
    const busy = screen.getByRole("button", { name: /Generating reply/ });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(json(201, {}));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the safe API error and does not refresh when generation fails", async () => {
    fetchMock.mockResolvedValue(
      json(502, {
        error: {
          code: "ai_unavailable",
          message: "The AI service is temporarily unavailable. Please try again.",
        },
      }),
    );
    const user = userEvent.setup();
    render(<AskAiButton conversationId="c1" />);
    await user.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("is disabled when told so (resolved conversations)", () => {
    render(<AskAiButton conversationId="c1" disabled />);
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeDisabled();
  });
});
