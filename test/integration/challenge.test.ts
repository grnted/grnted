// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// r1-1 (W3b review): a page answered with HTTP 202 (a bot challenge, or a site that answers 202 to
// everyone) did not load, for axe and the core tests alike. It is never graded from that body, and
// the enough-pages rule applies: a site that answers 202 everywhere gets no score.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { CHALLENGE_PAGE } from '../../src/probes/runner.js';
import { defaultAxeSource, scanSite, ScanPaused, type ScanResume } from '../../src/scan.js';
import type { BrowserLike, PageAudit, ScanEvent } from '../../src/types.js';

// An empty heading and a box wider than a phone on every page: 1.3.1 (the headings test) fails on every page.
// A paragraph marked up as a heading (F43): a core-test failure (1.3.1). Batch 19: was an empty <h3>, which the lead's
// ruling makes Needs review.
const PARAGRAPH = 'The office is open on weekdays from eight in the morning until five in the evening. On public holidays it stays closed, and the phone line takes messages that are answered the next working day by a member of staff.';
const page = (title: string, links = '') => `<!doctype html><html lang="en"><head><title>${title}</title></head>
<body><main><h2>${title}</h2><h3>${PARAGRAPH}</h3><div style="width:2000px;height:40px;background:#eee">Wide</div><p>Text.</p>${links}</main></body></html>`;

let browser: Browser;
let status = 200;
/** r2: what the core tests' own loads get (the audit gets `status`); `probeCss` refuses their stylesheet too. */
let probeStatus = 200;
let probeCss = false;
let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') return void res.writeHead(404).end();
    const probe = req.headers['x-test-probe'] === '1';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/site.css') return void res.writeHead(probe && probeCss ? 429 : 200, { 'content-type': 'text/css' }).end('main { padding: 4px; }');
    const body = (path === '/' ? page('Home', '<a href="/a">Page A</a> <a href="/b">Page B</a> <a href="/c">Page C</a>') : page(`Page ${path.slice(1).toUpperCase()}`))
      .replace('</head>', '<link rel="stylesheet" href="/site.css"></head>');
    res.writeHead(probe ? probeStatus : status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

const B = () => browser as unknown as BrowserLike;

/**
 * The real browser, but every context the core tests open (the probe runner's, the only ones that
 * block service workers) sends a header, so the server can answer them differently from the audit.
 */
const splitBrowser = (): BrowserLike => ({
  newContext: (o: Parameters<Browser['newContext']>[0]) =>
    browser.newContext(o && (o as { serviceWorkers?: string }).serviceWorkers === 'block' ? { ...o, extraHTTPHeaders: { 'x-test-probe': '1' } } : o),
} as unknown as BrowserLike);

describe('r1-1: HTTP 202 is a page that did not load', () => {
  it('audit: a 202 page is not loaded, with the challenge reason, and nothing is measured on it', async () => {
    status = 202; probeStatus = 202;
    const audit = await auditPage(B(), `${origin}/a`, { userAgent: 'grnted-test', axeSource: await defaultAxeSource() });
    expect(audit.status).toBe('failed');
    expect(audit.reason).toBe(CHALLENGE_PAGE);
    expect(audit.violations).toEqual([]);
  }, 60_000);

  it('the same site answering 200 fails its core tests; answering 202 everywhere it gets no score, never 100 or Access Granted', async () => {
    status = 200; probeStatus = 200;
    const ok = await scanSite(`${origin}/`, { browser: B(), maxPages: 4 });
    expect(ok.status).toBe('scored');
    expect(ok.score!).toBeLessThan(100);
    expect(ok.testIssues!.map((t) => t.criterion)).toContain('1.3.1');
    status = 202; probeStatus = 202;
    const challenged = await scanSite(`${origin}/`, { browser: B(), maxPages: 4 });
    expect(challenged.status).not.toBe('scored');
    expect(challenged.score).toBeNull();
    expect(challenged.pages.every((p) => p.status === 'failed' && p.reason === CHALLENGE_PAGE)).toBe(true);
  }, 240_000);
});

describe('r2-1: a core test whose own load gets a 202 (the audit got 200): the page did not load', () => {
  it('r2-1 real runner: never 100 or Access Granted, the pages are not ok, and each run says it was a challenge', async () => {
    status = 200; probeStatus = 202; probeCss = false;
    const r = await scanSite(`${origin}/`, { browser: splitBrowser(), maxPages: 4 });
    expect(r.score).not.toBe(100);
    expect(r.status).not.toBe('scored');
    expect(r.pages.every((p) => p.status === 'failed' && p.reason === CHALLENGE_PAGE)).toBe(true);
    const runs = r.probes!.runs.filter((x) => x.status !== 'ok');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((x) => x.findings.every((f) => f.loadFailure === 'challenge'))).toBe(true);
  }, 240_000);

  it('r2-2 202 with a refused stylesheet: the challenge is the reason, never the stylesheet', async () => {
    status = 200; probeStatus = 202; probeCss = true;
    const r = await scanSite(`${origin}/`, { browser: splitBrowser(), maxPages: 4 });
    expect(r.status).not.toBe('scored');
    expect(r.pages.every((p) => p.status === 'failed' && p.reason === CHALLENGE_PAGE)).toBe(true);
    expect(r.probes!.runs.filter((x) => x.status !== 'ok').every((x) => x.findings.every((f) => f.loadFailure === 'challenge'))).toBe(true);
  }, 240_000);

  it('r2-3 long-scan resume: stored 200 audits, then the last segment\'s core tests get a 202', async () => {
    status = 200; probeStatus = 200; probeCss = false;
    const audits = new Map<number, PageAudit>();
    let pages: string[] = [];
    let documents: string[] = [];
    let skipped: { url: string; reason: string }[] = [];
    const opts = {
      onEvent: (e: ScanEvent) => { if (e.type === 'selected') { pages = [...e.pages]; documents = [...e.documents]; skipped = e.skipped.map((x) => ({ ...x })); } },
      onPageAudited: (p: PageAudit, i: number) => { audits.set(i, p); },
    };
    const paused = await scanSite(`${origin}/`, { browser: splitBrowser(), maxPages: 4, pagesOnly: true, ...opts }).then(() => null, (e: unknown) => e);
    expect(paused).toBeInstanceOf(ScanPaused);
    expect([...audits.values()].every((a) => a.status === 'ok')).toBe(true);
    probeStatus = 202;
    const resume: ScanResume = { pages, documents, skipped, audit: (i) => audits.get(i) };
    const r = await scanSite(`${origin}/`, { browser: splitBrowser(), maxPages: 4, resume });
    expect(r.score).not.toBe(100);
    expect(r.status).not.toBe('scored');
    expect(r.pages.every((p) => p.status === 'failed' && p.reason === CHALLENGE_PAGE)).toBe(true);
  }, 240_000);
});
