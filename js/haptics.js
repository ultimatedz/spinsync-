/**
 * Haptic cues for guided workouts — on the phone and, over the same BLE link that
 * carries heart rate, on the watch.
 *
 * Riding indoors you are often not looking at the screen; a buzz two seconds before the
 * effort ramps is worth more than any on-screen countdown.
 *
 * Phone side uses navigator.vibrate rather than @capacitor/haptics because it takes a
 * pattern array natively (the plugin only does single buzzes), and needs no extra
 * bundle. It requires android.permission.VIBRATE, declared in the app manifest.
 */

/**
 * Pattern id ↔ waveform. The ids are the single byte written to the watch, so they
 * must stay in sync with PATTERNS in HapticPatterns.kt.
 */
export const PATTERNS = {
  phaseWarning: { id: 1, ms: [130] },
  phaseUp:      { id: 2, ms: [200, 100, 200, 100, 320] },
  phaseDown:    { id: 3, ms: [320, 130, 160] },
  phaseSame:    { id: 4, ms: [160, 90, 160] },
  finalStretch: { id: 5, ms: [110, 80, 110, 80, 110] },
  workoutEnd:   { id: 6, ms: [420, 160, 420] },
};

let enabled = true;
let bleRef = null;

/** Lets the app route watch haptics through whichever BLE manager is live. */
export function attachBLE(ble) {
  bleRef = ble;
}

export function setEnabled(value) {
  enabled = !!value;
}

export function isEnabled() {
  return enabled;
}

/**
 * Fires a cue on both devices. Never throws and never blocks the workout tick.
 * @param {keyof typeof PATTERNS} name
 */
export function cue(name) {
  const pattern = PATTERNS[name];
  if (!pattern || !enabled) return;

  vibratePhone(pattern.ms);
  vibrateWatch(pattern.id);
}

function vibratePhone(ms) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(ms);
    }
  } catch (e) {
    console.log('[Haptics] phone vibrate failed:', e?.message);
  }
}

function vibrateWatch(patternId) {
  // Fire and forget: a dropped buzz must never delay or break the session.
  try {
    bleRef?.sendHaptic?.(patternId);
  } catch (e) {
    console.log('[Haptics] watch cue failed:', e?.message);
  }
}

/** Stops any pattern in progress (used when a workout is stopped or paused). */
export function cancel() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(0);
    }
  } catch (e) { /* ignore */ }
}
