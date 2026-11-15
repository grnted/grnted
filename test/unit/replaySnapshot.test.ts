// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The snapshot's rules (src/replay/snapshot.ts): what is recorded, under which key, and what a later
// request gets. No browser: requests and answers are given as the browser layer would give them.
import { describe, expect, it } from 'vitest';
import { byteRange, createSnapshot, memoryStore, replayUrl, type ReplayRequest, type Snapshot } from '../../src/replay/index.js';

const text = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const get = (url: string, headers: Record<string, string> = {}, extra: Partial<ReplayRequest> = {}): ReplayRequest => ({ method: 'GET', url, headers, ...extra });
const rec = (snap: Snapshot, req: ReplayRequest, status: number, headers: Record<string, string>, body = '') => snap.record(req, { status, headers }, async () => text(body));
const hit = async (snap: Snapshot, req: ReplayRequest) => {
  const a = await snap.answer(req);
  return 'live' in a ? 'live' : { status: a.status, body: str(a.body), headers: a.headers, ...(a.location ? { location: a.location } : {}) };
};

describe('snapshot: what is recorded and replayed', () => {
  it('answers a later request for a recorded address, fragment or not, and never another address', async () => {
    const snap = createSnapshot();
    await rec(snap, get('https://site.example/a?x=1#top'), 200, { 'Content-Type': 'text/html' }, '<p>a</p>');
    expect(await hit(snap, get('https://site.example/a?x=1'))).toEqual({ status: 200, body: '<p>a</p>', headers: { 'content-type': 'text/html' } });
    expect(await hit(snap, get('https://site.example/a?x=1#other'))).toMatchObject({ body: '<p>a</p>' });
    expect(await hit(snap, get('https://site.example/a?x=2'))).toBe('live');
    expect(await hit(snap, get('https://site.example/a'))).toBe('live');
    expect(await hit(snap, get('http://site.example/a?x=1'))).toBe('live');
  });

  it('only GET and HEAD, only http(s), never an address with a password', async () => {
    const snap = createSnapshot();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) expect(snap.eligible({ method, url: 'https://site.example/a', headers: {} })).toBe(false);
    expect(snap.eligible({ method: 'HEAD', url: 'https://site.example/a', headers: {} })).toBe(true);
    expect(snap.eligible(get('data:text/plain,hi'))).toBe(false);
    // What an audio or video element loads is streamed by the browser: always live.
    expect(snap.eligible(get('https://site.example/clip.mp4', {}, { resourceType: 'media' }))).toBe(false);
    expect(snap.eligible(get('https://site.example/clip.mp4', { range: 'bytes=0-' }, { resourceType: 'fetch' }))).toBe(true);
    expect(snap.eligible(get('https://user:secret@site.example/a'))).toBe(false);
    expect(replayUrl('https://user:secret@site.example/a')).toBeUndefined();
    await rec(snap, { method: 'POST', url: 'https://site.example/form', headers: {} }, 200, {}, 'sent');
    expect(snap.stats().recorded).toBe(0);
  });

  it('stores no cookie and no credential, and leaves a request with credentials or a condition live', async () => {
    const store = memoryStore();
    const puts: string[] = [];
    const snap = createSnapshot({ store: { ...store, put: async (id, bytes) => { puts.push(str(bytes)); await store.put(id, bytes); } } });
    await rec(snap, get('https://site.example/'), 200, { 'Set-Cookie': 'sid=SECRET1', 'WWW-Authenticate': 'Basic realm=SECRET2', 'Proxy-Authenticate': 'SECRET3', 'X-Kept': 'yes', 'Content-Encoding': 'gzip', 'Content-Length': '999' }, 'home');
    const a = await hit(snap, get('https://site.example/'));
    expect(a).toEqual({ status: 200, body: 'home', headers: { 'x-kept': 'yes' } });
    expect(puts.join('\n')).not.toMatch(/SECRET/);
    for (const name of ['Authorization', 'Proxy-Authorization', 'If-None-Match', 'If-Modified-Since', 'If-Range']) {
      expect(snap.eligible(get('https://site.example/', { [name]: 'x' }))).toBe(false);
    }
  });

  it('records only answers that stay true for the scan', async () => {
    const snap = createSnapshot();
    const cases: [number, Record<string, string>, boolean][] = [
      [200, {}, true], [204, {}, true], [301, { location: '/x' }, true], [404, {}, true], [410, {}, true],
      [202, {}, false], [304, {}, false], [401, {}, false], [403, {}, false], [406, {}, false], [408, {}, false], [429, {}, false], [500, {}, false], [503, {}, false],
      [302, {}, false], // a redirect to nowhere
      [200, { 'cf-mitigated': 'challenge' }, false], [200, { 'x-amzn-waf-action': 'captcha' }, false],
      [200, { 'content-type': 'text/event-stream' }, false],
    ];
    for (const [i, [status, headers, kept]] of cases.entries()) {
      const req = get(`https://site.example/c${i}`);
      await rec(snap, req, status, headers, 'x');
      expect(snap.peek(req) !== undefined, `${status} ${JSON.stringify(headers)}`).toBe(kept);
    }
    // An analytics beacon is never kept (the scan never sends one either).
    await rec(snap, get('https://www.google-analytics.com/g/collect?v=2&tid=G-1'), 200, {}, '');
    expect(snap.eligible(get('https://www.google-analytics.com/g/collect?v=2&tid=G-1'))).toBe(false);
  });

  it('the first answer stands; an address that changes shape stays live for good', async () => {
    const snap = createSnapshot();
    const page = get('https://site.example/news');
    await rec(snap, page, 200, {}, 'first');
    await rec(snap, page, 200, {}, 'second, a moment later');
    expect(await hit(snap, page)).toMatchObject({ body: 'first' });
    // A redirect that became a page once a cookie was set (a cookie check): one visitor's own.
    const gate = get('https://site.example/');
    await rec(snap, gate, 302, { location: '/?check=1' });
    await rec(snap, gate, 200, {}, 'in');
    expect(await hit(snap, gate)).toBe('live');
    await rec(snap, gate, 302, { location: '/?check=1' });
    expect(await hit(snap, gate)).toBe('live');
    expect(snap.stats().volatile).toBe(1);
  });

  it('keys on the request headers the answer varies on, and on the Origin of a cross-origin answer', async () => {
    const snap = createSnapshot();
    const url = 'https://site.example/data';
    await rec(snap, get(url, { 'X-Mode': 'a', Cookie: 'sid=1' }), 200, { Vary: 'X-Mode, Accept-Encoding, Cookie' }, 'mode a');
    expect(await hit(snap, get(url, { 'x-mode': 'a', cookie: 'sid=2' }))).toMatchObject({ body: 'mode a' });
    expect(await hit(snap, get(url, { 'x-mode': 'b' }))).toBe('live');
    await rec(snap, get(url, { 'x-mode': 'b' }), 200, { vary: 'x-mode' }, 'mode b');
    expect(await hit(snap, get(url, { 'x-mode': 'b' }))).toMatchObject({ body: 'mode b' });
    expect(await hit(snap, get(url, { 'x-mode': 'a' }))).toMatchObject({ body: 'mode a' });
    // `Vary: *` says nothing a key could hold: one anonymous visitor, the first answer is the answer.
    await rec(snap, get('https://site.example/star'), 200, { vary: '*' }, 'star');
    expect(await hit(snap, get('https://site.example/star', { 'accept-language': 'fr', referer: 'https://site.example/other' }))).toMatchObject({ body: 'star' });
    const font = 'https://cdn.example/font.woff2';
    await rec(snap, get(font, { origin: 'https://site.example' }), 200, { 'access-control-allow-origin': 'https://site.example' }, 'font');
    expect(await hit(snap, get(font, { origin: 'https://site.example' }))).toMatchObject({ body: 'font' });
    expect(await hit(snap, get(font, { origin: 'https://other.example' }))).toBe('live');
  });

  it('keys on what kind of request it was, its Accept, and the headers a script added, whatever Vary says', async () => {
    const store = memoryStore();
    const puts: string[] = [];
    const snap = createSnapshot({ store: { ...store, put: async (id, bytes) => { puts.push(str(bytes)); await store.put(id, bytes); } } });
    const url = 'https://site.example/theme.css';
    // A script's own fetch of a stylesheet got it; the page's stylesheet request is another request.
    await rec(snap, get(url, { accept: '*/*' }, { resourceType: 'fetch' }), 200, {}, 'from fetch');
    expect(await hit(snap, get(url, { accept: '*/*', referer: 'https://site.example/two' }, { resourceType: 'fetch' }))).toMatchObject({ body: 'from fetch' });
    expect(await hit(snap, get(url, { accept: 'text/css,*/*;q=0.1' }, { resourceType: 'stylesheet' }))).toBe('live');
    expect(await hit(snap, get(url, { accept: 'text/css,*/*;q=0.1' }, { resourceType: 'fetch' }))).toBe('live');
    // The same address asked for by a script with a header of its own (a fragment, not the page).
    const page = 'https://site.example/list';
    await rec(snap, get(page, { accept: 'text/html' }, { resourceType: 'document' }), 200, {}, '<html>whole page</html>');
    expect(await hit(snap, get(page, { accept: 'text/html', 'HX-Request': 'true' }, { resourceType: 'document' }))).toBe('live');
    await rec(snap, get(page, { accept: 'text/html', 'hx-request': 'true', 'x-api-key': 'SECRETKEY' }, { resourceType: 'xhr' }), 200, {}, '<li>fragment</li>');
    expect(await hit(snap, get(page, { accept: 'text/html', 'X-Api-Key': 'SECRETKEY', 'HX-Request': 'true' }, { resourceType: 'xhr' }))).toMatchObject({ body: '<li>fragment</li>' });
    expect(await hit(snap, get(page, { accept: 'text/html', 'x-api-key': 'another', 'hx-request': 'true' }, { resourceType: 'xhr' }))).toBe('live');
    expect(await hit(snap, get(page, { accept: 'text/html' }, { resourceType: 'document' }))).toMatchObject({ body: '<html>whole page</html>' });
    // The value of a header a script added is never written anywhere.
    expect(puts.join('\n')).not.toMatch(/SECRETKEY/);
  });

  it('follows recorded redirects, and says a page is ready only when its whole chain is in the copy', async () => {
    const snap = createSnapshot();
    const get = (url: string) => ({ method: 'GET', url, headers: {}, resourceType: 'document' });
    await rec(snap, get('http://site.example/old'), 301, { location: 'https://site.example/new' });
    expect(snap.peek(get('http://site.example/old'))).toEqual({ status: 301, location: 'https://site.example/new' });
    expect(snap.ready('http://site.example/old', true)).toBe(false);
    await rec(snap, get('https://site.example/new'), 302, { location: '/final#x' });
    await rec(snap, get('https://site.example/final'), 200, {}, 'final');
    expect(snap.ready('http://site.example/old', true)).toBe(true);
    // Without a way to answer the hops, a redirecting page is not ready; a plain one is.
    expect(snap.ready('http://site.example/old', false)).toBe(false);
    expect(snap.ready('https://site.example/final', false)).toBe(true);
    expect(snap.ready('https://site.example/unknown', true)).toBe(false);
    await rec(snap, get('https://site.example/gone'), 404, {}, 'not here');
    expect(snap.ready('https://site.example/gone', true)).toBe(false);
    // A page that still asks the site for something when loaded from the copy is not ready any more.
    await rec(snap, get('https://site.example/video'), 200, {}, 'page with a video');
    expect(snap.ready('https://site.example/video', true)).toBe(true);
    snap.leak('https://site.example/video#player');
    snap.leak('https://site.example/video');
    expect(snap.ready('https://site.example/video', true)).toBe(false);
    expect(snap.ready('http://site.example/old', true)).toBe(true);
    expect(snap.stats().leaky).toBe(1);
    // An address only a script asked for is not a page the copy can load.
    await rec(snap, { method: 'GET', url: 'https://site.example/api', headers: {}, resourceType: 'fetch' }, 200, {}, '{}');
    expect(snap.ready('https://site.example/api', true)).toBe(false);
  });

  it('serves byte ranges from a body it holds whole, when the server takes ranges', async () => {
    const snap = createSnapshot();
    const url = 'https://site.example/clip.mp4';
    await rec(snap, get(url, { range: 'bytes=0-' }), 206, { 'content-range': 'bytes 0-9/10', 'accept-ranges': 'bytes' }, '0123456789');
    expect(await hit(snap, get(url, { range: 'bytes=0-' }))).toMatchObject({ status: 206, body: '0123456789' });
    expect(await hit(snap, get(url, { Range: 'bytes=4-6' }))).toMatchObject({ status: 206, body: '456', headers: { 'content-range': 'bytes 4-6/10' } });
    expect(await hit(snap, get(url, { range: 'bytes=-3' }))).toMatchObject({ body: '789', headers: { 'content-range': 'bytes 7-9/10' } });
    expect(await hit(snap, get(url, { range: 'bytes=20-' }))).toBe('live');
    expect(await hit(snap, get(url, { range: 'bytes=0-1,4-5' }))).toBe('live');
    // A partial answer is not the whole body: nothing is cut from it.
    const part = 'https://site.example/part.mp4';
    await rec(snap, get(part, { range: 'bytes=5-9' }), 206, { 'content-range': 'bytes 5-9/10' }, '56789');
    expect(await hit(snap, get(part, { range: 'bytes=6-7' }))).toBe('live');
    expect(byteRange('bytes=2-', 5)).toEqual({ start: 2, end: 4 });
    expect(byteRange('bytes=-', 5)).toBeUndefined();
  });

  it('treats a parameter as cache-busting only after the same body came under two made-up values', async () => {
    const snap = createSnapshot();
    const at = (v: string) => get(`https://site.example/menu.json?lang=en&_=${v}`);
    await rec(snap, at('1794329170921'), 200, {}, '{"menu":1}');
    expect(await hit(snap, at('1794329170999'))).toBe('live');
    await rec(snap, at('1794329170999'), 200, {}, '{"menu":1}');
    expect(await hit(snap, at('1794329171555'))).toMatchObject({ body: '{"menu":1}' });
    // Another parameter of the same address is still part of it.
    expect(await hit(snap, get('https://site.example/menu.json?lang=es&_=1794329171556'))).toBe('live');
    // Different bodies under changing values are different resources: never collapsed.
    const feed = (v: string) => get(`https://site.example/feed?since=${v}`);
    await rec(snap, feed('1794329170921'), 200, {}, 'older');
    await rec(snap, feed('1794329170999'), 200, {}, 'newer');
    expect(await hit(snap, feed('1794329171555'))).toBe('live');
    // An ordinary value is never taken for a made-up one, even with the same body twice.
    const pageOf = (n: string) => get(`https://site.example/list?page=${n}`);
    await rec(snap, pageOf('1'), 200, {}, '[]');
    await rec(snap, pageOf('2'), 200, {}, '[]');
    expect(await hit(snap, pageOf('3'))).toBe('live');
    expect(snap.stats()).toMatchObject({ busters: 1, busted: 1 });
  });

  it('holds to its caps: a body too large, and no more room', async () => {
    const snap = createSnapshot({ maxResourceBytes: 10, maxBytes: 25 });
    await rec(snap, get('https://site.example/big'), 200, {}, 'x'.repeat(11));
    expect(await hit(snap, get('https://site.example/big'))).toBe('live');
    let read = false;
    await snap.record(get('https://site.example/huge'), { status: 200, headers: { 'content-length': '5000000' } }, async () => { read = true; return text('never'); });
    expect(read).toBe(false);
    await rec(snap, get('https://site.example/1'), 200, {}, 'a'.repeat(10));
    await rec(snap, get('https://site.example/2'), 200, {}, 'b'.repeat(10));
    await rec(snap, get('https://site.example/3'), 200, {}, 'c'.repeat(10));
    expect(await hit(snap, get('https://site.example/3'))).toBe('live');
    // The same bytes are stored once, whatever the address.
    await rec(snap, get('https://site.example/again'), 200, {}, 'a'.repeat(10));
    expect(await hit(snap, get('https://site.example/again'))).toMatchObject({ body: 'a'.repeat(10) });
    expect(snap.stats()).toMatchObject({ tooLarge: 2, full: 1, storedBytes: 20 });
    // And the most answers one snapshot records.
    const few = createSnapshot({ maxEntries: 2 });
    for (const n of [1, 2, 3]) await rec(few, get(`https://site.example/n${n}`), 200, {}, `n${n}`);
    expect([await hit(few, get('https://site.example/n2')), await hit(few, get('https://site.example/n3'))]).toEqual([expect.objectContaining({ body: 'n2' }), 'live']);
    expect(few.stats()).toMatchObject({ recorded: 2, full: 1 });
  });

  it('makes the other requests for a resource wait for the one recording it, never past the bound', async () => {
    const snap = createSnapshot({ waitMs: 60 });
    const css = get('https://site.example/app.css');
    const first = await snap.answer(css, { lead: true });
    expect('live' in first && first.lease).toBeTruthy();
    // A second request while the first is on its way: it waits, then gets the recorded answer.
    const second = hit(snap, css);
    await new Promise((r) => setTimeout(r, 10));
    await rec(snap, css, 200, {}, 'p{}');
    expect(await second).toMatchObject({ body: 'p{}' });
    // A recording that never ends: the wait is bounded, and later requests no longer wait for it.
    const stuck = get('https://site.example/stuck.js');
    await snap.answer(stuck, { lead: true });
    const t0 = Date.now();
    expect(await hit(snap, stuck)).toBe('live');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    const t1 = Date.now();
    expect(await hit(snap, stuck)).toBe('live');
    expect(Date.now() - t1).toBeLessThan(40);
    // A request that failed lets its waiters go at once.
    const lost = get('https://site.example/lost.js');
    await snap.answer(lost, { lead: true });
    const waiting = hit(snap, lost);
    snap.failed(lost);
    expect(await waiting).toBe('live');
    expect(snap.stats().waited).toBe(3);
    // The recording request was refused: nothing is kept, and the ones that waited ask the site themselves
    // (the site judges each request on its own, as without replay; a refusal is never passed on).
    const busy = get('https://site.example/busy.css');
    await snap.answer(busy, { lead: true });
    const [w1, w2] = [hit(snap, busy), hit(snap, busy)];
    await new Promise((r) => setTimeout(r, 10));
    await rec(snap, busy, 429, { 'retry-after': '3' }, 'Slow down');
    expect([await w1, await w2]).toEqual(['live', 'live']);
    expect(snap.peek(busy)).toBeUndefined();
    expect(snap.stats()).toMatchObject({ waited: 5, recorded: 1 });
  });

  it('is one scan\'s own: closed, it answers nothing and its store is cleared (unless kept)', async () => {
    const store = memoryStore();
    const snap = createSnapshot({ store });
    await rec(snap, get('https://site.example/'), 200, {}, 'home');
    expect(await store.get('r/1')).toBeDefined();
    await snap.close();
    expect(await hit(snap, get('https://site.example/'))).toBe('live');
    expect(await store.get('r/1')).toBeUndefined();
    const kept = memoryStore();
    const other = createSnapshot({ store: kept });
    await rec(other, get('https://site.example/'), 200, {}, 'home');
    await other.close(true);
    expect(await kept.get('r/1')).toBeDefined();
    // A kept snapshot carries the assumptions it was recorded under.
    expect(JSON.parse(str((await kept.get('index'))!))).toMatchObject({ version: 1, methods: ['GET', 'HEAD'], visitor: expect.stringContaining('one anonymous visitor'), stats: { recorded: 1 } });
    expect(other.manifest()).toMatchObject({ version: 1, methods: ['GET', 'HEAD'] });
  });
});
