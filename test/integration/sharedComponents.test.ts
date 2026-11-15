// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared components in real Chromium (red-team 2026-11-10, coverage lane; review r1). Our own generic site:
// every page has the same footer, whose "Back to top" link loses its focus indicator (WCAG 2.4.7, failure
// F78). The keyboard test is slow and runs on the template sample, here the home page. Before, the six other
// pages said nothing about 2.4.7. Now:
// - the page with the site's only custom control gets the keyboard test too (something new for it), and
// - the footer link is **measured** on the news pages that carry the same kind of element (a targeted check:
//   that element alone, on that page), and the failure reported there with that page's own selector;
// - never on a look-alike: a page whose footer link keeps its outline (another element kind: no check), or a
//   page that loads one more stylesheet, which restores the outline (checked, and found fine).
// The review's counterexamples (pages that carry the very same kinds of element as a failing page and differ in
// what the tests measure), with round 1's attribution reconstructed beside them, are in
// test/integration/attributionCounterexamples.test.ts.
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kindsCollector, readKinds, KINDS_LIMITS, type PageKinds } from '../../src/collect/kinds.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { buildReport } from '../../src/report/build.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, PageAudit, PageLike, SiteReport } from '../../src/types.js';

const CSS = `body{font:16px/1.5 sans-serif;margin:0;color:#111;background:#fff} a{color:#0b4fb3} main,footer,header{padding:16px}
a:focus,button:focus,[tabindex]:focus{outline:3px solid #0b4fb3;outline-offset:2px}
.site-footer .to-top:focus{outline:none}`;
const head = (title: string, more = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/site.css">${more}</head>`;
const nav = '<header><nav aria-label="Main"><a href="/">Home</a> <a href="/news/budget">Budget</a> <a href="/news/roads">Roads</a> <a href="/news/parks">Parks</a> <a href="/services/permits">Permits</a> <a href="/about">About</a> <a href="/landing">Welcome</a></nav></header>';
const footer = (style = '') => `<footer class="site-footer"><p>City Hall, 1 Main Street</p><a class="to-top" href="#top"${style ? ` style="${style}"` : ''}>Back to top</a></footer>`;
const page = (title: string, body: string, o: { head?: string; footer?: string } = {}) => `${head(title, o.head)}<body id="top">${nav}<main><h1>${title}</h1>${body}</main>${o.footer ?? footer()}</body></html>`;
const story = (n: number) => `<p>${'A paragraph of the story. '.repeat(n)}</p><p><a href="/about">About the city</a></p>`;
const PAGES: Record<string, string> = {
  '/': page('Home', '<p>Welcome to the city website.</p>'),
  '/news/budget': page('Budget', story(3)),
  '/news/roads': page('Roads', story(5)),
  '/news/parks': page('Parks', story(2)),
  '/services/permits': page('Permits', '<p>Choose a date for your inspection.</p><div id="inspection-date" class="date-picker" role="button" tabindex="0">Choose a date</div><script>document.getElementById("inspection-date").addEventListener("click", function () { this.textContent = "Date chosen"; });</script>'),
  // Look-alike 1: the same footer, its link's outline kept by an inline style.
  '/about': page('About', '<p>About the city.</p>', { footer: footer('outline: 3px solid #0b4fb3') }),
  // Look-alike 2: the same footer markup; one more stylesheet restores the outline.
  '/landing': page('Welcome', '<p>Welcome.</p>', { head: '<link rel="stylesheet" href="/landing.css">' }),
};

let browser: Browser;
let server: Server;
let origin: string;
let report: SiteReport;
const audits: PageAudit[] = [];
beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }).end(CSS); return; }
    if (path === '/landing.css') { res.writeHead(200, { 'content-type': 'text/css' }).end('.site-footer .to-top:focus{outline:3px solid #0b4fb3}'); return; }
    const html = PAGES[path];
    if (html === undefined) { res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  report = await scanSite(`${origin}/`, {
    browser: browser as unknown as BrowserLike, maxPages: 25, documents: false, probes: [headingsProbe, keyboardProbe],
    // The public resumable loop hands each page's audit over (as a host that keeps them does).
    pause: () => false, onPageAudited: (p) => { audits.push(p); },
  });
}, 420_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(() => r(null)));
});

const path = (url: string) => new URL(url).pathname;
const runsOf = (probe: string) => (report.probes?.runs ?? []).filter((r) => r.probe === probe);
const failed = (r: { findings: { criterion: string; status: string }[] }, criterion: string) => r.findings.some((f) => f.criterion === criterion && f.status === 'failed');

describe('the switch', () => {
  it('coverage: false: the slow test stays on the sample, nothing is reported where it was not measured, no kinds are read', async () => {
    const seen: PageAudit[] = [];
    const plain = await scanSite(`${origin}/`, {
      browser: browser as unknown as BrowserLike, maxPages: 25, documents: false, probes: [headingsProbe, keyboardProbe], coverage: false,
      pause: () => false, onPageAudited: (p) => { seen.push(p); },
    });
    const keyboard = (plain.probes?.runs ?? []).filter((r) => r.probe === 'keyboard');
    expect(keyboard.map((r) => path(r.page))).toEqual(['/']);
    expect((plain.probes?.runs ?? []).some((r) => r.checked)).toBe(false);
    // The wider coverage is listed, not scored: the site scores the same with it and without.
    expect(plain.score).toBe(report.score);
    expect(plain.testIssues).toEqual(report.testIssues);
    expect(seen.every((p) => p.collected?.[kindsCollector.id] === undefined)).toBe(true);
    // The every-page test still ran everywhere.
    expect((plain.probes?.runs ?? []).filter((r) => r.probe === 'headings')).toHaveLength(7);
  }, 240_000);
});

describe('one page (every single-page test case: the simulation lab, the ACT cases)', () => {
  // Two scans of one page can differ by themselves on a loaded machine (a timing test that ran slow): tried again
  // before it counts, as any timing test is.
  it('the wider coverage changes nothing: the same runs and findings, the same score, with it and without', { retry: 2, timeout: 420_000 }, async () => {
    // What a detail says of the machine, not of the page (the frame rate the flash test filmed at), is not compared.
    // (Batch 15b: the visual lane's flash wording, "at 26 or more a second", is the same measurement.)
    const machine = (detail: string) => detail.replace(/\d+ or more frames per second/, 'N or more frames per second').replace(/at \d+ or more a second/, 'at N or more a second');
    const one = async (coverage: boolean) => {
      const r = await scanSite(`${origin}/services/permits`, { browser: browser as unknown as BrowserLike, maxPages: 1, documents: false, full: true, coverage });
      return {
        score: r.score, pages: r.pages.map((p) => p.url),
        runs: (r.probes?.runs ?? []).map((x) => ({ probe: x.probe, page: x.page, status: x.status, checked: x.checked, criteria: x.criteria, findings: x.findings.map(({ kind: _kind, ...f }) => ({ ...f, detail: machine(f.detail) })) })),
        criteria: (r.criteria ?? []).map((c) => [c.criterion, c.status]),
      };
    };
    const [withIt, without] = [await one(true), await one(false)];
    expect(withIt.pages).toHaveLength(1);
    expect(withIt.runs.some((x) => x.checked)).toBe(false);
    expect(withIt.runs.length).toBeGreaterThan(20);
    expect(withIt).toEqual(without);
  });
});

describe('element kinds (the audit\'s collector)', () => {
  const kindsAt = (p: string) => audits.find((a) => path(a.url) === p)!.collected![kindsCollector.id] as PageKinds;
  it('every page has its kinds; the shared footer link is one kind on every page that carries it as it is', () => {
    expect(audits).toHaveLength(7);
    const common = (a: string, b: string) => kindsAt(a).k.filter((k) => kindsAt(b).k.includes(k)).length;
    // Header links, the footer and its link are shared by the home page and a story; a story's main is not the home page's.
    expect(common('/', '/news/budget')).toBeGreaterThanOrEqual(4);
    // Two stories built from the same parts (3 and 5 sentences repeated) are the same kinds through and through.
    expect(new Set(kindsAt('/news/budget').k)).toEqual(new Set(kindsAt('/news/roads').k));
    // The page whose footer link has an inline style shares the header with the home page, and not that link.
    expect(common('/', '/about')).toBeLessThan(common('/', '/news/budget'));
  });
  it('the environment says which page loads another stylesheet, and features name what is new on a page', () => {
    expect(kindsAt('/landing').env.length).toBe(kindsAt('/').env.length + 1);
    expect(kindsAt('/news/budget').env).toEqual(kindsAt('/').env);
    const fresh = kindsAt('/services/permits').f.focus.filter((k) => !kindsAt('/').f.focus.includes(k));
    expect(fresh).toHaveLength(1);
    expect(kindsAt('/news/roads').f.focus.filter((k) => !kindsAt('/news/budget').f.focus.includes(k))).toEqual([]);
    expect(kindsAt('/services/permits').f.ids.length).toBeGreaterThan(kindsAt('/').f.ids.length);
  });
  it('reading kinds twice gives the same kinds, and leaves the page as it was', async () => {
    const p = await browser.newPage();
    try {
      await p.goto(`${origin}/services/permits`);
      const before = await p.content();
      const a = await p.evaluate(readKinds, { ...KINDS_LIMITS });
      const b = await p.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
      expect(b).toEqual(a);
      expect(await p.content()).toBe(before);
      expect(a.k.length).toBeGreaterThan(5);
      expect(a.cut).toBeUndefined();
      // A page cut at its element limit says so.
      expect((await (p as unknown as PageLike).evaluate(readKinds, { ...KINDS_LIMITS, elements: 3 })).cut).toBe(true);
    } finally {
      await p.close();
    }
  });
});

describe('the slow test goes where a page has something new, and the failing element is measured where else it is', () => {
  it('the keyboard test ran on the home page (the sample) and on the page with the custom control, and on no other', () => {
    const measured = runsOf('keyboard').filter((r) => !r.checked);
    expect(measured.map((r) => path(r.page)).sort()).toEqual(['/', '/services/permits']);
    // It measured the footer link's missing focus indicator on both.
    expect(measured.every((r) => failed(r, '2.4.7'))).toBe(true);
    expect(measured.flatMap((r) => r.findings.filter((f) => f.criterion === '2.4.7' && f.status === 'failed').map((f) => f.target))).toEqual(expect.arrayContaining([expect.stringContaining('footer')]));
  });

  it('the footer link is measured on the three stories that carry it: a failure of 2.4.7 on each, on the page\'s own element', async () => {
    const checked = runsOf('keyboard').filter((r) => r.checked);
    expect(checked.map((r) => path(r.page)).sort()).toEqual(['/news/budget', '/news/parks', '/news/roads']);
    const p = await browser.newPage();
    try {
      for (const r of checked) {
        expect(r.criteria).toEqual(['2.4.7']);
        expect(r.coverage).toBe(true);
        expect(r.checked!.from.map(path).sort()).toEqual(['/', '/services/permits']);
        expect(r.findings).toHaveLength(1);
        const f = r.findings[0]!;
        expect(f.status).toBe('failed');
        // Its own evidence: what the keyboard test says of an element it measured (pixels, the focused outline).
        expect(f.detail).toMatch(/No visible focus indicator on .*pixels? changed|no pixel change/);
        expect(f.detail).not.toMatch(/Not measured/);
        // Its own selector: it names the footer link on that page.
        await p.goto(r.page);
        expect(await p.locator(f.target!).evaluate((el) => el.textContent)).toBe('Back to top');
      }
    } finally {
      await p.close();
    }
  });

  it('look-alikes: the footer link that keeps its outline is another kind (no check), the page with one more stylesheet is checked and fine', () => {
    const pages = new Set(runsOf('keyboard').map((r) => path(r.page)));
    expect(pages.has('/about')).toBe(false);
    expect(pages.has('/landing')).toBe(false);
  });

  it('a page\'s own results show the failure (its report alone fails 2.4.7), and the site\'s share stays over the scored pages', () => {
    const one = (p: string) => {
      const audit = audits.find((a) => path(a.url) === p)!;
      const r = buildReport({ site: report.site, pages: [audit], documents: [], documentChecks: [], media: [], skipped: [], startedAt: report.meta.startedAt, finishedAt: report.meta.finishedAt, userAgent: 'test', probeRuns: (report.probes?.runs ?? []).filter((x) => x.page === audit.url) });
      return r.criteria!.find((c) => c.criterion === '2.4.7')!.status;
    };
    expect(one('/news/roads')).toBe('failed');
    expect(one('/about')).not.toBe('failed');
    expect(one('/landing')).not.toBe('failed');
    const row = report.criteria!.find((c) => c.criterion === '2.4.7')!;
    expect(row.status).toBe('failed');
    // Five pages fail it in the table: two given the whole test, three where the link was measured by itself.
    const method = row.methods.find((m) => m.id === 'keyboard')!;
    expect(method.pages).toBe(5);
    expect(method.note).toContain('full test on 2 pages; on 3 more pages the element that failed was measured on that page by itself');
    const runs = report.probes!.runs.filter((r) => r.probe === 'keyboard');
    expect(runs.filter((r) => r.coverage && !r.checked).map((r) => path(r.page))).toEqual(['/services/permits']);
    expect(runs.filter((r) => !r.coverage).map((r) => path(r.page))).toEqual(['/']);
  });
});
