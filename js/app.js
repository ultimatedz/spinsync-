import { BLEManager, BLESimulator } from './ble-manager.js';
import { WorkoutRecorder } from './workout-recorder.js';
import { WorkoutCharts } from './charts.js';
import { ZoneCalculator, ZONES } from './zone-calculator.js';
import* as Storage from './storage.js';
import * as Plans from './training-plans.js';
import * as Analytics from './analytics.js';

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

    // Guided workout state
    this.guidedPlan = null;
    this.guidedPhaseIndex = 0;
    this.guidedPhaseElapsed = 0;
    this.guidedTotalElapsed = 0;
    this.guidedCurrentBPM = 0;
    this.guidedCurrentRPM = 0;
    this.selectedPlan = null;
    this.creatorPhases = [];

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
    document.getElementById('nav-analytics')?.addEventListener('click', () => this.showView('analytics'));

    // Analytics Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.renderAnalytics(e.target.dataset.period);
      });
    });

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

    // Plan creator
    document.getElementById('btn-create-plan')?.addEventListener('click', () => this.showPlanCreator());
    document.getElementById('btn-add-phase')?.addEventListener('click', () => this.addCreatorPhase());
    document.getElementById('btn-save-plan')?.addEventListener('click', () => this.saveCreatorPlan());

    // Plan detail
    document.getElementById('btn-start-guided')?.addEventListener('click', () => this.startGuidedWorkout());

    // Guided workout controls
    document.getElementById('btn-guided-pause')?.addEventListener('click', () => this.toggleGuidedPause());
    document.getElementById('btn-guided-stop')?.addEventListener('click', () => {
      document.getElementById('guided-stop-modal')?.classList.add('show');
    });
    document.getElementById('btn-guided-confirm-stop')?.addEventListener('click', () => this.stopGuidedWorkout());
    document.getElementById('btn-guided-cancel-stop')?.addEventListener('click', () => {
      document.getElementById('guided-stop-modal')?.classList.remove('show');
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
        this.renderPlanCards();
        break;
      case 'history':
        this.renderHistory();
        break;
      case 'analytics':
        this.renderAnalytics();
        break;
    }

    // Update nav
    this.updateBottomNav();

    // Show/hide bottom nav
    const nav = document.getElementById('bottom-nav');
    if (nav) {
      const hideNav = viewId === 'workout' || viewId === 'guided';
      nav.style.display = hideNav ? 'none' : 'flex';
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

  renderAnalytics(period = 'week') {
    const stats = Analytics.getStats(period);

    // Update simple fields
    document.getElementById('analytics-count').textContent = stats.count;
    document.getElementById('analytics-calories').textContent = stats.totalCalories.toLocaleString();
    
    const h = Math.floor(stats.totalDuration / 3600);
    const m = Math.floor((stats.totalDuration % 3600) / 60);
    document.getElementById('analytics-duration').textContent = `${h}h ${m}m`;
    
    document.getElementById('analytics-avg-bpm').textContent = stats.avgBPM || '--';
    document.getElementById('analytics-avg-rpm').textContent = stats.avgRPM || '--';

    // Render chart
    const canvas = document.getElementById('chart-analytics-calories');
    if (this.analyticsChart) {
      this.analyticsChart.destroy();
    }
    
    if (stats.chartData.labels.length > 0) {
      // Just a simple bar chart
      this.analyticsChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: stats.chartData.labels,
          datasets: [{
            label: 'Calorias (kcal)',
            data: stats.chartData.calories,
            backgroundColor: '#EF5350',
            borderRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      });
    }
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

  // ══════════════════════════════════════════
  // GUIDED TRAINING PLANS
  // ══════════════════════════════════════════

  renderPlanCards() {
    const container = document.getElementById('plans-scroll');
    if (!container) return;

    const plans = Plans.getAllPlans();
    container.innerHTML = plans.map(plan => {
      const dur = Plans.getPlanDuration(plan);
      const durStr = Plans.formatDuration(dur);
      const badgeClass = plan.difficulty.toLowerCase().replace('+', '\\+');

      return `
        <div class="plan-card" data-plan-id="${plan.id}">
          <div class="plan-card-emoji">${plan.emoji}</div>
          <div class="plan-card-name">${plan.name}</div>
          <div class="plan-card-meta">
            <span>${durStr}</span>
            <span>·</span>
            <span>${plan.phases.length} fases</span>
          </div>
          <div class="plan-card-badge badge-${badgeClass}">${plan.difficulty}</div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.plan-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.planId;
        const plan = plans.find(p => p.id === id);
        if (plan) this.showPlanDetail(plan);
      });
    });
  }

  showPlanDetail(plan) {
    this.selectedPlan = plan;
    const profile = Storage.getProfile();
    const maxHR = profile ? (220 - profile.age) : 192;

    document.getElementById('plan-emoji').textContent = plan.emoji;
    document.getElementById('plan-name').textContent = plan.name;
    document.getElementById('plan-desc').textContent = plan.description;
    document.getElementById('plan-duration').textContent = Plans.formatDuration(Plans.getPlanDuration(plan));
    document.getElementById('plan-phases-count').textContent = plan.phases.length;
    document.getElementById('plan-difficulty').textContent = plan.difficulty;

    // Render phase timeline
    const timeline = document.getElementById('plan-timeline');
    timeline.innerHTML = plan.phases.map((phase, i) => {
      const zone = Plans.getPhaseZone(phase);
      const bpm = Plans.resolvePhaseBPM(phase, maxHR);
      return `
        <div class="phase-item">
          <div class="phase-track">
            <div class="phase-dot" style="border-color: ${zone.color}"></div>
            <div class="phase-line"></div>
          </div>
          <div class="phase-content">
            <div class="phase-header">
              <span class="phase-name" style="color: ${zone.color}">${phase.name}</span>
              <span class="phase-duration">${Plans.formatDuration(phase.duration)}</span>
            </div>
            <div class="phase-targets">
              <span>❤️ ${bpm.min}-${bpm.max} bpm</span>
              <span>🔄 ${phase.rpmMin}-${phase.rpmMax} rpm</span>
            </div>
            ${phase.tip ? `<div class="phase-tip">${phase.tip}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Enable start button if sensors connected
    const btn = document.getElementById('btn-start-guided');
    if (btn) {
      const ble = this.ble;
      const hasConnection = ble && (ble.hrConnected || ble.cscConnected);
      btn.disabled = !(this.demoMode || hasConnection);
    }

    this.showView('plan-detail');
  }

  // ── Guided Workout ──

  async startGuidedWorkout() {
    if (!this.selectedPlan) return;
    const profile = Storage.getProfile();
    if (!profile) return;

    this.guidedPlan = this.selectedPlan;
    this.guidedPhaseIndex = 0;
    this.guidedPhaseElapsed = 0;
    this.guidedTotalElapsed = 0;
    this.guidedCurrentBPM = 0;
    this.guidedCurrentRPM = 0;

    this.recorder = new WorkoutRecorder(profile);
    this.recorder.start();

    this.showView('guided');
    this.requestWakeLock();
    this.updateGuidedPhaseUI();

    document.getElementById('guided-plan-name').textContent = this.guidedPlan.name;
    document.getElementById('guided-calories').textContent = '0';

    const pauseBtn = document.getElementById('btn-guided-pause');
    if (pauseBtn) {
      pauseBtn.classList.remove('paused');
      pauseBtn.innerHTML = '⏸ Pausar';
    }

    this.tickInterval = setInterval(() => this.guidedTick(), 1000);
  }

  guidedTick() {
    if (!this.recorder || !this.guidedPlan) return;
    if (this.recorder.isPaused) return;

    const dp = this.recorder.tick();
    if (!dp) return;

    this.guidedPhaseElapsed++;
    this.guidedTotalElapsed++;

    const phase = this.guidedPlan.phases[this.guidedPhaseIndex];
    if (!phase) return;

    // Check phase completion
    if (this.guidedPhaseElapsed >= phase.duration) {
      if (this.guidedPhaseIndex < this.guidedPlan.phases.length - 1) {
        this.guidedPhaseIndex++;
        this.guidedPhaseElapsed = 0;
        this.updateGuidedPhaseUI();
        // Flash animation
        const header = document.querySelector('.guided-header');
        if (header) {
          header.classList.add('phase-transition');
          setTimeout(() => header.classList.remove('phase-transition'), 1500);
        }
      } else {
        // Plan complete!
        this.stopGuidedWorkout();
        return;
      }
    }

    // Update UI
    this.updateGuidedTimers(phase);
    this.updateGuidedTargets(dp);

    // Update calories
    document.getElementById('guided-calories').textContent = Math.round(dp.calories);

    // Overall progress
    const total = Plans.getPlanDuration(this.guidedPlan);
    const pct = Math.min(100, (this.guidedTotalElapsed / total) * 100);
    const fill = document.getElementById('guided-overall-fill');
    if (fill) fill.style.width = `${pct}%`;
  }

  updateGuidedPhaseUI() {
    const plan = this.guidedPlan;
    if (!plan) return;
    const phase = plan.phases[this.guidedPhaseIndex];
    const zone = Plans.getPhaseZone(phase);
    const profile = Storage.getProfile();
    const maxHR = profile ? (220 - profile.age) : 192;
    const bpm = Plans.resolvePhaseBPM(phase, maxHR);

    // Phase label & name
    document.getElementById('guided-phase-label').textContent =
      `FASE ${this.guidedPhaseIndex + 1} DE ${plan.phases.length}`;
    const nameEl = document.getElementById('guided-phase-name');
    if (nameEl) {
      nameEl.textContent = phase.name;
      nameEl.style.color = zone.color;
    }

    // BPM target range
    document.getElementById('guided-bpm-range').textContent = `${bpm.min}-${bpm.max}`;
    document.getElementById('guided-rpm-range').textContent = `${phase.rpmMin}-${phase.rpmMax}`;

    // Tip
    const tipCard = document.getElementById('guided-tip-card');
    const tipDot = document.getElementById('guided-tip-dot');
    const tipText = document.getElementById('guided-tip-text');
    if (tipCard && phase.tip) {
      tipCard.style.display = 'flex';
      tipDot.style.backgroundColor = zone.color;
      tipText.textContent = phase.tip;
    } else if (tipCard) {
      tipCard.style.display = 'none';
    }

    // Next phase preview
    const nextCard = document.getElementById('guided-next-card');
    const nextPhase = plan.phases[this.guidedPhaseIndex + 1];
    if (nextCard && nextPhase) {
      const nextZone = Plans.getPhaseZone(nextPhase);
      nextCard.style.display = 'flex';
      document.getElementById('guided-next-dot').style.backgroundColor = nextZone.color;
      document.getElementById('guided-next-name').textContent = nextPhase.name;
      document.getElementById('guided-next-meta').textContent =
        `${Plans.formatDuration(nextPhase.duration)} · Z${nextPhase.zone} · ${nextPhase.rpmMin}-${nextPhase.rpmMax} rpm`;
    } else if (nextCard) {
      nextCard.style.display = 'none';
    }
  }

  updateGuidedTimers(phase) {
    const remaining = Math.max(0, phase.duration - this.guidedPhaseElapsed);
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    document.getElementById('guided-phase-timer').textContent =
      `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    // Phase progress
    const phasePct = Math.min(100, (this.guidedPhaseElapsed / phase.duration) * 100);
    const fill = document.getElementById('guided-progress-fill');
    if (fill) fill.style.width = `${phasePct}%`;
  }

  updateGuidedTargets(dp) {
    const profile = Storage.getProfile();
    const maxHR = profile ? (220 - profile.age) : 192;
    const phase = this.guidedPlan.phases[this.guidedPhaseIndex];
    const bpmTarget = Plans.resolvePhaseBPM(phase, maxHR);
    const zone = Plans.getPhaseZone(phase);

    // BPM display
    const bpmEl = document.getElementById('guided-bpm');
    if (bpmEl) bpmEl.textContent = dp.bpm || '--';

    // BPM circle color
    const circle = document.getElementById('guided-bpm-circle');
    if (circle) {
      circle.style.background = `radial-gradient(circle, ${zone.color}20 0%, ${zone.color}08 70%)`;
      circle.style.border = `2px solid ${zone.color}40`;
      if (bpmEl) bpmEl.style.color = zone.color;
    }

    // BPM target badge
    const bpmStatus = Plans.evaluateTarget(dp.bpm, bpmTarget.min, bpmTarget.max);
    this.setTargetBadge('guided-bpm-badge', bpmStatus);

    // RPM display
    const rpmEl = document.getElementById('guided-rpm');
    if (rpmEl) rpmEl.textContent = dp.rpm || '--';

    // RPM target badge
    const rpmStatus = Plans.evaluateTarget(dp.rpm, phase.rpmMin, phase.rpmMax);
    this.setTargetBadge('guided-rpm-badge', rpmStatus);
  }

  setTargetBadge(elementId, status) {
    const badge = document.getElementById(elementId);
    if (!badge) return;

    const labels = {
      'on_target': '✅ No alvo',
      'close_below': '⬆️ Quase',
      'close_above': '⬇️ Quase',
      'below': '⬆️ Aumente',
      'above': '⬇️ Reduza',
      'no_data': '—'
    };

    badge.textContent = labels[status] || '—';
    badge.className = `target-badge ${status}`;
  }

  toggleGuidedPause() {
    if (!this.recorder) return;
    if (this.recorder.isPaused) {
      this.recorder.resume();
      const btn = document.getElementById('btn-guided-pause');
      if (btn) { btn.classList.remove('paused'); btn.innerHTML = '⏸ Pausar'; }
    } else {
      this.recorder.pause();
      const btn = document.getElementById('btn-guided-pause');
      if (btn) { btn.classList.add('paused'); btn.innerHTML = '▶ Retomar'; }
    }
  }

  stopGuidedWorkout() {
    document.getElementById('guided-stop-modal')?.classList.remove('show');

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.recorder) {
      this.recorder.stop();
      this.viewingSummary = this.recorder.getSummary();
      if (this.viewingSummary && this.guidedPlan) {
        this.viewingSummary.planName = this.guidedPlan.name;
      }
    }

    this.releaseWakeLock();
    this.guidedPlan = null;
    this.showSummaryView(this.viewingSummary);
  }

  // ── Plan Creator ──

  showPlanCreator() {
    document.getElementById('creator-name').value = '';
    document.getElementById('creator-emoji').value = '🔥';
    document.getElementById('creator-desc').value = '';
    document.getElementById('creator-difficulty').value = 'Iniciante';

    this.creatorPhases = [
      { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 50, rpmMax: 65 },
      { name: 'Principal', duration: 600, zone: 2, rpmMin: 65, rpmMax: 80 },
      { name: 'Volta à Calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55 },
    ];
    this.renderCreatorPhases();
    this.showView('plan-creator');
  }

  renderCreatorPhases() {
    const container = document.getElementById('creator-phases');
    if (!container) return;

    container.innerHTML = this.creatorPhases.map((phase, i) => `
      <div class="creator-phase-card">
        <div class="creator-phase-num">Fase ${i + 1}</div>
        <button class="creator-phase-remove" data-idx="${i}" title="Remover">✕</button>
        <div class="form-group" style="margin-bottom:8px">
          <input type="text" class="form-input" data-field="name" data-idx="${i}" value="${phase.name}" placeholder="Nome da fase">
        </div>
        <div class="form-row-3">
          <div class="form-group" style="margin-bottom:8px">
            <label style="font-size:0.65rem">Duração (min)</label>
            <input type="number" class="form-input" data-field="duration" data-idx="${i}" value="${Math.round(phase.duration / 60)}" min="1" max="60">
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label style="font-size:0.65rem">Zona FC</label>
            <select class="form-select" data-field="zone" data-idx="${i}">
              ${ZONES.map(z => `<option value="${z.id}" ${z.id === phase.zone ? 'selected' : ''}>Z${z.id}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label style="font-size:0.65rem">RPM</label>
            <input type="text" class="form-input" data-field="rpm" data-idx="${i}" value="${phase.rpmMin}-${phase.rpmMax}" placeholder="60-80">
          </div>
        </div>
      </div>
    `).join('');

    // Bind events
    container.querySelectorAll('.creator-phase-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        this.creatorPhases.splice(idx, 1);
        this.renderCreatorPhases();
      });
    });

    container.querySelectorAll('[data-field]').forEach(input => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.dataset.idx);
        const field = input.dataset.field;
        const phase = this.creatorPhases[idx];
        if (!phase) return;

        if (field === 'name') phase.name = input.value;
        if (field === 'duration') phase.duration = parseInt(input.value) * 60 || 60;
        if (field === 'zone') phase.zone = parseInt(input.value);
        if (field === 'rpm') {
          const parts = input.value.split('-').map(s => parseInt(s.trim()));
          if (parts.length === 2) {
            phase.rpmMin = parts[0] || 50;
            phase.rpmMax = parts[1] || 80;
          }
        }
      });
    });
  }

  addCreatorPhase() {
    this.creatorPhases.push({ name: 'Nova Fase', duration: 300, zone: 2, rpmMin: 60, rpmMax: 80 });
    this.renderCreatorPhases();
  }

  saveCreatorPlan() {
    const name = document.getElementById('creator-name').value.trim();
    if (!name) { alert('Dê um nome ao treino'); return; }
    if (this.creatorPhases.length === 0) { alert('Adicione pelo menos uma fase'); return; }

    const plan = {
      id: 'custom_' + Date.now(),
      name,
      emoji: document.getElementById('creator-emoji').value || '🔥',
      description: document.getElementById('creator-desc').value || '',
      difficulty: document.getElementById('creator-difficulty').value,
      focus: 'Personalizado',
      phases: this.creatorPhases.map(p => ({ ...p })),
    };

    Plans.saveCustomPlan(plan);
    this.showView('home');
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
