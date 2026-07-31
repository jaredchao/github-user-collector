import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  IntroUnavailableError,
  RateLimitError,
  UpstreamError,
  UserNotFoundError,
} from "./errors.js";
import { getUser } from "./db.js";
import { publishProfileSaved } from "./events.js";
import { checkDataServiceReady, fetchIntro } from "./introClient.js";
import { fetchAndStore } from "./service.js";
import { isValidUsername } from "./username.js";

// Unset means "any origin", which suits local development. Production sets the
// Cloudflare Pages domain plus a `https://*.domain` wildcard entry so Pages
// preview deployments (pr-N.<project>.pages.dev) can call the API too.
function originMatcher(): (origin: string) => string | null {
  const configured = process.env.CORS_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!configured?.length) return (origin) => origin;

  const exact = new Set(configured.filter((o) => !o.includes("*")));
  const subdomainPatterns = configured
    .filter((o) => o.startsWith("https://*."))
    // "https://*.a.dev" allows exactly one label before ".a.dev", nothing else.
    .map(
      (o) =>
        new RegExp(
          `^https://[a-z0-9-]+\\.${o.slice("https://*.".length).replaceAll(".", "\\.")}$`,
          "i",
        ),
    );

  return (origin) =>
    exact.has(origin) || subdomainPatterns.some((p) => p.test(origin)) ? origin : null;
}

export const app = new Hono();

app.use(
  "/*",
  cors({
    origin: originMatcher(),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

// Liveness: is this Lambda running at all.
app.get("/health", (c) => c.json({ status: "ok" }));

// Readiness: is the whole chain behind it usable — Lambda -> Go on ECS ->
// PostgreSQL. Deliberately touches no user data, so a probe can call it
// without credentials.
app.get("/ready", async (c) => {
  const started = Date.now();
  try {
    await checkDataServiceReady();
  } catch (err) {
    return c.json(
      { status: "unavailable", dependency: "go-service", error: (err as Error).message },
      503,
    );
  }
  return c.json({ status: "ready", checkedMs: Date.now() - started });
});

// Saving the profile stays synchronous — that is what the caller asked for.
// Generating the introduction does not: it is announced as an event and
// handled by the worker, so a slow or broken Go service can never roll back
// a profile that was already stored.
app.post("/users", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const username = (body as { username?: unknown })?.username;
  if (!isValidUsername(username)) {
    return c.json({ error: "Field 'username' must be a valid GitHub username" }, 400);
  }

  const stored = await fetchAndStore(username);
  // Best effort: publishProfileSaved never throws, so a messaging outage
  // downgrades the introduction to "missing for now" instead of failing a
  // request whose main work already succeeded.
  const published = await publishProfileSaved(stored);
  return c.json({ ...stored, introductionQueued: published }, 201);
});

app.get("/users/:username", async (c) => {
  const username = c.req.param("username");
  if (!isValidUsername(username)) {
    return c.json({ error: "Invalid GitHub username" }, 400);
  }

  const user = await getUser(username);
  if (!user) {
    // Either the worker hasn't caught up or the collection failed; the
    // poller treats both the same way — keep waiting, then give up.
    return c.json({ username, status: "pending" }, 404);
  }
  return c.json(user);
});

// Reached via Cloud Map: this Lambda calls the Go service in-VPC and returns
// the intro it renders. Demonstrates service discovery (Lambda -> Go).
app.get("/users/:username/intro", async (c) => {
  const username = c.req.param("username");
  if (!isValidUsername(username)) {
    return c.json({ error: "Invalid GitHub username" }, 400);
  }

  const intro = await fetchIntro(username);
  return c.json({ username, intro });
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
  if (err instanceof IntroUnavailableError) {
    return c.json({ error: "介绍服务暂时不可用，请稍后再试" }, 503);
  }
  console.error("Unhandled error", err);
  return c.json({ error: "Internal server error" }, 500);
});
