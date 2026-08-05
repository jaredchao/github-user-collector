import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchBreakdown, fetchPages, fetchSites, fetchSummary, fetchTimeseries, type Filters } from "./api";
import { Controls } from "./components/Controls";
import { LineChart } from "./components/LineChart";
import { PageBreakdown } from "./components/PageBreakdown";
import { SummaryCards } from "./components/SummaryCards";
import { METRIC_LABELS } from "./metrics";
import type { Metric, MetricSummary, PageStat, Timeseries } from "./types";

const DEFAULT_SITE = import.meta.env.VITE_DEFAULT_SITE ?? "zuoye-frontend";
const REFRESH_MS = 60_000;

export function App() {
  const [filters, setFilters] = useState<Filters>({ site: DEFAULT_SITE, page: "", range: "24h" });
  const [metric, setMetric] = useState<Metric>("LCP");

  const [sites, setSites] = useState<string[]>([]);
  const [pages, setPages] = useState<string[]>([]);
  const [summaries, setSummaries] = useState<MetricSummary[]>([]);
  const [series, setSeries] = useState<Timeseries | null>(null);
  const [breakdown, setBreakdown] = useState<PageStat[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters can change faster than the network answers. Every load takes a
  // ticket and only the newest one is allowed to write state, otherwise a
  // slow earlier response overwrites the newer view.
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const current = ++ticket.current;
    setLoading(true);

    try {
      const [summary, timeseries, pageStats] = await Promise.all([
        fetchSummary(filters),
        fetchTimeseries(filters, metric),
        fetchBreakdown(filters, metric),
      ]);

      if (current !== ticket.current) return;
      setSummaries(summary.metrics);
      setSeries(timeseries);
      setBreakdown(pageStats.pages);
      setError(null);
    } catch (err) {
      if (current !== ticket.current) return;
      setError(err instanceof ApiError ? err.message : "加载失败，请稍后再试");
    } finally {
      if (current === ticket.current) setLoading(false);
    }
  }, [filters, metric]);

  useEffect(() => {
    void load();
  }, [load]);

  // The selectors are refreshed separately: they change rarely, and a failure
  // to list sites should not blank out the charts.
  useEffect(() => {
    fetchSites()
      .then((response) => setSites(response.sites))
      .catch(() => setSites([]));
  }, []);

  useEffect(() => {
    fetchPages(filters.site)
      .then((response) => setPages(response.pages))
      .catch(() => setPages([]));
  }, [filters.site]);

  // Telemetry keeps arriving, so the view refreshes itself — but not while
  // the tab is in the background, where it would only burn requests.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="app">
      <header className="app__header">
        <h1>前端性能监控</h1>
        <p className="app__subtitle">
          浏览器 SDK 上报 → CloudWatch Logs → ECS 清洗 → PostgreSQL 聚合
        </p>
      </header>

      <Controls
        filters={filters}
        sites={sites}
        pages={pages}
        onChange={setFilters}
        onRefresh={() => void load()}
        loading={loading}
      />

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      <section className="section">
        <h2 className="section__title">指标概览</h2>
        <SummaryCards summaries={summaries} selected={metric} onSelect={setMetric} />
      </section>

      <section className="section">
        <h2 className="section__title">
          {metric} · {METRIC_LABELS[metric]} 趋势
          {filters.page && <span className="section__filter">{filters.page}</span>}
        </h2>
        {series?.approximate && (
          <p className="banner banner--info">
            这段时间的明细已过保留期，百分位由分钟聚合合并得出，为近似值。
          </p>
        )}
        <LineChart
          points={series?.points ?? []}
          metric={metric}
          bucketSeconds={series?.bucketSeconds ?? 60}
        />
      </section>

      <section className="section">
        <h2 className="section__title">{metric} 按页面分布</h2>
        <PageBreakdown
          pages={breakdown}
          metric={metric}
          onSelectPage={(page) => setFilters({ ...filters, page })}
        />
      </section>
    </div>
  );
}
