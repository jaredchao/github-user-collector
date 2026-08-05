interface Props {
  good: number;
  needsImprovement: number;
  poor: number;
}

// The good/needs-improvement/poor split, as a stacked bar. A p75 alone hides
// the shape of the distribution: 100% "needs improvement" and a half-and-half
// good/poor mix can produce the same percentile and call for different work.
export function RatingBar({ good, needsImprovement, poor }: Props) {
  const total = good + needsImprovement + poor;
  if (total === 0) return null;

  const percent = (count: number): number => (count / total) * 100;
  const label = `良好 ${good}，待改进 ${needsImprovement}，较差 ${poor}`;

  return (
    <div className="rating-bar" role="img" aria-label={label} title={label}>
      <span className="rating-bar__segment rating-bar__segment--good" style={{ width: `${percent(good)}%` }} />
      <span
        className="rating-bar__segment rating-bar__segment--needs-improvement"
        style={{ width: `${percent(needsImprovement)}%` }}
      />
      <span className="rating-bar__segment rating-bar__segment--poor" style={{ width: `${percent(poor)}%` }} />
    </div>
  );
}
