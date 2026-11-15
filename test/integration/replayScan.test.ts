// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Record once, test on the copy, through scanSite (src/scan.ts): the same report with replay on and
// off, on the same site, while the site is asked for each page about once instead of once per load.
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPace } from '../../src/pace.js';
import { scanSite } from '../../src/scan.js';
import type { ReplayStats } from '../../src/replay/index.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { comparable } from '../helpers/comparable.js';

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/site.css"><script src="/site.js" defer></script></head><body><header><a href="/">Home</a> <a href="/about">About</a> <a href="/contact/">Contact</a></header>
<main><h1>${title}</h1>${body}</main></body></html>`;
const PAGES: Record<string, string> = {
  '/': page('Home', '<p>Welcome.</p><img src="/logo.png"><p style="color:#aaa;background:#fff">Faint text</p>'),
  '/about': page('About', '<p>About us.</p><button id="b"></button><input type="text">'),
  '/contact/': page('Contact', '<form><label for="n">Name</label><input id="n" name="n" autocomplete="name"><button>Send</button></form>'),
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let browser: Browser;
let server: Server;
let origin: string;
let documents: Record<string, number> = {};
/** When each page's document was asked for (epoch ms), by path. */
let asked: Record<string, number[]> = {};
let requests = 0;
let crawlDelay = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    requests++;
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(crawlDelay ? `User-agent: *\nCrawl-delay: ${crawlDelay}\n` : 'User-agent: *\nAllow: /\n');
    if (path === '/contact') return void res.writeHead(301, { location: '/contact/' }).end();
    if (PAGES[path]) {
      documents[path] = (documents[path] ?? 0) + 1;
      (asked[path] ??= []).push(Date.now());
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGES[path]);
    }
    if (path === '/site.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end('body{font:16px sans-serif} a{color:#00e}');
    if (path === '/site.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end('document.documentElement.dataset.ready="1"');
    if (path === '/logo.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

/**
 * The report as two scans of the same site must agree on it (test/helpers/comparable.ts: no clock, no
 * port), without the two measured counts some notes carry, which differ between any two runs: the
 * frames per second a test filmed at, and how many timers a page had armed when a test looked.
 */
const measured = (s: string) => s.replace(/\b\d+ or more frames per second/g, 'N or more frames per second').replace(/\bat \d+ or more a second/g, 'at N or more a second').replace(/\(\d+ timers? of/g, '(N timers of');
const same = (r: SiteReport) => comparable(JSON.parse(JSON.stringify(r), (_k, v: unknown) => (typeof v === 'string' ? measured(v) : v)));

async function scan(replay: 'off' | 'record-replay', full = true) {
  documents = {};
  asked = {};
  requests = 0;
  let stats: ReplayStats | undefined;
  const t0 = Date.now();
  const report = await scanSite(`${origin}/`, {
    browser: browser as unknown as BrowserLike, maxPages: 5, concurrency: 2, full, replay, documents: false,
    onReplay: (s) => { stats = s; },
  });
  return { report, documents: { ...documents }, asked: { ...asked }, requests, stats, ms: Date.now() - t0 };
}

describe('scanSite with record and replay', () => {
  it('gives the same report as a live scan, and asks the site for each page about once', async () => {
    const live = await scan('off');
    const replay = await scan('record-replay');
    expect(live.stats).toBeUndefined();
    console.log(`live: ${live.ms} ms, ${live.requests} requests, documents ${JSON.stringify(live.documents)}; replay: ${replay.ms} ms, ${replay.requests} requests, documents ${JSON.stringify(replay.documents)}, ${JSON.stringify(replay.stats)}`);
    expect(replay.report.pages.map((p) => [p.url, p.status])).toEqual(live.report.pages.map((p) => [p.url, p.status]));
    expect(live.report.pages.filter((p) => p.status === 'ok').length).toBe(3);
    expect(same(replay.report)).toEqual(same(live.report));
    // Live, every page is loaded again for each width and each group of tests. With the copy, once.
    const most = (d: Record<string, number>) => Math.max(...Object.values(d));
    expect(most(live.documents)).toBeGreaterThan(4);
    expect(most(replay.documents)).toBeLessThanOrEqual(2);
    expect(replay.requests).toBeLessThan(live.requests / 3);
    expect(replay.stats).toMatchObject({ volatile: 0 });
    expect(replay.stats!.replayedDocuments).toBeGreaterThan(10);
  }, 600_000);

  it('a site with a Crawl-delay: everything that reaches it is still a delay apart, and it is reached once per page', async () => {
    crawlDelay = 1;
    try {
      const live = await scan('off', false);
      const replay = await scan('record-replay', false);
      console.log(`Crawl-delay 1 s, 3 pages, core tests: live ${live.ms} ms, documents ${JSON.stringify(live.documents)}; replay ${replay.ms} ms, documents ${JSON.stringify(replay.documents)}`);
      expect(replay.report.pages.map((p) => [p.url, p.status])).toEqual(live.report.pages.map((p) => [p.url, p.status]));
      expect(replay.report.pages.every((p) => p.status === 'ok')).toBe(true);
      expect(same(replay.report)).toEqual(same(live.report));
      // Both say the site asked for a pause between pages.
      expect(replay.report.pace).toMatchObject({ slowedDown: false, crawlDelayMs: 1000 });
      // With the copy the site is asked for each page once (the start page once more when discovery reads it) ...
      expect(Math.max(...Object.values(replay.documents))).toBeLessThanOrEqual(2);
      expect(Object.values(replay.documents).reduce((a, b) => a + b, 0)).toBeLessThan(Object.values(live.documents).reduce((a, b) => a + b, 0) / 2);
      // ... and whatever reached it came at the site's pace: page loads at least the delay apart (a page's
      // two widths count as one load, so two requests of one page may come together).
      const starts = (log: Record<string, number[]>) => Object.values(log).flat().sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1]! > 500);
      for (const run of [live, replay]) {
        const at = starts(run.asked);
        for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(950);
      }
      // The loads the copy answers wait for no gap: the scan is shorter by about a second for each of them.
      expect(replay.ms).toBeLessThan(live.ms - 3000);
    } finally {
      crawlDelay = 0;
    }
  }, 600_000);

  it('a load the copy answers waits for no turn: the Crawl-delay spaces only what goes to the site', async () => {
    let t = 0;
    const waits: number[] = [];
    const ready = new Set<string>();
    const pace = createPace({ concurrency: 2, now: () => t, sleep: async (ms) => { t += ms; }, replayed: (url) => ready.has(url), onTiming: (e) => { if (e.kind === 'load') waits.push(e.waitMs); } });
    pace.setCrawlDelay('site.example', 5);
    const load = (url: string, status = 200, files?: { url: string; status: number }[]) => pace.load(url, async () => { t += 100; return status; }, (s) => ({ status: s, loadMs: 100, ...(files ? { files } : {}) }));
    await load('https://site.example/a');
    await load('https://site.example/b');
    expect(waits).toEqual([0, 4900]);
    // From the copy: no gap, any number of them, and the next live load's gap still counts from the last live one.
    ready.add('https://site.example/a');
    for (let n = 0; n < 5; n++) await load('https://site.example/a');
    expect(waits.slice(2)).toEqual([0, 0, 0, 0, 0]);
    await load('https://site.example/c');
    expect(waits[7]).toBe(5000 - 100 - 500);
    // The copy did not answer all of it and the site refused a file the page needs: handled as a live load's.
    const refused = await pace.load('https://site.example/a', async () => { t += 100; return 200; }, () => ({ status: 200, files: [{ url: 'https://site.example/app.css', status: 429 }] }), { retries: 0 });
    expect(refused.refused).toMatch(/slow down/);
    expect(pace.summary()).toMatchObject({ slowedDown: true });
    pace.stop();
  });

  it('an answer from the copy is no success of its host: a slowed-down site climbs back only on its own answers', async () => {
    let t = 0;
    const pace = createPace({ concurrency: 4, recoverAfter: 3, now: () => t, sleep: async (ms) => { t += ms; } });
    // Loads that take a turn (the page is not one the copy answers whole): only the answer says where it came from.
    const load = (status: number, copied = false) => pace.load('https://site.example/a', async () => { t += 10; return status; }, (st) => ({ status: st, ...(copied ? { copied: true } : { loadMs: 10 }) }), { retries: 0 });
    await load(200);
    expect((await load(429)).refused).toMatch(/slow down/);
    expect(pace.limit('site.example')).toBe(1);
    // Nine answers from the copy: the site said nothing, so it stays at one load at a time.
    for (let n = 0; n < 9; n++) expect(await load(200, true)).toEqual({ value: 200 });
    expect(pace.limit('site.example')).toBe(1);
    // Three answers of its own: one more load at a time.
    for (let n = 0; n < 3; n++) await load(200);
    expect(pace.limit('site.example')).toBe(2);
    pace.stop();
  });
});
