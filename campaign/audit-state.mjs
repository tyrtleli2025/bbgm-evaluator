// Pure observations shared by the two backends; no simulation or import logic.
const select = (object, keys) => Object.fromEntries(keys.filter(k => object[k] !== undefined).map(k => [k, object[k]]));
export function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export async function auditState({ idb, g }, startingSeason) {
  await idb.cache.flush();
  const state = { season: g.get('season'), phase: g.get('phase'), stores: {} };
  const names = ['players', 'teams', 'teamSeasons', 'teamStats', 'draftPicks', 'releasedPlayers', 'playoffSeries', 'schedule', 'scheduledEvents', 'events', 'negotiations', 'gameAttributes'];
  for (const name of names) {
    let rows = await idb.league.getAll(name);
    if (name === 'players') rows = rows.map(p => ({ ...select(p, ['pid', 'tid', 'born', 'contract', 'salaries', 'injury', 'gamesUntilTradable', 'rosterOrder', 'ptModifier', 'value', 'valueNoPot', 'valueFuzz', 'draft', 'retiredYear', 'transactions']), ratings: p.ratings.at(-1), stats: p.stats.filter(s => s.season >= startingSeason) }));
    if (['teamSeasons', 'teamStats', 'playoffSeries', 'events'].includes(name)) rows = rows.filter(row => row.season >= startingSeason);
    if (name === 'events') rows = rows.map(row => select(row, ['eid', 'type', 'season', 'pids', 'tids', 'dpids', 'teams', 'score']));
    if (name === 'gameAttributes') rows = rows.filter(row => !['lid', 'lastDbChange'].includes(row.key));
    // getAll returns primary-key order in both implementations. Do not sort by
    // values: a small stat difference must not reorder unrelated player records.
    state.stores[name] = rows.map(canonical);
  }
  return canonical(state);
}

export const numericTolerance = 32 * Number.EPSILON;
export function differences(a, b, limit = 30) {
  const output = [];
  function walk(left, right, path) {
    if (output.length >= limit || Object.is(left, right)) return;
    // Different V8 releases can differ by a few ULPs, including a computed
    // 96.00000000000003 versus 96. Integer pairs remain exact; snapshots retain
    // all original precision and a changed ID/rating/count by 1 still fails.
    if (typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right)
      && (!Number.isInteger(left) || !Number.isInteger(right))
      && Math.abs(left - right) <= numericTolerance * Math.max(1, Math.abs(left), Math.abs(right))) return;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) {
      output.push({ path, node: left, browser: right }); return;
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk(left[key], right[key], `${path}.${key}`);
  }
  walk(a, b, '$'); return output;
}

export function importPreservation(raw, state) {
  const failures = [];
  const adjustments = [];
  const minContractSetting = state.stores.gameAttributes?.find(row => row.key === 'minContract')?.value ?? raw.gameAttributes?.minContract;
  const minContract = Array.isArray(minContractSetting)
    ? minContractSetting.filter(row => row.start === null || row.start <= state.season).at(-1)?.value : minContractSetting;
  // Explicit pinned-import rule: player/augmentPartialPlayer.ts uses
  // common/roundContract.ts. Report these changes; do not silently discard them.
  const roundContract = amount => {
    if (!Number.isFinite(minContract) || amount === minContract) return amount;
    const increment = minContract >= 3 ? 10 ** (Math.floor(Math.log10(minContract / 3)) - 1) : 1;
    return increment * Math.round(amount / increment);
  };
  const players = new Map(state.stores.players.map(p => [p.pid, p]));
  const attrs = ['hgt', 'stre', 'spd', 'jmp', 'endu', 'ins', 'dnk', 'ft', 'fg', 'tp', 'oiq', 'diq', 'drb', 'pss', 'reb'];
  for (const p of raw.players.filter(p => p.tid >= -2)) {
    const actual = players.get(p.pid);
    if (!actual) { failures.push({ pid: p.pid, field: 'missing player' }); continue; }
    for (const field of ['tid', 'born', 'contract', 'injury']) {
      if (p[field] === undefined) continue;
      // Extra importer-generated fields are permitted, but exported fields must survive.
      const expected = canonical(p[field]);
      if (field === 'contract' && Number.isFinite(expected.amount)) {
        const rounded = roundContract(expected.amount);
        if (rounded !== expected.amount) adjustments.push({ pid: p.pid, field: 'contract.amount', exported: expected.amount, expected: rounded, actual: actual.contract?.amount, reason: 'Native contract rounding' });
        expected.amount = rounded;
      }
      const got = expected && typeof expected === 'object' ? select(actual[field] ?? {}, Object.keys(expected)) : actual[field];
      if (JSON.stringify(canonical(got)) !== JSON.stringify(expected)) failures.push({ pid: p.pid, field, expected, actual: got });
    }
    for (const field of attrs) if (p.ratings.at(-1)[field] !== undefined && p.ratings.at(-1)[field] !== actual.ratings[field]) failures.push({ pid: p.pid, field: `ratings.${field}` });
  }
  return { passed: failures.length === 0, checkedPlayers: raw.players.filter(p => p.tid >= -2).length, failures: failures.slice(0, 30), failureCount: failures.length,
    nativeAdjustments: adjustments, nativeAdjustmentCount: adjustments.length };
}
