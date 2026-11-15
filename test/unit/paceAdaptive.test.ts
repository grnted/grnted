// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Adaptive pages at once (src/pace.ts, the page gate `Pace.page` and `ADAPTIVE`) on a fake clock: a
// fake host answers each page load from a script, and each page holds its turn for a fixed browser time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADAPTIVE, createPace, ScanStopped, type PaceAdapt, type PaceAnswer, type PaceOptions } from '../../src/pace.js';

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await Promise.resolve();
    },
    advance: (ms: number) => { t += ms; },
  };
}

const HOST = 'https://example.org';

/**
 * Simulated time for pages that run at once: every wait is a timer, and time jumps to the next one
 * once everything else has settled, so each page's turn lasts its own load and browser time however
 * many pages run beside it (browsers that keep up).
 */
function simulated(start = 1_000_000) {
  let t = start;
  const timers: { at: number; seq: number; wake: () => void }[] = [];
  let seq = 0;
  const settle = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((wake) => { timers.push({ at: t + Math.max(0, ms), seq: seq++, wake }); }),
    async run<T>(work: Promise<T>): Promise<T> {
      let done = false;
      void work.then(() => { done = true; }, () => { done = true; });
      for (;;) {
        await settle();
        await settle();
        if (done) return work;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift();
        if (!next) throw new Error('stuck: nothing to wait for');
        t = Math.max(t, next.at);
        next.wake();
      }
    },
  };
}

/** What the fake host answers page `i` (each width): a status and the load's own time. */
type Host = (i: number) => { status?: number; loadMs?: number; ttfbMs?: number; retryAfter?: string; throws?: Error };

/**
 * A scan's page pool against a fake host: `workers` workers take a turn from the page gate, load the
 * page's two widths at once through the controller (each takes its load time), hold the page for
 * `browserMs` (the audit), and release. Records the limit after every page, and the pages at once.
 */
async function runPages(n: number, host: Host, o: Partial<PaceOptions> & { workers?: number; browserMs?: number } = {}) {
  const c = simulated();
  const changes: PaceAdapt[] = [];
  const at: number[] = [];
  const { workers = 8, browserMs = 1_000, ...paceOpts } = o;
  const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => { changes.push(e); at.push(c.now()); }, ...paceOpts });
  const limits: number[] = [];
  let active = 0;
  let maxActive = 0;
  let overLimit = 0;
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const slot = await p.page();
      if (next >= n) {
        slot.release();
        return;
      }
      const i = next++;
      const url = `${HOST}/p${i}`;
      slot.url(url);
      active++;
      maxActive = Math.max(maxActive, active);
      if (active > p.pages().limit) overLimit++;
      const a = host(i);
      await Promise.all([0, 1].map(() => p.load(url, async () => {
        await c.sleep(a.loadMs ?? 50);
        if (a.throws) throw a.throws;
        return a;
      }, (x): PaceAnswer => ({ status: x.status ?? 200, retryAfter: x.retryAfter ?? null, loadMs: x.loadMs ?? 50, ttfbMs: x.ttfbMs ?? 20 }), { retries: 0, crawlGroup: url }).catch(() => undefined)));
      await c.sleep(browserMs);
      active--;
      slot.release();
      limits.push(p.pages().limit);
    }
  };
  await c.run(Promise.all(Array.from({ length: workers }, worker)));
  return { p, c, changes, at, limits, maxActive, overLimit };
}

describe('adaptive pages at once', () => {
  it('a fast host: the limit rises from 4 to 8 one step at a time, never past the ceiling', async () => {
    const r = await runPages(60, () => ({ loadMs: 40 }));
    expect(r.changes).toEqual([4, 5, 6, 7].map((from) => ({ from, to: from + 1, why: 'comfortable' })));
    expect(Math.max(...r.limits)).toBe(8);
    expect(r.p.pages()).toMatchObject({ limit: 8, highest: 8 });
    expect(r.maxActive).toBeLessThanOrEqual(8);
    expect(r.overLimit).toBe(0);
  });

  it('never goes past the ceiling it was given (the CLI\'s --concurrency)', async () => {
    const r = await runPages(60, () => ({ loadMs: 40 }), { concurrency: 6 });
    expect(r.changes.map((e) => e.to)).toEqual([5, 6]);
    expect(r.maxActive).toBeLessThanOrEqual(6);
  });

  it('starting at the ceiling is today\'s fixed pool: no raise', async () => {
    const r = await runPages(40, () => ({ loadMs: 40 }), { concurrency: 4, start: 4 });
    expect(r.changes).toEqual([]);
    expect(r.maxActive).toBeLessThanOrEqual(4);
  });

  it('a host that slows after 10 pages: the limit drops at once and stays down through the cooling window', async () => {
    const r = await runPages(40, (i) => ({ loadMs: i >= 10 ? 4_000 : 40 }));
    // Raised on the fast pages, then the first slow pages step it down: one step, for a slower trend.
    const firstLower = r.changes.findIndex((e) => e.to < e.from);
    expect(firstLower).toBeGreaterThan(0);
    expect(r.changes[firstLower]).toMatchObject({ why: 'slower' });
    expect(r.changes[firstLower]!.to).toBe(r.changes[firstLower]!.from - 1);
    // At once: before the 13th page was done (pages 10–12 are the first slow ones, each two loads).
    const dropAt = r.limits.findIndex((l, k) => k > 0 && l < r.limits[k - 1]!);
    expect(dropAt).toBeGreaterThan(-1);
    expect(dropAt).toBeLessThanOrEqual(12);
    // No raise ever after it (the site stayed slow), and every later change is down, to the floor at most.
    expect(r.changes.slice(firstLower).every((e) => e.to < e.from)).toBe(true);
    expect(Math.min(...r.limits)).toBeGreaterThanOrEqual(ADAPTIVE.floor);
  });

  it('after a lowering that is not the site refusing us, a fast host gets no raise until the cooling window is over', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    const page = async (i: number, loadMs: number, status = 200) => {
      const slot = await p.page();
      const url = `${HOST}/p${i}`;
      slot.url(url);
      // Both widths at once, as a page loads them.
      await Promise.all([0, 1].map(() => p.load(url, async () => status, (s) => ({ status: s, loadMs, ttfbMs: 20 }), { retries: 0 })));
      c.advance(loadMs + 1_000);
      slot.release();
    };
    let i = 0;
    for (; i < 4; i++) await page(i, 40);
    expect(p.pages().limit).toBe(5);
    // A page's own access rule (401): one step down at once, not held for the scan.
    await page(i++, 40, 401);
    expect(changes.at(-1)).toEqual({ from: 5, to: 4, why: 'refused' });
    // Fast pages inside the cooling window: no raise.
    const lowered = c.now();
    while (c.now() - lowered < ADAPTIVE.coolMs - 10_000) await page(i++, 40);
    expect(p.pages().limit).toBe(4);
    // Past it, a fresh window of fast pages raises again.
    c.advance(10_000);
    for (let k = 0; k < ADAPTIVE.windowPages; k++) await page(i++, 40);
    expect(p.pages().limit).toBe(5);
    expect(changes.at(-1)).toMatchObject({ from: 4, to: 5, why: 'comfortable' });
  });

  it('a 429 mid-scan: an immediate step down (and the host goes to one load at a time, as before)', async () => {
    const r = await runPages(30, (i) => (i === 18 ? { status: 429, retryAfter: '1' } : { loadMs: 40 }));
    const lower = r.changes.find((e) => e.to < e.from);
    expect(lower).toMatchObject({ why: 'slow-down' });
    expect(lower!.to).toBe(lower!.from - 1);
  });

  it('a refusal (406) mid-scan, a challenge (202) and a time-out each step down at once', async () => {
    for (const [ans, why] of [
      [{ status: 406 }, 'refused'],
      [{ status: 202 }, 'challenge'],
      [{ throws: Object.assign(new Error('page.goto: Timeout 45000ms exceeded.'), { name: 'TimeoutError' }) }, 'timeout'],
    ] as const) {
      const r = await runPages(30, (i) => (i === 18 ? ans : { loadMs: 40 }));
      const lower = r.changes.find((e) => e.to < e.from);
      expect(lower, why).toMatchObject({ why });
      expect(lower!.to).toBe(lower!.from - 1);
    }
  });

  it('not found (404) is an ordinary answer: no step down', async () => {
    const r = await runPages(60, (i) => (i % 5 === 0 ? { status: 404, loadMs: 40 } : { loadMs: 40 }));
    expect(r.changes.every((e) => e.to > e.from)).toBe(true);
    expect(r.p.pages().limit).toBe(8);
  });

  it('a lowering is once per round: answers to requests already on their way do not step it down again', async () => {
    const c = simulated();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 6, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    // Six pages sent together, every width refused (406): one round, one step.
    const round = (from: number) => Promise.all(Array.from({ length: 6 }, async (_, k) => {
      const slot = await p.page();
      const url = `${HOST}/r${from + k}`;
      slot.url(url);
      await Promise.all([0, 1].map(() => p.load(url, async () => { await c.sleep(40); return 406; }, (st) => ({ status: st, loadMs: 40 }), { retries: 0 })));
      slot.release();
    }));
    await c.run(round(0));
    expect(changes).toEqual([{ from: 6, to: 5, why: 'refused', held: true }]);
    // Sent after that lowering: a new round, one more step.
    await c.run(round(10));
    expect(changes).toEqual([{ from: 6, to: 5, why: 'refused', held: true }, { from: 5, to: 4, why: 'refused' }]);
  });

  it('a burst of stylesheets refused after a page loaded steps down once, and a stylesheet host held at one load blocks raises until it loads again', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 5, recoverAfter: 2, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    const page = async (i: number) => {
      const slot = await p.page();
      const url = `${HOST}/p${i}`;
      slot.url(url);
      await Promise.all([0, 1].map(() => p.load(url, async () => 200, (st) => ({ status: st, loadMs: 40, ttfbMs: 20 }), { retries: 0 })));
      c.advance(1_040);
      slot.release();
    };
    await page(0);
    c.advance(10);
    // Three stylesheets of that page refused late by the CDN: one step, not three.
    for (const f of ['a', 'b', 'c']) p.fileRefused(`https://cdn.example.net/${f}.css`, { status: 429 }, `${HOST}/p0`);
    expect(changes).toEqual([{ from: 5, to: 4, why: 'slow-down' }]);
    expect(p.limit('cdn.example.net')).toBe(1);
    // Past the cooling window, fast pages: the CDN is still at one load at a time, so no raise.
    c.advance(ADAPTIVE.coolMs + 1);
    for (let i = 1; i <= 8; i++) await page(i);
    expect(changes).toHaveLength(1);
    // Its stylesheets load again: it climbs back, and the next window raises.
    for (let k = 0; k < 8; k++) p.fileLoaded('https://cdn.example.net/a.css');
    expect(p.limit('cdn.example.net')).toBeNull();
    await page(9);
    expect(changes[1]).toEqual({ from: 4, to: 5, why: 'comfortable' });
  });

  it('a fixed pool (the start is the ceiling: --concurrency 4 or less) never steps down for strain', async () => {
    for (const n of [4, 2]) {
      const r = await runPages(30, (i) => (i === 10 ? { status: 406 } : i >= 15 ? { loadMs: 4_000 } : { loadMs: 40 }), { concurrency: n, start: n });
      // The 406 holds it (said once, the limit unmoved); the slow pages never step it down.
      expect(r.changes).toEqual([{ from: n, to: n, why: 'refused', held: true }]);
      expect(r.p.pages().limit).toBe(n);
    }
  });

  it('a cap that turns bad (a throw, NaN) keeps the last finite cap', async () => {
    let cap: () => number = () => 3;
    const p = createPace({ concurrency: 8, start: 4, cap: () => cap() });
    expect(p.pages().limit).toBe(3);
    cap = () => Number.NaN;
    expect(p.pages().limit).toBe(3);
    cap = () => { throw new Error('no'); };
    expect(p.pages().limit).toBe(3);
    cap = () => 6;
    expect(p.pages().limit).toBe(4);
  });

  it('a Crawl-delay: never above today\'s limit (the start), however fast the site', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    p.setCrawlDelay('example.org', 1);
    let next = 0;
    let active = 0;
    let max = 0;
    const worker = async () => {
      while (next < 40) {
        const slot = await p.page();
        if (next >= 40) { slot.release(); return; }
        const url = `${HOST}/p${next++}`;
        slot.url(url);
        active++;
        max = Math.max(max, active);
        await p.load(url, async () => { c.advance(40); return 200; }, (s) => ({ status: s, loadMs: 40, ttfbMs: 20 }), { crawlGroup: url });
        c.advance(1_000);
        active--;
        slot.release();
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    expect(changes.filter((e) => e.to > e.from)).toEqual([]);
    expect(p.pages().highest).toBe(4);
    expect(max).toBeLessThanOrEqual(4);
  });

  it('a Crawl-delay found after a raise brings the limit back to the start', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    for (let i = 0; i < 4; i++) {
      const slot = await p.page();
      const url = `${HOST}/p${i}`;
      slot.url(url);
      for (let w = 0; w < 2; w++) await p.load(url, async () => { c.advance(40); return 200; }, (s) => ({ status: s, loadMs: 40, ttfbMs: 20 }));
      c.advance(1_000);
      slot.release();
    }
    expect(p.pages().limit).toBe(5);
    p.setCrawlDelay('example.org', 2);
    expect(p.pages().limit).toBe(4);
    expect(changes.at(-1)).toMatchObject({ from: 5, to: 4, why: 'crawl-delay' });
  });

  it('a site that slows us (hold): never raised', async () => {
    const c = clock();
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep });
    p.hold(2);
    expect(p.pages().limit).toBe(2);
    const r = await runPages(40, () => ({ loadMs: 40 }), { start: 2, concurrency: 2 });
    expect(r.changes).toEqual([]);
  });

  it('browsers that stop keeping up: no raise past where each page\'s browser time grew', async () => {
    // A CPU-bound session: each page's browser time grows with the pages running at once.
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    for (let i = 0; i < 80; i++) {
      const slot = await p.page();
      const url = `${HOST}/p${i}`;
      slot.url(url);
      for (let w = 0; w < 2; w++) await p.load(url, async () => { c.advance(40); return 200; }, (s) => ({ status: s, loadMs: 40, ttfbMs: 20 }));
      // Browser time proportional to the limit: throughput flat however many pages run at once.
      c.advance(250 * p.pages().limit);
      slot.release();
    }
    // 4 → 5 at once (the first window is the baseline); at 5 browser time is 1.25×, past 1.1 + 0.5 × 1/4.
    expect(Math.max(...changes.map((e) => e.to))).toBeLessThanOrEqual(5);
    expect(p.pages().limit).toBeLessThanOrEqual(5);
  });

  it('a slow first byte against the start page\'s: not comfortable, no raise', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    p.baseline(200);
    for (let i = 0; i < 30; i++) {
      const slot = await p.page();
      const url = `${HOST}/p${i}`;
      slot.url(url);
      for (let w = 0; w < 2; w++) await p.load(url, async () => { c.advance(900); return 200; }, (s) => ({ status: s, loadMs: 900, ttfbMs: 800 }));
      c.advance(1_000);
      slot.release();
    }
    expect(changes).toEqual([]);
  });

  it('the host\'s share caps the limit, holds pages at 0, and a bigger share lets it climb again', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    let share = 8;
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, cap: () => share, onAdapt: (e) => changes.push(e) });
    expect(p.pages().limit).toBe(4);
    share = 2;
    const a = await p.page();
    const b = await p.page();
    let third = false;
    const pending = p.page().then((s) => { third = true; return s; });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(changes.at(-1)).toMatchObject({ from: 4, to: 2, why: 'share' });
    a.release();
    (await pending).release();
    b.release();
    share = 0;
    let held = false;
    const waiting = p.page().then((s) => { held = true; return s; });
    await new Promise((r) => setTimeout(r, ADAPTIVE.capPollMs / 2));
    expect(held).toBe(false);
    share = 3;
    (await waiting).release();
    expect(held).toBe(true);
  });

  it('a cap that throws is ignored', async () => {
    const r = await runPages(60, () => ({ loadMs: 40 }), { cap: () => { throw new Error('no'); } });
    expect(r.p.pages().limit).toBe(8);
  });

  it('a slowed-down host climbs back to the page limit of the moment, then its own limit lifts', async () => {
    const c = clock();
    const p = createPace({ concurrency: 8, start: 4, recoverAfter: 1, now: c.now, sleep: c.sleep, random: () => 1 });
    await p.load(`${HOST}/a`, async () => 429, (s) => ({ status: s, retryAfter: '1' }), { retries: 0 });
    expect(p.limit('example.org')).toBe(1);
    // The 429 stepped the page limit down to 3: two successes (one per step) take the host back there.
    expect(p.pages().limit).toBe(3);
    await p.load(`${HOST}/b`, async () => 200, (s) => ({ status: s }));
    expect(p.limit('example.org')).toBe(2);
    await p.load(`${HOST}/c`, async () => 200, (s) => ({ status: s }));
    expect(p.limit('example.org')).toBeNull();
  });
});

describe('the site refusing us holds the page limit down for the rest of the scan', () => {
  /** A controller ramped from 4 to 5 on fast pages, and a page helper: both widths, then its browser time. */
  async function ramped() {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    let i = 0;
    const page = async (a: { status?: number; challenge?: boolean; throws?: number; retryAfter?: string } = {}) => {
      const slot = await p.page();
      const url = `${HOST}/p${i++}`;
      slot.url(url);
      await Promise.all([0, 1].map(() => p.load(url, async () => {
        // An HTTP error with no body: the browser throws and hands back no response (src/egress.ts).
        if (a.throws !== undefined) throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${url}`);
        return a.status ?? 200;
      }, (s) => ({ status: s, loadMs: 40, ttfbMs: 20, retryAfter: a.retryAfter ?? null, ...(a.challenge ? { challenge: true } : {}) }), {
        retries: 0, ...(a.throws !== undefined ? { failedStatus: () => a.throws } : {}),
      }).catch(() => undefined)));
      c.advance(1_040);
      slot.release();
    };
    for (let k = 0; k < 4; k++) await page();
    expect(p.pages().limit).toBe(5);
    return { c, p, changes, page };
  }

  for (const [name, refusal, why] of [
    ['406', { status: 406 }, 'refused'],
    ['429', { status: 429, retryAfter: '1' }, 'slow-down'],
    ['a challenge (202)', { status: 202 }, 'challenge'],
    ['a WAF challenge (200 with its headers)', { status: 200, challenge: true }, 'challenge'],
    ['406 with no body (the browser threw)', { throws: 406 }, 'refused'],
    ['429 with no body (the browser threw)', { throws: 429 }, 'slow-down'],
  ] as const) {
    it(`${name} during the ramp: one step down at once, and no ramp back up however long the site is fast after it`, async () => {
      const { c, p, changes, page } = await ramped();
      await page(refusal);
      expect(changes.at(-1)).toEqual({ from: 5, to: 4, why, held: true });
      // Well past the cooling window, many clean fast pages: still 4.
      c.advance(ADAPTIVE.coolMs * 3);
      for (let k = 0; k < 40; k++) await page();
      expect(p.pages().limit).toBe(4);
      expect(changes.filter((e) => e.to > e.from)).toHaveLength(1);
    });
  }

  it('a refusal at the floor or in a fixed pool still says held once (the host keeps the scan down in its next attempts)', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 4, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    for (let k = 0; k < 3; k++) await p.load(`${HOST}/f${k}`, async () => 406, (s) => ({ status: s, loadMs: 40 }), { retries: 0 });
    expect(changes).toEqual([{ from: 4, to: 4, why: 'refused', held: true }]);
    expect(p.pages().limit).toBe(4);
  });

  it('a site that refuses every session (hold, refused): one page at a time, said held', () => {
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, onAdapt: (e) => changes.push(e) });
    p.hold(1, 'refused');
    expect(changes).toEqual([{ from: 4, to: 1, why: 'refused', held: true }]);
    expect(p.pages().limit).toBe(1);
  });

  it('a stylesheet refused, a time-out or a server error is not the site refusing us: no hold', async () => {
    const c = clock();
    const changes: PaceAdapt[] = [];
    const p = createPace({ concurrency: 8, start: 4, now: c.now, sleep: c.sleep, random: () => 1, onAdapt: (e) => changes.push(e) });
    p.fileRefused('https://cdn.example.net/a.css', { status: 429 }, `${HOST}/x`);
    await p.load(`${HOST}/t`, async () => { throw Object.assign(new Error('page.goto: Timeout 45000ms exceeded.'), { name: 'TimeoutError' }); }, () => null, { retries: 0 }).catch(() => undefined);
    await p.load(`${HOST}/e`, async () => { throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE'); }, () => null, { retries: 0, failedStatus: () => 500 }).catch(() => undefined);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((e) => e.held === undefined)).toBe(true);
  });
});

describe('stopping the controller (Pace.stop)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses the page turns still waiting, ends every wait, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    // Pages held by a cap of 0 (the cap is read again on a timer), and a load waiting out a Retry-After.
    const p = createPace({ concurrency: 8, start: 4, cap: () => 0, random: () => 1 });
    const turns = [p.page(), p.page()];
    for (const t of turns) t.catch(() => undefined);
    await p.load(`${HOST}/a`, async () => 429, (st) => ({ status: st, retryAfter: '10' }), { retries: 0 });
    const waiting = p.load(`${HOST}/b`, async () => 200, (st) => ({ status: st }));
    waiting.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    p.stop();
    for (const t of turns) await expect(t).rejects.toBeInstanceOf(ScanStopped);
    await expect(waiting).rejects.toBeInstanceOf(ScanStopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    // Later turns are refused at once; stop is idempotent.
    await expect(p.page()).rejects.toBeInstanceOf(ScanStopped);
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
