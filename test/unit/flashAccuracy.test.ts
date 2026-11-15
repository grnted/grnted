// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 accuracy at the thresholds, on synthetic screen captures run through the real analysis
// (`PixelFlashMeter`, as flash.ts does). A capture is what the
// screencast gives for a 1280x900 viewport: 320x225 px frames (a pixel is 4x4 CSS px, an edge pixel a
// blend in sRGB of what covers it), at an uneven frame rate, of rectangles that alternate between two
// colours on a white page.
// - Timing: more than three flashes in a second (seven transitions) fail, exactly three never do.
// - Area: the pixels that flash, whole; an edge pixel only for the share the content covers.
import { describe, expect, it } from 'vitest';
import { PixelFlashMeter, meterImage, type PixelFlashAnalysis } from '../../src/probes/flashPixels.js';

const VIEW = { width: 1280, height: 900 };
const SCALE = 4; // CSS px per screen pixel
const W = VIEW.width / SCALE;
const H = Math.ceil(VIEW.height / SCALE);
/** The 10° field the engine uses (CSS px). */
const FIELD = { w: Math.round((341 / 1024) * VIEW.width), h: Math.round((256 / 768) * VIEW.height) };

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

interface Flasher {
  /** CSS px. */
  x: number; y: number; w: number; h: number;
  a: string; b: string; hz: number;
  /** Its n-th change is shown `by` ms late (a video player presenting a frame late). */
  late?: { n: number; by: number };
  /** Flashes only between these times (ms); still in state `a` outside. */
  from?: number; until?: number;
  /** Starts in its other state (opposite phase). */
  inverse?: boolean;
}

/** The pixels a rectangle covers, with the share of each (CSS px rectangle, screen pixels). */
function raster(f: Flasher): { p: number; a: number }[] {
  const out: { p: number; a: number }[] = [];
  for (let py = Math.floor(f.y / SCALE); py < Math.ceil((f.y + f.h) / SCALE) && py < H; py++) {
    for (let px = Math.floor(f.x / SCALE); px < Math.ceil((f.x + f.w) / SCALE) && px < W; px++) {
      const w = Math.max(0, Math.min(f.x + f.w, (px + 1) * SCALE) - Math.max(f.x, px * SCALE));
      const h = Math.max(0, Math.min(f.y + f.h, (py + 1) * SCALE) - Math.max(f.y, py * SCALE));
      if (w * h > 0) out.push({ p: py * W + px, a: (w * h) / (SCALE * SCALE) });
    }
  }
  return out;
}

/**
 * Captures the flashers on white for `ms` at about `fps`, frame times jittered by up to `jitter` ms
 * (deterministic), and analyses them as the probe does.
 */
function analyse(fs: Flasher[], opts: { fps?: number; jitter?: number; ms?: number; phase?: number } = {}): PixelFlashAnalysis {
  const fps = opts.fps ?? 31;
  const ms = opts.ms ?? 3000;
  const jitter = opts.jitter ?? 6;
  const cover = fs.map(raster);
  const states = fs.map((f) => [hex(f.a), hex(f.b)] as const);
  const meter = new PixelFlashMeter(W, H, 150);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0, t = 0; t < ms; i++, t = i * (1000 / fps) + (rand() * 2 - 1) * jitter) {
    const data = new Uint8Array(W * H * 4).fill(255);
    fs.forEach((f, j) => {
      const half = 1000 / (2 * f.hz);
      const at = t + (opts.phase ?? 0);
      let k = Math.floor(at / half);
      if (f.late && k === f.late.n && at - k * half < f.late.by) k--;
      if ((f.from !== undefined && t < f.from) || (f.until !== undefined && t >= f.until)) k = 0;
      const c = states[j]![(k + (f.inverse ? 1 : 0)) % 2];
      for (const { p, a } of cover[j]!) {
        const q = p * 4;
        for (let ch = 0; ch < 3; ch++) data[q + ch] = Math.round(a * c![ch]! + (1 - a) * data[q + ch]!);
      }
    });
    meter.add(t, { width: W, height: H, data });
  }
  return meter.analyse(VIEW, SCALE);
}

/** A 240 px tall rectangle covering `share` of the field, placed off the pixel and cell grid. */
const rect = (share: number, a: string, b: string, hz: number, at: [number, number] = [210, 309]): Flasher => ({ x: at[0], y: at[1], h: 240, w: (share * FIELD.w * FIELD.h) / 240, a, b, hz });
const OFFSETS: [number, number][] = [[210, 309], [200.5, 300], [215, 313], [203, 318]];
const BW = ['#000000', '#ffffff'] as const;
const RED = ['#ff0000', '#7f7f7f'] as const;
const RED_STATES = { a: '#ff0000', b: '#7f7f7f' } as const;

describe('more than three flashes a second fail; exactly three never do', () => {
  for (const phase of [0, 11, 47, 83, 120]) {
    it(`3 Hz over 40% of the field, jittered frames (phase ${phase} ms): no failure; 3.5 Hz fails`, () => {
      expect(analyse([rect(0.4, ...BW, 3)], { phase }).general).toBeNull();
      expect(analyse([rect(0.4, ...BW, 3.5)], { phase }).general).not.toBeNull();
    });
  }
  it('3.2 Hz at 30 frames a second fails (four flashes in 0.94 s)', () => {
    for (const phase of [0, 40, 90]) expect(analyse([rect(0.4, ...BW, 3.2)], { fps: 30, jitter: 1, phase }).general, `phase ${phase}`).not.toBeNull();
  });
  it('3.5 Hz at 10 frames a second fails', () => {
    for (const phase of [0, 40, 90]) expect(analyse([rect(0.4, ...BW, 3.5)], { fps: 10, jitter: 1, phase }).general, `phase ${phase}`).not.toBeNull();
  });
  it('3 Hz with one change shown 25 ms late, at 30 frames a second, does not fail', () => {
    for (const n of [3, 4, 5, 6, 7, 8]) expect(analyse([{ ...rect(0.4, ...BW, 3), late: { n, by: 25 } }], { fps: 30, jitter: 1 }).general, `change ${n}`).toBeNull();
  });
  it('red: 3 Hz does not fail, 3.5 Hz does (over 40%)', () => {
    expect(analyse([rect(0.4, ...RED, 3)]).red).toBeNull();
    expect(analyse([rect(0.4, ...RED, 3.5)]).red).not.toBeNull();
  });
  it('at 15 frames a second with 20 ms jitter: 3 Hz does not fail, 4 Hz does', () => {
    expect(analyse([rect(0.4, ...BW, 3)], { fps: 15, jitter: 20 }).general).toBeNull();
    expect(analyse([rect(0.4, ...BW, 4)], { fps: 15, jitter: 20 }).general).not.toBeNull();
  });
});

describe('the flashing area is the pixels that flash', () => {
  for (const at of OFFSETS) {
    it(`one uniform rectangle: 24% of the field does not fail, 26% fails (8 Hz, at ${at})`, () => {
      expect(analyse([rect(0.24, ...BW, 8, at)]).general).toBeNull();
      expect(analyse([rect(0.26, ...BW, 8, at)]).general).not.toBeNull();
    });
    it(`red: 24% does not fail, 26% fails (pink edge pixels count for the red they hold; at ${at})`, () => {
      expect(analyse([rect(0.24, ...RED, 8, at)]).red).toBeNull();
      expect(analyse([rect(0.26, ...RED, 8, at)]).red).not.toBeNull();
    });
  }

  it('a 26% grey block flashing 0.69 to 0.80 luminance with one black and white row in it fails (every flashing pixel counts whole)', () => {
    // 26x5 cells (416x80 CSS px): the grey flash is a general flash (a 0.11 change, the darker state below 0.8).
    const x = 160, y = 320;
    const grey: Flasher = { x, y, w: 416, h: 80, a: '#d8d8d8', b: '#e7e7e7', hz: 8 };
    const row: Flasher = { x, y: y + 32, w: 416, h: 16, a: '#000000', b: '#ffffff', hz: 8 };
    const a = analyse([grey, row]);
    expect(a.general).not.toBeNull();
    expect(a.general!.share).toBeGreaterThan(0.25);
  });

  it('many small flashers, one in each of 150 cells, each covering 40% of its cell (12% of the field in all), do not fail', () => {
    const fs: Flasher[] = [];
    for (let cy = 0; cy < 10; cy++) for (let cx = 0; cx < 15; cx++) fs.push({ x: 160 + cx * 16 + 3, y: 320 + cy * 16 + 3, w: 10, h: 10, a: '#000000', b: '#ffffff', hz: 8 });
    const a = analyse(fs);
    expect(a.general, JSON.stringify(a.general && { share: a.general.share })).toBeNull();
  });

  it('8 px stripes in opposite phases over 40% of the field (each 16 px cell stays mid-grey on average) fail', () => {
    // Grok r2 finding 1: every pixel flashes, so the area is about 40%.
    const fs: Flasher[] = [];
    const w = 0.4 * FIELD.w * FIELD.h / 240;
    for (let i = 0, x = 208; x < 208 + w; i++, x += 8) fs.push({ x, y: 304, w: Math.min(8, 208 + w - x), h: 240, a: '#000000', b: '#ffffff', hz: 8, inverse: i % 2 === 1 });
    const a = analyse(fs);
    expect(a.general).not.toBeNull();
    expect(a.general!.share).toBeGreaterThan(0.38);
  });

  it('the same stripes in red and grey fail the red test', () => {
    const fs: Flasher[] = [];
    const w = 0.4 * FIELD.w * FIELD.h / 240;
    for (let i = 0, x = 208; x < 208 + w; i++, x += 8) fs.push({ x, y: 304, w: Math.min(8, 208 + w - x), h: 240, ...RED_STATES, hz: 8, inverse: i % 2 === 1 });
    expect(analyse(fs).red).not.toBeNull();
  });

  it('two side-by-side 96x288 rectangles (21.6% each), one flashing only in the first second, the other only in the last, do not fail', () => {
    // Grok r2 finding 3: no one second has more than 21.6% flashing.
    const left: Flasher = { x: 208, y: 304, w: 96, h: 288, a: '#000000', b: '#ffffff', hz: 8, until: 1000 };
    const right: Flasher = { x: 304, y: 304, w: 96, h: 288, a: '#000000', b: '#ffffff', hz: 8, from: 2000 };
    const a = analyse([left, right]);
    expect(a.general, JSON.stringify(a.general && { share: a.general.share })).toBeNull();
    // Each one alone is seen flashing (the test does see them).
    expect(analyse([{ ...left, until: undefined, w: 192 }]).general).not.toBeNull();
  });

  it('a 416x72 rectangle along the bottom edge (23.4% of the field) does not fail: the short last row counts its real size', () => {
    // Grok r2 finding 2: 900 px is not a whole number of 16 px cells.
    const a = analyse([{ x: 208, y: 828, w: 416, h: 72, a: '#000000', b: '#ffffff', hz: 8 }]);
    expect(a.general, JSON.stringify(a.general && { share: a.general.share })).toBeNull();
    // And at 27.8% (416x86) it fails.
    expect(analyse([{ x: 208, y: 814, w: 416, h: 86, a: '#000000', b: '#ffffff', hz: 8 }]).general).not.toBeNull();
  });

  it('reports the share it measured, close to the real one', () => {
    const a = analyse([rect(0.4, ...BW, 8)]);
    expect(a.general!.share).toBeGreaterThan(0.39);
    expect(a.general!.share).toBeLessThan(0.41);
  });
});

describe('memory', () => {
  it('a 1280x900 screenshot is metered at the screencast size (320 wide), and the meter stays under 32 MB', () => {
    const shot = { width: 1280, height: 900, data: new Uint8Array(1280 * 900 * 4).fill(255) };
    const img = meterImage(shot, 320);
    expect([img.width, img.height]).toEqual([320, 225]);
    const meter = new PixelFlashMeter(img.width, img.height, 150);
    expect(meter.bytes()).toBeLessThan(32 * 1024 * 1024);
    // The capture's length does not change it.
    for (let i = 0; i < 150; i++) meter.add(i * 33, i % 2 ? img : meterImage({ ...shot, data: new Uint8Array(1280 * 900 * 4) }, 320));
    expect(meter.bytes()).toBeLessThan(32 * 1024 * 1024);
  });
  it('downscaling keeps the area of a dark square and blends its edges in sRGB', () => {
    const shot = { width: 1280, height: 900, data: new Uint8Array(1280 * 900 * 4).fill(255) };
    for (let y = 100; y < 200; y++) for (let x = 102; x < 202; x++) { const q = (y * 1280 + x) * 4; shot.data[q] = 0; shot.data[q + 1] = 0; shot.data[q + 2] = 0; }
    const img = meterImage(shot, 320);
    let dark = 0;
    for (let p = 0; p < 320 * 225; p++) dark += 1 - img.data[p * 4]! / 255;
    expect(dark * 16).toBeGreaterThan(100 * 100 - 40);
    expect(dark * 16).toBeLessThan(100 * 100 + 40);
  });
});
