import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/db/client", () => ({ getDb: () => ({ $queryRaw: queryRaw }) }));
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { checkHealth } from "./health";

describe("checkHealth", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("reports ok when the database responds", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    expect(await checkHealth()).toEqual({ status: "ok", checks: { database: "up" } });
  });

  it("reports degraded when the database is unreachable", async () => {
    queryRaw.mockRejectedValue(new Error("connection refused"));
    expect(await checkHealth()).toEqual({ status: "degraded", checks: { database: "down" } });
  });
});
