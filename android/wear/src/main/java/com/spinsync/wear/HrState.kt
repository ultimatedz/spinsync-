package com.spinsync.wear

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update as flowUpdate

/**
 * What the UI shows. Broadcasting is single-process, so a StateFlow singleton beats
 * binder/AIDL plumbing between [HrBroadcastService] and [MainActivity].
 */
enum class BroadcastStatus {
    IDLE,
    STARTING,
    ADVERTISING,
    CONNECTED,

    /** Sensor warming up or re-locking. Routine — not a wrist-contact problem. */
    ACQUIRING,

    /** Strictly [SensorState.OFF_BODY], debounced. Anything else belongs elsewhere. */
    NO_CONTACT,

    /** Another app owns the single system-wide exercise session. */
    SESSION_TAKEN_OVER,

    ERROR_PERMISSION,
    ERROR_NO_SENSOR,
    ERROR_NO_PERIPHERAL,
    ERROR_BT_OFF,
}

data class HrUiState(
    val status: BroadcastStatus = BroadcastStatus.IDLE,
    val bpm: Int = 0,
    val subscribers: Int = 0,
    val sourceMode: SourceMode = SourceMode.EXERCISE,
    val detail: String? = null,
    /** Pushed by the phone over the vendor service; all zeros until a workout starts. */
    val workout: WorkoutStatus = WorkoutStatus(),
) {
    val isRunning: Boolean
        get() = status != BroadcastStatus.IDLE
}

object HrState {
    private val _flow = MutableStateFlow(HrUiState())
    val flow: StateFlow<HrUiState> = _flow.asStateFlow()

    /**
     * Compare-and-set, not read-modify-write: this is called from the main thread
     * (publishing) and from the GATT handler thread (subscriber counts) concurrently.
     */
    fun update(transform: (HrUiState) -> HrUiState) {
        _flow.flowUpdate(transform)
    }

    fun reset() {
        _flow.value = HrUiState()
    }
}
