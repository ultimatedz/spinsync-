import { getMaxHR, getRestingHR, usesReserve } from './physiology.js';

export const ZONES = [
  { id: 1, name: 'Aquecimento',      minPct: 0.50, maxPct: 0.60, color: '#4FC3F7', colorDark: '#0277BD' },
  { id: 2, name: 'Queima de Gordura', minPct: 0.60, maxPct: 0.70, color: '#66BB6A', colorDark: '#2E7D32' },
  { id: 3, name: 'Aeróbico',         minPct: 0.70, maxPct: 0.80, color: '#FFA726', colorDark: '#E65100' },
  { id: 4, name: 'Anaeróbico',       minPct: 0.80, maxPct: 0.90, color: '#EF5350', colorDark: '#C62828' },
  { id: 5, name: 'VO2 Máx',          minPct: 0.90, maxPct: 1.00, color: '#AB47BC', colorDark: '#6A1B9A' }
];

/**
 * Zone calculator for a ride that already happened.
 *
 * Historical workouts carry their own maxHR/restingHR snapshot, so editing the profile
 * today cannot retroactively rewrite how hard last month's rides were. Sessions recorded
 * before resting HR was used have no snapshot of it and correctly fall back to %max.
 */
export function zoneCalcFromSummary(summary, fallbackProfile) {
  if (summary && Number.isFinite(summary.maxHR)) {
    return new ZoneCalculator({
      maxHR: summary.maxHR,
      restingHR: summary.restingHR,
      age: summary.profile?.age,
    });
  }
  return new ZoneCalculator(fallbackProfile || summary?.profile || {});
}

export class ZoneCalculator {
  /**
   * @param {object} profile - perfil completo; aceita também (age, restingHR) por
   *   compatibilidade com estado persistido de versões anteriores.
   */
  constructor(profile, legacyRestingHR) {
    const resolved = typeof profile === 'number'
      ? { age: profile, restingHR: legacyRestingHR }
      : (profile || {});

    this.maxHR = getMaxHR(resolved);
    this.restingHR = getRestingHR(resolved);

    // Karvonen (heart-rate reserve) whenever a resting HR is on file.
    //
    // Plain %max ignores the floor your heart never goes below, which makes the lower
    // zones far too easy to reach: at 60 bpm resting and 190 max, simply sitting still
    // already reads as 32% and a gentle spin lands in "fat burn" without any effort. The
    // form has always asked for resting HR — until now nothing read it.
    this.useReserve = usesReserve(resolved);
    this.reserve = this.maxHR - this.restingHR;
  }

  /** Heart rate at a given fraction of intensity, in whichever model is active. */
  bpmAt(pct) {
    return this.useReserve
      ? Math.round(this.restingHR + this.reserve * pct)
      : Math.round(this.maxHR * pct);
  }

  /** Intensity of a heart rate, 0..1+, in whichever model is active. */
  intensityOf(bpm) {
    return this.useReserve
      ? (bpm - this.restingHR) / this.reserve
      : bpm / this.maxHR;
  }

  getZone(bpm) {
    if (bpm <= 0) return null;
    const pct = this.intensityOf(bpm);
    for (let i = ZONES.length - 1; i >= 0; i--) {
      if (pct >= ZONES[i].minPct) return ZONES[i];
    }
    return ZONES[0];
  }

  getZonePercentage(bpm) {
    if (bpm <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(this.intensityOf(bpm) * 100)));
  }

  getMaxHR() {
    return this.maxHR;
  }

  getRestingHR() {
    return this.restingHR;
  }

  /** True when zones come from heart-rate reserve rather than plain %max. */
  isReserveBased() {
    return this.useReserve;
  }

  getZoneBounds() {
    return ZONES.map(z => ({
      ...z,
      minBPM: this.bpmAt(z.minPct),
      maxBPM: this.bpmAt(z.maxPct)
    }));
  }
}
