// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Long scans (hosted 250-page and "Up to 3,500 pages" tiers): discovery from every sitemap (indexes
// nested), de-duplication of addresses that differ only by tracking, session or calendar parameters,
// and a per-shape cap against calendar traps. Only for scans of more than WIDE_MIN_PAGES pages: the
// discovery of 25-page scans is unchanged.
import { describe, expect, it } from 'vitest';
import { discoverPages } from '../../src/crawl.js';
import { MAX_PAGES_LIMIT, MAX_WIDE_DOCUMENTS, MAX_WIDE_SITEMAP_FILES, PER_SHAPE_MAX, WIDE_MIN_PAGES, isWide, pathShape, wideKey, wideNormalize } from '../../src/wide.js';
import type { BrowserLike } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const ORIGIN = 'https://www.e.org';
const urlset = (paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('')}</urlset>`;
const index = (files: string[]) => `<sitemapindex>${files.map((f) => `<sitemap><loc>${ORIGIN}${f}</loc></sitemap>`).join('')}</sitemapindex>`;
const noBrowser = { newContext: () => { throw new Error('discovery opens no page in a long scan: the crawl reads the audited pages\' links'); } } as unknown as BrowserLike;

describe('wide (long scan) helpers', () => {
  it('long scans are those past 50 pages (the old engine limit), up to 20,000', () => {
    expect(WIDE_MIN_PAGES).toBe(50);
    expect(isWide(25)).toBe(false);
    expect(isWide(50)).toBe(false);
    expect(isWide(250)).toBe(true);
    expect(MAX_PAGES_LIMIT).toBe(20_000);
  });

  it('one key for addresses that differ only by tracking, session or calendar parameters, or a fragment', () => {
    const base = wideKey('https://www.e.org/news/story');
    for (const v of [
      'https://e.org/news/story/', 'https://www.e.org/news/story#top', 'https://www.e.org/news/story?utm_source=x&fbclid=1',
      'https://www.e.org/news/story?sessionid=abc', 'https://www.e.org/news/story;jsessionid=ABC123', 'https://www.e.org/news/story?PHPSESSID=1&sid=2',
      'https://www.e.org/news/story?date=2026-11-03', 'https://www.e.org/news/story?month=11&year=2026&view=week', 'https://www.e.org/news/story?cal_date=1&start_date=2&end_date=3',
    ]) expect(wideKey(v), v).toBe(base);
    // Real content parameters stay.
    expect(wideKey('https://www.e.org/news/story?id=7')).not.toBe(base);
    expect(wideKey('https://www.e.org/news?page=2')).not.toBe(wideKey('https://www.e.org/news?page=3'));
  });

  it('normalises the address it loads: session ids and fragments go, the rest stays', () => {
    expect(wideNormalize('https://www.e.org/a;jsessionid=XYZ?sid=1&id=7#x')).toBe('https://www.e.org/a?id=7');
    expect(wideNormalize('https://www.e.org/cal?date=2026-11-03')).toBe('https://www.e.org/cal?date=2026-11-03');
    expect(wideNormalize('mailto:a@b.org')).toBeNull();
  });

  it('a path shape: dated segments and page numbers read as one template; ids and slugs do not', () => {
    expect(pathShape('https://www.e.org/node/123')).not.toBe(pathShape('https://www.e.org/node/124'));
    expect(pathShape('https://www.e.org/article?id=1')).not.toBe(pathShape('https://www.e.org/article?id=2'));
    expect(pathShape('https://www.e.org/calendar/2026/11/03')).toBe(pathShape('https://www.e.org/calendar/2027/01/15'));
    expect(pathShape('https://www.e.org/events/2026-11-03/board')).toBe(pathShape('https://www.e.org/events/2026-12-01/board'));
    expect(pathShape('https://www.e.org/news?page=2')).toBe(pathShape('https://www.e.org/news?page=40'));
    expect(pathShape('https://www.e.org/news/a')).not.toBe(pathShape('https://www.e.org/news/b'));
    expect(PER_SHAPE_MAX).toBe(50);
  });
});

describe('discoverPages: long scans', () => {
  it('reads every sitemap, nested indexes included, and selects up to maxPages by section spread', async () => {
    const files: Record<string, string> = {
      '/robots.txt': `Sitemap: ${ORIGIN}/a.xml\nSitemap: ${ORIGIN}/b.xml`,
      '/a.xml': index(['/a1.xml', '/a2.xml']),
      '/a1.xml': index(['/deep.xml']),
      '/deep.xml': urlset(Array.from({ length: 80 }, (_, i) => `/deep/p${i}`)),
      '/a2.xml': urlset(Array.from({ length: 80 }, (_, i) => `/news/s${i}`)),
      '/b.xml': urlset(Array.from({ length: 80 }, (_, i) => `/staff/m${i}`)),
    };
    const f = fakeFetch((req) => {
      const body = files[new URL(req.url).pathname];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    });
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 200, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages).toHaveLength(200);
    expect(f.calls.map((c) => new URL(c.url).pathname).sort()).toEqual(['/a.xml', '/a1.xml', '/a2.xml', '/b.xml', '/deep.xml', '/robots.txt']);
    for (const s of ['/deep/', '/news/', '/staff/']) expect(r.pages.filter((p) => p.includes(s)).length).toBeGreaterThan(60);
  });

  it('de-duplicates by the long-scan key and caps each path shape (calendar traps)', async () => {
    const paths = [
      '/about', '/about?utm_source=x', '/about?sessionid=1', '/about?date=2026-11-03',
      ...Array.from({ length: 200 }, (_, i) => `/calendar/2026/${String(1 + Math.floor(i / 28)).padStart(2, '0')}/${String(1 + (i % 28)).padStart(2, '0')}`),
    ];
    const f = fakeFetch((req) => new URL(req.url).pathname === '/sitemap.xml' ? new Response(urlset(paths)) : new Response('', { status: 404 }));
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 500, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages.filter((p) => p.includes('/about'))).toEqual([`${ORIGIN}/about`]);
    expect(r.pages.filter((p) => p.includes('/calendar/'))).toHaveLength(PER_SHAPE_MAX);
    // One record per shape, with the count (the report's skipped list stays short).
    expect(r.skipped.filter((s) => s.reason.startsWith('More than'))).toEqual([
      { url: `${ORIGIN}/calendar/2026/01/01`, reason: `More than ${PER_SHAPE_MAX} pages of the same kind as this one (a calendar or a long list): the first ${PER_SHAPE_MAX} were checked, the rest left out` },
    ]);
  });

  it('with no sitemap, starts from the home page alone (the crawl grows the list from the audited pages)', async () => {
    const f = fakeFetch(() => new Response('', { status: 404 }));
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 500, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages).toEqual([`${ORIGIN}/`]);
  });

  it('stops reading sitemap files at the file cap', async () => {
    const many = Array.from({ length: MAX_WIDE_SITEMAP_FILES + 50 }, (_, i) => `/s${i}.xml`);
    const f = fakeFetch((req) => {
      const p = new URL(req.url).pathname;
      if (p === '/sitemap.xml') return new Response(index(many));
      if (p.startsWith('/s')) return new Response(urlset([`/x${p.slice(2, -4)}`]));
      return new Response('', { status: 404 });
    });
    await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5000, userAgent: 'UA', fetchFn: f.fn });
    expect(f.calls.length).toBeLessThanOrEqual(MAX_WIDE_SITEMAP_FILES + 2);
  });

  it('a 15,000-address calendar sitemap at the 5,000 cap: one skip record per shape, documents capped (every record stays small)', async () => {
    const days = Array.from({ length: 15_000 }, (_, i) => {
      const d = new Date(Date.UTC(1990, 0, 1) + i * 86_400_000);
      return `/events/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    });
    const docs = Array.from({ length: 5000 }, (_, i) => `/files/report-${i}.pdf`);
    const f = fakeFetch((req) => new URL(req.url).pathname === '/sitemap.xml' ? new Response(urlset([...days, ...docs])) : new Response('', { status: 404 }));
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 5000, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages).toHaveLength(1 + PER_SHAPE_MAX);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toContain('the rest left out');
    expect(r.documents.length).toBeLessThanOrEqual(MAX_WIDE_DOCUMENTS);
    expect(JSON.stringify(r.skipped).length).toBeLessThan(2000);
  });
});
