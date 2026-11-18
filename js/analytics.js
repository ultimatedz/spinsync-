import * as Storage from './storage.js';
import * as Plans from './training-plans.js';
import { zoneCalcFromSummary } from './zone-calculator.js';

/**
 * Treinos que contam como treino de verdade.
 *
 * Sessões do modo demo são geradas pelo simulador e entravam no histórico
 * indistinguíveis das reais — inflando recordes, tendência de condicionamento e a escada
 * de progressão. Elas seguem visíveis no histórico, com selo; só não contam para número.
 */
function realWorkouts() {
  // Também fora: sessões curtas demais para serem treino (Storage.MIN_COUNTED_SECONDS).
  return Storage.getWorkouts().filter(Storage.countsAsTraining);
}

/** Midnight local time, so a ride at 23:50 belongs to the day it felt like. */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday-based, matching how a training week is normally counted in pt-BR. */
export function startOfWeek(date = new Date()) {
  const d = startOfDay(date);
  const dayFromMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayFromMonday);
  return d;
}

function periodStart(period, now) {
  if (period === 'week') return startOfWeek(now);
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === 'year') return new Date(now.getFullYear(), 0, 1);
  return new Date(0); // 'all'
}

/**
 * Filter and compute statistics from workout history.
 * @param {string} period - 'week', 'month', 'year', 'all'
 */
export function getStats(period = 'month') {
  const allWorkouts = realWorkouts();
  const now = new Date();
  
  // Calendar boundaries, not rolling windows.
  //
  // 'week' used to mean "the last 7 days", so on a Monday it still counted most of the
  // previous week and the number never matched what the user meant by "esta semana".
  const startDate = periodStart(period, now);

  // Filter workouts
  const filtered = allWorkouts.filter(w => {
    const wDate = new Date(w.date);
    return wDate >= startDate;
  });

  // Aggregate
  let totalDuration = 0;
  let totalCalories = 0;
  let sumBPM = 0;
  let countBPM = 0;
  let sumRPM = 0;
  let countRPM = 0;

  // Ponderado por duração, não média de médias: um sprint de 5 min pesava igual a um
  // endurance de 50, o que fazia o BPM médio do período dizer muito pouco.
  filtered.forEach(w => {
    const seconds = w.durationSeconds || 0;
    totalDuration += seconds;
    totalCalories += (w.calories || 0);
    if (w.avgBPM && seconds) {
      sumBPM += w.avgBPM * seconds;
      countBPM += seconds;
    }
    if (w.avgRPM && seconds) {
      sumRPM += w.avgRPM * seconds;
      countRPM += seconds;
    }
  });

  const avgBPM = countBPM > 0 ? Math.round(sumBPM / countBPM) : 0;
  const avgRPM = countRPM > 0 ? Math.round(sumRPM / countRPM) : 0;

  // Prepare chart data (Group by day for week/month, by month for year)
  const chartData = prepareChartData(filtered, period, startDate, now);

  return {
    count: filtered.length,
    totalDuration,
    totalCalories: Math.round(totalCalories),
    avgBPM,
    avgRPM,
    chartData
  };
}

/**
 * Progress against the weekly goal, plus the streak of weeks that met it.
 *
 * The streak deliberately counts *weeks*, not days: this is a spinning app, and a daily
 * streak would punish the rest days the training plans themselves prescribe.
 */
export function getGoalProgress(weeklyGoal) {
  const workouts = realWorkouts();
  const thisWeek = startOfWeek();
  const done = workouts.filter(w => new Date(w.date) >= thisWeek).length;

  if (!weeklyGoal) return { goal: 0, done, streak: 0, met: false };

  // Count backwards from last week. The current week is excluded from the streak until
  // it is actually met, so a Monday morning never reads as a broken streak.
  let streak = 0;
  for (let back = 1; back <= 104; back++) {
    const weekStart = new Date(thisWeek);
    weekStart.setDate(weekStart.getDate() - 7 * back);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const count = workouts.filter(w => {
      const d = new Date(w.date);
      return d >= weekStart && d < weekEnd;
    }).length;

    if (count >= weeklyGoal) streak++;
    else break;
  }

  const met = done >= weeklyGoal;
  return { goal: weeklyGoal, done, streak: met ? streak + 1 : streak, met };
}

/** Personal bests. Returns null for records no ride has set yet. */
export function getRecords() {
  const workouts = realWorkouts();
  if (workouts.length === 0) return null;

  const best = (pick) => workouts.reduce((a, b) => (pick(b) > pick(a) ? b : a));
  const timeInHardZones = (w) =>
    (w.zoneTime?.[4] || 0) + (w.zoneTime?.[5] || 0);

  return {
    longest: best(w => w.durationSeconds || 0),
    mostCalories: best(w => w.calories || 0),
    highestBPM: best(w => w.maxBPM || 0),
    hardest: best(timeInHardZones),
    hardestSeconds: timeInHardZones(best(timeInHardZones)),
    totalWorkouts: workouts.length,
    totalSeconds: workouts.reduce((sum, w) => sum + (w.durationSeconds || 0), 0),
  };
}

/**
 * Fitness trend: average heart rate for the *same prescribed work*, over time.
 *
 * Comparing raw average BPM across different rides says nothing — an easy recovery spin
 * and an interval session are not comparable. Restricting it to repeats of the same plan
 * makes the load constant, so a falling line is aerobic fitness improving rather than an
 * easier workout. Needs at least two rides of one plan to say anything at all.
 *
 * @returns {null|{planId, planName, points: Array<{date, avgBPM, intensity}>, deltaBPM}}
 */
export function getFitnessTrend() {
  const workouts = realWorkouts().filter(w => w.planId && w.avgBPM > 0);
  if (workouts.length < 2) return null;

  const byPlan = new Map();
  for (const w of workouts) {
    if (!byPlan.has(w.planId)) byPlan.set(w.planId, []);
    byPlan.get(w.planId).push(w);
  }

  // The plan with the most repeats carries the most signal; ties go to the more recent.
  let chosen = null;
  for (const [planId, list] of byPlan) {
    if (list.length < 2) continue;
    if (!chosen || list.length > chosen.list.length) chosen = { planId, list };
  }
  if (!chosen) return null;

  const points = chosen.list
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(w => ({
      date: w.date,
      avgBPM: w.avgBPM,
      intensity: Math.round(zoneCalcFromSummary(w).intensityOf(w.avgBPM) * 100),
    }));

  const plan = Plans.getAllPlans().find(p => p.id === chosen.planId);

  return {
    planId: chosen.planId,
    planName: plan?.name || chosen.planId,
    points,
    // Negative is the good direction: same work, lower heart rate.
    deltaBPM: points[points.length - 1].avgBPM - points[0].avgBPM,
  };
}

/**
 * Carga de treino pelo método sRPE: duração em minutos × esforço percebido.
 *
 * É a métrica clássica de diário de treino e o app já tinha os dois ingredientes gravados
 * sem usar nenhum deles. Ela responde o que nem FC nem calorias respondem: quanto o treino
 * custou a VOCÊ. Uma sessão de 60 min a RPE 4 (240) e uma de 30 min a RPE 8 (240) cobram
 * o mesmo, e é isso que se acumula ao longo da semana.
 *
 * A razão aguda:crônica compara a última semana com a média das quatro anteriores. Acima
 * de ~1.5 é um salto de volume — o padrão associado a lesão por excesso de carga. Só faz
 * sentido com histórico suficiente, por isso devolve null quando não há.
 */
export function getTrainingLoad() {
  return computeTrainingLoad(realWorkouts());
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Núcleo puro de getTrainingLoad, testável sem storage.
 *
 * Janelas MÓVEIS de 7 dias terminando agora, não semanas de calendário. A versão anterior
 * usava a semana desde segunda-feira como carga aguda e a comparava com semanas inteiras:
 * toda segunda de manhã a razão despencava para perto de zero ("pode ser perda de ritmo")
 * e só ficava justa no domingo, o mesmo treino lendo diferente conforme o dia da semana.
 *
 * @param {object[]} allWorkouts treinos reais (sem demo), com ou sem RPE
 * @param {number} [now] epoch ms — injetável para teste
 */
export function computeTrainingLoad(allWorkouts, now = Date.now()) {
  const workouts = allWorkouts.filter(w => w.rpe > 0);
  if (workouts.length === 0) return null;

  const load = (w) => Math.round((w.durationSeconds / 60) * w.rpe);

  // Janela k = [agora − 7(k+1) dias, agora − 7k dias).
  const weekLoad = (weeksBack) => {
    const end = now - 7 * DAY_MS * weeksBack;
    const start = end - 7 * DAY_MS;
    return workouts
      .filter(w => { const d = new Date(w.date).getTime(); return d >= start && d < end; })
      .reduce((sum, w) => sum + load(w), 0);
  };

  const acute = weekLoad(0);
  const previous = [1, 2, 3, 4].map(weekLoad);
  // Só conta como base as semanas em que houve treino: quem voltou de férias teria uma
  // média artificialmente baixa e qualquer sessão pareceria um salto perigoso.
  const active = previous.filter(v => v > 0);
  const chronic = active.length >= 2
    ? Math.round(active.reduce((a, b) => a + b, 0) / active.length)
    : null;

  const sessions = workouts
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 10)
    .map(w => ({ date: w.date, load: load(w), rpe: w.rpe, minutes: Math.round(w.durationSeconds / 60) }));

  return {
    acute,
    chronic,
    ratio: chronic ? Math.round((acute / chronic) * 100) / 100 : null,
    sessions,
    /** Quantos treinos ainda estão sem RPE — a razão de a carga poder subestimar. */
    missingRpe: allWorkouts.filter(w => !w.rpe).length,
  };
}

function prepareChartData(workouts, period, startDate, endDate) {
  // Simple grouping.
  const groups = {};
  
  workouts.forEach(w => {
    const d = new Date(w.date);
    let key = '';
    
    if (period === 'year') {
      // Group by month: "Jan", "Feb"
      key = d.toLocaleString('pt-BR', { month: 'short', year: '2-digit' });
    } else {
      // Group by day
      key = d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit' });
    }

    if (!groups[key]) {
      groups[key] = { calories: 0, duration: 0, dateObj: d };
    }
    groups[key].calories += (w.calories || 0);
    groups[key].duration += (w.durationSeconds || 0) / 60; // in minutes
  });

  // Sort chronologically
  const sortedKeys = Object.keys(groups).sort((a, b) => groups[a].dateObj - groups[b].dateObj);

  return {
    labels: sortedKeys,
    calories: sortedKeys.map(k => Math.round(groups[k].calories)),
    duration: sortedKeys.map(k => Math.round(groups[k].duration))
  };
}
