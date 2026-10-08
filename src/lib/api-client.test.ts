import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, fetchJson } from "./api-client";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

/** Awaits a promise that must reject and returns the rejection. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the promise to reject");
}

describe("fetchJson", () => {
  it("returns parsed JSON and sends JSON bodies with the right method and header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchJson("/api/x", { method: "POST", body: { a: 1 } })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/x");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });

  it("returns null for 204 and sends no content-type without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchJson("/api/x", { method: "DELETE" })).toBeNull();
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });

  it("throws ApiError with the server's safe message, code and field errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(400, {
          error: {
            code: "validation_error",
            message: "Invalid request",
            details: [
              { path: "email", message: "Enter a valid email address" },
              { path: "email", message: "ignored duplicate" },
            ],
          },
        }),
      ),
    );
    const error = await failure(fetchJson("/api/x"));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      message: "Invalid request",
      code: "validation_error",
      fieldErrors: { email: "Enter a valid email address" },
      isClientError: true,
    });
  });

  it("falls back to a generic message for non-JSON failures and never leaks the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>stack trace</html>", { status: 500 })),
    );
    const error = await failure(fetchJson("/api/x"));
    expect(error).toMatchObject({ status: 500, isClientError: false });
    expect(error.message).toBe("Something went wrong. Please try again.");
    expect(error.message).not.toContain("stack");
  });

  it("maps network failures to a status-0 ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await failure(fetchJson("/api/x"));
    expect(error).toMatchObject({ status: 0, code: "network_error", isClientError: false });
  });

  it("rethrows cancellation as-is instead of reporting an application error", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    const error = await failure(fetchJson("/api/x", { signal: controller.signal }));
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe("AbortError");
  });
});

describe("apiRequest (non-throwing wrapper)", () => {
  it("returns ok results and structured failures without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(200, { a: 1 })));
    expect(await apiRequest("/api/x")).toEqual({ ok: true, status: 200, data: { a: 1 } });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(json(409, { error: { code: "conflict", message: "Already exists" } })),
    );
    expect(await apiRequest("/api/x")).toEqual({
      ok: false,
      status: 409,
      message: "Already exists",
      fieldErrors: {},
    });
  });
});

describe("fetchJson: validation problems", () => {
  it("exposes the problems of a definition validation error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(400, {
          error: {
            code: "validation_error",
            message: "The automation is not valid",
            details: { problems: ["Condition 1: a value is required."] },
          },
        }),
      ),
    );
    const error = await failure(fetchJson("/api/x"));
    expect(error.problems).toEqual(["Condition 1: a value is required."]);
    expect(error.fieldErrors).toEqual({});
  });

  it("still maps field-level Zod details and tolerates other shapes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(400, {
          error: {
            code: "validation_error",
            message: "Invalid",
            details: [{ path: "name", message: "Required" }],
          },
        }),
      ),
    );
    const error = await failure(fetchJson("/api/x"));
    expect(error.fieldErrors).toEqual({ name: "Required" });
    expect(error.problems).toEqual([]);
  });
});
