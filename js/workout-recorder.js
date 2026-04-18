import { ZoneCalculator, ZONES } from './zone-calculator.js';
import { CalorieCalculator } from './calorie-calculator.js';

export class WorkoutRecorder {
  constructor(profile) {
    this.profile = profile;
    this.zoneCalc = new ZoneCalculator(profile.age, profile.restingHR);
    this.calorieCalc = new CalorieCalculator(profile.sex, profile.weight, profile.age);

    this.reset();
  }

  reset() {
    this.dataPoints = [];
    this.startTime = null;
    this.endTime = null;
    this.elapsedMs = 0;
    this.pausedMs = 0;
    this.lastTickTime = null;
    this.isPaused = false;

    this.currentBPM = 0;
    this.currentRPM = 0;
    this.totalCalories = 0;

    // Aggregates
    this.bpmSum = 0;
    this.bpmCount = 0;
    this.bpmMax = 0;
    this.rpmSum = 0;
    this.rpmCount = 0;
    this.rpmMax = 0;

    // Zone time tracking (in seconds)
    this.zoneTime = {};
    ZONES.forEach(z => this.zoneTime[z.id] = 0);
  }

  start() {
    this.reset();
    this.startTime = Date.now();
    this.lastTickTime = this.startTime;
  }

  pause() {
    if (!this.isPaused) {
      this.isPaused = true;
      this._pauseStart = Date.now();
    }
  }

  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.pausedMs += Date.now() - this._pauseStart;
      this.lastTickTime = Date.now();
    }
  }

  stop() {
    this.endTime = Date.now();
    if (this.isPaused) {
      this.pausedMs += Date.now() - this._pauseStart;
      this.isPaused = false;
    }
  }

  updateBPM(bpm) {
    this.currentBPM = bpm;
  }

  updateRPM(rpm) {
    this.currentRPM = rpm;
  }

  /**
   * Deve ser chamado a cada segundo durante o treino.
   * Registra o data point e atualiza métricas.
   */
  tick() {
    if (this.isPaused || !this.startTime) return null;

    const now = Date.now();
    this.elapsedMs = now - this.startTime - this.pausedMs;

    const bpm = this.currentBPM;
    const rpm = this.currentRPM;
    const zone = this.zoneCalc.getZone(bpm);
    const zoneId = zone ? zone.id : 0;

    // Calorie increment (1 second)
    if (bpm > 0) {
      const calIncrement = this.calorieCalc.calculateIncremental(bpm, 1);
      this.totalCalories += calIncrement;
    }

    // Aggregates
    if (bpm > 0) {
      this.bpmSum += bpm;
      this.bpmCount++;
      if (bpm > this.bpmMax) this.bpmMax = bpm;
    }
    if (rpm > 0) {
      this.rpmSum += rpm;
      this.rpmCount++;
      if (rpm > this.rpmMax) this.rpmMax = rpm;
    }

    // Zone time
    if (zoneId > 0) {
      this.zoneTime[zoneId] = (this.zoneTime[zoneId] || 0) + 1;
    }

    const dataPoint = {
      timestamp: this.elapsedMs,
      bpm,
      rpm,
      zoneId,
      calories: Math.round(this.totalCalories)
    };

    this.dataPoints.push(dataPoint);
    this.lastTickTime = now;

    return dataPoint;
  }

  getElapsedSeconds() {
    return Math.floor(this.elapsedMs / 1000);
  }

  getFormattedTime() {
    const total = this.getElapsedSeconds();
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  getCurrentZone() {
    return this.zoneCalc.getZone(this.currentBPM);
  }

  getZonePercentage() {
    return this.zoneCalc.getZonePercentage(this.currentBPM);
  }

  getAvgBPM() {
    return this.bpmCount > 0 ? Math.round(this.bpmSum / this.bpmCount) : 0;
  }

  getAvgRPM() {
    return this.rpmCount > 0 ? Math.round(this.rpmSum / this.rpmCount) : 0;
  }

  /**
   * Gera o resumo do treino para persistência e visualização.
   */
  getSummary() {
    const durationSec = this.getElapsedSeconds();

    return {
      id: `workout_${this.startTime}`,
      date: new Date(this.startTime).toISOString(),
      durationSeconds: durationSec,
      durationFormatted: this.getFormattedTime(),
      calories: Math.round(this.totalCalories),
      avgBPM: this.getAvgBPM(),
      maxBPM: this.bpmMax,
      avgRPM: this.getAvgRPM(),
      maxRPM: this.rpmMax,
      zoneTime: { ...this.zoneTime },
      dataPoints: this.dataPoints,
      profile: { ...this.profile },
      maxHR: this.zoneCalc.getMaxHR()
    };
  }
}
