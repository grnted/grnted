// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Sessions a site refuses (src/sessions.ts, src/egress.ts; staging 2026-11-04: one Browser Rendering
// egress address got HTTP 406 on every page, another 200): the pool reads each load's answer in the
// session it ran in, retries a refused page in a session that has not refused it, replaces a session
// the evidence says the site refuses, and never loops. Fakes only: every load is a goto on a fake page.
import { describe, expect, it } from 'vitest';
import { auditPage } from '../../src/audit.js';
import { loadOutcome } from '../../src/egress.js';
import { isWorkLost, reconnectingBrowser } from '../../src/reconnect.js';
import { isSessionWait, sessionPool } from '../../src/sessions.js';
import type { BrowserLike, ContextLike, PageLike, SubresourceResponseLike } from '../../src/types.js';

const VP = { viewport: { width: 1280, height: 900 } };

/**
 * A fake session whose every load answers `status(url)` (a function of the session's current
 * address: `refuses` flips when the host swaps it). Loads are recorded as `session url status`.
 */
function fakeSession(name: string, answer: (url: string) => number, log: string[]) {
  const s = {
    name,
    answer,
    browser: undefined as unknown as BrowserLike,
  };
  s.browser = {
    async newContext() {
      const ctx: ContextLike = {
        async newPage() {
          const page = {
            async goto(url: string) {
              const status = s.answer(url);
              log.push(`${s.name} ${new URL(url).pathname} ${status}`);
              return { status: () => status, url: () => url, headers: () => ({ 'content-type': 'text/html' }) };
            },
            async evaluate() { return undefined; },
            async addScriptTag() { return undefined; },
            async waitForTimeout() {},
            async screenshot() { return new Uint8Array(); },
            async close() {},
          } as unknown as PageLike;
          return page;
        },
        async close() {},
      };
      return ctx;
    },
  };
  return s;
}

async function load(b: BrowserLike, url: string): Promise<number> {
  const ctx = await b.newContext(VP);
  try {
    const p = await ctx.newPage();
    return (await p.goto(url))!.status();
  } finally {
    await ctx.close();
  }
}

const SITE = 'https://site.example/';

describe('loadOutcome: what one answer says about the session', () => {
  it('a refusal is the set loadFailure.ts calls one (202, a 4xx but 404/408/410, a WAF challenge); others are ok or neither', () => {
    expect(loadOutcome(406)).toBe('refused');
    expect(loadOutcome(403)).toBe('refused');
    expect(loadOutcome(202)).toBe('refused');
    expect(loadOutcome(200, { 'cf-mitigated': 'challenge' })).toBe('refused');
    expect(loadOutcome(200)).toBe('ok');
    expect(loadOutcome(301)).toBe('ok');
    for (const s of [404, 408, 410, 500, 503]) expect(loadOutcome(s)).toBe('other');
    expect(loadOutcome(undefined)).toBe('other');
  });
});

describe('sessionPool with sessions the site refuses', () => {
  it('with eight sessions, a refusal in the eighth retries in the seventh and swaps only the eighth address', async () => {
    const log: string[] = [];
    const sessions = Array.from({ length: 8 }, (_, i) => fakeSession(`s${i}`, () => i === 7 ? 406 : 200, log));
    const refused: [number, number | undefined][] = [];
    const swaps: number[] = [];
    const pool = sessionPool(sessions.map((s) => s.browser), {
      egress: {
        refused: (i, status) => refused.push([i, status]),
        swap: async (i) => {
          swaps.push(i);
          sessions[i]!.name += '-new';
          sessions[i]!.answer = () => 200;
          return true;
        },
      },
    });
    const held: ContextLike[] = [];
    try {
      for (let i = 0; i < 6; i++) held.push(await pool.audit.newContext(VP));
      expect(await load(pool.audit, SITE)).toBe(200); // seventh: proven to load the site
      expect(await load(pool.probe, `${SITE}x`)).toBe(406); // eighth: no success yet
      expect(refused).toEqual([]);
      const retry = await pool.refusedRetry(`${SITE}x`, 'probe');
      expect(retry).not.toBeNull();
      expect(await load(retry!, `${SITE}x`)).toBe(200);
      expect(log).toEqual(['s6 / 200', 's7 /x 406', 's6 /x 200']);
      await expect.poll(() => swaps).toEqual([7]);
      expect(refused).toEqual([[7, 406]]);
      expect(await load(pool.probe, `${SITE}x`)).toBe(200);
      expect(log.at(-1)).toBe('s7-new /x 200');
      expect(swaps).toEqual([7]);
    } finally {
      await Promise.all(held.map((c) => c.close()));
    }
  });

  it('a page refused in session A loads in B on the retry; A is reported refused and replaced, and its replacement takes work', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const b = fakeSession('b', () => 200, log);
    const refused: [number, number | undefined][] = [];
    const swaps: number[] = [];
    const pool = sessionPool([a.browser, b.browser], {
      drainMs: 50,
      egress: {
        refused: (i, status) => refused.push([i, status]),
        swap: async (i) => {
          swaps.push(i);
          a.name = 'a2';
          a.answer = () => 200; // a fresh session: a new address the site lets in
          return true;
        },
      },
    });
    // The first load goes to a (ties: the first session) and is refused; nothing else is known yet.
    expect(await load(pool.audit, `${SITE}x`)).toBe(406);
    expect(refused).toEqual([]);
    const retry = await pool.refusedRetry(`${SITE}x`);
    expect(retry).not.toBeNull();
    expect(await load(retry!, `${SITE}x`)).toBe(200);
    // The page a refused loaded in b: a's address is at fault.
    expect(refused).toEqual([[0, 406]]);
    await new Promise((r) => setTimeout(r, 20));
    expect(swaps).toEqual([0]);
    // Its replacement takes work again, and loads.
    const more = [];
    for (let i = 0; i < 4; i++) more.push(await load(pool.audit, `${SITE}p${i}`));
    expect(more.every((s) => s === 200)).toBe(true);
    expect(log.some((l) => l.startsWith('a2 '))).toBe(true);
    expect(log).toEqual(expect.arrayContaining(['a /x 406', 'b /x 200']));
  });

  it('without a swap, a session the site refuses takes no new work while another can', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const b = fakeSession('b', () => 200, log);
    const refused: number[] = [];
    const pool = sessionPool([a.browser, b.browser], { egress: { refused: (i) => refused.push(i) } });
    expect(await load(pool.audit, `${SITE}x`)).toBe(406);
    const retry = await pool.refusedRetry(`${SITE}x`);
    expect(await load(retry!, `${SITE}x`)).toBe(200);
    expect(refused).toEqual([0]);
    log.length = 0;
    for (let i = 0; i < 4; i++) expect(await load(pool.audit, `${SITE}q${i}`)).toBe(200);
    expect(log.every((l) => l.startsWith('b '))).toBe(true);
  });

  it('a page refused in two sessions while other pages load is a refusal of that page: no retry, no swap', async () => {
    const log: string[] = [];
    const answer = (url: string) => (url.endsWith('/members') ? 401 : 200);
    const a = fakeSession('a', answer, log);
    const b = fakeSession('b', answer, log);
    const swaps: number[] = [];
    const pool = sessionPool([a.browser, b.browser], { drainMs: 10, egress: { swap: async (i) => { swaps.push(i); return true; } } });
    expect(await load(pool.audit, `${SITE}`)).toBe(200);
    expect(await load(pool.audit, `${SITE}members`)).toBe(401);
    const retry = await pool.refusedRetry(`${SITE}members`);
    expect(retry).not.toBeNull();
    expect(await load(retry!, `${SITE}members`)).toBe(401);
    expect(await pool.refusedRetry(`${SITE}members`)).toBeNull();
    // Each session loaded a page of the site: neither is at fault.
    await new Promise((r) => setTimeout(r, 30));
    expect(swaps).toEqual([]);
    expect(log.filter((l) => l.endsWith('/members 401'))).toHaveLength(2);
  });

  it('one session (the free check): a refused page gets a fresh session once the host allows it; a host with none left gets null', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    let left = 1;
    const pool = sessionPool([a.browser], {
      drainMs: 10,
      egress: {
        swap: async () => {
          if (left-- <= 0) return false;
          a.name = 'a2';
          a.answer = () => 200;
          return true;
        },
      },
    });
    expect(await load(pool.audit, SITE)).toBe(406);
    const retry = await pool.refusedRetry(SITE);
    expect(retry).not.toBeNull();
    expect(await load(retry!, SITE)).toBe(200);
    // A site that refuses every address: once the swaps are used up there is no retry.
    a.answer = () => 406;
    expect(await load(pool.audit, `${SITE}b`)).toBe(406);
    expect(await pool.refusedRetry(`${SITE}b`)).toBeNull();
  });

  it('every session refusing everything ends: no swap hook means no retry once each session has refused', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const b = fakeSession('b', () => 406, log);
    const pool = sessionPool([a.browser, b.browser]);
    expect(await load(pool.audit, `${SITE}x`)).toBe(406);
    const r1 = await pool.refusedRetry(`${SITE}x`);
    expect(r1).not.toBeNull();
    expect(await load(r1!, `${SITE}x`)).toBe(406);
    expect(await pool.refusedRetry(`${SITE}x`)).toBeNull();
    // Another page: both sessions refused something and loaded nothing, so neither is worth a retry.
    expect(await load(pool.audit, `${SITE}y`)).toBe(406);
    expect(await pool.refusedRetry(`${SITE}y`)).toBeNull();
  });

  it('with no refusals nothing changes where work runs (the same order as before)', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 200, log);
    const b = fakeSession('b', () => 200, log);
    const pool = sessionPool([a.browser, b.browser], { egress: { swap: async () => true } });
    const held = await Promise.all([pool.audit.newContext(VP), pool.audit.newContext(VP), pool.audit.newContext(VP)]);
    for (const c of held) await (await c.newPage()).goto(`${SITE}z`);
    expect(log).toEqual(['a /z 200', 'b /z 200', 'a /z 200']);
  });
});

describe('the status of a load the browser threw on', () => {
  it('a navigation that ends net::ERR_HTTP_RESPONSE_CODE_FAILURE keeps the answer it got: HTTP 406', async () => {
    const listeners: ((r: SubresourceResponseLike) => void)[] = [];
    const mainFrame = { url: () => SITE, parentFrame: () => null };
    const page = {
      on(event: string, fn: (r: SubresourceResponseLike) => void) {
        if (event === 'response') listeners.push(fn);
      },
      mainFrame: () => mainFrame,
      async goto(url: string) {
        // The browser got the answer (the response event), then would not show it.
        const resp = { status: () => 406, url: () => url, headers: () => ({}), request: () => ({ method: () => 'GET', url: () => url, resourceType: () => 'document' }), frame: () => mainFrame };
        for (const fn of listeners) fn(resp as unknown as SubresourceResponseLike);
        throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${url}\nCall log: …`);
      },
      async evaluate() { return 1; },
      async addScriptTag() {},
      async waitForTimeout() {},
      async screenshot() { return new Uint8Array(); },
      async close() {},
      isClosed: () => false,
    };
    const browser: BrowserLike = { async newContext() { return { newPage: async () => page as unknown as PageLike, close: async () => {} }; } };
    const audit = await auditPage(browser, SITE, { userAgent: 'grnted-test', axeSource: '' });
    expect(audit.status).toBe('failed');
    expect(audit.httpStatus).toBe(406);
    expect(audit.reason).toBe('HTTP 406');
  });

  it('a frame\'s document answer is not the page\'s', async () => {
    const listeners: ((r: SubresourceResponseLike) => void)[] = [];
    const frame = { url: () => `${SITE}frame`, parentFrame: () => ({}) };
    const page = {
      on(event: string, fn: (r: SubresourceResponseLike) => void) {
        if (event === 'response') listeners.push(fn);
      },
      async goto(url: string) {
        const resp = { status: () => 406, url: () => url, headers: () => ({}), request: () => ({ method: () => 'GET', url: () => url, resourceType: () => 'document' }), frame: () => frame };
        for (const fn of listeners) fn(resp as unknown as SubresourceResponseLike);
        throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at x');
      },
      async evaluate() { return 1; },
      async addScriptTag() {},
      async waitForTimeout() {},
      async screenshot() { return new Uint8Array(); },
      async close() {},
      isClosed: () => false,
    };
    const browser: BrowserLike = { async newContext() { return { newPage: async () => page as unknown as PageLike, close: async () => {} }; } };
    const audit = await auditPage(browser, SITE, { userAgent: 'grnted-test', axeSource: '' });
    expect(audit.status).toBe('failed');
    expect(audit.httpStatus).toBeUndefined();
  });
});

describe('review r1: a swap never outlives the scan, and a refusal withdrawn before its drain swaps nothing', () => {
  it('a swap still waiting for its session\'s open context when the host closes the browsers launches nothing', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const b = fakeSession('b', () => 200, log);
    const fresh = fakeSession('fresh', () => 200, log);
    const opens: string[] = [];
    const ra = reconnectingBrowser({ browser: a.browser, close: async () => {} }, async () => {
      opens.push('open');
      return { browser: fresh.browser, close: async () => {} };
    });
    const swapped: boolean[] = [];
    const pool = sessionPool([ra.browser as unknown as BrowserLike, b.browser], {
      drainMs: 5_000,
      egress: { swap: async (i) => { const r = i === 0 ? await ra.swap() : false; swapped.push(r); return r; } },
    });
    // A context stays open in a while a is found at fault: the swap waits for it (drain).
    const held = await pool.audit.newContext(VP);
    const page = await held.newPage();
    expect((await page.goto(`${SITE}x`))!.status()).toBe(406);
    expect(await load(pool.audit, `${SITE}x`)).toBe(200);
    // The host ends the scan's browsers; then the open context closes and the drain ends.
    await ra.close();
    await held.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(opens).toEqual([]);
    expect(swapped).toEqual([false]);
  });

  it('a reopen asked for while close() is closing the sessions opens nothing either', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let alive = true;
    const first = {
      browser: { async newContext() { if (!alive) throw new Error('browser.newContext: Target page, context or browser has been closed'); return {}; }, isConnected: () => alive },
      async close() { alive = false; await slow; },
    };
    const opens: string[] = [];
    const r = reconnectingBrowser(first, async () => { opens.push('open'); return { browser: { async newContext() { return {}; } }, close: async () => {} }; });
    const closing = r.close();
    // While the first session is closing, the engine still asks for a context (work in flight).
    await expect(r.browser.newContext({} as never)).rejects.toThrow(/closed/);
    release();
    await closing;
    await new Promise((x) => setTimeout(x, 20));
    expect(opens).toEqual([]);
  });

  it('a refusal followed by a 200 on the same session before its drain ends (a pace retry) swaps nothing', async () => {
    const log: string[] = [];
    let tries = 0;
    const a = fakeSession('a', () => (++tries === 1 ? 406 : 200), log);
    const b = fakeSession('b', () => 200, log);
    const swaps: number[] = [];
    const pool = sessionPool([a.browser, b.browser], { drainMs: 5_000, egress: { swap: async (i) => { swaps.push(i); return true; } } });
    const held = await pool.audit.newContext(VP);
    const page = await held.newPage();
    expect((await page.goto(`${SITE}x`))!.status()).toBe(406);
    expect(await load(pool.audit, `${SITE}x`)).toBe(200); // b: a is now at fault, its swap waits for the held context
    expect((await page.goto(`${SITE}x`))!.status()).toBe(200); // the retry in a got the page
    await held.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(swaps).toEqual([]);
    // a takes work again.
    log.length = 0;
    await Promise.all([load(pool.audit, `${SITE}p`), load(pool.audit, `${SITE}q`)]);
    expect(log.some((l) => l.startsWith('a '))).toBe(true);
  });

  it('a session that already loaded a page of the site is never swapped for one refused page another session loaded', async () => {
    const log: string[] = [];
    const a = fakeSession('a', (url) => (url.endsWith('/x') ? 403 : 200), log);
    const b = fakeSession('b', () => 200, log);
    const swaps: number[] = [];
    const pool = sessionPool([a.browser, b.browser], { drainMs: 10, egress: { swap: async (i) => { swaps.push(i); return true; } } });
    expect(await load(pool.audit, `${SITE}`)).toBe(200); // a
    const held = await pool.audit.newContext(VP); // a, kept busy so the next load goes to b
    expect(await load(pool.audit, `${SITE}x`)).toBe(200); // b
    const page = await held.newPage();
    expect((await page.goto(`${SITE}x`))!.status()).toBe(403); // a: one refusal on a session that loads the site
    await held.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(swaps).toEqual([]);
  });

  it('a session with nothing loaded, refused on a page no other session has loaded, is not swapped yet', async () => {
    const log: string[] = [];
    const a = fakeSession('a', (url) => (url.endsWith('/members') ? 401 : 200), log);
    const b = fakeSession('b', () => 200, log);
    const swaps: number[] = [];
    const pool = sessionPool([a.browser, b.browser], { drainMs: 10, egress: { swap: async (i) => { swaps.push(i); return true; } } });
    const [x, y] = await Promise.all([load(pool.audit, `${SITE}members`), load(pool.audit, `${SITE}`)]);
    expect([x, y]).toEqual([401, 200]);
    await new Promise((r) => setTimeout(r, 30));
    expect(swaps).toEqual([]);
  });
});

describe('review r2: a retry swaps only a session that has loaded nothing, and close() closes a launch it caught mid-way', () => {
  it('a good session refused one page beside two unproven suspects: the retry swaps a suspect at once, never the good session, and the page is tried there', async () => {
    const log: string[] = [];
    const g = fakeSession('g', (url) => (url.endsWith('/members') ? 401 : 200), log);
    const s1 = fakeSession('s1', () => 406, log);
    const s2 = fakeSession('s2', () => 406, log);
    const swaps: number[] = [];
    const pool = sessionPool([g.browser, s1.browser, s2.browser], {
      drainMs: 2_000,
      egress: {
        swap: async (i) => {
          swaps.push(i);
          const fresh = [g, s1, s2][i]!;
          fresh.name = `${fresh.name}-new`;
          fresh.answer = (url) => (url.endsWith('/members') ? 401 : 200);
          return true;
        },
      },
    });
    // One context in each session (least busy first): g loads the site, s1 and s2 are refused pages no
    // other session has loaded (suspects, not proven at fault), then g is refused the members page.
    const [c0, c1, c2] = [await pool.audit.newContext(VP), await pool.audit.newContext(VP), await pool.audit.newContext(VP)];
    const [p0, p1, p2] = [await c0!.newPage(), await c1!.newPage(), await c2!.newPage()];
    expect((await p0.goto(SITE))!.status()).toBe(200);
    expect((await p1.goto(`${SITE}one`))!.status()).toBe(406);
    expect((await p2.goto(`${SITE}two`))!.status()).toBe(406);
    expect((await p0.goto(`${SITE}members`))!.status()).toBe(401);
    // g stays busy (its context open): a swap of g would wait out its drain.
    await c1!.close();
    await c2!.close();
    const started = Date.now();
    const retry = await pool.refusedRetry(`${SITE}members`);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(retry).not.toBeNull();
    expect(swaps).toEqual([1]);
    expect(await load(retry!, `${SITE}members`)).toBe(401);
    expect(log.at(-1)).toBe('s1-new /members 401');
    // Refused in two sessions while the site loads: the page's own refusal, no more retries.
    expect(await pool.refusedRetry(`${SITE}members`)).toBeNull();
    await c0!.close();
  });

  it('no session that has loaded nothing to swap (one session that loads the site, refused one page): null at once, and nothing is benched', async () => {
    const log: string[] = [];
    const g = fakeSession('g', (url) => (url.endsWith('/members') ? 401 : 200), log);
    const swaps: number[] = [];
    const pool = sessionPool([g.browser], { drainMs: 2_000, egress: { swap: async (i) => { swaps.push(i); return true; } } });
    const c0 = await pool.audit.newContext(VP);
    const p0 = await c0.newPage();
    expect((await p0.goto(SITE))!.status()).toBe(200);
    expect((await p0.goto(`${SITE}members`))!.status()).toBe(401);
    // Its context stays open: a swap of g would wait out the drain, and bench it meanwhile.
    const started = Date.now();
    expect(await pool.refusedRetry(`${SITE}members`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(swaps).toEqual([]);
    // g still takes work at once.
    const t = Date.now();
    expect(await load(pool.audit, `${SITE}b`)).toBe(200);
    expect(Date.now() - t).toBeLessThan(500);
    await c0.close();
  });

  it('a swap whose open() is still on its way when close() starts: the session it opens is closed, and nothing opens after', async () => {
    let releaseOpen!: () => void;
    const held = new Promise<void>((r) => { releaseOpen = r; });
    let opens = 0;
    let secondClosed = 0;
    const first = { browser: { async newContext() { return { name: 'first' }; } }, close: async () => {} };
    const second = { browser: { async newContext() { return { name: 'second' }; } }, close: async () => { secondClosed++; } };
    const r = reconnectingBrowser(first, async () => {
      opens++;
      await held;
      return second;
    }, { retryMs: [] });
    const swapped = r.swap();
    while (opens === 0) await new Promise((x) => setTimeout(x, 1));
    // close() starts while open() is held inside the swap's reopening.
    const closing = r.close();
    await new Promise((x) => setTimeout(x, 10));
    expect(secondClosed).toBe(0);
    releaseOpen();
    await closing;
    expect(await swapped).toBe(true);
    expect(secondClosed).toBe(1);
    expect(r.handles()).toContain(second);
    // Nothing opens after close(): a swap or a context asks in vain.
    expect(await r.swap()).toBe(false);
    await new Promise((x) => setTimeout(x, 10));
    expect(opens).toBe(1);
  });
});

// Staging scan 5b4986ad (2026-11-05, perrydale, 250 pages): 40 of 41 pages refused within ~11 s, a swap
// whose launch never came back, then every page worker waiting on it for ever (each holding its pace
// slot). The pool's waits are bounded, and a site that refuses even the session that loaded it is the
// site refusing us: no swap can help, so none is bought.
describe('bounded session waits and a site that refuses every session (staging 5b4986ad)', () => {
  const never = () => new Promise<never>(() => {});

  it('a retry whose swap never returns gives up at waitMs: null, and the page keeps its refusal', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const pool = sessionPool([a.browser], { drainMs: 10, egress: { swap: never, waitMs: 100 } });
    expect(await load(pool.audit, `${SITE}x`)).toBe(406);
    const started = Date.now();
    expect(await pool.refusedRetry(`${SITE}x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a context asked for while the only session is being replaced, and the swap never returns: it fails at waitMs as no session in time', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const pool = sessionPool([a.browser], { drainMs: 10, egress: { swap: never, waitMs: 100 } });
    expect(await load(pool.audit, `${SITE}x`)).toBe(406);
    void pool.refusedRetry(`${SITE}x`);
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    const err = await pool.audit.newContext(VP).then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err?.message).toMatch(/no browser session of the scan came free in time/);
    expect(isSessionWait(err?.message)).toBe(true);
    // A closed-browser error: the work is lost (no score), never taken as the site's answer.
    expect(isWorkLost(err?.message)).toBe(true);
  });

  it('one session loads the home page, then the site refuses every session, fresh ones too: no swap storm, the refused pages fail with their answer', async () => {
    const log: string[] = [];
    let loads = 0;
    // The first load anywhere gets in; every load after it is refused (the site now refuses us).
    const answer = () => (++loads === 1 ? 200 : 406);
    const sessions = [fakeSession('a', answer, log), fakeSession('b', answer, log), fakeSession('c', answer, log)];
    const swaps: number[] = [];
    const told: string[] = [];
    const pool = sessionPool(sessions.map((s) => s.browser), {
      drainMs: 10,
      egress: {
        swap: async (i) => { swaps.push(i); sessions[i]!.name += '+'; return true; },
        siteRefuses: () => told.push('site'),
      },
    });
    expect(await load(pool.audit, SITE)).toBe(200);
    // Pages as the scan runs them: each load, then its retries (REFUSED_RETRIES) while refused.
    const page = async (url: string) => {
      let status = await load(pool.audit, url);
      for (let n = 0; n < 2 && status === 406; n++) {
        const other = await pool.refusedRetry(url);
        if (!other) break;
        status = await load(other, url);
      }
      return status;
    };
    const started = Date.now();
    const statuses = await Promise.all(Array.from({ length: 12 }, (_, i) => page(`${SITE}p${i}`)));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(statuses.every((s) => s === 406)).toBe(true);
    // At most the swaps started before the evidence was in (one per place), never one per page.
    expect(swaps.length).toBeLessThanOrEqual(sessions.length);
    expect(told).toEqual(['site']);
    // Once it is known, no more: a further refused page is not retried and swaps nothing.
    const before = swaps.length;
    expect(await load(pool.audit, `${SITE}late`)).toBe(406);
    expect(await pool.refusedRetry(`${SITE}late`)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(swaps.length).toBe(before);
  });

  it('the case swaps are for still swaps: one address refused while another loads the site', async () => {
    const log: string[] = [];
    const a = fakeSession('a', () => 406, log);
    const b = fakeSession('b', () => 200, log);
    const swaps: number[] = [];
    const told: string[] = [];
    const pool = sessionPool([a.browser, b.browser], {
      drainMs: 10,
      egress: { swap: async (i) => { swaps.push(i); a.name = 'a2'; a.answer = () => 200; return true; }, siteRefuses: () => told.push('site') },
    });
    const statuses = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const url = `${SITE}q${i}`;
      let s = await load(pool.audit, url);
      for (let n = 0; n < 2 && s === 406; n++) {
        const other = await pool.refusedRetry(url);
        if (!other) break;
        s = await load(other, url);
      }
      return s;
    }));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(swaps).toEqual([0]);
    expect(told).toEqual([]);
  });

  it.each([2, 8])('Sol r1: with %i sessions, after A recovers from three 429s, the last session refusing the same shared URL is address evidence again', async (count) => {
    const log: string[] = [];
    const a = fakeSession('a', (url) => (new URL(url).pathname.startsWith('/busy') ? 429 : 200), log);
    const b = fakeSession('b', () => 406, log);
    const swaps: number[] = [];
    const told: string[] = [];
    const middle = Array.from({ length: count - 2 }, (_, i) => fakeSession(`middle${i}`, () => 200, log));
    const pool = sessionPool([a.browser, ...middle.map((s) => s.browser), b.browser], {
      drainMs: 10,
      onSiteRefuses: () => told.push('pace'),
      egress: {
        swap: async (i) => { swaps.push(i); return true; },
        siteRefuses: () => told.push('site'),
      },
    });
    // Sol's literal sequence: A 200, A 429 x3, A /shared 200, B /shared 406.
    expect(await load(pool.audit, SITE)).toBe(200);
    for (const path of ['busy1', 'busy2', 'busy3']) expect(await load(pool.audit, `${SITE}${path}`)).toBe(429);
    expect(told).toEqual(['site', 'pace']);
    expect(await load(pool.audit, `${SITE}shared`)).toBe(200);
    expect(await load(pool.probe, `${SITE}shared`)).toBe(406);
    expect(log).toEqual(['a / 200', 'a /busy1 429', 'a /busy2 429', 'a /busy3 429', 'a /shared 200', 'b /shared 406']);
    await expect.poll(() => swaps).toEqual([count - 1]);
    // Recovery allows new address evidence, but a second refusal streak must not notify the host or pace twice.
    for (const path of ['busy4', 'busy5', 'busy6']) expect(await load(pool.audit, `${SITE}${path}`)).toBe(429);
    expect(told).toEqual(['site', 'pace']);
  });

  it.each([2, 8])('Sol r1: with %i sessions, without recovery, a blanket refusal adds no address evidence and swaps nothing', async (count) => {
    const log: string[] = [];
    const a = fakeSession('a', (url) => (url === SITE ? 200 : 429), log);
    const b = fakeSession('b', () => 406, log);
    const swaps: number[] = [];
    const told: string[] = [];
    const middle = Array.from({ length: count - 2 }, (_, i) => fakeSession(`middle${i}`, () => 200, log));
    const pool = sessionPool([a.browser, ...middle.map((s) => s.browser), b.browser], {
      drainMs: 10,
      egress: {
        swap: async (i) => { swaps.push(i); return true; },
        siteRefuses: () => told.push('site'),
      },
    });
    expect(await load(pool.audit, SITE)).toBe(200);
    for (const path of ['busy1', 'busy2', 'busy3']) expect(await load(pool.audit, `${SITE}${path}`)).toBe(429);
    expect(told).toEqual(['site']);
    // The home page loaded before the blanket refusal; that old success must not incriminate B now.
    expect(await load(pool.probe, SITE)).toBe(406);
    expect(await pool.refusedRetry(SITE)).not.toBeNull(); // a retry in proven A is still allowed, without a swap
    expect(swaps).toEqual([]);
  });
});

describe('review r1 (Grok): the site-wide rule needs a streak, never one blocked address plus a few gated pages', () => {
  it('A is blocked on every page, B loads the site and serves one 429, a 401 and a 403 (and a 429 on a second width): A is still swapped, the rule never fires, the pace is not held, and B still takes retries', async () => {
    const log: string[] = [];
    const answer = (url: string) => (url.endsWith('/busy') ? 429 : url.endsWith('/members') ? 401 : url.endsWith('/admin') ? 403 : 200);
    const a = fakeSession('a', () => 406, log);
    let widths = 0;
    const b = fakeSession('b', (url) => (url.endsWith('/wide') ? (++widths === 1 ? 200 : 429) : answer(url)), log);
    const swaps: number[] = [];
    const told: string[] = [];
    const held: string[] = [];
    const pool = sessionPool([a.browser, b.browser], {
      drainMs: 10,
      onSiteRefuses: () => held.push('pace'),
      egress: {
        swap: async (i) => { swaps.push(i); return false; }, // the host's cap: A stays blocked
        siteRefuses: () => told.push('site'),
      },
    });
    const one = async (url: string) => {
      let s = await load(pool.audit, url);
      for (let n = 0; n < 2 && s >= 400 && s !== 404; n++) {
        const other = await pool.refusedRetry(url);
        if (!other) break;
        s = await load(other, url);
      }
      return s;
    };
    expect(await one(`${SITE}x`)).toBe(200); // refused in A, loaded on the retry in B: A is at fault
    await new Promise((r) => setTimeout(r, 30));
    expect(swaps).toEqual([0]);
    // B: the page at both widths (the second answers 429), a 429, then two gated pages.
    expect(await load(pool.audit, `${SITE}wide`)).toBe(200);
    expect(await load(pool.audit, `${SITE}wide`)).toBe(429);
    for (const u of ['busy', 'members', 'admin']) await load(pool.audit, `${SITE}${u}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(told).toEqual([]);
    expect(held).toEqual([]);
    // A page refused in A is still retried in B.
    expect(await one(`${SITE}y`)).toBe(200);
  });
});

describe('review r1 (Grok): a page that waited past the session wait never unscores the scan', () => {
  it('it is not checked, with its own reason, never a lost browser', async () => {
    const { scanSite } = await import('../../src/scan.js');
    const { isPageLost } = await import('../../src/reconnect.js');
    const log: string[] = [];
    // One session, refused, whose swap never comes back: every later context waits for it.
    const a = fakeSession('a', () => 406, log);
    const report = await scanSite(SITE, {
      browser: a.browser, sessions: [], maxPages: 4, concurrency: 1, probes: false,
      // The site lists its pages in a sitemap: discovery loads none of them in the browser.
      fetchFn: (async (u: string | URL | Request) => {
        const url = String(u instanceof Request ? u.url : u);
        if (url.endsWith('/sitemap.xml')) {
          const locs = ['', 'a', 'b', 'c'].map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('');
          return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } });
        }
        return new Response('', { status: 404 });
      }) as typeof fetch,
      axeSource: '',
      egress: { swap: () => new Promise<boolean>(() => {}), waitMs: 100 },
    });
    expect(report.pages.length).toBeGreaterThan(0);
    expect(report.pages.some((p) => isPageLost(p.reason))).toBe(false);
    expect(report.reasons.some((r) => /browser the scan ran in closed/i.test(r))).toBe(false);
  }, 20_000);
});

describe('review r1 (Grok): a context close that never answers does not hold the page (or its pace slot)', () => {
  const stuckClose = (b: BrowserLike): BrowserLike => ({
    async newContext(o) {
      const ctx = await b.newContext(o);
      return Object.assign(ctx, { close: () => new Promise<void>(() => {}) });
    },
  });

  it('the audit ends within CONTEXT_CLOSE_MS of its result', async () => {
    const { CONTEXT_CLOSE_MS } = await import('../../src/reconnect.js');
    const a = fakeSession('a', () => 406, []);
    const started = Date.now();
    const page = await auditPage(stuckClose(a.browser), `${SITE}x`, { userAgent: 'UA', axeSource: '' });
    expect(page.reason).toBe('HTTP 406');
    expect(Date.now() - started).toBeLessThan(CONTEXT_CLOSE_MS + 2_000);
  }, 15_000);

  it('a pool context\'s close ends within CONTEXT_CLOSE_MS too', async () => {
    const { CONTEXT_CLOSE_MS } = await import('../../src/reconnect.js');
    const pool = sessionPool([stuckClose(fakeSession('a', () => 200, []).browser), fakeSession('b', () => 200, []).browser]);
    const ctx = await pool.audit.newContext(VP);
    const started = Date.now();
    await ctx.close();
    expect(Date.now() - started).toBeLessThan(CONTEXT_CLOSE_MS + 2_000);
  }, 15_000);
});

describe('review r2 (Grok): a pool context close that fails after its bound is handled', () => {
  it('no unhandled rejection when the close rejects after CONTEXT_CLOSE_MS', async () => {
    const { CONTEXT_CLOSE_MS } = await import('../../src/reconnect.js');
    const a = fakeSession('a', () => 200, []);
    const late: BrowserLike = {
      async newContext(o) {
        const ctx = await a.browser.newContext(o);
        return Object.assign(ctx, { close: () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error('Target closed')), CONTEXT_CLOSE_MS + 100)) });
      },
    };
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      const pool = sessionPool([late, fakeSession('b', () => 200, []).browser]);
      const ctx = await pool.audit.newContext(VP);
      await ctx.close();
      await new Promise((r) => setTimeout(r, 400));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  }, 15_000);
});
