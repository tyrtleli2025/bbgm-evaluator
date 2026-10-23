import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolveTeamNames } from './team-names.mjs';

const ratings = 'hgt stre spd jmp endu ins dnk ft fg tp oiq diq drb pss reb'.split(' ');
const nonnegativeSettings = 'turnoverFactor stealFactor blockFactor assistFactor orbFactor foulRateFactor twoPointAccuracyFactor threePointAccuracyFactor threePointTendencyFactor ftAccuracyFactor'.split(' ');
const positiveSettings = 'pace quarterLength numPeriods numPlayersOnCourt overtimeLength'.split(' ');
const requiredSettings = [...nonnegativeSettings, ...positiveSettings,
  'season', 'gender', 'homeCourtAdvantage', 'threePointers', 'foulsNeededToFoulOut',
  'foulsUntilBonus', 'elam', 'elamASG', 'elamOvertime', 'elamMinutes', 'elamPoints',
  'maxOvertimes', 'maxOvertimesPlayoffs', 'shootoutRounds', 'neutralSite'];

function finite(value, label, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

export function normalizeLeague(data, inputHash = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a league JSON object');
  if (!Array.isArray(data.players)) throw new Error('Missing players array');
  for (const key of ['teams','draftPicks','releasedPlayers']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`Invalid ${key}: expected an array`);
  }
  if (!data.gameAttributes || Array.isArray(data.gameAttributes)) {
    throw new Error('A gameAttributes object with simulation settings is required');
  }
  const settings = structuredClone(data.gameAttributes);
  // BBGM permits season-indexed game attributes. Select the current value.
  if (!Number.isInteger(settings.season)) throw new Error('Invalid gameAttributes.season');
  for (const [key, value] of Object.entries(settings)) {
    if (Array.isArray(value) && value.length && value.every(v => v && typeof v === 'object' && 'start' in v && 'value' in v)) {
      const eligible = value.filter(v => v.start === null || v.start <= settings.season)
        .sort((a, b) => (a.start ?? -Infinity) - (b.start ?? -Infinity));
      if (!eligible.length) throw new Error(`No current value for gameAttributes.${key}`);
      settings[key] = eligible.at(-1).value;
    }
  }
  for (const key of requiredSettings) {
    if (!Object.hasOwn(settings, key)) throw new Error(`Missing gameAttributes.${key}`);
  }
  for (const key of nonnegativeSettings) finite(settings[key], key, 0);
  for (const key of positiveSettings) finite(settings[key], key, Number.EPSILON);
  finite(settings.homeCourtAdvantage, 'homeCourtAdvantage');
  if (!Number.isInteger(settings.numPlayersOnCourt) || !Number.isInteger(settings.numPeriods)) {
    throw new Error('numPlayersOnCourt and numPeriods must be integers');
  }
  if (settings.orbFactor === 0) throw new Error('orbFactor must be positive');
  if (!['never','playoffs','finals'].includes(settings.neutralSite)) throw new Error('Unsupported neutralSite setting');
  for (const key of ['threePointers','elam','elamASG','elamOvertime']) {
    if (typeof settings[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(settings.foulsUntilBonus) || settings.foulsUntilBonus.length !== 3 ||
      settings.foulsUntilBonus.some(x => !Number.isInteger(x) || x < 0)) throw new Error('Invalid foulsUntilBonus');
  finite(settings.foulsNeededToFoulOut, 'foulsNeededToFoulOut', 0);
  for (const key of ['maxOvertimes','maxOvertimesPlayoffs']) {
    if (settings[key] !== null && (!Number.isInteger(settings[key]) || settings[key] < 0)) throw new Error(`Invalid ${key}`);
  }
  if (settings.elam || settings.elamOvertime || settings.shootoutRounds || settings.shootoutRoundsPlayoffs) {
    throw new Error('This evaluator currently supports timed basketball without Elam endings or shootouts');
  }
  const warnings = [
    'Frozen exported rosters and ratings; no signings, aging, development, or season forecast.',
    'Underlying ratings are used without scouting fuzz.',
    'New in-game injuries are disabled; each game starts from the same exported state.',
    'Exported playing-time modifiers are honored for every team (controlled team is unknown).',
    'Missing team injury policies use the upstream default: play through 0 games in regular season, 4 in playoffs.',
    'The pinned reference engine is not proven to match the build that produced this export.',
    'Possessions use a box-score estimator; efficiency ratings and strength are estimates.',
    'Confidence intervals describe simulation sampling only, not input or engine-model uncertainty.',
  ];
  const teams = new Map();
  const pids = new Set();
  for (const raw of data.players) {
    if (!Number.isInteger(raw.tid)) throw new Error('Player has invalid tid');
    if (raw.tid < 0) continue;
    if (!Number.isInteger(raw.pid) || pids.has(raw.pid)) throw new Error(`Invalid/duplicate pid: ${raw.pid}`);
    pids.add(raw.pid);
    if (!Array.isArray(raw.ratings) || !raw.ratings.length) throw new Error(`Missing ratings: ${raw.pid}`);
    const eligible = raw.ratings.filter(r => Number.isInteger(r.season) && r.season <= settings.season);
    const rating = eligible.sort((a, b) => a.season - b.season).at(-1);
    if (!rating) throw new Error(`No ratings at/before ${settings.season}: ${raw.pid}`);
    for (const key of ratings) finite(rating[key], `player ${raw.pid} rating ${key}`, 0, 100);
    if (rating.season !== settings.season) warnings.push(`Player ${raw.pid}: using ${rating.season} ratings.`);
    for (const key of ['valueNoPot', 'ptModifier', 'rosterOrder']) finite(raw[key], `player ${raw.pid} ${key}`, 0);
    finite(raw.injury?.gamesRemaining, `player ${raw.pid} injury.gamesRemaining`, 0);
    if (!Number.isInteger(raw.born?.year) || typeof rating.pos !== 'string') throw new Error(`Missing age/position: ${raw.pid}`);
    const p = structuredClone(raw);
    p.rating = structuredClone(rating);
    if (!teams.has(p.tid)) teams.set(p.tid, []);
    teams.get(p.tid).push(p);
  }
  if (teams.size < 2) throw new Error('At least two reconstructed teams are required');
  const teamNames = resolveTeamNames(data,settings,teams.keys());
  if ([...teamNames.values()].some(t=>t.source==='historical-reference')) warnings.push('Missing exported team names use historical NBA franchise names based on the league starting season; custom relocations require exported team metadata.');
  if ([...teamNames.values()].some(t=>t.source==='id')) warnings.push('Some team names are unavailable; those teams are labeled by ID.');
  for (const [tid, roster] of teams) {
    roster.sort((a, b) => a.rosterOrder - b.rosterOrder || a.pid - b.pid);
    if (roster.length < settings.numPlayersOnCourt) throw new Error(`Team ${tid} has too few players`);
    if (roster.length < settings.minRosterSize) warnings.push(`${teamNames.get(tid).name} has ${roster.length} players, below the league roster minimum; evaluated as exported.`);
  }
  // Preserve transaction context separately from the simulation adapter. Historical
  // logs are unnecessary for current player trade value and expensive to clone.
  const historyKeys = new Set(['stats', 'awards', 'salaries', 'transactions', 'ratings']);
  const contextPlayers = data.players.filter(p => p.tid >= -1).map(p => ({
    ...Object.fromEntries(Object.entries(p).filter(([key]) => !historyKeys.has(key))),
    ratings: p.ratings?.length ? [structuredClone(p.ratings.at(-1))] : [],
  }));
  const rawData = { gameAttributes: structuredClone(settings), players: contextPlayers,
    teams: structuredClone(data.teams), releasedPlayers: structuredClone(data.releasedPlayers),
    draftPicks: structuredClone(data.draftPicks) };
  return { settings, teams: new Map([...teams].sort((a,b) => a[0]-b[0])), teamNames, warnings, rawData,
    inputHash, schemaVersion: data.version, totalPlayers: data.players.length };
}

export function readLeague(path) {
  const bytes = readFileSync(path);
  const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return normalizeLeague(JSON.parse(json.toString()), createHash('sha256').update(bytes).digest('hex'));
}
