import { Hono } from "hono";
import { cors } from "hono/cors";
import { RateLimitError, UpstreamError, UserNotFoundError } from "./errors.js";
import { fetchAndStore } from "./service.js";

// GitHub allows alphanumerics and single inner hyphens, up to 39 characters.
const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

// Unset means "any origin", which suits local development. Production sets the
// Cloudflare Pages domain here.
function allowedOrigins(): string[] | "*" {
  const configured = process.env.CORS_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return configured?.length ? configured : "*";
}

export const app = new Hono();

app.use(
  "/*",
  cors({
    origin: allowedOrigins(),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/users", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const username = (body as { username?: unknown })?.username;
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    return c.json({ error: "Field 'username' must be a valid GitHub username" }, 400);
  }

  const stored = await fetchAndStore(username);
  return c.json(stored, 201);
});

app.onError((err, c) => {
  if (err instanceof UserNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof RateLimitError) {
    return c.json({ error: err.message }, 429);
  }
  if (err instanceof UpstreamError) {
    return c.json({ error: err.message }, 502);
  }
  console.error("Unhandled error", err);
  return c.json({ error: "Internal server error" }, 500);
});
