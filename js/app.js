import { BLEManager, BLESimulator } from './ble-manager.js';
import { WorkoutRecorder } from './workout-recorder.js';
import { WorkoutCharts } from './charts.js';
import { ZoneCalculator, ZONES } from './zone-calculator.js';
import * as Storage from './storage.js';

class SpinSyncApp {
  constructor() {
    this.ble = null;
    this.recorder = null;
    this.charts = new WorkoutCharts();
    this.demoMode = false;
    this.tickInterval = null;
    this.realtimeCtx = null;
    this.realtimeBPMHistory = [];
    this.realtimeRPMHistory = [];
    this.wakeLock = null;

    this.currentView = null;
    this.viewingSummary = null;

    this.init();
  }

  init() {
    // Check if profile exists
    const profile = Storage.getProfile();
    if (!profile) {
      this.showView('profile');
    } else {
      this.showView('home');
    }

    this.bindEvents();
    this.updateBottomNav();
  }

  bindEvents() {
    // Profile form
    document.getElementById('profile-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveProfile();
    });

    // Navigation
    document.getElementById('nav-home')?.addEventListener('click', () => this.showView('home'));
    document.getElementById('nav-history')?.addEventListener('click', () => this.showView('history'));
    document.getElementById('nav-profile')?.addEventListener('click', () => this.showView('profile'));

    // Sensor connections
    document.getElementById('btn-connect-hr')?.addEventListener('click', () => this.connectHR());
    document.getElementById('btn-connect-csc')?.addEventListener('click', () => this.connectCSC());

    // Demo toggle
    document.getElementById('demo-toggle')?.addEventListener('click', () => this.toggleDemo());

    // Start workout
    document.getElementById('btn-start-workout')?.addEventListener('click', () => this.startWorkout());

    // Workout controls
    document.getElementById('btn-pause')?.addEventListener('click', () => this.togglePause());
    document.getElementById('btn-stop')?.addEventListener('click', () => this.showStopConfirm());

    // Stop confirm modal
    document.getElementById('btn-confirm-stop')?.addEventListener('click', () => this.stopWorkout());
    document.getElementById('btn-cancel-stop')?.addEventListener('click', () => this.hideStopConfirm());

    // Summary actions
    document.getElementById('btn-save-workout')?.addEventListener('click', () => this.saveWorkout());
    document.getElementById('btn-new-workout')?.addEventListener('click', () => this.newWorkout());

    // Back buttons
    document.querySelectorAll('[data-back]').forEach(btn => {
      btn.addEventListener('click', () => this.showView(btn.dataset.back));
    });
  }

  // ── Views ──

  showView(viewId) {
    // Hide all views
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

    // Show target view
    const view = document.getElementById(`view-${viewId}`);
    if (view) {
      view.classList.add('active');
      this.currentView = viewId;
    }

    // View-specific setup
    switch (viewId) {
      case 'profile':
        this.populateProfileForm();
        break;
      case 'home':
        this.updateHomeView();
        break;
      case 'history':
        this.renderHistory();
        break;
    }

    // Update nav
    this.updateBottomNav();

    // Show/hide bottom nav
    const nav = document.getElementById('bottom-nav');
    if (nav) {
      nav.style.display = (viewId === 'workout') ? 'none' : 'flex';
    }
  }

  updateBottomNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.id === `nav-${this.currentView}`);
    });
  }

  // ── Profile ──

  populateProfileForm() {
    const profile = Storage.getProfile() || Storage.getDefaultProfile();
    const f = document.getElementById('profile-form');
    if (!f) return;
    f.querySelector('#input-name').value = profile.name || '';
    f.querySelector('#input-age').value = profile.age || '';
    f.querySelector('#input-weight').value = profile.weight || '';
    f.querySelector('#input-sex').value = profile.sex || 'M';
    f.querySelector('#input-rhr').value = profile.restingHR || '';
  }

  saveProfile() {
    const f = document.getElementById('profile-form');
    const profile = {
      name: f.querySelector('#input-name').value.trim() || 'Atleta',
      age: parseInt(f.querySelector('#input-age').value) || 28,
      weight: parseFloat(f.querySelector('#input-weight').value) || 70,
      sex: f.querySelector('#input-sex').value || 'M',
      restingHR: parseInt(f.querySelector('#input-rhr').value) || 70,
    };
    Storage.saveProfile(profile);
    this.showView('home');
  }

  // ── Home / Sensors ──

  updateHomeView() {
    const profile = Storage.getProfile();
    if (!profile) return;

    const greeting = document.getElementById('home-greeting');
    if (greeting) {
      const hour = new Date().getHours();
      let period = 'Bom dia';
      if (hour >= 12 && hour < 18) period = 'Boa tarde';
      else if (hour >= 18) period = 'Boa noite';
      greeting.textContent = `${period}, ${profile.name}!`;
    }

    this.updateSensorUI();
    this.updateStartButton();
  }

  toggleDemo() {
    this.demoMode = !this.demoMode;
    const toggle = document.getElementById('demo-toggle');
    if (toggle) {
      toggle.classList.toggle('active', this.demoMode);
      toggle.querySelector('.demo-label').textContent = this.demoMode ? 'Modo Demo ATIVO' : 'Modo Demo';
    }

    // Reset connections when toggling
    if (this.ble) {
      this.ble.disconnectAll();
    }
    this.ble = null;

    this.updateSensorUI();
    this.updateStartButton();
  }

  getBLE() {
    if (!this.ble) {
      this.ble = this.demoMode ? new BLESimulator() : new BLEManager();
      this.setupBLEListeners();
    }
    return this.ble;
  }

  setupBLEListeners() {
    const ble = this.ble;

    // HR events
    ble.addEventListener('hr-status', (e) => {
      this.updateSensorStatus('hr', e.detail);
    });
    ble.addEventListener('hr-connected', (e) => {
      const nameEl = document.getElementById('hr-device-name');
      if (nameEl) nameEl.textContent = e.detail.name;
      this.updateStartButton();
    });
    ble.addEventListener('hr-disconnected', () => {
      this.updateStartButton();
    });
    ble.addEventListener('hr-data', (e) => {
      if (this.recorder && !this.recorder.isPaused) {
        this.recorder.updateBPM(e.detail.bpm);
        this.updateWorkoutBPM(e.detail.bpm);
      }
    });

    // CSC events
    ble.addEventListener('csc-status', (e) => {
      this.updateSensorStatus('csc', e.detail);
    });
    ble.addEventListener('csc-connected', (e) => {
      const nameEl = document.getElementById('csc-device-name');
      if (nameEl) nameEl.textContent = e.detail.name;
      this.updateStartButton();
    });
    ble.addEventListener('csc-disconnected', () => {
      this.updateStartButton();
    });
    ble.addEventListener('csc-data', (e) => {
      if (this.recorder && !this.recorder.isPaused) {
        this.recorder.updateRPM(e.detail.rpm);
        this.updateWorkoutRPM(e.detail.rpm);
      }
    });
  }

  async connectHR() {
    const ble = this.getBLE();
    if (ble.hrConnected) {
      ble.disconnectHR();
     this.updateSensorUI();
      this.updateStartButton();
      return;
    }
    await ble.connectHR();
  }

  async connectCSC() {
    const ble = this.getBLE();
    if (ble.cscConnected) {
      ble.disconnectCSC();
      this.updateSensorUI();
      this.updateStartButton();
      return;
    }
    await ble.connectCSC();
  }

  updateSensorStatus(type, status) {
    const dot = document.getElementById(`${type}-status-dot`);
    const text = document.getElementById(`${type}-status-text`);
    const btn = document.getElementById(`btn-connect-${type}`);

    if (dot) {
      dot.className = `status-dot ${status}`;
    }

    const statusMap = {
      disconnected: 'Desconectado',
      scanning: 'Procurando...',
      connecting: 'Conectando...',
      connected: 'Conectado',
      error: 'Erro',
      cancelled: 'Cancelado'
    };

    if (text) {
      text.textContent = statusMap[status] || status;
    }

    if (btn) {
      const isConnected = status === 'connected';
      btn.className = `sensor-btn ${isConnected ? 'disconnect' : 'connect'}`;
      btn.textContent = isConnected ? 'Desconectar' : 'Conectar';
      btn.disabled = status === 'scanning' || status === 'connecting';
    }
  }

  updateSensorUI() {
    const ble = this.ble;
    if (!ble) {
      this.updateSensorStatus('hr', 'disconnected');
      this.updateSensorStatus('csc', 'disconnected');
      return;
    }
    this.updateSensorStatus('hr', ble.hrConnected ? 'connected' : 'disconnected');
    this.updateSensorStatus('csc', ble.cscConnected ? 'connected' : 'disconnected');
  }

  updateStartButton() {
    const btn = document.getElementById('btn-start-workout');
    if (!btn) return;
    const ble = this.ble;
    const hasConnection = ble && (ble.hrConnected || ble.cscConnected);
    const hasDemoOrConnection = this.demoMode || hasConnection;
    btn.disabled = !hasDemoOrConnection;
  }

  // ── Workout ──

  async startWorkout() {
    const profile = Storage.getProfile();
    if (!profile) return;

    this.recorder = new WorkoutRecorder(profile);
    this.realtimeBPMHistory = [];
    this.realtimeRPMHistory = [];

    // Init BPM display
    this.updateWorkoutBPM(0);
    this.updateWorkoutRPM(0);
    document.getElementById('workout-timer').textContent = '00:00:00';
    document.getElementById('workout-calories').textContent = '0';

    // Reset pause button
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) {
      pauseBtn.classList.remove('paused');
      pauseBtn.innerHTML = '⏸ Pausar';
    }

    // Show workout view
    this.showView('workout');

    // Wake Lock
    this.requestWakeLock();

    // Start recording
    this.recorder.start();

    // Start tick loop
    this.tickInterval = setInterval(() => this.workoutTick(), 1000);

    // Setup realtime chart
    const canvas = document.getElementById('realtime-canvas');
    if (canvas) {
      this.realtimeCtx = canvas.getContext('2d');
      canvas.width = canvas.offsetWidth * 2;
      canvas.height = canvas.offsetHeight * 2;
      this.realtimeCtx.scale(2, 2);
    }
  }

  workoutTick() {
    if (!this.recorder) return;

    const dp = this.recorder.tick();
    if (!dp) return;

    // Update timer
    document.getElementById('workout-timer').textContent = this.recorder.getFormattedTime();

    // Update calories
    document.getElementById('workout-calories').textContent = dp.calories;

    // Realtime chart data
    this.realtimeBPMHistory.push(dp.bpm);
    this.realtimeRPMHistory.push(dp.rpm);
    if (this.realtimeBPMHistory.length > 60) {
      this.realtimeBPMHistory.shift();
      this.realtimeRPMHistory.shift();
    }
    this.drawRealtimeChart();

    // Update zone
    this.updateZoneBar();
  }

  updateWorkoutBPM(bpm) {
    const el = document.getElementById('workout-bpm');
    if (el) el.textContent = bpm || '--';

    // Update circle color based on zone
    const circle = document.getElementById('bpm-circle');
    if (circle && this.recorder) {
      const zone = this.recorder.getCurrentZone();
      if (zone) {
        circle.style.background = `radial-gradient(circle, ${zone.color}20 0%, ${zone.color}08 70%)`;
        circle.style.border = `2px solid ${zone.color}40`;
        el.style.color = zone.color;

        // Update glow
        circle.style.setProperty('--glow-color', zone.color);
      } else {
        circle.style.background = `radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)`;
        circle.style.border = `2px solid var(--border-color)`;
        el.style.color = 'var(--text-primary)';
      }
    }
  }

  updateWorkoutRPM(rpm) {
    const el = document.getElementById('workout-rpm');
    if (el) el.textContent = rpm || '--';
  }

  updateZoneBar() {
    if (!this.recorder) return;
    const zone = this.recorder.getCurrentZone();
    const pct = this.recorder.getZonePercentage();

    const fill = document.getElementById('zone-bar-fill');
    const name = document.getElementById('zone-name');
    const pctEl = document.getElementById('zone-pct');

    if (fill) {
      fill.style.width = `${Math.min(100, pct)}%`;
      fill.style.backgroundColor = zone ? zone.color : 'var(--text-tertiary)';
    }
    if (name) {
      name.textContent = zone ? `Z${zone.id} ${zone.name}` : 'Sem dados';
      name.style.color = zone ? zone.color : 'var(--text-tertiary)';
    }
    if (pctEl) {
      pctEl.textContent = `${pct}% FC máx`;
    }
  }

  drawRealtimeChart() {
    const ctx = this.realtimeCtx;
    if (!ctx) return;

    const canvas = ctx.canvas;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;

    ctx.clearRect(0, 0, w, h);

    if (this.realtimeBPMHistory.length < 2) return;

    // Draw BPM line (red)
    this.drawLine(ctx, this.realtimeBPMHistory, w, h, '#EF5350', 60, 200);

    // Draw RPM line (blue)
    this.drawLine(ctx, this.realtimeRPMHistory, w, h, '#4FC3F7', 0, 120);
  }

  drawLine(ctx, data, w, h, color, minVal, maxVal) {
    const len = data.length;
    if (len < 2) return;

    const stepX = w / 59; // 60 data points
    const range = maxVal - minVal || 1;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    for (let i = 0; i < len; i++) {
      const x = (60 - len + i) * stepX;
      const y = h - ((Math.min(maxVal, Math.max(minVal, data[i])) - minVal) / range) * (h - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Fill under line
    ctx.lineTo((60 - 1) * stepX, h);
    ctx.lineTo((60 - len) * stepX, h);
    ctx.closePath();
    ctx.fillStyle = color + '15';
    ctx.fill();
  }

  togglePause() {
    if (!this.recorder) return;

    if (this.recorder.isPaused) {
      this.recorder.resume();
      const btn = document.getElementById('btn-pause');
      if (btn) {
        btn.classList.remove('paused');
        btn.innerHTML = '⏸ Pausar';
      }
    } else {
      this.recorder.pause();
      const btn = document.getElementById('btn-pause');
      if (btn) {
        btn.classList.add('paused');
        btn.innerHTML = '▶ Retomar';
      }
    }
  }

  showStopConfirm() {
    document.getElementById('stop-modal')?.classList.add('show');
  }

  hideStopConfirm() {
    document.getElementById('stop-modal')?.classList.remove('show');
  }

  stopWorkout() {
    this.hideStopConfirm();

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.recorder) {
      this.recorder.stop();
      this.viewingSummary = this.recorder.getSummary();
    }

    // Release wake lock
    this.releaseWakeLock();

    // Show summary
    this.showSummaryView(this.viewingSummary);
  }

  showSummaryView(summary) {
    if (!summary) return;

    this.charts.destroyAll();

    // Header
    const date = new Date(summary.date);
    const dateStr = date.toLocaleDateString('pt-BR', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
    const timeStr = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    document.getElementById('summary-date-text').textContent = `${dateStr} · ${timeStr}`;

    // Hero stats
    document.getElementById('summary-duration').textContent = summary.durationFormatted;
    document.getElementById('summary-calories').textContent = summary.calories;
    document.getElementById('summary-avg-bpm').textContent = summary.avgBPM || '--';

    // Stat cards
    document.getElementById('stat-avg-bpm').textContent = summary.avgBPM || '--';
    document.getElementById('stat-max-bpm').textContent = summary.maxBPM || '--';
    document.getElementById('stat-avg-rpm').textContent = summary.avgRPM || '--';
    document.getElementById('stat-max-rpm').textContent = summary.maxRPM || '--';

    this.showView('summary');

    // Render charts (with a small delay for DOM)
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (summary.dataPoints.length > 0) {
          this.charts.renderBPMChart('chart-bpm', summary);
          this.charts.renderCadenceChart('chart-cadence', summary);
          this.charts.renderZoneChart('chart-zones', summary);
        }
      }, 100);
    });
  }

  saveWorkout() {
    if (this.viewingSummary) {
      // Remove dataPoints for storage efficiency (keep last 500 max)
      const toSave = { ...this.viewingSummary };
      if (toSave.dataPoints.length > 500) {
        const step = Math.ceil(toSave.dataPoints.length / 500);
        toSave.dataPoints = toSave.dataPoints.filter((_, i) => i % step === 0);
      }
      Storage.saveWorkout(toSave);
    }
    this.viewingSummary = null;
    this.showView('home');
  }

  newWorkout() {
    if (this.viewingSummary) {
      const toSave = { ...this.viewingSummary };
      if (toSave.dataPoints.length > 500) {
        const step = Math.ceil(toSave.dataPoints.length / 500);
        toSave.dataPoints = toSave.dataPoints.filter((_, i) => i % step === 0);
      }
      Storage.saveWorkout(toSave);
    }
    this.viewingSummary = null;
    this.showView('home');
  }

  // ── History ──

  renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;

    const workouts = Storage.getWorkouts();

    if (workouts.length === 0) {
      list.innerHTML = `
        <div class="history-empty">
          <div class="history-empty-icon">🚴</div>
          <p>Nenhum treino registrado ainda.</p>
          <p class="text-secondary" style="font-size:0.8rem;margin-top:4px;">Comece seu primeiro treino!</p>
        </div>
      `;
      return;
    }

    list.innerHTML = workouts.map(w => {
      const date = new Date(w.date);
      const dateStr = date.toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'short'
      });
      const timeStr = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="history-item" data-workout-id="${w.id}">
          <div class="history-icon">🚴</div>
          <div class="history-info">
            <div class="history-date">${dateStr} · ${timeStr}</div>
            <div class="history-meta">${w.durationFormatted} · FC média ${w.avgBPM || '--'} bpm</div>
          </div>
          <div class="history-cal">${w.calories} kcal</div>
        </div>
      `;
    }).join('');

    // Bind click events
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.workoutId;
        const workout = Storage.getWorkoutById(id);
        if (workout) {
          this.viewingSummary = workout;
          this.showSummaryView(workout);
        }
      });
    });
  }

  // ── Wake Lock ──

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      console.log('Wake Lock não disponível:', err);
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release();
      this.wakeLock = null;
    }
  }
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  window.app = new SpinSyncApp();
});
