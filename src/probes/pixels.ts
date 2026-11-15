// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Pixel measurements for the probes: the one PNG decoder of the engine (screenshots for contrast,
// Task 4.3; motion and flash, Task 4.4; focus indicators, Task 4.1), WCAG relative luminance and
// contrast ratios, and the pure rules that turn screenshots into contrast results (text 1.4.3,
// control boundaries, icons and focus indicators 1.4.11). Engine core: no Node-only imports; PNG data
// is inflated with the web-standard DecompressionStream (Node 18+, Workers, browsers).

/** sRGB colour, 0–255 per channel. */
export type Rgb = readonly [number, number, number];
/** sRGB colour with alpha: 0–255 per channel, alpha 0–1. */
export type Rgba = readonly [number, number, number, number];

/** A decoded image: RGBA, 8 bits per channel, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** [x, y, width, height] in image pixels. */
export type PxBox = readonly [x: number, y: number, w: number, h: number];

// ---------------------------------------------------------------------------------------------
// PNG decoding (8-bit grey, grey+alpha, RGB, RGBA and palette; not interlaced). Screenshots from
// Chromium are 8-bit RGB. The flash probe decodes up to 30 full-viewport screenshots per second, so
// rows are unfiltered with one loop per filter type, and RGBA images are returned without a copy.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Samples per pixel by PNG colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reverses one row's filter: `raw[src…]` (the filtered bytes, after the filter-type byte) into
 * `pix[row…]`, with `up` the start of the previous unfiltered row (-1 for the first row).
 */
function unfilterRow(filter: number, raw: Uint8Array, src: number, pix: Uint8Array, row: number, up: number, stride: number, bpp: number): void {
  switch (filter) {
    case 0:
      pix.set(raw.subarray(src, src + stride), row);
      return;
    case 1: // Sub
      for (let x = 0; x < bpp && x < stride; x++) pix[row + x] = raw[src + x]!;
      for (let x = bpp; x < stride; x++) pix[row + x] = (raw[src + x]! + pix[row + x - bpp]!) & 255;
      return;
    case 2: // Up
      if (up < 0) pix.set(raw.subarray(src, src + stride), row);
      else for (let x = 0; x < stride; x++) pix[row + x] = (raw[src + x]! + pix[up + x]!) & 255;
      return;
    case 3: // Average
      if (up < 0) {
        for (let x = 0; x < bpp && x < stride; x++) pix[row + x] = raw[src + x]!;
        for (let x = bpp; x < stride; x++) pix[row + x] = (raw[src + x]! + (pix[row + x - bpp]! >> 1)) & 255;
      } else {
        for (let x = 0; x < bpp && x < stride; x++) pix[row + x] = (raw[src + x]! + (pix[up + x]! >> 1)) & 255;
        for (let x = bpp; x < stride; x++) pix[row + x] = (raw[src + x]! + ((pix[row + x - bpp]! + pix[up + x]!) >> 1)) & 255;
      }
      return;
    case 4: // Paeth
      if (up < 0) {
        // With no row above, Paeth predicts the left neighbour (Sub).
        for (let x = 0; x < bpp && x < stride; x++) pix[row + x] = raw[src + x]!;
        for (let x = bpp; x < stride; x++) pix[row + x] = (raw[src + x]! + pix[row + x - bpp]!) & 255;
      } else {
        for (let x = 0; x < bpp && x < stride; x++) pix[row + x] = (raw[src + x]! + pix[up + x]!) & 255;
        for (let x = bpp; x < stride; x++) {
          const a = pix[row + x - bpp]!;
          const b = pix[up + x]!;
          const c = pix[up + x - bpp]!;
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - c - c);
          pix[row + x] = (raw[src + x]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
        }
      }
      return;
    default:
      throw new Error('damaged PNG image');
  }
}

/** Decodes a PNG into RGBA. Throws on anything it cannot read (16-bit, interlaced, damaged). */
export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let alphas: Uint8Array | undefined;
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const len = view.getUint32(at);
    const name = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (body.length !== len) throw new Error('damaged PNG image');
    if (name === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') alphas = body;
    else if (name === 'IDAT') parts.push(body);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  const channels = CHANNELS[type];
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height) throw new Error(`unsupported PNG image (type ${type}, ${depth}-bit${interlace ? ', interlaced' : ''})`);
  if (type === 3 && !palette) throw new Error('damaged PNG image');
  let joined: Uint8Array;
  if (parts.length === 1) joined = parts[0]!;
  else {
    joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
  }
  const raw = await inflate(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('damaged PNG image');
  const pix = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1);
    unfilterRow(raw[src]!, raw, src + 1, pix, y * stride, y > 0 ? (y - 1) * stride : -1, stride, channels);
  }
  if (type === 6) return { width, height, data: pix };
  const n = width * height;
  const data = new Uint8Array(n * 4);
  if (type === 2) {
    for (let i = 0, j = 0, o = 0; i < n; i++, j += 3, o += 4) {
      data[o] = pix[j]!;
      data[o + 1] = pix[j + 1]!;
      data[o + 2] = pix[j + 2]!;
      data[o + 3] = 255;
    }
  } else if (type === 3) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const k = pix[i]!;
      data[o] = palette![k * 3] ?? 0;
      data[o + 1] = palette![k * 3 + 1] ?? 0;
      data[o + 2] = palette![k * 3 + 2] ?? 0;
      data[o + 3] = alphas?.[k] ?? 255;
    }
  } else {
    for (let i = 0, j = 0, o = 0; i < n; i++, j += channels, o += 4) {
      const g = pix[j]!;
      data[o] = g;
      data[o + 1] = g;
      data[o + 2] = g;
      data[o + 3] = type === 4 ? pix[j + 1]! : 255;
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------------------------
// WCAG relative luminance and contrast ratio (sRGB, WCAG 2.2 definition).

/** sRGB 8-bit value to linear light (the WCAG relative luminance formula, with the 0.04045 knee). */
export const LINEAR: Float64Array = Float64Array.from({ length: 256 }, (_, v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

/** WCAG relative luminance of an sRGB colour (channels 0–255, rounded to whole values). */
export function relativeLuminance(c: Rgb | Rgba): number {
  const ch = (v: number) => LINEAR[Math.max(0, Math.min(255, Math.round(v)))]!;
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

/** WCAG contrast ratio (1–21) between two opaque colours. */
export function contrastRatio(a: Rgb | Rgba, b: Rgb | Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A colour with alpha painted over an opaque one. */
export function composite(fg: Rgba, bg: Rgb): Rgb {
  const a = Math.max(0, Math.min(1, fg[3]));
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

/** Ratio for display: rounded down to one decimal, so a failing 4.49 never reads as 4.5. */
export function ratioText(r: number): string {
  return `${(Math.floor(r * 10) / 10).toFixed(1)}:1`;
}

export function hex(c: Rgb | Rgba): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG large text: at least 18 pt (24 CSS px), or 14 pt (18.67 CSS px) and bold (700 or more). */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= (14 * 4) / 3 - 0.01 && fontWeight >= 700);
}

/** WCAG 1.4.3 minimum: 4.5:1, or 3:1 for large text. */
export const textThreshold = (large: boolean): number => (large ? 3 : 4.5);
/** WCAG 1.4.11 minimum for user interface components and graphics. */
export const NON_TEXT_THRESHOLD = 3;

// ---------------------------------------------------------------------------------------------
// Helpers over images.

export const px = (img: RgbaImage, x: number, y: number): Rgb => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
};
const maxDiff = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Value at fraction q (0–1) of an ascending-sorted list. */
const quantile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
const medianColour = (list: readonly Rgb[]): Rgb => {
  const ch = (k: 0 | 1 | 2) => quantile(list.map((c) => c[k]).sort((a, b) => a - b), 0.5);
  return [ch(0), ch(1), ch(2)];
};

/** Pixel positions inside the boxes (clamped to the image), each once. */
export function boxPixels(img: { width: number; height: number }, boxes: readonly PxBox[], pad = 0): number[] {
  const seen = new Set<number>();
  for (const [bx, by, bw, bh] of boxes) {
    const x0 = Math.max(0, Math.floor(bx - pad));
    const y0 = Math.max(0, Math.floor(by - pad));
    const x1 = Math.min(img.width, Math.ceil(bx + bw + pad));
    const y1 = Math.min(img.height, Math.ceil(by + bh + pad));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) seen.add(y * img.width + x);
  }
  return [...seen];
}

/** Pixels (of `at`) that differ between two screenshots of the same area by more than `tolerance`. */
export function changedPixels(a: RgbaImage, b: RgbaImage, at: readonly number[], tolerance = 2): number {
  let n = 0;
  for (const p of at) {
    const x = p % a.width;
    const y = (p - x) / a.width;
    if (maxDiff(px(a, x, y), px(b, x, y)) > tolerance) n++;
  }
  return n;
}

export interface PixelDelta {
  /** Pixels where a colour channel differs by `threshold` or more. */
  changed: number;
  total: number;
  /** Largest channel difference seen. */
  max: number;
}

/**
 * Compares two images of the same area, pixel by pixel. Images of different sizes count as entirely
 * changed (the layout moved). Alpha is ignored (screenshots are opaque).
 */
export function pixelDelta(a: RgbaImage, b: RgbaImage, threshold: number): PixelDelta {
  const total = a.width * a.height;
  if (a.width !== b.width || a.height !== b.height) return { changed: Math.max(total, b.width * b.height), total, max: 255 };
  let changed = 0;
  let max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i]! - b.data[i]!), Math.abs(a.data[i + 1]! - b.data[i + 1]!), Math.abs(a.data[i + 2]! - b.data[i + 2]!));
    if (d > max) max = d;
    if (d >= threshold) changed++;
  }
  return { changed, total, max };
}

/** The area changed between two screenshots of a static state: a video, an animation or loading content. */
export function isMoving(a: RgbaImage, b: RgbaImage, at: readonly number[]): boolean {
  if (a.width !== b.width || a.height !== b.height) return true;
  return changedPixels(a, b, at) > Math.max(3, 0.005 * at.length);
}

// ---------------------------------------------------------------------------------------------
// 1.4.3: text contrast from a screenshot with the text shown and one with it hidden.

/** What the probe knows about one piece of text, from the page. */
export interface TextFacts {
  /** The text's colour (computed `color`, or `-webkit-text-fill-color` when that differs), alpha 0–1. */
  fg: Rgba;
  /** Product of the opacity of the element and its ancestors. */
  opacity: number;
  large: boolean;
  /** It or an ancestor has a text shadow. */
  shadow: boolean;
  /**
   * Its colour (as read, and unchanged since) is fully transparent: when the shown text then changes
   * no pixel, nothing of it can be seen.
   */
  transparent?: boolean;
}

export type TextUnmeasured =
  /** The area changed between two screenshots of the same state (video, animation, loading content). */
  | 'moving'
  /**
   * Nothing of the text shows: drawn in black and in white it changes no pixel (covered by other
   * content, clipped, at no size or opacity), or it is transparent and showing it changes no pixel.
   * Nobody can see it, so it is not measured and not counted.
   */
  | 'covered'
  /** Some letter pixels show, but fewer than `MIN_TEXT_PIXELS` (or too few fully covered ones) to measure. */
  | 'small'
  /** The text's colour could not be confirmed in the pixels and the measured ratio is too close to call. */
  | 'close'
  /** The text has a shadow in a contrasting colour, which may outline it; how much was not measured. */
  | 'shadow';

export type TextVerdict =
  | {
    kind: 'ok' | 'failed';
    /** The ratio at least four fifths of the text's pixels reach (the 20th percentile, low end). */
    ratio: number;
    threshold: number;
    /** The text colour and the background at the measured (20th percentile) pixel. */
    fg: Rgb;
    bg: Rgb;
    /** The most common background behind the text (the median of the pixels behind it). */
    dominant: Rgb;
    /** The text's colour from its style matched its pixels (otherwise it was read from the pixels). */
    confirmed: boolean;
    /** Text pixels measured. */
    pixels: number;
  }
  | { kind: 'unmeasured'; reason: TextUnmeasured };

/**
 * A text shadow may outline the letters: enough shadow pixels around them (a tenth of the letter
 * pixels), and the strongest quarter of them in contrast with the text colour.
 */
function outlined(fg: Rgb, halo: readonly Rgb[], letters: number, threshold: number): boolean {
  if (halo.length < Math.max(MIN_TEXT_PIXELS, 0.1 * letters)) return false;
  return quantile(halo.map((c) => contrastRatio(fg, c)).sort((u, v) => u - v), 0.75) >= threshold;
}

/** Minimum text pixels for a measurement. */
export const MIN_TEXT_PIXELS = 12;
/** How far below the threshold a measurement from pixels alone (colour not confirmed) must be to count as failed. */
export const PIXEL_ONLY_MARGIN = 0.85;

/** Screenshots of one area in the states the text measurement needs. */
export interface TextShots {
  /** As the page shows it. */
  shown: RgbaImage;
  /** The text made transparent: only what is behind it shows. */
  hidden: RgbaImage;
  /** The text drawn in black and in white: they differ exactly where the letters are. */
  black: RgbaImage;
  white: RgbaImage;
  /** As shown, again (movement check). */
  again: RgbaImage;
}

/**
 * Decides the contrast of one piece of text from screenshots of the same area (`TextShots`).
 * `boxes` are the text's line boxes in image pixels.
 *
 * - Where the letters are, and how much of each pixel they cover, comes from the text drawn in black
 *   and in white: so text that is invisible against its background is still found. The pixel behind
 *   each letter comes from the screenshot with the text hidden, so gradients, background images and
 *   overlapping boxes are measured where each letter actually sits.
 * - When the text's style colour (with its alpha and opacity, blended over each background pixel)
 *   matches the shown pixels, the ratio uses that colour at every letter pixel: anti-aliased edges do
 *   not lower it ("confirmed"). Otherwise (filters, blend modes, gradient-filled text) the ratio comes
 *   from the most covered pixels as shown, and counts as failed only below 85% of the threshold.
 * - The result is the ratio four fifths of the letter pixels reach or exceed (20th percentile), so a
 *   gradient fails when a fifth of the text sits on a part too close to its colour.
 */
export function textContrast(shots: TextShots, boxes: readonly PxBox[], facts: TextFacts): TextVerdict {
  const { shown, hidden, black, white, again } = shots;
  const area = boxPixels(shown, boxes, 2);
  if (isMoving(shown, again, area)) return { kind: 'unmeasured', reason: 'moving' };
  const threshold = textThreshold(facts.large);
  const alpha = Math.max(0, Math.min(1, facts.fg[3]));
  const opacity = Math.max(0, Math.min(1, facts.opacity));
  // Letter pixels and their coverage d (0–1): how far the white drawing is from the black one. Group
  // opacity applies to those drawings too, so it is part of d. Halo: pixels around the letters that
  // the shown text changes although no letter covers them (a text shadow).
  const mask: { a: Rgb; h: Rgb; d: number }[] = [];
  const halo: Rgb[] = [];
  let drawn = 0;
  for (const i of boxPixels(shown, boxes, 2)) {
    const x = i % shown.width;
    const y = (i - x) / shown.width;
    const w = px(white, x, y);
    const k = px(black, x, y);
    const d = (w[0] - k[0] + w[1] - k[1] + w[2] - k[2]) / 765;
    const a = px(shown, x, y);
    const h = px(hidden, x, y);
    if (d >= 0.05) drawn++;
    if (d >= 0.15) mask.push({ a, h, d });
    else if (d < 0.05 && maxDiff(a, h) >= 16) halo.push(a);
  }
  if (mask.length < MIN_TEXT_PIXELS) return { kind: 'unmeasured', reason: drawn <= 2 ? 'covered' : 'small' };
  // Transparent text that shows nothing (no shadow, no stroke): nobody sees it.
  if (facts.transparent && mask.filter((m) => maxDiff(m.a, m.h) >= 8).length <= Math.max(2, 0.02 * mask.length)) return { kind: 'unmeasured', reason: 'covered' };

  // Confirmed: the style colour comes back from the most covered letter pixels when their coverage is
  // divided out (A = H + d·(F − H), so F = H + (A − H) / d; group opacity is part of d). A filter, a
  // blend mode or a gradient fill does not give it back.
  const F = (h: Rgb) => composite([facts.fg[0], facts.fg[1], facts.fg[2], alpha], h);
  const dmax = quantile(mask.map((m) => m.d).sort((u, v) => u - v), 0.98);
  const errors = mask.filter((m) => m.d >= 0.7 * dmax).map((m) => {
    const f = F(m.h);
    const est: Rgb = [m.h[0] + (m.a[0] - m.h[0]) / m.d, m.h[1] + (m.a[1] - m.h[1]) / m.d, m.h[2] + (m.a[2] - m.h[2]) / m.d];
    return dist(est, f);
  }).sort((u, v) => u - v);
  const confirmed = alpha > 0 && errors.length >= MIN_TEXT_PIXELS / 2 && quantile(errors, 0.5) <= 20 && quantile(errors, 0.8) <= 48;
  if (confirmed) {
    // The colour a fully covered letter pixel shows: the style colour with its alpha and opacity over the background.
    const P = (h: Rgb) => composite([facts.fg[0], facts.fg[1], facts.fg[2], alpha * opacity], h);
    const scored = mask.map((m) => ({ r: contrastRatio(P(m.h), m.h), m })).sort((u, v) => u.r - v.r);
    const at = scored[Math.min(scored.length - 1, Math.floor(0.2 * scored.length))]!;
    const verdict = { ratio: at.r, threshold, fg: P(at.m.h), bg: at.m.h, dominant: medianColour(mask.map((m) => m.h)), confirmed, pixels: mask.length };
    if (verdict.ratio >= threshold) return { kind: 'ok', ...verdict };
    if (facts.shadow && outlined(verdict.fg, halo, mask.length, threshold)) {
      return { kind: 'unmeasured', reason: 'shadow' };
    }
    return { kind: 'failed', ...verdict };
  }

  // Not confirmed: the most covered pixels, as shown, stand for the text colour.
  const top = quantile(mask.map((m) => m.d).sort((u, v) => u - v), 0.95);
  const core = mask.filter((m) => m.d >= 0.7 * top);
  if (core.length < MIN_TEXT_PIXELS / 2) return { kind: 'unmeasured', reason: 'small' };
  const scored = core.map((m) => ({ r: contrastRatio(m.a, m.h), m })).sort((u, v) => u.r - v.r);
  const at = scored[Math.min(scored.length - 1, Math.floor(0.2 * scored.length))]!;
  const verdict = { ratio: at.r, threshold, fg: at.m.a, bg: at.m.h, dominant: medianColour(core.map((m) => m.h)), confirmed: false, pixels: core.length };
  if (verdict.ratio >= threshold) return { kind: 'ok', ...verdict };
  if (facts.shadow && outlined(verdict.fg, halo, mask.length, threshold)) return { kind: 'unmeasured', reason: 'shadow' };
  if (verdict.ratio < threshold * PIXEL_ONLY_MARGIN) return { kind: 'failed', ...verdict };
  return { kind: 'unmeasured', reason: 'close' };
}

// ---------------------------------------------------------------------------------------------
// 1.4.11: boundaries of form fields, and icons.

export interface BoundaryVerdict {
  /** At least one side had a uniform background around it to compare with. */
  measurable: boolean;
  /** Best contrast of any boundary line (border, shadow ring) or of the fill, against the colours next to it. */
  ratio: number;
  /** Something marks the field at all (best ratio at least `VISIBLE_EDGE`). Without it there is no boundary to judge. */
  marked: boolean;
  outside: Rgb;
  fill: Rgb;
  /** The boundary line with the best contrast (or the fill when that is best). */
  edge: Rgb;
  /** What gives the best contrast: a line across the edge, or the fill against the outside. */
  by: 'edge' | 'fill';
}

/** Below this ratio a line or fill is not seen as marking the field at all. */
export const VISIBLE_EDGE = 1.1;

/**
 * The visual boundary of a form field from a screenshot: along the middle three fifths of each side,
 * the colours across the edge from 6 px outside to 6 px inside (medians over the side, so text and
 * corners do not count). The background outside must be uniform along a side for the side to count.
 * The best of: any line across the edge (border, inset or outer shadow) against the outside or the
 * fill, and the fill against the outside.
 */
export function boundaryContrast(img: RgbaImage, box: PxBox, scale = 1): BoundaryVerdict {
  const [bx, by, bw, bh] = box;
  const depth = Math.max(2, Math.round(6 * scale));
  const inner = Math.min(depth, Math.floor(Math.min(bw, bh) / 2) - 1);
  let best = 1;
  let bestEdge: Rgb = [0, 0, 0];
  let measurable = false;
  let source: 'edge' | 'fill' = 'edge';
  let outside: Rgb = [255, 255, 255];
  let fill: Rgb = [255, 255, 255];
  const sides = [
    { along: bw, at: (t: number, k: number) => [bx + t, by - 1 - k] as const, into: (t: number, k: number) => [bx + t, by + k] as const },
    { along: bw, at: (t: number, k: number) => [bx + t, by + bh + k] as const, into: (t: number, k: number) => [bx + t, by + bh - 1 - k] as const },
    { along: bh, at: (t: number, k: number) => [bx - 1 - k, by + t] as const, into: (t: number, k: number) => [bx + k, by + t] as const },
    { along: bh, at: (t: number, k: number) => [bx + bw + k, by + t] as const, into: (t: number, k: number) => [bx + bw - 1 - k, by + t] as const },
  ];
  const inImg = (x: number, y: number) => x >= 0 && y >= 0 && x < img.width && y < img.height;
  for (const s of sides) {
    const from = Math.floor(s.along * 0.2);
    const to = Math.ceil(s.along * 0.8);
    const step = Math.max(1, Math.floor((to - from) / 24));
    const ts: number[] = [];
    for (let t = from; t < to; t += step) ts.push(Math.round(t));
    if (ts.length < 3) continue;
    // Columns across the edge: k outside (k = depth-1 … 0), then k inside (0 … inner-1).
    const sample = (k: number, inside: boolean): Rgb[] | null => {
      const out: Rgb[] = [];
      for (const t of ts) {
        const [x, y] = inside ? s.into(t, k) : s.at(t, k);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (!inImg(xi, yi)) return null;
        out.push(px(img, xi, yi));
      }
      return out;
    };
    const far = sample(depth - 1, false);
    if (!far) continue;
    const out = medianColour(far);
    // The outside must be one colour along the side (not an image, not a neighbouring control).
    if (far.filter((c) => maxDiff(c, out) <= 10).length < 0.8 * far.length) continue;
    const fillCol = inner >= 1 ? sample(inner - 1, true) : null;
    const fl = fillCol ? medianColour(fillCol) : out;
    measurable = true;
    const consider = (c: Rgb) => {
      const r = Math.max(contrastRatio(c, out), contrastRatio(c, fl));
      if (r > best) {
        best = r;
        bestEdge = c;
        outside = out;
        fill = fl;
        source = 'edge';
      }
    };
    for (let k = depth - 2; k >= 0; k--) {
      const col = sample(k, false);
      if (col) consider(medianColour(col));
    }
    for (let k = 0; k < inner - 1; k++) {
      const col = sample(k, true);
      if (col) consider(medianColour(col));
    }
    const fr = contrastRatio(fl, out);
    if (fr >= best) {
      best = fr;
      bestEdge = fl;
      outside = out;
      fill = fl;
      source = 'fill';
    }
  }
  return { measurable, ratio: best, marked: best >= VISIBLE_EDGE, outside, fill, edge: bestEdge, by: source };
}

export interface ChangeVerdict {
  /** Pixels that differ between the two screenshots. */
  pixels: number;
  /** The contrast nearly all of the strongest changed pixels stay under (98th percentile). */
  ratio: number;
  /** The changed pixels' colour at that strength, and the colour they replaced. */
  colour: Rgb;
  behind: Rgb;
}

/**
 * Contrast of what changed between two screenshots of the same area, against what was there before:
 * `before` without the graphic (or the focus indicator), `after` with it. Each changed pixel is
 * compared with the pixel it replaced. The result is the 98th percentile: nearly the strongest
 * pixels, so anti-aliased edges and thin strokes do not lower it, and a graphic counts as failed only
 * when even its most solid pixels stay under the threshold. Used for icons (1.4.11) and suited to
 * focus indicators (a screenshot without focus against one with focus).
 */
export function changeContrast(before: RgbaImage, after: RgbaImage, boxes: readonly PxBox[]): ChangeVerdict {
  const changed: { r: number; c: Rgb; b: Rgb }[] = [];
  for (const i of boxPixels(after, boxes)) {
    const x = i % after.width;
    const y = (i - x) / after.width;
    const c = px(after, x, y);
    const b = px(before, x, y);
    if (maxDiff(c, b) >= 8) changed.push({ r: contrastRatio(c, b), c, b });
  }
  if (!changed.length) return { pixels: 0, ratio: 1, colour: [0, 0, 0], behind: [0, 0, 0] };
  changed.sort((u, v) => u.r - v.r);
  const at = changed[Math.min(changed.length - 1, Math.floor(0.98 * changed.length))]!;
  return { pixels: changed.length, ratio: at.r, colour: at.c, behind: at.b };
}

/** Minimum changed pixels for an icon to count as measured. */
export const MIN_ICON_PIXELS = 12;
