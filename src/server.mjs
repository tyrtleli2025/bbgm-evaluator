import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { normalizeLeague } from './importer.mjs';
import { normalizeTradeScenario, previewBaselineKey, tradeAssessment } from './trade-preview.mjs';
import { normalizeSeriesInjuries, prepareSeriesTeams, normalizeSeriesScore } from './series.mjs';

const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_JSON = 256 * 1024 * 1024;
const phaseNames = ['Preseason', 'Regular season', 'After trade deadline', 'Playoffs',
  'Draft lottery', 'Draft', 'After draft', 'Re-sign players', 'Free agency'];
const assets = new Map([
  ['/', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['../web/app.js', 'text/javascript; charset=utf-8']],
  ['/trade-builder.js', ['../web/trade-builder.js', 'text/javascript; charset=utf-8']],
  ['/playoff-series.js', ['../web/playoff-series.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['../web/styles.css', 'text/css; charset=utf-8']],
  ['/collect-proposals.js', ['../scripts/collect-proposals.js', 'text/javascript; charset=utf-8']],
  ['/collect-snapshot.js', ['../scripts/collect-snapshot.js', 'text/javascript; charset=utf-8']],
]);

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function integer(value, fallback, min, max, label) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw fail(`${label} must be an integer from ${min} to ${max}`);
  return number;
}
async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw fail('Upload is too large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('Upload is too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function importSnapshot(bytes, filename = 'league.json') {
  let decoded;
  try {
    const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_JSON }) : bytes;
    decoded = JSON.parse(json.toString('utf8'));
  } catch { throw fail('Could not read this file. Choose a valid BBGM .json or .json.gz export.'); }
  const bundle = decoded?.format === 'bbgm-proposals-v1' ? decoded : null;
  const raw = bundle ? bundle.league : decoded;
  const inputHash = createHash('sha256').update(bytes).digest('hex');
  const league = normalizeLeague(raw, inputHash);
  const metadata = new Map((Array.isArray(raw.teams) ? raw.teams : []).map(t => [t.tid, t]));
  const teams = [...league.teams].map(([tid, roster]) => {
    const team = metadata.get(tid);
    const identity = league.teamNames.get(tid);
    return { tid, name:identity.name, region:identity.region, abbrev:identity.abbrev,
      strategy: team?.strategy ?? null,
      picks: (raw.draftPicks ?? []).filter(p=>p.tid===tid).map(p=>({dpid:p.dpid,season:p.season,round:p.round,
        originalTid:p.originalTid,desc:p.desc??`${p.season} round ${p.round} (team ${p.originalTid})`})),
      players: roster.map(p => ({ pid: p.pid, name: `${p.firstName} ${p.lastName}`, pos: p.rating.pos,
        age: league.settings.season - p.born.year, ovr: p.rating.ovr ?? null, pot: p.rating.pot ?? null,
        salary: p.contract?.amount ?? null, valueNoPot: p.valueNoPot,
        contractExp:p.contract?.exp ?? null, gamesUntilTradable:p.gamesUntilTradable ?? null,
        skills: p.rating.skills ?? [], injury: p.injury })),
    };
  });
  const phase = Number.isInteger(league.settings.phase) ? league.settings.phase : null;
  const candidateTeamId = bundle?.context?.userTid ?? league.settings.userTid;
  const teamId = league.teams.has(candidateTeamId) ? candidateTeamId : teams[0].tid;
  return { league, bundle, baselines:new Map(), previews:new Map(), summary: { filename, season: league.settings.season, teamId, teams,
    warnings: league.warnings, hasProposals: !!bundle,
    tradeContext: { phase, phaseLabel: phase === null ? 'Not included in export' : phaseNames[phase] ?? `Phase ${phase}`,
      hasDraftPicks: Array.isArray(raw.draftPicks),
      hasTeamStrategies: teams.every(t => ['contending', 'rebuilding'].includes(metadata.get(t.tid)?.strategy)),
      hasDifficulty: Number.isFinite(league.settings.difficulty),
      difficulty:league.settings.difficulty ?? null, userTid:league.settings.userTid ?? null,
      salaryCap:league.settings.salaryCap ?? null, salaryCapType:league.settings.salaryCapType ?? null,
    } } };
}

export function validateJobOptions(league, type, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Invalid job options');
  const options = {
    teamId: integer(input.teamId, undefined, 0, Number.MAX_SAFE_INTEGER, 'Team ID'),
    phase: input.phase ?? 'regular', health: input.health ?? 'current',
    seed: integer(input.seed, 12345, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'Seed'),
    gamesPerOpponent: integer(input.gamesPerOpponent, 20, 4, 100, 'Games per opponent'),
  };
  if (!league.teams.has(options.teamId)) throw fail('Selected team is not in this league');
  if (!['regular', 'playoffs'].includes(options.phase)) throw fail('Select regular-season or playoff evaluation');
  if (!['current', 'healthy'].includes(options.health)) throw fail('Select current or healthy availability');
  if (options.gamesPerOpponent % 2) throw fail('Games per opponent must be even');
  if (type === 'series') {
    options.currentScore = normalizeSeriesScore(input.currentScore);
    options.phase = 'playoffs';
    options.opponentId = integer(input.opponentId, undefined, 0, Number.MAX_SAFE_INTEGER, 'Opponent ID');
    if (!league.teams.has(options.opponentId)) throw fail('Selected opponent is not in this league');
    if (options.opponentId === options.teamId) throw fail('Select two different teams');
    options.homeCourt = integer(input.homeCourt, options.teamId, 0, Number.MAX_SAFE_INTEGER, 'Home-court team');
    if (![options.teamId, options.opponentId].includes(options.homeCourt)) throw fail('Home-court advantage must belong to one of the selected teams');
    options.series = integer(input.series, 200, 1, 2000, 'Series count');
    if (league.settings.maxOvertimesPlayoffs !== null) throw fail('Series mode requires unlimited playoff overtimes');
    options.injuries = normalizeSeriesInjuries(league, options.teamId, options.opponentId, input.injuries);
    prepareSeriesTeams(league, options); // Reject impossible lineups before cancelling a running job.
  }
  if (type === 'search') {
    Object.assign(options, {
      iterations: integer(input.iterations, 500, 1, 5000, 'Candidate budget'),
      maxDepth: integer(input.maxDepth, 2, 1, 5, 'Maximum trades'),
      beamWidth: integer(input.beamWidth, 6, 1, 24, 'Beam width'),
      finalists: integer(input.finalists, 3, 1, 10, 'Finalists'),
      feasibility: input.feasibility ?? 'explore',
    });
    if (!['explore', 'verified'].includes(options.feasibility)) throw fail('Invalid feasibility mode');
    if (input.tradePhase !== undefined && input.tradePhase !== null && input.tradePhase !== '') {
      options.tradePhase = integer(input.tradePhase, undefined, 0, 8, 'League trade phase');
    }
  } else if (type === 'proposals') {
    options.proposalLimit = integer(input.proposalLimit, 20, 1, 40, 'Proposal limit');
  }
  if (['trade','trade-check','make-work'].includes(type)) {
    options.scenario = normalizeTradeScenario(league,input.scenario,options.teamId);
    if (input.tradePhase !== undefined && input.tradePhase !== null && input.tradePhase !== '') {
      options.tradePhase = integer(input.tradePhase,undefined,0,8,'Trading phase');
    }
    if (input.difficulty !== undefined && input.difficulty !== null && input.difficulty !== '') {
      if (typeof input.difficulty!=='number' || !Number.isFinite(input.difficulty) || input.difficulty < -100 || input.difficulty > 100) throw fail('Invalid difficulty assumption');
      options.difficulty = input.difficulty;
    }
    if (input.strategies !== undefined) {
      if (!input.strategies || typeof input.strategies!=='object' || Array.isArray(input.strategies)) throw fail('Invalid strategy assumptions');
      options.strategies = {};
      for (const [tid,strategy] of Object.entries(input.strategies)) {
        if (!options.scenario.teams.some(t=>String(t.tid)===tid) || !['contending','rebuilding'].includes(strategy)) throw fail('Invalid strategy assumption');
        options.strategies[tid] = strategy;
      }
    }
    if (input.excluded !== undefined) {
      if (!input.excluded || typeof input.excluded!=='object' || Array.isArray(input.excluded)) throw fail('Invalid protected-player list');
      options.excluded = {};
      for (const [tid,ids] of Object.entries(input.excluded)) {
        if (!options.scenario.teams.some(t=>String(t.tid)===tid) || !Array.isArray(ids) || ids.some(pid=>!Number.isInteger(pid)||!league.teams.get(Number(tid)).some(p=>p.pid===pid))) throw fail('Invalid protected player');
        options.excluded[tid] = [...new Set(ids)].sort((a,b)=>a-b);
      }
    }
  }
  return options;
}

export function createApp({ maxJobMs = 5 * 60 * 1000 } = {}) {
  const sessions = new Map(), jobs = new Map();
  function send(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(data));
  }
  function stop(job, status, error) {
    if (job.status !== 'running') return;
    job.status = status;
    if (error) job.error = error;
    clearTimeout(job.timeout);
    job.worker?.terminate();
    job.worker = undefined;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // Local files and simulations are available only to a page on this server.
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw fail('Use the local server address', 403);
      if (request.headers.origin && request.headers.origin !== `http://${host}`) throw fail('Cross-origin requests are not allowed', 403);
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true });
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [path, contentType] = assets.get(url.pathname);
        const content = await readFile(new URL(path, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(content);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/import') {
        const bytes = await readBody(request, MAX_UPLOAD);
        let filename = request.headers['x-filename'] ?? 'league.json';
        try { filename = decodeURIComponent(filename); } catch { /* plain filename */ }
        const session = importSnapshot(bytes, String(filename).slice(0, 250));
        const sessionId = randomUUID();
        sessions.set(sessionId, session);
        while (sessions.size > 3) sessions.delete(sessions.keys().next().value);
        return send(response, 200, { sessionId, ...session.summary });
      }
      if (request.method === 'POST' && url.pathname === '/api/trade-check') {
        let body;
        try { body = JSON.parse((await readBody(request,16384)).toString()); }
        catch (error) { if(error.status) throw error; throw fail('Expected a JSON request'); }
        const session = sessions.get(body?.sessionId);
        if (!session) throw fail('Import a league first; this session has expired',404);
        const options = validateJobOptions(session.league,'trade-check',body.options);
        return send(response,200,{scenario:options.scenario,assessment:tradeAssessment(session.league,options.scenario,options)});
      }
      if (request.method === 'POST' && url.pathname === '/api/jobs') {
        let body;
        try { body = JSON.parse((await readBody(request, 16384)).toString()); }
        catch (error) { if (error.status) throw error; throw fail('Expected a JSON request'); }
        if (!body || !['evaluate', 'search', 'proposals','trade','make-work','series'].includes(body.type)) throw fail('Unknown job type');
        const session = sessions.get(body.sessionId);
        if (!session) throw fail('Import a league first; this session has expired', 404);
        if (body.type === 'proposals' && !session.bundle) throw fail('Import a collected proposal bundle first');
        const options = validateJobOptions(session.league, body.type, body.options);
        const running = [...jobs.values()].filter(job=>job.status==='running');
        for (const job of running) {
          if (body.replace === true && job.sessionId===body.sessionId &&
            (['trade','make-work'].includes(body.type) && ['trade','make-work'].includes(job.type) || body.type==='series' && job.type==='series')) stop(job,'cancelled');
          else throw fail('A job is already running. Cancel it or wait for it to finish.',409);
        }
        const jobId = randomUUID();
        const cacheKey = ['trade','series'].includes(body.type) ? `${body.type}:${JSON.stringify(options)}` : null;
        const cachedResult = cacheKey ? session.previews.get(cacheKey) : null;
        const job = { status: 'running', progress: { stage: 'Starting', completed: 0 }, startedAt: Date.now(),sessionId:body.sessionId,type:body.type };
        if (cachedResult) {
          Object.assign(job,{status:'complete',result:{...cachedResult,resultReused:true,elapsedSeconds:0}});
          jobs.set(jobId,job);
          while (jobs.size>20) jobs.delete(jobs.keys().next().value);
          return send(response,202,{jobId});
        }
        const worker = new Worker(new URL('./web-worker.mjs', import.meta.url), {
          workerData: { league: session.league, bundle: body.type === 'proposals' ? session.bundle : null, type: body.type, options,
            baselineCache:body.type==='trade'?session.baselines.get(previewBaselineKey(session.league,options)):undefined },
          resourceLimits: { maxOldGenerationSizeMb: 768 },
        });
        job.worker = worker;
        job.timeout = setTimeout(() => stop(job, 'failed', 'This run reached the five-minute limit. Reduce the search or simulation budget.'), maxJobMs);
        worker.on('message', message => {
          if (job.status !== 'running') return;
          if (message.type === 'progress') job.progress = message.progress;
          else if (message.type === 'baseline') {
            session.baselines.set(message.cache.key,message.cache);
            while(session.baselines.size>6) session.baselines.delete(session.baselines.keys().next().value);
          } else if (message.type === 'result') {
            job.result = message.result;
            if (cacheKey) {
              session.previews.set(cacheKey,job.result);
              while(session.previews.size>12) session.previews.delete(session.previews.keys().next().value);
            }
            stop(job, 'complete');
          }
          else if (message.type === 'error') stop(job, 'failed', message.error);
        });
        worker.on('error', error => stop(job, 'failed', error.message));
        worker.on('exit', code => { if (job.status === 'running') stop(job, 'failed', `Evaluation worker exited unexpectedly (${code})`); });
        jobs.set(jobId, job);
        while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
        return send(response, 202, { jobId });
      }
      const match = /^\/api\/jobs\/([a-z0-9-]+)$/.exec(url.pathname);
      if (match && ['GET', 'DELETE'].includes(request.method)) {
        const job = jobs.get(match[1]);
        if (!job) throw fail('Job not found', 404);
        if (request.method === 'DELETE') stop(job, 'cancelled');
        return send(response, 200, { status: job.status, progress: job.progress, result: job.result, error: job.error });
      }
      throw fail('Not found', 404);
    } catch (error) {
      if (!response.headersSent) send(response, error.status ?? 400, { error: error.message });
      else response.end();
    }
  });
  server.on('close', () => { for (const job of jobs.values()) stop(job, 'cancelled'); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const server = createApp();
  server.on('error', error => { console.error(`Could not start BBGM Solver: ${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`BBGM Solver is running at http://127.0.0.1:${port}\nImports stay in local memory. Press Ctrl+C to stop.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(); server.closeAllConnections();
  });
}
