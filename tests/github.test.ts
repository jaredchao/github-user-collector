import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUser } from "../src/github.js";
import { RateLimitError, UpstreamError, UserNotFoundError } from "../src/errors.js";

const apiPayload = {
  login: "torvalds",
  id: 1024025,
  name: "Linus Torvalds",
  avatar_url: "https://avatars.githubusercontent.com/u/1024025",
  bio: null,
  company: "Linux Foundation",
  location: "Portland, OR",
  public_repos: 8,
  followers: 234000,
  following: 0,
  created_at: "2011-09-03T15:26:22Z",
};

function mockFetch(response: Partial<Response>): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchUser", () => {
  it("maps the GitHub payload onto our domain shape", async () => {
    mockFetch({ ok: true, status: 200, json: async () => apiPayload });

    const user = await fetchUser("torvalds");

    expect(user).toEqual({
      username: "torvalds",
      githubId: 1024025,
      name: "Linus Torvalds",
      avatarUrl: "https://avatars.githubusercontent.com/u/1024025",
      bio: null,
      company: "Linux Foundation",
      location: "Portland, OR",
      publicRepos: 8,
      followers: 234000,
      following: 0,
      githubCreatedAt: "2011-09-03T15:26:22Z",
    });
  });

  it("requests the user endpoint with a User-Agent header", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => apiPayload });
    vi.stubGlobal("fetch", spy);

    await fetchUser("torvalds");

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/users/torvalds");
    expect(init.headers["User-Agent"]).toBeTruthy();
  });

  it("throws UserNotFoundError on 404", async () => {
    mockFetch({ ok: false, status: 404, json: async () => ({}) });

    await expect(fetchUser("nobody-here-xyz")).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("throws RateLimitError when 403 carries an exhausted rate limit", async () => {
    mockFetch({
      ok: false,
      status: 403,
      headers: new Headers({ "x-ratelimit-remaining": "0" }),
      json: async () => ({}),
    });

    await expect(fetchUser("torvalds")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws UpstreamError on a 500 from GitHub", async () => {
    mockFetch({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchUser("torvalds")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("throws UpstreamError when the request times out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "TimeoutError")));

    await expect(fetchUser("torvalds")).rejects.toBeInstanceOf(UpstreamError);
  });
});
