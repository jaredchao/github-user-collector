export class UserNotFoundError extends Error {
  constructor(username: string) {
    super(`GitHub user not found: ${username}`);
    this.name = "UserNotFoundError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}
