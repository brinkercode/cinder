// The repo's trust thresholds: a judge series is trusted from min_outcomes outcomes, an agent version's win rate from
// min_races decided races. No repo_trust row, or a NULL column, means the default.
export async function trustOf(db, repo) {
  const s = await db.prepare("SELECT min_outcomes, min_races FROM repo_trust WHERE repo = ?").bind(repo).first();
  return { min_outcomes: s?.min_outcomes ?? 200, min_races: s?.min_races ?? 30 };
}

// pairs: [{ p, y }], y = 1 when the judgment proved correct; trusted once there are minOutcomes of them. Fits isotonic regression with pool-adjacent-violators
// and returns calibrated(p) plus the judge's reliability: Brier score and 10 equal-width bins (empty bins omitted).
export function calibrate(pairs, minOutcomes) {
  const blocks = [];
  for (const { p, y } of pairs.toSorted((a, b) => a.p - b.p)) {
    blocks.push({ lo: p, sum: y, n: 1 });
    // Equal p is pooled too, so calibrated(p) has one value per stated probability.
    while (blocks.length > 1) {
      const [prev, last] = blocks.slice(-2);
      if (prev.sum / prev.n <= last.sum / last.n && prev.lo !== last.lo) break;
      blocks.pop();
      prev.sum += last.sum;
      prev.n += last.n;
    }
  }
  const bins = [];
  for (let i = 0; i < 10; i++) {
    const inBin = pairs.filter(({ p }) => Math.min(Math.floor(p * 10), 9) === i);
    if (!inBin.length) continue;
    const mean = (f) => inBin.reduce((s, x) => s + f(x), 0) / inBin.length;
    bins.push({ lo: i / 10, hi: (i + 1) / 10, count: inBin.length, mean_p: mean((x) => x.p), observed: mean((x) => x.y) });
  }
  return {
    count: pairs.length,
    trusted: pairs.length >= minOutcomes,
    brier: pairs.length ? pairs.reduce((s, { p, y }) => s + (p - y) ** 2, 0) / pairs.length : null,
    bins,
    // Below the lowest fitted p the first block applies; with no outcomes the raw p is all there is.
    calibrated: (p) => {
      const block = blocks.findLast((b) => b.lo <= p) ?? blocks[0];
      return block ? block.sum / block.n : p;
    },
  };
}

// pairs: [{ p, y, observed_at }]. The Brier score per ISO week (Monday UTC) over the last `weeks` weeks, oldest first;
// a week with no outcomes is { count: 0, brier: null }.
export function brierByWeek(pairs, weeks, now = Date.now()) {
  const DAY = 86400e3, WEEK = 7 * DAY;
  const start = Math.floor(now / DAY) * DAY - ((new Date(now).getUTCDay() + 6) % 7) * DAY - (weeks - 1) * WEEK;
  const out = Array.from({ length: weeks }, (_, i) => ({ week: new Date(start + i * WEEK).toISOString().slice(0, 10), count: 0, sum: 0 }));
  for (const { p, y, observed_at } of pairs) {
    const w = out[Math.floor((Date.parse(observed_at) - start) / WEEK)];
    if (w) { w.count++; w.sum += (p - y) ** 2; }
  }
  return out.map(({ week, count, sum }) => ({ week, count, brier: count ? sum / count : null }));
}
