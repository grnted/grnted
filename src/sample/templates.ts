// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Template sampling (engine core: no Node-only or AI imports): a few pages that look like different
// templates, chosen by page index so the choice never depends on page timing. Used by the vision AI
// check and by the interaction and render probes (src/probes/).

/** What `samplePages` needs to know about a page. */
export interface TemplatePage {
  /** Page URL. */
  page: string;
  /** Position in the scan's page list (0 = the start page). */
  index: number;
  /** DOM-shape key (e.g. landmark, heading, form and table counts); '' when unknown. */
  shape: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generalise(segment: string, first: boolean): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  s = s.toLowerCase();
  const m = /^(.+?)(\.[a-z0-9]{1,5})$/.exec(s);
  const [base, ext] = m ? [m[1]!, m[2]!] : [s, ''];
  // Ids: numbers, UUIDs, hex hashes and mixed letter-and-digit tokens.
  if (/^\d+$/.test(base) || UUID.test(base) || (/^[0-9a-f]{8,}$/.test(base) && /\d/.test(base))) return `:id${ext}`;
  if (base.length >= 8 && /\d/.test(base) && /[a-z]/.test(base) && /^[a-z0-9]+$/.test(base)) return `:id${ext}`;
  // Slugs (several words, or words with a date) below the first level: /news/2026-spring-open-house.
  // Top-level pages keep their names: /about-our-school and /board-of-education are different pages.
  const words = base.split(/[-_+\s]+/).filter(Boolean);
  if (!first && (words.length >= 3 || (words.length >= 2 && /\d/.test(base)))) return `:slug${ext}`;
  return s;
}

/**
 * The URL with ids and slugs generalised, so pages built from one template share it:
 * `/news/123` → `/news/:id`, `/events/2026-spring-open-house` → `/events/:slug`. Query parameter
 * names are kept (sorted), their values are not.
 */
export function urlPattern(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const path = `/${segments.map((s, i) => generalise(s, i === 0)).join('/')}`;
  const keys = [...new Set(u.searchParams.keys())].sort();
  return keys.length ? `${path}?${keys.join('&')}` : path;
}

/**
 * Up to `size` pages that look like different templates: the start page first, then, in page
 * order, each page whose URL pattern and DOM shape both differ from every earlier page (two pages
 * sharing either one count as one template). Earlier pages win, so their reviews can start while
 * later pages are still loading.
 *
 * The choice for a page depends only on pages with a lower index, so it is the same however the
 * pages finish. Pass `decidedBefore` (the number of leading pages already audited) while the scan
 * is running: the result is then a prefix of the final sample, so nothing started early is ever
 * dropped later.
 */
export function samplePages<T extends TemplatePage>(
  pages: readonly T[],
  size = 5,
  decidedBefore = Number.POSITIVE_INFINITY,
): { eligible: number; sample: T[] } {
  const byIndex = new Map<number, T>();
  for (const p of pages) {
    const seen = byIndex.get(p.index);
    if (!seen || p.page < seen.page) byIndex.set(p.index, p);
  }
  const ordered = [...byIndex.values()].filter((p) => p.index < decidedBefore).sort((a, b) => a.index - b.index);
  const patterns = new Set<string>();
  const shapes = new Set<string>();
  const sample: T[] = [];
  for (const p of ordered) {
    if (sample.length >= Math.max(0, size)) break;
    const pattern = urlPattern(p.page);
    const isNew = !patterns.has(pattern) && !(p.shape && shapes.has(p.shape));
    patterns.add(pattern);
    if (p.shape) shapes.add(p.shape);
    if (isNew) sample.push(p);
  }
  return { eligible: byIndex.size, sample };
}
