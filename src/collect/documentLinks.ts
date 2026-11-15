// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import type { DocumentLink, PageCollector } from '../types.js';

/**
 * Runs inside the page (serialized, so self-contained). Every http(s) link with its accessible
 * name, `type` and `download` attributes and the text of the block around it. Exact duplicates
 * (same address and name) are kept once; at most 1000 links per page.
 *
 * Links that share a small container (a list item, paragraph, table row or caption, else the
 * nearest ancestor within 3 levels that holds 2 to 6 links and at most 300 characters of text: a
 * small card) get the same `group` number and the text right before them (`before`), so an
 * accessible version linked next to a document can be found outside the page.
 */
function collectDocumentLinks(): DocumentLink[] {
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const out: DocumentLink[] = [];
  const seen = new Set<string>();
  const counts = new Map<Element, number>();
  /** http(s) links inside an element (memoised: ancestors are shared by many links). */
  const linkCount = (el: Element) => {
    let n = counts.get(el);
    if (n === undefined) {
      n = [...el.querySelectorAll('a[href]')].filter((x) => /^https?:/i.test((x as HTMLAnchorElement).href)).length;
      counts.set(el, n);
    }
    return n;
  };
  const STOP = /^(?:BODY|HTML|MAIN|NAV|HEADER|FOOTER|ASIDE|SECTION|TABLE|TBODY|THEAD|UL|OL|DL|FORM)$/;
  /** The small container a link shares with its neighbours, or null when there is none. */
  const containerOf = (a: Element): Element | null => {
    const block = a.parentElement?.closest('li, p, tr, dd, dt, figcaption, caption') ?? null;
    if (block) return linkCount(block) > 1 ? block : null;
    let el = a.parentElement;
    for (let level = 0; el && level < 3 && !STOP.test(el.tagName); level++, el = el.parentElement) {
      const n = linkCount(el);
      if (n < 2) continue;
      return n <= 6 && (el.textContent ?? '').replace(/\s+/g, ' ').trim().length <= 300 ? el : null;
    }
    return null;
  };
  const groups = new Map<Element, number>();
  const textBefore = (container: Element, a: Element) => {
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEndBefore(a);
    return range.toString().replace(/\s+/g, ' ').trim().slice(-60);
  };
  for (const a of [...document.querySelectorAll('a[href]')] as HTMLAnchorElement[]) {
    if (out.length >= 1000) break;
    const href = a.href;
    if (!/^https?:/i.test(href)) continue;
    let text = clean(a.getAttribute('aria-label'), 200);
    const labelledBy = a.getAttribute('aria-labelledby');
    if (!text && labelledBy) {
      text = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '), 200);
    }
    if (!text) text = clean(a.innerText || a.textContent, 200);
    if (!text) text = clean([...a.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).join(' '), 200);
    if (!text) text = clean(a.getAttribute('title'), 200);
    const key = `${href}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = a.parentElement?.closest('li, p, td, th, dd, dt, figcaption, caption, h1, h2, h3, h4, h5, h6') ?? a.parentElement;
    const nearby = clean(block?.textContent, 150);
    const type = clean(a.getAttribute('type'), 100);
    const container = containerOf(a);
    let group: number | undefined;
    let before = '';
    if (container) {
      group = groups.get(container) ?? groups.size + 1;
      groups.set(container, group);
      before = textBefore(container, a);
    }
    out.push({
      href,
      text,
      ...(type ? { type } : {}),
      ...(a.hasAttribute('download') ? { download: clean(a.getAttribute('download'), 200) } : {}),
      ...(nearby ? { nearby } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(before ? { before } : {}),
    });
  }
  return out;
}

/**
 * Links with the context the document detector needs (desktop). Runs on every scan: the document
 * inventory is built from it (see `documents/`).
 */
export const documentLinksCollector: PageCollector<DocumentLink[]> = {
  id: 'documentLinks',
  viewport: 'desktop',
  collect: (page) => page.evaluate(collectDocumentLinks, undefined),
};
