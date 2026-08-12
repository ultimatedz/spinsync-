/**
 * Health Connect Integration Module
 * 
 * Syncs workout data with Samsung Health / Google Fit via Health Connect.
 * Only works when running as a native Android app via Capacitor.
 * Falls back gracefully to no-op when running as a PWA in browser.
 */

let HealthPlugin = null;
let isNative = false;

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
      write: ['heartRate', 'calories', 'totalCalories', 'workouts']
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

    const authorized = await requestAuth();
    if (!authorized) {
      return { success: false, error: 'Health Connect permission denied' };
    }

    const startDate = summary.date; // ISO string
    const startMs = new Date(startDate).getTime();
    const endMs = startMs + (summary.durationSeconds * 1000);
    const endDate = new Date(endMs).toISOString();

    // 1. Write heart rate samples (sampled to max ~60 points)
    if (summary.dataPoints && summary.dataPoints.length > 0) {
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
    if (summary.calories > 0) {
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

      // Total Calories (used by Google Fit and Health Connect UI)
      try {
        await HealthPlugin.saveSample({
          dataType: 'totalCalories',
          value: summary.calories,
          unit: 'kilocalorie',
          startDate: startDate,
          endDate: endDate
        });
        console.log(`[HealthSync] Wrote ${summary.calories} total kcal`);
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

    console.log('[HealthSync] Workout sync complete!');
    return { success: true };

  } catch (e) {
    console.error('[HealthSync] syncWorkout error:', e);
    return { success: false, error: e.message || 'Unknown error' };
  }
}

/**
 * Get the sync status text for UI display.
 */
export function getStatusText() {
  if (!isNative) return 'Disponível apenas no app Android';
  return 'Health Connect disponível';
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

  // O sono vem em blocos; somar a duração dá as horas da última noite.
  const sleepHours = sleepSamples.length
    ? Math.round(sleepSamples.reduce((sum, s) =>
        sum + (new Date(s.endDate) - new Date(s.startDate)), 0) / 3600000 * 10) / 10
    : null;

  if (hrvNow === null && rhrNow === null && sleepHours === null) return null;

  return {
    hrv: hrvNow === null ? null : Math.round(hrvNow),
    hrvBaseline: hrvBase === null ? null : Math.round(hrvBase),
    restingHR: rhrNow === null ? null : Math.round(rhrNow),
    restingHRBaseline: rhrBase === null ? null : Math.round(rhrBase),
    sleepHours,
  };
}
