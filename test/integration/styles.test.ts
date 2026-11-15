// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A page whose stylesheet the site refused (HTTP 429/503, or a burst-triggered 403) renders unstyled:
// it must never be scored, pictured or tested as if that were the real page. The refusal is charged to
// the stylesheet's own host, the page is loaded again within its retries, and a page still missing a
// stylesheet it needs is left out of the score with its reason. A sheet that only declares fonts, one
// no link would apply, a frame from another site, and a stylesheet that is really broken (404) do not
// drop a page. Real Chromium; one local server answers every host (host-resolver rules map them).
//
// The GAPS shape (a school district site): the page's own app CSS, the vendor's theme CSS on another
// registrable domain, and Google Fonts.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTLE_MS } from '../../src/audit.js';
import { STYLE_SETTLE_MS } from '../../src/styles.js';
import { captureEvidence, captureEvidenceResults } from '../../src/evidence/capture.js';
import { createPace } from '../../src/pace.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ScanEvent, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

const VENDOR = 'vendor.example';
const FONTS = 'fonts.googleapis.com';
const THIRD = 'third.example';

let browser: Browser;
const servers: { close: () => Promise<void> }[] = [];
const B = () => browser as unknown as BrowserLike;

beforeAll(async () => {
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${VENDOR} 127.0.0.1, MAP ${FONTS} 127.0.0.1, MAP ${THIRD} 127.0.0.1`] });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => s.close()));
});

/** `body`/`type`: what is sent (default 'Slow down' as text/plain); `drop`: cut the connection with no answer. */
type Answer = { status: number; headers?: Record<string, string>; body?: string; type?: string; drop?: boolean } | undefined;
const SLOW = (s = '1'): Answer => ({ status: 429, headers: { 'retry-after': s } });
const LIGHT = 'color:#c8c8c8';

/** A page of the site: the GAPS stylesheets, text readable only with each one, plus `extra` head and body. */
const page = (port: number, title: string, head = '', body = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="http://${VENDOR}:${port}/theme-assets/theme.css">
<link rel="stylesheet" href="http://${FONTS}:${port}/css2?family=DM+Sans&amp;display=swap">
<link rel="stylesheet" href="/assets/fonts.css">${head}</head>
<body><main><h1>${title}</h1>
<p class="ink" style="${LIGHT}">Readable only with the site’s own stylesheet.</p>
<p class="theme" style="${LIGHT}">Readable only with the theme stylesheet.</p>${body}
<p>Pages: <a href="/">Home</a>, <a href="/one.html">One</a>, <a href="/two.html">Two</a> and <a href="/plain.html">Plain</a>.</p>
</main></body></html>`;

const CSS: Record<string, string> = {
  '127.0.0.1/assets/app.css': '.ink { color: #111 !important; }',
  [`${VENDOR}/theme-assets/theme.css`]: '.theme { color: #111 !important; }',
  [`${FONTS}/css2`]: "@font-face { font-family: 'DM Sans'; src: local('Arial'); }",
  '127.0.0.1/assets/fonts.css': "@font-face { font-family: 'Self Sans'; src: local('Arial'); }",
  '127.0.0.1/print.css': '.ink { color: #ccc; }',
  '127.0.0.1/two.css': '.extra { margin: 0; }',
  '127.0.0.1/frame.css': '.fink { color: #111 !important; }',
  [`${THIRD}/widget.css`]: '.wink { color: #111 !important; }',
  '127.0.0.1/late.css': '.late { color: #111 !important; }',
  '127.0.0.1/slow.css': '.late { color: #111 !important; }',
  '127.0.0.1/slower.css': '.late { color: #111 !important; }',
  '127.0.0.1/mobile.css': '.ink { color: #111 !important; }',
};

const lateScript = (ms: number, href = '/late.css') => `<p class="late" style="${LIGHT}">Readable only with the late stylesheet.</p>
<script>setTimeout(function () { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${href}'; document.head.appendChild(l); }, ${ms});</script>`;
/**
 * How long /slow.css takes to answer: longer than the try waits for its stylesheets (the settle window
 * plus STYLE_SETTLE_MS), so its answer comes after the try was judged, while axe or the pictures run.
 */
const SLOW_SHEET_MS = 5300;
/** /slower.css answers after the picture time box of the test that uses it (and 200: nothing refused). */
const SLOWER_SHEET_MS = 9000;

function pages(port: number): Record<string, string> {
  return {
    '/': page(port, 'Styles home'),
    '/one.html': page(port, 'Styles one', '<link rel="stylesheet" media="print" href="/print.css">'),
    '/two.html': page(port, 'Styles two', '<link rel="stylesheet" href="/two.css">'),
    '/plain.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Styles plain</title></head><body><main><h1>Styles plain</h1><p>No stylesheet at all.</p></main></body></html>',
    '/framed.html': page(port, 'Styles framed', '', `<iframe title="Same site" src="/frame.html"></iframe><iframe title="Widget" src="http://${THIRD}:${port}/widget.html"></iframe>`),
    '/frame.html': `<!doctype html><html lang="en"><head><title>Frame</title><link rel="stylesheet" href="/frame.css"></head><body><p class="fink" style="${LIGHT}">Framed text.</p></body></html>`,
    '/widget.html': `<!doctype html><html lang="en"><head><title>Widget</title><link rel="stylesheet" href="/widget.css"></head><body><p class="wink" style="${LIGHT}">Widget text.</p></body></html>`,
    '/early-late.html': page(port, 'Styles early late', '', lateScript(300)),
    '/late.html': page(port, 'Styles late', '', lateScript(300, '/slow.css')),
    '/slower.html': page(port, 'Styles slower', '', lateScript(300, '/slower.css')),
    // The phone-only sheet is only ever asked for at phone width: the desktop width never sees it.
    '/narrow.html': page(port, 'Styles narrow', `<script>if (innerWidth < 600) document.write('<link rel="stylesheet" href="/mobile.css">');</script>`),
  };
}

interface Log { key: string; status: number; at: number }

/**
 * The fixture site, every host on one server. `css(key, n)` answers the n-th request for a stylesheet
 * (`key` = host + path, counted per key; undefined serves it). `listed`: the sitemap's pages.
 */
async function site(css: (key: string, n: number) => Answer = () => undefined, listed = ['/', '/one.html', '/two.html', '/plain.html']) {
  const log: Log[] = [];
  const seen: Record<string, number> = {};
  let port = 0;
  const server = await startFixtureServer('styles', {}, {
    delayMs: (path) => (path === '/slow.css' ? SLOW_SHEET_MS : path === '/slower.css' ? SLOWER_SHEET_MS : 0),
    respond: (req: IncomingMessage, path: string) => {
      const host = (req.headers.host ?? '').split(':')[0]!;
      const key = `${host}${path}`;
      if (path === '/robots.txt') return { status: 200, type: 'text/plain', body: '' };
      if (path === '/sitemap.xml') {
        return { status: 200, type: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${listed.map((p) => `<url><loc>http://127.0.0.1:${port}${p}</loc></url>`).join('')}</urlset>` };
      }
      // axe reads other sites' stylesheets again with a fetch of its own (css-orientation-lock): served,
      // and never counted as the page's stylesheet load.
      if (key in CSS && !String(req.headers.accept ?? '').startsWith('text/css')) {
        log.push({ key: `${key} (fetch)`, status: 200, at: Date.now() });
        return { status: 200, type: 'text/css', body: CSS[key]! };
      }
      if (key in CSS) {
        const a = css(key, (seen[key] = (seen[key] ?? 0) + 1));
        log.push({ key, status: a?.status ?? 200, at: Date.now() });
        return a ? { status: a.status, type: a.type ?? 'text/plain', ...(a.headers ? { headers: a.headers } : {}), body: a.body ?? 'Slow down', ...(a.drop ? { drop: true } : {}) } : { status: 200, type: 'text/css', body: CSS[key]! };
      }
      const html = pages(port)[path];
      if (html !== undefined) {
        // Browser loads only: the start page's first-byte check (siteSpeed.ts) is a plain request, not a load.
        if (req.headers['sec-fetch-dest'] === 'document') log.push({ key, status: 200, at: Date.now() });
        return { status: 200, body: html };
      }
      return undefined;
    },
  });
  port = Number(new URL(server.origin).port);
  servers.push(server);
  return { origin: server.origin, log };
}

const base = { maxPages: 4, probes: false as const, documents: false as const };
const scan = (origin: string, extra: Record<string, unknown> = {}) => scanSite(`${origin}/`, { browser: B(), ...base, ...extra });
const path = (u: string) => new URL(u).pathname;
const rows = (r: SiteReport) => r.pages.map((p) => [path(p.url), p.status, p.score]);
const count = (log: Log[], key: string) => log.filter((l) => l.key === key).length;
const APP = '127.0.0.1/assets/app.css';
const THEME = `${VENDOR}/theme-assets/theme.css`;
const UNSTYLED = /could not load its styles/;
const LEFT_OUT = 'The site asked us to slow down (HTTP 429) and kept refusing the page’s stylesheet, so the page could not load its styles and was left out of the score';

let styled: SiteReport;
beforeAll(async () => {
  styled = await scan((await site()).origin);
}, 60_000);

describe('which host pays, and the retry (GAPS shape)', () => {
  it('the styled scan is the reference: every page loads and every stylesheet makes its text readable', () => {
    expect(styled.status).toBe('scored');
    expect(styled.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(styled.rules.map((r) => r.id)).not.toContain('color-contrast');
    expect(styled.pace).toBeUndefined();
  });

  it('(a) the page’s own app CSS refused once with Retry-After 3: the reload waits 3 s, then every page scores as the styled scan', async () => {
    const s = await site((key, n) => (key === APP && n === 1 ? SLOW('3') : undefined));
    const r = await scan(s.origin);
    expect(rows(r)).toEqual(rows(styled));
    expect(r.score).toBe(styled.score);
    expect(r.pace).toMatchObject({ slowedDown: true, refusals: [{ status: 429, count: 1 }], failedPages: 0 });
    // Retry-After 3 s, not the 1–2 s first backoff.
    expect(r.pace!.pausedMs).toBeGreaterThanOrEqual(2900);
    const app = s.log.filter((l) => l.key === APP);
    expect(app.at(-1)!.at - app.find((l) => l.status === 429)!.at).toBeGreaterThanOrEqual(2900);
  }, 90_000);

  it('(b) the theme CSS refused on every try: its pages are left out; the page host is never given up on', async () => {
    const s = await site((key) => (key === THEME ? SLOW() : undefined));
    const r = await scan(s.origin, { concurrency: 1, pace: { retries: 1 } });
    expect(r.pages.map((p) => [path(p.url), p.status, p.reason]).sort()).toEqual([
      ['/', 'failed', LEFT_OUT], ['/one.html', 'failed', LEFT_OUT], ['/plain.html', 'ok', undefined], ['/two.html', 'failed', LEFT_OUT],
    ]);
    // A page loaded after the stylesheet had been refused again and again: the site was not given up on.
    const plainAt = s.log.find((l) => l.key === '127.0.0.1/plain.html')!.at;
    expect(s.log.filter((l) => l.key === THEME && l.status === 429 && l.at < plainAt).length).toBeGreaterThanOrEqual(4);
    expect(count(s.log, THEME)).toBe(3 * 2 * 2);
  }, 120_000);
});

/**
 * A block page from a CDN's firewall (as Cloudflare sends): HTML with Cross-Origin-Resource-Policy
 * same-origin. For a stylesheet from another site the browser blocks it: the page sees no answer at
 * all, only a failed request (net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin). Seen on GAPS's theme CSS.
 */
const BLOCK_PAGE: Answer = { status: 429, type: 'text/html', body: '<!doctype html><title>Just a moment</title>', headers: { 'cross-origin-resource-policy': 'same-origin' } };

describe('stylesheets that come back with no usable answer (GAPS on staging)', () => {
  it('the vendor theme answered once with a block page the browser blocks: the page is loaded again and scores styled', async () => {
    const s = await site((key, n) => (key === THEME && n === 2 ? BLOCK_PAGE : undefined));
    const r = await scan(s.origin);
    expect(rows(r)).toEqual(rows(styled));
    expect(r.pace!.refusals).toEqual([{ status: 0, count: 1 }]);
    // Each page at both widths, and the one width whose theme was blocked once more.
    expect(s.log.filter((l) => l.key.endsWith('.html') || l.key === '127.0.0.1/')).toHaveLength(9);
  }, 90_000);

  it('a theme that loaded earlier in the scan, then the connection is cut: retried, scores styled', async () => {
    // The second page's two widths (requests 3 and 4) get a cut connection.
    const s = await site((key, n) => (key === THEME && (n === 3 || n === 4) ? { status: 0, drop: true } : undefined));
    const r = await scan(s.origin, { concurrency: 1 });
    expect(rows(r)).toEqual(rows(styled));
    expect(r.pace!.refusals).toEqual([{ status: 0, count: 2 }]);
  }, 90_000);

  it('a theme that loaded earlier in the scan, then answers 200 with an HTML page: retried, scores styled', async () => {
    const s = await site((key, n) => (key === THEME && n === 3 ? { status: 200, type: 'text/html', body: '<!doctype html><title>Checking your browser</title>' } : undefined));
    const r = await scan(s.origin, { concurrency: 1 });
    expect(rows(r)).toEqual(rows(styled));
    expect(r.pace!.refusals).toEqual([{ status: 0, count: 1 }]);
  }, 90_000);

  it('a theme whose server never answers, or always sends HTML, is the page every visitor gets: scored as is, no reload', async () => {
    for (const answer of [{ status: 0, drop: true }, { status: 200, type: 'text/html', body: '<!doctype html><title>x</title>' }] as Answer[]) {
      const s = await site((key) => (key === THEME ? answer : undefined));
      const r = await scan(s.origin);
      expect(r.pages.every((p) => p.status === 'ok')).toBe(true);
      expect(r.rules.map((x) => x.id)).toContain('color-contrast');
      expect(count(s.log, '127.0.0.1/')).toBe(2);
      expect(r.pace).toBeUndefined();
    }
  }, 120_000);
});

describe('refusals that do not change what is measured', () => {
  for (const status of [429, 503]) {
    it(`(c) Google Fonts answering ${status} on every request, everything else 200: every page scored as is, no reload, the scan never slowed`, async () => {
      const s = await site((key) => (key === `${FONTS}/css2` ? { status } : undefined));
      const r = await scan(s.origin);
      expect(rows(r)).toEqual(rows(styled));
      expect(r.pace).toBeUndefined();
      for (const p of ['/', '/one.html', '/two.html', '/plain.html']) expect(count(s.log, `127.0.0.1${p}`)).toBe(2);
    }, 90_000);
  }

  it('(c) a self-hosted sheet seen earlier in the scan with only @font-face rules, refused afterwards: no page dropped or reloaded', async () => {
    const s = await site((key, n) => (key === '127.0.0.1/assets/fonts.css' && n > 1 ? { status: 503 } : undefined));
    const r = await scan(s.origin, { concurrency: 1 });
    expect(rows(r)).toEqual(rows(styled));
    expect(r.pace).toBeUndefined();
    for (const p of ['/', '/one.html', '/two.html', '/plain.html']) expect(count(s.log, `127.0.0.1${p}`)).toBe(2);
  }, 90_000);

  it('a print-only sheet refused on every request: its page is scored as is, never reloaded', async () => {
    const s = await site((key) => (key === '127.0.0.1/print.css' ? SLOW() : undefined));
    const r = await scan(s.origin);
    expect(rows(r)).toEqual(rows(styled));
    expect(count(s.log, '127.0.0.1/one.html')).toBe(2);
  }, 90_000);

  it('(d) an extra sheet the page links, refused on every try, leaves that page out (what it styles cannot be known); the rest score', async () => {
    const s = await site((key) => (key === '127.0.0.1/two.css' ? SLOW() : undefined));
    const r = await scan(s.origin, { concurrency: 1, pace: { retries: 1 } });
    expect(r.pages.filter((p) => p.status !== 'ok').map((p) => [path(p.url), p.reason])).toEqual([['/two.html', LEFT_OUT]]);
    expect(r.status).toBe('scored');
    expect(count(s.log, '127.0.0.1/plain.html')).toBe(2);
  }, 90_000);

  it('a stylesheet that is really broken (404): the page is scored as it is, with no reload', async () => {
    const s = await site((key) => (key === APP ? { status: 404 } : undefined));
    const r = await scan(s.origin);
    expect(r.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(r.rules.map((x) => x.id)).toContain('color-contrast');
    expect(r.score).toBeLessThan(styled.score!);
    expect(count(s.log, '127.0.0.1/')).toBe(2);
    expect(r.pace).toBeUndefined();
  }, 90_000);

  it('a 403 for a stylesheet that loaded earlier in the scan (a burst-triggered block) is retried; one forbidden from the first request is the page as it is', async () => {
    const burst = await site((key, n) => (key === APP && n >= 3 && n <= 4 ? { status: 403 } : undefined));
    const r = await scan(burst.origin, { concurrency: 1, pace: { backoffMs: 200 } });
    expect(rows(r)).toEqual(rows(styled));
    expect(r.pace!.refusals).toEqual([{ status: 403, count: 2 }]);
    const always = await site((key) => (key === APP ? { status: 403 } : undefined));
    const r2 = await scan(always.origin);
    expect(r2.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(r2.rules.map((x) => x.id)).toContain('color-contrast');
    expect(r2.pace).toBeUndefined();
  }, 120_000);
});

describe('frames', () => {
  const listed = ['/', '/framed.html', '/plain.html'];
  it('a same-site frame whose sheet is refused on every try: the page is left out (axe scores that frame with the page)', async () => {
    const s = await site((key) => (key === '127.0.0.1/frame.css' ? SLOW() : undefined), listed);
    const r = await scan(s.origin, { maxPages: 3, pace: { retries: 1 } });
    expect(r.pages.filter((p) => p.status !== 'ok').map((p) => [path(p.url), p.reason])).toEqual([['/framed.html', LEFT_OUT]]);
  }, 90_000);

  it('a frame from another site whose sheet is refused: never the page’s, scored as is, no reload', async () => {
    const s = await site((key) => (key === `${THIRD}/widget.css` ? SLOW() : undefined), listed);
    const r = await scan(s.origin, { maxPages: 3 });
    expect(r.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(count(s.log, '127.0.0.1/framed.html')).toBe(2);
    expect(r.pace).toBeUndefined();
  }, 90_000);
});

describe('stylesheets that come after the load event', () => {
  it('a sheet added while the page settles, refused once: part of the try, so the page is loaded again and scores styled', async () => {
    const s = await site((key, n) => (key === '127.0.0.1/late.css' && n === 1 ? SLOW() : undefined), ['/', '/early-late.html']);
    const r = await scan(s.origin, { maxPages: 2 });
    expect(r.pages.every((p) => p.status === 'ok')).toBe(true);
    expect(r.rules.map((x) => x.id)).not.toContain('color-contrast');
    expect(count(s.log, '127.0.0.1/early-late.html')).toBe(3);
  }, 90_000);

  it('a sheet whose answer comes after the try was judged, while axe runs, refused: that width is not scored (waited for, charged to its host)', async () => {
    expect(SLOW_SHEET_MS).toBeGreaterThan(SETTLE_MS + STYLE_SETTLE_MS + 500);
    const s = await site((key) => (key === '127.0.0.1/slow.css' ? SLOW('2') : undefined), ['/', '/late.html']);
    const r = await scan(s.origin, { maxPages: 2 });
    const late = r.pages.find((p) => path(p.url) === '/late.html')!;
    expect(late.status).toBe('failed');
    expect(late.reason).toMatch(UNSTYLED);
    expect(r.pace!.refusals).toEqual([{ status: 429, count: 2 }]);
  }, 90_000);
});

describe('pictures and tests', () => {
  it('a page that loses its styles at one width keeps no live picture at either width', async () => {
    const s = await site((key) => (key === '127.0.0.1/mobile.css' ? SLOW() : undefined), ['/', '/narrow.html']);
    const shots: string[] = [];
    const events: ScanEvent[] = [];
    const r = await scan(s.origin, { maxPages: 2, pace: { retries: 1 }, onEvent: (e: ScanEvent) => events.push(e), liveShots: { sink: async (id: string) => { shots.push(id); } } });
    const i = r.pages.findIndex((p) => path(p.url) === '/narrow.html');
    expect(r.pages[i]!.status).toBe('failed');
    expect(shots.filter((id) => id.startsWith(`${i}-`))).toEqual([]);
    expect(events.filter((e) => e.type === 'viewport-done' && e.index === i && 'shot' in e && e.shot)).toEqual([]);
    // The other page keeps its pictures.
    expect(shots.filter((id) => id.startsWith(`${1 - i}-`)).sort()).toEqual([`${1 - i}-desktop`, `${1 - i}-mobile`]);
  }, 90_000);

  const item = (origin: string, p = '/one.html') => ({ kind: 'rule' as const, page: `${origin}${p}`, rule: 'color-contrast', help: 'Text must have enough contrast', targets: ['.ink'] });

  it('an evidence picture of a page whose stylesheet was refused once is taken after one reload, after its Retry-After', async () => {
    const s = await site((key, n) => (key === THEME && n === 1 ? SLOW('2') : undefined));
    const [shot] = await captureEvidence(B(), [item(s.origin)], { userAgent: 'UA', pace: createPace({ concurrency: 6 }) });
    expect(shot).not.toBeNull();
    const theme = s.log.filter((l) => l.key === THEME);
    expect(theme.map((l) => l.status)).toEqual([429, 200]);
    expect(theme[1]!.at - theme[0]!.at).toBeGreaterThanOrEqual(1900);
  }, 60_000);

  it('no picture of an unstyled page: a stylesheet that stays refused drops the picture', async () => {
    const s = await site((key) => (key === APP ? SLOW() : undefined));
    const [shot] = await captureEvidence(B(), [item(s.origin)], { userAgent: 'UA', pace: createPace({ concurrency: 6 }) });
    expect(shot).toBeNull();
    expect(count(s.log, APP)).toBe(2);
  }, 60_000);

  it('no picture kept from a page that lost its styles while the pictures were taken', async () => {
    const s = await site((key) => (key === '127.0.0.1/slow.css' ? SLOW() : undefined));
    const [r] = await captureEvidenceResults(B(), [item(s.origin, '/late.html')], { userAgent: 'UA', pace: createPace({ concurrency: 6 }) });
    expect(r!.shot).toBeNull();
    expect(r!.missed).toMatch(UNSTYLED);
    // Taken after the try was judged: no reload.
    expect(count(s.log, '127.0.0.1/late.html')).toBe(1);
  }, 60_000);

  it('a picture time box that ends while the last wait runs keeps the pictures of a page that kept its styles (only its fonts were refused)', async () => {
    const s = await site((key) => (key === `${FONTS}/css2` ? SLOW() : undefined));
    // The pictures are taken after the try's waits (about 4.5 s); /slower.css is still on its way, so
    // the time box (6 s) ends during the final wait for it. Only Google Fonts was refused.
    const [r] = await captureEvidenceResults(B(), [item(s.origin, '/slower.html')], { userAgent: 'UA', pace: createPace({ concurrency: 6 }), timeouts: { pageBudgetMs: 6000 } });
    expect(r!.missed).toBeUndefined();
    expect(r!.shot).not.toBeNull();
  }, 60_000);

  /** A test that fails whatever it sees (so only the runner can keep a finding from standing). */
  const failsAlways: PageProbe = {
    id: 'fails-always', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 15_000,
    async run() {
      return [{ criterion: '0.0.1', status: 'failed', detail: 'failed on what it saw' }];
    },
  };

  it('a test never runs on an unstyled page: a stylesheet that stays refused leaves the test not testable, with no finding', async () => {
    const s = await site((key) => (key === APP ? SLOW() : undefined));
    const [run] = await runProbes(B(), [{ url: `${s.origin}/one.html`, index: 0 }], [failsAlways], { userAgent: 'UA', pace: createPace({ concurrency: 4 }) });
    expect(run!.findings.some((f) => f.status === 'failed')).toBe(false);
    expect(JSON.stringify(run)).toMatch(UNSTYLED);
  }, 60_000);

  it('a test whose page lost its styles while it ran (a reload the stylesheet refused) keeps no finding', async () => {
    let refuse = false;
    const s = await site((key) => (key === APP && refuse ? SLOW() : undefined));
    const reloads: PageProbe = {
      ...failsAlways, id: 'reloads',
      async run(ctx) {
        refuse = true;
        await ctx.page.goto(ctx.url, { waitUntil: 'load' });
        return [{ criterion: '0.0.1', status: 'failed', detail: 'failed on what it saw' }];
      },
    };
    const [run] = await runProbes(B(), [{ url: `${s.origin}/one.html`, index: 0 }], [reloads], { userAgent: 'UA', pace: createPace({ concurrency: 4 }) });
    expect(run!.findings.some((f) => f.status === 'failed')).toBe(false);
    expect(JSON.stringify(run)).toMatch(UNSTYLED);
  }, 60_000);

  it('a test on a page with a really broken stylesheet (404), or whose fonts were refused, runs as usual', async () => {
    const s = await site((key) => (key === APP ? { status: 404 } : key === `${FONTS}/css2` ? { status: 503 } : undefined));
    const [run] = await runProbes(B(), [{ url: `${s.origin}/one.html`, index: 0 }], [failsAlways], { userAgent: 'UA', pace: createPace({ concurrency: 4 }) });
    expect(run!.findings.map((f) => f.status)).toEqual(['failed']);
  }, 60_000);
});
