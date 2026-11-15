// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import { describe, expect, it } from 'vitest';
import { hasMedia } from '../../src/probes/mediaPlayers.js';
import { PROBES } from '../../src/probes/registry.js';
import { ALSO_ON_PAGE_CAP } from '../../src/probes/sample.js';
import type { PageProbe } from '../../src/probes/types.js';
import { samplePages } from '../../src/sample/templates.js';
import { DEEPEN } from '../../src/crawl.js';
import { scanSite } from '../../src/scan.js';
import { CANCELLED } from '../../src/probes/runner.js';
import type { AiScanPlan } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

// Pages in scan order (start page, then every top-level section first, by depth and path: scoring v3)
// and their DOM shapes.
const HOME = 'header:1 nav:1 main:1 h2-6:8-15';
const ARTICLE = 'header:1 nav:1 main:1 h2-6:2-3';
const SHAPES: Record<string, string> = {
  '/': HOME, '/about': ARTICLE, '/calendar': 'header:1 main:1 table:1', '/contact': 'header:1 main:1 form:1', '/staff': ARTICLE,
  '/events/2026-fair': ARTICLE, '/forms/enroll': 'header:1 main:1 form:2+', '/news/101': ARTICLE, '/zz/last': 'header:1 main:1 table:2+',
  '/events/2026-open-house': ARTICLE, '/news/102': ARTICLE, '/news/103': ARTICLE,
};
const LINKS = Object.keys(SHAPES).filter((p) => p !== '/').map((p) => `https://e.org${p}`);
const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;

function site(delayFor: (path: string) => number = () => 1) {
  return fakeProbeBrowser({
    delayFor,
    evaluate: (name, path) => {
      if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
      if (name === 'pageShape') return SHAPES[path];
      return undefined;
    },
  });
}

describe('scanSite with probes', () => {
  it('batch 15b: probes receive both the scan deadline and axe source for a cleared-page second look', async () => {
    const deadline = Date.now() + 20_000;
    const axeSource = '/* fixture axe source */';
    const seen: { deadline: number; axeSource: string | undefined }[] = [];
    const probe: PageProbe = {
      id: 'second-look-inputs', criteria: ['1.4.3'], tier: 'core', kind: 'pixels', timeoutMs: 60_000,
      async run(ctx) { seen.push({ deadline: ctx.deadline, axeSource: ctx.axeSource }); return []; },
    };
    const report = await scanSite('https://e.org/', {
      browser: site().browser, fetchFn: notFound, axeSource, deadline, maxPages: 1, probes: [probe],
    });
    expect(report.probes!.runs.map((r) => r.status)).toEqual(['ok']);
    expect(seen).toEqual([{ deadline, axeSource }]);
  });

  it('Sol r3 7: the caller\'s cancellation reaches the tests (a running test is cancelled, none starts after)', async () => {
    const stop = new AbortController();
    const probe: PageProbe = {
      id: 'waits', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        stop.abort();
        await new Promise((r) => { if (ctx.signal.aborted) r(null); ctx.signal.addEventListener('abort', () => r(null)); });
        return [];
      },
    };
    const t0 = Date.now();
    const report = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: [probe], signal: stop.signal });
    const runs = report.probes?.runs ?? [];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.findings.every((f) => f.detail === CANCELLED))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it('runs the probes on the template sample only, starting before the last page audit finishes', async () => {
    const fake = site((p) => (p === '/zz/last' ? 80 : 1));
    const started: { path: string; lastAudited: boolean }[] = [];
    let lastAudited = false;
    const probe: PageProbe = {
      id: 'rec', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000,
      async run(ctx) {
        started.push({ path: new URL(ctx.url).pathname, lastAudited });
        expect(ctx.collected?.shape).toBe(SHAPES[new URL(ctx.url).pathname]);
        return [{ criterion: '2.1.1', status: 'failed', target: '#x', detail: `index ${ctx.pageIndex}` }];
      },
    };
    const report = await scanSite('https://e.org/', {
      browser: fake.browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: [probe],
      onProgress: (p) => { if (p.phase === 'audit' && p.done === p.total) lastAudited = true; },
    });
    const paths = report.meta.pageList.map((u) => new URL(u).pathname);
    expect(paths).toEqual(Object.keys(SHAPES));
    const expected = samplePages(paths.map((p, index) => ({ page: `https://e.org${p}`, index, shape: SHAPES[p]! })), 5).sample.map((p) => new URL(p.page).pathname);
    expect(expected).toEqual(['/', '/about', '/calendar', '/contact', '/forms/enroll']);
    expect(report.probes!.runs.map((r) => new URL(r.page).pathname)).toEqual(expected);
    expect(report.probes!.runs.map((r) => r.findings[0]!.detail)).toEqual(['index 0', 'index 1', 'index 2', 'index 3', 'index 6']);
    expect(started.some((s) => !s.lastAudited)).toBe(true);
    expect(probeCriteriaResults(report.probes!.runs)).toEqual([{
      criterion: '2.1.1',
      method: { id: 'rec', kind: 'interaction', status: 'failed', pages: 5 },
      evidence: expected.map((p, i) => ({ page: `https://e.org${p === '/' ? '/' : p}`, target: '#x', detail: `index ${[0, 1, 2, 3, 6][i]}` })),
    }]);
    // The probe's result lands in the criteria table as an automated method of 2.1.1.
    const row = report.criteria!.find((c) => c.criterion === '2.1.1')!;
    expect(row.status).toBe('failed');
    expect(row.methods).toContainEqual({ id: 'rec', kind: 'interaction', status: 'failed', pages: 5 });
    expect(row.evidence.map((e) => e.detail)).toEqual(expect.arrayContaining(['index 0', 'index 6']));
    // A probe outside the registry is never scored (scoring v3 scores the registry's core probes only).
    const plain = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: false });
    expect(report.score).toBe(plain.score);
  });

  it('gives the same sample however the pages finish', async () => {
    const order = async (delayFor: (p: string) => number) => {
      const fake = site(delayFor);
      const probe: PageProbe = { id: 'rec', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000, run: async () => [] };
      const report = await scanSite('https://e.org/', { browser: fake.browser, fetchFn: notFound, axeSource: '', concurrency: 6, probes: [probe] });
      return report.probes!.runs.map((r) => r.page);
    };
    const a = await order(() => 1);
    const b = await order((p) => (p === '/' ? 40 : p === '/calendar' ? 25 : 1));
    expect(b).toEqual(a);
  });

  it('leaves the report unchanged with no probes: `probes: false`, or an empty probe list', async () => {
    const off = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', probes: false });
    expect(off.probes).toBeUndefined();
    // A criterion a probe declares still gets an automated result: not testable, saying why.
    expect(off.criteria!.find((c) => c.criterion === '2.1.1')!.methods.filter((m) => m.kind === 'interaction')).toEqual([
      { id: 'keyboard', kind: 'interaction', status: 'not_testable', pages: 0, note: 'the automated interaction and render tests were turned off for this scan' },
    ]);
    for (const probes of [false as const, [] as PageProbe[]]) {
      const fake = site();
      // (The User-Agent given: this fake has no CDP session, so the scan would read its own from a blank page.)
      const r = await scanSite('https://e.org/', { browser: fake.browser, fetchFn: notFound, axeSource: '', probes, userAgent: 'UA' });
      expect(r.probes).toBeUndefined();
      // Only discovery and the audit opened contexts: the home page's links, then (the list does not fill the
      // scan) the pages read for more links until DEEPEN.dryStop of them lead nowhere new, and 2 per page.
      expect(fake.contexts).toBe(1 + DEEPEN.dryStop + 2 * Object.keys(SHAPES).length);
    }
  });

  it('runs the registry\'s core probes by default', async () => {
    const core = PROBES.filter((p) => p.tier === 'core');
    const r = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '' });
    if (core.length === 0) expect(r.probes).toBeUndefined();
    else expect(r.probes!.runs.length).toBeGreaterThan(0);
  });

  it('hands each probe run, with its evidence, to the AI review before it finishes; the report keeps the runs without it', async () => {
    const probe: PageProbe = {
      id: 'ev', criteria: ['3.3.4'], kind: 'interaction', tier: 'core', timeoutMs: 1000,
      async run(ctx) {
        ctx.setData?.({ version: 1, path: new URL(ctx.url).pathname });
        return [];
      },
    };
    const heard: { page: string; data: unknown }[] = [];
    let finished = false;
    const ai: AiScanPlan = {
      collectors: [],
      onPageAudited: () => {},
      onProbeRun: (run) => { heard.push({ page: new URL(run.page).pathname, data: run.data }); expect(finished).toBe(false); },
      finish: async () => { finished = true; return { runs: [], disclaimer: '' }; },
    };
    const report = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', probes: [probe], ai });
    expect(heard.map((h) => h.page).sort()).toEqual(['/', '/about', '/calendar', '/contact', '/forms/enroll']);
    expect(heard.every((h) => (h.data as { path: string }).path === h.page)).toBe(true);
    expect(report.probes!.runs.every((r) => !('data' in r))).toBe(true);
  });

  it('reads the elements the findings name only for an AI review that asks, hands them to it, and keeps them out of the report', async () => {
    const probe: PageProbe = {
      id: 'named', criteria: ['1.3.1'], kind: 'render', tier: 'core', timeoutMs: 1000,
      async run(ctx) {
        return new URL(ctx.url).pathname === '/about' ? [{ criterion: '1.3.1', status: 'flagged', target: '#hours', detail: 'may be a heading' }] : [];
      },
    };
    let reads = 0;
    const named = () => fakeProbeBrowser({
      evaluate: (name, path, arg) => {
        if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
        if (name === 'pageShape') return SHAPES[path];
        if (name === 'readFacts') { reads++; return (arg as { targets: string[] }).targets.map((target) => ({ target, found: 1, tag: '<p id="hours">', text: 'Hours' })); }
        return undefined;
      },
    });
    const heard: { page: string; elements: unknown }[] = [];
    const plan = (elementFacts: boolean): AiScanPlan => ({
      collectors: [], onPageAudited: () => {}, ...(elementFacts ? { elementFacts: true } : {}),
      onProbeRun: (run) => { if (run.probe === 'named') heard.push({ page: new URL(run.page).pathname, elements: run.elements }); },
      finish: async () => ({ runs: [], disclaimer: '' }),
    });
    const off = await scanSite('https://e.org/', { browser: named().browser, fetchFn: notFound, axeSource: '', probes: [probe], ai: plan(false) });
    expect(reads).toBe(0);
    expect(heard.every((h) => h.elements === undefined)).toBe(true);
    heard.length = 0;
    const on = await scanSite('https://e.org/', { browser: named().browser, fetchFn: notFound, axeSource: '', probes: [probe], ai: plan(true) });
    expect(reads).toBe(1);
    expect(heard.find((h) => h.page === '/about')!.elements).toEqual([{ target: '#hours', found: 1, tag: '<p id="hours">', text: 'Hours' }]);
    expect(heard.filter((h) => h.page !== '/about').every((h) => h.elements === undefined)).toBe(true);
    for (const r of [off, on]) expect(r.probes!.runs.every((x) => !('elements' in x) && !('data' in x))).toBe(true);
    const noTime = (r: typeof on) => JSON.stringify(r.probes!.runs.map(({ ms: _ms, ...x }) => x));
    expect(noTime(on)).toBe(noTime(off));
  });

  it('runs deep probes only with `full`', async () => {
    const deep: PageProbe = { id: 'deep', criteria: ['2.3.1'], kind: 'pixels', tier: 'deep', timeoutMs: 1000, run: async () => [] };
    const without = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', probes: [deep] });
    expect(without.probes).toBeUndefined();
    const withFull = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', probes: [deep], full: true });
    expect(withFull.probes!.runs).toHaveLength(5);
  });

  it('runs a deep probe with `alsoOn` on every page it asks for, besides the sample, in scan order and capped', async () => {
    const withMedia = new Set(['/staff', '/news/102', '/zz/last']);
    const facts = (path: string) => ({ elements: withMedia.has(path) ? [{ tag: 'video', src: `https://e.org${path}.mp4`, tracks: [], autoplay: false, muted: false, controls: true, transcriptNearby: false }] : [], frames: [], links: [] });
    const mediaSite = (delayFor: (p: string) => number = () => 1, all = false) => fakeProbeBrowser({
      delayFor,
      evaluate: (name, path) => {
        if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
        if (name === 'pageShape') return SHAPES[path];
        if (name === 'collectMedia') return all ? { ...facts(path), elements: facts('/staff').elements } : facts(path);
        return undefined;
      },
    });
    const media: PageProbe = { id: 'media-like', criteria: ['1.2.4'], kind: 'interaction', tier: 'deep', timeoutMs: 1000, isolate: true, alsoOn: hasMedia, run: async () => [] };
    const core: PageProbe = { id: 'core-like', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 1000, run: async () => [] };
    // Pages the probe ran on (its run returns no findings; the site-level run for pages past the cap has some).
    const pathsOf = (r: Awaited<ReturnType<typeof scanSite>>, id: string) => r.probes!.runs.filter((x) => x.probe === id && !x.findings.length).map((x) => new URL(x.page).pathname);
    const scan = (b: ReturnType<typeof mediaSite>, full = true) => scanSite('https://e.org/', { browser: b.browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: [core, media], full });
    const r = await scan(mediaSite());
    // The sample, plus the pages with media outside it, by page index; other probes stay on the sample.
    expect(pathsOf(r, 'media-like')).toEqual(['/', '/about', '/calendar', '/contact', '/staff', '/forms/enroll', '/zz/last', '/news/102']);
    expect(pathsOf(r, 'core-like')).toEqual(['/', '/about', '/calendar', '/contact', '/forms/enroll']);
    // The same however the pages finish.
    const late = await scan(mediaSite((p) => (p === '/' ? 40 : p === '/news/102' ? 30 : 1)));
    expect(pathsOf(late, 'media-like')).toEqual(pathsOf(r, 'media-like'));
    // Capped: the first ALSO_ON_PAGE_CAP pages that ask for it, in scan order (the sample always runs).
    const every = await scan(mediaSite(() => 1, true));
    expect(pathsOf(every, 'media-like')).toEqual(Object.keys(SHAPES).slice(0, ALSO_ON_PAGE_CAP));
    // Deep: nothing without `full`.
    expect(pathsOf(await scan(mediaSite(), false), 'media-like')).toEqual([]);
  });

  it('review #3: media pages past the alsoOn cap give a site-level not_testable that reaches the criteria rows', async () => {
    const facts = { elements: [{ tag: 'video', src: 'https://e.org/v.mp4', tracks: [], autoplay: false, muted: false, controls: true, transcriptNearby: false }], frames: [], links: [] };
    const b = fakeProbeBrowser({
      evaluate: (name, path) => {
        if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
        if (name === 'pageShape') return SHAPES[path];
        if (name === 'collectMedia') return facts;
        return undefined;
      },
    });
    const media: PageProbe = { id: 'media-like', criteria: ['1.2.4'], kind: 'interaction', tier: 'deep', timeoutMs: 1000, isolate: true, alsoOn: hasMedia, run: async () => [] };
    const r = await scanSite('https://e.org/', { browser: b.browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: [media], full: true });
    const extra = r.probes!.runs.filter((x) => x.probe === 'media-like' && x.findings.some((f) => f.status === 'not_testable'));
    expect(extra).toHaveLength(1);
    expect(new URL(extra[0]!.page).pathname).toBe('/news/102');
    expect(extra[0]!.findings).toEqual([{ criterion: '1.2.4', status: 'not_testable', detail: expect.stringContaining('2 more scanned pages'), limit: true }]);
    const row = r.criteria!.find((c) => c.criterion === '1.2.4')!;
    expect(row.status).toBe('not_testable');
    expect(row.methods.find((m) => m.id === 'media-like')).toMatchObject({ status: 'not_testable', note: expect.stringContaining('2 more scanned pages') });
  });

  it('runs a core probe with `everyPage` on every page that loaded, in one page load with its group mates, the same however pages finish', async () => {
    const scan = async (delayFor: (p: string) => number, statusFor: (p: string) => number = () => 200) => {
      const contextsOf = new Map<string, Set<number>>();
      const b = fakeProbeBrowser({
        delayFor, statusFor,
        evaluate: (name, path) => {
          if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
          if (name === 'pageShape') return SHAPES[path];
          return undefined;
        },
      });
      const mk = (id: string, everyPage: boolean): PageProbe => ({
        id, criteria: ['2.4.6'], kind: 'render', tier: 'core', timeoutMs: 1000, everyPage,
        async run(ctx) {
          const path = new URL(ctx.url).pathname;
          contextsOf.set(path, new Set([...(contextsOf.get(path) ?? []), b.contextOf(ctx.page)]));
          return [];
        },
      });
      const report = await scanSite('https://e.org/', {
        browser: b.browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: [mk('every-a', true), mk('every-b', true), mk('sample-only', false)],
      });
      const on = (id: string) => report.probes!.runs.filter((r) => r.probe === id).map((r) => new URL(r.page).pathname);
      return { report, on, contextsOf };
    };
    const a = await scan(() => 1);
    const all = Object.keys(SHAPES);
    expect(a.on('every-a')).toEqual(all);
    expect(a.on('every-b')).toEqual(all);
    expect(a.on('sample-only')).toEqual(['/', '/about', '/calendar', '/contact', '/forms/enroll']);
    // Outside the sample, the two every-page probes share one context per page.
    for (const p of all.filter((x) => !['/', '/about', '/calendar', '/contact', '/forms/enroll'].includes(x))) expect(a.contextsOf.get(p)!.size, p).toBe(1);
    // The criterion is checked (here: no failures found) on every page the probe ran on.
    const row = a.report.criteria!.find((c) => c.criterion === '2.4.6')!;
    expect(row.methods).toContainEqual({ id: 'every-a', kind: 'render', status: 'no_failures_found', pages: all.length });
    // The same set however the pages finish.
    const late = await scan((p) => (p === '/' ? 40 : p === '/news/102' ? 30 : p === '/staff' ? 20 : 1));
    expect(late.on('every-a')).toEqual(all);
    // None on a page whose audit failed.
    const failed = await scan(() => 1, (p) => (p === '/staff' ? 500 : 200));
    expect(failed.on('every-a')).toEqual(all.filter((p) => p !== '/staff'));
  });

  it('adds a probe\'s cross-page findings (`acrossPages`) to its runs, from their data, before the report is built', async () => {
    const probe: PageProbe = {
      id: 'across', criteria: ['2.4.6'], kind: 'render', tier: 'core', timeoutMs: 1000, everyPage: true,
      async run(ctx) {
        ctx.setData?.({ path: new URL(ctx.url).pathname });
        return [];
      },
      acrossPages(runs) {
        expect(runs.map((r) => r.index)).toEqual(Object.keys(SHAPES).map((_, i) => i));
        const news = runs.filter((r) => (r.run.data as { path: string }).path.startsWith('/news/'));
        return new Map(news.map((r) => [r.run.page, [
          { criterion: '2.4.6', status: 'failed' as const, target: 'h1', detail: `same as ${news.length - 1} others` },
          { criterion: '9.9.9', status: 'failed' as const, detail: 'not this probe\'s criterion: dropped' },
        ]]));
      },
    };
    const thrower: PageProbe = { id: 'thrower', criteria: ['2.4.6'], kind: 'render', tier: 'core', timeoutMs: 1000, run: async () => [], acrossPages() { throw new Error('boom'); } };
    const report = await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 4, probes: [probe, thrower] });
    const failing = report.probes!.runs.filter((r) => r.probe === 'across' && r.findings.length);
    expect(failing.map((r) => new URL(r.page).pathname)).toEqual(['/news/101', '/news/102', '/news/103']);
    expect(failing[0]!.findings).toEqual([{ criterion: '2.4.6', status: 'failed', target: 'h1', detail: 'same as 2 others' }]);
    expect(report.probes!.runs.filter((r) => r.probe === 'thrower').every((r) => r.findings.length === 0)).toBe(true);
    expect(report.criteria!.find((c) => c.criterion === '2.4.6')!.methods.find((m) => m.id === 'across')).toMatchObject({ status: 'failed', pages: 12 });
  });
});
