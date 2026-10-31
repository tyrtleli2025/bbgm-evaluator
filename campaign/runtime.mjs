import 'fake-indexeddb/auto';
import { auditState } from './audit-state.mjs';
import { teamFeatures,featureSettings } from './features.mjs';
import { generateTrades } from './generate.mjs';
import { readFile } from 'node:fs/promises';

// Every invocation lives in a fresh worker. No user's browser/database is opened.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost', pathname: '/' };
globalThis.addEventListener = () => {};
globalThis.fetch = async name => {
  const allowed = ['names.json', 'names-female.json', 'real-player-data.basketball.json', 'real-player-stats.basketball.json'];
  if (!allowed.includes(name)) throw new Error(`Unexpected engine network request: ${name}`);
  return new Response(await readFile(new URL(`../.campaign-engine/data/${name}`, import.meta.url)));
};

export async function runCampaign({ raw, teamId, plan, seed, seasons = 8, preflight = false, audit, generate, collectTraining = false }, onProgress = () => {}) {
  // Seed even module initialization, before loading the full engine.
  const { makeSeededRandom } = await import('../.campaign-build/random.mjs');
  Math.random = makeSeededRandom(seed);
  const { createStream, startAutoPlay, idb, g, league, trade, PHASE, defaultGameAttributes } =
    await import('../.campaign-build/engine.mjs');
  globalThis.campaignUI = (name, args) => {
    if (name === 'updateLocal' && args[0]?.phaseText) onProgress({ kind: 'phase', text: args[0].phaseText });
    if (name === 'showNotification' && args[0]?.type === 'error') throw new Error(args[0].text);
  };
  const ga = raw.gameAttributes;
  const current = key => {
    const value = ga[key];
    return Array.isArray(value) && value[0] && Object.hasOwn(value[0], 'start')
      ? value.filter(row => row.start === null || row.start <= ga.season).at(-1)?.value : value;
  };
  await createStream(raw, {
    conditions: {}, confs: current('confs'), divs: current('divs'),
    fromFile: { gameAttributes: ga, teams: raw.teams, version: raw.version,
      startingSeason: raw.startingSeason ?? ga.startingSeason ?? ga.season,
      hasRookieContracts: raw.players.some(p => p.contract?.rookie), maxGid: (raw.games ?? []).reduce((max, game) => Math.max(max, game.gid), -1) },
    keptKeys: new Set(Object.keys(raw)), lid: 1, name: 'Courtside isolated campaign',
    setLeagueCreationStatus: text => onProgress({ kind: 'import', text }),
    settings: { noStartingInjuries: false, randomization: 'none', repeatSeason: current('repeatSeason')?.type ?? 'disabled' },
    shuffleRosters: false, startingSeasonFromInput: undefined, teamsFromInput: raw.teams, tid: teamId,
  });
  const importState = audit ? await auditState({ idb, g }, ga.season) : undefined;
  const actions = [];
  // Apply sequentially with the real engine: ownership/cap/AI checked after each move.
  const originalGodMode = g.get('godMode');
  await league.setGameAttributes({ spectator: false, userTids: [teamId], godMode: false });
  for (const [index, action] of plan.actions.entries()) {
    if (g.get('challengeNoTrades')) throw new Error('Trades are disabled by this league’s challenge settings.');
    for (const side of action.teams) {
      if (!(await idb.cache.teams.get(side.tid)) || (await idb.cache.teams.get(side.tid)).disabled) throw new Error(`Inactive trade partner ${side.tid}`);
      for (const pid of side.pids) {
        const player = await idb.cache.players.get(pid);
        if (player?.tid !== side.tid) throw new Error(`Trade ${index + 1}: player ${pid} is not owned by team ${side.tid}`);
        const eligibility = trade.isUntradable(player);
        if (eligibility.untradable) throw new Error(`Trade ${index + 1}, player ${pid}: ${eligibility.untradableMsg}`);
      }
      for (const dpid of side.dpids) {
        if ((await idb.cache.draftPicks.get(dpid))?.tid !== side.tid) throw new Error(`Trade ${index + 1}: pick ${dpid} is not owned by team ${side.tid}`);
      }
    }
    await trade.create(action.teams.map(side => ({ ...side, pidsExcluded: [], dpidsExcluded: [] })));
    const summary = await trade.summary(action.teams);
    if (summary.warning) throw new Error(`Trade ${index + 1}: ${summary.warning}`);
    const result = await trade.propose(false);
    if (!result.accepted) throw new Error(`Trade ${index + 1}: ${result.message ?? 'Rejected by the engine'}`);
    actions.push({ index, type: 'trade', teams: action.teams, message: result.message });
  }
  if (generate) {
    const result = await generateTrades(await import('../.campaign-build/engine.mjs'), teamId, generate, onProgress);
    idb.cache.stopAutoFlush();
    return result;
  }
  await league.setGameAttributes({ spectator: true, userTids: [teamId], godMode: originalGodMode });
  const firstSeason = g.get('season') + (g.get('phase') > PHASE.PLAYOFFS ? 1 : 0);
  if (audit) {
    if (plan.actions.length) throw new Error('Validation requires the no-move baseline');
    await startAutoPlay(firstSeason + audit.seasons, PHASE.PRESEASON, {});
    const endState = await auditState({ idb, g }, ga.season);
    idb.cache.stopAutoFlush();
    return { importState, endState };
  }
  const initialPlayers = await idb.cache.players.getAll();
  const initialRatings = new Map(initialPlayers.map(p => [p.pid, JSON.stringify(p.ratings.at(-1))]));
  const initialRosters = new Map(initialPlayers.map(p => [p.pid, p.tid]));
  const imported = { players: initialPlayers.length, prospects: initialPlayers.filter(p => p.tid === -2).length,
    exportedProspects: raw.players.filter(p => p.tid === -2).length,
    settingsAbsentFromExport: Object.keys(defaultGameAttributes).filter(key => !Object.hasOwn(ga, key)),
    teams: (await idb.cache.teams.getAll()).filter(t => !t.disabled).length };
  if (preflight) { idb.cache.stopAutoFlush(); return { seed, planId: plan.id, firstSeason, actions, imported }; }
  const trainingTeams=collectTraining?(await idb.cache.teams.getAll()).filter(t=>!t.disabled):[];
  const trainingPicks=collectTraining?await idb.cache.draftPicks.getAll():[];
  const trainingFeatures=collectTraining?trainingTeams.map(t=>({tid:t.tid,features:teamFeatures(initialPlayers,trainingPicks,t.tid,featureSettings(g),trainingTeams)})):undefined;
  const years = [];
  const captured = new Set();
  let lastEventId = (await idb.cache.events.getAll()).reduce((max, event) => Math.max(max, event.eid), -1);
  const captureYear = async season => {
    if (season < firstSeason || season >= firstSeason + seasons || captured.has(season)) return;
    captured.add(season);
    const teams = await idb.cache.teamSeasons.indexGetAll('teamSeasonsBySeasonTid', [[season], [season, 'Z']]);
    const rounds = g.get('numGamesPlayoffSeries', season).length;
    const champions = teams.filter(t => t.playoffRoundsWon === rounds);
    if (champions.length !== 1) throw new Error(`Expected one champion in ${season}, found ${champions.length}`);
    const ours = teams.find(t => t.tid === teamId);
    if (!ours) throw new Error(`Team ${teamId} no longer exists in ${season}`);
    const players = await idb.cache.players.getAll();
    const roster = players.filter(p => p.tid === teamId);
    if (roster.some(p => !Number.isFinite(p.ratings.at(-1)?.ovr) || !Number.isFinite(p.contract.amount))) throw new Error(`Non-finite player data in ${season}`);
    const events = await idb.cache.events.getAll();
    const transactions = {};
    for (const event of events.filter(e => e.eid > lastEventId && ['trade', 'freeAgent', 'reSigned', 'draft', 'release', 'retired', 'injured'].includes(e.type))) transactions[event.type] = (transactions[event.type] ?? 0) + 1;
    lastEventId = events.reduce((max, event) => Math.max(max, event.eid), lastEventId);
    years.push({ season, championTid: champions[0].tid, title: champions[0].tid === teamId,
      won: ours.won, lost: ours.lost, playoffRoundsWon: ours.playoffRoundsWon, cash: ours.cash,
      roster: roster.map(p => ({ pid: p.pid, name: `${p.firstName} ${p.lastName}`, age: season - p.born.year,
        ovr: p.ratings.at(-1).ovr, contract: { ...p.contract }, injury: { ...p.injury } })),
      league: { teams: teams.length, players: players.length, transactions,
        developedPlayers: players.filter(p => initialRatings.has(p.pid) && JSON.stringify(p.ratings.at(-1)) !== initialRatings.get(p.pid)).length,
        movedPlayers: players.filter(p => initialRosters.has(p.pid) && p.tid !== initialRosters.get(p.pid)).length } });
    const year = years.at(-1);
    onProgress({ kind: 'seasonComplete', season, championTid: year.championTid, title: year.title, won: year.won, lost: year.lost });
  };
  const notify = globalThis.campaignUI;
  globalThis.campaignUI = async (name, args) => {
    notify(name, args);
    // This UI notification is awaited by upstream phase.finalize, after its DB
    // changes. Observe results without stopping/restarting auto-play at expansion
    // draft boundaries, which can leave a nested phase transition in progress.
    if (name === 'realtimeUpdate' && args[0]?.includes('newPhase') && g.get('phase') >= PHASE.DRAFT_LOTTERY) {
      await captureYear(g.get('season'));
    }
  };
  await startAutoPlay(firstSeason + seasons - 1, PHASE.DRAFT_LOTTERY, {});
  await captureYear(g.get('season'));
  years.sort((a, b) => a.season - b.season);
  if (years.length !== seasons) throw new Error(`Expected ${seasons} completed seasons, observed ${years.length}`);
  await idb.cache.flush();
  idb.cache.stopAutoFlush();
  return { seed, planId: plan.id, firstSeason, titles: years.filter(y => y.title).length, years, actions, imported, ...(collectTraining?{trainingFeatures}: {}) };
}
