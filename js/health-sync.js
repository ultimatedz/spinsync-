/**
 * Health Connect Integration Module
 * 
 * Syncs workout data with Samsung Health / Google Fit via Health Connect.
 * Only works when running as a native Android app via Capacitor.
 * Falls back gracefully to no-op when running as a PWA in browser.
 */

import { restingKcal } from './calorie-calculator.js';

let HealthPlugin = null;
let isNative = false;

/** O que o app escreve ao fim de cada treino. Uma lista só, para pedido e consulta. */
const WRITE_TYPES = ['heartRate', 'calories', 'totalCalories', 'workouts'];

/**
 * Initialize the health sync module.
 * Attempts to load the Capacitor Health plugin.
 */
export async function init() {
  try {
    // Both bundles are vendored into js/vendor (see scripts/sync-vendor.mjs) and loaded
    // synchronously by index.html. The esm.sh fallbacks that used to sit here were
    // unreachable in the APK and made the PWA depend on the network again.
    const Capacitor = window.Capacitor;

    if (!Capacitor || !Capacitor.isNativePlatform()) {
      console.log('[HealthSync] Running in browser — Health Connect not available');
      return;
    }

    HealthPlugin = window.capacitorHealth?.Health;

    isNative = !!HealthPlugin;
    console.log('[HealthSync] Running in native mode — Health Connect available');
  } catch (e) {
    console.log('[HealthSync] Health plugin unavailable, sync disabled:', e?.message);
    isNative = false;
  }
}

/**
 * Check if Health Connect is available on this device.
 */
export async function isAvailable() {
  if (!isNative || !HealthPlugin) return false;
  try {
    const result = await HealthPlugin.isAvailable();
    return result.available;
  } catch (e) {
    console.warn('[HealthSync] isAvailable error:', e);
    return false;
  }
}

/**
 * Request authorization to write health data.
 * Returns true if authorized, false otherwise.
 */
export async function requestAuth() {
  if (!isNative || !HealthPlugin) return false;
  try {
    const result = await HealthPlugin.requestAuthorization({
      // Leitura: o relógio já mede tudo isto toda noite e escreve no Health Connect. É de
      // longe o caminho mais barato para prontidão — o Health Services não expõe intervalos
      // R-R para apps de terceiros, então medir HRV por conta exigiria uma cinta peitoral.
      read: ['heartRateVariability', 'restingHeartRate', 'sleep'],
      write: WRITE_TYPES
    });
    const hasWrite = result.writeAuthorized && result.writeAuthorized.length > 0;
    console.log('[HealthSync] Authorization result:', result);
    return hasWrite;
  } catch (e) {
    console.warn('[HealthSync] requestAuth error:', e);
    return false;
  }
}

/**
 * Sync a completed workout to Health Connect.
 * This writes:
 * 1. Individual heart rate samples
 * 2. Calorie data
 * 3. A workout/exercise session record
 * 
 * @param {Object} summary - The workout summary from WorkoutRecorder.getSummary()
 * @returns {Object} { success: boolean, error?: string }
 */
export async function syncWorkout(summary) {
  if (!isNative || !HealthPlugin) {
    return { success: false, error: 'Health Connect not available (running as PWA)' };
  }

  try {
    const available = await isAvailable();
    if (!available) {
      return { success: false, error: 'Health Connect not available on this device' };
    }

    // Só consulta — nunca pede. requestAuth() aqui abria a tela de permissões do Health
    // Connect por cima do resumo, logo depois de "Finalizar", a cada treino em que faltasse
    // qualquer uma das permissões (inclusive as de LEITURA, que nem são usadas aqui). Para
    // quem estava na bike, era o app "saindo sozinho". Autorizar é no card do perfil.
    const granted = await grantedWriteTypes();
    if (granted.size === 0) {
      return { success: false, skipped: true, error: 'Health Connect not authorized' };
    }

    const startDate = summary.date; // ISO string
    const startMs = new Date(startDate).getTime();
    const endMs = startMs + (summary.durationSeconds * 1000);
    const endDate = new Date(endMs).toISOString();

    // 1. Write heart rate samples (sampled to max ~60 points)
    if (granted.has('heartRate') && summary.dataPoints && summary.dataPoints.length > 0) {
      const hrPoints = summary.dataPoints.filter(dp => dp.bpm > 0);
      
      // Sample to max 60 points to avoid excessive writes
      let sampled = hrPoints;
      if (hrPoints.length > 60) {
        const step = Math.ceil(hrPoints.length / 60);
        sampled = hrPoints.filter((_, i) => i % step === 0);
      }

      for (const dp of sampled) {
        const sampleTime = new Date(startMs + dp.timestamp).toISOString();
        try {
          await HealthPlugin.saveSample({
            dataType: 'heartRate',
            value: dp.bpm,
            unit: 'bpm',
            startDate: sampleTime,
            endDate: sampleTime
          });
        } catch (e) {
          // Continue even if individual samples fail
          console.warn('[HealthSync] HR sample write failed:', e);
        }
      }
      console.log(`[HealthSync] Wrote ${sampled.length} heart rate samples`);
    }

    // 2. Write calories (both Active and Total for maximum compatibility)
    if (summary.calories > 0 && granted.has('calories')) {
      // Active Calories (used by some apps like Samsung Health)
      try {
        await HealthPlugin.saveSample({
          dataType: 'calories',
          value: summary.calories,
          unit: 'kilocalorie',
          startDate: startDate,
          endDate: endDate
        });
        console.log(`[HealthSync] Wrote ${summary.calories} active kcal`);
      } catch (e) {
        console.warn('[HealthSync] Active calories write failed:', e);
      }
    }

    if (summary.calories > 0 && granted.has('totalCalories')) {
      // Total = ativas + basal do intervalo. Era gravado o valor ATIVO aqui também, o que
      // subnotificava o total e deixava os dois registros idênticos.
      const totalKcal = Math.round(
        summary.calories + restingKcal(summary.profile, summary.durationSeconds / 60)
      );
      try {
        await HealthPlugin.saveSample({
          dataType: 'totalCalories',
          value: totalKcal,
          unit: 'kilocalorie',
          startDate: startDate,
          endDate: endDate
        });
        console.log(`[HealthSync] Wrote ${totalKcal} total kcal`);
      } catch (e) {
        console.warn('[HealthSync] Total calories write failed:', e);
      }
    }

    // 3. Write workout session as Indoor Cycling (bikingStationary).
    //
    // No energy is passed here on purpose: ExerciseSessionRecord has no energy field in
    // Health Connect. Session calories are the ActiveCaloriesBurned / TotalCaloriesBurned
    // records written above over the same interval, which is how the platform links them.
    // ('totalEnergyBurned' and 'sourceName' used to be sent here and were silently
    // discarded by the patched Kotlin, which read only workoutType and title.)
    if (granted.has('workouts')) {
      try {
        await HealthPlugin.saveSample({
          dataType: 'workouts',
          value: summary.durationSeconds,
          startDate: startDate,
          endDate: endDate,
          metadata: {
            'workoutType': 'bikingStationary',
            'title': summary.planName || 'SpinSync - Treino Indoor'
          }
        });
        console.log('[HealthSync] Wrote bikingStationary workout session');
      } catch (e) {
        console.warn('[HealthSync] Workout session write failed:', e);
      }
    }

    console.log('[HealthSync] Workout sync complete!');
    return { success: true };

  } catch (e) {
    console.error('[HealthSync] syncWorkout error:', e);
    return { success: false, error: e.message || 'Unknown error' };
  }
}

/** Tipos de escrita já concedidos, sem abrir UI nenhuma. Vazio em qualquer falha. */
async function grantedWriteTypes() {
  try {
    const status = await HealthPlugin.checkAuthorization({ write: WRITE_TYPES });
    return new Set(status?.writeAuthorized || []);
  } catch (e) {
    console.warn('[HealthSync] checkAuthorization error:', e);
    return new Set();
  }
}

/**
 * Check if running in native mode (Capacitor).
 */
export function isNativeMode() {
  return isNative;
}

// ── Leitura de recuperação ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Lê amostras de um tipo, devolvendo [] em qualquer falha — nada aqui é essencial. */
async function readSamples(dataType, days, limit = 100) {
  if (!isNative || !HealthPlugin) return [];
  try {
    const res = await HealthPlugin.readSamples({
      dataType,
      startDate: new Date(Date.now() - days * DAY_MS).toISOString(),
      endDate: new Date().toISOString(),
      limit,
    });
    return res?.samples || [];
  } catch (e) {
    // Permissão não concedida ou tipo não suportado pela fonte. Não é erro do app.
    console.log(`[HealthSync] leitura de ${dataType} indisponível:`, e?.message);
    return [];
  }
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/**
 * Sinais de recuperação medidos pelo relógio durante a noite.
 *
 * Cada métrica é comparada com a linha de base das últimas semanas, porque o valor
 * absoluto não diz nada: um RMSSD de 40 ms é ótimo para uns e ruim para outros. O que
 * informa é o desvio em relação a você mesmo.
 *
 * @returns {Promise<null|object>} null quando não há dado nenhum — o card some.
 */
export async function getRecovery() {
  if (!isNative || !HealthPlugin) return null;

  const [hrvSamples, rhrSamples, sleepSamples] = await Promise.all([
    readSamples('heartRateVariability', 30),
    readSamples('restingHeartRate', 30),
    readSamples('sleep', 2, 20),
  ]);

  const recent = (samples, days) => {
    const cutoff = Date.now() - days * DAY_MS;
    return samples.filter(s => new Date(s.startDate).getTime() >= cutoff).map(s => s.value);
  };

  // Base de 30 dias excluindo os últimos 2, para o valor recente não se comparar consigo.
  const baseline = (samples) => {
    const cutoff = Date.now() - 2 * DAY_MS;
    return mean(samples.filter(s => new Date(s.startDate).getTime() < cutoff).map(s => s.value));
  };

  const hrvNow = mean(recent(hrvSamples, 2));
  const hrvBase = baseline(hrvSamples);
  const rhrNow = mean(recent(rhrSamples, 2));
  const rhrBase = baseline(rhrSamples);

  const sleepHours = sleepHoursLast24h(sleepSamples);

  if (hrvNow === null && rhrNow === null && sleepHours === null) return null;

  return {
    hrv: hrvNow === null ? null : Math.round(hrvNow),
    hrvBaseline: hrvBase === null ? null : Math.round(hrvBase),
    restingHR: rhrNow === null ? null : Math.round(rhrNow),
    restingHRBaseline: rhrBase === null ? null : Math.round(rhrBase),
    sleepHours,
  };
}

/**
 * Horas dormidas nas últimas 24 h — na prática, a última noite (mais um cochilo, se houve).
 *
 * A versão anterior somava todas as sessões de sono das últimas 48 h, ou seja, quase sempre
 * DUAS noites: ~14 h, e o alerta de sono curto (< 6 h) praticamente nunca disparava. Os
 * intervalos são unidos antes de somar porque mais de uma fonte (Samsung Health, outro app)
 * pode gravar a mesma noite, e somá-las dobraria o número.
 *
 * @param {Array<{startDate: string, endDate: string}>} samples
 * @param {number} [now] epoch ms — injetável para teste
 * @returns {number|null} null quando não há sono registrado na janela (relógio fora do pulso
 *   à noite não é "0 h de sono")
 */
export function sleepHoursLast24h(samples, now = Date.now()) {
  const windowStart = now - DAY_MS;
  const intervals = (samples || [])
    .map(s => [
      Math.max(windowStart, new Date(s.startDate).getTime()),
      Math.min(now, new Date(s.endDate).getTime()),
    ])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  if (intervals.length === 0) return null;

  let totalMs = 0;
  let [curStart, curEnd] = intervals[0];
  for (const [a, b] of intervals.slice(1)) {
    if (a <= curEnd) {
      curEnd = Math.max(curEnd, b);
    } else {
      totalMs += curEnd - curStart;
      [curStart, curEnd] = [a, b];
    }
  }
  totalMs += curEnd - curStart;

  return Math.round(totalMs / 3600000 * 10) / 10;
}
