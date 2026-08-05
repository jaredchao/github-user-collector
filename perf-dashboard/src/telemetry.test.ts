import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@zuoye/perf-sdk", () => ({ init }));

import { startTelemetry } from "./telemetry";

describe("startTelemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  // Running the dashboard locally must not require the whole AWS chain.
  it("stays off when no ingest endpoint is configured", () => {
    vi.stubEnv("VITE_INGEST_URL", "");
    startTelemetry();
    expect(init).not.toHaveBeenCalled();
  });

  it("starts with the configured endpoint and site", () => {
    vi.stubEnv("VITE_INGEST_URL", "https://ingest.test/v1/collect");
    vi.stubEnv("VITE_TELEMETRY_SITE", "perf-dashboard");

    startTelemetry();

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://ingest.test/v1/collect",
        site: "perf-dashboard",
        captureLongTasks: false,
      }),
    );
  });
});
