import { describe, expect, it, vi } from "vitest";
import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { LogRecord } from "../src/contract.js";
import { createLogWriter, splitByBytes } from "../src/logs.js";

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    v: 1,
    sdk: "perf-sdk@1.0.0",
    site: "demo",
    session: "s",
    page: "/",
    ua: "ua",
    conn: "4g",
    id: "e-1",
    name: "LCP",
    value: 1000,
    rating: "good",
    at: 1_800_000_000_000,
    attrs: {},
    ...overrides,
  };
}

function fakeClient(send: (command: unknown) => Promise<unknown>): CloudWatchLogsClient {
  return { send: vi.fn(send) } as unknown as CloudWatchLogsClient;
}

const OPTIONS = { logGroup: "/perf/raw", streamName: "2026-08-05/abc" };

describe("createLogWriter", () => {
  it("creates the stream once and reuses it across writes", async () => {
    const commands: unknown[] = [];
    const client = fakeClient(async (command) => {
      commands.push(command);
      return {};
    });
    const writer = createLogWriter({ client, ...OPTIONS });

    await writer.write([record()]);
    await writer.write([record({ id: "e-2" })]);

    expect(commands.filter((c) => c instanceof CreateLogStreamCommand)).toHaveLength(1);
    expect(commands.filter((c) => c instanceof PutLogEventsCommand)).toHaveLength(2);
  });

  it("treats an already-existing stream as ready", async () => {
    const client = fakeClient(async (command) => {
      if (command instanceof CreateLogStreamCommand) {
        throw new ResourceAlreadyExistsException({ message: "exists", $metadata: {} });
      }
      return {};
    });

    await expect(createLogWriter({ client, ...OPTIONS }).write([record()])).resolves.toBeUndefined();
  });

  // PutLogEvents rejects a batch whose timestamps are out of order, and a
  // batch arrives in whatever order the browser buffered it.
  it("sorts events by timestamp before sending", async () => {
    const sent: PutLogEventsCommand[] = [];
    const client = fakeClient(async (command) => {
      if (command instanceof PutLogEventsCommand) sent.push(command);
      return {};
    });

    await createLogWriter({ client, ...OPTIONS }).write([
      record({ id: "late", at: 3000 }),
      record({ id: "early", at: 1000 }),
      record({ id: "middle", at: 2000 }),
    ]);

    expect(sent[0]?.input.logEvents?.map((e) => e.timestamp)).toEqual([1000, 2000, 3000]);
  });

  it("recreates a vanished stream and retries once", async () => {
    let putAttempts = 0;
    let creates = 0;
    const client = fakeClient(async (command) => {
      if (command instanceof CreateLogStreamCommand) {
        creates += 1;
        return {};
      }
      putAttempts += 1;
      if (putAttempts === 1) throw new ResourceNotFoundException({ message: "gone", $metadata: {} });
      return {};
    });

    await createLogWriter({ client, ...OPTIONS }).write([record()]);

    expect(creates).toBe(2);
    expect(putAttempts).toBe(2);
  });

  it("propagates an error that is not a missing stream", async () => {
    const client = fakeClient(async (command) => {
      if (command instanceof CreateLogStreamCommand) return {};
      throw new Error("throttled");
    });

    await expect(createLogWriter({ client, ...OPTIONS }).write([record()])).rejects.toThrow("throttled");
  });

  it("does nothing at all for an empty batch", async () => {
    const send = vi.fn(async () => ({}));
    const client = { send } as unknown as CloudWatchLogsClient;
    await createLogWriter({ client, ...OPTIONS }).write([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("splitByBytes", () => {
  it("keeps a small batch whole", () => {
    expect(splitByBytes([record(), record()])).toHaveLength(1);
  });

  it("splits once the byte budget is exceeded", () => {
    // Each record is padded to roughly 100 KB, so ten of them cannot fit in
    // one 1 MB PutLogEvents call.
    const fat = Array.from({ length: 12 }, (_, i) =>
      record({ id: `e-${i}`, attrs: { pad: "x".repeat(100_000) } }),
    );
    const batches = splitByBytes(fat);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(12);
  });

  it("returns nothing for no records", () => {
    expect(splitByBytes([])).toEqual([]);
  });
});
