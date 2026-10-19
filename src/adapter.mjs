import GameSim from '../.engine/worker/core/GameSim.basketball/index.js';
import { COMPOSITE_WEIGHTS, PHASE, DEFAULT_PLAY_THROUGH_INJURIES } from '../.engine/common/constants.js';
import compositeRating from '../.engine/worker/core/player/compositeRating.js';
import injuryFactor from '../.engine/common/playThroughInjuriesFactor.js';
import playerStats from '../.engine/worker/core/player/stats.basketball.js';
import teamStats from '../.engine/worker/core/team/stats.basketball.js';
import { makeSeededRandom } from '../.engine/common/random.js';
import { configureEngine } from './engine-runtime.mjs';

const zeros = keys => Object.fromEntries(keys.filter(k => !k.startsWith('opp') && k !== 'minAvailable').map(k => [k, 0]));

// Basketball portion of upstream loadTeams.processTeam, without IndexedDB,
// scouting/display OVR, or team-season metadata (none affect these games).
export function prepareTeam(tid, roster, settings, { phase = 'regular', health = 'current' } = {}) {
  const threshold = DEFAULT_PLAY_THROUGH_INJURIES[phase === 'playoffs' ? 1 : 0];
  const player = roster.map(p => {
    const remaining = health === 'healthy' ? 0 : p.injury.gamesRemaining;
    const factor = injuryFactor(remaining);
    const composite = Object.fromEntries(Object.entries(COMPOSITE_WEIGHTS).map(([key, w]) =>
      [key, compositeRating(p.rating, w.ratings, w.weights, false) * factor]));
    composite.usage **= 1.9;
    return {
      id: p.pid, name: `${p.firstName} ${p.lastName}`, age: settings.season - p.born.year,
      pos: p.rating.pos, valueNoPot: p.valueNoPot * factor, skills: p.rating.skills ?? [],
      injury: { ...p.injury, gamesRemaining: remaining, playingThrough: remaining > 0 && remaining <= threshold },
      injured: remaining > threshold, newInjury: false, ptModifier: p.ptModifier,
      compositeRating: composite, stat: { ...zeros(playerStats.raw), courtTime: -3, benchTime: 0, energy: 1 },
    };
  });
  const available = player.filter(p => !p.injured);
  if (available.length < settings.numPlayersOnCourt) throw new Error(`Team ${tid}: fewer than ${settings.numPlayersOnCourt} available players (${phase}/${health})`);
  const pacePlayers = available.slice(0, 7);
  return {
    id: tid, pace: 100 + 15 * pacePlayers.reduce((s,p) => s + p.compositeRating.pace, 0) / pacePlayers.length,
    player, stat: { ...zeros(teamStats.raw), ba: 0, pts: 0, ptsQtrs: [0] },
    synergy: { off: 0, def: 0, reb: 0 },
    compositeRating: Object.fromEntries(Object.keys(COMPOSITE_WEIGHTS).map(k => [k, 0])),
  };
}

export function simulate(home, away, settings, { seed, phase = 'regular', neutral = false, trackSynergy = true } = {}) {
  configureEngine({ ...settings, phase: phase === 'playoffs' ? PHASE.PLAYOFFS : PHASE.REGULAR_SEASON,
    shootoutRoundsPlayoffs: settings.shootoutRoundsPlayoffs ?? settings.shootoutRounds,
    overtimeLengthPlayoffs: settings.overtimeLengthPlayoffs ?? null,
    userTid: -999, injuryRate: 0 });
  const oldRandom = Math.random;
  // Engine is synchronous. Restore the global RNG even if it throws; do not run
  // simultaneous games in this JS isolate. Separate workers can be added later.
  Math.random = makeSeededRandom(seed);
  try {
    const sim = new GameSim({ gid: seed, teams: structuredClone([home, away]), doPlayByPlay: false,
      homeCourtFactor: 1, allStarGame: false, baseInjuryRate: 0, neutralSite: neutral });
    if (!trackSynergy) return sim.run();
    // Observe the same lineup/time intervals used by upstream minute accounting.
    // No extra random draws and no changes to the engine's ratings or decisions.
    const totals = [0,1].map(() => ({ seconds: 0, off: 0, def: 0, reb: 0,
      skills: Object.fromEntries(['3','A','B','Di','Dp','Po','Ps','R'].map(k => [k,0])) }));
    const updatePlayingTime = sim.updatePlayingTime;
    sim.updatePlayingTime = function(seconds) {
      for (const t of [0,1]) {
        const sum = totals[t];
        sum.seconds += seconds;
        for (const key of ['off','def','reb']) sum[key] += this.team[t].synergy[key] * seconds;
        for (const p of this.playersOnCourt[t]) {
          const skills = this.skillsCountCache.get(p);
          if (!skills) throw new Error('Missing engine lineup skill cache');
          for (const key of Object.keys(sum.skills)) sum.skills[key] += skills[key] * seconds;
        }
      }
      return updatePlayingTime.call(this, seconds);
    };
    const result = sim.run();
    for (const t of [0,1]) {
      const sum = totals[t];
      if (!(sum.seconds > 0)) throw new Error('Missing synergy observation time');
      result.team[t].synergyAverage = {
        seconds: sum.seconds,
        raw: Object.fromEntries(['off','def','reb'].map(k => [k,sum[k]/sum.seconds])),
        fractionalSkills: Object.fromEntries(Object.entries(sum.skills).map(([k,v]) => [k,v/sum.seconds])),
      };
    }
    return result;
  } finally { Math.random = oldRandom; }
}
