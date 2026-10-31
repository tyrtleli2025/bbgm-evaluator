// Bounded-variable Hoeffding intervals: conservative, valid even for zero observed
// titles/zero observed differences. No false precision from a zero sample variance.
export function estimate(values, min, max, alpha = 0.05) {
  if (!values.length) return { mean: null, standardError: null, interval95: [min, max], n: 0 };
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const standardError = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n) : null;
  const radius = (max - min) * Math.sqrt(Math.log(2 / alpha) / (2 * n));
  return { mean, standardError, interval95: [Math.max(min, mean - radius), Math.min(max, mean + radius)], n };
}
export function summarize(plans, trials, seasons = 8) {
  // Only complete paired trials enter any comparison. Failures never count as losses.
  const complete = trials.filter(t => plans.every(p => t.results[p.id]?.years?.length === seasons));
  return plans.map(plan => {
    const runs = complete.map(t => t.results[plan.id]);
    const values = runs.map(r => r.titles);
    const differences = complete.map(t => t.results[plan.id].titles - t.results.baseline.titles);
    return { id: plan.id, name: plan.name, expectedTitles: estimate(values, 0, seasons),
      deltaFromBaseline: plan.id === 'baseline' ? { mean: 0, standardError: 0, interval95: [0, 0], n: complete.length } : estimate(differences, -seasons, seasons),
      titleCountDistribution: Array.from({ length: seasons + 1 }, (_, titles) => ({ titles, count: values.filter(v => v === titles).length,
        probability: runs.length ? values.filter(v => v === titles).length / runs.length : null })),
      years: Array.from({ length: seasons }, (_, index) => ({ season: runs[0]?.years[index].season ?? null,
        titleProbability: estimate(runs.map(r => Number(r.years[index].title)), 0, 1),
        averageWins: runs.length ? runs.reduce((s, r) => s + r.years[index].won, 0) / runs.length : null })),
    };
  }).sort((a, b) => (b.expectedTitles.mean ?? -Infinity) - (a.expectedTitles.mean ?? -Infinity));
}
