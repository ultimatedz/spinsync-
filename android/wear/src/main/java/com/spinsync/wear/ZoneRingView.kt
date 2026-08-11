package com.spinsync.wear

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.min

/**
 * Zone gauge drawn around the rim of the display.
 *
 * The zone already travels in the workout packet from the phone and was going unused. A
 * colour on the wrist answers "am I working hard enough" without reading a number, which
 * is the whole point of glancing at a watch mid-effort.
 *
 * At the rim rather than around the BPM readout: a ring sized to surround the number is
 * roughly 96dp tall, and on a 450px round watch that is enough to push the Parar button
 * off the bottom. The rim is free real estate.
 */
class ZoneRingView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private companion object {
        /** Mirrors ZONES in js/zone-calculator.js. Index 0 is "no zone". */
        val ZONE_COLORS = intArrayOf(
            Color.parseColor("#30363D"), // sem zona
            Color.parseColor("#4FC3F7"), // Z1 aquecimento
            Color.parseColor("#66BB6A"), // Z2 queima
            Color.parseColor("#FFA726"), // Z3 aeróbico
            Color.parseColor("#EF5350"), // Z4 anaeróbico
            Color.parseColor("#AB47BC"), // Z5 VO2
        )

        const val STROKE_DP = 6f
        /** Leaves a gap at the bottom so the ring reads as a gauge, not a plain circle. */
        const val SWEEP_DEGREES = 300f
        const val START_DEGREES = 120f
        /** Keeps the stroke clear of the bezel curvature. */
        const val EDGE_INSET_DP = 3f
    }

    private val density = context.resources.displayMetrics.density

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        color = ZONE_COLORS[0]
        strokeWidth = STROKE_DP * density
    }

    private val zonePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = STROKE_DP * density
    }

    private val bounds = RectF()

    /** 0 = no zone; 1-5 map to the palette above. */
    var zone: Int = 0
        set(value) {
            val clamped = value.coerceIn(0, 5)
            if (field == clamped) return
            field = clamped
            invalidate()
        }

    /** Ambient mode: outline only, no fill, to respect the burn-in guidance. */
    var ambient: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            zonePaint.strokeWidth = (if (value) STROKE_DP / 2 else STROKE_DP) * density
            invalidate()
        }

    override fun onDraw(canvas: Canvas) {
        val inset = zonePaint.strokeWidth / 2 + EDGE_INSET_DP * density
        val size = min(width, height).toFloat()
        val left = (width - size) / 2 + inset
        val top = (height - size) / 2 + inset
        bounds.set(left, top, left + size - inset * 2, top + size - inset * 2)

        // The unfilled track is pure battery cost in ambient mode for no information.
        if (!ambient) {
            canvas.drawArc(bounds, START_DEGREES, SWEEP_DEGREES, false, trackPaint)
        }

        if (zone > 0) {
            zonePaint.color = ZONE_COLORS[zone]
            // Fill proportionally to the zone, so the ring reads as a level and not just
            // as a colour swap.
            canvas.drawArc(bounds, START_DEGREES, SWEEP_DEGREES * zone / 5f, false, zonePaint)
        }
    }
}
