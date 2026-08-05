// Session identity and page naming. Both deliberately avoid anything that
// could identify a person: no cookies, no localStorage, no fingerprinting.
// The session id lives in memory only, so it dies with the tab.

export function newId(): string {
  // randomUUID needs a secure context; the fallback keeps the SDK usable on
  // plain-http local development without pulling in a uuid dependency.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Path segments that look like identifiers become placeholders, so that
// /users/torvalds and /users/rust-lang roll up into one page instead of
// creating a metric series per visited profile.
const NUMERIC = /^\d+$/;
const HEXISH = /^[0-9a-f]{8,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const normalized = segments.map((segment) => {
    if (UUID.test(segment)) return ":uuid";
    if (NUMERIC.test(segment)) return ":id";
    if (HEXISH.test(segment)) return ":hash";
    return segment;
  });

  return `/${normalized.join("/")}`;
}

export function connectionType(): string {
  // Non-standard and Chromium-only; absent everywhere else.
  const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
  return nav.connection?.effectiveType ?? "unknown";
}
