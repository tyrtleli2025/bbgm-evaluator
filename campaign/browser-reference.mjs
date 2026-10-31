import { auditState } from './audit-state.mjs';
// Independent browser driver: native DB, native import, one native auto-play call.
// Does not import the Node campaign runtime or its result-collection hook.
export async function reference({ raw, teamId, seed, seasons }) {
  const { makeSeededRandom } = await import('/random.mjs');
  Math.random = makeSeededRandom(seed);
  const engine = await import('/browser.mjs');
  const { g, idb, createStream, startAutoPlay, league, PHASE } = engine;
  globalThis.campaignUI = (name, args) => {
    if (name === 'showNotification' && args[0]?.type === 'error') throw new Error(args[0].text);
  };
  const ga = raw.gameAttributes;
  const unwrap = value => Array.isArray(value) && value[0]?.start !== undefined
    ? value.filter(row => row.start === null || row.start <= ga.season).at(-1).value : value;
  await createStream(raw, {
    conditions: {}, confs: unwrap(ga.confs), divs: unwrap(ga.divs),
    fromFile: { gameAttributes: ga, teams: raw.teams, version: raw.version,
      startingSeason: raw.startingSeason ?? ga.startingSeason ?? ga.season,
      hasRookieContracts: raw.players.some(p => p.contract?.rookie),
      maxGid: (raw.games ?? []).reduce((v, game) => Math.max(v, game.gid), -1) },
    keptKeys: new Set(Object.keys(raw)), lid: 1, name: 'Browser validation reference',
    setLeagueCreationStatus: () => {}, settings: { noStartingInjuries: false, randomization: 'none', repeatSeason: 'disabled' },
    shuffleRosters: false, teamsFromInput: raw.teams, tid: teamId,
  });
  const importState = await auditState(engine, ga.season);
  await league.setGameAttributes({ spectator: true, userTids: [teamId] });
  const firstSeason = g.get('season') + (g.get('phase') > PHASE.PLAYOFFS ? 1 : 0);
  await startAutoPlay(firstSeason + seasons, PHASE.PRESEASON, {});
  const endState = await auditState(engine, ga.season);
  idb.cache.stopAutoFlush();
  return { importState, endState };
}
