import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserCard } from "./UserCard";
import type { GitHubUser } from "./types";

const base: GitHubUser = {
  id: 1,
  username: "torvalds",
  githubId: 1024025,
  name: "Linus Torvalds",
  avatarUrl: "https://avatars.githubusercontent.com/u/1024025",
  bio: "I make kernels",
  company: "Linux Foundation",
  location: "Portland, OR",
  publicRepos: 12,
  followers: 311029,
  following: 0,
  githubCreatedAt: "2011-09-03T15:26:22.000Z",
  createdAt: "2026-07-09T07:54:36.341Z",
  updatedAt: "2026-07-09T07:54:36.341Z",
};

describe("UserCard", () => {
  it("shows the name, handle, and stats", () => {
    render(<UserCard user={base} />);

    expect(screen.getByText("Linus Torvalds")).toBeInTheDocument();
    expect(screen.getByText("@torvalds")).toBeInTheDocument();
    expect(screen.getByText("311,029")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("links the handle to the GitHub profile", () => {
    render(<UserCard user={base} />);

    expect(screen.getByRole("link", { name: "@torvalds" })).toHaveAttribute(
      "href",
      "https://github.com/torvalds",
    );
  });

  it("gives the avatar an alt text", () => {
    render(<UserCard user={base} />);

    expect(screen.getByRole("img")).toHaveAttribute("alt", expect.stringContaining("torvalds"));
  });

  // Most GitHub users leave bio and company empty, so null is the common case,
  // not an edge case. Rendering it would literally print "null" on the page.
  it("omits optional fields instead of rendering null", () => {
    render(<UserCard user={{ ...base, bio: null, company: null, location: null }} />);

    expect(screen.queryByText("null")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bio")).not.toBeInTheDocument();
    expect(screen.queryByTestId("company")).not.toBeInTheDocument();
  });

  it("falls back to the username when the display name is missing", () => {
    render(<UserCard user={{ ...base, name: null }} />);

    expect(screen.getByRole("heading")).toHaveTextContent("torvalds");
  });
});
