// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Where a page lands, and whether the document measured is still the one that landed (fix/self-navigating
// round 5, lead rulings out/sol/selfnav-r4/rulings.md). Staging 2026-11-07 lost 4 of 25 pages of a city
// site: a bot manager's interstitial ("checking your browser") POSTs a proof ~50 ms after load and replaces
// itself with the page, under the audit's scroll pass ("Execution context was destroyed").
//
// - The audit loads the page as a visitor does (nothing held, nothing followed by rule) and waits, after
//   its load event, until the page has stopped replacing itself: no main-frame navigation committed or
//   requested for QUIET_MS. Playwright's own page events tell when to start measuring; nothing else.
// - The document measured is then marked (`markDocument`) and checked after measuring (`markedStill`):
//   a document that changed, or a navigation still in flight, is never measured as the page.
// - `landingFailure`: the checks every load's answer gets (a WAF's challenge headers, the status, an
//   HTML content type), on the answer of the document actually measured. The audit and the tests' loader
//   both use it; `bindLanding` ties that answer to the document marked, from the document's own facts.
// - Tests never follow bot checks: a blocked verification request or challenge response stops them.
// Engine core: no Node-only imports.
import { BOT_CHALLENGE, CHALLENGE_PAGE, isChallengeStatus, isWafChallenge } from './challenge.js';
import type { GuardFrameLike, PageLike, RequestLike, ResponseLike, SubresourceResponseLike } from './types.js';

/** A page that has not committed or requested a main-frame navigation for this long has stopped replacing itself. */
export const QUIET_MS = 750;
/** Documents a page may go to by itself while it loads, after the first one. */
export const MAX_EXTRA_DOCUMENTS = 5;
/** Longest wait, from the load event, for a page to stop replacing itself (the scan's time left may be shorter). */
export const LANDING_MAX_MS = 20_000;

export const KEEPS_NAVIGATING = 'The page kept loading other pages by itself (a redirect loop, a constant refresh, or a page that never finished loading), so it could not be checked';
export const MOVED_BY_ITSELF = 'The page went to another page by itself while it was being checked, so it could not be checked';
export const LANDING_UNCHECKED = 'The page went by itself to another page whose answer could not be checked, so it could not be checked';
export const LANDING_CANCELLED = 'The scan was cancelled while the page loaded';
export const LANDING_OUT_OF_TIME = 'The scan ran out of time while the page was still loading other pages by itself';
export const OTHER_SITE = 'The page went by itself to another site, so it could not be checked';
/** A page that stayed on its document but answered too slowly to be checked (fix/b18-ai-nav): time, never navigation. */
export const TOO_SLOW = 'The page took too long to answer while it was being checked, so it could not be checked';
/** A load whose answer is not a web page (`landingFailure`). */
export const NOT_HTML = 'Not an HTML page';

/** Why a load's answer is not the page, or undefined when it is. `challenge`: a bot challenge (never the page). */
export interface LandingFailure {
  reason: string;
  status: number;
  kind: 'challenge' | 'http' | 'not-html';
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** An HTML content type, or none. */
export const isHtmlType = (type: string | undefined): boolean => !type || /html/i.test(type);

/**
 * The checks on the answer of the document measured, in the audit's order: a known WAF's challenge
 * headers whatever the status (BOT_CHALLENGE), an HTTP error, a 202 challenge (CHALLENGE_PAGE), a
 * content type that is not HTML.
 */
export function landingFailure(resp: ResponseLike): LandingFailure | undefined {
  const status = resp.status();
  const headers = lower(resp.headers());
  if (!isChallengeStatus(status) && isWafChallenge(headers)) return { reason: BOT_CHALLENGE, status, kind: 'challenge' };
  if (status >= 400) return { reason: `HTTP ${status}`, status, kind: 'http' };
  if (isChallengeStatus(status)) return { reason: CHALLENGE_PAGE, status, kind: 'challenge' };
  if (!isHtmlType(headers['content-type'])) return { reason: NOT_HTML, status, kind: 'not-html' };
  return undefined;
}

/** The address without its fragment. */
const strip = (u: string) => u.split('#')[0]!;

/** Another host is another site, ignoring a leading www. No suffix or tenant list. */
export function isOtherSite(requested: string, landed: string): boolean {
  const site = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  };
  const a = site(requested);
  const b = site(landed);
  return !a || !b || a !== b;
}

/** What the page's own events say about its main-frame navigations since the load began (`watchLanding`). */
export interface LandingWatch {
  /** A load of the page starts (each try): what came before is forgotten. */
  begin(): void;
  /** Main-frame documents committed since `begin` (the load's own first one included). */
  readonly commits: number;
  /** Main-frame navigations requested and not yet answered, failed or committed. */
  pending(): number;
  /** Ms since a main-frame navigation was last requested, answered, failed or committed. */
  quietFor(): number;
  /**
   * The answer of the document shown now: the main-frame navigation response its commit followed. Null
   * when a document committed without one the watch saw (a back-forward cache restore, an error page).
   */
  current(): ResponseLike | null | undefined;
  /** When that document's response arrived, before its scripts could run (reload event window). */
  currentSince(): number | undefined;
  /** More document responses than commits, or any response after the one paired with the shown document. */
  ambiguous(): boolean;
  /** A main-frame commit came that no navigation response preceded: it may be a new document (`settleLanding` checks). */
  unsure: boolean;
  /**
   * Main-frame commits no navigation response preceded, since `begin`: same-document changes and documents the watch
   * cannot see (a cache restore, an error page) alike (`checkMark` reads the mark again after one).
   */
  readonly unmatched: number;
  /** Records a new document the watch could not see (a commit with no response): `current()` is then null. */
  unseenDocument(): void;
  /** Resolves at the next main-frame navigation event. */
  next(): Promise<void>;
  /** Resolves once more than MAX_EXTRA_DOCUMENTS documents followed the first (at once if they already have). */
  over(): Promise<void>;
}

const watches = new WeakMap<object, LandingWatch>();

/** The page's landing watch (installed once, on first use); undefined when the page reports no events. */
export function watchLanding(page: PageLike): LandingWatch | undefined {
  const known = watches.get(page);
  if (known) return known;
  if (typeof page.on !== 'function') return undefined;
  let main: GuardFrameLike | undefined;
  try {
    main = page.mainFrame?.();
  } catch {
    main = undefined;
  }
  const isMain = (f: GuardFrameLike | undefined | null) => !!f && (main ? f === main : f.parentFrame() === null);
  const frameOf = (r: RequestLike) => {
    try {
      return r.frame?.();
    } catch {
      return undefined; // a service worker's request has no frame
    }
  };
  const navigation = (r: RequestLike) => {
    try {
      return !!r.isNavigationRequest?.() && isMain(frameOf(r));
    } catch {
      return false;
    }
  };
  const pending = new Set<RequestLike>();
  let commits = 0;
  let unmatched = 0;
  let responses = 0;
  let boundResponse = 0;
  let answeredAt = 0;
  let boundAt = 0;
  let last = Date.now();
  let shown: ResponseLike | null | undefined;
  /** The latest main-frame navigation response no commit has taken yet. */
  let answer: SubresourceResponseLike | undefined;
  let waiters: (() => void)[] = [];
  let budget: (() => void)[] = [];
  const isOver = () => commits - 1 > MAX_EXTRA_DOCUMENTS;
  const touched = () => {
    last = Date.now();
    const w = waiters;
    waiters = [];
    for (const r of w) r();
    if (isOver() && budget.length) {
      const b = budget;
      budget = [];
      for (const r of b) r();
    }
  };
  const w: LandingWatch = {
    begin() {
      pending.clear();
      commits = 0;
      unmatched = 0;
      responses = 0;
      boundResponse = 0;
      answeredAt = 0;
      boundAt = 0;
      shown = undefined;
      answer = undefined;
      w.unsure = false;
      last = Date.now();
    },
    get commits() {
      return commits;
    },
    get unmatched() {
      return unmatched;
    },
    pending: () => pending.size,
    quietFor: () => Date.now() - last,
    current: () => shown,
    currentSince: () => shown ? boundAt : undefined,
    ambiguous: () => responses > commits || responses > boundResponse,
    unsure: false,
    unseenDocument() {
      commits++;
      shown = null;
      touched();
    },
    next: () => new Promise<void>((r) => { waiters.push(r); }),
    over: () => new Promise<void>((r) => { if (isOver()) r(); else budget.push(r); }),
  };
  page.on('request', (r: RequestLike) => {
    if (!navigation(r)) return;
    pending.add(r);
    touched();
  });
  const settled = (r: RequestLike) => {
    if (pending.delete(r)) touched();
  };
  page.on('requestfailed', settled);
  page.on('requestfinished', settled);
  page.on('response', (resp: SubresourceResponseLike) => {
    let req: RequestLike;
    try {
      req = resp.request();
    } catch {
      return;
    }
    if (!navigation(req)) return;
    // HTTP redirects produce no document or commit; only their final response can be bound.
    if ([301, 302, 303, 307, 308].includes(resp.status()) && lower(resp.headers())['location']) {
      settled(req);
      touched();
      return;
    }
    responses++;
    answeredAt = Date.now();
    answer = resp;
    settled(req);
    touched();
  });
  page.on('framenavigated', (f: GuardFrameLike) => {
    if (!isMain(f)) return;
    let at = '';
    let from = '';
    try {
      at = strip(f.url());
      from = answer ? strip(answer.url()) : '';
    } catch {
      // read below as a commit the watch could not pair
    }
    if (answer && at && at === from) {
      // A new document: the navigation response it followed is its answer.
      commits++;
      shown = answer;
      boundResponse = responses;
      boundAt = answeredAt;
      answer = undefined;
      touched();
      return;
    }
    // No response paired with it: a same-document change (pushState, a fragment) or a document the watch
    // cannot see (a cache restore, an error page). `settleLanding` asks the page which.
    unmatched++;
    w.unsure = true;
    const ws = waiters;
    waiters = [];
    for (const r of ws) r();
  });
  watches.set(page, w);
  return w;
}

/** Runs in the page: the time origin, which names its document (a same-document change keeps it). */
function timeOrigin(): number {
  return performance.timeOrigin;
}

/**
 * Runs in the page: marks it (when `mark` is given) with a property the page does not know (a document of
 * its own has none), and reads the document's own facts: its address, the address and status its
 * navigation entry recorded (a history change of the address does not touch them), and its content type.
 * Self-contained.
 */
function pageFacts(mark?: { name: string; token: string }): DocumentFacts {
  if (mark) Object.defineProperty(window, mark.name, { value: mark.token, enumerable: false, configurable: false, writable: false });
  const nav = performance.getEntriesByType('navigation')[0] as (PerformanceEntry & { responseStatus?: number }) | undefined;
  return {
    href: location.href,
    navUrl: nav?.name,
    status: typeof nav?.responseStatus === 'number' && nav.responseStatus > 0 ? nav.responseStatus : undefined,
    contentType: document.contentType,
    marked: !!mark && (window as unknown as Record<string, unknown>)[mark.name] === mark.token,
  };
}

/** A document's own facts (`pageFacts`). */
export interface DocumentFacts {
  href: string;
  /** The address its navigation entry recorded (undefined when the browser keeps none). */
  navUrl: string | undefined;
  /** Its response status as the navigation entry recorded it, where the browser records it. */
  status: number | undefined;
  contentType: string;
  /** The mark was set (and reads back). */
  marked: boolean;
}

/** Runs in the page: the mark, if this document has it. */
function readMark(name: string): unknown {
  return (window as unknown as Record<string, unknown>)[name];
}

/** The mark set on a document (`markDocument`), with the document's facts as it was marked. */
export interface DocumentMark {
  name: string;
  token: string;
  /** The watch's commit count when it was set. */
  commits: number;
  facts: DocumentFacts;
}

const randomPart = () => Math.random().toString(36).slice(2, 12);

/**
 * Marks the document shown now and reads its facts, by `by` (and the signal); undefined when the page did
 * not answer (it is going to another document) or the mark did not hold.
 */
export async function markDocument(page: PageLike, watch: LandingWatch | undefined, by = Date.now() + PAGE_ANSWER_MS, signal?: AbortSignal): Promise<DocumentMark | undefined> {
  const mark = { name: `__grnted_${randomPart()}`, token: randomPart() + randomPart() };
  const commits = watch?.commits ?? 0;
  let facts: DocumentFacts | 'cut';
  try {
    facts = await within(page.evaluate(pageFacts, mark), by, signal);
  } catch {
    return undefined;
  }
  if (facts === 'cut' || !facts?.marked) return undefined;
  return { ...mark, commits, facts };
}

/**
 * Whether the page still shows the document `mark` was set on, with no main-frame navigation in flight:
 * the mark is still there (a new document never has it), and the watch saw no commit or request since.
 */
export async function markedStill(page: PageLike, watch: LandingWatch | undefined, mark: DocumentMark | undefined, by = Date.now() + PAGE_ANSWER_MS, signal?: AbortSignal): Promise<boolean> {
  return (await checkMark(page, watch, mark, by, signal)) === 'same';
}

/**
 * `markedStill`, with why not: 'moved' (the events show a commit since the mark, a navigation in flight or an
 * answer of another document; a navigation error; a document without the mark), or 'unanswered' (nothing says it
 * moved, but the page did not answer in time, or the time, the signal or `by` came first).
 *
 * A slow answer is not a move (fix/b18-ai-nav: a starved host lost pages to MOVED_BY_ITSELF with no navigation
 * at all). The mark is asked for once; while nothing says the document changed, its answer is waited for
 * PAGE_ANSWER_MS at a time (an answer the scan heard late, its own process busy, is taken at the next step), the
 * next main-frame event ending each step at once, until `by` and at most SLOW_ANSWER_MS from now. After a commit no
 * response preceded, the mark is read again from the document shown then (an earlier answer may be the old document's).
 */
export async function checkMark(page: PageLike, watch: LandingWatch | undefined, mark: DocumentMark | undefined, by = Date.now() + PAGE_ANSWER_MS, signal?: AbortSignal): Promise<'same' | 'moved' | 'unanswered'> {
  if (!mark || signal?.aborted || Date.now() >= by) return mark ? 'unanswered' : 'moved';
  const moved = () => !!watch && (watch.commits !== mark.commits || watch.pending() > 0 || watch.ambiguous());
  if (moved()) return 'moved';
  const until = Math.min(by, Date.now() + SLOW_ANSWER_MS);
  const read = () => page.evaluate(readMark, mark.name);
  let found: unknown = 'cut';
  try {
    let asked = watch?.unmatched ?? 0;
    let reading = read();
    for (;;) {
      found = await within(reading, Math.min(until, Date.now() + PAGE_ANSWER_MS), signal, watch?.next());
      if (moved() || signal?.aborted) break;
      // A commit no response preceded since the read was asked (a same-document change, or a document the events
      // cannot tell, such as a cache restore): an answer may be the old document's, so the document shown now is read
      // again (Sol r1 P1). A same-document change keeps the mark; another document has none.
      if (watch && watch.unmatched !== asked) {
        asked = watch.unmatched;
        found = 'cut';
        if (Date.now() >= until) break;
        reading = read();
        continue;
      }
      if (found !== 'cut' || Date.now() >= until) break;
    }
  } catch {
    return 'moved';
  }
  if (moved()) return 'moved';
  if (found === 'cut' || signal?.aborted || Date.now() >= by) return 'unanswered';
  return found === mark.token ? 'same' : 'moved';
}

/**
 * Ties the answer checked (`landingFailure`) to the document marked, from the document's own facts: the
 * answer's address is the one its navigation entry recorded, its status agrees with the entry's where the
 * browser records it, and the document is HTML (NOT_HTML otherwise). Any other mismatch, or an entry the browser does not keep:
 * LANDING_UNCHECKED (the answer may be another document's).
 */
export function bindLanding(resp: ResponseLike, facts: DocumentFacts): string | undefined {
  let url: string;
  try {
    url = resp.url();
  } catch {
    return LANDING_UNCHECKED;
  }
  if (!facts.navUrl || strip(facts.navUrl) !== strip(url)) return LANDING_UNCHECKED;
  if (facts.status !== undefined && facts.status !== resp.status()) return LANDING_UNCHECKED;
  if (!/html/i.test(facts.contentType)) return NOT_HTML;
  return undefined;
}

export interface SettleOptions {
  /** The settle of each document the page shows (the audit's scroll pass and settle window). */
  settle: () => Promise<void>;
  /** Longest wait, from now, for the page to stop replacing itself (default LANDING_MAX_MS). */
  maxMs?: number;
  /** Epoch ms: the scan's own deadline, when it comes sooner (LANDING_OUT_OF_TIME then). */
  scanDeadline?: number;
  /** The scan's cancellation (LANDING_CANCELLED). */
  signal?: AbortSignal;
  quietMs?: number;
}

/** How long a call into the page may take to answer before it counts as going to another document. */
const PAGE_ANSWER_MS = 5000;
/**
 * The longest a page that has not moved may take to answer the mark's read (`checkMark`); past it, TOO_SLOW. Slow
 * answers on a starved host were up to about 14 s (fix/b18-ai-nav).
 */
const SLOW_ANSWER_MS = LANDING_MAX_MS;

/** The landing: the answer of the document measured and its mark; or why the page could not be checked. */
export type Landing = { response: ResponseLike | null | undefined; mark: DocumentMark } | { stop: string };

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, Math.max(0, ms));
  function done() {
    clearTimeout(t);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  signal?.addEventListener('abort', done, { once: true });
});

/** `p`'s value, or 'cut' once the deadline, the signal or `also` comes first. Rejects as `p` does. */
export async function within<T>(p: Promise<T>, deadline: number, signal?: AbortSignal, also?: Promise<void>): Promise<T | 'cut'> {
  // A call still running once cut short may fail later: never an unhandled rejection.
  p.catch(() => {});
  if (signal?.aborted || Date.now() >= deadline) return 'cut';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const value = await Promise.race([
      p,
      new Promise<'cut'>((resolve) => {
        if (Number.isFinite(deadline)) timer = setTimeout(() => resolve('cut'), Math.max(0, deadline - Date.now()));
        also?.then(() => resolve('cut'));
        if (signal) {
          onAbort = () => resolve('cut');
          if (signal.aborted) resolve('cut');
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
    return signal?.aborted || Date.now() >= deadline ? 'cut' : value;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The page's time origin, or undefined when it did not answer in time. Never asked while a main-frame
 * navigation is in flight: Playwright holds a call into the page until that navigation commits or fails.
 */
async function originOf(page: PageLike, watch: LandingWatch | undefined, by: number, signal?: AbortSignal): Promise<number | undefined> {
  if (watch && watch.pending() > 0) return undefined;
  const r = await within(page.evaluate(timeOrigin, undefined), by, signal).catch(() => undefined);
  return typeof r === 'number' ? r : undefined;
}

/** Waits until the document shown has finished loading (its readyState, which a cache restore keeps too). */
async function documentReady(page: PageLike, watch: LandingWatch, deadline: number, signal?: AbortSignal, also?: Promise<void>): Promise<void> {
  let over = false;
  also?.then(() => { over = true; });
  while (Date.now() < deadline && !signal?.aborted && !over) {
    // A navigation in flight: its commit is a new document (the caller sees it); nothing to ask yet.
    if (watch && watch.pending() > 0) return;
    const state = await within(page.evaluate(() => document.readyState, undefined), deadline, signal, also).catch(() => undefined);
    if (state === 'complete') return;
    await sleep(Math.min(100, deadline - Date.now()), signal);
  }
}

/**
 * After the load event of the page's first document: runs `settle` on it, then waits until the page has
 * stopped replacing itself (no main-frame navigation requested, answered or committed for `quietMs`, none
 * in flight). Each new document it goes to finishes loading and is settled in turn. At most
 * MAX_EXTRA_DOCUMENTS after the first, all before `deadline`; past either, the page kept navigating
 * (KEEPS_NAVIGATING), except a page still on the load's own document with no other main-frame commit and nothing in
 * flight at the cap: that one only answered too slowly (TOO_SLOW). The document it lands on is marked
 * (`markDocument`) before this returns, so a change after that is seen by `markedStill`, whatever the events said.
 *
 * `settle` failing because the page navigated is part of loading; any other failure is thrown. Without a
 * watch (a browser that reports no page events) the page is settled and marked as it is.
 */
export async function settleLanding(page: PageLike, events: LandingWatch | undefined, opts: SettleOptions): Promise<Landing> {
  // A browser that reported no commit for the load reports no page events: settled and marked as it is.
  const watch = events && events.commits > 0 ? events : undefined;
  const quietMs = opts.quietMs ?? QUIET_MS;
  const { signal } = opts;
  const cap = Date.now() + (opts.maxMs ?? LANDING_MAX_MS);
  // One deadline from the first settle through marking: the cap, or the scan's time left when that is sooner.
  const deadline = Math.min(cap, opts.scanDeadline ?? Infinity);
  // At the cap (fix/b18-ai-nav): TOO_SLOW only where it is provably no navigation (the load's own document, no other
  // main-frame commit of any kind since, matched or not, nothing in flight, no unpaired answer); anything else is a
  // page that kept navigating, as before. The scan's deadline first: LANDING_OUT_OF_TIME.
  const stillFirst = () => !!watch && watch.commits === 1 && watch.unmatched === 0 && watch.pending() === 0 && !watch.ambiguous();
  const late = () => (deadline < cap ? LANDING_OUT_OF_TIME : stillFirst() ? TOO_SLOW : KEEPS_NAVIGATING);
  const over = watch?.over();
  /** Cancelled, or past the document budget. */
  const stopped = (): string | undefined => {
    if (signal?.aborted) return LANDING_CANCELLED;
    if (watch && watch.commits - 1 > MAX_EXTRA_DOCUMENTS) return KEEPS_NAVIGATING;
    return undefined;
  };
  const closed = () => {
    if (page.isClosed?.()) throw new Error('Target page, context or browser has been closed');
  };
  let settledAt = watch?.commits ?? 0;
  /**
   * The time origin of the document being settled, read before its settle: a document that replaced it
   * with no answer the watch saw (an error page, a cache restore) has another one.
   */
  let origin = await originOf(page, watch, deadline, signal);
  /** False when the time (`by`), the signal or the document budget cut it short. */
  const settleThis = async (by: number): Promise<boolean> => {
    let r: true | 'cut';
    try {
      r = await within(opts.settle().then(() => true as const), by, signal, over);
    } catch (err) {
      // The page went to another document under the settle: part of loading it.
      if (!isNavigationError(err)) throw err;
      r = true;
    }
    return r !== 'cut';
  };
  /** The landing, once nothing stopped it meanwhile (decided after the mark's answer, not before). */
  const landed = (response: ResponseLike | null | undefined, mark: DocumentMark): Landing => {
    const stop = stopped() ?? (Date.now() >= deadline ? late() : events?.ambiguous() ? LANDING_UNCHECKED : undefined);
    return stop ? { stop } : { response, mark };
  };
  if (!(await settleThis(deadline))) return { stop: stopped() ?? late() };
  if (!watch) {
    const mark = await markDocument(page, undefined, deadline, signal);
    closed();
    return mark ? landed(undefined, mark) : { stop: stopped() ?? (Date.now() >= deadline ? late() : MOVED_BY_ITSELF) };
  }
  for (;;) {
    closed();
    const stop = stopped();
    if (stop) return { stop };
    if (watch.unsure && watch.pending() === 0) {
      // A commit no response preceded: a new document only if its time origin changed.
      watch.unsure = false;
      const now = await originOf(page, watch, deadline, signal);
      // No answer: it is going to another document; asked again shortly.
      if (now === undefined) watch.unsure = true;
      else if (origin === undefined) origin = now;
      else if (now !== origin) watch.unseenDocument();
    }
    if (watch.commits !== settledAt) {
      // A new document: it finishes loading, then is settled as the first was.
      settledAt = watch.commits;
      if (stopped()) continue;
      if (Date.now() >= deadline) return { stop: late() };
      await documentReady(page, watch, deadline, signal, over);
      if (stopped()) continue;
      origin = await originOf(page, watch, deadline, signal);
      if (Date.now() >= deadline) return { stop: late() };
      if (!(await settleThis(deadline))) return { stop: stopped() ?? late() };
      continue;
    }
    if (!watch.unsure && watch.pending() === 0 && watch.quietFor() >= quietMs) {
      const mark = await markDocument(page, watch, deadline, signal);
      // Marked on the document settled, with nothing in flight: the landing.
      if (mark && mark.commits === settledAt && mark.commits === watch.commits && watch.pending() === 0 && !watch.unsure) return landed(watch.current(), mark);
      if (Date.now() >= deadline) return { stop: late() };
      // It did not answer: a navigation is starting (seen shortly), or the page closed.
      if (!mark) await sleep(50, signal);
      continue;
    }
    if (Date.now() >= deadline) return { stop: late() };
    const wait = watch.unsure ? 50 : Math.max(10, quietMs - watch.quietFor());
    await within(Promise.race([watch.next(), sleep(wait, signal)]), deadline, signal, over);
  }
}

/** A Playwright error from a page whose document went away under the call (it navigated). */
export function isNavigationError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|because of a navigation|frame was detached|Cannot find context with specified id/i.test(m);
}
