// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeActions } from "./knowledge-actions";
import { KnowledgeDocumentForm } from "./knowledge-document-form";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, back: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("KnowledgeDocumentForm", () => {
  it("validates with the server schema and sends nothing when invalid", async () => {
    const user = userEvent.setup();
    render(<KnowledgeDocumentForm mode="create" />);
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByText("Title is required")).toBeInTheDocument();
    expect(screen.getByText("Content is required")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a draft and opens it", async () => {
    fetchMock.mockResolvedValue(json(201, { document: { id: "d1" } }));
    const user = userEvent.setup();
    render(<KnowledgeDocumentForm mode="create" />);
    await user.type(screen.getByLabelText("Title"), "Refund policy");
    await user.type(screen.getByLabelText("Content"), "Refunds within 30 days.");
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/knowledge/d1"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      title: "Refund policy",
      content: "Refunds within 30 days.",
    });
  });

  it("warns that saving a published document re-indexes it, and shows API failures without losing input", async () => {
    fetchMock.mockResolvedValue(
      json(502, {
        error: {
          code: "ai_unavailable",
          message: "The AI service is temporarily unavailable. Please try again.",
        },
      }),
    );
    const user = userEvent.setup();
    render(
      <KnowledgeDocumentForm
        mode="edit"
        documentId="d1"
        live
        initialValues={{ title: "Refunds", description: "", content: "Old" }}
      />,
    );
    expect(screen.getByText(/Saving re-indexes it/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Content"), " plus more");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.getByLabelText("Content")).toHaveValue("Old plus more");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge/d1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("KnowledgeActions", () => {
  it("offers publish and archive for a draft and calls the publish endpoint", async () => {
    fetchMock.mockResolvedValue(json(200, { document: {} }));
    const user = userEvent.setup();
    render(<KnowledgeActions documentId="d1" title="Refunds" status="DRAFT" />);
    expect(screen.queryByRole("button", { name: "Unpublish" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/knowledge/d1/publish");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("offers unpublish for published and restore for archived documents", () => {
    const { rerender } = render(<KnowledgeActions documentId="d1" title="T" status="PUBLISHED" />);
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
    rerender(<KnowledgeActions documentId="d1" title="T" status="ARCHIVED" />);
    expect(screen.getByRole("button", { name: "Restore as draft" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("shows the safe error and keeps the buttons usable when publishing fails", async () => {
    fetchMock.mockResolvedValue(
      json(502, {
        error: {
          code: "ai_embedding_failed",
          message: "Could not generate embeddings. Please try again.",
        },
      }),
    );
    const user = userEvent.setup();
    render(<KnowledgeActions documentId="d1" title="T" status="DRAFT" />);
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not generate embeddings");
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
