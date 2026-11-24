import { ZONES } from './zone-calculator.js';

/**
 * Tema único de todos os gráficos — inclusive os do Progresso, criados em app.js.
 *
 * Aplicado uma vez em Chart.defaults em vez de repetido em cada gráfico: antes cada um
 * trazia a própria cópia de cores e tooltip, e elas já tinham divergido entre si.
 */
const THEME = {
  text: '#8A9099',
  grid: '#23262A',
  tooltipBg: '#1B1E22',
  tooltipText: '#F2F3F4',
  hr: '#EF5350',
  rpm: '#C9CDD2',
  trend: '#D4F54C',
};

if (typeof Chart !== 'undefined') {
  Chart.defaults.color = THEME.text;
  Chart.defaults.borderColor = THEME.grid;
  Chart.defaults.font.family = 'system-ui, -apple-system, Roboto, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.animation.duration = 300;
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: THEME.tooltipBg,
    titleColor: THEME.tooltipText,
    bodyColor: THEME.tooltipText,
    borderColor: THEME.grid,
    borderWidth: 1,
    cornerRadius: 6,
    displayColors: false,
    padding: 8,
  });
}

/** Série temporal de uma linha: o formato dos gráficos de FC e de cadência. */
function lineOptions(yAxis, unit) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.parsed.y} ${unit}` } },
    },
    scales: {
      x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } },
      y: { ...yAxis, ticks: { maxTicksLimit: 5 } },
    },
  };
}

export class WorkoutCharts {
  constructor() {
    this.charts = [];
  }

  destroyAll() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
  }

  /** Frequência cardíaca ao longo do treino. */
  renderBPMChart(canvasId, summary) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const points = summary.dataPoints || [];
    const labels = points.map(p => this._formatTimestamp(p.timestamp));
    const { reducedLabels, reducedData } = this._reduceData(labels, points.map(p => p.bpm), 300);

    // Math.min() de array vazio é Infinity: num treino só com cadência o eixo ficava com
    // min: Infinity e o gráfico não desenhava nada.
    const beats = reducedData.filter(v => v > 0);
    const yAxis = beats.length
      ? { min: Math.max(0, Math.min(...beats) - 10), max: Math.max(...beats) + 10 }
      : { min: 0, max: 200 };

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: reducedLabels,
        datasets: [{
          data: reducedData,
          borderColor: THEME.hr,
          backgroundColor: 'rgba(239, 83, 80, 0.08)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.25,
        }],
      },
      options: lineOptions(yAxis, 'bpm'),
    });

    this.charts.push(chart);
    return chart;
  }

  /** Cadência ao longo do treino. */
  renderCadenceChart(canvasId, summary) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const points = summary.dataPoints || [];
    const labels = points.map(p => this._formatTimestamp(p.timestamp));
    const { reducedLabels, reducedData } = this._reduceData(labels, points.map(p => p.rpm), 300);

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: reducedLabels,
        datasets: [{
          data: reducedData,
          borderColor: THEME.rpm,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.25,
        }],
      },
      options: lineOptions({ min: 0 }, 'rpm'),
    });

    this.charts.push(chart);
    return chart;
  }

  /** Barras horizontais: minutos em cada zona, na cor da zona. */
  renderZoneChart(canvasId, summary) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    // zoneTime pode não existir em treino importado ou gravado por versão antiga; sem a
    // guarda, Object.values(undefined) derrubava a tela de resumo inteira.
    const zoneTime = summary.zoneTime || {};

    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ZONES.map(z => `Z${z.id}`),
        datasets: [{
          data: ZONES.map(z => Math.round((zoneTime[z.id] || 0) / 60 * 10) / 10),
          backgroundColor: ZONES.map(z => z.color),
          borderRadius: 2,
          barPercentage: 0.7,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].label} · ${ZONES[items[0].dataIndex].name}`,
              label: (c) => `${c.parsed.x} min`,
            },
          },
        },
        scales: {
          x: { ticks: { callback: (v) => `${v} min`, maxTicksLimit: 5 } },
          y: { grid: { display: false }, ticks: { color: '#C9CDD2', font: { weight: '600' } } },
        },
      },
    });

    this.charts.push(chart);
    return chart;
  }

  // -- Helpers --

  _formatTimestamp(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Average heart rate across repeats of one plan.
   *
   * Not registered in this.charts: it lives on the analytics screen, which has its own
   * lifecycle, while destroyAll() belongs to the workout summary.
   *
   * @returns {Chart|undefined} so the caller can destroy it on the next render.
   */
  renderFitnessTrend(canvasId, trend) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const labels = trend.points.map(p =>
      new Date(p.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: trend.points.map(p => p.avgBPM),
          borderColor: THEME.trend,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: THEME.trend,
          fill: false,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => `${c.parsed.y} bpm · ${trend.points[c.dataIndex].intensity}% de intensidade`,
            },
          },
        },
        scales: {
          x: { grid: { display: false } },
          // Not zero-based on purpose: the interesting movement is a handful of bpm,
          // and a zero baseline would flatten it into a straight line.
          y: { beginAtZero: false, ticks: { maxTicksLimit: 5 } },
        },
      },
    });
  }

  _reduceData(labels, data, maxPoints) {
    if (data.length <= maxPoints) {
      return { reducedLabels: labels, reducedData: data };
    }
    const step = Math.ceil(data.length / maxPoints);
    const reducedLabels = [];
    const reducedData = [];
    for (let i = 0; i < data.length; i += step) {
      reducedLabels.push(labels[i]);
      // Average the chunk
      const chunk = data.slice(i, Math.min(i + step, data.length));
      const avg = Math.round(chunk.reduce((a, b) => a + b, 0) / chunk.length);
      reducedData.push(avg);
    }
    return { reducedLabels, reducedData };
  }
}
