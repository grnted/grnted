// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The fedex.com pattern (staging 2026-11-03), end to end in a real browser, on a local fixture
// (helpers/slowSiteServer.ts) with the timings scaled down (`timing`): apex 301 to www, every HTML answer
// slow, `/` a 302 to a slow country chooser, sitemaps listed only in robots.txt and slow, an image that
// holds every page's load event. The real-scale runner is the end of helpers/slowSiteServer.ts.
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scanSite, ScanPaused, type ScanResume } from '../../src/scan.js';
import { BOT_CHALLENGE } from '../../src/challenge.js';
import { SLOWED_PAGE, type SiteTiming, type StartSpeed } from '../../src/siteSpeed.js';
import type { BrowserLike, PageAudit, ScanEvent } from '../../src/types.js';
import { startSlowSite, type SlowSite } from '../helpers/slowSiteServer.js';

// ~1/10 of real scale: a 600 ms first byte (FedEx 8.2 s) against a 400 ms threshold (5 s).
const timing: Partial<SiteTiming> = {
  slowFirstByteMs: 400, pageTimeoutMs: 2_500, slowPageTimeoutMs: 6_000, fileTimeoutMs: 3_000,
  sitemapBudgetMs: 6_000, homeLoadWaitMs: 800,
};

let browser: Browser;
let site: SlowSite | undefined;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });
afterEach(async () => { await site?.close(); site = undefined; });

const scan = (url: string, extra: Parameters<typeof scanSite>[1] extends infer O ? Partial<O> : never = {}) =>
  scanSite(url, { browser: browser as unknown as BrowserLike, maxPages: 6, concurrency: 6, documents: false, probes: false, timing, ...extra });

describe('a site that slows automated visitors (the fedex.com pattern)', () => {
  it('apex start: finds the pages in the robots.txt sitemaps, loads them with the longer timeout, two at a time', async () => {
    // Pages fire load after ~3.6 s: past the ordinary 2.5 s timeout, inside the slow 6 s one.
    site = await startSlowSite({ firstByteMs: 600, locationMs: 400, sitemapMs: 1_200, assetMs: 3_000, pagesPerSitemap: 4 });
    let speed: StartSpeed | undefined;
    const report = await scan(`${site.apex}/`, { onStartSpeed: (s) => { speed = s; } });
    expect(speed).toMatchObject({ slow: true, challenge: false });
    // Measured once, by a plain request for the start page and its redirect (never the body).
    expect(site.stats.plain).toEqual(['localhost/', 'www.localhost/']);
    expect(report.pages).toHaveLength(6);
    expect(report.pages.slice(1).every((p) => p.url.startsWith(`${site!.www}/`))).toBe(true);
    expect(report.pages.filter((p) => p.status === 'ok').length).toBe(6);
    // Two pages at once, each loading its two widths together: never more than 4 documents in flight.
    expect(site.stats.documents).toBeGreaterThanOrEqual(12);
    expect(site.stats.maxDocumentsAtOnce).toBeLessThanOrEqual(4);
    expect(site.stats.requests).not.toContain('www.localhost/sitemap.xml');
  }, 120_000);

  it('no sitemap pages in time: the start page\'s redirect is followed to the chooser and its links are used', async () => {
    // Sitemaps slower than the whole budget: the home page fallback reads the chooser's country links.
    site = await startSlowSite({ firstByteMs: 600, locationMs: 400, sitemapMs: 10_000, assetMs: 3_000 });
    const report = await scan(`${site.apex}/`, { maxPages: 5 });
    expect(report.pages[0]!.url).toBe(`${site.apex}/`);
    expect(report.pages.slice(1).map((p) => new URL(p.url).pathname).sort()).toEqual(['/de-de/home.html', '/en-gb/home.html', '/en-us/home.html', '/es-es/home.html']);
  }, 120_000);

  it('every page held back past the longer timeout: each fails as the site slowing us, inside the scan', async () => {
    site = await startSlowSite({ firstByteMs: 600, locationMs: 400, sitemapMs: 1_200, assetMs: 'never', pagesPerSitemap: 2 });
    const t0 = Date.now();
    const report = await scan(`${site.apex}/`, { maxPages: 3 });
    expect(report.pages).toHaveLength(3);
    for (const p of report.pages) expect([p.status, p.reason]).toEqual(['failed', SLOWED_PAGE]);
    // Discovery (≤ 6 s of sitemaps) + two rounds of 6 s loads, two pages at a time, plus overhead.
    expect(Date.now() - t0).toBeLessThan(40_000);
  }, 120_000);

  it('a page answered by a known WAF challenge (cf-mitigated) is a bot challenge, not the page', async () => {
    site = await startSlowSite({ firstByteMs: 50, locationMs: 0, sitemapMs: 50, assetMs: 0, pagesPerSitemap: 1, challenge: true });
    let speed: StartSpeed | undefined;
    const report = await scan(`${site.www}/en-us/page-0.html`, { maxPages: 1, onStartSpeed: (s) => { speed = s; } });
    expect(speed).toMatchObject({ challenge: true });
    expect(report.pages[0]).toMatchObject({ status: 'failed', reason: BOT_CHALLENGE });
  }, 60_000);

  // Paul, 2026-11-03: a site measured slow gets the time it needs. Hosted, it runs as a long scan: pages in
  // segments (pause between pages, checkpoints), then a last segment that resumes from the stored pages
  // and does the core tests and the report. The same here, with the host's measured speed handed in.
  it('in segments like a hosted long scan: paused, resumed from stored pages, scored, inside the budget', async () => {
    site = await startSlowSite({ firstByteMs: 600, locationMs: 400, sitemapMs: 600, assetMs: 1_500, pagesPerSitemap: 4 });
    const t0 = Date.now();
    const budgetMs = 120_000;
    const audits = new Map<number, PageAudit>();
    let pages: string[] = [];
    let documents: string[] = [];
    let skipped: { url: string; reason: string }[] = [];
    const speed: StartSpeed = { slow: true, challenge: false, firstByteMs: 8200 };
    const opts = {
      startSpeed: speed, maxPages: 10, concurrency: 4, probes: undefined, full: true, deadline: t0 + budgetMs,
      onPageAudited: (p: PageAudit, i: number) => { audits.set(i, p); },
      onEvent: (e: ScanEvent) => { if (e.type === 'selected') { pages = [...e.pages]; documents = [...e.documents]; skipped = e.skipped.map((x) => ({ ...x })); } },
    };
    const resume = (): ScanResume => ({ pages, documents, skipped, audit: (i) => audits.get(i), startSpeed: speed });
    // Segment 1: pages only, paused after 4 pages.
    const first = await scan(`${site.apex}/`, { ...opts, pagesOnly: true, pause: () => audits.size >= 4 }).then(() => null, (e: unknown) => e);
    expect(first).toBeInstanceOf(ScanPaused);
    const afterFirst = audits.size;
    expect(afterFirst).toBeGreaterThanOrEqual(4);
    expect(afterFirst).toBeLessThan(10);
    // The last segment: the rest of the pages, the core tests, the report.
    const report = await scan(`${site.apex}/`, { ...opts, resume: resume() });
    const wall = Date.now() - t0;
    expect(report.pages).toHaveLength(10);
    expect(report.status).toBe('scored');
    expect(report.probes?.runs.length ?? 0).toBeGreaterThan(0);
    expect(wall).toBeLessThan(budgetMs);
    // The start page was measured by the host only: neither segment asked again.
    expect(site.stats.plain).toEqual([]);
  }, 180_000);
});
