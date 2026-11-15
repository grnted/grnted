// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The addresses a page leads to, read inside the page: by discovery (src/crawl.ts) and by every page audit
// (src/audit.ts, for the long-scan crawl). Engine core: no Node-only imports.

/**
 * Addresses one page gives, at most (review r1, finding 8: a site map with 300,000 links was read, carried
 * and kept whole). The first ones in document order: a scan takes at most a few thousand pages, and the
 * long-scan crawl reads every audited page's links, so what one page leaves out the next ones bring.
 * (`collectLinks` runs inside the page and cannot read this constant: it carries the same number.)
 */
export const MAX_PAGE_LINKS = 5000;

/**
 * Runs inside the page: the addresses it leads to. Its links (`a[href]`, image-map `area[href]`) first, then
 * the addresses of navigation written as script (below). Must be self-contained.
 *
 * Never the documents it shows in frames (tried 2026-11-10, taken back): a document a site serves only to be
 * embedded is part of the page that embeds it (axe tests it there, with that page). Loaded as a page of its
 * own it would be judged as one (its title, its language, its headings), which is stricter than WCAG for
 * content no visitor is sent to. A framed document that is also linked is found by its link.
 * (Named `collectLinks`, as the audit's link reader always was: test browsers answer in-page calls by name.)
 */
export function collectLinks(): string[] {
  const MAX = 5000;
  const out: string[] = [];
  // A live list, walked by index and left at the cap: never a copy of every link the page holds.
  const anchors = document.getElementsByTagName('a');
  for (let i = 0; i < anchors.length && out.length < MAX; i++) if (anchors[i]!.hasAttribute('href')) out.push(anchors[i]!.href);
  const areas = document.getElementsByTagName('area');
  for (let i = 0; i < areas.length && out.length < MAX; i++) if (areas[i]!.hasAttribute('href')) out.push(areas[i]!.href);
  // Navigation written as script, where the address is in the markup: a card or table row with
  // `data-href`, an `onclick` that sets the location, a jump menu (a select whose `onchange` sets it).
  // Only what the markup says outright; nothing is clicked or run. At most 200 of each.
  const add = (raw: string | null) => {
    const v = (raw ?? '').trim();
    if (out.length >= MAX || !v || v.length > 2000 || /^(javascript:|mailto:|tel:|#|data:|blob:)/i.test(v)) return;
    try {
      const u = new URL(v, document.baseURI);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.href);
    } catch {
      // not an address
    }
  };
  const SETS_LOCATION = /(?:location(?:\.href)?\s*=\s*|location\.(?:assign|replace)\(\s*|window\.open\(\s*)(['"])([^'"]+)\1/;
  // One walk of a live list, by index, over the first 20,000 elements: no list of every match is ever built.
  const all = document.getElementsByTagName('*');
  let cards = 0;
  let clicks = 0;
  for (let i = 0; i < all.length && i < 20000 && out.length < MAX && (cards < 200 || clicks < 200); i++) {
    const el = all[i]!;
    if (cards < 200 && el.hasAttribute('data-href')) {
      cards++;
      add(el.getAttribute('data-href'));
    }
    if (clicks < 200 && el.hasAttribute('onclick')) {
      clicks++;
      const m = SETS_LOCATION.exec(el.getAttribute('onclick') ?? '');
      if (m) add(m[2]!);
    }
  }
  const selects = document.getElementsByTagName('select');
  let n = 0;
  for (let i = 0; i < selects.length && i < 200 && n < 200; i++) {
    const sel = selects[i]!;
    if (!/location|window\.open/.test(sel.getAttribute('onchange') ?? '')) continue;
    for (let k = 0; k < sel.options.length && n < 200; k++) {
      const opt = sel.options[k]!;
      if (!opt.hasAttribute('value')) continue;
      n++;
      const v = opt.getAttribute('value') ?? '';
      // A jump menu's values are addresses: a path or a full address, never a bare word.
      if (/^(\/|\.\.?\/|https?:\/\/)/i.test(v)) add(v);
    }
  }
  return out;
}
