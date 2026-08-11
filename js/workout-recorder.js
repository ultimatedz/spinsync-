import { ZoneCalculator, ZONES } from './zone-calculator.js';
import { CalorieCalculator } from './calorie-calculator.js';

/** Duas fontes de tick (timer do JS + heartbeat nativo) podem coincidir; abaixo disto é eco. */
const MIN_TICK_MS = 500;

/**
 * Teto do intervalo creditado a calorias e tempo em zona.
 *
 * Precisa ser MAIOR que o pior atraso legítimo: o Chromium degrada timers de página oculta
 * até uma acordada por minuto, então um intervalo de 60 s é normal e saudável — cortar em
 * 10 s reintroduziria exatamente o sub-registro que esta mudança existe para consertar.
 * 90 s dá folga sobre esse pior caso e ainda impede que um processo suspenso por 5 minutos
 * injete 5 minutos de esforço fictício de uma vez.
 */
const MAX_CREDIT_MS = 90_000;

/**
 * Idade máxima da última amostra para ela ainda valer como "o esforço agora".
 *
 * Esta é a trava de segurança de verdade, não o teto acima: as notificações BLE chegam por
 * callback nativo, que não sofre throttling. Se o processo está vivo mas apenas desacelerado,
 * a FC continua fresca e o intervalo inteiro é legítimo; se o processo foi suspenso, a FC
 * envelhece junto e nada é creditado. Mesma janela do watchdog de link em ble-manager.js.
 */
const SAMPLE_STALE_MS = 12_000;

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

    // Tempo em zona acumulado em MILISSEGUNDOS, arredondado só na saída — acumular em
    // segundos truncados fazia a soma derivar alguns segundos por treino.
    this.zoneTimeMs = {};
    ZONES.forEach(z => this.zoneTimeMs[z.id] = 0);

    // Tempo decorrido sem zona atribuível (sem cinta, sem contato, ou abaixo do piso da Z1).
    // Sem isto, sum(zoneTime) < durationSeconds e não havia como saber se a diferença era
    // um bug de contagem ou ausência legítima de sinal.
    this.unclassifiedMs = 0;

    // Quando cada sensor falou pela última vez. Ver SAMPLE_STALE_MS.
    this.lastBpmAt = 0;
    this.lastRpmAt = 0;

    // Roda: distância vem acumulada do sensor, velocidade é instantânea.
    this.currentSpeed = 0;
    this.speedMax = 0;
    this.distanceM = 0;

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
    // elapsedMs vinha do último tick e podia estar até um intervalo inteiro atrasado —
    // muito, se o app estava em segundo plano quando o treino foi encerrado.
    this.elapsedMs = this.endTime - this.startTime - this.pausedMs;
  }

  updateBPM(bpm) {
    this.currentBPM = bpm;
    this.lastBpmAt = Date.now();
  }

  updateRPM(rpm) {
    this.currentRPM = rpm;
    this.lastRpmAt = Date.now();
  }

  /**
   * Velocidade e distância do sensor de roda.
   *
   * A distância vem acumulada do parser (contador do próprio sensor), então é atribuída e
   * não somada — assim uma amostra perdida não some do total.
   */
  updateWheel({ speedKmh, distanceM }) {
    if (Number.isFinite(speedKmh)) {
      this.currentSpeed = speedKmh;
      if (speedKmh > this.speedMax) this.speedMax = speedKmh;
    }
    if (Number.isFinite(distanceM)) this.distanceM = distanceM;
  }

  /**
   * Chamado a cada ~1 s durante o treino. Registra o data point e atualiza as métricas.
   *
   * Credita o intervalo REAL desde o tick anterior, não 1 segundo fixo. Com tela apagada ou
   * app em segundo plano, o WebView desacelera os timers até uma acordada por minuto: assumir
   * 1 s por tick fazia calorias e tempo em zona ficarem dezenas de vezes menores que a
   * duração, que sempre foi medida por relógio de parede. A divergência era silenciosa —
   * `durationSeconds` certo, todo o resto errado.
   */
  tick() {
    if (this.isPaused || !this.startTime) return null;

    const now = Date.now();
    const rawDt = now - (this.lastTickTime || now);
    // Eco entre o timer do JS e o heartbeat nativo: os dois chamam este método.
    if (this.dataPoints.length && rawDt < MIN_TICK_MS) return null;

    this.elapsedMs = now - this.startTime - this.pausedMs;

    // Amostra velha significa esforço desconhecido, não esforço zero: extrapolar o último
    // BPM às cegas por um minuto inventaria calorias que ninguém queimou.
    const bpm = this.lastBpmAt && now - this.lastBpmAt <= SAMPLE_STALE_MS ? this.currentBPM : 0;
    const rpm = this.lastRpmAt && now - this.lastRpmAt <= SAMPLE_STALE_MS ? this.currentRPM : 0;

    const zone = this.zoneCalc.getZone(bpm);
    const zoneId = zone ? zone.id : 0;

    const dtMs = Math.min(rawDt, MAX_CREDIT_MS);
    const dtSec = dtMs / 1000;

    if (bpm > 0) {
      this.totalCalories += this.calorieCalc.calculateIncremental(bpm, dtSec);
      // Somas ponderadas por tempo: com amostragem irregular, contar amostras daria peso
      // igual a um tick de 1 s e a um de 60 s.
      this.bpmSum += bpm * dtSec;
      this.bpmCount += dtSec;
      if (bpm > this.bpmMax) this.bpmMax = bpm;
    }
    if (rpm > 0) {
      this.rpmSum += rpm * dtSec;
      this.rpmCount += dtSec;
      if (rpm > this.rpmMax) this.rpmMax = rpm;
    }

    if (zoneId > 0) this.zoneTimeMs[zoneId] = (this.zoneTimeMs[zoneId] || 0) + dtMs;
    else this.unclassifiedMs += dtMs;

    const dataPoint = {
      timestamp: this.elapsedMs,
      bpm,
      rpm,
      zoneId,
      calories: Math.round(this.totalCalories),
      speedKmh: this.currentSpeed || 0,
      distanceM: this.distanceM || 0,
      // Quanto tempo esta amostra representa. Consumidores antigos ignoram; quem pondera
      // usa `dp.dtMs || 1000`, que é exatamente o certo para dados gravados antes disto.
      dtMs: Math.round(rawDt),
    };

    this.dataPoints.push(dataPoint);
    this.lastTickTime = now;

    return dataPoint;
  }

  /**
   * Velocidade média = distância / tempo em movimento.
   *
   * Deliberadamente não é a média das leituras instantâneas: aquela conta cada amostra
   * igual, então uma parada longa com o sensor mudo puxaria a média para baixo de um jeito
   * que não corresponde a nada.
   */
  getAvgSpeed() {
    const seconds = this.getElapsedSeconds();
    if (!seconds || !this.distanceM) return 0;
    return Math.round((this.distanceM / 1000) / (seconds / 3600) * 10) / 10;
  }

  /** Tempo em zona em segundos — a forma que todo o resto do app consome. */
  getZoneTime() {
    const out = {};
    ZONES.forEach(z => out[z.id] = Math.round((this.zoneTimeMs[z.id] || 0) / 1000));
    return out;
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
      zoneTimeMs: { ...this.zoneTimeMs },
      unclassifiedMs: this.unclassifiedMs,
      distanceM: this.distanceM,
      speedMax: this.speedMax,
      lastBpmAt: this.lastBpmAt,
      lastRpmAt: this.lastRpmAt,
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
    // Aceita os dois formatos: um treino ativo salvo pela versão anterior guardava
    // zoneTime em segundos.
    this.zoneTimeMs = state.zoneTimeMs
      || Object.fromEntries(Object.entries(state.zoneTime || {}).map(([k, v]) => [k, v * 1000]));
    this.unclassifiedMs = state.unclassifiedMs || 0;
    this.distanceM = state.distanceM || 0;
    this.speedMax = state.speedMax || 0;
    this.lastBpmAt = state.lastBpmAt || 0;
    this.lastRpmAt = state.lastRpmAt || 0;
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
      zoneTime: this.getZoneTime(),
      // Tempo sem zona atribuível. Fecha o invariante
      // sum(zoneTime) + unclassifiedSeconds === durationSeconds, que sem isto não fechava e
      // não havia como distinguir falta de sinal de erro de contagem.
      unclassifiedSeconds: Math.round(this.unclassifiedMs / 1000),
      distanceM: Math.round(this.distanceM),
      avgSpeedKmh: this.getAvgSpeed(),
      maxSpeedKmh: Math.round(this.speedMax * 10) / 10,
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
