import { UserNotFoundError } from "./errors.js";
import type { ProfileSavedEvent } from "./events.js";
import { generateIntroduction } from "./introClient.js";
import { isValidUsername } from "./username.js";

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/**
 * Turns `profile.saved` into a generated introduction.
 *
 * Returning partial batch failures (rather than throwing) means one bad
 * message doesn't force its healthy neighbours to be redelivered and
 * regenerated. Anything reported here is retried until the queue's
 * maxReceiveCount is exhausted, after which SQS moves it to the DLQ.
 */
export async function handler(event: SqsEvent): Promise<BatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const message = parseProfileSavedEvent(record.body);
      await generate(message);
      console.info(`introduction generated for ${message.username} (event ${message.eventId})`);
    } catch (err) {
      console.error(`message ${record.messageId} failed, will be retried:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

async function generate(message: ProfileSavedEvent): Promise<void> {
  try {
    await generateIntroduction(message.username);
  } catch (err) {
    // The profile is gone (deleted, or never really saved). Retrying can't
    // bring it back, so this message is done rather than failed.
    if (err instanceof UserNotFoundError) {
      console.warn(`profile ${message.username} no longer exists, dropping the event`);
      return;
    }
    throw err;
  }
}

/**
 * Rejects anything that isn't a well-formed `profile.saved`. A malformed
 * message can never succeed, so it burns its retries and lands in the DLQ
 * where it can be inspected — which is exactly what a DLQ is for.
 */
export function parseProfileSavedEvent(body: string): ProfileSavedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("message body is not valid JSON");
  }

  const event = parsed as Partial<ProfileSavedEvent>;
  if (event.eventType !== "profile.saved") {
    throw new Error(`unexpected eventType: ${String(event.eventType)}`);
  }
  if (typeof event.eventId !== "string" || !event.eventId) {
    throw new Error("event has no eventId");
  }
  if (!isValidUsername(event.username)) {
    throw new Error("event has no valid username");
  }
  if (!Number.isInteger(event.profileId) || (event.profileId ?? 0) <= 0) {
    throw new Error("event has no valid profileId");
  }

  return event as ProfileSavedEvent;
}
