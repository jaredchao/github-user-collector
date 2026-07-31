import { UserNotFoundError } from "./errors.js";
import { fetchAndStore } from "./service.js";
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
 * Consumes collect requests from SQS.
 *
 * Returning partial batch failures (rather than throwing) means one bad
 * message doesn't force its healthy neighbours to be redelivered and
 * collected twice. Anything reported here is retried until the queue's
 * maxReceiveCount is exhausted, after which SQS moves it to the DLQ.
 */
export async function handler(event: SqsEvent): Promise<BatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await collect(record);
    } catch (err) {
      console.error(`message ${record.messageId} failed, will be retried:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

async function collect(record: SqsRecord): Promise<void> {
  const username = parseUsername(record.body);

  try {
    await fetchAndStore(username);
  } catch (err) {
    // A user who doesn't exist on GitHub won't start existing on retry, so
    // this is a completed message, not a failed one. Everything else — rate
    // limits, upstream 5xx, database trouble — is worth another attempt.
    if (err instanceof UserNotFoundError) {
      console.warn(`no such GitHub user: ${username}, dropping the request`);
      return;
    }
    throw err;
  }
}

function parseUsername(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("message body is not valid JSON");
  }

  const username = (parsed as { username?: unknown })?.username;
  if (!isValidUsername(username)) {
    throw new Error("message has no valid 'username' field");
  }
  return username;
}
