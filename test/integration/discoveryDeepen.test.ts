// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page discovery on a scan of up to 50 pages, in real Chromium (red-team 2026-11-10, coverage lane): a site
// with no XML sitemap whose home page links to a few of its pages. The rest are linked from a section page,
// from an HTML site map page, from an image map and from navigation written as script. One document is shown
// only in a frame: it is part of the page that embeds it, never a page of its own. The fixture is our own
// generic site, served from memory.
//
// Review r1 (2026-11-10): addresses that look like actions are never requested (finding 3); reading on is
// bounded end to end, and a page's links are capped where they are collected (finding 8); a directory and
// its index file are one page only when the server redirects one to the other (finding 9).
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverPages } from '../../src/crawl.js';
import { collectLinks, MAX_PAGE_LINKS } from '../../src/pageLinks.js';
import { scanSite } from '../../src/scan.js';
import { ACTION_SKIP_REASON } from '../../src/url.js';
import type { BrowserLike } from '../../src/types.js';

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const PAGES: Record<string, string> = {
  '/': page('Home', '<p><a href="/index.html">Home</a> <a href="/services/">Services</a> <a href="/services/index.html">All services</a> <a href="/about.html">About</a> <a href="/site-map.html">Site map</a></p>'),
  // Navigation written as script: a card with data-href, a row with an onclick, a jump menu. And look-alikes
  // that are not addresses of pages: a button that only toggles, a select of plain values, a data-href to a file.
  '/services/': page('Services', `<p><a href="/services/permits.html">Permits</a></p><p><iframe src="/embeds/request-form.html" title="Request form"></iframe></p>
<div class="card" data-href="/parks/trails.html" onclick="location.href=this.dataset.href" role="link" tabindex="0">Trails</div>
<table><tr onclick="window.location='/parks/pool.html'"><td>Pool</td></tr></table>
<label>Departments <select onchange="if (this.value) location = this.value"><option value="">Choose</option><option value="/departments/water.html">Water</option></select></label>
<button onclick="document.body.classList.toggle('dark')">Dark mode</button>
<label>Sort <select onchange="sort(this.value)"><option value="/not-a-page-a">A to Z</option></select></label>
<label>Size <select onchange="location.hash = this.value"><option value="large">Large</option></select></label>
<div data-href="/files/map.png">Map</div>
<p><a href="/logout">Sign out</a> <a href="/events/cancelled-meetings-2025.html">Cancelled meetings</a></p>
<div class="card" data-href="/unsubscribe?token=abc" role="link" tabindex="0">Stop the newsletter</div>
<table><tr onclick="location.href='/delete?id=7'"><td>Remove this row</td></tr></table>`),
  '/events/cancelled-meetings-2025.html': page('Cancelled meetings', '<p>Meetings that were cancelled.</p>'),
  // Never served to the scanner: each would lead on to a page only it links to.
  '/logout': page('Signed out', '<p><a href="/behind-logout.html">On</a></p>'),
  '/delete': page('Deleted', '<p><a href="/behind-delete.html">On</a></p>'),
  '/unsubscribe': page('Unsubscribed', '<p><a href="/behind-unsubscribe.html">On</a></p>'),
  '/services/permits.html': page('Permits', '<p>Permits.</p>'),
  '/about.html': page('About', '<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="Offices" usemap="#m"><map name="m"><area shape="rect" coords="0,0,1,1" href="/about/offices.html" alt="Offices"></map></p>'),
  '/about/offices.html': page('Offices', '<p>Offices.</p>'),
  '/site-map.html': page('Site map', '<ul><li><a href="/">Home</a></li><li><a href="/news/budget.html">Budget</a></li><li><a href="/news/roads.html">Roads</a></li><li><a href="/board/meetings.html">Meetings</a></li></ul>'),
  '/news/budget.html': page('Budget', '<p>Budget.</p>'),
  '/news/roads.html': page('Roads', '<p>Roads.</p>'),
  '/parks/trails.html': page('Trails', '<p>Trails.</p>'),
  '/parks/pool.html': page('Pool', '<p>Pool.</p>'),
  '/departments/water.html': page('Water', '<p>Water.</p>'),
  '/board/meetings.html': page('Meetings', '<p>Meetings.</p>'),
  '/embeds/request-form.html': page('Request form', '<form><label>Name <input name="n" autocomplete="name"></label></form>'),
};

let browser: Browser;
let server: Server;
let origin: string;
const requests: string[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    requests.push(path);
    // The server itself says a directory's index file is the directory: it redirects.
    if (path === '/index.html' || path === '/services/index.html') { res.writeHead(301, { location: path.replace('index.html', '') }).end(); return; }
    // Two sites in one: /apart/ and /apart/index.html are different pages, and say so by answering both.
    if (path === '/apart/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Apart: the list', '<p>The list.</p>')); return; }
    if (path === '/apart/' || path === '/apart') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Apart', '<p><a href="/apart/index.html">The list</a></p>')); return; }
    if (path === '/hub.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Hub', '<p><a href="/stuck.html">Stuck</a> <a href="/after-stuck.html">After</a> <a href="/apart/">Apart</a> <a href="/apart/index.html">Apart list</a></p>')); return; }
    if (path === '/after-stuck.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('After', '<p><a href="/found-after-stuck.html">On</a></p>')); return; }
    if (path === '/flood-hub.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Flood hub', '<p><a href="/flood.html">Flood</a></p>')); return; }
    // Loads, then blocks its own thread for good.
    if (path === '/stuck.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Stuck', '<p><a href="/behind-stuck.html">On</a></p><script>setTimeout(function () { for (;;) {} }, 30);</script>')); return; }
    // A site map with 300,000 links.
    if (path === '/flood.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Flood', `<ul>${Array.from({ length: 300_000 }, (_, i) => `<li><a href="/t/i${i}.html">${i}</a></li>`).join('')}</ul>`)); return; }
    const html = PAGES[path === '/services' ? '/services/' : path];
    if (html === undefined) { res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(() => r(null)));
});

describe('short scans: discovery past the home page', () => {
  it('finds the pages behind a section page, the site map page, an image map and script-written navigation, each once', async () => {
    const report = await scanSite(`${origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 25, probes: false, documents: false });
    const paths = report.pages.map((p) => new URL(p.url).pathname);
    // The home page's second address and the section's index file are not pages of their own.
    expect(paths.filter((p) => p === '/' || p === '/index.html')).toEqual(['/']);
    expect(paths.filter((p) => p.startsWith('/services') && !p.endsWith('permits.html'))).toHaveLength(1);
    expect(new Set(paths)).toEqual(new Set([
      '/', '/services', '/about.html', '/site-map.html', '/services/permits.html', '/about/offices.html',
      '/news/budget.html', '/news/roads.html', '/board/meetings.html',
      // Reached only through script-written navigation on the services page (never "/not-a-page-a", "/large" or the picture).
      '/parks/trails.html', '/parks/pool.html', '/departments/water.html',
      // Look-alike of an action: a page whose address only holds the word.
      '/events/cancelled-meetings-2025.html',
    ]));
    expect(report.pages.every((p) => p.status === 'ok')).toBe(true);
    // Finding 3: the three addresses that look like actions were never asked for, by discovery or by any test,
    // from a link, a data-href or an onclick alike; and nothing only they lead to was found.
    expect(requests.filter((r) => /^\/(logout|delete|unsubscribe|behind-)/.test(r))).toEqual([]);
    expect(report.skipped.filter((x) => x.reason === ACTION_SKIP_REASON).map((x) => `${new URL(x.url).pathname}${new URL(x.url).search}`)).toEqual(['/delete?id=7', '/logout', '/unsubscribe?token=abc']);
    // Look-alike: the form the services page shows in a frame is tested with that page (axe reads frames), not as a page.
    expect(paths).not.toContain('/embeds/request-form.html');
  }, 120_000);

  it('look-alike: with room for the home page links only, nothing more is read in discovery', async () => {
    requests.length = 0;
    const report = await scanSite(`${origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 4, probes: false, documents: false });
    expect(report.pages).toHaveLength(4);
    // The home page: its first-byte measurement, once for its links, then its audit at the two widths.
    // No other page is loaded more than its audit needs.
    const loads = (path: string) => requests.filter((r) => r === path).length;
    // (And once more: the server is asked whether /index.html is the home page, and redirects there.)
    expect(loads('/')).toBe(5);
    expect(loads('/site-map.html')).toBe(2);
  }, 120_000);
});

describe('review r1: bounds, and what the server says about an index file', () => {
  const found = (r: { pages: string[] }) => r.pages.map((u) => new URL(u).pathname);

  it('a page that blocks its thread after loading gives no links and does not hold the reading: the pages after it are still read', async () => {
    const t0 = Date.now();
    const r = await discoverPages(`${origin}/hub.html`, { browser: browser as unknown as BrowserLike, maxPages: 40, userAgent: 'grnted-test', deadline: Date.now() + 120_000 });
    // One call into the stuck page is waited for a few seconds at most, whatever is left of the reading's time.
    expect(Date.now() - t0).toBeLessThan(20_000);
    // The stuck page is still a page of the scan (its audit has its own time box); what only it links to is not found.
    expect(found(r)).toContain('/stuck.html');
    expect(found(r)).not.toContain('/behind-stuck.html');
    // The page read after it gave its links.
    expect(found(r)).toContain('/found-after-stuck.html');
  }, 120_000);

  it('a site map with 300,000 links gives its first 5,000, and the scan fills from them', async () => {
    const r = await discoverPages(`${origin}/flood-hub.html`, { browser: browser as unknown as BrowserLike, maxPages: 40, userAgent: 'grnted-test', deadline: Date.now() + 240_000 });
    expect(r.pages).toHaveLength(40);
    const p = await browser.newPage();
    try {
      await p.goto(`${origin}/flood.html`);
      const t1 = Date.now();
      const links = await p.evaluate(collectLinks, undefined);
      expect(links).toHaveLength(MAX_PAGE_LINKS);
      expect(links[0]).toBe(`${origin}/t/i0.html`);
      expect(Date.now() - t1).toBeLessThan(2000);
    } finally {
      await p.close();
    }
  }, 180_000);

  it('a directory and its index file that both answer are two pages; the redirected ones (above) were one', async () => {
    const r = await discoverPages(`${origin}/hub.html`, { browser: browser as unknown as BrowserLike, maxPages: 5, userAgent: 'grnted-test', deadline: Date.now() + 20_000 });
    expect(found(r)).toEqual(expect.arrayContaining(['/apart', '/apart/index.html']));
  }, 60_000);
});
