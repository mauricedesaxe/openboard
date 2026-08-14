import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { checkProductionHealth } from "../src/server/health";

import { workerFetch } from "./support";

const healthResponseSchema = z.object({
  status: z.enum(["ok", "unavailable"]),
});

describe("production health", () => {
  test("reports a valid Worker configuration and reachable D1 database", async () => {
    const response = await workerFetch("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
    });
  });

  test("reports an unavailable D1 database without exposing its error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const database = {
      prepare: () => ({
        first: () => Promise.reject(new Error("private database detail")),
      }),
    } as unknown as D1Database;

    const response = await checkProductionHealth(database);

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "unavailable",
    });
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        event: "production_health_database_unavailable",
        error: "private database detail",
      }),
    );
    consoleError.mockRestore();
  });
});
