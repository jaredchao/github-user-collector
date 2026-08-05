import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDiagnostics } from "../src/diagnostics";
import type { Reporter } from "../src/vitals";
import { fakeObserver } from "./fake-observer";

const OPTIONS = {
  captureResources: true,
  captureLongTasks: true,
  captureErrors: true,
  endpoint: "https://ingest.test/v1/collect",
};

interface Reported {
  name: string;
  value: number;
  attrs?: Record<string, string | number>;
}

function recorder(): { reports: Reported[]; report: Reporter } {
  const reports: Reported[] = [];
  return { reports, report: (name, value, attrs) => reports.push({ name, value, attrs }) };
}

describe("collectDiagnostics", () => {
  beforeEach(() => fakeObserver.install(["resource", "longtask"]));
  afterEach(() => fakeObserver.restore());

  it("reports only resources slower than the threshold", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, OPTIONS);

    fakeObserver.emit("resource", [
      { name: "https://cdn.test/fast.js", duration: 120, initiatorType: "script", transferSize: 10 } as never,
      { name: "https://cdn.test/slow.js?v=2", duration: 1400, initiatorType: "script", transferSize: 90 } as never,
    ]);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ name: "RESOURCE", value: 1400 });
    // The query string is stripped: it carries tokens and adds no signal.
    expect(reports[0]?.attrs?.url).toBe("https://cdn.test/slow.js");
  });

  // Measuring our own beacons would make the SDK's own latency look like
  // the page's, and every flush would generate another sample.
  it("never measures its own ingest endpoint", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, OPTIONS);

    fakeObserver.emit("resource", [
      { name: "https://ingest.test/v1/collect", duration: 2000, initiatorType: "beacon" } as never,
    ]);

    expect(reports).toHaveLength(0);
  });

  it("caps how many resources one page can report", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, OPTIONS);

    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `https://cdn.test/${i}.js`,
      duration: 900,
      initiatorType: "script",
    }));
    fakeObserver.emit("resource", many as never);

    expect(reports).toHaveLength(30);
  });

  it("reports long tasks", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, OPTIONS);

    fakeObserver.emit("longtask", [{ name: "self", duration: 180.6 } as never]);

    expect(reports[0]).toMatchObject({ name: "LONGTASK", value: 181 });
  });

  it("counts uncaught errors and unhandled rejections", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, OPTIONS);

    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: "https://a.test/app.js?v=1", lineno: 42 }),
    );
    window.dispatchEvent(new Event("unhandledrejection"));

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ name: "ERROR", value: 1 });
    expect(reports[0]?.attrs).toEqual({ message: "boom", source: "https://a.test/app.js:42" });
  });

  it("observes nothing that was switched off", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, {
      ...OPTIONS,
      captureResources: false,
      captureLongTasks: false,
      captureErrors: false,
    });

    fakeObserver.emit("resource", [{ name: "https://a.test/x.js", duration: 5000 } as never]);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(reports).toHaveLength(0);
  });

  it("removes its window listeners on disconnect", () => {
    const { reports, report } = recorder();
    collectDiagnostics(report, OPTIONS).disconnect();

    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(reports).toHaveLength(0);
  });
});
