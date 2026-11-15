// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Politeness toward the scanned site: one controller per scan, shared by everything that loads pages
// or files from it (audits, probes, the evidence pass, document requests, and discovery: robots.txt,
// the sitemaps and the home page link fallback). Per host: when the site says "slow down" (HTTP 429 or 503, or a 403 after earlier
// successes from that host in this scan: a burst-triggered firewall block), the host drops to one
// load at a time, every load to it waits out Retry-After (or an exponential backoff with jitter), and
// the refused load is tried again a few times. A run of successes lets the host climb back to the
// scan's concurrency. robots.txt `Crawl-delay` spaces page loads apart (a page's two widths count as one load). Every wait is capped, and no
// wait is started that would end past the scan's deadline. Only timing and the outcome of loads
// change: which pages are selected never depends on this. Engine core: no Node-only imports.
//
// Pages at once adapt too (`Pace.page`, the page gate the scan's page pools take a turn from): a scan
// starts at `PaceOptions.start` pages at once and goes one step higher, up to `concurrency` (and the
// host's share, `cap`), while the site is clearly comfortable and the browsers keep up (`ADAPTIVE`); at
// the first sign of strain it steps down at once and does not go up again for a cooling window. The
// site refusing us (406, 429 or 503, a burst 403, a challenge: with or without a body) is strain that
// holds: it never goes up again in that scan (`PaceAdapt.held`). The
// slow-down above stays and wins: no raise while any host is slowed or paused, and a site with a
// Crawl-delay never goes past its start. Only when pages run changes, never which pages or what they find.
import { isChallengeStatus, isRefusalStatus, isWafChallenge } from './challenge.js';
import type { StyleRefusal, StyleWatch } from './styles.js';
import type { PaceTiming } from './timeBudget.js';
import type { ScanPace } from './types.js';

export const PACE_DEFAULTS = {
  /** Tries after the first, per load. */
  retries: 3,
  /** Longest single wait (Retry-After or backoff). */
  maxWaitMs: 20_000,
  /** Backoff without Retry-After: base · 2^n, jittered to 50–100 %. */
  backoffMs: 2_000,
  /** Shortest wait after a refusal, whatever Retry-After says. */
  minRetryAfterMs: 500,
  /** Successes in a row (while slowed down) before one more load at a time is allowed. */
  recoverAfter: 3,
  /** Longest robots.txt Crawl-delay honoured. */
  maxCrawlDelayMs: 10_000,
  /**
   * Refusals in a row with no success between them, each to a request sent after the previous refusal
   * (so a burst of answers to requests already on their way counts once), before the scan stops
   * loading from that host: it is refusing us, not rate-limiting. Bounds the total wait (a few × 20 s).
   * Only once refusals in that run came for `giveUpUrls` different addresses: one address the site
   * always refuses is bounded by its own retries and never stops the rest of the scan.
   */
  giveUpAfter: 6,
  giveUpUrls: 3,
} as const;

/**
 * Adaptive pages at once (the page gate). Internal: these numbers never appear in a report, the scan
 * page or docs/scoring.md (public what, private how). "The window" is what was measured at the current
 * limit: page loads and pages that started after its last change (each width of a page is one load).
 */
export const ADAPTIVE = {
  /** Pages at once a hosted scan starts at: its fixed value before pages at once adapted. */
  start: 4,
  /** Most pages at once a hosted scan reaches: twice the start, what three CPU-bound sessions can hold (scanSessions.ts). */
  ceiling: 8,
  /**
   * Lowest a lowering for strain goes. Below it the slow-down above takes over (one load at a time on
   * 429/503 or a burst 403); a host's share (`cap`) can still go lower.
   */
  floor: 2,
  /** Pages finished in the window before a raise is judged: one round at the start level, so a fast 25-page scan reaches 8 by about its 16th page. */
  windowPages: 4,
  /** Clean page loads in the window before a raise is judged, the last ones judged: those pages' two widths. */
  windowLoads: 8,
  /** Comfortable: the window's median time to first byte is at most this times the start page's (siteSpeed.ts) ... */
  ttfbFactor: 2,
  /** ... or under this, whatever the start page measured (a 40 ms start page must not make 90 ms look like strain). */
  ttfbFloorMs: 500,
  /** Comfortable: the window's median load time is at most this times the scan's first window's (measured at the start) ... */
  loadFactor: 1.3,
  /** ... or within this of it (fast pages: 20 ms against 40 ms is noise, not a trend). */
  loadSlackMs: 300,
  /** A slower trend (strain): the median of the window's last `trendLoads` clean loads ... */
  trendLoads: 3,
  /** ... is more than this times the first window's median load time ... */
  trendFactor: 2,
  /** ... and more than this above it (no step down for a fast page that went from 30 ms to 70 ms). */
  trendSlackMs: 1_000,
  /**
   * The browsers keep up: the window's median browser time per page (the page's turn minus its load),
   * against the first window's, has grown by at most `keepUpNoise` plus `keepUpShare` of the step above
   * the start (at 6 of a start of 4: 1.1 + 0.5 × 2/4 = 1.35×). So each step must still bring at least
   * half its pages a second more. A CPU-bound session (scanSessions.ts) shows it first: browser time
   * grows with the pages at once and pages a second stay flat, so it stops one step above the start.
   */
  keepUpNoise: 0.1,
  keepUpShare: 0.5,
  /** No raise for this long after a lowering for strain. */
  coolMs: 60_000,
  /** While pages wait only for the host's share (`cap`) and none is running, the cap is read again this often. */
  capPollMs: 500,
} as const;

/**
 * Why the page limit changed (`PaceAdapt.why`), a short code for the host's log: `comfortable` (raise),
 * `slower` (a slower trend), `timeout`, `slow-down` (429/503, or a refused stylesheet), `refused` (a 4xx
 * but 404/408/410, a burst 403), `challenge` (202 or a WAF challenge), `browsers` (the sessions stopped
 * keeping up), `share` (the host's share went down), `crawl-delay`, `slow-site` (`Pace.hold`).
 */
export type AdaptWhy = 'comfortable' | 'slower' | 'timeout' | 'slow-down' | 'refused' | 'challenge' | 'browsers' | 'share' | 'crawl-delay' | 'slow-site';

export interface PaceAdapt {
  from: number;
  to: number;
  why: AdaptWhy;
  /**
   * The site refused us (`why` refused, slow-down or challenge): from now on the limit is never raised in
   * this scan. Said once, on the change it came with (`from` equals `to` when the limit did not move:
   * a fixed pool, the floor, or the same round). The host keeps the scan at `to` or lower in its later
   * attempts and segments.
   */
  held?: true;
}

/** A page's turn under the page limit (`Pace.page`). */
export interface PageSlot {
  /** The page this turn is for (its loads through the controller are then its load time). */
  url(url: string): void;
  /** The page is done (once; later calls do nothing). */
  release(): void;
}

export interface PaceTuning {
  retries?: number;
  maxWaitMs?: number;
  backoffMs?: number;
  recoverAfter?: number;
}

export interface PaceOptions extends PaceTuning {
  /**
   * The scan's configured concurrency: the most pages at once (the page gate's ceiling). A slowed-down
   * host climbs back to the page limit of the moment, then its own limit lifts.
   */
  concurrency: number;
  /**
   * Pages at once at the start (the page gate); raised one step at a time up to `concurrency` while the
   * site is comfortable (`ADAPTIVE`). Default `concurrency`: no raising (lowering for strain still applies).
   */
  start?: number;
  /**
   * The most pages at once allowed now, read before each raise and each page's turn (hosted: this scan's
   * share of its host's budget). 0 holds new pages until it rises. A throw or a non-number is ignored.
   */
  cap?: () => number;
  /** The page limit changed. Observation only; a throw is ignored. */
  onAdapt?: (e: PaceAdapt) => void;
  /** Epoch ms: no wait is started that would end after this (the hosted scan's budget). */
  deadline?: number;
  /** A host slowed down, or recovered. Observation only; a throw is ignored. */
  onChange?: (e: PaceChange) => void;
  /**
   * Diagnostics (docs/scan-time-budget.md): each load's wait for its turn and its run, and each page
   * turn's wait. Observation only; a throw is ignored.
   */
  onTiming?: (e: PaceTiming) => void;
  /**
   * Record and replay (src/replay): true for a page address whose whole load the scan's own copy of the
   * site answers. Nothing of such a load goes to the site, so it waits for no turn, pause or Crawl-delay
   * gap and says nothing about the site (it is not judged for the page limit). A load that turns out to
   * have reached the site after all and was refused is handled as any live load from there on. False for a
   * page whose load from the copy still asks the site for something (the host says so): it takes its turn
   * like any load. A throw counts as false.
   */
  replayed?: (url: string) => boolean;
  /**
   * Record and replay: true for a load's answer (the browser's response) that the scan's own copy gave.
   * `gotoPolitely` asks it (`Pace.copied`) and says so in its `PaceAnswer`. Absent (replay off): no answer
   * is ever taken for a copied one. A throw counts as false.
   */
  copied?: (answer: unknown) => boolean;
  /** Tests: the clock, the wait and the jitter source. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export type PaceChange =
  /** `file`: the refusal was of a file a page needs (a stylesheet), not of a page or a fetch. */
  | { step: 'slowed'; host: string; status: number; waitMs: number; file?: boolean }
  | { step: 'recovered'; host: string; concurrency: number };

/** What the server answered a load (null: no answer to judge, e.g. no response). */
export interface PaceAnswer {
  status: number;
  /** The Retry-After header, as sent. */
  retryAfter?: string | null;
  /**
   * Files the load needs that their server refused while the load itself was answered (a page's
   * stylesheets, `src/styles.ts`). Each is charged to its OWN host (its pause, its Retry-After), never
   * to this load's host: it never counts toward giving up on a host. The load is tried again within
   * its retries, after those hosts' pauses; still refused after them, it comes back refused.
   */
  files?: { url: string; status: number; retryAfter?: string | null }[];
  /** A page load's own time (the navigation, not the controller's waits), for the page limit. */
  loadMs?: number;
  /** Its time to first byte, when the browser says. */
  ttfbMs?: number;
  /** A known WAF's challenge answered (whatever the status). */
  challenge?: boolean;
  /**
   * The answer came from the scan's own copy of the site, not from the site (src/replay): it says nothing
   * about the site, so it is no success of its host (a slowed-down host does not climb back on it) and is
   * not judged for the page limit. A refusal, or a refused file the page needs, is still handled as ever.
   */
  copied?: boolean;
}

export interface PaceLoadOptions<T> {
  /** A page load: the crawl delay applies and a 403 after successes counts as a refusal. Default true. */
  page?: boolean;
  /** Tries after the first. Default `PACE_DEFAULTS.retries` (or the controller's). */
  retries?: number;
  /** A tighter deadline for this load (epoch ms), on top of the scan's. */
  deadline?: number;
  /** Ends a wait early (it then throws the signal's reason). */
  signal?: AbortSignal;
  /** Called with a refused value before the load is tried again (e.g. to release a response body). */
  discard?: (value: T) => void;
  /**
   * Page loads that count as ONE load for the crawl delay (a page's desktop and phone widths, loaded
   * together): the first waits out the gap, the others in the group go without waiting for it.
   */
  crawlGroup?: string;
  /**
   * Goes ahead of the ordinary loads waiting for the crawl gap (in arrival order among priority
   * loads): the evidence pass's few reloads, which would otherwise queue behind every probe load.
   */
  priority?: boolean;
  /**
   * A load that threw (`run` rejected): the HTTP status its answer had, when known (Chromium throws on an
   * HTTP error with no body and hands back no response, src/egress.ts). Judged for the page limit only
   * (a refusal is strain that holds); the error is still thrown, and the host's own slow-down is not set.
   */
  failedStatus?: (err: unknown) => number | undefined;
  /**
   * The scan's one more try (src/scan.ts `lateRetry`): sent even to a host the controller gave up on
   * (its one-at-a-time limit, pauses and crawl gap stand). Every other load still sees the give-up, until
   * a load from the host succeeds.
   */
  again?: boolean;
  /**
   * Not a page, but spaced like one: the Crawl-delay applies (a page's gap and this load's are the same
   * gap), the 403 rule does not. The document downloads (src/documents/index.ts).
   */
  crawl?: boolean;
}

/**
 * The outcome: `value` is the last answer (absent when the load never ran). `refused` is set when the
 * site kept saying slow down or the wait did not fit: the reason to record, and `status` the last
 * refusal's HTTP status.
 */
export type PaceResult<T> = { value: T; refused?: undefined; status?: undefined } | { value?: T; refused: string; status?: number };

/** What the report says about the scan's pace (only when it slowed down or honoured a crawl delay). */
export type PaceSummary = Omit<ScanPace, 'failedPages'>;

export interface Pace {
  load<T>(url: string, run: () => Promise<T>, answer: (value: T) => PaceAnswer | null, opts?: PaceLoadOptions<T>): Promise<PaceResult<T>>;
  /** robots.txt Crawl-delay for a host (`URL.host`), in seconds; ignored when not a positive number. */
  setCrawlDelay(host: string, seconds: number | undefined): void;
  /**
   * A file `pageUrl` needed was refused after its load was over (a stylesheet a script added later):
   * its host pauses for it (Retry-After), and later loads from `pageUrl`'s host wait for that pause.
   * Never counts toward giving up on a host.
   */
  fileRefused(fileUrl: string, answer: PaceAnswer, pageUrl: string): void;
  /** A file from `fileUrl`'s host answered (a stylesheet loaded with CSS): that host's file backoff starts over. */
  fileLoaded(fileUrl: string): void;
  /** The host's current limit on loads at once; null when not slowed down. */
  limit(host: string): number | null;
  summary(): PaceSummary | undefined;
  /**
   * A page's turn under the page limit, in arrival order: the scan's page pools take one before taking
   * a page, and release it once the page is done. `low`: a turn that gives way to every turn that is not
   * low (the optional coverage runs' loads, perf/split-tests): it counts against the same limit, so the
   * site never gets more loads at once, and it waits while any other turn waits. A low turn's time is not
   * judged for the limit (it is a test's load and settle, not a page's browser time).
   */
  page(opts?: { low?: boolean }): Promise<PageSlot>;
  /** Pages at once now (`limit`), pages running (`active`), and the highest limit reached. */
  pages(): { limit: number; active: number; highest: number };
  /** The start page's time to first byte (siteSpeed.ts): what "comfortable" is judged against. */
  baseline(firstByteMs: number | null): void;
  /**
   * At most `n` pages at once from now on, never raised: a site that slows us (siteSpeed.ts), or one that
   * refuses every session (src/sessions.ts, `why` 'refused').
   */
  hold(n: number, why?: AdaptWhy): void;
  /** Record and replay only (`PaceOptions.copied`): this answer came from the scan's own copy, not from the site. */
  copied?(answer: unknown): boolean;
  /**
   * The scan is over (done, out of time, or given up): every timer the controller holds is cleared,
   * every page turn still waiting (and every one asked for later) is refused with `ScanStopped`, and
   * every wait ends. Idempotent.
   */
  stop(): void;
}

/** A page turn or a wait refused because the scan stopped (`Pace.stop`). */
export class ScanStopped extends Error {
  constructor() {
    super('The scan stopped');
    this.name = 'ScanStopped';
  }
}

const SLOW_PREFIX = 'The site asked us to slow down';
const BLOCK_PREFIX = 'The site started refusing requests';
const CRAWL_PREFIX = 'The site’s robots.txt asks for a pause';

const keptRefusing = (status: number) =>
  status === 403 ? `${BLOCK_PREFIX} (HTTP 403) after earlier pages loaded, and kept refusing` : `${SLOW_PREFIX} (HTTP ${status}) and kept refusing`;
const noTimeToRetry = (status: number) =>
  status === 403
    ? `${BLOCK_PREFIX} (HTTP 403) after earlier pages loaded, and there was no time left in the scan to wait and try again`
    : `${SLOW_PREFIX} (HTTP ${status}), and there was no time left in the scan to wait and try again`;
const NO_TIME_PAUSED = `${SLOW_PREFIX}, and there was no time left in the scan to wait`;
const NO_TIME_CRAWL = `${CRAWL_PREFIX} between pages, and there was no time left in the scan for it`;

const UNSTYLED_END = 'so the page could not load its styles and was left out of the score';
// Status 0: no usable answer (the browser blocked what came back, the connection failed, or it was not CSS).
const refusedBy = (status: number) =>
  status === 0 ? `${BLOCK_PREFIX} (no usable answer)`
    : status === 403 ? `${BLOCK_PREFIX} (HTTP 403) after earlier pages loaded` : `${SLOW_PREFIX} (HTTP ${status})`;

/**
 * Why a page whose stylesheet the site refused was left out (it would only have rendered unstyled):
 * `kept` after every try was refused, `no-time` when the wait for another try did not fit the scan,
 * `once` when there was no try left to make (no controller, or the stylesheet came after the load).
 * A pace reason (`isPaceReason`), and an unstyled one (`isUnstyledReason`).
 */
export function unstyledReason(status: number, how: 'kept' | 'no-time' | 'once'): string {
  if (how === 'kept') return `${refusedBy(status)} and kept refusing the page’s stylesheet, ${UNSTYLED_END}`;
  if (how === 'no-time') return `${refusedBy(status)}: it refused the page’s stylesheet, and there was no time left in the scan to wait and try again, ${UNSTYLED_END}`;
  return `${refusedBy(status)}: it refused the page’s stylesheet, ${UNSTYLED_END}`;
}

/** A failure reason written by `unstyledReason`. */
export function isUnstyledReason(reason: string | undefined): boolean {
  return !!reason && isPaceReason(reason) && reason.endsWith(UNSTYLED_END);
}

/** A pace reason for a wait that did not fit in the scan's time (a later run of the scan may make it). */
export function isNoTimeReason(reason: string | undefined): boolean {
  return isPaceReason(reason) && reason!.includes('there was no time left in the scan');
}

/** A failure reason this controller wrote (the page failed because the site wanted a slower pace). */
export function isPaceReason(reason: string | undefined): boolean {
  return !!reason && (reason.startsWith(SLOW_PREFIX) || reason.startsWith(BLOCK_PREFIX) || reason.startsWith(CRAWL_PREFIX));
}

/** Retry-After (seconds or an HTTP date) in ms, between the floor and the cap; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now: number, cap: number = PACE_DEFAULTS.maxWaitMs): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (/^[A-Za-z]{3},/.test(v)) {
    const at = Date.parse(v);
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  } else return undefined;
  return Math.min(Math.max(ms, PACE_DEFAULTS.minRetryAfterMs), cap);
}

interface HostState {
  /** Loads running now (counted whether slowed down or not). */
  active: number;
  /** Loads at once while slowed down; null = no limit of its own. */
  limit: number | null;
  /** Successes in a row while slowed down. */
  streak: number;
  /** Refusals in a row since the last success, counted once per round (the backoff's exponent). */
  strikes: number;
  /** When the last refusal came in: a refusal of a request sent before it is part of the same round. */
  refusedAt: number;
  /** The status the host kept refusing with, once it reached `giveUpAfter` strikes; null while trying. */
  gaveUp: number | null;
  /** The addresses refused since the last success. */
  refusedUrls: Set<string>;
  /** Successful page loads (2xx/3xx) in this scan: a later 403 is a burst block. */
  successes: number;
  /** Crawl groups whose turn came already (`PaceLoadOptions.crawlGroup`). */
  crawlGroups: Set<string>;
  /** Hosts of files this host's pages need that were refused: its loads wait for their pauses too. */
  linked: Set<string>;
  /**
   * Rounds of file refusals from this host since a file from it last loaded (the backoff's exponent
   * for them; never a strike). As for loads, a refusal of a request sent before the last one is part
   * of the same round.
   */
  fileStrikes: number;
  /** When the last file refusal from this host came in. */
  fileRefusedAt: number;
  pausedUntil: number;
  /** Start of the last page load (crawl delay). */
  lastPageStart: number;
  crawlDelayMs: number;
  /**
   * Loads waiting for the crawl gap, in the order they get it: priority loads first, each kind in
   * arrival order. Only the first one waits for the gap; the others wait for their turn, so no load
   * is overtaken by one that came later (a timer race used to decide, and could starve a load).
   */
  queue: { priority: boolean }[];
  waiters: (() => void)[];
  /** A page load went to this host in this scan (its slow-down holds the page limit). */
  paged: boolean;
}

function hostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

const realSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  signal?.addEventListener('abort', done, { once: true });
});

export function createPace(opts: PaceOptions): Pace {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const ceiling = Math.max(1, Math.floor(opts.concurrency));
  const tune = {
    retries: Math.max(0, Math.floor(opts.retries ?? PACE_DEFAULTS.retries)),
    maxWaitMs: Math.max(0, opts.maxWaitMs ?? PACE_DEFAULTS.maxWaitMs),
    backoffMs: Math.max(0, opts.backoffMs ?? PACE_DEFAULTS.backoffMs),
    recoverAfter: Math.max(1, Math.floor(opts.recoverAfter ?? PACE_DEFAULTS.recoverAfter)),
  };
  const hosts = new Map<string, HostState>();
  const refusals = new Map<number, number>();
  /** Refusals of loads themselves (pages, fetches), as opposed to files a page needed. */
  let loadRefusals = 0;
  let retries = 0;
  let pausedMs = 0;
  let crawlDelayMs = 0;

  const state = (host: string): HostState => {
    let s = hosts.get(host);
    if (!s) hosts.set(host, (s = { active: 0, limit: null, streak: 0, strikes: 0, refusedAt: -Infinity, gaveUp: null, refusedUrls: new Set(), successes: 0, crawlGroups: new Set(), linked: new Set(), fileStrikes: 0, fileRefusedAt: -Infinity, pausedUntil: 0, lastPageStart: -Infinity, crawlDelayMs: 0, queue: [], waiters: [], paged: false }));
    return s;
  };
  const notify = (e: PaceChange) => {
    try {
      opts.onChange?.(e);
    } catch {
      // observation only
    }
  };
  const wake = (s: HostState) => {
    for (const w of s.waiters.splice(0)) w();
  };
  const fromCopy = (url: string): boolean => {
    if (!opts.replayed) return false;
    try {
      return opts.replayed(url) === true;
    } catch {
      return false;
    }
  };
  const timed = opts.onTiming
    ? (e: PaceTiming) => {
      try {
        opts.onTiming!(e);
      } catch {
        // observation only
      }
    }
    : undefined;
  const throwIfAborted = (signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  };

  // ---- the page gate: adaptive pages at once (ADAPTIVE) ----
  interface LoadSample { ok: boolean; loadMs: number; ttfbMs?: number }
  interface OpenSlot { url?: string; startedAt: number; loadMs: number; done: boolean; low?: boolean }
  const ad = {
    limit: Math.min(ceiling, Math.max(1, Math.floor(opts.start ?? ceiling))),
    highest: 0,
    /** The top of the limit: `concurrency`, lowered for a Crawl-delay (to the start) or by `hold`. */
    top: ceiling,
    start: 0,
    held: false,
    /** The site refused us: never raised again in this scan (`PaceAdapt.held`). */
    refused: false,
    /** `held` was said (once). */
    heldSaid: false,
    active: 0,
    queue: [] as { go: () => void; stop: () => void; low?: boolean }[],
    /** When the limit last changed: only what started after it is in the window. */
    changedAt: -Infinity,
    /** When the limit was last lowered for strain: a sign of strain from a request sent before it is that same round. */
    loweredAt: -Infinity,
    coolUntil: -Infinity,
    loads: [] as LoadSample[],
    browser: [] as number[],
    /** The scan's first window (at the start level): what later windows are compared with. */
    firstLoads: [] as LoadSample[],
    firstBrowser: [] as number[],
    baseLoadMs: null as number | null,
    baseTtfbMs: null as number | null,
    baseBrowserMs: null as number | null,
    /** The start page's first byte (`baseline`). */
    startTtfbMs: null as number | null,
    open: new Map<string, OpenSlot>(),
    poll: undefined as ReturnType<typeof setTimeout> | undefined,
    /** The last finite cap read (a cap that throws or is not a number keeps it). */
    lastCap: Infinity,
    /** Page loads' starts by page address: a stylesheet refused after its load is that load's round. */
    pageSent: new Map<string, number>(),
  };
  /** `Pace.stop`: every wait ends, every turn is refused, no timer is left. */
  const stopper = new AbortController();
  const stopped = () => stopper.signal.aborted;
  /** A wait that ends early when the load's own signal aborts, or when the scan stops. */
  const sleepUnlessStopped = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (!signal) return sleep(ms, stopper.signal);
    const both = new AbortController();
    const end = () => both.abort();
    signal.addEventListener('abort', end, { once: true });
    stopper.signal.addEventListener('abort', end, { once: true });
    return sleep(ms, both.signal).finally(() => {
      signal.removeEventListener('abort', end);
      stopper.signal.removeEventListener('abort', end);
    });
  };
  ad.highest = ad.start = ad.limit;
  const median = (xs: readonly number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  const capNow = (): number => {
    if (!opts.cap) return Infinity;
    try {
      const v = opts.cap();
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) ad.lastCap = Math.floor(v);
    } catch {
      // keeps the last finite cap
    }
    return ad.lastCap;
  };
  const notifyAdapt = (e: PaceAdapt) => {
    try {
      opts.onAdapt?.(e);
    } catch {
      // observation only
    }
  };
  /** Pages wait while the limit (and the share) is used; in arrival order. */
  const pump = () => {
    const cap = capNow();
    // The share went below the limit: the limit follows it down (no cooling: the site showed nothing).
    if (cap < ad.limit && cap >= 1) setLimit(cap, 'share', false);
    const room = Math.min(ad.limit, cap);
    while (ad.queue.length && ad.active < room) {
      ad.active++;
      // In arrival order, a low turn only once no other turn waits.
      const at = ad.queue.findIndex((q) => !q.low);
      ad.queue.splice(at < 0 ? 0 : at, 1)[0]!.go();
    }
    // Held by the share alone with nothing running to release a turn: read the share again soon.
    if (ad.queue.length && ad.active === 0 && ad.poll === undefined && !stopped()) {
      ad.poll = setTimeout(() => { ad.poll = undefined; pump(); }, ADAPTIVE.capPollMs);
    }
  };
  function setLimit(to: number, why: AdaptWhy, strain: boolean): void {
    const t = now();
    if (strain) {
      ad.loweredAt = t;
      ad.coolUntil = t + ADAPTIVE.coolMs;
    }
    const from = ad.limit;
    if (to === from) {
      if (strain) {
        // At the floor already: the window starts over all the same, so no raise comes from before it.
        ad.changedAt = t;
        ad.loads = [];
        ad.browser = [];
      }
      return;
    }
    ad.limit = to;
    ad.highest = Math.max(ad.highest, to);
    ad.changedAt = t;
    ad.loads = [];
    ad.browser = [];
    notifyAdapt({ from, to, why, ...heldNow() });
    if (to > from) pump();
  }
  /** `held: true` the first time a change is said after the site refused us. */
  function heldNow(): { held?: true } {
    if (!ad.refused || ad.heldSaid) return {};
    ad.heldSaid = true;
    return { held: true };
  }
  /** The site refused us: no raise from now on, said once (with the limit as it stands when it did not move). */
  function holdDown(why: AdaptWhy): void {
    ad.refused = true;
    if (!ad.heldSaid) notifyAdapt({ from: ad.limit, to: ad.limit, why, ...heldNow() });
  }
  /**
   * A sign of strain from a request sent at `sentAt`: one step down at once (once per round), then the
   * cooling window. `refusal`: the site refused us, so the limit is never raised again (`holdDown`).
   */
  function strained(why: AdaptWhy, sentAt: number, refusal = false): void {
    if (refusal) ad.refused = true;
    // A fixed pool (the start is the ceiling: the CLI's N of 4 or less, a hosted ceiling at or below
    // the start) keeps its width: the host's own slow-down still applies to its loads.
    // Sent before (or as) it was lowered: the same round (as for refusals, a burst of answers counts once).
    if (ad.start < ceiling && sentAt > ad.loweredAt) setLimit(Math.max(Math.min(ADAPTIVE.floor, ad.limit), ad.limit - 1), why, true);
    if (refusal) holdDown(why);
  }
  /** Any host the pages load from is slowed down or paused: the slow-down wins over any raise. */
  /** Any host the scan loads from, a stylesheet host included, is slowed down or paused: the slow-down wins over any raise. */
  const slowedAny = (t: number) => [...hosts.values()].some((s) => s.pausedUntil > t || s.limit !== null);
  function maybeRaise(): void {
    const t = now();
    if (ad.held || ad.refused || t < ad.coolUntil || slowedAny(t)) return;
    if (ad.limit >= Math.min(ad.top, capNow())) return;
    if (ad.browser.length < ADAPTIVE.windowPages || ad.loads.length < ADAPTIVE.windowLoads) return;
    const win = ad.loads.slice(-ADAPTIVE.windowLoads);
    if (win.some((x) => !x.ok) || ad.baseLoadMs === null) return;
    const load = median(win.map((x) => x.loadMs));
    if (load > Math.max(ad.baseLoadMs * ADAPTIVE.loadFactor, ad.baseLoadMs + ADAPTIVE.loadSlackMs)) return;
    const ttfbs = win.flatMap((x) => (x.ttfbMs !== undefined ? [x.ttfbMs] : []));
    const baseTtfb = ad.startTtfbMs ?? ad.baseTtfbMs;
    if (ttfbs.length && median(ttfbs) > Math.max(ADAPTIVE.ttfbFloorMs, baseTtfb !== null ? ADAPTIVE.ttfbFactor * baseTtfb : 0)) return;
    const keepUp = 1 + ADAPTIVE.keepUpNoise + ADAPTIVE.keepUpShare * Math.max(0, ad.limit - ad.start) / ad.start;
    if (ad.baseBrowserMs !== null && median(ad.browser.slice(-ADAPTIVE.windowPages)) > keepUp * ad.baseBrowserMs) return;
    setLimit(ad.limit + 1, 'comfortable', false);
  }
  /** A page load through the controller that was sent at `sentAt` ended: judged for the page limit. */
  function observed(sample: LoadSample | null, sentAt: number, url: string): void {
    if (sample?.ok) {
      const slot = ad.open.get(url);
      if (slot && sentAt >= slot.startedAt) slot.loadMs = Math.max(slot.loadMs, sample.loadMs);
      if (ad.firstLoads.length < ADAPTIVE.windowLoads) {
        ad.firstLoads.push(sample);
        if (ad.firstLoads.length === ADAPTIVE.windowLoads) {
          ad.baseLoadMs = median(ad.firstLoads.map((x) => x.loadMs));
          const t = ad.firstLoads.flatMap((x) => (x.ttfbMs !== undefined ? [x.ttfbMs] : []));
          if (t.length) ad.baseTtfbMs = median(t);
        }
      }
    }
    if (sentAt < ad.changedAt) return;
    ad.loads.push(sample ?? { ok: false, loadMs: 0 });
    if (ad.loads.length > 4 * ADAPTIVE.windowLoads) ad.loads.splice(0, ad.loads.length - 2 * ADAPTIVE.windowLoads);
    if (sample?.ok && ad.baseLoadMs !== null) {
      const last = ad.loads.filter((x) => x.ok).slice(-ADAPTIVE.trendLoads);
      if (last.length === ADAPTIVE.trendLoads) {
        const m = median(last.map((x) => x.loadMs));
        if (m > Math.max(ad.baseLoadMs * ADAPTIVE.trendFactor, ad.baseLoadMs + ADAPTIVE.trendSlackMs)) return strained('slower', sentAt);
      }
    }
    if (sample?.ok) maybeRaise();
  }
  /** A page's turn ended: its browser time (the turn minus its load) is judged. */
  function pageDone(slot: OpenSlot): void {
    const t = now();
    if (slot.loadMs > 0 && slot.startedAt >= ad.changedAt && !slot.low) {
      const ms = Math.max(0, t - slot.startedAt - slot.loadMs);
      if (ad.firstBrowser.length < ADAPTIVE.windowPages) {
        ad.firstBrowser.push(ms);
        if (ad.firstBrowser.length === ADAPTIVE.windowPages) ad.baseBrowserMs = median(ad.firstBrowser);
      }
      ad.browser.push(ms);
      if (ad.browser.length > 4 * ADAPTIVE.windowPages) ad.browser.splice(0, ad.browser.length - 2 * ADAPTIVE.windowPages);
      // The sessions stopped keeping up: more pages at once finish fewer pages a second than the start did.
      if (ad.baseBrowserMs !== null && ad.limit > ad.start && ad.browser.length >= ADAPTIVE.windowPages
        && median(ad.browser.slice(-ADAPTIVE.windowPages)) > ad.baseBrowserMs * (ad.limit / ad.start)) {
        setLimit(ad.limit - 1, 'browsers', true);
      } else maybeRaise();
    }
    pump();
  }
  /** The limit's top came down (a Crawl-delay, a slow site): the limit with it. */
  function lowerTop(top: number, why: AdaptWhy): void {
    ad.top = Math.max(1, Math.min(ad.top, top));
    if (ad.limit > ad.top) setLimit(ad.top, why, false);
  }
  /**
   * The page loads' outcome for the page limit (any load: a 429 on a fetch is strain too). The site
   * refusing us holds the limit down (`refusal`: 429, 503 or a burst 403; a challenge; 406, src/sessions.ts
   * refusesScan); a page's own access rule (401, a 403 before any page loaded) and a refused stylesheet
   * step down for the cooling window only.
   */
  function judge(a: PaceAnswer, page: boolean, sentAt: number, url: string, refusal: boolean): void {
    if (refusal) return strained(a.status === 403 ? 'refused' : 'slow-down', sentAt, true);
    if (a.files?.length && a.status < 400) return strained('slow-down', sentAt);
    if (!page) return;
    if (isChallengeStatus(a.status) || a.challenge) return strained('challenge', sentAt, true);
    if (isRefusalStatus(a.status)) return strained('refused', sentAt, a.status === 406);
    // A time-out answer or a server error: no step down, but the window is not clean. Not found or gone
    // is an ordinary answer, and a load that was not timed (no `loadMs`) says nothing either way.
    if (a.status === 408 || a.status >= 500) return observed(null, sentAt, url);
    if (a.status >= 400 || a.loadMs === undefined) return;
    observed({ ok: true, loadMs: a.loadMs, ...(a.ttfbMs !== undefined ? { ttfbMs: a.ttfbMs } : {}) }, sentAt, url);
  }

  /**
   * Waits for the host's turn (pause, crawl gap, a free slot) and takes a slot: the time it started.
   * A reason instead when the wait would not fit, or the host was given up on.
   */
  async function acquire(
    s: HostState, page: boolean, deadline: number, signal?: AbortSignal, group?: string, priority = false, again = false,
  ): Promise<number | { late: string; status?: number }> {
    let ticket: { priority: boolean } | undefined;
    const leave = () => {
      if (!ticket) return;
      const i = s.queue.indexOf(ticket);
      if (i >= 0) s.queue.splice(i, 1);
      ticket = undefined;
      wake(s);
    };
    const waitTurn = () => new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener('abort', done);
        resolve();
      };
      s.waiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    try {
      for (;;) {
        throwIfAborted(signal);
        if (stopped()) throw new ScanStopped();
        if (s.gaveUp !== null && !again) return { late: keptRefusing(s.gaveUp), status: s.gaveUp };
        const t = now();
        // A load whose group already had its turn (the page's other width) does not wait for the gap.
        const spaced = page && s.crawlDelayMs > 0 && !(group !== undefined && s.crawlGroups.has(group));
        if (spaced && !ticket) {
          ticket = { priority };
          const at = priority ? s.queue.findIndex((q) => !q.priority) : -1;
          if (at >= 0) s.queue.splice(at, 0, ticket);
          else s.queue.push(ticket);
        } else if (!spaced && ticket) leave();
        const gapAt = spaced ? s.lastPageStart + s.crawlDelayMs : 0;
        // A host whose files the pages need is pausing: the pages wait for it too.
        const pausedUntil = Math.max(s.pausedUntil, ...[...s.linked].map((h) => hosts.get(h)?.pausedUntil ?? 0));
        const readyAt = Math.max(pausedUntil, gapAt);
        if (ticket && s.queue[0] !== ticket) {
          // Not our turn yet. Give up once even the next gap ends past our deadline (loads ahead may
          // still give up and let us go sooner, so their gaps are not counted against us).
          if (Math.max(readyAt, t) > deadline) return { late: pausedUntil >= gapAt ? NO_TIME_PAUSED : NO_TIME_CRAWL };
          await waitTurn();
          continue;
        }
        if (readyAt > t) {
          if (readyAt > deadline) return { late: pausedUntil >= gapAt ? NO_TIME_PAUSED : NO_TIME_CRAWL };
          await sleepUnlessStopped(readyAt - t, signal);
          continue;
        }
        if (s.limit !== null && s.active >= s.limit) {
          await waitTurn();
          continue;
        }
        s.active++;
        if (spaced) {
          s.lastPageStart = t;
          if (group !== undefined) s.crawlGroups.add(group);
        }
        return t;
      }
    } finally {
      // Taken, given up or aborted: the next load in line moves up.
      leave();
    }
  }

  function release(s: HostState): void {
    s.active = Math.max(0, s.active - 1);
    wake(s);
  }

  function succeeded(host: string, s: HostState, page: boolean): void {
    // Only page loads count for the 403 rule: robots.txt or a document answering is not a page loading.
    if (page) s.successes++;
    s.strikes = 0;
    s.gaveUp = null;
    s.refusedUrls.clear();
    if (s.limit === null) return;
    if (++s.streak < tune.recoverAfter) return;
    s.streak = 0;
    s.limit++;
    // Back to the page limit of the moment (adaptive, `ADAPTIVE`): then the host's own limit lifts.
    const target = Math.max(1, Math.min(ad.limit, capNow()));
    if (s.limit >= target) {
      s.limit = null;
      notify({ step: 'recovered', host, concurrency: target });
    }
    wake(s);
  }

  /** A refusal of a request sent at `sentAt`: one load at a time, and the host paused for the wait. Returns the wait. */
  function refused(host: string, s: HostState, a: PaceAnswer, sentAt: number, url: string): number {
    refusals.set(a.status, (refusals.get(a.status) ?? 0) + 1);
    loadRefusals++;
    const t = now();
    // A request sent after the last refusal is a new round; the others were already on their way.
    if (sentAt > s.refusedAt) s.strikes++;
    s.refusedAt = t;
    if (s.refusedUrls.size < PACE_DEFAULTS.giveUpUrls) s.refusedUrls.add(url);
    if (s.strikes >= PACE_DEFAULTS.giveUpAfter && s.refusedUrls.size >= PACE_DEFAULTS.giveUpUrls) s.gaveUp = a.status;
    const asked = retryAfterMs(a.retryAfter, t, tune.maxWaitMs);
    const backoff = Math.min(tune.maxWaitMs, tune.backoffMs * 2 ** Math.min(Math.max(0, s.strikes - 1), 8)) * (0.5 + 0.5 * random());
    const wait = Math.round(asked ?? backoff);
    s.streak = 0;
    const wasFree = s.limit === null;
    s.limit = 1;
    const until = t + wait;
    if (until > s.pausedUntil) {
      // Counted up to the scan's deadline: past it nothing waits.
      pausedMs += Math.max(0, Math.min(until, opts.deadline ?? Infinity) - Math.max(t, s.pausedUntil));
      s.pausedUntil = until;
    }
    if (wasFree) notify({ step: 'slowed', host, status: a.status, waitMs: wait });
    return wait;
  }

  /**
   * A refused file (`PaceAnswer.files`): its own host pauses (Retry-After, or a backoff on that host's
   * file refusals in a row) and goes to one load at a time; `pageHost`'s loads wait for that pause.
   * No strike: a file never makes the scan give up on a host. Returns the wait.
   */
  function fileRefused(f: { url: string; status: number; retryAfter?: string | null }, pageHost: string, sentAt: number): number {
    const host = hostKey(f.url);
    const s = state(host);
    refusals.set(f.status, (refusals.get(f.status) ?? 0) + 1);
    if (host !== pageHost) state(pageHost).linked.add(host);
    const t = now();
    // Once per round: the two widths and every sheet of a try sent before the last refusal are one.
    if (sentAt > s.fileRefusedAt) s.fileStrikes++;
    s.fileRefusedAt = t;
    const asked = retryAfterMs(f.retryAfter, t, tune.maxWaitMs);
    const backoff = Math.min(tune.maxWaitMs, tune.backoffMs * 2 ** Math.min(Math.max(0, s.fileStrikes - 1), 8)) * (0.5 + 0.5 * random());
    const wait = Math.round(asked ?? backoff);
    s.streak = 0;
    const wasFree = s.limit === null;
    s.limit = 1;
    const until = t + wait;
    if (until > s.pausedUntil) {
      pausedMs += Math.max(0, Math.min(until, opts.deadline ?? Infinity) - Math.max(t, s.pausedUntil));
      s.pausedUntil = until;
    }
    if (wasFree) notify({ step: 'slowed', host, status: f.status, waitMs: wait, file: true });
    return wait;
  }

  return {
    async load<T>(url: string, run: () => Promise<T>, answer: (value: T) => PaceAnswer | null, o: PaceLoadOptions<T> = {}): Promise<PaceResult<T>> {
      const host = hostKey(url);
      const s = state(host);
      const page = o.page !== false;
      const deadline = Math.min(opts.deadline ?? Infinity, o.deadline ?? Infinity);
      const maxRetries = Math.max(0, Math.floor(o.retries ?? tune.retries));
      for (let attempt = 0; ; attempt++) {
        const asked = timed ? now() : 0;
        // The scan's own copy answers this load (first try only: a retry is a load the site refused).
        const free = page && attempt === 0 && fromCopy(url);
        const sent = free ? now() : await acquire(s, page || o.crawl === true, deadline, o.signal, o.crawlGroup, o.priority === true, o.again === true);
        if (typeof sent !== 'number') return sent.status === undefined ? { refused: sent.late } : { refused: sent.late, status: sent.status };
        if (page && !free) {
          s.paged = true;
          ad.pageSent.set(url, sent);
          if (ad.pageSent.size > 512) ad.pageSent.delete(ad.pageSent.keys().next().value!);
        }
        let value: T;
        try {
          value = await run();
        } catch (err) {
          // A page load that ran out of time is strain; one whose answer is known (an HTTP error with no
          // body) is judged as that answer; any other failure only leaves the window unclean.
          if (page && !free) {
            const status = thrownStatus(o.failedStatus, err);
            if (isTimeout(err)) strained('timeout', sent);
            else if (status !== undefined) judge({ status }, page, sent, url, status === 429 || status === 503 || (status === 403 && s.successes > 0));
            else observed(null, sent, url);
          }
          throw err;
        } finally {
          if (!free) release(s);
          timed?.({ kind: 'load', url, page, waitMs: Math.max(0, sent - asked), runMs: Math.max(0, now() - sent) });
        }
        const a = answer(value);
        if (!a) return { value };
        const isRefusal = a.status === 429 || a.status === 503 || (page && a.status === 403 && s.successes > 0);
        // Answered from the copy, with nothing refused: the site was not asked, so nothing is judged
        // (whether or not the load took a turn: the page's other width waits for the first one's answer).
        if ((free || a.copied) && !isRefusal && !(a.status < 400 && a.files?.length)) return { value };
        judge(a, page, sent, url, isRefusal);
        if (!isRefusal) {
          const files = a.status < 400 ? (a.files ?? []) : [];
          if (!files.length) {
            if (a.status < 400) succeeded(host, s, page);
            return { value };
          }
          // The page answered, but files it needs were refused, each by its own host: not a success of
          // the page's host (its strikes and give-up stand).
          let wait = 0;
          for (const f of files) wait = Math.max(wait, fileRefused(f, host, sent));
          const status = files[0]!.status;
          if (attempt >= maxRetries) return { value, refused: keptRefusing(status), status };
          if (now() + wait > deadline) return { value, refused: noTimeToRetry(status), status };
          o.discard?.(value);
          retries++;
          continue;
        }
        const wait = refused(host, s, a, sent, url);
        if (attempt >= maxRetries || s.gaveUp !== null) return { value, refused: keptRefusing(a.status), status: a.status };
        if (now() + wait > deadline) return { value, refused: noTimeToRetry(a.status), status: a.status };
        o.discard?.(value);
        retries++;
      }
    },
    fileRefused(fileUrl: string, answer: PaceAnswer, pageUrl: string): void {
      // The round of the page's last load: a burst of its stylesheets refused late steps down once.
      strained('slow-down', ad.pageSent.get(pageUrl) ?? now());
      fileRefused({ url: fileUrl, status: answer.status, retryAfter: answer.retryAfter ?? null }, hostKey(pageUrl), now());
    },
    fileLoaded(fileUrl: string): void {
      const s = hosts.get(hostKey(fileUrl));
      if (!s) return;
      s.fileStrikes = 0;
      // A stylesheet host that refused climbs back like a page host (its limit holds any raise meanwhile).
      if (s.limit !== null && !s.paged && ++s.streak >= tune.recoverAfter) {
        s.streak = 0;
        if (++s.limit >= Math.max(1, Math.min(ad.limit, capNow()))) s.limit = null;
        wake(s);
      }
    },
    setCrawlDelay(host: string, seconds: number | undefined): void {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
      const ms = Math.min(Math.round(seconds * 1000), PACE_DEFAULTS.maxCrawlDelayMs);
      state(host.toLowerCase()).crawlDelayMs = ms;
      crawlDelayMs = Math.max(crawlDelayMs, ms);
      // A site that asks for a pause between pages never gets more pages at once than the start.
      lowerTop(ad.start, 'crawl-delay');
    },
    limit(host: string): number | null {
      return hosts.get(host.toLowerCase())?.limit ?? null;
    },
    summary(): PaceSummary | undefined {
      const slowedDown = refusals.size > 0;
      if (!slowedDown && !crawlDelayMs) return undefined;
      return {
        slowedDown,
        refusals: [...refusals].sort((a, b) => a[0] - b[0]).map(([status, count]) => ({ status, count })),
        ...(slowedDown && !loadRefusals ? { stylesheetsOnly: true } : {}),
        retries,
        pausedMs,
        ...(crawlDelayMs ? { crawlDelayMs } : {}),
      };
    },
    page(o?: { low?: boolean }): Promise<PageSlot> {
      if (stopped()) return Promise.reject(new ScanStopped());
      const low = o?.low === true;
      const asked = timed ? now() : 0;
      return new Promise<PageSlot>((resolve, reject) => {
        ad.queue.push({ ...(low ? { low } : {}), stop: () => reject(new ScanStopped()), go: () => {
          const slot: OpenSlot = { startedAt: now(), loadMs: 0, done: false, ...(low ? { low } : {}) };
          timed?.({ kind: 'turn', waitMs: Math.max(0, slot.startedAt - asked) });
          resolve({
            url(u: string) {
              if (slot.done || slot.url !== undefined) return;
              slot.url = u;
              ad.open.set(u, slot);
            },
            release() {
              if (slot.done) return;
              slot.done = true;
              if (slot.url !== undefined && ad.open.get(slot.url) === slot) ad.open.delete(slot.url);
              ad.active = Math.max(0, ad.active - 1);
              if (!stopped()) pageDone(slot);
            },
          });
        } });
        pump();
      });
    },
    pages() {
      return { limit: Math.max(0, Math.min(ad.limit, capNow())), active: ad.active, highest: ad.highest };
    },
    baseline(firstByteMs: number | null): void {
      if (typeof firstByteMs === 'number' && Number.isFinite(firstByteMs) && firstByteMs >= 0) ad.startTtfbMs = firstByteMs;
    },
    hold(n: number, why: AdaptWhy = 'slow-site'): void {
      ad.held = true;
      // The site refuses every session: the host hears it held, on this change or on its own.
      if (why === 'refused') ad.refused = true;
      lowerTop(Math.floor(n), why);
      if (why === 'refused') holdDown(why);
    },
    ...(opts.copied ? {
      copied(answer: unknown): boolean {
        try {
          return opts.copied!(answer) === true;
        } catch {
          return false;
        }
      },
    } : {}),
    stop(): void {
      if (stopped()) return;
      stopper.abort();
      clearTimeout(ad.poll);
      ad.poll = undefined;
      for (const q of ad.queue.splice(0)) q.stop();
      // Loads waiting for a host's turn wake and see the stop.
      for (const s of hosts.values()) wake(s);
    },
  };
}

/** `PaceLoadOptions.failedStatus` for a thrown load: a whole HTTP status, else undefined (a throw in it says nothing). */
function thrownStatus(fn: ((err: unknown) => number | undefined) | undefined, err: unknown): number | undefined {
  if (!fn) return undefined;
  try {
    const v = fn(err);
    return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v < 600 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Playwright's navigation time-out (`page.goto: Timeout 45000ms exceeded`). */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || /\bTimeout \d+ms exceeded/.test(err.message));
}

/**
 * A page load (`page.goto`) through the controller; without one, a plain load. With `styles` (the
 * page's stylesheet watch, `src/styles.ts`), each try that the page answered first runs `prepare`
 * (the caller's settle: scrolling, waiting), then waits for its stylesheets to answer, and a try in
 * which the site refused a stylesheet the page needs counts as refused: each refused sheet is charged
 * to its own host (its Retry-After), and the page is loaded again within its retries, after that
 * pause. A page still missing a stylesheet after its tries comes back refused with `unstyledReason`
 * (without a controller there is no retry, only that reason).
 */
export async function gotoPolitely<R extends { status(): number; headers(): Record<string, string> }>(
  pace: Pace | undefined,
  url: string,
  goto: () => Promise<R | null>,
  opts: Omit<PaceLoadOptions<R | null>, 'page' | 'discard'> & {
    styles?: StyleWatch;
    /** Runs after each try the page answered (status under 400), before its stylesheets are judged. */
    prepare?: (resp: R) => Promise<void>;
  } = {},
): Promise<PaceResult<R | null>> {
  const { styles, prepare, ...loadOpts } = opts;
  /** The refused stylesheets of the last try that ran (empty: none, or no watch). */
  let refused: StyleRefusal[] = [];
  /** The last try's navigation time (for the page limit, `ADAPTIVE`). */
  let loadMs: number | undefined;
  const run = async () => {
    refused = [];
    styles?.reset();
    const t0 = Date.now();
    loadMs = undefined;
    const resp = await goto();
    loadMs = Date.now() - t0;
    // A bot challenge (HTTP 202) is the answer: never the page, so its stylesheets are not waited for
    // (nor judged), and the caller sees the challenge, not a refused stylesheet (v7).
    if (resp && resp.status() < 400 && !isChallengeStatus(resp.status())) {
      await prepare?.(resp);
      if (styles) {
        await styles.settle();
        refused = await styles.degraded();
      }
    }
    return resp;
  };
  const answer = (resp: R | null): PaceAnswer | null => {
    if (!resp) return null;
    const headers = resp.headers();
    const ttfbMs = firstByteOf(resp);
    // An answer the site did not send (the scan's own copy, src/replay) is not timed: it says nothing
    // about the site, so the page limit never rises or falls on it. Only with replay on: without it no
    // answer is asked about.
    const sent = !(pace?.copied?.(resp) ?? false);
    return {
      status: resp.status(), retryAfter: headers['retry-after'] ?? null,
      ...(loadMs !== undefined && sent ? { loadMs } : {}),
      ...(ttfbMs !== undefined && sent ? { ttfbMs } : {}),
      ...(sent ? {} : { copied: true }),
      ...(isWafChallenge(lowerKeys(headers)) ? { challenge: true } : {}),
      ...(refused.length ? { files: refused.map((f) => ({ url: f.url, status: f.status, retryAfter: f.retryAfter })) } : {}),
    };
  };
  if (!pace) {
    const value = await run();
    return refused.length ? { value, refused: unstyledReason(refused[0]!.status, 'once'), status: refused[0]!.status } : { value };
  }
  const r = await pace.load(url, run, answer, loadOpts);
  // Refused, and the last try that ran was refused for its stylesheets (a try the controller did not
  // start, for want of time, follows one that was).
  if (r.refused && refused.length) {
    const status = refused[0]!.status;
    return { ...(r.value !== undefined ? { value: r.value } : {}), refused: unstyledReason(status, /no time left/.test(r.refused) ? 'no-time' : 'kept'), status };
  }
  return r;
}

/** The response's time to first byte as the browser timed it (Playwright `request().timing()`), when it says. */
function firstByteOf(resp: unknown): number | undefined {
  try {
    const t = (resp as { request?: () => { timing?: () => { requestStart?: number; responseStart?: number } } }).request?.().timing?.();
    const at = t?.responseStart;
    return typeof at === 'number' && Number.isFinite(at) && at >= 0 ? Math.round(at) : undefined;
  } catch {
    return undefined;
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * A fetch through the controller: not a page load (no crawl delay, no 403 rule). `retries`: tries after
 * the first (default 1, as for document requests; discovery uses the controller's default). `crawl`: the
 * Crawl-delay applies as to a page (a PDF download, src/documents/index.ts).
 */
export function politeFetch(pace: Pace, fetchFn: typeof fetch, opts: { retries?: number; crawl?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const r = await pace.load(url, () => fetchFn(input, init), (res) => ({ status: res.status, retryAfter: res.headers.get('retry-after') }), {
      page: false, retries: opts.retries ?? 1, ...(opts.crawl ? { crawl: true } : {}), ...(init?.signal ? { signal: init.signal } : {}),
      discard: (res) => { res.body?.cancel().catch(() => {}); },
    });
    if (r.value) return r.value;
    throw new Error(r.refused ?? 'No response');
  };
}
