import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntroUnavailableError,
  RateLimitError,
  UpstreamError,
  UserNotFoundError,
} from "../src/errors.js";

vi.mock("../src/service.js", () => ({ fetchAndStore: vi.fn() }));
vi.mock("../src/introClient.js", () => ({ fetchIntro: vi.fn() }));

const { fetchAndStore } = await import("../src/service.js");
const { fetchIntro } = await import("../src/introClient.js");
const { app } = await import("../src/app.js");

const stored = {
  id: 1,
  username: "torvalds",
  githubId: 1024025,
  name: "Linus Torvalds",
  followers: 234000,
  createdAt: new Date("2026-07-08T00:00:00Z"),
  updatedAt: new Date("2026-07-08T00:00:00Z"),
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
  vi.mocked(fetchIntro).mockReset();
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
    expect(fetchIntro).toHaveBeenCalledWith("torvalds");
  });

  it("returns 400 for an invalid username", async () => {
    const res = await app.request("/users/-bad-/intro");
    expect(res.status).toBe(400);
    expect(fetchIntro).not.toHaveBeenCalled();
  });

  it("maps UserNotFoundError onto 404", async () => {
    vi.mocked(fetchIntro).mockRejectedValue(new UserNotFoundError("nobody"));

    const res = await app.request("/users/nobody/intro");
    expect(res.status).toBe(404);
  });

  it("maps IntroUnavailableError onto 503", async () => {
    vi.mocked(fetchIntro).mockRejectedValue(new IntroUnavailableError("down"));

    const res = await app.request("/users/torvalds/intro");
    expect(res.status).toBe(503);
  });
});

describe("POST /users", () => {
  it("returns 201 with the stored user on success", async () => {
    vi.mocked(fetchAndStore).mockResolvedValue(stored as never);

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ username: "torvalds", followers: 234000 });
  });

  it("returns 400 when username is missing", async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expect(fetchAndStore).not.toHaveBeenCalled();
  });

  it("returns 400 when username violates GitHub's format", async () => {
    const res = await post({ username: "-bad-name-" });

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
  });

  it("maps UserNotFoundError onto 404", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new UserNotFoundError("nobody"));

    const res = await post({ username: "nobody" });

    expect(res.status).toBe(404);
  });

  it("maps RateLimitError onto 429", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new RateLimitError("slow down"));

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(429);
  });

  it("maps UpstreamError onto 502", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new UpstreamError("github is down"));

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(502);
  });

  it("maps an unexpected failure onto 500", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new Error("connection refused"));

    const res = await post({ username: "torvalds" });

    expect(res.status).toBe(500);
  });
});

describe("GET /health", () => {
  it("reports that the service is up", async () => {
    const res = await app.request("/health");

    expect(res.status).toBe(200);
  });
});
