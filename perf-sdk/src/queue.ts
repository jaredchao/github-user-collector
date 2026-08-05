import type { ResolvedConfig } from "./config";
import type { Transport } from "./transport";
import { SCHEMA_VERSION, SDK_VERSION, type PerfEvent, type PerfPayload } from "./types";

// An event plus the page it was observed on. The page is captured at enqueue
// time, not at flush time: in a single-page app the route can change while
// events sit in the buffer, and attributing them to the new route would
// blame the wrong page.
interface BufferedEvent {
  readonly event: PerfEvent;
  readonly page: string;
}

export interface QueueMeta {
  session: string;
  ua: string;
  conn: string;
}

export interface Queue {
  add(event: PerfEvent): void;
  flush(): void;
  stop(): void;
  /** Buffered count, for tests and debug logging. */
  size(): number;
}

export function createQueue(
  config: ResolvedConfig,
  meta: QueueMeta,
  transport: Transport,
): Queue {
  let buffer: readonly BufferedEvent[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  const flush = (): void => {
    if (buffer.length === 0) return;

    // Take the buffer before sending. If the transport throws, the events are
    // already dropped — telemetry is best-effort and must not grow unbounded
    // on a page whose endpoint is unreachable.
    const pending = buffer;
    buffer = [];

    for (const [page, events] of groupByPage(pending)) {
      const payload: PerfPayload = {
        v: SCHEMA_VERSION,
        sdk: `perf-sdk@${SDK_VERSION}`,
        site: config.site,
        session: meta.session,
        page,
        ua: meta.ua,
        conn: meta.conn,
        events,
      };

      const sent = transport.send(config.endpoint, payload);
      if (config.debug) {
        console.info(`[perf-sdk] flush ${events.length} events for ${page}, sent=${sent}`);
      }
    }
  };

  const start = (): void => {
    if (timer !== undefined || config.flushIntervalMs <= 0) return;
    timer = setInterval(flush, config.flushIntervalMs);
    // In a browser this is a number; under Node (tests, SSR) it is a Timeout
    // that would otherwise hold the process open. unref only exists there.
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  start();

  return {
    add(event) {
      buffer = [...buffer, { event, page: config.pageName() }];
      if (buffer.length >= config.batchSize) flush();
    },
    flush,
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    size: () => buffer.length,
  };
}

function groupByPage(items: readonly BufferedEvent[]): Map<string, PerfEvent[]> {
  const grouped = new Map<string, PerfEvent[]>();
  for (const item of items) {
    const existing = grouped.get(item.page);
    grouped.set(item.page, existing ? [...existing, item.event] : [item.event]);
  }
  return grouped;
}
