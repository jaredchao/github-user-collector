import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchIntro, fetchUser } from "./api";

const user = {
  id: 1,
  username: "torvalds",
  githubId: 1024025,
  name: "Linus Torvalds",
  avatarUrl: "https://avatars.githubusercontent.com/u/1024025",
  bio: null,
  company: "Linux Foundation",
  location: "Portland, OR",
  publicRepos: 12,
  followers: 311029,
  following: 0,
  githubCreatedAt: "2011-09-03T15:26:22.000Z",
  createdAt: "2026-07-09T07:54:36.341Z",
  updatedAt: "2026-07-09T07:54:36.341Z",
};

function mockResponse(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response),
  );
}

beforeEach(() => {
  vi.stubEnv("VITE_GO_API_URL", "https://go.example.com");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchUser", () => {
  // Collection is async now: POST only queues the request, and the user
  // shows up on a later poll of GET /users/:username.
  it("queues the request and returns the user once the worker stores it", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ status: "accepted" }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ status: "pending" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => user });
    vi.stubGlobal("fetch", spy);

    await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 500 })).resolves.toEqual(user);

    const [postUrl, init] = spy.mock.calls[0]!;
    expect(postUrl).toBe("https://go.example.com/users");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ username: "torvalds" });
    expect(spy.mock.calls[1]![0]).toBe("https://go.example.com/users/torvalds");
  });

  it("gives up with a readable message when the collection never lands", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ status: "accepted" }) })
      .mockResolvedValue({ ok: false, status: 404, json: async () => ({ status: "pending" }) });
    vi.stubGlobal("fetch", spy);

    await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow("采集超时");
  });

  // A rejected request never reaches the queue, so polling would just waste
  // twenty seconds before reporting the failure the API already gave us.
  it("surfaces a rejected request immediately instead of polling", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    vi.stubGlobal("fetch", spy);

    await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 500 })).rejects.toThrow(
      "用户名格式不对",
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchUser error messages", () => {
  const cases: Array<[number, string]> = [
    [404, "找不到这个 GitHub 用户"],
    [400, "用户名格式不对"],
    [429, "请求太频繁"],
    [502, "GitHub 暂时无法访问"],
    [500, "服务器出错了"],
  ];

  for (const [status, fragment] of cases) {
    it(`turns ${status} into a readable message`, async () => {
      mockResponse(status);

      await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(
        ApiError,
      );
      await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(
        fragment,
      );
    });
  }

  it("has a fallback message for an unexpected status", async () => {
    mockResponse(418);

    await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(ApiError);
  });

  // fetch throws rather than resolving when the network itself fails, so this
  // path is separate from every status-code case above.
  it("turns a network failure into a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(fetchUser("torvalds", { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(
      "网络连接失败",
    );
  });
});

describe("fetchIntro", () => {
  it("returns the intro text on 200", async () => {
    mockResponse(200, { username: "torvalds", intro: "Linus Torvalds（@torvalds）..." });

    await expect(fetchIntro("torvalds")).resolves.toBe("Linus Torvalds（@torvalds）...");
  });

  it("calls the Go service directly through the ALB", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ intro: "x" }) });
    vi.stubGlobal("fetch", spy);

    await fetchIntro("torvalds");

    expect(spy.mock.calls[0]![0]).toBe("https://go.example.com/intro?username=torvalds");
  });

  it("maps 404 onto a readable message", async () => {
    mockResponse(404);
    await expect(fetchIntro("nobody")).rejects.toThrow("找不到");
  });

  it("maps 503 (Go service down) onto a readable message", async () => {
    mockResponse(503);
    await expect(fetchIntro("torvalds")).rejects.toThrow("介绍服务暂时不可用");
  });

  it("turns a network failure into a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchIntro("torvalds")).rejects.toThrow("网络连接失败");
  });
});
