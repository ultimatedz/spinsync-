package com.spinsync.wear

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.concurrent.futures.await
import androidx.core.content.ContextCompat
import androidx.health.services.client.ExerciseUpdateCallback
import androidx.health.services.client.HealthServices
import androidx.health.services.client.MeasureCallback
import androidx.health.services.client.data.Availability
import androidx.health.services.client.data.DataPointContainer
import androidx.health.services.client.data.DataType
import androidx.health.services.client.data.DataTypeAvailability
import androidx.health.services.client.data.DeltaDataType
import androidx.health.services.client.data.ExerciseConfig
import androidx.health.services.client.data.ExerciseEndReason
import androidx.health.services.client.data.ExerciseLapSummary
import androidx.health.services.client.data.ExerciseState
import androidx.health.services.client.data.ExerciseType
import androidx.health.services.client.data.ExerciseUpdate
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Flip to true to drive the GATT server with a synthetic 60→180 bpm ramp.
 *
 * Lets you validate the whole phone-side path (device picker, connect, CCCD,
 * js/hr-parser.js, the chart) before touching the real sensor.
 */
const val USE_FAKE_HEART_RATE = false

/**
 * What the sensor layer knows about its own signal.
 *
 * The distinction matters: an optical sensor re-locking is routine on a bike, and reporting
 * it as "not on a wrist" is the bug this enum exists to prevent.
 */
enum class SensorState {
    /** Locked on and reporting. */
    AVAILABLE,

    /** Re-acquiring the pulse. Frequent under grip changes and out-of-the-saddle efforts. */
    ACQUIRING,

    /** The sensor positively asserts the watch is not on a wrist. */
    OFF_BODY,

    /** Cannot measure, for some reason that is not off-body. */
    UNAVAILABLE,

    /** Health Services did not say. Treated like [ACQUIRING]. */
    UNKNOWN,
}

/** Which pipeline is actually feeding us — surfaced to the UI rather than swallowed. */
enum class SourceMode { EXERCISE, MEASURE_FALLBACK }

/** Everything the sensor layer can tell the service, beyond "here is a number". */
sealed interface HrEvent {
    data class Sample(val bpm: Int) : HrEvent

    data class Availability(val state: SensorState) : HrEvent

    /** The exercise session ended. [supersededByOtherApp] is the Samsung Health takeover. */
    data class SessionEnded(
        val stateName: String,
        val endReason: Int,
        val supersededByOtherApp: Boolean,
        val permissionLost: Boolean,
    ) : HrEvent

    /** We left the good path. [detail] is short enough for the watch screen. */
    data class ModeChanged(val mode: SourceMode, val detail: String?) : HrEvent
}

/** A source of heart rate samples, roughly 1 Hz. */
interface HeartRateSource {
    /** @return false when this watch cannot measure heart rate at all. */
    suspend fun isSupported(): Boolean

    /** [onEvent] is invoked off the main thread. */
    suspend fun start(onEvent: (HrEvent) -> Unit)

    suspend fun stop()
}

fun createHeartRateSource(ctx: Context): HeartRateSource =
    if (USE_FAKE_HEART_RATE) FakeHeartRateSource() else ExerciseHeartRateSource(ctx)

/**
 * Single mapping shared by both sources, so the two availability callbacks cannot drift.
 *
 * [DataTypeAvailability] is a class with companion constants rather than an enum, so the
 * `else` branch is mandatory — and it is also what catches values added by later releases.
 */
private fun DataTypeAvailability.toSensorState(): SensorState = when (this) {
    DataTypeAvailability.AVAILABLE -> SensorState.AVAILABLE
    DataTypeAvailability.ACQUIRING -> SensorState.ACQUIRING
    DataTypeAvailability.UNAVAILABLE_DEVICE_OFF_BODY -> SensorState.OFF_BODY
    DataTypeAvailability.UNAVAILABLE -> SensorState.UNAVAILABLE
    else -> SensorState.UNKNOWN
}

/**
 * Reads heart rate through Health Services ExerciseClient.
 *
 * MeasureClient is the obvious API for "give me heart rate now", but it is specified for
 * on-demand foreground measurement: measured on a Galaxy Watch 4, it delivered exactly
 * one sample after the screen turned off and then went silent for 86 seconds while the
 * foreground service kept running normally. ExerciseClient owns a real exercise session,
 * which is what keeps the sensor sampling with the wrist down — the actual usage
 * scenario for a spinning class.
 *
 * MeasureClient stays as a fallback for the case where another app (typically Samsung
 * Health) already owns the exercise session and ours cannot start.
 */
private class ExerciseHeartRateSource(private val ctx: Context) : HeartRateSource {

    private companion object {
        const val MAX_RESTARTS = 3
        const val RESTART_BACKOFF_MS = 5_000L
    }

    private val exerciseClient = HealthServices.getClient(ctx).exerciseClient
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var callback: ExerciseUpdateCallback? = null
    private var fallback: MeasureHeartRateSource? = null
    private var lastState: ExerciseState? = null
    private var restartAttempts = 0

    /** onExerciseUpdateReceived keeps firing in an ended state; recovery must run once. */
    private val recovering = AtomicBoolean(false)

    private val config: ExerciseConfig by lazy {
        ExerciseConfig.builder(ExerciseType.BIKING_STATIONARY)
            .setDataTypes(setOf(DataType.HEART_RATE_BPM))
            .setIsAutoPauseAndResumeEnabled(false)
            .setIsGpsEnabled(false)
            .build()
    }

    override suspend fun isSupported(): Boolean = try {
        val capabilities = exerciseClient.getCapabilitiesAsync().await()
        val biking = capabilities.getExerciseTypeCapabilities(ExerciseType.BIKING_STATIONARY)
        biking.supportedDataTypes.contains(DataType.HEART_RATE_BPM)
    } catch (e: Exception) {
        Log.w(LOG_TAG, "ExerciseClient capabilities unavailable, will try MeasureClient", e)
        MeasureHeartRateSource(ctx).isSupported()
    }

    override suspend fun start(onEvent: (HrEvent) -> Unit) {
        // Health Services gates startExerciseAsync on this. Checking up front turns an
        // opaque failure into a message that names the cause.
        val hasActivityPermission = ContextCompat.checkSelfPermission(
            ctx, Manifest.permission.ACTIVITY_RECOGNITION
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasActivityPermission) {
            Log.e(LOG_TAG, "ACTIVITY_RECOGNITION not granted — ExerciseClient will fail")
        }

        val cb = object : ExerciseUpdateCallback {
            override fun onRegistered() {
                Log.i(LOG_TAG, "ExerciseClient callback registered")
            }

            override fun onRegistrationFailed(throwable: Throwable) {
                Log.e(LOG_TAG, "ExerciseClient registration failed", throwable)
            }

            override fun onExerciseUpdateReceived(update: ExerciseUpdate) {
                val info = update.exerciseStateInfo
                if (info.state != lastState) {
                    Log.i(LOG_TAG, "Exercise state: ${info.state.name} endReason=${info.endReason}")
                    lastState = info.state
                }

                // isEnded already covers USER_ENDED, AUTO_ENDED, AUTO_ENDED_PERMISSION_LOST
                // and TERMINATED — the latter two are internal in the companion and cannot
                // be compared against directly.
                if (info.state.isEnded) {
                    val superseded = info.endReason == ExerciseEndReason.AUTO_END_SUPERSEDED
                    val permissionLost =
                        info.endReason == ExerciseEndReason.AUTO_END_PERMISSION_LOST
                    onEvent(
                        HrEvent.SessionEnded(
                            info.state.name, info.endReason, superseded, permissionLost
                        )
                    )
                    handleSessionEnded(superseded, permissionLost, onEvent)
                    return
                }

                val bpm = update.latestMetrics
                    .getData(DataType.HEART_RATE_BPM)
                    .lastOrNull()
                    ?.value
                if (bpm != null && bpm > 0) onEvent(HrEvent.Sample(bpm.roundToInt()))
            }

            override fun onLapSummaryReceived(lapSummary: ExerciseLapSummary) { /* unused */ }

            override fun onAvailabilityChanged(
                dataType: DataType<*, *>,
                availability: Availability,
            ) {
                if (availability !is DataTypeAvailability) return
                val state = availability.toSensorState()
                Log.i(LOG_TAG, "HR availability: ${availability.name} -> $state")
                // AVAILABLE is forwarded too: it is what un-latches the contact flag without
                // having to wait for the next sample.
                onEvent(HrEvent.Availability(state))
            }
        }

        try {
            exerciseClient.setUpdateCallback(cb)
            callback = cb
            exerciseClient.startExerciseAsync(config).await()
            Log.i(LOG_TAG, "Exercise session started (BIKING_STATIONARY, HR only)")
        } catch (e: Exception) {
            val detail = if (e is SecurityException || !hasActivityPermission) {
                ctx.getString(R.string.detail_no_activity_permission)
            } else {
                ctx.getString(R.string.detail_limited_mode)
            }
            // Deliberately Log.e: this used to be a warning, and the silent degradation it
            // hid is what surfaced to the user as a permanent phantom "no wrist contact".
            Log.e(LOG_TAG, "startExerciseAsync FAILED — degrading to MeasureClient: $detail", e)
            runCatching { exerciseClient.clearUpdateCallbackAsync(cb).await() }
            callback = null

            onEvent(HrEvent.ModeChanged(SourceMode.MEASURE_FALLBACK, detail))
            fallback = MeasureHeartRateSource(ctx).also { it.start(onEvent) }
        }
    }

    /**
     * Wear OS allows one exercise session system-wide. Losing it used to leave the UI frozen
     * on a stale status forever, because nothing noticed the updates had stopped.
     */
    private fun handleSessionEnded(
        superseded: Boolean,
        permissionLost: Boolean,
        onEvent: (HrEvent) -> Unit,
    ) {
        if (!recovering.compareAndSet(false, true)) return

        scope.launch {
            val cb = callback
            callback = null
            if (cb != null) runCatching { exerciseClient.clearUpdateCallbackAsync(cb).await() }

            // Retrying a superseded session would just fight the app that took it, and a lost
            // permission cannot be fixed from here either.
            if (superseded || permissionLost || restartAttempts >= MAX_RESTARTS) {
                val detail = if (superseded) {
                    ctx.getString(R.string.detail_session_busy)
                } else {
                    ctx.getString(R.string.detail_limited_mode)
                }
                Log.w(LOG_TAG, "Not restarting exercise session ($detail) — using MeasureClient")
                onEvent(HrEvent.ModeChanged(SourceMode.MEASURE_FALLBACK, detail))
                fallback = MeasureHeartRateSource(ctx).also { runCatching { it.start(onEvent) } }
                return@launch
            }

            restartAttempts++
            delay(RESTART_BACKOFF_MS)
            Log.i(LOG_TAG, "Restarting exercise session (attempt $restartAttempts)")
            runCatching {
                exerciseClient.setUpdateCallback(cb ?: return@runCatching)
                callback = cb
                exerciseClient.startExerciseAsync(config).await()
            }.onFailure {
                Log.e(LOG_TAG, "Exercise session restart failed", it)
            }
        }.invokeOnCompletion { recovering.set(false) }
    }

    override suspend fun stop() {
        scope.cancel()

        // Both can be live at once: the fallback is also engaged when a session that had
        // already started gets taken over, and returning early there leaked the session.
        fallback?.let {
            runCatching { it.stop() }
            fallback = null
        }

        val cb = callback ?: return
        callback = null
        runCatching { exerciseClient.endExerciseAsync().await() }
            .onFailure { Log.w(LOG_TAG, "endExercise failed", it) }
        runCatching { exerciseClient.clearUpdateCallbackAsync(cb).await() }
    }
}

/**
 * On-demand measurement. Fine while the watch screen is on, unreliable once it is not —
 * see the note on [ExerciseHeartRateSource].
 */
private class MeasureHeartRateSource(ctx: Context) : HeartRateSource {

    private val measureClient = HealthServices.getClient(ctx).measureClient
    private var callback: MeasureCallback? = null

    override suspend fun isSupported(): Boolean = try {
        measureClient.getCapabilitiesAsync().await()
            .supportedDataTypesMeasure.contains(DataType.HEART_RATE_BPM)
    } catch (e: Exception) {
        Log.e(LOG_TAG, "getCapabilities failed", e)
        false
    }

    override suspend fun start(onEvent: (HrEvent) -> Unit) {
        val cb = object : MeasureCallback {
            override fun onRegistered() {
                Log.i(LOG_TAG, "MeasureClient registered for HEART_RATE_BPM")
            }

            override fun onRegistrationFailed(throwable: Throwable) {
                Log.e(LOG_TAG, "MeasureClient registration failed", throwable)
                onEvent(HrEvent.Availability(SensorState.UNAVAILABLE))
            }

            override fun onAvailabilityChanged(
                dataType: DeltaDataType<*, *>,
                availability: Availability,
            ) {
                if (availability !is DataTypeAvailability) return
                val state = availability.toSensorState()
                Log.i(LOG_TAG, "HR availability: ${availability.name} -> $state")
                onEvent(HrEvent.Availability(state))
            }

            override fun onDataReceived(data: DataPointContainer) {
                val bpm = data.getData(DataType.HEART_RATE_BPM).lastOrNull()?.value ?: return
                if (bpm > 0) onEvent(HrEvent.Sample(bpm.roundToInt()))
            }
        }
        callback = cb
        measureClient.registerMeasureCallback(DataType.HEART_RATE_BPM, cb)
    }

    override suspend fun stop() {
        val cb = callback ?: return
        callback = null
        try {
            measureClient.unregisterMeasureCallbackAsync(DataType.HEART_RATE_BPM, cb).await()
        } catch (e: Exception) {
            Log.w(LOG_TAG, "unregisterMeasureCallback failed", e)
        }
    }
}

/**
 * Development-only: a 60→180→60 bpm sine at 1 Hz, plus a scripted availability cycle.
 *
 * The availability script is what makes the debounce in HrBroadcastService testable on a
 * desk. Without it the only way to exercise the ACQUIRING and OFF_BODY grace periods is to
 * repeatedly strap and unstrap the watch and hope the sensor cooperates.
 */
private class FakeHeartRateSource : HeartRateSource {

    private companion object {
        /** One full availability cycle, in ticks (= seconds). */
        const val CYCLE_TICKS = 45
        val ACQUIRING_RANGE = 30 until 38
        val OFF_BODY_RANGE = 38 until CYCLE_TICKS
    }

    private val handler = Handler(Looper.getMainLooper())
    private var tick = 0
    private var runnable: Runnable? = null
    private var lastState: SensorState? = null

    override suspend fun isSupported() = true

    override suspend fun start(onEvent: (HrEvent) -> Unit) {
        val r = object : Runnable {
            override fun run() {
                val phaseTick = tick % CYCLE_TICKS
                val state = when (phaseTick) {
                    in ACQUIRING_RANGE -> SensorState.ACQUIRING
                    in OFF_BODY_RANGE -> SensorState.OFF_BODY
                    else -> SensorState.AVAILABLE
                }
                if (state != lastState) {
                    lastState = state
                    onEvent(HrEvent.Availability(state))
                }

                if (state == SensorState.AVAILABLE) {
                    val phase = (tick % 240) / 240.0 * 2 * Math.PI
                    onEvent(HrEvent.Sample((120 + 60 * sin(phase)).roundToInt()))
                }

                tick++
                handler.postDelayed(this, 1000L)
            }
        }
        runnable = r
        handler.post(r)
    }

    override suspend fun stop() {
        runnable?.let { handler.removeCallbacks(it) }
        runnable = null
        lastState = null
        tick = 0
    }
}
