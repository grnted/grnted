// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Once the pages are audited, a scan always ends with a score (Paul, 2026-11-04: a staging scan of
// accessibe.com loaded all 25 pages, then ran out of its budget in the deep tests, the AI review and the
// document checks, and all that work was thrown away as "No score"). With `finishBy`, the work after the
// pages is planned against it: what does not fit is stopped or skipped (lowest value first: the AI-flagged
// image pictures, the deep tests and the problem pictures, the AI review, the document checks, the core
// tests last), the report lists it as not checked, and the score comes from what ran.
import { describe, expect, it } from 'vitest';
import { FINISH, planFinish } from '../../src/finishPlan.js';
import type { PageProbe } from '../../src/probes/types.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { PROBES } from '../../src/probes/registry.js';
import { createProbeRunner } from '../../src/probes/runner.js';
import { scanSite } from '../../src/scan.js';
import type { AiScanPlan } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const PATHS = ['/', '/about', '/contact', '/news'];
const LINKS = PATHS.filter((p) => p !== '/').map((p) => `https://e.org${p}`);
const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
const site = () => fakeProbeBrowser({
  delayFor: () => 1,
  evaluate: (name, path) => (name === '' || name === 'collectLinks' ? (path === '/' ? LINKS : []) : undefined),
});

/** A scored core test that is done at once. */
const quickCore: PageProbe = {
  id: 'text-spacing', criteria: ['1.4.12'], kind: 'render', tier: 'core', timeoutMs: 20_000,
  run: async () => [{ criterion: '1.4.12', status: 'no_failures_found', detail: 'ok' }],
};

/** A test that runs until it is stopped (or its 20 s time box ends). */
const hanging = (id: string, tier: 'core' | 'deep', criterion: string): PageProbe => ({
  id, criteria: [criterion], kind: 'interaction', tier, timeoutMs: 20_000,
  run: (ctx) => new Promise((resolve) => {
    const done = () => resolve([{ criterion, status: 'no_failures_found', detail: 'ok' }]);
    const t = setTimeout(done, 19_000);
    ctx.signal?.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
  }),
});

/** An AI review that answers only when stopped (or after 20 s). */
function slowAi(): AiScanPlan & { stopped: () => boolean } {
  let stopped = false;
  return {
    collectors: [],
    onPageAudited: () => {},
    stopped: () => stopped,
    finish: (ctx) => new Promise((resolve) => {
      const t = setTimeout(() => resolve({ runs: [], disclaimer: '' }), 20_000);
      ctx.signal?.addEventListener('abort', () => { stopped = true; clearTimeout(t); resolve({ runs: [], disclaimer: '' }); }, { once: true });
    }),
  };
}

// Small times so the test runs in about a second (the real ones are FINISH).
const timing = { reportMs: 200, aiMs: 400, aiPicturesMs: 100, minTestsMs: 300, deepMarginMs: 300, graceMs: 300 };

async function scan(o: { probes: PageProbe[]; ai?: AiScanPlan; budgetMs: number }) {
  const t0 = Date.now();
  const finishBy = t0 + o.budgetMs;
  const report = await scanSite('https://e.org/', {
    browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 2, probes: o.probes, full: true,
    ...(o.ai ? { ai: o.ai } : {}), finishBy, finishTiming: timing,
  });
  return { report, ms: Date.now() - t0, finishBy, ended: Date.now() };
}

describe('the work after the pages fits the deadline', () => {
  it('the deadline comes during the deep tests: a score, the deep tests listed as not checked', async () => {
    const { report, ended, finishBy } = await scan({ probes: [quickCore, hanging('hover-content', 'deep', '1.4.13')], budgetMs: 2000 });
    expect(ended).toBeLessThanOrEqual(finishBy);
    expect(report.status).toBe('scored');
    expect(report.score).not.toBeNull();
    expect(report.notChecked).toEqual([{ stage: 'deep-tests', detail: 'Not checked: the deep tests (the scan ran out of time)' }]);
    // The core test ran; the deep one is "not tested", never a clean pass.
    const runs = report.probes!.runs;
    expect(runs.filter((r) => r.probe === 'text-spacing').every((r) => r.status === 'ok')).toBe(true);
    const deep = report.criteria?.find((c) => c.criterion === '1.4.13');
    if (deep) expect(deep.methods.find((m) => m.id === 'hover-content')?.status).not.toBe('no_failures_found');
  }, 30_000);

  it('the deadline comes during the AI review: a score without it (it is stopped and listed)', async () => {
    const ai = slowAi();
    const { report, ended, finishBy } = await scan({ probes: [quickCore], ai, budgetMs: 2000 });
    expect(ended).toBeLessThanOrEqual(finishBy);
    expect(report.status).toBe('scored');
    expect(report.ai).toBeUndefined();
    expect(report.aiChecks?.ran).toBe(false);
    expect(ai.stopped()).toBe(true);
    expect(report.notChecked).toEqual([{ stage: 'ai-review', detail: 'Not checked: the AI review (the scan ran out of time)' }]);
  }, 30_000);

  it('the deadline comes during the core tests: a score from the tests that ran; the rest are not tested', async () => {
    const { report, ended, finishBy } = await scan({ probes: [quickCore, hanging('keyboard', 'core', '2.1.1')], budgetMs: 1500 });
    expect(ended).toBeLessThanOrEqual(finishBy);
    expect(report.status).toBe('scored');
    expect(report.notChecked?.map((s) => s.stage)).toEqual(['core-tests']);
    expect(report.notChecked![0]!.detail).toMatch(/^Not (checked|finished): the automated tests \(the scan ran out of time/);
    // A test that was stopped costs nothing and earns nothing: its criterion is not in the score.
    expect(report.untestedCriteria).toContain('2.1.1');
    // Its WCAG row says it was cut short, never "no failures found".
    const m = report.criteria?.find((c) => c.criterion === '2.1.1')?.methods.find((x) => x.id === 'keyboard');
    expect(m?.status).toBe('not_testable');
    expect(m?.note).toMatch(/^Partly tested: 0 of \d+ pages? \(the scan ran out of time\)|^not run: the scan ran out of time/);
  }, 30_000);

  it('enough time: everything runs, nothing is listed', async () => {
    const { report } = await scan({ probes: [quickCore], budgetMs: 60_000 });
    expect(report.status).toBe('scored');
    expect(report.notChecked).toBeUndefined();
  }, 30_000);
});

describe('the finish plan', () => {
  it('keeps time for the report; gives the AI review its share only when the core tests still get theirs', () => {
    const now = 1_000_000;
    const p = planFinish(now, now + 5 * 60_000, { ai: true });
    expect(p.end).toBe(now + 5 * 60_000 - FINISH.reportMs);
    expect(p.aiPicturesBy).toBe(p.end);
    expect(p.aiBy).toBe(p.end - FINISH.aiPicturesMs);
    expect(p.testsBy).toBe(p.aiBy - FINISH.aiMs);
    expect(p.docsBy).toBe(p.testsBy);
    expect(p.deepBy).toBe(p.testsBy - FINISH.deepMarginMs);
    expect(p.picturesBy).toBe(p.deepBy);
    expect(p.skipAi).toBe(false);
    // Too little time for both: the AI review is skipped up front, the core tests keep it all.
    const short = planFinish(now, now + FINISH.reportMs + FINISH.minTestsMs, { ai: true });
    expect(short.skipAi).toBe(true);
    expect(short.testsBy).toBe(short.end);
    // Nothing is ever planned before now.
    const late = planFinish(now, now - 1000, { ai: false });
    for (const t of [late.deepBy, late.testsBy, late.docsBy, late.picturesBy, late.aiBy, late.end]) expect(t).toBeGreaterThanOrEqual(now);
  });
});

describe('cross-page findings on the cut-short path (the tests ran past their time)', () => {
  /** The headings test as it reports to the cross-page rule: every page's level-1 heading is the site's name. */
  const sameH1: PageProbe = {
    ...headingsProbe,
    run: async (ctx) => {
      ctx.setData?.({ title: `Page ${new URL(ctx.url).pathname}`, h1: [{ text: 'Riverside School', target: 'h1' }] });
      return [];
    },
  };

  it('3 pages finished with the same level-1 heading, one page never came back: 2.4.6 fails as on the normal path', async () => {
    const loads = new Map<string, number>();
    const b = fakeProbeBrowser({
      // /news loads for the audit, then hangs for the tests (one stuck in a page load is left).
      delayFor: (path) => { const n = (loads.get(path) ?? 0) + 1; loads.set(path, n); return path === '/news' && n > 2 ? 60_000 : 1; },
      evaluate: (name, path) => (name === '' || name === 'collectLinks' ? (path === '/' ? LINKS : []) : undefined),
    });
    const t0 = Date.now();
    const report = await scanSite('https://e.org/', { browser: b.browser, fetchFn: notFound, axeSource: '', concurrency: 2, probes: [sameH1], finishBy: t0 + 2500, finishTiming: timing });
    expect(report.notChecked?.map((x) => x.stage)).toContain('core-tests');
    const runs = report.probes!.runs.filter((r) => r.probe === 'headings');
    const failed = runs.filter((r) => r.findings.some((f) => f.criterion === '2.4.6' && f.status === 'failed')).map((r) => new URL(r.page).pathname).sort();
    expect(failed).toEqual(['/about', '/contact']);
    expect(report.criteria!.find((c) => c.criterion === '2.4.6')!.status).toBe('failed');
  }, 60_000);

  it('every probe with cross-page findings gets them on the cut-short path (a sweep over the registry)', async () => {
    const across = PROBES.filter((p) => p.acrossPages);
    expect(across.length).toBeGreaterThan(0);
    for (const p of across) {
      let called = 0;
      const spy: PageProbe = { ...p, tier: 'core', run: async () => [], acrossPages: (runs) => { called++; return p.acrossPages!(runs); } };
      const runner = createProbeRunner(fakeProbeBrowser().browser, [spy], { userAgent: 'ua' });
      for (const [i, path] of PATHS.entries()) runner.add({ url: `https://e.org${path}`, index: i });
      const runs = await runner.finish();
      called = 0;
      runner.partial(runs.slice(0, 3));
      expect(called, p.id).toBe(1);
      // And the run that never came back is marked not tested.
      expect(runner.partial(runs.slice(0, 3)).filter((r) => r.findings.some((f) => f.timeLimit)).length, p.id).toBeGreaterThan(0);
    }
  }, 60_000);
});
