// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Plan 5 Task 5.8: follow-ups from the first real report. Pure parts: which of a rule's targets share
// one image, the crop around a probe's boxes, the AI thumbnail's alt text and the resize-text wording.
import { describe, expect, it } from 'vitest';
import { aiAlt } from '../../src/evidence/capture.js';
import { chooseTargets, type TargetCandidate } from '../../src/evidence/fit.js';
import { MAX_CANDIDATES, MAX_TARGETS } from '../../src/evidence/select.js';
import { cropAround } from '../../src/probes/evidence.js';
import { zoomSizeWords } from '../../src/probes/resizeText.js';

const MAX = { width: 1280, height: 900 };
const PAD = 24;
const cand = (x: number, y: number, w: number, h: number, text = true): TargetCandidate => ({ x0: x, y0: y, x1: x + w, y1: y + h, text });

describe('which targets share one image', () => {
  it('keeps them all when they fit one clip together', () => {
    expect(chooseTargets([cand(10, 10, 100, 40), cand(200, 300, 100, 40), cand(400, 600, 100, 40)], PAD, MAX)).toEqual([0, 1, 2]);
  });

  it('takes the largest group that fits: two big cards far down beat a logo at the top', () => {
    // The real case: the logo link (no visible text) at the top, two 380×500 school cards ~1800 px down.
    const logo = cand(24, 20, 200, 60, false);
    const card1 = cand(100, 1800, 380, 500);
    const card2 = cand(520, 1800, 380, 500);
    expect(chooseTargets([logo, card1, card2], PAD, MAX)).toEqual([1, 2]);
  });

  it('breaks a tie by visible text, then by larger painted area, then by order', () => {
    const icon = cand(10, 10, 300, 300, false);
    const small = cand(10, 2000, 40, 20);
    const big = cand(10, 4000, 400, 200);
    // One target per image: text first (both have text), then area.
    expect(chooseTargets([icon, small, big], PAD, MAX)).toEqual([2]);
    // Without text anywhere, the larger area wins.
    expect(chooseTargets([cand(10, 10, 40, 20, false), cand(10, 3000, 400, 200, false)], PAD, MAX)).toEqual([1]);
    // Same everything: the first.
    expect(chooseTargets([cand(10, 10, 40, 20), cand(10, 3000, 40, 20)], PAD, MAX)).toEqual([0]);
  });

  it('never more than 3, and deterministic', () => {
    const many = Array.from({ length: MAX_CANDIDATES }, (_, i) => cand(10 + i * 100, 10, 80, 30));
    const got = chooseTargets(many, PAD, MAX);
    expect(got).toHaveLength(MAX_TARGETS);
    expect(chooseTargets(many, PAD, MAX)).toEqual(got);
    expect(got).toEqual([0, 1, 2]);
  });

  it('keeps one target that is larger than a clip on its own; nothing for no candidates', () => {
    expect(chooseTargets([cand(0, 0, 3000, 5000)], PAD, MAX)).toEqual([0]);
    expect(chooseTargets([], PAD, MAX)).toEqual([]);
  });

  it('a pair that fits only without padding does not fit', () => {
    // 1280 - 2×24 = 1232 wide at most.
    expect(chooseTargets([cand(0, 0, 100, 30), cand(1132, 0, 100, 30)], PAD, MAX)).toEqual([0, 1]);
    expect(chooseTargets([cand(0, 0, 100, 30), cand(1133, 0, 100, 30)], PAD, MAX)).toEqual([0]);
  });
});

describe('the crop around a probe image\'s boxes', () => {
  const VIEW = { width: 1280, height: 900 };
  const within = (c: { x: number; y: number; width: number; height: number }) => {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.width).toBeLessThanOrEqual(VIEW.width);
    expect(c.y + c.height).toBeLessThanOrEqual(VIEW.height);
    for (const v of [c.x, c.y, c.width, c.height]) expect(Number.isInteger(v)).toBe(true);
  };

  it('is the union of the boxes with 48 px padding, at least 640×240', () => {
    const c = cropAround([{ x: 600, y: 400, width: 40, height: 20 }], VIEW)!;
    expect([c.width, c.height]).toEqual([640, 240]);
    // Centred on the box.
    expect(c.x + c.width / 2).toBeCloseTo(620, 0);
    expect(c.y + c.height / 2).toBeCloseTo(410, 0);
    within(c);
    const d = cropAround([{ x: 100, y: 100, width: 700, height: 300 }, { x: 300, y: 500, width: 200, height: 50 }], VIEW)!;
    expect(d).toEqual({ x: 52, y: 52, width: 796, height: 546 });
  });

  it('a full-width header and a link under it: full width, short', () => {
    const c = cropAround([{ x: 0, y: 0, width: 1280, height: 92 }, { x: 24, y: 40, width: 120, height: 24 }], VIEW)!;
    expect(c).toEqual({ x: 0, y: 0, width: 1280, height: 240 });
  });

  it('stays inside the viewport near its edges and never exceeds 1280×900 or the viewport', () => {
    within(cropAround([{ x: 1270, y: 890, width: 10, height: 10 }], VIEW)!);
    within(cropAround([{ x: -50, y: -30, width: 100, height: 60 }], VIEW)!);
    const all = cropAround([{ x: -100, y: -100, width: 3000, height: 3000 }], VIEW)!;
    expect(all).toEqual({ x: 0, y: 0, width: 1280, height: 900 });
    // A fractional viewport (a zoomed page): still inside it, whole pixels.
    const frac = { width: 1264.5, height: 700.5 };
    const f = cropAround([{ x: 1250, y: 690, width: 10, height: 10 }], frac)!;
    expect(f.x + f.width).toBeLessThanOrEqual(frac.width);
    expect(f.y + f.height).toBeLessThanOrEqual(frac.height);
    expect([f.x, f.y, f.width, f.height].every(Number.isInteger)).toBe(true);
    const small = { width: 500, height: 200 };
    expect(cropAround([{ x: 10, y: 10, width: 20, height: 20 }], small)).toEqual({ x: 0, y: 0, width: 500, height: 200 });
  });

  it('takes a given width (the pair lines up side by side), clamped to the viewport', () => {
    const c = cropAround([{ x: 600, y: 400, width: 40, height: 20 }], VIEW, { width: 1280 })!;
    expect([c.x, c.width, c.height]).toEqual([0, 1280, 240]);
    const d = cropAround([{ x: 600, y: 400, width: 40, height: 20 }], VIEW, { width: 5000 })!;
    expect(d.width).toBe(1280);
    // A box wider than the given width still fits.
    const e = cropAround([{ x: 100, y: 400, width: 900, height: 20 }], VIEW, { width: 640 })!;
    expect(e.width).toBeGreaterThanOrEqual(900 + 96);
    within(e);
    // A given width below 640 (a 2.4.11 crop around a small hidden link, Task 5.10) is kept, so the pair still lines up.
    const f = cropAround([{ x: 24, y: 400, width: 45, height: 24 }], VIEW, { width: 369 })!;
    expect(f.width).toBe(369);
    within(f);
  });

  it('null for no boxes, bad numbers or boxes entirely outside the viewport', () => {
    expect(cropAround([], VIEW)).toBeNull();
    expect(cropAround([{ x: Number.NaN, y: 0, width: 10, height: 10 }], VIEW)).toBeNull();
    expect(cropAround([{ x: 2000, y: 0, width: 10, height: 10 }], VIEW)).toBeNull();
    expect(cropAround([{ x: 10, y: 10, width: 0, height: 10 }], VIEW)).toBeNull();
  });
});

describe('AI thumbnail alt text', () => {
  const page = 'https://e.org/schools/';
  const target = 'https://cdn.e.org/img/ci-a836f00d.webp?w=640';

  it('uses the image\'s own alt text, quoted and trimmed to 120 characters', () => {
    expect(aiAlt(page, { target, alt: '  Students at   the science fair ' })).toBe('Page /schools/: the image with the alt text “Students at the science fair”, which the AI review flagged');
    const long = aiAlt(page, { target, alt: 'x'.repeat(400) });
    expect(long).toContain(`“${'x'.repeat(119)}…”`);
  });

  it('falls back to the AI\'s description, then to plain words; never the file name or the address', () => {
    expect(aiAlt(page, { target, alt: '', observed: 'A group of students holding trophies.' }))
      .toBe('Page /schools/: an image the AI review flagged; the AI describes it as “A group of students holding trophies”');
    expect(aiAlt(page, { target })).toBe('An image on the page /schools/ that the AI review flagged');
    expect(aiAlt('https://e.org/', { target })).toBe('An image on the home page that the AI review flagged');
    for (const alt of [aiAlt(page, { target }), aiAlt(page, { target, alt: '   ' }), aiAlt(page, { target, observed: '' })]) {
      expect(alt).not.toMatch(/ci-a836|webp|cdn\.e\.org|https?:/);
    }
  });

  it('skips alt text that is itself a file name or an address, and drops them from the description', () => {
    for (const alt of ['IMG_1234.JPG', 'ci-a836f00d.webp', 'https://cdn.e.org/img/a.png', '/img/photo.jpeg', 'www.e.org/a.gif']) {
      const got = aiAlt(page, { target, alt, observed: 'A photo of a bus.' });
      expect(got, alt).toContain('the AI describes it as “A photo of a bus”');
      expect(got, alt).not.toMatch(/IMG_1234|ci-a836|https?:|\.jpe?g|\.gif|\.png|\.webp/i);
    }
    // An alt text with a file name or an address inside it is not quoted either (never rewritten).
    for (const alt of ['Photo ci-a836f00d.webp of students', 'See www.e.org for more', 'Logo /img/logo-final.svg', 'ci-a836f00d banner']) {
      expect(aiAlt(page, { target, alt }), alt).toBe('An image on the page /schools/ that the AI review flagged');
    }
    // Words with dots or slashes that are not names stay.
    expect(aiAlt(page, { target, alt: 'Before/after, e.g. the 3.5 km route' })).toContain('“Before/after, e.g. the 3.5 km route”');
    const got = aiAlt(page, { target, observed: 'The file ci-a836f00d.webp at https://cdn.e.org/x.png shows a bus.' });
    expect(got).not.toMatch(/ci-a836|https?:|\.png|\.webp/);
    expect(got).toContain('shows a bus');
  });

  it('cleans hostile text: control and direction characters, markup stays text (the report escapes it)', () => {
    const got = aiAlt(page, { target, alt: '<img src=x onerror=alert(1)>‮\u0000 evil\n\tline' });
    expect(got).not.toMatch(/[\u0000-\u001f‮]/);
    expect(got).toContain('“<img src=x onerror=alert(1)> evil line”');
    expect(aiAlt(page, { target, alt: 42 as unknown as string })).toBe('An image on the page /schools/ that the AI review flagged');
  });
});

describe('resize text: what browser zoom did to the text on screen', () => {
  it('says the text got smaller, from the size at 100% to CSS px × 2', () => {
    expect(zoomSizeWords(113, 36)).toBe('gets smaller on screen (113 px → 72 px)');
  });

  it('the same size within ±10%', () => {
    expect(zoomSizeWords(51.2, 25.6)).toBe('stays the same size on screen (51 px → 51 px)');
    expect(zoomSizeWords(100, 45.5)).toBe('stays the same size on screen (100 px → 91 px)');
    expect(zoomSizeWords(100, 55)).toBe('stays the same size on screen (100 px → 110 px)');
  });

  it('grows only a little', () => {
    expect(zoomSizeWords(100, 60)).toBe('grows only 20% on screen (100 px → 120 px)');
  });

  it('plain English: no criterion numbers', () => {
    for (const [b, z] of [[113, 36], [40, 20], [100, 60]] as const) expect(zoomSizeWords(b, z)).not.toMatch(/\d\.\d+\.\d+|viewport units/);
  });
});
