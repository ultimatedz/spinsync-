/**
 * Parser para CSC Measurement characteristic (0x2A5B).
 * Calcula RPM instantâneo a partir das diferenças entre leituras.
 */
export class CadenceParser {
  constructor() {
    this.lastCrankRevs = null;
    this.lastCrankTime = null;
  }

  /**
   * Parseia um valor do CSC Measurement.
   *
   * Byte layout:
   *  - Byte 0: Flags
   *    - Bit 0: Wheel Revolution Data Present
   *    - Bit 1: Crank Revolution Data Present
   *  - Se Bit 1 (Crank):
   *    - Cumulative Crank Revolutions (uint16)
   *    - Last Crank Event Time (uint16, unidade: 1/1024 segundo)
   *
   * @param {DataView} dataView
   * @returns {{ rpm: number } | null}
   */
  parse(dataView) {
    const flags = dataView.getUint8(0);
    const hasCrank = (flags >> 1) & 0x01;
    const hasWheel = flags & 0x01;

    if (!hasCrank) return null;

    // Offset depends on whether wheel data is present
    let offset = 1;
    if (hasWheel) {
      // Skip wheel data: 4 bytes (cumulative revs uint32) + 2 bytes (last event time uint16)
      offset += 6;
    }

    const crankRevs = dataView.getUint16(offset, true);
    const crankTime = dataView.getUint16(offset + 2, true);

    if (this.lastCrankRevs === null) {
      this.lastCrankRevs = crankRevs;
      this.lastCrankTime = crankTime;
      return { rpm: 0 };
    }

    // Handle uint16 overflow
    let deltaRevs = crankRevs - this.lastCrankRevs;
    if (deltaRevs < 0) deltaRevs += 65536;

    let deltaTime = crankTime - this.lastCrankTime;
    if (deltaTime < 0) deltaTime += 65536;

    this.lastCrankRevs = crankRevs;
    this.lastCrankTime = crankTime;

    if (deltaTime === 0 || deltaRevs === 0) {
      return { rpm: 0 };
    }

    // deltaTime is in 1/1024 seconds
    const deltaSeconds = deltaTime / 1024;
    const rpm = Math.round((deltaRevs / deltaSeconds) * 60);

    // Sanity check: ignore unrealistic values
    if (rpm > 200) return { rpm: 0 };

    return { rpm };
  }

  reset() {
    this.lastCrankRevs = null;
    this.lastCrankTime = null;
  }
}
