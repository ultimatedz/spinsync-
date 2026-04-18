export const ZONES = [
  { id: 1, name: 'Aquecimento',      minPct: 0.50, maxPct: 0.60, color: '#4FC3F7', colorDark: '#0277BD' },
  { id: 2, name: 'Queima de Gordura', minPct: 0.60, maxPct: 0.70, color: '#66BB6A', colorDark: '#2E7D32' },
  { id: 3, name: 'Aeróbico',         minPct: 0.70, maxPct: 0.80, color: '#FFA726', colorDark: '#E65100' },
  { id: 4, name: 'Anaeróbico',       minPct: 0.80, maxPct: 0.90, color: '#EF5350', colorDark: '#C62828' },
  { id: 5, name: 'VO2 Máx',          minPct: 0.90, maxPct: 1.00, color: '#AB47BC', colorDark: '#6A1B9A' }
];

export class ZoneCalculator {
  constructor(age, restingHR = 70) {
    this.maxHR = 220 - age;
    this.restingHR = restingHR;
  }

  getZone(bpm) {
    if (bpm <= 0) return null;
    const pct = bpm / this.maxHR;
    for (let i = ZONES.length - 1; i >= 0; i--) {
      if (pct >= ZONES[i].minPct) return ZONES[i];
    }
    return ZONES[0];
  }

  getZonePercentage(bpm) {
    return Math.min(100, Math.round((bpm / this.maxHR) * 100));
  }

  getMaxHR() {
    return this.maxHR;
  }

  getZoneBounds() {
    return ZONES.map(z => ({
      ...z,
      minBPM: Math.round(z.minPct * this.maxHR),
      maxBPM: Math.round(z.maxPct * this.maxHR)
    }));
  }
}
