import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send = send;
  },
  PublishCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const { buildProfileSavedEvent, publishProfileSaved } = await import("../src/events.js");

const profile = { id: 7, username: "torvalds" };

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ MessageId: "msg-1" });
  process.env.PROFILE_EVENTS_TOPIC_ARN = "arn:aws:sns:us-east-2:1:profile-events";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("buildProfileSavedEvent", () => {
  it("carries what a consumer needs to act on the event", () => {
    const event = buildProfileSavedEvent(profile, new Date("2026-07-31T10:00:00Z"));

    expect(event).toMatchObject({
      eventType: "profile.saved",
      username: "torvalds",
      profileId: 7,
      occurredAt: "2026-07-31T10:00:00.000Z",
    });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives every event its own id so retries stay traceable", () => {
    const a = buildProfileSavedEvent(profile);
    const b = buildProfileSavedEvent(profile);

    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("publishProfileSaved", () => {
  it("publishes the event with a filterable attribute", async () => {
    await expect(publishProfileSaved(profile)).resolves.toBe(true);

    const { input } = send.mock.calls[0]![0] as {
      input: { TopicArn: string; Message: string; MessageAttributes: Record<string, unknown> };
    };
    expect(input.TopicArn).toBe("arn:aws:sns:us-east-2:1:profile-events");
    expect(JSON.parse(input.Message)).toMatchObject({ username: "torvalds", profileId: 7 });
    expect(input.MessageAttributes.eventType).toMatchObject({ StringValue: "profile.saved" });
  });

  it("is a no-op when no topic is configured, so local development still works", async () => {
    delete process.env.PROFILE_EVENTS_TOPIC_ARN;

    await expect(publishProfileSaved(profile)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  // The profile is already committed when this runs. Rethrowing here would
  // fail a request whose main work succeeded.
  it("swallows a publish failure instead of failing the saved profile", async () => {
    send.mockRejectedValue(new Error("SNS unreachable"));

    await expect(publishProfileSaved(profile)).resolves.toBe(false);
  });
});
