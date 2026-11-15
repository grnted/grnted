// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The work after the page checks (stage events): the live view must show what really runs once every
// page is done (the automated tests, the document checks, the AI review, the report's pictures), with
// real counts, in order: after the last page-done, before scoring. Observation only.
import { describe, expect, it } from 'vitest';
import { STAGE_DETAIL_MAX } from '../../src/events.js';
import { probeLabel } from '../../src/probes/labels.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { AiProgress, AiScanPlan, ScanEvent, ScanStage } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const PATHS = ['/', '/about', '/calendar', '/contact', '/staff', '/news/1'];
const SHAPES: Record<string, string> = {
  '/': 'header:1 nav:1 main:1 h2-6:8-15', '/about': 'header:1 nav:1 main:1 h2-6:2-3', '/calendar': 'header:1 main:1 table:1',
  '/contact': 'header:1 main:1 form:1', '/staff': 'header:1 nav:1 main:1 h2-6:2-3', '/news/1': 'header:1 main:1 table:2+',
};
const LINKS = PATHS.filter((p) => p !== '/').map((p) => `https://e.org${p}`);
const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;

const site = () => fakeProbeBrowser({
  delayFor: () => 1,
  evaluate: (name, path) => {
    if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
    if (name === 'pageShape') return SHAPES[path];
    return undefined;
  },
});

/** A probe slow enough that most of its runs end after the last page audit. */
const slowProbe = (id = 'text-spacing'): PageProbe => ({
  id, criteria: ['1.4.12'], kind: 'render', tier: 'core', timeoutMs: 2000,
  run: async () => {
    await new Promise((r) => setTimeout(r, 40));
    return [{ criterion: '1.4.12', status: 'no_failures_found', detail: 'ok' }];
  },
});

/** An AI plan whose finish reports real progress through `onProgress` (two checks, the first sampled). */
function fakeAi(extra: Partial<AiScanPlan> = {}, late?: (onProgress: (p: AiProgress) => void) => void): AiScanPlan {
  return {
    collectors: [],
    onPageAudited: () => {},
    async finish(ctx) {
      for (let i = 1; i <= 3; i++) ctx.onProgress?.({ checksDone: 0, checks: 2, check: 'Image descriptions (alt text)', reviewed: i, sample: 3 });
      ctx.onProgress?.({ checksDone: 1, checks: 2, check: 'Image descriptions (alt text)' });
      ctx.onProgress?.({ checksDone: 2, checks: 2, check: 'Page text: titles, links, headings and instructions' });
      if (late && ctx.onProgress) late(ctx.onProgress);
      return { runs: [], disclaimer: '' };
    },
    ...extra,
  };
}

async function scan(o: { ai?: AiScanPlan; probes?: PageProbe[] | false } = {}) {
  const events: ScanEvent[] = [];
  const report = await scanSite('https://e.org/', {
    browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 3, probes: o.probes ?? [slowProbe()],
    ...(o.ai ? { ai: o.ai } : {}), onEvent: (e) => events.push(e),
  });
  return { events, report };
}

type Stage = Extract<ScanEvent, { type: 'stage' }>;
const stages = (events: ScanEvent[]) => events.filter((e): e is Stage => e.type === 'stage');
const of = (events: ScanEvent[], stage: ScanStage) => stages(events).filter((e) => e.stage === stage);

describe('stage events after the page checks', () => {
  it('come after the last page-done and before scoring, each stage start → progress → done', async () => {
    const { events } = await scan({ ai: fakeAi() });
    const types = events.map((e) => e.type);
    const lastPage = types.lastIndexOf('page-done');
    const firstScoring = types.indexOf('scoring');
    const at = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'stage').map(({ i }) => i);
    expect(at.length).toBeGreaterThan(0);
    expect(Math.min(...at)).toBeGreaterThan(lastPage);
    expect(Math.max(...at)).toBeLessThan(firstScoring);
    for (const stage of ['tests', 'documents', 'ai'] as const) {
      const steps = of(events, stage).map((e) => e.step);
      expect(steps[0], stage).toBe('start');
      expect(steps.at(-1), stage).toBe('done');
      expect(steps.slice(1, -1).every((s) => s === 'progress'), stage).toBe(true);
    }
    // No AI flagged an image here, so the second pictures stage never starts; no evidence, no pictures at all.
    expect(of(events, 'pictures')).toEqual([]);
    expect(of(events, 'media')).toEqual([]);
  });

  it('the tests stage says how far along it is as a percentage, never the test runs, test names or pages (public what, private how)', async () => {
    const { events, report } = await scan();
    const tests = of(events, 'tests');
    const runs = report.probes!.runs.length;
    expect(runs).toBe(5);
    const start = tests[0]!;
    expect(start).toMatchObject({ step: 'start', detail: 'Running the automated tests', total: 100 });
    expect(start.done).toBeLessThan(100);
    const done = tests.at(-1)!;
    expect(done).toMatchObject({ step: 'done', detail: 'Automated tests done', done: 100, total: 100 });
    const progress = tests.filter((e) => e.step === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    // Counts never go back and never pass the total.
    let last = start.done ?? 0;
    for (const e of progress) {
      expect(e.done!).toBeGreaterThanOrEqual(last);
      expect(e.done!).toBeLessThanOrEqual(e.total!);
      last = e.done!;
    }
    for (const e of [...progress, start, done]) expect(e.total).toBe(100);
    expect(progress.every((e) => /^Running the automated tests: \d{1,3}%$/.test(e.detail)), JSON.stringify(progress)).toBe(true);
    // No test name, page path or count of test runs in any detail.
    expect(tests.some((e) => e.detail.includes(probeLabel('text-spacing')) || /\/[a-z]|test runs| of \d/.test(e.detail))).toBe(false);
  });

  it('the documents stage carries the documents found so far (`found`), never going back, and the final count at done', async () => {
    const docs = ['https://e.org/files/a.pdf', 'https://e.org/files/b.docx', 'https://e.org/files/c.pdf'];
    const withDocs = fakeProbeBrowser({
      delayFor: () => 1,
      evaluate: (name, path) => {
        if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : path === '/about' ? docs : [];
        if (name === 'pageShape') return SHAPES[path];
        return undefined;
      },
    });
    const events: ScanEvent[] = [];
    const report = await scanSite('https://e.org/', {
      browser: withDocs.browser, fetchFn: notFound, axeSource: '', concurrency: 3, probes: [slowProbe()], onEvent: (e) => events.push(e),
    });
    expect(report.documents).toHaveLength(3);
    const d = of(events, 'documents');
    expect(d.every((e) => typeof e.found === 'number'), JSON.stringify(d)).toBe(true);
    let last = 0;
    for (const e of d) {
      expect(e.found!).toBeGreaterThanOrEqual(last);
      last = e.found!;
    }
    expect(d.at(-1)).toMatchObject({ step: 'done', found: 3 });
    // Only the documents stage counts documents.
    expect(stages(events).filter((e) => e.stage !== 'documents').every((e) => e.found === undefined)).toBe(true);
  });

  it('the AI stage follows the tests and documents and passes on the review\'s real progress', async () => {
    const { events } = await scan({ ai: fakeAi() });
    const all = stages(events);
    const aiStart = all.findIndex((e) => e.stage === 'ai' && e.step === 'start');
    for (const stage of ['tests', 'documents'] as const) {
      expect(all.findIndex((e) => e.stage === stage && e.step === 'done')).toBeLessThan(aiStart);
    }
    const ai = of(events, 'ai');
    // The review's progress as a percentage: never how many checks the review has or items it reviews.
    expect(ai.filter((e) => e.step === 'progress').map((e) => [e.done, e.total])).toEqual([[0, 100], [0, 100], [0, 100], [50, 100], [100, 100]]);
    expect(ai.find((e) => e.step === 'progress')!.detail).toBe('Reviewing Image descriptions (alt text): 33%');
    expect(ai.some((e) => / of \d|reviewed|checks?\b/.test(e.detail))).toBe(false);
    expect(ai.at(-1)).toMatchObject({ step: 'done', detail: 'AI review done', done: 100, total: 100 });
  });

  it('no AI stage for a plan that reviews nothing (a page tap), and none after the review settled', async () => {
    const tap = await scan({ ai: fakeAi({ reviews: false }) });
    expect(of(tap.events, 'ai')).toEqual([]);
    const late = await scan({ ai: fakeAi({}, (onProgress) => setTimeout(() => onProgress({ checksDone: 2, checks: 2, check: 'late' }), 0)) });
    await new Promise((r) => setTimeout(r, 20));
    expect(late.events.at(-1)!.type).toBe('done');
    expect(stages(late.events).some((e) => e.detail.includes('late'))).toBe(false);
  });

  it('no tests stage without probes; details are short plain text with paths, never full addresses', async () => {
    const { events } = await scan({ probes: false, ai: fakeAi() });
    expect(of(events, 'tests')).toEqual([]);
    const withTests = await scan({ ai: fakeAi() });
    for (const e of stages(withTests.events)) {
      expect(e.detail.length).toBeLessThanOrEqual(STAGE_DETAIL_MAX);
      expect(e.detail).not.toMatch(/https?:|<|>/);
    }
  });

  it('with report pictures: a pictures stage beside the others, done before the AI review, with the real count', async () => {
    const events: ScanEvent[] = [];
    await scanSite('https://e.org/', {
      browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 3, probes: [slowProbe()], ai: fakeAi(),
      evidence: { sink: async () => {} }, onEvent: (e) => events.push(e),
    });
    const pics = of(events, 'pictures');
    expect(pics.map((e) => e.step)).toEqual(['start', 'done']);
    expect(pics[1]!.detail).toMatch(/^\d+ pictures for the report$/);
    const all = stages(events);
    expect(all.indexOf(pics[1]!)).toBeLessThan(all.findIndex((e) => e.stage === 'ai' && e.step === 'start'));
  });

  it('is observation only: the same report with and without a listener', async () => {
    const { report } = await scan({ ai: fakeAi() });
    const quiet = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 3, probes: [slowProbe()], ai: fakeAi() });
    const strip = (r: typeof report) => ({ ...r, meta: { ...r.meta, startedAt: '', finishedAt: '' }, probes: r.probes && { ...r.probes, runs: r.probes.runs.map((x) => ({ ...x, ms: 0 })) } });
    expect(strip(report)).toEqual(strip(quiet));
  });
});
