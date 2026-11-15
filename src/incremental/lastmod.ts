// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Sitemap <lastmod> for monitoring scans (Plan 7, W6; docs/monitoring.md "Layer 1"). Engine core.
import { urlKey } from '../url.js';
import { wideNormalize } from '../wide.js';

/** How sitemap lastmods are keyed (the same for a sitemap address and the page address loaded). */
export function lastmodKey(url: string): string {
  try {
    return urlKey(wideNormalize(url) ?? url);
  } catch {
    return url;
  }
}

const HOUR = 3_600_000;
/** The latest time zone on earth is UTC+14: a date with no time can still be that day there until then. */
const LATEST_ZONE_MS = 14 * HOUR;

/**
 * A W3C datetime (the sitemap protocol's format) as epoch ms, or null when it is not one. A date alone
 * (`2026-10-02`) counts as the end of that day in the latest time zone (so it is never read as earlier
 * than it can be); a time without a zone is unsure (null).
 */
export function parseLastmod(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) {
    const t = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return Number.isFinite(t) ? t + 24 * HOUR + LATEST_ZONE_MS : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** What a lastmod says about a page since the previous scan started: strictly older is unchanged. */
export function lastmodSays(raw: string | undefined, previousStartedAt: string): 'unchanged' | 'changed' | undefined {
  const t = parseLastmod(raw);
  const prev = Date.parse(previousStartedAt);
  if (t === null || !Number.isFinite(prev)) return undefined;
  return t < prev ? 'unchanged' : 'changed';
}

export type LastmodTrustState = 'unproven' | 'trusted' | 'ignored';

/** Whether a site's sitemap lastmod is used to skip pages (kept per monitor). */
export interface LastmodTrust {
  trust: LastmodTrustState;
  /** Why it is ignored (plain words, for the log and the docs). */
  why?: string;
}

/** Pages a scan must have checked against their lastmod before the sitemap is trusted. */
export const LASTMOD_PROOF_PAGES = 3;

/**
 * The trust after a scan, from what its pages showed: each page fetched this scan whose lastmod
 * gave a verdict, compared with what its HTML said (`htmlSaid`). Ignored for good once a lastmod said
 * "unchanged" for a page that had changed (a missed change is worse than an extra audit), or when the
 * sitemap stamps pages as changed that are not (at least half of the pages checked, and at least
 * LASTMOD_PROOF_PAGES: a sitemap that stamps every page "now"), or when every page has the same
 * date-time. Trusted once one scan checked LASTMOD_PROOF_PAGES pages with none of that. A trusted
 * sitemap is still checked every scan on the pages that are fetched anyway (the homepage, the template
 * sample, pages its lastmod says changed) and on every page in the full scan every few cycles.
 */
export function nextLastmodTrust(
  prev: LastmodTrust | undefined,
  seen: readonly {
    lastmod?: string | undefined; lastmodSaid?: 'unchanged' | 'changed' | undefined; htmlSaid?: 'unchanged' | 'changed' | undefined; auditSaid?: 'unchanged' | 'changed' | undefined;
    bodyUnread?: boolean | undefined;
  }[],
): LastmodTrust {
  if (prev?.trust === 'ignored') return prev;
  // Evidence is a real body's hash (`htmlSaid`; a 304 never is) or, on a full cycle, the audit (`auditSaid`).
  if (seen.some((s) => s.lastmodSaid === 'unchanged' && (s.htmlSaid === 'changed' || s.auditSaid === 'changed'))) {
    return { trust: 'ignored', why: 'a sitemap lastmod said a page had not changed when it had' };
  }
  // A full cycle that could not read a page's body cannot vouch for the sitemap (r2-3): unproven again.
  if (seen.some((s) => s.bodyUnread)) return { trust: 'unproven', why: 'a page could not be read on the full scan' };
  const checked = seen.filter((s) => s.lastmodSaid && s.htmlSaid);
  if (checked.some((s) => s.lastmodSaid === 'unchanged' && s.htmlSaid === 'changed')) {
    return { trust: 'ignored', why: 'a sitemap lastmod said a page had not changed when it had' };
  }
  const falseAlarms = checked.filter((s) => s.lastmodSaid === 'changed' && s.htmlSaid === 'unchanged').length;
  if (falseAlarms >= LASTMOD_PROOF_PAGES && falseAlarms * 2 >= checked.length) {
    return { trust: 'ignored', why: 'the sitemap stamps pages as changed that have not changed' };
  }
  // One date-time (with a time of day) on every page is a generated stamp, not when pages changed. (One
  // date alone is plausible: a site published in a day; the checks above catch it if it misleads.)
  const values = new Set(seen.map((s) => s.lastmod).filter((x): x is string => !!x));
  const dated = seen.filter((s) => s.lastmod).length;
  if (dated >= LASTMOD_PROOF_PAGES * 2 && values.size === 1 && [...values][0]!.includes('T')) return { trust: 'ignored', why: 'every page has the same lastmod' };
  if (prev?.trust === 'trusted') return prev;
  return checked.length >= LASTMOD_PROOF_PAGES ? { trust: 'trusted' } : { trust: 'unproven' };
}
