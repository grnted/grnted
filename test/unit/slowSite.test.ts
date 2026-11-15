// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Staging 2026-11-03: a paid scan of fedex.com found one page and ended "0 of 1 pages loaded". The site
// slows every automated HTML answer to ~8-10 s (bot protection): each sitemap fetch was cut at our 10 s
// cap, so the robots.txt sitemaps gave nothing, and the home page link fallback threw its links away
// when the page's load event did not come within 45 s. These tests pin the fixes: slow sitemaps are read
// within a bounded budget, the fallback reads the links of the page it reached, and a slow start page
// is measured (bounded) so its pages get a longer, still bounded, load timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverPages } from '../../src/crawl.js';
import { measureStart, pageTimeoutFor, SITE_TIMING, SLOWED_PAGE, slowedReason } from '../../src/siteSpeed.js';
import { BOT_CHALLENGE, isWafChallenge } from '../../src/challenge.js';
import type { BrowserLike } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const APEX = 'https://e.org';
const WWW = 'https://www.e.org';
const later = <T>(ms: number, v: () => T) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
const urlset = (paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>${WWW}${p}</loc></url>`).join('')}</urlset>`;
const noBrowser = { newContext: () => { throw new Error('the homepage is not opened when the sitemap has pages'); } } as unknown as BrowserLike;

/** A browser whose page answers DOMContentLoaded but never `load` within the timeout (a slow asset). */
function neverLoads(links: string[], log: { waitUntil?: string; timeout?: number }[] = []): BrowserLike {
  return {
    newContext: async () => ({
      newPage: async () => ({
        goto: async (_url: string, o?: { waitUntil?: string; timeout?: number }) => {
          log.push({ ...o });
          if (o?.waitUntil === 'load') throw new Error(`page.goto: Timeout ${o.timeout}ms exceeded.`);
          return { status: () => 200, url: () => `${WWW}/global/choose-location.html`, headers: () => ({ 'content-type': 'text/html' }) };
        },
        // A number: the bounded in-page wait for `load` (it never comes). Otherwise: the links.
        evaluate: async (_fn: unknown, arg: unknown) => (typeof arg === 'number' ? undefined : links),
        close: async () => {},
      }),
      close: async () => {},
    }),
  } as unknown as BrowserLike;
}

describe('sitemaps on a slow site (robots.txt lists them; every answer is slow)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a sitemap that takes 12 s is still read (the old 10 s cap dropped it)', async () => {
    const f = fakeFetch((req) => {
      const p = new URL(req.url).pathname;
      if (p === '/robots.txt') return new Response(`User-agent: *\nAllow: /\nSitemap: ${WWW}/en-us/sitemap.xml`);
      if (p === '/en-us/sitemap.xml') return later(12_000, () => new Response(urlset(['/en-us/about.html', '/en-us/shipping.html'])));
      return new Response('', { status: 404 });
    });
    const run = discoverPages(`${WWW}/`, { browser: noBrowser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await run;
    expect(r.pages.map((u) => new URL(u).pathname)).toEqual(['/', '/en-us/about.html', '/en-us/shipping.html']);
  });

  it('a slow sitemap index and its children are read, apex start, sitemaps on www', async () => {
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      if (u.host === 'e.org') return new Response('', { status: 301, headers: { location: `${WWW}${u.pathname}` } });
      if (u.pathname === '/robots.txt') return new Response(`Sitemap: ${WWW}/global/sitemap_index.xml`);
      if (u.pathname === '/global/sitemap_index.xml') return later(8_000, () => new Response(`<sitemapindex><sitemap><loc>${WWW}/en-us/sitemap.xml</loc></sitemap></sitemapindex>`));
      if (u.pathname === '/en-us/sitemap.xml') return later(11_000, () => new Response(urlset(['/en-us/home.html'])));
      return new Response('', { status: 404 });
    });
    const run = discoverPages(`${APEX}/`, { browser: noBrowser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await run;
    expect(r.pages).toEqual([`${APEX}/`, `${WWW}/en-us/home.html`]);
  });

  it('the sitemap files are read within a bounded budget: past it, no file is started and a slow one is cut', async () => {
    const roots = Array.from({ length: 5 }, (_, i) => `${WWW}/s${i}.xml`);
    const f = fakeFetch((req) => {
      const p = new URL(req.url).pathname;
      if (p === '/robots.txt') return new Response(roots.map((r) => `Sitemap: ${r}`).join('\n'));
      // Each file answers after 19 s: under the per-file cap, but five of them would take 95 s.
      return later(19_000, () => new Response(urlset([`/page-${p.slice(1, -4)}.html`])));
    });
    const t0 = Date.now();
    const run = discoverPages(`${WWW}/`, { browser: noBrowser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    let done = false;
    void run.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(SITE_TIMING.sitemapBudgetMs + 1_000);
    expect(done).toBe(true);
    const r = await run;
    expect(Date.now() - t0).toBeLessThanOrEqual(SITE_TIMING.sitemapBudgetMs + 1_000);
    // Two files fit in 40 s; the third was cut at the budget's end and the last two never requested.
    expect(r.pages.map((u) => new URL(u).pathname)).toEqual(['/', '/page-s0.html', '/page-s1.html']);
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(['/robots.txt', '/s0.xml', '/s1.xml', '/s2.xml']);
  });

  it('the budget is also bounded by the scan deadline (a quarter of the time left)', async () => {
    const f = fakeFetch((req) => {
      const p = new URL(req.url).pathname;
      if (p === '/robots.txt') return new Response(`Sitemap: ${WWW}/a.xml\nSitemap: ${WWW}/b.xml`);
      return later(6_000, () => new Response(urlset([`/from-${p.slice(1, -4)}.html`])));
    });
    const run = discoverPages(`${WWW}/`, { browser: noBrowser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn, deadline: Date.now() + 40_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await run;
    // 10 s of sitemap time: a.xml (6 s) fits, b.xml is cut at 10 s.
    expect(r.pages.map((u) => new URL(u).pathname)).toEqual(['/', '/from-a.html']);
  });
});

describe('the home page link fallback on a page that never fires load', () => {
  it('reads the links of the page it reached (a country chooser) instead of throwing them away', async () => {
    const chooser = ['/en-us/home.html', '/en-gb/home.html', '/de-de/home.html', '/fr-fr/home.html'].map((p) => `${WWW}${p}`);
    const f = fakeFetch(() => new Response('', { status: 404 }));
    const log: { waitUntil?: string; timeout?: number }[] = [];
    const r = await discoverPages(`${APEX}/`, { browser: neverLoads(chooser, log), maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages[0]).toBe(`${APEX}/`);
    expect(r.pages).toHaveLength(5);
    expect(new Set(r.pages.slice(1))).toEqual(new Set(chooser));
    // It waits for the document, not every asset; the load wait is bounded inside the page.
    expect(log[0]!.waitUntil).toBe('domcontentloaded');
    expect(log[0]!.timeout).toBe(SITE_TIMING.pageTimeoutMs);
  });

  it('a slow start page gets the longer, bounded timeout in the fallback too', async () => {
    const f = fakeFetch(() => new Response('', { status: 404 }));
    const log: { waitUntil?: string; timeout?: number }[] = [];
    const speed = Promise.resolve({ slow: true, challenge: false, firstByteMs: 8200 });
    await discoverPages(`${WWW}/`, { browser: neverLoads([], log), maxPages: 25, userAgent: 'UA', fetchFn: f.fn, startSpeed: speed });
    expect(log[0]!.timeout).toBe(SITE_TIMING.slowPageTimeoutMs);
  });
});

describe('measureStart: the start page\'s first byte, bounded', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('apex 301 (fast) then www answering after 8.2 s: slow, measured without waiting the 8.2 s out', async () => {
    let aborted = false;
    const f = fakeFetch((req) => {
      const u = new URL(req.url);
      if (u.host === 'e.org') return new Response('', { status: 301, headers: { location: `${WWW}/` } });
      return later(8_200, () => new Response('<html>', { status: 302, headers: { location: `${WWW}/global/choose-location.html` } }));
    });
    const wrapped = (async (i: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return f.fn(i, init);
    }) as typeof fetch;
    const t0 = Date.now();
    let at = 0;
    const run = measureStart(`${APEX}/`, { userAgent: 'UA', fetchFn: wrapped });
    void run.then(() => { at = Date.now(); });
    await vi.advanceTimersByTimeAsync(20_000);
    const s = await run;
    expect(s.slow).toBe(true);
    expect(s.challenge).toBe(false);
    expect(s.firstByteMs).toBeGreaterThanOrEqual(SITE_TIMING.slowFirstByteMs);
    expect(aborted).toBe(true);
    expect(at - t0).toBeLessThan(SITE_TIMING.slowFirstByteMs + 1_000);
    expect(f.calls.map((c) => c.url)).toEqual([`${APEX}/`, `${WWW}/`]);
    expect(f.calls.every((c) => c.headers['user-agent'] === 'UA')).toBe(true);
  });

  it('a fast site is not slow; each redirect hop is checked with allowUrl', async () => {
    const f = fakeFetch((req) => (new URL(req.url).host === 'e.org'
      ? new Response('', { status: 301, headers: { location: `${WWW}/` } })
      : later(300, () => new Response('<html>', { status: 200 }))));
    const asked: string[] = [];
    const run = measureStart(`${APEX}/`, { userAgent: 'UA', fetchFn: f.fn, allowUrl: async (u) => { asked.push(u); return true; } });
    await vi.advanceTimersByTimeAsync(5_000);
    const s = await run;
    expect(s).toMatchObject({ slow: false, challenge: false });
    expect(asked).toEqual([`${APEX}/`, `${WWW}/`]);
  });

  it('a hop allowUrl refuses is never requested (unknown, not slow)', async () => {
    const f = fakeFetch(() => new Response('', { status: 301, headers: { location: 'http://10.0.0.1/' } }));
    const run = measureStart(`${APEX}/`, { userAgent: 'UA', fetchFn: f.fn, allowUrl: async (u) => !u.includes('10.0.0.1') });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await run).toMatchObject({ slow: false, challenge: false });
    expect(f.calls).toHaveLength(1);
  });

  it('a known WAF challenge answer is flagged (Cloudflare cf-mitigated, AWS WAF x-amzn-waf-action)', async () => {
    for (const headers of [{ 'cf-mitigated': 'challenge' }, { 'x-amzn-waf-action': 'challenge' }, { 'x-amzn-waf-action': 'captcha' }] as Record<string, string>[]) {
      const f = fakeFetch(() => new Response('<html>', { status: 403, headers }));
      const run = measureStart(`${WWW}/`, { userAgent: 'UA', fetchFn: f.fn });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await run, JSON.stringify(headers)).toMatchObject({ slow: false, challenge: true });
    }
  });
});

describe('the slow-site page timeout and reasons', () => {
  it('normal sites keep 45 s; a slow one gets 75 s, never past the deadline, never under 45 s', () => {
    const now = 1_000_000;
    expect(pageTimeoutFor({ slow: false, challenge: false, firstByteMs: 300 }, SITE_TIMING, undefined, now)).toBe(45_000);
    expect(pageTimeoutFor({ slow: true, challenge: false, firstByteMs: 8200 }, SITE_TIMING, undefined, now)).toBe(75_000);
    expect(pageTimeoutFor({ slow: true, challenge: false, firstByteMs: 8200 }, SITE_TIMING, now + 60_000, now)).toBe(60_000);
    expect(pageTimeoutFor({ slow: true, challenge: false, firstByteMs: 8200 }, SITE_TIMING, now + 10_000, now)).toBe(45_000);
    expect(pageTimeoutFor({ slow: false, challenge: true, firstByteMs: 200 }, SITE_TIMING, undefined, now)).toBe(45_000);
  });

  it('a load time-out on a slow (or challenging) site reads as the site slowing us; other failures stay as they are', () => {
    const slow = { slow: true, challenge: false, firstByteMs: 8200 };
    expect(slowedReason(slow, 'page.goto: Timeout 75000ms exceeded.')).toBe(SLOWED_PAGE);
    expect(slowedReason({ ...slow, slow: false, challenge: true }, 'page.goto: Timeout 45000ms exceeded.')).toBe(SLOWED_PAGE);
    expect(slowedReason({ ...slow, slow: false }, 'page.goto: Timeout 45000ms exceeded.')).toBe('page.goto: Timeout 45000ms exceeded.');
    for (const other of ['HTTP 403', 'net::ERR_BLOCKED_BY_CLIENT', 'Target page, context or browser has been closed (x)', 'net::ERR_CONNECTION_RESET']) {
      expect(slowedReason(slow, other)).toBe(other);
    }
  });

  it('WAF challenge headers', () => {
    expect(isWafChallenge({ 'cf-mitigated': 'challenge' })).toBe(true);
    expect(isWafChallenge({ 'x-amzn-waf-action': 'captcha' })).toBe(true);
    expect(isWafChallenge({ server: 'cloudflare' })).toBe(false);
    expect(BOT_CHALLENGE).toMatch(/bot challenge/);
  });
});
