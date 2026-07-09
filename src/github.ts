import { RateLimitError, UpstreamError, UserNotFoundError } from "./errors.js";

const API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5000;

export interface GitHubUser {
  username: string;
  githubId: number;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  publicRepos: number;
  followers: number;
  following: number;
  githubCreatedAt: string | null;
}

interface GitHubApiUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string | null;
}

function toDomain(payload: GitHubApiUser): GitHubUser {
  return {
    username: payload.login,
    githubId: payload.id,
    name: payload.name,
    avatarUrl: payload.avatar_url,
    bio: payload.bio,
    company: payload.company,
    location: payload.location,
    publicRepos: payload.public_repos,
    followers: payload.followers,
    following: payload.following,
    githubCreatedAt: payload.created_at,
  };
}

// A 403 means rate limiting only when the remaining quota is actually zero;
// GitHub also returns 403 for blocked or suspended accounts.
function isRateLimited(response: Response): boolean {
  return response.status === 403 && response.headers?.get("x-ratelimit-remaining") === "0";
}

export async function fetchUser(username: string): Promise<GitHubUser> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}/users/${username}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "github-user-collector",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new UpstreamError(`GitHub request failed: ${(cause as Error).message}`);
  }

  if (response.ok) {
    return toDomain((await response.json()) as GitHubApiUser);
  }
  if (response.status === 404) {
    throw new UserNotFoundError(username);
  }
  if (isRateLimited(response)) {
    throw new RateLimitError("GitHub API rate limit exceeded");
  }
  throw new UpstreamError(`GitHub responded with ${response.status}`);
}
