import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@zuoye/perf-sdk", () => ({ init }));

import { startTelemetry } from "./telemetry";

describe("startTelemetry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  // This is what keeps PR previews out of the production site's percentiles:
  // the workflow builds them with an empty VITE_INGEST_URL.
  it("stays off when no ingest endpoint is configured", () => {
    vi.stubEnv("VITE_INGEST_URL", "");
    startTelemetry();
    expect(init).not.toHaveBeenCalled();
  });

  it("reports under the production site name by default", () => {
    vi.stubEnv("VITE_INGEST_URL", "https://ingest.test/v1/collect");

    startTelemetry();

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://ingest.test/v1/collect",
        site: "zuoye-frontend",
      }),
    );
  });

  it("allows the site name to be overridden", () => {
    vi.stubEnv("VITE_INGEST_URL", "https://ingest.test/v1/collect");
    vi.stubEnv("VITE_TELEMETRY_SITE", "zuoye-frontend-staging");

    startTelemetry();

    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({ site: "zuoye-frontend-staging" }),
    );
  });
});
