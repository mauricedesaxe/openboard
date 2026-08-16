import { reportOperationalFailure } from "./observability";

export async function checkProductionHealth(
  database: D1Database,
): Promise<Response> {
  try {
    const result = await database
      .prepare("SELECT 1 AS reachable")
      .first<{ reachable: number }>();
    if (result?.reachable !== 1) return productionUnavailableResponse();

    return Response.json(
      { status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: unknown) {
    reportOperationalFailure(
      "production_health_database_unavailable",
      {},
      error,
    );
    return productionUnavailableResponse();
  }
}

export function productionUnavailableResponse(): Response {
  return Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
