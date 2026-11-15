// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Record once, test on the copy (docs/record-replay.md): the snapshot of one scan. The first live answer
// to each GET or HEAD is recorded; every later request for it, in any browser context of the scan, is
// answered from the copy. This module is the copy itself: what may be recorded, under which key, and
// what a later request gets. It never talks to a browser (src/replay/browser.ts does) and holds no
// credentials: Set-Cookie and authentication headers are never stored. One snapshot belongs to one scan
// and is deleted when it ends. Engine core: no Node-only imports.
import { isAnalyticsBeacon } from '../analytics.js';
import { isChallengeStatus, isWafChallenge } from '../challenge.js';

/** Where the snapshot's bytes live: memory (default), a folder (`fileStore`), or the host's own (hosted: R2). */
export interface SnapshotStore {
  put(id: string, bytes: Uint8Array): Promise<void>;
  get(id: string): Promise<Uint8Array | undefined>;
  /** Deletes everything this snapshot stored (the scan ended). */
  clear(): Promise<void>;
}

export const REPLAY_DEFAULTS = {
  /** Most bytes of bodies one snapshot stores; past it new bodies are not stored (those requests stay live). */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /** The in-memory store's own cap (the default store): a scan on a laptop, not a 3,500-page crawl. */
  memoryMaxBytes: 512 * 1024 * 1024,
  /** Largest body stored; a larger one passes through live every time. */
  maxResourceBytes: 20 * 1024 * 1024,
  /**
   * Most answers one snapshot records. Each costs a few hundred bytes of memory for as long as the scan
   * runs (its key and where its record is), whatever the store; past it nothing more is recorded.
   */
  maxEntries: 100_000,
  /** Bodies kept in memory in front of a store that is not memory (least recently used first out). */
  cacheBytes: 64 * 1024 * 1024,
  /** Longest a request waits for the same resource being recorded by another page of the scan. */
  waitMs: 15_000,
  /** Variants of one address (by its `Vary` header) kept; past it the address stays live. */
  maxVariants: 6,
  /** Redirect hops followed inside the copy. */
  maxHops: 10,
  /** Addresses with a made-up parameter value remembered as cache-busting candidates. */
  maxCandidates: 4000,
  /** Page addresses remembered as still asking the site for something; past it no page counts as ready. */
  maxLeaks: 20_000,
} as const;

export interface SnapshotOptions {
  store?: SnapshotStore;
  maxBytes?: number;
  maxResourceBytes?: number;
  maxEntries?: number;
  cacheBytes?: number;
  waitMs?: number;
  now?: () => number;
}

/** A request as the browser reports it: header names in any case. */
export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Playwright's resource type ('document', 'stylesheet', ...), lower case. */
  resourceType?: string;
  /** A navigation (the page, a frame): never an analytics beacon. */
  navigation?: boolean;
}

/** An answer from the copy. */
export interface ReplayHit {
  status: number;
  /** Header names in lower case; without the ones that describe the wire (length, encoding, connection). */
  headers: Record<string, string>;
  body: Uint8Array;
  /** The address a redirect answer points to (absolute). */
  location?: string;
}

export interface ReplayStats {
  /** Requests answered from the copy, and of those, the documents (pages and frames). */
  replayed: number;
  replayedDocuments: number;
  /** Answers recorded, and their stored bytes (each distinct body once). */
  recorded: number;
  storedBytes: number;
  /** Requests that could have been recorded or replayed and went to the site instead. */
  live: number;
  /**
   * Every request the pages sent to the network: what the copy did not answer. More than `live`: it
   * also counts what is never kept (audio and video, anything but GET and HEAD, requests with
   * credentials) and the later addresses of a redirect the browser followed. Not a request the scan
   * itself stopped before it left the browser (a guard, the analytics blocking).
   */
  sent: number;
  /** Requests that waited for the same resource being recorded elsewhere in the scan, and the time they waited. */
  waited: number;
  waitedMs: number;
  /** Addresses left live for good: answers that changed shape, too many variants, too large, or no room left. */
  volatile: number;
  tooLarge: number;
  full: number;
  /** Cache-busting values recognised (the same body under a changing value), and requests answered that way. */
  busters: number;
  busted: number;
  /** Pages whose load from the copy still asked the site for something that cannot be kept (they take pace turns). */
  leaky: number;
}

/**
 * The assumptions a snapshot is recorded under, kept with it (`Snapshot.manifest`): one anonymous visitor
 * per scan, so the first answer to an address is THE answer (cookies and `Vary: *` are not part of the
 * key); only GET and HEAD; no credentials stored.
 */
export const SNAPSHOT_ASSUMPTIONS = {
  version: 1,
  visitor: 'one anonymous visitor per scan: the first answer to an address is the answer for the whole scan',
  methods: ['GET', 'HEAD'],
  key: 'method + address without its fragment + Range, plus what kind of request it was (a page, a stylesheet, a script\'s fetch ...), its Accept header, the headers a script added to it, and the request headers the answer says it varies on (never Cookie or Authorization)',
  neverStored: ['set-cookie', 'set-cookie2', 'authorization', 'proxy-authorization', 'proxy-authenticate', 'www-authenticate'],
} as const;

interface Meta {
  /** The stored record's id (`r/<n>`). */
  id: string;
  status: number;
  /** A redirect's target, absolute. */
  location?: string;
  hash?: string;
  size: number;
  /** The request header values this answer was recorded under, for the names its `Vary` lists. */
  vary?: Record<string, string>;
  /** The whole body of the address (a 200, or a 206 that covers all of it) from a server that takes ranges. */
  sliceable?: boolean;
}

interface StoredRecord {
  v: 1;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  hash?: string;
  size: number;
}

/** Response headers never stored (credentials), and the ones that describe the wire, not the resource. */
const NEVER_STORED = new Set<string>(SNAPSHOT_ASSUMPTIONS.neverStored);
const WIRE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
/** `Vary` names that are not part of the key: the anonymous visitor, and what the browser always sends alike. */
const VARY_IGNORED = new Set(['*', 'cookie', 'authorization', 'accept-encoding']);
/** Request headers that make a request live, never recorded or replayed. */
const LIVE_REQUEST_HEADERS = ['authorization', 'proxy-authorization', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range'];
/**
 * Request kinds that are always live. Media (what an audio or video element loads) too: the browser
 * streams it, keeping the request open while the element plays or buffers, and a copy handed over whole
 * changes when the page counts as loaded (measured on the ACT audio and video cases: a test that found
 * the page "still loading" live ran on the copy, and other pages waited for recordings that never ended).
 */
const LIVE_TYPES = new Set(['websocket', 'eventsource', 'ping', 'cspviolationreport', 'preflight', 'media']);

const lower = (h: Record<string, string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
};

/**
 * Request headers the browser sets by itself. Any other header was put there by a script (`X-Requested-With`,
 * `HX-Request`, an API's own): a server may answer the same address differently for it without saying
 * so in `Vary`, so the set of them is part of the key.
 */
const BROWSER_SET = /^(?:sec-|accept$|accept-|user-agent$|referer$|origin$|cookie$|cache-control$|pragma$|upgrade-insecure-requests$|dnt$|range$|if-|connection$|host$|priority$|purpose$|content-|te$|x-grnted-replay$)/;
/** The parts of every key beside the address: the request's kind, its Accept, and the headers a script added. */
const ALWAYS_KEYED = [':type', 'accept', ':custom'];

/** A short fingerprint (FNV-1a, twice): the added headers' values are never stored themselves. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5) + (b << 7);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** The request's headers in lower case, with the two the key adds: `:type` (its kind) and `:custom` (see `BROWSER_SET`). */
function keyed(req: ReplayRequest): Record<string, string> {
  const h = lower(req.headers);
  const added = Object.keys(h).filter((n) => !BROWSER_SET.test(n)).sort().map((n) => `${n}=${h[n]}`).join('\n');
  h[':type'] = (req.resourceType ?? '').toLowerCase();
  h[':custom'] = added ? fingerprint(added) : '';
  return h;
}

const hex = (bytes: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += b.toString(16).padStart(2, '0');
  return s;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Response headers as they are kept: without credentials and without the wire's own. */
function kept(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, v] of Object.entries(headers)) if (!NEVER_STORED.has(n) && !WIRE_HEADERS.has(n)) out[n] = v;
  return out;
}

/** A value a script made up for one request: a timestamp, Math.random(), a random token. */
const MADE_UP = /^(?:\d{10,}|0?\.\d{6,}|(?=[A-Za-z_-]*\d)(?=\d*[A-Za-z_-])[A-Za-z0-9_-]{12,})$/;

/** The in-memory store (the default): the snapshot lives and dies with the scan's process. */
export function memoryStore(): SnapshotStore {
  const map = new Map<string, Uint8Array>();
  return {
    async put(id, bytes) { map.set(id, bytes); },
    async get(id) { return map.get(id); },
    async clear() { map.clear(); },
  };
}

/** The address without its fragment, or undefined for one a snapshot never holds (not http(s), or with a password in it). */
export function replayUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password) return undefined;
  u.hash = '';
  return u.href;
}

/** One `bytes=a-b` range of a body `size` long, or undefined for anything else (several ranges, a bad one). */
export function byteRange(header: string, size: number): { start: number; end: number } | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  let start: number;
  let end: number;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!n) return undefined;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : undefined;
}

export interface Snapshot {
  /** A request the snapshot may record or answer: GET or HEAD of an http(s) address, with nothing that makes it one visitor's own. */
  eligible(req: ReplayRequest): boolean;
  /**
   * The copy's answer, 'live' when there is none, or 'lead' when there is none and this request should
   * go to the site and be recorded (`lead` was taken for it: the caller must end it, `Lease.done`).
   * With `wait`, a request for a resource another page is recording waits for it first (at most `waitMs`).
   */
  answer(req: ReplayRequest, opts?: { lead?: boolean }): Promise<ReplayHit | { live: true; lease?: Lease }>;
  /** Without waiting or reading a body: the status the copy would answer with, and a redirect's target. */
  peek(req: ReplayRequest): { status: number; location?: string } | undefined;
  /**
   * Records a live answer (the first one for its key stands). `body` is read only when the answer can
   * be stored; undefined from it means the body could not be read (nothing is recorded).
   */
  record(req: ReplayRequest, res: { status: number; headers: Record<string, string>; loopback?: boolean }, body: () => Promise<Uint8Array | undefined>): Promise<void>;
  /**
   * A document of this origin was recorded from a loopback address (a site on this machine: a test
   * fixture). Chromium gives a document answered from the copy no address at all, and then refuses its
   * live requests to loopback hosts of other origins (Local Network Access), which the live document may
   * make freely: the browser layer grants such an origin that permission, and no other.
   */
  local(origin: string): boolean;
  /** The live request for `req` ended without an answer to record (it failed, or its page closed). */
  failed(req: ReplayRequest): void;
  /**
   * The whole load of this page address (redirects included) would be answered from the copy, and no
   * earlier load of it from the copy asked the site for something that cannot be kept (`leak`).
   */
  ready(url: string, redirects: boolean): boolean;
  /**
   * A page that was loaded from the copy still asked the site for something that is not kept (what an
   * audio or video element loads, a file the site refuses, anything but GET and HEAD). Its later loads
   * are the site's business again: the page is no longer `ready`, so each takes its turn from the pace
   * controller (the Crawl-delay gap, a pause after a refusal) like any live load.
   */
  leak(pageUrl: string): void;
  /**
   * A request went to the network instead of being answered from the copy (`ReplayStats.sent`); -1 takes
   * one back that the scan itself then stopped before it left the browser.
   */
  sent(by?: 1 | -1): void;
  stats(): ReplayStats;
  manifest(): typeof SNAPSHOT_ASSUMPTIONS & { stats: ReplayStats };
  /** The scan ended: waiting requests go live, and the store is cleared unless `keep`. */
  close(keep?: boolean): Promise<void>;
}

/** A request recording a resource: the others wait for `done` (called once it is recorded, or cannot be). */
export interface Lease {
  done(): void;
}

export function createSnapshot(opts: SnapshotOptions = {}): Snapshot {
  const now = opts.now ?? Date.now;
  const ownStore = !opts.store;
  const store = opts.store ?? memoryStore();
  const maxBytes = opts.maxBytes ?? (ownStore ? REPLAY_DEFAULTS.memoryMaxBytes : REPLAY_DEFAULTS.maxBytes);
  const maxResourceBytes = opts.maxResourceBytes ?? REPLAY_DEFAULTS.maxResourceBytes;
  const maxEntries = opts.maxEntries ?? REPLAY_DEFAULTS.maxEntries;
  const cacheBytes = ownStore ? 0 : (opts.cacheBytes ?? REPLAY_DEFAULTS.cacheBytes);
  const waitMs = opts.waitMs ?? REPLAY_DEFAULTS.waitMs;

  /** Answers by key (`METHOD address[ range]`), one per variant. */
  const index = new Map<string, Meta[]>();
  /** Keys never recorded or replayed again, and why. */
  const off = new Map<string, 'volatile' | 'tooLarge'>();
  /** Bodies stored, by hash (each once). */
  const bodies = new Map<string, number>();
  /** Resources being recorded now: the requests waiting for each. */
  const flights = new Map<string, Set<() => void>>();
  const takeOff = (key: string): void => {
    if (!flights.has(key)) flights.set(key, new Set());
  };
  /** Recently used bodies and records in front of a store that is not memory. */
  const cache = new Map<string, Uint8Array>();
  let cached = 0;
  /** A cache-busting parameter: `METHOD address-without-it\nname` to the answer every value gets. */
  const busters = new Map<string, Meta>();
  /** Candidates: the first value seen for a made-up parameter, with its answer. */
  const busterSeen = new Map<string, { value: string; meta: Meta }>();
  /** Origins a document was recorded from at a loopback address (`Snapshot.local`). */
  const localOrigins = new Set<string>();
  /** Page addresses that still ask the site for something when loaded from the copy (`Snapshot.leak`). */
  const leaks = new Set<string>();
  let seq = 0;
  let closed = false;
  const s: ReplayStats = { replayed: 0, replayedDocuments: 0, recorded: 0, storedBytes: 0, live: 0, sent: 0, waited: 0, waitedMs: 0, volatile: 0, tooLarge: 0, full: 0, busters: 0, busted: 0, leaky: 0 };

  const keyOf = (req: ReplayRequest, url: string, h: Record<string, string>): string => `${req.method.toUpperCase()} ${url}${h.range ? ` ${h.range.trim()}` : ''}`;

  const eligibleWith = (req: ReplayRequest, h: Record<string, string>): string | undefined => {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return undefined;
    const url = replayUrl(req.url);
    if (!url) return undefined;
    if (req.resourceType && LIVE_TYPES.has(req.resourceType.toLowerCase())) return undefined;
    if (LIVE_REQUEST_HEADERS.some((n) => h[n] !== undefined)) return undefined;
    if (/\btext\/event-stream\b/i.test(h.accept ?? '') || h.upgrade !== undefined) return undefined;
    // A beacon never reaches the site at all (analytics.ts): nothing of it is kept either.
    if (isAnalyticsBeacon(method, url, req.navigation === true)) return undefined;
    return url;
  };

  const matches = (m: Meta, h: Record<string, string>): boolean => !m.vary || Object.entries(m.vary).every(([n, v]) => (h[n] ?? '') === v);

  /** The parameters of `url` whose value looks made up, each with the address without it. */
  const madeUp = (method: string, url: string): { key: string; value: string }[] => {
    const q = url.indexOf('?');
    if (q < 0) return [];
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return [];
    }
    const params = [...u.searchParams];
    if (!params.length || params.length > 12) return [];
    const out: { key: string; value: string }[] = [];
    params.forEach(([name, value], i) => {
      if (!MADE_UP.test(value)) return;
      const rest = params.filter((_, j) => j !== i).map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&');
      out.push({ key: `${method} ${u.origin}${u.pathname}?${rest}\n${name}`, value });
    });
    return out;
  };

  const find = (req: ReplayRequest, url: string, h: Record<string, string>): { meta: Meta; range?: { start: number; end: number }; busted?: true } | undefined => {
    const key = keyOf(req, url, h);
    if (off.has(key)) return undefined;
    const exact = index.get(key)?.find((m) => matches(m, h));
    if (exact) return { meta: exact };
    const method = req.method.toUpperCase();
    if (h.range) {
      // A part of a body the copy holds whole, from a server that takes ranges.
      const whole = index.get(`${method} ${url}`)?.find((m) => m.sliceable && matches(m, h)) ?? index.get(`${method} ${url} bytes=0-`)?.find((m) => m.sliceable && matches(m, h));
      const range = whole ? byteRange(h.range, whole.size) : undefined;
      return whole && range ? { meta: whole, range } : undefined;
    }
    for (const c of madeUp(method, url)) {
      const b = busters.get(c.key);
      if (b && matches(b, h)) return { meta: b, busted: true };
    }
    return undefined;
  };

  const remember = (id: string, bytes: Uint8Array): void => {
    if (!cacheBytes || bytes.length > cacheBytes / 4) return;
    if (cache.has(id)) return;
    cache.set(id, bytes);
    cached += bytes.length;
    while (cached > cacheBytes) {
      const first = cache.keys().next().value!;
      cached -= cache.get(first)!.length;
      cache.delete(first);
    }
  };
  const read = async (id: string): Promise<Uint8Array | undefined> => {
    const hit = cache.get(id);
    if (hit) {
      // Most recently used last.
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const bytes = await store.get(id);
    if (bytes) remember(id, bytes);
    return bytes;
  };

  const land = (key: string): void => {
    const waiting = flights.get(key);
    if (!waiting) return;
    flights.delete(key);
    for (const wake of waiting) wake();
  };
  /**
   * Waits for the resource being recorded under `key` (at most `waitMs`); false when nothing is. A
   * recording that did not end in that time is given up on (its waiters, and every later request, go on).
   */
  const landed = async (key: string): Promise<boolean> => {
    const waiting = flights.get(key);
    if (!waiting || closed) return false;
    const t0 = now();
    s.waited++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      waiting.add(resolve);
      timer = setTimeout(() => { land(key); resolve(); }, waitMs);
    }).finally(() => clearTimeout(timer));
    s.waitedMs += now() - t0;
    return true;
  };

  const hitOf = async (found: { meta: Meta; range?: { start: number; end: number }; busted?: true }, req: ReplayRequest, counted = true): Promise<ReplayHit | undefined> => {
    const raw = await read(found.meta.id);
    if (!raw) return undefined;
    let rec: StoredRecord;
    try {
      rec = JSON.parse(decoder.decode(raw)) as StoredRecord;
    } catch {
      return undefined;
    }
    let body: Uint8Array = new Uint8Array(0);
    if (rec.hash && req.method.toUpperCase() !== 'HEAD') {
      const stored = await read(`b/${rec.hash}`);
      if (!stored) return undefined;
      body = stored;
    }
    const headers = { ...rec.headers };
    let status = rec.status;
    if (found.range) {
      const { start, end } = found.range;
      headers['content-range'] = `bytes ${start}-${end}/${found.meta.size}`;
      body = body.subarray(start, end + 1);
      status = 206;
    }
    if (counted) {
      s.replayed++;
      if (found.busted) s.busted++;
      if (req.resourceType === 'document' || req.navigation) s.replayedDocuments++;
    }
    return { status, headers, body, ...(found.meta.location ? { location: found.meta.location } : {}) };
  };

  const turnOff = (key: string, why: 'volatile' | 'tooLarge'): void => {
    if (off.has(key)) return;
    off.set(key, why);
    index.delete(key);
    s[why]++;
  };

  return {
    eligible(req) {
      return !closed && eligibleWith(req, keyed(req)) !== undefined;
    },
    async answer(req, o = {}) {
      const h = keyed(req);
      const url = closed ? undefined : eligibleWith(req, h);
      if (!url) return { live: true };
      const key = keyOf(req, url, h);
      for (let round = 0; round < 2; round++) {
        const found = find(req, url, h);
        if (found) {
          // A redirect is never answered where a request is led (a route): it is handed to the
          // browser-level session, which asks again and counts it when it answers (or it goes to the site).
          const hit = await hitOf(found, req, !(o.lead && found.meta.location));
          if (hit) return hit;
          // The store no longer has it (it failed, or was cleared): live from now on.
          turnOff(key, 'volatile');
          break;
        }
        // A request for a resource being recorded waits for it. When that answer is not one to keep (a
        // refusal, an error), nothing is found afterwards and this request asks the site itself: the site
        // judges each request on its own, as without replay (a refusal is never passed on).
        if (off.has(key) || round || !(await landed(key))) break;
      }
      s.live++;
      // A part of a body (a Range request) is never waited for: whoever asks for it asks the site.
      if (!o.lead || h.range || off.has(key) || closed || flights.has(key)) return { live: true };
      takeOff(key);
      let ended = false;
      return { live: true, lease: { done: () => { if (!ended) { ended = true; land(key); } } } };
    },
    peek(req) {
      const h = keyed(req);
      const url = closed ? undefined : eligibleWith(req, h);
      const found = url ? find(req, url, h) : undefined;
      return found ? { status: found.range ? 206 : found.meta.status, ...(found.meta.location ? { location: found.meta.location } : {}) } : undefined;
    },
    async record(req, res, body) {
      const h = keyed(req);
      const url = closed ? undefined : eligibleWith(req, h);
      if (!url) return;
      const key = keyOf(req, url, h);
      try {
        if (res.loopback && req.resourceType === 'document') localOrigins.add(new URL(url).origin);
        if (off.has(key)) return;
        const headers = lower(res.headers);
        const status = res.status;
        // Only answers that stay true for the scan: the resource, a redirect to it, or "not there". A
        // refusal, a challenge or a server error is the site's answer to that one request.
        const stable = (status >= 200 && status < 400 && status !== 304 && !isChallengeStatus(status)) || status === 404 || status === 410;
        if (/\btext\/event-stream\b/i.test(headers['content-type'] ?? '')) return;
        if (!stable || isWafChallenge(headers)) return;
        const redirect = status >= 300 && status < 400;
        let location: string | undefined;
        if (redirect) {
          if (!headers.location) return;
          try {
            location = replayUrl(new URL(headers.location, url).href);
          } catch {
            location = undefined;
          }
          if (!location) return;
        }
        const known = index.get(key)?.find((m) => matches(m, h));
        if (known) {
          // A second live answer for the same key: the first stands, unless the address changed shape
          // (a redirect that became a page once a cookie was set): then it is one visitor's own, and stays live.
          if (known.status !== status || known.location !== location) turnOff(key, 'volatile');
          return;
        }
        if (s.recorded >= maxEntries) {
          s.full++;
          return;
        }
        const length = Number(headers['content-length']);
        if (Number.isFinite(length) && length > maxResourceBytes) return turnOff(key, 'tooLarge');
        let bytes: Uint8Array | undefined;
        if (!redirect && req.method.toUpperCase() !== 'HEAD' && status !== 204) {
          bytes = await body();
          if (!bytes || closed) return;
          if (bytes.length > maxResourceBytes) return turnOff(key, 'tooLarge');
        }
        // Raced: another page recorded it while the body was read.
        if (index.get(key)?.some((m) => matches(m, h)) || off.has(key)) return;
        let hash: string | undefined;
        if (bytes?.length) {
          hash = hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
          if (!bodies.has(hash)) {
            if (s.storedBytes + bytes.length > maxBytes) {
              s.full++;
              return;
            }
            await store.put(`b/${hash}`, bytes);
            bodies.set(hash, bytes.length);
            s.storedBytes += bytes.length;
            remember(`b/${hash}`, bytes);
          }
        }
        // The key's own part of the request: the headers the answer says it varies on, and the Origin of
        // a cross-origin answer made for one origin.
        const names = new Set([...ALWAYS_KEYED, ...(headers.vary ?? '').split(',').map((n) => n.trim().toLowerCase()).filter((n) => n && !VARY_IGNORED.has(n))]);
        const allowed = headers['access-control-allow-origin'];
        if (allowed && allowed !== '*') names.add('origin');
        const vary = Object.fromEntries([...names].sort().map((n) => [n, h[n] ?? '']));
        const size = bytes?.length ?? 0;
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] ?? '');
        const whole = status === 200 ? !h.range && /\bbytes\b/i.test(headers['accept-ranges'] ?? '') : status === 206 && !!range && Number(range[1]) === 0 && Number(range[2]) + 1 === Number(range[3]) && size === Number(range[3]);
        const meta: Meta = { id: `r/${++seq}`, status, size, ...(location ? { location } : {}), ...(hash ? { hash } : {}), vary, ...(whole && size ? { sliceable: true } : {}) };
        const rec: StoredRecord = { v: 1, url, method: req.method.toUpperCase(), status, headers: kept(headers), size, ...(hash ? { hash } : {}) };
        const encoded = encoder.encode(JSON.stringify(rec));
        await store.put(meta.id, encoded);
        remember(meta.id, encoded);
        const list = index.get(key) ?? [];
        if (list.length >= REPLAY_DEFAULTS.maxVariants) return turnOff(key, 'volatile');
        list.push(meta);
        index.set(key, list);
        s.recorded++;
        // The browser follows a redirect by itself: its target is being fetched now, by the same
        // request. Requests that follow this recorded redirect wait for that answer.
        if (location) {
          const next = `${req.method.toUpperCase()} ${location}`;
          if (!index.has(next) && !off.has(next)) takeOff(next);
        }
        // The same body under another made-up value of one parameter: that parameter only busts caches.
        if (!redirect && !h.range) {
          for (const c of madeUp(req.method.toUpperCase(), url)) {
            const seen = busterSeen.get(c.key);
            if (!seen) {
              busterSeen.set(c.key, { value: c.value, meta });
              // Bounded: the oldest candidate goes (it is only a chance to recognise a parameter later).
              if (busterSeen.size > REPLAY_DEFAULTS.maxCandidates) busterSeen.delete(busterSeen.keys().next().value!);
            }
            else if (seen.value !== c.value && !busters.has(c.key) && seen.meta.status === status && seen.meta.hash === hash && JSON.stringify(seen.meta.vary) === JSON.stringify(vary)) {
              busters.set(c.key, seen.meta);
              s.busters++;
            }
          }
        }
      } catch {
        // A store that fails records nothing: the request stays live.
      } finally {
        land(key);
      }
    },
    local(origin) {
      return localOrigins.has(origin);
    },
    failed(req) {
      const h = keyed(req);
      const url = eligibleWith(req, h);
      if (url) land(keyOf(req, url, h));
    },
    leak(pageUrl) {
      const at = replayUrl(pageUrl);
      if (!at || leaks.has(at)) return;
      s.leaky++;
      // Past the bound nothing more is remembered, and from then on no page counts as ready (`ready`).
      if (leaks.size < REPLAY_DEFAULTS.maxLeaks) leaks.add(at);
    },
    ready(url, redirects) {
      if (closed || s.leaky > leaks.size) return false;
      let at = replayUrl(url);
      for (let hop = 0; at && hop <= REPLAY_DEFAULTS.maxHops; hop++) {
        if (leaks.has(at)) return false;
        const key = `GET ${at}`;
        const list = off.has(key) ? undefined : index.get(key);
        // The page's own answer (a navigation), and only when there is one (the scan's own loads are alike).
        const docs = list?.filter((x) => x.vary?.[':type'] === 'document') ?? [];
        const m = docs.length === 1 ? docs[0]! : undefined;
        if (!m) return false;
        if (!m.location) return m.status < 400;
        if (!redirects) return false;
        at = m.location;
      }
      return false;
    },
    sent(by = 1) {
      s.sent = Math.max(0, s.sent + by);
    },
    stats() {
      return { ...s };
    },
    manifest() {
      return { ...SNAPSHOT_ASSUMPTIONS, stats: { ...s } };
    },
    async close(keep = false) {
      if (closed) return;
      closed = true;
      for (const key of [...flights.keys()]) land(key);
      index.clear();
      cache.clear();
      cached = 0;
      if (!keep) await store.clear().catch(() => {});
      // A kept snapshot says under which assumptions it was recorded (never a key or a request header).
      else await store.put('index', encoder.encode(JSON.stringify({ ...SNAPSHOT_ASSUMPTIONS, stats: { ...s } }))).catch(() => {});
    },
  };
}
