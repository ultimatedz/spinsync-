package com.spinsync.wear

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.spinsync.wear.databinding.ActivityMainBinding
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

// ComponentActivity, not AppCompatActivity: Wear OS uses Theme.DeviceDefault, and
// AppCompat hard-fails at setContentView with any non-AppCompat theme.
class MainActivity : ComponentActivity() {

    private lateinit var binding: ActivityMainBinding

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            // A permission that was already granted got filtered out of the request array, so
            // it is absent from `result` — reading the map alone reports it as denied. Fall
            // back to the real state.
            fun granted(p: String) = result[p] == true || isGranted(p)

            // health.READ_HEART_RATE may not exist on older Wear builds; BODY_SENSORS is the
            // one that actually gates the sensor there, so require at least one of them.
            val sensorGranted = granted(Manifest.permission.BODY_SENSORS) ||
                granted(PERMISSION_READ_HEART_RATE)
            val advertiseGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                granted(Manifest.permission.BLUETOOTH_ADVERTISE)

            if (!sensorGranted || !advertiseGranted) {
                HrState.update { it.copy(status = BroadcastStatus.ERROR_PERMISSION) }
                return@registerForActivityResult
            }

            // Not fatal on its own — it only forces the degraded MeasureClient path — but the
            // service needs to know so it can label the UI honestly instead of blaming the wrist.
            if (!isGranted(Manifest.permission.ACTIVITY_RECOGNITION)) {
                Log.w(LOG_TAG, "ACTIVITY_RECOGNITION denied — exercise session will not start")
            }

            maybeRequestBackgroundSensors()
            startBroadcast()
        }

    /**
     * Background body sensors must be asked for on their own, after the foreground permission
     * is held; bundling the two gets the background one auto-denied. Denial is not fatal, so
     * the result is deliberately ignored.
     */
    private val backgroundSensorLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
            Log.i(LOG_TAG, "BODY_SENSORS_BACKGROUND granted=$ok")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnToggle.setOnClickListener {
            if (HrState.flow.value.isRunning) stopBroadcast() else requestPermissionsThenStart()
        }

        if (!hasPeripheralRole()) {
            HrState.update { it.copy(status = BroadcastStatus.ERROR_NO_PERIPHERAL) }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                HrState.flow.collectLatest(::render)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Only while the user is actually looking at the watch — the service is what keeps
        // sampling alive once the screen goes off.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onStop() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onStop()
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private fun render(state: HrUiState) {
        binding.txtBpm.text = if (state.bpm > 0) state.bpm.toString() else getString(R.string.bpm_placeholder)
        // Dim rather than blank: a faded number reads as stale, a missing one reads as broken.
        binding.txtBpm.alpha = when (state.status) {
            BroadcastStatus.ACQUIRING,
            BroadcastStatus.NO_CONTACT,
            BroadcastStatus.SESSION_TAKEN_OVER -> 0.45f
            else -> 1f
        }

        val statusRes = when (state.status) {
            BroadcastStatus.IDLE -> R.string.status_idle
            BroadcastStatus.STARTING -> R.string.status_starting
            BroadcastStatus.ADVERTISING -> R.string.status_advertising
            BroadcastStatus.CONNECTED -> R.string.status_connected
            BroadcastStatus.ACQUIRING -> R.string.status_acquiring
            BroadcastStatus.NO_CONTACT -> R.string.status_no_contact
            BroadcastStatus.SESSION_TAKEN_OVER -> R.string.status_session_busy
            BroadcastStatus.ERROR_PERMISSION -> R.string.status_permission_denied
            BroadcastStatus.ERROR_NO_SENSOR -> R.string.status_no_sensor
            BroadcastStatus.ERROR_NO_PERIPHERAL -> R.string.status_no_peripheral
            BroadcastStatus.ERROR_BT_OFF -> R.string.status_bt_off
        }
        binding.txtStatus.text = state.detail?.let { "${getString(statusRes)}\n$it" }
            ?: getString(statusRes)

        binding.txtSubscribers.text = if (state.subscribers == 0) {
            getString(R.string.subscribers_none)
        } else {
            getString(R.string.subscribers_fmt, state.subscribers)
        }

        binding.btnToggle.setText(if (state.isRunning) R.string.btn_stop else R.string.btn_start)
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    private fun requestPermissionsThenStart() {
        val needed = requiredPermissions().filterNot(::isGranted)
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
            return
        }
        maybeRequestBackgroundSensors()
        startBroadcast()
    }

    private fun requiredPermissions(): List<String> = buildList {
        // BODY_SENSORS is declared with maxSdkVersion="35"; Android 16 dropped it in
        // favour of health.READ_HEART_RATE. Asking for an undeclared permission just
        // gets an automatic denial.
        if (Build.VERSION.SDK_INT <= 35) add(Manifest.permission.BODY_SENSORS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            add(PERMISSION_READ_HEART_RATE)
        }
        // Health Services gates the exercise session on this one, and the exercise session is
        // what keeps the sensor sampling with the screen off. minSdk is 30, so it is always a
        // runtime permission here.
        add(Manifest.permission.ACTIVITY_RECOGNITION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            add(Manifest.permission.BLUETOOTH_ADVERTISE)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
        // BODY_SENSORS_BACKGROUND is deliberately absent — see backgroundSensorLauncher.
    }

    private fun maybeRequestBackgroundSensors() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (Build.VERSION.SDK_INT > 35) return // dropped alongside BODY_SENSORS
        if (!isGranted(Manifest.permission.BODY_SENSORS)) return
        if (isGranted(PERMISSION_BODY_SENSORS_BACKGROUND)) return
        backgroundSensorLauncher.launch(PERMISSION_BODY_SENSORS_BACKGROUND)
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun startBroadcast() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, HrBroadcastService::class.java).setAction(HrBroadcastService.ACTION_START),
        )
    }

    private fun stopBroadcast() {
        startService(
            Intent(this, HrBroadcastService::class.java).setAction(HrBroadcastService.ACTION_STOP)
        )
    }

    private fun hasPeripheralRole(): Boolean {
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter ?: return false
        return adapter.bluetoothLeAdvertiser != null || !adapter.isEnabled
    }

    private companion object {
        // Not in Manifest.permission until the SDK the watch actually ships with.
        const val PERMISSION_READ_HEART_RATE = "android.permission.health.READ_HEART_RATE"
        const val PERMISSION_BODY_SENSORS_BACKGROUND =
            "android.permission.BODY_SENSORS_BACKGROUND"
    }
}
