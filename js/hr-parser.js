/**
 * Parseia o valor do BLE Heart Rate Measurement characteristic (0x2A37).
 *
 * Byte layout:
 *  - Byte 0: Flags
 *    - Bit 0: Heart Rate Format (0 = UINT8, 1 = UINT16)
 *    - Bit 1: Sensor Contact Detected
 *    - Bit 2: Sensor Contact Supported
 *  - Byte 1 (or 1-2): Heart Rate Value
 *
 * O app do relógio (android/wear/.../GattUuids.kt, buildHrPacket) envia 0x06 quando há
 * contato e 0x04 quando não há — informação que era descartada aqui, fazendo a perda de
 * contato chegar ao app como um "0 bpm" sem explicação.
 *
 * @param {DataView} dataView - Raw BLE characteristic value
 * @returns {{ bpm: number, contact: boolean, contactSupported: boolean }}
 */
export function parseHeartRate(dataView) {
  const flags = dataView.getUint8(0);
  const is16Bit = flags & 0x01;
  const contactSupported = (flags & 0x04) !== 0;
  const contactDetected = (flags & 0x02) !== 0;

  let bpm;
  if (is16Bit) {
    bpm = dataView.getUint16(1, true); // little-endian
  } else {
    bpm = dataView.getUint8(1);
  }

  // Cintas comuns (Polar, Wahoo, Garmin) deixam os dois bits zerados, o que pela spec
  // significa "status de contato não suportado". Sem este default, toda cinta passaria a
  // ser reportada como "sem contato".
  return { bpm, contactSupported, contact: contactSupported ? contactDetected : true };
}
