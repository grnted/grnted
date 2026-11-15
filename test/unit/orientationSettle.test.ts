// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.3.4 orientation probe: both orientations are read 1.6 s after each turn, each until it reads the
// same twice in a row (every read at the same settle), and an unsettled pair is never compared
// (src/probes/orientation.ts). A fake page on a virtual clock (Date.now follows it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANDSCAPE, PORTRAIT, orientationProbe, sameFacts, type OrientationFacts } from '../../src/probes/orientation.js';
import type { GuardEvent, GuardLog, ProbeContext } from '../../src/probes/types.js';
import type { PageLike } from '../../src/types.js';

// A page of running text: where its main content is shown its three paragraphs are too (`general`); where it is
// hidden, the three the other orientation shows are not shown (`generalOfOther`). That, not the amount of text, is
// what makes a hidden page a failure (review r2, finding 5).
const facts = (text: number, mainVisible = true, rotate?: string): OrientationFacts => ({
  text, main: { found: true, visible: mainVisible, text: mainVisible ? text : 0, path: 'main' }, rotation: 0,
  ...(mainVisible ? { general: 3, generalOfOther: { had: 0, hidden: 0 } } : { general: 0, generalOfOther: { had: 3, hidden: 3 } }),
  ...(rotate ? { rotate: { text: rotate, path: '#lock', cover: 1 } } : {}),
});

type Orientation = 'portrait' | 'landscape';

/**
 * A phone page. `show(o, t, sinceTurn)` says what it shows in orientation `o` at virtual time `t` (ms
 * from the start of the test), `sinceTurn` ms after the last resize.
 */
function fakeCtx(show: (o: Orientation, t: number, sinceTurn: number) => OrientationFacts, opts: { deadlineMs?: number } = {}) {
  let t = 0;
  let turnedAt = -10_000;
  const start = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => start + t);
  let size: { width: number; height: number } = { ...PORTRAIT };
  const reads: { t: number; o: Orientation }[] = [];
  const sizes: { width: number; height: number }[] = [];
  const events: GuardEvent[] = [];
  const guard = { events, mark: () => events.length, since: (m: number) => events.slice(m) } as unknown as GuardLog;
  const page = {
    async waitForTimeout(ms: number) { t += ms; },
    async setViewportSize(s: { width: number; height: number }) { size = { ...s }; sizes.push(s); t += 20; turnedAt = t; },
    async evaluate() {
      const o: Orientation = size.width > size.height ? 'landscape' : 'portrait';
      reads.push({ t, o });
      const f = show(o, t, t - turnedAt);
      t += 30;
      return f;
    },
  } as unknown as PageLike;
  const ctx = {
    page, url: 'https://e.org/', pageIndex: 0, viewport: { ...PORTRAIT }, guard,
    signal: new AbortController().signal, deadline: start + (opts.deadlineMs ?? 15_000),
  } as unknown as ProbeContext;
  return { ctx, reads, sizes };
}

/** Before `mountAt` only "Loading…" shows; after it, 900 characters in `worksIn` and the main content hidden in the other. */
const mounting = (mountAt: number, worksIn: Orientation[]) => (o: Orientation, t: number) =>
  (t < mountAt ? facts(18) : worksIn.includes(o) ? facts(900) : facts(18, false));

describe('orientation probe: same settle, steady readings', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('passes a page that mounts while it is being turned (it works in both orientations)', async () => {
    for (const mountAt of [100, 300, 600, 1000, 1500, 2500, 4000]) {
      const { ctx } = fakeCtx(mounting(mountAt, ['portrait', 'landscape']));
      expect(await orientationProbe.run(ctx), `mount at ${mountAt} ms`).toEqual([]);
    }
  });

  it('reads each orientation 1.6 s after each turn, twice at least, never at once', async () => {
    const { ctx, reads } = fakeCtx(() => facts(900));
    expect(await orientationProbe.run(ctx)).toEqual([]);
    expect(reads[0]).toEqual({ t: 1620, o: 'landscape' });
    expect(reads.map((r) => r.o)).toEqual(['landscape', 'portrait', 'landscape', 'portrait']);
  });

  it('still fails a late-mounting page whose content is hidden in portrait, and one hidden in landscape', async () => {
    for (const mountAt of [100, 600, 1000, 1500, 4000]) {
      const portraitHidden = await orientationProbe.run(fakeCtx(mounting(mountAt, ['landscape'])).ctx);
      expect(portraitHidden, `mount at ${mountAt} ms`).toHaveLength(1);
      expect(portraitHidden[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('On a phone in portrait') });
      const landscapeHidden = await orientationProbe.run(fakeCtx(mounting(mountAt, ['portrait'])).ctx);
      expect(landscapeHidden[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('On a phone in landscape') });
    }
  });

  it('fails a lock a script shows 800 ms or 1.5 s after the page is turned to landscape', async () => {
    for (const after of [800, 1500]) {
      const lockedLate = (o: Orientation, _t: number, sinceTurn: number) =>
        (o === 'landscape' && sinceTurn >= after ? facts(40, false, 'Rotate your device to portrait') : facts(900));
      const out = await orientationProbe.run(fakeCtx(lockedLate).ctx);
      expect(out, `lock after ${after} ms`).toHaveLength(1);
      expect(out[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('On a phone in landscape') });
    }
  });

  it('is not testable when the reads still differ after three rounds, and turns the viewport back', async () => {
    let n = 0;
    const { ctx, sizes, reads } = fakeCtx(() => facts(400 + 200 * n++));
    await expect(orientationProbe.run(ctx)).rejects.toThrow(/kept changing/);
    expect(reads).toHaveLength(6);
    expect(sizes.at(-1)).toEqual(PORTRAIT);
  });

  it('is not testable when time runs out before landscape has read the same twice (never compares an unsettled pair)', async () => {
    const { ctx, reads } = fakeCtx(mounting(0, ['portrait', 'landscape']), { deadlineMs: 6000 });
    await expect(orientationProbe.run(ctx)).rejects.toThrow(/time for this test ran out/);
    expect(reads.map((r) => r.o)).toEqual(['landscape', 'portrait']);
  });

  it('sameFacts: equal within 5% or 20 characters; the main content shown or hidden, the turn and the message must match', () => {
    expect(sameFacts(facts(900), facts(930))).toBe(true);
    expect(sameFacts(facts(900), facts(1000))).toBe(false);
    expect(sameFacts(facts(18), facts(30))).toBe(true);
    expect(sameFacts(facts(900), { ...facts(900), main: { ...facts(900).main, visible: false } })).toBe(false);
    expect(sameFacts(facts(900), { ...facts(900), rotation: 90 })).toBe(false);
    expect(sameFacts(facts(900), facts(900, true, 'Rotate your device'))).toBe(false);
    expect(LANDSCAPE.width).toBeGreaterThan(LANDSCAPE.height);
  });
});
