package com.spinsync.wear

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

/**
 * Waveforms for the cues the phone sends over the haptic characteristic.
 *
 * The ids MUST stay in sync with PATTERNS in js/haptics.js — they are the single byte
 * carried on the wire.
 */
object HapticPatterns {

    private const val PHASE_WARNING = 1
    private const val PHASE_UP = 2
    private const val PHASE_DOWN = 3
    private const val PHASE_SAME = 4
    private const val FINAL_STRETCH = 5
    private const val WORKOUT_END = 6

    /** Timings alternate off/on, starting with an initial 0ms delay. */
    private val WAVEFORMS: Map<Int, LongArray> = mapOf(
        PHASE_WARNING to longArrayOf(0, 130),
        PHASE_UP to longArrayOf(0, 200, 100, 200, 100, 320),
        PHASE_DOWN to longArrayOf(0, 320, 130, 160),
        PHASE_SAME to longArrayOf(0, 160, 90, 160),
        FINAL_STRETCH to longArrayOf(0, 110, 80, 110, 80, 110),
        WORKOUT_END to longArrayOf(0, 420, 160, 420),
    )

    fun play(ctx: Context, patternId: Int) {
        val timings = WAVEFORMS[patternId]
        if (timings == null) {
            Log.w(LOG_TAG, "Unknown haptic pattern id=$patternId")
            return
        }

        val vibrator = getVibrator(ctx) ?: return
        if (!vibrator.hasVibrator()) return

        try {
            vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
            Log.i(LOG_TAG, "Haptic cue $patternId")
        } catch (e: Exception) {
            Log.w(LOG_TAG, "Vibration failed", e)
        }
    }

    private fun getVibrator(ctx: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            ctx.getSystemService(Vibrator::class.java)
        }
}
