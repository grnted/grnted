// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The pure parts of the forced-colours probe (plan item C13): when something "disappears" (visible
// before, one colour under forced colours), on synthetic screenshots, and the findings it gives.
import { describe, expect, it } from 'vitest';
import { forcedColorsFindings, forcedColorsProbe, vanished, VANISH } from '../../src/probes/forcedColors.js';
import { boxPixels, type RgbaImage } from '../../src/probes/pixels.js';
import { PROBES, SCORED_PROBES } from '../../src/probes/registry.js';

type Rgb = [number, number, number];
/** A w×h image of `bg` with a square of `fg` (side `s`) in the middle. */
function img(w: number, h: number, bg: Rgb, fg?: Rgb, s = 6): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  const x0 = Math.floor((w - s) / 2);
  const y0 = Math.floor((h - s) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fg && x >= x0 && x < x0 + s && y >= y0 && y < y0 + s ? fg : bg;
      data.set([...c, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}
const all = (i: RgbaImage) => boxPixels(i, [[0, 0, i.width, i.height]]);
const WHITE: Rgb = [255, 255, 255];
const BLUE: Rgb = [11, 79, 179];

describe('vanished: visible before, one color after', () => {
  it('a white icon on a blue button that becomes white on white disappears', () => {
    const before = img(20, 20, BLUE, WHITE);
    const after = img(20, 20, WHITE);
    expect(vanished(before, after, all(before))).toMatchObject({ gone: true });
  });

  it('an icon that stays visible in another color has not disappeared', () => {
    expect(vanished(img(20, 20, BLUE, WHITE), img(20, 20, WHITE, [0, 0, 0]), all(img(20, 20, WHITE))).gone).toBe(false);
  });

  it('anti-aliasing or a faint trace (a few pixels, or a color a few levels off) still counts as gone; a distinct color does not', () => {
    const before = img(20, 20, BLUE, WHITE);
    const speck = img(20, 20, WHITE, [0, 0, 0], 1);
    expect(vanished(before, speck, all(before)).gone).toBe(true);
    const faint = img(20, 20, [0, 0, 0], [10, 10, 10]);
    expect(vanished(before, faint, all(before)).gone).toBe(true);
    const dim = img(20, 20, [0, 0, 0], [60, 60, 60]);
    expect(vanished(before, dim, all(before)).gone).toBe(false);
  });

  it('nothing to lose: a control that showed nothing before (or too little to see) never disappears', () => {
    const flat = img(20, 20, WHITE);
    expect(vanished(flat, flat, all(flat)).gone).toBe(false);
    // A light grey square on white (1.2:1) was not visible enough before to call its loss a disappearance.
    expect(vanished(img(20, 20, WHITE, [230, 230, 230]), flat, all(flat)).gone).toBe(false);
    // Fewer pixels than an icon has.
    expect(vanished(img(20, 20, WHITE, [0, 0, 0], 2), flat, all(flat)).gone).toBe(false);
    expect(VANISH.minVisible).toBeGreaterThan(4);
  });

  it('images of different sizes are never compared', () => {
    expect(vanished(img(20, 20, BLUE, WHITE), img(21, 20, WHITE), all(img(20, 20, WHITE))).gone).toBe(false);
  });

  it('hostile input stays linear: a full-viewport area is measured in one pass', () => {
    const big = img(1280, 900, BLUE, WHITE, 400);
    const flat = img(1280, 900, WHITE);
    const t0 = Date.now();
    expect(vanished(big, flat, all(big)).gone).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('findings', () => {
  it('names the theme and the control, and says not applicable when there was nothing to test', () => {
    const f = forcedColorsFindings({
      controls: { found: 1, measured: 1, items: [{ target: '#s', kind: 'icon', graphic: 'svg', name: 'Search', palettes: ['light'] }] },
      texts: { found: 0, measured: 0, items: [] },
      focus: { stops: 0, compared: 0, items: [] },
    });
    expect(f).toEqual([
      { criterion: '1.4.11', status: 'no_failures_found', advice: true, target: '#s', detail: 'An icon-only control (svg) disappears in a light contrast theme (forced colors): its icon turns the color of the background, so nothing of it shows; in normal colors it shows. A forced-colors rule (an outline, or a system color for the icon) keeps it in contrast themes too: “Search”' },
      { criterion: '1.4.3', status: 'not_applicable', detail: expect.any(String) },
      { criterion: '2.4.7', status: 'not_applicable', detail: expect.any(String) },
    ]);
  });

  // Batch 19 (precision lane, real-site dev split; the lead's ruling D3): in forced colors the user agent's theme draws the
  // page, and 1.4.11 excepts an appearance "determined by the user agent and not modified by the author": a disappearance
  // is a recommendation, never a failure of 1.4.11 or 1.4.3.
  it('a disappearance in a contrast theme is a recommendation, never a failure', () => {
    const f = forcedColorsFindings({
      controls: { found: 2, measured: 2, items: [{ target: '#i', kind: 'icon', graphic: 'background', name: 'Facebook', palettes: ['light'] }, { target: '#c', kind: 'toggle', name: '', palettes: ['dark'] }] },
      texts: { found: 1, measured: 1, items: [{ target: '#t', text: 'Open house', palettes: ['light', 'dark'] }] },
      focus: { stops: 1, compared: 1, items: [] },
    });
    expect(f.filter((x) => x.status === 'failed')).toEqual([]);
    for (const t of ['#i', '#c', '#t']) expect(f.find((x) => x.target === t), t).toMatchObject({ status: 'no_failures_found', advice: true });
  });

  it('controls found but none measured is not testable; some measured gives their results only', () => {
    const none = forcedColorsFindings({ controls: { found: 3, measured: 0, items: [] }, texts: { found: 0, measured: 0, items: [] }, focus: { stops: 2, compared: 1, items: [] } });
    expect(none.map((f) => [f.criterion, f.status])).toEqual([['1.4.11', 'not_testable'], ['1.4.3', 'not_applicable']]);
    const some = forcedColorsFindings({ controls: { found: 3, measured: 1, items: [] }, texts: { found: 0, measured: 0, items: [] }, focus: { stops: 2, compared: 1, items: [] } });
    expect(some.map((f) => f.criterion)).toEqual(['1.4.3']);
  });

  it('copy is plain and confident', () => {
    const f = forcedColorsFindings({
      controls: { found: 1, measured: 1, items: [{ target: '#b', kind: 'toggle', name: '', palettes: ['light', 'dark'] }] },
      texts: { found: 1, measured: 1, items: [{ target: '#t', text: 'Open house', palettes: ['dark'] }] },
      focus: { stops: 1, compared: 1, items: [{ target: '#a', name: 'News', palettes: ['dark'] }] },
    });
    for (const x of f) expect(x.detail).not.toMatch(/need to|compliant|fair use/i);
    // 2.4.7 in a contrast theme only: a recommendation (W3C precision lane, 2026-11-11).
    expect(f.find((x) => x.target === '#a')).toMatchObject({ criterion: '2.4.7', status: 'no_failures_found', advice: true });
    expect(f.find((x) => x.target === '#b')!.detail).toMatch(/^A custom checkbox or radio button disappears in light and dark contrast themes/);
  });
});

describe('registration', () => {
  it('is a deep test on a page of its own, listed but not scored until the gold standard proves it', () => {
    expect(PROBES).toContain(forcedColorsProbe);
    expect(forcedColorsProbe).toMatchObject({ id: 'forced-colors', tier: 'deep', isolate: true, scored: false, criteria: ['1.4.3', '1.4.11', '2.4.7'] });
    expect(SCORED_PROBES.has('forced-colors')).toBe(false);
  });
});
