/**
 * Parseia o valor do BLE Heart Rate Measurement characteristic (0x2A37).
 *
 * Byte layout:
 *  - Byte 0: Flags
 *    - Bit 0: Heart Rate Format (0 = UINT8, 1 = UINT16)
 *  - Byte 1 (or 1-2): Heart Rate Value
 *
 * @param {DataView} dataView - Raw BLE characteristic value
 * @returns {{ bpm: number }}
 */
export function parseHeartRate(dataView) {
  const flags = dataView.getUint8(0);
  const is16Bit = flags & 0x01;

  let bpm;
  if (is16Bit) {
    bpm = dataView.getUint16(1, true); // little-endian
  } else {
    bpm = dataView.getUint8(1);
  }

  return { bpm };
}
