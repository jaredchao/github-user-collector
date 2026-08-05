// A PerformanceObserver for an entry type the browser does not support
// throws on observe(). Every call site here is optional telemetry, so a
// missing entry type must degrade to "this metric is absent", never to a
// broken page.
export function observe(
  type: string,
  callback: (entries: PerformanceEntry[]) => void,
  options: PerformanceObserverInit = {},
): PerformanceObserver | undefined {
  if (typeof PerformanceObserver !== "function") return undefined;
  const supported = PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(supported) && !supported.includes(type)) return undefined;

  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    // buffered replays entries that fired before the SDK loaded, which is
    // most of them: FCP and TTFB happen before any script of ours runs.
    observer.observe({ type, buffered: true, ...options });
    return observer;
  } catch {
    return undefined;
  }
}
