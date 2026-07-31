import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntroUnavailableError, UserNotFoundError } from "../src/errors.js";

vi.mock("../src/service.js", () => ({ fetchAndStore: vi.fn() }));
vi.mock("../src/events.js", () => ({ publishProfileSaved: vi.fn() }));
vi.mock("../src/db.js", () => ({ getUser: vi.fn() }));
vi.mock("../src/introClient.js", () => ({ fetchIntro: vi.fn(), checkDataServiceReady: vi.fn() }));

const { fetchAndStore } = await import("../src/service.js");
const { publishProfileSaved } = await import("../src/events.js");
const { getUser } = await import("../src/db.js");
const { fetchIntro, checkDataServiceReady } = await import("../src/introClient.js");
const { app } = await import("../src/app.js");

const stored = {
  id: 1,
  username: "torvalds",
  githubId: 1024025,
  name: "Linus Torvalds",
  followers: 234000,
  createdAt: new Date("2026-07-31T00:00:00Z"),
  updatedAt: new Date("2026-07-31T00:00:00Z"),
};

function post(body: unknown): Response | Promise<Response> {
  return app.request("/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(fetchAndStore).mockReset();
  vi.mocked(publishProfileSaved).mockReset();
  vi.mocked(publishProfileSaved).mockResolvedValue(true);
  vi.mocked(getUser).mockReset();
  vi.mocked(fetchIntro).mockReset();
  vi.mocked(checkDataServiceReady).mockReset();
});

// Saving stays synchronous; only the introduction is deferred to the queue.
describe("POST /users", () => {
  it("saves the profile and announces it for async introduction generation", async () => {
    vi.mocked(fetchAndStore).mockResolvedValue(stored as never);

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      username: "torvalds",
      followers: 234000,
      introductionQueued: true,
    });
    expect(publishProfileSaved).toHaveBeenCalledWith(stored);
  });

  // The profile is already committed; a messaging outage must not turn a
  // successful save into a failed request.
  it("still returns 201 when the event could not be published", async () => {
    vi.mocked(fetchAndStore).mockResolvedValue(stored as never);
    vi.mocked(publishProfileSaved).mockResolvedValue(false);

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ introductionQueued: false });
  });

  it.each([
    ["username is missing", {}],
    ["username violates GitHub's format", { username: "-bad-name-" }],
  ])("returns 400 when %s", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(fetchAndStore).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const res = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    expect(fetchAndStore).not.toHaveBeenCalled();
  });

  it("maps a failed GitHub lookup onto 404", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new UserNotFoundError("nobody"));

    expect((await post({ username: "nobody" })).status).toBe(404);
  });
});

describe("GET /users/:username", () => {
  it("returns the collected user", async () => {
    vi.mocked(getUser).mockResolvedValue(stored as never);

    const res = await app.request("/users/torvalds");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ username: "torvalds", followers: 234000 });
  });

  // The poller needs to tell "not collected yet" apart from a hard failure,
  // so a pending user is a 404 that says so.
  it("returns 404 with a pending status while the worker is still catching up", async () => {
    vi.mocked(getUser).mockResolvedValue(null);

    const res = await app.request("/users/torvalds");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ status: "pending" });
  });

  it("returns 400 for an invalid username", async () => {
    const res = await app.request("/users/-bad-");

    expect(res.status).toBe(400);
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe("GET /users/:username/intro", () => {
  it("returns 200 with the intro from the Go service", async () => {
    vi.mocked(fetchIntro).mockResolvedValue("Linus Torvalds ...");

    const res = await app.request("/users/torvalds/intro");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      username: "torvalds",
      intro: "Linus Torvalds ...",
    });
  });

  it("returns 400 for an invalid username", async () => {
    const res = await app.request("/users/-bad-/intro");

    expect(res.status).toBe(400);
    expect(fetchIntro).not.toHaveBeenCalled();
  });

  it("maps UserNotFoundError onto 404", async () => {
    vi.mocked(fetchIntro).mockRejectedValue(new UserNotFoundError("nobody"));

    expect((await app.request("/users/nobody/intro")).status).toBe(404);
  });

  it("maps IntroUnavailableError onto 503", async () => {
    vi.mocked(fetchIntro).mockRejectedValue(new IntroUnavailableError("down"));

    expect((await app.request("/users/torvalds/intro")).status).toBe(503);
  });
});

describe("GET /health", () => {
  it("reports that the service is up", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });
});

describe("GET /ready", () => {
  it("reports ready when the data service answers", async () => {
    vi.mocked(checkDataServiceReady).mockResolvedValue(undefined);

    const res = await app.request("/ready");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ready" });
  });

  // Readiness is what the probe alarms on, so a broken dependency has to be
  // a 503 — a cheerful 200 would hide exactly the outage it exists to catch.
  it("reports 503 with the failing dependency when the chain is broken", async () => {
    vi.mocked(checkDataServiceReady).mockRejectedValue(new IntroUnavailableError("down"));

    const res = await app.request("/ready");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      status: "unavailable",
      dependency: "go-service",
    });
  });
});
