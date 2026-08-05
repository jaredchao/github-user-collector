import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ApiError } from "./api";
import type { MetricSummary, PageStat, Timeseries } from "./types";

const { fetchSites, fetchPages, fetchSummary, fetchTimeseries, fetchBreakdown } = vi.hoisted(() => ({
  fetchSites: vi.fn(),
  fetchPages: vi.fn(),
  fetchSummary: vi.fn(),
  fetchTimeseries: vi.fn(),
  fetchBreakdown: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchSites,
  fetchPages,
  fetchSummary,
  fetchTimeseries,
  fetchBreakdown,
}));

const SUMMARIES: MetricSummary[] = [
  { metric: "LCP", samples: 120, p50: 1400, p75: 2100, p95: 3800, good: 90, needsImprovement: 20, poor: 10 },
  { metric: "INP", samples: 80, p50: 90, p75: 150, p95: 320, good: 70, needsImprovement: 8, poor: 2 },
];

const SERIES: Timeseries = {
  site: "demo",
  metric: "LCP",
  page: "",
  from: "2026-08-05T00:00:00.000Z",
  to: "2026-08-05T12:00:00.000Z",
  bucketSeconds: 900,
  approximate: false,
  points: [
    {
      bucket: "2026-08-05T09:00:00.000Z",
      samples: 10,
      p50: 1200,
      p75: 1900,
      p95: 3000,
      good: 8,
      needsImprovement: 1,
      poor: 1,
    },
  ],
};

const PAGES: PageStat[] = [
  { page: "/users/:id", samples: 60, p75: 2400, poor: 8 },
  { page: "/", samples: 40, p75: 1500, poor: 1 },
];

describe("App", () => {
  beforeEach(() => {
    fetchSites.mockResolvedValue({ sites: ["demo", "other"] });
    fetchPages.mockResolvedValue({ pages: ["/", "/users/:id"] });
    fetchSummary.mockResolvedValue({ metrics: SUMMARIES });
    fetchTimeseries.mockResolvedValue(SERIES);
    fetchBreakdown.mockResolvedValue({ pages: PAGES });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a card per reported metric", async () => {
    render(<App />);

    expect(await screen.findByRole("button", { name: /LCP/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /INP/ })).toBeInTheDocument();
    // 2100 ms formats as seconds once it crosses a second.
    expect(screen.getByText("2.10 s")).toBeInTheDocument();
  });

  it("switches the chart when another metric card is selected", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /INP/ });

    await userEvent.click(screen.getByRole("button", { name: /INP/ }));

    await waitFor(() => {
      expect(fetchTimeseries).toHaveBeenCalledWith(expect.anything(), "INP");
    });
    expect(await screen.findByText(/交互到下一帧 趋势/)).toBeInTheDocument();
  });

  it("reloads with the new window when the range changes", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /LCP/ });

    await userEvent.click(screen.getByRole("button", { name: "7 天" }));

    await waitFor(() => {
      expect(fetchSummary).toHaveBeenCalledWith(expect.objectContaining({ range: "7d" }));
    });
  });

  it("filters to a single page when one is picked from the breakdown", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "/users/:id" });

    await userEvent.click(screen.getByRole("button", { name: "/users/:id" }));

    await waitFor(() => {
      expect(fetchTimeseries).toHaveBeenCalledWith(
        expect.objectContaining({ page: "/users/:id" }),
        expect.anything(),
      );
    });
  });

  it("shows the failure instead of an empty chart that looks like good news", async () => {
    fetchSummary.mockRejectedValue(new ApiError("查询服务暂时不可用", 503));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("查询服务暂时不可用");
  });

  // Merged percentiles are an approximation. Presenting them as exact is the
  // kind of quiet wrongness a monitoring tool must not have.
  it("warns when the numbers came from merged rollups", async () => {
    fetchTimeseries.mockResolvedValue({ ...SERIES, approximate: true });

    render(<App />);

    expect(await screen.findByText(/近似值/)).toBeInTheDocument();
  });

  it("stays usable when the site list cannot be loaded", async () => {
    fetchSites.mockRejectedValue(new Error("boom"));

    render(<App />);

    expect(await screen.findByRole("button", { name: /LCP/ })).toBeInTheDocument();
  });

  it("tells the user when nothing has been collected yet", async () => {
    fetchSummary.mockResolvedValue({ metrics: [] });
    fetchTimeseries.mockResolvedValue({ ...SERIES, points: [] });
    fetchBreakdown.mockResolvedValue({ pages: [] });

    render(<App />);

    expect(await screen.findByText(/还没有采集到任何指标/)).toBeInTheDocument();
  });
});
