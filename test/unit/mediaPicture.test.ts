// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The picture measurement behind the media-files test (src/media/picture.ts): a frame is plain only when no
// part of it holds marks fine enough to be writing. Frames are drawn here, pixel by pixel.
import { describe, expect, it } from 'vitest';
import { frameMarks, framePlain, PICTURE_CELL, PICTURE_STEP } from '../../src/media/picture.js';

const W = 320;
const H = 180;
type Rgb = [number, number, number];
function frame(paint: (x: number, y: number) => Rgb, w = W, h = H): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      out.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}
/** Cells along a side of `size` px: one every step, and one that ends at the edge. */
const cellsAlong = (size: number): number => Math.floor((size - PICTURE_CELL) / PICTURE_STEP) + 1 + ((size - PICTURE_CELL) % PICTURE_STEP ? 1 : 0);
const GROUND: Rgb = [22, 72, 63];
const INK: Rgb = [255, 255, 255];
/** A 5 x 7 "letter" made of strokes: two uprights and a bar, drawn at (x0, y0) scaled by k. */
const letter = (x: number, y: number, x0: number, y0: number, k: number): boolean => {
  const u = Math.floor((x - x0) / k);
  const v = Math.floor((y - y0) / k);
  return u >= 0 && u < 5 && v >= 0 && v < 7 && (u === 0 || u === 4 || v === 3);
};
const word = (x: number, y: number, x0: number, y0: number, k: number, letters: number): boolean => {
  for (let i = 0; i < letters; i++) if (letter(x, y, x0 + i * 7 * k, y0, k)) return true;
  return false;
};

describe('a frame is plain only when it shows nothing fine enough to be writing', () => {
  it('plain: a flat colour, a smooth gradient, a large shape, thin rules', () => {
    const plain: Record<string, Uint8ClampedArray> = {
      flat: frame(() => GROUND),
      gradient: frame((x, y) => [Math.round((x / W) * 200), Math.round((y / H) * 200), 80]),
      shape: frame((x, y) => (x > 60 && x < 200 && y > 40 && y < 140 ? [230, 193, 90] : GROUND)),
      rules: frame((x, y) => (x % 80 === 0 || y % 60 === 0 ? [140, 170, 160] : GROUND)),
    };
    for (const [name, rgba] of Object.entries(plain)) {
      const m = frameMarks(rgba, W, H);
      expect(m.marked, name).toBe(0);
      expect(framePlain(m), name).toBe(true);
      expect(m.cells).toBe(cellsAlong(W) * cellsAlong(H));
    }
  });

  it('marks: a caption line, one short word, small text, text in one colour channel only, fine texture', () => {
    const marks: Record<string, Uint8ClampedArray> = {
      caption: frame((x, y) => (word(x, y, 60, 150, 2, 12) ? INK : GROUND)),
      word: frame((x, y) => (word(x, y, 140, 80, 2, 2) ? INK : GROUND)),
      small: frame((x, y) => (word(x, y, 20, 20, 1, 30) ? INK : GROUND)),
      // Blue on black: next to no brightness, a clear step in the blue channel.
      blue: frame((x, y) => (word(x, y, 60, 150, 2, 12) ? [0, 0, 255] : [0, 0, 0])),
      texture: frame((x, y) => ((x * 7 + y * 13) % 5 < 2 ? [200, 200, 200] : [40, 40, 40])),
    };
    for (const [name, rgba] of Object.entries(marks)) {
      const m = frameMarks(rgba, W, H);
      expect(m.marked, name).toBeGreaterThan(0);
      expect(framePlain(m), name).toBe(false);
      expect(m.box, name).toBeDefined();
    }
  });

  it('the box is around the marked cells', () => {
    const m = frameMarks(frame((x, y) => (word(x, y, 64, 144, 2, 12) ? INK : GROUND)), W, H);
    expect(m.box!.y).toBeGreaterThanOrEqual(128);
    expect(m.box!.y + m.box!.h).toBeLessThanOrEqual(176);
    expect(m.box!.x).toBeGreaterThanOrEqual(48);
    expect(m.box!.x + m.box!.w).toBeLessThanOrEqual(64 + 12 * 14 + 16);
  });

  // Fix round 1, S2: no strip of the frame goes unread, whatever its size.
  it('red: a 12 px line of writing inside the last 14 rows of a 1280 x 718 frame (below the last whole 16 px cell) puts marks in a cell', () => {
    const w = 1280;
    const h = 718;
    // Rows 705 to 711 hold the letters: 1280 x 718 has 44 whole cells down (704 rows) and 14 rows left over.
    const m = frameMarks(frame((x, y) => (word(x, y, 400, 705, 1, 40) ? INK : GROUND), w, h), w, h);
    expect(m.marked).toBeGreaterThan(0);
    expect(framePlain(m)).toBe(false);
    expect(m.box!.y + m.box!.h).toBe(h);
    expect(m.cells).toBe(cellsAlong(w) * cellsAlong(h));
  });

  it('red: writing inside the last columns of a frame whose width no cell size divides (650 px: 10 columns left over)', () => {
    const w = 650;
    const h = 360;
    // A column of short words in the last 10 columns: each row of a letter crosses its two uprights.
    const m = frameMarks(frame((x, y) => (y >= 40 && y < 320 && letter(x, y % 14, 642, 2, 1) ? INK : GROUND), w, h), w, h);
    expect(m.marked).toBeGreaterThan(0);
    expect(m.box!.x + m.box!.w).toBe(w);
  });

  it('red: a line of small writing that lies across the edge between two cells of a 16 px grid (rows 14 to 18)', () => {
    // Five rows of letters, two in one cell of a 16 px grid and three in the next, where a letter's bar is one of
    // the three: neither whole cell has three rows that cross two strokes. A cell that starts 8 px on holds all five.
    const m = frameMarks(frame((x, y) => (word(x, y, 40, 14, 1, 30) && y < 19 ? INK : GROUND)), W, H);
    expect(m.marked).toBeGreaterThan(0);
  });

  it('a line of letters is found wherever it lies against the cells: every offset of 16 px across and down, letters 7 px and 14 px tall', () => {
    for (const k of [1, 2]) {
      const missed: string[] = [];
      for (let dy = 0; dy < 16; dy++) {
        for (let dx = 0; dx < 16; dx++) {
          const m = frameMarks(frame((x, y) => (word(x, y, 96 + dx, 64 + dy, k, 6) ? INK : GROUND)), W, H);
          if (!m.marked) missed.push(`${dx},${dy}`);
        }
      }
      expect(missed, `letters ${7 * k} px tall`).toEqual([]);
    }
  });

  it('look-alike: plain frames of sizes no cell size divides stay plain, edges included', () => {
    for (const [w, h] of [[1280, 718], [650, 360], [642, 366], [17, 17], [16, 16]] as const) {
      const flat = frameMarks(frame(() => GROUND, w, h), w, h);
      expect(framePlain(flat), `${w}x${h}`).toBe(true);
      expect(flat.cells, `${w}x${h}`).toBe(cellsAlong(w) * cellsAlong(h));
      // A rule along the very last row and the very last column is still a rule (in a frame wide enough that
      // no cell holds two of the frame's sides).
      if (w < 64) continue;
      const ruled = frameMarks(frame((x, y) => (x === w - 1 || y === h - 1 || x === 0 || y === 0 ? [140, 170, 160] : GROUND), w, h), w, h);
      expect(framePlain(ruled), `${w}x${h} ruled`).toBe(true);
    }
  });

  it('a frame with no cells (smaller than a cell, or bytes missing) is never plain', () => {
    expect(framePlain(frameMarks(new Uint8ClampedArray(8 * 8 * 4), 8, 8))).toBe(false);
    expect(framePlain(frameMarks(new Uint8ClampedArray(10), W, H))).toBe(false);
  });

  it('frameMarks uses no outer names (its source is sent into the page as it is)', () => {
    const again = new Function(`return (${frameMarks.toString()})`)() as typeof frameMarks;
    const rgba = frame((x, y) => (word(x, y, 60, 150, 2, 12) ? INK : GROUND));
    expect(again(rgba, W, H)).toEqual(frameMarks(rgba, W, H));
  });
});
