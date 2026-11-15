// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 17 (structure lane): the title after a client-side page change (2.4.2), found on the pages the template
// sample leaves out. The deep route-titles test follows a page's own links and comes back; it ran on the template
// sample only, and the views of a single-page app all look like one template, so it ran on the start page alone
// and a view whose title does not come back with it was never looked at. Now a run that saw the site change pages
// without loading them sends the test, whole, to the scan's other pages (`SITE_SENDS`, optional work after every
// required test): each page is then judged by following a link ON IT, never from another page's run.
// Real Chromium, real scans. Both sites are written for this test.
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeTitlesProbe } from '../../src/probes/routeTitles.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';

const VIEWS: Record<string, [string, string]> = {
  '': ['Welcome to the town', 'Home | Town'],
  rates: ['Rates and fees', 'Rates | Town'],
  board: ['Board of wardens', 'Board | Town'],
  parks: ['Parks and trails', 'Parks | Town'],
  contact: ['Contact the office', 'Contact | Town'],
  permits: ['Building permits', 'Permits | Town'],
};
const NAV = `<nav aria-label="Main">${Object.keys(VIEWS).map((k) => `<a href="/${k}">${VIEWS[k]![1].split(' | ')[0]}</a>`).join(' ')}</nav>`;
const STYLE = '<style>body{font:16px/1.5 sans-serif;margin:24px;color:#111;background:#fff} nav a{margin-right:16px;color:#0b4fb3}</style>';
/** One small app: every view is the same document; the title is set on a page change except for `stale` views. */
const app = (stale: readonly string[]) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Town</title>${STYLE}</head>
<body>${NAV}<main id="view"></main>
<script>
  var VIEWS = ${JSON.stringify(VIEWS)}; var STALE = ${JSON.stringify(stale)};
  function show(first) {
    var key = location.pathname.split('/')[1] || '';
    var v = VIEWS[key] || ['Not found', 'Not found | Town'];
    document.getElementById('view').innerHTML = '<h1>' + v[0] + '</h1><p>This page is about ' + v[0].toLowerCase() + ' and how to reach the office that looks after it.</p>';
    if (first || STALE.indexOf(key) < 0) document.title = v[1];
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a || a.origin !== location.origin) return;
    e.preventDefault(); history.pushState({}, '', a.href); show(false);
  });
  addEventListener('popstate', function () { show(false); });
  show(true);
</script></body></html>`;
/** The same pages as documents of their own: each link loads a page (a script counts clicks, as analytics do). */
const plain = (key: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${VIEWS[key]![1]}</title>${STYLE}</head>
<body>${NAV}<main><h1>${VIEWS[key]![0]}</h1><p>This page is about ${VIEWS[key]![0].toLowerCase()} and how to reach the office that looks after it.</p></main>
<script>var clicks = 0; document.addEventListener('click', function () { clicks++; });</script></body></html>`;

let browser: Browser;
const servers: Server[] = [];
const serve = async (page: (key: string) => string | undefined): Promise<string> => {
  const server = createServer((req, res) => {
    const key = new URL(req.url ?? '/', 'http://x').pathname.split('/')[1] ?? '';
    const html = page(key);
    if (html === undefined) { res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const scan = (origin: string): Promise<SiteReport> => scanSite(`${origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 25, documents: false, full: true, probes: [routeTitlesProbe] });
const path = (url: string) => new URL(url).pathname;
const routes = (report: SiteReport) => (report.probes?.runs ?? []).filter((r) => r.probe === 'route-titles');

let spa: SiteReport;
let mpa: SiteReport;
beforeAll(async () => {
  browser = await chromium.launch();
  const stale = ['rates', 'contact'];
  spa = await scan(await serve((key) => (key in VIEWS ? app(stale) : undefined)));
  mpa = await scan(await serve((key) => (key in VIEWS ? plain(key) : undefined)));
}, 600_000);
afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
});

describe('2.4.2: route-titles goes to every page of a site that changes pages without loading them', () => {
  it('runs on the views outside the template sample, and fails exactly the two whose title does not come back', () => {
    const runs = routes(spa);
    // Every view was scanned and got the test (the sample alone is the start page: the views share one template).
    expect(runs.map((r) => path(r.page)).sort()).toEqual(['/', '/board', '/contact', '/parks', '/permits', '/rates']);
    const failed = runs.filter((r) => r.findings.some((f) => f.criterion === '2.4.2' && f.status === 'failed'));
    expect(failed.map((r) => path(r.page)).sort()).toEqual(['/contact', '/rates']);
    // The finding is what was measured on the page itself: its own title, and the one that stayed.
    const rates = failed.find((r) => path(r.page) === '/rates')!.findings[0]!;
    expect(rates.detail).toBe('The site changes pages without loading them and gives them titles of their own, but this page\'s title does not come back with it: after following “Home” (/) and going back, the title is still “Home | Town”; loaded by its address, this page\'s title is “Rates | Town”.');
    // The views whose title follows the page change are clean, each by its own run.
    for (const p of ['/', '/board', '/parks', '/permits']) expect(runs.find((r) => path(r.page) === p)!.findings.map((f) => f.status), p).toEqual(['no_failures_found']);
    // The criterion's row: failed on the two pages.
    const row = spa.criteria?.find((c) => c.criterion === '2.4.2');
    expect(row?.status).toBe('failed');
  });

  it('look-alike: a site that loads its pages gets the test on its template sample only, and nothing is sent', () => {
    const runs = routes(mpa);
    expect(runs.map((r) => path(r.page))).toEqual(['/']);
    expect(runs[0]!.findings.map((f) => [f.status, f.detail])).toEqual([['not_applicable', 'the links followed on this page load a new page, which has the title it loads with']]);
    expect(mpa.pages?.filter((p) => p.status === 'ok').length).toBe(6);
  });
});
