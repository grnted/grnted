// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The probe runner's queue rules (review r1 of the coverage lane, findings 5 to 7; docs/redteam-triage-coverage.md
// "Queue rules"). Optional work is extra coverage: it never takes time or capacity from required work, and what
// of it does not happen leaves no trace anywhere a scan reads (the runs `finish` gives, the runs handed to
// `onRun` as they complete, `partial`, the counts).
import { describe, expect, it } from 'vitest';
import { createProbeRunner, type OptionalSkip } from '../../src/probes/runner.js';
import type { NavigatorHook, PlanEvent } from '../../src/probes/plan.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { ProbeRun } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const OPTS = { userAgent: 'test-agent' };
const page = (index: number, path = `/p${index}`) => ({ url: `https://e.org${path}`, index });
const ranOn = (runs: readonly { probe: string; page: string }[]) => runs.map((r) => `${r.probe} ${new URL(r.page).pathname}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A test that records when it starts, then takes `ms`; `onStart` runs once it has started. */
function probes(started: string[]) {
  return (id: string, extra: Partial<PageProbe> = {}, ms = 0, onStart?: (path: string) => void): PageProbe => ({
    id, criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 2000, ...extra,
    run: async (ctx) => {
      const path = new URL(ctx.url).pathname;
      started.push(`${id} ${path}`);
      onStart?.(path);
      if (ms) await sleep(ms);
      return [{ criterion: '2.1.1', status: 'no_failures_found', detail: `${id} on ${ctx.url}` }];
    },
  });
}

describe('finding 6: the optional cutoff is a deadline per optional test, and required tests go first', () => {
  it('a page whose time runs out while it loads or runs its required tests starts none of its optional ones', async () => {
    const started: string[] = [];
    const ok = probes(started);
    let over = false;
    // Registry order puts optional tests before a required one (as text spacing, resize and reflow come before
    // text contrast): the required one still runs first. The cutoff passes while it runs, as it would in a slow load.
    const list = [ok('spacing'), ok('resize'), ok('contrast', {}, 5, () => { over = true; }), ok('keyboard')];
    const runner = createProbeRunner(fakeProbeBrowser().browser, list, { ...OPTS, concurrency: 1, optionalUntil: () => (over ? 0 : undefined) });
    runner.add(page(6, '/news/6'), ['spacing', 'resize', 'contrast', 'keyboard'], { optional: ['spacing', 'resize', 'keyboard'] });
    const runs = await runner.finish();
    expect(started).toEqual(['contrast /news/6']);
    expect(ranOn(runs)).toEqual(['contrast /news/6']);
    expect(runner.counts()).toEqual({ queued: 1, done: 1 });
    expect(runner.unfinished(runs)).toEqual([]);
  });

  it('the cutoff is read again before each optional test of a page, not once for the page', async () => {
    const started: string[] = [];
    const ok = probes(started);
    let over = false;
    const list = [ok('first', {}, 5, () => { over = true; }), ok('second'), ok('third')];
    const runner = createProbeRunner(fakeProbeBrowser().browser, list, { ...OPTS, concurrency: 1, optionalUntil: () => (over ? 0 : undefined) });
    runner.add(page(1), ['first', 'second', 'third'], { optional: ['first', 'second', 'third'] });
    const runs = await runner.finish();
    // The first had started in time and stands; the two behind it are left out without a trace.
    expect(started).toEqual(['first /p1']);
    expect(ranOn(runs)).toEqual(['first /p1']);
    expect(runner.counts()).toEqual({ queued: 1, done: 1 });
  });

  it('required work queued while optional work runs takes its place: the optional tests wait and run afterwards', async () => {
    const started: string[] = [];
    const ok = probes(started);
    let runner!: ReturnType<typeof createProbeRunner>;
    let queued = false;
    // While the first optional test of /news/6 runs, a later page's required test is queued (its audit just ended).
    const list = [
      ok('opt1', {}, 60, () => { if (!queued) { queued = true; runner.add(page(7, '/services/7'), ['req']); } }),
      ok('opt2', {}, 5),
      ok('req', {}, 5),
    ];
    runner = createProbeRunner(fakeProbeBrowser().browser, list, { ...OPTS, concurrency: 1 });
    runner.add(page(6, '/news/6'), ['opt1', 'opt2', 'req'], { optional: ['opt1', 'opt2'] });
    const runs = await runner.finish();
    // Required first on its own page; the optional test that had started gives way to the required work that
    // arrived, and the optional tests run once nothing required is waiting.
    expect(started).toEqual(['req /news/6', 'opt1 /news/6', 'req /services/7', 'opt1 /news/6', 'opt2 /news/6']);
    expect(ranOn(runs)).toEqual(['opt1 /news/6', 'opt2 /news/6', 'req /news/6', 'req /services/7']);
    expect(runner.counts()).toEqual({ queued: 4, done: 4 });
  });

  it('look-alike: required tests of one page keep their registry order and share one page load', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const fake = fakeProbeBrowser();
    const runner = createProbeRunner(fake.browser, [ok('a'), ok('b'), ok('c')], { ...OPTS, concurrency: 1 });
    runner.add(page(0));
    await runner.finish();
    expect(started).toEqual(['a /p0', 'b /p0', 'c /p0']);
    expect(fake.contexts).toBe(1);
  });
});

describe('finding 5: an optional run that did not happen is in no list a scan reads', () => {
  const failing = () => fakeProbeBrowser({ statusFor: (path) => (path === '/p1' ? 500 : 200) });

  it('a run whose own page load failed is not handed to onRun, so the cut-short path cannot bring it back', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const emissions: ProbeRun[] = [];
    const runner = createProbeRunner(failing().browser, [ok('every'), ok('own', { isolate: true })], { ...OPTS, onRun: (r) => { emissions.push(r); } });
    runner.add(page(0), ['every']);
    runner.add(page(1), ['own'], { optional: ['own'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p0']);
    expect(ranOn(emissions)).toEqual(['every /p0']);
    expect(ranOn(runner.partial(emissions))).toEqual(['every /p0']);
  });

  it('partial applies the same filter to whatever it is handed', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const runner = createProbeRunner(failing().browser, [ok('every'), ok('own', { isolate: true })], OPTS);
    runner.add(page(0), ['every']);
    runner.add(page(1), ['own'], { optional: ['own'] });
    const runs = await runner.finish();
    // A challenge answered to an optional run's own load, as an earlier emission would have carried it.
    const challenged: ProbeRun = {
      probe: 'own', kind: 'interaction', page: 'https://e.org/p1', criteria: ['2.1.1'], status: 'error', ms: 0,
      findings: [{ criterion: '2.1.1', status: 'not_testable', detail: 'the site answered with a bot check', loadFailure: 'challenge' }],
    };
    expect(ranOn(runner.partial([...runs, challenged]))).toEqual(['every /p0']);
  });

  it('look-alike: the same failed load of a required run is reported, by finish and by partial alike', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const emissions: ProbeRun[] = [];
    const runner = createProbeRunner(failing().browser, [ok('own', { isolate: true })], { ...OPTS, onRun: (r) => { emissions.push(r); } });
    runner.add(page(1), ['own']);
    const runs = await runner.finish();
    expect(runs.map((r) => r.findings[0]!.loadFailure)).toEqual(['not-loaded']);
    expect(runner.partial(emissions).map((r) => r.findings[0]!.loadFailure)).toEqual(['not-loaded']);
  });

  it('finish does not wait for optional work once the tests are stopped', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const stop = new AbortController();
    // The optional run's page load never answers in time.
    const fake = fakeProbeBrowser({ delayFor: (path) => (path === '/p1' ? 400 : 0) });
    const runner = createProbeRunner(fake.browser, [ok('every'), ok('own', { isolate: true })], { ...OPTS, signal: stop.signal });
    runner.add(page(0), ['every']);
    runner.add(page(1), ['own'], { optional: ['own'] });
    await sleep(30);
    const t0 = Date.now();
    stop.abort();
    const runs = await runner.finish();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(ranOn(runs)).toEqual(['every /p0']);
    expect(runner.unfinished(runs)).toEqual([]);
  });
});

describe('finding 7: a page plan wanted only by optional tests is optional work too', () => {
  const navigator = (asked: string[]): NavigatorHook => ({
    maxTargets: 3, budgetMs: 200,
    plan: async (input) => { asked.push(new URL(input.url).pathname); return null; },
  });
  const loads = (fake: ReturnType<typeof fakeProbeBrowser>) => fake.events.filter((e) => e.type === 'goto').map((e) => new URL(e.url!).pathname);

  it('past the cutoff no plan is captured for it: no page load, no navigator call', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const fake = fakeProbeBrowser();
    const asked: string[] = [];
    const runner = createProbeRunner(fake.browser, [ok('every'), ok('forms', { usesPlan: true })], { ...OPTS, concurrency: 1, navigator: navigator(asked), optionalUntil: () => 0 });
    runner.add(page(6, '/forms/6'), ['every', 'forms'], { optional: ['forms'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /forms/6']);
    // One load: the required test's. No capture, no plan.
    expect(loads(fake)).toEqual(['/forms/6']);
    expect(asked).toEqual([]);
  });

  it('in time, its capture waits behind every required run instead of going to the front of the queue', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const fake = fakeProbeBrowser();
    const asked: string[] = [];
    const runner = createProbeRunner(fake.browser, [ok('every', {}, 10), ok('forms', { usesPlan: true })], { ...OPTS, concurrency: 1, navigator: navigator(asked) });
    runner.add(page(0), ['every']);
    runner.add(page(6, '/forms/6'), ['forms'], { optional: ['forms'] });
    runner.add(page(1), ['every']);
    runner.add(page(2), ['every']);
    await runner.finish();
    // The required loads first (the very first had started before anything else was queued), then the capture.
    expect(loads(fake).slice(0, 3)).toEqual(['/p0', '/p1', '/p2']);
    expect(loads(fake).slice(3)).toContain('/forms/6');
  });

  it('look-alike: a plan a required test wants is still captured first', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const fake = fakeProbeBrowser();
    const asked: string[] = [];
    const runner = createProbeRunner(fake.browser, [ok('every', {}, 10), ok('forms', { usesPlan: true })], { ...OPTS, concurrency: 1, navigator: navigator(asked) });
    runner.add(page(0), ['every']);
    runner.add(page(1), ['every']);
    runner.add(page(6, '/forms/6'), ['forms']);
    await runner.finish();
    expect(loads(fake).slice(0, 2)).toEqual(['/p0', '/forms/6']);
  });
});

// A second review of the round-2 scheduler (2026-11-10) found these by reading the code.
describe('second review: what a stopped optional job leaves, and what it holds up', () => {
  it('a run that ends after its optional job was stopped is no result, whatever words it ends with', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const emissions: ProbeRun[] = [];
    let runner!: ReturnType<typeof createProbeRunner>;
    // The optional test is stopped (required work arrives) and, as a test caught mid-load does, ends with a
    // result of its own wording: neither "canceled" nor "out of time", and no load failure.
    const odd: PageProbe = {
      ...ok('opt'),
      run: async (ctx) => {
        started.push(`opt ${new URL(ctx.url).pathname}`);
        if (started.filter((s) => s.startsWith('opt')).length === 1) {
          runner.add(page(7), ['req']);
          await sleep(20);
          return [{ criterion: '2.1.1', status: 'not_testable', detail: 'the page stopped responding' }];
        }
        return [{ criterion: '2.1.1', status: 'no_failures_found', detail: 'second time' }];
      },
    };
    runner = createProbeRunner(fakeProbeBrowser().browser, [odd, ok('req', {}, 5)], { ...OPTS, concurrency: 1, onRun: (r) => { emissions.push(r); } });
    runner.add(page(6), ['opt'], { optional: ['opt'] });
    const runs = await runner.finish();
    // The stopped attempt is nowhere; the test ran again once the required work was done, and that is its result.
    expect(runs.map((r) => `${r.probe} ${r.findings[0]!.detail}`)).toEqual(['opt second time', expect.stringMatching(/^req /)]);
    expect(emissions.map((r) => `${r.probe} ${r.findings[0]!.detail}`)).toEqual([expect.stringMatching(/^req /), 'opt second time']);
    expect(runner.counts()).toEqual({ queued: 2, done: 2 });
  });

  it('every run handed to onRun is in what finish gives, also when the scan stops while an optional job is half done', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const stop = new AbortController();
    const emissions: ProbeRun[] = [];
    const list = [ok('first', {}, 5), ok('second', {}, 300)];
    const runner = createProbeRunner(fakeProbeBrowser().browser, list, { ...OPTS, concurrency: 1, signal: stop.signal, onRun: (r) => { emissions.push(r); if (r.probe === 'first') setTimeout(() => stop.abort(), 10); } });
    runner.add(page(1), ['first', 'second'], { optional: ['first', 'second'] });
    const runs = await runner.finish();
    expect(ranOn(emissions)).toEqual(['first /p1']);
    expect(ranOn(runs)).toEqual(['first /p1']);
  });

  it('an optional test that gave up its place is not queued again by a later add of the same page', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const fake = fakeProbeBrowser();
    // Past its time from the start: the optional test is forgotten at once.
    const runner = createProbeRunner(fake.browser, [ok('every'), ok('extra', { isolate: true })], { ...OPTS, concurrency: 1, optionalUntil: () => 0 });
    runner.add(page(1), ['every', 'extra'], { optional: ['extra'] });
    await sleep(20);
    // The scheduler adds the page again each time another audit ends: the forgotten test stays forgotten.
    runner.add(page(1), ['every', 'extra'], { optional: ['extra'] });
    runner.add(page(1), ['every', 'extra'], { optional: ['extra'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['every /p1']);
    expect(runner.counts()).toEqual({ queued: 1, done: 1 });
    // Look-alike: the same test asked for as required afterwards does run.
    const again = createProbeRunner(fakeProbeBrowser().browser, [ok('every'), ok('extra', { isolate: true })], { ...OPTS, concurrency: 1, optionalUntil: () => 0 });
    again.add(page(1), ['every', 'extra'], { optional: ['extra'] });
    await sleep(20);
    again.add(page(1), ['extra']);
    expect(ranOn(await again.finish())).toEqual(['every /p1', 'extra /p1']);
  });

  it('an optional job told to stop between two tests does not go on into a late pass: the first pass stands', async () => {
    const started: string[] = [];
    const ok = probes(started);
    let over = false;
    let lateRan = false;
    // An optional test with a late pass (as the motion test has). Its time runs out while its first pass runs.
    const withLate: PageProbe = {
      ...ok('opt', {}, 5, () => { over = true; }),
      late: { timeoutMs: 2000, run: async () => { lateRan = true; await sleep(100); return [{ criterion: '2.1.1', status: 'failed', detail: 'from the late pass' }]; } },
    };
    const runner = createProbeRunner(fakeProbeBrowser().browser, [withLate, ok('opt2')], { ...OPTS, concurrency: 1, optionalUntil: () => (over ? 0 : undefined) });
    runner.add(page(6), ['opt', 'opt2'], { optional: ['opt', 'opt2'] });
    const runs = await runner.finish();
    expect(lateRan).toBe(false);
    expect(runs.map((r) => `${r.probe} ${r.findings[0]!.status}`)).toEqual(['opt no_failures_found']);
    expect(started).toEqual(['opt /p6']);
    // Look-alike: in time, the late pass runs and its findings are the test's.
    let late2 = false;
    const again = createProbeRunner(fakeProbeBrowser().browser, [{ ...withLate, late: { timeoutMs: 2000, run: async () => { late2 = true; return [{ criterion: '2.1.1', status: 'failed', detail: 'from the late pass' }]; } } }, ok('opt2')], { ...OPTS, concurrency: 1 });
    over = false;
    again.add(page(6), ['opt', 'opt2'], { optional: ['opt', 'opt2'] });
    const full = await again.finish();
    expect(late2).toBe(true);
    expect(full.map((r) => `${r.probe} ${r.findings[0]!.status}`)).toEqual(['opt failed', 'opt2 no_failures_found']);
  });
});

// Found by the engine suite (test/integration/adaptive.test.ts): a scan's report must not depend on how many
// pages are audited at once. An optional job that gave its place to required work a third time was forgotten,
// so which pages kept their optional tests depended on timing.
describe('giving way is never a reason to drop an optional test', () => {
  it('an optional job stopped for required work again and again still runs once the required work is done', async () => {
    const started: string[] = [];
    const ok = probes(started);
    let runner!: ReturnType<typeof createProbeRunner>;
    let n = 0;
    // Each time the optional test starts, another required test arrives (as audits keep ending), five times over.
    const opt = ok('opt', {}, 40, () => { if (n < 5) runner.add(page(10 + n++), ['req']); });
    runner = createProbeRunner(fakeProbeBrowser().browser, [opt, ok('req', {}, 2)], { ...OPTS, concurrency: 1 });
    runner.add(page(1), ['opt'], { optional: ['opt'] });
    const runs = await runner.finish();
    expect(ranOn(runs)).toEqual(['opt /p1', 'req /p10', 'req /p11', 'req /p12', 'req /p13', 'req /p14']);
    expect(started.filter((s) => s === 'opt /p1')).toHaveLength(6);
    expect(runner.counts()).toEqual({ queued: 6, done: 6 });
  });
});

// Round-2 review (2026-11-10, finding 2; the lead's decision): the cutoff is asked again at the last moment,
// immediately before an optional test starts and immediately before each navigator call, and a skip is recorded.
// The reviewer's inputs: a 250 ms page load with the cutoff 100 ms away (the optional test started 166 ms late),
// and the same timing for a plan's capture (the navigator was called 165 ms late, for a test that then never ran).
describe('round-2 review, finding 2: the cutoff is asked again at the last moment', () => {
  const navigator = (asked: string[], events: PlanEvent[], ms = 0): NavigatorHook => ({
    maxTargets: 3, budgetMs: 2000,
    plan: async (input) => { asked.push(new URL(input.url).pathname); if (ms) await sleep(ms); return null; },
    onPlan: (e) => { events.push(e); },
  });
  /** A browser whose pages answer the plan's capture with a (empty) summary, so the navigator is really reached. */
  const planBrowser = (delay = 0) => fakeProbeBrowser({
    delayFor: () => delay,
    evaluate: (name) => (name === 'navSummary' ? { viewport: { width: 1280, height: 900 }, height: 900, title: 't', elements: [], page: [], truncated: false } : undefined),
  });

  it('a cutoff that passes while the optional job loads its page: the test never starts, and the skip is recorded', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const skipped: OptionalSkip[] = [];
    const cutoff = Date.now() + 100;
    const runner = createProbeRunner(fakeProbeBrowser({ delayFor: () => 250 }).browser, [ok('slow')], { ...OPTS, concurrency: 1, optionalUntil: () => cutoff, onOptionalSkipped: (e) => { skipped.push(e); } });
    runner.add(page(1), ['slow'], { optional: ['slow'] });
    const runs = await runner.finish();
    expect(started).toEqual([]);
    expect(runs).toEqual([]);
    expect(skipped).toEqual([{ page: 'https://e.org/p1', probes: ['slow'], why: 'cutoff' }]);
    expect(runner.counts()).toEqual({ queued: 0, done: 0 });
  });

  it('look-alike: the same load with the cutoff still ahead when it ends: the test runs, and nothing is recorded', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const skipped: OptionalSkip[] = [];
    const cutoff = Date.now() + 5000;
    const runner = createProbeRunner(fakeProbeBrowser({ delayFor: () => 250 }).browser, [ok('slow')], { ...OPTS, concurrency: 1, optionalUntil: () => cutoff, onOptionalSkipped: (e) => { skipped.push(e); } });
    runner.add(page(1), ['slow'], { optional: ['slow'] });
    expect(ranOn(await runner.finish())).toEqual(['slow /p1']);
    expect(started).toEqual(['slow /p1']);
    expect(skipped).toEqual([]);
  });

  it('a cutoff that passes during a plan\'s capture: the navigator is not called, and the plan and its test are recorded as skipped', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const asked: string[] = [];
    const events: PlanEvent[] = [];
    const skipped: OptionalSkip[] = [];
    const cutoff = Date.now() + 100;
    const runner = createProbeRunner(planBrowser(250).browser, [ok('forms', { usesPlan: true })], {
      ...OPTS, concurrency: 1, navigator: navigator(asked, events), optionalUntil: () => cutoff, onOptionalSkipped: (e) => { skipped.push(e); },
    });
    runner.add(page(6, '/forms/6'), ['forms'], { optional: ['forms'] });
    const runs = await runner.finish();
    expect(asked).toEqual([]);
    expect(events.map((e) => [new URL(e.page).pathname, e.outcome])).toEqual([['/forms/6', 'cutoff']]);
    expect(started).toEqual([]);
    expect(runs).toEqual([]);
    expect(skipped).toEqual([{ page: 'https://e.org/forms/6', probes: ['forms'], why: 'cutoff' }]);
  });

  it('look-alike: a capture that ends in time: the navigator is asked, and the test runs', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const asked: string[] = [];
    const events: PlanEvent[] = [];
    const cutoff = Date.now() + 5000;
    const runner = createProbeRunner(planBrowser(50).browser, [ok('forms', { usesPlan: true })], { ...OPTS, concurrency: 1, navigator: navigator(asked, events), optionalUntil: () => cutoff });
    runner.add(page(6, '/forms/6'), ['forms'], { optional: ['forms'] });
    expect(ranOn(await runner.finish())).toEqual(['forms /forms/6']);
    expect(asked).toEqual(['/forms/6']);
    expect(events.map((e) => e.outcome)).toEqual(['failed']);
  });

  it('a cutoff that passes while a test waits for its page\'s plan: asked again right before the test would start', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const asked: string[] = [];
    const skipped: OptionalSkip[] = [];
    const cutoff = Date.now() + 120;
    // The plan's answer takes 300 ms. The planned test shares its page with another test, so it waits for the plan
    // with the page already open and its turn already admitted.
    const runner = createProbeRunner(planBrowser().browser, [ok('first'), ok('forms', { usesPlan: true })], {
      ...OPTS, concurrency: 2, navigator: navigator(asked, [], 300), optionalUntil: () => cutoff, onOptionalSkipped: (e) => { skipped.push(e); },
    });
    runner.add(page(6, '/forms/6'), ['first', 'forms'], { optional: ['first', 'forms'] });
    const runs = await runner.finish();
    expect(asked).toEqual(['/forms/6']);
    expect(started).toEqual(['first /forms/6']);
    expect(ranOn(runs)).toEqual(['first /forms/6']);
    expect(skipped).toEqual([{ page: 'https://e.org/forms/6', probes: ['forms'], why: 'cutoff' }]);
  });

  it('other reasons are recorded by their name: a stop of the tests, a load that failed', async () => {
    const started: string[] = [];
    const ok = probes(started);
    const skipped: OptionalSkip[] = [];
    const stop = new AbortController();
    stop.abort();
    const stopped = createProbeRunner(fakeProbeBrowser().browser, [ok('own')], { ...OPTS, signal: stop.signal, onOptionalSkipped: (e) => { skipped.push(e); } });
    stopped.add(page(1), ['own'], { optional: ['own'] });
    await stopped.finish();
    const failing = createProbeRunner(fakeProbeBrowser({ statusFor: () => 500 }).browser, [ok('own')], { ...OPTS, onOptionalSkipped: (e) => { skipped.push(e); } });
    failing.add(page(2), ['own'], { optional: ['own'] });
    await failing.finish();
    expect(skipped.map((e) => [new URL(e.page).pathname, e.why])).toEqual([['/p1', 'stopped'], ['/p2', 'failed']]);
    // A listener that throws changes nothing.
    const noisy = createProbeRunner(fakeProbeBrowser().browser, [ok('own')], { ...OPTS, optionalUntil: () => 0, onOptionalSkipped: () => { throw new Error('listener'); } });
    noisy.add(page(3), ['own'], { optional: ['own'] });
    expect(await noisy.finish()).toEqual([]);
  });
});
