import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readLeague } from './input.mjs';
import { compareCampaigns } from './compare.mjs';

const help = `Eight-season comparison runner

npm run campaign -- --league "League json files/LEAGUE.json" --team-id 21 --trials 2

  --plans PATH         JSON array of opening trade plans; baseline is always included
  --seasons N         Horizon 1–8 (default 8); shorter runs are preliminary
  --trials N           Independent eight-season trials per plan (default 10)
  --seed N             Reproducible unsigned 32-bit seed (default 12345)
  --jobs N             Concurrent isolated trials, 1–4 (default 1)
  --timeout-minutes N  Limit per campaign (default 20)
  --out PATH           JSON report (default results/campaign-TIMESTAMP.json)
  --list-teams         Show team names and IDs in the export
  --list-assets        Show your selected team's player/pick IDs for a plan
  --help               Show this message

First-time setup: npm run campaign:setup
Full league exports are required. JSON and JSON.gz are supported.
Ctrl+C cancels active workers and saves completed results.
See campaign/README.md for trade plan format and interpretation.`;

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    ...['league', 'team-id', 'plans', 'trials', 'seed', 'jobs', 'timeout-minutes', 'seasons', 'out'].map(k => [k, { type: 'string' }]),
    ...['help', 'list-teams', 'list-assets'].map(k => [k, { type: 'boolean' }]),
  ]) });
  if (values.help) { console.log(help); return; }
  if (!values.league) throw new Error(`--league is required.\n\n${help}`);
  const { raw, hash } = await readLeague(values.league);
  if (values['list-teams']) {
    if (!raw.teams) throw new Error('No teams in this export. Use a complete league export.');
    for (const team of raw.teams.filter(t => !t.disabled)) console.log(`${team.tid}\t${team.region} ${team.name} (${team.abbrev})`);
    return;
  }
  if (values['team-id'] === undefined) throw new Error('--team-id is required. Use --list-teams to see IDs.');
  if (values['list-assets']) {
    const teamId = Number(values['team-id']);
    const team = raw.teams?.find(t => t.tid === teamId);
    if (!team) throw new Error(`Unknown team ${teamId}`);
    console.log(JSON.stringify({ tid: teamId, name: `${team.region} ${team.name}`,
      players: raw.players.filter(p => p.tid === teamId).map(p => ({ pid: p.pid, name: `${p.firstName} ${p.lastName}`,
        ovr: p.ratings.at(-1)?.ovr, contract: p.contract, gamesUntilTradable: p.gamesUntilTradable })),
      picks: raw.draftPicks?.filter(p => p.tid === teamId) ?? [],
    }, null, 2));
    return;
  }
  const out = resolve(values.out ?? `results/campaign-${Date.now()}.json`);
  if (out === resolve(values.league) || values.plans && out === resolve(values.plans)) throw new Error('Output must not overwrite the league or plans file.');
  const plans = values.plans ? JSON.parse(await readFile(values.plans, 'utf8')) : [];
  const controller = new AbortController();
  const cancel = () => { console.error('\nCancelling; saving completed results...'); controller.abort(new Error('Cancelled by user')); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  await mkdir(dirname(out), { recursive: true });
  let lastProgress = 0;
  const started = Date.now();
  try {
    const report = await compareCampaigns({ raw, inputHash: hash, teamId: Number(values['team-id']), plans,
      seasons: Number(values.seasons ?? 8), trials: Number(values.trials ?? 10), seed: Number(values.seed ?? 12345), jobs: Number(values.jobs ?? 1),
      timeoutMs: Number(values['timeout-minutes'] ?? 20) * 60000, signal: controller.signal,
      onProgress(event) {
        const now = Date.now();
        if (['campaign', 'preflight', 'seasonComplete', 'failure'].includes(event.kind) || now - lastProgress > 10000) {
          const trial = event.trial == null ? 'check' : `trial ${event.trial + 1}`;
          const detail = event.kind === 'seasonComplete' ? `${event.season}: ${event.won}–${event.lost}, ${event.title ? 'champion' : `champion tid ${event.championTid}`}` : event.message ?? event.text ?? event.kind;
          console.error(`[${Math.round((now - started) / 1000)}s] ${event.planId}, ${trial}: ${detail}`);
          lastProgress = now;
        }
      },
      async onCheckpoint(report) {
        const temp = `${out}.tmp`;
        await writeFile(temp, JSON.stringify(report, null, 2) + '\n');
        await rename(temp, out);
      },
    });
    console.log(`\n${report.input.teamName}: ${report.input.firstSeason}–${report.input.firstSeason + report.seasons - 1}`);
    console.log(`${report.completedTrials}/${report.requestedTrials} complete paired trials · ${report.status}`);
    const number = n => n === null ? '—' : n.toFixed(3);
    for (const row of report.summary) {
      console.log(`${row.name}: ${number(row.expectedTitles.mean)} expected titles; Δ ${number(row.deltaFromBaseline.mean)}; 95% title interval [${row.expectedTitles.interval95.map(number).join(', ')}]`);
    }
    if (report.error) console.error(`${report.error.planId}: ${report.error.message}`);
    if (report.warning) console.error(report.warning);
    console.log(`Report: ${out}`);
    if (report.seasons < 8) console.log('PRELIMINARY short-horizon results; not eight-year championship estimates.');
    console.log('Future policy: BBGM AI. Small runs are smoke tests; intervals cover sampling uncertainty only.');
    if (report.status !== 'complete') process.exitCode = report.status === 'cancelled' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
