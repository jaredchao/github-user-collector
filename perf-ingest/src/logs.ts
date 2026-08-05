import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
} from "@aws-sdk/client-cloudwatch-logs";
import type { LogRecord } from "./contract.js";

export interface LogWriter {
  write(records: readonly LogRecord[]): Promise<void>;
}

// PutLogEvents caps a batch at 10,000 events and 1 MB. Validation already
// caps a payload at 50 events, so only the byte budget needs watching.
const MAX_BATCH_BYTES = 900_000;
// CloudWatch counts 26 bytes of overhead per event on top of the message.
const EVENT_OVERHEAD_BYTES = 26;

export interface LogWriterOptions {
  client: CloudWatchLogsClient;
  logGroup: string;
  /** Stable for the life of a Lambda execution environment — see below. */
  streamName: string;
}

export function createLogWriter({ client, logGroup, streamName }: LogWriterOptions): LogWriter {
  // Each execution environment owns its own log stream. Concurrent Lambdas
  // writing one shared stream would contend on it; a stream per instance
  // removes the contention entirely and costs nothing.
  let streamReady = false;

  const ensureStream = async (): Promise<void> => {
    if (streamReady) return;
    try {
      await client.send(new CreateLogStreamCommand({ logGroupName: logGroup, logStreamName: streamName }));
    } catch (error) {
      // A warm instance that already created it, or a race between two
      // concurrent invocations of the same instance.
      if (!(error instanceof ResourceAlreadyExistsException)) throw error;
    }
    streamReady = true;
  };

  const put = async (records: readonly LogRecord[]): Promise<void> => {
    await client.send(
      new PutLogEventsCommand({
        logGroupName: logGroup,
        logStreamName: streamName,
        // PutLogEvents rejects a batch whose timestamps are not ascending.
        logEvents: [...records]
          .sort((a, b) => a.at - b.at)
          .map((record) => ({ timestamp: record.at, message: JSON.stringify(record) })),
      }),
    );
  };

  return {
    async write(records) {
      if (records.length === 0) return;
      await ensureStream();

      for (const batch of splitByBytes(records)) {
        try {
          await put(batch);
        } catch (error) {
          // The stream can vanish under us when the log group's retention
          // sweeps an empty stream. Recreate it and retry once; a second
          // failure is a real problem and belongs to the caller.
          if (!(error instanceof ResourceNotFoundException)) throw error;
          streamReady = false;
          await ensureStream();
          await put(batch);
        }
      }
    },
  };
}

export function splitByBytes(records: readonly LogRecord[]): LogRecord[][] {
  const batches: LogRecord[][] = [];
  let current: LogRecord[] = [];
  let bytes = 0;

  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record)) + EVENT_OVERHEAD_BYTES;
    if (current.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
