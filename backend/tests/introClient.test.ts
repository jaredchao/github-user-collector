import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntroUnavailableError, UserNotFoundError } from "../src/errors.js";
import { fetchIntro } from "../src/introClient.js";

beforeEach(() => {
  vi.stubEnv("GO_SERVICE_URL", "http://go-service.zuoye.internal:8080");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchIntro", () => {
  it("returns the intro text on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ username: "torvalds", intro: "Linus ..." }),
      }),
    );

    await expect(fetchIntro("torvalds")).resolves.toBe("Linus ...");
  });

  it("calls the Go service intro endpoint with the username", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ intro: "x" }) });
    vi.stubGlobal("fetch", spy);

    await fetchIntro("torvalds");

    const url = spy.mock.calls[0]![0] as string;
    expect(url).toBe("http://go-service.zuoye.internal:8080/intro?username=torvalds");
  });

  it("maps the Go service 404 onto UserNotFoundError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));

    await expect(fetchIntro("nobody")).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("throws IntroUnavailableError when the Go service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    await expect(fetchIntro("torvalds")).rejects.toBeInstanceOf(IntroUnavailableError);
  });

  it("throws IntroUnavailableError on a 5xx from the Go service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({}) }));

    await expect(fetchIntro("torvalds")).rejects.toBeInstanceOf(IntroUnavailableError);
  });
});
