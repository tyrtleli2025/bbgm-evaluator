import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from '../campaign/node_modules/esbuild/lib/main.js';
import { transformSync } from '../campaign/node_modules/@babel/core/lib/index.js';
import syntaxTypescript from '../campaign/node_modules/@babel/plugin-syntax-typescript/lib/index.js';
import syntaxJsx from '../campaign/node_modules/@babel/plugin-syntax-jsx/lib/index.js';
import { sourceFingerprint } from '../campaign/provenance.mjs';
import { sha256 } from '../campaign/input.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await readFile(resolve(root, 'campaign/upstream.json')));
if (await sourceFingerprint() !== pin.sourceSha256) throw new Error('Full engine source does not match the pinned revision.');
await mkdir(resolve(root, '.campaign-build'), { recursive: true });
await build({ entryPoints: [resolve(root, '.campaign-engine/src/common/random.ts')],
  outfile: resolve(root, '.campaign-build/random.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
await build({
  entryPoints: [resolve(root, '.campaign-engine/tools/build/generateJsonSchema.ts')],
  outfile: resolve(root, '.campaign-build/schema.mjs'), bundle: true,
  platform: 'node', format: 'esm', nodePaths: [resolve(root, 'campaign/node_modules')],
});
const { generateJsonSchema } = await import('../.campaign-build/schema.mjs');
await mkdir(resolve(root, '.campaign-engine/build/files'), { recursive: true });
await writeFile(resolve(root, '.campaign-engine/build/files/league-schema.json'), JSON.stringify(generateJsonSchema('basketball')));
await build({ entryPoints: [resolve(root, '.campaign-engine/tools/babel-plugin-sport-functions/index.ts')],
  outfile: resolve(root, '.campaign-build/sport-transform.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { babelPluginSportFunctionsFactory } = await import('../.campaign-build/sport-transform.mjs');
const engineOptions = {
  entryPoints: [resolve(root, 'campaign/engine-entry.mjs')],
  outfile: resolve(root, '.campaign-build/engine.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as campaignCreateRequire } from "node:module"; const require = campaignCreateRequire(import.meta.url);' },
  nodePaths: [resolve(root, 'campaign/node_modules')],
  define: {
    __SPORT: '"basketball"', __NODE_ENV: '"production"',
    __JSON_URLS: JSON.stringify({ names: 'names.json', namesFemale: 'names-female.json',
      realPlayerData: 'real-player-data.basketball.json', realPlayerStats: 'real-player-stats.basketball.json' }),
  },
  plugins: [{ name: 'headless-ui', setup(build) {
    build.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
      const code = await readFile(path, 'utf8');
      if (!code.includes('bySport')) return;
      const contents = transformSync(code, { babelrc: false, configFile: false,
        plugins: [syntaxTypescript, ...(path.endsWith('.tsx') ? [syntaxJsx] : []), babelPluginSportFunctionsFactory('basketball')] }).code;
      return { contents, loader: path.endsWith('.tsx') ? 'tsx' : 'ts' };
    });
    build.onResolve({ filter: /(?:^|\/)toUI\.ts$/ }, () => ({ path: resolve(root, 'campaign/to-ui.mjs') }));
    build.onResolve({ filter: /(?:^|\/)promiseWorker\.ts$/ }, () => ({ path: 'worker', namespace: 'headless' }));
    build.onLoad({ filter: /.*/, namespace: 'headless' }, () => ({ contents:
      'export const promiseWorker = {postMessage: async () => {throw new Error("Unexpected browser RPC in campaign")}};' }));
  } }],
  metafile: true, logLevel: 'warning',
};
const result = await build(engineOptions);
await build({ ...engineOptions, platform: 'browser', banner: {}, outfile: resolve(root, '.campaign-build/browser.mjs') });
await writeFile(resolve(root, '.campaign-build/inputs.json'), JSON.stringify(Object.keys(result.metafile.inputs), null, 2));
const files = {};
const adapterFiles = ['campaign/runtime.mjs', 'campaign/worker.mjs', 'campaign/engine-entry.mjs', 'campaign/to-ui.mjs',
  'campaign/input.mjs', 'campaign/compare.mjs', 'campaign/report.mjs', 'campaign/provenance.mjs',
  'campaign/features.mjs', 'campaign/predictor.mjs', 'campaign/relative-predictor.mjs', 'campaign/stages.mjs', 'campaign/generate.mjs', 'campaign/planner.mjs', 'campaign/plan-cli.mjs',
  'campaign/audit-state.mjs', 'campaign/browser-reference.mjs', 'campaign/validate.mjs', 'campaign/package.json', 'campaign/package-lock.json', 'scripts/build-campaign.mjs'];
for (const path of ['.campaign-build/engine.mjs', '.campaign-build/browser.mjs', '.campaign-build/random.mjs', ...adapterFiles,
  ...['names.json', 'names-female.json', 'real-player-data.basketball.json', 'real-player-stats.basketball.json'].map(name => `.campaign-engine/data/${name}`)]) {
  files[path] = sha256(await readFile(resolve(root, path)));
}
await writeFile(resolve(root, '.campaign-build/manifest.json'), JSON.stringify({ ...pin, files,
  adapterSha256: sha256(JSON.stringify(adapterFiles.map(path => [path, files[path]]))) }, null, 2));
console.log('Built complete local Basketball GM campaign engine.');
