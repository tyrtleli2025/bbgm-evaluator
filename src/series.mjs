import { readFileSync } from 'node:fs';
import { prepareTeam, simulate } from './adapter.mjs';
import { scheduleSeed, validateGame } from './evaluator.mjs';

const manifest = JSON.parse(readFileSync(new URL('../vendor/zengm/manifest.json', import.meta.url)));
// Games 1, 2, 5 and 7 are hosted by the team with home-court advantage.
export const HOME_COURT_SCHEDULE = [true, true, false, false, true, false, true];

export function wilsonInterval(wins, trials) {
  const p = wins / trials, z2 = 1.96 ** 2;
  const center = (p + z2 / (2 * trials)) / (1 + z2 / trials);
  const radius = 1.96 * Math.sqrt(p * (1 - p) / trials + z2 / (4 * trials ** 2)) / (1 + z2 / trials);
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

export function evaluateSeries(league, {
  teamId, opponentId, homeCourt = teamId, series = 1000,
  health = 'current', seed = 12345, onProgress,
} = {}) {
  for (const id of [teamId, opponentId]) {
    if (!Number.isInteger(id) || !league.teams.has(id)) throw new Error(`Unknown team ID ${id}`);
  }
  if (teamId === opponentId) throw new Error('Select two different teams');
  if (![teamId, opponentId].includes(homeCourt)) throw new Error('home-court must be one of the selected team IDs');
  if (!Number.isInteger(series) || series < 1) throw new Error('series must be a positive integer');
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be a safe integer');
  if (!['current', 'healthy'].includes(health)) throw new Error('health must be current or healthy');
  if (league.settings.maxOvertimesPlayoffs !== null) {
    throw new Error('Series mode requires unlimited playoff overtimes (maxOvertimesPlayoffs: null) so every game has a winner');
  }
  const ids = [teamId, opponentId];
  const other = ids.find(id => id !== homeCourt);
  const homeSchedule = HOME_COURT_SCHEDULE.map(home => home ? homeCourt : other);
  const templates = new Map(ids.map(id => [id, prepareTeam(id, league.teams.get(id), league.settings, { phase: 'playoffs', health })]));
  const neutral = league.settings.neutralSite === 'playoffs';
  const wins = [0, 0], gameWins = [0, 0];
  const outcomes = ids.flatMap(winner => [0, 1, 2, 3].map(loserWins => ({ winner, loser: ids.find(id => id !== winner), winnerWins: 4, loserWins, count: 0 })));
  let simulatedGames = 0;
  const sampleSeries = [];
  for (let trial = 0; trial < series; trial++) {
    const score = [0, 0];
    for (let gameNumber = 0; gameNumber < 7; gameNumber++) {
      const home = homeSchedule[gameNumber], away = ids.find(id => id !== home);
      const result = simulate(templates.get(home), templates.get(away), league.settings, {
        seed: scheduleSeed(`series:${seed}`, Math.min(...ids), Math.max(...ids), trial * 7 + gameNumber),
        phase: 'playoffs', neutral,
      });
      validateGame(result, league.settings, 'playoffs');
      const [h, a] = result.team;
      if (h.stat.pts === a.stat.pts) throw new Error('A series game unexpectedly ended in a tie');
      const winner = h.stat.pts > a.stat.pts ? home : away;
      const winnerIndex = ids.indexOf(winner);
      score[winnerIndex]++;
      gameWins[winnerIndex]++;
      simulatedGames++;
      if (trial === 0) sampleSeries.push({ game: gameNumber + 1, home, away, homePoints: h.stat.pts, awayPoints: a.stat.pts, winner });
      if (score[winnerIndex] === 4) {
        wins[winnerIndex]++;
        outcomes.find(o => o.winner === winner && o.loserWins === score[1 - winnerIndex]).count++;
        break;
      }
    }
    onProgress?.({ simulatedGames, completedSeries: trial + 1 });
  }
  return {
    model: 'pinned-engine-best-of-seven-v1', engineRevision: manifest.revision,
    engineSourceHashes: manifest.files, inputSha256: league.inputHash,
    exportSchemaVersion: league.schemaVersion, nodeVersion: process.version,
    phase: 'playoffs', health, seed, series, simulatedGames, bestOf: 7,
    homeCourt, homeSchedule, neutralSite: neutral, meanSeriesLength: simulatedGames / series,
    settings: league.settings, engineOverrides: { phase: 3, injuryRate: 0, homeCourtFactor: 1, neutralSite: neutral },
    teams: ids.map((tid, i) => ({ tid,
      players: league.teams.get(tid).slice(0, 5).map(p => `${p.firstName} ${p.lastName}`),
      seriesWins: wins[i], seriesWinProbability: wins[i] / series,
      seriesWinConfidence95: wilsonInterval(wins[i], series), gameWins: gameWins[i],
    })),
    outcomes: outcomes.map(o => ({ ...o, probability: o.count / series })), sampleSeries,
    warnings: [...league.warnings,
      'Best-of-seven, first to four wins, using a 2-2-1-1-1 venue schedule.',
      'Availability and ratings reset before every game; existing injuries do not heal during a series.',
      ...(neutral ? ['League settings require neutral playoff games; home-court advantage is disabled.'] : []),
      ...(league.settings.neutralSite === 'finals' ? ['This is a generic playoff series, not a finals series; finals-only neutral venues do not apply.'] : []),
    ],
  };
}
