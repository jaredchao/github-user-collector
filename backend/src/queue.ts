import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

// The client lives at module scope so a warm Lambda container reuses the
// connection, the same reason the pg pool does.
let client: SNSClient | undefined;

function getClient(): SNSClient {
  client ??= new SNSClient({});
  return client;
}

export interface CollectRequest {
  username: string;
  requestedAt: string;
}

/**
 * Hands a collect request to SNS and returns immediately. The API answers 202
 * on the strength of this message alone: the fan-out (SNS -> SQS -> worker) is
 * what actually talks to GitHub and the database.
 */
export async function publishCollectRequest(username: string): Promise<string> {
  const topicArn = process.env.COLLECT_TOPIC_ARN;
  if (!topicArn) {
    throw new Error("COLLECT_TOPIC_ARN is not configured");
  }

  const message: CollectRequest = { username, requestedAt: new Date().toISOString() };
  const result = await getClient().send(
    new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(message) }),
  );

  return result.MessageId ?? "";
}
