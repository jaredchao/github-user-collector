// The ingest endpoint is called from browsers on whichever sites embed the
// SDK, so the allow-list is configuration, not a constant. An empty list
// means "any origin", which is the sane default for a write-only telemetry
// endpoint that stores nothing an attacker could read back.
export function corsHeaders(origin: string | undefined, allowed: readonly string[]): Record<string, string> {
  const base = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };

  if (allowed.length === 0) return { ...base, "Access-Control-Allow-Origin": "*" };
  if (origin && allowed.includes(origin)) {
    // Echoing the origin requires Vary, or a shared cache will serve one
    // site's CORS decision to another.
    return { ...base, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { ...base, Vary: "Origin" };
}

export function parseOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
