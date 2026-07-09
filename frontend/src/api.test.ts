import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchUser } from "./api";

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
  vi.stubEnv("VITE_API_URL", "https://api.example.com");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchUser", () => {
  it("returns the user on 201", async () => {
    mockResponse(201, user);

    await expect(fetchUser("torvalds")).resolves.toEqual(user);
  });

  it("posts the username to the users endpoint", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => user });
    vi.stubGlobal("fetch", spy);

    await fetchUser("torvalds");

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/users");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ username: "torvalds" });
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

      await expect(fetchUser("torvalds")).rejects.toThrow(ApiError);
      await expect(fetchUser("torvalds")).rejects.toThrow(fragment);
    });
  }

  it("has a fallback message for an unexpected status", async () => {
    mockResponse(418);

    await expect(fetchUser("torvalds")).rejects.toThrow(ApiError);
  });

  // fetch throws rather than resolving when the network itself fails, so this
  // path is separate from every status-code case above.
  it("turns a network failure into a readable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(fetchUser("torvalds")).rejects.toThrow("网络连接失败");
  });
});
