import { ZoneCalculator, ZONES } from './zone-calculator.js';
import { CalorieCalculator } from './calorie-calculator.js';

export class WorkoutRecorder {
  constructor(profile) {
    this.profile = profile;
    this.zoneCalc = new ZoneCalculator(profile);
    this.calorieCalc = new CalorieCalculator(
      profile.sex, profile.weight, profile.age, profile.height
    );

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

    // Laps. Closed on demand; the segment still running is not in here.
    this.laps = [];
    this.lapStartMs = 0;
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

  /**
   * Closes the running segment and starts a new one.
   *
   * Stats are computed from the recorded samples rather than tracked incrementally, so a
   * lap costs nothing until it is actually marked and cannot drift from the data.
   *
   * @returns {null|object} the closed lap, or null if it would be empty.
   */
  markLap() {
    const endMs = this.elapsedMs;
    if (endMs - this.lapStartMs < 1000) return null;

    const points = this.dataPoints.filter(
      p => p.timestamp >= this.lapStartMs && p.timestamp < endMs
    );
    const bpms = points.map(p => p.bpm).filter(b => b > 0);
    const rpms = points.map(p => p.rpm).filter(r => r > 0);
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

    const lap = {
      index: this.laps.length + 1,
      startMs: this.lapStartMs,
      endMs,
      durationSeconds: Math.round((endMs - this.lapStartMs) / 1000),
      avgBPM: avg(bpms),
      maxBPM: bpms.length ? Math.max(...bpms) : 0,
      avgRPM: avg(rpms),
      calories: points.length
        ? Math.max(0, points[points.length - 1].calories - (points[0].calories || 0))
        : 0,
    };

    this.laps.push(lap);
    this.lapStartMs = endMs;
    return lap;
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
   * Serializa o estado completo do recorder para persistência.
   */
  getState() {
    return {
      startTime: this.startTime,
      endTime: this.endTime,
      elapsedMs: this.elapsedMs,
      pausedMs: this.pausedMs,
      isPaused: this.isPaused,
      _pauseStart: this._pauseStart || null,
      currentBPM: this.currentBPM,
      currentRPM: this.currentRPM,
      totalCalories: this.totalCalories,
      dataPoints: this.dataPoints,
      bpmSum: this.bpmSum,
      bpmCount: this.bpmCount,
      bpmMax: this.bpmMax,
      rpmSum: this.rpmSum,
      rpmCount: this.rpmCount,
      rpmMax: this.rpmMax,
      zoneTime: { ...this.zoneTime },
      laps: this.laps,
      lapStartMs: this.lapStartMs,
      profile: { ...this.profile }
    };
  }

  /**
   * Restaura o estado do recorder a partir de dados salvos.
   */
  restoreState(state) {
    this.startTime = state.startTime;
    this.endTime = state.endTime;
    this.elapsedMs = state.elapsedMs;
    this.pausedMs = state.pausedMs;
    this.isPaused = state.isPaused;
    this._pauseStart = state._pauseStart;
    this.currentBPM = state.currentBPM;
    this.currentRPM = state.currentRPM;
    this.totalCalories = state.totalCalories;
    this.dataPoints = state.dataPoints || [];
    this.bpmSum = state.bpmSum;
    this.bpmCount = state.bpmCount;
    this.bpmMax = state.bpmMax;
    this.rpmSum = state.rpmSum;
    this.rpmCount = state.rpmCount;
    this.rpmMax = state.rpmMax;
    this.zoneTime = { ...state.zoneTime };
    this.laps = state.laps || [];
    this.lapStartMs = state.lapStartMs || 0;
    this.lastTickTime = Date.now();

    // Adjust timing: account for time spent on the page being closed
    if (this.isPaused) {
      // If it was paused, keep it paused — no adjustment needed
    } else {
      // Was actively recording — we lost time while page was closed
      // Add the offline gap as paused time so elapsed doesn't jump
      const offlineGap = Date.now() - (this.startTime + this.elapsedMs + this.pausedMs);
      if (offlineGap > 0) {
        this.pausedMs += offlineGap;
      }
      // Pause the workout on restore — user must explicitly resume
      this.isPaused = true;
      this._pauseStart = Date.now();
    }
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
      laps: this.laps.slice(),
      dataPoints: this.dataPoints,
      profile: { ...this.profile },
      // Snapshotted so a later profile edit cannot silently rewrite the intensity of
      // rides that already happened.
      maxHR: this.zoneCalc.getMaxHR(),
      restingHR: this.zoneCalc.getRestingHR(),
      reserveBased: this.zoneCalc.isReserveBased()
    };
  }
}
