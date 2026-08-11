import { createBLEManager, BLESimulator } from './ble-manager.js';
import { WorkoutRecorder } from './workout-recorder.js';
import { WorkoutCharts } from './charts.js';
import { ZoneCalculator, ZONES } from './zone-calculator.js';
import* as Storage from './storage.js';
import * as Plans from './training-plans.js';
import * as Analytics from './analytics.js';
import * as HealthSync from './health-sync.js';
import * as Progression from './progression.js';
import * as Haptics from './haptics.js';

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

    // Sensor contact, from flag bits 1-2 of the BLE HR measurement. Optimistic default:
    // straps that do not support the field report both bits as 0.
    this.hrContact = true;

    this.currentView = null;
    this.viewingSummary = null;
    // 'live'  — just finished, already persisted; actions are Concluir / Descartar
    // 'history' — reopened from the list; actions are Voltar / Excluir
    this.summaryMode = 'live';
    this._confirmResolver = null;
    this.viewStack = [];

    // Guided workout state
    this.guidedPlan = null;
    this.guidedPhaseIndex = 0;
    this.guidedPhaseElapsed = 0;
    this.guidedTotalElapsed = 0;
    this.guidedCurrentBPM = 0;
    this.guidedCurrentRPM = 0;
    this.selectedPlan = null;
    this.creatorPhases = [];

    // Persistence
    this.persistCounter = 0;
    this.planFilter = 'all';

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
    this.setupBackHandler();
    this.setupModalDismiss();
    this.updateBottomNav();

    // Check for active workout to recover
    this.checkWorkoutRecovery();

    this.applySettings();

    // Initialize Health Connect, then reflect its real state in the profile screen.
    HealthSync.init().then(() => this.updateHealthCard());

    // Silently pick up sensors used before — no picker, no tap.
    if (!this.demoMode) {
      this.getBLE().restoreSavedDevices().catch(() => {});
    }
  }

  bindEvents() {
    // Profile form
    document.getElementById('profile-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveProfile();
    });

    // Navigation — bottom-nav destinations are roots, so they reset the back stack.
    const showRoot = (id) => { this.viewStack = []; this.showView(id, { push: false }); };
    document.getElementById('nav-home')?.addEventListener('click', () => showRoot('home'));
    document.getElementById('nav-history')?.addEventListener('click', () => showRoot('history'));
    document.getElementById('nav-profile')?.addEventListener('click', () => showRoot('profile'));
    document.getElementById('nav-analytics')?.addEventListener('click', () => showRoot('analytics'));

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

    // Settings
    document.getElementById('setting-haptics')?.addEventListener('change', (e) => {
      Storage.saveSettings({ haptics: e.target.checked });
      Haptics.setEnabled(e.target.checked);
      if (e.target.checked) Haptics.cue('phaseWarning'); // confirm it actually buzzes
    });
    document.getElementById('btn-health-connect')?.addEventListener('click', () => this.connectHealth());

    // Backup
    document.getElementById('btn-export-data')?.addEventListener('click', () => this.exportData());
    document.getElementById('btn-reset-data')?.addEventListener('click', () => this.resetData());
    const importInput = document.getElementById('input-import-file');
    document.getElementById('btn-import-data')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', () => {
      this.importData(importInput.files?.[0]);
      importInput.value = '';
    });

    // Start workout
    document.getElementById('btn-start-workout')?.addEventListener('click', () => this.startWorkout());

    // Workout controls
    document.getElementById('btn-pause')?.addEventListener('click', () => this.togglePause());
    document.getElementById('btn-stop')?.addEventListener('click', () => this.showStopConfirm());

    // Stop confirm modal
    document.getElementById('btn-confirm-stop')?.addEventListener('click', () => this.stopWorkout());
    document.getElementById('btn-cancel-stop')?.addEventListener('click', () => this.hideStopConfirm());

    // Summary actions
    document.getElementById('btn-summary-primary')?.addEventListener('click', () => this.finishSummary());
    document.getElementById('btn-summary-delete')?.addEventListener('click', () => this.deleteSummary());

    // Coach
    document.getElementById('btn-coach-open')?.addEventListener('click', () => this.openCoachPlan());
    document.getElementById('btn-verdict-next')?.addEventListener('click', () => this.openVerdictNext());

    // Generic confirm modal
    document.getElementById('btn-confirm-ok')?.addEventListener('click', () => this._resolveConfirm(true));
    document.getElementById('btn-confirm-cancel')?.addEventListener('click', () => this._resolveConfirm(false));

    // Back buttons — walk the real stack when we have one, data-back is the fallback.
    document.querySelectorAll('[data-back]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = this.viewStack.length > 0 ? this.viewStack.pop() : btn.dataset.back;
        this.showView(target, { push: false });
      });
    });

    // Plan creator
    document.getElementById('btn-create-plan')?.addEventListener('click', () => this.showPlanCreator());
    document.getElementById('btn-add-phase')?.addEventListener('click', () => this.addCreatorPhase());
    document.getElementById('btn-save-plan')?.addEventListener('click', () => this.saveCreatorPlan());

    // Plan detail
    document.getElementById('btn-start-guided')?.addEventListener('click', () => this.startGuidedWorkout());
    document.getElementById('btn-delete-plan')?.addEventListener('click', () => this.deleteSelectedPlan());

    // Guided workout controls
    document.getElementById('btn-guided-pause')?.addEventListener('click', () => this.toggleGuidedPause());
    document.getElementById('btn-guided-stop')?.addEventListener('click', () => {
      this.openModal('guided-stop-modal');
    });
    document.getElementById('btn-guided-confirm-stop')?.addEventListener('click', () => this.stopGuidedWorkout());
    document.getElementById('btn-guided-cancel-stop')?.addEventListener('click', () => {
      this.closeModal('guided-stop-modal');
    });

    // Recovery modal
    document.getElementById('btn-resume-workout')?.addEventListener('click', () => this.resumeFromRecovery());
    document.getElementById('btn-discard-workout')?.addEventListener('click', () => this.discardRecovery());

    // Plan filter tabs
    document.querySelectorAll('.plan-filter-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('.plan-filter-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        this.planFilter = e.target.dataset.level;
        this.renderPlanCards();
      });
    });
  }

  // ── Views ──

  showView(viewId, { push = true } = {}) {
    // Remember where we came from so the Android back button can walk back up
    // instead of dropping straight out of the app.
    // Workout views are never pushed: going "back" into a finished session would
    // show a frozen timer over a recorder that no longer exists.
    const RESUMABLE = this.currentView !== 'workout' && this.currentView !== 'guided';
    if (push && this.currentView && this.currentView !== viewId && RESUMABLE) {
      this.viewStack.push(this.currentView);
      if (this.viewStack.length > 20) this.viewStack.shift();
    }

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

    // Show/hide bottom nav. Uses `hidden` rather than an inline display, which used to
    // win over the stylesheet and permanently override the 4-column grid layout.
    const nav = document.getElementById('bottom-nav');
    if (nav) nav.hidden = viewId === 'workout' || viewId === 'guided';
  }

  updateBottomNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      const isCurrent = item.id === `nav-${this.currentView}`;
      item.classList.toggle('active', isCurrent);
      if (isCurrent) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  // ── Back navigation ──

  /**
   * Wires the Android hardware back button (and Esc in the browser).
   *
   * Without this, back during a workout quit the app outright and back on any
   * secondary screen quit instead of going up.
   */
  setupBackHandler() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.handleBack()) e.preventDefault();
    });

    const CapApp = window.capacitorApp?.App;
    if (!CapApp?.addListener) return;

    CapApp.addListener('backButton', () => {
      if (!this.handleBack()) CapApp.exitApp();
    });
  }

  // ── Settings ──

  /** Pushes stored preferences into the modules that own them, and into the UI. */
  applySettings() {
    const settings = Storage.getSettings();
    Haptics.setEnabled(settings.haptics);
    const hapticsInput = document.getElementById('setting-haptics');
    if (hapticsInput) hapticsInput.checked = settings.haptics;
  }

  /**
   * The card is hidden entirely in the browser: Health Connect is an Android-only
   * integration, and offering a dead button there is worse than offering nothing.
   */
  async updateHealthCard() {
    const card = document.getElementById('health-card');
    const status = document.getElementById('health-status');
    const btn = document.getElementById('btn-health-connect');
    if (!card) return;

    if (!HealthSync.isNativeMode()) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const available = await HealthSync.isAvailable();
    if (status) {
      status.textContent = available
        ? 'Disponível. Autorize agora para que seus treinos sejam enviados ao terminar.'
        : 'Health Connect não está instalado ou está desativado neste aparelho.';
    }
    if (btn) btn.disabled = !available;
  }

  async connectHealth() {
    const btn = document.getElementById('btn-health-connect');
    const status = document.getElementById('health-status');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Aguardando a permissão…';

    const ok = await HealthSync.requestAuth();
    if (status) {
      status.textContent = ok
        ? 'Autorizado. Os treinos serão enviados automaticamente.'
        : 'Permissão negada. Você pode autorizar depois pelo app Health Connect.';
    }
    if (btn) btn.disabled = false;
    this.toast(ok ? 'Health Connect autorizado' : 'Permissão negada', ok ? 'success' : 'error');
  }

  // ── Modals ──

  /**
   * Opens an overlay and moves focus into it.
   *
   * The overlays all live in the DOM from boot. Before this, "hidden" meant opacity 0 with
   * pointer-events off, so a keyboard user could tab into the buttons of four invisible
   * dialogs from the profile screen — and an opened dialog never received focus at all.
   */
  openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    this._modalReturnFocus = document.activeElement;
    modal.classList.add('show');
    // Prefer the safe action: these dialogs all pair a destructive button with a cancel.
    const target = modal.querySelector('.btn-secondary, button');
    if (target) requestAnimationFrame(() => target.focus());
  }

  closeModal(id) {
    document.getElementById(id)?.classList.remove('show');
    // Hand focus back to whatever opened it, so the tab order does not jump to the top.
    const previous = this._modalReturnFocus;
    this._modalReturnFocus = null;
    if (previous?.isConnected) previous.focus();
  }

  /** Dismisses whatever overlay is open. @returns {boolean} true if one was. */
  closeTopModal() {
    const open = document.querySelector('.modal-overlay.show');
    if (!open) return false;
    // confirm-modal owns a pending promise; resolving it is what closes it.
    if (open.id === 'confirm-modal') this._resolveConfirm(false);
    else this.closeModal(open.id);
    return true;
  }

  /**
   * A click on the backdrop dismisses. Bound once on the container rather than per modal,
   * since the overlays are static markup.
   */
  setupModalDismiss() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        // Only the backdrop itself — clicks inside .modal bubble up here too.
        if (e.target !== overlay) return;
        if (overlay.id === 'confirm-modal') this._resolveConfirm(false);
        else this.closeModal(overlay.id);
      });
    });
  }

  /** @returns {boolean} true when the press was consumed and the app should stay open. */
  handleBack() {
    const openModal = document.querySelector('.modal-overlay.show');
    if (openModal) {
      if (openModal.id === 'confirm-modal') this._resolveConfirm(false);
      else this.closeModal(openModal.id);
      return true;
    }

    // Mid-workout: never leave silently, ask the same way the Finalizar button does.
    if (this.currentView === 'workout') {
      this.showStopConfirm();
      return true;
    }
    if (this.currentView === 'guided') {
      this.openModal('guided-stop-modal');
      return true;
    }

    if (this.viewStack.length > 0) {
      this.showView(this.viewStack.pop(), { push: false });
      return true;
    }

    if (this.currentView !== 'home' && Storage.getProfile()) {
      this.showView('home', { push: false });
      return true;
    }

    return false;
  }

  // ── Feedback ──

  /** Non-blocking replacement for window.alert(). */
  toast(message, type = 'info', duration = 3200) {
    const host = document.getElementById('toast-host');
    if (!host) return;

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    host.appendChild(el);

    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, duration);
  }

  /** @returns {Promise<boolean>} */
  confirm({ title = 'Confirmar', text = '', confirmLabel = 'Confirmar', danger = true }) {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return Promise.resolve(false);

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;

    const okBtn = document.getElementById('btn-confirm-ok');
    okBtn.textContent = confirmLabel;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm`;

    this.openModal('confirm-modal');

    return new Promise(resolve => { this._confirmResolver = resolve; });
  }

  _resolveConfirm(answer) {
    this.closeModal('confirm-modal');
    const resolve = this._confirmResolver;
    this._confirmResolver = null;
    if (resolve) resolve(answer);
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

    const name = f.querySelector('#input-name').value.trim();
    const age = parseInt(f.querySelector('#input-age').value, 10);
    const weight = parseFloat(f.querySelector('#input-weight').value);
    const restingHR = parseInt(f.querySelector('#input-rhr').value, 10);

    // Silently coercing a bad weight to 70 kg made every calorie number afterwards
    // wrong without the user ever knowing.
    const problems = [
      [!name, '#input-name', 'Informe seu nome.'],
      [!Number.isFinite(age) || age < 10 || age > 100, '#input-age', 'Idade deve estar entre 10 e 100 anos.'],
      [!Number.isFinite(weight) || weight < 30 || weight > 300, '#input-weight', 'Peso deve estar entre 30 e 300 kg.'],
      [f.querySelector('#input-rhr').value !== '' && (!Number.isFinite(restingHR) || restingHR < 30 || restingHR > 120),
        '#input-rhr', 'FC de repouso deve estar entre 30 e 120 bpm.'],
    ].find(([bad]) => bad);

    if (problems) {
      const [, selector, message] = problems;
      const field = f.querySelector(selector);
      field.classList.add('invalid');
      field.focus();
      field.addEventListener('input', () => field.classList.remove('invalid'), { once: true });
      this.toast(message, 'error');
      return;
    }

    const saved = Storage.saveProfile({
      name,
      age,
      weight,
      sex: f.querySelector('#input-sex').value || 'M',
      restingHR: Number.isFinite(restingHR) ? restingHR : 60,
    });

    this.toast(saved ? 'Perfil salvo.' : 'Não foi possível salvar o perfil.', saved ? 'success' : 'error');
    if (saved) this.showView('home');
  }

  // ── Backup ──

  exportData() {
    try {
      const payload = Storage.exportAll();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const stamp = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `spinsync-backup-${stamp}.json`;
      link.click();

      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.toast(`Backup com ${payload.workouts.length} treino(s) gerado.`, 'success');
    } catch (e) {
      console.error('[App] Export failed:', e);
      this.toast('Não foi possível gerar o backup.', 'error');
    }
  }

  async importData(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const { workouts, plans } = Storage.importAll(payload);
      this.toast(`Importado: ${workouts} treino(s), ${plans} plano(s).`, 'success');
      if (this.currentView === 'history') this.renderHistory();
    } catch (e) {
      console.error('[App] Import failed:', e);
      this.toast('Arquivo de backup inválido.', 'error');
    }
  }

  async resetData() {
    const confirmed = await this.confirm({
      title: 'Apagar todos os dados?',
      text: 'Perfil, histórico de treinos e treinos personalizados serão removidos deste aparelho. Exporte um backup antes se quiser guardá-los.',
      confirmLabel: 'Apagar tudo'
    });
    if (!confirmed) return;

    Storage.clearAll();
    location.reload();
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

    this.renderCoachCard();
    this.updateSensorUI();
    this.updateStartButton();
  }

  // ── Coach / progression ──

  renderCoachCard() {
    const card = document.getElementById('coach-card');
    if (!card) return;

    const profile = Storage.getProfile();
    const hint = Progression.getNextStepHint(profile);
    const state = hint.state;

    card.hidden = false;
    document.getElementById('coach-title').textContent = hint.title;
    document.getElementById('coach-text').textContent = hint.text;
    document.getElementById('coach-step').textContent = state.graduated
      ? `${state.totalSteps} de ${state.totalSteps}`
      : `Passo ${state.currentIndex + 1} de ${state.totalSteps}`;

    // Compact ladder: one pip per step, so progress is visible at a glance.
    document.getElementById('coach-ladder').innerHTML = state.steps
      .map(s => `<span class="ladder-pip ${s.status}" title="${escapeHtml(s.plan?.name || s.planId)}"></span>`)
      .join('');

    const btn = document.getElementById('btn-coach-open');
    if (btn) {
      btn.hidden = !hint.planId;
      this._coachPlanId = hint.planId;
    }
  }

  openCoachPlan() {
    if (!this._coachPlanId) return;
    const plan = Plans.getAllPlans().find(p => p.id === this._coachPlanId);
    if (plan) this.showPlanDetail(plan);
  }

  /**
   * Grades a finished guided session and renders the coach's call.
   * Hidden entirely for free rides and custom plans — they have no prescription to
   * measure against.
   */
  renderVerdict(summary) {
    const card = document.getElementById('verdict-card');
    if (!card) return;

    const profile = Storage.getProfile();
    const evaluation = summary?.planId ? Progression.evaluateSession(summary, profile) : null;

    if (!evaluation || !Progression.isLadderPlan(summary.planId)) {
      card.hidden = true;
      return;
    }

    // Only sessions *before* this one count as prior evidence.
    const previous = Progression.getSessionsFor(summary.planId, profile)
      .filter(e => e.date !== summary.date);
    const verdict = Progression.judge(evaluation, previous);

    card.hidden = false;
    card.className = `verdict-card ${verdict.action}`;

    document.getElementById('verdict-score').textContent = evaluation.score;
    document.getElementById('verdict-title').textContent = verdict.title;
    document.getElementById('verdict-plan').textContent = evaluation.planName;
    document.getElementById('verdict-message').textContent = verdict.message;

    document.getElementById('verdict-reasons').innerHTML = verdict.reasons
      .map(r => {
        const icon = r.good === true ? '✓' : r.good === false ? '✕' : '•';
        const cls = r.good === true ? 'good' : r.good === false ? 'bad' : 'neutral';
        return `<li class="${cls}"><span class="reason-icon">${icon}</span>${escapeHtml(r.text)}</li>`;
      })
      .join('');

    const btn = document.getElementById('btn-verdict-next');
    if (btn) {
      const showNext = verdict.action === 'advance' && verdict.nextPlanId;
      btn.hidden = !showNext;
      if (showNext) {
        const next = Plans.getAllPlans().find(p => p.id === verdict.nextPlanId);
        btn.textContent = `Ver "${next?.name || 'próximo treino'}"`;
        this._verdictNextPlanId = verdict.nextPlanId;
      }
    }
  }

  openVerdictNext() {
    if (!this._verdictNextPlanId) return;
    const plan = Plans.getAllPlans().find(p => p.id === this._verdictNextPlanId);
    if (plan) this.showPlanDetail(plan);
  }

  toggleDemo() {
    this.demoMode = !this.demoMode;
    const toggle = document.getElementById('demo-toggle');
    if (toggle) {
      toggle.classList.toggle('active', this.demoMode);
      toggle.setAttribute('aria-pressed', String(this.demoMode));
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
      this.ble = this.demoMode ? new BLESimulator() : createBLEManager();
      this.setupBLEListeners();
      // Watch haptics ride the same BLE link as heart rate.
      Haptics.attachBLE(this.ble);
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
      this.hrContact = true; // a fresh link starts clean
      this.updateStartButton();
    });
    ble.addEventListener('hr-disconnected', () => {
      this.hrContact = true;
      this.updateStartButton();
    });
    ble.addEventListener('hr-data', (e) => {
      const { bpm, contact = true } = e.detail;

      if (this.hrContact !== contact) {
        this.hrContact = contact;
        this.setHRContact(contact);
      }

      if (!contact) {
        // Hold the last good reading, greyed out. Feeding a 0 into the recorder would
        // poison avgBPM, time-in-zone and the calorie estimate for the rest of the session.
        this.updateWorkoutBPM(this.recorder?.currentBPM || 0, true);
        return;
      }

      if (this.recorder && !this.recorder.isPaused) {
        this.recorder.updateBPM(bpm);
        this.updateWorkoutBPM(bpm);
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
    if (ble.hrReconnecting) {
      ble.cancelReconnect('hr');
      this.updateStartButton();
      return;
    }
    if (ble.hrConnected) {
      await ble.disconnectHR();
      this.updateSensorUI();
      this.updateStartButton();
      return;
    }
    await ble.connectHR();
  }

  async connectCSC() {
    const ble = this.getBLE();
    if (ble.cscReconnecting) {
      ble.cancelReconnect('csc');
      this.updateStartButton();
      return;
    }
    if (ble.cscConnected) {
      await ble.disconnectCSC();
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
      // className assignment wipes the contact modifier; re-apply it so an unrelated
      // status refresh does not silently clear a live no-contact warning.
      if (type === 'hr' && status === 'connected' && this.hrContact === false) {
        dot.classList.add('no-contact');
      }
    }

    const statusMap = {
      disconnected: 'Desconectado',
      scanning: 'Procurando...',
      connecting: 'Conectando...',
      reconnecting: 'Reconectando...',
      connected: 'Conectado',
      stale: 'Sem dados, reconectando...',
      'bt-off': 'Bluetooth desligado',
      'no-permission': 'Permissão negada',
      timeout: 'Sensor não respondeu',
      offline: 'Sem internet para carregar o BLE',
      error: 'Erro',
      cancelled: 'Cancelado'
    };

    if (text) {
      const noContact = type === 'hr' && status === 'connected' && this.hrContact === false;
      text.textContent = noContact
        ? 'Conectado (sem contato)'
        : (statusMap[status] || status);
    }

    if (btn) {
      const isConnected = status === 'connected';
      const isReconnecting = status === 'reconnecting' || status === 'stale';
      btn.className = `sensor-btn ${isConnected || isReconnecting ? 'disconnect' : 'connect'}`;
      // Reconnection retries for up to ~2 minutes; the button has to stay live so the
      // user can call it off instead of watching a dead control.
      btn.textContent = isConnected ? 'Desconectar' : (isReconnecting ? 'Cancelar' : 'Conectar');
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
    const statusOf = (connected, reconnecting) =>
      connected ? 'connected' : (reconnecting ? 'reconnecting' : 'disconnected');
    this.updateSensorStatus('hr', statusOf(ble.hrConnected, ble.hrReconnecting));
    this.updateSensorStatus('csc', statusOf(ble.cscConnected, ble.cscReconnecting));
  }

  updateStartButton() {
    const btn = document.getElementById('btn-start-workout');
    if (!btn) return;
    // Always allow starting — sensors are optional
    btn.disabled = false;
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

    // Persist state every 5 seconds
    this.persistCounter++;
    if (this.persistCounter % 5 === 0) {
      this.persistWorkoutState('free');
    }
  }

  /**
   * Reflects a contact change on the sensor card only.
   *
   * Deliberately not routed through updateSensorStatus(): that also rewrites the connect
   * button's label and class, so a momentary contact blip would flip "Desconectar" back
   * into "Conectar" on a link that is perfectly healthy.
   */
  setHRContact(ok) {
    if (!this.getBLE()?.hrConnected) return;
    const text = document.getElementById('hr-status-text');
    const dot = document.getElementById('hr-status-dot');
    if (text) text.textContent = ok ? 'Conectado' : 'Conectado (sem contato)';
    if (dot) dot.classList.toggle('no-contact', !ok);
  }

  updateWorkoutBPM(bpm, stale = false) {
    const el = document.getElementById('workout-bpm');
    if (el) {
      el.textContent = bpm || '--';
      el.classList.toggle('stale', !!stale && bpm > 0);
    }

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
    this.openModal('stop-modal');
  }

  hideStopConfirm() {
    this.closeModal('stop-modal');
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

    // Save FIRST. Persisting only from the summary buttons meant one tap on the bottom
    // nav threw the whole ride away with no warning and no recovery.
    this.persistSummary(this.viewingSummary);

    // Release wake lock
    this.releaseWakeLock();

    // Show summary
    this.showSummaryView(this.viewingSummary, 'live');
  }

  showSummaryView(summary, mode = 'history') {
    if (!summary) return;

    this.summaryMode = mode;
    this.viewingSummary = summary;
    this.charts.destroyAll();

    // The two buttons used to be byte-identical copies of each other, and pressing
    // "Salvar" on a workout reopened from history silently duplicated it.
    const primary = document.getElementById('btn-summary-primary');
    const del = document.getElementById('btn-summary-delete');
    if (primary) primary.textContent = mode === 'live' ? 'Concluir' : 'Voltar';
    if (del) del.textContent = mode === 'live' ? 'Descartar treino' : 'Excluir treino';

    this.renderVerdict(summary);

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

    // A ride with no sensor data draws nothing, so show an empty state instead of three
    // captioned blank boxes.
    const hasData = summary.dataPoints.length > 0;
    const chartsEl = document.getElementById('summary-charts');
    const emptyEl = document.getElementById('summary-charts-empty');
    if (chartsEl) chartsEl.hidden = !hasData;
    if (emptyEl) emptyEl.hidden = hasData;
    if (!hasData) return;

    // Render charts (with a small delay for DOM)
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.charts.renderBPMChart('chart-bpm', summary);
        this.charts.renderCadenceChart('chart-cadence', summary);
        this.charts.renderZoneChart('chart-zones', summary);
        this.renderZoneAltText(summary);
      }, 100);
    });
  }

  /**
   * Text equivalent of the zone chart. It is the one chart with no stat card duplicating
   * its numbers, so without this a screen reader gets nothing from it at all.
   */
  renderZoneAltText(summary) {
    const el = document.getElementById('chart-zones-alt');
    if (!el) return;
    const parts = Object.entries(summary.zoneTime || {})
      .filter(([, seconds]) => seconds > 0)
      .map(([id, seconds]) => `${id}: ${Math.round(seconds / 60)} min`);
    el.textContent = parts.length
      ? `Tempo por zona — ${parts.join(', ')}.`
      : 'Sem tempo registrado em nenhuma zona.';
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
      this.analyticsChart = null;
    }

    // A titled but permanently blank chart card reads as a bug; say what's missing.
    const hasData = stats.chartData.labels.length > 0;
    const card = document.getElementById('analytics-chart-card');
    const empty = document.getElementById('analytics-empty');
    if (card) card.hidden = !hasData;
    if (empty) empty.hidden = hasData;

    if (hasData) {
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

  /**
   * Writes a finished session to history and pushes it to Health Connect.
   * Called from stopWorkout/stopGuidedWorkout, not from a button — the user should
   * never be able to lose a ride by navigating away.
   */
  persistSummary(summary) {
    if (!summary) return false;

    // Trim dataPoints for storage efficiency (keep 500 max)
    const toSave = { ...summary };
    if (toSave.dataPoints.length > 500) {
      const step = Math.ceil(toSave.dataPoints.length / 500);
      toSave.dataPoints = toSave.dataPoints.filter((_, i) => i % step === 0);
    }

    const ok = Storage.saveWorkout(toSave);
    if (!ok) {
      this.toast('Não foi possível salvar o treino (armazenamento cheio).', 'error', 6000);
      return false;
    }

    // Sync to Health Connect (async, non-blocking). Only surfaced in native builds:
    // in the browser "sync skipped" is the expected outcome, not news.
    HealthSync.syncWorkout(summary).then(result => {
      if (result.success) {
        this.toast('Treino enviado ao Health Connect', 'success');
      } else if (HealthSync.isNativeMode()) {
        console.log('[App] Health sync failed:', result.error);
        this.toast('Não foi possível enviar ao Health Connect', 'error');
      }
    });

    Storage.clearActiveWorkout();
    return true;
  }

  /** Primary summary action: Concluir (live) or Voltar (history). */
  finishSummary() {
    const mode = this.summaryMode;
    this.viewingSummary = null;
    this.showView(mode === 'history' ? 'history' : 'home');
  }

  /** Destructive summary action: Descartar (live) or Excluir (history). */
  async deleteSummary() {
    const summary = this.viewingSummary;
    if (!summary) return;

    const isLive = this.summaryMode === 'live';
    const confirmed = await this.confirm({
      title: isLive ? 'Descartar treino?' : 'Excluir treino?',
      text: isLive
        ? 'Este treino já foi salvo no histórico. Descartar vai apagá-lo definitivamente.'
        : 'Este treino será removido do histórico definitivamente.',
      confirmLabel: isLive ? 'Descartar' : 'Excluir'
    });
    if (!confirmed) return;

    Storage.deleteWorkout(summary.id);
    this.viewingSummary = null;
    this.toast('Treino excluído.', 'warning');
    this.showView(isLive ? 'home' : 'history');
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
        <div class="history-item" data-workout-id="${escapeHtml(w.id)}">
          <div class="history-icon" aria-hidden="true">🚴</div>
          <div class="history-info">
            <!-- The button is the row: its ::after overlay stretches over the whole card,
                 so the click target stays the full row while staying valid HTML (a nested
                 delete button cannot live inside another button). -->
            <button type="button" class="history-open" data-workout-id="${escapeHtml(w.id)}">
              <span class="history-date">${dateStr} · ${timeStr}${w.planName ? ` · ${escapeHtml(w.planName)}` : ''}</span>
              <span class="history-meta">${w.durationFormatted} · FC média ${w.avgBPM || '--'} bpm</span>
            </button>
          </div>
          <div class="history-cal">${w.calories} kcal</div>
          <button class="history-delete" data-delete-id="${escapeHtml(w.id)}" aria-label="Excluir treino">✕</button>
        </div>
      `;
    }).join('');

    // Bind click events
    list.querySelectorAll('.history-open').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.workoutId;
        const workout = Storage.getWorkoutById(id);
        if (workout) this.showSummaryView(workout, 'history');
      });
    });

    list.querySelectorAll('.history-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // don't open the summary behind the button
        const id = btn.dataset.deleteId;
        const confirmed = await this.confirm({
          title: 'Excluir treino?',
          text: 'Este treino será removido do histórico definitivamente.',
          confirmLabel: 'Excluir'
        });
        if (!confirmed) return;
        Storage.deleteWorkout(id);
        this.toast('Treino excluído.', 'warning');
        this.renderHistory();
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

    const allPlans = Plans.getAllPlans();

    // Filter by selected level
    const normalizeLevel = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace('+', '');
    const plans = this.planFilter === 'all'
      ? allPlans
      : allPlans.filter(p => normalizeLevel(p.difficulty).startsWith(normalizeLevel(this.planFilter)));

    if (plans.length === 0) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:0.85rem;">Nenhum treino neste nível</div>`;
      return;
    }

    container.innerHTML = plans.map(plan => {
      const dur = Plans.getPlanDuration(plan);
      const durStr = Plans.formatDuration(dur);
      const badgeClass = normalizeLevel(plan.difficulty);

      return `
        <button type="button" class="plan-card" data-plan-id="${escapeHtml(plan.id)}">
          <span class="plan-card-emoji" aria-hidden="true">${escapeHtml(plan.emoji)}</span>
          <span class="plan-card-name">${escapeHtml(plan.name)}</span>
          <span class="plan-card-meta">
            <span>${durStr}</span>
            <span aria-hidden="true">·</span>
            <span>${plan.phases.length} fases</span>
          </span>
          <span class="plan-card-badge badge-${badgeClass}">${escapeHtml(plan.difficulty)}</span>
        </button>
      `;
    }).join('');

    container.querySelectorAll('.plan-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.planId;
        const plan = allPlans.find(p => p.id === id);
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
              <span class="phase-name" style="color: ${zone.color}">${escapeHtml(phase.name)}</span>
              <span class="phase-duration">${Plans.formatDuration(phase.duration)}</span>
            </div>
            <div class="phase-targets">
              <span>❤️ ${bpm.min}-${bpm.max} bpm</span>
              <span>🔄 ${phase.rpmMin}-${phase.rpmMax} rpm</span>
            </div>
            ${phase.tip ? `<div class="phase-tip">${escapeHtml(phase.tip)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Always allow starting — sensors are optional
    const btn = document.getElementById('btn-start-guided');
    if (btn) btn.disabled = false;

    this.renderPlanLadderStatus(plan, profile);

    // Custom plans can be deleted; the 12 pre-built ones cannot.
    const delBtn = document.getElementById('btn-delete-plan');
    if (delBtn) delBtn.style.display = Plans.isCustomPlan(plan.id) ? '' : 'none';

    this.showView('plan-detail');
  }

  /** Marks where this plan sits on the ladder relative to where the rider is. */
  renderPlanLadderStatus(plan, profile) {
    const el = document.getElementById('plan-ladder-status');
    if (!el) return;

    if (!Progression.isLadderPlan(plan.id)) {
      el.hidden = true;
      return;
    }

    const state = Progression.getLadderState(profile);
    const step = state.steps.find(s => s.planId === plan.id);
    if (!step) { el.hidden = true; return; }

    const position = `Passo ${step.index + 1} de ${state.totalSteps}`;
    const labels = {
      cleared: `✓ Concluído · ${position} · melhor nota ${step.bestScore}/100`,
      current: step.attempts === 0
        ? `▶ Este treino começa aqui · ${position}`
        : `▶ Você está aqui · ${position} · melhor nota ${step.bestScore}/100`,
      locked: `🔒 ${position} · conclua os anteriores primeiro`,
    };

    el.hidden = false;
    el.className = `plan-ladder-status ${step.status}`;
    el.textContent = labels[step.status];
  }

  async deleteSelectedPlan() {
    const plan = this.selectedPlan;
    if (!plan || !Plans.isCustomPlan(plan.id)) return;

    const confirmed = await this.confirm({
      title: 'Excluir treino?',
      text: `"${plan.name}" será removido definitivamente.`,
      confirmLabel: 'Excluir'
    });
    if (!confirmed) return;

    Plans.deleteCustomPlan(plan.id);
    this.selectedPlan = null;
    this.toast('Treino excluído.', 'warning');
    this.viewStack = [];
    this.showView('home', { push: false });
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

    const planTotal = Plans.getPlanDuration(this.guidedPlan);

    // Heads-up buzz 5s before the effort changes, and again 10s before the whole thing
    // ends — riding indoors you are rarely looking at the screen.
    if (phase.duration - this.guidedPhaseElapsed === HAPTIC_WARNING_LEAD) {
      Haptics.cue('phaseWarning');
    }
    if (planTotal - this.guidedTotalElapsed === HAPTIC_FINAL_LEAD) {
      Haptics.cue('finalStretch');
    }

    // Check phase completion
    if (this.guidedPhaseElapsed >= phase.duration) {
      if (this.guidedPhaseIndex < this.guidedPlan.phases.length - 1) {
        const previousZone = phase.zone;
        this.guidedPhaseIndex++;
        this.guidedPhaseElapsed = 0;

        // Distinct pattern per direction, so the wrist alone tells you whether to push
        // or to back off.
        const nextZone = this.guidedPlan.phases[this.guidedPhaseIndex].zone;
        if (nextZone > previousZone) Haptics.cue('phaseUp');
        else if (nextZone < previousZone) Haptics.cue('phaseDown');
        else Haptics.cue('phaseSame');

        this.updateGuidedPhaseUI();
        // Flash animation
        const header = document.querySelector('.guided-header');
        if (header) {
          header.classList.add('phase-transition');
          setTimeout(() => header.classList.remove('phase-transition'), 1500);
        }
      } else {
        // Plan complete!
        Haptics.cue('workoutEnd');
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

    // Persist state every 5 seconds
    this.persistCounter++;
    if (this.persistCounter % 5 === 0) {
      this.persistWorkoutState('guided');
    }
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
    this.closeModal('guided-stop-modal');

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.recorder) {
      this.recorder.stop();
      this.viewingSummary = this.recorder.getSummary();
      if (this.viewingSummary && this.guidedPlan) {
        this.viewingSummary.planName = this.guidedPlan.name;
        // planId is what lets the progression engine grade this session later.
        this.viewingSummary.planId = this.guidedPlan.id;
      }
    }

    Haptics.cancel();

    this.persistSummary(this.viewingSummary);

    this.releaseWakeLock();
    this.guidedPlan = null;
    this.showSummaryView(this.viewingSummary, 'live');
  }

  // ══════════════════════════════════════════
  // WORKOUT PERSISTENCE & RECOVERY
  // ══════════════════════════════════════════

  persistWorkoutState(type) {
    if (!this.recorder) return;

    const state = {
      type, // 'free' or 'guided'
      demoMode: this.demoMode,
      recorder: this.recorder.getState(),
      savedAt: Date.now()
    };

    if (type === 'guided' && this.guidedPlan) {
      state.planId = this.guidedPlan.id;
      state.guidedPhaseIndex = this.guidedPhaseIndex;
      state.guidedPhaseElapsed = this.guidedPhaseElapsed;
      state.guidedTotalElapsed = this.guidedTotalElapsed;
    }

    try {
      // Limit dataPoints to avoid localStorage quota issues
      const toSave = { ...state };
      toSave.recorder = { ...state.recorder };
      if (toSave.recorder.dataPoints && toSave.recorder.dataPoints.length > 300) {
        const step = Math.ceil(toSave.recorder.dataPoints.length / 300);
        toSave.recorder.dataPoints = toSave.recorder.dataPoints.filter((_, i) => i % step === 0);
      }
      Storage.saveActiveWorkout(toSave);
    } catch (e) {
      console.warn('Failed to persist workout state:', e);
    }
  }

  checkWorkoutRecovery() {
    const saved = Storage.getActiveWorkout();
    if (!saved || !saved.recorder) return;

    // Calculate elapsed time from saved state
    const elapsed = saved.recorder.elapsedMs || 0;
    const totalSec = Math.floor(elapsed / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const durStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

    const calories = Math.round(saved.recorder.totalCalories || 0);

    let typeLabel = 'Treino Livre';
    if (saved.type === 'guided' && saved.planId) {
      const plan = Plans.getAllPlans().find(p => p.id === saved.planId);
      typeLabel = plan ? plan.name : 'Treino Guiado';
    }

    // Fill modal info
    document.getElementById('recovery-duration').textContent = durStr;
    document.getElementById('recovery-calories').textContent = `${calories} kcal`;
    document.getElementById('recovery-type').textContent = typeLabel;

    // Show modal
    this.openModal('recovery-modal');
  }

  resumeFromRecovery() {
    this.closeModal('recovery-modal');

    const saved = Storage.getActiveWorkout();
    if (!saved || !saved.recorder) {
      Storage.clearActiveWorkout();
      return;
    }

    if (saved.type === 'guided') {
      this.resumeGuidedWorkout(saved);
    } else {
      this.resumeWorkout(saved);
    }
  }

  discardRecovery() {
    this.closeModal('recovery-modal');
    Storage.clearActiveWorkout();
  }

  resumeWorkout(saved) {
    const profile = saved.recorder.profile || Storage.getProfile();
    if (!profile) return;

    this.recorder = new WorkoutRecorder(profile);
    this.recorder.restoreState(saved.recorder);

    this.demoMode = saved.demoMode || false;
    this.realtimeBPMHistory = [];
    this.realtimeRPMHistory = [];

    // Restore BPM/RPM display from last known values
    this.updateWorkoutBPM(this.recorder.currentBPM);
    this.updateWorkoutRPM(this.recorder.currentRPM);
    document.getElementById('workout-timer').textContent = this.recorder.getFormattedTime();
    document.getElementById('workout-calories').textContent = Math.round(this.recorder.totalCalories);

    // Set pause button state (restored as paused)
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) {
      pauseBtn.classList.add('paused');
      pauseBtn.innerHTML = '▶ Retomar';
    }

    // Show workout view
    this.showView('workout');
    this.requestWakeLock();

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

    // Setup BLE if demo mode
    if (this.demoMode) {
      this.getBLE();
    }
  }

  resumeGuidedWorkout(saved) {
    const profile = saved.recorder.profile || Storage.getProfile();
    if (!profile) return;

    // Find the plan
    const plan = Plans.getAllPlans().find(p => p.id === saved.planId);
    if (!plan) {
      // Plan not found, fall back to free workout resume
      this.resumeWorkout(saved);
      return;
    }

    this.guidedPlan = plan;
    this.guidedPhaseIndex = saved.guidedPhaseIndex || 0;
    this.guidedPhaseElapsed = saved.guidedPhaseElapsed || 0;
    this.guidedTotalElapsed = saved.guidedTotalElapsed || 0;
    this.demoMode = saved.demoMode || false;

    this.recorder = new WorkoutRecorder(profile);
    this.recorder.restoreState(saved.recorder);

    // Show guided view
    this.showView('guided');
    this.requestWakeLock();
    this.updateGuidedPhaseUI();

    document.getElementById('guided-plan-name').textContent = this.guidedPlan.name;
    document.getElementById('guided-calories').textContent = Math.round(this.recorder.totalCalories);

    // Set pause button state (restored as paused)
    const pauseBtn = document.getElementById('btn-guided-pause');
    if (pauseBtn) {
      pauseBtn.classList.add('paused');
      pauseBtn.innerHTML = '▶ Retomar';
    }

    // Update timers
    const phase = this.guidedPlan.phases[this.guidedPhaseIndex];
    if (phase) {
      this.updateGuidedTimers(phase);
    }

    // Overall progress
    const total = Plans.getPlanDuration(this.guidedPlan);
    const pct = Math.min(100, (this.guidedTotalElapsed / total) * 100);
    const fill = document.getElementById('guided-overall-fill');
    if (fill) fill.style.width = `${pct}%`;

    // Start tick
    this.tickInterval = setInterval(() => this.guidedTick(), 1000);

    // Setup BLE if demo mode
    if (this.demoMode) {
      this.getBLE();
    }
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
        <div class="creator-phase-num" id="phase-${i}-num">Fase ${i + 1}</div>
        <button class="creator-phase-remove" data-idx="${i}" aria-label="Remover fase ${i + 1}">✕</button>
        <div class="form-group" style="margin-bottom:8px">
          <!-- Every input carries a real id/for pair. A placeholder is not a label: it
               disappears on focus and screen readers may skip it entirely. -->
          <label class="sr-only" for="phase-${i}-name">Nome da fase ${i + 1}</label>
          <input type="text" id="phase-${i}-name" class="form-input" data-field="name" data-idx="${i}" value="${escapeHtml(phase.name)}" placeholder="Nome da fase">
        </div>
        <div class="form-row-3">
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label-xs" for="phase-${i}-duration">Duração (min)</label>
            <input type="number" id="phase-${i}-duration" class="form-input" data-field="duration" data-idx="${i}" value="${Math.round(phase.duration / 60)}" min="1" max="60">
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label-xs" for="phase-${i}-zone">Zona FC</label>
            <select class="form-select" id="phase-${i}-zone" data-field="zone" data-idx="${i}">
              ${ZONES.map(z => `<option value="${z.id}" ${z.id === phase.zone ? 'selected' : ''}>Z${z.id}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label-xs" for="phase-${i}-rpm">RPM</label>
            <input type="text" id="phase-${i}-rpm" class="form-input" data-field="rpm" data-idx="${i}" value="${phase.rpmMin}-${phase.rpmMax}" placeholder="60-80">
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
    const nameInput = document.getElementById('creator-name');
    const name = nameInput.value.trim();
    if (!name) {
      this.toast('Dê um nome ao treino.', 'error');
      nameInput.focus();
      return;
    }
    if (this.creatorPhases.length === 0) {
      this.toast('Adicione pelo menos uma fase.', 'error');
      return;
    }

    const plan = {
      id: 'custom_' + Date.now(),
      name,
      emoji: document.getElementById('creator-emoji').value || '🔥',
      description: document.getElementById('creator-desc').value || '',
      difficulty: document.getElementById('creator-difficulty').value,
      focus: 'Personalizado',
      phases: this.creatorPhases.map(p => ({ ...p })),
    };

    if (Plans.saveCustomPlan(plan)) {
      this.toast('Treino personalizado salvo.', 'success');
    } else {
      this.toast('Não foi possível salvar o treino.', 'error');
    }
    this.showView('home');
  }
}

/** Seconds of warning before a phase change and before the workout ends. */
const HAPTIC_WARNING_LEAD = 5;
const HAPTIC_FINAL_LEAD = 10;

/** Plan and phase names are user input rendered through innerHTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Boot ──

/**
 * Last line of defence. If construction throws, the app used to render nothing at all
 * — a black screen with no way for the user to recover short of reinstalling.
 */
function showBootError(error) {
  console.error('[App] Boot failed:', error);
  if (document.querySelector('.boot-error')) return;

  const screen = document.createElement('div');
  screen.className = 'boot-error';
  screen.innerHTML = `
    <div style="font-size:2.5rem">🚴</div>
    <h2>Não foi possível abrir o SpinSync</h2>
    <p>Os dados salvos parecem estar corrompidos.</p>
  `;

  const retry = document.createElement('button');
  retry.className = 'btn btn-secondary btn-full';
  retry.textContent = 'Tentar de novo';
  retry.addEventListener('click', () => location.reload());

  const reset = document.createElement('button');
  reset.className = 'btn btn-danger btn-full';
  reset.textContent = 'Apagar dados e recomeçar';
  reset.addEventListener('click', () => {
    Storage.clearAll();
    location.reload();
  });

  screen.append(retry, reset);
  document.body.appendChild(screen);
}

document.addEventListener('DOMContentLoaded', () => {
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  try {
    window.app = new SpinSyncApp();
  } catch (e) {
    showBootError(e);
  }
});
