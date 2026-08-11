import { parseHeartRate } from './hr-parser.js';
import { CadenceParser } from './cadence-parser.js';
import * as Storage from './storage.js';

const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
const CSC_SERVICE = '00001816-0000-1000-8000-00805f9b34fb';
const CSC_MEASUREMENT = '00002a5b-0000-1000-8000-00805f9b34fb';

// Vendor-specific service exposed by the SpinSync Wear app so the phone can buzz the
// watch over the link it is already using for heart rate. A plain HR strap simply does
// not have it, and the write fails harmlessly once before being disabled.
const HAPTIC_SERVICE = '6b1a0001-4c2f-4d9a-9b3e-1f7a5c8d2e60';
const HAPTIC_CHARACTERISTIC = '6b1a0002-4c2f-4d9a-9b3e-1f7a5c8d2e60';
const WORKOUT_CHARACTERISTIC = '6b1a0003-4c2f-4d9a-9b3e-1f7a5c8d2e60';

/**
 * Packs the live workout state for the watch screen. Must stay byte-compatible with
 * parseWorkoutPacket in android/wear/.../GattUuids.kt.
 *
 *   byte 0    flags — bit0 active, bit1 guided, bit2 paused
 *   byte 1-2  elapsed seconds, uint16 LE
 *   byte 3-4  calories, uint16 LE
 *   byte 5-6  seconds to next phase, uint16 LE (0xFFFF = none)
 *   byte 7    phase shift: 0 none, 1 harder, 2 easier, 3 same
 *   byte 8    current heart-rate zone, 0-5
 *   byte 9-10 target cadence range
 *
 * 11 bytes, so it fits the 20-byte default ATT payload and never forces an MTU exchange.
 */
export function buildWorkoutPacket(s = {}) {
  const buf = new ArrayBuffer(11);
  const view = new DataView(buf);
  const u16 = (n) => Math.max(0, Math.min(0xfffe, Math.round(n || 0)));

  view.setUint8(0, (s.active ? 1 : 0) | (s.guided ? 2 : 0) | (s.paused ? 4 : 0));
  view.setUint16(1, u16(s.elapsedSeconds), true);
  view.setUint16(3, u16(s.calories), true);
  view.setUint16(5, s.secondsToNextPhase == null ? 0xffff : u16(s.secondsToNextPhase), true);
  view.setUint8(7, s.shift || 0);
  view.setUint8(8, Math.max(0, Math.min(5, s.zone || 0)));
  view.setUint8(9, Math.max(0, Math.min(255, s.rpmMin || 0)));
  view.setUint8(10, Math.max(0, Math.min(255, s.rpmMax || 0)));
  return view;
}

/** Phase shift ordinals — mirror of PhaseShift in GattUuids.kt. */
export const PHASE_SHIFT = { NONE: 0, HARDER: 1, EASIER: 2, SAME: 3 };

// Short UUIDs for Web Bluetooth API
const HR_SERVICE_SHORT = 0x180D;
const CSC_SERVICE_SHORT = 0x1816;

const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_RECONNECT_ATTEMPTS = 12;

// Heart rate straps and the watch both notify at ~1 Hz. Twelve seconds of silence on a
// link that still reports "connected" means the peripheral went to sleep — the phone
// would otherwise sit there showing a frozen BPM for the rest of the ride.
const HR_STALE_MS = 12000;
const WATCHDOG_INTERVAL_MS = 5000;

/**
 * Detect if running in Capacitor native context.
 */
function isCapacitorNative() {
  return typeof window !== 'undefined' &&
         window.Capacitor &&
         window.Capacitor.isNativePlatform &&
         window.Capacitor.isNativePlatform();
}

/**
 * Turns a plugin exception into a stable status token so the UI can say something
 * more useful than "Erro".
 */
function classifyError(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  if (msg.includes('cancel') || msg.includes('aborted')) return 'cancelled';
  if (err?.name === 'NotFoundError') return 'cancelled';
  if (msg.includes('not enabled') || msg.includes('is disabled') || msg.includes('turned off')) return 'bt-off';
  if (msg.includes('permission') || msg.includes('denied')) return 'no-permission';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('failed to fetch') || msg.includes('dynamically imported') || msg.includes('networkerror')) return 'offline';
  return 'error';
}

/**
 * BLE Manager using the native Capacitor plugin (@capacitor-community/bluetooth-le).
 * Used when running as an Android/iOS native app.
 *
 * Both sensors follow the same connect/notify/reconnect lifecycle, so the logic lives in
 * one generic implementation keyed by channel ('hr' | 'csc') with thin public wrappers.
 */
export class BLENativeManager extends EventTarget {
  constructor() {
    super();
    this.cadenceParser = new CadenceParser();
    this._ble = null;
    this._initialized = false;
    this._hapticUnsupported = false;

    this._channels = {
      hr: this._newChannel('hr', HR_SERVICE, HR_MEASUREMENT, 'HR Monitor'),
      csc: this._newChannel('csc', CSC_SERVICE, CSC_MEASUREMENT, 'Cadence Sensor')
    };

    this._watchdog = null;
  }

  _newChannel(kind, service, characteristic, defaultName) {
    return {
      kind, service, characteristic, defaultName,
      connected: false,
      deviceId: null,
      deviceName: null,
      autoReconnect: false,
      reconnectTimer: null,
      reconnectAttempt: 0,
      lastDataAt: 0
    };
  }

  get hrConnected() { return this._channels.hr.connected; }
  get cscConnected() { return this._channels.csc.connected; }
  get hrReconnecting() { return this._channels.hr.reconnectTimer !== null; }
  get cscReconnecting() { return this._channels.csc.reconnectTimer !== null; }

  // ── Plugin loading ───────────────────────────────────────────────────────

  async _ensureInitialized() {
    if (this._initialized) return;

    // js/vendor/bluetooth-le.js is loaded synchronously by index.html and shipped in the
    // APK, so this global is always there. The esm.sh fallback that used to sit here was
    // unreachable in the APK and, in the PWA, re-introduced exactly the network dependency
    // scripts/sync-vendor.mjs exists to remove.
    const BleClient = window.capacitorCommunityBluetoothLe?.BleClient;
    if (!BleClient) {
      throw new Error('Bundle BLE ausente — rode `npm run vendor:sync`');
    }

    this._ble = BleClient;

    // Triggers the runtime permission request on Android.
    await this._ble.initialize({ androidNeverForLocation: true });
    this._initialized = true;
    console.log('[BLE Native] Initialized successfully');
  }

  // ── Public API ───────────────────────────────────────────────────────────

  async connectHR() { return this._connect('hr'); }
  async connectCSC() { return this._connect('csc'); }
  async disconnectHR() { return this._disconnect('hr'); }
  async disconnectCSC() { return this._disconnect('csc'); }

  async disconnectAll() {
    await this._disconnect('hr');
    await this._disconnect('csc');
  }

  /**
   * Silently reconnects to previously used sensors. Called on startup — no picker,
   * no user tap, because on Android the saved deviceId is a stable MAC address.
   */
  async restoreSavedDevices() {
    for (const kind of ['hr', 'csc']) {
      const saved = Storage.getSavedDevice(kind);
      if (!saved) continue;
      try {
        await this._ensureInitialized();
        this._emit(`${kind}-status`, 'reconnecting');
        await this._attach(kind, saved.deviceId, saved.name);
      } catch (err) {
        console.log(`[BLE Native] Silent restore of ${kind} failed:`, err?.message);
        this._emit(`${kind}-status`, 'disconnected');
      }
    }
  }

  cancelReconnect(kind) {
    const ch = this._channels[kind];
    if (!ch) return;
    ch.autoReconnect = false;
    this._clearReconnectTimer(ch);
    this._emit(`${kind}-status`, 'disconnected');
  }

  // ── Connect / disconnect ─────────────────────────────────────────────────

  async _connect(kind) {
    const ch = this._channels[kind];

    // Tapping the button while a retry is pending means "stop trying".
    if (ch.reconnectTimer) {
      this.cancelReconnect(kind);
      return false;
    }

    try {
      await this._ensureInitialized();
      this._emit(`${kind}-status`, 'scanning');

      const device = await this._ble.requestDevice({
        services: [ch.service],
        // The haptic service is never advertised, so it has to be named here to be
        // reachable after connecting.
        optionalServices: kind === 'hr' ? [ch.service, HAPTIC_SERVICE] : [ch.service]
      });

      await this._attach(kind, device.deviceId, device.name);
      return true;
    } catch (err) {
      ch.connected = false;
      const status = classifyError(err);
      console.error(`[BLE Native] ${kind} error:`, err);
      this._emit(`${kind}-error`, err?.message || String(err));
      this._emit(`${kind}-status`, status);
      return false;
    }
  }

  /** Connects to a known deviceId and starts notifications. Throws on failure. */
  async _attach(kind, deviceId, name) {
    const ch = this._channels[kind];

    this._emit(`${kind}-status`, 'connecting');

    await this._ble.connect(
      deviceId,
      () => this._onDisconnected(kind),
      { timeout: CONNECT_TIMEOUT_MS }
    );

    if (kind === 'csc') this.cadenceParser.reset();

    await this._ble.startNotifications(
      deviceId,
      ch.service,
      ch.characteristic,
      (value) => this._onData(kind, value)
    );

    ch.connected = true;
    ch.deviceId = deviceId;
    ch.deviceName = name || ch.defaultName;
    ch.autoReconnect = true;
    ch.reconnectAttempt = 0;
    ch.lastDataAt = Date.now();
    this._clearReconnectTimer(ch);

    Storage.saveDevice(kind, { deviceId, name: ch.deviceName });

    this._emit(`${kind}-status`, 'connected');
    this._emit(`${kind}-connected`, { name: ch.deviceName });

    this._startWatchdog();
  }

  async _disconnect(kind) {
    const ch = this._channels[kind];

    ch.autoReconnect = false;
    this._clearReconnectTimer(ch);

    if (ch.deviceId && this._ble) {
      try { await this._ble.disconnect(ch.deviceId); } catch (e) { /* already gone */ }
    }

    ch.connected = false;
    ch.deviceId = null;
    ch.deviceName = null;
    if (kind === 'csc') this.cadenceParser.reset();
    // The next sensor may well support haptics even if this one didn't.
    if (kind === 'hr') this._hapticUnsupported = false;

    // An explicit disconnect means "forget this sensor" — otherwise the user could
    // never switch to a different one.
    Storage.clearSavedDevice(kind);

    this._stopWatchdogIfIdle();
  }

  /**
   * Buzzes the watch through the vendor haptic characteristic.
   * Silently becomes a no-op for peripherals that don't implement it.
   * @returns {Promise<boolean>} whether the cue was delivered
   */
  async sendHaptic(patternId) {
    const ch = this._channels.hr;
    if (!ch.connected || !ch.deviceId || !this._ble || this._hapticUnsupported) return false;

    try {
      await this._ble.writeWithoutResponse(
        ch.deviceId,
        HAPTIC_SERVICE,
        HAPTIC_CHARACTERISTIC,
        new DataView(Uint8Array.of(patternId & 0xff).buffer)
      );
      return true;
    } catch (err) {
      // A regular HR strap has no such service; stop trying rather than throwing once
      // per phase change for the rest of the session.
      this._hapticUnsupported = true;
      console.log('[BLE Native] Haptics unavailable on this sensor:', err?.message);
      return false;
    }
  }

  /**
   * Pushes elapsed time, calories and the upcoming phase change to the watch screen.
   * Same no-op-on-a-plain-strap contract as sendHaptic.
   */
  async sendWorkoutStatus(status) {
    const ch = this._channels.hr;
    if (!ch.connected || !ch.deviceId || !this._ble || this._workoutUnsupported) return false;

    try {
      await this._ble.writeWithoutResponse(
        ch.deviceId, HAPTIC_SERVICE, WORKOUT_CHARACTERISTIC, buildWorkoutPacket(status)
      );
      return true;
    } catch (err) {
      this._workoutUnsupported = true;
      console.log('[BLE Native] Workout mirroring unavailable:', err?.message);
      return false;
    }
  }

  _onData(kind, value) {
    const ch = this._channels[kind];
    // Deliberately before parsing: a packet reporting *no* sensor contact still proves the
    // link is alive, so it must keep the HR_STALE_MS watchdog from forcing a reconnect.
    ch.lastDataAt = Date.now();

    if (kind === 'hr') {
      this._emit('hr-data', parseHeartRate(value));
    } else {
      const result = this.cadenceParser.parse(value);
      if (result) this._emit('csc-data', result);
    }
  }

  // ── Reconnection ─────────────────────────────────────────────────────────

  _onDisconnected(kind) {
    const ch = this._channels[kind];
    if (!ch.connected && !ch.autoReconnect) return;
    // The watchdog forces a disconnect itself and schedules the retry, so the plugin's
    // disconnect callback must not schedule a second one on top of it.
    if (ch.reconnectTimer) return;

    ch.connected = false;
    this._emit(`${kind}-disconnected`);

    if (ch.autoReconnect && ch.deviceId) {
      this._scheduleReconnect(kind);
    } else {
      this._emit(`${kind}-status`, 'disconnected');
      this._stopWatchdogIfIdle();
    }
  }

  _scheduleReconnect(kind) {
    const ch = this._channels[kind];
    this._clearReconnectTimer(ch);

    if (ch.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[BLE Native] Giving up reconnecting ${kind}`);
      ch.autoReconnect = false;
      ch.reconnectAttempt = 0;
      this._emit(`${kind}-status`, 'disconnected');
      return;
    }

    const delay = RECONNECT_BACKOFF_MS[
      Math.min(ch.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
    ];
    ch.reconnectAttempt++;

    this._emit(`${kind}-status`, 'reconnecting');

    ch.reconnectTimer = setTimeout(async () => {
      ch.reconnectTimer = null;
      if (!ch.autoReconnect || !ch.deviceId) return;
      try {
        await this._attach(kind, ch.deviceId, ch.deviceName);
      } catch (err) {
        console.log(`[BLE Native] Reconnect ${kind} attempt ${ch.reconnectAttempt} failed`);
        this._scheduleReconnect(kind);
      }
    }, delay);
  }

  _clearReconnectTimer(ch) {
    if (ch.reconnectTimer) {
      clearTimeout(ch.reconnectTimer);
      ch.reconnectTimer = null;
    }
  }

  // ── Stale-data watchdog ──────────────────────────────────────────────────

  /**
   * HR only. Cadence legitimately stops notifying when the rider stops pedalling
   * (CadenceParser returns null to hold the last value), so silence there is normal.
   */
  _startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(() => {
      const ch = this._channels.hr;
      if (!ch.connected) return;
      if (Date.now() - ch.lastDataAt < HR_STALE_MS) return;

      console.warn('[BLE Native] HR link is connected but silent — forcing reconnect');
      this._emit('hr-status', 'stale');
      ch.connected = false;
      if (ch.deviceId) {
        this._ble?.disconnect(ch.deviceId).catch(() => {});
        this._scheduleReconnect('hr');
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  _stopWatchdogIfIdle() {
    const anyActive = Object.values(this._channels)
      .some(ch => ch.connected || ch.autoReconnect);
    if (anyActive || !this._watchdog) return;
    clearInterval(this._watchdog);
    this._watchdog = null;
  }

  _emit(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }
}

/**
 * BLE Manager using Web Bluetooth API.
 * Used when running as PWA in Chrome browser.
 */
export class BLEManager extends EventTarget {
  constructor() {
    super();
    this.hrDevice = null;
    this.cscDevice = null;
    this.hrServer = null;
    this.cscServer = null;
    this.hrCharacteristic = null;
    this.cscCharacteristic = null;
    this.cadenceParser = new CadenceParser();
    this._hrConnected = false;
    this._cscConnected = false;
    this._hrAutoReconnect = false;
    this._hrReconnectTimer = null;
    this._hrReconnectAttempt = 0;
    this._hapticUnsupported = false;
  }

  get hrConnected() { return this._hrConnected; }
  get cscConnected() { return this._cscConnected; }
  get hrReconnecting() { return this._hrReconnectTimer !== null; }
  get cscReconnecting() { return false; }

  async connectHR() {
    if (this._hrReconnectTimer) {
      this.cancelReconnect('hr');
      return false;
    }
    try {
      this._emit('hr-status', 'scanning');

      this.hrDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE_SHORT] }],
        optionalServices: [HR_SERVICE_SHORT, HAPTIC_SERVICE]
      });

      this.hrDevice.addEventListener('gattserverdisconnected', () => {
        this._hrConnected = false;
        this._emit('hr-disconnected');
        if (this._hrAutoReconnect) {
          this._scheduleHRReconnect();
        } else {
          this._emit('hr-status', 'disconnected');
        }
      });

      await this._attachHR();
      this._hrAutoReconnect = true;
      return true;
    } catch (err) {
      this._hrConnected = false;
      const status = classifyError(err);
      if (status !== 'cancelled') {
        console.error('HR connection error:', err);
        this._emit('hr-error', err.message);
      }
      this._emit('hr-status', status);
      return false;
    }
  }

  /** (Re)opens GATT on an already-picked device. Throws on failure. */
  async _attachHR() {
    this._emit('hr-status', 'connecting');
    this.hrServer = await this.hrDevice.gatt.connect();

    const service = await this.hrServer.getPrimaryService(HR_SERVICE_SHORT);
    this.hrCharacteristic = await service.getCharacteristic(0x2A37);

    await this.hrCharacteristic.startNotifications();
    this.hrCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
      this._emit('hr-data', parseHeartRate(e.target.value));
    });

    this._hrConnected = true;
    this._hrReconnectAttempt = 0;
    this._emit('hr-status', 'connected');
    this._emit('hr-connected', { name: this.hrDevice.name || 'HR Monitor' });
  }

  _scheduleHRReconnect() {
    if (this._hrReconnectTimer) clearTimeout(this._hrReconnectTimer);

    if (this._hrReconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this._hrAutoReconnect = false;
      this._hrReconnectAttempt = 0;
      this._emit('hr-status', 'disconnected');
      return;
    }

    const delay = RECONNECT_BACKOFF_MS[
      Math.min(this._hrReconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
    ];
    this._hrReconnectAttempt++;
    this._emit('hr-status', 'reconnecting');

    this._hrReconnectTimer = setTimeout(async () => {
      this._hrReconnectTimer = null;
      if (!this._hrAutoReconnect || !this.hrDevice) return;
      try {
        await this._attachHR();
      } catch (err) {
        this._scheduleHRReconnect();
      }
    }, delay);
  }

  cancelReconnect(kind) {
    if (kind !== 'hr') return;
    this._hrAutoReconnect = false;
    if (this._hrReconnectTimer) {
      clearTimeout(this._hrReconnectTimer);
      this._hrReconnectTimer = null;
    }
    this._emit('hr-status', 'disconnected');
  }

  async restoreSavedDevices() {
    // Web Bluetooth cannot reconnect without a user gesture — nothing to restore.
  }

  async sendHaptic(patternId) {
    if (!this._hrConnected || !this.hrServer?.connected || this._hapticUnsupported) return false;
    try {
      const service = await this.hrServer.getPrimaryService(HAPTIC_SERVICE);
      const characteristic = await service.getCharacteristic(HAPTIC_CHARACTERISTIC);
      await characteristic.writeValueWithoutResponse(Uint8Array.of(patternId & 0xff));
      return true;
    } catch (err) {
      this._hapticUnsupported = true;
      return false;
    }
  }

  async sendWorkoutStatus(status) {
    if (!this._hrConnected || !this.hrServer?.connected || this._workoutUnsupported) return false;
    try {
      const service = await this.hrServer.getPrimaryService(HAPTIC_SERVICE);
      const characteristic = await service.getCharacteristic(WORKOUT_CHARACTERISTIC);
      await characteristic.writeValueWithoutResponse(buildWorkoutPacket(status));
      return true;
    } catch (err) {
      this._workoutUnsupported = true;
      return false;
    }
  }

  async connectCSC() {
    try {
      this._emit('csc-status', 'scanning');

      this.cscDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CSC_SERVICE_SHORT] }],
        optionalServices: [CSC_SERVICE_SHORT]
      });

      this.cscDevice.addEventListener('gattserverdisconnected', () => {
        this._cscConnected = false;
        this._emit('csc-status', 'disconnected');
        this._emit('csc-disconnected');
      });

      this._emit('csc-status', 'connecting');
      this.cscServer = await this.cscDevice.gatt.connect();

      const service = await this.cscServer.getPrimaryService(CSC_SERVICE_SHORT);
      this.cscCharacteristic = await service.getCharacteristic(0x2A5B);

      this.cadenceParser.reset();

      await this.cscCharacteristic.startNotifications();
      this.cscCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
        const result = this.cadenceParser.parse(e.target.value);
        if (result) {
          this._emit('csc-data', result);
        }
      });

      this._cscConnected = true;
      this._emit('csc-status', 'connected');
      this._emit('csc-connected', { name: this.cscDevice.name || 'Cadence Sensor' });

      return true;
    } catch (err) {
      this._cscConnected = false;
      const status = classifyError(err);
      if (status !== 'cancelled') {
        console.error('CSC connection error:', err);
        this._emit('csc-error', err.message);
      }
      this._emit('csc-status', status);
      return false;
    }
  }

  disconnectHR() {
    this.cancelReconnect('hr');
    if (this.hrServer && this.hrServer.connected) {
      this.hrServer.disconnect();
    }
    this._hrConnected = false;
  }

  disconnectCSC() {
    if (this.cscServer && this.cscServer.connected) {
      this.cscServer.disconnect();
    }
    this._cscConnected = false;
    this.cadenceParser.reset();
  }

  disconnectAll() {
    this.disconnectHR();
    this.disconnectCSC();
  }

  _emit(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }
}

/**
 * Simulador para modo demo (sem sensores BLE).
 * Emite dados simulados para testar a UI.
 */
export class BLESimulator extends EventTarget {
  constructor() {
    super();
    this._hrConnected = false;
    this._cscConnected = false;
    this._hrInterval = null;
    this._cscInterval = null;
    this._baseBPM = 75;
    this._baseRPM = 0;
    this._time = 0;
  }

  get hrConnected() { return this._hrConnected; }
  get cscConnected() { return this._cscConnected; }
  get hrReconnecting() { return false; }
  get cscReconnecting() { return false; }

  async connectHR() {
    this._emit('hr-status', 'scanning');
    await this._delay(800);
    this._emit('hr-status', 'connecting');
    await this._delay(500);
    this._hrConnected = true;
    this._emit('hr-status', 'connected');
    this._emit('hr-connected', { name: 'Demo HR Monitor' });

    this._hrInterval = setInterval(() => {
      this._time += 1;
      // Simula um treino realista: aquecimento → pico → recuperação
      const phase = this._time / 60; // minutos
      let targetBPM;
      if (phase < 3) {
        targetBPM = 80 + phase * 15; // aquecimento
      } else if (phase < 15) {
        targetBPM = 130 + Math.sin(phase * 0.5) * 25; // treino
      } else if (phase < 20) {
        targetBPM = 155 + Math.sin(phase * 0.8) * 20; // pico
      } else {
        targetBPM = 140 - (phase - 20) * 5; // recuperação
      }
      this._baseBPM += (targetBPM - this._baseBPM) * 0.1;
      const bpm = Math.round(this._baseBPM + (Math.random() - 0.5) * 4);
      this._emit('hr-data', { bpm: Math.max(60, Math.min(195, bpm)), contact: true, contactSupported: false });
    }, 1000);

    return true;
  }

  async connectCSC() {
    this._emit('csc-status', 'scanning');
    await this._delay(600);
    this._emit('csc-status', 'connecting');
    await this._delay(400);
    this._cscConnected = true;
    this._emit('csc-status', 'connected');
    this._emit('csc-connected', { name: 'Demo XOSS ARENA' });

    this._cscInterval = setInterval(() => {
      const phase = this._time / 60;
      let targetRPM;
      if (phase < 2) {
        targetRPM = 40 + phase * 15;
      } else if (phase < 15) {
        targetRPM = 70 + Math.sin(phase * 0.6) * 15;
      } else if (phase < 20) {
        targetRPM = 85 + Math.sin(phase) * 10;
      } else {
        targetRPM = 60 - (phase - 20) * 3;
      }
      this._baseRPM += (targetRPM - this._baseRPM) * 0.15;
      const rpm = Math.round(this._baseRPM + (Math.random() - 0.5) * 6);
      this._emit('csc-data', { rpm: Math.max(0, Math.min(150, rpm)) });
    }, 1200);

    return true;
  }

  disconnectHR() {
    clearInterval(this._hrInterval);
    this._hrConnected = false;
    this._emit('hr-status', 'disconnected');
  }

  disconnectCSC() {
    clearInterval(this._cscInterval);
    this._cscConnected = false;
    this._emit('csc-status', 'disconnected');
  }

  disconnectAll() {
    this.disconnectHR();
    this.disconnectCSC();
    this._time = 0;
    this._baseBPM = 75;
    this._baseRPM = 0;
  }

  cancelReconnect() { /* nothing to cancel in demo mode */ }
  async restoreSavedDevices() { /* nothing to restore in demo mode */ }
  async sendHaptic() { return false; /* no watch in demo mode */ }
  async sendWorkoutStatus() { return false; /* no watch in demo mode */ }

  _emit(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

/**
 * Factory: returns the correct BLE manager for the current platform.
 */
export function createBLEManager() {
  if (isCapacitorNative()) {
    console.log('[BLE] Using native Capacitor BLE plugin');
    return new BLENativeManager();
  }
  console.log('[BLE] Using Web Bluetooth API');
  return new BLEManager();
}
