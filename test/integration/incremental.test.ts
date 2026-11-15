// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Incremental monitoring scans end to end (Plan 7, W6; docs/monitoring.md), on a local copy of the
// synthetic site's behaviour (test/helpers/synthLite.ts) with a real browser: a monitoring scan audits
// only what changed, carries every other page's audit forward, and its score is the full scan's.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incrementalSummary, nextIncrementalState, WORKER_ACCEPT_LANGUAGE, type IncrementalPrevious, type PageRevision } from '../../src/incremental/index.js';

/** The worker's own GETs ask for HTML with this Accept (the browser's differs). */
const WORKER_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
import { scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, PageAudit, SiteReport } from '../../src/types.js';
import { startSynthLite, type SynthLite } from '../helpers/synthLite.js';

let browser: Browser;
let site: SynthLite;

beforeAll(async () => {
  browser = await chromium.launch();
  site = await startSynthLite();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

/** What a monitor keeps between scans: the state and every page's audit (the host's R2 copy). */
interface Kept { state: IncrementalPrevious | null; audits: Map<string, PageAudit> }

const base = (over: Partial<ScanOptions> = {}): ScanOptions => ({
  browser: browser as unknown as BrowserLike, maxPages: 25, concurrency: 4, documents: false, probes: false, ...over,
});

/** One monitoring scan: the report, the pages as audited or carried, and what the monitor keeps next. */
async function monitorScan(kept: Kept, o: { full?: boolean; opts?: Partial<ScanOptions> } = {}) {
  const pages = new Map<number, PageAudit>();
  const startedAt = new Date().toISOString();
  const report = await scanSite(site.origin, base({
    ...o.opts,
    now: () => new Date(startedAt),
    incremental: { previous: kept.state, full: o.full ?? false, carried: async (u) => kept.audits.get(u) },
    onPageAudited: (p, i) => { pages.set(i, p); },
  }));
  const list = [...pages.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
  const next: Kept = { state: nextIncrementalState(kept.state, list, { startedAt, full: !!o.full || !kept.state }), audits: keep(list, report) };
  const decided = Object.fromEntries(list.map((p) => [new URL(p.url).pathname, (p.revision as PageRevision).decided]));
  return { report, list, next, decided };
}

/** What the host keeps per page: its audit and its core test runs from the report (r1-8b). */
function keep(list: PageAudit[], report: SiteReport): Map<string, PageAudit> {
  const runs = report.probes?.runs ?? [];
  return new Map(list.map((p) => {
    const own = runs.filter((r) => r.page === p.url);
    const { probeRuns: _old, ...audit } = p;
    return [p.url, own.length ? { ...audit, probeRuns: own } : audit];
  }));
}

const requestsAfter = (t: number) => site.log.filter((l) => l.at >= t);
const pagePaths = new Set<string>();

describe('incremental monitoring scans', () => {
  let first: Awaited<ReturnType<typeof monitorScan>>;
  let fullV1: SiteReport;

  it('the first scan audits every page and is the full scan', async () => {
    site.version = '1';
    site.assets = '1';
    fullV1 = await scanSite(site.origin, base());
    first = await monitorScan({ state: null, audits: new Map() });
    for (const p of first.list) pagePaths.add(new URL(p.url).pathname);
    expect(first.list.length).toBe(site.paths.length);
    expect(new Set(Object.values(first.decided))).toEqual(new Set(['new']));
    expect(first.report.score).toBe(fullV1.score);
    expect(first.report.incremental).toEqual({ full: true, pages: site.paths.length, checked: site.paths.length, unchanged: 0, skipped: { lastmod: 0, notModified: 0, sameHtml: 0 } });
    expect(first.next.state!.lastmod.trust).toBe('unproven');
  }, 120_000);

  let second: Awaited<ReturnType<typeof monitorScan>>;
  it('nothing changed: only the homepage (and the core-test sample) load in the browser; the score is the full scan\'s', async () => {
    const t = Date.now();
    second = await monitorScan(first.next);
    const audited = Object.entries(second.decided).filter(([, d]) => !['not-modified', 'same-html', 'lastmod'].includes(d)).map(([p]) => p);
    // The homepage and one page per template the core tests sample (by URL pattern and DOM shape).
    expect(audited[0]).toBe('/');
    expect(audited.every((p) => ['home', 'sample'].includes(second.decided[p]!))).toBe(true);
    expect(second.report.score).toBe(fullV1.score);
    expect(second.report.status).toBe('scored');
    expect(second.report.incremental!.unchanged).toBe(site.paths.length - audited.length);
    expect(second.report.incremental!.skipped.notModified).toBe(site.paths.length - audited.length);
    // Carried pages say so, with the date of the audit they carry.
    const carried = second.report.pages.filter((p) => p.unchangedSince);
    expect(carried.length).toBe(site.paths.length - audited.length);
    expect(carried.every((p) => p.unchangedSince === first.next.state!.startedAt)).toBe(true);
    // The browser loaded only the audited pages (a conditional GET of each other page answered 304).
    // (Every page has state now, so the scan's own fetches are all conditional; the browser's are not.)
    const loads = requestsAfter(t).filter((l) => !l.conditional && pagePaths.has(l.path)).map((l) => l.path);
    expect(new Set(loads)).toEqual(new Set(audited));
    // (The hosted report's comparison of the two scans, nothing fixed and nothing new, is tested with that report.)
    // The pages read in full (the homepage and the sample) agreed with their lastmods: trusted now.
    expect(second.next.state!.lastmod.trust).toBe('trusted');
  }, 120_000);

  it('a new site version: the changed pages are audited, the score is a full scan\'s of the new site', async () => {
    site.version = '2';
    const changed = site.paths.filter((p) => site.changed('2', p));
    expect(changed.length).toBeGreaterThanOrEqual(2);
    const t = Date.now();
    const third = await monitorScan(second.next);
    const during = site.log.filter((l) => l.at >= t);
    const fullV2 = await scanSite(site.origin, base());
    for (const p of changed) expect(['changed', 'home', 'sample']).toContain(third.decided[p]);
    const unchanged = site.paths.filter((p) => !changed.includes(p) && !['home', 'sample'].includes(third.decided[p]!));
    // Layer 1: the trusted sitemap's lastmod settles every unchanged page without a request.
    for (const p of unchanged) expect(third.decided[p]).toBe('lastmod');
    expect(unchanged.length).toBeGreaterThan(0);
    for (const p of unchanged) expect(during.filter((l) => l.path === p)).toEqual([]);
    expect(during.some((l) => l.path === '/sitemap.xml')).toBe(true);
    expect(third.report.score).toBe(fullV2.score);
    expect(third.report.incremental).toMatchObject({ full: false, skipped: { lastmod: unchanged.length, notModified: 0, sameHtml: 0 } });
    expect(third.report.incremental!.checked).toBe(site.paths.length - unchanged.length);
    // Back to the baseline for the next tests.
    site.version = '1';
  }, 180_000);

  it('the same site and the same previous state give the same decisions', async () => {
    site.version = '2';
    const a = await monitorScan(second.next);
    const b = await monitorScan(second.next, { opts: { concurrency: 2 } });
    expect(b.decided).toEqual(a.decided);
    site.version = '1';
  }, 180_000);

  it('r1-3: a shared stylesheet changed (cosmetically): every page that uses it is audited', async () => {
    site.assets = '2';
    const r = await monitorScan(second.next);
    // Every page uses /assets/site.css: none is carried.
    expect(Object.values(r.decided).every((d) => ['home', 'sample', 'asset-changed'].includes(d))).toBe(true);
    expect(Object.values(r.decided)).toContain('asset-changed');
    expect(r.report.score).toBe(fullV1.score);
    site.assets = '1';
  }, 120_000);

  it('r1-3: a shared stylesheet change that fails news pages: every page is audited and the score is the full scan\'s', async () => {
    site.assets = 'low-contrast';
    const r = await monitorScan(second.next);
    const full = await scanSite(site.origin, base());
    expect(Object.values(r.decided).every((d) => ['home', 'sample', 'asset-changed'].includes(d))).toBe(true);
    expect(r.report.score).toBe(full.score);
    expect(r.report.score).toBeLessThan(fullV1.score!);
    site.assets = '1';
  }, 180_000);

  it('r2-4: a full cycle is a one-off scan plus one plain worker GET per page (no conditional request)', async () => {
    const t = Date.now();
    const r = await monitorScan(second.next, { full: true });
    const during = requestsAfter(t).filter((l) => pagePaths.has(l.path));
    expect(during.filter((l) => l.conditional)).toEqual([]);
    const worker = during.filter((l) => l.accept === WORKER_ACCEPT);
    expect(worker.map((l) => l.path).sort()).toEqual([...site.paths].sort());
    expect(worker.every((l) => l.acceptLanguage === WORKER_ACCEPT_LANGUAGE && !l.cookie)).toBe(true);
    const t2 = Date.now();
    await scanSite(site.origin, base());
    const oneOff = requestsAfter(t2).filter((l) => pagePaths.has(l.path));
    expect(during.length).toBeLessThanOrEqual(oneOff.length + site.paths.length);
    expect(new Set(Object.values(r.decided))).toEqual(new Set(['full']));
    expect(r.report.incremental).toMatchObject({ full: true, unchanged: 0 });
    expect(r.report.score).toBe(fullV1.score);
  }, 120_000);

  it('the score is the same with the core tests on (they run on the sample every scan)', async () => {
    const opts = { probes: undefined } as Partial<ScanOptions>;
    const fullP = await scanSite(site.origin, base(opts));
    const k1 = await monitorScan({ state: null, audits: new Map() }, { opts });
    const k2 = await monitorScan(k1.next, { opts });
    expect(k2.report.incremental!.unchanged).toBeGreaterThan(0);
    expect(k2.report.score).toBe(fullP.score);
    expect(k2.report.testIssues).toEqual(fullP.testIssues);
    expect(k2.report.criteria).toEqual(fullP.criteria);
  }, 240_000);

  it('r1-8b: with the core tests on, a carried page gets no probe navigation (its conditional GET is its only request)', async () => {
    const opts = { probes: undefined } as Partial<ScanOptions>;
    const k1 = await monitorScan({ state: null, audits: new Map() }, { opts });
    const t = Date.now();
    const k2 = await monitorScan(k1.next, { opts });
    const carried = Object.entries(k2.decided).filter(([, d]) => d === 'not-modified').map(([p]) => p);
    expect(carried.length).toBeGreaterThan(5);
    for (const p of carried) expect(requestsAfter(t).filter((l) => l.path === p).map((l) => l.status), p).toEqual([304]);
    // The carried pages' every-page runs are in the report, from the scan that checked them.
    for (const p of carried) expect(k2.report.probes!.runs.some((r) => new URL(r.page).pathname === p && r.probe === 'headings'), p).toBe(true);
  }, 240_000);
});

describe('politeness', () => {
  let slow: SynthLite;
  beforeAll(async () => { slow = await startSynthLite({ crawlDelay: 1 }); });
  afterAll(async () => { await slow?.close(); });

  it('every page request, conditional ones included, keeps the Crawl-delay; the trusted sitemap needs none', async () => {
    const scan = async (kept: Kept) => {
      const pages = new Map<number, PageAudit>();
      const startedAt = new Date().toISOString();
      const report = await scanSite(slow.origin, base({
        maxPages: 8, now: () => new Date(startedAt), incremental: { previous: kept.state, carried: async (u) => kept.audits.get(u) }, onPageAudited: (p, i) => { pages.set(i, p); },
      }));
      const list = [...pages.values()];
      return { report, next: { state: nextIncrementalState(kept.state, list, { startedAt, full: !kept.state }), audits: keep(list, report) } as Kept, list };
    };
    const a = await scan({ state: null, audits: new Map() });
    const t = Date.now();
    const b = await scan(a.next);
    const pageReqs = slow.log.filter((l) => l.at >= t && slow.paths.includes(l.path));
    expect(pageReqs.some((l) => l.conditional)).toBe(true);
    const starts = pageReqs.map((l) => l.at).sort((x, y) => x - y);
    // A page's two widths load together (one load for the delay); every other gap is at least ~1 s.
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    expect(gaps.filter((g) => g >= 950).length).toBeGreaterThanOrEqual(pageReqs.filter((l) => l.conditional).length - 1);
    expect(b.list.length).toBe(8);
    // Trusted now: the next scan settles unchanged pages from the sitemap with no request at all.
    expect(b.next.state!.lastmod.trust).toBe('trusted');
    const t2 = Date.now();
    const c = await scan(b.next);
    const carried = c.list.filter((p) => (p.revision as PageRevision).decided === 'lastmod');
    expect(carried.length).toBeGreaterThan(0);
    for (const p of carried) expect(slow.log.some((l) => l.at >= t2 && l.path === new URL(p.url).pathname)).toBe(false);
    expect(incrementalSummary(c.list, false).skipped.lastmod).toBe(carried.length);
  }, 180_000);
});

describe('long monitoring scans (the crawl, segments)', () => {
  let tree: import('node:http').Server;
  let origin = '';
  /** A crawl-only tree site (no sitemap): / links /s0../s5, each /sN links /sN/p0../sN/p11; validators on every page. */
  const body = (path: string) => {
    const kids = path === '/' ? Array.from({ length: 6 }, (_, i) => `/s${i}`) : /^\/s\d$/.test(path) ? Array.from({ length: 12 }, (_, i) => `${path}/p${i}`) : [];
    const bad = path.endsWith('p3') ? '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' : '';
    return `<!doctype html><html lang="en"><head><title>${path}</title></head><body><main><h1>Page ${path}</h1><p>${'Words for people to read on this page. '.repeat(3)}</p>${bad}<ul>${kids.map((h) => `<li><a href="${h}">${h}</a></li>`).join('')}</ul></main></body></html>`;
  };
  beforeAll(async () => {
    const { createServer } = await import('node:http');
    tree = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/' || /^\/s\d(\/p\d+)?$/.test(path)) {
        const etag = `"${path}"`;
        if (req.headers['if-none-match'] === etag) return void res.writeHead(304, { etag }).end();
        return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag }).end(body(path));
      }
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>');
    });
    await new Promise<void>((r) => tree.listen(0, '127.0.0.1', () => r()));
    const a = tree.address();
    origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(async () => { await new Promise<void>((r) => tree?.close(() => r())); });

  const longScan = async (kept: Kept, extra: Partial<ScanOptions> = {}) => {
    const pages = new Map<number, PageAudit>();
    const startedAt = new Date().toISOString();
    const report = await scanSite(origin, base({
      maxPages: 60, now: () => new Date(startedAt), ...extra,
      incremental: { previous: kept.state, carried: async (u) => kept.audits.get(u), ...(extra.incremental ?? {}) },
      onPageAudited: (p, i) => { pages.set(i, p); extra.onPageAudited?.(p, i); },
    }));
    const list = [...pages.entries()].sort(([a], [b]) => a - b).map(([, p]) => p);
    return { report, list, startedAt, next: { state: nextIncrementalState(kept.state, list, { startedAt, full: !kept.state }), audits: new Map(list.map((p) => [p.url, p])) } as Kept };
  };

  it('carried pages replay their links, so the crawl finds the same pages; the score is the full scan\'s', async () => {
    const full = await scanSite(origin, base({ maxPages: 60 }));
    const a = await longScan({ state: null, audits: new Map() });
    const b = await longScan(a.next);
    expect(b.report.meta.pageList).toEqual(full.meta.pageList);
    expect(b.report.score).toBe(full.score);
    expect(b.report.incremental!.unchanged).toBeGreaterThan(40);
  }, 180_000);

  it('a monitoring scan paused between pages and resumed decides the same as one run', async () => {
    const a = await longScan({ state: null, audits: new Map() });
    const one = await longScan(a.next);
    // The host keeps the page list as it grew and every page as decided, like the ScanRunner.
    const done = new Map<number, PageAudit>();
    let list: string[] = [];
    let skipped: { url: string; reason: string }[] = [];
    let lastmods: Record<string, string> = {};
    let n = 0;
    await expect(scanSite(origin, base({
      maxPages: 60, pause: () => n >= 12,
      incremental: { previous: a.next.state, carried: async (u) => a.next.audits.get(u), onLastmods: (m) => { lastmods = m; } },
      onEvent: (e) => { if (e.type === 'selected') { list = [...e.pages]; skipped = e.skipped.map((x) => ({ ...x })); } },
      onPagesAdded: (all, sk) => { list = [...all]; skipped = sk.map((x) => ({ ...x })); },
      onPageAudited: (p, i) => { done.set(i, p); n++; },
    }))).rejects.toThrow(/stopped between pages/);
    const resumed = await scanSite(origin, base({
      maxPages: 60,
      resume: { pages: list, documents: [], skipped, audit: (i) => done.get(i) },
      incremental: { previous: a.next.state, carried: async (u) => a.next.audits.get(u), lastmods },
      onPageAudited: (p, i) => { done.set(i, p); },
    }));
    const decided = (m: Map<number, PageAudit> | PageAudit[]) => [...m.values()].map((p) => [p.url, (p.revision as PageRevision).decided] as const).sort();
    expect(decided(done)).toEqual(decided(one.list));
    expect(resumed.score).toBe(one.report.score);
    expect(resumed.incremental).toEqual(one.report.incremental);
  }, 240_000);
});
