package com.spinsync.wear

import android.content.Context
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.Button
import androidx.wear.protolayout.material.ButtonColors
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.PrimaryLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * Quick-start tile: one swipe from the watch face starts broadcasting.
 *
 * Getting to the app meant the launcher, which on a wrist with gloves on and a class
 * already starting is several taps too many. The tile also doubles as a live BPM readout
 * while a session is running.
 */
class SpinSyncTileService : TileService() {

    private companion object {
        const val RESOURCES_VERSION = "1"
        /** Refresh cadence when idle. The tile is a shortcut, not a dashboard. */
        const val FRESHNESS_IDLE_MS = 0L
        /** While broadcasting, keep the number roughly current without draining anything. */
        const val FRESHNESS_ACTIVE_MS = 20_000L
        const val ID_CLICK_START = "spinsync_start"
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest
    ): ListenableFuture<ResourceBuilders.Resources> = Futures.immediateFuture(
        ResourceBuilders.Resources.Builder().setVersion(RESOURCES_VERSION).build()
    )

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest
    ): ListenableFuture<TileBuilders.Tile> {
        val state = HrState.flow.value
        val deviceParams = requestParams.deviceConfiguration

        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RESOURCES_VERSION)
            // A running session refreshes; an idle one has nothing to say until tapped.
            .setFreshnessIntervalMillis(
                if (state.isRunning) FRESHNESS_ACTIVE_MS else FRESHNESS_IDLE_MS
            )
            .setTileTimeline(
                TimelineBuilders.Timeline.fromLayoutElement(layout(state, deviceParams))
            )
            .build()

        return Futures.immediateFuture(tile)
    }

    private fun layout(
        state: HrUiState,
        deviceParams: DeviceParameters,
    ): LayoutElementBuilders.LayoutElement {
        val running = state.isRunning
        val headline = if (running && state.bpm > 0) "${state.bpm} bpm" else getString(R.string.app_name)
        val label = when {
            !running -> getString(R.string.tile_idle)
            state.subscribers > 0 -> getString(R.string.status_connected)
            else -> getString(R.string.status_advertising)
        }

        return PrimaryLayout.Builder(deviceParams)
            .setResponsiveContentInsetEnabled(true)
            .setPrimaryLabelTextContent(
                Text.Builder(this, headline)
                    .setTypography(Typography.TYPOGRAPHY_TITLE2)
                    .setColor(argb(getColor(R.color.hr_red)))
                    .build()
            )
            .setSecondaryLabelTextContent(
                Text.Builder(this, label)
                    .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                    .setColor(argb(getColor(R.color.text_secondary)))
                    .build()
            )
            .setContent(
                Button.Builder(this, launchAction())
                    .setTextContent(
                        getString(if (running) R.string.btn_stop else R.string.btn_start)
                    )
                    .setButtonColors(
                        ButtonColors(getColor(R.color.hr_red), getColor(android.R.color.white))
                    )
                    .build()
            )
            .build()
    }

    /**
     * Opens the app rather than starting the service directly.
     *
     * Starting to broadcast needs runtime permissions, and a permission dialog cannot be
     * raised from a tile — so the tile hands off to the activity that can ask.
     */
    private fun launchAction() = ModifiersBuilders.Clickable.Builder()
        .setId(ID_CLICK_START)
        .setOnClick(
            ActionBuilders.LaunchAction.Builder()
                .setAndroidActivity(
                    ActionBuilders.AndroidActivity.Builder()
                        .setPackageName(packageName)
                        .setClassName(MainActivity::class.java.name)
                        .build()
                )
                .build()
        )
        .build()
}

/** Asks the system to redraw the tile after the broadcast state changes. */
fun requestTileUpdate(context: Context) {
    runCatching {
        TileService.getUpdater(context).requestUpdate(SpinSyncTileService::class.java)
    }
}
