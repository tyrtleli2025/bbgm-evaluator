import { mkdtemp, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { root, sourceFingerprint } from '../campaign/provenance.mjs';
import { sha256 } from '../campaign/input.mjs';

const pin = JSON.parse(await readFile(resolve(root, 'campaign/upstream.json')));
async function command(cmd, args, cwd = root) {
  await new Promise((accept, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? accept() : reject(new Error(`${cmd} failed (${code})`)));
  });
}
try {
  await access(resolve(root, '.campaign-engine'));
} catch {
  const temp = await mkdtemp(resolve(tmpdir(), 'courtside-engine-'));
  try {
    console.log(`Downloading ZenGM ${pin.revision} for private local execution...`);
    const response = await fetch(`https://codeload.github.com/zengm-games/zengm/tar.gz/${pin.revision}`);
    if (!response.ok) throw new Error(`Engine download: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== pin.archiveSha256) throw new Error('Downloaded source archive hash mismatch.');
    const archive = resolve(temp, 'source.tar.gz');
    await writeFile(archive, bytes);
    await command('tar', ['-xzf', archive, '-C', temp]);
    const source = resolve(temp, `zengm-${pin.revision}`);
    if (await sourceFingerprint(source) !== pin.sourceSha256) throw new Error('Source tree hash mismatch.');
    await rename(source, resolve(root, '.campaign-engine'));
  } finally { await rm(temp, { recursive: true, force: true }); }
}
if (await sourceFingerprint() !== pin.sourceSha256) throw new Error('Local full engine source differs from the pinned source. Setup will not overwrite it.');
await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--prefix', 'campaign']);
await command(process.execPath, ['scripts/build-campaign.mjs']);
