import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './input.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function sourceFingerprint(directory = resolve(root, '.campaign-engine')) {
  const paths = [];
  async function walk(name) {
    for (const entry of await readdir(resolve(directory, name), { withFileTypes: true })) {
      const relative = `${name}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) paths.push(relative);
      else throw new Error(`Unexpected source entry: ${relative}`);
    }
  }
  for (const name of ['src', 'tools', 'data']) await walk(name);
  paths.push('LICENSE.md', 'package.json');
  const entries = [];
  for (const path of paths.sort()) entries.push([path, sha256(await readFile(resolve(directory, path)))]);
  return sha256(JSON.stringify(entries));
}
export async function verifyBuild() {
  try {
    const pin = JSON.parse(await readFile(resolve(root, 'campaign/upstream.json')));
    const build = JSON.parse(await readFile(resolve(root, '.campaign-build/manifest.json')));
    if (pin.revision !== build.revision || pin.sourceSha256 !== build.sourceSha256) throw new Error('Engine revision mismatch');
    for (const [path, hash] of Object.entries(build.files)) {
      if (sha256(await readFile(resolve(root, path))) !== hash) throw new Error(`Changed build input: ${path}`);
    }
    return { ...pin, bundleSha256: build.files['.campaign-build/engine.mjs'], browserBundleSha256: build.files['.campaign-build/browser.mjs'], adapterSha256: build.adapterSha256 };
  } catch (error) {
    throw new Error(`${error.message}. Run npm run campaign:setup (or campaign:build after adapter changes).`);
  }
}
