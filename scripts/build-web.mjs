#!/usr/bin/env node
/**
 * Assembles www/ — the directory Capacitor copies into the APK and the one to deploy as
 * the PWA.
 *
 * Replaces an inline PowerShell one-liner in package.json, which was Windows-only and
 * could not stamp the service worker. That stamping is the point: sw.js served the app
 * stale-while-revalidate off a hand-edited `CACHE_NAME`, so shipping a JS change without
 * remembering to bump that constant left existing installs on the old bundle indefinitely.
 */
import { createHash } from 'node:crypto';
import {
  cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'www');

const FILES = ['index.html', 'manifest.json', 'sw.js'];
const DIRS = ['js', 'css', 'assets'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of FILES) cpSync(join(root, f), join(out, f));
for (const d of DIRS) cpSync(join(root, d), join(out, d), { recursive: true });

/** Every shipped byte except sw.js itself, which is what we are about to rewrite. */
function hashTree(dir, hash) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) hashTree(p, hash);
    else if (p !== join(out, 'sw.js')) hash.update(entry).update(readFileSync(p));
  }
  return hash;
}

const version = hashTree(out, createHash('sha256')).digest('hex').slice(0, 12);
const swPath = join(out, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const stamped = sw.replace(
  /const CACHE_NAME = '[^']*';/,
  `const CACHE_NAME = 'spinsync-${version}';`,
);

if (stamped === sw) {
  console.error('[build:web] could not stamp CACHE_NAME — sw.js no longer matches the pattern');
  process.exit(1);
}
writeFileSync(swPath, stamped);

console.log(`[build:web] www/ built, cache spinsync-${version}`);
