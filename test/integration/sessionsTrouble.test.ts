// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A scan over several browser sessions when sessions go wrong (review r1 of perf/hosted-throughput):
// every session's browser dying together, with a first replacement that is refused; a session whose
// navigation gate cannot hold its windows; and the number of page loads at once, which must not grow
// with the number of sessions. Fixtures: test/fixtures/timing/ (300 ms per page), test/fixtures/site/.
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_ALLOWED } from '../../src/navigationGate.js';
import { BROWSER_LOST_PAGE, reconnectingBrowser, type BrowserHandle } from '../../src/reconnect.js';
import { NO_DOCUMENT_GATE } from '../../src/probes/runner.js';
import { scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let hosted: Awaited<ReturnType<typeof startFixtureServer>>;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const HOSTED: Partial<ScanOptions> = { allowUrl: async () => true, concurrency: 4, maxPages: 8 };
let hostedClean: SiteReport;
let siteClean: SiteReport;
let chrome: Browser;
const opened: Browser[] = [];

const launch = async (): Promise<Browser> => {
  const b = await chromium.launch();
  opened.push(b);
  return b;
};

/** What the score is made of: the score, each failing rule's and core test criterion's pages. */
const scored = (r: SiteReport) => ({
  status: r.status, score: r.score,
  rules: r.rules.map((x) => [x.id, x.pagesAffected.map((u) => new URL(u).pathname)]),
  tests: (r.testIssues ?? []).map((t) => [t.criterion, t.pagesAffected.map((u) => new URL(u).pathname), t.pointsLost]),
});

beforeAll(async () => {
  hosted = await startFixtureServer('timing', {}, { delayMs: (path) => (path.endsWith('.html') || path.endsWith('/') ? 300 : 0) });
  site = await startFixtureServer();
  chrome = await launch();
  hostedClean = await scanSite(`${hosted.origin}/`, { browser: chrome as unknown as BrowserLike, ...HOSTED });
  siteClean = await scanSite(`${site.origin}/`, { browser: chrome as unknown as BrowserLike, allowUrl: async () => true, maxPages: 10 });
}, 240_000);

afterAll(async () => {
  await Promise.all(opened.map((b) => b.close().catch(() => {})));
  await hosted?.close();
  await site?.close();
});

describe('every session dies together, and the first replacements are refused', () => {
  it('the sessions are not given up while they can still reconnect: the pages are redone and the scan scores the same', async () => {
    expect(hostedClean.status).toBe('scored');
    const firsts = await Promise.all([launch(), launch(), launch()]);
    // All three close together, 150 ms after the 9th context of the scan opened (work in flight in each).
    let contexts = 0;
    for (const b of firsts) {
      const original = b.newContext.bind(b);
      b.newContext = (async (o?: Parameters<Browser['newContext']>[0]) => {
        const ctx = await original(o);
        if (++contexts === 9) setTimeout(() => { for (const x of firsts) void x.close().catch(() => {}); }, 150);
        return ctx;
      }) as Browser['newContext'];
    }
    // Each session's first replacement is refused (429 at the session limit), the next one comes.
    const sessions = firsts.map((b) => {
      let tries = 0;
      const open = async (): Promise<BrowserHandle> => {
        if (++tries === 1) throw new Error('429 too many sessions');
        const n = await launch();
        return { browser: n, close: () => n.close() };
      };
      return reconnectingBrowser({ browser: b, close: () => b.close() }, open, { maxReopens: 2, retryMs: [] });
    });
    try {
      const report = await scanSite(`${hosted.origin}/`, {
        browser: sessions[0]!.browser as unknown as BrowserLike,
        sessions: sessions.slice(1).map((s) => s.browser as unknown as BrowserLike),
        ...HOSTED,
      });
      expect(sessions.map((s) => s.reopened())).toEqual([1, 1, 1]);
      expect(report.pages.filter((p) => p.status !== 'ok').map((p) => p.reason)).toEqual([]);
      expect(report.pages.some((p) => p.reason === BROWSER_LOST_PAGE)).toBe(false);
      expect(scored(report)).toEqual(scored(hostedClean));
    } finally {
      await Promise.all(sessions.map((s) => s.close()));
    }
  }, 300_000);
});

/** The shared Chromium as a session whose browser-level CDP session (the window hold) cannot be opened. */
const unarmed = (): BrowserLike => ({
  newContext: (o) => (chrome as unknown as BrowserLike).newContext(o),
  async newBrowserCDPSession() {
    throw new Error('Target.attachToBrowserTarget: Not allowed');
  },
});
const armed = (): BrowserLike => ({
  newContext: (o) => (chrome as unknown as BrowserLike).newContext(o),
  newBrowserCDPSession: () => (chrome as unknown as BrowserLike).newBrowserCDPSession!(),
});

describe('a session whose navigation gate cannot hold its windows', () => {
  it('takes no work: its pages and core tests run in the other session, with the same report as one healthy session', async () => {
    expect(siteClean.status).toBe('scored');
    expect(siteClean.probes?.runs.length).toBeGreaterThan(0);
    // The tests' own session (the last) is the one that cannot arm.
    const report = await scanSite(`${site.origin}/`, { browser: armed(), sessions: [unarmed()], allowUrl: async () => true, maxPages: 10 });
    expect(report.pages.filter((p) => p.reason === NOT_ALLOWED)).toEqual([]);
    expect((report.probes?.runs ?? []).filter((r) => r.findings.some((f) => f.detail === NO_DOCUMENT_GATE))).toEqual([]);
    expect(scored(report)).toEqual(scored(siteClean));
  }, 240_000);

  it('when no session can arm its gate the scan gives no score, and no page is taken as refused by the site', async () => {
    const report = await scanSite(`${site.origin}/`, { browser: unarmed(), sessions: [unarmed()], allowUrl: async () => true, maxPages: 10 }).catch((err: unknown) => err as Error);
    if (report instanceof Error) {
      // Discovery could not open a page either: the scan fails as lost work, never with a score.
      expect(report.message).toMatch(/closed/);
      return;
    }
    expect(report.status).toBe('incomplete');
    expect(report.score).toBeNull();
    expect(report.pages.filter((p) => p.reason === NOT_ALLOWED)).toEqual([]);
    expect(report.pages.every((p) => p.status === 'failed' && p.reason === BROWSER_LOST_PAGE)).toBe(true);
  }, 240_000);

  it('a real refusal (the address is not allowed) is still NOT_ALLOWED with several sessions', async () => {
    const report = await scanSite(`${site.origin}/`, {
      browser: armed(), sessions: [armed()], maxPages: 10, probes: false,
      allowUrl: async (u) => !u.includes('/bad.html'),
    });
    expect(report.pages.find((p) => p.url.endsWith('/bad.html'))?.reason).toBe(NOT_ALLOWED);
  }, 240_000);
});

describe('page loads at once', () => {
  let server: Server;
  let origin = '';
  let active = 0;
  let max = 0;
  beforeAll(async () => {
    const pages = Array.from({ length: 8 }, (_, i) => `/p${i}.html`);
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('');
      if (path === '/sitemap.xml') {
        const o = `http://${req.headers.host}`;
        return void res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', ...pages].map((p) => `<url><loc>${o}${p}</loc></url>`).join('')}</urlset>`);
      }
      if (path !== '/' && !path.endsWith('.html')) return void res.writeHead(404).end();
      active++;
      max = Math.max(max, active);
      setTimeout(() => {
        active--;
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><title>P</title><main><h1>Page ${path}</h1><p>Text.</p></main></html>`);
      }, 300);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('is the scan concurrency (both widths of each page), however many sessions there are', async () => {
    const run = async (sessions: number) => {
      max = 0;
      const extra = Array.from({ length: sessions - 1 }, () => armed());
      await scanSite(`${origin}/`, { browser: armed(), ...(extra.length ? { sessions: extra } : {}), concurrency: 2, maxPages: 9, probes: false, documents: false });
      return max;
    };
    const one = await run(1);
    const three = await run(3);
    expect(one).toBe(4);
    expect(three).toBe(one);
  }, 240_000);
});
