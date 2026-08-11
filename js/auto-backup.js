/**
 * Periodic backup to a real file on the device.
 *
 * Everything lives in localStorage, which Android clears with "limpar dados" and drops
 * entirely on uninstall. Until now the only safety net was remembering to tap "Exportar
 * backup" — the one thing nobody does before the day they need it.
 *
 * Native only: the browser cannot write to disk without a user gesture, so in the PWA
 * this is a no-op and the manual export stays the answer.
 */

import * as Storage from './storage.js';

const BACKUP_DIR = 'backups';
const KEEP_COPIES = 5;
/** At most one automatic backup per day; the data changes on the order of one ride. */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

let Filesystem = null;
let Directory = null;

export async function init() {
  try {
    const Capacitor = window.Capacitor;
    if (!Capacitor?.isNativePlatform?.()) return false;

    const plugin = window.capacitorFilesystem;
    if (!plugin?.Filesystem) {
      console.log('[AutoBackup] Filesystem plugin unavailable');
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
  const path = `${BACKUP_DIR}/spinsync-${stamp}.json`;

  try {
    await Filesystem.writeFile({
      path,
      data: JSON.stringify(payload),
      directory: Directory.Data,
      encoding: 'utf8',
      recursive: true,
    });
    Storage.saveSettings({ lastAutoBackup: Date.now() });
    await pruneOldBackups();
    console.log(`[AutoBackup] wrote ${path} (${payload.workouts.length} treinos)`);
    return { path, workouts: payload.workouts.length };
  } catch (e) {
    console.warn('[AutoBackup] write failed:', e?.message);
    return null;
  }
}

/** Keeps the newest [KEEP_COPIES]; a corrupted export should not be the only copy left. */
async function pruneOldBackups() {
  try {
    const { files } = await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Data });
    const names = files
      .map(f => (typeof f === 'string' ? f : f.name))
      .filter(n => n.endsWith('.json'))
      .sort(); // ISO date prefix sorts chronologically

    for (const name of names.slice(0, Math.max(0, names.length - KEEP_COPIES))) {
      await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${name}`, directory: Directory.Data })
        .catch(() => {});
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
