import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntroUnavailableError, UserNotFoundError } from "../src/errors.js";

vi.mock("../src/queue.js", () => ({ publishCollectRequest: vi.fn() }));
vi.mock("../src/db.js", () => ({ getUser: vi.fn() }));
vi.mock("../src/introClient.js", () => ({ fetchIntro: vi.fn() }));

const { publishCollectRequest } = await import("../src/queue.js");
const { getUser } = await import("../src/db.js");
const { fetchIntro } = await import("../src/introClient.js");
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
  vi.mocked(publishCollectRequest).mockReset();
  vi.mocked(getUser).mockReset();
  vi.mocked(fetchIntro).mockReset();
});

// POST no longer waits for GitHub: it hands the request to SNS and answers
// 202, and the caller polls GET /users/:username for the result.
describe("POST /users", () => {
  it("accepts the request and returns 202 with a tracking id", async () => {
    vi.mocked(publishCollectRequest).mockResolvedValue("msg-1");

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      username: "torvalds",
      status: "accepted",
      messageId: "msg-1",
    });
    expect(publishCollectRequest).toHaveBeenCalledWith("torvalds");
  });

  it.each([
    ["username is missing", {}],
    ["username violates GitHub's format", { username: "-bad-name-" }],
  ])("returns 400 when %s", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(publishCollectRequest).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const res = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    expect(publishCollectRequest).not.toHaveBeenCalled();
  });

  // If the queue is unreachable the request was never accepted, and saying
  // 202 would promise a collection that will never happen.
  it("returns 500 when the request cannot be queued", async () => {
    vi.mocked(publishCollectRequest).mockRejectedValue(new Error("SNS unreachable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(500);
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
