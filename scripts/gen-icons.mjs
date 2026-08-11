#!/usr/bin/env node
/**
 * Generates the PWA icons referenced by manifest.json into assets/icons/.
 *
 * manifest.json has always pointed at assets/icons/icon-192.png and icon-512.png, but
 * neither file (nor the assets/ directory) existed: installing to the home screen got a
 * blank icon and two 404s on every launch.
 *
 * The artwork is rasterised here rather than committed as binaries so it stays diffable
 * and stays in sync with the palette in css/styles.css. No image dependency is used —
 * sharp/canvas would be a native build step for four small files — so the PNG encoder
 * below is hand-rolled on top of node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'assets', 'icons');

// Mirrors --bg-primary, --accent-blue and --hr-red in css/styles.css.
const BG = [0x0d, 0x11, 0x17];
const BLUE = [0x29, 0x79, 0xff];
const RED = [0xef, 0x53, 0x50];

/** Supersampling factor. 4x is enough to hide stair-stepping at 192px. */
const SS = 4;

// ── PNG encoding ───────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba - size*size*4, row-major. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10-12: compression / filter / interlace, all 0

  // Filter type 0 (None) on every scanline: these are flat-colour icons, so the extra
  // filter search would buy a handful of bytes at most.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ────────────────────────────────────────────────────────────────

/**
 * A tiny supersampled canvas. Coordinates are normalised 0..1 so the same drawing code
 * produces every size.
 */
class Canvas {
  constructor(size) {
    this.size = size;
    this.n = size * SS;
    this.px = new Float64Array(this.n * this.n * 4);
  }

  _blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    const i = (y * this.n + x) * 4;
    const a = Math.min(1, alpha);
    const dst = this.px[i + 3];
    const out = a + dst * (1 - a);
    if (out <= 0) return;
    this.px[i] = (r * a + this.px[i] * dst * (1 - a)) / out;
    this.px[i + 1] = (g * a + this.px[i + 1] * dst * (1 - a)) / out;
    this.px[i + 2] = (b * a + this.px[i + 2] * dst * (1 - a)) / out;
    this.px[i + 3] = out;
  }

  /** Rounded rectangle in normalised coords. radius 0.5 gives a circle. */
  fillRoundRect(x0, y0, x1, y1, radius, color) {
    const n = this.n;
    const [ax, ay, bx, by, r] = [x0 * n, y0 * n, x1 * n, y1 * n, radius * n];
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) {
      for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
        // Distance from the inner rectangle whose corners are inset by r.
        const dx = Math.max(ax + r - x, 0, x - (bx - r));
        const dy = Math.max(ay + r - y, 0, y - (by - r));
        if (Math.hypot(dx, dy) <= r) this._blend(x, y, color, 1);
      }
    }
  }

  /** Ring centred at (cx, cy). [width] is the stroke thickness, all normalised. */
  strokeCircle(cx, cy, radius, width, color) {
    const n = this.n;
    const [px, py, rr, hw] = [cx * n, cy * n, radius * n, (width * n) / 2];
    const outer = rr + hw;
    for (let y = Math.floor(py - outer); y <= Math.ceil(py + outer); y++) {
      for (let x = Math.floor(px - outer); x <= Math.ceil(px + outer); x++) {
        const d = Math.abs(Math.hypot(x - px, y - py) - rr);
        if (d <= hw) this._blend(x, y, color, 1);
      }
    }
  }

  /** Round-capped polyline through normalised [[x, y], ...] points. */
  strokePolyline(points, width, color) {
    const n = this.n;
    const hw = (width * n) / 2;
    const pts = points.map(([x, y]) => [x * n, y * n]);

    for (let s = 0; s < pts.length - 1; s++) {
      const [x1, y1] = pts[s];
      const [x2, y2] = pts[s + 1];
      const minX = Math.floor(Math.min(x1, x2) - hw);
      const maxX = Math.ceil(Math.max(x1, x2) + hw);
      const minY = Math.floor(Math.min(y1, y2) - hw);
      const maxY = Math.ceil(Math.max(y1, y2) + hw);
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy || 1;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          // Distance to the segment, clamped to the endpoints (round caps + joins).
          const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq));
          const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
          if (d <= hw) this._blend(x, y, color, 1);
        }
      }
    }
  }

  /** Box-downsamples the supersampled buffer to the final RGBA bytes. */
  toRGBA() {
    const out = new Uint8Array(this.size * this.size * 4);
    const area = SS * SS;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * this.n + (x * SS + sx)) * 4;
            const pa = this.px[i + 3];
            r += this.px[i] * pa;
            g += this.px[i + 1] * pa;
            b += this.px[i + 2] * pa;
            a += pa;
          }
        }
        const o = (y * this.size + x) * 4;
        // Un-premultiply: averaging straight colour would darken edges toward black.
        out[o] = a > 0 ? Math.round(r / a) : 0;
        out[o + 1] = a > 0 ? Math.round(g / a) : 0;
        out[o + 2] = a > 0 ? Math.round(b / a) : 0;
        out[o + 3] = Math.round((a / area) * 255);
      }
    }
    return out;
  }
}

/**
 * A spinning wheel with a heart-rate trace across it — the two things the app measures.
 *
 * @param {number} scale  Content scale. Maskable icons get 0.8 so nothing lands under
 *                        the circular mask Android applies on some launchers.
 * @param {number} corner Background corner radius. 0.5 = circle, 0 = full bleed square.
 */
function drawIcon(size, { scale = 1, corner = 0.22 } = {}) {
  const c = new Canvas(size);
  c.fillRoundRect(0, 0, 1, 1, corner, BG);

  const at = (v) => 0.5 + (v - 0.5) * scale;
  const ring = 0.31 * scale;

  c.strokeCircle(0.5, 0.5, ring, 0.08 * scale, BLUE);

  // ECG trace. Amplitude stays well inside the ring: a taller spike reads as a red "V"
  // and swallows the wheel at 48px, which is the size that actually matters on a launcher.
  c.strokePolyline(
    [
      [at(0.20), at(0.5)],
      [at(0.37), at(0.5)],
      [at(0.435), at(0.385)],
      [at(0.5), at(0.625)],
      [at(0.565), at(0.455)],
      [at(0.625), at(0.5)],
      [at(0.80), at(0.5)],
    ],
    0.058 * scale,
    RED,
  );

  return encodePng(c.toRGBA(), size);
}

// ── Output ─────────────────────────────────────────────────────────────────

const OUTPUTS = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  // Maskable icons are cropped to a circle inscribed in the middle 80%, so the content
  // shrinks and the background must bleed to the edges.
  ['icon-maskable-512.png', 512, { scale: 0.8, corner: 0 }],
  // iOS ignores the manifest and composites onto its own rounded rect.
  ['apple-touch-icon-180.png', 180, { corner: 0 }],
];

mkdirSync(outDir, { recursive: true });
for (const [name, size, opts] of OUTPUTS) {
  const png = drawIcon(size, opts);
  writeFileSync(resolve(outDir, name), png);
  console.log(`[icons] ${name} (${size}x${size}, ${png.length} bytes)`);
}
