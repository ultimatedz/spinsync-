import * as Storage from './storage.js';

/**
 * Filter and compute statistics from workout history.
 * @param {string} period - 'week', 'month', 'year', 'all'
 */
export function getStats(period = 'month') {
  const allWorkouts = Storage.getHistory();
  const now = new Date();
  
  // Define the start date based on period
  let startDate = new Date(0); // 'all'
  if (period === 'week') {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 7);
  } else if (period === 'month') {
    startDate = new Date(now);
    startDate.setMonth(now.getMonth() - 1);
  } else if (period === 'year') {
    startDate = new Date(now);
    startDate.setFullYear(now.getFullYear() - 1);
  }

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
