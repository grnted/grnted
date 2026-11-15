// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// One late retry for the pages the site turned away (Paul, 2026-11-05). Real Chromium: each "session" is
// the browser with its own header, and the server refuses some pages to some sessions (HTTP 406 with no
// body, or 429, as Browser Rendering egress meets them). Once the page pass is done, the pages the site
// refused get one more try in a fresh session, one at a time, after a cool-off, inside the budget; the
// pass stops at its first refusal. A page that loads is checked like any other; one refused again keeps
// its answer. Pages that are the site's own answer (401, 403, 404) are never tried again.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scanSite, type LateRetryOptions } from '../../src/scan.js';
import type { BrowserLike, ScanEvent, SiteReport } from '../../src/types.js';

const html = (title: string, links = '') => `<!doctype html><html lang="en"><head><title>${title}</title></head>
<body><main><h1>${title}</h1><p>Text.</p><img src="/x.png">${links}</main></body></html>`;

let browser: Browser;
let server: Server;
let origin = '';
/** Document requests: `<session> <path>`. */
const hits: string[] = [];
/** The pages the home page links to. */
let paths = ['/a', '/b', '/c'];
/** The answer a session gets for a page: a status to refuse with, or null to serve it. */
let answer: (who: string, path: string) => number | null = () => null;
/** The late session's documents are answered this much later; the most different pages it had in flight at once. */
let lateDelayMs = 0;
let lateInFlight = new Map<string, number>();
let lateMostAtOnce = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/robots.txt' || path === '/sitemap.xml' || path.endsWith('.png')) return void res.writeHead(404).end();
    const who = String(req.headers['x-egress'] ?? 'none');
    hits.push(`${who} ${path}`);
    const refuse = answer(who, path);
    if (refuse !== null) return void res.writeHead(refuse, refuse === 429 ? { 'retry-after': '1' } : {}).end();
    const links = path === '/' ? paths.map((p) => `<a href="${p}">Page ${p.slice(1)}</a>`).join(' ') : '';
    const send = () => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(path === '/' ? 'Home' : `Page ${path.slice(1)}`, links));
    if (who !== 'late' || !lateDelayMs) return void send();
    lateInFlight.set(path, (lateInFlight.get(path) ?? 0) + 1);
    lateMostAtOnce = Math.max(lateMostAtOnce, lateInFlight.size);
    setTimeout(() => {
      const n = lateInFlight.get(path)! - 1;
      if (n) lateInFlight.set(path, n);
      else lateInFlight.delete(path);
      send();
    }, lateDelayMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  hits.length = 0;
  paths = ['/a', '/b', '/c'];
  answer = () => null;
  lateDelayMs = 0;
  lateInFlight = new Map();
  lateMostAtOnce = 0;
});

/** The real browser as one "session": every context sends `tag`. */
const session = (tag: string): BrowserLike => ({
  newContext: (o: Parameters<Browser['newContext']>[0]) => browser.newContext({ ...o, extraHTTPHeaders: { 'x-egress': tag } }),
} as unknown as BrowserLike);

/** What the report is made of: pages in order with their status and reason, the score, each rule's and test's pages. */
const results = (r: SiteReport) => ({
  status: r.status, score: r.score,
  pages: r.pages.map((p) => [new URL(p.url).pathname, p.status, p.reason ?? null]),
  rules: r.rules.map((x) => [x.id, x.pagesAffected.map((u) => new URL(u).pathname)]),
  tests: (r.testIssues ?? []).map((t) => [t.criterion, t.pagesAffected.map((u) => new URL(u).pathname), t.pointsLost]),
});

/** A late retry whose fresh session is `late` (a new address), with what it was asked recorded. */
function late(o: Partial<LateRetryOptions> & { tag?: string; never?: boolean } = {}) {
  const seen = { sessions: 0, released: 0, starts: [] as number[], startedAt: 0 };
  const { tag = 'late', never, ...rest } = o;
  const lateRetry: LateRetryOptions = {
    coolMs: 0,
    session: async () => {
      seen.sessions++;
      if (never) return new Promise<never>(() => {});
      return { browser: session(tag), release: async () => { seen.released++; } };
    },
    onStart: (n) => { seen.starts.push(n); seen.startedAt = Date.now(); },
    ...rest,
  };
  return { lateRetry, seen };
}

// Room for the work after the pages (the report and the core tests, FINISH) and the pass itself.
const budget = () => ({ finishBy: Date.now() + 5 * 60_000 });
const OPTS = { maxPages: 4, concurrency: 2 } as const;
const pageOf = (r: SiteReport, path: string) => r.pages.find((p) => new URL(p.url).pathname === path)!;

describe('one late retry for the pages the site turned away', () => {
  it('runs one page at a time even when the page limit sits at 8', async () => {
    paths = ['/a', '/b', '/c', '/d', '/e', '/f'];
    answer = (who, path) => (path !== '/' && who !== 'late' ? 406 : null);
    lateDelayMs = 300;
    const { lateRetry, seen } = late();
    const report = await scanSite(`${origin}/`, { browser: session('main'), maxPages: 7, concurrency: 8, startConcurrency: 8, ...budget(), lateRetry });
    expect(seen.starts).toEqual([6]);
    expect(report.pages.every((p) => p.status === 'ok')).toBe(true);
    // Each page's two widths together, never two pages.
    expect(lateMostAtOnce).toBe(1);
  }, 240_000);

  it('a page refused (HTTP 406) in the pass loads on the late retry: it is checked like any other page, and the report is the clean scan’s', async () => {
    const clean = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS });
    expect(clean.status).toBe('scored');
    hits.length = 0;
    answer = (who, path) => (path === '/b' && who !== 'late' ? 406 : null);
    const { lateRetry, seen } = late();
    const events: ScanEvent[] = [];
    const report = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, ...budget(), lateRetry, onEvent: (e) => events.push(e) });
    expect(pageOf(report, '/b').status).toBe('ok');
    expect(results(report)).toEqual(results(clean));
    expect(seen.starts).toEqual([1]);
    expect(seen.sessions).toBe(1);
    expect(seen.released).toBe(1);
    // Only the refused page went to the fresh session.
    expect(hits.filter((h) => h.startsWith('late ')).every((h) => h === 'late /b')).toBe(true);
    // The live view: the page failed, then loaded; it ends done once, as loaded (viewport-start reopens it).
    const b = report.pages.findIndex((p) => new URL(p.url).pathname === '/b');
    const done = events.filter((e): e is Extract<ScanEvent, { type: 'page-done' }> => e.type === 'page-done' && e.index === b);
    expect(done.map((e) => e.status)).toEqual(['failed', 'ok']);
    const reopened = events.findIndex((e, i) => e.type === 'viewport-start' && e.index === b && i > events.indexOf(done[0]!));
    expect(reopened).toBeGreaterThan(events.indexOf(done[0]!));
    expect(reopened).toBeLessThan(events.indexOf(done[1]!));
  }, 240_000);

  it('a page refused again keeps its answer, it is tried once, and the pass stops at that refusal (the next refused page is not tried)', async () => {
    answer = (_who, path) => (path === '/b' || path === '/c' ? 406 : null);
    const { lateRetry, seen } = late();
    const events: ScanEvent[] = [];
    const report = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, ...budget(), lateRetry, onEvent: (e) => events.push(e) });
    expect(pageOf(report, '/b')).toMatchObject({ status: 'failed', reason: 'HTTP 406' });
    expect(pageOf(report, '/c')).toMatchObject({ status: 'failed', reason: 'HTTP 406' });
    expect(seen.starts).toEqual([2]);
    expect(seen.sessions).toBe(1);
    expect(seen.released).toBe(1);
    // One try of /b in the fresh session (its widths load together), none of /c, and nothing more.
    const tried = hits.filter((h) => h.startsWith('late '));
    expect(new Set(tried)).toEqual(new Set(['late /b']));
    expect(tried.length).toBeLessThanOrEqual(2);
    // Its last word in the live view is still the refusal.
    const b = report.pages.findIndex((p) => new URL(p.url).pathname === '/b');
    const last = events.filter((e): e is Extract<ScanEvent, { type: 'page-done' }> => e.type === 'page-done' && e.index === b).at(-1)!;
    expect(last).toMatchObject({ status: 'failed', reason: 'HTTP 406' });
  }, 240_000);

  it('a site that rate-limits (429) and lets the page in after the cool-off: the page loads on the retry, after the cool-off', async () => {
    let open = false;
    answer = (_who, path) => (path === '/b' && !open ? 429 : null);
    const { lateRetry, seen } = late({
      coolMs: 1500,
      onStart: (n) => { seen.starts.push(n); seen.startedAt = Date.now(); setTimeout(() => { open = true; }, 1000); },
    });
    const report = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, ...budget(), lateRetry });
    expect(pageOf(report, '/b').status).toBe('ok');
    expect(seen.starts).toEqual([1]);
  }, 240_000);

  it('no time left in the budget: no retry, no session asked for, and the scan ends at once', async () => {
    answer = (_who, path) => (path === '/b' ? 406 : null);
    // The work after the pages needs more than this (FINISH: the report and the core tests).
    const { lateRetry, seen } = late();
    const started = Date.now();
    const report = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, finishBy: Date.now() + 60_000, lateRetry });
    expect(pageOf(report, '/b')).toMatchObject({ status: 'failed', reason: 'HTTP 406' });
    expect(seen).toMatchObject({ sessions: 0, starts: [] });
    expect(hits.some((h) => h.startsWith('late '))).toBe(false);
    expect(Date.now() - started).toBeLessThan(60_000);
    // The host's own limit (a long segment's pages window) past: the same.
    const second = late({ by: Date.now() - 1 });
    const again = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, ...budget(), lateRetry: second.lateRetry });
    expect(pageOf(again, '/b').status).toBe('failed');
    expect(second.seen).toMatchObject({ sessions: 0, starts: [] });
  }, 240_000);

  it('a page’s own answer is never tried again: 401, 403 and 404 pages keep theirs, and no fresh session is asked for', async () => {
    paths = ['/members', '/staff', '/gone'];
    answer = (_who, path) => (path === '/members' ? 401 : path === '/staff' ? 403 : path === '/gone' ? 404 : null);
    const { lateRetry, seen } = late();
    const report = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, ...budget(), lateRetry });
    expect(pageOf(report, '/members')).toMatchObject({ status: 'failed', reason: 'HTTP 401' });
    expect(pageOf(report, '/staff')).toMatchObject({ status: 'failed', reason: expect.stringContaining('HTTP 403') });
    expect(pageOf(report, '/gone')).toMatchObject({ status: 'failed', reason: 'HTTP 404' });
    expect(seen).toMatchObject({ sessions: 0, starts: [] });
    expect(hits.some((h) => h.startsWith('late '))).toBe(false);
  }, 240_000);

  it('a fresh session that never comes: the wait for it ends, the page keeps its answer, and the scan ends', async () => {
    answer = (_who, path) => (path === '/b' ? 406 : null);
    const { lateRetry, seen } = late({ never: true, sessionMs: 500 });
    const started = Date.now();
    const report = await scanSite(`${origin}/`, { browser: session('main'), ...OPTS, ...budget(), lateRetry });
    expect(pageOf(report, '/b')).toMatchObject({ status: 'failed', reason: 'HTTP 406' });
    expect(seen.sessions).toBe(1);
    expect(Date.now() - started).toBeLessThan(90_000);
  }, 240_000);

  it('a fresh session whose pages never open and whose release never answers: the pass ends at its limit, and the scan ends', async () => {
    answer = (_who, path) => (path === '/b' ? 406 : null);
    const seen = { sessions: 0, released: 0 };
    const hung = { newContext: () => new Promise<never>(() => {}) } as unknown as BrowserLike;
    const started = Date.now();
    const report = await scanSite(`${origin}/`, {
      browser: session('main'), ...OPTS, ...budget(),
      lateRetry: {
        coolMs: 0, minPageMs: 0, by: Date.now() + 20_000,
        session: async () => { seen.sessions++; return { browser: hung, release: () => { seen.released++; return new Promise<never>(() => {}); } }; },
      },
    });
    expect(pageOf(report, '/b')).toMatchObject({ status: 'failed', reason: 'HTTP 406' });
    expect(seen).toEqual({ sessions: 1, released: 1 });
    expect(Date.now() - started).toBeLessThan(90_000);
  }, 240_000);
});
