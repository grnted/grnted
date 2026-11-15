// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page discovery from sitemaps (scoring v3): the 2,000-URL cap stays, but the section spread comes from
// the whole sitemap, so a big first sitemap file cannot hide the sections listed after it.
import { describe, expect, it } from 'vitest';
import { DEEPEN, MAX_SITEMAP_URLS, discoverPages, sitemapUrls } from '../../src/crawl.js';
import { parseRobots } from '../../src/robots.js';
import { spreadOrder } from '../../src/select.js';
import type { BrowserLike } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const ORIGIN = 'https://www.e.org';
const urlset = (paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`).join('')}</urlset>`;
const noBrowser = { newContext: () => { throw new Error('the homepage is not opened when the sitemap has pages'); } } as unknown as BrowserLike;

describe('discoverPages (sitemap spread)', () => {
  // 2,500 news stories in the first file, then the other sections in the last one.
  const news = Array.from({ length: 2500 }, (_, i) => `/news/2026/story-${String(i).padStart(4, '0')}`);
  const files: Record<string, string> = {
    '/robots.txt': `User-agent: *\nDisallow: /private\nSitemap: ${ORIGIN}/sitemap.xml`,
    '/sitemap.xml': `<sitemapindex><sitemap><loc>${ORIGIN}/news.xml</loc></sitemap><sitemap><loc>${ORIGIN}/pages.xml</loc></sitemap></sitemapindex>`,
    '/news.xml': urlset(news),
    '/pages.xml': urlset(['/policies/board/policy-101', '/calendar/2026/10/31/event', '/resources/handbook', '/about', '/logo.png', '/private/x'])
      .replace('</urlset>', '<url><loc>https://other.org/elsewhere</loc></url></urlset>'),
  };
  const fetch = () => fakeFetch((req) => {
    const body = files[new URL(req.url).pathname];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
  });

  it('reads every sitemap file and spreads the selection over all their sections', async () => {
    const f = fetch();
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 8, userAgent: 'UA', fetchFn: f.fn });
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(['/robots.txt', '/sitemap.xml', '/news.xml', '/pages.xml']);
    expect(r.pages.map((u) => new URL(u).pathname)).toEqual([
      '/', '/about', '/resources/handbook', '/news/2026/story-0000', '/policies/board/policy-101', '/calendar/2026/10/31/event', '/news/2026/story-0001', '/news/2026/story-0002',
    ]);
    expect(r.skipped).toEqual([{ url: `${ORIGIN}/private/x`, reason: 'Blocked by robots.txt' }]);
  });

  it('keeps the 2,000-URL cap, chosen by section spread over the whole sitemap', async () => {
    expect(MAX_SITEMAP_URLS).toBe(2000);
    const f = fetch();
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 50, userAgent: 'UA', fetchFn: f.fn });
    expect(r.pages).toHaveLength(50);
    // Equal to the spread order of the full list, capped.
    const all = [...news, '/policies/board/policy-101', '/calendar/2026/10/31/event', '/resources/handbook', '/about'].map((p) => `${ORIGIN}${p}`);
    const expected = spreadOrder(all).slice(0, MAX_SITEMAP_URLS);
    expect(r.pages.slice(1)).toEqual(expected.slice(0, 49));
  });

  it('is the same selection when the files are listed in the other order', async () => {
    const a = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 20, userAgent: 'UA', fetchFn: fetch().fn });
    const swapped = files['/sitemap.xml']!;
    files['/sitemap.xml'] = `<sitemapindex><sitemap><loc>${ORIGIN}/pages.xml</loc></sitemap><sitemap><loc>${ORIGIN}/news.xml</loc></sitemap></sitemapindex>`;
    try {
      const b = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 20, userAgent: 'UA', fetchFn: fetch().fn });
      expect(b.pages).toEqual(a.pages);
    } finally {
      files['/sitemap.xml'] = swapped;
    }
  });
});

describe('sitemapUrls (reduced file by file)', () => {
  it('keeps exactly the first 2,000 of the whole list in section-spread order, whatever the files hold', async () => {
    // A seeded generator: 3 files of 1,500 addresses over 40 sections and depths 1–5, with repeats.
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const files: Record<string, string[]> = {};
    for (const f of ['a', 'b', 'c']) {
      files[f] = Array.from({ length: 1500 }, () => {
        const depth = 1 + rand(5);
        return `/s${rand(40)}${Array.from({ length: depth - 1 }, () => `/p${rand(30)}`).join('')}`;
      });
    }
    const body: Record<string, string> = {
      '/sitemap.xml': `<sitemapindex>${Object.keys(files).map((f) => `<sitemap><loc>${ORIGIN}/${f}.xml</loc></sitemap>`).join('')}</sitemapindex>`,
      ...Object.fromEntries(Object.entries(files).map(([f, paths]) => [`/${f}.xml`, urlset(paths)])),
    };
    const f = fakeFetch((req) => new Response(body[new URL(req.url).pathname] ?? '', { status: body[new URL(req.url).pathname] ? 200 : 404 }));
    const keep = (u: string) => u;
    const got = await sitemapUrls(ORIGIN, parseRobots('', 'grnted'), { browser: noBrowser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn }, keep);
    const all = [...new Set(Object.values(files).flat())].map((p) => `${ORIGIN}${p}`);
    expect(all.length).toBeGreaterThan(MAX_SITEMAP_URLS);
    expect(got).toEqual(spreadOrder(all).slice(0, MAX_SITEMAP_URLS));
  });
});

// The CPU-spin guard (staging 2026-11-03, trademe.co.nz): a robots.txt shaped like theirs (7,840 rules,
// one `Disallow: /a/` + 140 `*` + `k97.cc`) over 2,000 /a/… sitemap addresses: discovery answers in
// well under a second, so a Durable Object running it never comes near its CPU limit.
describe('discoverPages with a hostile robots.txt', () => {
  it('a trademe-shaped robots.txt and 2,000 /a/… addresses: done in under a second', async () => {
    const rules = Array.from({ length: 7840 }, (_, i) => `Disallow: /a/section-${i}/*/*/*listing`).join('\n');
    const paths = Array.from({ length: 2000 }, (_, i) => `/a/property/residential/sale/region-${i % 40}/district/${'x'.repeat(i % 60)}/listing/${i}`);
    const files: Record<string, string> = {
      '/robots.txt': `User-agent: *\nDisallow: /a/${'*'.repeat(140)}k97.cc\n${rules}\nSitemap: ${ORIGIN}/sitemap.xml`,
      '/sitemap.xml': urlset(paths),
    };
    const f = fakeFetch((req) => {
      const body = files[new URL(req.url).pathname];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
    });
    const t = performance.now();
    const r = await discoverPages(`${ORIGIN}/`, { browser: noBrowser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.pages).toHaveLength(25);
  });
});

// Red-team 2026-11-10 (coverage lane): a scan of up to 50 pages took the home page's links and stopped, so
// a site with no XML sitemap whose home page links to half its pages was scanned at half its size.
// Fixtures here are our own: a generic site whose deeper pages are linked from section pages and from an
// HTML site map page only.
describe('discoverPages (short scans read on past the home page)', () => {
  const SITE = 'https://www.e.org';
  /** A browser whose pages answer with the links given for their path; every load is logged. */
  function linkBrowser(links: Record<string, string[]>, loads: string[] = [], status: Record<string, number> = {}): BrowserLike {
    return {
      newContext: async () => {
        let at = '';
        return {
          newPage: async () => ({
            goto: async (url: string) => {
              at = new URL(url).pathname;
              loads.push(at);
              return { status: () => status[at] ?? 200, url: () => url, headers: () => ({ 'content-type': 'text/html' }) };
            },
            evaluate: async (_fn: unknown, arg: unknown) => (typeof arg === 'number' ? undefined : (links[at] ?? []).map((p) => (p.startsWith('http') ? p : `${SITE}${p}`))),
            close: async () => {},
          }),
          close: async () => {},
        };
      },
    } as unknown as BrowserLike;
  }
  const none = () => fakeFetch(() => new Response('', { status: 404 }));
  const paths = (r: { pages: string[] }) => r.pages.map((u) => new URL(u).pathname);

  it('a home page that links to 4 of 9 pages: the section pages are read for the rest', async () => {
    const loads: string[] = [];
    const browser = linkBrowser({
      '/': ['/about', '/news', '/services', '/contact'],
      '/about': ['/', '/about/staff', '/about/history'],
      '/news': ['/', '/news/budget'],
      '/services': ['/', '/services/permits', '/services/water'],
      '/contact': ['/'],
    }, loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn });
    expect(new Set(paths(r))).toEqual(new Set(['/', '/about', '/news', '/services', '/contact', '/about/staff', '/about/history', '/news/budget', '/services/permits', '/services/water']));
    expect(paths(r)[0]).toBe('/');
    // Each page is read once.
    expect(new Set(loads).size).toBe(loads.length);
  });

  it('a site map page is read first, and one read is enough when it fills the scan', async () => {
    const loads: string[] = [];
    const deep = Array.from({ length: 12 }, (_, i) => `/topics/item-${i}`);
    const browser = linkBrowser({ '/': ['/about', '/news', '/site-map', '/contact'], '/site-map': ['/', '/about', '/news', '/contact', ...deep], '/about': ['/about/never-read'] }, loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 10, userAgent: 'UA', fetchFn: none().fn });
    expect(loads).toEqual(['/', '/site-map']);
    expect(r.pages).toHaveLength(10);
    // Every top-level section first, as for any short scan.
    expect(paths(r).slice(0, 6)).toEqual(['/', '/about', '/contact', '/news', '/site-map', '/topics/item-0']);
  });

  it('look-alike: a home page that already fills the scan is the only page read', async () => {
    const loads: string[] = [];
    const browser = linkBrowser({ '/': Array.from({ length: 30 }, (_, i) => `/p${i}`) }, loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn });
    expect(loads).toEqual(['/']);
    expect(r.pages).toHaveLength(25);
  });

  it('a small site that is all on its home page costs at most two more reads', async () => {
    const loads: string[] = [];
    const all = ['/a', '/b', '/c', '/d', '/e'];
    const browser = linkBrowser(Object.fromEntries(['/', ...all].map((p) => [p, ['/', ...all]])), loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn });
    expect(paths(r)).toEqual(['/', ...all]);
    expect(loads).toHaveLength(1 + DEEPEN.dryStop);
  });

  it('never reads more than its bound of pages, however many pages still lead on', async () => {
    const loads: string[] = [];
    // Each page links to one more: a chain longer than the bound.
    const chain = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i === 0 ? '/' : `/s${i}`, [`/s${i + 1}`]]));
    const r = await discoverPages(`${SITE}/`, { browser: linkBrowser(chain, loads), maxPages: 50, userAgent: 'UA', fetchFn: none().fn });
    expect(loads).toHaveLength(1 + DEEPEN.maxLoads);
    expect(r.pages).toHaveLength(2 + DEEPEN.maxLoads);
  });

  it('a sitemap with a few pages does not end discovery: the home page links are added', async () => {
    const loads: string[] = [];
    const f = fakeFetch((req) => (new URL(req.url).pathname === '/sitemap.xml'
      ? new Response(`<urlset><url><loc>${SITE}/about</loc></url><url><loc>${SITE}/news</loc></url></urlset>`)
      : new Response('', { status: 404 })));
    const browser = linkBrowser({ '/': ['/about', '/news', '/services', '/contact'], '/about': [], '/news': [] }, loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    expect(new Set(paths(r))).toEqual(new Set(['/', '/about', '/news', '/services', '/contact']));
    expect(loads[0]).toBe('/');
  });

  it('pages robots.txt blocks are neither read nor selected, and a page that refuses the read gives no links', async () => {
    const loads: string[] = [];
    const f = fakeFetch((req) => (new URL(req.url).pathname === '/robots.txt' ? new Response('User-agent: *\nDisallow: /private') : new Response('', { status: 404 })));
    const browser = linkBrowser({ '/': ['/private/hub', '/open', '/gate'], '/private/hub': ['/secret'], '/open': ['/open/more'], '/gate': ['/behind-gate'] }, loads, { '/gate': 403 });
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: f.fn });
    expect(loads).not.toContain('/private/hub');
    expect(new Set(paths(r))).toEqual(new Set(['/', '/open', '/gate', '/open/more']));
    expect(r.skipped).toEqual([{ url: `${SITE}/private/hub`, reason: 'Blocked by robots.txt' }]);
  });

  it('a monitoring scan that carries pages forward takes its previous pages and reads no page for links', async () => {
    const loads: string[] = [];
    const browser = linkBrowser({ '/': ['/about', '/news'], '/about': ['/about/staff'] }, loads);
    const r = await discoverPages(`${SITE}/`, { browser, maxPages: 25, userAgent: 'UA', fetchFn: none().fn, known: [`${SITE}/`, `${SITE}/about`, `${SITE}/about/staff`, `${SITE}/index.html`] });
    // The home page's links (no sitemap), and nothing more.
    expect(loads).toEqual(['/']);
    // (/index.html stays a page of its own: this server does not say it is the home page.)
    expect(new Set(paths(r))).toEqual(new Set(['/', '/about', '/news', '/about/staff', '/index.html']));
  });

  it('long scans are unchanged: no page is opened in discovery (the crawl reads the audited pages)', async () => {
    const loads: string[] = [];
    const r = await discoverPages(`${SITE}/`, { browser: linkBrowser({ '/': ['/a'] }, loads), maxPages: 60, userAgent: 'UA', fetchFn: none().fn });
    expect(loads).toEqual([]);
    expect(paths(r)).toEqual(['/']);
  });

  it('a start page that turned the scan away is still the scan\'s only page', async () => {
    const r = await discoverPages(`${SITE}/`, { browser: linkBrowser({}, [], { '/': 403 }), maxPages: 25, userAgent: 'UA', fetchFn: none().fn });
    expect(paths(r)).toEqual(['/']);
    expect(r.refusedStart).toEqual({ status: 403, reason: 'HTTP 403' });
  });
});

// A directory and its index file: test/unit/discoveryRules.test.ts (one page only when the server shows it).
