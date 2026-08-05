import { formatValue, ratePercentile } from "../metrics";
import type { Metric, PageStat } from "../types";

interface Props {
  pages: PageStat[];
  metric: Metric;
  onSelectPage: (page: string) => void;
}

// Horizontal bars, ordered by traffic rather than by how bad the number is:
// a single slow visit to an obscure page would otherwise top the list and
// send everyone optimising something nobody loads.
export function PageBreakdown({ pages, metric, onSelectPage }: Props) {
  if (pages.length === 0) {
    return <p className="empty">这段时间没有页面级数据。</p>;
  }

  const worst = Math.max(...pages.map((page) => page.p75), 1);

  return (
    <ul className="breakdown">
      {pages.map((page) => {
        const rating = ratePercentile(metric, page.p75);
        return (
          <li key={page.page} className="breakdown__row">
            <button
              type="button"
              className="breakdown__page"
              onClick={() => onSelectPage(page.page)}
              title={`只看 ${page.page}`}
            >
              {page.page}
            </button>
            <div className="breakdown__track">
              <div
                className={`breakdown__bar breakdown__bar--${rating}`}
                style={{ width: `${(page.p75 / worst) * 100}%` }}
              />
            </div>
            <span className="breakdown__value">{formatValue(metric, page.p75)}</span>
            <span className="breakdown__samples">{page.samples}</span>
          </li>
        );
      })}
    </ul>
  );
}
