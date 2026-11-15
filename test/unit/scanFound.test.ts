// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The live view's provisional "found so far" events (plan 2026-11-04, the live scan page): as each page's
// audit, each test run and each AI review item finishes, which criteria now have a problem found and which
// were checked with nothing found yet. Provisional and results only: never a weight, share, threshold or
// point (public what, private how). Observation only: the report is the same with or without them.
import { describe, expect, it } from 'vitest';
import { FOUND_EVENTS_MAX, FOUND_FLUSH_EVERY, foundTracker } from '../../src/found.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { AiFinding, AiScanPlan, PageAudit, ProbeRun, ScanEvent } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

type Found = Extract<ScanEvent, { type: 'found' }>;
const PATHS = ['/', '/about', '/contact'];
const LINKS = PATHS.filter((p) => p !== '/').map((p) => `https://e.org${p}`);
const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
const node = (target: string) => ({ target, html: `<img src="${target}.png">` });

/** axe's answer per page (a plain AxeRun): /about has two images with no alt text; every page passes the title rule. */
const axe = (path: string) => ({
  violations: path === '/about' ? [{ id: 'image-alt', impact: 'critical', help: 'Images must have alternate text', helpUrl: '', nodes: [node('img.a'), node('img.b')] }] : [],
  passes: ['document-title', ...(path === '/about' ? [] : ['image-alt'])],
  incomplete: [], inapplicable: [],
});

const site = () => fakeProbeBrowser({
  delayFor: () => 1,
  evaluate: (name, path) => {
    if (name === 'runAxeInPage') return axe(path);
    if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
    // A different shape per page, so the template sample tests every page.
    if (name === 'pageShape') return { '/': 'header:1 nav:1 main:1', '/about': 'header:1 main:1 h2-6:2-3', '/contact': 'header:1 main:1 form:1' }[path];
    return undefined;
  },
});

/** A test that fails 2.4.11 on /contact and finds nothing elsewhere. */
const probe: PageProbe = {
  id: 'focus-obscured', criteria: ['2.4.11'], kind: 'interaction', tier: 'core', timeoutMs: 2000,
  run: async (ctx) => {
    const path = new URL(ctx.page.url!()).pathname;
    return path === '/contact'
      ? [{ criterion: '2.4.11', status: 'failed', detail: 'covered', target: 'a.x' }, { criterion: '2.4.11', status: 'failed', detail: 'covered', target: 'a.y' }]
      : [{ criterion: '2.4.11', status: 'no_failures_found', detail: 'ok' }];
  },
};

const aiFinding = (over: Partial<AiFinding>): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: 'https://e.org/', target: 'https://e.org/a.png', verdict: 'v', label: 'l',
  flagged: false, confidence: 'high', observed: '', issue: '', suggestion: '', source: 'ai', ...over,
});

/** An AI plan whose items answer while the pages are audited (it reports them through `watch`). */
function earlyAi(): AiScanPlan {
  let watcher: ((check: AiFinding['check'], f: readonly AiFinding[]) => void) | undefined;
  return {
    collectors: [],
    watch: (fn) => { watcher = fn; },
    onPageAudited: (page) => {
      if (page.url.endsWith('/about')) watcher?.('altText', [aiFinding({ page: page.url, flagged: true, target: 'https://e.org/b.png' })]);
      if (page.url.endsWith('/contact')) watcher?.('altText', [aiFinding({ page: page.url })]);
    },
    async finish() {
      // finish gives every finding again (the report's run): nothing is counted twice.
      return { runs: [{ check: 'altText', title: 'Alt text', summary: '', model: 'm', promptVersion: '1', tier: 'core', inputs: 2, reviewed: 2, cached: 0, notReviewed: 0,
        findings: [aiFinding({ page: 'https://e.org/about', flagged: true, target: 'https://e.org/b.png' }), aiFinding({ page: 'https://e.org/contact' })] }], disclaimer: '' };
    },
  };
}

async function scan(o: { ai?: AiScanPlan; listen?: boolean } = {}) {
  const events: ScanEvent[] = [];
  const report = await scanSite('https://e.org/', {
    browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 2, probes: [probe],
    ...(o.ai ? { ai: o.ai } : {}), ...(o.listen === false ? {} : { onEvent: (e: ScanEvent) => events.push(e) }),
  });
  return { events, report };
}

const found = (events: ScanEvent[]) => events.filter((e): e is Found => e.type === 'found');

describe('provisional found-so-far events', () => {
  it('each audited page says the criteria its rules checked and the problems they found, with the page', async () => {
    const { events } = await scan();
    const pages = (events.find((e) => e.type === 'selected') as Extract<ScanEvent, { type: 'selected' }>).pages;
    const rules = found(events).filter((e) => e.source === 'rules');
    expect(rules.length).toBeGreaterThan(0);
    for (const e of rules) expect(e.provisional).toBe(true);
    // A rule that passed and one that failed: both criteria checked; the failure once, on its page.
    expect(rules.flatMap((e) => e.checked)).toEqual(expect.arrayContaining(['1.1.1', '2.4.2']));
    const problems = rules.flatMap((e) => e.problems.map((p) => ({ ...p, page: pages[e.page!] })));
    expect(problems).toEqual([{ check: 'image-alt', criterion: '1.1.1', count: 2, page: 'https://e.org/about' }]);
  });

  it('each test run says what it checked and the failures it found on its page', async () => {
    const { events } = await scan();
    const tests = found(events).filter((e) => e.source === 'test');
    const failing = tests.filter((e) => e.problems.length);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.problems).toEqual([{ check: 'focus-obscured', criterion: '2.4.11', count: 2 }]);
    expect(tests.some((e) => e.checked.includes('2.4.11'))).toBe(true);
  });

  it('AI review items report as they answer, flagged ones as flags, and never twice', async () => {
    const { events } = await scan({ ai: earlyAi() });
    const ai = found(events).filter((e) => e.source === 'ai');
    const flags = ai.flatMap((e) => e.problems);
    expect(flags).toEqual([{ check: 'altText', criterion: '1.1.1', count: 1, flag: true }]);
    // The flag came while the pages were audited: before the last page-done.
    const at = events.findIndex((e) => e.type === 'found' && e.source === 'ai' && e.problems.length);
    expect(at).toBeLessThan(events.map((e) => e.type).lastIndexOf('page-done'));
    expect(ai.some((e) => e.checked.includes('1.1.1'))).toBe(true);
  });

  it('carry results only: no weight, share, threshold, points or score', async () => {
    const { events } = await scan({ ai: earlyAi() });
    for (const e of found(events)) {
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['checked', 'problems', 'provisional', 'source', 'type']));
      for (const k of Object.keys(e)) expect(['type', 'provisional', 'source', 'page', 'checked', 'problems']).toContain(k);
      for (const p of e.problems) for (const k of Object.keys(p)) expect(['check', 'criterion', 'count', 'flag']).toContain(k);
    }
    expect(JSON.stringify(found(events))).not.toMatch(/weight|share|threshold|point|score/i);
  });

  it('all come before done, and the report is the same with or without a listener', async () => {
    const a = await scan({ ai: earlyAi() });
    const b = await scan({ ai: earlyAi(), listen: false });
    expect(a.events.at(-1)!.type).toBe('done');
    const strip = (r: typeof a.report) => ({ ...r, meta: { ...r.meta, startedAt: '', finishedAt: '' }, probes: r.probes && { ...r.probes, runs: r.probes.runs.map((x) => ({ ...x, ms: 0 })) } });
    expect(strip(a.report)).toEqual(strip(b.report));
  });
});

describe('the found tracker', () => {
  const page = (url: string, extra: Partial<PageAudit> = {}): PageAudit => ({ url, status: 'ok', rules: { 'image-alt': 'fail', 'document-title': 'pass' }, violations: [{ id: 'image-alt', help: '', helpUrl: '', nodes: [{ target: 'img', html: '', viewports: ['desktop'] }] }], incomplete: [], links: [], ...extra });

  it('sends only what is new: a criterion already checked by that kind is not sent again', () => {
    const out: ScanEvent[] = [];
    const t = foundTracker((e) => out.push(e), (u) => (u.endsWith('/a') ? 0 : 1));
    t.page(page('https://e.org/a'), 0);
    t.page(page('https://e.org/b'), 1);
    const [a, b] = out as Found[];
    expect(a!.checked.sort()).toEqual(['1.1.1', '2.4.2']);
    expect(b!.checked).toEqual([]);
    expect(b!.problems).toEqual([{ check: 'image-alt', criterion: '1.1.1', count: 1 }]);
  });

  it('a failed page says nothing; a test run that could not test says nothing', () => {
    const out: ScanEvent[] = [];
    const t = foundTracker((e) => out.push(e), () => 0);
    t.page(page('https://e.org/a', { status: 'failed', rules: {}, violations: [] }), 0);
    const run: ProbeRun = { probe: 'p', kind: 'interaction', page: 'https://e.org/a', criteria: ['2.1.1'], status: 'timeout', findings: [{ criterion: '2.1.1', status: 'not_testable', detail: 'x' }], ms: 1 };
    t.run(run);
    expect(out).toEqual([]);
  });

  it('a test run with no finding for a criterion checked it with nothing found, as the report reads it', () => {
    const out: ScanEvent[] = [];
    const t = foundTracker((e) => out.push(e), () => 0);
    t.run({ probe: 'keyboard', kind: 'interaction', page: 'https://e.org/a', criteria: ['2.1.1', '2.4.7'], status: 'ok', findings: [{ criterion: '2.4.7', status: 'not_applicable', detail: 'x' }], ms: 1 });
    expect(out).toEqual([{ type: 'found', provisional: true, source: 'test', page: 0, checked: ['2.1.1'], problems: [] }]);
  });

  it('past FOUND_EVENTS_MAX nothing is dropped: gathered into few events, and the totals at the end are the whole scan\'s', () => {
    const out: ScanEvent[] = [];
    const t = foundTracker((e) => out.push(e), (u) => Number(new URL(u).pathname.slice(1)));
    const PAGES = 1000;
    const two = (id: string, n: number) => ({ id, help: '', helpUrl: '', nodes: Array.from({ length: n }, () => ({ target: 'a', html: '', viewports: ['desktop' as const] })) });
    for (let i = 0; i < PAGES; i++) t.page(page(`https://e.org/${i}`, { rules: { 'image-alt': 'fail', 'link-name': 'fail' }, violations: [two('image-alt', 2), two('link-name', 3)] }), i);
    t.flush();
    // Bounded: the cap, one event per FOUND_FLUSH_EVERY pages past it, and the flush.
    expect(out.length).toBeLessThanOrEqual(FOUND_EVENTS_MAX + Math.ceil((PAGES - FOUND_EVENTS_MAX) / FOUND_FLUSH_EVERY) + 2);
    // Complete: every element on every page, each problem on the pages it was found on.
    const total = new Map<string, number>();
    const pages = new Map<string, Set<number>>();
    for (const e of out as Found[]) {
      for (const p of e.problems) {
        const k = `${p.check}|${p.criterion}`;
        total.set(k, (total.get(k) ?? 0) + p.count);
        const set = pages.get(k) ?? new Set<number>();
        for (const n of p.pages ?? (e.page !== undefined ? [e.page] : [])) set.add(n);
        pages.set(k, set);
      }
    }
    expect(Object.fromEntries(total)).toEqual({ 'image-alt|1.1.1': 2 * PAGES, 'link-name|2.4.4': 3 * PAGES, 'link-name|4.1.2': 3 * PAGES });
    for (const set of pages.values()) expect(set.size).toBe(PAGES);
    // A gathered event names no single page; each of its problems names its own.
    const gathered = (out as Found[]).slice(FOUND_EVENTS_MAX);
    expect(gathered.length).toBeGreaterThan(0);
    for (const e of gathered) { expect(e.page).toBeUndefined(); for (const p of e.problems) expect(p.pages?.length).toBeGreaterThan(0); }
  });

  it('a later segment with no budget left gathers from its first page, and still ends complete', () => {
    const out: ScanEvent[] = [];
    const t = foundTracker((e) => out.push(e), (u) => Number(new URL(u).pathname.slice(1)), 0);
    for (let i = 0; i < 200; i++) t.page(page(`https://e.org/${i}`), i);
    t.flush();
    expect(out.length).toBeLessThanOrEqual(2 + Math.ceil(200 / FOUND_FLUSH_EVERY) + 2);
    const sum = (out as Found[]).flatMap((e) => e.problems).filter((p) => p.check === 'image-alt').reduce((a, p) => a + p.count, 0);
    expect(sum).toBe(200);
  });

  it('past the cap, a criterion\'s first problem still goes out at once (the grid never waits)', () => {
    const out: ScanEvent[] = [];
    const t = foundTracker((e) => out.push(e), (u) => Number(new URL(u).pathname.slice(1)));
    for (let i = 0; i < FOUND_EVENTS_MAX + 5; i++) t.page(page(`https://e.org/${i}`), i);
    const before = out.length;
    t.page(page('https://e.org/9999', { rules: { bypass: 'fail' }, violations: [{ id: 'bypass', help: '', helpUrl: '', nodes: [{ target: 'html', html: '', viewports: ['desktop'] }] }] }), 9999);
    expect(out.length).toBe(before + 1);
    expect((out.at(-1) as Found).problems).toContainEqual({ check: 'bypass', criterion: '2.4.1', count: 1, pages: [9999] });
  });
});
