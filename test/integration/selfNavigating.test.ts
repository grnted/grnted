// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Pages that navigate themselves (src/landing.ts; fix/self-navigating round 3, lead rulings
// out/sol/selfnav-r2/rulings.md). Staging 2026-11-07 lost four of 25 pages of a city site, each
// "page.evaluate: Execution context was destroyed, most likely because of a navigation": a bot manager's
// interstitial replaced itself with the page as the audit's scroll pass ran.
// - The audit loads the page as a visitor does and measures where it lands, once it has stopped replacing
//   itself; a document that changes while it is measured is never measured as the page.
// - The tests never follow anything: a page that tries to navigate itself as it loads for a test is not
//   tested; a blocked verification request or a challenge response makes a bot check not testable.
// Each test is a reviewer's input (Sol r1 / r2), with its outcome under this design. Fixtures:
// test/fixtures/self-navigating/.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { BOT_CHALLENGE } from '../../src/challenge.js';
import { KEEPS_NAVIGATING, LANDING_CANCELLED, LANDING_OUT_OF_TIME, LANDING_UNCHECKED, MOVED_BY_ITSELF, OTHER_SITE } from '../../src/landing.js';
import { NOT_ALLOWED, REFUSED_ADDRESS, gatedBrowser } from '../../src/navigationGate.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { createPace } from '../../src/pace.js';
import { CANCELLED, LOADED_DURING, LOADING_ITSELF, UNCONFIRMED, runProbes } from '../../src/probes/runner.js';
import { timingProbe } from '../../src/probes/timing.js';
import type { PageProbe } from '../../src/probes/types.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, PageAudit, PageCollector, PageLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let blocked: Awaited<ReturnType<typeof startFixtureServer>>;
let axeSource: string;
let reloadAnswer = 'bot';
let reloadRequests = 0;
/** The rotating clearance (Sol r3 2): each token admits one request, which gets the next. */
const rotValid = new Set<string>();
let rotNext = 0;
const rotToken = () => { const t = `t${++rotNext}`; rotValid.add(t); return t; };
/** Every request the refused server got. */
const refusedLog: string[] = [];
/** Every request the site got (method and path with query). */
const siteLog: string[] = [];
const B = () => browser as unknown as BrowserLike;
const allowUrl = async (url: string) => new URL(url).port !== new URL(blocked.origin).port;

// A bot manager's interstitial (the shape of Akamai's on the city site): without its cookie the address
// answers 200 with a "checking your browser" page that POSTs a proof, gets the cookie, and replaces
// itself with the same address, which then answers with the page.
const INTERSTITIAL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>&nbsp;</title></head><body style="margin:0;height:100vh">
<p>Powered and protected by a bot manager</p><img id="logo" alt="Bot manager" src="/_sec/logo.svg" loading="eager">
<script>function verify() { var x = new XMLHttpRequest(); x.addEventListener('loadend', function () {
  try { if (JSON.parse(x.responseText).reload) { location.replace(location.href); return; } } catch (e) {} location.reload(); });
  x.open('POST', '/_sec/verify', false); x.setRequestHeader('Content-Type', 'application/json'); x.send('{"pow":1}'); }
var logo = document.getElementById('logo'); logo.onload = function () { requestAnimationFrame(verify); }; logo.onerror = verify;</script></body></html>`;
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="200" height="40" fill="#09c"/></svg>';
const EVENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Neighbors meeting | Calendar</title></head><body>
<main><h1>Neighbors meeting</h1><p>Tuesday at 6:30 pm in the library. <a href="/event-only.html">Add to calendar</a></p></main></body></html>`;
const page = (title: string, link: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>main{min-height:3000px}</style><title>${title}</title></head><body><main><h1>${title}</h1><p>Read more. <a href="${link}">More</a></p>
<form method="get" action="/form-same.html"><label>Search <input name="q" value="pothole"></label><button>Go</button></form></main>${script ? `<script>${script}</script>` : ''}</body></html>`;

beforeAll(async () => {
  blocked = await startFixtureServer('self-navigating', {}, { onRequest: (req: IncomingMessage) => refusedLog.push(`${req.method} ${req.url}`) });
  const html = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../fixtures/self-navigating/private.html', import.meta.url), 'utf8'));
  site = await startFixtureServer('self-navigating', {
    '/private.html': { type: 'text/html; charset=utf-8', body: html.replaceAll('BLOCKED', blocked.origin) },
  }, {
    onRequest: (req: IncomingMessage) => siteLog.push(`${req.method} ${req.url}`),
    // The proof's answer takes a moment, as across the internet: the page replaces itself ~150 ms after load.
    // A destination whose headers take 5 s; an image that holds the load event for 2 s; an answer that
    // never comes in time (25 s); a fetch the page waits 1.2 s for.
    delayMs: (path) => (path === '/_sec/verify' ? 150 : path === '/slow-dest.html' ? 5000 : path === '/slow-image.svg' ? 2000
      : path === '/hang.html' ? 25_000 : path === '/resolve' ? 1200 : 0),
    respond: (req, path): { status: number; headers?: Record<string, string>; body?: string; type?: string } | undefined => {
      if (path === '/bot-proof.html') {
        const proof = new URL(req.url!, 'http://fixture').searchParams.get('proof')!;
        return { status: 200, body: page('Proof', '/proof-help.html', `fetch(${JSON.stringify(proof)}, { method: 'POST' }).catch(() => {});`) };
      }
      if (path === '/reload-check.html') {
        if (++reloadRequests === 1) return { status: 200, body: EVENT };
        if (reloadAnswer === 'bot' || reloadAnswer === 'bot-slow') return { status: 200, body: reloadAnswer === 'bot-slow' ? INTERSTITIAL.replace('requestAnimationFrame(verify)', 'setTimeout(verify, 850)') : INTERSTITIAL };
        if (reloadAnswer === 'cf') return { status: 200, headers: { 'cf-mitigated': 'challenge' }, body: page('Checking your browser', '/challenge-only.html') };
        if (reloadAnswer === 'http') return { status: 404, body: page('Not found', '/missing-only.html') };
        if (reloadAnswer === 'plain') return { status: 200, type: 'text/plain', body: 'Just text' };
        return { status: 200, body: page('Reloading', '/reload-only.html', "addEventListener('load', () => setTimeout(() => location.reload(), 100));") };
      }
      if (path === '/slow-image.svg') return { status: 200, type: 'image/svg+xml', body: LOGO };
      if (path === '/gone.html') return { status: 404, body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><main><h1>Not found</h1><p><a href="/gone-only.html">Home</a></p></main></body></html>' };
      if (path === '/wait.html') return { status: 202, body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>One moment</title></head><body><main><h1>One moment</h1><p><a href="/wait-only.html">Why?</a></p></main></body></html>' };
      // A chain of documents, each sending itself to the next 100 ms after load (?n=1, 2, 3 …).
      if (path === '/chain.html') {
        const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? '1');
        return { status: 200, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Step ${n}</title></head><body><main><h1>Step ${n}</h1><p><a href="/chain-only.html">Help</a></p></main><script>addEventListener('load', function () { setTimeout(function () { location.replace('/chain.html?n=${n + 1}'); }, 100); });</script></body></html>` };
      }
      if (path === '/_sec/verify') {
        return req.method === 'POST'
          ? { status: 200, type: 'application/json', headers: { 'set-cookie': [`_abck=${req.headers.referer?.includes('/rot.html') ? rotToken() : 'ok'}; Path=/`, 'pendingCart=123; Path=/'] as unknown as string }, body: '{"reload":true}' }
          : { status: 405 };
      }
      if (path === '/_sec/logo.svg') return { status: 200, type: 'image/svg+xml', body: LOGO };
      // A WAF's challenge with a 200 status, and a file that is not a page.
      if (path === '/cf-block.html') return { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: page('Checking your browser', '/challenge-only.html') };
      if (path === '/cf-challenge.html') return { status: 200, headers: { 'cf-mitigated': 'challenge' }, body: page('Just a moment', '/cf-only.html') };
      if (path === '/plain.txt') return { status: 200, type: 'text/plain; charset=utf-8', body: 'Just text' };
      if (path === '/go-cf') return { status: 302, headers: { location: '/cf-challenge.html' } };
      if (path === '/go-plain') return { status: 302, headers: { location: '/plain.txt' } };
      if (path === '/to-cf.html') return { status: 200, body: page('Moved', '/moved-help.html', "addEventListener('load', function () { location.replace('/cf-challenge.html'); });") };
      if (path === '/to-plain.html') return { status: 200, body: page('Moved', '/moved-help.html', "addEventListener('load', function () { location.replace('/plain.txt'); });") };
      // A session that expires 700 ms after load (Sol r1 7).
      if (path === '/redirect-700.html') return { status: 200, body: page('Your account', '/account-help.html', "addEventListener('load', function () { setTimeout(function () { location.href = '/signed-out.html'; }, 700); });") };
      // Six early navigations, each cancelled before its answer (Sol r2 6).
      if (path === '/stop-chain.html') {
        return { status: 200, body: page('Parks', '/stop-only.html', "addEventListener('load', function () { var n = 0; (function go() { if (n++ >= 6) return; location.href = '/slow-dest.html?try=' + n; setTimeout(function () { window.stop(); setTimeout(go, 50); }, 50); })(); });") };
      }
      // A page whose fetch answers 1.2 s after load, and then replaces itself (Sol r2 3): no timer anywhere.
      if (path === '/fetch-replace.html') return { status: 200, body: page('Loading', '/fetch-only.html', "fetch('/resolve').then(function () { location.replace('/real.html'); });") };
      if (path === '/resolve') return { status: 200, type: 'application/json', body: '{}' };
      // Replaces itself with a page whose answer never comes in time.
      if (path === '/to-hang.html') return { status: 200, body: page('One moment', '/hang-only.html', "addEventListener('load', function () { setTimeout(function () { location.replace('/hang.html'); }, 100); });") };
      if (path === '/hang.html') return { status: 200, body: page('Late', '/late-only.html') };
      // A plain page with a GET form to itself (Sol r2 5).
      if (path === '/form-same.html') return { status: 200, body: page('Search', '/search-help.html') };
      // Sol r3 2: a clearance that rotates on each request it admits.
      if (path === '/_sec/verify-rot') return { status: 200, type: 'application/json', headers: { 'set-cookie': `_abck=${rotToken()}; Path=/` }, body: '{"reload":true}' };
      if (path === '/rot.html') {
        const t = /(?:^|;\s*)_abck=(t\d+)/.exec(req.headers.cookie ?? '')?.[1];
        if (t && rotValid.delete(t)) return { status: 200, headers: { 'set-cookie': `_abck=${rotToken()}; Path=/` }, body: EVENT };
        return { status: 200, body: INTERSTITIAL };
      }
      // Sol r3 4: a script redirect to a sign-in page on another site (localhost is another host than 127.0.0.1).
      if (path === '/to-other.html') return { status: 200, body: page('Account', '/account-help.html', "addEventListener('load', function () { setTimeout(function () { location.replace('http://localhost:' + location.port + '/no-title.html'); }, 100); });") };
      if (path === '/no-title.html') return { status: 200, body: '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main><h1>Sign in</h1><p><a href="/external-only.html">Help</a></p></main></body></html>' };
      // Sol r3 6: the ordinary script redirect from / to /home.
      if (path === '/root-redirect.html') return { status: 200, body: page('Welcome', '/root-only.html', "addEventListener('load', function () { setTimeout(function () { location.replace('/home.html'); }, 100); });") };
      if (path === '/home.html') return { status: 200, body: page('Home', '/home-only.html') };
      // A page that builds a phone menu below 600 px (40 more links, more text): the same page at both widths.
      if (path === '/phone-menu.html') return { status: 200, body: page('Library', '/library-only.html', "if (innerWidth < 600) { var nav = document.createElement('nav'); for (var i = 0; i < 40; i++) { var a = document.createElement('a'); a.href = '/m' + i; a.textContent = 'Menu item number ' + i; nav.appendChild(a); } document.querySelector('main').appendChild(nav); }") };
      if (path !== '/event.html' && path !== '/event-slow.html') return undefined;
      if (/(?:^|;\s*)_abck=ok/.test(req.headers.cookie ?? '')) return { status: 200, body: EVENT };
      // The slow one verifies 850 ms after load.
      return { status: 200, body: path === '/event.html' ? INTERSTITIAL : INTERSTITIAL.replace('requestAnimationFrame(verify)', 'setTimeout(verify, 850)') };
    },
  });
  axeSource = await defaultAxeSource();
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  await blocked?.close();
});

type AuditExtra = Partial<Pick<Parameters<typeof auditPage>[2], 'collectors' | 'deadline' | 'signal'>>;
const audit = (path: string, b: BrowserLike = B(), extra: AuditExtra = {}) => auditPage(b, `${site.origin}${path}`, { userAgent: 'grnted-test', axeSource, timeoutMs: 20_000, ...extra });
/** The page's own link addresses (paths): which document was audited. */
const linkPaths = (p: PageAudit) => p.links.map((l) => new URL(l).pathname);
const ruleIds = (p: PageAudit) => p.violations.map((v) => v.id);
const outcome = (p: PageAudit) => ({ status: p.status, reason: p.reason, httpStatus: p.httpStatus });
const sent = (path: string) => siteLog.filter((l) => l.split(' ')[1]!.split('?')[0] === path);
/** The highest step of the redirect chain the site was asked for. */
const chainTop = () => Math.max(0, ...siteLog.filter((l) => l.includes('/chain.html')).map((l) => Number(new URL(l.split(' ')[1]!, 'http://x').searchParams.get('n') ?? '1')));

/** Where the test ran: the page's own link addresses (paths). */
const where: PageProbe = {
  id: 'where', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
  async run(ctx) {
    const links = await ctx.page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => new URL((a as HTMLAnchorElement).href).pathname).join(' '), undefined);
    return [{ criterion: '0.0.1', status: 'no_failures_found', detail: links }];
  },
};
const OPTS = { userAgent: 'grnted-test' };
const BOT_CHECK = 'a bot check stood in front of the page';
const probeOn = async (path: string, probes: PageProbe[], b: BrowserLike = B(), signal?: AbortSignal) =>
  runProbes(b, [{ url: `${site.origin}${path}`, index: 0 }], probes, { ...OPTS, ...(signal ? { signal } : {}) });
const loadOutcome = (run: { findings: readonly { status: string; loadFailure?: string; detail?: string }[] }) => run.findings.map((f) => ({ status: f.status, loadFailure: f.loadFailure, detail: f.detail }));
const stillLoading = expect.objectContaining({ status: 'not_testable', loadFailure: 'not-loaded', detail: expect.stringContaining(LOADING_ITSELF) });

describe('the audit measures the page where it lands, as a visitor sees it', () => {
  it('location.replace to a page of the same site 300 ms after load: audited as the page it landed on', async () => {
    const p = await audit('/replace.html');
    expect([p.status, p.reason]).toEqual(['ok', undefined]);
    expect(linkPaths(p)).toEqual(['/landed-only.html']);
    expect(ruleIds(p)).toContain('image-alt');
  }, 60_000);

  it('the staging case: a bot manager\'s interstitial that verifies the browser and replaces itself is audited as the page', async () => {
    const p = await audit('/event.html');
    expect([p.status, p.reason]).toEqual(['ok', undefined]);
    expect(linkPaths(p)).toEqual(['/event-only.html']);
  }, 60_000);

  it('Sol r1 4: an interstitial that verifies 850 ms after load is audited as the page, not the interstitial', async () => {
    const p = await audit('/event-slow.html');
    expect([p.status, p.reason, linkPaths(p)]).toEqual(['ok', undefined, ['/event-only.html']]);
  }, 60_000);

  it('history.pushState and a fragment after load (the same document): audited, never counted as other pages', async () => {
    const p = await audit('/history.html');
    expect([p.status, p.reason]).toEqual(['ok', undefined]);
    expect(linkPaths(p)).toEqual(['/history-help.html']);
  }, 60_000);

  it('a page that reloads itself once: audited as the reloaded page', async () => {
    const p = await audit('/reload-once.html');
    expect([p.status, p.reason]).toEqual(['ok', undefined]);
    expect(linkPaths(p)).toEqual(['/reloaded-only.html']);
  }, 60_000);

  it('Sol r1 6: a replace 100 ms in, while a 2 s image holds the load event: audited as /real', async () => {
    const p = await audit('/preload-replace.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/real-only.html']]);
  }, 60_000);

  it('Sol r1 3: a replace at 600 ms to a destination whose headers take 5 s: the audit waits for it, never measures the interstitial', async () => {
    const p = await audit('/replace-slow.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/slow-dest-only.html']]);
  }, 60_000);

  it('a timed meta refresh (1 s) lands within the settle: audited where it lands', async () => {
    const p = await audit('/refresh-timeout.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/sign-in.html']]);
  }, 60_000);

  it('Sol r1 7: a session that expires 700 ms after load: a visitor lands on the sign-out page, and so does the audit', async () => {
    const p = await audit('/redirect-700.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/sign-in.html']]);
  }, 60_000);

  it('Sol r1 2 (audit side): the audit loads like a visitor, so a page script that submits its own GET form 200 ms after load sends it, as every visitor\'s browser does (unchanged from before); it lands on the answer', async () => {
    siteLog.length = 0;
    const p = await audit('/form-get.html');
    expect(sent('/process').length).toBeGreaterThan(0);
    expect(outcome(p)).toEqual({ status: 'failed', reason: 'HTTP 404', httpStatus: 404 });
  }, 60_000);

  it('a page that sends itself to an address the scan refuses is still refused, and the address is never asked', async () => {
    refusedLog.length = 0;
    const p = await audit('/private.html', gatedBrowser(B(), allowUrl));
    expect(p.status).toBe('failed');
    expect([NOT_ALLOWED, REFUSED_ADDRESS]).toContain(p.reason);
    expect(refusedLog).toEqual([]);
  }, 60_000);
});

describe('the answer of the document measured is checked (Sol r1 5, r2 4)', () => {
  it('a 200, then a fast client redirect to a 404: the same outcome as a direct 404', async () => {
    const direct = await audit('/gone.html');
    expect(outcome(direct)).toEqual({ status: 'failed', reason: 'HTTP 404', httpStatus: 404 });
    expect(outcome(await audit('/to-404.html'))).toEqual(outcome(direct));
  }, 60_000);

  it('a 200, then a fast client redirect to a 202: the same outcome as a direct 202 (a challenge)', async () => {
    const direct = await audit('/wait.html');
    expect(direct.status).toBe('failed');
    expect(outcome(await audit('/to-202.html'))).toEqual(outcome(direct));
  }, 60_000);

  it('a 200, then a fast client redirect to a WAF challenge (200, cf-mitigated) or to a text file: as a direct landing on either', async () => {
    expect(outcome(await audit('/to-cf.html'))).toEqual(outcome(await audit('/cf-challenge.html')));
    expect(outcome(await audit('/to-cf.html'))).toEqual({ status: 'failed', reason: BOT_CHALLENGE, httpStatus: 200 });
    expect(outcome(await audit('/to-plain.html'))).toEqual({ status: 'failed', reason: 'Not an HTML page', httpStatus: undefined });
  }, 90_000);

  it('Sol r2 4 (the tests\' loader): a server redirect to a WAF challenge or to a text file is never tested as the page', async () => {
    const [cf] = await probeOn('/go-cf', [where]);
    expect(cf!.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge', detail: expect.stringContaining(BOT_CHECK) })]);
    const [plain] = await probeOn('/go-plain', [where]);
    expect(plain!.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'not-loaded', detail: expect.stringContaining('not an HTML page') })]);
  }, 60_000);
});

describe('bounded: documents, time, cancellation (Sol r1 9, 10; r2 6, 8, 9)', () => {
  it('Sol r1 9: a chain of 100 ms redirects: "kept loading other pages by itself" after 5 more documents, at most 7 asked', async () => {
    siteLog.length = 0;
    const t0 = Date.now();
    const p = await audit('/chain.html?n=1');
    expect([p.status, p.reason]).toEqual(['failed', KEEPS_NAVIGATING]);
    // Both widths each commit at most 6 documents (the first and 5 more); the 7th's commit ends it.
    expect(chainTop()).toBeLessThanOrEqual(7);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  it('a redirect loop: bounded, then a clear reason (never a hang)', async () => {
    const t0 = Date.now();
    const p = await audit('/loop-a.html');
    expect([p.status, p.reason]).toEqual(['failed', KEEPS_NAVIGATING]);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  it('Sol r2 6: navigations cancelled before their answer (window.stop) are not documents: the page is audited as itself', async () => {
    const p = await audit('/stop-chain.html');
    expect([p.status, p.reason, linkPaths(p)]).toEqual(['ok', undefined, ['/stop-only.html']]);
  }, 60_000);

  it('Sol r2 9: a page that replaces itself with one whose answer never comes, with the scan\'s deadline 4 s away: stops at the deadline, not 20 s later', async () => {
    const t0 = Date.now();
    const p = await audit('/to-hang.html', B(), { deadline: Date.now() + 4000 });
    expect([p.status, p.reason]).toEqual(['failed', LANDING_OUT_OF_TIME]);
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 60_000);

  it('Sol r2 8: the scan cancelled while such a page waits: it stops at once', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 2500);
    const t0 = Date.now();
    const p = await audit('/to-hang.html', B(), { signal: stop.signal });
    expect([p.status, p.reason]).toEqual(['failed', LANDING_CANCELLED]);
    expect(Date.now() - t0).toBeLessThan(6000);
  }, 60_000);
});

/** A collector that makes the page go to `to` while the audit measures it (a navigation nothing held). */
const goesAway = (to: string): PageCollector => ({
  id: 'goes-away', viewport: 'both',
  async collect(p: PageLike) {
    await p.evaluate((u: string) => { location.replace(u); }, to);
    return null;
  },
});

describe('a document that changes while it is measured is never measured as the page (ruling 2: Sol r1 8, r2 1, 2)', () => {
  it('Sol r2 1: a navigation that starts during measuring and is still in flight at its end: not testable', async () => {
    const p = await audit('/real.html', B(), { collectors: [goesAway('/slow-dest.html')] });
    expect([p.status, p.reason]).toEqual(['failed', MOVED_BY_ITSELF]);
  }, 60_000);

  it('…and one that commits during measuring: not testable', async () => {
    const p = await audit('/real.html', B(), { collectors: [goesAway('/landed.html')] });
    expect([p.status, p.reason]).toEqual(['failed', MOVED_BY_ITSELF]);
  }, 60_000);

  it('Sol r2 2: a browser that reports no page events (no watch): a document changed while measuring is still caught by the mark', async () => {
    const noEvents = {
      async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
        const c = await B().newContext(o);
        return new Proxy(c, {
          get(t, k) {
            if (k !== 'newPage') return Reflect.get(t, k);
            return async () => new Proxy(await t.newPage(), { get: (pg, key) => (key === 'on' ? undefined : Reflect.get(pg, key)) });
          },
        });
      },
    } as unknown as BrowserLike;
    const p = await audit('/real.html', noEvents, { collectors: [goesAway('/landed.html')] });
    expect([p.status, p.reason]).toEqual(['failed', MOVED_BY_ITSELF]);
    // …and a page that does not move is audited as before.
    const q = await audit('/real.html', noEvents);
    expect([q.status, linkPaths(q)]).toEqual(['ok', ['/real-only.html']]);
  }, 60_000);

  it('Sol r1 8: a same-origin frame sends the whole page to a time-out page 800 ms after it loads: never the first page\'s results with the other\'s document', async () => {
    const p = await audit('/frame-parent.html');
    // A visitor lands on the time-out page: measured there, or not testable; never mixed.
    if (p.status === 'ok') expect(linkPaths(p)).toEqual(['/timed-out-only.html']);
    else expect(p.reason).toBe(MOVED_BY_ITSELF);
  }, 60_000);

  it('Sol r1 8: a timer goes back (a cross-document history.back()) 1.6 s after load: one document measured, or not testable', async () => {
    const p = await audit('/hb-start.html');
    if (p.status === 'ok') expect([['/hb-page-only.html'], ['/hb-start-only.html']]).toContainEqual(linkPaths(p));
    else expect(p.reason).toBe(MOVED_BY_ITSELF);
  }, 60_000);
});

describe('the tests never follow anything: a page still loading itself is not tested (ruling 4)', () => {
  it('location.replace 300 ms after load: held, and not testable (never the page it was leaving)', async () => {
    siteLog.length = 0;
    const [run] = await probeOn('/replace.html', [where]);
    expect(run!.findings).toEqual([stillLoading]);
    expect(sent('/landed.html')).toEqual([]);
  }, 60_000);

  it.each(['/event.html', '/event-slow.html'])('a blocked bot verification stops tests on %s, even when the interstitial never navigates', async (path) => {
    siteLog.length = 0;
    const [run] = await probeOn(path, [where]);
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', loadFailure: 'challenge', detail: expect.stringContaining(BOT_CHECK) })]);
    expect(siteLog.filter((l) => l.startsWith('POST'))).toEqual([]);
  }, 60_000);

  it('only exact documented paths on the page host count; every proof remains blocked', async () => {
    for (const [proof, bot] of [
      ['/_sec/verify?token=1', true],
      ['/cdn-cgi/challenge-platform/h/g/verify', true],
      ['/_sec/verify-delete', false],
      ['/cdn-cgi/challenge-platformish/verify', false],
      [`${blocked.origin}/_sec/verify`, false],
      [`${site.origin.replace('127.0.0.1', 'localhost')}/_sec/verify`, false],
    ] as const) {
      siteLog.length = 0;
      refusedLog.length = 0;
      const [run] = await probeOn(`/bot-proof.html?proof=${encodeURIComponent(proof)}`, [where]);
      expect(run!.findings[0]!.status).toBe(bot ? 'not_testable' : 'no_failures_found');
      if (bot) expect(run!.findings[0]!.detail).toContain(BOT_CHECK);
      expect([...siteLog, ...refusedLog].filter((l) => l.startsWith('POST'))).toEqual([]);
    }
  }, 60_000);

  it('a delayed verification decision is settled before any test runs on the interstitial', async () => {
    const delayed: BrowserLike = {
      async newContext(o) {
        const c = await B().newContext(o);
        const route = c.route!.bind(c);
        c.route = (pattern, handler) => route(pattern, (r) => { setTimeout(() => { void handler(r); }, 1500); });
        return c;
      },
    };
    const [run] = await probeOn(`/bot-proof.html?proof=${encodeURIComponent('/_sec/verify')}`, [where], delayed);
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(BOT_CHECK) })]);
  }, 60_000);

  it.each(['/event.html', '/cf-challenge.html'])('a detected bot check on %s ends the group, without requesting another session', async (path) => {
    let retries = 0;
    const [run] = await runProbes(B(), [{ url: `${site.origin}${path}`, index: 0 }], [where], {
      ...OPTS, refusedRetry: async () => { retries++; return null; },
    });
    expect(run!.findings.every((f) => f.status === 'not_testable')).toBe(true);
    expect(retries).toBe(0);
  }, 60_000);

  it('a challenge landing stops before politeness retries a 403, even after earlier successes', async () => {
    const url = `${site.origin}/cf-block.html`;
    const pace = createPace({ concurrency: 1, retries: 1, backoffMs: 1, maxWaitMs: 1 });
    await pace.load(url, async () => true, () => ({ status: 200, retryAfter: null }));
    siteLog.length = 0;
    try {
      const [run] = await runProbes(B(), [{ url, index: 0 }], [where], { ...OPTS, pace });
      expect(run!.findings[0]!.detail).toContain(BOT_CHECK);
      expect(sent('/cf-block.html')).toHaveLength(1);
    } finally {
      pace.stop();
    }
  }, 60_000);

  it('the audit reaches the real page, but its cookies are never replayed to the tests', async () => {
    const p = await audit('/event.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/event-only.html']]);
    const [run] = await probeOn('/event.html', [where]);
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(BOT_CHECK) })]);
  }, 60_000);

  it('a page that reloads itself once 300 ms after load: not testable', async () => {
    const [run] = await probeOn('/reload-once.html', [where]);
    expect(run!.findings).toEqual([stillLoading]);
  }, 60_000);

  it('Sol r1 2: a page script submits a GET form 200 ms after load: never sent, and not testable', async () => {
    siteLog.length = 0;
    const [run] = await probeOn('/form-get.html', [where]);
    expect(sent('/process')).toEqual([]);
    expect(run!.findings).toEqual([stillLoading]);
  }, 60_000);

  it('Sol r1 6: a replace 100 ms in, before the load event (a 2 s image holds it): held, not testable', async () => {
    siteLog.length = 0;
    const [run] = await probeOn('/preload-replace.html', [where]);
    expect(run!.findings).toEqual([stillLoading]);
    expect(sent('/real.html')).toEqual([]);
  }, 60_000);

  it('Sol r1 3: a replace at 600 ms to a slow destination: held, not testable (the interstitial is never tested)', async () => {
    const [run] = await probeOn('/replace-slow.html', [where]);
    expect(run!.findings).toEqual([stillLoading]);
  }, 60_000);

  it('Sol r1 5: a fast client redirect to a 404 or a 202: held, not testable, never tested as either page', async () => {
    for (const path of ['/to-404.html', '/to-202.html', '/to-cf.html']) {
      const [run] = await probeOn(path, [where]);
      expect(loadOutcome(run!)).toEqual([{ status: 'not_testable', loadFailure: 'not-loaded', detail: expect.stringContaining(LOADING_ITSELF) }]);
    }
  }, 90_000);

  it('Sol r1 7: a session that expires 700 ms after load: held, not testable, so no 2.2.1 result either way', async () => {
    const [timing] = await probeOn('/redirect-700.html', [timingProbe]);
    expect(timing!.findings.every((f) => f.status === 'not_testable' && f.detail?.includes(LOADING_ITSELF))).toBe(true);
  }, 60_000);

  it('Sol r1 8: a frame that sends the page away 800 ms after it loads (held): the tests never see the time-out page', async () => {
    const [run] = await probeOn('/frame-parent.html', [where]);
    expect(run!.findings.some((f) => /timed-out-only/.test(f.detail ?? ''))).toBe(false);
  }, 60_000);

  it('Sol r1 8: a traversal: the first page goes on 100 ms after load (held), not testable', async () => {
    const [run] = await probeOn('/hb-start.html', [where]);
    expect(run!.findings).toEqual([stillLoading]);
  }, 60_000);

  it('Sol r1 9: a chain of 100 ms redirects: one document asked, not testable', async () => {
    siteLog.length = 0;
    const [run] = await probeOn('/chain.html?n=1', [where]);
    expect(run!.findings).toEqual([stillLoading]);
    expect(chainTop()).toBe(1);
  }, 60_000);

  it('a page that sends itself to a refused address: no result stands, and the address is never asked', async () => {
    refusedLog.length = 0;
    const [run] = await probeOn('/private.html', [where], gatedBrowser(B(), allowUrl));
    expect(run!.findings.filter((f) => f.status !== 'not_testable')).toEqual([]);
    expect(refusedLog).toEqual([]);
  }, 60_000);

  it('history.pushState and a fragment after load (no navigation to hold): the tests run', async () => {
    const [run] = await probeOn('/history.html', [where]);
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/history-help.html' })]);
  }, 60_000);

  it('a time limit 1.6 s after load is the page\'s own behaviour: the 2.2.1 test still fails it, and the keyboard test runs on the page', async () => {
    const [timing] = await probeOn('/session-timeout.html', [timingProbe]);
    expect(timing!.findings).toEqual([expect.objectContaining({ criterion: '2.2.1', status: 'failed', detail: expect.stringMatching(/sends the user to .*signed-out\.html after 1\.6 s/) })]);
    const [keys] = await probeOn('/session-timeout.html', [keyboardProbe]);
    expect(keys!.findings.some((f) => /did not load|loaded another page/.test(f.detail ?? ''))).toBe(false);
  }, 90_000);

  it('Known limit (docs/scoring.md, ruling 5): a redirect 1 s after load is held while the tests\' page settles, before the 2.2.1 test starts, so it is missed (not failed), as before', async () => {
    const [timing] = await probeOn('/redirect-1s.html', [timingProbe]);
    expect(timing!.findings.filter((f) => f.criterion === '2.2.1' && f.status === 'failed')).toEqual([]);
  }, 60_000);

  it('Sol r2 3: a page that replaces itself when a fetch answers 1.2 s after load (no timer, no time limit): no 2.2.1 failure', async () => {
    const [timing] = await probeOn('/fetch-replace.html', [timingProbe]);
    expect(timing!.findings.filter((f) => f.criterion === '2.2.1' && f.status === 'failed')).toEqual([]);
  }, 60_000);
});

describe('each test\'s document is checked after it, as the audit\'s (ruling 4: Sol r2 1, 5)', () => {
  const reloads: PageProbe = {
    id: 'reloads', criteria: ['0.0.2'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
    async run(ctx) {
      // The page reloads its own address while the test runs (the guard lets that go during a test).
      await ctx.page.evaluate(() => { location.reload(); }, undefined).catch(() => {});
      await ctx.page.waitForTimeout(800);
      return [{ criterion: '0.0.2', status: 'failed', detail: 'a failure found on the reloaded document' }];
    },
  };
  const submitsLater: PageProbe = {
    id: 'submits-later', criteria: ['0.0.3'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
    async run(ctx) {
      // A GET form to the page's own address, submitted by the page once the test is over (between tests).
      await ctx.page.evaluate(() => { setTimeout(() => { (document.forms[0] as HTMLFormElement).submit(); }, 50); }, undefined);
      return [{ criterion: '0.0.3', status: 'no_failures_found', detail: 'ok' }];
    },
  };

  it('Sol r2 1: a test whose page replaced itself while it ran: its failure does not stand, and the next test gets the page loaded again', async () => {
    siteLog.length = 0;
    const runs = await probeOn('/form-same.html', [reloads, where]);
    expect(runs[0]!.findings).toEqual([expect.objectContaining({ criterion: '0.0.2', status: 'not_testable', detail: LOADED_DURING })]);
    expect(runs[1]!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: '/search-help.html' })]);
    // The runner's two loads and the page's own reload.
    expect(sent('/form-same.html')).toHaveLength(3);
  }, 60_000);

  it('Sol r2 5: after a reload during a test, a GET form the page submits to its own address between tests is never sent', async () => {
    siteLog.length = 0;
    await probeOn('/form-same.html', [reloads, submitsLater, where]);
    expect(siteLog.filter((l) => l.includes('/form-same.html?q='))).toEqual([]);
  }, 60_000);
});

describe('round 4 (Sol r3, lead rulings out/sol/selfnav-r3/rulings.md)', () => {
  it('Sol r3 2: rotating clearance is not handed over; both groups detect the blocked bot check', async () => {
    rotValid.clear();
    const p = await audit('/rot.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/event-only.html']]);
    const isolated = { ...where, id: 'isolated', isolate: true };
    const runs = await probeOn('/rot.html', [where, isolated]);
    expect(runs.flatMap((r) => r.findings)).toEqual([
      expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(BOT_CHECK) }),
      expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(BOT_CHECK) }),
    ]);
  }, 90_000);

  const reloadsAgain: PageProbe = {
    id: 'reloads-again', criteria: ['0.0.4'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
    async run(ctx) {
      // Its own reload (a new baseline)…
      await ctx.page.goto(ctx.page.url!(), { waitUntil: 'load' });
      await ctx.reloadedPage?.();
      // …then the page reloads itself.
      await ctx.page.evaluate(() => { setTimeout(() => location.reload(), 50); }, undefined);
      await ctx.page.waitForTimeout(800);
      return [{ criterion: '0.0.4', status: 'failed', detail: 'found on the page\'s own replacement' }];
    },
  };
  const ownReloadOnly: PageProbe = {
    ...reloadsAgain, id: 'own-reload-only',
    async run(ctx) {
      await ctx.page.goto(ctx.page.url!(), { waitUntil: 'load' });
      await ctx.reloadedPage?.();
      return [{ criterion: '0.0.4', status: 'failed', detail: 'found on the test\'s own reload' }];
    },
  };
  const keepsThenTimesOut: PageProbe = {
    id: 'keeps-then-times-out', criteria: ['0.0.5'], kind: 'interaction', tier: 'core', timeoutMs: 3000,
    async run(ctx) {
      await ctx.page.evaluate(() => { location.reload(); }, undefined).catch(() => {});
      await ctx.page.waitForTimeout(500);
      ctx.keep?.([{ criterion: '0.0.5', status: 'failed', detail: 'kept from the replacement' }]);
      await new Promise((r) => setTimeout(r, 10_000));
      return [];
    },
  };
  const leavesPageBusy: PageProbe = {
    id: 'leaves-page-busy', criteria: ['0.0.6'], kind: 'interaction', tier: 'core', timeoutMs: 15_000,
    async run(ctx) {
      await ctx.page.evaluate(() => { setTimeout(() => { const t = Date.now(); while (Date.now() - t < 8000); }, 0); }, undefined);
      return [{ criterion: '0.0.6', status: 'failed', detail: 'found before the page stopped answering' }];
    },
  };

  it('responsive content runs at both widths without a fingerprint baseline', async () => {
    const phone: PageProbe = { ...where, id: 'where-phone', viewport: { width: 390, height: 844 }, contextOptions: { isMobile: true, hasTouch: true } };
    const runs = await probeOn('/phone-menu.html', [where, phone]);
    expect(runs.flatMap((r) => r.findings.map((f) => f.status))).toEqual(['no_failures_found', 'no_failures_found']);
  }, 60_000);

  it('Sol r3 3: a test\'s own reload sets a new baseline; a reload by the page after it is not exempt', async () => {
    const [own] = await probeOn('/form-same.html', [ownReloadOnly]);
    expect(own!.findings).toEqual([expect.objectContaining({ status: 'failed', detail: 'found on the test\'s own reload' })]);
    const [again] = await probeOn('/form-same.html', [reloadsAgain]);
    expect(again!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: LOADED_DURING })]);
  }, 60_000);

  it('Sol r3 3: a page that replaced itself during a test that then times out keeps no failure', async () => {
    const [run] = await probeOn('/form-same.html', [keepsThenTimesOut]);
    expect(run!.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, 60_000);

  it('Sol r3 3: a page that does not answer after a test (\'hung\'): its results do not stand', async () => {
    const [run] = await probeOn('/form-same.html', [leavesPageBusy]);
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: UNCONFIRMED })]);
  }, 60_000);

  it('Sol r3 4: a script redirect to a sign-in page on another site: not testable, never that page\'s failures', async () => {
    const p = await audit('/to-other.html');
    expect(outcome(p)).toEqual({ status: 'failed', reason: OTHER_SITE, httpStatus: undefined });
  }, 60_000);

  it('Sol r3 5: a replacement 404 whose commit event is missed: the old 200 cannot be tied to the document marked, so not testable', async () => {
    const missesCommits = {
      async newContext(o: Parameters<BrowserLike['newContext']>[0]) {
        const c = await B().newContext(o);
        return new Proxy(c, {
          get(t, k) {
            if (k !== 'newPage') return Reflect.get(t, k);
            return async () => {
              const pg = await t.newPage();
              const on = pg.on!.bind(pg) as (ev: string, fn: (x: unknown) => void) => unknown;
              return new Proxy(pg, {
                get(target, key) {
                  if (key !== 'on') return Reflect.get(target, key);
                  return (ev: string, fn: (x: unknown) => void) => {
                    if (ev !== 'framenavigated') return on(ev, fn);
                    let seen = 0;
                    return on(ev, (f) => { if (seen++ === 0) fn(f); });
                  };
                },
              });
            };
          },
        });
      },
    } as unknown as BrowserLike;
    const p = await audit('/to-404.html', missesCommits);
    expect(outcome(p)).toEqual({ status: 'failed', reason: LANDING_UNCHECKED, httpStatus: undefined });
  }, 60_000);

  it('Sol r3 6 is superseded: the audit measures /home, tests load the requested address and stop on its redirect', async () => {
    const p = await audit('/root-redirect.html');
    expect([p.status, linkPaths(p)]).toEqual(['ok', ['/home-only.html']]);
    siteLog.length = 0;
    const [run] = await probeOn('/root-redirect.html', [where]);
    expect(run!.page).toBe(`${site.origin}/root-redirect.html`);
    expect(run!.findings).toEqual([stillLoading]);
    expect(sent('/home.html')).toEqual([]);
  }, 60_000);

  it('Sol r3 7: the scan cancelled while a test\'s page is still loading: the tests stop at once (the load\'s wait is cancelled)', async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const t0 = Date.now();
    const [run] = await probeOn('/hang.html', [where], B(), stop.signal);
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: CANCELLED })]);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 60_000);
});


describe('round 5: an owned reload gets the load checks again (Sol r4 2)', () => {
  it.each(['bot', 'bot-slow', 'cf', 'http', 'plain', 'self'])('a probe reload into %s cannot retain failures', async (answer) => {
    reloadAnswer = answer;
    reloadRequests = 0;
    let checked = false;
    const reload: PageProbe = {
      id: 'reload-check', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 10_000,
      async run(ctx) {
        await ctx.page.goto(ctx.url, { waitUntil: 'load' });
        await ctx.reloadedPage?.();
        checked = true;
        return [{ criterion: '0.0.1', status: 'failed', detail: 'failure from the unchecked reload' }];
      },
    };
    const [run] = await probeOn('/reload-check.html', [reload]);
    expect(checked).toBe(false);
    expect(run!.findings.every((f) => f.status === 'not_testable')).toBe(true);
    if (answer.startsWith('bot') || answer === 'cf') expect(run!.findings[0]!.detail).toContain(BOT_CHECK);
  }, 60_000);

  it('a bot check on an owned reload ends the remaining group without loading again', async () => {
    reloadAnswer = 'bot';
    reloadRequests = 0;
    const reload: PageProbe = {
      id: 'reload-and-stop', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 10_000,
      async run(ctx) {
        await ctx.page.goto(ctx.url, { waitUntil: 'load' });
        await ctx.reloadedPage?.();
        return [{ criterion: '0.0.1', status: 'failed', detail: 'unchecked reload' }];
      },
    };
    const runs = await probeOn('/reload-check.html', [reload, where]);
    expect(runs.flatMap((r) => r.findings).every((f) => f.status === 'not_testable')).toBe(true);
    expect(reloadRequests).toBe(2);
  }, 60_000);

  it('Sol r4 2: keep on the original page, then replacement, then timeout needs a final identity check', async () => {
    const keeps: PageProbe = {
      id: 'keeps-before-replacement', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 2000,
      async run(ctx) {
        ctx.keep?.([{ criterion: '0.0.1', status: 'failed', detail: 'kept on the original page' }]);
        await ctx.page.waitForTimeout(100);
        await ctx.page.evaluate(() => { location.reload(); }, undefined).catch(() => {});
        return new Promise(() => {});
      },
    };
    const [run] = await probeOn('/form-same.html', [keeps]);
    expect(run!.findings.every((f) => f.status === 'not_testable')).toBe(true);
  }, 60_000);
});
