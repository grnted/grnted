// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The stylesheet watch (src/styles.ts), the controller's file refusals and gotoPolitely with a watch
// (src/pace.ts), on fake pages and a fake clock: which responses count against the page, which host
// pays for them, and what a load does about them.
import { describe, expect, it } from 'vitest';
import { createPace, gotoPolitely, isPaceReason, isUnstyledReason, unstyledReason } from '../../src/pace.js';
import { MAX_REMEMBERED_STYLESHEETS, WEB_FONT_CSS_HOSTS, onlyDeclaresFonts, refusedSince, watchStyles } from '../../src/styles.js';
import type { PageLike } from '../../src/types.js';

interface Frame { url(): string; parentFrame(): Frame | null; evaluate?: unknown }
const frame = (url: string, parent: Frame | null): Frame => ({ url: () => url, parentFrame: () => parent });
const MAIN = frame('https://example.org/', null);

type Listener = (x: unknown) => void;

/**
 * A page whose network the test drives: `send` makes a stylesheet request (the request event),
 * `answer` its response; `respond` does both. `links` is what the in-page link check answers.
 */
function fakePage(opts: { noOn?: boolean; noMain?: boolean; links?: (urls: string[]) => unknown } = {}) {
  const on: Record<string, Listener[]> = {};
  const page = {
    ...(opts.noMain ? {} : { mainFrame: () => MAIN }),
    async evaluate(_fn: unknown, urls: string[]) {
      return opts.links ? opts.links(urls) : urls.map(() => 'applies');
    },
    ...(opts.noOn ? {} : { on: (event: string, fn: Listener) => { (on[event] ??= []).push(fn); } }),
  } as unknown as PageLike;
  const send = (url: string, type = 'stylesheet') => {
    const req = { method: () => 'GET', url: () => url, resourceType: () => type };
    for (const fn of on.request ?? []) fn(req);
    return req;
  };
  const answer = (req: ReturnType<typeof send>, status: number, o: { frame?: Frame | null; retryAfter?: string; type?: string; body?: string; read?: () => Promise<string> } = {}) => {
    const headers: Record<string, string> = { ...(o.retryAfter ? { 'retry-after': o.retryAfter } : {}), ...(o.type ? { 'content-type': o.type } : {}) };
    for (const fn of on.response ?? []) {
      fn({
        url: req.url, status: () => status, headers: () => headers, request: () => req,
        frame: () => (o.frame === undefined ? MAIN : o.frame), text: o.read ?? (async () => o.body ?? ''),
      });
    }
    for (const fn of on.requestfinished ?? []) fn(req);
  };
  const respond = (url: string, status: number, o: Parameters<typeof answer>[2] & { resource?: string } = {}) => answer(send(url, o.resource), status, o);
  /** The request fails with the browser's `errorText` (no response at all). */
  const fail = (url: string, errorText: string, o: { frame?: Frame | null; req?: ReturnType<typeof send> } = {}) => {
    const req = o.req ?? send(url);
    const failed = Object.assign(req, { failure: () => ({ errorText }), frame: () => (o.frame === undefined ? MAIN : o.frame) });
    for (const fn of on.requestfailed ?? []) fn(failed);
  };
  return { page, send, answer, respond, fail };
}

const CSS = 'https://example.org/site.css';
const urls = async (w: { degraded(): Promise<{ url: string }[]> }) => (await w.degraded()).map((r) => r.url);

describe('watchStyles: which refusals count against the page', () => {
  it('429 and 503 count, with their own Retry-After; reset starts a new try', async () => {
    const { page, respond } = fakePage();
    const w = watchStyles(page)!;
    respond(CSS, 200);
    expect(await w.degraded()).toEqual([]);
    respond('https://cdn.example.net/a.css', 429, { retryAfter: '3' });
    respond('https://cdn.example.net/b.css', 503, { retryAfter: '7' });
    expect(await w.degraded()).toEqual([
      { url: 'https://cdn.example.net/a.css', status: 429, retryAfter: '3' },
      { url: 'https://cdn.example.net/b.css', status: 503, retryAfter: '7' },
    ]);
    w.reset();
    expect(await w.degraded()).toEqual([]);
  });

  it('the latest answer for an address in the try wins (a later 200 clears a 429)', async () => {
    const { page, respond } = fakePage();
    const w = watchStyles(page)!;
    respond(CSS, 429);
    respond(CSS, 200);
    expect(await w.degraded()).toEqual([]);
  });

  it('a late answer to an earlier try’s request does not count against the new try', async () => {
    const { page, send, answer } = fakePage();
    const w = watchStyles(page)!;
    const old = send(CSS);
    w.reset();
    answer(old, 429);
    expect(await w.degraded()).toEqual([]);
  });

  it('other resources and statuses that are the site’s real state never count', async () => {
    const { page, respond } = fakePage();
    const w = watchStyles(page)!;
    respond('https://example.org/font.woff2', 429, { resource: 'font' });
    respond('https://example.org/app.js', 503, { resource: 'script' });
    respond(CSS, 404);
    respond('https://example.org/b.css', 500);
    respond('https://example.org/c.css', 403);
    expect(await w.degraded()).toEqual([]);
  });
});

describe('watchStyles: the 403 rule', () => {
  it('a 403 counts only for an address that answered 2xx with CSS earlier in the scan; redirects, 304s and non-CSS never teach it', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    watchStyles(a.page, pace);
    a.respond('https://example.org/moved.css', 301, { type: 'text/css' });
    a.respond('https://example.org/cached.css', 304, { type: 'text/css' });
    a.respond('https://example.org/html.css', 200, { type: 'text/html' });
    a.respond(CSS, 200, { type: 'text/css; charset=utf-8', body: '.a{color:red}' });
    await new Promise((r) => setTimeout(r, 0));
    const b = fakePage();
    const w = watchStyles(b.page, pace)!;
    for (const u of ['https://example.org/moved.css', 'https://example.org/cached.css', 'https://example.org/html.css', 'https://example.org/never.css', CSS]) b.respond(u, 403);
    expect(await urls(w)).toEqual([CSS]);
    // Another scan has its own memory.
    const c = fakePage();
    const w2 = watchStyles(c.page, createPace({ concurrency: 2 }))!;
    c.respond(CSS, 403);
    expect(await w2.degraded()).toEqual([]);
  });

  it('is judged when the try is judged, not when the 403 arrived: the same answer whichever of two pages answered first', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    const b = fakePage();
    watchStyles(a.page, pace);
    const wb = watchStyles(b.page, pace)!;
    // Page B's 403 arrives before page A's 200 for the same address; B is judged after both.
    b.respond(CSS, 403);
    a.respond(CSS, 200, { type: 'text/css', body: '.a{}' });
    await wb.settle(100);
    expect(await urls(wb)).toEqual([CSS]);
  });

  it('the memory keeps the most recent addresses: a new one past the cap is still remembered', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    const wa = watchStyles(a.page, pace)!;
    for (let i = 0; i <= MAX_REMEMBERED_STYLESHEETS; i++) a.respond(`https://example.org/s${i}.css`, 200, { type: 'text/css', body: '.a{}' });
    await wa.settle(1000);
    const b = fakePage();
    const wb = watchStyles(b.page, pace)!;
    b.respond(`https://example.org/s${MAX_REMEMBERED_STYLESHEETS}.css`, 403);
    b.respond('https://example.org/s0.css', 403);
    expect(await urls(wb)).toEqual([`https://example.org/s${MAX_REMEMBERED_STYLESHEETS}.css`]);
  });
});

describe('watchStyles: sheets whose loss does not change what is measured', () => {
  it('web-font services (only @font-face rules) never count', async () => {
    const { page, respond } = fakePage();
    const w = watchStyles(page)!;
    for (const host of WEB_FONT_CSS_HOSTS) respond(`https://${host}/css2?family=DM+Sans`, 503);
    expect(await w.degraded()).toEqual([]);
  });

  it('a sheet seen earlier in the scan with only @font-face rules (or none) never counts; one with rules does', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    const wa = watchStyles(a.page, pace)!;
    a.respond('https://example.org/fonts.css', 200, { type: 'text/css', body: '/* fonts */ @charset "utf-8"; @font-face { font-family: X; src: url(x.woff2); }' });
    a.respond('https://example.org/empty.css', 200, { type: 'text/css', body: '  ' });
    a.respond('https://example.org/rules.css', 200, { type: 'text/css', body: '@font-face { font-family: X; } nav a { padding: 12px }' });
    await wa.settle(1000);
    const b = fakePage();
    const w = watchStyles(b.page, pace)!;
    for (const u of ['https://example.org/fonts.css', 'https://example.org/empty.css', 'https://example.org/rules.css']) b.respond(u, 429);
    expect(await urls(w)).toEqual(['https://example.org/rules.css']);
  });

  it('onlyDeclaresFonts', () => {
    expect(onlyDeclaresFonts('@font-face{font-family:A;src:url(a)}\n@font-face { font-family: B }')).toBe(true);
    expect(onlyDeclaresFonts('')).toBe(true);
    expect(onlyDeclaresFonts('.tk-x { font-family: A }')).toBe(false);
    expect(onlyDeclaresFonts('@media screen { a { color: red } }')).toBe(false);
  });

  it('a sheet no <link> would apply now (other media, disabled, alternate, preload) never counts; an unknown one does', async () => {
    const { page, respond } = fakePage({ links: (u) => u.map((x) => (x.endsWith('print.css') ? 'idle' : 'unknown')) });
    const w = watchStyles(page)!;
    respond('https://example.org/print.css', 429);
    respond('https://example.org/imported.css', 429);
    expect(await urls(w)).toEqual(['https://example.org/imported.css']);
  });

  it('an in-page check that fails counts every refused sheet', async () => {
    const { page, respond } = fakePage({ links: () => { throw new Error('page gone'); } });
    const w = watchStyles(page)!;
    respond(CSS, 429);
    expect(await urls(w)).toEqual([CSS]);
  });
});

describe('watchStyles: frames', () => {
  const linksOk = { evaluate: async (_f: unknown, u: string[]) => u.map(() => 'applies') };
  it('same-site frames and about:blank / srcdoc frames inside them count; other-site frames, frames inside them and unknown frames do not', async () => {
    const { page, respond } = fakePage();
    const w = watchStyles(page, undefined, 'https://www.example.org/')!;
    const same = { ...frame('https://cdn.example.org/embed', MAIN), ...linksOk };
    const blank = { ...frame('about:blank', same), ...linksOk };
    const srcdoc = { ...frame('about:srcdoc', MAIN), ...linksOk };
    const other = { ...frame('https://player.video.com/', MAIN), ...linksOk };
    const inOther = { ...frame('about:blank', other), ...linksOk };
    const orphan = { ...frame('https://example.org/x', null), ...linksOk };
    respond('https://x.test/same.css', 429, { frame: same });
    respond('https://x.test/blank.css', 429, { frame: blank });
    respond('https://x.test/srcdoc.css', 429, { frame: srcdoc });
    respond('https://x.test/other.css', 429, { frame: other });
    respond('https://x.test/in-other.css', 429, { frame: inOther });
    respond('https://x.test/orphan.css', 429, { frame: orphan });
    respond('https://x.test/unknown.css', 429, { frame: null });
    expect(await urls(w)).toEqual(['https://x.test/same.css', 'https://x.test/blank.css', 'https://x.test/srcdoc.css']);
  });

  it('without the main frame nothing can be placed, so nothing counts', async () => {
    const { page, respond } = fakePage({ noMain: true });
    const w = watchStyles(page)!;
    respond(CSS, 429);
    expect(await w.degraded()).toEqual([]);
  });

  it('no watch when the browser cannot report responses', () => {
    expect(watchStyles(fakePage({ noOn: true }).page)).toBeUndefined();
  });
});

/** A fake clock for the controller: waits pass at once and are recorded. */
function clocked(extra: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const waits: number[] = [];
  const changes: unknown[] = [];
  const pace = createPace({ concurrency: 6, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, random: () => 1, onChange: (c) => changes.push(c), ...extra });
  return { pace, waits, changes, advance: (ms: number) => { t += ms; } };
}

describe('the controller: a refused file is charged to its own host', () => {
  const PAGE = 'https://example.org/a';
  const ok = { status: 200 };
  const file = (url: string, retryAfter?: string) => ({ url, status: 429, ...(retryAfter ? { retryAfter } : {}) });

  it('Retry-After of the file’s answer sets the wait (3 s, not the 2 s first backoff), on the file’s host only', async () => {
    const { pace, waits, changes } = clocked();
    let n = 0;
    const r = await pace.load(PAGE, async () => ++n, (i) => (i === 1 ? { ...ok, files: [file('https://cdn.example.net/t.css', '3')] } : ok));
    expect(r.refused).toBeUndefined();
    expect(n).toBe(2);
    expect(waits).toEqual([3000]);
    expect(pace.limit('cdn.example.net')).toBe(1);
    expect(pace.limit('example.org')).toBeNull();
    expect(changes).toEqual([{ step: 'slowed', host: 'cdn.example.net', status: 429, waitMs: 3000, file: true }]);
    expect(pace.summary()).toMatchObject({ slowedDown: true, refusals: [{ status: 429, count: 1 }], retries: 1, pausedMs: 3000 });
  });

  it('a file refused on every try: the load comes back refused after its retries, and never makes the scan give up on the page host', async () => {
    const { pace } = clocked();
    for (let i = 0; i < 10; i++) {
      const r = await pace.load(`${PAGE}${i}`, async () => 1, () => ({ ...ok, files: [file('https://example.org/app.css', '1')] }), { retries: 3 });
      expect(r.refused).toBe('The site asked us to slow down (HTTP 429) and kept refusing');
    }
    // The page host still loads pages (it slowed down: the sheet came from it).
    let ran = false;
    const r = await pace.load(`${PAGE}-last`, async () => { ran = true; return 1; }, () => ok);
    expect(ran).toBe(true);
    expect(r.refused).toBeUndefined();
  });

  it('later loads of the page host wait for the pause of a file host its pages need', async () => {
    const { pace, waits } = clocked();
    await pace.load(PAGE, async () => 1, () => ({ ...ok, files: [file('https://cdn.example.net/t.css', '5')] }), { retries: 0 });
    waits.length = 0;
    await pace.load(`${PAGE}/next`, async () => 1, () => ok);
    expect(waits).toEqual([5000]);
  });

  it('fileRefused (after the load was over) pauses the file host the same way', async () => {
    const { pace, waits } = clocked();
    pace.fileRefused('https://cdn.example.net/late.css', { status: 503, retryAfter: '4' }, PAGE);
    await pace.load(`${PAGE}/next`, async () => 1, () => ok);
    expect(waits).toEqual([4000]);
    expect(pace.summary()).toMatchObject({ refusals: [{ status: 503, count: 1 }] });
  });
});

describe('gotoPolitely with a stylesheet watch', () => {
  const resp = (status = 200) => ({ status: () => status, headers: () => ({}) });

  it('each try the page answered runs prepare, then is judged; a refused sheet reloads the page after the sheet host’s Retry-After', async () => {
    const { page, respond } = fakePage();
    const styles = watchStyles(page)!;
    const { pace, waits } = clocked();
    let tries = 0;
    let prepared = 0;
    const r = await gotoPolitely(pace, 'https://example.org/', async () => {
      tries++;
      return resp();
    }, {
      styles,
      // The sheet is added while the page settles: part of the try.
      prepare: async () => { prepared++; respond('https://cdn.example.net/t.css', tries === 1 ? 429 : 200, { retryAfter: '3' }); },
    });
    expect(r.refused).toBeUndefined();
    expect([tries, prepared]).toEqual([2, 2]);
    expect(waits).toEqual([3000]);
  });

  it('still refused after every try: refused with the unstyled reason (a pace reason)', async () => {
    const { page, respond } = fakePage();
    const styles = watchStyles(page)!;
    const { pace } = clocked();
    let tries = 0;
    const r = await gotoPolitely(pace, 'https://example.org/', async () => {
      tries++;
      respond(CSS, 503);
      return resp();
    }, { styles, retries: 2 });
    expect(tries).toBe(3);
    expect(r.refused).toBe(unstyledReason(503, 'kept'));
    expect(isPaceReason(r.refused)).toBe(true);
    expect(isUnstyledReason(r.refused)).toBe(true);
    expect(r.value?.status()).toBe(200);
  });

  it('without a controller: no retry, and the page is never taken as loaded', async () => {
    const { page, respond } = fakePage();
    const styles = watchStyles(page)!;
    const r = await gotoPolitely(undefined, 'https://example.org/', async () => {
      respond(CSS, 429);
      return resp();
    }, { styles });
    expect(r.refused).toBe(unstyledReason(429, 'once'));
  });

  it('a page refused itself keeps the page’s own reason; prepare does not run for it', async () => {
    const { page, respond } = fakePage();
    const styles = watchStyles(page)!;
    const { pace } = clocked();
    let prepared = 0;
    const r = await gotoPolitely(pace, 'https://example.org/x', async () => {
      respond(CSS, 429);
      return resp(429);
    }, { styles, retries: 0, prepare: async () => { prepared++; } });
    expect(r.refused).toBe('The site asked us to slow down (HTTP 429) and kept refusing');
    expect(prepared).toBe(0);
  });

  it('refusedSince: a sheet refused after the load is charged to its host and gives the one-try reason', async () => {
    const { page, respond } = fakePage();
    const styles = watchStyles(page)!;
    const { pace, waits } = clocked();
    expect(await refusedSince(styles, pace, 'https://example.org/')).toBeUndefined();
    respond('https://cdn.example.net/late.css', 429, { retryAfter: '6' });
    expect(await refusedSince(styles, pace, 'https://example.org/')).toBe(unstyledReason(429, 'once'));
    await pace.load('https://example.org/next', async () => 1, () => ({ status: 200 }));
    expect(waits).toEqual([6000]);
  });

  it('the reasons say plainly that the page could not load its styles and was left out', () => {
    expect(unstyledReason(429, 'kept')).toBe('The site asked us to slow down (HTTP 429) and kept refusing the page’s stylesheet, so the page could not load its styles and was left out of the score');
    expect(unstyledReason(403, 'once')).toBe('The site started refusing requests (HTTP 403) after earlier pages loaded: it refused the page’s stylesheet, so the page could not load its styles and was left out of the score');
    expect(unstyledReason(503, 'no-time')).toMatch(/no time left in the scan/);
    expect(isUnstyledReason('The site asked us to slow down (HTTP 429) and kept refusing')).toBe(false);
  });
});

describe('round 2: the font-sheet read race', () => {
  it('a refusal of an address whose 2xx body is still being read (another width) waits for the read before it is judged', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    const b = fakePage();
    watchStyles(a.page, pace);
    const wb = watchStyles(b.page, pace)!;
    let release!: () => void;
    const read = new Promise<string>((r) => { release = () => r('@font-face { font-family: X; src: url(x.woff2); }'); });
    a.respond('https://example.org/fonts.css', 200, { type: 'text/css', read: () => read });
    b.respond('https://example.org/fonts.css', 503);
    setTimeout(release, 50);
    expect(await wb.degraded()).toEqual([]);
  });

  it('a read that fails leaves the address as layout CSS: its refusal still counts', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    const b = fakePage();
    watchStyles(a.page, pace);
    const wb = watchStyles(b.page, pace)!;
    a.respond('https://example.org/fonts.css', 200, { type: 'text/css', read: () => Promise.reject(new Error('gone')) });
    b.respond('https://example.org/fonts.css', 503);
    expect(await urls(wb)).toEqual(['https://example.org/fonts.css']);
  });
});

describe('round 2: the file backoff', () => {
  const PAGE = 'https://example.org/p';
  const CDN = 'https://cdn.example.net/app.css';
  const refusedFiles = (n = 1) => ({ status: 200, files: Array.from({ length: n }, (_, i) => ({ url: `${CDN}?v=${i}`, status: 429 })) });
  /** The pause the next page load waits for (the file host's backoff), on the fake clock. */
  async function nextWait(c: ReturnType<typeof clocked>): Promise<number> {
    c.waits.length = 0;
    await c.pace.load(`${PAGE}/probe-${Math.random()}`, async () => 1, () => ({ status: 200 }));
    return c.waits.reduce((x, y) => x + y, 0);
  }

  it('counts once per round per host: both widths, two refused sheets each, move the backoff one step, not four', async () => {
    const c = clocked();
    // Round 1: both widths sent together, each with two refused sheets on the CDN.
    await Promise.all([0, 1].map((w) => c.pace.load(`${PAGE}/a`, async () => w, () => refusedFiles(2), { retries: 0 })));
    expect(await nextWait(c)).toBe(2000);
    // Round 2 (sent after round 1's refusal): one step more.
    await c.pace.load(`${PAGE}/b`, async () => 1, () => refusedFiles(2), { retries: 0 });
    expect(await nextWait(c)).toBe(4000);
  });

  it('only a sheet from that host loading again resets its backoff; a page with no refusals does not', async () => {
    const c = clocked();
    await c.pace.load(`${PAGE}/a`, async () => 1, () => refusedFiles(), { retries: 0 });
    await nextWait(c);
    // An unrelated page that loaded with no refused sheet: the CDN's backoff stands.
    await c.pace.load(`${PAGE}/plain`, async () => 1, () => ({ status: 200 }));
    await c.pace.load(`${PAGE}/b`, async () => 1, () => refusedFiles(), { retries: 0 });
    expect(await nextWait(c)).toBe(4000);
    // A stylesheet from the CDN answered 2xx with CSS (the watch reports it): back to the first step.
    const { page, respond } = fakePage();
    watchStyles(page, c.pace);
    respond(`${CDN}?v=0`, 200, { type: 'text/css', body: '.a{}' });
    await c.pace.load(`${PAGE}/c`, async () => 1, () => refusedFiles(), { retries: 0 });
    expect(await nextWait(c)).toBe(2000);
  });

  it('a page answered 200 whose layout sheet was refused is not a success of the page host: its strikes stand', async () => {
    const c = clocked();
    // Two refusal rounds of pages on the host: its backoff is at 4 s.
    await c.pace.load(`${PAGE}/1`, async () => 1, () => ({ status: 429 }), { retries: 0 });
    await c.pace.load(`${PAGE}/2`, async () => 1, () => ({ status: 429 }), { retries: 0 });
    // A page answered 200 but its sheet was refused (on the page host itself).
    await c.pace.load(`${PAGE}/3`, async () => 1, () => ({ status: 200, files: [{ url: 'https://example.org/app.css', status: 429, retryAfter: '1' }] }), { retries: 0 });
    // The next page refusal is the third round: 8 s, not the first step again.
    c.waits.length = 0;
    await c.pace.load(`${PAGE}/4`, async () => 1, () => ({ status: 429 }), { retries: 0 });
    await c.pace.load(`${PAGE}/5`, async () => 1, () => ({ status: 200 }));
    expect(c.waits.at(-1)).toBe(8000);
  });
});

describe('stylesheets with no usable answer (GAPS on staging, 2026-11-02)', () => {
  const THEME = 'https://vendor.example.com/theme.css';
  it('an answer the browser blocked (a firewall block page with CORP) counts, even the first time; our own aborts never do', async () => {
    const { page, fail } = fakePage();
    const w = watchStyles(page)!;
    fail(THEME, 'net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin');
    fail('https://example.org/a.css', 'net::ERR_ABORTED');
    fail('https://example.org/b.css', 'net::ERR_BLOCKED_BY_CLIENT');
    expect(await w.degraded()).toEqual([{ url: THEME, status: 0, retryAfter: null }]);
  });

  it('a failed request or a 2xx that is not CSS counts only for an address that answered with CSS earlier in the scan', async () => {
    const pace = createPace({ concurrency: 2 });
    const a = fakePage();
    watchStyles(a.page, pace);
    a.respond(THEME, 200, { type: 'text/css', body: '.a{}' });
    const b = fakePage();
    const w = watchStyles(b.page, pace)!;
    b.fail(THEME, 'net::ERR_CONNECTION_RESET');
    b.fail('https://dead.example.net/x.css', 'net::ERR_NAME_NOT_RESOLVED');
    b.respond('https://example.org/served-as-html.css', 200, { type: 'text/html' });
    expect(await urls(w)).toEqual([THEME]);
    w.reset();
    b.respond(THEME, 200, { type: 'text/html' });
    expect(await urls(w)).toEqual([THEME]);
  });

  it('a failure of an earlier try’s request, or in another site’s frame, does not count', async () => {
    const { page, send, fail } = fakePage();
    const w = watchStyles(page)!;
    const old = send(THEME);
    w.reset();
    fail(THEME, 'net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin', { req: old });
    fail('https://player.example.net/p.css', 'net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin', { frame: frame('https://player.example.net/', MAIN) });
    expect(await w.degraded()).toEqual([]);
  });

  it('the reason and the report say there was no usable answer', () => {
    expect(unstyledReason(0, 'kept')).toBe('The site started refusing requests (no usable answer) and kept refusing the page’s stylesheet, so the page could not load its styles and was left out of the score');
    expect(isUnstyledReason(unstyledReason(0, 'once'))).toBe(true);
  });
});
