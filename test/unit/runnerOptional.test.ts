// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Optional runs (red-team 2026-11-10, coverage lane; src/probes/runner.ts `add` with `optional`): the extra
// coverage runs. They wait behind every run that is not optional, on a page load of their own, and one that
// cannot start in time is left out without a trace: never "cut short", never "not tested", never a criterion
// that reads "Partly tested". The coverage hooks are observation only. The queue rules themselves:
// test/unit/runnerQueueRules.test.ts.
import { describe, expect, it } from 'vitest';
import { HOOK_MS, createProbeRunner } from '../../src/probes/runner.js';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { ProbeFinding } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const OPTS = { userAgent: 'test-agent' };
const page = (index: number, path = `/p${index}`) => ({ url: `https://e.org${path}`, index });
const started: string[] = [];
const ok = (id: string, extra: Partial<PageProbe> = {}, ms = 0): PageProbe => ({
  id, criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 2000, ...extra,
  run: async (ctx) => {
    started.push(`${id} ${new URL(ctx.url).pathname}`);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    return [{ criterion: '2.1.1', status: 'no_failures_found', detail: `${id} on ${ctx.url}` }];
  },
});
const ranOn = (runs: { probe: string; page: string }[]) => runs.map((r) => `${r.probe} ${new URL(r.page).pathname}`);

describe('optional runs', () => {
  it('the optional tests of a page run in a job of their own: the page is opened again for them', async () => {
    const fake = fakeProbeBrowser();
    const runner = createProbeRunner(fake.browser, [ok('every'), ok('slow')], OPTS);
    runner.add(page(0), ['every', 'slow'], { optional: ['slow'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0', 'slow /p0']);
    expect(fake.contexts).toBe(2);
  });

  it('runs that are all optional start after every run that is not, whatever order they were added in', async () => {
    started.length = 0;
    const runner = createProbeRunner(fakeProbeBrowser().browser, [ok('own', { isolate: true }, 15)], { ...OPTS, concurrency: 1 });
    runner.add(page(0), ['own'], { optional: ['own'] });
    runner.add(page(1), ['own'], { optional: ['own'] });
    runner.add(page(2));
    runner.add(page(3));
    await runner.finish();
    // The first optional run had its page open when the required ones were queued: it gave its place to
    // them, and ran again behind the optional run that was already waiting.
    expect(started).toEqual(['own /p2', 'own /p3', 'own /p1', 'own /p0']);
  });

  it('a page\'s optional tests wait behind every required one, of any page, in the order they were queued', async () => {
    started.length = 0;
    const runner = createProbeRunner(fakeProbeBrowser().browser, [ok('every', {}, 10), ok('slow', {}, 10), ok('own', { isolate: true }, 10)], { ...OPTS, concurrency: 1 });
    runner.add(page(1), ['own'], { optional: ['own'] });
    runner.add(page(2), ['every', 'slow'], { optional: ['slow'] });
    runner.add(page(3), ['every', 'slow']);
    await runner.finish();
    // (Page 1's optional run had its page open when the required work came: it went back to the end of the queue.)
    expect(started).toEqual(['every /p2', 'every /p3', 'slow /p3', 'slow /p2', 'own /p1']);
  });

  it('past its time an optional run is not started and leaves no trace: no run, not counted, not unfinished', async () => {
    let over = false;
    const runner = createProbeRunner(fakeProbeBrowser().browser, [ok('every'), ok('slow'), ok('own', { isolate: true })], { ...OPTS, concurrency: 1, optionalUntil: () => (over ? 0 : undefined) });
    runner.add(page(0));
    runner.add(page(1), ['every', 'slow', 'own'], { optional: ['slow', 'own'] });
    over = true;
    const runs = await runner.finish();
    // Page 1 keeps the test that was not optional, on its own page load.
    expect(ranOn(runs)).toEqual(['every /p0', 'slow /p0', 'own /p0', 'every /p1']);
    expect(runner.counts()).toEqual({ queued: 4, done: 4 });
    expect(runner.unfinished(runs)).toEqual([]);
    expect(runner.unfinished([])).toHaveLength(4);
    // The criterion's result is the pages tested, never "Partly tested".
    const r = probeCriteriaResults(runs).find((x) => x.method.id === 'slow')!;
    expect(r.method).toMatchObject({ status: 'no_failures_found', pages: 1 });
  });

  it('look-alike: the same run not marked optional is still reported as not finished when the scan stops', async () => {
    const stop = new AbortController();
    const runner = createProbeRunner(fakeProbeBrowser().browser, [ok('every'), ok('slow')], { ...OPTS, signal: stop.signal });
    stop.abort();
    runner.add(page(0), ['every', 'slow']);
    const runs = await runner.finish();
    expect(runs.map((r) => r.findings[0]!.status)).toEqual(['not_testable', 'not_testable']);
  });

  it('a stop of the tests or of the deep tests ends the optional runs: one cut while it ran is left out too', async () => {
    const stop = new AbortController();
    const slow: PageProbe = { ...ok('slow', { isolate: true }), run: async () => { stop.abort(); await new Promise((r) => setTimeout(r, 30)); return []; } };
    const runner = createProbeRunner(fakeProbeBrowser().browser, [ok('every'), slow], { ...OPTS, concurrency: 1, signal: stop.signal });
    runner.add(page(0), ['every']);
    runner.add(page(1), ['slow'], { optional: ['slow'] });
    runner.add(page(2), ['slow'], { optional: ['slow'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0']);
    expect(runner.unfinished(runs)).toEqual([]);
    const deep = new AbortController();
    deep.abort();
    const other = createProbeRunner(fakeProbeBrowser().browser, [ok('every'), ok('own', { isolate: true })], { ...OPTS, deepSignal: deep.signal });
    other.add(page(0), ['every', 'own'], { optional: ['own'] });
    expect(ranOn(await other.finish())).toEqual(['every /p0']);
  });
});

describe('an optional run whose page does not load for it', () => {
  it('leaves no trace: never a page that "did not load", a bot challenge or a lost browser for the scan to act on', async () => {
    // The page answers 500 to the test's own load (as a refusal or a bot challenge would).
    const fake = fakeProbeBrowser({ statusFor: (path) => (path === '/p1' ? 500 : 200) });
    const runner = createProbeRunner(fake.browser, [ok('every'), ok('own', { isolate: true })], OPTS);
    runner.add(page(0));
    runner.add(page(1), ['own'], { optional: ['own'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0', 'own /p0']);
    expect(runner.unfinished(runs)).toEqual([]);
    // Look-alike: the same run when it is required says the page did not load for the test.
    const again = createProbeRunner(fakeProbeBrowser({ statusFor: (path) => (path === '/p1' ? 500 : 200) }).browser, [ok('own', { isolate: true })], OPTS);
    again.add(page(1), ['own']);
    const required = await again.finish();
    expect(required.map((r) => [r.findings[0]!.status, r.findings[0]!.loadFailure])).toEqual([['not_testable', 'not-loaded']]);
  });
});

describe('the coverage hooks', () => {
  it('hear each page a group opened and each test\'s findings as it gave them, with the page', async () => {
    const opened: string[] = [];
    const heard: string[] = [];
    const failing: PageProbe = { ...ok('k'), run: async () => [{ criterion: '2.1.1', status: 'failed', target: 'footer > a', detail: 'x', extra: 'kept for the hook' } as ProbeFinding] };
    const runs = await (async () => {
      const runner = createProbeRunner(fakeProbeBrowser().browser, [failing, ok('own', { isolate: true })], {
        ...OPTS,
        onPageOpened: (p, target) => { opened.push(`${target.url} ${typeof p.evaluate}`); },
        onFindings: (_p, probe, target, findings) => { heard.push(`${probe.id} ${target.url} ${findings.map((f) => f.target ?? '-').join()}`); },
      });
      runner.add(page(0));
      return runner.finish();
    })();
    expect(opened.sort()).toEqual(['https://e.org/p0 function', 'https://e.org/p0 function']);
    expect(heard.sort()).toEqual(['k https://e.org/p0 footer > a', 'own https://e.org/p0 -']);
    expect(runs.map((r) => r.findings[0]!.status)).toEqual(['failed', 'no_failures_found']);
  });

  it('a hook that throws, rejects or never answers changes no result', async () => {
    expect(HOOK_MS).toBeLessThanOrEqual(1500);
    const runner = createProbeRunner(fakeProbeBrowser().browser, [ok('a')], {
      ...OPTS,
      onPageOpened: () => { throw new Error('boom'); },
      onFindings: () => Promise.reject(new Error('boom')),
    });
    runner.add(page(0));
    expect((await runner.finish()).map((r) => [r.status, r.findings[0]!.status])).toEqual([['ok', 'no_failures_found']]);
    const hung = createProbeRunner(fakeProbeBrowser().browser, [ok('a')], { ...OPTS, onFindings: () => new Promise<void>(() => {}) });
    hung.add(page(0));
    const t0 = Date.now();
    expect((await hung.finish()).map((r) => r.findings[0]!.status)).toEqual(['no_failures_found']);
    expect(Date.now() - t0).toBeLessThan(HOOK_MS + 1500);
  }, 10_000);
});
