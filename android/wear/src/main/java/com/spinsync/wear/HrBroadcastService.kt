package com.spinsync.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Keeps heart rate flowing to connected centrals while the watch screen is off.
 *
 * A foreground service is not optional here: without it Wear OS suspends the process
 * within seconds of the screen turning off, which is the actual usage scenario.
 */
class HrBroadcastService : LifecycleService() {

    companion object {
        const val ACTION_START = "com.spinsync.wear.START"
        const val ACTION_STOP = "com.spinsync.wear.STOP"

        private const val CHANNEL_ID = "hr_broadcast"
        private const val NOTIF_ID = 1001

        /** How long to keep publishing the last good reading after samples stop. */
        private const val CONTACT_GRACE_MS = 10_000L

        /**
         * How long a non-AVAILABLE sensor state must persist before the UI admits a problem.
         *
         * Samples arrive at ~1 Hz and the optical sensor drops to ACQUIRING on every re-lock —
         * grip changes, out-of-the-saddle efforts, forearm tension — recovering within a few
         * seconds. Anything under ~15 s of continuous ACQUIRING is normal sensor behaviour,
         * so 20 s sits above the worst case while still telling the truth reasonably fast.
         */
        private const val ACQUIRING_GRACE_MS = 20_000L

        /**
         * OFF_BODY is a positive assertion by the sensor rather than an absence of signal, so
         * it only needs enough debounce to swallow a spurious event: five samples' worth.
         */
        private const val OFF_BODY_GRACE_MS = 5_000L

        /** How often the keepalive loop checks whether the link has gone quiet. */
        private const val PUBLISH_TICK_MS = 250L

        /** Publish a keepalive only after this long without any sample-driven push. */
        private const val KEEPALIVE_GAP_MS = 1_000L

        /** Floor between sample-driven pushes, in case samples ever arrive in a burst. */
        private const val MIN_PUBLISH_GAP_MS = 200L

        private const val NOTIF_MIN_INTERVAL_MS = 5_000L
        private const val WAKELOCK_TIMEOUT_MS = 4L * 60 * 60 * 1000

        /** Low-rate heartbeat log, so a screen-off stall is visible in logcat. */
        private const val DIAG_INTERVAL_MS = 15_000L
    }

    private lateinit var gatt: HrGattServer
    private lateinit var source: HeartRateSource
    private var wakeLock: PowerManager.WakeLock? = null

    private val handler = Handler(Looper.getMainLooper())
    private var running = false

    // Latest sample, written from the Health Services callback thread.
    @Volatile private var lastBpm = 0
    @Volatile private var lastBpmAt = 0L
    @Volatile private var lastPublishAt = 0L

    // Sensor state plus when it last actually changed — the clock the debounce runs on.
    @Volatile private var sensorState = SensorState.UNKNOWN
    @Volatile private var sensorStateSince = 0L
    @Volatile private var sessionTakenOver = false

    private var lastNotifAt = 0L
    private var lastDiagAt = 0L

    // ── Lifecycle ────────────────────────────────────────────────────────────

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        if (intent?.action == ACTION_STOP) {
            stopBroadcasting()
            stopSelf()
            return START_NOT_STICKY
        }

        if (!running) startBroadcasting()
        return START_STICKY
    }

    override fun onDestroy() {
        stopBroadcasting()
        super.onDestroy()
    }

    private fun startBroadcasting() {
        running = true
        // A restart must not inherit the previous session's sample or sensor state.
        lastBpm = 0
        lastBpmAt = 0L
        lastPublishAt = 0L
        sensorState = SensorState.UNKNOWN
        sensorStateSince = 0L
        sessionTakenOver = false
        HrState.update { it.copy(status = BroadcastStatus.STARTING, bpm = 0, subscribers = 0) }

        createChannel()
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
            } else {
                0
            },
        )

        acquireWakeLock()
        registerReceiver(btStateReceiver, IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED))

        gatt = HrGattServer(this, ::onGattEvent)
        gatt.start()

        source = createHeartRateSource(this)
        lifecycleScope.launch {
            if (!source.isSupported()) {
                Log.e(LOG_TAG, "HEART_RATE_BPM not supported by this watch")
                HrState.update { it.copy(status = BroadcastStatus.ERROR_NO_SENSOR) }
                return@launch
            }
            runCatching { source.start(::onHrEvent) }
                .onFailure { Log.e(LOG_TAG, "Heart rate source failed to start", it) }
        }

        handler.post(publishLoop)
    }

    private fun stopBroadcasting() {
        if (!running) return
        running = false

        handler.removeCallbacks(publishLoop)
        runCatching { unregisterReceiver(btStateReceiver) }

        lifecycleScope.launch { runCatching { source.stop() } }
        if (::gatt.isInitialized) gatt.release()

        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        HrState.reset()
    }

    // ── Sampling and publishing ──────────────────────────────────────────────

    /** Called from the Health Services callback thread. */
    private fun onHrEvent(event: HrEvent) {
        when (event) {
            is HrEvent.Sample -> {
                lastBpm = event.bpm
                lastBpmAt = System.currentTimeMillis()
                // A real reading proves contact, whatever the last availability event claimed.
                setSensorState(SensorState.AVAILABLE)
            }

            is HrEvent.Availability -> setSensorState(event.state)

            is HrEvent.ModeChanged -> {
                Log.w(LOG_TAG, "Source mode -> ${event.mode} (${event.detail})")
                HrState.update { it.copy(sourceMode = event.mode, detail = event.detail) }
            }

            is HrEvent.SessionEnded -> {
                sessionTakenOver = event.supersededByOtherApp
                if (event.permissionLost) {
                    HrState.update { it.copy(status = BroadcastStatus.ERROR_PERMISSION) }
                }
            }
        }
        // Push the instant the sensor speaks. Waiting for the next timer tick added up to
        // a full second of avoidable lag between wrist and phone display.
        handler.post { publishCurrent(force = false) }
    }

    /** Restarts the debounce clock only on an actual transition, never on a repeat. */
    private fun setSensorState(state: SensorState) {
        if (sensorState == state) return
        Log.i(LOG_TAG, "sensor state $sensorState -> $state")
        sensorState = state
        sensorStateSince = System.currentTimeMillis()
        if (state == SensorState.AVAILABLE) sessionTakenOver = false
    }

    private fun publishCurrent(force: Boolean) {
        if (!running || !::gatt.isInitialized) return

        val now = System.currentTimeMillis()
        if (!force && now - lastPublishAt < MIN_PUBLISH_GAP_MS) return

        val state = sensorState
        val grace = when (state) {
            SensorState.AVAILABLE -> Long.MAX_VALUE
            SensorState.OFF_BODY -> OFF_BODY_GRACE_MS
            else -> ACQUIRING_GRACE_MS
        }
        // A blip only counts once it has persisted. Recovery is deliberately not debounced.
        val degraded = state != SensorState.AVAILABLE &&
            sensorStateSince > 0 && (now - sensorStateSince) >= grace

        val fresh = lastBpmAt > 0 && (now - lastBpmAt) < CONTACT_GRACE_MS
        val contact = fresh && !degraded
        val bpm = if (contact) lastBpm else 0

        lastPublishAt = now
        gatt.publish(bpm, contact)
        updateUiState(bpm, contact, degraded)
        maybeUpdateNotification(bpm)

        if (now - lastDiagAt >= DIAG_INTERVAL_MS) {
            lastDiagAt = now
            val screen = getSystemService(PowerManager::class.java)?.isInteractive
            Log.i(
                LOG_TAG,
                "publish bpm=$bpm contact=$contact subs=${gatt.subscriberCount} " +
                    "sampleAge=${if (lastBpmAt > 0) now - lastBpmAt else -1}ms screenOn=$screen " +
                    "state=$state stateAge=${if (sensorStateSince > 0) now - sensorStateSince else -1}ms " +
                    "degraded=$degraded mode=${HrState.flow.value.sourceMode}"
            )
        }
    }

    /**
     * Keepalive. Samples normally drive publishing; this only fills the gaps (off-body,
     * a stalled sensor) so the link is never connected-but-mute — a silent link looks
     * like a frozen BPM on the phone, which is worse than an honest zero.
     */
    private val publishLoop = object : Runnable {
        override fun run() {
            if (!running) return
            if (System.currentTimeMillis() - lastPublishAt >= KEEPALIVE_GAP_MS) {
                publishCurrent(force = true)
            }
            handler.postDelayed(this, PUBLISH_TICK_MS)
        }
    }

    private fun updateUiState(bpm: Int, contact: Boolean, degraded: Boolean) {
        HrState.update { current ->
            val status = when {
                current.status.isError() -> current.status
                contact && current.subscribers > 0 -> BroadcastStatus.CONNECTED
                contact -> BroadcastStatus.ADVERTISING
                // Before the phone connects, "waiting for the phone" is the actionable message.
                current.subscribers == 0 -> BroadcastStatus.ADVERTISING
                sensorState == SensorState.OFF_BODY && degraded -> BroadcastStatus.NO_CONTACT
                sessionTakenOver -> BroadcastStatus.SESSION_TAKEN_OVER
                else -> BroadcastStatus.ACQUIRING
            }
            current.copy(status = status, bpm = bpm)
        }
    }

    private fun onGattEvent(event: HrGattServer.GattEvent) {
        when (event) {
            is HrGattServer.GattEvent.Advertising ->
                HrState.update {
                    if (it.status.isError()) it else it.copy(status = BroadcastStatus.ADVERTISING)
                }

            is HrGattServer.GattEvent.SubscribersChanged ->
                HrState.update { it.copy(subscribers = event.count) }

            is HrGattServer.GattEvent.HapticRequested ->
                HapticPatterns.play(this, event.patternId)

            is HrGattServer.GattEvent.Failed -> {
                Log.e(LOG_TAG, "GATT failure: ${event.reason} — ${event.detail}")
                val status = when (event.reason) {
                    HrGattServer.Reason.BLUETOOTH_OFF -> BroadcastStatus.ERROR_BT_OFF
                    HrGattServer.Reason.NO_PERIPHERAL_ROLE -> BroadcastStatus.ERROR_NO_PERIPHERAL
                    else -> BroadcastStatus.ERROR_NO_PERIPHERAL
                }
                HrState.update { it.copy(status = status, detail = event.detail) }
            }
        }
    }

    // ── Bluetooth toggle recovery ────────────────────────────────────────────

    /**
     * A BluetoothGattServer handle is dead once the adapter cycles off; the only recovery
     * is to tear it down and rebuild.
     */
    private val btStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_OFF -> {
                    Log.w(LOG_TAG, "Bluetooth turned off")
                    HrState.update { it.copy(status = BroadcastStatus.ERROR_BT_OFF, subscribers = 0) }
                }
                BluetoothAdapter.STATE_ON -> {
                    Log.i(LOG_TAG, "Bluetooth back on — rebuilding GATT server")
                    HrState.update { it.copy(status = BroadcastStatus.STARTING, detail = null) }
                    if (::gatt.isInitialized) gatt.restart()
                }
            }
        }
    }

    // ── Wake lock ────────────────────────────────────────────────────────────

    private fun acquireWakeLock() {
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spinsync:hr").apply {
            setReferenceCounted(false)
            acquire(WAKELOCK_TIMEOUT_MS)
        }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
    }

    // ── Notification ─────────────────────────────────────────────────────────

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notif_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            )
        )
    }

    private fun buildNotification(bpm: Int = 0): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val subs = HrState.flow.value.subscribers
        val text = if (bpm > 0) {
            getString(R.string.notif_text_fmt, bpm, subs)
        } else {
            getString(R.string.notif_text_idle)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    /** Throttled: refreshing an ongoing notification every second is pure battery waste. */
    private fun maybeUpdateNotification(bpm: Int) {
        val now = System.currentTimeMillis()
        if (now - lastNotifAt < NOTIF_MIN_INTERVAL_MS) return
        lastNotifAt = now
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(bpm))
    }
}

private fun BroadcastStatus.isError(): Boolean = when (this) {
    BroadcastStatus.ERROR_PERMISSION,
    BroadcastStatus.ERROR_NO_SENSOR,
    BroadcastStatus.ERROR_NO_PERIPHERAL,
    BroadcastStatus.ERROR_BT_OFF -> true
    else -> false
}
