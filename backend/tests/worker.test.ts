import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntroUnavailableError, UserNotFoundError } from "../src/errors.js";

vi.mock("../src/introClient.js", () => ({ generateIntroduction: vi.fn() }));

const { generateIntroduction } = await import("../src/introClient.js");
const { handler, parseProfileSavedEvent } = await import("../src/worker.js");

function event(username: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: "11111111-2222-3333-4444-555555555555",
    eventType: "profile.saved",
    occurredAt: "2026-07-31T10:00:00.000Z",
    username,
    profileId: 7,
    ...overrides,
  };
}

function sqsEvent(...bodies: unknown[]) {
  return {
    Records: bodies.map((body, i) => ({
      messageId: `m${i}`,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })),
  };
}

beforeEach(() => {
  vi.mocked(generateIntroduction).mockReset();
  vi.mocked(generateIntroduction).mockResolvedValue("Linus Torvalds ...");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("profile.saved worker", () => {
  it("generates an introduction for every event in the batch", async () => {
    const result = await handler(sqsEvent(event("torvalds"), event("gaearon")));

    expect(vi.mocked(generateIntroduction).mock.calls.map(([u]) => u)).toEqual([
      "torvalds",
      "gaearon",
    ]);
    expect(result.batchItemFailures).toEqual([]);
  });

  // The profile is gone; no number of retries brings it back.
  it("treats a missing profile as handled, not as a retryable failure", async () => {
    vi.mocked(generateIntroduction).mockRejectedValue(new UserNotFoundError("nobody"));

    const result = await handler(sqsEvent(event("nobody")));

    expect(result.batchItemFailures).toEqual([]);
  });

  it.each([
    ["the Go service is unreachable", new IntroUnavailableError("connection refused")],
    ["the Go service errors", new IntroUnavailableError("Go service responded with 500")],
    ["something unexpected breaks", new Error("boom")],
  ])("retries when %s", async (_label, error) => {
    vi.mocked(generateIntroduction).mockRejectedValue(error);

    const result = await handler(sqsEvent(event("torvalds")));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
  });

  // Only the broken message goes back on the queue; its healthy batch mate
  // must not have its introduction generated twice.
  it("fails only the offending message in a mixed batch", async () => {
    vi.mocked(generateIntroduction)
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new IntroUnavailableError("down"));

    const result = await handler(sqsEvent(event("torvalds"), event("gaearon")));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
  });

  it.each([
    ["a non-JSON body", "not json at all"],
    ["a foreign event type", event("torvalds", { eventType: "profile.deleted" })],
    ["a missing eventId", event("torvalds", { eventId: undefined })],
    ["an invalid username", event("-bad-")],
    ["a missing profileId", event("torvalds", { profileId: 0 })],
  ])("sends %s to the dead letter queue", async (_label, body) => {
    const result = await handler(sqsEvent(body));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    expect(generateIntroduction).not.toHaveBeenCalled();
  });
});

describe("parseProfileSavedEvent", () => {
  it("returns the event when it is well formed", () => {
    expect(parseProfileSavedEvent(JSON.stringify(event("torvalds")))).toMatchObject({
      username: "torvalds",
      profileId: 7,
    });
  });

  it("explains what was wrong", () => {
    expect(() => parseProfileSavedEvent(JSON.stringify(event("torvalds", { profileId: -1 })))).toThrow(
      "profileId",
    );
  });
});
