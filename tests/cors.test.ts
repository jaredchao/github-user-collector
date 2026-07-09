import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserNotFoundError } from "../src/errors.js";

const ORIGIN = "https://zuoye.pages.dev";

// app.ts reads CORS_ORIGINS at module load, so it must be set before the import.
process.env.CORS_ORIGINS = ORIGIN;

vi.mock("../src/service.js", () => ({ fetchAndStore: vi.fn() }));

const { fetchAndStore } = await import("../src/service.js");
const { app } = await import("../src/app.js");

beforeEach(() => {
  vi.mocked(fetchAndStore).mockReset();
});

describe("CORS preflight", () => {
  it("answers OPTIONS with the allowed origin and methods", async () => {
    const res = await app.request("/users", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });
});

describe("CORS on real responses", () => {
  it("sets the origin header on a successful POST", async () => {
    vi.mocked(fetchAndStore).mockResolvedValue({ id: 1, username: "torvalds" } as never);

    const res = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ username: "torvalds" }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  // Without this the browser reports an opaque CORS failure instead of the real
  // status, and the frontend can never show "user not found" to the user.
  it("sets the origin header on an error response too", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new UserNotFoundError("nobody"));

    const res = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ username: "nobody" }),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("sets the origin header on a validation failure", async () => {
    const res = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});
