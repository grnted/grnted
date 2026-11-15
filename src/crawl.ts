// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { parseRobots, type Robots } from './robots.js';
import { selectPages, spreadOrder, type Selection } from './select.js';
import { parseSitemap, sitemapLastmods } from './sitemap.js';
import { lastmodKey } from './incremental/lastmod.js';
import { CHALLENGE_PAGE, isChallengeStatus, isRefusalStatus } from './challenge.js';
import { REFUSED_RETRIES, isResponseCodeFailure, navigationOf, thrownStatus, type NavigationStatus } from './egress.js';
import { safeEmit } from './events.js';
import { gateFailure, gateStopsLoad, gatedBrowser } from './navigationGate.js';
import { PACE_DEFAULTS, gotoPolitely, politeFetch, type Pace } from './pace.js';
import type { BrowserLike, ScanEvent } from './types.js';
import { directoryOfIndex, isActionLikeUrl, isDocumentUrl, isLikelyHtml, normalizeUrl, sameSite, urlKey } from './url.js';
import { collectLinks, MAX_PAGE_LINKS } from './pageLinks.js';
import { pageTimeoutFor, siteTiming, type SiteTiming, type StartSpeed } from './siteSpeed.js';
import { actionSkips, isWide, MAX_SITEMAP_DEPTH, MAX_WIDE_DOCUMENTS, MAX_WIDE_SITEMAP_FILES, wideFilter, wideNormalize } from './wide.js';

/** Page addresses kept from the sitemaps: the first ones in section-spread order over every file read. */
export const MAX_SITEMAP_URLS = 2000;
const MAX_CHILD_SITEMAPS = 5;
/** robots.txt and sitemap bodies: read as a stream and cut off here (the reader is cancelled). */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Sitemap files are fetched only from the scanned host, its domain (the host without `www.`) and the
 * hosts under that domain (cdn.e.org for www.e.org); any other site's is skipped (Grok r1 #2).
 */
export function sitemapHostAllowed(fileUrl: string, startUrl: string): boolean {
  let file: string;
  let start: string;
  try {
    file = new URL(fileUrl).hostname.toLowerCase();
    start = new URL(startUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const base = start.replace(/^www\./, '');
  return file === start || file === base || file.endsWith(`.${base}`);
}

/**
 * The body as text, at most MAX_BODY_BYTES: past it the reader is cancelled and the rest never read.
 * The text read so far is kept (`truncated`), so a big sitemap still gives the addresses it starts with
 * and a big robots.txt its rules. After cancel() the reader is not released again (the Workers runtime
 * releases it with the cancel, and a second release throws).
 */
export async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_BODY_BYTES - bytes;
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += part.byteLength;
      text += dec.decode(part, { stream: true });
      if (bytes >= MAX_BODY_BYTES) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // A body that broke off: what was read stands.
    truncated = true;
  }
  if (!truncated) {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return { text: text + dec.decode(), truncated };
}

export interface CrawlOptions {
  browser: BrowserLike;
  /**
   * A home page load the site refused: a browser to load it again in (another session, or a fresh
   * one: src/sessions.ts `refusedRetry`), at most REFUSED_RETRIES times; null when there is none. Only
   * then does the start page count as refused (`refusedStart`).
   */
  refusedRetry?: (url: string) => Promise<BrowserLike | null>;
  maxPages: number;
  userAgent: string;
  fetchFn?: typeof fetch;
  allowUrl?: (url: string) => Promise<boolean>;
  /** Discovery events (`discover` steps, then `selected`); observation only, a throwing listener is ignored. */
  onEvent?: (e: ScanEvent) => void;
  /** The scan's politeness controller: gets the site's Crawl-delay, and paces the home page load. */
  pace?: Pace;
  /** Sitemap files listed on other sites, not fetched (`sitemapHostAllowed`): their count, once. */
  onSitemapsSkipped?: (count: number) => void;
  /**
   * Monitoring scans: each kept sitemap address's `<lastmod>` goes here, by `lastmodKey` (at most
   * MAX_LASTMODS). Discovery's page list does not depend on it.
   */
  lastmods?: Map<string, string>;
  /**
   * The scan's cut-off for waits (epoch ms): the sitemap files are read within a quarter of the time
   * left before it (and `sitemapBudgetMs` at most), so discovery never eats the pages' time.
   */
  deadline?: number;
  /** The start page's measured speed (`measureStart`): the home page link fallback's timeout follows it. */
  startSpeed?: Promise<StartSpeed>;
  /** Tests: the slow-site timings (`SITE_TIMING`). */
  timing?: Partial<SiteTiming>;
  /**
   * Monitoring scans that carry pages forward: the pages the monitor's previous scan had. They are
   * candidates beside the sitemap's or the home page's, and discovery reads no page for more links (`deepen`):
   * what a full scan found by reading on stays in the list, and an unchanged page still costs the site one
   * conditional request. The monitor's full scans discover as any scan does.
   */
  known?: readonly string[];
}

/** Sitemap lastmods kept per scan (monitoring scans). */
export const MAX_LASTMODS = 20_000;

/** The file's lastmods for the addresses `keep` keeps, into the scan's map. */
function noteLastmods(xml: string, keep: (url: string) => string | null, into: Map<string, string> | undefined): void {
  if (!into) return;
  for (const [loc, mod] of Object.entries(sitemapLastmods(xml))) {
    if (into.size >= MAX_LASTMODS) return;
    const n = keep(loc);
    if (!n) continue;
    const k = lastmodKey(n);
    if (!into.has(k)) into.set(k, mod);
  }
}

/** Redirects followed for robots.txt and a sitemap, each hop checked with `allowUrl`. */
export const MAX_FETCH_REDIRECTS = 5;

/**
 * GET a text file (robots.txt, a sitemap): at most MAX_FETCH_REDIRECTS redirects, each hop through
 * `allowUrl`, the body capped at MAX_BODY_BYTES. With `site` (sitemaps), every address it is fetched
 * from, each redirect hop included, must also be on the scanned host or a host under its domain
 * (`sitemapHostAllowed`). robots.txt is fetched without it: it follows redirects across hosts, as
 * RFC 9309 asks, so a site whose robots.txt redirects keeps its rules.
 */
async function fetchText(
  url: string, opts: Pick<CrawlOptions, 'fetchFn' | 'pace' | 'allowUrl' | 'userAgent' | 'timing'>, site?: string, until = Infinity,
): Promise<string> {
  return followed(url, opts, site, until, async (res) => {
    if (res.ok) return (await readCapped(res)).text;
    await res.body?.cancel().catch(() => {});
    return '';
  }, '');
}

/**
 * GETs `url`, following its redirects by hand (a hop to an address `allowUrl` refuses is never requested;
 * at most MAX_FETCH_REDIRECTS), and gives the last answer and its address to `use`. `fallback` when a hop is
 * refused, the redirects do not end, or the request fails.
 */
async function followed<T>(
  url: string, opts: Pick<CrawlOptions, 'fetchFn' | 'pace' | 'allowUrl' | 'userAgent' | 'timing'>, site: string | undefined, until: number,
  use: (res: Response, address: string) => Promise<T>, fallback: T,
  /** Asked for the address and for each redirect hop before it is requested: false ends there (`fallback`). */
  may: (address: string) => boolean = () => true,
): Promise<T> {
  // Each try gets its own `fileTimeoutMs` (the request and its body; staging 2026-11-03: fedex.com's
  // sitemaps take 8-12 s, past the old 10 s), never past `until` (the sitemap budget's end); a wait
  // the site asked for comes between tries.
  const fileMs = siteTiming(opts.timing).fileTimeoutMs;
  if (Date.now() >= until) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const base = opts.fetchFn ?? fetch;
  const once: typeof fetch = (input, init) => {
    clearTimeout(timer);
    const c = new AbortController();
    timer = setTimeout(() => c.abort(), Math.max(0, Math.min(fileMs, until - Date.now())));
    return base(input, { ...init, signal: c.signal });
  };
  // Through the scan's controller: a refused fetch (429, 503) is tried again after a pause, so the
  // candidate list does not depend on the site's load at that moment. One that still fails reads as ''.
  const fetchOnce = opts.pace ? politeFetch(opts.pace, once, { retries: PACE_DEFAULTS.retries }) : once;
  try {
    let current = url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      if (site !== undefined && !sitemapHostAllowed(current, site)) return fallback;
      if (!may(current)) return fallback;
      if (opts.allowUrl && !(await opts.allowUrl(current))) return fallback;
      res = await fetchOnce(current, { headers: { 'user-agent': opts.userAgent }, redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_FETCH_REDIRECTS) return fallback;
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return fallback;
      next.hash = '';
      current = next.href;
    }
    return await use(res, current);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Directory and index-file pairs a scan asks the server about, and the longest all of it may take. */
export const INDEX_ALIAS = { pairs: 10, budgetMs: 8000 } as const;

/**
 * A directory and its index file (`/news/` and `/news/index.html`) are one page **only when the server shows
 * it** (review r1, finding 9: their names prove nothing; `/a` and `/a/index.html` can hold different pages):
 * when both are candidates, each is asked for, and they are one page when their redirects end at the same
 * address. The one that address names is kept (the start address always is). Otherwise both are pages, as any
 * two addresses are. Short scans only (a long scan keeps both), at most `INDEX_ALIAS.pairs` pairs a scan,
 * within `INDEX_ALIAS.budgetMs`; the answers' bodies are never read. Only addresses the scan could load as
 * pages are asked for, each redirect hop included: on the scanned site, allowed by robots.txt, not an
 * action (`isActionLikeUrl`). A one-page scan asks nothing.
 */
function indexAliases(startUrl: string, opts: CrawlOptions, isAllowed: (url: string) => boolean): { drop(candidates: readonly string[]): Promise<string[]> } {
  /** Address keys that turned out to be another candidate's second address. */
  const aliases = new Set<string>();
  const asked = new Set<string>();
  const until = Date.now() + Math.min(INDEX_ALIAS.budgetMs, opts.deadline === undefined ? Infinity : Math.max(0, opts.deadline - Date.now()) / 8);
  const may = (address: string) => {
    try {
      return sameSite(address, startUrl) && isAllowed(address) && !isActionLikeUrl(address, startUrl);
    } catch {
      return false;
    }
  };
  const endOf = (url: string) => followed(url, opts, startUrl, until, async (res, address) => {
    await res.body?.cancel().catch(() => {});
    return res.ok ? normalizeUrl(address) : null;
  }, null as string | null, may);
  return {
    async drop(candidates) {
      if (opts.maxPages <= 1) return [...candidates];
      const byKey = new Map<string, string>([[urlKey(startUrl), startUrl]]);
      for (const c of candidates) {
        const n = normalizeUrl(c, startUrl);
        if (n && sameSite(n, startUrl) && !byKey.has(urlKey(n))) byKey.set(urlKey(n), n);
      }
      for (const [key, href] of byKey) {
        if (asked.size >= INDEX_ALIAS.pairs || Date.now() >= until) break;
        if (asked.has(key)) continue;
        const dir = directoryOfIndex(href);
        if (!dir || !byKey.has(urlKey(dir)) || !may(href) || !may(dir)) continue;
        asked.add(key);
        const a = await endOf(href);
        if (!a) continue;
        // The index file's own redirects ended at the directory: shown. Otherwise the directory is asked too.
        const b = urlKey(a) === urlKey(dir) ? a : await endOf(dir);
        if (!b || urlKey(a) !== urlKey(b)) continue;
        // One page: the address the server ends at stays; the start address always does.
        const startKey = urlKey(startUrl);
        const gone = key === startKey ? urlKey(dir) : urlKey(dir) === startKey || urlKey(a) === urlKey(dir) ? key : urlKey(dir);
        aliases.add(gone);
      }
      return aliases.size ? candidates.filter((c) => {
        const n = normalizeUrl(c, startUrl);
        return !n || !aliases.has(urlKey(n));
      }) : [...candidates];
    },
  };
}

/**
 * When the sitemap reading ends: `budget` from now, and at most a quarter of the time left before the
 * scan's deadline. Past it no file is started and the one being read is cut (what was read stands).
 */
function sitemapsUntil(opts: Pick<CrawlOptions, 'deadline'>, budget: number): number {
  const now = Date.now();
  const left = opts.deadline === undefined ? Infinity : Math.max(0, opts.deadline - now) / 4;
  return now + Math.min(budget, left);
}

/**
 * The site's page addresses from its sitemaps (scoring v3): every listed file is read (up to
 * MAX_CHILD_SITEMAPS roots, each with up to MAX_CHILD_SITEMAPS child files), and the MAX_SITEMAP_URLS
 * kept are the first in section-spread order over all of them, so one big file cannot crowd out the
 * sections listed after it. `keep` filters the addresses first (same site, pages only). The list is
 * reduced after each file, so memory stays at one file plus the kept addresses; the result is the same
 * as ordering the whole list at once.
 */
export async function sitemapUrls(origin: string, robots: Robots, opts: CrawlOptions, keep: (url: string) => string | null): Promise<string[]> {
  const own = (u: string) => {
    if (sitemapHostAllowed(u, origin)) return true;
    offSite.n++;
    return false;
  };
  const offSite = { n: 0 };
  const roots = (robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`]).filter(own).slice(0, MAX_CHILD_SITEMAPS);
  let kept: string[] = [];
  const seen = new Set<string>();
  const add = (urls: string[]) => {
    let grew = false;
    for (const u of urls) {
      const n = keep(u);
      if (!n) continue;
      const key = urlKey(n);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(n);
      grew = true;
    }
    if (grew && kept.length > MAX_SITEMAP_URLS) {
      kept = spreadOrder(kept).slice(0, MAX_SITEMAP_URLS);
      // Dropped addresses may come back from a later file and must compete again.
      seen.clear();
      for (const n of kept) seen.add(urlKey(n));
    }
  };
  const until = sitemapsUntil(opts, siteTiming(opts.timing).sitemapBudgetMs);
  for (const root of roots) {
    if (Date.now() >= until) break;
    const xml = await fetchText(root, opts, origin, until);
    const parsed = parseSitemap(xml);
    noteLastmods(xml, keep, opts.lastmods);
    add(parsed.urls);
    for (const child of parsed.sitemaps.filter(own).slice(0, MAX_CHILD_SITEMAPS)) {
      if (Date.now() >= until) break;
      const cx = await fetchText(child, opts, origin, until);
      noteLastmods(cx, keep, opts.lastmods);
      add(parseSitemap(cx).urls);
    }
  }
  if (offSite.n) opts.onSitemapsSkipped?.(offSite.n);
  return spreadOrder(kept);
}

/**
 * Long scans (wide.ts): every sitemap robots.txt lists (or /sitemap.xml), indexes followed up to
 * MAX_SITEMAP_DEPTH deep, breadth first, at most MAX_WIDE_SITEMAP_FILES files; up to `cap` addresses
 * kept in section-spread order (reduced as files come in, like sitemapUrls).
 */
async function wideSitemapUrls(origin: string, robots: Robots, opts: CrawlOptions, keep: (url: string) => string | null, cap: number): Promise<string[]> {
  let offSite = 0;
  const own = (u: string) => {
    if (sitemapHostAllowed(u, origin)) return true;
    offSite++;
    return false;
  };
  let level = (robots.sitemaps.length ? [...robots.sitemaps] : [`${origin}/sitemap.xml`]).filter(own);
  const read = new Set<string>();
  let kept: string[] = [];
  const seen = new Set<string>();
  const until = sitemapsUntil(opts, siteTiming(opts.timing).wideSitemapBudgetMs);
  for (let depth = 0; depth <= MAX_SITEMAP_DEPTH && level.length && read.size < MAX_WIDE_SITEMAP_FILES; depth++) {
    const next: string[] = [];
    for (const file of level) {
      if (read.size >= MAX_WIDE_SITEMAP_FILES || Date.now() >= until) break;
      if (read.has(file)) continue;
      read.add(file);
      const xml = await fetchText(file, opts, origin, until);
      const parsed = parseSitemap(xml);
      noteLastmods(xml, keep, opts.lastmods);
      next.push(...parsed.sitemaps.filter(own));
      let grew = false;
      for (const u of parsed.urls) {
        const n = keep(u);
        if (!n) continue;
        const key = urlKey(n);
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(n);
        grew = true;
      }
      if (grew && kept.length > cap) {
        kept = spreadOrder(kept).slice(0, cap);
        seen.clear();
        for (const n of kept) seen.add(urlKey(n));
      }
    }
    level = next;
  }
  if (offSite) opts.onSitemapsSkipped?.(offSite);
  return spreadOrder(kept);
}

/** robots.txt for the site: the rule for its own host and its Crawl-delay (given to the pace). */
export async function readRobots(origin: string, opts: Pick<CrawlOptions, 'userAgent' | 'fetchFn' | 'allowUrl' | 'pace' | 'timing'>): Promise<{ robots: Robots; text: string; isAllowed: (url: string) => boolean }> {
  // robots.txt follows redirects to any host (RFC 9309 2.3.1.2), each hop through allowUrl, at most 5.
  const text = await fetchText(`${origin}/robots.txt`, opts);
  const robots = parseRobots(text, 'grnted');
  opts.pace?.setCrawlDelay(new URL(origin).host, robots.crawlDelay);
  const isAllowed = (u: string) => {
    const x = new URL(u);
    return robots.isAllowed(`${x.pathname}${x.search}`);
  };
  return { robots, text, isAllowed };
}

/**
 * A long scan's page list from its candidates (wide.ts): the start address first, then same-site pages
 * robots.txt allows, one per long-scan key, at most PER_SHAPE_MAX per shape, in section-spread order.
 */
export function selectWide(startUrl: string, candidates: readonly string[], max: number, isAllowed: (url: string) => boolean): Selection {
  const filter = wideFilter();
  filter.seen(startUrl);
  const documents = new Set<string>();
  const skipped: Selection['skipped'] = [];
  const actions = actionSkips(skipped, startUrl);
  const pool: string[] = [];
  for (const candidate of candidates) {
    const href = wideNormalize(candidate, startUrl);
    if (!href) continue;
    if (isDocumentUrl(href)) {
      // The action filter comes first, on any host (as in `selectPages`).
      if (isActionLikeUrl(href, startUrl)) actions.add(href);
      else documents.add(href);
      continue;
    }
    if (!sameSite(href, startUrl) || !isLikelyHtml(href)) continue;
    // Never requested (before the shape count: an action is not a page of any shape).
    if (isActionLikeUrl(href, startUrl)) {
      actions.add(href);
      continue;
    }
    const verdict = filter.admit(href);
    if (verdict === 'duplicate') continue;
    if (verdict === 'shape') {
      const record = filter.shapeRecord(href);
      if (record) skipped.push(record);
      continue;
    }
    if (!isAllowed(href)) {
      skipped.push({ url: href, reason: 'Blocked by robots.txt' });
      continue;
    }
    pool.push(href);
  }
  actions.end();
  return {
    pages: [startUrl, ...spreadOrder(pool)].slice(0, Math.max(1, max)),
    documents: [...documents].sort().slice(0, MAX_WIDE_DOCUMENTS),
    skipped: skipped.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
  };
}

/**
 * The links of the page the start address led to (after its redirects: fedex.com's start page is a
 * country chooser, whose links are the country home pages). It waits for the document, then for the
 * load event at most `homeLoadWaitMs` (inside the page), then reads the links: a page whose load event
 * never comes (an asset a slowing site holds back) still gives its links (staging 2026-11-03: waiting
 * for `load` timed out at 45 s and threw them away, so the scan had one page). A slow start page gets
 * the slow-site timeout (`pageTimeoutFor`). `refused`: the home page turned the scanner away (its status
 * and the audit's reason).
 */
async function homepageLinks(start: string, opts: CrawlOptions): Promise<{ links: string[]; refused?: { status: number; reason: string } }> {
  let r = await homepageOnce(start, opts, opts.browser);
  for (let n = 0; n < REFUSED_RETRIES && r.refused && opts.refusedRetry; n++) {
    const other = await opts.refusedRetry(start);
    if (!other) break;
    r = await homepageOnce(start, opts, other);
  }
  return r;
}

/** Longest wait for a discovery page's context to close; past it the close is left behind (it cannot hold the scan). */
const CLOSE_WAIT_MS = 2000;
/** Longest one call into a page that discovery reads on may take: a page that blocks its own thread gives no links. */
export const PAGE_READ_MS = 5000;

/**
 * How long the wait for a page's `load` event is waited for from outside the page. The wait ends by itself
 * inside the page after `wait` ms, so this only guards a thread that no longer answers: the start page keeps
 * its whole wait (links a script adds while the page loads count), a page read on past it (`until`) gets
 * `PAGE_READ_MS`, and what the page has by then is read.
 */
export function loadWaitBound(wait: number, until: number | undefined, left: number): number {
  return Math.min(wait + 1000, until === undefined ? Infinity : PAGE_READ_MS, left);
}

/** `p`, or `fallback` once `ms` have passed (the promise is left behind; it must not reject unhandled). */
function inTime<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); });
  p.catch(() => {});
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * One page opened for its links. With `until` (reading on past the home page, `deepen`) the whole read is
 * inside that time box, end to end (review r1, finding 8; round-2 review, finding 3): one race covers
 * everything from opening the context and the page to closing them, and inside it the load, the wait for
 * `load`, the reading of the links and the close each get what is left. So a browser that does not open a
 * context or a page, a page that blocks its own thread after it loads, or a context that never closes cannot
 * hold the scan: the page then gives no links. What a read left behind opens later is closed as it comes,
 * and never used.
 */
async function homepageOnce(start: string, opts: CrawlOptions, given: BrowserLike, until?: number): Promise<{ links: string[]; refused?: { status: number; reason: string } }> {
  if (until === undefined) return readPage(start, opts, given, undefined, { over: false });
  const state: ReadState = { over: false };
  const result = await inTime<Awaited<ReturnType<typeof readPage>> | null>(readPage(start, opts, given, until, state), until - Date.now(), null);
  if (result) return result;
  state.over = true;
  void state.context?.close().catch(() => {});
  return { links: [] };
}

/** A read's state as its caller sees it: `over` once its time box has ended, and the context it has open. */
interface ReadState {
  over: boolean;
  context?: { close(): Promise<void> };
}

async function readPage(start: string, opts: CrawlOptions, given: BrowserLike, until: number | undefined, state: ReadState): Promise<{ links: string[]; refused?: { status: number; reason: string } }> {
  const t = siteTiming(opts.timing);
  const speed = opts.startSpeed ? await opts.startSpeed.catch(() => undefined) : undefined;
  // `until` (reading on past the home page): the load and the wait for `load` both end there.
  const timeout = Math.max(1, Math.min(pageTimeoutFor(speed, t, opts.deadline, Date.now()), until === undefined ? Infinity : until - Date.now()));
  /** What is left of the time box for one in-page call (the start page's own read keeps the page timeout). */
  const left = () => (until === undefined ? timeout : Math.max(0, until - Date.now()));
  // The home page and its frames, each redirect hop included, are checked with allowUrl before loading.
  const browser = opts.allowUrl ? gatedBrowser(given, opts.allowUrl) : given;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: opts.userAgent });
  // Opened after the read's time box ended: closed, never used.
  if (state.over) {
    void ctx.close().catch(() => {});
    return { links: [] };
  }
  state.context = ctx;
  let nav: NavigationStatus | undefined;
  try {
    const page = await ctx.newPage();
    if (state.over) return { links: [] };
    nav = navigationOf(page);
    // A gate that could not start: the home page is not loaded at all.
    if (gateStopsLoad(page)) return { links: [] };
    const started = Date.now();
    const loaded = await gotoPolitely(opts.pace, start, () => {
      nav?.reset();
      return page.goto(start, { waitUntil: 'domcontentloaded', timeout });
    }, { failedStatus: thrownStatus(nav) });
    if (gateFailure(page)) return { links: [] };
    if (loaded.refused) return loaded.status && isRefusalStatus(loaded.status) ? { links: [], refused: { status: loaded.status, reason: loaded.refused } } : { links: [] };
    const status = loaded.value?.status();
    if (status !== undefined && isRefusalStatus(status)) return { links: [], refused: { status, reason: isChallengeStatus(status) ? CHALLENGE_PAGE : `HTTP ${status}` } };
    // Links a script adds while the page loads count too: the load event, or the wait's end.
    const wait = Math.max(0, Math.min(t.homeLoadWaitMs, timeout - (Date.now() - started)));
    await inTime(page.evaluate((ms: number) => new Promise<void>((resolve) => {
      if (document.readyState === 'complete') return resolve();
      addEventListener('load', () => resolve(), { once: true });
      setTimeout(resolve, ms);
    }), wait).catch(() => {}), loadWaitBound(wait, until, left()), undefined);
    const links = await inTime<string[] | null>(page.evaluate(collectLinks, undefined), until === undefined ? left() : Math.min(PAGE_READ_MS, left()), null);
    // Links read from a page whose gate was lost meanwhile do not stand either; nor does a read that never came back.
    if (!Array.isArray(links) || gateFailure(page)) return { links: [] };
    // The page caps what it collects; a browser that hands back more is cut here too.
    return { links: links.length > MAX_PAGE_LINKS ? links.slice(0, MAX_PAGE_LINKS) : links };
  } catch (err) {
    // An HTTP error the browser would not show (no body): a refusal is the site's answer, as above.
    const status = nav?.status();
    const message = err instanceof Error ? err.message : String(err);
    if (status !== undefined && isResponseCodeFailure(message) && isRefusalStatus(status)) return { links: [], refused: { status, reason: `HTTP ${status}` } };
    return { links: [] };
  } finally {
    // Inside the time box too: a close that does not come back is left behind.
    await inTime(ctx.close().catch(() => {}), Math.min(CLOSE_WAIT_MS, until === undefined ? Infinity : until - Date.now()), undefined);
  }
}

/**
 * Short scans, reading on past the first list (`deepen`): at most `maxLoads` pages are opened for their
 * links, the reading stops after `dryStop` pages in a row that led to no new page, and it takes at most
 * `budgetMs` (and a quarter of the time left before the scan's deadline).
 */
export const DEEPEN = { maxLoads: 8, dryStop: 2, budgetMs: 30_000 } as const;

/** A page that lists the site's pages (an HTML site map): read first, it usually fills the scan in one load. */
const SITE_MAP_PAGE = /(^|[/._-])site-?map([/._-]|$)/i;

/**
 * Scans of up to 50 pages whose first list (the sitemap's pages, or the home page's links) does not fill the
 * scan: the pages found are read for their links, in the order the scan would take them (a site map page
 * first; the start page first when only the sitemap was read), until the list is full, nothing new comes, or
 * the bounds in DEEPEN are met. Before this (red-team 2026-11-10) a site with no XML sitemap whose home page
 * linked to half its pages was scanned at half its size. Long scans do not need it: their crawl reads every
 * audited page's links. Each read is one more load of a page the scan audits later; a site whose first list
 * fills the scan pays nothing. Pages robots.txt blocks are not read. The result depends only on the pages'
 * links, never on timing, unless a bound cuts it.
 */
async function deepen(
  startUrl: string, first: readonly string[], homeRead: boolean, opts: CrawlOptions, isAllowed: (url: string) => boolean,
  onRead: (reads: number) => void, same: { drop(candidates: readonly string[]): Promise<string[]> },
): Promise<string[]> {
  let candidates = await same.drop(first);
  const read = new Set<string>(homeRead ? [urlKey(startUrl)] : []);
  const now = Date.now();
  const until = now + Math.min(DEEPEN.budgetMs, opts.deadline === undefined ? Infinity : Math.max(0, opts.deadline - now) / 4);
  let loads = 0;
  let dry = 0;
  for (;;) {
    const selection = selectPages(startUrl, candidates, opts.maxPages, isAllowed);
    if (selection.pages.length >= opts.maxPages || loads >= DEEPEN.maxLoads || dry >= DEEPEN.dryStop || Date.now() >= until) break;
    const unread = selection.pages.filter((u) => !read.has(urlKey(u)));
    const next = unread.find((u) => SITE_MAP_PAGE.test(new URL(u).pathname)) ?? unread[0];
    if (!next) break;
    read.add(urlKey(next));
    loads++;
    onRead(loads);
    let links: string[] = [];
    try {
      links = (await homepageOnce(next, opts, opts.browser, until)).links;
    } catch {
      // A page that could not be read leads nowhere; the scan audits it as any other page.
    }
    const before = selection.pages.length;
    candidates = await same.drop([...candidates, ...links]);
    dry = selectPages(startUrl, candidates, opts.maxPages, isAllowed).pages.length > before ? 0 : dry + 1;
  }
  return candidates;
}

/**
 * Sitemap first; homepage links if the sitemap has no usable same-site pages; then, on scans of up to
 * 50 pages, the links of the pages found while the list is not full (`deepen`). `isAllowed` is the
 * site's robots.txt rule for its own host (the document inventory uses it for its requests).
 */
/**
 * `refusedStart`: the start page turned the scanner away (a challenge or a refusing 4xx) and the site gave
 * no other page address: the start page is the only page, and its audit is that answer.
 */
export async function discoverPages(start: string, opts: CrawlOptions): Promise<Selection & { isAllowed: (url: string) => boolean; refusedStart?: { status: number; reason: string } }> {
  const startUrl = normalizeUrl(start);
  if (!startUrl) throw new Error(`Invalid URL: ${start}`);
  const origin = new URL(startUrl).origin;
  const emit = safeEmit(opts.onEvent);
  emit?.({ type: 'discover', step: 'start', detail: 'Reading the site’s robots.txt' });
  // robots.txt follows redirects to any host (RFC 9309 2.3.1.2), each hop through allowUrl, at most 5.
  const robotsText = await fetchText(`${origin}/robots.txt`, opts);
  const robots = parseRobots(robotsText, 'grnted');
  opts.pace?.setCrawlDelay(new URL(origin).host, robots.crawlDelay);
  emit?.({
    type: 'discover', step: 'robots', count: robots.sitemaps.length,
    detail: robotsText.trim() ? `robots.txt read: ${plural(robots.sitemaps.length, 'sitemap')} listed` : 'No robots.txt',
  });
  const isAllowed = (u: string) => {
    const x = new URL(u);
    return robots.isAllowed(`${x.pathname}${x.search}`);
  };
  const wide = isWide(opts.maxPages);
  const keepPage = (u: string) => {
    const n = normalizeUrl(u);
    return n !== null && sameSite(n, startUrl) && isLikelyHtml(n) ? n : null;
  };
  const fromSitemap = wide
    ? await wideSitemapUrls(origin, robots, opts, keepPage, Math.max(MAX_SITEMAP_URLS, 3 * opts.maxPages))
    : await sitemapUrls(origin, robots, opts, keepPage);
  emit?.({
    type: 'discover', step: 'sitemap', count: fromSitemap.length,
    detail: fromSitemap.length ? `${plural(fromSitemap.length, 'page address', 'page addresses')} in the sitemaps` : 'No pages in a sitemap: reading the home page links',
  });
  // A long scan never opens the home page here: it is audited first, and the crawl reads its links.
  let refusedStart: { status: number; reason: string } | undefined;
  let candidates = fromSitemap;
  if (!fromSitemap.length && !wide) {
    emit?.({ type: 'discover', step: 'home', detail: 'Loading the homepage' });
    const home = await homepageLinks(startUrl, opts);
    candidates = home.links;
    refusedStart = home.refused;
  }
  // Short scans: a first list that does not fill the scan is not the end of discovery. A monitoring scan
  // that carries pages forward takes its previous scan's pages instead of reading on.
  const same = indexAliases(startUrl, opts, isAllowed);
  if (!wide && opts.known) candidates = await same.drop([...candidates, ...opts.known]);
  else if (!wide && !refusedStart) {
    candidates = await deepen(startUrl, candidates, !fromSitemap.length, opts, isAllowed, (reads) => {
      if (reads === 1) emit?.({ type: 'discover', step: 'home', detail: 'Reading the pages found for links to more pages' });
    }, same);
  }
  emit?.({ type: 'discover', step: 'normalize', count: candidates.length, detail: `${plural(candidates.length, 'candidate address', 'candidate addresses')}` });
  const selection = wide ? selectWide(startUrl, candidates, opts.maxPages, isAllowed) : selectPages(startUrl, candidates, opts.maxPages, isAllowed);
  if (emit) {
    emit({ type: 'discover', step: 'select', count: selection.pages.length, detail: `${plural(selection.pages.length, 'page')} selected` });
    emit({ type: 'discover', step: 'documents', count: selection.documents.length, detail: `${plural(selection.documents.length, 'document')} found` });
    // Copies: a listener that changes the event cannot change the selection.
    emit({ type: 'selected', pages: [...selection.pages], documents: [...selection.documents], skipped: selection.skipped.map((s) => ({ ...s })) });
  }
  // The start page turned us away and nothing else is known: the scan ends from this one load (scan.ts).
  const refused = refusedStart && selection.pages.length === 1 ? { refusedStart } : {};
  return { ...selection, isAllowed, ...refused };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
