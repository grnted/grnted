// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 flash analysis on a sequence of per-cell colour grids (src/probes/pixels.ts). Pure and
// deterministic. Engine core: no Node-only imports.
//
// Definitions (WCAG 2.2, "general flash and red flash thresholds"):
// - General flash: a pair of opposing changes in relative luminance of 10% or more of the maximum
//   (1.0) where the darker state is below 0.80.
// - Red flash: a pair of opposing transitions to or from a saturated red, R/(R+G+B) >= 0.8, where
//   the two states are more than 0.2 apart in the CIE 1976 u'v' chromaticity diagram.
// - Fails: more than three flashes in any one-second period, over a combined area of more than 25%
//   of any 10-degree visual field. WCAG's note approximates the field as 341x256 px on a 1024x768
//   screen; it is scaled here to the viewport (one third of its width by one third of its height).
//
// Method: each cell's luminance series is reduced to its transitions (a zigzag with a 0.1
// hysteresis, so slow fades count once); a cell flashes in a one-second window when it has more than
// six transitions (more than three flashes) there; the window fails when the flashing cells inside
// any field-sized rectangle cover more than 25% of it. Red transitions are counted the same way on
// the cell's chromaticity. R, G and B are linear (sRGB-decoded) values, as for luminance.
import type { CellGrid } from './motionPixels.js';

export const FLASH = {
  delta: 0.1,
  darkerBelow: 0.8,
  redRatio: 0.8,
  redDistance: 0.2,
  /** More transitions than this (three flashes) in one second fail. */
  maxTransitions: 6,
  window: 1000,
  /** The 10° visual field as a share of the viewport (341×256 px at 1024×768). */
  field: { w: 341 / 1024, h: 256 / 768 },
  areaShare: 0.25,
  /** Screenshots per second needed to see flashing at 4 per second (Nyquist). */
  minFps: 8,
} as const;

/** u'v' of D65 white, used for cells too dark to have a meaningful chromaticity. */
const WHITE_UV: readonly [number, number] = [0.1978, 0.4683];

export interface FlashFrame {
  /** Milliseconds (any origin; only differences matter). */
  t: number;
  grid: CellGrid;
}

export interface FlashFinding {
  kind: 'general' | 'red';
  /** Most transitions a cell had in the worst one-second window (two transitions make one flash). */
  transitions: number;
  /** Start of that window, ms after the first frame. */
  at: number;
  /** Flashing area inside the worst 10° field (CSS px²) and that field (CSS px, viewport coordinates). */
  area: number;
  /** That area as a share of the 10° field (more than `FLASH.areaShare` fails). */
  share: number;
  box: { x: number; y: number; w: number; h: number };
  /** The flashing cells inside that field: their bounding box (CSS px, viewport coordinates). */
  spot: { x: number; y: number; w: number; h: number };
  /** Centres of up to `SPOT_POINTS` of those cells, spread over them (CSS px, viewport coordinates). */
  points: { x: number; y: number }[];
}

/** Most flashing-cell centres a finding keeps (to name the element under the flash). */
export const SPOT_POINTS = 25;

/** Bounding box and spread centres of the flagged cells inside a w×h field at (fx, fy), in CSS px. */
function spotOf(flags: Uint8Array, cols: number, fx: number, fy: number, w: number, h: number, cssCell: number): Pick<FlashFinding, 'spot' | 'points'> {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const cells: number[] = [];
  for (let y = fy; y < fy + h; y++) {
    for (let x = fx; x < fx + w; x++) {
      if (!flags[y * cols + x]) continue;
      cells.push(y * cols + x);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!cells.length) return { spot: { x: fx * cssCell, y: fy * cssCell, w: w * cssCell, h: h * cssCell }, points: [] };
  const step = cells.length / Math.min(SPOT_POINTS, cells.length);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < cells.length && points.length < SPOT_POINTS; i += step) {
    const c = cells[Math.floor(i)]!;
    points.push({ x: ((c % cols) + 0.5) * cssCell, y: (Math.floor(c / cols) + 0.5) * cssCell });
  }
  return { spot: { x: x0 * cssCell, y: y0 * cssCell, w: (x1 - x0 + 1) * cssCell, h: (y1 - y0 + 1) * cssCell }, points };
}

export interface FlashAnalysis {
  frames: number;
  durationMs: number;
  fps: number;
  /** The 10° field in CSS px. */
  field: { w: number; h: number };
  /** Share of consecutive frame pairs in which more than 25% of some field changed by 10% luminance or more. */
  changingShare: number;
  /** Most transitions any cell had in one second. */
  maxCellTransitions: number;
  general: FlashFinding | null;
  red: FlashFinding | null;
}

/**
 * Times (ms) of a series' luminance transitions that count for a general flash. A zigzag with a
 * `delta` hysteresis: each monotonic run of at least `delta` between turning points is one
 * transition; it counts when its darker end is below `darkerBelow`. A transition is timed at the
 * first frame that shows it (the run is `delta` away from where it started), so it really happened
 * after the frame before that one: `earliest`, when given, gets that frame's time for each transition
 * (the frame timing tolerance of the one-second window, `analyseFlashes`).
 */
export function luminanceTransitions(values: ArrayLike<number>, times: ArrayLike<number>, delta: number = FLASH.delta, darkerBelow: number = FLASH.darkerBelow, earliest?: number[]): number[] {
  const out: number[] = [];
  const n = values.length;
  if (!n) return out;
  let dir = 0;
  let lo = values[0]!, hi = values[0]!, loT = times[0]!, hiT = times[0]!;
  let pivot = 0, ext = 0, startT = 0, startPrev = 0;
  const push = (from: number, to: number) => {
    if (Math.min(from, to) >= darkerBelow) return;
    out.push(startT);
    earliest?.push(startPrev);
  };
  for (let i = 1; i < n; i++) {
    const v = values[i]!;
    const t = times[i]!;
    if (dir === 0) {
      if (v < lo) { lo = v; loT = t; }
      if (v > hi) { hi = v; hiT = t; }
      if (v - lo >= delta && loT < t) { dir = 1; pivot = lo; ext = v; startT = t; startPrev = times[i - 1]!; } else if (hi - v >= delta && hiT < t) { dir = -1; pivot = hi; ext = v; startT = t; startPrev = times[i - 1]!; }
      continue;
    }
    if (dir === 1) {
      if (v >= ext) ext = v;
      else if (ext - v >= delta) { push(pivot, ext); pivot = ext; dir = -1; ext = v; startT = t; startPrev = times[i - 1]!; }
    } else if (v <= ext) ext = v;
    else if (v - ext >= delta) { push(pivot, ext); pivot = ext; dir = 1; ext = v; startT = t; startPrev = times[i - 1]!; }
  }
  if (dir !== 0 && Math.abs(ext - pivot) >= delta) push(pivot, ext);
  return out;
}

/** CIE 1976 u'v' of a linear sRGB colour (D65). */
export function chromaticity(r: number, g: number, b: number): [number, number] {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const d = X + 15 * Y + 3 * Z;
  if (Y < 0.001 || d <= 0) return [WHITE_UV[0], WHITE_UV[1]];
  return [(4 * X) / d, (9 * Y) / d];
}

/** Saturated red: R/(R+G+B) of the linear values at least 0.8 (and not black). */
export function isSaturatedRed(r: number, g: number, b: number): boolean {
  const sum = r + g + b;
  return sum > 0.003 && r / sum >= FLASH.redRatio;
}

/**
 * Times (ms) of a series' red transitions: changes between a saturated red and another colour that
 * move more than 0.2 in u'v' from the last counted state, timed at the first frame that shows them
 * (`earliest` gets the frame before, as for `luminanceTransitions`).
 */
export function redTransitions(rs: ArrayLike<number>, gs: ArrayLike<number>, bs: ArrayLike<number>, times: ArrayLike<number>, earliest?: number[]): number[] {
  const out: number[] = [];
  const n = rs.length;
  if (!n) return out;
  let refRed = isSaturatedRed(rs[0]!, gs[0]!, bs[0]!);
  let refUv = chromaticity(rs[0]!, gs[0]!, bs[0]!);
  for (let i = 1; i < n; i++) {
    const red = isSaturatedRed(rs[i]!, gs[i]!, bs[i]!);
    const uv = chromaticity(rs[i]!, gs[i]!, bs[i]!);
    if (red !== refRed && Math.hypot(uv[0] - refUv[0], uv[1] - refUv[1]) > FLASH.redDistance) {
      out.push(times[i]!);
      earliest?.push(times[i - 1]!);
      refRed = red;
      refUv = uv;
    } else if (red === refRed && red) {
      // Stay anchored on the reddest state seen while red.
      refUv = uv;
    }
  }
  return out;
}

/** Largest weighted sum in any fw×fh placement, and where (cell coordinates). */
function bestField(weights: ArrayLike<number>, cols: number, rows: number, fw: number, fh: number): { count: number; x: number; y: number } {
  const w = Math.min(fw, cols);
  const h = Math.min(fh, rows);
  const sum = new Float64Array((cols + 1) * (rows + 1));
  for (let y = 0; y < rows; y++) {
    let row = 0;
    for (let x = 0; x < cols; x++) {
      row += weights[y * cols + x]!;
      sum[(y + 1) * (cols + 1) + x + 1] = sum[y * (cols + 1) + x + 1]! + row;
    }
  }
  let best = { count: 0, x: 0, y: 0 };
  for (let y = 0; y + h <= rows; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const c = sum[(y + h) * (cols + 1) + x + w]! - sum[y * (cols + 1) + x + w]! - sum[(y + h) * (cols + 1) + x]! + sum[y * (cols + 1) + x]!;
      if (c > best.count + 1e-9) best = { count: c, x, y };
    }
  }
  return best;
}

/**
 * Whether a cell's transitions hold more than `maxTransitions` that certainly fall within one
 * second: from the frame before the first (it happened after that frame) to the last one's frame.
 */
function flashesSomewhere(times: readonly number[], earliest: readonly number[]): boolean {
  const k = FLASH.maxTransitions;
  for (let j = 0; j + k < times.length; j++) if (times[j + k]! - earliest[j]! < FLASH.window) return true;
  return false;
}

/**
 * Analyses frames of the same grid. `cssCell` is a cell's size in CSS px and `viewport` the
 * viewport in CSS px (the field is scaled to it).
 *
 * A cell flashes in a one-second window when more than `maxTransitions` of its transitions certainly
 * happened inside it: each one after the frame before the one that shows it, so frame timing never
 * fits exactly three flashes a second into less than a second (seven changes of 3 Hz span a second
 * plus a frame). A cell flashing in the window counts whole; the limit is 25% of the field's real
 * size (the field is placed in whole cells no larger than it). Used for pictures analysed in cells
 * (animated images, `flashMotion.ts`); the screen capture is analysed pixel by pixel (`flashPixels.ts`).
 */
export function analyseFlashes(frames: readonly FlashFrame[], cssCell: number, viewport: { width: number; height: number }): FlashAnalysis {
  const n = frames.length;
  const fieldPx = { w: Math.round(FLASH.field.w * viewport.width), h: Math.round(FLASH.field.h * viewport.height) };
  const empty: FlashAnalysis = { frames: n, durationMs: 0, fps: 0, field: fieldPx, changingShare: 0, maxCellTransitions: 0, general: null, red: null };
  if (n < 2) return empty;
  const { cols, rows } = frames[0]!.grid;
  if (frames.some((f) => f.grid.cols !== cols || f.grid.rows !== rows)) throw new Error('frames of different sizes');
  const t0 = frames[0]!.t;
  const times = frames.map((f) => f.t - t0);
  const durationMs = times[n - 1]!;
  const fps = durationMs > 0 ? ((n - 1) * 1000) / durationMs : 0;
  // The field placed in whole cells, never larger than the field itself.
  const fw = Math.max(1, Math.floor(fieldPx.w / cssCell + 1e-6));
  const fh = Math.max(1, Math.floor(fieldPx.h / cssCell + 1e-6));
  const pw = Math.min(fw, cols), ph = Math.min(fh, rows);
  const limit = (FLASH.areaShare * fieldPx.w * fieldPx.h) / (cssCell * cssCell);
  const fieldArea = Math.max(1, fieldPx.w * fieldPx.h);
  const cells = cols * rows;

  // Large changes between consecutive frames (for the frame-rate caveat).
  let changing = 0;
  const flags = new Uint8Array(cells);
  for (let i = 1; i < n; i++) {
    const a = frames[i - 1]!.grid.lum;
    const b = frames[i]!.grid.lum;
    for (let c = 0; c < cells; c++) flags[c] = Math.abs(a[c]! - b[c]!) >= FLASH.delta ? 1 : 0;
    if (bestField(flags, cols, rows, pw, ph).count > limit) changing++;
  }

  const general: number[][] = [];
  const generalE: number[][] = [];
  const red: number[][] = [];
  const redE: number[][] = [];
  const lum = new Float32Array(n);
  const rr = new Float32Array(n);
  const gg = new Float32Array(n);
  const bb = new Float32Array(n);
  for (let c = 0; c < cells; c++) {
    for (let i = 0; i < n; i++) {
      const g = frames[i]!.grid;
      lum[i] = g.lum[c]!;
      rr[i] = g.r[c]!;
      gg[i] = g.g[c]!;
      bb[i] = g.b[c]!;
    }
    const ge: number[] = [];
    general.push(luminanceTransitions(lum, times, FLASH.delta, FLASH.darkerBelow, ge));
    generalE.push(ge);
    const re: number[] = [];
    red.push(redTransitions(rr, gg, bb, times, re));
    redE.push(re);
  }

  let maxCell = 0;
  const worst = (series: number[][], early: number[][], kind: FlashFinding['kind']): FlashFinding | null => {
    let any = false;
    for (let c = 0; c < cells && !any; c++) any = flashesSomewhere(series[c]!, early[c]!);
    if (!any && kind !== 'general') return null;
    let found: FlashFinding | null = null;
    const ptrLo = new Uint32Array(cells);
    const ptrHi = new Uint32Array(cells);
    // One-second windows starting at each frame: a transition is in one when the frame before the one
    // showing it is at or after the start and that frame is before the end.
    for (const start of times) {
      let top = 0;
      for (let c = 0; c < cells; c++) {
        const s = series[c]!;
        const e = early[c]!;
        while (ptrLo[c]! < s.length && e[ptrLo[c]!]! < start) ptrLo[c]!++;
        if (ptrHi[c]! < ptrLo[c]!) ptrHi[c] = ptrLo[c]!;
        while (ptrHi[c]! < s.length && s[ptrHi[c]!]! < start + FLASH.window) ptrHi[c]!++;
        const count = ptrHi[c]! - ptrLo[c]!;
        if (kind === 'general' && count > maxCell) maxCell = count;
        flags[c] = count > FLASH.maxTransitions ? 1 : 0;
        if (count > top && flags[c]) top = count;
      }
      if (!top) continue;
      // A cell flashing in the window counts whole.
      const best = bestField(flags, cols, rows, pw, ph);
      if (best.count > limit && (!found || best.count * cssCell * cssCell > found.area)) {
        const area = best.count * cssCell * cssCell;
        found = {
          kind, transitions: top, at: Math.round(start), area, share: area / fieldArea,
          box: { x: best.x * cssCell, y: best.y * cssCell, w: pw * cssCell, h: ph * cssCell },
          ...spotOf(flags, cols, best.x, best.y, pw, ph, cssCell),
        };
      }
    }
    return found;
  };
  const g = worst(general, generalE, 'general');
  const r = worst(red, redE, 'red');
  return { frames: n, durationMs: Math.round(durationMs), fps: Math.round(fps * 10) / 10, field: fieldPx, changingShare: changing / (n - 1), maxCellTransitions: maxCell, general: g, red: r };
}

/** The 10° field in CSS px for a viewport (one third of its width by one third of its height). */
export function flashField(viewport: { width: number; height: number }): { w: number; h: number } {
  return { w: Math.round(FLASH.field.w * viewport.width), h: Math.round(FLASH.field.h * viewport.height) };
}

/** Most of the (sorted) times that fall in any one window of `FLASH.window` ms. */
export function mostInWindow(times: readonly number[]): number {
  let best = 0;
  for (let lo = 0, hi = 0; lo < times.length; lo++) {
    while (hi < times.length && times[hi]! < times[lo]! + FLASH.window) hi++;
    best = Math.max(best, hi - lo);
  }
  return best;
}

/**
 * Share of the 10° field one solid w×h CSS px area can cover (the area clipped to the field, over the
 * field): a flash fails only above `FLASH.areaShare`.
 */
export function fieldShare(w: number, h: number, viewport: { width: number; height: number }): number {
  const f = flashField(viewport);
  if (f.w <= 0 || f.h <= 0) return 0;
  return (Math.min(Math.max(0, w), f.w) * Math.min(Math.max(0, h), f.h)) / (f.w * f.h);
}

/**
 * The grid placed at the top left of a grid at least the field's size (in cells of `cssCell` CSS px),
 * the rest a constant black: `analyseFlashes` measures the 25% against the field, so a picture smaller
 * than the field must sit inside one (an image, not the whole viewport).
 */
export function padToField(grid: CellGrid, cssCell: number, viewport: { width: number; height: number }): CellGrid {
  const f = flashField(viewport);
  const cols = Math.max(grid.cols, Math.round(f.w / cssCell));
  const rows = Math.max(grid.rows, Math.round(f.h / cssCell));
  if (cols === grid.cols && rows === grid.rows) return grid;
  const n = cols * rows;
  const out: CellGrid = { cols, rows, cell: grid.cell, lum: new Float32Array(n), r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const i = y * grid.cols + x;
      const j = y * cols + x;
      out.lum[j] = grid.lum[i]!;
      out.r[j] = grid.r[i]!;
      out.g[j] = grid.g[i]!;
      out.b[j] = grid.b[i]!;
    }
  }
  return out;
}
