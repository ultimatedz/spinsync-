import { parseHeartRate } from './hr-parser.js';
import { CadenceParser } from './cadence-parser.js';

const HR_SERVICE = 0x180D;
const HR_MEASUREMENT = 0x2A37;
const CSC_SERVICE = 0x1816;
const CSC_MEASUREMENT = 0x2A5B;

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
  }

  get hrConnected() { return this._hrConnected; }
  get cscConnected() { return this._cscConnected; }

  async connectHR() {
    try {
      this._emit('hr-status', 'scanning');

      this.hrDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HR_SERVICE] }],
        optionalServices: [HR_SERVICE]
      });

      this.hrDevice.addEventListener('gattserverdisconnected', () => {
        this._hrConnected = false;
        this._emit('hr-status', 'disconnected');
        this._emit('hr-disconnected');
      });

      this._emit('hr-status', 'connecting');
      this.hrServer = await this.hrDevice.gatt.connect();

      const service = await this.hrServer.getPrimaryService(HR_SERVICE);
      this.hrCharacteristic = await service.getCharacteristic(HR_MEASUREMENT);

      await this.hrCharacteristic.startNotifications();
      this.hrCharacteristic.addEventListener('characteristicvaluechanged', (e) => {
        const result = parseHeartRate(e.target.value);
        this._emit('hr-data', result);
      });

      this._hrConnected = true;
      this._emit('hr-status', 'connected');
      this._emit('hr-connected', { name: this.hrDevice.name || 'HR Monitor' });

      return true;
    } catch (err) {
      this._hrConnected = false;
      if (err.name === 'NotFoundError') {
        this._emit('hr-status', 'cancelled');
      } else {
        console.error('HR connection error:', err);
        this._emit('hr-status', 'error');
        this._emit('hr-error', err.message);
      }
      return false;
    }
  }

  async connectCSC() {
    try {
      this._emit('csc-status', 'scanning');

      this.cscDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CSC_SERVICE] }],
        optionalServices: [CSC_SERVICE]
      });

      this.cscDevice.addEventListener('gattserverdisconnected', () => {
        this._cscConnected = false;
        this._emit('csc-status', 'disconnected');
        this._emit('csc-disconnected');
      });

      this._emit('csc-status', 'connecting');
      this.cscServer = await this.cscDevice.gatt.connect();

      const service = await this.cscServer.getPrimaryService(CSC_SERVICE);
      this.cscCharacteristic = await service.getCharacteristic(CSC_MEASUREMENT);

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
      if (err.name === 'NotFoundError') {
        this._emit('csc-status', 'cancelled');
      } else {
        console.error('CSC connection error:', err);
        this._emit('csc-status', 'error');
        this._emit('csc-error', err.message);
      }
      return false;
    }
  }

  disconnectHR() {
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
      this._emit('hr-data', { bpm: Math.max(60, Math.min(195, bpm)) });
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

  _emit(type, data) {
    this.dispatchEvent(new CustomEvent(type, { detail: data }));
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
