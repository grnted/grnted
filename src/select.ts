// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { isActionLikeUrl, isDocumentUrl, isLikelyHtml, normalizeUrl, sameSite, urlKey } from './url.js';
import { actionSkips } from './wide.js';

export interface Selection {
  pages: string[];
  documents: string[];
  skipped: { url: string; reason: string }[];
}

function depth(href: string): number {
  return new URL(href).pathname.split('/').filter(Boolean).length;
}

function sortKey(href: string): string {
  const u = new URL(href);
  return `${u.pathname}${u.search}`;
}

/** The top-level section of an address: its first path segment ('' for the root). */
function sectionOf(href: string): string {
  return new URL(href).pathname.split('/').filter(Boolean)[0] ?? '';
}

const byDepthThenPath = (a: { depth: number; key: string }, b: { depth: number; key: string }) =>
  a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Orders page addresses by section spread (scoring v3): round-robin over the top-level sections (first
 * path segment), shallowest first within a section (then by path and query). Round 1 takes the first
 * page of every section, round 2 the second of every section that has one, and so on; the pages of
 * one round are ordered by depth, then by path and query. Deterministic: the result does not depend on
 * the input order. Duplicates are the caller's to remove.
 */
export function spreadOrder(urls: readonly string[]): string[] {
  const sections = new Map<string, { href: string; depth: number; key: string }[]>();
  for (const href of urls) {
    const s = sectionOf(href);
    let list = sections.get(s);
    if (!list) sections.set(s, (list = []));
    list.push({ href, depth: depth(href), key: sortKey(href) });
  }
  // Each round looks only at the sections that still have pages (in first-seen order, which breaks
  // ties as before): every section is visited once per page it holds, not once per round (a scan's
  // whole sitemap list cost sections x longest section).
  let lists = [...sections.values()].map((l) => l.sort(byDepthThenPath));
  const out: string[] = [];
  for (let round = 0; out.length < urls.length; round++) {
    lists = lists.filter((l) => round < l.length);
    const picks = lists.map((l) => l[round]!).sort(byDepthThenPath);
    if (!picks.length) break;
    for (const p of picks) out.push(p.href);
  }
  return out;
}

export function selectPages(
  start: string,
  candidates: string[],
  max: number,
  isAllowed: (url: string) => boolean = () => true,
): Selection {
  const startUrl = normalizeUrl(start);
  if (!startUrl) throw new Error(`Invalid start URL: ${start}`);
  const seen = new Set<string>([urlKey(startUrl)]);
  const documents = new Set<string>();
  const skipped: Selection['skipped'] = [];
  const actions = actionSkips(skipped, startUrl);
  const pool: string[] = [];

  for (const candidate of candidates) {
    const href = normalizeUrl(candidate, startUrl);
    if (!href) continue;
    if (isDocumentUrl(href)) {
      // The action filter comes first, on any host: an address that looks like an action is never accepted as
      // a document either (`/delete/report.pdf?token=abc` would be downloaded by the document checks).
      if (isActionLikeUrl(href, startUrl)) actions.add(href);
      else documents.add(href);
      continue;
    }
    if (!sameSite(href, startUrl) || !isLikelyHtml(href)) continue;
    const key = urlKey(href);
    if (seen.has(key)) continue;
    seen.add(key);
    // Never requested, wherever the address came from (a link, script-written navigation, a sitemap).
    if (isActionLikeUrl(href, startUrl)) {
      actions.add(href);
      continue;
    }
    if (!isAllowed(href)) {
      skipped.push({ url: href, reason: 'Blocked by robots.txt' });
      continue;
    }
    pool.push(href);
  }

  actions.end();
  // Every top-level section first, then by depth (scoring v3, docs/scoring.md).
  return {
    pages: [startUrl, ...spreadOrder(pool)].slice(0, Math.max(1, max)),
    documents: [...documents].sort(),
    skipped: skipped.sort((a, b) => (a.url < b.url ? -1 : 1)),
  };
}
