import { env } from "cloudflare:workers";
import { describe, expect, test, vi } from "vitest";

import type { Environment } from "../src/server/environment";
import { checkProductionHealth } from "../src/server/health";
import worker from "../src/worker";

import { workerFetch } from "./support";

describe("production health", () => {
  test("reports a valid Worker configuration and reachable D1 database", async () => {
    const response = await workerFetch("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("reports invalid Worker configuration without exposing its issues", async () => {
    const response = await worker.fetch(
      new Request("https://localhost/api/health") as unknown as Parameters<
        typeof worker.fetch
      >[0],
      {
        ...(env as unknown as Environment),
        BETTER_AUTH_SECRET: "short",
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "unavailable" });
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
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({
        event: "production_health_database_unavailable",
        error: "private database detail",
      }),
    );
    consoleError.mockRestore();
  });
});
