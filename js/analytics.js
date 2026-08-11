import * as Storage from './storage.js';
import * as Plans from './training-plans.js';
import { zoneCalcFromSummary } from './zone-calculator.js';

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
  const allWorkouts = Storage.getWorkouts();
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

  filtered.forEach(w => {
    totalDuration += (w.durationSeconds || 0);
    totalCalories += (w.calories || 0);
    if (w.avgBPM) {
      sumBPM += w.avgBPM;
      countBPM++;
    }
    if (w.avgRPM) {
      sumRPM += w.avgRPM;
      countRPM++;
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
  const workouts = Storage.getWorkouts();
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
  const workouts = Storage.getWorkouts();
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
  const workouts = Storage.getWorkouts().filter(w => w.planId && w.avgBPM > 0);
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
