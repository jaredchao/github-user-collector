import { vi } from "vitest";

// jsdom implements none of the performance entry types the SDK observes, so
// the suite installs this stub and pushes entries by hand. It keeps the
// tests deterministic: real timings would be flaky by definition.
type Callback = (list: { getEntries: () => PerformanceEntry[] }) => void;

const handlers = new Map<string, Callback[]>();
let disconnected = 0;

export const fakeObserver = {
  install(supportedTypes: string[]): void {
    handlers.clear();
    disconnected = 0;

    class FakePerformanceObserver {
      static supportedEntryTypes = supportedTypes;

      constructor(private readonly callback: Callback) {}

      observe(options: { type: string }): void {
        const existing = handlers.get(options.type) ?? [];
        handlers.set(options.type, [...existing, this.callback]);
      }

      disconnect(): void {
        disconnected += 1;
      }

      takeRecords(): PerformanceEntry[] {
        return [];
      }
    }

    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
  },

  emit(type: string, entries: Partial<PerformanceEntry>[]): void {
    for (const callback of handlers.get(type) ?? []) {
      callback({ getEntries: () => entries as PerformanceEntry[] });
    }
  },

  observing(type: string): boolean {
    return (handlers.get(type) ?? []).length > 0;
  },

  disconnectCount(): number {
    return disconnected;
  },

  restore(): void {
    handlers.clear();
    vi.unstubAllGlobals();
  },
};
