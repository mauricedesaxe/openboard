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
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "production_health_database_unavailable",
        error: error instanceof Error ? error.message : "Unknown D1 error",
      }),
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
