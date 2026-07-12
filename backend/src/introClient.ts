import { IntroUnavailableError, UserNotFoundError } from "./errors.js";

// Cloud Map resolves this in-VPC name to the current Go container IP. Overridable
// so each PR environment can point at its own go-api-pr-N.internal.
const DEFAULT_URL = "http://go-service.zuoye.internal:8080";

const REQUEST_TIMEOUT_MS = 5000;

// Calls the Go service's GET /intro. Returns the intro string, or throws a
// typed error the route layer maps to a status code.
export async function fetchIntro(username: string): Promise<string> {
  const baseUrl = process.env.GO_SERVICE_URL ?? DEFAULT_URL;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/intro?username=${username}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new IntroUnavailableError(`Go service unreachable: ${(cause as Error).message}`);
  }

  if (response.ok) {
    const body = (await response.json()) as { intro?: string };
    return body.intro ?? "";
  }
  if (response.status === 404) {
    throw new UserNotFoundError(username);
  }
  throw new IntroUnavailableError(`Go service responded with ${response.status}`);
}
