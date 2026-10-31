import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

export function smallLeague() {
  const base = JSON.parse(gunzipSync(readFileSync(new URL('../../test/fixtures/league.json.gz', import.meta.url))));
  const season = 2006;
  const players = [];
  const template = base.players.filter(p => p.tid >= 0);
  const add = (tid, index, year = season) => {
    const p = structuredClone(template[index % template.length]);
    p.pid = players.length;
    p.tid = tid;
    p.firstName = 'Test'; p.lastName = `Player${p.pid}`;
    p.born = { year: tid === -2 ? year - 19 : season - 24, loc: 'USA' };
    p.ratings = [{ ...p.ratings.at(-1), season, fuzz: 0 }];
    p.contract = { amount: 1000, exp: season + (p.pid % 3) };
    p.injury = { type: 'Healthy', gamesRemaining: 0 };
    p.gamesUntilTradable = 0;
    p.stats = []; p.awards = []; p.salaries = []; p.transactions = [];
    p.draft = { year: tid === -2 ? year : season - 4, tid: -1, originalTid: -1, round: 0, pick: 0, pot: 60, ovr: 40, skills: [] };
    delete p.srID;
    players.push(p);
  };
  for (let tid = 0; tid < 4; tid++) for (let i = 0; i < 10; i++) add(tid, tid * 10 + i);
  for (let i = 0; i < 30; i++) add(-1, i + 40);
  for (let year = season; year < season + 3; year++) for (let i = 0; i < 20; i++) add(-2, i + 70, year);
  return {
    version: 74, players, releasedPlayers: [], scheduledEvents: [],
    draftPicks: Array.from({ length: 24 }, (_, dpid) => ({ dpid, tid: dpid % 4, originalTid: dpid % 4, round: dpid % 8 < 4 ? 1 : 2, season: season + Math.floor(dpid / 8) })),
    teams: Array.from({ length: 4 }, (_, tid) => ({ tid, cid: tid % 2, did: tid % 2,
      region: 'Test', name: `Team ${tid}`, abbrev: `T${tid}`, pop: 2, strategy: 'contending',
      budget: { scouting: 34, coaching: 34, facilities: 34, health: 34, ticketPrice: 30 },
      playThroughInjuries: [0, 4], seasons: [{ season, cash: 10000, won: 0, lost: 0, hype: 0.5 }], stats: [] })),
    gameAttributes: { season, startingSeason: season, phase: 0, userTid: 0, userTids: [0],
      confs: [{ cid: 0, name: 'East' }, { cid: 1, name: 'West' }],
      divs: [{ did: 0, cid: 0, name: 'East' }, { did: 1, cid: 1, name: 'West' }],
      numGames: 6, numGamesConf: null, numGamesDiv: null, numGamesPlayoffSeries: [1, 1], numPlayoffByes: 0,
      playIn: false, salaryCap: 90000, salaryCapType: 'soft', minContract: 500, maxContract: 30000,
      minRosterSize: 8, maxRosterSize: 16, difficulty: 0, draftType: 'noLottery',
      aiTradesFactor: 1, injuryRate: 0.001, allStarGame: null, allStarDunk: false, allStarThree: false,
      autoExpandProb: 0, autoRelocateProb: 0, realPlayerDeterminism: 0 },
  };
}
