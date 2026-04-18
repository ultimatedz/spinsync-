import { ZONES } from './zone-calculator.js';

export class WorkoutCharts {
  constructor() {
    this.charts = [];
  }

  destroyAll() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
  }

  /**
   * Gráfico de BPM ao longo do tempo com zonas coloridas como fundo.
   */
  renderBPMChart(canvasId, summary) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const points = summary.dataPoints;
    const labels = points.map(p => this._formatTimestamp(p.timestamp));
    const bpmData = points.map(p => p.bpm);
    const maxHR = summary.maxHR;

    // Reduce data points for performance (max ~300 points)
    const { reducedLabels, reducedData } = this._reduceData(labels, bpmData, 300);

    // Zone background bands as annotations
    const zoneBands = ZONES.map(z => ({
      type: 'box',
      yMin: z.minPct * maxHR,
      yMax: z.maxPct * maxHR,
      backgroundColor: z.color + '15',
      borderWidth: 0,
    }));

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: reducedLabels,
        datasets: [{
          label: 'BPM',
          data: reducedData,
          borderColor: '#EF5350',
          backgroundColor: 'rgba(239, 83, 80, 0.1)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#161B22',
            titleColor: '#F0F6FC',
            bodyColor: '#8B949E',
            borderColor: '#30363D',
            borderWidth: 1,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              label: (ctx) => `${ctx.parsed.y} BPM`
            }
          }
        },
        scales: {
          x: {
            display: true,
            ticks: { color: '#6E7681', maxTicksLimit: 6, font: { size: 10 } },
            grid: { color: '#21262D' }
          },
          y: {
            display: true,
            min: Math.max(0, Math.min(...reducedData.filter(v => v > 0)) - 10),
            max: Math.max(...reducedData) + 10,
            ticks: { color: '#6E7681', font: { size: 10 } },
            grid: { color: '#21262D' }
          }
        }
      }
    });

    this.charts.push(chart);
    return chart;
  }

  /**
   * Gráfico de cadência (RPM) ao longo do tempo.
   */
  renderCadenceChart(canvasId, summary) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const points = summary.dataPoints;
    const labels = points.map(p => this._formatTimestamp(p.timestamp));
    const rpmData = points.map(p => p.rpm);

    const { reducedLabels, reducedData } = this._reduceData(labels, rpmData, 300);

    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: reducedLabels,
        datasets: [{
          label: 'RPM',
          data: reducedData,
          borderColor: '#4FC3F7',
          backgroundColor: 'rgba(79, 195, 247, 0.1)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 800, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#161B22',
            titleColor: '#F0F6FC',
            bodyColor: '#8B949E',
            borderColor: '#30363D',
            borderWidth: 1,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              label: (ctx) => `${ctx.parsed.y} RPM`
            }
          }
        },
        scales: {
          x: {
            display: true,
            ticks: { color: '#6E7681', maxTicksLimit: 6, font: { size: 10 } },
            grid: { color: '#21262D' }
          },
          y: {
            display: true,
            min: 0,
            ticks: { color: '#6E7681', font: { size: 10 } },
            grid: { color: '#21262D' }
          }
        }
      }
    });

    this.charts.push(chart);
    return chart;
  }

  /**
   * Gráfico de barras horizontais: tempo em cada zona.
   */
  renderZoneChart(canvasId, summary) {
    const ctx = document.getElementById(canvasId)?.getContext('2d');
    if (!ctx) return;

    const totalSeconds = Object.values(summary.zoneTime).reduce((a, b) => a + b, 0);

    const labels = ZONES.map(z => z.name);
    const data = ZONES.map(z => Math.round((summary.zoneTime[z.id] || 0) / 60 * 10) / 10);
    const colors = ZONES.map(z => z.color);

    const chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: colors.map(c => c + 'CC'),
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 6,
          barPercentage: 0.6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        animation: { duration: 1000, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#161B22',
            titleColor: '#F0F6FC',
            bodyColor: '#8B949E',
            borderColor: '#30363D',
            borderWidth: 1,
            cornerRadius: 8,
            callbacks: {
              label: (ctx) => `${ctx.parsed.x} min`
            }
          }
        },
        scales: {
          x: {
            display: true,
            ticks: {
              color: '#6E7681',
              font: { size: 10 },
              callback: (v) => `${v}m`
            },
            grid: { color: '#21262D' }
          },
          y: {
            ticks: { color: '#F0F6FC', font: { size: 11, weight: '500' } },
            grid: { display: false }
          }
        }
      }
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
