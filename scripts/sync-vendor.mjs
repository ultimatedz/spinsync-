#!/usr/bin/env node
/**
 * Copies third-party browser bundles from node_modules into js/vendor/.
 *
 * The app has no bundler, so it used to pull @capacitor/core, the BLE plugin, the
 * health plugin and Chart.js from esm.sh/jsDelivr at runtime. That made a gym with no
 * signal a hard failure: no heart rate, and an uncaught ReferenceError on every chart.
 * Run this after `npm install` or whenever those packages are upgraded.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'js', 'vendor');

// Each Capacitor plugin IIFE ends in `})({}, capacitorExports)`, so capacitor-core.js
// (which declares `var capacitorExports`) must be loaded before the plugins.
const FILES = [
  ['node_modules/@capacitor/core/dist/capacitor.js', 'capacitor-core.js'],
  ['node_modules/@capacitor/app/dist/plugin.js', 'capacitor-app.js'],
  ['node_modules/@capacitor-community/bluetooth-le/dist/plugin.js', 'bluetooth-le.js'],
  ['node_modules/@capgo/capacitor-health/dist/plugin.js', 'capacitor-health.js'],
  ['node_modules/chart.js/dist/chart.umd.js', 'chart.umd.js'],
];

mkdirSync(outDir, { recursive: true });

let failed = false;
for (const [from, to] of FILES) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.error(`[vendor] MISSING ${from} — run npm install`);
    failed = true;
    continue;
  }
  copyFileSync(src, resolve(outDir, to));
  console.log(`[vendor] ${from} -> js/vendor/${to}`);
}

process.exit(failed ? 1 : 0);
