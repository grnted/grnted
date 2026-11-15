// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Per-cell luminance and changed regions over decoded screenshots, for the motion and flash probes
// (Plan 4 Task 4.4). Screenshots are decoded by the engine's one PNG decoder (`decodePng` in
// pixels.ts, RGBA). Engine core: no Node-only imports.
import { LINEAR, type RgbaImage } from './pixels.js';

/** Mean linear R, G, B and relative luminance per cell of a grid laid over the image. */
export interface CellGrid {
  cols: number;
  rows: number;
  /** Cell size in image pixels (the last column and row may be smaller). */
  cell: number;
  lum: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export function cellGrid(img: RgbaImage, cell: number): CellGrid {
  const cols = Math.ceil(img.width / cell);
  const rows = Math.ceil(img.height / cell);
  const n = cols * rows;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const count = new Float32Array(n);
  const d = img.data;
  // A local reference: hot loops should not read the imported binding on every pixel.
  const lin = LINEAR;
  // Cell column of each pixel column, computed once.
  const colOf = new Uint32Array(img.width);
  for (let x = 0; x < img.width; x++) colOf[x] = Math.floor(x / cell);
  for (let y = 0; y < img.height; y++) {
    const rowBase = Math.floor(y / cell) * cols;
    let p = y * img.width * 4;
    for (let x = 0; x < img.width; x++, p += 4) {
      const i = rowBase + colOf[x]!;
      r[i]! += lin[d[p]!]!;
      g[i]! += lin[d[p + 1]!]!;
      b[i]! += lin[d[p + 2]!]!;
      count[i]!++;
    }
  }
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = count[i] || 1;
    r[i]! /= c;
    g[i]! /= c;
    b[i]! /= c;
    lum[i] = 0.2126 * r[i]! + 0.7152 * g[i]! + 0.0722 * b[i]!;
  }
  return { cols, rows, cell, lum, r, g, b };
}

/** A changed area of a screenshot, in image pixels. */
export interface ChangedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pixels whose luminance changed by more than the threshold. */
  pixels: number;
}

/**
 * Where two screenshots of the same size differ: pixels whose relative luminance changed by more
 * than `threshold`, grouped into connected cells of `cell` pixels. Regions with fewer than
 * `minPixels` changed pixels are dropped (anti-aliasing noise).
 */
export function changedRegions(a: RgbaImage, b: RgbaImage, opts: { cell?: number; threshold?: number; minPixels?: number } = {}): ChangedRegion[] {
  if (a.width !== b.width || a.height !== b.height) return [{ x: 0, y: 0, w: a.width, h: a.height, pixels: a.width * a.height }];
  const cell = opts.cell ?? 32;
  const threshold = opts.threshold ?? 0.02;
  const minPixels = opts.minPixels ?? 300;
  const cols = Math.ceil(a.width / cell);
  const rows = Math.ceil(a.height / cell);
  const counts = new Uint32Array(cols * rows);
  const lin = LINEAR;
  const lum = (d: Uint8Array, p: number) => 0.2126 * lin[d[p]!]! + 0.7152 * lin[d[p + 1]!]! + 0.0722 * lin[d[p + 2]!]!;
  for (let y = 0; y < a.height; y++) {
    const rowBase = Math.floor(y / cell) * cols;
    let p = y * a.width * 4;
    for (let x = 0; x < a.width; x++, p += 4) {
      // Screenshots are opaque: only the colour channels are compared.
      if (a.data[p] === b.data[p] && a.data[p + 1] === b.data[p + 1] && a.data[p + 2] === b.data[p + 2]) continue;
      if (Math.abs(lum(a.data, p) - lum(b.data, p)) > threshold) counts[rowBase + Math.floor(x / cell)]!++;
    }
  }
  // Connected changed cells (4-neighbour flood fill).
  const seen = new Uint8Array(cols * rows);
  const out: ChangedRegion[] = [];
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i] || seen[i]) continue;
    let minX = cols, minY = rows, maxX = 0, maxY = 0, pixels = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      const cx = j % cols;
      const cy = (j - cx) / cols;
      pixels += counts[j]!;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const k = ny * cols + nx;
        if (counts[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (pixels < minPixels) continue;
    const x = minX * cell;
    const y = minY * cell;
    out.push({ x, y, w: Math.min(a.width, (maxX + 1) * cell) - x, h: Math.min(a.height, (maxY + 1) * cell) - y, pixels });
  }
  return out.sort((p, q) => q.pixels - p.pixels);
}
