// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 on the screen's pixels (Plan 4 Task 4.4): the general-flash and red-flash analysis of a
// capture, pixel by pixel. Each pixel's own luminance and red transitions are followed as the frames
// arrive (no frame is kept), and for every one-second window the test knows which pixels flash in it:
// more than six of their own transitions certainly inside it (each after the frame before the one
// that shows it). The flashing area of a window is those pixels, at their real size on the page:
// - a pixel that flashes counts whole;
// - a pixel an edge of the flashing content cuts (the capture is downscaled, so it shows a blend, in
//   sRGB, of the content and what is beside it) counts for the share the content covers, but only
//   when it is shown to be such a blend: its two states are one mix of the states of a pixel nearby
//   that swings fully and of a still pixel beside it. A blended pixel that does not flash by itself
//   (too little of it is covered, or a red edge mixed to pink) counts in the windows its full pixel
//   flashes in.
// Nothing is averaged over a cell first, so flashes that cancel inside a cell (opposite phases side
// by side) keep their area, and nothing flashes in a window it did not flash in. Content finer than
// one capture pixel (4 CSS px at the screencast's size) is blended away by the capture itself.
// Memory is per pixel (about 100 bytes), so captures are metered at the screencast's size
// (`meterImage`). Pure; engine core, no Node-only imports.
import { FLASH, SPOT_POINTS, chromaticity, isSaturatedRed, type FlashFinding } from './flashMath.js';
import { LINEAR, type RgbaImage } from './pixels.js';

/** A pixel no further than this from its first colour (sRGB, squared, 0–1 channels) is still. */
const STILL = 3 * (3 / 255) ** 2;
/** Largest RMS error (sRGB, 0–1) of a pixel read as a blend of a fully swinging pixel and a still one. */
const BLEND_RMS = 10 / 255;
/** Transitions remembered per pixel (the count in one second is read from them). */
const RING = 32;
/** CSS px of the cells the 10° field is placed on. */
const PLACE_CELL_CSS = 16;
/** Frames a capture may have (frame numbers are bytes). */
export const METER_MAX_FRAMES = 255;

export interface PixelFlashAnalysis {
  frames: number;
  durationMs: number;
  fps: number;
  general: FlashFinding | null;
  red: FlashFinding | null;
}

/** Per kind of flash: each pixel's state, its last transitions (frame numbers) and the windows it flashes in. */
class Track {
  readonly ring: Uint8Array;
  readonly count: Uint16Array;
  /** Bit s: the pixel flashes in the one-second window that starts at frame s. */
  readonly bits: Uint8Array;
  readonly any: Uint8Array;
  /** Most transitions certainly inside one second (for the result's text). */
  readonly most: Uint8Array;
  constructor(n: number, readonly bytesPer: number) {
    this.ring = new Uint8Array(n * RING);
    this.count = new Uint16Array(n);
    this.bits = new Uint8Array(n * bytesPer);
    this.any = new Uint8Array(n);
    this.most = new Uint8Array(n);
  }
  has(p: number, s: number): boolean {
    return (this.bits[p * this.bytesPer + (s >> 3)]! & (1 << (s & 7))) !== 0;
  }
  /** A transition first shown at frame `at` (it happened after frame at - 1). */
  push(p: number, at: number, times: Float64Array): void {
    const c = this.count[p]!;
    this.ring[p * RING + (c % RING)] = at;
    this.count[p] = c + 1;
    const kept = Math.min(c + 1, RING);
    const tAt = times[at]!;
    // How many of the kept transitions certainly fall within one second ending with this one.
    let inside = 0;
    for (let k = 0; k < kept; k++) {
      const f = this.ring[p * RING + ((c - k + RING * 8) % RING)]!;
      if (tAt - times[f - 1]! < FLASH.window) inside++;
      else break;
    }
    if (inside > this.most[p]!) this.most[p] = Math.min(255, inside);
    const k = FLASH.maxTransitions;
    if (kept <= k) return;
    // The seven ending with this one: the windows that hold them all start at or before the frame
    // before the first (it happened after that frame) and less than a second before this one.
    const first = this.ring[p * RING + ((c - k + RING * 8) % RING)]!;
    const early = times[first - 1]!;
    if (tAt - early >= FLASH.window) return;
    for (let s = first - 1; s >= 0 && times[s]! > tAt - FLASH.window; s--) this.bits[p * this.bytesPer + (s >> 3)]! |= 1 << (s & 7);
    this.any[p] = 1;
  }
}

/** A capture image no wider than `width` (box-averaged in sRGB, as the screencast downscales). */
export function meterImage(img: RgbaImage, width: number): RgbaImage {
  if (img.width <= width) return img;
  const f = img.width / width;
  const w = width;
  const h = Math.max(1, Math.round(img.height / f));
  const out = new Uint8Array(w * h * 4);
  const src = img.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * f)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * f)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0, q = (yy * img.width + x0) * 4; xx < x1; xx++, q += 4) { r += src[q]!; g += src[q + 1]!; b += src[q + 2]!; n++; }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Follows every pixel of a capture: feed the frames in order with `add` (null for a frame identical to
 * the one before; at most `maxFrames`), then `analyse` once.
 */
export class PixelFlashMeter {
  readonly width: number;
  readonly height: number;
  private readonly n: number;
  private readonly maxFrames: number;
  private readonly times: Float64Array;
  private frames = 0;
  private prev: Uint8Array;
  // General flashes: the zigzag of `luminanceTransitions`, per pixel (frame numbers, not times).
  private readonly dir: Int8Array;
  private readonly lo: Float32Array;
  private readonly hi: Float32Array;
  private readonly pivot: Float32Array;
  private readonly ext: Float32Array;
  private readonly loI: Uint8Array;
  private readonly hiI: Uint8Array;
  private readonly startI: Uint8Array;
  private readonly general: Track;
  // Red flashes: the state of `redTransitions`, per pixel.
  private readonly refRed: Uint8Array;
  private readonly refU: Float32Array;
  private readonly refV: Float32Array;
  private readonly red: Track;
  // The pixel's first colour and the colour furthest from it (its two states), sRGB bytes.
  private readonly c0: Uint8Array;
  private readonly c1: Uint8Array;
  private readonly d1: Float32Array;

  constructor(width: number, height: number, maxFrames: number = METER_MAX_FRAMES) {
    if (maxFrames > METER_MAX_FRAMES) throw new Error('too many frames for the pixel meter');
    this.width = width;
    this.height = height;
    this.maxFrames = maxFrames;
    const n = (this.n = width * height);
    const bytesPer = Math.ceil(maxFrames / 8);
    this.times = new Float64Array(maxFrames);
    this.prev = new Uint8Array(n * 3);
    this.dir = new Int8Array(n);
    this.lo = new Float32Array(n); this.hi = new Float32Array(n); this.pivot = new Float32Array(n); this.ext = new Float32Array(n);
    this.loI = new Uint8Array(n); this.hiI = new Uint8Array(n); this.startI = new Uint8Array(n);
    this.general = new Track(n, bytesPer);
    this.refRed = new Uint8Array(n); this.refU = new Float32Array(n); this.refV = new Float32Array(n);
    this.red = new Track(n, bytesPer);
    this.c0 = new Uint8Array(n * 3); this.c1 = new Uint8Array(n * 3); this.d1 = new Float32Array(n);
  }

  /** Bytes the meter holds (its typed arrays), whatever the length of the capture. */
  bytes(): number {
    let total = 0;
    for (const v of Object.values(this)) if (ArrayBuffer.isView(v)) total += v.byteLength;
    for (const tr of [this.general, this.red]) for (const v of Object.values(tr)) if (ArrayBuffer.isView(v)) total += v.byteLength;
    return total;
  }

  /** One frame at time `t` (ms, increasing); null when it shows the same pixels as the one before. False when the meter is full. */
  add(t: number, img: RgbaImage | null): boolean {
    if (this.frames >= this.maxFrames) return false;
    const i = this.frames;
    if (i === 0) {
      if (!img) return false;
      this.first(t, img);
      return true;
    }
    this.times[i] = t;
    this.frames++;
    if (!img) return true;
    if (img.width !== this.width || img.height !== this.height) throw new Error('frames of different sizes');
    const d = img.data;
    const prev = this.prev;
    const lin = LINEAR;
    for (let p = 0, q = 0, k = 0; p < this.n; p++, q += 4, k += 3) {
      const r = d[q]!, g = d[q + 1]!, b = d[q + 2]!;
      if (r === prev[k] && g === prev[k + 1] && b === prev[k + 2]) continue;
      prev[k] = r; prev[k + 1] = g; prev[k + 2] = b;
      const lr = lin[r]!, lg = lin[g]!, lb = lin[b]!;
      this.stepLum(p, 0.2126 * lr + 0.7152 * lg + 0.0722 * lb, i);
      this.stepRed(p, lr, lg, lb, i);
      const dr = (r - this.c0[k]!) / 255, dg = (g - this.c0[k + 1]!) / 255, db = (b - this.c0[k + 2]!) / 255;
      const dist = dr * dr + dg * dg + db * db;
      if (dist > this.d1[p]!) { this.d1[p] = dist; this.c1[k] = r; this.c1[k + 1] = g; this.c1[k + 2] = b; }
    }
    return true;
  }

  private first(t: number, img: RgbaImage): void {
    if (img.width !== this.width || img.height !== this.height) throw new Error('frames of different sizes');
    this.frames = 1;
    this.times[0] = t;
    const d = img.data;
    const lin = LINEAR;
    for (let p = 0, q = 0, k = 0; p < this.n; p++, q += 4, k += 3) {
      const r = d[q]!, g = d[q + 1]!, b = d[q + 2]!;
      this.prev[k] = r; this.prev[k + 1] = g; this.prev[k + 2] = b;
      const v = 0.2126 * lin[r]! + 0.7152 * lin[g]! + 0.0722 * lin[b]!;
      this.lo[p] = v; this.hi[p] = v;
      this.refRed[p] = isSaturatedRed(lin[r]!, lin[g]!, lin[b]!) ? 1 : 0;
      const uv = chromaticity(lin[r]!, lin[g]!, lin[b]!);
      this.refU[p] = uv[0]; this.refV[p] = uv[1];
      this.c0[k] = r; this.c0[k + 1] = g; this.c0[k + 2] = b;
      this.c1[k] = r; this.c1[k + 1] = g; this.c1[k + 2] = b;
    }
  }

  private stepLum(p: number, v: number, i: number): void {
    const delta = FLASH.delta;
    const dir = this.dir[p]!;
    const pushIf = (from: number, to: number) => { if (Math.min(from, to) < FLASH.darkerBelow) this.general.push(p, this.startI[p]!, this.times); };
    if (dir === 0) {
      if (v < this.lo[p]!) { this.lo[p] = v; this.loI[p] = i; }
      if (v > this.hi[p]!) { this.hi[p] = v; this.hiI[p] = i; }
      if (v - this.lo[p]! >= delta && this.loI[p]! < i) { this.dir[p] = 1; this.pivot[p] = this.lo[p]!; this.ext[p] = v; this.startI[p] = i; } else if (this.hi[p]! - v >= delta && this.hiI[p]! < i) { this.dir[p] = -1; this.pivot[p] = this.hi[p]!; this.ext[p] = v; this.startI[p] = i; }
      return;
    }
    const ext = this.ext[p]!;
    if (dir === 1) {
      if (v >= ext) this.ext[p] = v;
      else if (ext - v >= delta) { pushIf(this.pivot[p]!, ext); this.pivot[p] = ext; this.dir[p] = -1; this.ext[p] = v; this.startI[p] = i; }
    } else if (v <= ext) this.ext[p] = v;
    else if (v - ext >= delta) { pushIf(this.pivot[p]!, ext); this.pivot[p] = ext; this.dir[p] = 1; this.ext[p] = v; this.startI[p] = i; }
  }

  private stepRed(p: number, r: number, g: number, b: number, i: number): void {
    const red = isSaturatedRed(r, g, b);
    const was = this.refRed[p] === 1;
    if (red !== was) {
      const uv = chromaticity(r, g, b);
      if (Math.hypot(uv[0] - this.refU[p]!, uv[1] - this.refV[p]!) > FLASH.redDistance) {
        this.red.push(p, i, this.times);
        this.refRed[p] = red ? 1 : 0;
        this.refU[p] = uv[0]; this.refV[p] = uv[1];
      }
    } else if (red) {
      const uv = chromaticity(r, g, b);
      this.refU[p] = uv[0]; this.refV[p] = uv[1];
    }
  }

  /** Ends the capture: a general transition still running at the last frame counts. */
  private finish(): void {
    for (let p = 0; p < this.n; p++) {
      if (this.dir[p] === 0) continue;
      const pivot = this.pivot[p]!, ext = this.ext[p]!;
      if (Math.abs(ext - pivot) >= FLASH.delta && Math.min(pivot, ext) < FLASH.darkerBelow) this.general.push(p, this.startI[p]!, this.times);
      this.dir[p] = 0;
    }
  }

  /** Whether pixel `p` flashes in the window that starts at frame `s` (tests). */
  flashesIn(kind: 'general' | 'red', p: number, s: number): boolean {
    return (kind === 'general' ? this.general : this.red).has(p, s);
  }

  /**
   * The analysis: for each kind, the window and placement of the 10° field (in 16 CSS px steps,
   * never larger than the field) with the most flashing area, when it is more than 25% of the field.
   * `cssPx` is the CSS px one capture pixel covers; `viewport` sets the field.
   */
  analyse(viewport: { width: number; height: number }, cssPx: number): PixelFlashAnalysis {
    const n = this.frames;
    const durationMs = n > 1 ? this.times[n - 1]! - this.times[0]! : 0;
    const fps = durationMs > 0 ? ((n - 1) * 1000) / durationMs : 0;
    const base = { frames: n, durationMs: Math.round(durationMs), fps: Math.round(fps * 10) / 10 };
    if (n < 2) return { ...base, general: null, red: null };
    this.finish();
    return { ...base, general: this.worst(this.general, 'general', viewport, cssPx), red: this.worst(this.red, 'red', viewport, cssPx) };
  }

  private worst(track: Track, kind: FlashFinding['kind'], viewport: { width: number; height: number }, cssPx: number): FlashFinding | null {
    const W = this.width, H = this.height;
    // Pixels that count, and how much: flashing ones (1, or their share when a proven blend), and
    // blends that do not flash themselves (their share, in the windows their full pixel flashes in).
    const candP: number[] = [], candW: number[] = [], candRef: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const own = track.any[p] === 1;
        let ref = -1, refD = -1, still = -1;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            if (track.any[q] && this.d1[q]! > refD) { refD = this.d1[q]!; ref = q; }
            if (still < 0 && dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && q !== p && this.d1[q]! <= STILL) still = q;
          }
        }
        if (ref < 0) continue;
        const share = still >= 0 && ref !== p && refD >= this.d1[p]! ? this.blend(p, ref, still) : null;
        if (own) { candP.push(p); candW.push(share ?? 1); candRef.push(-1); } else if (share !== null && share > 0) { candP.push(p); candW.push(share); candRef.push(ref); }
      }
    }
    if (!candP.length) return null;
    const area1 = cssPx * cssPx;
    const cellPx = Math.max(1, Math.round(PLACE_CELL_CSS / cssPx));
    const cols = Math.ceil(W / cellPx), rows = Math.ceil(H / cellPx);
    const cellOf = candP.map((p) => Math.floor(Math.floor(p / W) / cellPx) * cols + Math.floor((p % W) / cellPx));
    const field = { w: Math.round(FLASH.field.w * viewport.width), h: Math.round(FLASH.field.h * viewport.height) };
    const fieldArea = Math.max(1, field.w * field.h);
    const limit = FLASH.areaShare * fieldArea;
    const cellCss = cellPx * cssPx;
    const pw = Math.min(cols, Math.max(1, Math.floor(field.w / cellCss + 1e-6)));
    const ph = Math.min(rows, Math.max(1, Math.floor(field.h / cellCss + 1e-6)));
    const area = new Float64Array(cols * rows);
    const sum = new Float64Array((cols + 1) * (rows + 1));
    let found: FlashFinding | null = null;
    for (let s = 0; s < this.frames; s++) {
      area.fill(0);
      let anyIn = false;
      for (let i = 0; i < candP.length; i++) {
        const q = candRef[i]! < 0 ? candP[i]! : candRef[i]!;
        if (!track.has(q, s)) continue;
        area[cellOf[i]!]! += candW[i]! * area1;
        anyIn = true;
      }
      if (!anyIn) continue;
      for (let y = 0; y < rows; y++) {
        let row = 0;
        for (let x = 0; x < cols; x++) {
          row += area[y * cols + x]!;
          sum[(y + 1) * (cols + 1) + x + 1] = sum[y * (cols + 1) + x + 1]! + row;
        }
      }
      let best = { a: 0, x: 0, y: 0 };
      for (let y = 0; y + ph <= rows; y++) {
        for (let x = 0; x + pw <= cols; x++) {
          const a = sum[(y + ph) * (cols + 1) + x + pw]! - sum[y * (cols + 1) + x + pw]! - sum[(y + ph) * (cols + 1) + x]! + sum[y * (cols + 1) + x]!;
          if (a > best.a + 1e-9) best = { a, x, y };
        }
      }
      if (best.a <= limit || (found && best.a <= found.area)) continue;
      // The flashing pixels inside that placement: where they are, and the most transitions one had.
      const x0 = best.x * cellPx, y0 = best.y * cellPx, x1 = Math.min(W, (best.x + pw) * cellPx), y1 = Math.min(H, (best.y + ph) * cellPx);
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity, most = 0;
      const inside: number[] = [];
      for (let i = 0; i < candP.length; i++) {
        if (candRef[i]! >= 0) continue;
        const p = candP[i]!;
        const x = p % W, y = Math.floor(p / W);
        if (x < x0 || x >= x1 || y < y0 || y >= y1 || !track.has(p, s)) continue;
        inside.push(p);
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
        most = Math.max(most, track.most[p]!);
      }
      if (!inside.length) continue;
      const step = inside.length / Math.min(SPOT_POINTS, inside.length);
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i < inside.length && points.length < SPOT_POINTS; i += step) {
        const p = inside[Math.floor(i)]!;
        points.push({ x: ((p % W) + 0.5) * cssPx, y: (Math.floor(p / W) + 0.5) * cssPx });
      }
      found = {
        kind, transitions: most, at: Math.round(this.times[s]! - this.times[0]!), area: best.a, share: best.a / fieldArea,
        box: { x: best.x * cellCss, y: best.y * cellCss, w: pw * cellCss, h: ph * cellCss },
        spot: { x: bx0 * cssPx, y: by0 * cssPx, w: (bx1 - bx0 + 1) * cssPx, h: (by1 - by0 + 1) * cssPx },
        points,
      };
    }
    return found;
  }

  /** The share `a` with which pixel p's two states are a blend of ref's states and the still pixel's colour, or null. */
  private blend(p: number, ref: number, still: number): number | null {
    const s = [this.c0[still * 3]! / 255, this.c0[still * 3 + 1]! / 255, this.c0[still * 3 + 2]! / 255];
    const P = [this.c0, this.c1].map((c) => [c[p * 3]! / 255 - s[0]!, c[p * 3 + 1]! / 255 - s[1]!, c[p * 3 + 2]! / 255 - s[2]!]);
    const Q = [this.c0, this.c1].map((c) => [c[ref * 3]! / 255 - s[0]!, c[ref * 3 + 1]! / 255 - s[1]!, c[ref * 3 + 2]! / 255 - s[2]!]);
    let best: { a: number; rms: number } | null = null;
    for (const order of [[0, 1], [1, 0]] as const) {
      let num = 0, den = 0;
      for (let i = 0; i < 2; i++) for (let ch = 0; ch < 3; ch++) { const q = Q[order[i]!]![ch]!; num += P[i]![ch]! * q; den += q * q; }
      if (den <= 1e-6) continue;
      const a = num / den;
      let err = 0;
      for (let i = 0; i < 2; i++) for (let ch = 0; ch < 3; ch++) err += (P[i]![ch]! - a * Q[order[i]!]![ch]!) ** 2;
      const rms = Math.sqrt(err / 6);
      if (!best || rms < best.rms) best = { a, rms };
    }
    if (!best || best.rms > BLEND_RMS || best.a < -0.05) return null;
    return Math.max(0, Math.min(1, best.a));
  }
}
