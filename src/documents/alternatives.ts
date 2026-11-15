// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Accessible alternatives: a document whose page links a version labelled "accessible" (or "HTML
// version", "text version", "large print", "plain text") right next to it, in the same list item,
// paragraph, table row or small card. The label is the site's own claim; nothing here checks the
// alternative. Pure functions, no network. Engine core: no Node-only imports.
import type { DocumentLink } from '../types.js';
import { normalizeUrl } from '../url.js';

/**
 * Wording that names an accessible version of a document. "Accessible" alone counts only as a
 * whole link text, or followed by a word for a version or format, so a document about accessible
 * parking ("Accessible parking map (PDF)") is not taken for one.
 */
const ALTERNATIVE_PHRASE = new RegExp(
  [
    String.raw`\baccessible\s+(?:version|format|copy|edition|pdf|word|document|file|html|web\s*page|page|alternative)s?\b`,
    String.raw`\b(?:html|text|text[\s-]only|plain[\s-]text|large[\s-]print)\s+(?:version|format|copy|edition)s?\b`,
    String.raw`\blarge[\s-]print\b`,
    String.raw`\bplain[\s-]text\b`,
  ].join('|'),
  'i',
);
const ACCESSIBLE_ALONE = /^\s*(?:view\s+|open\s+|download\s+)?(?:the\s+)?accessible\s*$/i;

/** True when a link's own text says it is an accessible version ("View accessible PDF", "Large print"). */
export function namesAlternative(text: string | undefined): boolean {
  if (!text) return false;
  return ACCESSIBLE_ALONE.test(text) || ALTERNATIVE_PHRASE.test(text);
}

/** The few words right before a link that can label it ("Accessible version: <a>Agenda</a>"). */
function labelBefore(before: string | undefined): string {
  if (!before) return '';
  // Only the text after the last sentence or item break, so a label further back is not borrowed.
  const tail = before.split(/[.;|•·]\s*|\s[–—-]\s/).pop() ?? '';
  return tail.trim().slice(-40);
}

/** True when a link is presented as an accessible version: by its own text or a label right before it. */
export function isAlternativeLink(link: Pick<DocumentLink, 'text' | 'before'>): boolean {
  return namesAlternative(link.text) || ALTERNATIVE_PHRASE.test(labelBefore(link.before));
}

/**
 * For every link on one page that has an accessible version linked next to it, the address of
 * that version, by the link's normalized address. A link counts as the original only when it is
 * not itself presented as the accessible version, and the alternative must be a different address
 * in the same container (`group`). The first alternative in page order wins.
 */
export function accessibleAlternatives(links: readonly DocumentLink[], base?: string): Map<string, string> {
  const byGroup = new Map<number, { url: string; alternative: boolean }[]>();
  for (const link of links) {
    if (link.group === undefined) continue;
    const url = normalizeUrl(link.href, base);
    if (!url) continue;
    const list = byGroup.get(link.group) ?? [];
    list.push({ url, alternative: isAlternativeLink(link) });
    byGroup.set(link.group, list);
  }
  const out = new Map<string, string>();
  for (const list of byGroup.values()) {
    for (const original of list) {
      if (original.alternative || out.has(original.url)) continue;
      // The original itself may also be listed under an alternative's label elsewhere in the group.
      if (list.some((l) => l.alternative && l.url === original.url)) continue;
      const alt = list.find((l) => l.alternative && l.url !== original.url);
      if (alt) out.set(original.url, alt.url);
    }
  }
  return out;
}
