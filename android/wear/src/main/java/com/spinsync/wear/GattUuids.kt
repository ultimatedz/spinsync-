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
 * Vendor-specific service that lets the phone drive the watch over the link it already
 * holds for heart rate — no Data Layer, no second connection. Never advertised: the
 * phone reaches it by UUID after connecting. Mirrors js/ble-manager.js.
 */
val HAPTIC_SERVICE: UUID = UUID.fromString("6b1a0001-4c2f-4d9a-9b3e-1f7a5c8d2e60")
val HAPTIC_CHARACTERISTIC: UUID = UUID.fromString("6b1a0002-4c2f-4d9a-9b3e-1f7a5c8d2e60")

/** Live workout state, pushed by the phone roughly once a second. */
val WORKOUT_CHARACTERISTIC: UUID = UUID.fromString("6b1a0003-4c2f-4d9a-9b3e-1f7a5c8d2e60")

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

/** Direction of the upcoming phase relative to the current one. */
enum class PhaseShift { NONE, HARDER, EASIER, SAME }

/**
 * What the phone knows and the watch does not: elapsed time, calories, and what the
 * effort is about to do.
 *
 * Riding indoors the phone is usually clamped out of easy reach on the handlebars, so
 * the wrist is the screen that actually gets looked at mid-effort.
 */
data class WorkoutStatus(
    val active: Boolean = false,
    val guided: Boolean = false,
    val paused: Boolean = false,
    val elapsedSeconds: Int = 0,
    val calories: Int = 0,
    /** Seconds until the next phase, or null when there is no next phase. */
    val secondsToNextPhase: Int? = null,
    val shift: PhaseShift = PhaseShift.NONE,
    /** Zone the rider is actually in, 0-5. */
    val zone: Int = 0,
    /** Zone the current phase asks for, 0-5. 0 on a free ride. */
    val targetZone: Int = 0,
    val rpmMin: Int = 0,
    val rpmMax: Int = 0,
)

/**
 * Layout of the 11-byte workout packet written by js/ble-manager.js sendWorkoutStatus().
 *
 * Kept under the 20-byte default ATT payload so it never needs an MTU negotiation.
 *
 *   byte 0    flags — bit0 active, bit1 guided, bit2 paused
 *   byte 1-2  elapsed seconds, uint16 LE
 *   byte 3-4  calories, uint16 LE
 *   byte 5-6  seconds to next phase, uint16 LE (0xFFFF = none)
 *   byte 7    phase shift ordinal
 *   byte 8    zones: low nibble = current, high nibble = target (both 0-5)
 *   byte 9-10 target cadence range
 */
fun parseWorkoutPacket(value: ByteArray): WorkoutStatus? {
    if (value.size < 11) return null

    fun u8(i: Int) = value[i].toInt() and 0xff
    fun u16(i: Int) = u8(i) or (u8(i + 1) shl 8)

    val flags = u8(0)
    val nextPhase = u16(5)
    val shiftOrdinal = u8(7)

    return WorkoutStatus(
        active = flags and 0x01 != 0,
        guided = flags and 0x02 != 0,
        paused = flags and 0x04 != 0,
        elapsedSeconds = u16(1),
        calories = u16(3),
        secondsToNextPhase = if (nextPhase == 0xFFFF) null else nextPhase,
        shift = PhaseShift.entries.getOrElse(shiftOrdinal) { PhaseShift.NONE },
        // Both zones ride in one byte: each is 0-5, so a nibble each keeps the packet at
        // 11 bytes instead of growing it for 3 bits of information.
        zone = u8(8) and 0x0f,
        targetZone = (u8(8) shr 4) and 0x0f,
        rpmMin = u8(9),
        rpmMax = u8(10),
    )
}
