import { randomUUID } from "node:crypto";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { StoredUser } from "./db.js";

export interface ProfileSavedEvent {
  eventId: string;
  eventType: "profile.saved";
  occurredAt: string;
  username: string;
  profileId: number;
}

// The client lives at module scope so a warm Lambda container reuses the
// connection, the same reason the pg pool does.
let client: SNSClient | undefined;

export function buildProfileSavedEvent(
  profile: Pick<StoredUser, "id" | "username">,
  now = new Date(),
): ProfileSavedEvent {
  return {
    eventId: randomUUID(),
    eventType: "profile.saved",
    occurredAt: now.toISOString(),
    username: profile.username,
    profileId: profile.id,
  };
}

/**
 * Announces that a profile was saved, so the introduction can be generated
 * asynchronously.
 *
 * Best effort on purpose: the profile is already committed by the time this
 * runs, and failing the caller's request over a missed side effect would
 * throw away work that actually succeeded. Returns false when there is no
 * topic configured (local development) and rethrows nothing.
 */
export async function publishProfileSaved(
  profile: Pick<StoredUser, "id" | "username">,
): Promise<boolean> {
  const topicArn = process.env.PROFILE_EVENTS_TOPIC_ARN?.trim();
  if (!topicArn) return false;

  try {
    client ??= new SNSClient({});
    await client.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(buildProfileSavedEvent(profile)),
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: "profile.saved" },
        },
      }),
    );
    return true;
  } catch (err) {
    console.error(`publishing profile.saved for ${profile.username} failed:`, err);
    return false;
  }
}
