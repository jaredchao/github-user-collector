// The allow-list here is noise control, NOT a security boundary. Do not
// mistake it for one.
//
// The SDK posts with sendBeacon and a text/plain body, which is a CORS
// *simple request*: no preflight, so the request reaches this function and
// is stored regardless of what this file decides. All the browser does with
// a missing Access-Control-Allow-Origin is hide the response — and a beacon
// is fire-and-forget, so nobody was reading it. Verified by posting from an
// unlisted origin: 204, no CORS header, row in the database 45 seconds later.
//
// What the list actually buys: listed origins get a clean console instead of
// a red CORS error on every flush. That is worth having, and it is all it is.
//
// The real defences are elsewhere — payload validation, field truncation,
// per-site isolation, and the API Gateway rate limit. This endpoint is
// writable by anyone who can run curl, by construction: it has to be, since
// it is called from every visitor's browser with no credentials.
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
