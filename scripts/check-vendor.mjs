#!/usr/bin/env node
/**
 * Executa os bundles de js/vendor/ num sandbox e confere que cada plugin publica o global
 * que o app procura.
 *
 * Existe porque essa classe de erro já passou duas vezes: o bundle do Filesystem lançava na
 * carga (dependência `synapse` não vendorizada) e o app procurava `capacitorFilesystem`
 * quando o global real é `capacitorFilesystemPluginCapacitor`. Nenhum dos dois aparece no
 * build — e um `grep capacitorFilesystem` casa por substring dentro do nome longo, dando
 * falso positivo. Só carregar de fato resolve.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'js', 'vendor');

/** Ordem de carga idêntica à do index.html — capacitor-core precisa vir primeiro. */
const SCRIPTS = [
  'capacitor-core.js',
  'capacitor-app.js',
  'bluetooth-le.js',
  'capacitor-health.js',
  'capacitor-synapse.js',
  // O alias que o index.html declara entre os dois scripts.
  { eval: 'var synapse = window.outsystemsSynapse;' },
  'capacitor-filesystem.js',
  'chart.umd.js',
];

/** global publicado -> caminho que o app realmente usa dentro dele. */
const EXPECTED = {
  capacitorApp: 'App',
  capacitorCommunityBluetoothLe: 'BleClient',
  capacitorHealth: 'Health',
  capacitorFilesystemPluginCapacitor: 'Filesystem',
};

const win = {};
Object.assign(win, {
  window: win, self: win, globalThis: win, console,
  navigator: { userAgent: 'node' },
  document: { addEventListener() {}, querySelector: () => null, createElement: () => ({ style: {} }) },
});
const ctx = createContext(win);

let failed = false;

for (const entry of SCRIPTS) {
  if (typeof entry === 'object') { runInContext(entry.eval, ctx); continue; }
  try {
    runInContext(readFileSync(resolve(vendor, entry), 'utf8'), ctx, { filename: entry });
  } catch (e) {
    console.error(`[vendor] ${entry} LANÇOU na carga: ${e.message}`);
    failed = true;
  }
}

for (const [global, member] of Object.entries(EXPECTED)) {
  const value = win[global];
  if (!value) {
    console.error(`[vendor] global ausente: window.${global}`);
    failed = true;
  } else if (!value[member]) {
    console.error(`[vendor] window.${global} existe mas não expõe .${member}`);
    failed = true;
  }
}

if (failed) {
  console.error('[vendor] verificação FALHOU — rode `npm run vendor:sync` e confira o index.html');
  process.exit(1);
}
console.log(`[vendor] ${Object.keys(EXPECTED).length} plugins carregam e publicam seus globais`);
