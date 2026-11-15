// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A site that asks the scanner to slow down (HTTP 429/503, a burst-triggered 403, robots.txt
// Crawl-delay): the scan slows down instead of losing pages. Local fixture servers only.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureEvidence } from '../../src/evidence/capture.js';
import { createPace, PACE_DEFAULTS } from '../../src/pace.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
const servers: { close: () => Promise<void> }[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => s.close()));
});

const PAGES = ['/', '/one.html', '/two.html', '/three.html', '/four.html', '/five.html', '/bad.html'];
const isPage = (path: string) => path === '/' || path.endsWith('.html');
type Answer = { status: number; headers?: Record<string, string> } | undefined;

/**
 * The pace fixture site with a sitemap of its pages. `page(n, path)` decides the answer to the n-th
 * page request (1-based, both widths and every pass counted); undefined serves the page.
 */
async function site(page: (n: number, path: string) => Answer = () => undefined, robots = '', discovery?: (path: string, n: number) => Answer, listed = PAGES) {
  const log: { n: number; path: string; at: number; status: number }[] = [];
  const seen: Record<string, number> = {};
  let n = 0;
  const server = await startFixtureServer('pace', {}, {
    respond: (req: IncomingMessage, path: string) => {
      if (path === '/robots.txt' || path === '/sitemap.xml') {
        // `discovery(path, n)`: the answer to the n-th request for robots.txt or the sitemap.
        const d = discovery?.(path, (seen[path] = (seen[path] ?? 0) + 1));
        if (d) return { status: d.status, ...(d.headers ? { headers: d.headers } : {}), body: 'Slow down' };
      }
      if (path === '/robots.txt') return { status: 200, type: 'text/plain', body: robots };
      if (path === '/sitemap.xml') {
        const origin = `http://${req.headers.host}`;
        return { status: 200, type: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${listed.map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>` };
      }
      // Browser loads only: the start page's first-byte check (siteSpeed.ts) is a plain request, not a load.
      if (!isPage(path) || req.headers['sec-fetch-dest'] !== 'document') return undefined;
      const a = page(++n, path);
      log.push({ n, path, at: Date.now(), status: a?.status ?? 200 });
      return a ? { status: a.status, ...(a.headers ? { headers: a.headers } : {}), body: '<!doctype html><title>Refused</title>' } : undefined;
    },
  });
  servers.push(server);
  return { origin: server.origin, log };
}

const base = { maxPages: 7, probes: false as const, documents: false as const };
const scan = (origin: string, extra: Record<string, unknown> = {}) =>
  scanSite(`${origin}/`, { browser: browser as unknown as BrowserLike, ...base, ...extra });
const paths = (r: SiteReport) => r.pages.map((p) => new URL(p.url).pathname);

let plain: SiteReport;
beforeAll(async () => {
  plain = await scan((await site()).origin);
}, 60_000);

describe('a site that asks us to slow down', () => {

  // A burst of refusals as long as one load's retries: every load gets through, however the burst falls on them.
  // One more and the outcome is a race: the first refusal drops the host to one load at a time, so when a page's
  // other width had not sent its request yet (a busy machine), one load took the whole burst and ran out of
  // tries (the 403 test on the CI runner, 2026-11-09); when both widths were already waiting, they split it.
  // A load that keeps being refused fails, and the test below shows that.
  const BURST = PACE_DEFAULTS.retries;

  it('a 503 burst then OK: every page loads', async () => {
    const s = await site((n) => (n <= BURST ? { status: 503 } : undefined));
    const r = await scan(s.origin, { pace: { backoffMs: 200 } });
    expect(r.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(r.pace!.refusals).toEqual([{ status: 503, count: BURST }]);
  }, 90_000);

  it('a 403 after earlier pages loaded (a burst-triggered block) is retried', async () => {
    const s = await site((n) => (n >= 5 && n < 5 + BURST ? { status: 403 } : undefined));
    const r = await scan(s.origin, { concurrency: 1, pace: { backoffMs: 200 } });
    expect(r.pages.map((p) => [new URL(p.url).pathname, p.status, p.reason])).toEqual(paths(plain).map((p) => [p, 'ok', undefined]));
    expect(r.pace!.refusals).toEqual([{ status: 403, count: BURST }]);
  }, 90_000);

  it('a 403 from the very first request is a real refusal: never retried', async () => {
    const s = await site(() => ({ status: 403 }));
    const r = await scan(s.origin);
    expect(r.status).toBe('incomplete');
    expect(r.pages.every((p) => p.status === 'failed' && p.reason === 'HTTP 403')).toBe(true);
    // One request per page and width: no retry.
    expect(s.log).toHaveLength(PAGES.length * 2);
    expect(r.pace).toBeUndefined();
  }, 90_000);

  it('stops retrying when the scan budget cannot fit the wait', async () => {
    const s = await site(() => ({ status: 429, headers: { 'retry-after': '5' } }));
    const t0 = Date.now();
    const r = await scan(s.origin, { deadline: Date.now() + 2000 });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.status).toBe('incomplete');
    expect(r.pages.every((p) => p.status === 'failed' && /no time left in the scan/.test(p.reason ?? ''))).toBe(true);
    // Never more than one request per page and width.
    expect(s.log.length).toBeLessThanOrEqual(PAGES.length * 2);
    expect(paths(r)).toEqual(paths(plain));
  }, 90_000);

  it('a site that refuses everything: the scan gives up on it in bounded time, without a deadline', async () => {
    const s = await site(() => ({ status: 429, headers: { 'retry-after': '1' } }));
    const t0 = Date.now();
    const r = await scan(s.origin);
    expect(Date.now() - t0).toBeLessThan(45_000);
    expect(r.status).toBe('incomplete');
    expect(r.pages.every((p) => p.status === 'failed' && p.reason === 'The site asked us to slow down (HTTP 429) and kept refusing')).toBe(true);
    expect(r.pace).toMatchObject({ slowedDown: true, failedPages: PAGES.length });
    expect(s.log.length).toBeLessThan(PAGES.length * 2 * 4);
  }, 90_000);
});

describe('a scan over several browser sessions keeps one pace (ScanOptions.sessions)', () => {
  // Two "sessions" over the one local Chromium: what matters is that the site sees one scan.
  const two = () => ({ sessions: [{ newContext: (o: never) => (browser as unknown as BrowserLike).newContext(o) } as BrowserLike] });

  it('Crawl-delay spaces page loads apart across every session, as with one', async () => {
    const s = await site(undefined, 'User-agent: *\nCrawl-delay: 1\n');
    const r = await scan(s.origin, { maxPages: 4, ...two() });
    expect(r.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(s.log).toHaveLength(8);
    const byPath = new Map<string, number[]>();
    for (const l of s.log) byPath.set(l.path, [...(byPath.get(l.path) ?? []), l.at]);
    const firsts = [...byPath.values()].map((x) => Math.min(...x)).sort((a, b) => a - b);
    for (let i = 1; i < firsts.length; i++) expect(firsts[i]! - firsts[i - 1]!).toBeGreaterThanOrEqual(950);
    expect(r.pace).toMatchObject({ slowedDown: false, crawlDelayMs: 1000 });
  }, 90_000);

  it('a 429 slows the whole scan down, whichever session asked: the same pages, refusals counted once', async () => {
    const s = await site((n) => (n % 3 === 0 ? { status: 429, headers: { 'retry-after': '1' } } : undefined));
    const r = await scan(s.origin, two());
    expect(r.pages.filter((p) => p.status !== 'ok')).toEqual([]);
    expect(paths(r)).toEqual(paths(plain));
    expect(r.pace).toMatchObject({ slowedDown: true, failedPages: 0 });
    expect(r.pace!.refusals).toEqual([{ status: 429, count: s.log.filter((l) => l.status === 429).length }]);
  }, 120_000);
});

describe('discovery through the controller', () => {
  const ROBOTS = 'User-agent: *\nDisallow: /five.html\n';
  // /six.html is only in the sitemap (the home page does not link it): a lost sitemap changes the pages.
  const LISTED = [...PAGES, '/six.html'];
  const dscan = (origin: string) => scan(origin, { maxPages: 8 });
  const once = (path: string) => (p: string, n: number): Answer => (p === path && n === 1 ? { status: 429, headers: { 'retry-after': '1' } } : undefined);
  let unthrottled: SiteReport;
  beforeAll(async () => {
    unthrottled = await dscan((await site(undefined, ROBOTS, undefined, LISTED)).origin);
    expect(paths(unthrottled)).toContain('/six.html');
  }, 60_000);

  it('robots.txt 429 then OK: the same selection as an unthrottled run', async () => {
    const s = await site(undefined, ROBOTS, once('/robots.txt'), LISTED);
    const r = await dscan(s.origin);
    expect(paths(r)).toEqual(paths(unthrottled));
    expect(r.skipped.map((x) => new URL(x.url).pathname)).toEqual(['/five.html']);
    expect(r.pace?.refusals).toEqual([{ status: 429, count: 1 }]);
  }, 90_000);

  it('sitemap 429 then OK: the same selection as an unthrottled run', async () => {
    const s = await site(undefined, ROBOTS, once('/sitemap.xml'), LISTED);
    const r = await dscan(s.origin);
    expect(paths(r)).toEqual(paths(unthrottled));
    expect(r.skipped).toEqual(unthrottled.skipped.map((x) => ({ ...x, url: x.url.replace(new URL(unthrottled.site).origin, s.origin) })));
  }, 90_000);

  it('a discovery fetch that keeps refusing behaves as before: no robots rules, no sitemap', async () => {
    const s = await site(undefined, ROBOTS, (p) => (p === '/robots.txt' ? { status: 429, headers: { 'retry-after': '1' } } : undefined), LISTED);
    const r = await dscan(s.origin);
    // robots.txt never read: nothing is disallowed, so /five.html is scanned.
    expect(paths(r)).toContain('/five.html');
    expect(r.skipped).toEqual([]);
  }, 90_000);
});

describe('the evidence picture pass', () => {
  const item = (origin: string) => ({ kind: 'rule' as const, page: `${origin}/bad.html`, rule: 'image-alt', help: 'Images must have alternative text', targets: ['#noalt'] });

  it('retries a picture once after a backoff when its page load was refused', async () => {
    const s = await site((n) => (n === 1 ? { status: 429, headers: { 'retry-after': '1' } } : undefined));
    const [shot] = await captureEvidence(browser as unknown as BrowserLike, [item(s.origin)], { userAgent: 'UA', pace: createPace({ concurrency: 6 }) });
    expect(shot).not.toBeNull();
    expect(s.log.map((l) => l.status)).toEqual([429, 200]);
  }, 60_000);

  it('only once: a second refusal drops the picture', async () => {
    const s = await site((n) => (n <= 2 ? { status: 429, headers: { 'retry-after': '1' } } : undefined));
    const [shot] = await captureEvidence(browser as unknown as BrowserLike, [item(s.origin)], { userAgent: 'UA', pace: createPace({ concurrency: 6 }) });
    expect(shot).toBeNull();
    expect(s.log.map((l) => l.status)).toEqual([429, 429]);
  }, 60_000);

  it('in a scan: the evidence pass shares the controller and still takes the refused picture', async () => {
    // bad.html: the audit's two widths, then the evidence pass's load (refused once).
    let bad = 0;
    const s = await site((_n, path) => (path === '/bad.html' && ++bad === 3 ? { status: 429, headers: { 'retry-after': '1' } } : undefined));
    const sink = async () => {};
    const r = await scan(s.origin, { evidence: { sink, maxImages: 8 } });
    expect(r.evidence?.some((e) => 'rule' in e.for && e.for.rule === 'image-alt')).toBe(true);
    expect(s.log.filter((l) => l.path === '/bad.html').map((l) => l.status)).toEqual([200, 200, 429, 200]);
  }, 90_000);
});
