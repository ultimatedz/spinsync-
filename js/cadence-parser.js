/**
 * Parser da CSC Measurement characteristic (0x2A5B).
 *
 * Layout do perfil Cycling Speed and Cadence:
 *   byte 0        flags — bit0 dados de roda presentes, bit1 dados de pedivela presentes
 *   bytes 1-4     Cumulative Wheel Revolutions, uint32 LE   (se bit0)
 *   bytes 5-6     Last Wheel Event Time, uint16 LE, 1/1024 s (se bit0)
 *   depois        Cumulative Crank Revolutions, uint16 LE   (se bit1)
 *                 Last Crank Event Time, uint16 LE, 1/1024 s
 *
 * O campo de roda era pulado com um `offset += 6` e a leitura abortava quando não havia
 * pedivela — ou seja, um sensor só de velocidade ficava totalmente ignorado mesmo
 * conectado, e não havia velocidade nem distância em lugar nenhum do app (o TCX exportado
 * saía com 0 km, e o Strava importava a atividade sem distância).
 */

/** Circunferência padrão: 700x23c, o valor que quase todo ciclocomputador assume. */
export const DEFAULT_WHEEL_MM = 2096;

/** Sem evento novo por este tempo, a roda/pedivela está parada, não silenciosa. */
const STOPPED_AFTER_MS = 2500;

export class CadenceParser {
  /** @param {number} wheelCircumferenceMm circunferência da roda, em milímetros. */
  constructor(wheelCircumferenceMm = DEFAULT_WHEEL_MM) {
    this.wheelMm = wheelCircumferenceMm;
    this.reset();
  }

  setWheelCircumference(mm) {
    if (Number.isFinite(mm) && mm >= 800 && mm <= 3000) this.wheelMm = mm;
  }

  parse(dataView) {
    if (!dataView || dataView.byteLength < 1) return null;

    const flags = dataView.getUint8(0);
    const hasWheel = (flags & 0x01) !== 0;
    const hasCrank = (flags & 0x02) !== 0;
    if (!hasWheel && !hasCrank) return null;

    const now = Date.now();
    const result = {};
    let offset = 1;

    if (hasWheel && dataView.byteLength >= offset + 6) {
      const revs = dataView.getUint32(offset, true);
      const time = dataView.getUint16(offset + 4, true);
      offset += 6;
      Object.assign(result, this._wheel(revs, time, now));
    }

    if (hasCrank && dataView.byteLength >= offset + 4) {
      const revs = dataView.getUint16(offset, true);
      const time = dataView.getUint16(offset + 2, true);
      Object.assign(result, this._crank(revs, time, now));
    }

    return Object.keys(result).length ? result : null;
  }

  _crank(revs, time, now) {
    if (this.lastCrankRevs === null) {
      this.lastCrankRevs = revs;
      this.lastCrankTime = time;
      this.lastCrankAt = now;
      return { rpm: 0 };
    }

    const deltaRevs = wrap16(revs - this.lastCrankRevs);
    const deltaTime = wrap16(time - this.lastCrankTime);

    if (deltaTime === 0 || deltaRevs === 0) {
      // O sensor notifica mais rápido do que a volta completa. Só depois de um tempo sem
      // evento novo é que a pessoa realmente parou de pedalar.
      return now - this.lastCrankAt > STOPPED_AFTER_MS ? { rpm: 0 } : {};
    }

    this.lastCrankRevs = revs;
    this.lastCrankTime = time;
    this.lastCrankAt = now;

    const rpm = Math.round((deltaRevs / (deltaTime / 1024)) * 60);
    // Descarta lixo de overflow temporário.
    return rpm >= 0 && rpm <= 200 ? { rpm } : {};
  }

  _wheel(revs, time, now) {
    if (this.lastWheelRevs === null) {
      this.lastWheelRevs = revs;
      this.lastWheelTime = time;
      this.lastWheelAt = now;
      this.firstWheelRevs = revs;
      return { speedKmh: 0, distanceM: 0 };
    }

    // Revoluções acumuladas são uint32: o rollover leva anos de pedalada, mas o contador
    // também zera quando o sensor reinicia. Nesse caso reancoramos, senão a distância
    // daria um salto negativo.
    if (revs < this.lastWheelRevs) {
      this.lastWheelRevs = revs;
      this.firstWheelRevs = revs - this.totalWheelRevs;
    }

    const deltaRevs = revs - this.lastWheelRevs;
    const deltaTime = wrap16(time - this.lastWheelTime);

    if (deltaTime === 0 || deltaRevs === 0) {
      if (now - this.lastWheelAt > STOPPED_AFTER_MS) {
        return { speedKmh: 0, distanceM: this.distanceM };
      }
      return {};
    }

    this.lastWheelRevs = revs;
    this.lastWheelTime = time;
    this.lastWheelAt = now;
    this.totalWheelRevs = revs - this.firstWheelRevs;

    const metres = (deltaRevs * this.wheelMm) / 1000;
    const speedKmh = Math.round((metres / (deltaTime / 1024)) * 3.6 * 10) / 10;
    this.distanceM = Math.round((this.totalWheelRevs * this.wheelMm) / 1000);

    // 120 km/h numa bike de spinning é lixo de sensor, não pedalada.
    if (speedKmh < 0 || speedKmh > 120) return { distanceM: this.distanceM };

    return { speedKmh, distanceM: this.distanceM };
  }

  reset() {
    this.lastCrankRevs = null;
    this.lastCrankTime = null;
    this.lastCrankAt = 0;

    this.lastWheelRevs = null;
    this.lastWheelTime = null;
    this.lastWheelAt = 0;
    this.firstWheelRevs = 0;
    this.totalWheelRevs = 0;
    this.distanceM = 0;
  }
}

/** Diferença de contador uint16, tratando o rollover. */
function wrap16(delta) {
  return delta < 0 ? delta + 65536 : delta;
}
