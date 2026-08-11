package com.spinsync.wear

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.util.Log

/**
 * Presents this watch as a standard BLE Heart Rate sensor.
 *
 * Owns a [BluetoothGattServer] exposing Heart Rate Service 0x180D and a
 * [BluetoothLeAdvertiser] announcing it, so any BLE central (SpinSync, Zwift,
 * nRF Connect) can subscribe to notifications on 0x2A37.
 *
 * All Bluetooth calls run on a dedicated handler thread — never on the Health
 * Services callback thread.
 */
@SuppressLint("MissingPermission") // permissions are gated in MainActivity before the service starts
class HrGattServer(
    private val ctx: Context,
    private val onEvent: (GattEvent) -> Unit,
) {

    sealed interface GattEvent {
        /** Advertising, waiting for a central to connect. */
        data object Advertising : GattEvent
        /** At least one central subscribed to notifications. */
        data class SubscribersChanged(val count: Int) : GattEvent
        /** The phone asked for a haptic cue. */
        data class HapticRequested(val patternId: Int) : GattEvent
        data class Failed(val reason: Reason, val detail: String) : GattEvent
    }

    enum class Reason { BLUETOOTH_OFF, NO_PERIPHERAL_ROLE, ADVERTISE_FAILED, GATT_FAILED }

    private companion object {
        /** How long an unacknowledged notification blocks a central. ~1.5 sample periods. */
        const val NOTIFY_TIMEOUT_MS = 1_500L
    }

    private val thread = HandlerThread("hr-gatt").apply { start() }
    private val handler = Handler(thread.looper)

    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var hrChar: BluetoothGattCharacteristic? = null

    /** Centrals that wrote ENABLE_NOTIFICATION to the CCCD. Handler-thread confined. */
    private val subscribers = mutableSetOf<BluetoothDevice>()

    /**
     * Devices with a notification still in flight; skip a sample rather than queueing.
     *
     * Keyed by send time, not a plain set: a missed [onNotificationSent] used to leave an
     * address stuck here forever, silently muting that central for the rest of the session.
     */
    private val notifyInFlight = mutableMapOf<String, Long>()

    private var advertising = false
    private var currentMode = AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY

    val subscriberCount: Int get() = subscribers.size

    // ── Lifecycle ────────────────────────────────────────────────────────────

    fun start() = handler.post { startInternal() }

    fun stop() = handler.post { stopInternal() }

    /** Tear down and rebuild — the only way to recover after Bluetooth is toggled off/on. */
    fun restart() = handler.post {
        stopInternal()
        startInternal()
    }

    fun release() {
        handler.post { stopInternal() }
        thread.quitSafely()
    }

    private fun startInternal() {
        val manager = ctx.getSystemService(BluetoothManager::class.java)
        val adapter = manager?.adapter

        if (adapter == null || !adapter.isEnabled) {
            onEvent(GattEvent.Failed(Reason.BLUETOOTH_OFF, "Bluetooth desligado"))
            return
        }
        if (!adapter.isMultipleAdvertisementSupported) {
            Log.w(LOG_TAG, "isMultipleAdvertisementSupported=false; trying anyway")
        }

        advertiser = adapter.bluetoothLeAdvertiser
        if (advertiser == null) {
            onEvent(GattEvent.Failed(Reason.NO_PERIPHERAL_ROLE, "BLE peripheral indisponível"))
            return
        }

        val server = manager.openGattServer(ctx, gattCallback)
        if (server == null) {
            onEvent(GattEvent.Failed(Reason.GATT_FAILED, "openGattServer retornou null"))
            return
        }
        gattServer = server

        val service = BluetoothGattService(HR_SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)

        val measurement = BluetoothGattCharacteristic(
            HR_MEASUREMENT,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        ).apply {
            addDescriptor(
                BluetoothGattDescriptor(
                    CCCD,
                    BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
                )
            )
        }
        hrChar = measurement

        // Some clients read the sensor location right after connecting.
        val location = BluetoothGattCharacteristic(
            BODY_SENSOR_LOCATION,
            BluetoothGattCharacteristic.PROPERTY_READ,
            BluetoothGattCharacteristic.PERMISSION_READ,
        ).apply { value = byteArrayOf(SENSOR_LOCATION_WRIST) }

        service.addCharacteristic(measurement)
        service.addCharacteristic(location)

        // Advertising starts from onServiceAdded — never before the service is live.
        server.addService(service)

        // Haptic service is added from onServiceAdded: BluetoothGattServer.addService is
        // asynchronous and only one may be in flight at a time.
    }

    private fun addHapticService() {
        val server = gattServer ?: return
        val service = BluetoothGattService(HAPTIC_SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                HAPTIC_CHARACTERISTIC,
                BluetoothGattCharacteristic.PROPERTY_WRITE
                    or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            )
        )
        server.addService(service)
    }

    private fun stopInternal() {
        stopAdvertising()
        subscribers.clear()
        notifyInFlight.clear()
        try {
            gattServer?.clearServices()
            gattServer?.close()
        } catch (e: Exception) {
            Log.w(LOG_TAG, "Error closing GATT server", e)
        }
        gattServer = null
        hrChar = null
        advertiser = null
    }

    // ── Advertising ──────────────────────────────────────────────────────────

    private fun startAdvertising(mode: Int) {
        val adv = advertiser ?: return
        if (advertising) stopAdvertising()

        currentMode = mode

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(mode)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()

        // The service UUID MUST be in the primary payload: js/ble-manager.js:64-67 calls
        // requestDevice({ services: [HR_SERVICE] }), which filters on advertised UUIDs.
        // The device name MUST NOT be — a 128-bit UUID plus a ~20-char name overflows the
        // 31-byte limit and fails with ADVERTISE_FAILED_DATA_TOO_LARGE.
        val data = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(HR_SERVICE))
            .setIncludeDeviceName(false)
            .setIncludeTxPowerLevel(false)
            .build()

        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .build()

        try {
            adv.startAdvertising(settings, data, scanResponse, advertiseCallback)
        } catch (e: Exception) {
            onEvent(GattEvent.Failed(Reason.ADVERTISE_FAILED, e.message ?: "startAdvertising falhou"))
        }
    }

    private fun stopAdvertising() {
        if (!advertising) return
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (e: Exception) {
            Log.w(LOG_TAG, "stopAdvertising failed", e)
        }
        advertising = false
    }

    /**
     * LOW_LATENCY while nobody is subscribed (fast discovery), BALANCED once a central is
     * riding along — meaningful battery savings across a 45-minute session.
     */
    private fun syncAdvertiseMode() {
        val wanted = if (subscribers.isEmpty()) {
            AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY
        } else {
            AdvertiseSettings.ADVERTISE_MODE_BALANCED
        }
        if (wanted != currentMode || !advertising) startAdvertising(wanted)
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            advertising = true
            Log.i(LOG_TAG, "Advertising 0x180D, mode=$currentMode")
            onEvent(GattEvent.Advertising)
        }

        override fun onStartFailure(errorCode: Int) {
            advertising = false
            val detail = when (errorCode) {
                ADVERTISE_FAILED_DATA_TOO_LARGE -> "payload > 31 bytes"
                ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "muitos advertisers no sistema"
                ADVERTISE_FAILED_ALREADY_STARTED -> "já estava anunciando"
                ADVERTISE_FAILED_INTERNAL_ERROR -> "erro interno do stack BLE"
                ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "relógio não suporta peripheral role"
                else -> "código $errorCode"
            }
            Log.e(LOG_TAG, "Advertise failed: $detail")
            onEvent(GattEvent.Failed(Reason.ADVERTISE_FAILED, detail))
        }
    }

    // ── GATT server ──────────────────────────────────────────────────────────

    private val gattCallback = object : BluetoothGattServerCallback() {

        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                onEvent(GattEvent.Failed(Reason.GATT_FAILED, "addService status=$status"))
                return
            }
            when (service.uuid) {
                HR_SERVICE -> handler.post {
                    startAdvertising(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                    addHapticService()
                }
                HAPTIC_SERVICE -> Log.i(LOG_TAG, "Haptic service ready")
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Log.i(LOG_TAG, "Central disconnected: ${device.address}")
                    subscribers.remove(device)
                    notifyInFlight.remove(device.address)
                    onEvent(GattEvent.SubscribersChanged(subscribers.size))
                    syncAdvertiseMode()
                } else if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Log.i(LOG_TAG, "Central connected: ${device.address}")
                }
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic,
        ) {
            val value = characteristic.value ?: ByteArray(0)
            val slice = if (offset < value.size) value.copyOfRange(offset, value.size) else ByteArray(0)
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice)
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor,
        ) {
            val value = if (subscribers.contains(device)) {
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            } else {
                BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            }
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (descriptor.uuid == CCCD) {
                val enable = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                handler.post {
                    if (enable) subscribers.add(device) else subscribers.remove(device)
                    Log.i(LOG_TAG, "CCCD ${if (enable) "subscribe" else "unsubscribe"} ${device.address}")
                    onEvent(GattEvent.SubscribersChanged(subscribers.size))
                    syncAdvertiseMode()
                }
            }
            // Never skip this: a missing response on responseNeeded is the #1 cause of
            // "connects, then drops after ~30s".
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == HAPTIC_CHARACTERISTIC && value.isNotEmpty()) {
                onEvent(GattEvent.HapticRequested(value[0].toInt() and 0xff))
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post { notifyInFlight.remove(device.address) }
        }
    }

    // ── Publishing ───────────────────────────────────────────────────────────

    /** Notifies every subscribed central. Safe to call from any thread. */
    fun publish(bpm: Int, contact: Boolean) {
        handler.post {
            val server = gattServer ?: return@post
            val characteristic = hrChar ?: return@post
            if (subscribers.isEmpty()) return@post

            val payload = buildHrPacket(bpm, contact)

            val now = System.currentTimeMillis()
            for (device in subscribers.toList()) {
                // Still in flight — drop this sample, unless the callback never came back.
                val sentAt = notifyInFlight[device.address]
                if (sentAt != null && now - sentAt < NOTIFY_TIMEOUT_MS) continue
                notifyInFlight[device.address] = now
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        server.notifyCharacteristicChanged(device, characteristic, false, payload)
                    } else {
                        @Suppress("DEPRECATION")
                        characteristic.value = payload
                        @Suppress("DEPRECATION")
                        server.notifyCharacteristicChanged(device, characteristic, false)
                    }
                } catch (e: Exception) {
                    notifyInFlight.remove(device.address)
                    Log.w(LOG_TAG, "notify failed for ${device.address}", e)
                }
            }
        }
    }
}
