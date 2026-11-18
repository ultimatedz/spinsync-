/**
 * Periodic backup to a real file on the device.
 *
 * Everything lives in localStorage, which Android clears with "limpar dados" and drops
 * entirely on uninstall. Until now the only safety net was remembering to tap "Exportar
 * backup" — the one thing nobody does before the day they need it.
 *
 * Native only: the browser cannot write to disk without a user gesture, so in the PWA
 * this is a no-op and the manual export stays the answer.
 *
 * ONDE grava importa mais do que QUANDO. A primeira versão gravava na pasta privada do
 * app (Directory.Data), que é apagada exatamente nos dois cenários acima — desinstalar e
 * limpar dados. Agora o destino é Documentos/SpinSync, que sobrevive a ambos e de onde
 * "Importar backup" restaura pelo seletor de arquivos. A pasta privada fica de reserva para
 * Android 10 ou anterior, onde Documentos exigiria uma permissão de armazenamento que o
 * app não pede.
 */

import * as Storage from './storage.js';

/** Dentro de Documentos. Também recebe os exports manuais (backup JSON e TCX). */
const PUBLIC_DIR = 'SpinSync';
/** Dentro da pasta privada do app — só a reserva. */
const PRIVATE_DIR = 'backups';
/** Só os backups automáticos entram no rodízio; exports manuais nunca são apagados. */
const AUTO_BACKUP_NAME = /^spinsync-\d{4}-\d{2}-\d{2}\.json$/;
const KEEP_COPIES = 5;
/** At most one automatic backup per day; the data changes on the order of one ride. */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

let Filesystem = null;
let Directory = null;

export async function init() {
  try {
    const Capacitor = window.Capacitor;
    if (!Capacitor?.isNativePlatform?.()) return false;

    // Nome do global conferido no próprio bundle vendorizado, não por grep: um `grep
    // capacitorFilesystem` casa por substring dentro de `capacitorFilesystemPluginCapacitor`
    // e dá falso positivo — foi exatamente assim que este plugin ficou morto sem ninguém ver.
    const plugin = window.capacitorFilesystemPluginCapacitor;
    if (!plugin?.Filesystem) {
      console.warn('[AutoBackup] bundle do Filesystem não carregou — backup automático off');
      return false;
    }
    Filesystem = plugin.Filesystem;
    Directory = plugin.Directory;
    return true;
  } catch (e) {
    console.log('[AutoBackup] init failed:', e?.message);
    return false;
  }
}

export function isAvailable() {
  return !!Filesystem;
}

/**
 * Writes a backup if one is due.
 *
 * @param {boolean} force ignore the interval (used by the manual button)
 * @returns {Promise<null|{path: string, workouts: number}>}
 */
export async function maybeBackup(force = false) {
  if (!Filesystem) return null;

  const settings = Storage.getSettings();
  const last = settings.lastAutoBackup || 0;
  if (!force && Date.now() - last < MIN_INTERVAL_MS) return null;

  const payload = Storage.exportAll();
  // Nothing recorded yet: an empty backup would only push a real one out of the rotation.
  if (!force && payload.workouts.length === 0) return null;

  const stamp = new Date().toISOString().slice(0, 10);
  const result = await writeUserFile(`spinsync-${stamp}.json`, JSON.stringify(payload));
  if (!result) return null;

  Storage.saveSettings({ lastAutoBackup: Date.now(), lastBackupWhere: result.where });
  await pruneOldBackups(result.where);
  console.log(`[AutoBackup] wrote ${result.path} (${payload.workouts.length} treinos)`);
  return { ...result, workouts: payload.workouts.length };
}

/**
 * Grava um arquivo onde o usuário consegue achá-lo: Documentos/SpinSync, ou a pasta privada
 * do app quando o aparelho recusa (Android 10 ou anterior).
 *
 * Usado também pelos exports manuais. Eles eram um `<a download>` de blob, que a WebView do
 * Capacitor simplesmente ignora — sem DownloadListener nada é gravado, e o app mostrava
 * "Backup gerado" sem ter gerado arquivo nenhum.
 *
 * @returns {Promise<null|{where: 'documents'|'data', path: string}>} null se nem a reserva deu
 */
export async function writeUserFile(name, data) {
  if (!Filesystem) return null;

  try {
    await Filesystem.writeFile({
      path: `${PUBLIC_DIR}/${name}`, data, directory: Directory.Documents,
      encoding: 'utf8', recursive: true,
    });
    return { where: 'documents', path: `Documentos/${PUBLIC_DIR}/${name}` };
  } catch (e) {
    console.warn('[AutoBackup] Documentos indisponível, usando a pasta interna:', e?.message);
  }

  try {
    await Filesystem.writeFile({
      path: `${PRIVATE_DIR}/${name}`, data, directory: Directory.Data,
      encoding: 'utf8', recursive: true,
    });
    return { where: 'data', path: `${PRIVATE_DIR}/${name}` };
  } catch (e) {
    console.warn('[AutoBackup] write failed:', e?.message);
    return null;
  }
}

/** Keeps the newest [KEEP_COPIES]; a corrupted export should not be the only copy left. */
async function pruneOldBackups(where) {
  const path = where === 'documents' ? PUBLIC_DIR : PRIVATE_DIR;
  const directory = where === 'documents' ? Directory.Documents : Directory.Data;
  try {
    const { files } = await Filesystem.readdir({ path, directory });
    const names = files
      .map(f => (typeof f === 'string' ? f : f.name))
      .filter(n => AUTO_BACKUP_NAME.test(n))
      .sort(); // ISO date prefix sorts chronologically

    for (const name of names.slice(0, Math.max(0, names.length - KEEP_COPIES))) {
      // Falha esperada para arquivos de uma instalação anterior: no Android 11+ o app
      // novo não é dono deles. Ficam lá, o que é o comportamento seguro.
      await Filesystem.deleteFile({ path: `${path}/${name}`, directory }).catch(() => {});
    }
  } catch (e) {
    // readdir throws when the directory does not exist yet — nothing to prune.
  }
}

export async function getLastBackupLabel() {
  const { lastAutoBackup } = Storage.getSettings();
  if (!lastAutoBackup) return null;
  return new Date(lastAutoBackup).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 'documents' | 'data' | null — onde o último backup automático foi parar. */
export function getLastBackupWhere() {
  return Storage.getSettings().lastBackupWhere || null;
}
