import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { root, verifyBuild } from './provenance.mjs';
import { readLeague, validateLeague, sha256 } from './input.mjs';
import { runIsolated } from './compare.mjs';
import { differences, importPreservation, numericTolerance } from './audit-state.mjs';
import { smallLeague } from './test/fixture.mjs';

export async function validateCampaign({ raw, teamId, seed = 71, seasons = 1, executablePath, timeoutMs = 20 * 60_000, onProgress = console.error }) {
  const input = validateLeague(raw, teamId);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(seasons) || seasons < 1 || seasons > 8) throw new Error('Use a uint32 seed and 1–8 seasons.');
  const engine = await verifyBuild();
  const routes = new Map([
    ['/browser.mjs', '.campaign-build/browser.mjs'], ['/random.mjs', '.campaign-build/random.mjs'],
    ['/reference.mjs', 'campaign/browser-reference.mjs'], ['/audit-state.mjs', 'campaign/audit-state.mjs'],
    ...['names.json', 'names-female.json', 'real-player-data.basketball.json', 'real-player-stats.basketball.json'].map(name => [`/${name}`, `.campaign-engine/data/${name}`]),
  ]);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated BBGM validation</title>'); return; }
      if (!routes.has(req.url)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', req.url.endsWith('.json') ? 'application/json' : 'text/javascript');
      res.end(await readFile(resolve(root, routes.get(req.url))));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Validation cancelled'));
  process.once('SIGINT', cancel);
  let browser;
  let pending;
  const started = Date.now();
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    if (!executablePath && process.platform === 'darwin') {
      const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      try { await access(chrome); executablePath = chrome; } catch { /* Use Playwright Chromium */ }
    }
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage(); // Fresh, disposable profile and native IndexedDB.
    page.setDefaultTimeout(timeoutMs);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const browserVersion = browser.version();
    onProgress('Comparing Node and browser import, then season/offseason advancement...');
    const timer = setTimeout(cancel, timeoutMs);
    const abortBrowser = () => void browser.close();
    controller.signal.addEventListener('abort', abortBrowser, { once: true });
    const nodeTask = runIsolated({ raw, teamId, seed, plan: { id: 'baseline', actions: [] }, audit: { seasons } },
      { signal: controller.signal, timeoutMs, onProgress: p => { if (p.kind === 'phase') onProgress(p.text); } });
    const browserTask = page.evaluate(async data => (await import('/reference.mjs')).reference(data), { raw, teamId, seed, seasons });
    pending = Promise.allSettled([nodeTask, browserTask]);
    const results = await pending;
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abortBrowser);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const [node, reference] = results.map(result => result.value);
    if (node.endState.season !== input.firstSeason + seasons || node.endState.phase !== 0) throw new Error('Advancement did not reach the requested preseason.');
    const checkpoints = ['importState', 'endState'].map(name => {
      const mismatches = differences(node[name], reference[name]);
      return { name, passed: mismatches.length === 0, nodeSha256: sha256(JSON.stringify(node[name])),
        browserSha256: sha256(JSON.stringify(reference[name])), differences: mismatches,
        stores: Object.keys(node[name].stores).map(store => ({ name: store,
          nodeRows: node[name].stores[store].length, browserRows: reference[name].stores[store].length,
          passed: differences(node[name].stores[store], reference[name].stores[store], 1).length === 0 })) };
    });
    const preservation = importPreservation(raw, node.importState);
    return { status: checkpoints.every(c => c.passed) && preservation.passed ? 'passed' : 'failed', engine, browserVersion,
      input: { ...input, sha256: sha256(JSON.stringify(raw)) }, seed, seasons,
      target: { season: node.endState.season, phase: node.endState.phase }, preservation, checkpoints,
      comparison: { numericTolerance, rule: 'Integer pairs exact; other numbers allow 32 * Number.EPSILON * max(1, abs(a), abs(b)). Hashes remain exact.' },
      elapsedSeconds: (Date.now() - started) / 1000,
      scope: 'Pinned engine in native browser IndexedDB versus the Node runner in in-memory IndexedDB. Independent drivers share the compiler, UI shim and read-only snapshot projection. This does not establish equivalence with another live game build or validate unobserved fields.' };
  } finally {
    controller.abort(new Error('Validation finished'));
    await browser?.close();
    await pending;
    server.closeAllConnections();
    await new Promise(accept => server.close(accept));
    process.removeListener('SIGINT', cancel);
  }
}

async function main() {
  const { values } = parseArgs({ options: { league: { type: 'string' }, 'team-id': { type: 'string' }, seed: { type: 'string' }, seasons: { type: 'string' }, out: { type: 'string' }, browser: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('npm run campaign:validate -- [--league PATH --team-id ID] [--seasons 1] [--seed 71] [--browser EXECUTABLE] [--out PATH]\nWithout a league, uses a small controlled test league. Requires a local campaign build and Chrome or Playwright Chromium.'); return; }
  if (values.league && values['team-id'] === undefined) throw new Error('--team-id is required with --league');
  const raw = values.league ? (await readLeague(values.league)).raw : smallLeague();
  const out = resolve(values.out ?? 'results/campaign-validation.json');
  if (values.league && out === resolve(values.league)) throw new Error('Output cannot overwrite the input league.');
  await mkdir(dirname(out), { recursive: true });
  let report;
  try { report = await validateCampaign({ raw, teamId: Number(values['team-id'] ?? 0), seed: Number(values.seed ?? 71), seasons: Number(values.seasons ?? 1), executablePath: values.browser }); }
  catch (error) { report = { status: 'error', message: error.message }; }
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`Validation ${report.status}. Report: ${out}`);
  if (report.status === 'passed') console.log(`Import and advancement to ${report.target.season} preseason match. ${report.preservation.checkedPlayers} exported players checked; ${report.preservation.nativeAdjustmentCount} native salary adjustments recorded.`);
  if (report.status !== 'passed') { console.error(report.message ?? JSON.stringify({ checkpoints: report.checkpoints?.filter(c => !c.passed).map(c => ({ name: c.name, differences: c.differences.slice(0, 5) })), preservation: report.preservation?.failures.slice(0, 5) })); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
