import { createBLEManager, BLESimulator, PHASE_SHIFT } from './ble-manager.js';
import { WorkoutRecorder } from './workout-recorder.js';
import { WorkoutCharts } from './charts.js';
import { ZoneCalculator, ZONES } from './zone-calculator.js';
import* as Storage from './storage.js';
import * as Plans from './training-plans.js';
import * as Analytics from './analytics.js';
import * as HealthSync from './health-sync.js';
import * as Progression from './progression.js';
import * as Haptics from './haptics.js';
import { buildTCX, tcxFilename } from './tcx-export.js';
import * as AutoBackup from './auto-backup.js';
import * as WorkoutService from './workout-service.js';
import * as Personalization from './personalization.js';
import * as Goals from './goals.js';

/** Sem cadência por este tempo com o sensor conectado = parou de pedalar. */
const AUTO_PAUSE_AFTER_MS = 8000;
/** Abaixo disto a roda está apenas girando por inércia, não é pedalada. */
const AUTO_RESUME_RPM = 5;

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

    // Auto-pause: distinto da pausa manual, para que um toque deliberado nunca seja desfeito
    // pelo sensor e vice-versa.
    this.autoPaused = false;
    this.lastPedalAt = 0;

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

    // Treino de hoje (personalization.js) e a prontidão lida do Health Connect, que chega
    // depois, de forma assíncrona, e pode mudar a recomendação.
    this.todayRecommendation = null;
    this._readiness = null;

    this.init();
  }

  init() {
    // Check if profile exists
    const profile = Storage.getProfile();
    if (!profile) {
      // What the app needs to work comes before what it needs to know about you.
      this.showView('welcome');
    } else {
      this.showView('home');
    }

    this.bindEvents();
    this.setupBackHandler();
    this.setupModalDismiss();
    this.setupLifecycleHandlers();
    this.updateBottomNav();

    // Check for active workout to recover
    this.checkWorkoutRecovery();

    this.applySettings();

    // Initialize Health Connect, then reflect its real state in the profile screen.
    HealthSync.init().then(() => this.updateHealthCard());

    // Backup on launch rather than on a timer: the app is opened around rides, which is
    // exactly when there is something new worth keeping.
    AutoBackup.init().then(async (ok) => {
      if (!ok) return;
      await AutoBackup.maybeBackup();
      this.updateBackupCard();
    });

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
    document.getElementById('nav-progress')?.addEventListener('click', () => showRoot('analytics'));
    document.getElementById('nav-profile')?.addEventListener('click', () => showRoot('profile'));

    // Progresso tem duas faces — visão geral e lista de treinos — sob uma aba só.
    document.querySelectorAll('[data-progress]').forEach(btn => {
      btn.addEventListener('click', () => showRoot(btn.dataset.progress));
    });

    // Treino de hoje
    document.getElementById('btn-today-start')?.addEventListener('click', () => this.startToday());
    document.getElementById('btn-today-detail')?.addEventListener('click', () => {
      if (this.todayRecommendation?.plan) this.openPlanDetail(this.todayRecommendation.plan);
    });
    document.getElementById('btn-calibration-apply')?.addEventListener('click', () => this.applyCalibration());
    document.getElementById('btn-calibration-dismiss')?.addEventListener('click', () => this.dismissCalibration());
    document.getElementById('btn-plan-original')?.addEventListener('click', () => {
      const base = Plans.getAllPlans().find(p => p.id === this.selectedPlan?.id);
      if (base) this.showPlanDetail(base);
    });
    document.getElementById('setting-gear')?.addEventListener('change', (e) => {
      Storage.saveSettings({ virtualGear: e.target.value });
      this.updateGearHint();
    });

    // Analytics Filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.renderAnalytics(e.target.dataset.period);
      });
    });

    // Sensor connections
    // O botão muda de função quando o Bluetooth está desligado — ver updateSensorStatus.
    document.getElementById('btn-connect-hr')?.addEventListener('click', (e) => {
      if (e.currentTarget.dataset.action === 'enable-bt') this.enableBluetooth('hr');
      else this.connectHR();
    });
    document.getElementById('btn-connect-csc')?.addEventListener('click', (e) => {
      if (e.currentTarget.dataset.action === 'enable-bt') this.enableBluetooth('csc');
      else this.connectCSC();
    });

    // Demo toggle
    // Live zone preview while the numbers that drive it are being edited.
    ['#input-age', '#input-rhr', '#input-maxhr'].forEach(sel => {
      document.querySelector(sel)?.addEventListener('input', () => this.updateZonePreview());
    });

    document.getElementById('btn-welcome-start')?.addEventListener('click', () => this.showView('profile'));
    document.getElementById('btn-skip-step')?.addEventListener('click', () => this.skipCurrentStep());
    document.getElementById('btn-reset-progression')?.addEventListener('click', () => this.resetProgression());

    document.getElementById('demo-toggle')?.addEventListener('change', (e) => this.toggleDemo(e.target.checked));

    // Settings
    document.getElementById('setting-haptics')?.addEventListener('change', (e) => {
      Storage.saveSettings({ haptics: e.target.checked });
      Haptics.setEnabled(e.target.checked);
      if (e.target.checked) Haptics.cue('phaseWarning'); // confirm it actually buzzes
    });
    // On blur rather than per keystroke: one storage write per edit, not per letter.
    document.getElementById('workout-note')?.addEventListener('blur', () => this.persistSummaryEdits());

    document.getElementById('setting-autopause')?.addEventListener('change', (e) => {
      Storage.saveSettings({ autoPause: e.target.checked });
    });
    document.getElementById('setting-wheel')?.addEventListener('change', (e) => {
      const mm = Math.max(800, Math.min(3000, parseInt(e.target.value, 10) || 2096));
      e.target.value = mm;
      Storage.saveSettings({ wheelCircumferenceMm: mm });
      // Aplica já no parser em uso, senão só valeria na próxima conexão.
      this.ble?.cadenceParser?.setWheelCircumference(mm);
    });
    document.getElementById('setting-goal')?.addEventListener('change', (e) => {
      const goal = Math.max(0, Math.min(14, parseInt(e.target.value, 10) || 0));
      e.target.value = goal;
      Storage.saveSettings({ weeklyGoal: goal });
      this.updateHomeView();
    });
    document.getElementById('btn-health-connect')?.addEventListener('click', () => this.connectHealth());

    // Backup
    document.getElementById('btn-export-data')?.addEventListener('click', () => this.exportData());
    document.getElementById('btn-backup-now')?.addEventListener('click', () => this.backupNow());
    document.getElementById('btn-export-tcx')?.addEventListener('click', () => this.exportTCX());
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
    document.getElementById('btn-lap')?.addEventListener('click', () => this.markLap());
    document.getElementById('btn-guided-lap')?.addEventListener('click', () => this.markLap());
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
    document.getElementById('history-search')?.addEventListener('input', () => this.renderHistory());
    document.getElementById('btn-edit-plan')?.addEventListener('click', () => this.editSelectedPlan());
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

    // As abas de categoria são desenhadas por renderPlanLibrary (dependem de existirem
    // treinos personalizados); um listener delegado sobrevive a cada redesenho.
    document.getElementById('plan-filter-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-category]');
      if (!tab) return;
      this.planFilter = tab.dataset.category;
      this.renderPlanLibrary();
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
        this.renderPlanLibrary();
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
    // Três abas para mais telas que isso: cada tela acende a aba a que pertence.
    const TAB_OF = {
      home: 'home', 'plan-detail': 'home', 'plan-creator': 'home',
      analytics: 'progress', history: 'progress',
      profile: 'profile',
    };
    const tab = TAB_OF[this.currentView];
    document.querySelectorAll('.nav-item').forEach(item => {
      const isCurrent = !!tab && item.id === `nav-${tab}`;
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

  /**
   * Zone calculator for the current profile.
   *
   * Replaces three separate copies of `220 - profile.age` that had drifted into the
   * guided-workout screens, each with its own fallback. Cheap to build (a handful of
   * arithmetic), so it is not cached — a stale one after a profile edit would be a much
   * nastier bug than the allocation is a cost.
   */
  zoneCalcForProfile() {
    return new ZoneCalculator(Storage.getProfile() || {});
  }

  // ── Settings ──

  /** Pushes stored preferences into the modules that own them, and into the UI. */
  applySettings() {
    const settings = Storage.getSettings();
    Haptics.setEnabled(settings.haptics);

    const set = (id, value, prop = 'checked') => {
      const el = document.getElementById(id);
      if (el) el[prop] = value;
    };
    set('setting-haptics', settings.haptics);
    set('setting-autopause', settings.autoPause);
    set('setting-goal', settings.weeklyGoal, 'value');
    set('setting-wheel', settings.wheelCircumferenceMm, 'value');
    set('setting-gear', settings.virtualGear || 'media', 'value');
    this.updateGearHint();
    this.updateProgressionSettings();
    // O modo demo é de sessão, não persistido — mas o interruptor e os banners precisam
    // refletir o estado atual ao entrar no perfil.
    this.updateDemoBanner();
  }

  /** Traduz a marcha virtual em algo palpável: a velocidade que ela implica. */
  updateGearHint() {
    const el = document.getElementById('setting-gear-desc');
    if (!el) return;
    const m = Goals.metersPerRev();
    el.textContent = `Sem sensor de roda, a distância sai das pedaladas: ${String(m).replace('.', ',')} m `
      + `cada uma, cerca de ${Goals.speedAt(80, m)} km/h a 80 rpm. Serve para comparar você com você mesmo.`;
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
  confirm({ title = 'Confirmar', text = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = true }) {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return Promise.resolve(false);

    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    // Sempre reescrito: um rótulo custom não pode vazar para o próximo diálogo.
    document.getElementById('btn-confirm-cancel').textContent = cancelLabel;

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
    f.querySelector('#input-height').value = profile.height || '';
    f.querySelector('#input-rhr').value = profile.restingHR || '';
    f.querySelector('#input-maxhr').value = profile.maxHR || '';
    this.updateZonePreview();
  }

  /**
   * Shows the actual zone boundaries the profile produces.
   *
   * Max HR and resting HR are abstract numbers; "Z4 começa em 158 bpm" is the thing the
   * rider can sanity-check against what they see on the bike.
   */
  updateZonePreview() {
    const host = document.getElementById('zone-preview');
    if (!host) return;

    const f = document.getElementById('profile-form');
    const draft = {
      age: parseInt(f.querySelector('#input-age').value, 10),
      restingHR: parseInt(f.querySelector('#input-rhr').value, 10),
      maxHR: parseInt(f.querySelector('#input-maxhr').value, 10),
    };
    if (!Number.isFinite(draft.age)) { host.hidden = true; return; }

    const calc = new ZoneCalculator(draft);
    host.hidden = false;
    host.innerHTML = `
      <div class="zone-preview-head">
        <span>FC máx ${calc.getMaxHR()} bpm</span>
        <span>${calc.isReserveBased() ? 'reserva de FC' : '% da FC máx'}</span>
      </div>
      ${calc.getZoneBounds().map(z => `
        <div class="zone-preview-row">
          <span class="zone-preview-dot" style="background:${z.color}"></span>
          <span class="zone-preview-name">Z${z.id} ${escapeHtml(z.name)}</span>
          <span class="zone-preview-range">${z.minBPM}–${z.maxBPM}</span>
        </div>`).join('')}
    `;
  }

  saveProfile() {
    const f = document.getElementById('profile-form');

    const name = f.querySelector('#input-name').value.trim();
    const age = parseInt(f.querySelector('#input-age').value, 10);
    const weight = parseFloat(f.querySelector('#input-weight').value);
    const height = parseInt(f.querySelector('#input-height').value, 10);
    const restingHR = parseInt(f.querySelector('#input-rhr').value, 10);
    const maxHR = parseInt(f.querySelector('#input-maxhr').value, 10);
    const filled = (sel) => f.querySelector(sel).value !== '';

    // Silently coercing a bad weight to 70 kg made every calorie number afterwards
    // wrong without the user ever knowing.
    const problems = [
      [!name, '#input-name', 'Informe seu nome.'],
      [!Number.isFinite(age) || age < 10 || age > 100, '#input-age', 'Idade deve estar entre 10 e 100 anos.'],
      [!Number.isFinite(weight) || weight < 30 || weight > 300, '#input-weight', 'Peso deve estar entre 30 e 300 kg.'],
      [filled('#input-height') && (!Number.isFinite(height) || height < 100 || height > 250),
        '#input-height', 'Altura deve estar entre 100 e 250 cm.'],
      [filled('#input-rhr') && (!Number.isFinite(restingHR) || restingHR < 30 || restingHR > 120),
        '#input-rhr', 'FC de repouso deve estar entre 30 e 120 bpm.'],
      [filled('#input-maxhr') && (!Number.isFinite(maxHR) || maxHR < 120 || maxHR > 230),
        '#input-maxhr', 'FC máxima deve estar entre 120 e 230 bpm.'],
      // A max at or below resting would make the heart-rate reserve zero or negative and
      // every zone boundary nonsense.
      [filled('#input-maxhr') && filled('#input-rhr') && Number.isFinite(maxHR)
        && Number.isFinite(restingHR) && maxHR <= restingHR + 40,
        '#input-maxhr', 'FC máxima deve ser bem maior que a de repouso.'],
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
      height: Number.isFinite(height) ? height : null,
      restingHR: Number.isFinite(restingHR) ? restingHR : 60,
      // null, not a prediction: getMaxHR() falls back to Tanaka, and storing the estimate
      // would make it indistinguishable from a measured value on the next edit.
      maxHR: Number.isFinite(maxHR) ? maxHR : null,
    });

    this.toast(saved ? 'Perfil salvo.' : 'Não foi possível salvar o perfil.', saved ? 'success' : 'error');
    if (saved) this.showView('home');
  }

  // ── Backup ──

  async exportData() {
    try {
      const payload = Storage.exportAll();
      const stamp = new Date().toISOString().slice(0, 10);
      const where = await this.saveFile(
        JSON.stringify(payload, null, 2), `spinsync-backup-${stamp}.json`, 'application/json'
      );
      this.toast(`Backup com ${payload.workouts.length} treino(s) salvo${where ? ` em ${where}` : ''}.`, 'success', 6000);
    } catch (e) {
      console.error('[App] Export failed:', e);
      this.toast('Não foi possível gerar o backup.', 'error');
    }
  }

  async updateBackupCard() {
    const row = document.getElementById('auto-backup-row');
    if (!row) return;
    row.hidden = !AutoBackup.isAvailable();
    if (row.hidden) return;

    const status = document.getElementById('auto-backup-status');
    if (!status) return;
    const last = await AutoBackup.getLastBackupLabel();
    // Dizer ONDE é o que importa: só a cópia em Documentos sobrevive a desinstalar o app.
    // E ela é legível por outros apps com acesso a arquivos — o usuário merece saber.
    const where = AutoBackup.getLastBackupWhere() === 'data'
      ? 'na memória interna do app — é apagado se o app for desinstalado'
      : 'em Documentos/SpinSync — sobrevive à desinstalação e fica visível para apps com acesso a arquivos';
    status.textContent = last
      ? `Último backup automático: ${last}, ${where}. São mantidas as 5 cópias mais recentes.`
      : 'Ainda sem backup automático.';
  }

  async backupNow() {
    const result = await AutoBackup.maybeBackup(true);
    this.toast(
      result
        ? `Backup salvo em ${result.where === 'documents' ? result.path : 'memória interna do app'} (${result.workouts} treino(s)).`
        : 'Não foi possível salvar o backup.',
      result ? 'success' : 'error', 6000
    );
    this.updateBackupCard();
  }

  /**
   * Caminho comum do backup JSON e do TCX.
   *
   * No APK, `<a download>` de blob não faz nada — a WebView do Capacitor não tem
   * DownloadListener —, então lá o arquivo vai por Filesystem para Documentos/SpinSync.
   *
   * @returns {Promise<string|null>} onde o arquivo ficou, para o toast; null no navegador,
   *   onde é o próprio navegador quem mostra o download.
   */
  async saveFile(contents, filename, mime) {
    if (AutoBackup.isAvailable()) {
      const result = await AutoBackup.writeUserFile(filename, contents);
      if (!result) throw new Error('Filesystem recusou a gravação');
      return result.where === 'documents' ? result.path : 'memória interna do app';
    }

    const url = URL.createObjectURL(new Blob([contents], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return null;
  }

  /** Exports the summary on screen in a format other training apps can read. */
  async exportTCX() {
    const summary = this.viewingSummary;
    if (!summary) return;
    try {
      const where = await this.saveFile(buildTCX(summary), tcxFilename(summary), 'application/vnd.garmin.tcx+xml');
      this.toast(
        `Arquivo TCX salvo${where ? ` em ${where}` : ''} — abre no Strava e no Garmin Connect.`,
        'success', 6000
      );
    } catch (e) {
      console.error('[App] TCX export failed:', e);
      this.toast('Não foi possível gerar o TCX.', 'error');
    }
  }

  async importData(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const { workouts, plans, skipped } = Storage.importAll(payload);
      this.toast(
        `Importado: ${workouts} treino(s), ${plans} plano(s).`
          + (skipped ? ` ${skipped} registro(s) ignorado(s) por formato inválido.` : ''),
        'success'
      );
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

    const date = document.getElementById('home-date');
    if (date) {
      const label = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' });
      date.textContent = label.charAt(0).toUpperCase() + label.slice(1);
    }
    const greeting = document.getElementById('home-greeting');
    if (greeting) greeting.textContent = profile.name ? `Olá, ${profile.name}` : 'Treinar';

    this.renderToday();
    this.renderCalibration();
    this.renderWeekCard();
    // Assíncrono: lê do Health Connect, e o card aparece sozinho quando houver dado.
    this.renderReadiness().catch(() => {});
    this.renderCoachCard();
    this.updateSensorUI();
    this.updateStartButton();
  }

  /**
   * O treino de hoje, com a razão por escrito.
   *
   * Redesenhado de novo quando a prontidão chega do Health Connect: uma noite ruim muda a
   * sugestão, e ela não pode depender de o usuário recarregar a tela.
   */
  renderToday() {
    const card = document.getElementById('today-card');
    if (!card) return;

    let rec;
    try {
      rec = Personalization.recommend(Personalization.getAthleteContext(), this._readiness);
    } catch (e) {
      // A home nunca pode cair por causa da recomendação: o resto da tela segue útil.
      console.error('[App] recommend falhou:', e);
      rec = null;
    }
    this.todayRecommendation = rec;
    if (!rec?.plan) { card.hidden = true; return; }
    card.hidden = false;

    const plan = rec.plan;
    const zoneCalc = this.zoneCalcForProfile();
    // A zona e a cadência "do treino" são as da fase principal: a mais longa entre o
    // aquecimento e a volta à calma. É o número que decide se dá para encarar.
    const main = plan.phases.slice(1, -1).reduce((a, b) => (b.duration > (a?.duration || 0) ? b : a), null)
      || plan.phases[0];
    const bpm = Plans.resolvePhaseBPM(main, zoneCalc);

    const categoryName = Plans.getPlanCategory(plan).name;
    document.getElementById('today-kind').textContent = rec.title;
    const tag = document.getElementById('today-category');
    tag.textContent = categoryName;
    tag.hidden = categoryName.toLowerCase() === rec.title.toLowerCase();
    document.getElementById('today-plan-name').textContent = plan.name;
    document.getElementById('today-meta').textContent = [
      Plans.formatDuration(Plans.getPlanDuration(plan)),
      `Z${main.zone} ${bpm.min}–${bpm.max} bpm`,
      `${main.rpmMin}–${main.rpmMax} rpm`,
    ].join(' · ');
    document.getElementById('today-reasons').innerHTML = rec.reasons
      .map(r => `<li>${escapeHtml(r)}</li>`).join('');
  }

  startToday() {
    const plan = this.todayRecommendation?.plan;
    if (!plan) return;
    this.selectedPlan = plan;
    this.startGuidedWorkout();
  }

  /**
   * FC máxima observada acima da estimada por idade: sugere atualizar o perfil.
   *
   * Todas as zonas saem desse número, então um valor real vale mais do que qualquer ajuste
   * de treino. Só sugere: um pico espúrio do sensor não pode mudar as zonas sozinho.
   */
  renderCalibration() {
    const card = document.getElementById('calibration-card');
    if (!card) return;
    const profile = Storage.getProfile();
    const s = Personalization.maxHRSuggestion(profile, Storage.getWorkouts().filter(Storage.countsAsTraining));
    const dismissed = Storage.getSettings().dismissedMaxHR || 0;
    if (!s || s.observed <= dismissed) { card.hidden = true; this._calibration = null; return; }

    this._calibration = s;
    card.hidden = false;
    const when = new Date(s.date).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });
    document.getElementById('calibration-text').textContent =
      `Sua FC chegou a ${s.observed} bpm em ${when}, acima dos ${s.estimate} bpm estimados pela idade. `
      + 'Usar o valor real deixa todas as zonas mais precisas.';
  }

  applyCalibration() {
    const s = this._calibration;
    const profile = Storage.getProfile();
    if (!s || !profile) return;
    if (Storage.saveProfile({ ...profile, maxHR: s.observed })) {
      this.toast(`FC máxima atualizada para ${s.observed} bpm.`, 'success');
    }
    this.updateHomeView();
  }

  dismissCalibration() {
    // Lembra o valor recusado: só volta a sugerir se aparecer um pico ainda maior.
    if (this._calibration) Storage.saveSettings({ dismissedMaxHR: this._calibration.observed });
    this.renderCalibration();
  }

  /**
   * Prontidão: o que o relógio mediu dormindo, cruzado com a carga recente.
   *
   * Nenhuma das métricas vale sozinha — o valor absoluto de RMSSD varia enormemente entre
   * pessoas. O que informa é o desvio em relação à sua própria linha de base, e o
   * cruzamento: carga subindo com HRV caindo é o padrão que antecede estagnação. Os
   * limiares vivem em personalization.readinessFlags, os mesmos que a recomendação usa.
   */
  async renderReadiness() {
    const card = document.getElementById('readiness-card');
    if (!card) return;

    const recovery = await HealthSync.getRecovery();
    if (!recovery) { card.hidden = true; return; }
    card.hidden = false;

    const readiness = Personalization.readinessFlags(recovery, Analytics.getTrainingLoad());
    const changed = readiness.level !== this._readiness?.level;
    this._readiness = readiness;
    if (changed) this.renderToday();

    const verdict = readiness.level === 'red' ? 'Incompleta'
      : readiness.level === 'yellow' ? 'Parcial'
        : 'Boa';
    const verdictEl = document.getElementById('readiness-verdict');
    verdictEl.textContent = verdict;
    verdictEl.dataset.level = readiness.level;

    document.getElementById('readiness-text').textContent = readiness.reasons.length
      ? `${readiness.reasons.join(', ')}. ${readiness.level === 'red' ? 'Prefira um treino leve hoje.' : 'Dá para treinar, sem forçar o topo.'}`
      : 'Sinais noturnos dentro da sua média.';

    // Valores vêm do Health Connect como números, então não passam por escapeHtml.
    const metrics = [];
    if (recovery.hrv) metrics.push(`<span>HRV <strong>${recovery.hrv} ms</strong></span>`);
    if (recovery.restingHR) metrics.push(`<span>Repouso <strong>${recovery.restingHR} bpm</strong></span>`);
    if (recovery.sleepHours !== null) metrics.push(`<span>Sono <strong>${formatDecimal(recovery.sleepHours)} h</strong></span>`);
    document.getElementById('readiness-metrics').innerHTML = metrics.join('');
  }

  /**
   * A semana: treinos contra a meta, minutos e distância.
   *
   * A tela de progresso responde "o que eu fiz"; esta responde "estou no caminho", que é
   * a pergunta que põe alguém de volta na bike numa terça-feira.
   */
  renderWeekCard() {
    const card = document.getElementById('goal-card');
    if (!card) return;

    const { weeklyGoal } = Storage.getSettings();
    const { done, streak, met } = Analytics.getGoalProgress(weeklyGoal || 0);
    card.hidden = false;

    const weekStart = Analytics.startOfWeek();
    const week = Storage.getWorkouts()
      .filter(Storage.countsAsTraining)
      .filter(w => new Date(w.date) >= weekStart);
    const minutes = Math.round(week.reduce((s, w) => s + (w.durationSeconds || 0), 0) / 60);
    const mPerRev = Goals.metersPerRev();
    const km = week.reduce((s, w) => s + Goals.workoutDistance(w, mPerRev).m, 0) / 1000;

    document.getElementById('week-sessions').textContent = done;
    document.getElementById('week-sessions-unit').textContent = weeklyGoal
      ? `de ${weeklyGoal} treinos` : (done === 1 ? 'treino' : 'treinos');
    document.getElementById('week-minutes').textContent = minutes;
    document.getElementById('week-km').textContent = formatDecimal(km);

    const fill = document.getElementById('goal-bar-fill');
    if (fill) {
      fill.style.width = weeklyGoal ? `${Math.min(100, (done / weeklyGoal) * 100)}%` : '0%';
      fill.parentElement.hidden = !weeklyGoal;
    }

    const title = document.getElementById('goal-title');
    if (title) {
      const remaining = Math.max(0, (weeklyGoal || 0) - done);
      title.textContent = !weeklyGoal ? 'Sem meta semanal. Defina uma no Perfil.'
        : met ? 'Meta da semana cumprida.'
          : `Falta${remaining > 1 ? 'm' : ''} ${remaining} para a meta.`;
    }

    // Só vale mostrar quando já é uma sequência, não uma semana isolada.
    const streakEl = document.getElementById('goal-streak');
    if (streakEl) {
      streakEl.hidden = streak < 2;
      streakEl.textContent = `${streak} semanas seguidas`;
    }
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
    this.openPlanDetail(plan);
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

    if (!evaluation) {
      card.hidden = true;
      return;
    }

    // Planos personalizados eram avaliados por completo e o resultado jogado fora aqui.
    // Eles não têm lugar na escada — não são calibrados — mas a nota e a aderência valem
    // igual: dizem se você segurou o que o SEU plano pediu.
    const onLadder = Progression.isLadderPlan(summary.planId);

    // Only sessions *before* this one count as prior evidence.
    const previous = Progression.getSessionsFor(summary.planId, profile)
      .filter(e => e.date !== summary.date);
    const verdict = onLadder
      ? Progression.judge(evaluation, previous)
      : Progression.judgeCustom(evaluation);

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
    this.openPlanDetail(plan);
  }

  toggleDemo(enabled) {
    this.demoMode = enabled === undefined ? !this.demoMode : !!enabled;
    this.updateDemoBanner();

    // Reset connections when toggling
    if (this.ble) {
      this.ble.disconnectAll();
    }
    this.ble = null;

    this.updateSensorUI();
    this.updateStartButton();
  }

  /** O aviso vive na home e na tela de treino, não só onde fica o interruptor. */
  updateDemoBanner() {
    document.querySelectorAll('.demo-banner').forEach(el => { el.hidden = !this.demoMode; });
    const toggle = document.getElementById('demo-toggle');
    if (toggle) toggle.checked = this.demoMode;
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
      const rpm = e.detail.rpm;

      // Outside the paused guard on purpose: pedalling again is exactly the signal that
      // ends an auto-pause, and inside the guard it would never be seen.
      if (rpm >= AUTO_RESUME_RPM) {
        this.lastPedalAt = Date.now();
        if (this.autoPaused) this.resumeFromAutoPause();
      }

      if (this.recorder && !this.recorder.isPaused) {
        if (rpm !== undefined) {
          this.recorder.updateRPM(rpm);
          this.updateWorkoutRPM(rpm);
        }
        // Um sensor só de velocidade não manda rpm nenhum — antes ele era ignorado por
        // completo mesmo estando conectado.
        this.recorder.updateWheel(e.detail);
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
      // Bluetooth desligado tem uma ação óbvia — ligar. Era só um rótulo, e o app ficava
      // tentando reconectar em silêncio contra um adaptador desligado.
      const isBtOff = status === 'bt-off';
      btn.className = `sensor-btn ${isConnected || isReconnecting ? 'disconnect' : 'connect'}`;
      btn.textContent = isBtOff ? 'Ligar Bluetooth'
        : isConnected ? 'Desconectar'
          : isReconnecting ? 'Cancelar' : 'Conectar';
      btn.disabled = status === 'scanning' || status === 'connecting';
      btn.dataset.action = isBtOff ? 'enable-bt' : '';
    }
  }

  /** Pede o Bluetooth e, se o usuário ligar, retoma a conexão do sensor. */
  async enableBluetooth(kind) {
    const ble = this.getBLE();
    if (!ble?.requestBluetooth) return;
    const on = await ble.requestBluetooth();
    if (!on) {
      this.toast('O Bluetooth continua desligado.', 'error');
      return;
    }
    if (kind === 'hr') this.connectHR();
    else this.connectCSC();
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

    this.recorder = new WorkoutRecorder(profile, { metersPerRev: Goals.metersPerRev() });
    this.realtimeBPMHistory = [];
    this.realtimeRPMHistory = [];

    // Init BPM display
    this.updateWorkoutBPM(0);
    this.updateWorkoutRPM(0);
    document.getElementById('workout-timer').textContent = '00:00:00';
    document.getElementById('workout-calories').textContent = '0';
    document.getElementById('workout-distance').textContent = '0,0';
    document.getElementById('workout-avg-bpm').textContent = '--';
    const speedCard = document.getElementById('workout-speed-card');
    if (speedCard) speedCard.hidden = true;
    this.updateZoneBar();

    // Reset pause button
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) {
      pauseBtn.classList.remove('paused');
      pauseBtn.textContent = 'Pausar';
    }

    // Show workout view
    this.showView('workout');

    // Wake Lock
    this.requestWakeLock();

    // Start recording
    this.recorder.start();
    // Um treino novo não herda a pausa automática do anterior.
    this.autoPaused = false;
    this.lastPedalAt = Date.now();
    this._persistWarned = false;

    // Start tick loop
    this.startTicking(() => this.workoutTick(), 'Treino livre');

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
    if (!dp) {
      // Pausado, tick() não grava nada — mas o relógio precisa continuar recebendo o
      // pacote, ou ele expira o treino em 15 s e "Treino pausado" nunca aparece no pulso.
      if (this.recorder.isPaused) this.mirrorToWatch();
      return;
    }

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
    this.updateDistanceMetric('workout-distance', 'workout-distance-label');
    const avgEl = document.getElementById('workout-avg-bpm');
    if (avgEl) avgEl.textContent = this.recorder.getAvgBPM() || '--';

    this.checkAutoPause();
    this.mirrorToWatch();

    // Persist state every 5 seconds
    this.persistCounter++;
    if (this.persistCounter % 5 === 0) {
      this.persistWorkoutState('free');
      this.updateWorkoutNotification('Treino livre', dp);
    }
  }

  /**
   * Mirrors the workout onto the watch face.
   *
   * The watch only ever knew its own BPM; elapsed time, calories and the phase schedule
   * live here. On a bike the phone is clamped out of easy reach, so the wrist is the
   * screen that actually gets read mid-effort.
   *
   * Fire and forget, about once a second: the write is writeWithoutResponse and turns
   * itself off on a plain strap that has no such characteristic.
   *
   * @param {boolean} force ignora o limite de taxa — para mudanças de estado (pausa) que o
   *   relógio deve refletir na hora, e não no próximo tick.
   */
  mirrorToWatch(force = false) {
    const ble = this.ble;
    if (!ble?.sendWorkoutStatus || !this.recorder) return;

    // Pausado, as duas fontes de tick (timer JS e heartbeat nativo) chegam aqui sem a
    // deduplicação do recorder; sem este limite seriam duas escritas por segundo.
    const now = Date.now();
    if (!force && now - (this._lastMirrorAt || 0) < 800) return;
    this._lastMirrorAt = now;

    const status = {
      active: true,
      paused: !!this.recorder.isPaused,
      elapsedSeconds: Math.round(this.recorder.elapsedMs / 1000),
      calories: Math.round(this.recorder.totalCalories || 0),
      zone: this.recorder.getCurrentZone()?.id || 0,
      guided: !!this.guidedPlan,
    };

    if (this.guidedPlan) {
      const phase = this.guidedPlan.phases[this.guidedPhaseIndex];
      const next = this.guidedPlan.phases[this.guidedPhaseIndex + 1];
      if (phase) {
        status.rpmMin = phase.rpmMin;
        status.rpmMax = phase.rpmMax;
        // Lets the watch nag on its own when the effort drifts off the prescription.
        status.targetZone = phase.zone;
        if (next) {
          status.secondsToNextPhase = Math.max(0, phase.duration - this.guidedPhaseElapsed);
          status.shift = next.zone > phase.zone ? PHASE_SHIFT.HARDER
            : next.zone < phase.zone ? PHASE_SHIFT.EASIER
              : PHASE_SHIFT.SAME;
        }
      }
    }

    ble.sendWorkoutStatus(status).catch(() => {});
  }

  /** Tells the watch the ride is over, so it stops showing a frozen timer. */
  clearWatchWorkout() {
    this.ble?.sendWorkoutStatus?.({ active: false }).catch(() => {});
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

    // A cor da zona vai numa variável CSS; o estilo decide onde ela aparece. Antes eram
    // gradientes e bordas inline, recalculados a cada batimento.
    const block = document.getElementById('bpm-circle');
    if (block && this.recorder) {
      const zone = this.recorder.getCurrentZone();
      block.style.setProperty('--zone-color', zone ? zone.color : 'var(--text)');
    }
  }

  updateWorkoutRPM(rpm) {
    const el = document.getElementById('workout-rpm');
    if (el) el.textContent = rpm || '--';
  }

  /**
   * Distância ao vivo: a do sensor de roda quando há, senão a estimada pela cadência.
   *
   * O rótulo muda junto — "km est." nunca pode aparecer sem o "est.", ou o número passaria
   * por medida. A velocidade só existe com roda de verdade, então só aparece nesse caso.
   */
  updateDistanceMetric(valueId, labelId) {
    const r = this.recorder;
    if (!r) return;
    const real = r.distanceM > 0;
    const value = document.getElementById(valueId);
    if (value) value.textContent = formatDecimal((real ? r.distanceM : r.estDistanceM) / 1000, real ? 2 : 1);
    const label = labelId && document.getElementById(labelId);
    if (label) label.textContent = real ? 'Distância · km' : 'Distância · km est.';

    const speedCard = document.getElementById('workout-speed-card');
    if (speedCard && real) {
      speedCard.hidden = false;
      const speed = document.getElementById('workout-speed');
      if (speed) speed.textContent = formatDecimal(r.currentSpeed || 0, 1);
    }
  }

  /** Cinco segmentos, acesos até a zona atual; a cor da zona vem do token do CSS. */
  updateZoneBar() {
    if (!this.recorder) return;
    const zone = this.recorder.getCurrentZone();
    const pct = this.recorder.getZonePercentage();

    document.querySelectorAll('#zone-segments > span').forEach((seg, i) => {
      seg.classList.toggle('on', !!zone && i < zone.id);
      seg.classList.toggle('current', !!zone && i === zone.id - 1);
    });

    const name = document.getElementById('zone-name');
    const pctEl = document.getElementById('zone-pct');
    if (name) {
      name.textContent = zone ? `Z${zone.id} · ${zone.name}` : 'Sem frequência cardíaca';
      name.style.color = zone ? zone.color : '';
    }
    if (pctEl) {
      // O rótulo tem que seguir o modelo em uso: com FC de repouso no perfil o número é
      // % da *reserva*, não da máxima — 15 a 25 pontos de diferença.
      pctEl.textContent = !zone ? ''
        : this.recorder.zoneCalc.isReserveBased() ? `${pct}% da reserva` : `${pct}% da FC máx`;
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

    this.drawLine(ctx, this.realtimeRPMHistory, w, h, CHART_RPM, 0, 120);
    // FC por cima: é a linha que importa.
    this.drawLine(ctx, this.realtimeBPMHistory, w, h, CHART_HR, 60, 200);
  }

  /** Só a linha, sem área preenchida: dois preenchimentos sobrepostos viravam borrão. */
  drawLine(ctx, data, w, h, color, minVal, maxVal) {
    const len = data.length;
    if (len < 2) return;

    const stepX = w / 59; // 60 data points
    const range = maxVal - minVal || 1;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (let i = 0; i < len; i++) {
      const x = (60 - len + i) * stepX;
      const y = h - ((Math.min(maxVal, Math.max(minVal, data[i])) - minVal) / range) * (h - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /**
   * Pauses the clock when the pedals stop.
   *
   * Stopping for water used to keep the timer running, which dragged the heart-rate
   * average down, inflated the duration and made the progression engine judge the
   * session against time the rider never actually spent riding.
   *
   * Only ever engages with a cadence sensor connected: without one there is no way to
   * tell a water break from a steady effort, and pausing on a hunch would be worse than
   * not pausing at all.
   */
  checkAutoPause() {
    if (!this.recorder || this.recorder.isPaused) return;
    if (!Storage.getSettings().autoPause) return;
    if (!this.getBLE()?.cscConnected) return;
    if (!this.lastPedalAt) return;

    if (Date.now() - this.lastPedalAt >= AUTO_PAUSE_AFTER_MS) {
      this.autoPaused = true;
      this.recorder.pause();
      this.setPauseButton(true);
      this.toast('Pausado automaticamente — você parou de pedalar', 'info');
      Haptics.cue('phaseSame');
    }
  }

  resumeFromAutoPause() {
    if (!this.autoPaused || !this.recorder) return;
    this.autoPaused = false;
    this.recorder.resume();
    this.setPauseButton(false);
  }

  /**
   * Inicia o loop de gravação, com as duas fontes de tick.
   *
   * O setInterval é o que funciona no navegador e em primeiro plano; o heartbeat nativo é
   * o que sobrevive à tela apagada, porque parte do Android e não passa pelo acelerador de
   * timers do renderer. As duas chamam o mesmo tick — a deduplicação é do recorder, que
   * ignora intervalos abaixo de meio segundo.
   */
  startTicking(fn, title) {
    // Só as fontes de tick — NÃO stopTicking(). Aquele também para o foreground service, e
    // um stop disparado colado no start fazia o Android matar o app ao iniciar qualquer
    // treino (ver WorkoutForegroundService.onStartCommand). O nativo agora tolera a
    // sequência, mas não há razão para mandá-la.
    this.clearTickSources();
    // Volta é por sessão: um banner remanescente falaria da sessão anterior.
    document.querySelectorAll('.lap-banner').forEach(el => { el.hidden = true; });
    this.tickInterval = setInterval(fn, 1000);
    WorkoutService.start(title);
    this._tickOff = WorkoutService.onTick(fn);
  }

  /** Texto da notificação persistente: o que se quer ler sem desbloquear o celular. */
  updateWorkoutNotification(title, dp, slot) {
    if (!this.recorder) return;
    const parts = [this.recorder.getFormattedTime().replace(/^00:/, '')];
    if (dp?.bpm > 0) parts.push(`${dp.bpm} bpm`);
    parts.push(`${Math.round(dp?.calories || 0)} kcal`);
    if (slot) {
      const mins = Math.floor(slot.remaining / 60);
      const secs = slot.remaining % 60;
      parts.push(`${slot.phase.name} · falta ${mins}:${String(secs).padStart(2, '0')}`);
    }
    WorkoutService.update(title, parts.join(' · '));
  }

  /** Encerra o treino: fontes de tick e o foreground service. */
  stopTicking() {
    this.clearTickSources();
    WorkoutService.stop();
  }

  clearTickSources() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this._tickOff) {
      this._tickOff();
      this._tickOff = null;
    }
  }

  markLap() {
    const lap = this.recorder?.markLap();
    if (!lap) {
      this.toast('Volta muito curta', 'error');
      return;
    }

    Haptics.cue('phaseSame');

    // O banner é o da view que está no ar — a marcação de volta serve nas duas.
    const banner = document.getElementById(
      this.currentView === 'guided' ? 'guided-lap-banner' : 'lap-banner'
    );
    if (banner) {
      banner.hidden = false;
      const mins = Math.floor(lap.durationSeconds / 60);
      const secs = lap.durationSeconds % 60;
      const parts = [`Volta ${lap.index} · ${mins}:${String(secs).padStart(2, '0')}`];
      if (lap.avgBPM) parts.push(`${lap.avgBPM} bpm`);
      if (lap.avgRPM) parts.push(`${lap.avgRPM} rpm`);
      banner.textContent = parts.join(' · ');
    }
  }

  /** Laps are only meaningful on the ride they belong to; the summary lists them. */
  renderLaps(summary) {
    const card = document.getElementById('laps-card');
    const list = document.getElementById('laps-list');
    if (!card || !list) return;

    const laps = summary?.laps || [];
    card.hidden = laps.length === 0;
    if (laps.length === 0) return;

    list.innerHTML = laps.map(lap => {
      const mins = Math.floor(lap.durationSeconds / 60);
      const secs = lap.durationSeconds % 60;
      const meta = [
        lap.avgBPM ? `${lap.avgBPM} bpm` : null,
        lap.avgRPM ? `${lap.avgRPM} rpm` : null,
        lap.calories ? `${lap.calories} kcal` : null,
      ].filter(Boolean).join(' · ');
      return `
        <div class="lap-row">
          <span class="lap-index">${lap.index}</span>
          <span class="lap-time">${mins}:${String(secs).padStart(2, '0')}</span>
          <span class="lap-meta">${escapeHtml(meta)}</span>
        </div>`;
    }).join('');
  }

  /**
   * Atualiza o botão de pausa da tela que está no ar.
   *
   * Antes só conhecia o botão do treino livre, mas o auto-pause roda nos dois ticks: no
   * guiado o cronômetro parava e o botão continuava escrito "Pausar", de modo que tocá-lo
   * *retomava* — o oposto do rótulo.
   */
  setPauseButton(paused) {
    const id = this.currentView === 'guided' ? 'btn-guided-pause' : 'btn-pause';
    const btn = document.getElementById(id);
    if (btn) {
      btn.classList.toggle('paused', paused);
      btn.textContent = paused ? 'Retomar' : 'Pausar';
    }
    // Todo caminho de pausa (toque, auto-pause, retomada pelo pedal) passa por aqui.
    this.mirrorToWatch(true);
  }

  togglePause() {
    if (!this.recorder) return;

    // A deliberate tap always wins over the automatic state, in both directions.
    this.autoPaused = false;

    if (this.recorder.isPaused) {
      this.recorder.resume();
      this.setPauseButton(false);
    } else {
      this.recorder.pause();
      this.setPauseButton(true);
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

    this.stopTicking();

    this.clearWatchWorkout();

    if (this.recorder) {
      this.recorder.stop();
      this.viewingSummary = this.recorder.getSummary();
      // Marca no próprio treino: sem isto uma sessão do simulador ficava indistinguível
      // de uma real em histórico, recordes, tendência e escada de progressão.
      if (this.demoMode) this.viewingSummary.demo = true;
    }

    this.concludeSession();
  }

  /**
   * Destino comum de stopWorkout e stopGuidedWorkout, com o recorder já parado.
   *
   * Save FIRST: persistir só pelos botões do resumo fazia um toque na barra de navegação
   * jogar o treino fora sem aviso. A exceção é a sessão curta demais para contar — um
   * início acidental, um teste de sensor —, que antes entrava calada em meta, recordes e
   * médias. Para essa o app pergunta; até a resposta, o estado de recuperação continua
   * salvo, então nem um fechamento do app nesse meio-tempo a perde.
   */
  async concludeSession() {
    this.releaseWakeLock();

    const summary = this.viewingSummary;
    if (summary && (summary.durationSeconds || 0) < Storage.MIN_COUNTED_SECONDS) {
      const keep = await this.confirm({
        title: 'Treino muito curto',
        text: `Foram ${summary.durationFormatted}. Sessões com menos de 2 minutos não contam para meta, carga nem estatísticas. Guardar no histórico mesmo assim?`,
        confirmLabel: 'Guardar',
        cancelLabel: 'Descartar',
        danger: false,
      });
      if (!keep) {
        Storage.clearActiveWorkout();
        this.viewingSummary = null;
        this.viewStack = [];
        this.toast('Treino descartado.', 'info');
        this.showView('home', { push: false });
        return;
      }
    }

    this.persistSummary(this.viewingSummary);
    this.showSummaryView(this.viewingSummary, 'live');
  }

  showSummaryView(summary, mode = 'history') {
    if (!summary) return;

    this.summaryMode = mode;
    this.viewingSummary = summary;
    this.charts.destroyAll();
    this.renderLaps(summary);
    this.renderRPE(summary);

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
    document.getElementById('summary-title').textContent = summary.planName || 'Treino livre';

    // Hero stats
    document.getElementById('summary-duration').textContent =
      summary.durationFormatted?.replace(/^00:/, '') || '--';
    document.getElementById('summary-calories').textContent = summary.calories;
    document.getElementById('summary-avg-bpm').textContent = summary.avgBPM || '--';

    // Distância: medida quando houve roda, estimada pela cadência quando não.
    const dist = Goals.workoutDistance(summary);
    document.getElementById('summary-distance').textContent =
      dist.m > 0 ? formatDecimal(dist.m / 1000, dist.estimated ? 1 : 2) : '--';
    document.getElementById('summary-distance-label').textContent = dist.estimated ? 'km est.' : 'km';

    this.renderSummaryMilestones(summary);

    // Stat cards
    document.getElementById('stat-avg-bpm').textContent = summary.avgBPM || '--';
    document.getElementById('stat-max-bpm').textContent = summary.maxBPM || '--';
    document.getElementById('stat-avg-rpm').textContent = summary.avgRPM || '--';
    document.getElementById('stat-max-rpm').textContent = summary.maxRPM || '--';

    // Só aparecem quando houve sensor de roda no treino.
    const hasDistance = (summary.distanceM || 0) > 0;
    document.getElementById('stat-distance-card').hidden = !hasDistance;
    document.getElementById('stat-speed-card').hidden = !hasDistance;
    if (hasDistance) {
      document.getElementById('stat-distance').textContent = `${formatDecimal(summary.distanceM / 1000, 2)} km`;
      document.getElementById('stat-avg-speed').textContent = summary.avgSpeedKmh
        ? `${formatDecimal(summary.avgSpeedKmh, 1)} km/h` : '--';
    }

    this.showView('summary');

    // A ride with no sensor data draws nothing, so show an empty state instead of three
    // captioned blank boxes.
    // Testa se há batimento, não se há pontos: um treino só com cadência tem centenas de
    // pontos com bpm 0, passava por este guard e ia desenhar um gráfico de FC vazio.
    // A guarda de array também protege contra treino importado sem dataPoints.
    const points = summary.dataPoints || [];
    const hasData = points.some(p => p.bpm > 0 || p.rpm > 0);
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
   * Marcos de tempo e distância que este treino derrubou.
   *
   * Calculado do histórico salvo, então reabrir o resumo dias depois mostra a mesma
   * conquista — e apagar o treino a desfaz, sem estado para dessincronizar.
   */
  renderSummaryMilestones(summary) {
    const card = document.getElementById('summary-milestones');
    const list = document.getElementById('summary-milestones-list');
    if (!card || !list) return;
    const reached = Storage.countsAsTraining(summary)
      ? Goals.milestonesReachedBy(summary.id, Goals.getMilestones())
      : [];
    card.hidden = reached.length === 0;
    list.innerHTML = reached.map(t => `<li>${escapeHtml(t)}</li>`).join('');
  }

  // ── Perceived effort ──

  /**
   * Borg CR10 wording, condensed. Kept short because it is read on a phone right after a
   * hard effort, not studied.
   */
  static RPE_LABELS = [
    '', 'Muito leve', 'Leve', 'Moderado', 'Um pouco puxado', 'Puxado',
    'Puxado', 'Muito puxado', 'Muito puxado', 'Quase no limite', 'Máximo',
  ];

  renderRPE(summary) {
    const scale = document.getElementById('rpe-scale');
    const note = document.getElementById('workout-note');
    if (!scale) return;

    const current = summary?.rpe || 0;

    scale.innerHTML = Array.from({ length: 10 }, (_, i) => {
      const value = i + 1;
      // Colour walks the zone palette so the scale reads as effort, not as a rating.
      const zone = ZONES[Math.min(4, Math.floor(i / 2))];
      const filled = current > 0 && value <= current;
      return `<button type="button" class="rpe-btn${filled ? ' filled' : ''}${value === current ? ' selected' : ''}"
        style="${filled ? `background:${zone.color}` : ''}"
        role="radio" aria-checked="${value === current}"
        aria-label="Esforço ${value} de 10" data-rpe="${value}">${value}</button>`;
    }).join('');

    scale.querySelectorAll('.rpe-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setRPE(parseInt(btn.dataset.rpe, 10)));
    });

    const hint = document.getElementById('rpe-hint');
    if (hint) {
      hint.textContent = current > 0
        ? `${current}/10 · ${SpinSyncApp.RPE_LABELS[current]}`
        : 'Toque para avaliar o esforço';
    }

    if (note) note.value = summary?.note || '';
  }

  setRPE(value) {
    if (!this.viewingSummary) return;
    // Tapping the current value clears it — the only way back out of a mis-tap.
    this.viewingSummary.rpe = this.viewingSummary.rpe === value ? 0 : value;
    this.renderRPE(this.viewingSummary);
    this.persistSummaryEdits();
  }

  /** Writes RPE and note back onto the stored workout, in place. */
  persistSummaryEdits() {
    const summary = this.viewingSummary;
    if (!summary?.id) return;
    const note = document.getElementById('workout-note');
    summary.note = note ? note.value.trim() : summary.note;
    Storage.updateWorkout(summary.id, {
      rpe: summary.rpe || 0,
      note: summary.note || '',
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

  renderTrainingLoad() {
    const card = document.getElementById('load-card');
    if (!card) return;

    const load = Analytics.getTrainingLoad();
    if (!load) { card.hidden = true; return; }
    card.hidden = false;

    document.getElementById('load-acute').textContent = load.acute;
    document.getElementById('load-chronic').textContent = load.chronic ?? '--';

    const ratioEl = document.getElementById('load-ratio');
    ratioEl.textContent = load.ratio == null ? '--' : formatDecimal(load.ratio, 2);
    ratioEl.className = 'load-value'
      + (load.ratio >= 1.5 ? ' danger' : load.ratio >= 1.3 ? ' warn' : '');

    const hint = document.getElementById('load-hint');
    if (!hint) return;
    if (!load.chronic) {
      hint.textContent = 'Carga = minutos × esforço percebido. Com mais algumas semanas dá para comparar com a sua média.';
    } else if (load.ratio >= 1.5) {
      // "Salto de volume", não "risco de lesão": a capacidade da razão aguda:crônica de
      // prever lesão é contestada na literatura. O salto em si é o fato observável.
      hint.textContent = `Seus últimos 7 dias estão ${formatDecimal(load.ratio, 2)}× a média das quatro semanas anteriores. É um salto grande de volume — vale segurar até o corpo acompanhar.`;
    } else if (load.ratio >= 1.3) {
      hint.textContent = `Últimos 7 dias ${formatDecimal(load.ratio, 2)}× acima da média. Subida forte, mas ainda dentro do razoável.`;
    } else if (load.ratio < 0.8) {
      hint.textContent = `Últimos 7 dias a ${formatDecimal(load.ratio, 2)}× da média. Pode ser descanso planejado — ou perda de ritmo.`;
    } else {
      hint.textContent = 'Volume em linha com as últimas semanas.';
    }

    if (load.missingRpe > 0) {
      hint.textContent += ` (${load.missingRpe} treino(s) sem esforço informado não entram na conta.)`;
    }
  }

  renderRecords() {
    const card = document.getElementById('records-card');
    const list = document.getElementById('records-list');
    if (!card || !list) return;

    const r = Analytics.getRecords();
    if (!r) { card.hidden = true; return; }
    card.hidden = false;

    const when = (w) => new Date(w.date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    const hhmm = (secs) => {
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m} min`;
    };

    const rows = [
      // getRecords escolhe o melhor com `|| 0`, mas a renderização lia o campo cru: um
      // treino legado sem maxBPM mostrava "undefined bpm" na tela.
      ['Treino mais longo', hhmm(r.longest.durationSeconds || 0), when(r.longest)],
      ['Mais calorias', `${r.mostCalories.calories || 0} kcal`, when(r.mostCalories)],
      ['FC mais alta', `${r.highestBPM.maxBPM || '--'} bpm`, when(r.highestBPM)],
    ];
    if (r.hardestSeconds > 0) {
      rows.push(['Mais tempo em Z4+', hhmm(r.hardestSeconds), when(r.hardest)]);
    }
    rows.push(['Total acumulado', `${r.totalWorkouts} treinos · ${hhmm(r.totalSeconds)}`, '']);

    list.innerHTML = rows.map(([label, value, date]) => `
      <div class="record-row">
        <span class="record-label">${escapeHtml(label)}</span>
        <span class="record-value">${escapeHtml(value)}</span>
        <span class="record-date">${escapeHtml(date)}</span>
      </div>`).join('');
  }

  renderFitnessTrend() {
    const card = document.getElementById('fitness-trend-card');
    if (!card) return;

    const trend = Analytics.getFitnessTrend();
    // Needs at least two rides of one plan; below that there is no comparison to make.
    if (!trend || trend.points.length < 2) { card.hidden = true; return; }
    card.hidden = false;

    const desc = document.getElementById('fitness-trend-desc');
    if (desc) {
      const delta = trend.deltaBPM;
      const verdict = delta <= -3
        ? `${Math.abs(delta)} bpm mais baixa para o mesmo esforço — sinal de ganho de condicionamento.`
        : delta >= 3
          ? `${delta} bpm mais alta. Pode ser fadiga, calor ou sono ruim.`
          : 'Estável para o mesmo esforço.';
      desc.textContent = `${trend.planName} · ${trend.points.length} repetições. ${verdict}`;
    }

    if (this.fitnessChart) {
      this.fitnessChart.destroy();
      this.fitnessChart = null;
    }
    this.fitnessChart = this.charts.renderFitnessTrend('chart-fitness', trend);
  }

  renderAnalytics(period = this.analyticsPeriod || 'week') {
    // O período escolhido sobrevive a sair e voltar da aba; antes voltava sempre para
    // "Semana" com o botão de outro período ainda aceso.
    this.analyticsPeriod = period;
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.period === period);
    });

    const stats = Analytics.getStats(period);
    const mPerRev = Goals.metersPerRev();
    const km = stats.workouts.reduce((s, w) => s + Goals.workoutDistance(w, mPerRev).m, 0) / 1000;

    document.getElementById('analytics-count').textContent = stats.count;
    document.getElementById('analytics-calories').textContent = stats.totalCalories.toLocaleString('pt-BR');
    document.getElementById('analytics-duration').textContent = formatMinutes(stats.totalDuration);
    document.getElementById('analytics-distance').textContent = `${formatDecimal(km)} km`;
    document.getElementById('analytics-avg-bpm').textContent = stats.avgBPM || '--';
    document.getElementById('analytics-avg-rpm').textContent = stats.avgRPM || '--';

    // Metas, carga, recordes e tendência leem o histórico inteiro e ignoram o período de
    // propósito — um recorde pessoal não é propriedade dos últimos 7 dias.
    this.renderGoals();
    this.renderTrainingLoad();
    this.renderRecords();
    this.renderFitnessTrend();

    // A titled but permanently blank chart card reads as a bug; say what's missing.
    const hasData = stats.chartData.labels.length > 0;
    const empty = document.getElementById('analytics-empty');
    if (empty) empty.hidden = hasData;

    this.renderBarChart('analyticsChart', 'analytics-chart-card', 'chart-analytics-calories',
      stats.chartData.labels, stats.chartData.calories, 'kcal', CHART_MUTED);
    this.renderBarChart('volumeChart', 'analytics-volume-card', 'chart-analytics-volume',
      stats.chartData.labels, stats.chartData.duration || [], 'min', CHART_ACCENT);
  }

  /** Um gráfico de barras simples, recriado a cada render (Chart.js não reaproveita canvas). */
  renderBarChart(field, cardId, canvasId, labels, data, unit, color) {
    const card = document.getElementById(cardId);
    const canvas = document.getElementById(canvasId);
    if (this[field]) {
      this[field].destroy();
      this[field] = null;
    }
    const has = data.some(v => v > 0);
    if (card) card.hidden = !has;
    if (!has || !canvas) return;

    this[field] = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: color, borderRadius: 2, maxBarThickness: 28 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.parsed.y} ${unit}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 4 } },
        },
      },
    });
  }

  /**
   * Desafio do mês e próximas marcas (goals.js).
   *
   * Duas réguas de propósito: o desafio é renovável (todo mês tem um), as marcas são
   * permanentes (cada uma cai uma vez). Juntas dão um motivo para hoje e um para o ano.
   */
  renderGoals() {
    const mPerRev = Goals.metersPerRev();
    const counted = Storage.getWorkouts().filter(Storage.countsAsTraining);

    const card = document.getElementById('challenge-card');
    if (card) {
      const c = Goals.getMonthlyChallenge(counted, { mPerRev });
      card.hidden = false;
      document.getElementById('challenge-title').textContent = `Desafio de ${c.monthName}`;
      document.getElementById('challenge-days').textContent =
        c.daysLeft === 0 ? 'último dia' : `faltam ${c.daysLeft} dias`;
      document.getElementById('challenge-km-text').textContent =
        `${formatDecimal(c.km.value)} de ${c.km.target} km`;
      document.getElementById('challenge-min-text').textContent =
        `${Math.round(c.minutes.value)} de ${c.minutes.target} min`;
      document.getElementById('challenge-km-fill').style.width = `${Math.round(c.km.pct * 100)}%`;
      document.getElementById('challenge-min-fill').style.width = `${Math.round(c.minutes.pct * 100)}%`;

      const { weeklyGoal } = Storage.getSettings();
      const sessionsLeft = Math.max(1, Math.ceil((c.daysLeft / 7) * Math.max(1, weeklyGoal || 1)));
      const kmLeft = Math.max(0, c.km.target - c.km.value);
      const pace = c.km.pct >= 1
        ? `Desafio cumprido. Meta extra: ${Math.ceil((c.km.value * 1.2) / 5) * 5} km.`
        : c.km.onTrack ? 'Você está no ritmo para fechar o mês.'
          : `Para fechar: cerca de ${formatDecimal(kmLeft / sessionsLeft)} km por treino até o fim do mês.`;
      document.getElementById('challenge-note').textContent = `${pace} `
        + (c.basedOnLastMonth ? 'Meta: o mês passado + 10%.' : 'Meta calculada pela sua meta semanal e seu treino típico.')
        + ' Distância estimada pela cadência.';
    }

    const msCard = document.getElementById('milestones-card');
    const msList = document.getElementById('milestones-list');
    if (msCard && msList) {
      const m = Goals.getMilestones(counted, mPerRev);
      msCard.hidden = counted.length === 0;
      const line = (label, t, fmt, unit) => {
        const value = `${fmt(t.value)} ${unit}`;
        const next = t.next ? `próxima: ${t.next} ${unit}` : 'todas alcançadas';
        return `
          <div class="goal-line">
            <div class="goal-line-head"><span>${label}</span><span>${value} · ${next}</span></div>
            <div class="bar"><div class="bar-fill" style="width:${Math.round(t.progress * 100)}%"></div></div>
          </div>`;
      };
      msList.innerHTML = [
        line('Treino mais longo', m.longestRide, (v) => Math.round(v), 'min'),
        line('Maior distância num treino', m.longestDistance, (v) => formatDecimal(v), 'km'),
        line('Distância acumulada', m.totalDistance, (v) => formatDecimal(v), 'km'),
      ].join('');
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
    toSave.dataPoints = toSave.dataPoints || [];
    if (toSave.dataPoints.length > 500) {
      const step = Math.ceil(toSave.dataPoints.length / 500);
      toSave.dataPoints = toSave.dataPoints.filter((_, i) => i % step === 0);
    }

    let ok = Storage.saveWorkout(toSave);

    // Armazenamento cheio era um beco sem saída: o app avisava e o treino de 45 min se
    // perdia, sem nenhuma ação possível de dentro do app. As amostras são ~90% do peso de
    // um treino e o resumo (duração, calorias, zonas, FC) sobrevive sem elas — perder os
    // gráficos é muito melhor que perder a sessão.
    if (!ok) {
      const stripped = { ...toSave, dataPoints: [], samplesDropped: true };
      ok = Storage.saveWorkout(stripped);
      if (ok) {
        this.viewingSummary = stripped;
        this.toast(
          'Armazenamento cheio: o treino foi salvo sem os gráficos. Exporte um backup e apague treinos antigos.',
          'error', 8000
        );
      }
    }

    if (!ok) {
      this.toast('Não foi possível salvar o treino (armazenamento cheio).', 'error', 8000);
      return false;
    }

    // Sync to Health Connect (async, non-blocking). Only surfaced in native builds:
    // in the browser "sync skipped" is the expected outcome, not news.
    HealthSync.syncWorkout(summary).then(result => {
      if (result.success) {
        this.toast('Treino enviado ao Health Connect', 'success');
      } else if (HealthSync.isNativeMode() && !result.skipped) {
        // `skipped` = nunca autorizado: não é falha, e um toast de erro a cada treino
        // seria só barulho para quem escolheu não usar o Health Connect.
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
        : 'Este treino será removido do histórico definitivamente.'
          + ' Se ele contava para a escada de progressão, você pode regredir um degrau.',
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

    const query = (document.getElementById('history-search')?.value || '').trim().toLowerCase();
    const all = Storage.getWorkouts();
    const workouts = query
      ? all.filter(w => `${w.planName || ''} ${w.note || ''}`.toLowerCase().includes(query))
      : all;

    if (workouts.length === 0) {
      list.innerHTML = query
        ? `<div class="empty-state"><p>Nenhum treino encontrado para "${escapeHtml(query)}".</p></div>`
        : `<div class="empty-state"><p>Nenhum treino registrado ainda.</p>
             <p class="fine-print">O primeiro aparece aqui assim que você finalizar.</p></div>`;
      return;
    }

    // Agrupado por mês, com o total de cada um: a lista vira diário, não só um log.
    const mPerRev = Goals.metersPerRev();
    const groups = new Map();
    for (const w of workouts) {
      const d = new Date(w.date);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!groups.has(key)) groups.set(key, { date: d, items: [] });
      groups.get(key).items.push(w);
    }

    const row = (w) => {
      const d = new Date(w.date);
      const when = `${d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      const dist = Goals.workoutDistance(w, mPerRev);
      const meta = [
        formatMinutes(w.durationSeconds),
        dist.m > 0 ? `${formatDecimal(dist.m / 1000)} km${dist.estimated ? ' est.' : ''}` : null,
        w.avgBPM ? `FC ${w.avgBPM}` : null,
        w.rpe ? `RPE ${w.rpe}` : null,
      ].filter(Boolean).join(' · ');
      const tags = [
        w.demo ? '<span class="tag tag-muted">demo</span>' : '',
        !w.demo && !Storage.countsAsTraining(w) ? '<span class="tag tag-muted">curto</span>' : '',
        w.note ? '<span class="tag tag-muted">nota</span>' : '',
      ].join('');
      return `
        <button type="button" class="history-item" data-workout-id="${escapeHtml(w.id)}">
          <span class="history-top">
            <span class="history-name">${escapeHtml(w.planName || 'Treino livre')}</span>
            <span class="history-date">${escapeHtml(when)}</span>
          </span>
          <span class="history-meta">${escapeHtml(meta)}${tags}</span>
        </button>`;
    };

    list.innerHTML = [...groups.values()].map(g => {
      const counted = g.items.filter(Storage.countsAsTraining);
      const km = counted.reduce((s, w) => s + Goals.workoutDistance(w, mPerRev).m, 0) / 1000;
      const min = Math.round(counted.reduce((s, w) => s + (w.durationSeconds || 0), 0) / 60);
      const month = g.date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return `
        <section class="history-group">
          <div class="history-group-head">
            <span>${escapeHtml(month.charAt(0).toUpperCase() + month.slice(1))}</span>
            <span>${counted.length} treinos · ${min} min · ${formatDecimal(km)} km</span>
          </div>
          ${g.items.map(row).join('')}
        </section>`;
    }).join('');

    // Excluir fica no resumo do treino: na lista era um toque a um centímetro de abrir.
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        const workout = Storage.getWorkoutById(item.dataset.workoutId);
        if (workout) this.showSummaryView(workout, 'history');
      });
    });
  }

  // ── Wake Lock ──

  async requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        // O sistema libera o lock sozinho ao esconder a aba; sem saber disso, o app achava
        // que ainda o tinha e a tela voltava a apagar no meio do treino.
        this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
      }
    } catch (err) {
      console.log('Wake Lock não disponível:', err);
    }
  }

  /**
   * Reage ao app sair e voltar do segundo plano.
   *
   * Não existia nada disto: nem `visibilitychange`, nem `pagehide`, nem o `appStateChange`
   * do Capacitor. Duas consequências, as duas ruins no mesmo momento — quando o usuário
   * guarda o celular no bolso:
   *
   *  - o estado do treino só era salvo dentro do tick, e o tick sai cedo quando pausado,
   *    então nada era gravado justamente quando o Android está mais propenso a matar o
   *    processo;
   *  - o wake lock nunca era readquirido ao voltar.
   */
  setupLifecycleHandlers() {
    const save = () => {
      if (!this.recorder) return;
      this.persistWorkoutState(this.guidedPlan ? 'guided' : 'free');
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        save();
      } else if (this.recorder && !this.wakeLock) {
        this.requestWakeLock();
      }
    });

    // pagehide cobre o fechamento da aba, que não dispara visibilitychange em todo browser.
    window.addEventListener('pagehide', save);

    // No APK a WebView pode nem receber os eventos de página; o Capacitor avisa antes.
    const CapApp = window.capacitorApp?.App;
    CapApp?.addListener?.('appStateChange', ({ isActive }) => {
      if (!isActive) save();
      else if (this.recorder && !this.wakeLock) this.requestWakeLock();
    });
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

  /**
   * Biblioteca de treinos, por objetivo.
   *
   * Era um carrossel horizontal filtrado por nível, com um emoji grande por card: metade
   * dos treinos ficava fora da tela e o filtro respondia "quão difícil", não "para quê".
   * Agora é uma lista vertical por categoria, com nível e duração à direita.
   */
  renderPlanLibrary() {
    const container = document.getElementById('plans-scroll');
    const tabsEl = document.getElementById('plan-filter-tabs');
    if (!container || !tabsEl) return;

    const allPlans = Plans.getAllPlans();
    const custom = Plans.getCustomPlans();
    const categories = [...Plans.CATEGORIES, ...(custom.length ? [Plans.CUSTOM_CATEGORY] : [])];
    if (!['all', ...categories.map(c => c.id)].includes(this.planFilter)) this.planFilter = 'all';

    tabsEl.innerHTML = [{ id: 'all', name: 'Todos' }, ...categories].map(c => `
      <button type="button" class="tab${c.id === this.planFilter ? ' active' : ''}" role="tab"
              aria-selected="${c.id === this.planFilter}" data-category="${c.id}">${escapeHtml(c.name)}</button>`).join('');

    const desc = document.getElementById('category-desc');
    const current = categories.find(c => c.id === this.planFilter);
    if (desc) {
      desc.hidden = !current;
      desc.textContent = current?.desc || '';
    }

    const recommendedId = this.todayRecommendation?.plan?.id;
    const ladderCurrentId = Progression.getLadderState(Storage.getProfile()).current?.planId;
    const rank = { 'Iniciante': 0, 'Iniciante+': 1, 'Intermediário': 2, 'Avançado': 3 };
    const byLevel = (a, b) => (rank[a.difficulty] ?? 9) - (rank[b.difficulty] ?? 9)
      || Plans.getPlanDuration(a) - Plans.getPlanDuration(b);

    const row = (plan) => {
      const tags = [
        plan.id === recommendedId ? '<span class="tag tag-accent">hoje</span>' : '',
        plan.id === ladderCurrentId && plan.id !== recommendedId ? '<span class="tag tag-muted">seu degrau</span>' : '',
      ].join('');
      return `
        <button type="button" class="plan-row" data-plan-id="${escapeHtml(plan.id)}">
          <span class="plan-row-main">
            <span class="plan-row-name">${escapeHtml(plan.name)}${tags}</span>
            <span class="plan-row-desc">${escapeHtml(plan.description || '')}</span>
          </span>
          <span class="plan-row-side">
            <span class="plan-row-dur">${Plans.formatDuration(Plans.getPlanDuration(plan))}</span>
            <span class="plan-row-level">${escapeHtml(plan.difficulty || '')}</span>
          </span>
        </button>`;
    };

    if (this.planFilter === 'all') {
      container.innerHTML = categories.map(c => {
        const plans = allPlans.filter(p => Plans.getPlanCategory(p).id === c.id).sort(byLevel);
        if (!plans.length) return '';
        return `<div class="plan-group-head">${escapeHtml(c.name)}</div>${plans.map(row).join('')}`;
      }).join('');
    } else {
      const plans = allPlans.filter(p => Plans.getPlanCategory(p).id === this.planFilter).sort(byLevel);
      container.innerHTML = plans.length
        ? plans.map(row).join('')
        : '<div class="empty-state"><p>Nenhum treino nesta categoria.</p></div>';
    }

    container.querySelectorAll('.plan-row').forEach(el => {
      el.addEventListener('click', () => {
        this.openPlanDetail(allPlans.find(p => p.id === el.dataset.planId));
      });
    });
  }

  /**
   * Abre a tela de detalhe de um plano, sem deixar o toque morrer em silêncio.
   *
   * Um `ReferenceError` dentro de showPlanDetail deixava os cards de treino, o botão do
   * coach e o do veredito completamente inertes: a exceção morria no console do handler e
   * a tela simplesmente não trocava. Um erro visível teria custado minutos em vez de
   * semanas com a funcionalidade principal do app fora do ar.
   */
  openPlanDetail(plan) {
    if (!plan) return;
    try {
      this.showPlanDetail(plan);
    } catch (e) {
      console.error('[App] showPlanDetail falhou:', e);
      this.toast('Não foi possível abrir este treino.', 'error');
    }
  }

  showPlanDetail(plan) {
    this.selectedPlan = plan;
    const zoneCalc = this.zoneCalcForProfile();

    document.getElementById('plan-category').textContent = Plans.getPlanCategory(plan).name;
    document.getElementById('plan-name').textContent = plan.name;
    document.getElementById('plan-desc').textContent = plan.description || '';
    document.getElementById('plan-duration').textContent = Plans.formatDuration(Plans.getPlanDuration(plan));
    document.getElementById('plan-phases-count').textContent = plan.phases.length;
    document.getElementById('plan-difficulty').textContent = plan.difficulty || '--';

    // Versão com a duração ajustada ao histórico (personalization.scalePlan): diz o quanto
    // mudou e deixa voltar à original com um toque.
    const personal = document.getElementById('plan-personal');
    if (personal) {
      personal.hidden = !plan.personalized;
      if (plan.personalized) {
        document.getElementById('plan-personal-text').textContent =
          `Ajustado para você: ${Plans.formatDuration(plan.personalized.toSec)} `
          + `(original ${Plans.formatDuration(plan.personalized.fromSec)}).`;
      }
    }

    document.getElementById('plan-timeline').innerHTML = plan.phases.map(phase => {
      const zone = Plans.getPhaseZone(phase);
      const bpm = Plans.resolvePhaseBPM(phase, zoneCalc);
      return `
        <li class="phase-row" style="--zone-color:${zone.color}">
          <span class="phase-mark" aria-hidden="true"></span>
          <div class="phase-body">
            <div class="phase-head">
              <span class="phase-name">${escapeHtml(phase.name)}</span>
              <span class="phase-dur">${Plans.formatDuration(phase.duration)}</span>
            </div>
            <div class="phase-targets">Z${phase.zone} · ${bpm.min}–${bpm.max} bpm · ${phase.rpmMin}–${phase.rpmMax} rpm</div>
            ${phase.tip ? `<div class="phase-tip">${escapeHtml(phase.tip)}</div>` : ''}
          </div>
        </li>`;
    }).join('');

    // Always allow starting — sensors are optional
    const btn = document.getElementById('btn-start-guided');
    if (btn) btn.disabled = false;

    this.renderPlanLadderStatus(plan, Storage.getProfile());

    // Custom plans can be edited and deleted; the built-in ones cannot.
    const isCustom = Plans.isCustomPlan(plan.id);
    const delBtn = document.getElementById('btn-delete-plan');
    if (delBtn) delBtn.hidden = !isCustom;
    const editBtn = document.getElementById('btn-edit-plan');
    if (editBtn) editBtn.hidden = !isCustom;

    this.showView('plan-detail');
    window.scrollTo(0, 0);
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
      cleared: `Concluído · ${position} · melhor nota ${step.bestScore}/100`,
      current: step.attempts === 0
        ? `Seu próximo degrau · ${position}`
        : `Você está aqui · ${position} · melhor nota ${step.bestScore}/100`,
      locked: `Bloqueado · ${position} · conclua os anteriores primeiro`,
      skipped: `Pulado · ${position}`,
    };

    el.hidden = false;
    el.className = `plan-ladder-status ${step.status}`;
    el.textContent = labels[step.status];

    // Saída para um degrau que não sai. Um plano pode simplesmente não servir para a
    // pessoa, e sem isto a escada travava nele para sempre.
    const skipBtn = document.getElementById('btn-skip-step');
    if (skipBtn) {
      const canSkip = step.status === 'current' && step.attempts >= 2;
      skipBtn.hidden = !canSkip;
      this._skipStepPlanId = canSkip ? plan.id : null;
    }
  }

  async skipCurrentStep() {
    if (!this._skipStepPlanId) return;
    const ok = await this.confirm({
      title: 'Pular este degrau?',
      text: 'O próximo treino da escada é liberado. Você pode desfazer em Perfil › Progressão.',
      confirmLabel: 'Pular',
      danger: false,
    });
    if (!ok) return;

    Progression.skipStep(this._skipStepPlanId);
    this.toast('Degrau pulado. O próximo treino foi liberado.', 'success');
    this.showPlanDetail(this.selectedPlan);
    this.renderCoachCard();
  }

  async resetProgression() {
    const ok = await this.confirm({
      title: 'Refazer a escada?',
      text: 'Os degraus pulados voltam a contar. Seu histórico de treinos não é afetado.',
      confirmLabel: 'Refazer',
    });
    if (!ok) return;
    Progression.resetSkipped();
    this.toast('Escada recalculada a partir do seu histórico.', 'success');
    this.updateProgressionSettings();
    this.renderCoachCard();
  }

  updateProgressionSettings() {
    const row = document.getElementById('progression-reset-row');
    if (row) row.hidden = !Progression.hasSkipped();
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
    // Travas dos avisos hápticos. Se vazarem de uma sessão para a outra, o aviso
    // simplesmente nunca mais toca — falha silenciosa e difícil de perceber.
    this._phaseWarnFired = false;
    this._finalWarnFired = false;

    this.recorder = new WorkoutRecorder(profile, { metersPerRev: Goals.metersPerRev() });
    this.recorder.start();
    // Um treino novo não herda a pausa automática do anterior.
    this.autoPaused = false;
    this.lastPedalAt = Date.now();
    this._persistWarned = false;

    this.showView('guided');
    this.requestWakeLock();
    this.updateGuidedPhaseUI();

    document.getElementById('guided-plan-name').textContent = this.guidedPlan.name;
    document.getElementById('guided-calories').textContent = '0';
    document.getElementById('guided-distance').textContent = '0,0';
    document.getElementById('guided-remaining').textContent =
      formatClock(Plans.getPlanDuration(this.guidedPlan));

    const pauseBtn = document.getElementById('btn-guided-pause');
    if (pauseBtn) {
      pauseBtn.classList.remove('paused');
      pauseBtn.textContent = 'Pausar';
    }

    this.startTicking(() => this.guidedTick(), this.guidedPlan?.name || 'Treino guiado');
  }

  /**
   * Qual fase estava rodando em `elapsedSec` de treino.
   *
   * Percorre a MESMA soma cumulativa de `phase.duration` que progression.js usa para julgar
   * a sessão. Por construção, o que a tela mostra e o que o avaliador vê deixam de poder
   * divergir — antes a tela contava ticks e o avaliador usava timestamps de relógio de
   * parede, então bastava o app ficar em segundo plano para as amostras serem atribuídas às
   * fases erradas.
   */
  phaseAt(plan, elapsedSec) {
    let acc = 0;
    for (let i = 0; i < plan.phases.length; i++) {
      const end = acc + plan.phases[i].duration;
      if (elapsedSec < end) {
        return { index: i, phase: plan.phases[i], into: elapsedSec - acc, remaining: end - elapsedSec };
      }
      acc = end;
    }
    return null; // plano terminado
  }

  guidedTick() {
    if (!this.recorder || !this.guidedPlan) return;
    if (this.recorder.isPaused) {
      // Mesmo motivo do treino livre: sem pacote, o relógio apaga o treino em 15 s.
      this.mirrorToWatch();
      return;
    }

    const dp = this.recorder.tick();
    if (!dp) return;

    // Única fonte de verdade: o relógio do recorder, que já desconta as pausas.
    const total = Math.floor(this.recorder.elapsedMs / 1000);
    this.guidedTotalElapsed = total;

    const slot = this.phaseAt(this.guidedPlan, total);
    if (!slot) {
      Haptics.cue('workoutEnd');
      this.stopGuidedWorkout();
      return;
    }

    // Voltamos de um período em segundo plano? Então avisos já vencidos não devem tocar.
    const jumped = (dp.dtMs || 1000) > 30_000;

    if (slot.index !== this.guidedPhaseIndex) {
      const previousZone = this.guidedPlan.phases[this.guidedPhaseIndex]?.zone ?? slot.phase.zone;
      // Salta quantas fases forem necessárias de uma vez — o código antigo avançava uma só,
      // então um intervalo grande deixava a tela numa fase que já tinha acabado.
      this.guidedPhaseIndex = slot.index;
      this._phaseWarnFired = false;

      // Padrão distinto por direção, para o pulso sozinho dizer se é para forçar ou aliviar.
      if (slot.phase.zone > previousZone) Haptics.cue('phaseUp');
      else if (slot.phase.zone < previousZone) Haptics.cue('phaseDown');
      else Haptics.cue('phaseSame');

      this.updateGuidedPhaseUI();
      const header = document.querySelector('.guided-header');
      if (header) {
        header.classList.add('phase-transition');
        setTimeout(() => header.classList.remove('phase-transition'), 1500);
      }
    }

    // Cache derivado: updateGuidedTimers, mirrorToWatch e a barra de progresso seguem lendo.
    this.guidedPhaseElapsed = slot.into;

    // Avisos por limiar com trava, não por igualdade: `=== HAPTIC_WARNING_LEAD` significava
    // que um único tick perdido pulava o aviso inteiro.
    const planTotal = Plans.getPlanDuration(this.guidedPlan);
    const hasNext = this.guidedPhaseIndex < this.guidedPlan.phases.length - 1;

    if (!this._phaseWarnFired && hasNext && !jumped
        && slot.remaining > 0 && slot.remaining <= HAPTIC_WARNING_LEAD) {
      this._phaseWarnFired = true;
      Haptics.cue('phaseWarning');
    }
    if (!this._finalWarnFired && !jumped && planTotal - total <= HAPTIC_FINAL_LEAD) {
      this._finalWarnFired = true;
      Haptics.cue('finalStretch');
    }

    this.updateGuidedTimers(slot.phase);
    this.updateGuidedTargets(dp);
    this.mirrorToWatch();
    this.checkAutoPause();

    document.getElementById('guided-calories').textContent = Math.round(dp.calories);

    const pct = Math.min(100, (total / planTotal) * 100);
    const fill = document.getElementById('guided-overall-fill');
    if (fill) fill.style.width = `${pct}%`;
    // Só a barra fina não dizia quanto faltava — e é a primeira pergunta no meio do treino.
    const remaining = document.getElementById('guided-remaining');
    if (remaining) remaining.textContent = formatClock(Math.max(0, planTotal - total));
    this.updateDistanceMetric('guided-distance');

    this.persistCounter++;
    if (this.persistCounter % 5 === 0) {
      this.persistWorkoutState('guided');
      this.updateWorkoutNotification(this.guidedPlan?.name || 'Treino guiado', dp, slot);
    }
  }

  updateGuidedPhaseUI() {
    const plan = this.guidedPlan;
    if (!plan) return;
    const phase = plan.phases[this.guidedPhaseIndex];
    const zone = Plans.getPhaseZone(phase);
    const zoneCalc = this.zoneCalcForProfile();
    const bpm = Plans.resolvePhaseBPM(phase, zoneCalc);

    // Phase label & name
    document.getElementById('guided-phase-label').textContent =
      `Fase ${this.guidedPhaseIndex + 1} de ${plan.phases.length}`;
    const nameEl = document.getElementById('guided-phase-name');
    if (nameEl) {
      nameEl.textContent = phase.name;
      nameEl.style.color = zone.color;
    }

    // BPM target range
    document.getElementById('guided-bpm-range').textContent = `${bpm.min}–${bpm.max}`;
    document.getElementById('guided-rpm-range').textContent = `${phase.rpmMin}–${phase.rpmMax}`;

    // Tip
    const tipCard = document.getElementById('guided-tip-card');
    const tipDot = document.getElementById('guided-tip-dot');
    const tipText = document.getElementById('guided-tip-text');
    if (tipCard && phase.tip) {
      tipCard.hidden = false;
      tipDot.style.backgroundColor = zone.color;
      tipText.textContent = phase.tip;
    } else if (tipCard) {
      tipCard.hidden = true;
    }

    // Next phase preview
    const nextCard = document.getElementById('guided-next-card');
    const nextPhase = plan.phases[this.guidedPhaseIndex + 1];
    if (nextCard && nextPhase) {
      const nextZone = Plans.getPhaseZone(nextPhase);
      nextCard.hidden = false;
      document.getElementById('guided-next-dot').style.backgroundColor = nextZone.color;
      document.getElementById('guided-next-name').textContent = nextPhase.name;
      document.getElementById('guided-next-meta').textContent =
        `${Plans.formatDuration(nextPhase.duration)} · Z${nextPhase.zone} · ${nextPhase.rpmMin}–${nextPhase.rpmMax} rpm`;
    } else if (nextCard) {
      nextCard.hidden = true;
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
    const zoneCalc = this.zoneCalcForProfile();
    const phase = this.guidedPlan.phases[this.guidedPhaseIndex];
    const bpmTarget = Plans.resolvePhaseBPM(phase, zoneCalc);
    const zone = Plans.getPhaseZone(phase);

    // BPM display
    const bpmEl = document.getElementById('guided-bpm');
    if (bpmEl) bpmEl.textContent = dp.bpm || '--';

    // BPM circle color
    // No guiado a cor é a da zona PEDIDA: o número ao lado diz se você está nela.
    document.getElementById('guided-bpm-circle')?.style.setProperty('--zone-color', zone.color);

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
      'on_target': 'No alvo',
      'close_below': 'Quase · suba',
      'close_above': 'Quase · alivie',
      'below': 'Suba',
      'above': 'Alivie',
      'no_data': 'sem dado'
    };

    badge.textContent = labels[status] || '—';
    badge.className = `target-badge ${status}`;
  }

  toggleGuidedPause() {
    if (!this.recorder) return;

    // Igual ao togglePause do treino livre: um toque deliberado sempre vence o estado
    // automático. Sem isto, uma pausa manual podia ser desfeita pelo sensor de cadência.
    this.autoPaused = false;

    if (this.recorder.isPaused) this.recorder.resume();
    else this.recorder.pause();

    this.setPauseButton(this.recorder.isPaused);
  }

  stopGuidedWorkout() {
    this.closeModal('guided-stop-modal');

    this.stopTicking();

    this.clearWatchWorkout();

    if (this.recorder) {
      this.recorder.stop();
      this.viewingSummary = this.recorder.getSummary();
      // Marca no próprio treino: sem isto uma sessão do simulador ficava indistinguível
      // de uma real em histórico, recordes, tendência e escada de progressão.
      if (this.demoMode) this.viewingSummary.demo = true;
      if (this.viewingSummary && this.guidedPlan) {
        this.viewingSummary.planName = this.guidedPlan.name;
        // planId is what lets the progression engine grade this session later.
        this.viewingSummary.planId = this.guidedPlan.id;
        this.viewingSummary.category = this.guidedPlan.category || null;
        // Snapshot das fases de fato pedaladas: a versão ajustada à sua dose não existe no
        // catálogo, e a avaliação (progression.evaluateSession) precisa julgar contra ela.
        this.viewingSummary.planPhases = this.guidedPlan.phases.map(p => ({ ...p }));
      }
    }

    Haptics.cancel();

    this.guidedPlan = null;
    this.concludeSession();
  }

  // ══════════════════════════════════════════
  // WORKOUT PERSISTENCE & RECOVERY
  // ══════════════════════════════════════════

  persistWorkoutState(type) {
    // Treino já encerrado não é "em andamento". O gravador fica em memória depois do fim
    // (o resumo ainda o usa), e o salvamento de segurança ao ir para segundo plano o
    // regravava como ativo: no boot seguinte, o modal oferecia retomar um treino que tinha
    // acabado — inclusive um que o usuário acabara de descartar.
    if (!this.recorder || this.recorder.endTime) return;

    const state = {
      type, // 'free' or 'guided'
      demoMode: this.demoMode,
      recorder: this.recorder.getState(),
      savedAt: Date.now()
    };

    if (type === 'guided' && this.guidedPlan) {
      state.planId = this.guidedPlan.id;
      state.planName = this.guidedPlan.name;
      state.planPhases = this.guidedPlan.phases;
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
      const ok = Storage.saveActiveWorkout(toSave);
      // Falhar aqui significa que a recuperação de sessão parou de funcionar. Era só um
      // console.warn: o usuário seguia o treino inteiro achando que estava protegido.
      // Avisa uma vez por treino, para não virar barulho a cada 5 s.
      if (!ok && !this._persistWarned) {
        this._persistWarned = true;
        this.toast('Armazenamento cheio: este treino não poderá ser recuperado se o app fechar.', 'error', 6000);
      }
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

    let typeLabel = 'Treino livre';
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

    this.recorder = new WorkoutRecorder(profile, { metersPerRev: Goals.metersPerRev() });
    this.recorder.restoreState(saved.recorder);
    // Sem isto o auto-pause fica morto após uma recuperação: checkAutoPause sai cedo
    // enquanto lastPedalAt for 0, e ele só voltaria no primeiro evento de cadência.
    this.autoPaused = false;
    this.lastPedalAt = Date.now();
    this._persistWarned = false;

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
      pauseBtn.textContent = 'Retomar';
    }

    // Show workout view
    this.showView('workout');
    this.requestWakeLock();

    // Start tick loop
    this.startTicking(() => this.workoutTick(), 'Treino livre');

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

    // Find the plan — com as fases e o nome que estavam rodando, se foram ajustados.
    const base = Plans.getAllPlans().find(p => p.id === saved.planId);
    const plan = base && Array.isArray(saved.planPhases) && saved.planPhases.length
      ? { ...base, name: saved.planName || base.name, phases: saved.planPhases }
      : base;
    if (!plan) {
      // Plan not found, fall back to free workout resume
      this.resumeWorkout(saved);
      return;
    }

    this.guidedPlan = plan;
    this.demoMode = saved.demoMode || false;
    this._phaseWarnFired = false;
    this._finalWarnFired = false;

    this.recorder = new WorkoutRecorder(profile, { metersPerRev: Goals.metersPerRev() });
    this.recorder.restoreState(saved.recorder);

    // Índice derivado do relógio, não lido do estado salvo: um scratch state gravado pela
    // versão antiga contava ticks e estava atrasado em relação ao tempo real. Assim ele se
    // conserta sozinho na primeira retomada.
    const resumedAt = Math.floor(this.recorder.elapsedMs / 1000);
    const slot = this.phaseAt(plan, resumedAt);
    this.guidedPhaseIndex = slot ? slot.index : (saved.guidedPhaseIndex || 0);
    this.guidedPhaseElapsed = slot ? slot.into : (saved.guidedPhaseElapsed || 0);
    this.guidedTotalElapsed = resumedAt;
    // Sem isto o auto-pause fica morto após uma recuperação: checkAutoPause sai cedo
    // enquanto lastPedalAt for 0, e ele só voltaria no primeiro evento de cadência.
    this.autoPaused = false;
    this.lastPedalAt = Date.now();
    this._persistWarned = false;

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
      pauseBtn.textContent = 'Retomar';
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
    this.startTicking(() => this.guidedTick(), this.guidedPlan?.name || 'Treino guiado');

    // Setup BLE if demo mode
    if (this.demoMode) {
      this.getBLE();
    }
  }

  // ── Plan Creator ──

  /**
   * Abre o criador, em branco ou carregado com um plano existente.
   *
   * O storage sempre soube atualizar por id (saveCustomPlan faz upsert), mas não havia
   * caminho na interface: qualquer ajuste num treino personalizado significava recriá-lo
   * do zero e apagar o antigo.
   */
  showPlanCreator(plan = null) {
    this.editingPlanId = plan?.id || null;

    document.getElementById('creator-name').value = plan?.name || '';
    const categorySelect = document.getElementById('creator-category');
    if (categorySelect) {
      categorySelect.innerHTML = Plans.CATEGORIES
        .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
      categorySelect.value = plan?.category || 'folego';
    }
    document.getElementById('creator-desc').value = plan?.description || '';
    document.getElementById('creator-difficulty').value = plan?.difficulty || 'Iniciante';

    const title = document.getElementById('creator-title');
    if (title) title.textContent = plan ? 'Editar Treino' : 'Criar Treino';

    this.creatorPhases = plan
      ? plan.phases.map(p => ({ ...p }))
      : [
        { name: 'Aquecimento', duration: 300, zone: 1, rpmMin: 50, rpmMax: 65, tip: '' },
        { name: 'Principal', duration: 600, zone: 2, rpmMin: 65, rpmMax: 80, tip: '' },
        { name: 'Volta à Calma', duration: 240, zone: 1, rpmMin: 45, rpmMax: 55, tip: '' },
      ];
    this.renderCreatorPhases();
    this.showView('plan-creator');
  }

  editSelectedPlan() {
    if (this.selectedPlan) this.showPlanCreator(this.selectedPlan);
  }

  updateCreatorTotal() {
    const el = document.getElementById('creator-total');
    if (!el) return;
    const seconds = this.creatorPhases.reduce((sum, p) => sum + (p.duration || 0), 0);
    el.textContent = Plans.formatDuration(seconds);
  }

  renderCreatorPhases() {
    const container = document.getElementById('creator-phases');
    if (!container) return;

    container.innerHTML = this.creatorPhases.map((phase, i) => `
      <div class="creator-phase-card">
        <div class="creator-phase-num" id="phase-${i}-num">Fase ${i + 1}</div>
        <div class="creator-phase-tools">
          <button class="creator-phase-tool" data-move="up" data-idx="${i}"
                  ${i === 0 ? 'disabled' : ''} aria-label="Mover fase ${i + 1} para cima">↑</button>
          <button class="creator-phase-tool" data-move="down" data-idx="${i}"
                  ${i === this.creatorPhases.length - 1 ? 'disabled' : ''} aria-label="Mover fase ${i + 1} para baixo">↓</button>
          <!-- Building an interval set meant retyping the same phase over and over. -->
          <button class="creator-phase-tool" data-duplicate="${i}" aria-label="Duplicar fase ${i + 1}">⧉</button>
        </div>
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
        <div class="form-group" style="margin-bottom:0">
          <!-- A tela de treino guiado tem um card de dica que ficava permanentemente vazio
               nos planos personalizados, porque o criador não coletava este campo. -->
          <label class="form-label-xs" for="phase-${i}-tip">Dica (opcional)</label>
          <input type="text" id="phase-${i}-tip" class="form-input" data-field="tip" data-idx="${i}"
                 value="${escapeHtml(phase.tip || '')}" placeholder="Ex: sentado, mão na barra">
        </div>
      </div>
    `).join('');

    this.updateCreatorTotal();

    // Bind events
    container.querySelectorAll('.creator-phase-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        this.creatorPhases.splice(idx, 1);
        this.renderCreatorPhases();
      });
    });

    container.querySelectorAll('[data-move]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const target = btn.dataset.move === 'up' ? idx - 1 : idx + 1;
        if (target < 0 || target >= this.creatorPhases.length) return;
        const phases = this.creatorPhases;
        [phases[idx], phases[target]] = [phases[target], phases[idx]];
        this.renderCreatorPhases();
        // Follow the phase that moved, so repeated taps keep working without re-aiming.
        container.querySelector(`[data-move="${btn.dataset.move}"][data-idx="${target}"]`)?.focus();
      });
    });

    container.querySelectorAll('[data-duplicate]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.duplicate);
        const source = this.creatorPhases[idx];
        if (!source) return;
        this.creatorPhases.splice(idx + 1, 0, { ...source });
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
        if (field === 'tip') phase.tip = input.value.trim();
        if (field === 'duration') {
          phase.duration = parseInt(input.value) * 60 || 60;
          this.updateCreatorTotal();
        }
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
      // Preserva o id ao editar, senão salvar viraria sempre uma cópia nova.
      id: this.editingPlanId || 'custom_' + Date.now(),
      name,
      category: document.getElementById('creator-category')?.value || 'folego',
      description: document.getElementById('creator-desc').value || '',
      difficulty: document.getElementById('creator-difficulty').value,
      focus: 'Personalizado',
      phases: this.creatorPhases.map(p => ({ ...p })),
    };

    if (Plans.saveCustomPlan(plan)) {
      this.toast(this.editingPlanId ? 'Treino atualizado.' : 'Treino personalizado salvo.', 'success');
    } else {
      this.toast('Não foi possível salvar o treino.', 'error');
    }
    this.showView('home');
  }
}

/** Seconds of warning before a phase change and before the workout ends. */
const HAPTIC_WARNING_LEAD = 5;
const HAPTIC_FINAL_LEAD = 10;

/** Cor do selo de RPE: caminha a paleta de zonas, então o esforço se lê pela cor. */
function rpeColor(rpe) {
  return ZONES[Math.min(4, Math.max(0, Math.floor((rpe - 1) / 2)))].color;
}

/** Plan and phase names are user input rendered through innerHTML. */
/** Número com vírgula decimal, como se lê no Brasil. */
function formatDecimal(value, digits = 1) {
  return (Number(value) || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

/** mm:ss, ou h:mm:ss acima de uma hora. */
function formatClock(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "18 min" ou "1 h 05 min". */
function formatMinutes(seconds) {
  const total = Math.round((seconds || 0) / 60);
  if (total < 60) return `${total} min`;
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`;
}

/** Cores do gráfico ao vivo: FC em vermelho (a convenção), cadência neutra. */
const CHART_HR = '#EF5350';
const CHART_RPM = '#8A9099';
/** Barras do Progresso: o volume (a métrica principal) no destaque, o resto neutro. */
const CHART_ACCENT = '#D4F54C';
const CHART_MUTED = '#5C636C';

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

/**
 * Service worker só no PWA.
 *
 * No APK os arquivos já são locais (o Capacitor os serve de dentro do pacote), então o
 * SW não acrescenta nada offline — e, sendo stale-while-revalidate, fazia o PRIMEIRO boot
 * depois de cada atualização do APK rodar o JS da versão anterior, que ainda estava no
 * cache. Uma correção instalada só valia a partir do segundo boot. Os registros e caches
 * deixados por versões antigas são removidos aqui.
 */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  if (window.Capacitor?.isNativePlatform?.()) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
    window.caches?.keys()
      .then(keys => keys.forEach(k => caches.delete(k)))
      .catch(() => {});
    return;
  }

  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  setupServiceWorker();

  try {
    window.app = new SpinSyncApp();
  } catch (e) {
    showBootError(e);
  }
});
