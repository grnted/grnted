// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Record once, test on the copy (src/replay), in real Chromium against a small site that counts every
// request it gets. What a second page load does to the site is the whole point: nothing.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { quietBrowser } from '../../src/analytics.js';
import { gatedBrowser, gateFailure } from '../../src/navigationGate.js';
import { createPace, gotoPolitely, type Pace, type PaceAnswer } from '../../src/pace.js';
import { createReplay, fileStore, REPLAY_MARK, type Replay, type ReplayOptions } from '../../src/replay/index.js';
import type { BrowserLike } from '../../src/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** One second of silence (8 kHz, 8 bit, mono): a file an audio element can load. */
const WAV = (() => {
  const data = Buffer.alloc(8000, 128);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(8000, 24); head.writeUInt32LE(8000, 28);
  head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
})();
const HOME = `<!doctype html><html lang="en"><head><title>Home</title><link rel="stylesheet" href="/moved.css"><script src="/app.js"></script></head>
<body><h1 id="h">Welcome</h1><img id="logo" src="/logo.png" alt="Logo"><button id="more">More</button><iframe title="Inner" src="/frame.html"></iframe>
<form method="post" action="/submit"><button id="send">Send</button></form></body></html>`;

let browser: Browser;
let server: Server;
let origin: string;
/** Requests the site got, by path (with the query), since the last `reset`. */
let hits: Record<string, number> = {};
/** What the site saw of each request (method, headers). */
let seen: { method: string; path: string; headers: IncomingMessage['headers'] }[] = [];
let flaky = 0;
let delayMs = 0;

function respond(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://x');
  const path = u.pathname + u.search;
  hits[path] = (hits[path] ?? 0) + 1;
  seen.push({ method: req.method ?? '', path, headers: req.headers });
  const send = (status: number, headers: Record<string, string>, body: string | Buffer = '') => { res.writeHead(status, headers); res.end(body); };
  const cookie = req.headers.cookie ?? '';
  switch (u.pathname) {
    case '/': return send(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=SECRET; Path=/' }, HOME);
    case '/old': return send(301, { location: '/' });
    case '/moved.css': return send(302, { location: '/assets/site.css' });
    // A redirect chain whose addresses hold the characters a CDP pattern treats as wildcards.
    case '/query.html': return send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Query</title><link rel="stylesheet" href="/q.css?v=1&k=a*b"><h1 id="h">Q</h1>');
    case '/q.css': return send(302, { location: '/assets/q2.css?from=q&star=*' });
    case '/assets/q2.css': return send(200, { 'content-type': 'text/css' }, 'h1{color:rgb(7, 8, 9)}');
    case '/assets/site.css': return send(200, { 'content-type': 'text/css' }, 'h1{background:url(bg.png)} h1{color:rgb(1, 2, 3)}');
    case '/assets/bg.png':
    case '/logo.png': return send(200, { 'content-type': 'image/png' }, PNG);
    case '/app.js': return send(200, { 'content-type': 'text/javascript' }, `window.ran=1;document.addEventListener('click',function(e){if(e.target.id==='more')fetch('/more.json').then(function(r){return r.text()}).then(function(t){document.title=t})});`);
    case '/more.json': return send(200, { 'content-type': 'application/json' }, `more ${hits[path]}`);
    case '/frame.html': return send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Frame</title><p>frame</p>');
    case '/submit': return send(200, { 'content-type': 'text/html' }, `<!doctype html><title>Sent ${hits[path]}</title>`);
    case '/time.html': return send(200, { 'content-type': 'text/html' }, `<!doctype html><title>Served ${hits[path]}</title><p>x</p>`);
    case '/flaky.html': return flaky-- > 0 ? send(503, { 'retry-after': '1' }, 'busy') : send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Flaky ok</title>');
    case '/slow-moved': { setTimeout(() => send(302, { location: '/time.html' }), delayMs); return; }
    case '/slow.html': { setTimeout(() => send(200, { 'content-type': 'text/html' }, `<!doctype html><title>Slow ${hits[path]}</title><img src="/logo.png" alt="">`), delayMs); return; }
    // A cookie check: a redirect until the cookie it sets comes back.
    case '/members': return /\bok=1\b/.test(cookie) ? send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Members</title>') : send(302, { location: '/members', 'set-cookie': 'ok=1; Path=/' });
    case '/private': return send(200, { 'content-type': 'text/plain' }, `private ${hits[path]}`);
    case '/big.bin': return send(200, { 'content-type': 'application/octet-stream' }, Buffer.alloc(3000, 1));
    case '/vendor.html': return send(200, { 'content-type': 'text/html' }, `<!doctype html><title>Vendor</title><link rel="stylesheet" href="http://vendor.example:${new URL(origin).port}/busy.css"><p>x</p>`);
    case '/busy.css': return send(429, { 'content-type': 'text/plain', 'retry-after': '1' }, 'Slow down');
    case '/media.html': return send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Media</title><audio id="a" src="/tone.wav" preload="auto"></audio><link rel="stylesheet" href="/two-ways.css"><p id="p">x</p>');
    case '/tone.wav': return send(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' }, WAV);
    // One address, two answers, no Vary: CSS for a stylesheet request, a refusal for a script's own fetch.
    case '/two-ways.css': return /^text\/css/.test(String(req.headers.accept ?? '')) ? send(200, { 'content-type': 'text/css' }, '#p{color:rgb(4, 5, 6)}') : send(403, { 'content-type': 'text/plain' }, 'not for scripts');
    default: return send(404, { 'content-type': 'text/plain' }, 'not here');
  }
}

beforeAll(async () => {
  server = createServer(respond);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // A second host name on the same server (a vendor's): another origin, at a loopback address.
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP vendor.example 127.0.0.1'] });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

beforeEach(() => {
  hits = {};
  seen = [];
  flaky = 0;
  delayMs = 0;
});

const settled = () => new Promise((r) => setTimeout(r, 250));
const open: BrowserContext[] = [];
/** One scan's replay over the shared browser; its contexts are closed with it. */
function scanReplay(opts: ReplayOptions = {}, wrap: (b: BrowserLike) => BrowserLike = (b) => b, base: BrowserLike = browser as unknown as BrowserLike): { replay: Replay; page(): Promise<Page>; end(): Promise<void> } {
  const replay = createReplay(opts);
  const wrapped = wrap(replay.browser(base));
  return {
    replay,
    async page() {
      const ctx = (await wrapped.newContext({ viewport: { width: 1280, height: 900 } })) as unknown as BrowserContext;
      open.push(ctx);
      return (await ctx.newPage()) as unknown as Page;
    },
    async end() {
      for (const c of open.splice(0)) await c.close().catch(() => {});
      await replay.close();
    },
  };
}

/** How many requests the site itself counted since the test began. */
const asked = () => Object.values(hits).reduce((a, b) => a + b, 0);

/** What the page under test looks like to a test: the things a replay must not change. */
const facts = (page: Page) => page.evaluate(() => ({
  url: location.href, title: document.title, ran: (window as unknown as { ran?: number }).ran,
  h1: getComputedStyle(document.getElementById('h')!).color,
  bg: getComputedStyle(document.getElementById('h')!).backgroundImage,
  logo: (document.getElementById('logo') as HTMLImageElement).naturalWidth,
  redirects: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).redirectCount,
  frames: window.frames.length,
}));

describe('record once, test on the copy', () => {
  it('loads a page from the site once: every later load, in any context, asks the site for nothing', async () => {
    const s = scanReplay();
    try {
      const first = await s.page();
      const resp1 = await first.goto(`${origin}/old`, { waitUntil: 'load' });
      await settled();
      const live = await facts(first);
      const once = { ...hits };
      expect(once).toEqual({ '/old': 1, '/': 1, '/moved.css': 1, '/assets/site.css': 1, '/assets/bg.png': 1, '/logo.png': 1, '/app.js': 1, '/frame.html': 1 });
      for (let n = 0; n < 3; n++) {
        const again = await s.page();
        const resp = await again.goto(`${origin}/old`, { waitUntil: 'load' });
        await settled();
        // The answer the engine reads (status, address, headers, the redirect it came through) is the same.
        expect([resp!.status(), resp!.url(), resp!.headers()['content-type'], resp!.request().redirectedFrom()?.url()]).toEqual([resp1!.status(), resp1!.url(), resp1!.headers()['content-type'], resp1!.request().redirectedFrom()?.url()]);
        expect(await facts(again)).toEqual(live);
        expect(again.frames().map((f) => f.url())).toEqual(first.frames().map((f) => f.url()));
      }
      expect(hits).toEqual(once);
      // The browser's own timing tells an answer from the copy from one the site sent: no request went out.
      const plain = await s.page();
      const fromCopy = await plain.goto(`${origin}/`, { waitUntil: 'load' });
      expect(resp1!.request().timing().requestStart).toBeGreaterThanOrEqual(0);
      expect(fromCopy!.request().timing()).toMatchObject({ requestStart: -1 });
      // So the pace controller is given no load time for it: the page limit is judged on the site's answers only.
      const answers: (PaceAnswer | null)[] = [];
      // The replay layer says which answers it gave: exactly, for one given at the route and for the end of a chain.
      expect([s.replay.copied(resp1), s.replay.copied(fromCopy), s.replay.copied(null), s.replay.copied({})]).toEqual([false, true, false, false]);
      const chain = await (await s.page()).goto(`${origin}/old`, { waitUntil: 'load' });
      expect(s.replay.copied(chain)).toBe(true);
      const heard: Pace = { ...createPace({ concurrency: 1, copied: (r) => s.replay.copied(r) }), load: async (_url, run, answer) => { const value = await run(); answers.push(answer(value)); return { value }; } };
      await gotoPolitely(heard, `${origin}/`, async () => resp1);
      await gotoPolitely(heard, `${origin}/`, async () => fromCopy);
      expect(answers.map((a) => [a?.status, typeof a?.loadMs, typeof a?.ttfbMs, a?.copied])).toEqual([[200, 'number', 'number', undefined], [200, 'undefined', 'undefined', true]]);
      // With replay off the controller is never told of a copy: the same answer is timed like any other.
      const off: (PaceAnswer | null)[] = [];
      const plainPace: Pace = { ...createPace({ concurrency: 1 }), load: async (_url, run, answer) => { const value = await run(); off.push(answer(value)); return { value }; } };
      await gotoPolitely(plainPace, `${origin}/`, async () => fromCopy);
      expect([typeof off[0]?.loadMs, off[0]?.copied]).toEqual(['number', undefined]);
      // Eight answers were recorded on the first load, and nothing has been recorded since.
      expect(s.replay.stats()).toMatchObject({ recorded: 8, volatile: 0, leaky: 0 });
      expect(s.replay.stats().replayedDocuments).toBeGreaterThan(10);
      expect(s.replay.ready(`${origin}/old`)).toBe(true);
      expect(s.replay.ready(`${origin}/`)).toBe(true);
      expect(s.replay.ready(`${origin}/never`)).toBe(false);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('never stores or replays a cookie, and never lets its own mark reach the site', async () => {
    const s = scanReplay();
    try {
      const first = await s.page();
      await first.goto(`${origin}/old`, { waitUntil: 'load' });
      expect(await first.evaluate(() => document.cookie)).toBe('sid=SECRET');
      await settled();
      const again = await s.page();
      await again.goto(`${origin}/old`, { waitUntil: 'load' });
      expect(await again.evaluate(() => document.cookie)).toBe('');
      // A redirect whose target the copy cannot answer goes to the site without the mark.
      await again.goto(`${origin}/private`, { waitUntil: 'load' });
      expect(seen.every((r) => r.headers[REPLAY_MARK] === undefined)).toBe(true);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('sends what the copy cannot answer to the site, records it, and never replays anything but GET and HEAD', async () => {
    const s = scanReplay();
    try {
      const first = await s.page();
      await first.goto(`${origin}/`, { waitUntil: 'load' });
      await settled();
      // A request an interaction makes for the first time goes live, and is recorded.
      const second = await s.page();
      await second.goto(`${origin}/`, { waitUntil: 'load' });
      await second.click('#more');
      await expect.poll(() => second.title()).toBe('more 1');
      await settled();
      const third = await s.page();
      await third.goto(`${origin}/`, { waitUntil: 'load' });
      await third.click('#more');
      await expect.poll(() => third.title()).toBe('more 1');
      expect(hits['/more.json']).toBe(1);
      // A form post reaches the site every time (here nothing guards it), and its answer is never kept.
      await third.click('#send');
      await expect.poll(() => third.title()).toBe('Sent 1');
      const fourth = await s.page();
      await fourth.goto(`${origin}/`, { waitUntil: 'load' });
      await fourth.click('#send');
      await expect.poll(() => fourth.title()).toBe('Sent 2');
      expect(hits['/']).toBe(1);
      // A request with credentials is the visitor's own: live every time.
      for (const p of [third, fourth]) {
        const body = await p.evaluate(() => fetch('/private', { headers: { Authorization: 'Bearer x' } }).then((r) => r.text()));
        expect(body).toBe(`private ${hits['/private']}`);
      }
      expect(hits['/private']).toBe(2);
      // The count of what went to the site is the site's own count: first requests, the redirect's second
      // address, the posts and the requests with credentials. Everything else came from the copy.
      await settled();
      expect(s.replay.stats().sent).toBe(asked());
      expect(asked()).toBe(12);
      expect(s.replay.stats().replayed).toBeGreaterThan(asked());
    } finally {
      await s.end();
    }
  }, 60_000);

  it('two pages loading the same address at once ask the site once', async () => {
    delayMs = 300;
    const s = scanReplay();
    try {
      const [a, b] = await Promise.all([s.page(), s.page()]);
      const [ra, rb] = await Promise.all([a.goto(`${origin}/slow.html`, { waitUntil: 'load' }), b.goto(`${origin}/slow.html`, { waitUntil: 'load' })]);
      expect([ra!.status(), rb!.status(), await a.title(), await b.title()]).toEqual([200, 200, 'Slow 1', 'Slow 1']);
      expect(hits).toEqual({ '/slow.html': 1, '/logo.png': 1 });
      expect(s.replay.stats().waited).toBeGreaterThan(0);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('a request already on its way when a redirect is first recorded goes to the site unmarked, and every request is counted once', async () => {
    delayMs = 700;
    const s = scanReplay();
    try {
      let events = 0;
      const pages = [await s.page(), await s.page(), await s.page()];
      for (const p of pages) p.context().on('request', () => { events++; });
      // Two pages ask for the same redirecting address at once: the second waits for the first's recording.
      // The browser-level session that answers redirects is opened when the first redirect is recorded, and
      // it does not see a request that began before it: the second page's request is the site's to answer.
      await Promise.all([
        pages[0]!.goto(`${origin}/slow-moved`, { waitUntil: 'load' }),
        new Promise((r) => setTimeout(r, 150)).then(() => pages[1]!.goto(`${origin}/slow-moved`, { waitUntil: 'load' })),
      ]);
      await settled();
      // A request that begins afterwards has its redirect and the page it leads to from the copy.
      await pages[2]!.goto(`${origin}/slow-moved`, { waitUntil: 'load' });
      await settled();
      expect(await Promise.all(pages.map((p) => p.title()))).toEqual(['Served 1', 'Served 2', 'Served 1']);
      expect(seen.every((r) => r.headers[REPLAY_MARK] === undefined)).toBe(true);
      expect(hits).toEqual({ '/slow-moved': 2, '/time.html': 2 });
      const st = s.replay.stats();
      expect(st.waited).toBeGreaterThan(0);
      // Three loads of two requests each: every one of the six is counted once, as sent or as answered from the copy.
      expect(events).toBe(6);
      expect([st.sent, st.replayed]).toEqual([4, 2]);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('never sends its mark to the site, however a redirect\'s first recording and the requests for it fall', async () => {
    // Many requests for a redirecting address, begun before, while and after its redirect is first recorded
    // (when the browser-level session is switched on), from pages loaded before that: the session cannot
    // pause what such a page asks for, so none of it may be marked.
    for (let round = 0; round < 6; round++) {
      delayMs = 60 + round * 40;
      const s = scanReplay();
      try {
        const pages = [await s.page(), await s.page(), await s.page()];
        await Promise.all(pages.map((p) => p.goto(`${origin}/time.html`, { waitUntil: 'load' })));
        const burst = (p: Page, n: number, gap: number) => p.evaluate(async ({ n, gap }) => {
          const all: Promise<number>[] = [];
          for (let i = 0; i < n; i++) {
            all.push(fetch('/slow-moved').then((r) => r.status, () => 0));
            await new Promise((r) => setTimeout(r, gap));
          }
          return Promise.all(all);
        }, { n, gap });
        const statuses = (await Promise.all([burst(pages[0]!, 12, 15), burst(pages[1]!, 12, 22), burst(pages[2]!, 12, 31)])).flat();
        expect(statuses.every((x) => x === 200)).toBe(true);
        await settled();
        expect(seen.filter((r) => r.headers[REPLAY_MARK] !== undefined).map((r) => r.path)).toEqual([]);
        // A page loaded now (the session is on, and pauses the address) has the redirect from the copy;
        // a page loaded before the session still asks the site, unmarked.
        const before = hits['/slow-moved']!;
        const late = await s.page();
        await late.goto(`${origin}/time.html`, { waitUntil: 'load' });
        expect(await late.evaluate(() => fetch('/slow-moved').then((r) => r.status))).toBe(200);
        expect(hits['/slow-moved']).toBe(before);
        expect(await pages[0]!.evaluate(() => fetch('/slow-moved').then((r) => r.status))).toBe(200);
        expect(hits['/slow-moved']).toBe(before + 1);
        // A redirect first recorded now, asked for again by the page that was loaded under the session.
        expect(await late.evaluate(() => fetch('/old').then((r) => r.status))).toBe(200);
        await settled();
        const old = hits['/old'];
        expect(await late.evaluate(() => fetch('/old').then((r) => r.status))).toBe(200);
        expect(hits['/old']).toBe(old);
        expect(seen.filter((r) => r.headers[REPLAY_MARK] !== undefined).map((r) => r.path)).toEqual([]);
      } finally {
        await s.end();
      }
      hits = {};
      seen.length = 0;
    }
  }, 120_000);

  it('a page whose recording never ends does not hold the others past the bound', async () => {
    delayMs = 5000;
    const s = scanReplay({ waitMs: 300 });
    try {
      const a = await s.page();
      const going = a.goto(`${origin}/slow.html`, { waitUntil: 'load' }).catch(() => null);
      await new Promise((r) => setTimeout(r, 100));
      // The page that was recording closes: the one waiting goes to the site itself.
      const b = await s.page();
      const t0 = Date.now();
      const second = b.goto(`${origin}/slow.html`, { waitUntil: 'commit' }).catch(() => null);
      await a.context().close();
      await going;
      delayMs = 0;
      const c = await s.page();
      const rc = await c.goto(`${origin}/slow.html`, { waitUntil: 'load' });
      expect(rc!.status()).toBe(200);
      expect(Date.now() - t0).toBeLessThan(4000);
      await b.context().close();
      await second;
    } finally {
      await s.end();
    }
  }, 60_000);

  it('a browser that dies under a page that was recording lets the waiting requests go at once', async () => {
    delayMs = 4000;
    // Two browsers of one scan (as its sessions are): the first is recording a slow page when its process
    // is killed. A killed browser reports no failed request: only its contexts' close says it is gone.
    const server = await chromium.launchServer();
    const dying = await chromium.connect(server.wsEndpoint());
    const replay = createReplay();
    const first = replay.browser(dying as unknown as BrowserLike);
    const second = replay.browser(browser as unknown as BrowserLike);
    const ctxA = (await first.newContext({ viewport: { width: 1280, height: 900 } })) as unknown as BrowserContext;
    const ctxB = (await second.newContext({ viewport: { width: 1280, height: 900 } })) as unknown as BrowserContext;
    try {
      const a = await ctxA.newPage();
      void a.goto(`${origin}/slow.html`, { waitUntil: 'load' }).catch(() => null);
      await new Promise((r) => setTimeout(r, 300));
      const b = await ctxB.newPage();
      const t0 = Date.now();
      const waiting = b.goto(`${origin}/slow.html`, { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 300));
      // The site answers at once from here on (the first request is still held for its 4 s).
      delayMs = 0;
      await server.kill();
      const resp = await waiting;
      expect(resp!.status()).toBe(200);
      // Not the 15 s a waiting request is otherwise bounded by: the second page asked the site itself.
      expect(Date.now() - t0).toBeLessThan(3500);
    } finally {
      await ctxB.close().catch(() => {});
      await dying.close().catch(() => {});
      await server.close().catch(() => {});
      await replay.close();
    }
  }, 60_000);

  it('keeps no answer that is only true for one request: a refusal, or a cookie check', async () => {
    const s = scanReplay();
    try {
      flaky = 1;
      const a = await s.page();
      expect((await a.goto(`${origin}/flaky.html`, { waitUntil: 'load' }))!.status()).toBe(503);
      await settled();
      const b = await s.page();
      expect((await b.goto(`${origin}/flaky.html`, { waitUntil: 'load' }))!.status()).toBe(200);
      expect(s.replay.ready(`${origin}/flaky.html`)).toBe(false);
      await settled();
      expect(s.replay.ready(`${origin}/flaky.html`)).toBe(true);
      // The cookie check: the same address redirects, then answers. It works live in every context,
      // and is never taken for a page the copy can answer.
      for (let n = 0; n < 3; n++) {
        const p = await s.page();
        const r = await p.goto(`${origin}/members`, { waitUntil: 'load' });
        expect([r!.status(), await p.title()]).toEqual([200, 'Members']);
        await settled();
      }
      expect(hits['/members']).toBe(6);
      expect(s.replay.ready(`${origin}/members`)).toBe(false);
      expect(s.replay.stats().volatile).toBe(1);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('a guard added after it still decides first, and the analytics blocking under it still applies', async () => {
    const s = scanReplay({}, (b) => b);
    try {
      const first = await s.page();
      await first.goto(`${origin}/`, { waitUntil: 'load' });
      await settled();
      // A route added later (the probes' request guard is): what it stops is stopped, recorded or not.
      const guarded = await s.page();
      await guarded.context().route('**/*', (route) => (route.request().url().endsWith('/logo.png') ? route.abort('blockedbyclient') : route.fallback()));
      await guarded.goto(`${origin}/`, { waitUntil: 'load' });
      expect(await guarded.evaluate(() => (document.getElementById('logo') as HTMLImageElement).naturalWidth)).toBe(0);
      expect(hits['/logo.png']).toBe(1);
      // What the guard stopped went nowhere: the count of what went to the site is still the site's own.
      expect(s.replay.stats().sent).toBe(asked());
    } finally {
      await s.end();
    }
    // The CLI's order: analytics blocking is on the browser the scan is given, record and replay over it.
    const quiet = createReplay();
    const b = quiet.browser(quietBrowser(browser as unknown as BrowserLike));
    const ctx = (await b.newContext({ viewport: { width: 800, height: 600 } })) as unknown as BrowserContext;
    try {
      const page = await ctx.newPage();
      await page.goto(`${origin}/time.html`, { waitUntil: 'load' });
      const failed = await page.evaluate(() => fetch('https://www.google-analytics.com/g/collect?v=2&tid=G-TEST1').then(() => 'sent', () => 'blocked'));
      expect(failed).toBe('blocked');
      expect(quiet.stats().recorded).toBe(1);
      // The beacon was let go by this layer and stopped under it: it is not counted as sent.
      expect(quiet.stats().sent).toBe(1);
    } finally {
      await ctx.close();
      await quiet.close();
    }
  }, 60_000);

  it('passes a document from the copy through the navigation gate, its server address check included', async () => {
    const asked: string[] = [];
    const allowUrl = async (url: string) => { asked.push(new URL(url).pathname); return true; };
    const replay = createReplay({ gateMark: true });
    const gated = gatedBrowser(replay.browser(browser as unknown as BrowserLike), allowUrl, { allowIp: () => true, replayed: replay.gateMark! });
    const contexts: BrowserContext[] = [];
    const page = async () => {
      const ctx = (await gated.newContext({ viewport: { width: 1280, height: 900 } })) as unknown as BrowserContext;
      contexts.push(ctx);
      return (await ctx.newPage()) as unknown as Page;
    };
    try {
      const first = await page();
      const r1 = await first.goto(`${origin}/old`, { waitUntil: 'load' });
      await settled();
      const once = { ...hits };
      const again = await page();
      const r2 = await again.goto(`${origin}/old`, { waitUntil: 'load' });
      await settled();
      expect([r2!.status(), r2!.url(), await again.title()]).toEqual([r1!.status(), r1!.url(), 'Home']);
      expect(gateFailure(again as never)).toBeUndefined();
      expect(hits).toEqual(once);
      // The gate was asked about each document of the replayed load too, and its mark never reaches the page.
      expect(asked.filter((p) => p === '/old').length).toBe(2);
      expect(Object.keys(r2!.headers()).some((n) => n.startsWith('x-grnted'))).toBe(false);
    } finally {
      for (const c of contexts) await c.close().catch(() => {});
      await replay.close();
    }
  }, 60_000);

  it('a page closed right after its load event is still recorded whole', async () => {
    const s = scanReplay();
    try {
      for (let n = 0; n < 3; n++) {
        const p = await s.page();
        await p.goto(`${origin}/`, { waitUntil: 'load' });
        // No settling: the context closes while the last answers are still being read.
        await p.context().close();
      }
      expect(hits).toEqual({ '/': 1, '/moved.css': 1, '/assets/site.css': 1, '/assets/bg.png': 1, '/logo.png': 1, '/app.js': 1, '/frame.html': 1 });
    } finally {
      await s.end();
    }
  }, 60_000);

  it('a page of a site on this machine, answered from the copy, still reaches the other local hosts it asks', async () => {
    // Chromium gives a document answered by an interception no server address, and then refuses its
    // requests to loopback hosts of other origins (Local Network Access): every test fixture with a
    // second host name. The live document may make them, so the one from the copy may too.
    const s = scanReplay();
    try {
      const outcomes: string[] = [];
      for (let n = 0; n < 3; n++) {
        const p = await s.page();
        const failed: string[] = [];
        p.on('requestfailed', (q) => failed.push(q.failure()?.errorText ?? ''));
        await p.goto(`${origin}/vendor.html`, { waitUntil: 'load' });
        await settled();
        outcomes.push(failed.join());
      }
      // The refused stylesheet is asked for on every load (a refusal is never kept), and fails the same way.
      expect(hits).toEqual({ '/vendor.html': 1, '/busy.css': 3 });
      expect(outcomes).toEqual(['net::ERR_ABORTED', 'net::ERR_ABORTED', 'net::ERR_ABORTED']);
      expect(s.replay.snapshot.local(origin)).toBe(true);
      expect(s.replay.snapshot.local('http://vendor.example')).toBe(false);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('what an audio element loads is always the site\'s own answer, and one address asked for in two ways is two entries', async () => {
    const s = scanReplay();
    try {
      const seenByPage: { duration: number; color: string; fetched: number }[] = [];
      for (let n = 0; n < 3; n++) {
        const p = await s.page();
        await p.goto(`${origin}/media.html`, { waitUntil: 'load' });
        await p.waitForFunction(() => (document.getElementById('a') as HTMLAudioElement).readyState >= 1, undefined, { timeout: 10_000 });
        seenByPage.push(await p.evaluate(async () => ({
          duration: Math.round((document.getElementById('a') as HTMLAudioElement).duration),
          color: getComputedStyle(document.getElementById('p')!).color,
          // The page's script asks for the stylesheet's address itself (as axe does): the site refuses it.
          fetched: (await fetch('/two-ways.css')).status,
        })));
        await settled();
      }
      // The same in every load: the media plays as the site sent it, the link gets CSS, the fetch its refusal.
      expect(seenByPage).toEqual(Array.from({ length: 3 }, () => ({ duration: 1, color: 'rgb(4, 5, 6)', fetched: 403 })));
      // The page and its stylesheet came from the site once; the audio file on every load.
      expect(hits['/media.html']).toBe(1);
      expect(seen.filter((r) => r.path === '/two-ways.css' && /^text\/css/.test(String(r.headers.accept))).length).toBe(1);
      expect(hits['/tone.wav']).toBeGreaterThanOrEqual(3);
      // What is never kept is counted as sent every time it is asked for.
      expect(s.replay.stats().sent).toBe(asked());
    } finally {
      await s.end();
    }
  }, 60_000);

  it('a page that still asks the site for something when loaded from the copy takes its turn again', async () => {
    const s = scanReplay();
    try {
      // /media.html holds an audio file (never kept); /vendor.html a stylesheet the site refuses every time;
      // everything / loads is kept.
      for (const path of ['/media.html', '/vendor.html', '/']) {
        const first = await s.page();
        await first.goto(`${origin}${path}`, { waitUntil: 'load' });
        await settled();
        // Recorded: its next load comes from the copy and waits for no turn.
        expect(s.replay.ready(`${origin}${path}`), path).toBe(true);
        const again = await s.page();
        await again.goto(`${origin}${path}`, { waitUntil: 'load' });
        await settled();
      }
      // That load showed which pages still ask the site: from now on theirs take a turn like a live load.
      expect(s.replay.ready(`${origin}/media.html`)).toBe(false);
      expect(s.replay.ready(`${origin}/vendor.html`)).toBe(false);
      expect(s.replay.ready(`${origin}/`)).toBe(true);
      expect(s.replay.stats().leaky).toBe(2);
    } finally {
      await s.end();
    }
  }, 60_000);

  it('the browser-level session pauses documents and the addresses of recorded redirect chains, never every request', async () => {
    // Each `Fetch.enable` the replay layer sends on its browser-level session, as sent.
    const enables: { urlPattern: string; resourceType?: string }[][] = [];
    const real = browser as unknown as BrowserLike;
    const spied: BrowserLike = {
      newContext: (o) => real.newContext(o),
      async newBrowserCDPSession() {
        const session = await real.newBrowserCDPSession!();
        const send = session.send.bind(session);
        session.send = (method: string, params?: Record<string, unknown>) => {
          if (method === 'Fetch.enable') enables.push((params as { patterns: { urlPattern: string; resourceType?: string }[] }).patterns);
          return send(method, params);
        };
        return session;
      },
    };
    const s = scanReplay({}, (b) => b, spied);
    try {
      for (let n = 0; n < 3; n++) {
        const p = await s.page();
        await p.goto(`${origin}/`, { waitUntil: 'load' });
        await settled();
        expect(await p.evaluate(() => getComputedStyle(document.getElementById('h')!).color)).toBe('rgb(1, 2, 3)');
      }
      // The stylesheet's redirect (/moved.css to /assets/site.css) came from the copy on the later loads.
      expect(hits['/moved.css']).toBe(1);
      expect(hits['/assets/site.css']).toBe(1);
      expect(enables.length).toBeGreaterThan(0);
      for (const patterns of enables) {
        for (const p of patterns) expect(p.resourceType === 'Document' || /^http/.test(p.urlPattern), JSON.stringify(p)).toBe(true);
      }
      expect(enables.at(-1)!.filter((p) => p.resourceType !== 'Document').map((p) => p.urlPattern).sort()).toEqual([`${origin}/assets/site.css`, `${origin}/moved.css`]);
      // Addresses with a query and a star are paused by name too (escaped), and their chain replays.
      for (let n = 0; n < 3; n++) {
        const p = await s.page();
        await p.goto(`${origin}/query.html`, { waitUntil: 'load' });
        await settled();
        expect(await p.evaluate(() => getComputedStyle(document.getElementById('h')!).color)).toBe('rgb(7, 8, 9)');
      }
      expect([hits['/query.html'], hits['/q.css?v=1&k=a*b'], hits['/assets/q2.css?from=q&star=*']]).toEqual([1, 1, 1]);
      // Redirects answered from the copy are not counted as sent: the count is the site's own.
      expect(s.replay.stats().sent).toBe(asked());
    } finally {
      await s.end();
    }
  }, 60_000);

  it('holds to its caps and leaves nothing behind: a body too large stays live, the store is cleared at the end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grnted-replay-test-'));
    const s = scanReplay({ store: await fileStore(join(dir, 'snap')), maxResourceBytes: 2000 });
    try {
      for (let n = 0; n < 2; n++) {
        const p = await s.page();
        await p.goto(`${origin}/`, { waitUntil: 'load' });
        expect(await p.evaluate(() => fetch('/big.bin').then((r) => r.arrayBuffer()).then((b) => b.byteLength))).toBe(3000);
        await settled();
      }
      expect(hits['/big.bin']).toBe(2);
      expect(hits['/']).toBe(1);
      expect((await readdir(join(dir, 'snap', 'b'))).length).toBeGreaterThan(0);
    } finally {
      await s.end();
    }
    await expect(stat(join(dir, 'snap'))).rejects.toThrow();
  }, 60_000);
});
