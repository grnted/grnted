// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Work by (page, test) (perf/split-tests, spec 2026-11-09 parts 1 and 3; queue rules 2 and 8 in
// src/probes/runner.ts): the optional coverage runs are jobs of their own, by unit (`ProbeRunner.add` `units`),
// that any free tab can take; required runs keep their jobs, their room and their order, and are never delayed by
// optional work; a page's required job goes on with that page's optional tests that need no load of their own (its
// riders, and its units no tab has started) instead of the page being loaded again; optional runs may use extra
// tabs (`optionalTabs`) that required runs never use, and their loads take the optional load turn.
import { describe, expect, it } from 'vitest';
import { createProbeRunner } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { ProbeRun } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const OPTS = { userAgent: 'test-agent' };
const page = (index: number, path = `/p${index}`) => ({ url: `https://e.org${path}`, index });
const ranOn = (runs: readonly { probe: string; page: string }[]) => runs.map((r) => `${r.probe} ${new URL(r.page).pathname}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A probe that records when it started and ended, and in which context. */
function rec(log: string[], fake: ReturnType<typeof fakeProbeBrowser>, ctxOf?: Map<string, number>) {
  return (id: string, extra: Partial<PageProbe> = {}, ms = 0, onStart?: (path: string) => void): PageProbe => ({
    id, criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 5000, ...extra,
    run: async (ctx) => {
      const where = new URL(ctx.url).pathname;
      log.push(`start ${id} ${where}`);
      ctxOf?.set(`${id} ${where}`, fake.contextOf(ctx.page));
      onStart?.(where);
      if (ms) await sleep(ms);
      log.push(`end ${id} ${where}`);
      return [{ criterion: '2.1.1', status: 'no_failures_found', detail: id }];
    },
  });
}

describe('optional units are jobs of their own', () => {
  it('two units of one page run at once in tabs of their own when tabs are free', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    const ctxOf = new Map<string, number>();
    const p = rec(log, fake, ctxOf);
    const runner = createProbeRunner(fake.browser, [p('every', {}, 30), p('k', {}, 30), p('f', {}, 30)], { ...OPTS, concurrency: 1, optionalTabs: () => 2 });
    runner.add(page(0), ['every', 'k', 'f'], { optional: ['k', 'f'], units: [{ probes: ['k'] }, { probes: ['f'] }] });
    const runs = await runner.finish();
    expect(new Set(ctxOf.values()).size).toBe(3);
    // Both units started before the required job ended.
    const endEvery = log.indexOf('end every /p0');
    expect(log.indexOf('start k /p0')).toBeLessThan(endEvery);
    expect(log.indexOf('start f /p0')).toBeLessThan(endEvery);
    // Results in registry order, whatever order the jobs ran in.
    expect(ranOn(runs)).toEqual(['every /p0', 'k /p0', 'f /p0']);
  });

  it('without units, a page\'s optional tests of one context group stay one job (as before)', async () => {
    const fake = fakeProbeBrowser();
    const ctxOf = new Map<string, number>();
    const p = rec([], fake, ctxOf);
    const runner = createProbeRunner(fake.browser, [p('k'), p('f')], { ...OPTS, concurrency: 1, optionalTabs: () => 4 });
    runner.add(page(0), ['k', 'f'], { optional: ['k', 'f'] });
    await runner.finish();
    expect(fake.contexts).toBe(1);
  });
});

describe('a required job\'s page goes on with optional tests (no second load)', () => {
  it('with no tab free, the page\'s required job takes its units over on the page it loaded (one load)', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    const p = rec(log, fake);
    const runner = createProbeRunner(fake.browser, [p('every'), p('k'), p('f')], { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['every', 'k', 'f'], { optional: ['k', 'f'], units: [{ probes: ['k'] }, { probes: ['f'] }] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0', 'k /p0', 'f /p0']);
    expect(fake.contexts).toBe(1);
    expect(fake.events.filter((e) => e.type === 'goto')).toHaveLength(1);
    expect(runner.counts()).toEqual({ queued: 3, done: 3 });
  });

  it('a rider unit waits for its page\'s required job, even with tabs free, and goes on on its load', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    const p = rec(log, fake);
    const runner = createProbeRunner(fake.browser, [p('every', {}, 20), p('cheap')], { ...OPTS, concurrency: 1, optionalTabs: () => 4 });
    runner.add(page(0), ['every', 'cheap'], { optional: ['cheap'], units: [{ probes: ['cheap'], rider: true }] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0', 'cheap /p0']);
    expect(fake.contexts).toBe(1);
    expect(log).toEqual(['start every /p0', 'end every /p0', 'start cheap /p0', 'end cheap /p0']);
  });

  it('a unit in another context group is never taken over (it needs its own page)', async () => {
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('every'), p('own', { isolate: true })], { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['every', 'own'], { optional: ['own'] });
    await runner.finish();
    expect(fake.contexts).toBe(2);
  });

  it('a rider whose page has no required job of its group is a job of its own, its riders together', async () => {
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('a'), p('b')], { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['a', 'b'], { optional: ['a', 'b'], units: [{ probes: ['a'], rider: true }, { probes: ['b'], rider: true }] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['a /p0', 'b /p0']);
    expect(fake.contexts).toBe(1);
  });

  it('required work waiting when the required tests end: the riders do not go on, they run later as a job of their own', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    let runner!: ReturnType<typeof createProbeRunner>;
    const p = rec(log, fake);
    // While /p0's required test runs, /p1's required test is queued (its audit just ended).
    const list = [p('every', {}, 20, (path) => { if (path === '/p0') runner.add(page(1), ['every']); }), p('cheap')];
    runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['every', 'cheap'], { optional: ['cheap'], units: [{ probes: ['cheap'], rider: true }] });
    const runs = await runner.finish();
    expect(log.filter((l) => l.startsWith('start'))).toEqual(['start every /p0', 'start every /p1', 'start cheap /p0']);
    expect(ranOn(runs)).toEqual(['every /p0', 'cheap /p0', 'every /p1']);
    expect(fake.contexts).toBe(3);
  });

  it('riders that cannot go on join the page\'s unit still waiting in the queue: one load for both, after the required work', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    let runner!: ReturnType<typeof createProbeRunner>;
    const p = rec(log, fake);
    const list = [p('every', {}, 20, (path) => { if (path === '/p0') runner.add(page(1), ['every']); }), p('cheap'), p('k')];
    runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['every', 'cheap', 'k'], { optional: ['cheap', 'k'], units: [{ probes: ['cheap'], rider: true }, { probes: ['k'] }] });
    const runs = await runner.finish();
    expect(log.filter((l) => l.startsWith('start'))).toEqual(['start every /p0', 'start every /p1', 'start cheap /p0', 'start k /p0']);
    expect(ranOn(runs)).toEqual(['every /p0', 'cheap /p0', 'k /p0', 'every /p1']);
    // /p0 twice (its required load, then one for both optional tests), /p1 once.
    expect(fake.contexts).toBe(3);
  });

  it('riders with no required job of their group join its other unit (one load for both)', async () => {
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('cheap'), p('k'), p('own', { isolate: true })], { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['cheap', 'k', 'own'], { optional: ['cheap', 'k', 'own'], units: [{ probes: ['cheap'], rider: true }, { probes: ['k'] }, { probes: ['own'] }] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['cheap /p0', 'k /p0', 'own /p0']);
    expect(fake.contexts).toBe(2);
  });

  it('required work waiting when the required tests end, with a tab free for it: the page goes on and the required work starts at once', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    let runner!: ReturnType<typeof createProbeRunner>;
    const p = rec(log, fake);
    const list = [p('every', {}, 20, (path) => { if (path === '/p0') runner.add(page(1), ['every']); }), p('cheap', {}, 40)];
    runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1, optionalTabs: () => 1 });
    runner.add(page(0), ['every', 'cheap'], { optional: ['cheap'], units: [{ probes: ['cheap'], rider: true }] });
    const runs = await runner.finish();
    // /p1's required test did not wait for /p0's optional one: it started while that ran, in the other tab.
    expect(log.indexOf('start every /p1')).toBeLessThan(log.indexOf('end cheap /p0'));
    expect(log.indexOf('start cheap /p0')).toBeGreaterThan(log.indexOf('end every /p0'));
    expect(ranOn(runs)).toEqual(['every /p0', 'cheap /p0', 'every /p1']);
    // One load for /p0 (the optional test went on on it), one for /p1.
    expect(fake.contexts).toBe(2);
    expect(fake.maxOpen).toBe(2);
  });

  it('required work that arrives while the page goes on takes the context: the optional tests left run later, none lost', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    let runner!: ReturnType<typeof createProbeRunner>;
    let queued = false;
    const p = rec(log, fake);
    const list = [p('every'), p('o1', {}, 40, () => { if (!queued) { queued = true; runner.add(page(1), ['every']); } }), p('o2')];
    runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['every', 'o1', 'o2'], { optional: ['o1', 'o2'], units: [{ probes: ['o1', 'o2'], rider: true }] });
    const runs = await runner.finish();
    const starts = log.filter((l) => l.startsWith('start'));
    // o1 gave its context back mid-test (rule 4) and ran again once /p1's required test was done.
    expect(starts).toEqual(['start every /p0', 'start o1 /p0', 'start every /p1', 'start o1 /p0', 'start o2 /p0']);
    expect(ranOn(runs)).toEqual(['every /p0', 'o1 /p0', 'o2 /p0', 'every /p1']);
    expect(runner.counts()).toEqual({ queued: 4, done: 4 });
    expect(runner.unfinished(runs)).toEqual([]);
  });

  it('past the optional cutoff when the required tests end, the riders are forgotten without a trace', async () => {
    const heard: string[] = [];
    const fake = fakeProbeBrowser();
    let over = false;
    const p = rec([], fake);
    const list = [p('every', {}, 0, () => { over = true; }), p('cheap')];
    const runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1, optionalUntil: () => (over ? 0 : undefined), onRun: (r) => heard.push(r.probe) });
    runner.add(page(0), ['every', 'cheap'], { optional: ['cheap'], units: [{ probes: ['cheap'], rider: true }] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0']);
    expect(heard).toEqual(['every']);
    expect(runner.counts()).toEqual({ queued: 1, done: 1 });
    expect(runner.unfinished(runs)).toEqual([]);
    expect(ranOn(runner.partial(runs))).toEqual(['every /p0']);
  });

  it('a test that goes on is asked once more at the last moment: its time running out in its own wait for the page leaves no trace', async () => {
    const log: string[] = [];
    const heard: string[] = [];
    let over = false;
    let requiredDone = false;
    // The page's content check (the wait before a test that asks for it) is where the cutoff passes.
    const fake = fakeProbeBrowser({ evaluate: (name) => { if (name === 'stillMounting' && requiredDone) over = true; return undefined; } });
    const p = rec(log, fake);
    const list = [p('every', {}, 0, () => { requiredDone = true; }), p('waits', { waitFor: { content: true } })];
    const runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1, optionalUntil: () => (over ? 0 : undefined), onRun: (r) => heard.push(r.probe) });
    runner.add(page(0), ['every', 'waits'], { optional: ['waits'], units: [{ probes: ['waits'], rider: true }] });
    const runs = await runner.finish();
    expect(over).toBe(true);
    expect(log.filter((l) => l.startsWith('start'))).toEqual(['start every /p0']);
    expect(ranOn(runs)).toEqual(['every /p0']);
    expect(heard).toEqual(['every']);
    expect(runner.counts()).toEqual({ queued: 1, done: 1 });
  });

  it('the tests that go on take no load turn of their own; one that needs a load takes the optional turn', async () => {
    const turns: string[] = [];
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('every'), p('types', { sendsNothing: true }), p('cheap', { sendsNothing: true })], {
      ...OPTS, concurrency: 1,
      loadTurn: () => { turns.push('normal'); return Promise.resolve({ release() {} }); },
      optionalLoadTurn: () => { turns.push('low'); return Promise.resolve({ release() {} }); },
    });
    runner.add(page(0), ['every', 'types', 'cheap'], { optional: ['types', 'cheap'], units: [{ probes: ['types', 'cheap'], rider: true }] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0', 'types /p0', 'cheap /p0']);
    // The required load; the first optional test needs none; after it typed, the page is loaded again (optional).
    expect(turns).toEqual(['normal', 'low']);
    expect(fake.contexts).toBe(2);
  });

  it('on the page that goes on, the tests that type go last (no load again for the others)', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    const p = rec(log, fake);
    const runner = createProbeRunner(fake.browser, [p('every'), p('types', { sendsNothing: true }), p('looks')], { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['every', 'types', 'looks'], { optional: ['types', 'looks'], units: [{ probes: ['types'], rider: true }, { probes: ['looks'], rider: true }] });
    const runs = await runner.finish();
    expect(log.filter((l) => l.startsWith('start'))).toEqual(['start every /p0', 'start looks /p0', 'start types /p0']);
    expect(ranOn(runs)).toEqual(['every /p0', 'types /p0', 'looks /p0']);
    expect(fake.contexts).toBe(1);
  });

  it('a page that was challenged does not go on; its riders\' own load is challenged too and leaves no trace', async () => {
    const heard: string[] = [];
    const fake = fakeProbeBrowser({ statusFor: (path) => (path === '/p0' ? 500 : 200) });
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('every'), p('cheap')], { ...OPTS, concurrency: 1, onRun: (r) => heard.push(r.probe) });
    runner.add(page(0), ['every', 'cheap'], { optional: ['cheap'], units: [{ probes: ['cheap'], rider: true }] });
    const runs = await runner.finish();
    // The required run says the page did not load; the rider's own load failed too: no trace of it.
    expect(ranOn(runs)).toEqual(['every /p0']);
    expect(heard).toEqual(['every']);
    expect(runner.counts()).toEqual({ queued: 1, done: 1 });
  });
});

describe('extra tabs for optional runs', () => {
  it('required runs never use the extra tabs: one at a time with a room of one', async () => {
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('every', {}, 15)], { ...OPTS, concurrency: 1, optionalTabs: () => 3 });
    for (let i = 0; i < 4; i++) runner.add(page(i));
    await runner.finish();
    expect(fake.maxOpen).toBe(1);
  });

  it('optional runs use the room and the extra tabs, never more than `maxSlots` in all', async () => {
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('own', { isolate: true }, 20)], { ...OPTS, concurrency: 2, optionalTabs: () => 10, maxSlots: 5 });
    for (let i = 0; i < 12; i++) runner.add(page(i), ['own'], { optional: ['own'] });
    await runner.finish();
    expect(fake.maxOpen).toBe(5);
  });

  it('without extra tabs, optional runs share the room as before', async () => {
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('own', { isolate: true }, 10)], { ...OPTS, concurrency: 2 });
    for (let i = 0; i < 6; i++) runner.add(page(i), ['own'], { optional: ['own'] });
    await runner.finish();
    expect(fake.maxOpen).toBe(2);
  });

  it('a throwing or odd `optionalTabs` is no extra tab', async () => {
    for (const odd of [() => { throw new Error('x'); }, () => Number.NaN, () => -3, () => 'two' as unknown as number]) {
      const fake = fakeProbeBrowser();
      const p = rec([], fake);
      const runner = createProbeRunner(fake.browser, [p('own', { isolate: true }, 10)], { ...OPTS, concurrency: 1, optionalTabs: odd });
      for (let i = 0; i < 3; i++) runner.add(page(i), ['own'], { optional: ['own'] });
      await runner.finish();
      expect(fake.maxOpen).toBe(1);
    }
  });

  it('optional runs\' loads take their own turn (`optionalLoadTurn`), required ones the ordinary turn', async () => {
    const turns: string[] = [];
    const fake = fakeProbeBrowser();
    const p = rec([], fake);
    const runner = createProbeRunner(fake.browser, [p('every'), p('own', { isolate: true })], {
      ...OPTS,
      loadTurn: () => { turns.push('normal'); return Promise.resolve({ release() {} }); },
      optionalLoadTurn: () => { turns.push('low'); return Promise.resolve({ release() {} }); },
    });
    runner.add(page(0), ['every', 'own'], { optional: ['own'] });
    await runner.finish();
    expect(turns.sort()).toEqual(['low', 'normal']);
  });

  it('optional work in the extra tabs is not stopped for required work that could not use its context', async () => {
    const log: string[] = [];
    const fake = fakeProbeBrowser();
    let runner!: ReturnType<typeof createProbeRunner>;
    const p = rec(log, fake);
    // /p0's required test holds the only required room; /p9's optional test runs in an extra tab. Required work
    // for /p1 arrives: it waits for the required room, and the optional test is left alone (it ran once).
    const list = [p('every', {}, 40, (path) => { if (path === '/p0') runner.add(page(1), ['every']); }), p('own', { isolate: true }, 30)];
    runner = createProbeRunner(fake.browser, list, { ...OPTS, concurrency: 1, optionalTabs: () => 1 });
    runner.add(page(9), ['own'], { optional: ['own'] });
    runner.add(page(0), ['every']);
    const runs = await runner.finish();
    expect(log.filter((l) => l === 'start own /p9')).toHaveLength(1);
    expect(ranOn(runs)).toEqual(['every /p0', 'every /p1', 'own /p9']);
  });

  it('the same runs with and without extra tabs (which tests run never depends on how jobs interleave)', async () => {
    const make = (tabs: number) => {
      const fake = fakeProbeBrowser();
      const p = rec([], fake);
      const runner = createProbeRunner(fake.browser, [p('every', {}, 5), p('k', {}, 10), p('cheap'), p('own', { isolate: true }, 10)], { ...OPTS, concurrency: 2, optionalTabs: () => tabs });
      for (let i = 0; i < 6; i++) {
        runner.add(page(i), ['every', 'k', 'cheap', 'own'], { optional: ['k', 'cheap', 'own'], units: [{ probes: ['k'] }, { probes: ['cheap'], rider: true }, { probes: ['own'] }] });
      }
      return runner.finish();
    };
    const strip = (runs: ProbeRun[]) => runs.map((r) => ({ ...r, ms: 0 }));
    const [none, some] = await Promise.all([make(0), make(4)]);
    expect(strip(some)).toEqual(strip(none));
    expect(ranOn(none)).toHaveLength(24);
  });
});
