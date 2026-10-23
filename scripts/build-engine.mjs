import { stripTypeScriptTypes } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'vendor/zengm/manifest.json')));
for (const [file, info] of Object.entries(manifest.auditFiles ?? {})) {
  const bytes = readFileSync(resolve(root, 'vendor/zengm', file));
  if (createHash('sha256').update(bytes).digest('hex') !== info.sha256) throw new Error(`Upstream audit source changed: ${file}`);
}
for (const [file, hash] of Object.entries(manifest.files)) {
  const bytes = readFileSync(resolve(root, 'vendor/zengm', file));
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error(`Upstream source changed: ${file}`);
  }
  // loadTeams is retained for auditing the adapter, not executed (it needs IndexedDB).
  if (file.endsWith('/loadTeams.ts')) continue;
  const output = stripTypeScriptTypes(bytes.toString(), { mode: 'strip' })
    .replaceAll('__SPORT', '"basketball"')
    .replaceAll('__NODE_ENV', '"production"')
    .replace(/(from\s+["'][^"']+)\.ts(["'])/g, '$1.js$2');
  const dest = resolve(root, '.engine', file.slice(4).replace(/\.ts$/, '.js'));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, output);
}
const runtime = new URL('../src/engine-runtime.mjs', import.meta.url).href;
const util = resolve(root, '.engine/worker/util');
mkdirSync(util, { recursive: true });
writeFileSync(resolve(util, 'index.js'), `export { g, helpers } from ${JSON.stringify(runtime)};\n`);
writeFileSync(resolve(util, 'helpers.js'), `export { helpers as default } from ${JSON.stringify(runtime)};\n`);
console.error(`Built local engine ${manifest.revision} (verified source hashes).`);

writeFileSync(resolve(root, ".engine/common/helpers.js"), `export { helpers } from ${JSON.stringify(runtime)};\n`);
