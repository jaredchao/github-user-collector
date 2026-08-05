import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config";
import { createQueue } from "../src/queue";
import type { Transport } from "../src/transport";
import type { PerfEvent, PerfPayload } from "../src/types";

function makeEvent(overrides: Partial<PerfEvent> = {}): PerfEvent {
  return { id: "e1", name: "LCP", value: 1000, rating: "good", at: 1, ...overrides };
}

function setup(page: () => string, overrides: Record<string, unknown> = {}) {
  const sent: PerfPayload[] = [];
  const transport: Transport = {
    send(_endpoint, payload) {
      sent.push(payload);
      return true;
    },
  };
  const config = resolveConfig(
    { endpoint: "https://ingest.test/v1/collect", site: "demo", batchSize: 3, ...overrides },
    page,
  );
  const queue = createQueue(config, { session: "s1", ua: "ua", conn: "4g" }, transport);
  return { queue, sent };
}

describe("createQueue", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("flushes once the batch size is reached", () => {
    const { queue, sent } = setup(() => "/home");

    queue.add(makeEvent({ id: "a" }));
    queue.add(makeEvent({ id: "b" }));
    expect(sent).toHaveLength(0);

    queue.add(makeEvent({ id: "c" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(queue.size()).toBe(0);
  });

  it("sends nothing when the buffer is empty", () => {
    const { queue, sent } = setup(() => "/home");
    queue.flush();
    expect(sent).toHaveLength(0);
  });

  // A single-page app changes route while events are buffered. Each event
  // must stay attached to the page it was measured on.
  it("splits a batch into one payload per page", () => {
    let page = "/home";
    const { queue, sent } = setup(() => page);

    queue.add(makeEvent({ id: "a" }));
    page = "/users/:id";
    queue.add(makeEvent({ id: "b" }));
    queue.flush();

    expect(sent).toHaveLength(2);
    expect(sent.map((p) => p.page)).toEqual(["/home", "/users/:id"]);
    expect(sent[0]?.events.map((e) => e.id)).toEqual(["a"]);
    expect(sent[1]?.events.map((e) => e.id)).toEqual(["b"]);
  });

  it("stamps the payload with the session and schema metadata", () => {
    const { queue, sent } = setup(() => "/home");
    queue.add(makeEvent());
    queue.flush();

    expect(sent[0]).toMatchObject({ v: 1, site: "demo", session: "s1", ua: "ua", conn: "4g" });
    expect(sent[0]?.sdk).toMatch(/^perf-sdk@/);
  });

  it("drops the buffer even when the transport refuses, so it cannot grow unbounded", () => {
    const failing: Transport = { send: () => false };
    const config = resolveConfig({ endpoint: "https://x", site: "s" }, () => "/");
    const queue = createQueue(config, { session: "s", ua: "", conn: "" }, failing);

    queue.add(makeEvent());
    queue.flush();
    expect(queue.size()).toBe(0);
  });

  it("flushes on the timer and stops when told to", () => {
    vi.useFakeTimers();
    const { queue, sent } = setup(() => "/home", { flushIntervalMs: 1000 });

    queue.add(makeEvent());
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(1);

    queue.stop();
    queue.add(makeEvent());
    vi.advanceTimersByTime(5000);
    expect(sent).toHaveLength(1);
  });
});
