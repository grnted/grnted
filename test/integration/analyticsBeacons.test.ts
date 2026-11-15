// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A scan is not a visitor (P1, 2026-11-05: a staging scan added ~7,700 sessions to the scanned site's
// GA4). Real Chromium against the analytics fixture (test/helpers/analyticsSite.ts): the site's tags
// load from their real host names, mapped to a local collector, and the collector counts what reaches
// it. Without `quietBrowser` every page the scan opens records visits; with it nothing does, the tags
// still run, and the page renders the same. The hosted path is proved in apps/worker (noAnalyticsHits).
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quietBrowser } from '../../src/analytics.js';
import { captureLiveShot } from '../../src/liveShot.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ContextLike, PageLike, SiteReport } from '../../src/types.js';
import { ANALYTICS_HOST_RULES, startAnalyticsSite, type AnalyticsSite } from '../helpers/analyticsSite.js';

let browser: Browser;
let site: AnalyticsSite;

beforeAll(async () => {
  site = await startAnalyticsSite();
  browser = await chromium.launch({ args: [ANALYTICS_HOST_RULES] });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const settle = () => new Promise((r) => setTimeout(r, 400));

/**
 * What the report concludes, without its times, its fixture port, or the counts some notes carry (how
 * many timers a page had armed when a test looked, frames per second): those vary from run to run.
 */
const results = (r: SiteReport) => {
  const at = (u: string) => u.replace(/^https?:\/\/[^/]+/, '');
  return {
    status: r.status, score: r.score, letter: r.letter, headline: r.headline, reasons: r.reasons,
    pages: r.pages.map((p) => [at(p.url), p.status, p.score, p.violations]),
    rules: r.rules.map((x) => [x.id, x.pagesAffected.map(at), x.elements]),
    needsReview: r.needsReview.map((x) => [x.id, x.pagesAffected.map(at)]),
    testIssues: (r.testIssues ?? []).map((t) => [t.criterion, t.pagesAffected.map(at), t.pointsLost]),
    untested: r.untestedCriteria, documents: r.documents.map(at),
    criteria: (r.criteria ?? []).map((c) => [c.criterion, c.status, c.methods.map((m) => `${m.id} ${m.status} ${m.pages}`)]),
  };
};

describe('the CLI\'s browser (quietBrowser)', () => {
  it('a scan sends the site\'s analytics nothing, while the same scan without it records visits on every page; the results are the same', async () => {
    site.reset();
    const plain = await scanSite(`${site.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 3, concurrency: 2 });
    await settle();
    const before = site.hits().length;
    expect(before, 'the fixture tags record visits when nothing stops them').toBeGreaterThan(0);
    expect(new Set(site.hits().map((h) => h.host))).toEqual(new Set(['region1.google-analytics.com', 'www.google-analytics.com', 'us.i.posthog.com', 'www.facebook.com']));
    site.reset();
    const quiet = await scanSite(`${site.origin}/`, { browser: quietBrowser(browser as unknown as BrowserLike), maxPages: 3, concurrency: 2 });
    await settle();
    console.log(`analytics hits: without quietBrowser ${before}, with it ${site.hits().length} (scripts loaded ${site.scripts().length})`);
    expect(site.hits()).toEqual([]);
    // The tags themselves still loaded, on every page.
    expect(site.scripts().length).toBeGreaterThanOrEqual(3 * 3);
    expect(results(quiet)).toEqual(results(plain));
  }, 120_000);

  it('the 800x600 sessions: a live shot (CDP captureScreenshot with a clip, from its own session) resets the page\'s screen to the browser default, and a later event sends that; quietBrowser stops it too', async () => {
    const run = async (b: BrowserLike) => {
      site.reset();
      const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = (await ctx.newPage()) as unknown as Page;
        await page.goto(`${site.origin}/`, { waitUntil: 'load' });
        await page.waitForTimeout(300);
        const screenBefore = await page.evaluate(() => `${screen.width}x${screen.height}`);
        await captureLiveShot(page as unknown as PageLike, ctx as ContextLike, 'desktop');
        await page.waitForTimeout(400);
        const screenAfter = await page.evaluate(() => `${screen.width}x${screen.height}`);
        return { screenBefore, screenAfter, sr: site.hits().map((h) => h.sr).filter(Boolean) };
      } finally {
        await ctx.close();
      }
    };
    const plain = await run(browser as unknown as BrowserLike);
    expect(plain.screenBefore).toBe('1280x900');
    expect(plain.screenAfter).toBe('800x600');
    expect(plain.sr).toContain('800x600');
    const quiet = await run(quietBrowser(browser as unknown as BrowserLike));
    expect(quiet.screenAfter).toBe('800x600');
    expect(quiet.sr).toEqual([]);
  }, 60_000);

  it('a page whose UI depends on its analytics scripts renders exactly as without quietBrowser', async () => {
    const shoot = async (b: BrowserLike) => {
      const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = (await ctx.newPage()) as unknown as Page;
        await page.goto(`${site.origin}/about.html`, { waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('tag-status')?.className === 'ready' && !!document.getElementById('ph-banner'));
        const text = await page.evaluate(() => document.querySelector('main')!.innerText);
        const png = await page.screenshot({ type: 'png' });
        return { text, png: Buffer.from(png).toString('base64') };
      } finally {
        await ctx.close();
      }
    };
    const plain = await shoot(browser as unknown as BrowserLike);
    const quiet = await shoot(quietBrowser(browser as unknown as BrowserLike));
    expect(quiet.text).toContain('Analytics ready');
    expect(quiet.text).toContain('Welcome back');
    expect(quiet.text).toBe(plain.text);
    expect(quiet.png).toBe(plain.png);
  }, 60_000);
});
