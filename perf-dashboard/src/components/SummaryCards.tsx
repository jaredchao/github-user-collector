import { formatValue, METRIC_LABELS, ratePercentile } from "../metrics";
import type { Metric, MetricSummary } from "../types";
import { RatingBar } from "./RatingBar";

interface Props {
  summaries: MetricSummary[];
  selected: Metric;
  onSelect: (metric: Metric) => void;
}

// Core Web Vitals first, then the supporting metrics. Order is fixed rather
// than data-driven so a card does not jump position between refreshes.
const ORDER: Metric[] = ["LCP", "INP", "CLS", "FCP", "TTFB", "RESOURCE", "LONGTASK", "ERROR", "CUSTOM"];

export function SummaryCards({ summaries, selected, onSelect }: Props) {
  const byMetric = new Map(summaries.map((summary) => [summary.metric, summary]));
  const present = ORDER.filter((metric) => byMetric.has(metric));

  if (present.length === 0) {
    return <p className="empty">这段时间还没有采集到任何指标。</p>;
  }

  return (
    <ul className="cards">
      {present.map((metric) => {
        const summary = byMetric.get(metric);
        if (!summary) return null;
        const rating = ratePercentile(metric, summary.p75);

        return (
          <li key={metric}>
            <button
              type="button"
              className={`card card--${rating} ${metric === selected ? "card--selected" : ""}`}
              onClick={() => onSelect(metric)}
              aria-pressed={metric === selected}
            >
              <span className="card__metric">{metric}</span>
              <span className="card__label">{METRIC_LABELS[metric]}</span>
              <span className="card__value">{formatValue(metric, summary.p75)}</span>
              <span className="card__sub">p75 · {summary.samples} 个样本</span>
              <RatingBar
                good={summary.good}
                needsImprovement={summary.needsImprovement}
                poor={summary.poor}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
