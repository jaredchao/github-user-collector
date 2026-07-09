import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserNotFoundError } from "../src/errors.js";

vi.mock("../src/github.js", () => ({ fetchUser: vi.fn() }));
vi.mock("../src/db.js", () => ({ upsertUser: vi.fn() }));

const { fetchUser } = await import("../src/github.js");
const { upsertUser } = await import("../src/db.js");
const { fetchAndStore } = await import("../src/service.js");

const user = { username: "torvalds", githubId: 1024025, followers: 234000 };
const stored = { ...user, id: 1, createdAt: new Date(), updatedAt: new Date() };

beforeEach(() => {
  vi.mocked(fetchUser).mockReset();
  vi.mocked(upsertUser).mockReset();
});

describe("fetchAndStore", () => {
  it("fetches from GitHub then persists what it fetched", async () => {
    vi.mocked(fetchUser).mockResolvedValue(user as never);
    vi.mocked(upsertUser).mockResolvedValue(stored as never);

    const result = await fetchAndStore("torvalds");

    expect(fetchUser).toHaveBeenCalledWith("torvalds");
    expect(upsertUser).toHaveBeenCalledWith(user);
    expect(result).toBe(stored);
  });

  it("does not touch the database when GitHub rejects", async () => {
    vi.mocked(fetchUser).mockRejectedValue(new UserNotFoundError("nobody"));

    await expect(fetchAndStore("nobody")).rejects.toBeInstanceOf(UserNotFoundError);
    expect(upsertUser).not.toHaveBeenCalled();
  });
});
