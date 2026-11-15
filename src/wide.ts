// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Long scans (more than WIDE_MIN_PAGES pages: the hosted 250-page and "Up to 3,500 pages" tiers). Scans of
// up to 50 pages keep the discovery they always had; long ones differ in three deterministic ways:
//
// 1. Discovery reads every sitemap: each one robots.txt lists (or /sitemap.xml), sitemap indexes nested
//    up to MAX_SITEMAP_DEPTH deep, at most MAX_WIDE_SITEMAP_FILES files, keeping up to
//    max(MAX_SITEMAP_URLS, 3 × maxPages) addresses in section-spread order. Then the crawl: every
//    audited page's same-site links join the list, in page order (the links of page i only after every
//    page before it), until maxPages; so the list is the same whatever order the audits finish in.
// 2. De-duplication (`wideKey`): besides the scheme, a leading www., a trailing slash,
//    the fragment and the tracking parameters (url.ts), addresses that differ only by session parameters (SESSION_PARAM,
//    `;jsessionid=` path parameters) or calendar-style parameters (CALENDAR_PARAM) are one page: the
//    first address met is kept. Session ids are also dropped from the address loaded (`wideNormalize`).
// 3. Calendar traps: at most PER_SHAPE_MAX pages per path shape (`pathShape`: dated path segments and
//    pagination parameter values read as one template; ids and slugs stay distinct), the rest skipped.
//
// Engine core: no Node-only imports.
import { ACTION_SKIP_REASON, normalizeUrl, urlKey } from './url.js';

/** Scans of more pages than this are long scans. */
export const WIDE_MIN_PAGES = 50;
/** The most pages one scan selects (the hosted page cap is lower; src/tiers.ts in the Worker). */
export const MAX_PAGES_LIMIT = 20_000;
export const MAX_WIDE_SITEMAP_FILES = 300;
export const MAX_SITEMAP_DEPTH = 3;
/** Pages kept per path shape (calendar pages, endless pagination). */
export const PER_SHAPE_MAX = 50;
/** Document addresses a long scan keeps from its sitemaps (sorted; the pages' own links add more). */
export const MAX_WIDE_DOCUMENTS = 1000;

export const isWide = (maxPages: number) => maxPages > WIDE_MIN_PAGES;

const SESSION_PARAM = /^(sid|sessionid|session_id|session|jsessionid|phpsessid|aspsessionid|cfid|cftoken|sessid|zenid|osCsid)$/i;
const CALENDAR_PARAM = /^(date|day|month|year|week|yr|mo|view|calendar|cal|cal_date|caldate|calendardate|start_date|startdate|end_date|enddate|start|end|time)$/i;

/** The address a long scan loads: normalizeUrl, then without session ids (query or `;jsessionid=`). */
export function wideNormalize(input: string, base?: string): string | null {
  const n = normalizeUrl(input, base);
  if (!n) return null;
  const u = new URL(n);
  u.pathname = u.pathname.replace(/;(jsessionid|sid|phpsessid)=[^/]*/gi, '');
  for (const key of [...u.searchParams.keys()]) if (SESSION_PARAM.test(key)) u.searchParams.delete(key);
  return normalizeUrl(u.href);
}

/** De-duplication key of a long scan: the address key (url.ts `urlKey`) without session or calendar-style parameters. */
export function wideKey(href: string): string {
  const n = wideNormalize(href) ?? href;
  const u = new URL(n);
  for (const key of [...u.searchParams.keys()]) if (CALENDAR_PARAM.test(key)) u.searchParams.delete(key);
  return urlKey(normalizeUrl(u.href) ?? u.href);
}

const PAGINATION_PARAM = /^(page|p|pg|paged|offset|start|pagenum|page_num)$/i;
const YEAR = /^(19|20)\d{2}$/;
const DATED = /^(19|20)\d{2}-\d{1,2}(-\d{1,2})?$/;

/**
 * A path's template, for the calendar-trap cap: dated segments (a year and the month and day segments
 * after it, or 2026-11-03) read as one, and so do pagination parameters' values. Ids and slugs stay
 * themselves, so /node/123 and /node/124 are different shapes.
 */
export function pathShape(href: string): string {
  const u = new URL(href);
  let afterYear = 0;
  const segs = u.pathname.toLowerCase().split('/').map((seg) => {
    if (YEAR.test(seg)) {
      afterYear = 2;
      return 'Y';
    }
    if (afterYear > 0 && /^\d{1,2}$/.test(seg)) {
      afterYear--;
      return 'D';
    }
    afterYear = 0;
    return DATED.test(seg) ? 'D' : seg;
  });
  const params = [...u.searchParams.entries()].map(([k, v]) => `${k.toLowerCase()}=${PAGINATION_PARAM.test(k) ? 'N' : v}`).sort();
  return `${segs.join('/')}${params.length ? `?${params.join('&')}` : ''}`;
}

/** Long-scan filter for the page list: same key once, at most PER_SHAPE_MAX per shape. Stateful, deterministic in call order. */
export function wideFilter(): {
  admit(href: string): 'ok' | 'duplicate' | 'shape';
  seen(href: string): void;
  /** The shape's one skip record, when it has none yet (the shape's first page is its example). */
  shapeRecord(href: string): { url: string; reason: string } | null;
  /** Skip records kept from an earlier run: their shapes have theirs. */
  recorded(skipped: readonly { url: string; reason: string }[]): void;
} {
  const keys = new Set<string>();
  const shapes = new Map<string, number>();
  const examples = new Map<string, string>();
  const withRecord = new Set<string>();
  return {
    seen(href) {
      keys.add(wideKey(href));
      const s = pathShape(href);
      shapes.set(s, (shapes.get(s) ?? 0) + 1);
      if (!examples.has(s)) examples.set(s, href);
    },
    admit(href) {
      const key = wideKey(href);
      if (keys.has(key)) return 'duplicate';
      const s = pathShape(href);
      if ((shapes.get(s) ?? 0) >= PER_SHAPE_MAX) {
        keys.add(key);
        return 'shape';
      }
      keys.add(key);
      shapes.set(s, (shapes.get(s) ?? 0) + 1);
      if (!examples.has(s)) examples.set(s, href);
      return 'ok';
    },
    shapeRecord(href) {
      const s = pathShape(href);
      if (withRecord.has(s)) return null;
      withRecord.add(s);
      return { url: examples.get(s) ?? href, reason: SHAPE_SKIP_REASON };
    },
    recorded(skipped) {
      for (const x of skipped) if (x.reason === SHAPE_SKIP_REASON) withRecord.add(pathShape(x.url));
    },
  };
}

/** Robots-blocked addresses the long-scan crawl lists; past this they are only counted (`robotsMoreReason`). */
export const MAX_CRAWL_ROBOTS_SKIPPED = 1000;
export const ROBOTS_SKIP_REASON = 'Blocked by robots.txt';
const ROBOTS_MORE_TAIL = `not listed (the list stops at ${MAX_CRAWL_ROBOTS_SKIPPED.toLocaleString('en-US')})`;

/**
 * The one record that stands for the robots-blocked addresses past MAX_CRAWL_ROBOTS_SKIPPED: with their
 * count once the crawl has ended, without it while the crawl runs (what a host stores between segments).
 */
export function robotsMoreReason(count?: number): string {
  if (count === undefined) return `${ROBOTS_SKIP_REASON}: more addresses it blocks are ${ROBOTS_MORE_TAIL}`;
  const n = count.toLocaleString('en-US');
  return `${ROBOTS_SKIP_REASON}: ${n} more ${count === 1 ? 'address it blocks is' : 'addresses it blocks are'} ${ROBOTS_MORE_TAIL}`;
}
export const isRobotsMoreRecord = (x: { reason: string }): boolean =>
  x.reason.startsWith(`${ROBOTS_SKIP_REASON}: `) && x.reason.endsWith(ROBOTS_MORE_TAIL);

/** One record per shape past PER_SHAPE_MAX (its example: the shape's first page), so the list stays short. */
export const SHAPE_SKIP_REASON = `More than ${PER_SHAPE_MAX} pages of the same kind as this one (a calendar or a long list): the first ${PER_SHAPE_MAX} were checked, the rest left out`;

/** Addresses left out because they look like actions (`isActionLikeUrl`) that a scan lists; past this they are only counted. */
export const MAX_ACTION_SKIPPED = 100;
const ACTION_MORE_TAIL = `not listed (the list stops at ${MAX_ACTION_SKIPPED})`;
/** The one record that stands for the action-like addresses past MAX_ACTION_SKIPPED (as `robotsMoreReason`: counted once the list is final). */
export function actionMoreReason(count?: number): string {
  if (count === undefined) return `${ACTION_SKIP_REASON}: more addresses are ${ACTION_MORE_TAIL}`;
  return `${ACTION_SKIP_REASON}: ${count.toLocaleString('en-US')} more ${count === 1 ? 'address is' : 'addresses are'} ${ACTION_MORE_TAIL}`;
}
export const isActionMoreRecord = (x: { reason: string }): boolean =>
  x.reason.startsWith(`${ACTION_SKIP_REASON}: `) && x.reason.endsWith(ACTION_MORE_TAIL);

/**
 * Lists the action-like addresses a page list left out, into `skipped`: each once, the first
 * MAX_ACTION_SKIPPED of them, the rest counted in one record (`end` writes the count). Bounded whatever a
 * site links to: at most ACTION_KEYS_KEPT addresses are remembered for the once-only rule.
 */
export function actionSkips(skipped: { url: string; reason: string }[], site: string): { add(href: string): void; end(): void } {
  const ACTION_KEYS_KEPT = 5000;
  const seen = new Set<string>();
  let moreRecord = skipped.find(isActionMoreRecord);
  for (const x of skipped) if (x.reason === ACTION_SKIP_REASON) seen.add(urlKey(x.url));
  let listed = seen.size;
  // What an earlier counter over this list counted (the first page list, before the crawl) stays counted.
  const before = moreRecord ? Number((/: ([\d,]+) more /.exec(moreRecord.reason)?.[1] ?? '0').replace(/,/g, '')) || 0 : 0;
  let more = 0;
  return {
    add(href) {
      const key = urlKey(href);
      if (seen.has(key)) return;
      if (seen.size < ACTION_KEYS_KEPT) seen.add(key);
      if (listed < MAX_ACTION_SKIPPED) {
        skipped.push({ url: href, reason: ACTION_SKIP_REASON });
        listed++;
        return;
      }
      more++;
      if (!moreRecord) skipped.push((moreRecord = { url: site, reason: actionMoreReason() }));
    },
    end() {
      if (moreRecord && before + more > 0) moreRecord.reason = actionMoreReason(before + more);
    },
  };
}
