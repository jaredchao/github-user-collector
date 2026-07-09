import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GitHubUser } from "../src/github.js";
import { closePool, getPool, upsertUser } from "../src/db.js";
import { runMigrations } from "../scripts/migrate.js";

const torvalds: GitHubUser = {
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
};

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await getPool().query("TRUNCATE github_users RESTART IDENTITY");
});

afterAll(async () => {
  await closePool();
});

describe("upsertUser", () => {
  it("inserts a new user and returns the stored row", async () => {
    const stored = await upsertUser(torvalds);

    expect(stored.id).toBeGreaterThan(0);
    expect(stored.username).toBe("torvalds");
    expect(stored.followers).toBe(234000);
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it("updates in place on conflict instead of inserting a second row", async () => {
    const first = await upsertUser(torvalds);
    const second = await upsertUser({ ...torvalds, followers: 240000, name: "Linus B. Torvalds" });

    const { rows } = await getPool().query("SELECT count(*)::int AS count FROM github_users");
    expect(rows[0].count).toBe(1);

    expect(second.id).toBe(first.id);
    expect(second.followers).toBe(240000);
    expect(second.name).toBe("Linus B. Torvalds");
  });

  it("preserves created_at but advances updated_at on conflict", async () => {
    const first = await upsertUser(torvalds);
    const second = await upsertUser({ ...torvalds, followers: 240000 });

    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it("stores nullable fields as null rather than the string 'null'", async () => {
    const stored = await upsertUser({ ...torvalds, bio: null, company: null });

    expect(stored.bio).toBeNull();
    expect(stored.company).toBeNull();
  });
});
