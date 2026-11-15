// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The one PNG decoder (src/probes/pixels.ts: contrast, motion and flash, focus indicators) and the
// pixel comparison behind 2.4.7 (focus visible), against PNGs encoded here with every filter type and
// colour type, and the per-cell luminance grid of the flash probe on what it decodes.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PIXEL_CHANNEL_DELTA } from '../../src/probes/keyboard/rules.js';
import { cellGrid } from '../../src/probes/motionPixels.js';
import { decodePng, pixelDelta, type RgbaImage } from '../../src/probes/pixels.js';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
  return out;
}
const CH: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
/** Encodes raw samples (rows of width*channels bytes) with the given filter on every row. */
function encode(width: number, height: number, colorType: number, samples: Uint8Array, filter: number | number[], opts: { depth?: number; interlace?: number; palette?: Uint8Array } = {}): Uint8Array {
  const ch = CH[colorType]!;
  const stride = width * ch;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = Array.isArray(filter) ? filter[y % filter.length]! : filter;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = samples[y * stride + x]!;
      const a = x >= ch ? samples[y * stride + x - ch]! : 0;
      const b = y > 0 ? samples[(y - 1) * stride + x]! : 0;
      const c = x >= ch && y > 0 ? samples[(y - 1) * stride + x - ch]! : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]!;
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = opts.depth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = opts.interlace ?? 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(opts.palette ? [chunk('PLTE', opts.palette)] : []),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const random = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = s >>> 24; }
  return out;
};

describe('decodePng', () => {
  it('decodes every filter type and colour type to RGBA (one filter for every row)', async () => {
    for (const colorType of [0, 2, 4, 6]) {
      const ch = CH[colorType]!;
      const w = 7; const h = 5;
      const samples = random(w * h * ch, colorType + 1);
      for (const filter of [0, 1, 2, 3, 4]) {
        const img = await decodePng(encode(w, h, colorType, samples, filter));
        expect([img.width, img.height]).toEqual([w, h]);
        for (let i = 0; i < w * h; i++) {
          const px = Array.from(img.data.subarray(i * 4, i * 4 + 4));
          const s = Array.from(samples.subarray(i * ch, i * ch + ch));
          const want = ch === 4 ? s : ch === 3 ? [...s, 255] : ch === 2 ? [s[0], s[0], s[0], s[1]] : [s[0], s[0], s[0], 255];
          expect(px, `type ${colorType} filter ${filter} pixel ${i}`).toEqual(want);
        }
      }
    }
  });

  it('decodes rows that each use a different filter, on a wider image (filters chained across rows)', async () => {
    for (const colorType of [0, 2, 4, 6]) {
      const ch = CH[colorType]!;
      const w = 33; const h = 17;
      const samples = random(w * h * ch, 40 + colorType);
      const img = await decodePng(encode(w, h, colorType, samples, [4, 0, 3, 1, 2, 4, 2]));
      const ref = await decodePng(encode(w, h, colorType, samples, 0));
      expect(Buffer.from(img.data).equals(Buffer.from(ref.data)), `type ${colorType}`).toBe(true);
    }
  });

  it('decodes palette images through the palette (opaque without tRNS)', async () => {
    const palette = Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 128, 255]);
    const img = await decodePng(encode(3, 1, 3, Uint8Array.from([2, 1, 0]), 1, { palette }));
    expect([...img.data]).toEqual([0, 128, 255, 255, 255, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('refuses what it does not decode', async () => {
    const ok = encode(2, 2, 6, random(16, 9), 0);
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow('not a PNG');
    await expect(decodePng(encode(2, 2, 6, random(32, 9), 0, { depth: 16 }))).rejects.toThrow('unsupported');
    await expect(decodePng(encode(2, 2, 6, random(16, 9), 0, { interlace: 1 }))).rejects.toThrow('unsupported');
    await expect(decodePng(ok.subarray(0, 40))).rejects.toThrow();
  });
});

describe('pixelDelta', () => {
  const img = (w: number, h: number, fill: number[]): RgbaImage => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
    return { width: w, height: h, data };
  };
  it('counts pixels whose colour changed by the threshold or more (2.4.7 uses PIXEL_CHANNEL_DELTA)', () => {
    expect(PIXEL_CHANNEL_DELTA).toBe(16);
    const a = img(4, 4, [255, 255, 255, 255]);
    const b = img(4, 4, [255, 255, 255, 255]);
    expect(pixelDelta(a, b, PIXEL_CHANNEL_DELTA)).toEqual({ changed: 0, total: 16, max: 0 });
    b.data.set([0, 95, 204, 255], 0);
    b.data.set([250, 250, 250, 255], 4);
    expect(pixelDelta(a, b, PIXEL_CHANNEL_DELTA)).toEqual({ changed: 1, total: 16, max: 255 });
    expect(pixelDelta(a, b, 5).changed).toBe(2);
    // Alpha alone does not count (screenshots are opaque).
    b.data.set([255, 255, 255, 0], 8);
    expect(pixelDelta(a, b, PIXEL_CHANNEL_DELTA).changed).toBe(1);
  });
  it('different sizes count as entirely changed', () => {
    expect(pixelDelta(img(2, 2, [0, 0, 0, 255]), img(3, 2, [0, 0, 0, 255]), PIXEL_CHANNEL_DELTA)).toEqual({ changed: 6, total: 4, max: 255 });
  });
});

describe('cellGrid (flash analysis) on decoded screenshots', () => {
  it('gives the same mean linear colour and luminance per cell for grey, RGB and RGBA encodings of one picture', async () => {
    const w = 10; const h = 7;
    const grey = random(w * h, 77);
    const rgb = new Uint8Array(w * h * 3);
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgb.fill(grey[i]!, i * 3, i * 3 + 3);
      rgba.fill(grey[i]!, i * 4, i * 4 + 3);
      rgba[i * 4 + 3] = 255;
    }
    const grids = await Promise.all([encode(w, h, 0, grey, 4), encode(w, h, 2, rgb, 1), encode(w, h, 6, rgba, 3)].map(async (b) => cellGrid(await decodePng(b), 4)));
    for (const g of grids) expect([g.cols, g.rows, g.cell]).toEqual([3, 2, 4]);
    for (const g of grids.slice(1)) {
      for (const k of ['lum', 'r', 'g', 'b'] as const) for (let i = 0; i < 6; i++) expect(g[k][i]).toBeCloseTo(grids[0]![k][i]!, 6);
    }
    // Cell 0 is the mean of the linear values of its 4×4 pixels; the last column and row are smaller cells.
    const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    let sum = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += lin(grey[y * w + x]!);
    expect(grids[0]!.lum[0]).toBeCloseTo(sum / 16, 5);
    let last = 0;
    for (let y = 4; y < 7; y++) for (let x = 8; x < 10; x++) last += lin(grey[y * w + x]!);
    expect(grids[1]!.lum[5]).toBeCloseTo(last / 6, 5);
  });
});
