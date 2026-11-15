// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// `ScanOptions.allowUrl` and `allowIp` on every document the browser loads (Plan 2, H0, from the
// hosted Worker's reviews): a server redirect is followed by the browser before any route handler sees
// the next hop (Playwright does not route redirect hops), so an address check on the first request is
// not enough: `https://public.example/go` → 302 → `http://169.254.169.254/…`. Here the refused address
// is a second fixture server (`blocked`, refused by its port), and its own request log is the proof.
// Frames from another site (`localhost` against `127.0.0.1`) run in their own process (out-of-process
// iframes), and so does a frame inside one of them.
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { discoverPages } from '../../src/crawl.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes, NO_DOCUMENT_GATE } from '../../src/probes/runner.js';
import { gatedBrowser, NOT_ALLOWED } from '../../src/navigationGate.js';
import { GATE_LOST } from '../../src/reconnect.js';
import { defaultAxeSource, scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer, type FixtureRoutes } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let blocked: Awaited<ReturnType<typeof startFixtureServer>>;
/** host + path of every request the fixture server got. */
const requests: string[] = [];
/** Every request the refused server got. */
const refusedLog: string[] = [];
const refused = () => [...refusedLog];
const count = (path: string) => requests.filter((r) => r.split(' ')[1] === path).length;
const allowUrl = async (url: string) => new URL(url).port !== new URL(blocked.origin).port;
const B = () => browser as unknown as BrowserLike;

const START = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Navigation gate</title>
<script type="speculationrules">{"prefetch":[{"source":"list","urls":["BLOCKED/nav/secret-spec","/nav/spec-go"],"eagerness":"immediate"}]}</script>
</head><body>
<main><h1>Navigation gate</h1><p><a href="/nav/a.html">A page</a></p>
<button type="button"></button>
<iframe title="A frame that redirects" src="/nav/frame-go"></iframe>
<iframe title="A frame from another site that redirects" src="CROSS/nav/frame-go"></iframe>
<iframe title="A frame from another site with its own frame" src="CROSS/nav/outer.html"></iframe></main></body></html>`;
// Windows the page opens by itself (a popup, a new tab, a form sent to a new tab), all to the refused server.
const POPUPS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Popups</title></head>
<body><main><h1>Popups</h1><button type="button"></button>
<a id="tab" target="_blank" href="BLOCKED/nav/secret-tab">A new tab</a>
<form id="f" target="_blank" method="get" action="BLOCKED/nav/secret-form"></form>
<script>window.open('BLOCKED/nav/secret-popup'); window.open('BLOCKED/nav/secret-noopener', '_blank', 'noopener');
document.getElementById('tab').click(); document.getElementById('f').submit();
setTimeout(function () { window.open('BLOCKED/nav/secret-late'); }, 300);</script></main></body></html>`;
// A page that adds a frame once it has loaded, then opens a window to the refused server.
const LATE_OPEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Late window</title></head>
<body><main><h1>Late window</h1><p>Plain text.</p>
<script>setTimeout(function () { var f = document.createElement('iframe'); f.title = 'late'; f.src = '/nav/a.html'; document.body.appendChild(f); }, 100);
setTimeout(function () { window.open('BLOCKED/nav/secret-after-drop'); }, 700);</script></main></body></html>`;
const html = (body: string) => ({ type: 'text/html; charset=utf-8', body });
const routes: FixtureRoutes = {
  '/nav/start.html': html(START),
  '/nav/popups.html': html(POPUPS),
  '/nav/late-open.html': html(LATE_OPEN),
  '/nav/data-go': { type: 'text/html', status: 302, headers: { location: 'data:text/html,<title>x</title><h1>injected</h1>' } },
  '/nav/clip-go': { type: 'text/html', status: 302, headers: {} },
  '/nav/to-a': { type: 'text/html', status: 302, headers: { location: '/nav/a.html' } },
  '/nav/a.html': html('<!doctype html><html lang="en"><title>A</title><main><h1>A</h1><p>Plain text.</p></main></html>'),
  '/nav/outer.html': html('<!doctype html><html lang="en"><title>Outer</title><iframe title="inner" src="/nav/frame-go"></iframe></html>'),
  '/nav/frame-go': { type: 'text/html', status: 302, headers: {} },
  '/nav/spec-go': { type: 'text/html', status: 302, headers: {} },
  '/nav/go': { type: 'text/html', status: 302, headers: {} },
  '/nav/hop': { type: 'text/html', status: 301, headers: { location: '/nav/go' } },
  '/robots.txt': { type: 'text/plain', status: 302, headers: {} },
  '/sitemap.xml': { type: 'text/plain', status: 302, headers: {} },
};

beforeAll(async () => {
  server = await startFixtureServer('probes', routes, { onRequest: (req: IncomingMessage) => requests.push(`${req.headers.host} ${new URL(req.url ?? '/', 'http://x').pathname}`) });
  blocked = await startFixtureServer('probes', {}, { onRequest: (req: IncomingMessage) => refusedLog.push(`${req.headers.host} ${req.url}`) });
  const cross = server.origin.replace('127.0.0.1', 'localhost');
  routes['/nav/start.html']!.body = START.replaceAll('BLOCKED', blocked.origin).replaceAll('CROSS', cross);
  const clip = new Uint8Array(await readFile(new URL('../fixtures/keyboard/clip.webm', import.meta.url)));
  routes['/nav/clip.webm'] = { type: 'video/webm', body: clip };
  routes['/nav/clip-go']!.headers = { location: `${blocked.origin}/nav/clip.webm` };
  routes['/nav/popups.html']!.body = POPUPS.replaceAll('BLOCKED', blocked.origin);
  routes['/nav/late-open.html']!.body = LATE_OPEN.replaceAll('BLOCKED', blocked.origin);
  for (const [path, to] of [['/nav/frame-go', 'secret-frame'], ['/nav/spec-go', 'secret-spec-hop'], ['/nav/go', 'secret-top'], ['/robots.txt', 'secret-robots'], ['/sitemap.xml', 'secret-sitemap']] as const) {
    routes[path]!.headers = { location: `${blocked.origin}/nav/${to}` };
  }
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await blocked?.close();
});

const reset = () => {
  requests.length = 0;
  refusedLog.length = 0;
};

describe('allowUrl on every document the browser loads', () => {
  it('frames (same site, another site, a frame inside one) that redirect to a refused address, and speculation rules, never reach it: in the audit (both widths), the evidence pass and a probe', async () => {
    reset();
    const images: string[] = [];
    const report = await scanSite(`${server.origin}/nav/start.html`, {
      browser: B(), maxPages: 1, allowUrl, documents: false, probes: [keyboardProbe],
      evidence: { sink: (id: string) => { images.push(id); } },
    });
    expect(report.pages[0]!.status).toBe('ok');
    // Every context loaded the page and its three frames (four redirects each): 2 audit widths, the probe, the evidence pass.
    expect(count('/nav/frame-go')).toBeGreaterThanOrEqual(4 * 3);
    expect(count('/nav/outer.html')).toBeGreaterThanOrEqual(4);
    expect(images.length).toBeGreaterThan(0);
    expect(refused()).toEqual([]);
  }, 120_000);

  it('a start page whose redirects end on a refused address is not loaded, and the address is never asked', async () => {
    reset();
    const report = await scanSite(`${server.origin}/nav/hop`, { browser: B(), maxPages: 1, allowUrl, documents: false, probes: false });
    expect(report.pages[0]!.status).not.toBe('ok');
    expect(count('/nav/go')).toBeGreaterThanOrEqual(1);
    expect(refused()).toEqual([]);
  }, 60_000);

  it('robots.txt and sitemap redirects to a refused address are not followed', async () => {
    reset();
    await discoverPages(`${server.origin}/nav/start.html`, { browser: B(), maxPages: 3, userAgent: 'grnted-test', allowUrl });
    expect(count('/robots.txt')).toBe(1);
    expect(count('/sitemap.xml')).toBe(1);
    expect(refused()).toEqual([]);
  }, 60_000);

  it('windows the page opens (window.open, noopener, target=_blank, a form) never reach a refused address: discovery, the audit (both widths) and the evidence pass', async () => {
    reset();
    const images: string[] = [];
    const report = await scanSite(`${server.origin}/nav/popups.html`, {
      browser: B(), maxPages: 1, allowUrl, documents: false, probes: false,
      evidence: { sink: (id: string) => { images.push(id); } },
    });
    expect(report.pages[0]!.status).toBe('ok');
    // Discovery (no sitemap: the home page's links), two audit widths and the evidence pass loaded it.
    expect(count('/nav/popups.html')).toBeGreaterThanOrEqual(4);
    expect(images.length).toBeGreaterThan(0);
    expect(refused()).toEqual([]);
  }, 120_000);

  it('a document gate that could not start (no CDP session for the page): the page is not loaded for scoring', async () => {
    const noGate = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const context = await browser.newContext(o);
        return Object.assign(context, { newCDPSession() { return Promise.reject(new Error('no CDP here')); } });
      },
      newBrowserCDPSession: () => browser.newBrowserCDPSession(),
    } as unknown as BrowserLike;
    const report = await scanSite(`${server.origin}/nav/a.html`, { browser: noGate, maxPages: 1, allowUrl, documents: false, probes: false });
    expect(report.pages.map((p) => [p.status, p.reason])).toEqual([['failed', NOT_ALLOWED]]);
  }, 60_000);

  it('a gate session that is lost while allowUrl decides a redirect hop: the page does not stand', async () => {
    const sessions: { detach(): Promise<void>; on(event: 'close', fn: () => void): unknown }[] = [];
    const losing = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const context = await browser.newContext(o);
        const open = context.newCDPSession.bind(context);
        return Object.assign(context, { async newCDPSession(page: Parameters<typeof open>[0]) { const s = await open(page); sessions.push(s); return s; } });
      },
      newBrowserCDPSession: () => browser.newBrowserCDPSession(),
    } as unknown as BrowserLike;
    const decide = async (url: string) => {
      // The session is ended while the hop waits for this answer (Chromium finishes the detach only
      // once the paused hop is decided, so it is not awaited here; its close is, for at most 2 s).
      if (new URL(url).pathname === '/nav/a.html') {
        for (const s of sessions.splice(0)) {
          const closed = new Promise<void>((r) => { s.on('close', () => r()); setTimeout(r, 2000); });
          void s.detach().catch(() => {});
          await closed;
        }
      }
      return allowUrl(url);
    };
    // The audit alone, with a short load time-out.
    const page = await auditPage(gatedBrowser(losing, decide), `${server.origin}/nav/to-a`, { userAgent: 'grnted-test', axeSource: await defaultAxeSource(), timeoutMs: 8000 });
    // Not loaded, and said as a lost session (what a browser that closes does): the scan audits it
    // again in a new context, and gives no score when that fails too (never a refusal of the site).
    expect([page.status, page.reason]).toEqual(['failed', GATE_LOST]);
  }, 60_000);

  it('the browser-level session lost after the page loaded: a window the page opens later never reaches a refused address, and the page does not stand', async () => {
    reset();
    const sessions: { detach(): Promise<void>; on(event: 'close', fn: () => void): unknown }[] = [];
    const losing = {
      newContext: (o: Parameters<Browser['newContext']>[0]) => browser.newContext(o),
      async newBrowserCDPSession() { const s = await browser.newBrowserCDPSession(); sessions.push(s); return s; },
    } as unknown as BrowserLike;
    // The window hold is ended while the page's late frame waits for allowUrl (the page itself loaded).
    const decide = async (url: string) => {
      if (new URL(url).pathname === '/nav/a.html') {
        for (const s of sessions.splice(0)) {
          const closed = new Promise<void>((r) => { s.on('close', () => r()); setTimeout(r, 2000); });
          void s.detach().catch(() => {});
          await closed;
        }
      }
      return allowUrl(url);
    };
    const page = await auditPage(gatedBrowser(losing, decide), `${server.origin}/nav/late-open.html`, { userAgent: 'grnted-test', axeSource: await defaultAxeSource(), timeoutMs: 8000 });
    expect([page.status, page.reason]).toEqual(['failed', GATE_LOST]);
    expect(count('/nav/late-open.html')).toBeGreaterThanOrEqual(1);
    // Past the page's own window.open (700 ms after load).
    await new Promise((r) => setTimeout(r, 1500));
    expect(refused()).toEqual([]);
  }, 60_000);

  it('a redirect to a data: document is not audited', async () => {
    const report = await scanSite(`${server.origin}/nav/data-go`, { browser: B(), maxPages: 1, allowUrl, documents: false, probes: false });
    expect(report.pages.map((p) => p.status)).toEqual(['failed']);
  }, 60_000);

  it('probes on a browser that cannot check documents before they load: the page is not loaded, no result stands', async () => {
    // The first CDP session of each context (the gate's) cannot be opened; the request guard's can.
    const noGate = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const context = await browser.newContext(o);
        const open = context.newCDPSession.bind(context);
        let n = 0;
        return Object.assign(context, {
          newCDPSession(page: Parameters<typeof open>[0]) {
            if (n++ === 0) return Promise.reject(new Error('no CDP here'));
            return open(page);
          },
        });
      },
    } as unknown as BrowserLike;
    reset();
    const [run] = await runProbes(gatedBrowser(noGate, allowUrl), [{ url: `${server.origin}/nav/a.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    // The page is not loaded at all: no result of any kind.
    expect(run!.findings.filter((f) => f.status !== 'not_testable')).toEqual([]);
    expect(count('/nav/a.html')).toBe(0);
    expect(run!.findings.filter((f) => f.status === 'not_testable').map((f) => f.detail)).toContain(NO_DOCUMENT_GATE);
  }, 60_000);
});

// The AI frame sampler's allowUrl test lives with the AI code (closed AI package, framesNavigationGate.test.ts).

describe('allowIp: the address the browser connected to (DNS rebinding)', () => {
  // allowUrl passes the host (its name looked public); the browser then connected to a loopback address.
  const allowIp = (ip: string) => !(ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.'));

  it('a page served from a refused address never reaches axe: it is reported as not loaded', async () => {
    reset();
    const report = await scanSite(`${server.origin}/nav/a.html`, { browser: B(), maxPages: 1, allowUrl: async () => true, allowIp, documents: false, probes: [keyboardProbe] });
    expect(report.pages.map((p) => p.status)).toEqual(['failed']);
    // Refused before its body reached the page (Chromium's class of the address: loopback).
    expect(report.pages[0]!.reason).toBe(NOT_ALLOWED);
    // A probe on it gives no result at all (the page never loads for it).
    const [run] = await runProbes(gatedBrowser(B(), async () => true, { allowIp }), [{ url: `${server.origin}/nav/a.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    expect(run!.findings.filter((f) => f.status !== 'not_testable')).toEqual([]);
  }, 60_000);

  it('the same page with every address allowed loads (the control)', async () => {
    reset();
    const report = await scanSite(`${server.origin}/nav/a.html`, { browser: B(), maxPages: 1, allowUrl: async () => true, allowIp: () => true, documents: false, probes: false });
    expect(report.pages.map((p) => p.status)).toEqual(['ok']);
  }, 60_000);
});
