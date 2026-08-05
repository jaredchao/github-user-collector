import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildScale, LineChart } from "./LineChart";
import type { Point } from "../types";

function point(overrides: Partial<Point> = {}): Point {
  return {
    bucket: "2026-08-05T09:00:00.000Z",
    samples: 10,
    p50: 1000,
    p75: 1500,
    p95: 2000,
    good: 8,
    needsImprovement: 1,
    poor: 1,
    ...overrides,
  };
}

describe("LineChart", () => {
  it("says so instead of drawing an empty axis when there is no data", () => {
    render(<LineChart points={[]} metric="LCP" bucketSeconds={60} />);
    expect(screen.getByText(/没有采集到数据/)).toBeInTheDocument();
  });

  it("renders a path per series and describes itself for screen readers", () => {
    const points = [point(), point({ bucket: "2026-08-05T09:01:00.000Z", p75: 1800 })];
    const { container } = render(<LineChart points={points} metric="LCP" bucketSeconds={60} />);

    expect(screen.getByRole("img", { name: /LCP 随时间变化，共 2 个数据点/ })).toBeInTheDocument();
    expect(container.querySelector(".chart__line")).toBeTruthy();
    expect(container.querySelector(".chart__band")).toBeTruthy();
  });

  // A single point has no interval to divide, and dividing by zero would
  // put it at NaN and blank the chart.
  it("survives a single data point", () => {
    const { container } = render(<LineChart points={[point()]} metric="LCP" bucketSeconds={60} />);
    const path = container.querySelector(".chart__line")?.getAttribute("d") ?? "";

    expect(path).not.toContain("NaN");
    expect(path.length).toBeGreaterThan(0);
  });

  it("draws the Web Vitals thresholds so a raw number can be judged", () => {
    const { container } = render(<LineChart points={[point()]} metric="LCP" bucketSeconds={60} />);
    expect(container.querySelectorAll(".chart__threshold").length).toBeGreaterThan(0);
  });

  it("omits thresholds for metrics that have none", () => {
    const { container } = render(<LineChart points={[point()]} metric="CUSTOM" bucketSeconds={60} />);
    expect(container.querySelectorAll(".chart__threshold")).toHaveLength(0);
  });
});

describe("buildScale", () => {
  // Starting the axis at the data's minimum turns a 10ms wobble into a
  // dramatic climb. Durations start at zero.
  it("always starts at zero", () => {
    expect(buildScale([point({ p50: 900, p95: 1000 })], "LCP").min).toBe(0);
  });

  it("leaves headroom above the tallest value", () => {
    const scale = buildScale([point({ p95: 2000 })], "LCP");
    expect(scale.max).toBeGreaterThanOrEqual(2200);
  });

  // A chart whose axis stops below the "poor" line cannot show that the
  // values are comfortably under it.
  it("keeps the good threshold inside the axis even when values are tiny", () => {
    const scale = buildScale([point({ p50: 10, p75: 12, p95: 15 })], "LCP");
    expect(scale.max).toBeGreaterThanOrEqual(2500);
  });

  it("rounds the axis maximum to a readable number", () => {
    const scale = buildScale([point({ p95: 2870 })], "LCP");
    expect([5000, 10000]).toContain(scale.max);
  });

  it("never produces a zero span, which would divide by zero", () => {
    const scale = buildScale([point({ p50: 0, p75: 0, p95: 0 })], "CUSTOM");
    expect(scale.span).toBeGreaterThan(0);
  });
});
