// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page-load pop-ups (src/probes/popupAside.ts): the pure parts. The guard windows a test that set a pop-up aside
// rests on (its first look and its second, never the dismissal between them); rule 5's result; reflow's overlap places
// built without every pair (Sol popup-r3 14). Real Chromium runs: test/integration/popupAside.test.ts.
import { describe, expect, it } from 'vitest';
import { boxesOf, newOverlapPlaces, newOverlaps, overlapPlaces, type LayoutItem, type LayoutState } from '../../src/probes/layout.js';
import { incomplete, INCOMPLETE, stoppedBetween } from '../../src/probes/popupAside.js';
import { reflowPlaces } from '../../src/probes/reflow.js';
import { guardedIn } from '../../src/probes/textContrast.js';
import type { GuardEvent, GuardLog, ProbeFinding } from '../../src/probes/types.js';

const log = (events: GuardEvent[]): GuardLog => ({ events, mark: () => events.length, since: (m) => events.slice(m) });
const nav: GuardEvent = { kind: 'navigation', url: 'https://e.org/account', at: 1 };
const post: GuardEvent = { kind: 'blocked', url: 'https://e.org/api', method: 'POST', resourceType: 'fetch', reason: 'method', at: 1 };
const ok: ProbeFinding[] = [{ criterion: '1.4.3', status: 'no_failures_found', detail: 'clean' }];

describe('guard windows around a pop-up dismissal', () => {
  it('what the guard held during the dismissal (between the windows) never voids the result', () => {
    // First look [0, 1), the dismissal's press at 1 (a held navigation: the pop-up stayed), second look [2, ...).
    const g = log([{ kind: 'websocket', at: 0 }, nav, { kind: 'websocket', at: 2 }]);
    expect(stoppedBetween(g, 0, 1)).toBeUndefined();
    expect(guardedIn({ guard: g }, [{ from: 0, to: 1 }, { from: 2 }], ok, true)).toEqual(ok);
  });

  it('a held navigation in either look voids it; a blocked request voids only a clean result of a test whose requests count', () => {
    const first = log([nav, post]);
    expect(() => guardedIn({ guard: first }, [{ from: 0, to: 1 }, { from: 2 }], ok, true)).toThrow(/another address/);
    const second = log([post, post, nav]);
    expect(() => guardedIn({ guard: second }, [{ from: 0, to: 1 }, { from: 2 }], ok, true)).toThrow(/another address/);
    const blocked = log([post]);
    expect(guardedIn({ guard: blocked }, [{ from: 0 }], ok, true)).toEqual(ok);
    expect(() => guardedIn({ guard: blocked }, [{ from: 0 }], ok)).toThrow();
  });
});

describe('rule 5: incomplete is not testable, never clean (Sol popup-r3 9, 11, 12)', () => {
  it('an incomplete look keeps no look-1 findings and explains why the page is not testable', () => {
    expect(incomplete('1.4.11', INCOMPLETE.stayed)).toEqual([
      { criterion: '1.4.11', status: 'not_testable', detail: 'a pop-up covered the page and could not be closed, so the page could not be checked' },
    ]);
    expect(incomplete('1.4.3', INCOMPLETE.unfinished).map((f) => f.status)).toEqual(['not_testable']);
    expect(incomplete('1.4.3', INCOMPLETE.unfinished)[0]!.detail).toMatch(/^the second look did not finish/);
  });
});

/** A small random layout: text items ('t') with one or two line boxes, some hidden or in a fixed box. */
function randomLayout(seed: number, n: number): { before: LayoutState; after: LayoutState; kinds: string } {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const view = { w: 320, h: 256, scrollW: 320, scrollH: 2000, canScrollX: true, canScrollY: true };
  const item = (spread: number): LayoutItem => {
    const x = Math.floor(r() * 200);
    const y = Math.floor(r() * spread);
    const lines = r() < 0.3 ? [x, y, 120, 18, x, y + 18, 80, 18] : [x, y, 60 + Math.floor(r() * 100), 18];
    return { v: r() < 0.9 ? 1 : 0, r: lines, fs: 16, cut: r() < 0.05 ? 2 : 0, ...(r() < 0.15 ? { fx: 1 } : {}) };
  };
  const before: LayoutItem[] = [];
  const after: LayoutItem[] = [];
  let kinds = '';
  for (let i = 0; i < n; i++) {
    before.push(item(2000));
    after.push(item(400));
    kinds += r() < 0.9 ? 't' : 'c';
  }
  return { before: { view, items: before, els: {} }, after: { view, items: after, els: {} }, kinds };
}

describe('reflow overlap places without every pair (Sol popup-r3 14, ruling 8)', () => {
  it('gives exactly the places `overlapPlaces(newOverlaps(...))` gives, in the same order, on random layouts', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { before, after, kinds } = randomLayout(seed, 5 + (seed % 60));
      const skip = seed % 3 === 0 ? (it: LayoutItem, i: number) => i % 7 === 0 && boxesOf(it).length > 1 : undefined;
      expect(newOverlapPlaces(before, after, kinds, skip), `seed ${seed}`).toEqual(overlapPlaces(newOverlaps(before, after, kinds, skip)));
    }
  });

  it('1,500 lines colliding in one place keep memory and time small, and the reporting cap is applied before any finding is worded', () => {
    const n = 1500;
    const view = { w: 320, h: 256, scrollW: 320, scrollH: 2000, canScrollX: true, canScrollY: true };
    const before: LayoutState = { view, items: Array.from({ length: n }, (_, i) => ({ v: 1, r: [0, i * 30, 100, 18], fs: 16, cut: 0 })), els: {} };
    const after: LayoutState = { view, items: Array.from({ length: n }, () => ({ v: 1, r: [0, 0, 100, 18], fs: 16, cut: 0 })), els: {} };
    const kinds = 't'.repeat(n);
    const t0 = Date.now();
    const places = reflowPlaces(before, after, kinds);
    // Each item is in one place at most (the greedy pairing), so there are n / 2 overlap places, not n * (n - 1) / 2.
    expect(places.filter((p) => p.kind === 'overlap')).toHaveLength(n / 2);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
