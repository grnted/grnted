// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A browser that outlives its session (`reconnectingBrowser`), and the report when work was lost
// with it (`browserLost`).
import { describe, expect, it } from 'vitest';
import { BROWSER_LOST, BROWSER_LOST_PAGE, cdpSession, GATE_LOST, isBrowserGone, isWorkLost, pageGone, reconnectingBrowser, type BrowserHandle } from '../../src/reconnect.js';
import { NOT_ALLOWED } from '../../src/navigationGate.js';
import { browserLost } from '../../src/report/build.js';
import type { PageAudit, ProbeRun } from '../../src/types.js';

const CLOSED = 'browser.newContext: Target page, context or browser has been closed';

/** A fake session: contexts until `kill()`, then every call fails as a closed browser does. */
function fake(name: string) {
  let alive = true;
  const listeners: (() => void)[] = [];
  let closed = 0;
  const handle: BrowserHandle & { kill(): void; closed(): number } = {
    browser: {
      async newContext() {
        if (!alive) throw new Error(CLOSED);
        return { name };
      },
      async newBrowserCDPSession() {
        if (!alive) throw new Error('browser.newBrowserCDPSession: Target page, context or browser has been closed');
        return { name };
      },
      isConnected: () => alive,
      on(event: string, fn: () => void) { if (event === 'disconnected') listeners.push(fn); },
    },
    async close() { closed++; },
    kill() { alive = false; for (const fn of listeners) fn(); },
    closed: () => closed,
  };
  return handle;
}

describe('reconnectingBrowser.swap (a session the site refuses)', () => {
  it('retires the current session (told why), opens a fresh one in its place, and does not use up a reopen', async () => {
    const a = fake('a');
    const b = fake('b');
    const c = fake('c');
    const next = [b, c];
    const retired: string[] = [];
    const opened: BrowserHandle[] = [];
    const r = reconnectingBrowser(a, async () => next.shift()!, {
      maxReopens: 1,
      retire: async (h, why) => { retired.push(`${h === a ? 'a' : h === b ? 'b' : 'c'} ${why}`); await h.close(); },
      onOpen: (h) => opened.push(h),
    });
    expect(await r.swap()).toBe(true);
    expect(retired).toEqual(['a swap']);
    expect(opened).toEqual([b]);
    expect(await r.browser.newContext({} as never)).toEqual({ name: 'b' });
    expect([r.swapped(), r.reopened()]).toEqual([1, 0]);
    // A loss after the swap still has its reopen.
    b.kill();
    expect(await r.browser.newContext({} as never)).toEqual({ name: 'c' });
    expect([r.swapped(), r.reopened()]).toEqual([1, 1]);
    expect(retired).toEqual(['a swap', 'b lost']);
    await r.close();
    expect([a.closed(), b.closed(), c.closed()]).toEqual([1, 1, 1]);
  });

  it('a swap whose launch is refused says false, and the browser reopens on its next use', async () => {
    const a = fake('a');
    const b = fake('b');
    let tries = 0;
    const r = reconnectingBrowser(a, async () => {
      if (++tries === 1) throw new Error('429 too many sessions');
      return b;
    }, { retryMs: [] });
    expect(await r.swap()).toBe(false);
    expect(await r.browser.newContext({} as never)).toEqual({ name: 'b' });
    expect(r.reopened()).toBe(1);
  });
});

describe('reconnectingBrowser', () => {
  it('opens a new browser on the next context after the current one is lost, once for concurrent callers, and closes all', async () => {
    const a = fake('a');
    const b = fake('b');
    let opens = 0;
    const r = reconnectingBrowser(a, async () => { opens++; return b; });
    expect(await r.browser.newContext({} as never)).toEqual({ name: 'a' });
    a.kill();
    const [x, y] = await Promise.all([r.browser.newContext({} as never), r.browser.newBrowserCDPSession!()]);
    expect([x, y]).toEqual([{ name: 'b' }, { name: 'b' }]);
    expect(opens).toBe(1);
    expect(r.reopened()).toBe(1);
    await r.close();
    expect([a.closed(), b.closed()]).toEqual([1, 1]);
  });

  it('also when it learns of the loss from a call that fails as closed (no event, still reported connected)', async () => {
    const a = fake('a');
    const b = fake('b');
    const quiet = { ...a, browser: { ...(a.browser as object), isConnected: () => true, on() {} } };
    const r = reconnectingBrowser(quiet, async () => b);
    a.kill();
    expect(await r.browser.newContext({} as never)).toEqual({ name: 'b' });
  });

  it('stops after maxReopens: a lost browser then stays lost (the call fails as closed); other errors pass through', async () => {
    const a = fake('a');
    const r = reconnectingBrowser(a, async () => fake('never'), { maxReopens: 0 });
    a.kill();
    await expect(r.browser.newContext({} as never)).rejects.toThrow(/has been closed/);
    const failing = { ...fake('c'), browser: { async newContext() { throw new Error('net::ERR_FAILED'); } } };
    await expect(reconnectingBrowser(failing, async () => fake('d')).browser.newContext({} as never)).rejects.toThrow('net::ERR_FAILED');
  });

  it('a gate whose session closed is lost work (done again), a refusal is not', () => {
    expect(isWorkLost(GATE_LOST)).toBe(true);
    expect(isWorkLost('page.evaluate: Target page, context or browser has been closed')).toBe(true);
    expect(isWorkLost(NOT_ALLOWED)).toBe(false);
    expect(isWorkLost('page.goto: net::ERR_ABORTED at https://e.org/')).toBe(false);
    expect(isWorkLost(undefined)).toBe(false);
  });

  it('asks the page itself when an error does not say it is gone', async () => {
    expect(await pageGone({ async evaluate() { return 1; } })).toBe(false);
    expect(await pageGone({ async evaluate() { throw new Error('page.evaluate: Target page, context or browser has been closed'); } })).toBe(true);
    expect(await pageGone({ async evaluate() { return 1; }, isClosed: () => true })).toBe(true);
    // A page that does not answer is hung, not gone.
    expect(await pageGone({ evaluate: () => new Promise(() => {}) }, 50)).toBe(false);
  });

  it('frees the lost session before opening the next; a launch refused at the limit is tried again, and only a launch that works counts', async () => {
    const a = fake('a');
    const b = fake('b');
    const order: string[] = [];
    let launches = 0;
    const r = reconnectingBrowser(a, async () => {
      order.push(`launch ${++launches}`);
      if (launches === 1) throw new Error('429 Too many sessions');
      return b;
    }, { retryMs: [10], retire: async (h) => { order.push(`retire ${h === a ? 'a' : '?'}`); } });
    a.kill();
    expect(await r.browser.newContext({} as never)).toEqual({ name: 'b' });
    expect(order).toEqual(['retire a', 'launch 1', 'launch 2']);
    expect(r.reopened()).toBe(1);
    // Every try refused (no retry left, or past `until`): lost for now, the reopen not used up.
    const c = fake('c');
    const d = fake('d');
    let n = 0;
    const r2 = reconnectingBrowser(c, async () => { if (++n <= 2) throw new Error('429'); return d; }, { retryMs: [], retire: async () => {} });
    c.kill();
    await expect(r2.browser.newContext({} as never)).rejects.toThrow(/has been closed \(no new browser: 429/);
    expect(r2.reopened()).toBe(0);
    await expect(r2.browser.newContext({} as never)).rejects.toThrow(/has been closed/);
    // Two reopenings failed in full: lost for good, no third launch.
    await expect(r2.browser.newContext({} as never)).rejects.toThrow(/no new one could be opened/);
    expect(n).toBe(2);
  });

  it('tells a closed browser from other errors', () => {
    expect(isBrowserGone(new Error(CLOSED))).toBe(true);
    expect(isBrowserGone('page.evaluate: Target page, context or browser has been closed')).toBe(true);
    expect(isBrowserGone('Browser has been closed.')).toBe(true);
    expect(isBrowserGone('page.goto: net::ERR_NAME_NOT_RESOLVED')).toBe(false);
    expect(isBrowserGone('timed out after 15 s')).toBe(false);
  });
});

describe('a report with work lost with the browser', () => {
  const scored = { status: 'scored' as const, score: 91, letter: 'A' as const, headline: 'Access Granted' as const, reasons: [] as string[], pageScores: new Map(), pointsLost: { x: 1 }, probePointsLost: {}, aiPointsLost: {}, documentPointsLost: 0 };
  const page = (reason?: string): PageAudit => ({ url: 'https://e.org/', status: reason ? 'failed' : 'ok', ...(reason ? { reason } : {}), rules: {}, violations: [], incomplete: [], links: [] });
  const run = (probe: string, detail: string): ProbeRun => ({ probe, kind: 'render', page: 'https://e.org/', criteria: ['1.3.1'], status: 'error', findings: [{ criterion: '1.3.1', status: 'not_testable', detail }], ms: 0 });

  it('gives no score, and says why first, when a page or a scored test could not be redone', () => {
    const lost = browserLost(scored, [page(), page(BROWSER_LOST_PAGE)], []);
    expect(lost).toMatchObject({ status: 'incomplete', score: null, letter: null, headline: 'Scan incomplete', pointsLost: {} });
    expect(lost.reasons[0]).toMatch(/^The browser the scan ran in closed, and 1 page could not be redone/);
    expect(browserLost(scored, [page()], [run('headings', BROWSER_LOST), run('text-contrast', BROWSER_LOST)]).reasons[0]).toMatch(/2 automated test runs could not be redone/);
  });

  it('keeps the score for other errors and for unscored tests (v8: keyboard-deep)', () => {
    expect(browserLost(scored, [page(), page('HTTP 500')], [run('headings', 'timed out after 15 s'), run('keyboard-deep', BROWSER_LOST)])).toBe(scored);
  });
});

// Staging scan 5b4986ad (2026-11-05): a swap's launch never returned, and the scan's close waited on it
// (and on each session's own close) for ever: no report, the order still running 15 minutes later.
describe('bounded close: a stuck launch or close never freezes the end of a scan', () => {
  const never = () => new Promise<never>(() => {});
  const within = async <T>(p: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`still waiting after ${ms} ms`)), ms); })]);
    } finally {
      clearTimeout(timer);
    }
  };

  it('a session whose close never returns: close() ends at closeMs and names it as not closed', async () => {
    const a = { ...fake('a'), close: never };
    const r = reconnectingBrowser(a, async () => fake('b'), { closeMs: 50 });
    const left = await within(r.close(), 1_000);
    expect(left).toEqual([a]);
  });

  it('a swap whose launch never returns: close() ends at closeMs; the session it opens later is handed to onLate, never kept', async () => {
    let arrive!: (h: BrowserHandle) => void;
    const late: BrowserHandle[] = [];
    const a = fake('a');
    const b = fake('b');
    const r = reconnectingBrowser(a, () => new Promise<BrowserHandle>((res) => { arrive = res; }), { closeMs: 50, retryMs: [], onLate: (h) => late.push(h) });
    const swapped = r.swap();
    await new Promise((x) => setTimeout(x, 5));
    await within(r.close(), 1_000);
    expect(a.closed()).toBeGreaterThan(0);
    arrive(b);
    await new Promise((x) => setTimeout(x, 5));
    expect(late).toEqual([b]);
    // Nothing opened after close() is used: the swap says it did not happen.
    expect(await swapped).toBe(false);
  });

  it('without onLate, a session that arrives after close() gave up is closed by its own handle', async () => {
    let arrive!: (h: BrowserHandle) => void;
    const b = fake('b');
    const r = reconnectingBrowser(fake('a'), () => new Promise<BrowserHandle>((res) => { arrive = res; }), { closeMs: 20, retryMs: [] });
    void r.swap();
    await new Promise((x) => setTimeout(x, 5));
    await within(r.close(), 1_000);
    arrive(b);
    await new Promise((x) => setTimeout(x, 5));
    expect(b.closed()).toBe(1);
  });
});

describe('review r1 (Grok): nothing is launched once close() started, and a close that fails is not taken as closed', () => {
  it('a reopen whose launch was refused does not try again once close() started (no launch after close)', async () => {
    let opens = 0;
    const a = fake('a');
    const r = reconnectingBrowser(a, async () => { opens++; throw new Error('429 too many sessions'); }, { retryMs: [80, 80], closeMs: 50 });
    const swapped = r.swap();
    while (opens === 0) await new Promise((x) => setTimeout(x, 1));
    // The first launch was refused; the reopen now sleeps before its next try. The scan closes.
    await r.close();
    await new Promise((x) => setTimeout(x, 250));
    expect(opens).toBe(1);
    expect(await swapped).toBe(false);
  });

  it('a session whose close rejects (its connection already gone) is returned as not closed, for the host to end by id', async () => {
    const a = { ...fake('a'), close: async () => { throw new Error('Target page, context or browser has been closed'); } };
    const r = reconnectingBrowser(a, async () => fake('b'), { closeMs: 50 });
    expect(await r.close()).toEqual([a]);
  });
});

describe('cdpSession: a CDP session asked for as the browser closes never freezes the scan', () => {
  // Playwright left context.newCDPSession(page) unanswered for good when the browser closed as it was made
  // (the CI runner, 2026-11-09: browserLost.test.ts hung in the probes' popup sandbox).
  type S = { detach(): Promise<void>; detached: boolean };
  const session = (): S => { const s: S = { detached: false, detach: async () => { s.detached = true; } }; return s; };

  it('a page that closes while the session is asked for: rejected as a closed browser, and a late session is detached', async () => {
    let closed = false;
    let answer!: (s: S) => void;
    const asked = new Promise<S>((r) => { answer = r; });
    const p = cdpSession({ newCDPSession: () => asked }, { isClosed: () => closed });
    setTimeout(() => { closed = true; }, 50);
    const err = await p.then(() => null, (e: unknown) => e);
    expect(isBrowserGone(err)).toBe(true);
    const late = session();
    answer(late);
    await new Promise((r) => setTimeout(r, 0));
    expect(late.detached).toBe(true);
  });

  it('a page already closed: rejected at once, nothing asked', async () => {
    let calls = 0;
    const err = await cdpSession({ newCDPSession: async () => { calls++; return session(); } }, { isClosed: () => true }).then(() => null, (e: unknown) => e);
    expect(isBrowserGone(err)).toBe(true);
    expect(calls).toBe(0);
  });

  it('a page that stays open is waited for as long as the session takes, and keeps it', async () => {
    const s = session();
    const got = await cdpSession({ newCDPSession: () => new Promise<S>((r) => setTimeout(() => r(s), 350)) }, { isClosed: () => false });
    expect(got).toBe(s);
    expect(s.detached).toBe(false);
  });

  it('the browser refusing the session is passed on as it was', async () => {
    await expect(cdpSession({ newCDPSession: () => Promise.reject(new Error('Not supported')) }, { isClosed: () => false })).rejects.toThrow('Not supported');
  });
});
