// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The pure parts of the contrast probes (Plan 4 Task 4.3): PNG decoding, WCAG ratio math, large
// text, the text, boundary and icon measurements on synthetic screenshots (anti-aliasing, gradients,
// opacity, shadows, movement) and the findings' wording.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { linkColorFindings, linkContrast } from '../../src/probes/linkColor.js';
import { boundaryOutcome, iconOutcome, nonTextFindings, phoneOutcome, type NonTextTarget } from '../../src/probes/nonTextContrast.js';
import {
  boundaryContrast, changeContrast, composite, contrastRatio, decodePng, hex, isLargeText, ratioText, relativeLuminance, textContrast, textThreshold,
  type PxBox, type Rgb, type RgbaImage, type TextFacts,
} from '../../src/probes/pixels.js';
import { PROBES } from '../../src/probes/registry.js';
import { clipAround, eachBatch, pickBatch, shoot, toImageBoxes, type ViewItem } from '../../src/probes/shots.js';
import { axeReason, guarded, textContrastFindings, undecidedTexts, MOBILE_VIEWPORT, TEXT_CONTRAST_LIMITS, type TextItem } from '../../src/probes/textContrast.js';
import { VIEWPORTS } from '../../src/report/build.js';
import type { GuardEvent, GuardLog } from '../../src/probes/types.js';
import { CRITERIA } from '../../src/report/criteria.js';
import type { Finding } from '../../src/types.js';

// --- PNG encoding for the decoder tests ---------------------------------------------------------

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
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}
/** A PNG of `rows` (raw samples per row), each row written with the given filter type. */
function png(width: number, height: number, type: number, rows: number[][], opts: { filter?: number; depth?: number; interlace?: number; palette?: number[]; trns?: number[]; split?: boolean } = {}): Uint8Array {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]!;
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([opts.depth ?? 8, type, 0, 0, opts.interlace ?? 0], 8);
  const raw: number[] = [];
  const f = opts.filter ?? 0;
  rows.forEach((row, y) => {
    raw.push(f);
    const prev = y > 0 ? rows[y - 1]! : row.map(() => 0);
    row.forEach((val, x) => {
      const a = x >= channels ? row[x - channels]! : 0;
      const b = y > 0 ? prev[x]! : 0;
      const c = x >= channels && y > 0 ? prev[x - channels]! : 0;
      const p = a + b - c;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1
        : (Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c);
      raw.push((val - pred) & 255);
    });
  });
  const z = new Uint8Array(deflateSync(Uint8Array.from(raw)));
  const idat = opts.split ? [chunk('IDAT', z.subarray(0, 5)), chunk('IDAT', z.subarray(5))] : [chunk('IDAT', z)];
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    ...(opts.palette ? [chunk('PLTE', Uint8Array.from(opts.palette))] : []), ...(opts.trns ? [chunk('tRNS', Uint8Array.from(opts.trns))] : []),
    ...idat, chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('decodePng', () => {
  const rgbRows = [[10, 20, 30, 200, 100, 50, 255, 255, 255], [0, 0, 0, 1, 2, 3, 250, 128, 7]];
  const expected = [10, 20, 30, 255, 200, 100, 50, 255, 255, 255, 255, 255, 0, 0, 0, 255, 1, 2, 3, 255, 250, 128, 7, 255];

  it('reads 8-bit RGB with every row filter, across several IDAT chunks', async () => {
    for (const filter of [0, 1, 2, 3, 4]) {
      const img = await decodePng(png(3, 2, 2, rgbRows, { filter, split: true }));
      expect([img.width, img.height]).toEqual([3, 2]);
      expect([...img.data], `filter ${filter}`).toEqual(expected);
    }
  });

  it('reads RGBA, grey, grey with alpha and palettes with transparency', async () => {
    expect([...(await decodePng(png(1, 1, 6, [[1, 2, 3, 4]]))).data]).toEqual([1, 2, 3, 4]);
    expect([...(await decodePng(png(2, 1, 0, [[7, 250]], { filter: 1 }))).data]).toEqual([7, 7, 7, 255, 250, 250, 250, 255]);
    expect([...(await decodePng(png(1, 1, 4, [[9, 100]]))).data]).toEqual([9, 9, 9, 100]);
    expect([...(await decodePng(png(2, 1, 3, [[1, 0]], { palette: [0, 0, 0, 10, 20, 30], trns: [255, 0] }))).data]).toEqual([10, 20, 30, 0, 0, 0, 0, 255]);
  });

  it('refuses what it cannot read: not a PNG, 16-bit, interlaced, truncated data', async () => {
    await expect(decodePng(new Uint8Array(40))).rejects.toThrow(/not a PNG/);
    await expect(decodePng(png(1, 1, 2, [[0, 0, 0, 0, 0, 0]], { depth: 16 }))).rejects.toThrow(/unsupported PNG image \(type 2, 16-bit\)/);
    await expect(decodePng(png(1, 1, 2, [[0, 0, 0]], { interlace: 1 }))).rejects.toThrow(/interlaced/);
    const short = png(3, 2, 2, rgbRows);
    await expect(decodePng(short.subarray(0, short.length - 20))).rejects.toThrow();
  });
});

// --- WCAG math ------------------------------------------------------------------------------------

describe('contrast ratio (WCAG relative luminance, sRGB)', () => {
  it('matches the WCAG definition at the known points', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255])).toBeLessThan(4.5);
    expect(contrastRatio([255, 255, 255], [0x76, 0x76, 0x76])).toBe(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255]));
    // The 0.04045 knee of the sRGB curve, and channel weights (green counts most).
    expect(relativeLuminance([10, 10, 10])).toBeCloseTo(10 / 255 / 12.92, 6);
    expect(relativeLuminance([0, 255, 0])).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance([255, 0, 0])).toBeCloseTo(0.2126, 4);
  });

  it('shows ratios rounded down, so a failing 4.49 never reads as 4.5', () => {
    expect(ratioText(4.4999)).toBe('4.4:1');
    expect(ratioText(21)).toBe('21.0:1');
    expect(hex([255, 0, 16.4])).toBe('#ff0010');
    expect(composite([0, 0, 0, 0.3], [255, 255, 255]).map(Math.round)).toEqual([179, 179, 179]);
  });

  it('large text is 18 pt (24 px), or 14 pt (18.67 px) and bold; it needs 3:1 instead of 4.5:1', () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(23.9, 400)).toBe(false);
    expect(isLargeText(18.67, 700)).toBe(true);
    expect(isLargeText(18.6, 700)).toBe(false);
    expect(isLargeText(18.67, 600)).toBe(false);
    expect([textThreshold(true), textThreshold(false)]).toEqual([3, 4.5]);
  });
});

// --- Synthetic screenshots -------------------------------------------------------------------------

const W = 40;
const H = 16;
const image = (f: (x: number, y: number) => Rgb): RgbaImage => {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = f(x, y);
      data.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
};
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
/** Letter coverage: vertical stems two pixels wide every five pixels, the edges anti-aliased. */
const stems = (x: number, y: number, max = 1) => (y < 3 || y > 12 ? 0 : [0, 0.35, max, max, 0.35][x % 5]!);
const WHITE: Rgb = [255, 255, 255];
const BOX: PxBox[] = [[0, 0, W, H]];

/** The five screenshots for text of colour `fg` (opacity `op`) over `bg`, as Chromium draws them. */
function shots(o: { bg: (x: number, y: number) => Rgb; fg: Rgb; op?: number; cover?: (x: number, y: number) => number; shown?: (x: number, y: number, bg: Rgb, cov: number) => Rgb; moving?: boolean; halo?: Rgb }) {
  const op = o.op ?? 1;
  const cover = o.cover ?? stems;
  const draw = (colour: Rgb) => image((x, y) => mix(o.bg(x, y), colour, cover(x, y) * op));
  const shown = image((x, y) => {
    const bg = o.bg(x, y);
    const cov = cover(x, y);
    if (o.shown) return o.shown(x, y, bg, cov);
    if (o.halo && cov === 0 && (cover(x - 1, y) > 0 || cover(x + 1, y) > 0)) return o.halo;
    return mix(bg, o.fg, cov * op);
  });
  return {
    shown, hidden: image(o.bg), black: draw([0, 0, 0]), white: draw(WHITE),
    again: o.moving ? image((x, y) => mix(o.bg(x, y), [128, 0, 0], 0.5)) : shown,
  };
}
const facts = (fg: Rgb, over: Partial<TextFacts> = {}): TextFacts => ({ fg: [...fg, 1], opacity: 1, large: false, shadow: false, ...over });

describe('textContrast (1.4.3 from screenshots)', () => {
  it('uses the style color at every letter pixel, so anti-aliased edges do not lower the ratio', () => {
    const ok = textContrast(shots({ bg: () => WHITE, fg: [0x76, 0x76, 0x76] }), BOX, facts([0x76, 0x76, 0x76]));
    expect(ok).toMatchObject({ kind: 'ok', confirmed: true });
    expect((ok as { ratio: number }).ratio).toBeCloseTo(4.54, 2);
    const fail = textContrast(shots({ bg: () => WHITE, fg: [0x77, 0x77, 0x77] }), BOX, facts([0x77, 0x77, 0x77]));
    expect(fail).toMatchObject({ kind: 'failed', confirmed: true, threshold: 4.5, fg: [0x77, 0x77, 0x77], bg: WHITE });
  });

  it('thin text that never fully covers a pixel is confirmed by dividing out its coverage', () => {
    const v = textContrast(shots({ bg: () => WHITE, fg: [0x59, 0x59, 0x59], cover: (x, y) => stems(x, y, 0.6) }), BOX, facts([0x59, 0x59, 0x59]));
    expect(v).toMatchObject({ kind: 'ok', confirmed: true });
    expect((v as { ratio: number }).ratio).toBeCloseTo(contrastRatio([0x59, 0x59, 0x59], WHITE), 5);
  });

  it('measures each letter on the background behind it: a gradient fails where a fifth of the text is too close', () => {
    // White text; the left three quarters are black behind it, the right quarter white.
    const quarter = textContrast(shots({ bg: (x) => (x < 30 ? [0, 0, 0] : WHITE), fg: WHITE }), BOX, facts(WHITE));
    expect(quarter).toMatchObject({ kind: 'failed', bg: WHITE, dominant: [0, 0, 0] });
    expect((quarter as { ratio: number }).ratio).toBe(1);
    // A tenth on white: four fifths of the letters still reach 21:1.
    const tenth = textContrast(shots({ bg: (x) => (x < 36 ? [0, 0, 0] : WHITE), fg: WHITE }), BOX, facts(WHITE));
    expect(tenth).toMatchObject({ kind: 'ok' });
  });

  it('finds text that is invisible against its background (white on white) and fails it', () => {
    expect(textContrast(shots({ bg: () => WHITE, fg: WHITE }), BOX, facts(WHITE))).toMatchObject({ kind: 'failed', ratio: 1 });
  });

  it('applies group opacity: black at 30% on white is a light grey', () => {
    const v = textContrast(shots({ bg: () => WHITE, fg: [0, 0, 0], op: 0.3 }), BOX, facts([0, 0, 0], { opacity: 0.3 }));
    expect(v).toMatchObject({ kind: 'failed', confirmed: true });
    expect((v as { ratio: number }).ratio).toBeCloseTo(contrastRatio(composite([0, 0, 0, 0.3], WHITE), WHITE), 5);
  });

  it('large text needs 3:1', () => {
    const grey: Rgb = [0x90, 0x90, 0x90];
    expect(textContrast(shots({ bg: () => WHITE, fg: grey }), BOX, facts(grey, { large: true }))).toMatchObject({ kind: 'ok', threshold: 3 });
    expect(textContrast(shots({ bg: () => WHITE, fg: grey }), BOX, facts(grey))).toMatchObject({ kind: 'failed', threshold: 4.5 });
  });

  it('when the pixels do not show the style color (a filter), reads the color from them and fails only well below the threshold', () => {
    const drawn = (c: Rgb) => shots({ bg: () => WHITE, fg: c });
    // The style says black, the page shows another grey.
    const pale = textContrast(drawn([0xaa, 0xaa, 0xaa]), BOX, facts([0, 0, 0]));
    expect(pale).toMatchObject({ kind: 'failed', confirmed: false });
    expect(textContrast(drawn([0x80, 0x80, 0x80]), BOX, facts([0, 0, 0]))).toEqual({ kind: 'unmeasured', reason: 'close' });
    expect(textContrast(drawn([0x59, 0x59, 0x59]), BOX, facts([0, 0, 0]))).toMatchObject({ kind: 'ok', confirmed: false });
    // Gradient-filled text (transparent fill colour) is never confirmed.
    expect(textContrast(drawn([0x30, 0x30, 0x30]), BOX, { ...facts([0, 0, 0]), fg: [0, 0, 0, 0] })).toMatchObject({ kind: 'ok', confirmed: false });
  });

  it('a contrasting text shadow around failing letters makes it not measurable, never failed or clean', () => {
    const s = shots({ bg: () => WHITE, fg: WHITE, halo: [0, 0, 0] });
    expect(textContrast(s, BOX, facts(WHITE, { shadow: true }))).toEqual({ kind: 'unmeasured', reason: 'shadow' });
    // A pale shadow does not outline anything.
    const pale = shots({ bg: () => WHITE, fg: WHITE, halo: [0xf0, 0xf0, 0xf0] });
    expect(textContrast(pale, BOX, facts(WHITE, { shadow: true }))).toMatchObject({ kind: 'failed' });
  });

  it('a background that moves between two screenshots, or no letters at all, is not measured', () => {
    expect(textContrast(shots({ bg: () => WHITE, fg: [0, 0, 0], moving: true }), BOX, facts([0, 0, 0]))).toEqual({ kind: 'unmeasured', reason: 'moving' });
    // Drawn in black and in white it changes no pixel: covered, so nobody sees it.
    expect(textContrast(shots({ bg: () => WHITE, fg: [0, 0, 0], cover: () => 0 }), BOX, facts([0, 0, 0]))).toEqual({ kind: 'unmeasured', reason: 'covered' });
    // Only the boxes (and 2 px around them, for shadows) count: letters farther away are not this text's.
    expect(textContrast(shots({ bg: () => WHITE, fg: [0, 0, 0] }), [[0, 0, W, 1]], facts([0, 0, 0]))).toEqual({ kind: 'unmeasured', reason: 'covered' });
    // A few letter pixels (9) are too few to measure.
    expect(textContrast(shots({ bg: () => WHITE, fg: [0, 0, 0] }), [[0, 3, 2, 1]], facts([0, 0, 0]))).toEqual({ kind: 'unmeasured', reason: 'small' });
  });

  it('transparent text that shows nothing is covered (not seen); white on white with a known color still fails', () => {
    const clear = shots({ bg: () => WHITE, fg: [0, 0, 0], op: 1, shown: (_x, _y, bg) => bg });
    expect(textContrast(clear, BOX, { ...facts([0, 0, 0]), fg: [0, 0, 0, 0], transparent: true })).toEqual({ kind: 'unmeasured', reason: 'covered' });
    expect(textContrast(shots({ bg: () => WHITE, fg: WHITE }), BOX, facts(WHITE))).toMatchObject({ kind: 'failed', ratio: 1 });
  });
});

describe('boundaryContrast and changeContrast (1.4.11 from screenshots)', () => {
  const field = (o: { page?: Rgb; border?: Rgb; sides?: string; fill?: Rgb; busy?: boolean; ring?: Rgb }): RgbaImage => {
    const w = 60;
    const h = 40;
    const data = new Uint8Array(w * h * 4);
    // The field's border box: x 10–49, y 10–29.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = x >= 10 && x < 50 && y >= 10 && y < 30;
        let c: Rgb = o.busy && !inside ? ((x + y) % 2 ? [0, 0, 0] : WHITE) : o.page ?? WHITE;
        if (inside) {
          c = o.fill ?? WHITE;
          const sides = o.sides ?? 'trbl';
          const edge = (sides.includes('t') && y === 10) || (sides.includes('b') && y === 29) || (sides.includes('l') && x === 10) || (sides.includes('r') && x === 49);
          if (o.border && edge) c = o.border;
        } else if (o.ring && x >= 9 && x < 51 && y >= 9 && y < 31) c = o.ring;
        data.set([...c, 255], (y * w + x) * 4);
      }
    }
    return { width: w, height: h, data };
  };
  const BOXF: PxBox = [10, 10, 40, 20];
  const t: Pick<NonTextTarget, 'kind' | 'name'> = { kind: 'field', name: 'Email' };

  it('fails a light border on white; not a dark one, a dark bottom line alone, or a shadow ring', () => {
    expect(boundaryContrast(field({ border: [0xdd, 0xdd, 0xdd] }), BOXF)).toMatchObject({ measurable: true, marked: true, by: 'edge', edge: [0xdd, 0xdd, 0xdd] });
    expect(boundaryOutcome(t, boundaryContrast(field({ border: [0xdd, 0xdd, 0xdd] }), BOXF))).toEqual({
      kind: 'failed', detail: 'A form field’s boundary has 1.3:1 contrast with the colors next to it (edge #dddddd between #ffffff outside and #ffffff inside); at least 3:1 is needed to see the control: “Email”',
    });
    expect(boundaryOutcome(t, boundaryContrast(field({ border: [0x76, 0x76, 0x76] }), BOXF))).toEqual({ kind: 'ok' });
    expect(boundaryOutcome(t, boundaryContrast(field({ border: [0x59, 0x59, 0x59], sides: 'b' }), BOXF))).toEqual({ kind: 'ok' });
    expect(boundaryOutcome(t, boundaryContrast(field({ ring: [0x76, 0x76, 0x76] }), BOXF))).toEqual({ kind: 'ok' });
  });

  it('a fill is a boundary too: a pale fill fails, a light field on a dark page does not', () => {
    const pale = boundaryContrast(field({ fill: [0xee, 0xee, 0xee] }), BOXF);
    expect(pale).toMatchObject({ by: 'fill', marked: true });
    expect(boundaryOutcome(t, pale)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('(fill #eeeeee on #ffffff)') });
    expect(boundaryOutcome(t, boundaryContrast(field({ page: [0x33, 0x33, 0x33], fill: [0xe8, 0xe8, 0xe8] }), BOXF))).toEqual({ kind: 'ok' });
  });

  it('a field nothing marks is not failed (WCAG does not require a boundary); busy surroundings are not measured', () => {
    expect(boundaryContrast(field({}), BOXF)).toMatchObject({ marked: false });
    expect(boundaryOutcome(t, boundaryContrast(field({}), BOXF))).toEqual({ kind: 'ok' });
    expect(boundaryContrast(field({ busy: true, border: [0xdd, 0xdd, 0xdd] }), BOXF)).toMatchObject({ measurable: false });
    expect(boundaryOutcome(t, boundaryContrast(field({ busy: true }), BOXF))).toEqual({ kind: 'unmeasured', reason: 'busy' });
  });

  it('icons: the strongest pixels count, so thin anti-aliased strokes are not failed; a pale icon is', () => {
    const icon = (c: Rgb, thin = false) => image((x, y) => mix(WHITE, c, stems(x, y, thin ? 1 : 1) * (thin ? (x % 5 === 2 ? 1 : 0.3) : 1)));
    const pale = changeContrast(image(() => WHITE), icon([0xcc, 0xcc, 0xcc]), BOX);
    expect(pale.ratio).toBeCloseTo(contrastRatio([0xcc, 0xcc, 0xcc], WHITE), 5);
    expect(iconOutcome({ name: 'Close', graphic: 'svg' }, pale)).toEqual({
      kind: 'failed', detail: 'The icon of an icon-only control (svg) has 1.6:1 contrast with the color behind it (#cccccc on #ffffff); at least 3:1 is needed to make it out: “Close”',
    });
    expect(iconOutcome({ name: 'Add' }, changeContrast(image(() => WHITE), icon([0x59, 0x59, 0x59], true), BOX))).toEqual({ kind: 'ok' });
    expect(iconOutcome({ name: 'Info' }, changeContrast(image(() => WHITE), image(() => WHITE), BOX))).toEqual({ kind: 'unmeasured', reason: 'no-icon' });
  });
});

// --- Probe bookkeeping -------------------------------------------------------------------------------

describe('the text-contrast probe’s inputs and findings', () => {
  const node = (target: string, viewports: ('desktop' | 'mobile')[], summary?: string) => ({ target, html: '', viewports, ...(summary ? { failureSummary: summary } : {}) });
  it('measures phone-only elements at the audit’s phone viewport', () => {
    expect(MOBILE_VIEWPORT).toEqual({ width: VIEWPORTS[1]!.width, height: VIEWPORTS[1]!.height });
    expect(VIEWPORTS[1]!.name).toBe('mobile');
  });

  it('takes axe’s undecided color-contrast elements once each, desktop first', () => {
    const incomplete: Finding[] = [
      { id: 'link-in-text-block', help: '', helpUrl: '', nodes: [node('#a', ['desktop'])] },
      { id: 'color-contrast', help: '', helpUrl: '', nodes: [node('#m', ['mobile']), node('#d', ['desktop', 'mobile'], 'background image'), node('#d', ['desktop'])] },
    ];
    expect(undecidedTexts(incomplete)).toEqual([
      { target: '#d', summary: 'background image', mobileOnly: false }, { target: '#m', mobileOnly: true },
    ]);
    expect(['gradient', 'background image', 'partially obscured', 'pseudo element', '', 'text-shadow'].map((s) => axeReason(`Element's background color could not be determined due to a ${s}`)))
      .toEqual(['a gradient', 'a background image', 'overlapping content', 'a pseudo-element', 'a background axe could not read', 'a text shadow']);
  });

  it('one failed finding per element, a not_testable summary when over a third of the shown text is unmeasured, and nothing for text nobody sees', () => {
    const failed = { kind: 'failed', ratio: 2.04, threshold: 4.5, fg: [0xaa, 0xaa, 0xaa], bg: [0xf2, 0xf2, 0xf2], dominant: [0xfb, 0xfb, 0xfb], confirmed: true, pixels: 100 } as const;
    const items: TextItem[] = [
      { target: '#a', summary: 'gradient', text: 'Hello', fontSize: 16, outcome: { kind: 'verdict', verdict: failed } },
      { target: '#b', outcome: { kind: 'verdict', verdict: { ...failed, kind: 'ok', ratio: 7 } } },
      { target: '#c', outcome: { kind: 'unmeasured', reason: 'moving' } },
      { target: '#d', outcome: { kind: 'unmeasured', reason: 'moving' } },
      { target: '#e', outcome: { kind: 'unmeasured', reason: 'frame' } },
      { target: '#f', outcome: { kind: 'unseen' } },
      { target: '#g', outcome: { kind: 'unshown', reason: 'clipped' } },
    ];
    expect(textContrastFindings(items)).toEqual([
      { criterion: '1.4.3', status: 'failed', target: '#a', data: { kind: 'backdrop' }, detail: 'Text contrast is 2.0:1 where it sits on a gradient (text #aaaaaa on #f2f2f2, mostly #fbfbfb); 16 px text needs at least 4.5:1: “Hello”' },
      { criterion: '1.4.3', status: 'not_testable', target: '#c', detail: expect.stringMatching(/^axe could not decide the contrast of 6 text elements here; 2 measured from screenshots; 3 shown elements could not be: 2 because .*; 1 element not shown/) },
    ]);
    const ok = { ...failed, kind: 'ok', ratio: 7 } as const;
    const v = (target: string): TextItem => ({ target, outcome: { kind: 'verdict', verdict: ok } });
    const moving = (target: string): TextItem => ({ target, outcome: { kind: 'unmeasured', reason: 'moving' } });
    const hidden = (target: string): TextItem => ({ target, outcome: { kind: 'unshown', reason: 'covered' } });
    // A third unmeasured (1 of 3 shown) is not over a third: no failures found, with the counts.
    expect(textContrastFindings([v('#a'), v('#b'), moving('#c'), hidden('#d')])).toEqual([{ criterion: '1.4.3', status: 'no_failures_found', detail: expect.stringMatching(/1 shown element could not be/) }]);
    expect(textContrastFindings([v('#a'), moving('#b'), moving('#c')]).map((f) => f.status)).toEqual(['not_testable']);
    // Everything shown measured and clean: nothing to say.
    expect(textContrastFindings([v('#a'), v('#b')])).toEqual([]);
    // A failure with a few unmeasured elements: only the failure.
    expect(textContrastFindings([{ target: '#x', outcome: { kind: 'verdict', verdict: failed } }, v('#a'), moving('#c')]).map((f) => f.status)).toEqual(['failed']);
    // Nothing shown at all: checked; but nothing found at all is not testable.
    const missing = (target: string): TextItem => ({ target, outcome: { kind: 'unshown', reason: 'missing' } });
    expect(textContrastFindings([hidden('#d'), missing('#e')])).toEqual([{ criterion: '1.4.3', status: 'no_failures_found', detail: 'the text axe could not decide is not shown on the page' }]);
    expect(textContrastFindings([missing('#e'), missing('#f')]).map((f) => f.status)).toEqual(['not_testable']);
    expect(textContrastFindings([{ target: '#f', outcome: { kind: 'unseen' } }])).toEqual([{ criterion: '1.4.3', status: 'no_failures_found', detail: 'the text axe could not decide is not shown on the page' }]);
  });

  it('text the time box left unmeasured makes a clean page not testable, whatever its share; failures stand', () => {
    const ok = { kind: 'ok', ratio: 7, threshold: 4.5, fg: [0, 0, 0], bg: [255, 255, 255], dominant: [255, 255, 255], confirmed: true, pixels: 100 } as const;
    const v = (target: string): TextItem => ({ target, outcome: { kind: 'verdict', verdict: ok } });
    const late = (target: string): TextItem => ({ target, outcome: { kind: 'unmeasured', reason: 'time' } });
    const measured = Array.from({ length: 9 }, (_, i) => v(`#m${i}`));
    expect(textContrastFindings([...measured, late('#x')]).map((f) => f.status)).toEqual(['not_testable']);
    const failed = { ...ok, kind: 'failed', ratio: 2 } as const;
    expect(textContrastFindings([{ target: '#f', outcome: { kind: 'verdict', verdict: failed } }, ...measured, late('#x')]).map((f) => f.status)).toEqual(['failed', 'not_testable']);
  });

  it('text past the fixed number of places measured is not measured, and says so', () => {
    const ok = { kind: 'ok', ratio: 7, threshold: 4.5, fg: [0, 0, 0], bg: [255, 255, 255], dominant: [255, 255, 255], confirmed: true, pixels: 100 } as const;
    const v = (target: string): TextItem => ({ target, outcome: { kind: 'verdict', verdict: ok } });
    const far = (target: string): TextItem => ({ target, outcome: { kind: 'unmeasured', reason: 'limit' } });
    const [f] = textContrastFindings([v('#a'), v('#b'), far('#c')]);
    expect(f).toEqual({ criterion: '1.4.3', status: 'no_failures_found', detail: expect.stringContaining(`1 because it is further down the page than the ${TEXT_CONTRAST_LIMITS.positions} places the test measures`) });
    expect(textContrastFindings([v('#a'), far('#b'), far('#c')]).map((x) => x.status)).toEqual(['not_testable']);
  });
});

describe('what the request guard stopped', () => {
  const log = (events: GuardEvent[]): GuardLog => ({ events, mark: () => 0, since: (m) => events.slice(m) });
  const failed = [{ criterion: '1.4.3', status: 'failed' as const, detail: 'x' }];
  const nav: GuardEvent = { kind: 'navigation', url: 'https://e.org/other', at: 1 };
  const post: GuardEvent = { kind: 'blocked', url: 'https://e.org/api', method: 'POST', resourceType: 'fetch', reason: 'method', at: 1 };
  const beacon: GuardEvent = { ...post, resourceType: 'beacon' };
  it('a held navigation makes the page not testable; a blocked request only a clean result; beacons never', () => {
    expect(() => guarded({ guard: log([nav]) }, 0, failed)).toThrow(/tried to go to another address/);
    expect(guarded({ guard: log([post]) }, 0, failed)).toEqual(failed);
    expect(() => guarded({ guard: log([post]) }, 0, [])).toThrow(/would have sent data to the live site/);
    expect(guarded({ guard: log([beacon]) }, 0, [])).toEqual([]);
    // Styles (the link test) cannot change through a blocked request.
    expect(guarded({ guard: log([post]) }, 0, [], true)).toEqual([]);
    expect(() => guarded({ guard: log([nav]) }, 0, [], true)).toThrow(/another address/);
  });
});

describe('batches of element screenshots', () => {
  const item = (ref: number, boxes: [number, number, number, number][], over: Partial<ViewItem> = {}): ViewItem => ({ ref, boxes, outside: 0, covered: false, ...over });
  const view = { w: 1280, h: 900 };
  it('takes the first element and every other one fully in view that does not overlap; the first with nothing in view is gone', () => {
    const r = pickBatch([item(1, [[10, 10, 100, 20]]), item(2, [[10, 25, 100, 20]]), item(3, [[10, 200, 50, 20]]), item(4, [[10, 880, 50, 40]], { outside: 0.5 })], view);
    expect(r.batch.map((b) => b.ref)).toEqual([1, 3]);
    expect(r.clip).toEqual([6, 6, 108, 218]);
    expect(pickBatch([item(1, [], { cause: 'offpage' }), item(2, [[0, 0, 5, 5]])], view)).toEqual({ batch: [], clip: null, gone: item(1, [], { cause: 'offpage' }) });
  });

  it('clips stay inside the viewport and map to screenshot pixels at any scale', () => {
    expect(clipAround([[-5, 890, 20, 30]], view, 4)).toEqual([0, 886, 19, 14]);
    expect(clipAround([], view)).toBeNull();
    expect(toImageBoxes([[20, 30, 10, 5]], [10, 20, 100, 50], { width: 200, height: 100 })).toEqual([[20, 20, 20, 10]]);
  });

  /** A page whose elements sit one screen apart: every element is a batch of its own. */
  const spread = (n: number, callMs = 0) => {
    const calls: string[] = [];
    const page = {
      async evaluate(fn: { name: string }, arg: { refs: number[]; first: number }) {
        calls.push(fn.name);
        if (callMs) await new Promise((r) => setTimeout(r, callMs));
        return { w: 1280, h: 900, sx: 0, sy: arg.first * 900, items: arg.refs.map((ref) => item(ref, ref === arg.first ? [[10, 10, 100, 20]] : [], ref === arg.first ? {} : { outside: 1, cause: 'clipped' })) };
      },
    };
    return { page: page as never, calls, refs: Array.from({ length: n }, (_, i) => i) };
  };
  const opts = (over: Partial<Parameters<typeof eachBatch>[2]> = {}) => ({ mode: 'text' as const, margin: 4, deadline: Date.now() + 60_000, reserveMs: 1000, signal: new AbortController().signal, ...over });

  it('measures at most a fixed number of places, whatever the time left: the rest are left, as the limit', async () => {
    const { page, refs } = spread(20);
    const measured: number[] = [];
    const r = await eachBatch(page, refs, opts({ maxBatches: 12 }), async (b, _clip, at) => { measured.push(b[0]!.ref); expect(at).toEqual({ x: 0, y: b[0]!.ref * 900 }); }, () => {});
    expect(measured).toEqual(refs.slice(0, 12));
    expect(r).toEqual({ left: refs.slice(12), cut: 'limit', batches: 12 });
    const all = await eachBatch(spread(5).page, [0, 1, 2, 3, 4], opts({ maxBatches: 12 }), async () => {}, () => {});
    expect(all).toEqual({ left: [], batches: 5 });
  });

  it('does not start a batch that would not end before the reserve (the longest batch so far as the measure)', async () => {
    const { page, refs } = spread(10);
    const measured: number[] = [];
    const t0 = Date.now();
    // Each batch takes ~300 ms; 1 s before the reserve leaves room for 3, not a 4th that would end late.
    const r = await eachBatch(page, refs, opts({ deadline: t0 + 2000, reserveMs: 1000 }), async (b) => { measured.push(b[0]!.ref); await new Promise((res) => setTimeout(res, 300)); }, () => {});
    expect(Date.now()).toBeLessThan(t0 + 1000 + 50);
    expect(r.cut).toBe('time');
    expect(measured.length).toBeGreaterThanOrEqual(2);
    expect(measured.length).toBeLessThanOrEqual(3);
  });

  it('takes a screenshot with one CDP call, the clip moved into document coordinates; falls back to Playwright without an image', async () => {
    const image = png(2, 1, 2, [[1, 2, 3, 4, 5, 6]]);
    const sent: unknown[] = [];
    let shots = 0;
    const page = { async screenshot() { shots++; return image; } } as never;
    const cdp = { async send(method: string, params: unknown) { sent.push({ method, params }); return { data: Buffer.from(image).toString('base64') }; }, on() {} };
    const a = await shoot(page, [10, 20, 2, 1], { cdp, at: { x: 0, y: 900 } });
    expect([...a.data.slice(0, 4)]).toEqual([1, 2, 3, 255]);
    expect(sent).toEqual([{ method: 'Page.captureScreenshot', params: expect.objectContaining({ format: 'png', clip: { x: 10, y: 920, width: 2, height: 1, scale: 1 }, captureBeyondViewport: false }) }]);
    expect(shots).toBe(0);
    const empty = { async send() { return {}; }, on() {} };
    await shoot(page, [10, 20, 2, 1], { cdp: empty, at: { x: 0, y: 0 } });
    await shoot(page, [10, 20, 2, 1]);
    expect(shots).toBe(2);
  });
});

describe('non-text and link findings', () => {
  const target = (ref: number, kind: NonTextTarget['kind']): NonTextTarget => ({ ref, kind, path: `#c${ref}`, name: '', y: ref });
  it('one finding per failure, one not_testable with the reasons; not applicable without controls', () => {
    expect(nonTextFindings([
      { target: target(1, 'field'), outcome: { kind: 'failed', detail: 'boundary' } },
      { target: target(2, 'icon'), outcome: { kind: 'unmeasured', reason: 'busy' } },
      { target: target(3, 'icon'), outcome: { kind: 'ok' } },
      { target: target(4, 'icon'), outcome: { kind: 'unseen' } },
    ], 0)).toEqual([
      { criterion: '1.4.11', status: 'failed', target: '#c1', detail: 'boundary' },
      { criterion: '1.4.11', status: 'not_testable', target: '#c2', detail: '1 control of 3 could not be measured: 1 because the colors around it vary too much to compare with (an image or other content right next to it)' },
    ]);
    // Review r1 of fix/redteam-visual, finding 10: nothing found at the phone width is dropped, and a phone width that was not looked at is never clean.
    expect(nonTextFindings([{ target: target(7, 'icon'), outcome: { kind: 'unmeasured', reason: 'busy' }, phone: true }], 0)).toEqual([
      expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('1 because the colors around it vary too much to compare with (an image or other content right next to it) (at the phone width)') }),
    ]);
    expect(nonTextFindings([], 0, 'the time for this test ran out first')).toEqual([{ criterion: '1.4.11', status: 'not_testable', detail: 'Not tested at the phone width: the time for this test ran out first' }]);
    expect(nonTextFindings([{ target: target(8, 'field'), outcome: { kind: 'ok' } }], 0, 'the time for this test ran out first')).toEqual([{ criterion: '1.4.11', status: 'not_testable', detail: 'Not tested at the phone width: the time for this test ran out first' }]);
    expect(phoneOutcome({ kind: 'unmeasured', reason: 'moving' })).toEqual({ kind: 'unmeasured', reason: 'moving' });
    expect(phoneOutcome(undefined)).toEqual({ kind: 'unmeasured', reason: 'time' });
    expect(nonTextFindings([], 3)).toEqual([{ criterion: '1.4.11', status: 'not_applicable', detail: 'no styled form fields or icon-only controls on the page (3 controls with the browser’s own look or disabled, which are exempt)' }]);
  });

  it('link colors: see-through colors cannot be compared; findings say which cue is missing', () => {
    const link = { text: 'hours', href: 'https://e.org/#h', context: 'Read the hours', linkColor: '', textColor: '', contrastWithText: 1.4, box: [0, 0, 1, 1] as [number, number, number, number] };
    expect(linkContrast({ ...link, linkRgba: [77, 77, 77, 1], textRgba: [51, 51, 51, 1] })).toBeCloseTo(contrastRatio([77, 77, 77], [51, 51, 51]), 6);
    expect(linkContrast({ ...link, linkRgba: [77, 77, 77, 0.5], textRgba: [51, 51, 51, 1] })).toBeNull();
    const l = { ...link, linkRgba: [77, 77, 77, 1] as [number, number, number, number], textRgba: [51, 51, 51, 1] as [number, number, number, number] };
    const f = linkColorFindings([
      { link: l, ratio: 1.45, outcome: { kind: 'failed', hoverCue: true, focusCue: false } },
      { link: l, ratio: 1.45, outcome: { kind: 'failed', hoverCue: null, focusCue: false } },
      { link: l, ratio: 1.45, outcome: { kind: 'failed', hoverCue: false, focusCue: true } },
      { link: l, ratio: null, outcome: { kind: 'unmeasured', reason: 'translucent' } },
    ], 4);
    expect(f.map((x) => x.detail.replace(/^.*\), and /, ''))).toEqual([
      'focusing it adds no other cue: “hours” in “Read the hours”', 'focusing it adds no other cue: “hours” in “Read the hours”',
      'pointing at it adds no other cue: “hours” in “Read the hours”',
      '1 of 4 links told apart only by a color close to the text could not be tested: 1 because its color or the text color is see-through, so the colors on screen are not known',
    ]);
    expect(linkColorFindings([], 0)).toEqual([{ criterion: '1.4.1', status: 'not_applicable', detail: 'no links in running text told apart only by color' }]);
  });
});

describe('registration', () => {
  it('the three contrast probes are core, in the registry, and declared by their criteria', () => {
    const ids = { 'text-contrast': '1.4.3', 'non-text-contrast': '1.4.11', 'link-color': '1.4.1' } as const;
    for (const [id, criterion] of Object.entries(ids)) {
      const p = PROBES.find((x) => x.id === id)!;
      expect(p, id).toMatchObject({ tier: 'core', criteria: [criterion] });
      expect(CRITERIA.find((c) => c.criterion === criterion)!.methods).toContain(`probe:${id}`);
    }
  });
});
