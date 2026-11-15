// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A browser that outlives its session: when the browser the scan runs in closes (a remote browser
// session ended, the browser process died), the next new context opens a new browser through the
// host's `open` and goes on there. Work that was running in the old one fails with Playwright's
// "Target page, context or browser has been closed"; the engine runs that work again
// (`isBrowserGone`) and, where it cannot, says so in the report instead of scoring without it.
// Engine core: no Node-only imports.
import { matchedContextOptions } from './userAgent.js';

/** The browser objects this wraps: Playwright's Browser (local or @cloudflare/playwright). */
export interface RawBrowser {
  newContext(opts: never): Promise<unknown>;
  newBrowserCDPSession?(): Promise<unknown>;
  isConnected?(): boolean;
  on?(event: 'disconnected', fn: () => void): unknown;
}

/** One browser session the host opened. */
export interface BrowserHandle {
  browser: unknown;
  /** The host's id for the session (Browser Rendering), for its records and to close it if orphaned. */
  sessionId?: string;
  close(): Promise<void>;
}

export interface ReconnectingBrowser {
  /** Use in place of the first handle's browser (same calls; contexts are the current browser's own). */
  browser: RawBrowser;
  /** Every session opened so far, the first included (all closed by `close`). */
  handles(): readonly BrowserHandle[];
  /** Times the browser was lost and a new one opened. */
  reopened(): number;
  /**
   * Ends the current session and opens a fresh one in its place (the site refuses this one's address:
   * src/sessions.ts). The old one is retired first (`retire`, told why), the new one goes to `onOpen`,
   * and it does not count toward `maxReopens`. True once the new one is current; false when none
   * could be opened (the browser then reopens as if lost, on its next use).
   */
  swap(): Promise<boolean>;
  /** Sessions replaced by `swap`. */
  swapped(): number;
  /**
   * Closes every session opened, waiting at most about `closeMs` for each step (a launch on its way, the
   * sessions' own closes). Resolves with the sessions whose close did not answer in time (the host then
   * ends them by id; one whose close failed too). A session a launch brings after close() gave up on it goes to `onLate`.
   */
  close(): Promise<BrowserHandle[]>;
}

export interface ReconnectOptions {
  /** New browsers opened at most (default 2); once used up, a lost browser stays lost. */
  maxReopens?: number;
  /** A new session opened (to record its id). */
  onOpen?(h: BrowserHandle): void;
  /** The current session was found lost (before a new one is opened). */
  onLost?(h: BrowserHandle): void;
  /**
   * Frees the lost session before the new one is opened (a remote browser service counts sessions:
   * a launch while the lost one still holds its slot can be refused). Waited for, at most
   * `retireMs` (default 5000). Default: the handle's own `close`.
   */
  retire?(h: BrowserHandle, why: 'lost' | 'swap'): Promise<void>;
  retireMs?: number;
  /**
   * Waits before trying `open` again when it fails (a launch refused at the session limit): one
   * reopening tries `1 + retryMs.length` times (default [1000, 2000, 5000]), never past `until()`.
   * Only an open that worked counts toward `maxReopens`; two reopenings that failed in full leave
   * the browser lost.
   */
  retryMs?: readonly number[];
  until?(): number;
  /**
   * Longest close() waits for each of its steps (a reopening on its way, then the sessions' closes):
   * default CLOSE_MS. A browser call that never answers must not keep a scan from ending.
   */
  closeMs?: number;
  /**
   * A session that a launch brought after close() stopped waiting for it: never used, handed over to be
   * ended (by id too). Default: its own `close`. Must not throw.
   */
  onLate?(h: BrowserHandle): void;
}

/** Longest close() waits for each step by default (reconnectingBrowser `closeMs`). */
export const CLOSE_MS = 10_000;

/** Longest a browser context's close is waited for (a page audit's, a pool context's): it goes on, unwaited. */
export const CONTEXT_CLOSE_MS = 5_000;

/**
 * Whether `p` ended within `ms`: settled at all, or (`fulfilled`) without an error. It is never
 * cancelled: past `ms` it goes on, unwaited.
 */
export async function settlesWithin(p: Promise<unknown>, ms: number, fulfilled = false): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.then(() => true, () => !fulfilled), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A core test's result when the browser was lost (closed under the test, or no context could be
 * opened) and running it again in a new one did not work either (`runGroup`). While a scored test
 * has this result the report gives no score: it never counts as if the test had passed.
 */
export const BROWSER_LOST = 'the browser closed while this test ran and it could not be run again, so the scan has no result for it';
/**
 * A gated page whose checking session closed (the page's or the browser's CDP session: what a
 * browser that closes, or a page that crashes, does to it). Nothing on the page stands, like a
 * refusal, but it is lost work, not the site's doing: it is done again in a new context, and when
 * that fails too the scan has no score (`isWorkLost`).
 */
export const GATE_LOST = 'the page could not be checked: the browser session that checks its addresses closed';
/**
 * A page's reason when the browser closed under its audit and it was not checked again (a hosted long
 * scan's page waiting for its retry in fresh sessions, or out of time for one): the report gives no score.
 */
export const BROWSER_CLOSED_PAGE = 'the browser closed while this page was checked';
/** A page's reason when the browser closed under its audit and every check again failed too: no score either. */
export const BROWSER_LOST_PAGE = `${BROWSER_CLOSED_PAGE} and it could not be checked again`;
/** A page the browser closed under, retried or not: the scan has no score while it stays so. */
export function isPageLost(reason: string | undefined): boolean {
  return reason === BROWSER_LOST_PAGE || reason === BROWSER_CLOSED_PAGE;
}

/**
 * In the error of a browser whose every reopen is used up (`reconnectingBrowser`): lost for good. Any
 * other closed-browser error of a reconnecting browser may still be followed by a new browser.
 */
export const BROWSER_EXHAUSTED = 'the browser was lost and no new one could be opened';

/** The error of a reconnecting browser that has no reopen left. */
export function isBrowserExhausted(err: unknown): boolean {
  const message = typeof err === 'string' ? err : String((err as Error)?.message ?? err);
  return message.includes(BROWSER_EXHAUSTED);
}

/** Playwright's error for a call into a page, context or browser that is closed. */
const GONE = /target (page, context or browser )?(has been )?closed|browser has been closed|browser (has )?disconnected|browser closed|websocket (is )?closed|connection closed/i;

/** Work the browser lost (closed under it, or its gate's session closed): done again, never taken as the site's result. */
export function isWorkLost(reason: string | undefined): boolean {
  return !!reason && (reason === GATE_LOST || isBrowserGone(reason));
}

/**
 * After a call into `page` failed in a way that does not say why (a navigation that ends with
 * net::ERR_ABORTED as the browser goes away): whether the page, its context or the browser is gone.
 * One cheap call into the page, at most `ms`; a page that does not answer in time is not gone (hung).
 */
export async function pageGone(page: { evaluate(fn: () => unknown, arg?: unknown): Promise<unknown>; isClosed?(): boolean }, ms = 2000): Promise<boolean> {
  if (page.isClosed?.()) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([page.evaluate(() => 1), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    return !!page.isClosed?.();
  } catch (err) {
    return !!page.isClosed?.() || isBrowserGone(err);
  } finally {
    clearTimeout(timer);
  }
}

/** How often `cdpSession` looks whether its page closed while the session is asked for. */
const CDP_CLOSED_POLL_MS = 100;

/**
 * `context.newCDPSession(page)`, given up as a closed browser once the page is closed. Playwright can leave
 * that call unanswered for good when the browser closes as it is made (the CI runner, 2026-11-09: a scan whose
 * browser closed with no new one to open hung in the probes' popup sandbox, browserLost.test.ts). Every CDP
 * session the engine opens goes through here. A page that stays open is waited for as long as the call
 * takes, as before; a session that comes after the page closed is detached.
 */
export function cdpSession<S extends { detach?(): Promise<void> }, P extends { isClosed?(): boolean }>(
  context: { newCDPSession?(page: P): Promise<S> },
  page: P,
): Promise<S> {
  if (!context.newCDPSession) return Promise.reject(new Error('the browser has no CDP sessions'));
  if (page.isClosed?.()) return Promise.reject(new Error('Target page, context or browser has been closed'));
  const asked = context.newCDPSession(page);
  if (!page.isClosed) return asked;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const watch = new Promise<never>((_, reject) => {
    const look = () => {
      if (page.isClosed!()) {
        closed = true;
        reject(new Error('Target page, context or browser has been closed (no answer to the CDP session it asked for)'));
      } else timer = setTimeout(look, CDP_CLOSED_POLL_MS);
    };
    timer = setTimeout(look, CDP_CLOSED_POLL_MS);
  });
  asked.then((s) => { if (closed) void s.detach?.().catch(() => {}); }, () => {});
  return Promise.race([asked, watch]).finally(() => clearTimeout(timer));
}

/** The error says the page, its context or the browser was closed (what a lost browser looks like). */
export function isBrowserGone(err: unknown): boolean {
  const message = typeof err === 'string' ? err : String((err as Error)?.message ?? err);
  return GONE.test(message);
}

/**
 * `first` as a browser that opens a new session through `open` when it is lost: on the next
 * `newContext` (or browser CDP session) after it disconnected, or when one of those calls fails
 * because it is closed. Concurrent calls share the one reopening. Never more than `maxReopens`.
 */
export function reconnectingBrowser(first: BrowserHandle, open: () => Promise<BrowserHandle>, opts: ReconnectOptions = {}): ReconnectingBrowser {
  const max = opts.maxReopens ?? 2;
  const all: BrowserHandle[] = [];
  const dead = new WeakSet<BrowserHandle>();
  let current = first;
  let reopening: Promise<BrowserHandle> | null = null;
  let reopens = 0;
  /** Reopenings whose every try failed. */
  let failedReopens = 0;
  /** Lost sessions already freed (`retire`): not closed again at the end. */
  const retired = new WeakSet<BrowserHandle>();
  const retryMs = opts.retryMs ?? [1000, 2000, 5000];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let swaps = 0;
  /** close() has started: no new session is opened from now on (review r1: none may outlive it). */
  let closing = false;
  /** close() stopped waiting for a reopening: what it brings is handed to `onLate`, never used. */
  let gaveUp = false;
  const closeMs = opts.closeMs ?? CLOSE_MS;
  const CLOSING = 'Target page, context or browser has been closed (the scan closed its browsers)';
  /** The lost (or swapped) session freed (bounded), then `open` with retries (bounded by `until`). */
  const reopen = async (lost: BrowserHandle, why: 'lost' | 'swap'): Promise<BrowserHandle> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      (opts.retire ? opts.retire(lost, why) : lost.close()).catch(() => undefined),
      new Promise((r) => { timer = setTimeout(r, opts.retireMs ?? 5000); }),
    ]);
    clearTimeout(timer);
    retired.add(lost);
    // Nothing is launched once close() started (review r1: a launch after it outlives the scan).
    const stop = () => {
      if (closing || gaveUp) throw new Error(CLOSING);
    };
    for (let attempt = 0; ; attempt++) {
      stop();
      try {
        return await open();
      } catch (err) {
        const wait = retryMs[attempt];
        if (wait === undefined || (opts.until && Date.now() + wait > opts.until())) throw err;
        stop();
        await sleep(wait);
      }
    }
  };
  const raw = (h: BrowserHandle) => h.browser as RawBrowser;
  const watch = (h: BrowserHandle) => {
    all.push(h);
    try {
      raw(h).on?.('disconnected', () => dead.add(h));
    } catch {
      // No event: `isConnected` and the calls' errors still tell.
    }
  };
  watch(first);
  const gone = (h: BrowserHandle) => dead.has(h) || raw(h).isConnected?.() === false;
  /** A reopening of `lost` (shared by concurrent callers): counted as a reopen, or as a swap. */
  const begin = (lost: BrowserHandle, why: 'lost' | 'swap'): Promise<BrowserHandle> => {
    reopening = reopen(lost, why).catch((err: unknown) => {
      failedReopens++;
      // Said as a closed browser, so the work waiting for it is redone or reported lost, never
      // taken for the site's own failure.
      throw new Error(`Target page, context or browser has been closed (no new browser: ${String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, 120)})`);
    }).then((h) => {
      if (gaveUp) {
        try {
          if (opts.onLate) opts.onLate(h);
          else void h.close().catch(() => {});
        } catch {
          // a listener's bug must not leave it running: closed by its handle
          void h.close().catch(() => {});
        }
        throw new Error(CLOSING);
      }
      if (why === 'swap') swaps++;
      else reopens++;
      watch(h);
      current = h;
      try {
        opts.onOpen?.(h);
      } catch {
        // as above
      }
      return h;
    }).finally(() => {
      reopening = null;
    });
    return reopening;
  };
  /** The current session, or a new one when it is lost (shared by concurrent callers). */
  const live = async (): Promise<BrowserHandle> => {
    if (!gone(current)) return current;
    if (!reopening) {
      if (closing) throw new Error(CLOSING);
      if (reopens >= max || failedReopens >= 2) throw new Error(`Target page, context or browser has been closed (${BROWSER_EXHAUSTED})`);
      const lost = current;
      try {
        opts.onLost?.(lost);
      } catch {
        // A listener's bug must not stop the scan.
      }
      begin(lost, 'lost');
    }
    return reopening!;
  };
  /** A browser call, on a new browser when the current one turns out to be closed. */
  const call = async <T>(fn: (b: RawBrowser) => Promise<T> | undefined): Promise<T> => {
    const h = await live();
    try {
      return (await fn(raw(h))) as T;
    } catch (err) {
      if (!isBrowserGone(err)) throw err;
      dead.add(h);
      return (await fn(raw(await live()))) as T;
    }
  };
  const browser: RawBrowser = {
    // Each session's contexts get that session's own User-Agent (src/userAgent.ts): a replacement browser
    // of another version sends what its own client hints agree with.
    newContext: (o: never) => call(async (b) => b.newContext(await matchedContextOptions(b, o))),
    ...(typeof raw(first).newBrowserCDPSession === 'function'
      ? { newBrowserCDPSession: () => call((b) => b.newBrowserCDPSession?.()) }
      : {}),
    isConnected: () => !gone(current) || (reopens < max && failedReopens < 2),
  };
  return {
    browser,
    handles: () => all,
    reopened: () => reopens,
    swapped: () => swaps,
    async swap() {
      if (closing) return false;
      // A reopening already under way gives a fresh session too.
      if (reopening) return reopening.then(() => true, () => false);
      const old = current;
      dead.add(old);
      return begin(old, 'swap').then(() => true, () => false);
    },
    async close() {
      // Set before any wait: a swap or reopen asked for from now on opens nothing. One already on its
      // way is waited for, at most closeMs, and its session closed too (no new one can start once
      // closing, so at most two passes). Each session's close is waited for at most closeMs as well:
      // one that does not answer is returned, for the host to end by id (staging 5b4986ad).
      closing = true;
      const done = new WeakSet<BrowserHandle>();
      const left: BrowserHandle[] = [];
      for (;;) {
        if (reopening && !(await settlesWithin(reopening, closeMs))) gaveUp = true;
        const batch = all.filter((h) => !retired.has(h) && !done.has(h));
        for (const h of batch) done.add(h);
        // A close that fails (its connection already gone) has not ended the session either: returned too.
        const closed = await Promise.all(batch.map((h) => settlesWithin(h.close(), closeMs, true)));
        batch.forEach((h, i) => { if (!closed[i]) left.push(h); });
        if (gaveUp || !reopening) break;
      }
      return left;
    },
  };
}
