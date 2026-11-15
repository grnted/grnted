// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Slow sites (staging 2026-11-03, fedex.com: every automated HTML answer took ~8-10 s, a pattern of bot
// protection that slows automated visitors down). The start page's first byte is measured once per scan,
// bounded, beside robots.txt and the sitemaps: a site whose first answer takes more than
// `slowFirstByteMs` gets a longer, still bounded, page load timeout and fewer pages at once, and a page
// load on it that times out reads as the site slowing us (SLOWED_PAGE), not as a plain time-out.
// Engine core: no Node-only imports.
import { isWafChallenge } from './challenge.js';
import type { Pace } from './pace.js';

export const SITE_TIMING = {
  /** A start page whose first byte (any redirect hop) takes longer than this: the site is slow. */
  slowFirstByteMs: 5_000,
  /** Page loads (the load event) on an ordinary site. */
  pageTimeoutMs: 45_000,
  /** Page loads on a slow site: longer, never past the scan's deadline, never under `pageTimeoutMs`. */
  slowPageTimeoutMs: 75_000,
  /** Pages audited at once on a slow site (each loads its two widths together). */
  slowConcurrency: 2,
  /** robots.txt and one sitemap file: the request and its body. */
  fileTimeoutMs: 20_000,
  /** All sitemap files of a scan (at most a quarter of the time left before the deadline). */
  sitemapBudgetMs: 40_000,
  /** The same for long scans, which read many more files. */
  wideSitemapBudgetMs: 90_000,
  /** The home page link fallback: after the document, how long it waits for `load` before reading links. */
  homeLoadWaitMs: 15_000,
  /** Redirect hops followed when measuring the start page. */
  probeHops: 5,
} as const;

export type SiteTiming = { -readonly [K in keyof typeof SITE_TIMING]: number };

export const siteTiming = (t?: Partial<SiteTiming>): SiteTiming => ({ ...SITE_TIMING, ...t });

export interface StartSpeed {
  /** The slowest hop's first byte took longer than `slowFirstByteMs` (it was not waited out). */
  slow: boolean;
  /** A known WAF challenge answered (Cloudflare `cf-mitigated: challenge`, AWS WAF `x-amzn-waf-action`). */
  challenge: boolean;
  /** The slowest hop's time to its first byte (at least `slowFirstByteMs` when slow); null: unknown. */
  firstByteMs: number | null;
}

const UNKNOWN: StartSpeed = { slow: false, challenge: false, firstByteMs: null };

/**
 * The start page's first byte, each redirect hop's on its own (fedex.com: the apex's 301 comes at once,
 * www's answer after 8.2 s), each hop checked with `allowUrl` before it is requested. A hop that has not
 * answered after `slowFirstByteMs` is cut there: the site is slow, and nothing waits it out. The body is
 * never read. With `pace`, each hop goes through the scan's politeness controller (a refusal slows the
 * scan; the measurement is then unknown). Any other failure is "unknown" (not slow): only time we measured makes a site slow.
 */
export async function measureStart(
  url: string,
  opts: { userAgent: string; fetchFn?: typeof fetch; allowUrl?: (url: string) => Promise<boolean>; timing?: Partial<SiteTiming>; pace?: Pace },
): Promise<StartSpeed> {
  const t = siteTiming(opts.timing);
  const fetchFn = opts.fetchFn ?? fetch;
  let current = url;
  let slowest = 0;
  let challenge = false;
  // The whole measurement, waits for the controller included, takes at most `fileTimeoutMs`.
  const end = Date.now() + t.fileTimeoutMs;
  try {
    for (let hop = 0; hop <= t.probeHops; hop++) {
      if (opts.allowUrl && !(await opts.allowUrl(current))) return { ...UNKNOWN, challenge };
      const c = new AbortController();
      const all = setTimeout(() => c.abort(), Math.max(0, end - Date.now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cut = false;
      let sent = 0;
      let res: Response;
      try {
        const get = () => {
          // The first-byte clock starts when the request goes out, not while the controller waits.
          sent = Date.now();
          timer = setTimeout(() => { cut = true; c.abort(); }, t.slowFirstByteMs);
          return fetchFn(current, { headers: { 'user-agent': opts.userAgent }, redirect: 'manual', signal: c.signal });
        };
        // Through the scan's politeness controller (not a page load, never tried again): a site that
        // answers it 429 or 503 slows the scan down like any other refusal.
        if (opts.pace) {
          const r = await opts.pace.load(current, get, (x) => ({ status: x.status, retryAfter: x.headers.get('retry-after') }), {
            page: false, retries: 0, signal: c.signal, discard: (x) => { x.body?.cancel().catch(() => {}); },
          });
          if (!r.value) return { ...UNKNOWN, challenge };
          res = r.value;
        } else res = await get();
      } catch {
        return cut ? { slow: true, challenge, firstByteMs: Math.max(slowest, t.slowFirstByteMs) } : { ...UNKNOWN, challenge };
      } finally {
        clearTimeout(timer);
        clearTimeout(all);
      }
      slowest = Math.max(slowest, Date.now() - sent);
      await res.body?.cancel().catch(() => {});
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      if (isWafChallenge(headers)) challenge = true;
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') break;
      next.hash = '';
      current = next.href;
    }
  } catch {
    return { ...UNKNOWN, challenge };
  }
  return { slow: slowest > t.slowFirstByteMs, challenge, firstByteMs: slowest };
}

/** Treated as slowing us: slow, or answering with a known WAF challenge. */
export const slowing = (s: StartSpeed | undefined): boolean => !!s && (s.slow || s.challenge);

/**
 * A page load's timeout: `pageTimeoutMs` on an ordinary site. On a slow one `slowPageTimeoutMs`, but
 * never ending after `deadline` (the scan's own cut-off for waits), and never shorter than an ordinary
 * site's, so a page is never failed sooner because the site was slow.
 */
export function pageTimeoutFor(s: StartSpeed | undefined, t: SiteTiming, deadline: number | undefined, now: number): number {
  if (!s?.slow) return t.pageTimeoutMs;
  const left = deadline === undefined ? Infinity : deadline - now;
  return Math.max(t.pageTimeoutMs, Math.min(t.slowPageTimeoutMs, left));
}

/** Why a page on a site that slowed (or challenged) us did not load, as the report shows it. */
export const SLOWED_PAGE = 'The site slowed or blocked our scanner: the page did not finish loading in time';

/** A page load that ran out of time (Playwright's goto timeout). */
const LOAD_TIMEOUT = /^page\.goto: Timeout \d+ms exceeded/;

/** The reason a failed page gets: a load time-out on a site that slowed us is SLOWED_PAGE; any other stays. */
export function slowedReason(s: StartSpeed | undefined, reason: string): string {
  return slowing(s) && LOAD_TIMEOUT.test(reason) ? SLOWED_PAGE : reason;
}
