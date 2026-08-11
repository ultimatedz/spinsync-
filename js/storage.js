const PROFILE_KEY = 'spinsync_profile';
const WORKOUTS_KEY = 'spinsync_workouts';

const DEFAULT_PROFILE = {
  name: '',
  age: 30,
  weight: 70,
  sex: 'M',
  restingHR: 60
};

/**
 * A single truncated write (quota exceeded, process killed mid-write) used to throw
 * inside the app constructor and leave a permanently black screen with no way out.
 * Every read falls back to a sane default instead.
 */
function readJSON(key, fallback) {
  try {
    const data = localStorage.getItem(key);
    if (data === null) return fallback;
    const parsed = JSON.parse(data);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    console.error(`[Storage] Corrupted value for "${key}", discarding:`, e);
    try { localStorage.removeItem(key); } catch (_) { /* nothing else to do */ }
    return fallback;
  }
}

/** @returns {boolean} false when the write failed (quota, private mode). */
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`[Storage] Failed to write "${key}":`, e);
    return false;
  }
}

export function getProfile() {
  return readJSON(PROFILE_KEY, null);
}

export function saveProfile(profile) {
  return writeJSON(PROFILE_KEY, profile);
}

export function getDefaultProfile() {
  return { ...DEFAULT_PROFILE };
}

export function getWorkouts() {
  const workouts = readJSON(WORKOUTS_KEY, []);
  return Array.isArray(workouts) ? workouts : [];
}

export function saveWorkout(workout) {
  const workouts = getWorkouts();
  const existingIndex = workouts.findIndex(w => w.id === workout.id);
  if (existingIndex >= 0) {
    // Re-saving the same session (e.g. reopened from history) must not duplicate it.
    workouts[existingIndex] = workout;
  } else {
    workouts.unshift(workout);
  }
  return writeJSON(WORKOUTS_KEY, workouts);
}

export function getWorkoutById(id) {
  return getWorkouts().find(w => w.id === id) || null;
}

export function deleteWorkout(id) {
  const workouts = getWorkouts().filter(w => w.id !== id);
  return writeJSON(WORKOUTS_KEY, workouts);
}

export function replaceWorkouts(workouts) {
  return writeJSON(WORKOUTS_KEY, Array.isArray(workouts) ? workouts : []);
}

// ── Active Workout Persistence ──
const ACTIVE_WORKOUT_KEY = 'spinsync_active_workout';

export function saveActiveWorkout(state) {
  return writeJSON(ACTIVE_WORKOUT_KEY, state);
}

export function getActiveWorkout() {
  return readJSON(ACTIVE_WORKOUT_KEY, null);
}

export function clearActiveWorkout() {
  try { localStorage.removeItem(ACTIVE_WORKOUT_KEY); } catch (e) { /* ignore */ }
}

// ── Remembered BLE sensors ──
// On Android the deviceId is the MAC address and is stable across sessions, so a saved
// id lets us reconnect with BleClient.connect() — no scan, no picker, no user tap.

const DEVICE_KEYS = {
  hr: 'spinsync_hr_device',
  csc: 'spinsync_csc_device'
};

export function getSavedDevice(kind) {
  const key = DEVICE_KEYS[kind];
  if (!key) return null;
  const saved = readJSON(key, null);
  return saved && saved.deviceId ? saved : null;
}

export function saveDevice(kind, device) {
  const key = DEVICE_KEYS[kind];
  if (!key || !device?.deviceId) return false;
  return writeJSON(key, { deviceId: device.deviceId, name: device.name || '' });
}

export function clearSavedDevice(kind) {
  const key = DEVICE_KEYS[kind];
  if (!key) return;
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

// ── Settings ──
// Preferences that are neither profile data nor workout history.

const SETTINGS_KEY = 'spinsync_settings';

const DEFAULT_SETTINGS = {
  haptics: true,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_KEY, {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJSON(SETTINGS_KEY, next);
  return next;
}

// ── Backup ──

export function exportAll() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: getProfile(),
    workouts: getWorkouts(),
    customPlans: readJSON('spinsync_custom_plans', [])
  };
}

/**
 * Merges a backup into the current data, keyed by workout id and plan id.
 * @returns {{workouts: number, plans: number}} how many new entries were added
 */
export function importAll(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Arquivo inválido');

  let addedWorkouts = 0;
  if (Array.isArray(payload.workouts)) {
    const existing = getWorkouts();
    const ids = new Set(existing.map(w => w.id));
    for (const w of payload.workouts) {
      if (w && w.id && !ids.has(w.id)) {
        existing.push(w);
        ids.add(w.id);
        addedWorkouts++;
      }
    }
    existing.sort((a, b) => new Date(b.date) - new Date(a.date));
    replaceWorkouts(existing);
  }

  let addedPlans = 0;
  if (Array.isArray(payload.customPlans)) {
    const existing = readJSON('spinsync_custom_plans', []);
    const ids = new Set(existing.map(p => p.id));
    for (const p of payload.customPlans) {
      if (p && p.id && !ids.has(p.id)) {
        existing.push(p);
        ids.add(p.id);
        addedPlans++;
      }
    }
    writeJSON('spinsync_custom_plans', existing);
  }

  if (payload.profile && !getProfile()) saveProfile(payload.profile);

  return { workouts: addedWorkouts, plans: addedPlans };
}

export function clearAll() {
  const keys = [
    PROFILE_KEY, WORKOUTS_KEY, ACTIVE_WORKOUT_KEY, SETTINGS_KEY,
    'spinsync_custom_plans', DEVICE_KEYS.hr, DEVICE_KEYS.csc
  ];
  for (const key of keys) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
}
