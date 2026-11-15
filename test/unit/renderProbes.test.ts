// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The render probes' pure rules (Plan 4 Task 4.2): what counts as cut off, overlapping, out of reach,
// not enlarged, locked to one orientation, and how failures are worded. Real Chromium runs are in
// test/integration/render.test.ts.
import { describe, expect, it } from 'vitest';
import { HOVER_STEP_PX, hoverContentProbe, hoverDetail, hoverFindings, hoverPath, nearestPointIn, pointerSteps, type HoverResult } from '../../src/probes/hoverContent.js';
import type { GuardEvent } from '../../src/probes/types.js';
import {
  boxesOverlap, cutPlaces, fixedOverflow, goneShare, guardStopped, newlyCut, newOverlaps, overlapPairs, overlapPlaces, pastEdge, placeFindings, placeRefs, pushedOutOfReach, reachableWidth,
  type LayoutDescription, type LayoutItem, type LayoutState, type LayoutView,
} from '../../src/probes/layout.js';
import { orientationFindings, orientationProbe, ROTATE_MESSAGE, swapEvidence, type OrientationFacts } from '../../src/probes/orientation.js';
import { beyondEdge, reflowPlaces, reflowProbe } from '../../src/probes/reflow.js';
import { PROBES } from '../../src/probes/registry.js';
import { largeTextPlaces, notEnlargedPlaces, resizeTextProbe, zoomPlaces } from '../../src/probes/resizeText.js';
import { textSpacingPlaces, textSpacingProbe } from '../../src/probes/textSpacing.js';
import { CRITERIA } from '../../src/report/criteria.js';
import { scanSite } from '../../src/scan.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const VIEW: LayoutView = { w: 1280, h: 900, scrollW: 1280, scrollH: 2000, canScrollX: true, canScrollY: true };
const NARROW: LayoutView = { w: 320, h: 256, scrollW: 320, scrollH: 4000, canScrollX: true, canScrollY: true };
const it_ = (r: number[], extra: Partial<LayoutItem> = {}): LayoutItem => ({ v: 1, r, fs: 16, cut: 0, ...extra });
const state = (items: LayoutItem[], view = VIEW, els: LayoutState['els'] = {}): LayoutState => ({ view, items, els });

describe('layout rules', () => {
  it('counts overlapping text, not lines that merely touch', () => {
    expect(boxesOverlap([0, 0, 100, 18], [0, 16, 100, 18])).toBe(false); // 2 px: tight line height
    expect(boxesOverlap([0, 0, 100, 18], [0, 10, 100, 18])).toBe(true);
    expect(boxesOverlap([0, 0, 100, 18], [98, 0, 100, 18])).toBe(false); // 2 px wide
    expect(boxesOverlap([0, 0, 100, 18], [50, 0, 100, 18])).toBe(true);
  });

  it('finds overlapping pairs of visible text and the ones that are new', () => {
    const kinds = 'tttc';
    const before = state([it_([0, 0, 100, 18]), it_([0, 30, 100, 18]), it_([0, 60, 100, 18]), it_([0, 0, 100, 18])]);
    const after = state([it_([0, 0, 100, 18, 0, 24, 100, 18]), it_([0, 30, 100, 18]), it_([0, 60, 100, 18], { v: 0 }), it_([0, 0, 100, 18])]);
    expect([...overlapPairs(before, kinds)]).toEqual([]);
    expect([...overlapPairs(after, kinds)]).toEqual(['0:1']); // the control (c) and the hidden item never count
    expect(newOverlaps(before, after, kinds)).toEqual([[0, 1]]);
    expect(newOverlaps(after, after, kinds)).toEqual([]);
    expect(newOverlaps(before, after, kinds, (_, i) => i === 1)).toEqual([]);
  });

  it('reports text cut off by the change only when it was not cut off before, and not ellipses on purpose', () => {
    const kinds = 'tttt';
    const before = state([it_([0, 0, 10, 10]), it_([0, 0, 10, 10], { cut: 1, by: 0 }), it_([0, 0, 10, 10]), it_([0, 0, 10, 10])]);
    const after = state([
      it_([0, 0, 10, 10], { cut: 1, by: 0 }), it_([0, 0, 10, 10], { cut: 1, by: 0 }), it_([], { cut: 2, by: 0 }), it_([0, 0, 10, 10], { cut: 1, by: 1 }),
    ], VIEW, { 0: { w: 300, h: 40, ox: 'hidden', oy: 'hidden' }, 1: { w: 300, h: 40, ox: 'hidden', oy: 'hidden', truncates: 1 } });
    expect(newlyCut(before, after, kinds)).toEqual([0, 2]);
    expect(newlyCut(before, after, kinds, { partialOnly: true })).toEqual([0]);
    expect(cutPlaces([0, 2], after)).toEqual([{ kind: 'cut', el: 0, items: [0, 2] }]);
  });

  it('finds content pushed out of the part of the page that can be reached', () => {
    expect(reachableWidth({ ...VIEW, scrollW: 2000 })).toBe(2000);
    expect(reachableWidth({ ...VIEW, scrollW: 2000, canScrollX: false })).toBe(1280);
    expect(pastEdge(it_([1200, 0, 200, 20]), 1281)).toBe(119);
    const before = state([it_([1000, 0, 200, 20]), it_([1000, 0, 200, 20]), it_([1000, 0, 200, 20], { ex: 'scroll' })]);
    const locked = state([it_([1250, 0, 400, 20]), it_([1100, 0, 200, 20]), it_([1250, 0, 400, 20], { ex: 'scroll' })], { ...VIEW, scrollW: 1650, canScrollX: false });
    expect(pushedOutOfReach(before, locked)).toEqual([0]); // more than half outside; the scroll region's content is reachable
    const scrolls = state(locked.items, { ...VIEW, scrollW: 1650 });
    expect(pushedOutOfReach(before, scrolls)).toEqual([]);
  });

  it('words places as findings: target, excerpt, and how many more were left out', () => {
    const desc: LayoutDescription = { items: { 0: { path: '#a > p', text: 'First' }, 1: { path: '#b', text: 'Second' } }, els: { 3: { path: '#box', text: '' } } };
    const places = [{ kind: 'cut', el: 3, items: [0] }, { kind: 'overlap', items: [1, 0] }, { kind: 'cut', items: [1] }];
    expect(placeRefs(places, 2)).toEqual({ items: [0, 1], els: [3] });
    expect(placeFindings('1.4.12', places, desc, (p, t) => `${p.kind} ${t(p.items[0]!)}`, 2)).toEqual([
      { criterion: '1.4.12', status: 'failed', target: '#box', detail: 'cut “First”' },
      { criterion: '1.4.12', status: 'failed', target: '#b', detail: 'overlap “Second” (and 1 more on this page)' },
    ]);
    expect(overlapPlaces([[0, 1], [1, 2], [3, 4]])).toEqual([{ kind: 'overlap', items: [0, 1] }, { kind: 'overlap', items: [3, 4] }]);
  });
});

describe('text spacing and resize text', () => {
  it('text spacing: new cuts per container, then new overlaps', () => {
    const before = state([it_([0, 0, 100, 18]), it_([0, 40, 100, 18])]);
    const after = state([it_([0, 0, 100, 18, 0, 30, 100, 18], { cut: 1, by: 0 }), it_([0, 40, 100, 18])], VIEW, { 0: { w: 100, h: 20, ox: 'hidden', oy: 'hidden' } });
    expect(textSpacingPlaces({ kinds: 'tt', truncated: false, before, after })).toEqual([{ kind: 'cut', el: 0, items: [0] }, { kind: 'overlap', items: [0, 1] }]);
    expect(textSpacingPlaces({ kinds: 'tt', truncated: false, before })).toEqual([]);
  });

  it('resize text: cut, overlap and out-of-reach places, grouped by the overflowing container', () => {
    const before = state([it_([0, 0, 100, 18]), it_([1000, 0, 100, 18]), it_([1100, 0, 100, 18])]);
    const after = state([it_([0, 0, 100, 18], { cut: 1, by: 4 }), it_([1300, 0, 200, 18], { wide: 7 }), it_([1500, 0, 200, 18], { wide: 7 })],
      { ...VIEW, canScrollX: false }, { 4: { w: 100, h: 20, ox: 'hidden', oy: 'hidden' } });
    expect(largeTextPlaces({ kinds: 'ttc', truncated: false, before, after })).toEqual([{ kind: 'cut', el: 4, items: [0] }, { kind: 'reach', el: 7, items: [1, 2] }]);
  });

  it('browser zoom: text whose CSS size halves (viewport units) is not enlarged; breakpoints that shrink a little are fine', () => {
    const base = state([it_([0, 0, 10, 10], { fs: 51.2 }), it_([0, 0, 10, 10], { fs: 18 }), it_([0, 0, 10, 10], { fs: 48 }), it_([0, 0, 10, 10], { fs: 40 })]);
    const zoomed = state([it_([0, 0, 10, 10], { fs: 25.6 }), it_([0, 0, 10, 10], { fs: 16 }), it_([0, 0, 10, 10], { fs: 32 }), it_([], { fs: 20, v: 0 })]);
    expect(notEnlargedPlaces(base, zoomed, 'tttt')).toEqual([{ kind: 'zoom', items: [0] }]);
  });
});

describe('reflow rules', () => {
  it('counts text past the edge, but not exceptions or text positioned off screen on purpose', () => {
    const narrow = state([
      it_([10, 0, 900, 20], { wide: 1 }), // a too-wide container's text
      it_([10, 30, 900, 20], { ex: 'table' }), // data table
      it_([-9999, 0, 150, 20], { pos: 1 }), // skip link off screen
      it_([400, 0, 100, 20], { pos: 1 }), // closed off-canvas menu, entirely off screen
      it_([300, 0, 100, 20], { pos: 1 }), // positioned and straddling the edge
      it_([400, 60, 100, 20]), // in flow past the edge
      it_([10, 90, 100, 20], { cut: 2 }),
    ], NARROW);
    expect(beyondEdge(narrow, 'ttttttt')).toEqual([0, 4, 5]);
    expect(beyondEdge(narrow, 'cttttct')).toEqual([4]);
  });

  it('groups by the too-wide container, adds newly (partly) cut text except in carousels, and new overlaps', () => {
    const base = state([it_([0, 0, 900, 20]), it_([0, 0, 900, 20]), it_([0, 100, 300, 20]), it_([0, 200, 300, 20]), it_([0, 300, 300, 20]), it_([0, 330, 300, 20])]);
    const narrow = state([
      it_([10, 0, 900, 20], { wide: 2 }), it_([10, 30, 900, 20], { wide: 2 }),
      it_([0, 100, 300, 20], { cut: 1, by: 5 }), it_([0, 200, 300, 20], { cut: 1, by: 6 }),
      it_([0, 300, 300, 20]), it_([0, 305, 300, 20]),
    ], NARROW, { 5: { w: 300, h: 10, ox: 'hidden', oy: 'hidden' }, 6: { w: 300, h: 10, ox: 'hidden', oy: 'hidden', carousel: 1 } });
    expect(reflowPlaces(base, narrow, 'tttttt')).toEqual([
      { kind: 'wide', el: 2, items: [0, 1] }, { kind: 'cut', el: 5, items: [2] }, { kind: 'overlap', items: [4, 5] },
    ]);
  });
});

describe('failure modes of the layout rules', () => {
  it('reflow: content moved entirely off the right edge on purpose (positioned or transformed) counts only when the page can scroll to it', () => {
    const locked = { ...NARROW, canScrollX: false };
    const offCanvas = it_([330, 0, 200, 20], { pos: 1 }); // closed off-canvas menu, translated past the edge
    expect(beyondEdge(state([offCanvas], locked), 't')).toEqual([]);
    // The page scrolls sideways onto it: that is horizontal scrolling at 320 px.
    expect(beyondEdge(state([offCanvas], { ...NARROW, scrollW: 600 }), 't')).toEqual([0]);
    // In flow and entirely past the edge where the page cannot scroll: that content is lost.
    expect(beyondEdge(state([it_([330, 0, 200, 20], { wide: 0 })], locked), 't')).toEqual([0]);
  });

  it('reflow: form controls without text of their own count like text; controls with text are counted through their text', () => {
    const narrow = state([it_([10, 0, 600, 30], { wide: 1 }), it_([10, 40, 600, 30], { wide: 1 })], NARROW);
    expect(beyondEdge(narrow, 'bc')).toEqual([0]);
  });

  it('reflow: a line wider than its own sideways-scrolling region fails, except in carousels and exempt content', () => {
    const els = { 3: { w: 288, h: 40, ox: 'auto', oy: 'hidden' }, 4: { w: 288, h: 40, ox: 'auto', oy: 'hidden', carousel: 1 as const } };
    const base = state([it_([0, 0, 300, 20]), it_([0, 30, 300, 20]), it_([0, 60, 300, 20]), it_([0, 90, 300, 20])]);
    const narrow = state([
      it_([16, 0, 288, 20], { ex: 'scroll', hw: 3 }), it_([16, 30, 288, 20], { ex: 'scroll', hw: 3 }),
      it_([16, 60, 288, 20], { ex: 'scroll', hw: 4 }), it_([16, 90, 288, 20], { ex: 'code', hw: 3 }),
    ], NARROW, els);
    expect(reflowPlaces(base, narrow, 'tttt')).toEqual([{ kind: 'hscroll', el: 3, items: [0, 1] }]);
    // Batch 18, round 3: wrapped text (`wl`) wider than a carousel-like region is read line by line sideways: counted.
    const wrapped = state([it_([16, 0, 288, 20], { ex: 'scroll', hw: 4, wl: 1 }), it_([16, 30, 288, 20], { ex: 'scroll', hw: 4 })], NARROW, els);
    expect(reflowPlaces(state([it_([0, 0, 300, 20]), it_([0, 30, 300, 20])]), wrapped, 'tt')).toEqual([{ kind: 'hscroll', el: 4, items: [0] }]);
  });

  it('reflow: the share of text the page replaced after the resize (a script re-rendering it)', () => {
    const base = state([it_([0, 0, 10, 10]), it_([0, 0, 10, 10]), it_([0, 0, 10, 10]), it_([0, 0, 10, 10], { v: 0 })]);
    const now = state([it_([], { v: 0, gone: 1 }), it_([0, 0, 10, 10]), it_([0, 0, 10, 10]), it_([], { v: 0, gone: 1 })]);
    expect(goneShare(base, now, 'tttt')).toBeCloseTo(1 / 3);
    expect(goneShare(base, base, 'tttt')).toBe(0);
    expect(goneShare(state([]), state([]), '')).toBe(0);
  });

  it('resize text: a closed off-canvas menu is not content pushed out of reach', () => {
    const before = state([it_([1000, 0, 200, 20]), it_([1000, 30, 200, 20])]);
    const after = state([it_([700, 0, 200, 20], { pos: 1 }), it_([700, 30, 200, 20])], { ...VIEW, w: 640, scrollW: 640, canScrollX: false });
    expect(pushedOutOfReach(before, after)).toEqual([1]);
  });

  it('resize text at 200% zoom: text the narrower layout cuts off, overlaps or pushes out of reach, but not carousels or what pass 1 already reported', () => {
    const base = state([it_([0, 0, 300, 20]), it_([0, 30, 300, 20]), it_([0, 60, 300, 20]), it_([0, 90, 300, 20]), it_([900, 120, 200, 20]), it_([0, 150, 100, 20], { fs: 40 })]);
    const zoomed = state([
      it_([0, 0, 300, 20], { cut: 1, by: 5 }), it_([0, 30, 300, 20], { cut: 1, by: 6 }), it_([0, 60, 300, 20]), it_([0, 65, 300, 20]),
      it_([700, 120, 200, 20]), it_([0, 150, 100, 20], { fs: 20 }),
    ], { ...VIEW, w: 640, h: 450, scrollW: 640, canScrollX: false }, {
      5: { w: 300, h: 10, ox: 'hidden', oy: 'hidden' }, 6: { w: 300, h: 10, ox: 'hidden', oy: 'hidden', carousel: 1 },
    });
    expect(zoomPlaces(base, zoomed, 'tttttt', new Set())).toEqual([
      { kind: 'zcut', el: 5, items: [0] }, { kind: 'zoverlap', items: [2, 3] }, { kind: 'zreach', items: [4] }, { kind: 'zoom', items: [5] },
    ]);
    expect(zoomPlaces(base, zoomed, 'tttttt', new Set([0, 4]))).toEqual([{ kind: 'zoverlap', items: [2, 3] }, { kind: 'zoom', items: [5] }]);
  });

  it('text spacing and resize text: a form control without text that the change cuts off counts', () => {
    const before = state([it_([0, 0, 200, 30])]);
    const after = state([it_([0, 0, 400, 30], { cut: 1, by: 2 })], VIEW, { 2: { w: 300, h: 40, ox: 'hidden', oy: 'hidden' } });
    expect(newlyCut(before, after, 'b')).toEqual([0]);
    expect(newlyCut(before, after, 'c')).toEqual([]);
  });

  it('reflow: a fixed box that grows past the top or bottom of the 256 px screen loses content; a closed sheet moved out entirely does not', () => {
    const narrow = state([
      it_([0, -40, 300, 20], { fx: 4 }), it_([0, 0, 300, 20], { fx: 4 }), it_([0, 230, 300, 40], { fx: 4 }), // banner: partly above and below
      it_([0, 300, 300, 20], { fx: 5 }), it_([0, 330, 300, 20], { fx: 5 }), // a closed bottom sheet, entirely below
      it_([0, 10, 300, 20], { fx: 6 }), // a small fixed header that fits
      it_([0, 400, 300, 20]), // page text below the fold scrolls into view
      it_([0, -40, 300, 20], { fx: 7, ex: 'media' }),
    ], NARROW);
    expect(fixedOverflow(narrow, 'tttttttt')).toEqual([{ kind: 'fixed', el: 4, items: [0, 2] }]);
    expect(fixedOverflow(narrow, 'tttttttt', new Set([0]))).toEqual([{ kind: 'fixed', el: 4, items: [2] }]);
  });

  // Batch 19 (real-site dev split): a closed drawer menu moved off the screen sideways (left: 100%) is fixed and runs past
  // the 256 px height, but none of it is on the screen: it keeps nothing from being scrolled to. The same box on screen does.
  it('reflow: a fixed drawer moved off the screen sideways is not counted; the same drawer on screen is', () => {
    const W = NARROW.w;
    const off = state([it_([W, 80, 300, 20], { fx: 4 }), it_([W, 230, 300, 40], { fx: 4 }), it_([W + 10, 300, 280, 20], { fx: 4 })], NARROW);
    expect(fixedOverflow(off, 'ttt')).toEqual([]);
    const on = state([it_([0, 80, 300, 20], { fx: 4 }), it_([0, 230, 300, 40], { fx: 4 }), it_([10, 300, 280, 20], { fx: 4 })], NARROW);
    expect(fixedOverflow(on, 'ttt')).toEqual([{ kind: 'fixed', el: 4, items: [1, 2] }]);
  });

  it('overlaps: text under a fixed banner or header is not text overlapping text (the page scrolls under it)', () => {
    const narrow = state([it_([0, 100, 300, 20]), it_([0, 105, 300, 20], { fx: 3 }), it_([0, 200, 300, 20], { fx: 3 }), it_([0, 205, 300, 20], { fx: 3 })], NARROW);
    expect([...overlapPairs(narrow, 'tttt')]).toEqual(['2:3']);
  });

  it('the guard: an analytics request the page also sent while loading does not stop a test; any other repeated or new request does', () => {
    const post = (url: string): GuardEvent => ({ kind: 'blocked', at: 0, reason: 'method', method: 'POST', url, resourceType: 'xhr' });
    expect(guardStopped([post('https://www.google-analytics.com/g/collect?s=2')], [post('https://www.google-analytics.com/g/collect?s=1')])).toBeUndefined();
    expect(guardStopped([post('https://e.org/tip')], [post('https://www.google-analytics.com/g/collect?s=1')])?.reason).toMatch(/POST request to https:\/\/e\.org\/tip/);
    // Round 2 review #1: the page's own address (or another unlisted host) seen on load still stops the test.
    expect(guardStopped([post('https://e.org/api/tooltip')], [post('https://e.org/api/tooltip?preload=1')])?.reason).toMatch(/POST request to https:\/\/e\.org\/api\/tooltip/);
    expect(guardStopped([post('https://c.example/collect?s=2')], [post('https://c.example/collect?s=1')])?.reason).toMatch(/c\.example\/collect/);
  });

  it('the guard: a static file stopped for its action-like address does not stop a render test; an action request does', () => {
    const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'blocked', at: 0, method: 'GET', reason: 'action', ...e });
    for (const [url, resourceType] of [['https://e.org/assets/cart.js', 'script'], ['https://e.org/icons/add-to-cart.svg', 'image'], ['https://e.org/css/pre-order.css', 'stylesheet']]) {
      expect(guardStopped([ev({ url, resourceType })])).toBeUndefined();
    }
    expect(guardStopped([ev({ url: 'https://e.org/account/logout', resourceType: 'xhr' })])?.reason).toMatch(/looks like an action to https:\/\/e\.org\/account\/logout/);
  });

  it('the guard: a held navigation or a blocked request (not an analytics beacon) is the reason a test could not run', () => {
    const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'blocked', at: 0, ...e });
    expect(guardStopped([])).toBeUndefined();
    expect(guardStopped([ev({ kind: 'dialog', dialog: 'alert' }), ev({ kind: 'url-change', url: 'https://e.org/#x' })])).toBeUndefined();
    expect(guardStopped([ev({ reason: 'method', method: 'POST', url: 'https://e.org/b', resourceType: 'ping' })])).toBeUndefined();
    expect(guardStopped([ev({ reason: 'method', method: 'POST', url: 'https://e.org/tip', resourceType: 'fetch' })]))
      .toEqual({ navigation: false, reason: 'the test would have sent data to the live site (POST request to https://e.org/tip), so it was stopped' });
    expect(guardStopped([ev({ reason: 'method', method: 'POST', url: 'https://e.org/tip', resourceType: 'fetch' }), ev({ kind: 'navigation', url: 'https://m.e.org/' })]))
      .toEqual({ navigation: true, reason: 'the page tried to go to another address during the test (https://m.e.org/); the test holds such navigations, so the page could not be measured' });
  });
});

describe('orientation rules', () => {
  const facts = (over: Partial<OrientationFacts> = {}): OrientationFacts => ({
    text: 900, main: { found: true, visible: true, text: 800, path: 'main' }, rotation: 0, ...over,
  });

  it('recognises messages asking to rotate the device', () => {
    for (const s of ['Please rotate your device', 'Turn your phone to portrait.', 'Best viewed in landscape', 'This page only works in portrait mode', 'Landscape mode only', 'Switch to landscape']) {
      expect(ROTATE_MESSAGE.test(s), s).toBe(true);
    }
    for (const s of ['The rotating lunch schedule', 'Turn your attention to the board', 'A portrait of the principal', 'Landscape photos from the trip', 'Turn the page']) {
      expect(ROTATE_MESSAGE.test(s), s).toBe(false);
    }
  });

  // Blocks of running text the other orientation shows (`general`) that are not shown here (`generalOfOther`): the
  // evidence that what is hidden is general page content.
  const shows = { general: 3 };
  const hides = { general: 0, generalOfOther: { had: 3, hidden: 3 } };

  it('fails content hidden, replaced by a rotate message or turned by CSS in one orientation only', () => {
    const msg = { text: 'Please rotate your device', path: '#rotate', cover: 1 };
    expect(orientationFindings(facts({ text: 40, main: { found: true, visible: false, text: 0, path: 'main' }, rotate: msg, ...hides }), facts(shows))).toEqual([{
      criterion: '1.3.4', status: 'failed', target: '#rotate',
      detail: 'On a phone in portrait (390×844 px), most of its text is hidden (40 characters shown, 900 in landscape); it shows “Please rotate your device” over 100% of the screen, so the content only works in landscape',
    }]);
    expect(orientationFindings(facts(shows), facts({ text: 850, main: { found: true, visible: true, text: 20, path: 'main' }, ...hides }))).toEqual([{
      criterion: '1.3.4', status: 'failed', target: 'main',
      detail: 'On a phone in landscape (844×390 px), its main content is nearly empty (20 characters shown, 800 in portrait), so the content only works in portrait',
    }]);
    expect(orientationFindings(facts({ rotation: 90, rotatedPath: 'body' }), facts())[0]).toMatchObject({ target: 'body', detail: expect.stringContaining('the page is turned 90° with a CSS transform') });
  });

  // Review r2, finding 5: an amount of text never decides it.
  it('is not testable, never failed, when nothing shows that what an orientation hides is general page content', () => {
    const msg = { text: 'Please rotate your device', path: '#rotate', cover: 1 };
    // Most of the text hidden behind a message over the screen, on a page with no block of running text or form.
    expect(orientationFindings(facts({ text: 40, main: { found: true, visible: false, text: 0, path: 'main' }, rotate: msg }), facts())).toEqual([expect.objectContaining({
      status: 'not_testable', target: '#rotate', detail: expect.stringContaining('whether that content needs landscape could not be told'),
    })]);
    // The main content nearly empty, with nothing known to be general among what is hidden.
    expect(orientationFindings(facts(), facts({ text: 850, main: { found: true, visible: true, text: 20, path: 'main' } }))).toEqual([expect.objectContaining({
      status: 'not_testable', target: 'main',
      detail: 'On a phone in landscape (844×390 px), its main content is nearly empty (20 characters shown, 800 in portrait); whether what is hidden needs portrait could not be told (WCAG allows an orientation that is essential, as for a bank check or a piano keyboard)',
    })]);
    // The running text still shown, something else hidden: the blocks the other orientation shows are all shown here.
    expect(orientationFindings(facts({ general: 3 }), facts({ text: 200, generalOfOther: { had: 3, hidden: 0 } }))).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  });

  it('a message in place of a picture of a thing is not general content, however much of the page’s text it holds', () => {
    const wall = { text: 'Turn your phone sideways to see the sample check', path: '#wall', cover: 0.2 };
    // A check of 300 characters beside 250 characters of other content: more than half of the page's text.
    const f = facts({ text: 300, rotate: wall, swapped: 300, swapKind: { prose: 0, total: 300, fields: 0, presentation: true }, general: 2, generalOfOther: { had: 2, hidden: 0 } });
    const other = facts({ text: 550, shownOfOther: 300, general: 2 });
    expect(swapEvidence(f, other)).toBeNull();
    expect(orientationFindings(f, other)).toEqual([expect.objectContaining({ status: 'not_testable', target: '#wall', detail: expect.stringContaining('in place of content shown in landscape (300 characters); whether that content needs landscape could not be told') })]);
    // A form with a drawing in it is not decided as a form either; the same form without it is general content.
    expect(swapEvidence(facts({ rotate: wall, swapped: 90, swapKind: { prose: 0, total: 90, fields: 3, presentation: true } }), other)).toBeNull();
    expect(swapEvidence(facts({ rotate: wall, swapped: 90, swapKind: { prose: 0, total: 90, fields: 3, presentation: false } }), other)).toBe('general');
    // Shown in the same orientation on a larger screen: it does not need the other one.
    expect(swapEvidence({ ...f, shownElsewhere: 300 }, other)).toBe('elsewhere');
  });

  it('does not fail a small rotate hint that leaves the content, or the same page in both orientations', () => {
    expect(orientationFindings(facts({ rotate: { text: 'Best viewed in landscape', path: '#hint', cover: 0.1 } }), facts())).toEqual([]);
    expect(orientationFindings(facts(), facts({ text: 700 }))).toEqual([]);
    expect(orientationFindings(facts({ rotation: 90 }), facts({ rotation: 90 }))).toEqual([]);
    expect(orientationFindings(facts({ text: 10 }), facts({ text: 30 }))).toEqual([]); // too little text to judge
  });
});

describe('hover content wording', () => {
  const r = (failed: HoverResult['failed'], how: 'hover' | 'focus' = 'hover'): HoverResult =>
    ({ candidate: { i: 0, how, source: 'listener', path: '#t', name: 'Info' }, revealed: true, text: 'Office hours', obscures: true, failed });

  it('says what was measured for each requirement', () => {
    expect(hoverDetail(r(['dismissible', 'hoverable']))).toBe('Content shown on hover (“Office hours”): pressing Escape does not hide it although it covers other content; it disappears when the pointer moves onto it');
    expect(hoverDetail(r(['persistent'], 'focus'))).toBe('Content shown on focus (“Office hours”): it disappears by itself within 2 s while the trigger keeps focus');
    expect(hoverDetail(r(['dismissible']))).not.toMatch(/person|manual|by hand|check/i);
  });
});

describe('hover content: the pointer moves onto the content the shortest way', () => {
  // A 46 px trigger at x 48–94 with a 276 px tooltip right under it (the sim lab's page).
  const tip = { left: 48, top: 178, right: 324, bottom: 233 };
  it('lands first on the point of the content nearest the trigger, 2 px inside it, not its middle', () => {
    expect(nearestPointIn({ x: 71, y: 166 }, tip)).toEqual({ x: 71, y: 180 }); // straight down
    expect(nearestPointIn({ x: 400, y: 200 }, tip)).toEqual({ x: 322, y: 200 }); // content on the left
    expect(nearestPointIn({ x: 10, y: 10 }, tip)).toEqual({ x: 50, y: 180 }); // corner
    expect(nearestPointIn({ x: 100, y: 200 }, tip)).toEqual({ x: 100, y: 200 }); // already on it
    expect(nearestPointIn({ x: 0, y: 0 }, { left: 10, top: 10, right: 12, bottom: 30 })).toEqual({ x: 11, y: 11 }); // thin: on its middle line, inset no more than half its width
  });
  it('steps at most 4 px apart so a gap on the way is crossed, not jumped over, however long the move', () => {
    expect(HOVER_STEP_PX).toBe(4);
    expect(pointerSteps({ x: 71, y: 166 }, { x: 71, y: 180 })).toBe(4);
    expect(pointerSteps({ x: 71, y: 166 }, { x: 71, y: 204 })).toBe(10); // a 24 px gap: several points in it
    expect(pointerSteps({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(2);
    // No fixed cap (it was 60: a 24 px gap on a 1440 px move could be stepped over). The longest move is
    // the viewport's diagonal: 1565 px at 1280 × 900.
    expect(pointerSteps({ x: 1, y: 1 }, { x: 1278, y: 898 })).toBe(Math.ceil(Math.hypot(1277, 897) / 4));
    expect(Math.hypot(1277, 897) / pointerSteps({ x: 1, y: 1 }, { x: 1278, y: 898 })).toBeLessThanOrEqual(4);
  });
  it('goes inside the trigger to its point nearest the content first, then across, then onto the content', () => {
    // A 320 px trigger (centre 160, 24) with a 64 px menu under its left end (the review's corner case).
    const near = nearestPointIn({ x: 160, y: 24 }, { left: 0, top: 48, right: 64, bottom: 140 });
    expect(near).toEqual({ x: 62, y: 50 });
    const edge = nearestPointIn(near, { left: 0, top: 0, right: 320, bottom: 48 });
    expect(edge).toEqual({ x: 62, y: 46 });
    expect(hoverPath({ point: { x: 32, y: 94 }, near, edge })).toEqual([edge, near, { x: 32, y: 94 }]);
    expect(hoverPath({ point: { x: 32, y: 94 } })).toEqual([{ x: 32, y: 94 }]);
  });
});

describe('hover content result per page', () => {
  const res = (over: Partial<HoverResult> = {}): HoverResult =>
    ({ candidate: { i: 0, how: 'hover', source: 'listener', path: '#t', name: 'Info' }, revealed: true, text: 'Tip', obscures: true, failed: [], ...over });
  const why = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return 'no throw'; };

  it('failures are reported whatever else happened, except on a trigger whose page tried to navigate away', () => {
    const stop = { navigation: false, reason: 'blocked' };
    expect(hoverFindings([res({ failed: ['persistent'] }), res({ stopped: stop })], 5)).toHaveLength(1);
    expect(why(() => hoverFindings([res({ failed: ['persistent'], stopped: { navigation: true, reason: 'nav' } })], 1))).toBe('nav');
  });

  it('never a clean result after a guard stop, a time-out or with no trigger reachable', () => {
    expect(why(() => hoverFindings([res(), res({ revealed: false, stopped: { navigation: false, reason: 'blocked POST' } })], 2))).toBe('blocked POST');
    expect(why(() => hoverFindings([res()], 3))).toBe('the time ran out after 1 of 3 hover and focus triggers');
    expect(why(() => hoverFindings([res({ revealed: false, covered: true }), res({ revealed: false })], 2)))
      .toBe('the pointer could not reach the hover triggers on this page (1 of 2 is covered by other content)');
    expect(hoverFindings([res(), res({ revealed: false, covered: true })], 2)).toEqual([]);
    expect(hoverFindings([res({ revealed: false })], 1)).toEqual([{ criterion: '1.4.13', status: 'not_applicable', detail: 'no content appeared on hover or focus' }]);
    expect(hoverFindings([], 0)).toEqual([{ criterion: '1.4.13', status: 'not_applicable', detail: 'no hover or focus triggers found' }]);
  });
});

describe('registration', () => {
  it('registers each render probe in PROBES and in the criteria rows it reports on', () => {
    const mine = [textSpacingProbe, resizeTextProbe, reflowProbe, orientationProbe, hoverContentProbe];
    for (const p of mine) {
      expect(PROBES).toContain(p);
      for (const c of p.criteria) expect(CRITERIA.find((d) => d.criterion === c)!.methods, `${p.id} ${c}`).toContain(`probe:${p.id}`);
    }
    expect(mine.map((p) => [p.id, p.criteria.join(), p.kind, p.tier])).toEqual([
      ['text-spacing', '1.4.12', 'render', 'core'], ['resize-text', '1.4.4', 'render', 'core'], ['reflow', '1.4.10', 'render', 'core'],
      ['orientation', '1.3.4', 'render', 'core'], ['hover-content', '1.4.13', 'interaction', 'deep'],
    ]);
    // Every probe method in the table names a registered probe, and the axe methods stay.
    const ids = new Set(PROBES.map((p) => p.id));
    for (const d of CRITERIA) for (const m of d.methods) if (m.startsWith('probe:')) expect(ids.has(m.slice(6)), m).toBe(true);
    for (const c of ['1.3.4', '1.4.4', '1.4.12']) expect(CRITERIA.find((d) => d.criterion === c)!.methods[0]).toBe('axe');
  });

  it('shares the desktop page for the layout probes; the phone context and the hover test get their own', () => {
    for (const p of [textSpacingProbe, resizeTextProbe, reflowProbe]) expect([p.viewport, p.contextOptions, p.isolate]).toEqual([undefined, undefined, undefined]);
    expect([orientationProbe.viewport, orientationProbe.contextOptions]).toEqual([{ width: 390, height: 844 }, { isMobile: true, hasTouch: true }]);
    expect(hoverContentProbe.isolate).toBe(true);
  });
});

describe('the render probes in a scan (fake browser)', () => {
  // Five pages with five different shapes: the template sample is all of them.
  const SHAPES: Record<string, string> = {
    '/': 'header:1 nav:1 main:1 h2-6:8-15', '/a': 'header:1 main:1 table:1', '/b': 'header:1 main:1 form:1',
    '/c': 'header:1 nav:1 main:1 h2-6:2-3', '/d': 'header:1 main:1 table:2+',
  };
  const LINKS = Object.keys(SHAPES).filter((p) => p !== '/').map((p) => `https://e.org${p}`);
  const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
  const site = () => fakeProbeBrowser({
    evaluate: (name, path) => {
      if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
      if (name === 'pageShape') return SHAPES[path];
      return undefined;
    },
  });
  const methods = (r: Awaited<ReturnType<typeof scanSite>>, c: string) => r.criteria!.find((x) => x.criterion === c)!.methods;

  it('with the probes turned off, each render criterion still gets an automated reason', async () => {
    const off = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', probes: false });
    expect(off.probes).toBeUndefined();
    const reason = 'the automated interaction and render tests were turned off for this scan';
    expect(methods(off, '1.4.10')).toEqual([{ id: 'reflow', kind: 'render', status: 'not_testable', pages: 0, note: reason }, { id: 'overlays', kind: 'render', status: 'not_testable', pages: 0, note: reason }]);
    expect(methods(off, '1.4.13')).toEqual([{ id: 'hover-content', kind: 'interaction', status: 'not_testable', pages: 0, note: reason }]);
    for (const [c, id] of [['1.3.4', 'orientation'], ['1.4.4', 'resize-text'], ['1.4.12', 'text-spacing']] as const) {
      expect(methods(off, c).find((m) => m.id === id)).toEqual({ id, kind: 'render', status: 'not_testable', pages: 0, note: reason });
    }
  });

  it('runs the core render probes on the sample by default and lists the deep hover test with the reason it did not run', async () => {
    const dflt = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '' });
    const core = PROBES.filter((p) => p.tier === 'core').map((p) => p.id);
    expect(core).toEqual(expect.arrayContaining(['text-spacing', 'resize-text', 'reflow', 'orientation']));
    expect([...new Set(dflt.probes!.runs.map((r) => r.probe))].sort()).toEqual([...core].sort());
    expect(dflt.probes!.runs).toHaveLength(core.length * 5);
    expect(methods(dflt, '1.4.13')).toEqual([
      { id: 'hover-content', kind: 'interaction', status: 'not_testable', pages: 0, note: 'a deep automated test, not run in this scan' },
    ]);
    // The fake pages answer no layout question: the probes say they could not run, never "no failures".
    for (const c of ['1.3.4', '1.4.4', '1.4.10', '1.4.12']) {
      const m = methods(dflt, c).find((x) => x.kind === 'render')!;
      expect(m.status, c).toBe('not_testable');
      expect(m.pages, c).toBe(5);
    }
    const full = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', full: true });
    expect(methods(full, '1.4.13')[0]).toMatchObject({ id: 'hover-content', status: 'not_testable', pages: 5 });
  });
});
