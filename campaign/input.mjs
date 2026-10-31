import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function attribute(raw, key) {
  const value = raw.gameAttributes?.[key];
  return Array.isArray(value) && value[0] && Object.hasOwn(value[0], 'start')
    ? value.filter(row => row.start === null || row.start <= raw.gameAttributes.season).at(-1)?.value : value;
}
export async function readLeague(path) {
  const bytes = await readFile(path);
  const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }) : bytes;
  return { raw: JSON.parse(json), hash: sha256(json) };
}

export function validateLeague(raw, teamId) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.version) || raw.version < 73 || raw.version > 74) {
    throw new Error('The campaign runner supports complete schema 73–74 league exports.');
  }
  for (const key of ['players', 'teams', 'draftPicks', 'releasedPlayers', 'scheduledEvents']) {
    if (!Array.isArray(raw[key])) throw new Error(`Missing ${key}. Export the complete league, including draft prospects, teams, picks, and scheduled events.`);
  }
  if (!raw.gameAttributes || Array.isArray(raw.gameAttributes)) throw new Error('Missing gameAttributes object.');
  for (const key of ['season', 'phase', 'confs', 'divs', 'salaryCap', 'salaryCapType', 'numGames', 'numGamesPlayoffSeries', 'difficulty']) {
    if (attribute(raw, key) === undefined) throw new Error(`Missing league setting: ${key}`);
  }
  const phase = attribute(raw, 'phase');
  const season = attribute(raw, 'season');
  if (!Number.isInteger(season) || !Number.isInteger(phase) || phase < 0 || phase > 8) throw new Error('Unsupported season/phase (finish any expansion or fantasy draft first).');
  const team = raw.teams.find(t => t.tid === teamId && !t.disabled);
  if (!team) throw new Error(`Team ${teamId} is not an active team in this export.`);
  if (raw.teams.some((t, i) => t.tid !== i)) throw new Error('Team IDs must be sequential, as in a full BBGM export.');
  if (!attribute(raw, 'numGamesPlayoffSeries')?.length) throw new Error('A championship playoff format is required.');
  if (attribute(raw, 'repeatSeason') || attribute(raw, 'forceHistoricalRosters')) throw new Error('Repeat-season and forced historical roster modes are not supported for evolving-roster comparisons.');
  for (const t of raw.teams.filter(t => !t.disabled)) {
    if (!t.budget || !t.strategy || !t.playThroughInjuries || !Number.isFinite(t.pop)) throw new Error(`Team ${t.tid} is missing financial/management context. Use a full league export.`);
    if (!t.seasons?.some(s => s.season === season) && !raw.teamSeasons?.some(s => s.tid === t.tid && s.season === season)) {
      throw new Error(`Missing current season record/finances for team ${t.tid}.`);
    }
  }
  const pids = new Set();
  const ratingKeys = ['hgt', 'stre', 'spd', 'jmp', 'endu', 'ins', 'dnk', 'ft', 'fg', 'tp', 'oiq', 'diq', 'drb', 'pss', 'reb'];
  for (const p of raw.players) {
    if (!Number.isInteger(p.pid) || pids.has(p.pid)) throw new Error('Missing or duplicate player ID.');
    pids.add(p.pid);
    if (p.tid < -2) continue;
    if (!Number.isInteger(p.born?.year) || !Number.isFinite(p.contract?.amount) || !Number.isInteger(p.contract?.exp) || !p.injury ||
        ratingKeys.some(k => !Number.isFinite(p.ratings?.at(-1)?.[k]))) throw new Error(`Player ${p.pid} has incomplete ratings, age, health, or contract data.`);
  }
  if (!raw.players.some(p => p.tid === -2)) throw new Error('No draft prospects exported. Include all players and draft classes.');
  if ([1, 2].includes(phase) && (!Array.isArray(raw.schedule) || !raw.schedule.length)) throw new Error('An in-season export must include its remaining schedule.');
  if (phase === 3 && !raw.playoffSeries?.some(s => s.season === season)) throw new Error('A playoff export must include the current playoff bracket.');
  if (phase === 8 && !Number.isInteger(attribute(raw, 'daysLeft'))) throw new Error('Free agency requires daysLeft.');
  const events = new Set(['teamInfo', 'gameAttributes', 'expansionDraft', 'contraction', 'unretirePlayer', 'confsDivs', 'awards']);
  for (const event of raw.scheduledEvents) if (!events.has(event.type)) throw new Error(`Unsupported scheduled event: ${event.type}`);
  return { teamId, teamName: `${team.region} ${team.name}`, firstSeason: season + (phase > 3 ? 1 : 0), phase,
    warnings: ['Missing optional game settings use the pinned engine’s import defaults.',
      'The engine may generate prospects to fill incomplete future draft classes during import.',
      'Future management is BBGM auto-play AI for every team, including yours; this is not an optimized future policy.'] };
}

export function normalizePlans(input, teamId) {
  const keysOnly = (object, allowed) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('Expected a plan/trade object.');
    for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Unsupported plan/trade field: ${key}`);
  };
  if (!Array.isArray(input)) throw new Error('Plans must be a JSON array.');
  const ids = new Set(['baseline']);
  return [{ id: 'baseline', name: 'No opening move', actions: [] }, ...input.map((plan, i) => {
    keysOnly(plan, ['id', 'name', 'actions']);
    if (!plan || typeof plan.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(plan.id) || ids.has(plan.id)) throw new Error(`Invalid or duplicate plan ID at index ${i}. "baseline" is reserved.`);
    ids.add(plan.id);
    if (!Array.isArray(plan.actions)) throw new Error(`Plan ${plan.id} needs an actions array.`);
    const actions = plan.actions.map((action, index) => {
      keysOnly(action, ['type', 'teams']);
      if (action.type !== 'trade' || action.teams?.length !== 2) throw new Error(`Plan ${plan.id}, action ${index + 1}: expected a two-team trade.`);
      const teams = action.teams.map(side => {
        keysOnly(side, ['tid', 'pids', 'dpids']);
        if (!Number.isInteger(side.tid) || side.tid < 0) throw new Error('Invalid trade team ID.');
        const result = { tid: side.tid };
        for (const key of ['pids', 'dpids']) {
          const values = side[key] ?? [];
          if (!Array.isArray(values) || values.some(v => !Number.isInteger(v) || v < 0) || new Set(values).size !== values.length) throw new Error(`Invalid or duplicate ${key} in ${plan.id}.`);
          result[key] = [...values];
        }
        return result;
      });
      if (teams[0].tid !== teamId || teams[1].tid === teamId) throw new Error('The first trade side must be your team; the second must be a different team.');
      for (const key of ['pids', 'dpids']) if (teams[0][key].some(id => teams[1][key].includes(id))) throw new Error(`An asset appears on both sides of a trade in ${plan.id}.`);
      if (!teams.some(t => t.pids.length || t.dpids.length)) throw new Error('Empty trade. Use an empty actions array for a control plan.');
      return { type: 'trade', teams };
    });
    return { id: plan.id, name: typeof plan.name === 'string' ? plan.name : plan.id, actions };
  })];
}
