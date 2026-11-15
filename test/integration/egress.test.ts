// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A site that refuses one browser session and lets another in (staging 2026-11-04: an Apptegy school
// site's host answered HTTP 406, with no body, to some Browser Rendering egress addresses and 200 to
// others). Real Chromium: each "session" is the browser with its own header, and the server answers
// 406 with an empty body to the refused one, so the load throws net::ERR_HTTP_RESPONSE_CODE_FAILURE as
// it does on Browser Rendering. The scan must end with every page loaded, the refused session reported,
// and the same results as a scan in the good session alone; a page every session is refused stays failed.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPageLost } from '../../src/reconnect.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';

const page = (title: string, links = '') => `<!doctype html><html lang="en"><head><title>${title}</title></head>
<body><main><h1>${title}</h1><p>Text.</p><img src="/x.png">${links}</main></body></html>`;

let browser: Browser;
let server: Server;
let origin = '';
/** Document requests by path and session header. */
const hits: string[] = [];
/** /members answers 401 to everyone (a members-only page). */
let members = false;
/** The site lists its pages in a sitemap (discovery then loads no page: the audits meet the refusal first). */
let sitemap = false;
/** Staging 5b4986ad: the site lets the first browser load in, then refuses every session (fresh ones too). */
let refuseAfterFirst = false;
let firstServed = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/sitemap.xml' && sitemap) {
      const urls = ['/', '/a', '/b', '/c'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('');
      return void res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }
    if (path === '/robots.txt' || path === '/sitemap.xml') return void res.writeHead(404).end();
    const who = String(req.headers['x-egress'] ?? 'none');
    if (!path.endsWith('.png')) hits.push(`${who} ${path}`);
    // The refused address: every request, no body (Chromium will not show it: ERR_HTTP_RESPONSE_CODE_FAILURE).
    if (who.startsWith('bad')) return void res.writeHead(406).end();
    if (refuseAfterFirst && who !== 'none' && !path.endsWith('.png')) {
      if (firstServed) return void res.writeHead(406).end();
      firstServed = true;
    }
    if (path === '/members') return void res.writeHead(401).end();
    if (path.endsWith('.png')) return void res.writeHead(404).end();
    const more = refuseAfterFirst ? Array.from({ length: 10 }, (_, i) => ` <a href="/p${i}">Page ${i}</a>`).join('') : '';
    const links = `<a href="/a">Page A</a> <a href="/b">Page B</a> <a href="/c">Page C</a>${members ? ' <a href="/members">Members</a>' : ''}${more}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(path === '/' ? 'Home' : `Page ${path.slice(1)}`, path === '/' ? links : ''));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

/** The real browser as one "session": every context sends `tag()` (read at each new context). */
const session = (tag: () => string): BrowserLike => ({
  newContext: (o: Parameters<Browser['newContext']>[0]) => browser.newContext({ ...o, extraHTTPHeaders: { 'x-egress': tag() } }),
} as unknown as BrowserLike);

/** What the report is made of: pages in order with their status, the score, each failing rule's and test's pages. */
const results = (r: SiteReport) => ({
  status: r.status, score: r.score,
  pages: r.pages.map((p) => [new URL(p.url).pathname, p.status, p.reason ?? null]),
  rules: r.rules.map((x) => [x.id, x.pagesAffected.map((u) => new URL(u).pathname)]),
  tests: (r.testIssues ?? []).map((t) => [t.criterion, t.pagesAffected.map((u) => new URL(u).pathname), t.pointsLost]),
});

const OPTS = { maxPages: 4, concurrency: 4 } as const;

describe('a session the site refuses', () => {
  it('A answers 406 to every load, B 200: every page loads, A is reported refused, and the results are those of B alone', async () => {
    members = false;
    const alone = await scanSite(`${origin}/`, { browser: session(() => 'good-b'), ...OPTS });
    expect(alone.status).toBe('scored');
    hits.length = 0;
    const refused: [number, number | undefined][] = [];
    const swaps: number[] = [];
    let a = 'bad-a';
    const done = new Map<number, number>();
    const report = await scanSite(`${origin}/`, {
      browser: session(() => a), sessions: [session(() => 'good-b')], ...OPTS,
      onEvent: (e) => { if (e.type === 'page-done') done.set(e.index, (done.get(e.index) ?? 0) + 1); },
      egress: {
        refused: (i, status) => refused.push([i, status]),
        // A fresh session: a new address the site lets in.
        swap: async (i) => {
          swaps.push(i);
          a = 'good-a2';
          return true;
        },
      },
    });
    expect(report.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(results(report)).toEqual(results(alone));
    expect(refused).toEqual([[0, 406]]);
    expect(swaps).toEqual([0]);
    // Review r1: a page refused and then loaded on the retry says it is done once, as loaded.
    expect([...done.values()]).toEqual(report.pages.map(() => 1));
    expect(done.size).toBe(report.pages.length);
    // The refused address was tried, and turned away.
    expect(hits.some((h) => h.startsWith('bad-a '))).toBe(true);
  }, 240_000);

  it('a refusal with no body (406) in a session that is then swapped is strain that holds: the limit steps down, and neither the swap nor the clean pages after it bring it back up', async () => {
    members = false;
    sitemap = false;
    let a = 'bad-a';
    const changes: { from: number; to: number; why: string; held?: true }[] = [];
    const report = await scanSite(`${origin}/`, {
      browser: session(() => a), sessions: [session(() => 'good-b')], maxPages: 4, concurrency: 8, startConcurrency: 4,
      onConcurrency: (e) => changes.push(e),
      egress: { swap: async () => { a = 'good-a2'; return true; } },
    });
    expect(report.pages.every((p) => p.status === 'ok')).toBe(true);
    const held = changes.findIndex((e) => e.held);
    expect(held).toBeGreaterThan(-1);
    expect(changes[held]).toMatchObject({ why: 'refused', to: 3 });
    // Nothing after it goes up: the swap kept the controller, and a fresh session is not a fresh start.
    expect(changes.slice(held).every((e) => e.to <= e.from)).toBe(true);
    expect(changes.filter((e) => e.held)).toHaveLength(1);
  }, 240_000);

  it('with no swap from the host, the refused session is retried around: every page still loads in B', async () => {
    members = false;
    const refused: number[] = [];
    const report = await scanSite(`${origin}/`, {
      browser: session(() => 'bad-a'), sessions: [session(() => 'good-b')], ...OPTS,
      egress: { refused: (i) => refused.push(i) },
    });
    expect(report.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(report.status).toBe('scored');
    expect(refused).toEqual([0]);
  }, 240_000);

  it('review r1: a page audit refused in A and loaded on its retry in B says page-done once, as loaded', async () => {
    members = false;
    sitemap = true;
    hits.length = 0;
    const done: { index: number; status: string }[] = [];
    try {
      const report = await scanSite(`${origin}/`, {
        browser: session(() => 'bad-a'), sessions: [session(() => 'good-b')], ...OPTS, probes: false,
        onEvent: (e) => { if (e.type === 'page-done') done.push({ index: e.index, status: e.status }); },
      });
      expect(report.pages.every((p) => p.status === 'ok')).toBe(true);
      // A page audit was refused in A (the sitemap gave the list: no discovery load met it first).
      expect(hits.some((h) => h.startsWith('bad-a /'))).toBe(true);
      expect(done.map((d) => d.index).sort()).toEqual(report.pages.map((_, i) => i));
      expect(done.every((d) => d.status === 'ok')).toBe(true);
    } finally {
      sitemap = false;
    }
  }, 240_000);

  it('a page refused in two sessions while the others load stays failed with its status (HTTP 401), tried twice, and nothing loops', async () => {
    members = true;
    hits.length = 0;
    const swaps: number[] = [];
    const report = await scanSite(`${origin}/`, {
      browser: session(() => 'good-a'), sessions: [session(() => 'good-b')], maxPages: 5, concurrency: 4,
      egress: { swap: async (i) => { swaps.push(i); return true; } },
    });
    const m = report.pages.find((p) => new URL(p.url).pathname === '/members')!;
    expect(m.status).toBe('failed');
    // The report keeps the answer as the page's reason (its status is read from it: apps/worker/src/loadFailure.ts).
    expect(m.reason).toBe('HTTP 401');
    expect(report.pages.filter((p) => p.status === 'ok')).toHaveLength(4);
    // Refused in both sessions, then left: one try (both widths, when they ran in the two sessions) or
    // two (the first and one retry in the other session). Never a third (review r2: exactly 2 or 4).
    const tried = hits.filter((h) => h.endsWith(' /members'));
    expect([2, 4]).toContain(tried.length);
    expect(new Set(tried)).toEqual(new Set(['good-a /members', 'good-b /members']));
    expect(swaps).toEqual([]);
  }, 240_000);

  it('a site that refuses every session ends quickly, every page failed with HTTP 406, the swaps bounded by the host', async () => {
    members = false;
    let swaps = 0;
    let n = 0;
    const tags = ['bad-0', 'bad-1'];
    const started = Date.now();
    const report = await scanSite(`${origin}/`, {
      browser: session(() => tags[0]!), sessions: [session(() => tags[1]!)], ...OPTS,
      egress: {
        swap: async (i) => {
          if (swaps >= 3) return false;
          swaps++;
          tags[i] = `bad-new-${++n}`;
          return true;
        },
      },
    });
    expect(report.status).not.toBe('scored');
    expect(report.pages.length).toBeGreaterThan(0);
    expect(report.pages.every((p) => p.status === 'failed' && p.reason === 'HTTP 406')).toBe(true);
    expect(swaps).toBeLessThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 240_000);

  // Staging 5b4986ad (2026-11-05, perrydale): 40 of 41 pages refused within ~11 s; the pool blamed the
  // egress addresses and kept buying launches, and a launch that never came back froze the scan.
  // Both ways (src/replay): an answer from the scan's own copy is not the site letting a session in. Counted as
  // one, a copied 200 ended "the site refuses us everywhere" and every refusal after it bought a swap again.
  it.each(['off', 'record-replay'] as const)('the site lets one page in, then refuses every session: no swap storm, every refused page fails with HTTP 406, and the host hears it once (replay %s)', async (replay) => {
    members = false;
    refuseAfterFirst = true;
    firstServed = false;
    let swaps = 0;
    let n = 0;
    const tags = ['s-0', 's-1', 's-2'];
    const told: string[] = [];
    const started = Date.now();
    try {
      const report = await scanSite(`${origin}/`, {
        browser: session(() => tags[0]!), sessions: [session(() => tags[1]!), session(() => tags[2]!)], maxPages: 14, concurrency: 4, replay,
        egress: {
          swap: async (i) => {
            if (swaps >= 6) return false;
            swaps++;
            tags[i] = `s-new-${++n}`;
            return true;
          },
          siteRefuses: () => told.push('site'),
        },
      });
      expect(report.status).not.toBe('scored');
      const refused = report.pages.filter((p) => p.status === 'failed');
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.every((p) => p.reason === 'HTTP 406')).toBe(true);
      expect(swaps).toBeLessThanOrEqual(2);
      expect(told).toEqual(['site']);
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      refuseAfterFirst = false;
    }
  }, 240_000);

  it('a swap that never comes back: the waits for it end, every page ends failed, the refused ones with HTTP 406, none as a lost browser', async () => {
    members = false;
    const started = Date.now();
    const report = await scanSite(`${origin}/`, {
      browser: session(() => 'bad-0'), sessions: [session(() => 'bad-1')], ...OPTS,
      egress: { swap: () => new Promise<boolean>(() => {}), waitMs: 500 },
    });
    expect(report.status).not.toBe('scored');
    expect(report.pages.length).toBeGreaterThan(0);
    expect(report.pages.every((p) => p.status === 'failed')).toBe(true);
    expect(report.pages.some((p) => p.reason === 'HTTP 406')).toBe(true);
    expect(report.pages.some((p) => isPageLost(p.reason))).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 90_000);
});
