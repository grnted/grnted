// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The site owner's scanner key (`keyedBrowser`, `keyedFetch`): a header the owner allowed in their
// firewall, sent ONLY on requests to the hosts they verified (documents, subresources, scripts' own
// fetches), never to another host, and never past a redirect that leaves those hosts. A real Chromium
// against one fixture server under two names: `127.0.0.1` is the owner's site (covered), `localhost` is
// everyone else (a CDN, a third party). The server's own request log, with the header it got, is the proof.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatedBrowser } from '../../src/navigationGate.js';
import { keyedBrowser, keyedFetch, type ScopedHeader } from '../../src/ownerKey.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer, type FixtureRoutes } from '../helpers/fixtureServer.js';

const VALUE = 'owner-header-test-value';
const NAME = 'X-Grnted-Key';
let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let IN = '';
let OUT = '';
/** `<host> <path> <key header or ->` for every request the server got. */
const log: string[] = [];
const header: ScopedHeader = { name: NAME, value: VALUE, covers: (url) => new URL(url).hostname === '127.0.0.1' };
const B = () => browser as unknown as BrowserLike;
const seen = (host: 'in' | 'out', path: string) => log.filter((l) => l.startsWith(`${host === 'in' ? '127.0.0.1' : 'localhost'}:`) && l.split(' ')[1] === path);
const keyOn = (host: 'in' | 'out', path: string) => seen(host, path).map((l) => l.split(' ')[2]);

const html = (body: string) => ({ type: 'text/html; charset=utf-8', body });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const START = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Owner key</title>
<link rel="stylesheet" href="/k/to-out.css">
<link rel="stylesheet" href="OUT/k/out.css">
<script src="OUT/k/back-in.js"></script>
</head><body><main><h1>Owner key</h1>
<img alt="" src="/k/own.png"><img alt="" src="OUT/k/cdn.png">
<script>fetch('/k/api').catch(function(){}); fetch('OUT/k/third-party-api').catch(function(){});</script>
</main></body></html>`;
const routes: FixtureRoutes = {
  '/k/start.html': html(START),
  '/k/own.png': { type: 'image/png', body: PNG },
  '/k/cdn.png': { type: 'image/png', body: PNG },
  '/k/api': { type: 'application/json', body: '{}' },
  '/k/third-party-api': { type: 'application/json', body: '{}' },
  '/k/out.css': { type: 'text/css', body: 'p{}' },
  '/k/landed.css': { type: 'text/css', body: 'p{}' },
  '/k/landed-in.js': { type: 'text/javascript', body: '' },
  '/k/landed.html': html('<!doctype html><html lang="en"><title>Landed</title><main><h1>Landed</h1></main></html>'),
  '/k/back.html': html('<!doctype html><html lang="en"><title>Back</title><main><h1>Back</h1><img alt="" src="/k/own.png"></main></html>'),
  // A page that sends data to its own (covered) host: only its GET carries the key (Paul, 2026-11-05).
  '/k/write.html': html(`<!doctype html><html lang="en"><title>Write</title><main><h1>Write</h1>
<script>fetch('/k/w-get').catch(function(){}); fetch('/k/w-post', { method: 'POST', body: 'x' }).catch(function(){});
fetch('/k/w-put', { method: 'PUT', body: 'x' }).catch(function(){}); navigator.sendBeacon('/k/w-beacon', 'x');</script></main></html>`),
  '/k/w-get': { type: 'text/plain', body: '' },
  '/k/w-post': { type: 'text/plain', body: '' },
  '/k/w-put': { type: 'text/plain', body: '' },
  '/k/w-beacon': { type: 'text/plain', body: '' },
  // Filled in beforeAll (they need the other name's origin).
  '/k/to-out.css': { type: 'text/css', status: 302, headers: {} },
  '/k/back-in.js': { type: 'text/javascript', status: 302, headers: {} },
  '/k/go-out': { type: 'text/html', status: 302, headers: {} },
  '/k/go-in': { type: 'text/html', status: 302, headers: {} },
  '/k/fetch-out': { type: 'text/plain', status: 302, headers: {} },
};

beforeAll(async () => {
  server = await startFixtureServer('probes', routes, {
    onRequest: (req: IncomingMessage) => {
      const k = req.headers[NAME.toLowerCase()];
      log.push(`${req.headers.host} ${new URL(req.url ?? '/', 'http://x').pathname} ${typeof k === 'string' ? k : '-'}`);
    },
  });
  IN = server.origin;
  OUT = server.origin.replace('127.0.0.1', 'localhost');
  routes['/k/start.html']!.body = START.replaceAll('OUT', OUT);
  routes['/k/to-out.css']!.headers = { location: `${OUT}/k/landed.css` };
  routes['/k/back-in.js']!.headers = { location: `${IN}/k/landed-in.js` };
  routes['/k/go-out']!.headers = { location: `${OUT}/k/landed.html` };
  routes['/k/go-in']!.headers = { location: `${IN}/k/back.html` };
  routes['/k/fetch-out']!.headers = { location: `${OUT}/k/landed.css` };
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function load(b: BrowserLike, url: string): Promise<void> {
  const ctx = await b.newContext({ viewport: { width: 800, height: 600 } });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(300);
  } finally {
    await ctx.close();
  }
}

describe('keyedBrowser: the owner key goes only to the covered hosts', () => {
  it('the page, its own subresources and its own fetches carry the key; other hosts never do', async () => {
    log.length = 0;
    await load(keyedBrowser(B(), header), `${IN}/k/start.html`);
    expect(keyOn('in', '/k/start.html')).toEqual([VALUE]);
    expect(keyOn('in', '/k/own.png')).toEqual([VALUE]);
    expect(keyOn('in', '/k/api')).toEqual([VALUE]);
    // Third-party hosts: never.
    expect(keyOn('out', '/k/cdn.png')).toEqual(['-']);
    expect(keyOn('out', '/k/out.css')).toEqual(['-']);
    expect(keyOn('out', '/k/third-party-api')).toEqual(['-']);
    expect(log.filter((l) => l.startsWith('localhost:') && !l.endsWith(' -'))).toEqual([]);
  }, 60_000);

  it('only GET (and HEAD) requests carry the key: a covered POST, PUT or beacon goes without it', async () => {
    log.length = 0;
    await load(keyedBrowser(B(), header), `${IN}/k/write.html`);
    expect(keyOn('in', '/k/write.html')).toEqual([VALUE]);
    expect(keyOn('in', '/k/w-get')).toEqual([VALUE]);
    expect(keyOn('in', '/k/w-post')).toEqual(['-']);
    expect(keyOn('in', '/k/w-put')).toEqual(['-']);
    expect(keyOn('in', '/k/w-beacon')).toEqual(['-']);
  }, 60_000);

  it('a covered subresource that redirects to another host does not take the key with it; one coming back gets it', async () => {
    log.length = 0;
    await load(keyedBrowser(B(), header), `${IN}/k/start.html`);
    expect(keyOn('in', '/k/to-out.css')).toEqual([VALUE]);
    expect(keyOn('out', '/k/landed.css')).toEqual(['-']);
    // out → 302 → in: the covered hop is sent with it.
    expect(keyOn('out', '/k/back-in.js')).toEqual(['-']);
    expect(keyOn('in', '/k/landed-in.js')).toEqual([VALUE]);
  }, 60_000);

  it('a covered page that redirects to another host: the landing is asked without the key', async () => {
    log.length = 0;
    await load(keyedBrowser(B(), header), `${IN}/k/go-out`);
    expect(keyOn('in', '/k/go-out')).toEqual([VALUE]);
    expect(keyOn('out', '/k/landed.html')).toEqual(['-']);
  }, 60_000);

  it('another host that redirects to a covered page: the covered hop gets the key', async () => {
    log.length = 0;
    await load(keyedBrowser(B(), header), `${OUT}/k/go-in`);
    expect(keyOn('out', '/k/go-in')).toEqual(['-']);
    expect(keyOn('in', '/k/back.html')).toEqual([VALUE]);
    expect(keyOn('in', '/k/own.png')).toEqual([VALUE]);
  }, 60_000);

  it('works under the navigation gate (the scan\'s own CDP Fetch interception of documents)', async () => {
    log.length = 0;
    await load(gatedBrowser(keyedBrowser(B(), header), async () => true), `${IN}/k/go-out`);
    expect(keyOn('in', '/k/go-out')).toEqual([VALUE]);
    expect(keyOn('out', '/k/landed.html')).toEqual(['-']);
    log.length = 0;
    await load(gatedBrowser(keyedBrowser(B(), header), async () => true), `${IN}/k/start.html`);
    expect(keyOn('in', '/k/own.png')).toEqual([VALUE]);
    expect(keyOn('out', '/k/landed.css')).toEqual(['-']);
    expect(keyOn('out', '/k/cdn.png')).toEqual(['-']);
  }, 60_000);

  it('a context without CDP sessions sends no key at all (it fails safe, never open)', async () => {
    log.length = 0;
    const noCdp: BrowserLike = {
      async newContext(o) {
        const ctx = await B().newContext(o);
        return { newPage: () => ctx.newPage(), close: () => ctx.close() };
      },
    };
    await load(keyedBrowser(noCdp, header), `${IN}/k/start.html`);
    expect(keyOn('in', '/k/start.html')).toEqual(['-']);
    expect(log.filter((l) => !l.endsWith(' -'))).toEqual([]);
  }, 60_000);

  // Why the key is set at the CDP request stage and not with Playwright's route.continue({ headers }):
  // Playwright applies those headers to every redirect the request initiates, another host included.
  it('characterization: route.continue({ headers }) carries the header across an off-host redirect', async () => {
    log.length = 0;
    const ctx = await browser.newContext();
    try {
      await ctx.route('**/*', (route) => {
        const req = route.request();
        if (new URL(req.url()).hostname !== '127.0.0.1') return route.continue();
        return route.continue({ headers: { ...req.headers(), [NAME.toLowerCase()]: VALUE } });
      });
      const page = await ctx.newPage();
      await page.goto(`${IN}/k/go-out`);
    } finally {
      await ctx.close();
    }
    expect(keyOn('out', '/k/landed.html')).toEqual([VALUE]);
  }, 60_000);
});

describe('keyedFetch: the scan\'s own fetches', () => {
  const calls: { url: string; key: string | null; redirect: string | undefined }[] = [];
  const raw = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url: String(input), key: h.get(NAME), redirect: init?.redirect });
    return new Response('', { status: 200 });
  }) as typeof fetch;

  it('adds the key on a covered address only, and asks for redirects by hand when it does', async () => {
    calls.length = 0;
    const f = keyedFetch(raw, header);
    await f(`${IN}/robots.txt`, { headers: { 'user-agent': 'grnted-test' } });
    await f(`${OUT}/robots.txt`, { headers: { 'user-agent': 'grnted-test' } });
    expect(calls.map((c) => c.key)).toEqual([VALUE, null]);
    expect(calls[0]!.redirect).toBe('manual');
  });

  it('sends the key on GET and HEAD only: any other method to a covered address goes without it (a caller\'s own key stripped)', async () => {
    calls.length = 0;
    const f = keyedFetch(raw, header);
    await f(`${IN}/a`, { method: 'HEAD' });
    await f(`${IN}/b`, { method: 'POST', body: 'x' });
    await f(`${IN}/c`, { method: 'put', body: 'x', headers: { [NAME]: 'smuggled' } });
    await f(new Request(`${IN}/d`, { method: 'DELETE' }));
    expect(calls.map((c) => c.key)).toEqual([VALUE, null, null, null]);
  });

  it('strips a key a caller set itself on an address that is not covered', async () => {
    calls.length = 0;
    const f = keyedFetch(raw, header);
    await f(`${OUT}/x`, { headers: { [NAME]: 'smuggled' } });
    await f(new Request(`${OUT}/y`, { headers: { [NAME]: 'smuggled' } }));
    expect(calls.map((c) => c.key)).toEqual([null, null]);
  });

  it('follows a covered redirect by hand, hop by hop: the key goes no further than the covered hosts', async () => {
    log.length = 0;
    const f = keyedFetch(fetch, header);
    const res = await f(`${IN}/k/fetch-out`);
    expect(res.status).toBe(200);
    expect(keyOn('in', '/k/fetch-out')).toEqual([VALUE]);
    expect(keyOn('out', '/k/landed.css')).toEqual(['-']);
  });

  it('a caller that asks for manual redirects gets the 3xx back (the caller follows, hop by hop)', async () => {
    log.length = 0;
    const f = keyedFetch(fetch, header);
    const res = await f(`${IN}/k/fetch-out`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(seen('out', '/k/landed.css')).toEqual([]);
  });
});
