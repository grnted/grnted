// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Unit tests for the Task 4.4 pure parts: animated image parsing (GIF loops, the size cap), PNG
// decoding and changed regions, the WCAG 2.3.1 flash analysis on synthetic luminance sequences, the
// registrable-domain guess (timing) and the related-control pattern (motion actuation).
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { flashDecision, stillShots } from '../../src/probes/flash.js';
import { guardStop } from '../../src/probes/motionShared.js';
import { changedRegions } from '../../src/probes/motionPixels.js';
import { decodePng, type RgbaImage } from '../../src/probes/pixels.js';
import { registrableDomain } from '../../src/probes/timing.js';
import { describe, expect, it } from 'vitest';
import { FLASH, analyseFlashes, luminanceTransitions, redTransitions, type FlashFrame } from '../../src/probes/flashMath.js';
import { readImageAnimations } from '../../src/probes/motion.js';
import type { CellGrid } from '../../src/probes/motionPixels.js';
import { LINEAR } from '../../src/probes/pixels.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/motion/${name}`, import.meta.url));
const dataUrl = (bytes: Uint8Array, type: string) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

describe('animated image parsing (in-page code, run in Node with data: URLs)', () => {
  it('reads GIF frames, delays and loops', async () => {
    const [spinner, still] = await readImageAnimations({ srcs: [dataUrl(fixture('spinner.gif'), 'image/gif'), dataUrl(fixture('still.gif'), 'image/gif')], maxBytes: 1e6 });
    expect(spinner).toEqual({ frames: 2, loopMs: 400, loops: null });
    expect(still).toEqual({ frames: 1, loopMs: 0, loops: 1 });
  });

  it('reads a finite loop count (NETSCAPE n means n + 1 plays) and refuses files past maxBytes', async () => {
    const gif = new Uint8Array(fixture('spinner.gif'));
    const at = Buffer.from(gif).indexOf('NETSCAPE2.0') + 11 + 2;
    gif[at] = 2;
    const [twice] = await readImageAnimations({ srcs: [dataUrl(gif, 'image/gif')], maxBytes: 1e6 });
    expect(twice).toEqual({ frames: 2, loopMs: 400, loops: 3 });
    const [tooBig] = await readImageAnimations({ srcs: [dataUrl(gif, 'image/gif')], maxBytes: 50 });
    expect(tooBig).toBeNull();
  });
});

/** A PNG with the given rows (each `width * channels` bytes) and per-row filters. */
function png(width: number, height: number, colorType: 2 | 6, rows: number[][], filters: number[]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(new Uint8Array(out.subarray(4, 8 + data.length))), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r, i) => Buffer.from([filters[i]!, ...r])));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]));
}

describe('PNG decoding and changed regions (screenshots)', () => {
  it('decodes RGB and RGBA with the sub, up, average and Paeth filters (to RGBA)', async () => {
    // Two RGB pixels per row; row 0 raw (filter 0), row 1 "up" (1 + the row above), row 2 "sub".
    const rgb = await decodePng(png(2, 3, 2, [[10, 20, 30, 40, 50, 60], [1, 1, 1, 1, 1, 1], [5, 5, 5, 1, 2, 3]], [0, 2, 1]));
    expect(rgb).toMatchObject({ width: 2, height: 3 });
    expect([...rgb.data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 11, 21, 31, 255, 41, 51, 61, 255, 5, 5, 5, 255, 6, 7, 8, 255]);
    // Average (3) and Paeth (4) against a zero row above.
    const rgba = await decodePng(png(2, 2, 6, [[100, 0, 0, 255, 50, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], [3, 4]));
    expect([...rgba.data.subarray(0, 8)]).toEqual([100, 0, 0, 255, 100, 0, 0, 127]);
    expect([...rgba.data.subarray(8)]).toEqual([100, 0, 0, 255, 100, 0, 0, 127]);
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow('not a PNG');
  });

  it('finds the changed area between two screenshots and ignores tiny changes', () => {
    const img = (fill: (x: number, y: number) => number): RgbaImage => {
      const data = new Uint8Array(200 * 100 * 4).fill(255);
      for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) data.fill(fill(x, y), (y * 200 + x) * 4, (y * 200 + x) * 4 + 3);
      return { width: 200, height: 100, data };
    };
    const a = img(() => 255);
    const b = img((x, y) => (x >= 64 && x < 128 && y >= 32 && y < 64 ? 0 : 255));
    expect(changedRegions(a, b)).toEqual([{ x: 64, y: 32, w: 64, h: 32, pixels: 64 * 32 }]);
    const speck = img((x, y) => (x === 5 && y === 5 ? 0 : 255));
    expect(changedRegions(a, speck)).toEqual([]);
    expect(changedRegions(a, a)).toEqual([]);
  });
});

describe('registrable domains (own site versus third-party services)', () => {
  it('handles plain, multi-part and US locality suffixes', () => {
    expect(registrableDomain('https://www.example.org/a')).toBe('example.org');
    expect(registrableDomain('https://a.example.co.uk/')).toBe('example.co.uk');
    expect(registrableDomain('https://b.other.co.uk/')).toBe('other.co.uk');
    expect(registrableDomain('https://www.amity.k12.or.us/')).toBe('amity.k12.or.us');
    expect(registrableDomain('https://www.ci.salem.or.us/')).toBe('salem.or.us');
    expect(registrableDomain('https://shop.example.com.au/x')).toBe('example.com.au');
    expect(registrableDomain('http://127.0.0.1:8080/')).toBe('127.0.0.1');
    expect(registrableDomain('not a url')).toBe('');
  });

  it('pairs labels only under real multi-part suffixes, splits shared-hosting tenants, groups www with a locality domain', () => {
    expect(registrableDomain('https://www.school.de/')).toBe('school.de');
    expect(registrableDomain('https://api.school.de/x')).toBe('school.de');
    expect(registrableDomain('https://www.police.ro/')).toBe('police.ro');
    expect(registrableDomain('https://a.github.io/')).toBe('a.github.io');
    expect(registrableDomain('https://b.github.io/')).not.toBe(registrableDomain('https://a.github.io/'));
    expect(registrableDomain('https://x.my-app.vercel.app/')).toBe('my-app.vercel.app');
    expect(registrableDomain('https://bucket.s3.amazonaws.com/f')).toBe('bucket.s3.amazonaws.com');
    expect(registrableDomain('https://www.k12.or.us/')).toBe(registrableDomain('https://k12.or.us/'));
    expect(registrableDomain('https://www.gouv.fr/')).toBe('www.gouv.fr');
    expect(registrableDomain('https://service.impots.gouv.fr/')).toBe('impots.gouv.fr');
  });
});

describe('flash decision from the captures', () => {
  it('decides nothing from a capture at 8 frames per second or fewer, even when it shows flashes', () => {
    expect(flashDecision([{ fps: 8, flashes: 1 }])).toBe('not_testable');
    expect(flashDecision([{ fps: 29, flashes: 1 }, { fps: 6, flashes: 0 }])).toBe('not_testable');
    expect(flashDecision([{ fps: 29, flashes: 1 }])).toBe('failed');
    expect(flashDecision([{ fps: 8.5, flashes: 0 }])).toBe('no_failures_found');
  });
});

describe('flash captures while the page scrolls', () => {
  const at = { x: 0, y: 2820 };
  const shot = (t: number, sy?: number) => ({ t, ...(sy !== undefined ? { sy, sx: 0 } : {}) });

  it('keeps only the longest run of frames drawn at the place (the screencast says where each one was drawn)', () => {
    // A smooth scroll still arriving for the first frames, then still, then a page script scrolling away.
    const shots = [shot(0, 240), shot(33, 1200), shot(66, 2600), shot(100, 2820), shot(133, 2820), shot(166, 2820.4), shot(200, 2900), shot(233, 2820)];
    expect(stillShots(shots, at, true).map((s) => s.t)).toEqual([100, 133, 166]);
    expect(stillShots([shot(0, 2820), shot(33, 2820)], at, true).map((s) => s.t)).toEqual([0, 33]);
    expect(stillShots([shot(0, 0), shot(33, 10)], at, false)).toEqual([]);
  });

  it('without per-frame positions, keeps every frame only when the window never scrolled', () => {
    const shots = [shot(0), shot(33), shot(66)];
    expect(stillShots(shots, at, false)).toHaveLength(3);
    expect(stillShots(shots, at, true)).toEqual([]);
  });
});

describe('where the flash is', () => {
  it('gives the flashing cells inside the worst field, not just the field around them', () => {
    // 40 by 24 cells of 16 px (a 640x384 viewport, a 213x128 px field, 13x8 cells): a block of 6x5
    // cells at cells (20..25, 10..14) flashes black and white 8 times a second, the rest is still.
    const cols = 40, rows = 24, n = cols * rows;
    const frames: FlashFrame[] = [];
    for (let i = 0; i < 64; i++) {
      const lum = new Float32Array(n).fill(1);
      const on = Math.floor((i * 31.25) / 62.5) % 2 === 0;
      for (let y = 10; y < 15; y++) for (let x = 20; x < 26; x++) lum[y * cols + x] = on ? 0 : 1;
      frames.push({ t: i * 31.25, grid: { cols, rows, cell: 16, lum, r: lum, g: lum, b: lum } });
    }
    const a = analyseFlashes(frames, 16, { width: 640, height: 384 });
    expect(a.general).not.toBeNull();
    expect(a.general!.spot).toEqual({ x: 320, y: 160, w: 96, h: 80 });
    expect(a.general!.points.length).toBeGreaterThan(0);
    expect(a.general!.points.length).toBeLessThanOrEqual(25);
    for (const p of a.general!.points) {
      expect(p.x).toBeGreaterThan(320); expect(p.x).toBeLessThan(416);
      expect(p.y).toBeGreaterThan(160); expect(p.y).toBeLessThan(240);
    }
  });
});

describe('what the guard stopped', () => {
  it('counts a WebSocket kept in the page, as it does requests, navigations and popups', () => {
    expect(guardStop([{ kind: 'websocket', url: 'wss://e.org/live', at: 1 }])).toContain('WebSocket');
    expect(guardStop([{ kind: 'dialog', dialog: 'alert', at: 1 }])).toBeNull();
  });
});
