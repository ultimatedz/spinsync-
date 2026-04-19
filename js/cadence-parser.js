/**
 * Parser para CSC Measurement characteristic (0x2A5B).
 * Calcula RPM instantâneo a partir das diferenças entre leituras.
 */
export class CadenceParser {
  constructor() {
    this.lastCrankRevs = null;
    this.lastCrankTime = null;
    this.lastReceiveTime = 0;
  }

  parse(dataView) {
    const flags = dataView.getUint8(0);
    const hasCrank = (flags >> 1) & 0x01;
    const hasWheel = flags & 0x01;

    if (!hasCrank) return null;

    let offset = 1;
    if (hasWheel) {
      offset += 6;
    }

    const crankRevs = dataView.getUint16(offset, true);
    const crankTime = dataView.getUint16(offset + 2, true);
    const now = Date.now();

    if (this.lastCrankRevs === null) {
      this.lastCrankRevs = crankRevs;
      this.lastCrankTime = crankTime;
      this.lastReceiveTime = now;
      return { rpm: 0 };
    }

    let deltaRevs = crankRevs - this.lastCrankRevs;
    if (deltaRevs < 0) deltaRevs += 65536;

    let deltaTime = crankTime - this.lastCrankTime;
    if (deltaTime < 0) deltaTime += 65536;

    // Se o evento do pedivela não mudou (mesmas revoluções/tempo)
    if (deltaTime === 0 || deltaRevs === 0) {
      // Se passou muito tempo (ex: 2.5s) sem um novo crank interval,
      // assumimos que a pessoa realmente parou de pedalar (RPM = 0).
      if (now - this.lastReceiveTime > 2500) {
        return { rpm: 0 };
      }
      // Senão, é só o sensor transmitindo em alta frequência
      // antes da volta completar. Retornamos null para a UI ignorar
      // este pacote e manter o valor atual no painel.
      return null;
    }

    this.lastCrankRevs = crankRevs;
    this.lastCrankTime = crankTime;
    this.lastReceiveTime = now;

    const deltaSeconds = deltaTime / 1024;
    const rpm = Math.round((deltaRevs / deltaSeconds) * 60);

    // Ignora valores absurdos (overflow lixo temporário)
    if (rpm > 200 || rpm < 0) return null;

    return { rpm };
  }

  reset() {
    this.lastCrankRevs = null;
    this.lastCrankTime = null;
    this.lastReceiveTime = 0;
  }
}
