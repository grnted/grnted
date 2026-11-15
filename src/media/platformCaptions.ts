// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Do the site's YouTube and Vimeo videos have captions? (plan C14, 2026-11-05). Granted never tests the
// platform's player: it reads the platform's own list of caption tracks for each video id.
//   YouTube: Data API v3 `captions.list` (part=snippet), an API key only; 50 quota units a call.
//            trackKind 'standard' = made by a person, 'asr' = automatic, 'forced' = forced subtitles.
//   Vimeo:   `GET /videos/{id}/texttracks` with a token (an unauthenticated app token reads public videos).
// Only the video id goes to the platform (and our key or token): nothing about the customer or the scan.
// Bounded: ids and API calls per scan, calls at once, time per call, retries (429/5xx), the answer's
// bytes and items, and an overall deadline. Never throws: a video it could not check says why.
// Engine core: works with any fetch, no Node-only imports.
import type { MediaPlayer, PlatformCaptions, PlatformUncheckedReason } from '../types.js';

export const YOUTUBE_CAPTIONS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/captions';
export const VIMEO_API_ORIGIN = 'https://api.vimeo.com';

export const PLATFORM_CAPTION_LIMITS = {
  /**
   * API calls per scan (cache hits are free). 50 YouTube calls are 2,500 of the default 10,000 quota
   * units a day: a quarter, so one scan never spends the day, and a 25-page scan rarely has more than
   * a handful of distinct videos. A larger site gets 50 more each rescan, as the cache fills.
   */
  lookups: 50,
  /** Distinct videos considered per scan (cache reads); the rest say "not checked: too many videos". */
  videos: 500,
  /** Calls at once. */
  concurrency: 4,
  /** One call's time box. */
  timeoutMs: 8_000,
  /** Retries of a call answered 429 or 5xx (or a network error). */
  retries: 2,
  /** Longest wait before a retry (Retry-After is honoured up to this). */
  maxRetryWaitMs: 5_000,
  /** The answer's body, read at most. */
  maxBytes: 256 * 1024,
  /** Tracks read from one answer. */
  maxTracks: 200,
  /** Languages kept per video. */
  maxLanguages: 10,
  /** The whole lookup, at most (also never past the caller's `by`). */
  totalMs: 60_000,
} as const;

/** YouTube quota units per `captions.list` call. */
export const YOUTUBE_CAPTIONS_UNITS = 50;

/** Cache lifetimes: a captioned video for 7 days; any other answer 1 day, so a fix shows the next day. */
export const PLATFORM_CAPTION_TTL = { captions: 7 * 24 * 3600, other: 24 * 3600 } as const;

/** The cache key's version: a change to how answers are read starts fresh entries. */
const CACHE_VERSION = 'captions@1';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_ID = /^\d{1,12}$/;

/** Answers kept between scans (the hosted checker: a Durable Object). Never stores a key or token. */
export interface CaptionCache {
  get(key: string): Promise<unknown>;
  put(key: string, value: PlatformCaptions, ttlSeconds: number): Promise<void>;
}

/** The day's YouTube quota, shared by every scan. `take` false: the day's units are spent. */
export interface CaptionQuota {
  take(units: number): Promise<boolean>;
  /** YouTube itself said the quota is spent: nothing more today. */
  exhausted?(): Promise<void>;
}

export interface PlatformCaptionOptions {
  /** YouTube Data API key. Never stored, logged or reported. */
  youtubeApiKey?: string;
  /** Vimeo API token (an unauthenticated app token). Never stored, logged or reported. */
  vimeoToken?: string;
  cache?: CaptionCache;
  quota?: CaptionQuota;
  /** false: cached answers only, no API call (the free homepage check). Default true. */
  lookups?: boolean;
  fetchFn?: typeof fetch;
  userAgent?: string;
  /** Hosted safety: each API address must pass. */
  allowUrl?: (url: string) => Promise<boolean>;
  /** Stop by then (epoch ms): the videos left say "not checked in time". */
  by?: number;
  /** Tests: the limits and the clock. */
  limits?: Partial<Record<keyof typeof PLATFORM_CAPTION_LIMITS, number>>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PlatformVideo {
  player: MediaPlayer;
  videoId: string;
}

/** The key of a video in the cache and in the result map. */
export const platformVideoKey = (v: PlatformVideo) => `${v.player}:${v.videoId}`;

/** True when the platform's captions can be looked up for this video. */
export function lookupable(v: { player?: MediaPlayer; videoId?: string }): v is PlatformVideo {
  return (v.player === 'youtube' && !!v.videoId && YOUTUBE_ID.test(v.videoId))
    || (v.player === 'vimeo' && !!v.videoId && VIMEO_ID.test(v.videoId));
}

const unchecked = (reason: PlatformUncheckedReason, status?: number): PlatformCaptions => ({ status: 'unchecked', reason, ...(status ? { httpStatus: status } : {}) });

const STATUSES = new Set(['captions', 'auto-only', 'none', 'unchecked']);
const REASONS = new Set<PlatformUncheckedReason>(['not-found', 'api-error', 'daily-limit', 'scan-limit', 'time-limit', 'no-token', 'free-check']);

/** A cached value read back: only a well-formed answer counts, anything else is a miss. */
export function cachedCaptions(v: unknown): PlatformCaptions | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.status !== 'string' || !STATUSES.has(o.status)) return undefined;
  const out: PlatformCaptions = { status: o.status as PlatformCaptions['status'] };
  if (Array.isArray(o.languages)) {
    const langs = o.languages.filter((l): l is string => typeof l === 'string' && l.length > 0 && l.length <= 35).slice(0, PLATFORM_CAPTION_LIMITS.maxLanguages);
    if (langs.length) out.languages = langs;
  }
  if (out.status === 'unchecked') {
    // Only "not found" is ever cached among the unchecked answers.
    if (o.reason !== 'not-found') return undefined;
    out.reason = 'not-found';
  }
  return out;
}

/** Reads at most `max` bytes of the body as JSON; undefined when it is longer or not JSON. */
async function jsonCapped(res: Response, max: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      parts.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

const lang = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 35) : '');
const uniq = (xs: string[], max: number) => [...new Set(xs.filter(Boolean))].slice(0, max);

/** YouTube's caption tracks → the status. Any track made by a person: captions; only automatic: auto-only. */
export function youtubeStatus(body: unknown, maxTracks: number = PLATFORM_CAPTION_LIMITS.maxTracks): PlatformCaptions | undefined {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return undefined;
  const standard: string[] = [];
  const asr: string[] = [];
  for (const item of items.slice(0, maxTracks)) {
    const s = (item as { snippet?: { trackKind?: unknown; language?: unknown } } | null)?.snippet;
    const kind = typeof s?.trackKind === 'string' ? s.trackKind.toLowerCase() : '';
    if (kind === 'standard') standard.push(lang(s?.language));
    else if (kind === 'asr') asr.push(lang(s?.language));
    // 'forced' tracks subtitle only parts of a video: never captions on their own.
  }
  const max = PLATFORM_CAPTION_LIMITS.maxLanguages;
  if (standard.length) return withLanguages('captions', uniq(standard, max));
  if (asr.length) return withLanguages('auto-only', uniq(asr, max));
  return { status: 'none' };
}

/** Vimeo's text tracks → the status. Only active captions or subtitles count; "-x-autogen" ones are automatic. */
export function vimeoStatus(body: unknown, maxTracks: number = PLATFORM_CAPTION_LIMITS.maxTracks): PlatformCaptions | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const person: string[] = [];
  const auto: string[] = [];
  for (const t of data.slice(0, maxTracks)) {
    const track = t as { type?: unknown; language?: unknown; active?: unknown; name?: unknown } | null;
    if (!track || track.active === false) continue;
    if (track.type !== 'captions' && track.type !== 'subtitles') continue;
    const l = lang(track.language);
    const automatic = /-x-autogen$/i.test(l) || (typeof track.name === 'string' && /auto-?generated/i.test(track.name.slice(0, 200)));
    (automatic ? auto : person).push(l.replace(/-x-autogen$/i, ''));
  }
  const max = PLATFORM_CAPTION_LIMITS.maxLanguages;
  if (person.length) return withLanguages('captions', uniq(person, max));
  if (auto.length) return withLanguages('auto-only', uniq(auto, max));
  return { status: 'none' };
}

function withLanguages(status: 'captions' | 'auto-only', languages: string[]): PlatformCaptions {
  return languages.length ? { status, languages } : { status };
}

/** The error reasons in a Google API error body (error.errors[].reason). */
function googleReasons(body: unknown): string[] {
  const errors = (body as { error?: { errors?: unknown } } | null)?.error?.errors;
  return Array.isArray(errors) ? errors.slice(0, 10).map((e) => String((e as { reason?: unknown } | null)?.reason ?? '')).filter(Boolean) : [];
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const id = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(id);
    resolve();
  }, { once: true });
});

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
function retryAfterMs(res: Response, now: number): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

type CallResult = { kind: 'ok'; status: PlatformCaptions } | { kind: 'done'; status: PlatformCaptions } | { kind: 'quota' };

/**
 * The captions status of each video, keyed by `platformVideoKey`. Every lookupable video gets an
 * answer: one the platform gave (cached or fresh), or `unchecked` with the reason. Never throws.
 */
export async function platformCaptions(videos: readonly PlatformVideo[], o: PlatformCaptionOptions): Promise<Map<string, PlatformCaptions>> {
  const L = { ...PLATFORM_CAPTION_LIMITS, ...o.limits };
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const out = new Map<string, PlatformCaptions>();
  const seen = new Set<string>();
  const unique: PlatformVideo[] = [];
  for (const v of videos) {
    if (!lookupable(v)) continue;
    const k = platformVideoKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push({ player: v.player, videoId: v.videoId });
  }
  if (!unique.length) return out;
  const fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
  const deadline = Math.min(o.by ?? Infinity, now() + L.totalMs);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.max(0, deadline - now()));
  const cacheKey = (v: PlatformVideo) => `${CACHE_VERSION}:${platformVideoKey(v)}`;
  let lookupsLeft = L.lookups;
  let youtubeSpent = false;

  /** One GET with retries on 429/5xx and network errors, bounded by the call's and the overall time. */
  async function get(url: string, headers: Record<string, string>): Promise<{ res: Response; body: unknown } | 'error' | 'time'> {
    for (let attempt = 0; ; attempt++) {
      if (stop.signal.aborted) return 'time';
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { accept: 'application/json', ...(o.userAgent ? { 'user-agent': o.userAgent } : {}), ...headers },
          redirect: 'error',
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(L.timeoutMs)]),
        });
      } catch {
        if (stop.signal.aborted) return 'time';
        if (attempt >= L.retries) return 'error';
        await sleep(Math.min(L.maxRetryWaitMs, 500 * 2 ** attempt), stop.signal);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < L.retries) {
        const wait = Math.min(L.maxRetryWaitMs, retryAfterMs(res, now()) ?? 500 * 2 ** attempt);
        await res.body?.cancel().catch(() => {});
        if (now() + wait >= deadline) return 'time';
        await sleep(wait, stop.signal);
        continue;
      }
      const body = await jsonCapped(res, L.maxBytes);
      return { res, body };
    }
  }

  async function youtube(v: PlatformVideo): Promise<CallResult> {
    const url = `${YOUTUBE_CAPTIONS_ENDPOINT}?part=snippet&videoId=${encodeURIComponent(v.videoId)}&key=${encodeURIComponent(o.youtubeApiKey!)}`;
    const r = await get(url, {});
    if (r === 'time') return { kind: 'done', status: unchecked('time-limit') };
    if (r === 'error') return { kind: 'done', status: unchecked('api-error') };
    if (r.res.ok) {
      const s = youtubeStatus(r.body, L.maxTracks);
      return s ? { kind: 'ok', status: s } : { kind: 'done', status: unchecked('api-error', r.res.status) };
    }
    const reasons = googleReasons(r.body);
    if (reasons.some((x) => x === 'quotaExceeded' || x === 'dailyLimitExceeded')) return { kind: 'quota' };
    if (r.res.status === 404 || reasons.includes('videoNotFound')) return { kind: 'ok', status: unchecked('not-found') };
    return { kind: 'done', status: unchecked('api-error', r.res.status) };
  }

  async function vimeo(v: PlatformVideo): Promise<CallResult> {
    const r = await get(`${VIMEO_API_ORIGIN}/videos/${v.videoId}/texttracks`, {
      authorization: `bearer ${o.vimeoToken!}`,
      accept: 'application/vnd.vimeo.*+json;version=3.4',
    });
    if (r === 'time') return { kind: 'done', status: unchecked('time-limit') };
    if (r === 'error') return { kind: 'done', status: unchecked('api-error') };
    if (r.res.ok) {
      const s = vimeoStatus(r.body, L.maxTracks);
      return s ? { kind: 'ok', status: s } : { kind: 'done', status: unchecked('api-error', r.res.status) };
    }
    if (r.res.status === 404) return { kind: 'ok', status: unchecked('not-found') };
    return { kind: 'done', status: unchecked('api-error', r.res.status) };
  }

  async function one(v: PlatformVideo): Promise<PlatformCaptions> {
    const hasCredential = v.player === 'youtube' ? !!o.youtubeApiKey : !!o.vimeoToken;
    if (o.cache) {
      try {
        const hit = cachedCaptions(await o.cache.get(cacheKey(v)));
        if (hit) return hit;
      } catch {
        // a cache that is down is a miss
      }
    }
    if (!hasCredential) return unchecked('no-token');
    if (o.lookups === false) return unchecked('free-check');
    if (stop.signal.aborted) return unchecked('time-limit');
    if (v.player === 'youtube' && youtubeSpent) return unchecked('daily-limit');
    if (lookupsLeft <= 0) return unchecked('scan-limit');
    lookupsLeft--;
    const endpoint = v.player === 'youtube' ? YOUTUBE_CAPTIONS_ENDPOINT : VIMEO_API_ORIGIN;
    try {
      if (o.allowUrl && !(await o.allowUrl(endpoint))) return unchecked('api-error');
    } catch {
      return unchecked('api-error');
    }
    if (v.player === 'youtube' && o.quota) {
      let ok: boolean;
      try {
        ok = await o.quota.take(YOUTUBE_CAPTIONS_UNITS);
      } catch {
        return unchecked('api-error');
      }
      if (!ok) {
        youtubeSpent = true;
        return unchecked('daily-limit');
      }
    }
    const r = v.player === 'youtube' ? await youtube(v) : await vimeo(v);
    if (r.kind === 'quota') {
      youtubeSpent = true;
      await o.quota?.exhausted?.().catch(() => {});
      return unchecked('daily-limit');
    }
    if (r.kind === 'ok' && o.cache) {
      const ttl = r.status.status === 'captions' ? PLATFORM_CAPTION_TTL.captions : PLATFORM_CAPTION_TTL.other;
      await o.cache.put(cacheKey(v), r.status, ttl).catch(() => {});
    }
    return r.status;
  }

  try {
    const considered = unique.slice(0, L.videos);
    for (const v of unique.slice(L.videos)) out.set(platformVideoKey(v), unchecked('scan-limit'));
    let next = 0;
    const worker = async () => {
      while (next < considered.length) {
        const v = considered[next++]!;
        let s: PlatformCaptions;
        try {
          s = await one(v);
        } catch {
          s = unchecked('api-error');
        }
        out.set(platformVideoKey(v), s);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(L.concurrency, considered.length)) }, worker));
  } finally {
    clearTimeout(timer);
  }
  // Keys in the order the videos were given.
  return new Map(unique.map((v) => [platformVideoKey(v), out.get(platformVideoKey(v)) ?? unchecked('api-error')]));
}
