// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The per-host politeness controller (src/pace.ts) on a fake clock: no real waits, no network.
import { describe, expect, it } from 'vitest';
import { PACE_DEFAULTS, createPace, isPaceReason, retryAfterMs, type PaceOptions } from '../../src/pace.js';
import { runProbes } from '../../src/probes/runner.js';
import { parseRobots } from '../../src/robots.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

/** A fake clock: `sleep` advances time at once and records each wait. */
function clock(start = 1_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
      await Promise.resolve();
    },
    advance: (ms: number) => { t += ms; },
    waits,
  };
}

const URL_A = 'https://example.org/a';
const answer = (status: number, retryAfter?: string) => ({ status, retryAfter });
type Ans = ReturnType<typeof answer>;

function pace(opts: Partial<PaceOptions> = {}) {
  const c = clock();
  const p = createPace({ concurrency: 6, now: c.now, sleep: c.sleep, random: () => 1, ...opts });
  return { p, c };
}

/** A load whose server answers from a script, one entry per request. */
function scripted(statuses: Ans[]) {
  let i = 0;
  const calls: number[] = [];
  return {
    run: async () => {
      calls.push(i);
      return statuses[Math.min(i++, statuses.length - 1)]!;
    },
    calls,
  };
}

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates, caps them and never goes below the floor', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(retryAfterMs('1', now)).toBe(1000);
    expect(retryAfterMs(' 7 ', now)).toBe(7000);
    expect(retryAfterMs('3600', now)).toBe(PACE_DEFAULTS.maxWaitMs);
    expect(retryAfterMs('Sun, 01 Nov 2026 12:00:05 GMT', now)).toBe(5000);
    expect(retryAfterMs('0', now)).toBe(PACE_DEFAULTS.minRetryAfterMs);
    expect(retryAfterMs('Sun, 01 Nov 2026 11:00:00 GMT', now)).toBe(PACE_DEFAULTS.minRetryAfterMs);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs('-5', now)).toBeUndefined();
  });
});

describe('createPace', () => {
  it('retries a 429 after the Retry-After wait and succeeds', async () => {
    const { p, c } = pace();
    const s = scripted([answer(429, '1'), answer(200)]);
    const r = await p.load(URL_A, s.run, (a) => a);
    expect(r.refused).toBeUndefined();
    expect(r.value?.status).toBe(200);
    expect(s.calls).toHaveLength(2);
    expect(c.waits).toEqual([1000]);
    expect(p.summary()).toMatchObject({ slowedDown: true, refusals: [{ status: 429, count: 1 }], retries: 1, pausedMs: 1000 });
  });

  it('gives up after the retry limit with a clear reason', async () => {
    const { p } = pace();
    const s = scripted([answer(429, '1')]);
    const r = await p.load(URL_A, s.run, (a) => a);
    expect(s.calls).toHaveLength(1 + PACE_DEFAULTS.retries);
    expect(r.refused).toBe('The site asked us to slow down (HTTP 429) and kept refusing');
    expect(r.status).toBe(429);
    expect(isPaceReason(r.refused)).toBe(true);
  });

  it('backs off exponentially with jitter when there is no Retry-After', async () => {
    const { p, c } = pace({ random: () => 0 });
    const s = scripted([answer(503), answer(503), answer(503), answer(200)]);
    const r = await p.load(URL_A, s.run, (a) => a);
    expect(r.value?.status).toBe(200);
    // random 0 → half of base·2^n.
    const b = PACE_DEFAULTS.backoffMs;
    expect(c.waits).toEqual([b / 2, b, 2 * b]);
  });

  it('a 403 on the first request from a host is a real refusal: not retried', async () => {
    const { p } = pace();
    const s = scripted([answer(403), answer(200)]);
    const r = await p.load(URL_A, s.run, (a) => a);
    expect(s.calls).toHaveLength(1);
    expect(r.refused).toBeUndefined();
    expect(r.value?.status).toBe(403);
    expect(p.summary()).toBeUndefined();
  });

  it('a 403 after earlier successes from the host is a burst block: retried', async () => {
    const { p } = pace();
    await p.load(URL_A, async () => answer(200), (a) => a);
    const s = scripted([answer(403), answer(200)]);
    const r = await p.load('https://example.org/b', s.run, (a) => a);
    expect(s.calls).toHaveLength(2);
    expect(r.value?.status).toBe(200);
    // Another host's successes do not count.
    const other = scripted([answer(403), answer(200)]);
    const o = await p.load('https://other.example/x', other.run, (a) => a);
    expect(other.calls).toHaveLength(1);
    expect(o.value?.status).toBe(403);
  });

  it('a 403 is never a refusal for a non-page request (documents)', async () => {
    const { p } = pace();
    await p.load(URL_A, async () => answer(200), (a) => a);
    const s = scripted([answer(403), answer(200)]);
    const r = await p.load('https://example.org/doc.pdf', s.run, (a) => a, { page: false });
    expect(s.calls).toHaveLength(1);
    expect(r.value?.status).toBe(403);
  });

  it('stops retrying when the wait would not fit in the scan budget', async () => {
    const c = clock();
    const p = createPace({ concurrency: 6, now: c.now, sleep: c.sleep, random: () => 1, deadline: c.now() + 3000 });
    const s = scripted([answer(429, '5')]);
    const r = await p.load(URL_A, s.run, (a) => a);
    expect(s.calls).toHaveLength(1);
    expect(c.waits).toEqual([]);
    expect(r.refused).toBe('The site asked us to slow down (HTTP 429), and there was no time left in the scan to wait and try again');
    expect(r.status).toBe(429);
    expect(isPaceReason(r.refused)).toBe(true);
    // Another load to the paused host does not start: its wait would not fit either.
    const t = scripted([answer(200)]);
    const r2 = await p.load('https://example.org/b', t.run, (a) => a);
    expect(t.calls).toHaveLength(0);
    expect(r2.refused).toBe('The site asked us to slow down, and there was no time left in the scan to wait');
  });

  it('a load option deadline tightens the scan budget', async () => {
    const { p, c } = pace();
    const s = scripted([answer(429, '5')]);
    const r = await p.load(URL_A, s.run, (a) => a, { deadline: c.now() + 1000 });
    expect(s.calls).toHaveLength(1);
    expect(r.refused).toMatch(/no time left/);
  });

  it('drops the host to one load at a time on a refusal, then climbs back gradually', async () => {
    const { p } = pace({ concurrency: 3, recoverAfter: 2 });
    let active = 0;
    let max = 0;
    const gate: (() => void)[] = [];
    const held = (status: number) => async () => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((r) => gate.push(r));
      active--;
      return answer(status);
    };
    const flush = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    // Unslowed: no limit of its own (the scan's pools decide).
    const first = [p.load(URL_A, held(200), (a) => a), p.load(URL_A, held(200), (a) => a), p.load(URL_A, held(200), (a) => a), p.load(URL_A, held(200), (a) => a)];
    await flush();
    expect(active).toBe(4);
    gate.splice(0).forEach((g) => g());
    await Promise.all(first);
    // A refusal: one at a time.
    await p.load(URL_A, async () => answer(429, '1'), (a) => a, { retries: 0 });
    expect(p.limit('example.org')).toBe(1);
    max = 0;
    const slow = [1, 2, 3].map(() => p.load(URL_A, held(200), (a) => a));
    for (let i = 0; i < 10; i++) {
      await flush();
      gate.splice(0).forEach((g) => g());
    }
    await Promise.all(slow);
    expect(max).toBe(1);
    // Two successes per step: 3 successes took it to 2, then on to 3 = the configured value, where the limit lifts.
    await p.load(URL_A, async () => answer(200), (a) => a);
    expect(p.limit('example.org')).toBeNull();
  });

  it('keeps every load to a paused host waiting, not only the refused one', async () => {
    const { p, c } = pace();
    const t0 = c.now();
    await p.load(URL_A, async () => answer(429, '2'), (a) => a, { retries: 0 });
    let startedAt = 0;
    await p.load('https://example.org/b', async () => { startedAt = c.now(); return answer(200); }, (a) => a);
    expect(startedAt - t0).toBeGreaterThanOrEqual(2000);
  });

  it('honours a crawl delay between page loads to that host, and only page loads', async () => {
    const { p, c } = pace();
    p.setCrawlDelay('example.org', 3);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) await p.load(URL_A, async () => { starts.push(c.now()); return answer(200); }, (a) => a);
    expect(starts[1]! - starts[0]!).toBe(3000);
    expect(starts[2]! - starts[1]!).toBe(3000);
    // A document request is not held back.
    const before = c.now();
    await p.load('https://example.org/x.pdf', async () => answer(200), (a) => a, { page: false });
    expect(c.now()).toBe(before);
    // Another host is not held back either.
    await p.load('https://other.example/', async () => answer(200), (a) => a);
    expect(c.now()).toBe(before);
    expect(p.summary()).toMatchObject({ slowedDown: false, crawlDelayMs: 3000 });
  });

  it('loads in one crawl group (a page\'s two widths) count as one load for the delay', async () => {
    const { p, c } = pace();
    p.setCrawlDelay('example.org', 2);
    const starts: number[] = [];
    const run = async () => { starts.push(c.now()); return answer(200); };
    await Promise.all([p.load(URL_A, run, (a) => a, { crawlGroup: 'a' }), p.load(URL_A, run, (a) => a, { crawlGroup: 'a' })]);
    await Promise.all([p.load('https://example.org/b', run, (a) => a, { crawlGroup: 'b' }), p.load('https://example.org/b', run, (a) => a, { crawlGroup: 'b' })]);
    expect(starts[1]! - starts[0]!).toBe(0);
    expect(starts[2]! - starts[0]!).toBe(2000);
    expect(starts[3]! - starts[2]!).toBe(0);
  });

  it('a priority load (an evidence picture\'s reload) takes the next crawl gap ahead of loads already waiting', async () => {
    // Real timers: a 40 ms crawl delay and four loaders that keep the gap busy, as the probes do.
    const p = createPace({ concurrency: 6 });
    p.setCrawlDelay('example.org', 0.04);
    const order: string[] = [];
    const busy = (name: string) => (async () => {
      for (let i = 0; i < 4; i++) await p.load(`${URL_A}?${name}${i}`, async () => { order.push(name); return answer(200); }, (a) => a);
    })();
    const loaders = ['a', 'b', 'c', 'd'].map(busy);
    await new Promise((r) => setTimeout(r, 10));
    const pic = p.load(URL_A, async () => { order.push('pic'); return answer(200); }, (a) => a, { priority: true });
    await Promise.all([pic, ...loaders]);
    // Each queued loader would otherwise go first: the picture gets the gap after the one in progress.
    expect(order.indexOf('pic')).toBeLessThanOrEqual(1 + 1);
    expect(order).toHaveLength(17);
  });

  it('loads waiting for the crawl gap go in arrival order: a waiting load is never overtaken by a later one', async () => {
    const p = createPace({ concurrency: 6 });
    p.setCrawlDelay('example.org', 0.03);
    const order: string[] = [];
    const busy = (name: string) => (async () => {
      for (let i = 0; i < 4; i++) await p.load(`${URL_A}?${name}${i}`, async () => { order.push(name); return answer(200); }, (a) => a);
    })();
    const loaders = ['a', 'b', 'c', 'd'].map(busy);
    await new Promise((r) => setTimeout(r, 10));
    const late = p.load(URL_A, async () => { order.push('late'); return answer(200); }, (a) => a);
    await Promise.all([late, ...loaders]);
    // The first load ran at once; the three waiting loaders and the first one's next load come before it, nothing more.
    expect(order.indexOf('late')).toBeLessThanOrEqual(5);
  });

  it('normal loads are not held back by a priority load that gave up', async () => {
    const c = clock();
    const p = createPace({ concurrency: 6, now: c.now, sleep: c.sleep, deadline: c.now() + 1500 });
    p.setCrawlDelay('example.org', 2);
    await p.load(URL_A, async () => answer(200), (a) => a);
    const r = await p.load(URL_A, async () => answer(200), (a) => a, { priority: true });
    expect(r.refused).toMatch(/no time left/);
    const late = await p.load('https://other.example/', async () => answer(200), (a) => a);
    expect(late.value?.status).toBe(200);
  });

  it('a discovery fetch (not a page) counts no success for the 403 rule', async () => {
    const { p } = pace();
    await p.load('https://example.org/robots.txt', async () => answer(200), (a) => a, { page: false });
    const s = scripted([answer(403), answer(200)]);
    const r = await p.load(URL_A, s.run, (a) => a);
    expect(s.calls).toHaveLength(1);
    expect(r.value?.status).toBe(403);
  });

  it('caps the crawl delay and stops when the gap would not fit the budget', async () => {
    const c = clock();
    const p = createPace({ concurrency: 6, now: c.now, sleep: c.sleep, deadline: c.now() + 15_000 });
    p.setCrawlDelay('example.org', 600);
    await p.load(URL_A, async () => answer(200), (a) => a);
    await p.load(URL_A, async () => answer(200), (a) => a);
    expect(c.waits).toEqual([PACE_DEFAULTS.maxCrawlDelayMs]);
    const r = await p.load(URL_A, async () => answer(200), (a) => a);
    expect(r.refused).toBe('The site’s robots.txt asks for a pause between pages, and there was no time left in the scan for it');
    expect(isPaceReason(r.refused)).toBe(true);
  });

  it('gives up on a host that refuses everything: the total wait stays bounded', async () => {
    const { p, c } = pace();
    let calls = 0;
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await p.load(`https://example.org/p${i}`, async () => { calls++; return answer(429, '20'); }, (a) => a));
    // Three addresses (4 + 4 tries) take it past 6 refusals in a row: the third gives up at once, the rest never load.
    expect(calls).toBe(9);
    expect(c.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(calls * PACE_DEFAULTS.maxWaitMs);
    expect(results.every((r) => r.refused === 'The site asked us to slow down (HTTP 429) and kept refusing' && r.status === 429)).toBe(true);
  });

  it('one address the site always refuses never stops the rest of the scan', async () => {
    const { p } = pace();
    for (let i = 0; i < 3; i++) {
      const r = await p.load(URL_A, async () => answer(429, '1'), (a) => a);
      expect(r.refused).toMatch(/kept refusing/);
    }
    const other = await p.load('https://example.org/fine', async () => answer(200), (a) => a);
    expect(other.value?.status).toBe(200);
  });

  it('refusals of requests already on their way count as one round', async () => {
    const { p } = pace({ random: () => 0 });
    const gate: (() => void)[] = [];
    const held = () => new Promise<Ans>((r) => gate.push(() => r(answer(503))));
    // Eight loads in flight, all refused at once: one strike, so the backoff is the first step's, and nobody gives up.
    const all = Array.from({ length: 8 }, () => p.load(URL_A, held, (a) => a, { retries: 0 }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    gate.splice(0).forEach((g) => g());
    await Promise.all(all);
    const r = await p.load(URL_A, async () => answer(200), (a) => a);
    expect(r.value?.status).toBe(200);
  });

  it('a load that throws frees its slot and does not count', async () => {
    const { p } = pace();
    await expect(p.load(URL_A, async () => { throw new Error('net'); }, (a: Ans) => a)).rejects.toThrow('net');
    const r = await p.load(URL_A, async () => answer(200), (a) => a);
    expect(r.value?.status).toBe(200);
    expect(p.summary()).toBeUndefined();
  });

  it('discards a refused value before trying again', async () => {
    const { p } = pace();
    const dropped: number[] = [];
    const s = scripted([answer(429, '1'), answer(200)]);
    await p.load(URL_A, s.run, (a) => a, { discard: (a) => dropped.push(a.status) });
    expect(dropped).toEqual([429]);
  });

  it('an aborted signal ends the wait with an abort error', async () => {
    const c = clock();
    const ctl = new AbortController();
    const p = createPace({ concurrency: 6, now: c.now, sleep: async (ms, signal) => { ctl.abort(); c.advance(ms); expect(signal?.aborted).toBe(true); } });
    await expect(p.load(URL_A, async () => answer(429, '1'), (a) => a, { signal: ctl.signal })).rejects.toThrow();
  });

  it('tells the scan when a host slows down and when it recovers', async () => {
    const changes: string[] = [];
    const { p } = pace({ concurrency: 2, recoverAfter: 1, onChange: (e) => changes.push(`${e.step}:${e.host}`) });
    await p.load(URL_A, scripted([answer(429, '1'), answer(200)]).run, (a) => a);
    await p.load(URL_A, async () => answer(200), (a) => a);
    expect(changes).toEqual(['slowed:example.org', 'recovered:example.org']);
  });
});

describe('parseRobots crawl-delay', () => {
  it('reads Crawl-delay from the group that applies to us', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 2.5\nDisallow: /x', 'grnted').crawlDelay).toBe(2.5);
    expect(parseRobots('User-agent: grnted\nCrawl-delay: 4\n\nUser-agent: *\nCrawl-delay: 1', 'grnted').crawlDelay).toBe(4);
    expect(parseRobots('User-agent: other\nCrawl-delay: 9\n\nUser-agent: *\nDisallow: /p', 'grnted').crawlDelay).toBeUndefined();
    expect(parseRobots('User-agent: *\nCrawl-delay: soon', 'grnted').crawlDelay).toBeUndefined();
    expect(parseRobots('User-agent: *\nCrawl-delay: -1', 'grnted').crawlDelay).toBeUndefined();
    expect(parseRobots('', 'grnted').crawlDelay).toBeUndefined();
  });
});

describe('the probe runner with the controller', () => {
  it('a refused page load is tried again after a pause, and the probes run', async () => {
    let n = 0;
    const fake = fakeProbeBrowser({ statusFor: () => (++n === 1 ? 429 : 200) });
    const probe = { id: 'p', criteria: ['2.1.1'], kind: 'interaction' as const, tier: 'core' as const, timeoutMs: 1000, run: async () => [{ criterion: '2.1.1', status: 'no_failures_found' as const, detail: 'ok' }] };
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [probe], { userAgent: 'UA', pace: createPace({ concurrency: 1, backoffMs: 10 }) });
    expect(n).toBe(2);
    expect(runs.map((r) => [r.status, r.findings[0]!.detail])).toEqual([['ok', 'ok']]);
  });

  it('a page that keeps refusing: the probes say why they did not run', async () => {
    const fake = fakeProbeBrowser({ statusFor: () => 503 });
    const probe = { id: 'p', criteria: ['2.1.1'], kind: 'interaction' as const, tier: 'core' as const, timeoutMs: 1000, run: async () => [] };
    const runs = await runProbes(fake.browser, [{ url: 'https://e.org/p0', index: 0 }], [probe], { userAgent: 'UA', pace: createPace({ concurrency: 1, backoffMs: 5, retries: 1 }) });
    expect(runs[0]!.findings[0]!.detail).toBe('the page did not load for this test: The site asked us to slow down (HTTP 503) and kept refusing');
  });
});
