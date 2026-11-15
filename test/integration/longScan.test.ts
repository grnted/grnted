// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Long scans (more than 50 pages; the hosted 250-page and "Up to 3,500 pages" tiers): the crawl grows
// the page list from the audited pages' links (in page order, so the list does not depend on which
// audit finishes first), and a scan can stop between pages (`pause`, `pagesOnly`: ScanPaused) and go
// on later from the pages it already audited (`resume`), loading none of them again. The finished
// report is the same as one uninterrupted scan's.
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite, ScanPaused, type ScanResume } from '../../src/scan.js';
import type { BrowserLike, PageAudit, ScanEvent, SiteReport } from '../../src/types.js';
import { comparable as sameScan } from '../helpers/comparable.js';
import type { StartSpeed } from '../../src/siteSpeed.js';

let browser: Browser;
let server: Server;
let origin = '';
const loads: string[] = [];
/** Plain requests for the start page: its first-byte check (siteSpeed.ts measureStart). */
const measured: string[] = [];

/** A tree site with no sitemap: / links to /s0../s5, each /sN links to /sN/p0../sN/p11, and some duplicates. */
function page(path: string): string {
  const kids = path === '/'
    ? Array.from({ length: 6 }, (_, i) => `/s${i}`)
    : /^\/s\d$/.test(path) ? Array.from({ length: 12 }, (_, i) => `${path}/p${i}`) : [];
  const dupes = path === '/' ? ['/s0?utm_source=x', '/s0#top', '/s0?sessionid=9', '/calendar?date=2026-11-03', '/calendar?date=2026-11-04'] : [];
  const links = [...kids, ...dupes].map((h) => `<li><a href="${h}">${h}</a></li>`).join('');
  const bad = path.endsWith('p3') ? '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">' : '';
  return `<!doctype html><html lang="en"><head><title>${path}</title></head><body><main><h1>Page ${path}</h1>${bad}<ul>${links}</ul></main></body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/robots.txt' || path.endsWith('.xml')) return void res.writeHead(404).end();
    if (path === '/' || /^\/(s\d(\/p\d+)?|calendar)$/.test(path)) {
      // Browser loads only: the start page's first-byte check (siteSpeed.ts) is a plain request, not a load.
      if (req.headers['sec-fetch-dest'] === 'document') loads.push(req.url ?? path);
      else if (path === '/') measured.push(path);
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(path));
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title><h1>Not found</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
});

const base = () => ({
  browser: browser as unknown as BrowserLike, maxPages: 60, concurrency: 4, documents: false as const, probes: false as const,
  now: () => new Date('2026-11-03T00:00:00.000Z'),
});

/** What the runner keeps between segments: the page list as it grew, and every audit by index. */
function store() {
  const audits = new Map<number, PageAudit>();
  let pages: string[] = [];
  let skipped: { url: string; reason: string }[] = [];
  let documents: string[] = [];
  let startSpeed: StartSpeed | undefined;
  return {
    audits,
    opts: {
      onStartSpeed: (x: StartSpeed) => { startSpeed = x; },
      onEvent: (e: ScanEvent) => {
        if (e.type === 'selected') {
          pages = [...e.pages];
          documents = [...e.documents];
          skipped = e.skipped.map((x) => ({ ...x }));
        }
      },
      onPagesAdded: (all: readonly string[], sk: readonly { url: string; reason: string }[]) => {
        pages = [...all];
        skipped = sk.map((x) => ({ ...x }));
      },
      onPageAudited: (p: PageAudit, i: number) => { audits.set(i, p); },
    },
    resume(): ScanResume {
      return { pages, documents, skipped, audit: (i: number) => audits.get(i), ...(startSpeed ? { startSpeed } : {}) };
    },
  };
}

const comparable = (r: SiteReport) => JSON.stringify(sameScan(r));

describe('long scans', () => {
  let whole: SiteReport;

  it('crawls from the home page to maxPages, one page per de-duplicated address, in page order', async () => {
    loads.length = 0;
    whole = await scanSite(`${origin}/`, base());
    const paths = whole.pages.map((p) => new URL(p.url).pathname + new URL(p.url).search);
    expect(paths).toHaveLength(60);
    // Breadth first in page order: the home page, its sections, then the sections' pages in order.
    expect(paths.slice(0, 8)).toEqual(['/', '/s0', '/s1', '/s2', '/s3', '/s4', '/s5', '/calendar?date=2026-11-03']);
    expect(paths.slice(8, 20)).toEqual(Array.from({ length: 12 }, (_, i) => `/s0/p${i}`));
    // utm, fragment and session duplicates of /s0, and the calendar's other date: never loaded.
    expect(loads.filter((u) => u.startsWith('/s0?'))).toEqual([]);
    // (Each page loads once per width.)
    expect([...new Set(loads.filter((u) => u.startsWith('/calendar')))]).toEqual(['/calendar?date=2026-11-03']);
    expect(whole.status).toBe('scored');
  }, 120_000);

  it('the same list and report however many pages run at once', async () => {
    const one = await scanSite(`${origin}/`, { ...base(), concurrency: 2 });
    expect(comparable(one)).toBe(comparable(whole));
  }, 180_000);

  it('pauses between pages, then resumes without loading a stored page again: the same report', async () => {
    const s = store();
    loads.length = 0;
    const audited = () => s.audits.size;
    const err = await scanSite(`${origin}/`, { ...base(), ...s.opts, pause: () => audited() >= 17 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ScanPaused);
    expect((err as ScanPaused).audited).toBeGreaterThanOrEqual(17);
    expect((err as ScanPaused).audited).toBeLessThan(60);
    const firstLoads = [...loads];
    const stored = new Set([...s.audits.values()].map((a) => new URL(a.url).pathname + new URL(a.url).search));
    loads.length = 0;
    measured.length = 0;
    const resumed = await scanSite(`${origin}/`, { ...base(), ...s.opts, resume: s.resume() });
    // The start page's speed comes with the resume: it is not measured again.
    expect(measured).toEqual([]);
    // robots.txt and sitemaps are not asked again for the page list; no stored page is loaded again.
    for (const u of loads) expect(stored.has(u)).toBe(false);
    // Every page loaded once per width, over both runs together.
    expect(new Set([...firstLoads, ...loads]).size).toBe(60);
    expect(firstLoads.length + loads.length).toBe(120);
    expect(comparable(resumed)).toBe(comparable(whole));
  }, 180_000);

  it('pagesOnly: audits the pages and stops before the work after them; a resume does only that work', async () => {
    const s = store();
    const err = await scanSite(`${origin}/`, { ...base(), ...s.opts, pagesOnly: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ScanPaused);
    expect((err as ScanPaused).audited).toBe(60);
    expect((err as ScanPaused).remaining).toBe(0);
    loads.length = 0;
    const resumed = await scanSite(`${origin}/`, { ...base(), ...s.opts, resume: s.resume() });
    expect(loads).toEqual([]);
    expect(comparable(resumed)).toBe(comparable(whole));
  }, 180_000);

  it('a resume with a pause that is already due stops at once', async () => {
    const s = store();
    await scanSite(`${origin}/`, { ...base(), ...s.opts, pause: () => s.audits.size >= 5 }).catch(() => {});
    const before = s.audits.size;
    const err = await scanSite(`${origin}/`, { ...base(), ...s.opts, resume: s.resume(), pause: () => true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ScanPaused);
    expect(s.audits.size).toBe(before);
  }, 120_000);

  it('with the core tests: a pages-only run then a resume gives the uninterrupted report (tests run on the stored pages)', async () => {
    const withTests = () => ({ ...base(), probes: undefined, maxPages: 55 });
    const full = await scanSite(`${origin}/`, withTests());
    expect(full.probes?.runs.length ?? 0).toBeGreaterThan(0);
    const s = store();
    await scanSite(`${origin}/`, { ...withTests(), ...s.opts, pagesOnly: true }).catch(() => {});
    const resumed = await scanSite(`${origin}/`, { ...withTests(), ...s.opts, resume: s.resume() });
    expect(comparable(resumed)).toBe(comparable(full));
  }, 300_000);
});
