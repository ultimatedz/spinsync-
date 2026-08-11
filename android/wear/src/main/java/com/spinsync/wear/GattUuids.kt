package com.spinsync.wear

import java.util.UUID

/**
 * Standard Bluetooth SIG Heart Rate Service UUIDs.
 *
 * These MUST stay byte-identical to the constants in js/ble-manager.js:4-5 — the whole
 * point of this app is that SpinSync (and Zwift, Wahoo, nRF Connect, …) sees the watch
 * as an ordinary heart rate strap with no client-side changes.
 */
const val LOG_TAG = "SpinSyncHR"

val HR_SERVICE: UUID = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb")
val HR_MEASUREMENT: UUID = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
val BODY_SENSOR_LOCATION: UUID = UUID.fromString("00002a38-0000-1000-8000-00805f9b34fb")

/** Client Characteristic Configuration Descriptor. */
val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

/**
 * Vendor-specific service that lets the phone buzz the watch over the link it already
 * holds for heart rate — no Data Layer, no second connection. Never advertised: the
 * phone reaches it by UUID after connecting. Mirrors js/ble-manager.js.
 */
val HAPTIC_SERVICE: UUID = UUID.fromString("6b1a0001-4c2f-4d9a-9b3e-1f7a5c8d2e60")
val HAPTIC_CHARACTERISTIC: UUID = UUID.fromString("6b1a0002-4c2f-4d9a-9b3e-1f7a5c8d2e60")

/** Body Sensor Location value: 0x02 = Wrist. */
const val SENSOR_LOCATION_WRIST: Byte = 0x02

/**
 * Builds a Heart Rate Measurement (0x2A37) payload in its minimal 2-byte form.
 *
 * byte[0] — flags
 *   bit0 = 0  -> BPM is uint8. Must stay 0: js/hr-parser.js:14 masks only this bit.
 *   bit1 = sensor contact detected
 *   bit2 = sensor contact supported
 *   bit3 = 0  -> no Energy Expended field
 *   bit4 = 0  -> no RR-Interval field
 * byte[1] — bpm as uint8
 */
fun buildHrPacket(bpm: Int, contact: Boolean): ByteArray {
    val flags = if (contact) 0x06 else 0x04
    return byteArrayOf(flags.toByte(), bpm.coerceIn(0, 255).toByte())
}
