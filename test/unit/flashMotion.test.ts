// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.3.1 without frames of the screen (src/probes/flashMotion.ts, src/probes/gif.ts): the bounded GIF
// decoder, judging animations, script restyles and GIFs, and the precedence of the frames.
import { describe, expect, it } from 'vitest';
import { decodeGif, GIF_LIMITS } from '../../src/probes/gif.js';
import { flashPrecedence, imageKind, judgeAnimation, judgeGif, judgeMotion, judgeRestyled, type AnimState, type MotionAnimation, type MotionScan } from '../../src/probes/flashMotion.js';
import type { ProbeRun } from '../../src/types.js';
import { encodeGif } from '../helpers/gifEncode.js';

const VIEW = { width: 1280, height: 900 };
const BW: [number, number, number][] = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [118, 118, 118]];
const fill = (w: number, h: number, v: number) => new Uint8Array(w * h).fill(v);

/** A GIF alternating two palette colours, `delayCs` each. */
const alternating = (w: number, h: number, delayCs: number, a = 0, b = 1, loops: number | null = 0) =>
  encodeGif(w, h, BW, [{ pixels: fill(w, h, a), delayCs }, { pixels: fill(w, h, b), delayCs }], loops);

describe('GIF decoder', () => {
  it('plays frames onto the canvas: colours, delays, loop count, transparency and disposal', () => {
    const w = 4, h = 2;
    const bytes = encodeGif(w, h, BW, [
      { pixels: fill(w, h, 1), delayCs: 5 },
      // A 2×1 red patch with a transparent pixel, then restored to the background (disposal 2).
      { pixels: Uint8Array.from([2, 0]), rect: { x: 1, y: 1, w: 2, h: 1 }, transparent: 0, disposal: 2, delayCs: 1 },
      { pixels: Uint8Array.from([3]), rect: { x: 0, y: 0, w: 1, h: 1 }, delayCs: 0 },
    ], 3);
    const seen: { px: number[]; delay: number }[] = [];
    const r = decodeGif(bytes, (f) => seen.push({ px: [...f.rgba], delay: f.delayMs }));
    expect(r).toEqual({ width: 4, height: 2, frames: 3, loops: 3, truncated: false });
    expect(seen.map((s) => s.delay)).toEqual([50, 100, 100]);
    const at = (px: number[], x: number, y: number) => px.slice((y * w + x) * 4, (y * w + x) * 4 + 4);
    expect(at(seen[0]!.px, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(at(seen[1]!.px, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(at(seen[1]!.px, 2, 1)).toEqual([255, 255, 255, 255]); // transparent: the white below shows
    expect(at(seen[2]!.px, 1, 1)).toEqual([0, 0, 0, 0]); // disposal 2 cleared the red patch
    expect(at(seen[2]!.px, 0, 0)).toEqual([118, 118, 118, 255]);
  });

  it('reads interlaced frames in row order', () => {
    const w = 3, h = 9;
    const pixels = Uint8Array.from({ length: w * h }, (_, i) => Math.floor(i / w) % 4);
    let rows: number[] = [];
    decodeGif(encodeGif(w, h, BW, [{ pixels, delayCs: 10, interlaced: true }], null), (f) => {
      rows = Array.from({ length: h }, (_, y) => f.rgba[y * w * 4 + 2]!);
    });
    expect(rows).toEqual([0, 255, 0, 118, 0, 255, 0, 118, 0]);
  });

  it('refuses what it cannot read, and stops at its limits', () => {
    expect(() => decodeGif(Uint8Array.from([1, 2, 3]), () => {})).toThrow(/not a GIF/);
    const good = alternating(8, 8, 10);
    expect(() => decodeGif(good.subarray(0, good.length - 40), () => {})).toThrow(/cut short|damaged/);
    expect(() => decodeGif(alternating(800, 800, 10), () => {})).toThrow(/canvas too large/);
    const frames = Array.from({ length: 30 }, (_, i) => ({ pixels: fill(10, 10, i % 2), delayCs: 5 }));
    const r = decodeGif(encodeGif(10, 10, BW, frames), () => {}, { ...GIF_LIMITS, maxFrames: 12 });
    expect(r).toMatchObject({ frames: 12, truncated: true });
    const w = decodeGif(encodeGif(10, 10, BW, frames), () => {}, { ...GIF_LIMITS, maxWork: 1000 });
    expect(w).toMatchObject({ frames: 10, truncated: true });
    // A frame that claims 60000×60000 pixels on a small canvas (a decompression bomb) is refused at once.
    const bomb = encodeGif(10, 10, BW, [{ pixels: fill(10, 10, 0), delayCs: 5 }]);
    const at = bomb.indexOf(0x2c, 13 + 384);
    bomb.set([0x60, 0xea, 0x60, 0xea], at + 5);
    expect(() => decodeGif(bomb, () => {})).toThrow(/frame too large/);
  });

  it('decodes in time linear in what it decodes: a GIF at the work limit stays well under a second', () => {
    const side = 600;
    const frames = Array.from({ length: Math.floor(GIF_LIMITS.maxWork / (side * side)) + 5 }, (_, i) => ({ pixels: fill(side, side, i % 2), delayCs: 5 }));
    const bytes = encodeGif(side, side, BW, frames);
    const t0 = Date.now();
    // This writer does not compress: allow the file size (the work limit is what is under test).
    const r = decodeGif(bytes, () => {}, { ...GIF_LIMITS, maxBytes: Infinity });
    expect(r.truncated).toBe(true);
    expect(r.frames * side * side).toBeLessThanOrEqual(GIF_LIMITS.maxWork);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('judging animated GIFs', () => {
  const img = (w: number, h: number) => ({ w, h, backdrop: [255, 255, 255] as [number, number, number] });

  it('fails a large black and white GIF at about 6 flashes a second, general and red', () => {
    expect(judgeGif(alternating(60, 40, 8), img(600, 400), VIEW)).toMatchObject({ kind: 'fails', red: false });
    expect(judgeGif(alternating(60, 40, 8, 2, 3), img(600, 400), VIEW)).toMatchObject({ kind: 'fails', red: true });
  });

  it('clears the same GIF slower than three flashes a second, smaller than the area threshold, or playing once briefly', () => {
    expect(judgeGif(alternating(60, 40, 30), img(600, 400), VIEW)).toEqual({ kind: 'clear' });
    expect(judgeGif(alternating(60, 40, 8), img(120, 80), VIEW)).toEqual({ kind: 'clear' });
    expect(judgeGif(alternating(60, 40, 8, 0, 1, null), img(600, 400), VIEW)).toEqual({ kind: 'clear' });
  });
});

const states = (...xs: [number, [number, number, number] | null][]): AnimState[] => xs.map(([offset, rgb]) => ({ offset, rgb, key: JSON.stringify(rgb), easing: 'steps(1)' }));
const anim = (o: Partial<MotionAnimation>): MotionAnimation => ({
  path: 'div.flash', w: 500, h: 500, pseudo: false, durationMs: 200, iterations: -1, direction: 'normal', rate: 1, moveOnly: false,
  states: states([0, [0, 0, 0]], [0.5, [255, 255, 255]], [1, [0, 0, 0]]), ...o,
});

describe('judging animations from their keyframes', () => {
  it('fails a large black and white animation at 5 a second, and a red one', () => {
    expect(judgeAnimation(anim({}), VIEW)).toMatchObject({ kind: 'fails', red: false, transitions: expect.toSatisfy((n: number) => n >= 9 && n <= 11) });
    expect(judgeAnimation(anim({ states: states([0, [255, 0, 0]], [0.5, [118, 118, 118]], [1, [255, 0, 0]]) }), VIEW)).toMatchObject({ kind: 'fails', red: true });
  });

  it('clears slow, small, short, faint and moving animations', () => {
    expect(judgeAnimation(anim({ durationMs: 500 }), VIEW)).toEqual({ kind: 'clear' }); // 2 a second
    expect(judgeAnimation(anim({ w: 80, h: 80 }), VIEW)).toEqual({ kind: 'clear' });
    expect(judgeAnimation(anim({ iterations: 2 }), VIEW)).toEqual({ kind: 'clear' }); // 400 ms in all
    expect(judgeAnimation(anim({ states: states([0, [200, 200, 200]], [0.5, [210, 210, 210]], [1, [200, 200, 200]]) }), VIEW)).toEqual({ kind: 'clear' });
    expect(judgeAnimation(anim({ moveOnly: true }), VIEW)).toEqual({ kind: 'clear' });
  });

  it('counts an alternating animation once per direction change, and a jump back at each repeat', () => {
    // 0→1 then jump back: 2 transitions per 200 ms; alternate: 1 per 200 ms (5 a second, 2.5 flashes).
    const ramp = states([0, [0, 0, 0]], [1, [255, 255, 255]]).map((s) => ({ ...s, easing: 'linear' }));
    expect(judgeAnimation(anim({ states: ramp }), VIEW)).toMatchObject({ kind: 'fails' });
    expect(judgeAnimation(anim({ states: ramp, direction: 'alternate' }), VIEW)).toEqual({ kind: 'clear' });
  });

  it('says it cannot tell when a fast, large animation has colours it cannot read', () => {
    expect(judgeAnimation(anim({ states: states([0, null], [0.5, [255, 255, 255]], [1, null]) }), VIEW)).toMatchObject({ kind: 'unclear' });
    expect(judgeAnimation(anim({ pseudo: true }), VIEW)).toMatchObject({ kind: 'unclear' });
  });
});

describe('judging script restyles', () => {
  const samples = (gap: number, n: number, rgb: (i: number) => [number, number, number] | null) =>
    Array.from({ length: n }, (_, i) => ({ t: i * gap, rgb: rgb(i), key: String(i % 2) }));
  it('fails a large element a script swaps black and white 16 times a second; clears it at 4 a second', () => {
    const bw = (i: number): [number, number, number] => (i % 2 ? [255, 255, 255] : [0, 0, 0]);
    expect(judgeRestyled({ path: '#f', w: 500, h: 500, samples: samples(62, 19, bw) }, VIEW)).toMatchObject({ kind: 'fails' });
    expect(judgeRestyled({ path: '#f', w: 500, h: 500, samples: samples(250, 5, bw) }, VIEW)).toEqual({ kind: 'clear' });
    expect(judgeRestyled({ path: '#f', w: 500, h: 500, samples: samples(62, 19, () => null) }, VIEW)).toMatchObject({ kind: 'unclear' });
  });
});

describe('the page verdict', () => {
  const empty: MotionScan = { animations: [], restyled: [], images: [], others: [] };
  it('fails on clear evidence, cannot test a large source it cannot read, and otherwise finds no failure', () => {
    expect(judgeMotion({ ...empty, animations: [anim({})] }, new Map(), VIEW).failed).toHaveLength(1);
    const video = judgeMotion({ ...empty, others: [{ path: 'video', w: 640, h: 360, kind: 'video' }] }, new Map(), VIEW);
    expect(video).toMatchObject({ failed: [], unclear: [expect.stringContaining('a playing video')] });
    const small = judgeMotion({ ...empty, others: [{ path: 'video', w: 100, h: 60, kind: 'video' }] }, new Map(), VIEW);
    expect(small).toMatchObject({ failed: [], unclear: [] });
    const gif = { path: 'img', src: 'http://x/a.gif', w: 600, h: 400, backdrop: [255, 255, 255] as [number, number, number] };
    expect(judgeMotion({ ...empty, images: [gif] }, new Map([[gif.src, alternating(60, 40, 8)]]), VIEW).failed).toHaveLength(1);
    expect(judgeMotion({ ...empty, images: [gif] }, new Map([[gif.src, 'unread' as const]]), VIEW).unclear).toHaveLength(1);
  });

  it('tells GIFs, animated PNG and WebP, and still images apart by their bytes', () => {
    expect(imageKind(alternating(4, 4, 10))).toBe('gif');
    const png = (chunks: string[]) => Uint8Array.from([0x89, ...[...`PNG\r\n\x1a\n${chunks.join('')}`].map((c) => c.charCodeAt(0))]);
    expect(imageKind(png(['....IHDR', '....acTL', '....IDAT']))).toBe('animated');
    expect(imageKind(png(['....IHDR', '....IDAT']))).toBe('still');
    const webp = (s: string) => Uint8Array.from([...`RIFF....WEBP${s}`].map((c) => c.charCodeAt(0)));
    expect(imageKind(webp('VP8X....ANIM'))).toBe('animated');
    expect(imageKind(webp('VP8 ....'))).toBe('still');
    expect(imageKind(new TextEncoder().encode('<svg><rect><animate attributeName="fill"/></rect></svg>'))).toBe('animated');
  });
});

describe('precedence of the frames', () => {
  const run = (probe: string, page: string, status: ProbeRun['findings'][number]['status']): ProbeRun => ({
    probe, kind: 'pixels', page, criteria: ['2.3.1'], status: 'ok', ms: 1, findings: [{ criterion: '2.3.1', status, detail: status }],
  });
  it('the frames decide a page when they could; the animation check stands where they could not', () => {
    const runs = [
      run('flash', 'a', 'no_failures_found'), run('flash-motion', 'a', 'failed'),
      run('flash', 'b', 'not_testable'), run('flash-motion', 'b', 'failed'),
      run('flash', 'c', 'failed'), run('flash-motion', 'c', 'no_failures_found'),
    ];
    const out = flashPrecedence(runs);
    expect(out.map((r) => `${r.probe} ${r.page} ${r.findings[0]!.status}`)).toEqual([
      'flash a no_failures_found', 'flash-motion a not_applicable',
      'flash b not_testable', 'flash-motion b failed',
      'flash c failed', 'flash-motion c not_applicable',
    ]);
  });
});
