import { useMemo, useState } from "react";
import { formatBucket, formatValue, ratePercentile } from "../metrics";
import type { Metric, Point } from "../types";

// A fixed viewBox scaled by CSS: the chart stays sharp at any width without
// a resize observer, and every coordinate below can be plain arithmetic.
const WIDTH = 800;
const HEIGHT = 280;
const PADDING = { top: 16, right: 16, bottom: 32, left: 52 };

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

// Web Vitals thresholds, drawn as reference lines. Without them a chart of
// raw milliseconds says nothing about whether the number is acceptable.
const REFERENCE_LINES: Partial<Record<Metric, readonly { value: number; label: string }[]>> = {
  LCP: [
    { value: 2500, label: "良好" },
    { value: 4000, label: "较差" },
  ],
  INP: [
    { value: 200, label: "良好" },
    { value: 500, label: "较差" },
  ],
  CLS: [
    { value: 0.1, label: "良好" },
    { value: 0.25, label: "较差" },
  ],
  FCP: [
    { value: 1800, label: "良好" },
    { value: 3000, label: "较差" },
  ],
  TTFB: [
    { value: 800, label: "良好" },
    { value: 1800, label: "较差" },
  ],
};

interface Props {
  points: Point[];
  metric: Metric;
  bucketSeconds: number;
}

export function LineChart({ points, metric, bucketSeconds }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);

  const scale = useMemo(() => buildScale(points, metric), [points, metric]);

  if (points.length === 0) {
    return (
      <div className="chart chart--empty" role="img" aria-label="所选范围内没有数据">
        这段时间没有采集到数据
      </div>
    );
  }

  const x = (index: number): number =>
    points.length === 1
      ? PADDING.left + PLOT_WIDTH / 2
      : PADDING.left + (index / (points.length - 1)) * PLOT_WIDTH;

  const y = (value: number): number =>
    PADDING.top + PLOT_HEIGHT - ((value - scale.min) / scale.span) * PLOT_HEIGHT;

  const line = (pick: (p: Point) => number): string =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(pick(point))}`).join(" ");

  // The p50-to-p95 band shows spread: a flat p75 hiding a widening tail is
  // the failure this chart exists to make visible.
  const band = [
    ...points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point.p95)}`),
    ...[...points].reverse().map((point, index) => `L${x(points.length - 1 - index)},${y(point.p50)}`),
    "Z",
  ].join(" ");

  const active = hovered !== null ? points[hovered] : undefined;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="chart__svg"
        role="img"
        aria-label={`${metric} 随时间变化，共 ${points.length} 个数据点`}
        onMouseLeave={() => setHovered(null)}
        onMouseMove={(event) => setHovered(nearestIndex(event, points.length))}
      >
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={y(tick)}
              y2={y(tick)}
              className="chart__gridline"
            />
            <text x={PADDING.left - 8} y={y(tick) + 4} className="chart__axis-label" textAnchor="end">
              {formatValue(metric, tick)}
            </text>
          </g>
        ))}

        {(REFERENCE_LINES[metric] ?? [])
          .filter((reference) => reference.value >= scale.min && reference.value <= scale.max)
          .map((reference) => (
            <g key={reference.label}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={y(reference.value)}
                y2={y(reference.value)}
                className={`chart__threshold chart__threshold--${reference.label === "良好" ? "good" : "poor"}`}
              />
              <text
                x={WIDTH - PADDING.right}
                y={y(reference.value) - 4}
                className="chart__threshold-label"
                textAnchor="end"
              >
                {reference.label}
              </text>
            </g>
          ))}

        <path d={band} className="chart__band" />
        <path d={line((point) => point.p75)} className="chart__line" />

        {active !== undefined && hovered !== null && (
          <g>
            <line
              x1={x(hovered)}
              x2={x(hovered)}
              y1={PADDING.top}
              y2={PADDING.top + PLOT_HEIGHT}
              className="chart__cursor"
            />
            <circle cx={x(hovered)} cy={y(active.p75)} r={4} className="chart__dot" />
          </g>
        )}

        {xTicks(points.length).map((index) => (
          <text
            key={index}
            x={x(index)}
            y={HEIGHT - 10}
            className="chart__axis-label"
            textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
          >
            {formatBucket(points[index]?.bucket ?? "", bucketSeconds)}
          </text>
        ))}
      </svg>

      <div className="chart__readout" aria-live="polite">
        {active ? (
          <>
            <strong>{formatBucket(active.bucket, bucketSeconds)}</strong>
            <span className={`chart__value chart__value--${ratePercentile(metric, active.p75)}`}>
              p75 {formatValue(metric, active.p75)}
            </span>
            <span>p50 {formatValue(metric, active.p50)}</span>
            <span>p95 {formatValue(metric, active.p95)}</span>
            <span>{active.samples} 个样本</span>
          </>
        ) : (
          <span className="chart__hint">阴影是 p50 到 p95 的区间，实线是 p75</span>
        )}
      </div>
    </div>
  );
}

interface Scale {
  min: number;
  max: number;
  span: number;
  ticks: number[];
}

// The axis starts at zero for durations: starting at the data's minimum
// would exaggerate a 10ms wobble into a dramatic climb.
export function buildScale(points: Point[], metric: Metric): Scale {
  const values = points.flatMap((point) => [point.p50, point.p95]);
  const thresholds = REFERENCE_LINES[metric] ?? [];
  const highest = Math.max(...values, thresholds[0]?.value ?? 0, 1);

  const max = niceCeiling(highest * 1.1);
  const min = 0;
  const span = max - min || 1;

  return { min, max, span, ticks: [0, max / 4, max / 2, (max * 3) / 4, max] };
}

// Rounds an axis maximum up to a readable number, so labels read 3 s rather
// than 2.87 s.
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude;
}

function xTicks(count: number): number[] {
  if (count <= 1) return [0];
  const desired = Math.min(6, count);
  const step = (count - 1) / (desired - 1);
  return Array.from({ length: desired }, (_, i) => Math.round(i * step));
}

function nearestIndex(event: React.MouseEvent<SVGSVGElement>, count: number): number | null {
  const svg = event.currentTarget;
  const bounds = svg.getBoundingClientRect();
  if (bounds.width === 0) return null;

  // The pointer is in CSS pixels; the plot is in viewBox units.
  const viewBoxX = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
  const ratio = (viewBoxX - PADDING.left) / PLOT_WIDTH;
  if (ratio < -0.05 || ratio > 1.05) return null;

  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}
