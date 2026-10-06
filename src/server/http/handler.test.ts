import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForbiddenError, UnauthorizedError } from "@/server/errors";
import { apiHandler, parseJsonBody } from "./handler";

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ctx = { params: Promise.resolve({}) };
const request = (body?: string) => new Request("http://localhost/api/x", { method: "POST", body });

describe("apiHandler", () => {
  it("maps application errors to their status without leaking internals", async () => {
    const res = await apiHandler(async () => {
      throw new ForbiddenError();
    })(request(), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("returns 401 for unauthenticated errors", async () => {
    const res = await apiHandler(async () => {
      throw new UnauthorizedError();
    })(request(), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 with field details for schema violations", async () => {
    const res = await apiHandler(async (req) => {
      await parseJsonBody(req, z.object({ name: z.string().min(1) }));
      return new Response("ok");
    })(request(JSON.stringify({ name: "" })), ctx);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.details[0].path).toBe("name");
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await apiHandler(async (req) => {
      await parseJsonBody(req, z.object({}));
      return new Response("ok");
    })(request("{not json"), ctx);
    expect(res.status).toBe(400);
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const res = await apiHandler(async () => {
      throw new Error("password=hunter2 at /srv/app/secret.ts");
    })(request(), ctx);
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(500);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("internal_error");
  });
});
