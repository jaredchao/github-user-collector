import type { Filters } from "../api";

const RANGES = [
  { value: "1h", label: "1 小时" },
  { value: "6h", label: "6 小时" },
  { value: "24h", label: "24 小时" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
] as const;

interface Props {
  filters: Filters;
  sites: string[];
  pages: string[];
  onChange: (filters: Filters) => void;
  onRefresh: () => void;
  loading: boolean;
}

export function Controls({ filters, sites, pages, onChange, onRefresh, loading }: Props) {
  return (
    <div className="controls">
      <label className="controls__field">
        <span>站点</span>
        <select
          value={filters.site}
          onChange={(event) => onChange({ ...filters, site: event.target.value, page: "" })}
        >
          {/* The configured default may not be in the list yet on a fresh
              deployment, so it is always offered. */}
          {(sites.includes(filters.site) ? sites : [filters.site, ...sites]).map((site) => (
            <option key={site} value={site}>
              {site}
            </option>
          ))}
        </select>
      </label>

      <label className="controls__field">
        <span>页面</span>
        <select value={filters.page} onChange={(event) => onChange({ ...filters, page: event.target.value })}>
          <option value="">全部页面</option>
          {pages.map((page) => (
            <option key={page} value={page}>
              {page}
            </option>
          ))}
        </select>
      </label>

      <div className="controls__field">
        <span>时间范围</span>
        <div className="controls__ranges" role="group" aria-label="时间范围">
          {RANGES.map((range) => (
            <button
              key={range.value}
              type="button"
              className={filters.range === range.value ? "range range--active" : "range"}
              aria-pressed={filters.range === range.value}
              onClick={() => onChange({ ...filters, range: range.value })}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <button type="button" className="controls__refresh" onClick={onRefresh} disabled={loading}>
        {loading ? "加载中" : "刷新"}
      </button>
    </div>
  );
}
