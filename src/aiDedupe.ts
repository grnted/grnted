// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// One cost per element: when two gated AI checks confirm a failure of the same element (same page, same
// criterion, a shared element key), only the strongest one counts. Findings name their element with keys
// (`AiFinding.elements`): the box a screenshot fact has, its visible or accessible text, or the page as a
// whole. Pure and order-independent. Engine core: no Node-only imports.
import type { AiFinding } from './types.js';

/** The element key of a finding about the page as a whole (no line, block or item). */
export const PAGE_ELEMENT = 'page';

/** A text key: case, spacing and trailing punctuation do not matter. Undefined for empty text. */
export function textElement(s: string | undefined | null): string | undefined {
  const t = (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.,:;!?…]+$/u, '');
  return t ? `text:${t}` : undefined;
}

/** A box key: [x, y, width, height] in screenshot pixels (the vision collector's facts). */
export function boxElement(box: readonly number[]): string {
  return `box:${box.map((v) => Math.round(v)).join(',')}`;
}

/** A selector key: an element's CSS path (an axe node's target, a test's recorded path). */
export function selElement(selector: string | undefined | null): string | undefined {
  const t = (selector ?? '').trim();
  return t ? `sel:${t}` : undefined;
}

/** Roles, normalised across axe (the tag), the tests and the AI checks, for `roleElement`. */
const ROLE_OF: Readonly<Record<string, string>> = {
  a: 'link', link: 'link', button: 'button', img: 'image', image: 'image', graphic: 'image', svg: 'image',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', heading: 'heading',
  input: 'field', select: 'field', textarea: 'field', edit: 'field', field: 'field', textbox: 'field', combobox: 'field',
  checkbox: 'field', radio: 'field', switch: 'field',
};

/**
 * A role key, never matched on its own: two elements' keys match only when they share a selector or a
 * text key, and their role keys, when both have one, agree (`sameElement`). Undefined for a role this does
 * not know ("heading 2" is a heading, "field (email)" a field).
 */
export function roleElement(role: string | undefined | null): string | undefined {
  const r = (role ?? '').trim().toLowerCase().split(/[\s(]/)[0] ?? '';
  return Object.prototype.hasOwnProperty.call(ROLE_OF, r) ? `role:${ROLE_OF[r]}` : undefined;
}

const isRole = (k: string) => k.startsWith('role:');
/** Keys that can make a match (role keys only qualify one). */
const matches = (k: string) => k.startsWith('sel:') || k.startsWith('text:') || k.startsWith('tag:');

/** A bare tag name as a CSS selector (`table`, `html`): axe uses one only when it is unique on the page. */
const BARE_TAG = /^[a-z][a-z0-9-]*$/i;

/**
 * A tag key: the element is the page's only one of that tag (axe's selector is the bare tag), or a test's
 * CSS path ends in that bare tag. A tag key matches only another tag key, so a test's `#main > table`
 * and axe's `table` are one element; two tests' paths never meet (only axe makes a unique one).
 */
export function tagElement(tag: string | undefined | null): string | undefined {
  const t = (tag ?? '').trim().toLowerCase();
  return BARE_TAG.test(t) ? `tag:${t}` : undefined;
}

/** The last compound of a CSS path (`#main > table` → `table`), or '' for none. */
const lastCompound = (path: string) => path.split(/\s*(?:>>>|>|\+|~|\s)\s*/).filter(Boolean).pop() ?? '';

/** An axe node's keys: its selector, its text (an image's alt, else its visible text or aria-label) and its tag's role. */
export function axeNodeElements(node: { target: string; html: string }): string[] {
  const html = String(node.html ?? '');
  const tag = /^\s*<([a-zA-Z][\w-]*)/.exec(html)?.[1]?.toLowerCase();
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(html);
  const at = (name: string) => { const m = attr(name); return m ? (m[2] ?? m[3] ?? '') : undefined; };
  const visible = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = tag === 'img' ? at('alt') : visible.trim() || at('aria-label');
  const target = String(node.target ?? '').trim();
  return elementKeys(selElement(target), BARE_TAG.test(target) ? tagElement(target) : undefined, textElement(text), roleElement(tag));
}

/**
 * A test's finding's keys: the ones it set (`elements`), else read from its target: `link “name”` (a role
 * and a name) or a CSS path. Empty when it names nothing a key can be made of.
 */
export function probeFindingElements(f: { target?: string; elements?: readonly string[] }): string[] {
  if (Array.isArray(f.elements) && f.elements.length) return f.elements.filter((k): k is string => typeof k === 'string' && !!k);
  const t = (f.target ?? '').trim();
  if (!t) return [];
  const named = /^([a-z][\w-]*)\s+[“"](.+)[”"]$/i.exec(t);
  if (named) return elementKeys(textElement(named[2]), roleElement(named[1]));
  // A CSS path (a bare tag too, when it is one of the page's own landmarks or containers), with the bare tag it ends in.
  if (BARE_TAG.test(t)) return BARE_PAGE_TAGS.has(t.toLowerCase()) ? elementKeys(selElement(t), tagElement(t)) : [];
  if (!(/^[#.a-z*\[]/i.test(t) && !/\s{2,}/.test(t) && /[#.>\[:]/.test(t))) return [];
  const last = lastCompound(t);
  return elementKeys(selElement(t), BARE_TAG.test(last) ? tagElement(last) : undefined);
}

/** Bare tags a test's target may be on its own (a word like "button" alone is a description, not a path). */
const BARE_PAGE_TAGS: ReadonlySet<string> = new Set(['html', 'body', 'main', 'header', 'footer', 'nav', 'table', 'form']);

/**
 * Two findings name the same element (across axe, the tests and the AI checks): a selector or text key in
 * common, and, when both name a role, the same role. The page and criterion are the caller's to compare.
 */
export function sameElement(a: readonly string[], b: readonly string[]): boolean {
  const ra = a.filter(isRole);
  const rb = b.filter(isRole);
  if (ra.length && rb.length && !ra.some((r) => rb.includes(r))) return false;
  const kb = new Set(b.filter(matches));
  return a.some((k) => matches(k) && kb.has(k));
}

/** The keys of a finding, without empties or repeats. */
export function elementKeys(...keys: (string | undefined)[]): string[] {
  return [...new Set(keys.filter((k): k is string => !!k))];
}

const criterionOf = (f: AiFinding) => String(f.criterion).split(',')[0]!.trim();

/**
 * The findings another, stronger finding already stands for: same page, same (first) criterion, another
 * check, and at least one element key in common. Strength is `strength(f)` (higher wins); ties go to
 * the finding that comes first in `findings`. A finding without element keys is never a duplicate. Keys
 * chain: a finding that shares a key with any kept finding of another check is dropped.
 */
export function aiDuplicates(findings: readonly AiFinding[], strength: (f: AiFinding) => number, onDrop?: (dropped: AiFinding, kept: AiFinding) => void): Set<AiFinding> {
  const order = findings.map((f, i) => ({ f, i, s: strength(f) })).sort((a, b) => b.s - a.s || a.i - b.i);
  // Key → the kept findings that claim it (role keys qualify a match, they never make one).
  const claimed = new Map<string, AiFinding[]>();
  const dropped = new Set<AiFinding>();
  for (const { f } of order) {
    const keys = (Array.isArray(f.elements) ? f.elements : []).filter((k) => !isRole(k));
    if (!keys.length) continue;
    const scope = `${f.page}\n${criterionOf(f)}\n`;
    const kept = keys.flatMap((k) => claimed.get(scope + k) ?? []).find((x) => x.check !== f.check);
    if (kept) {
      dropped.add(f);
      onDrop?.(f, kept);
      continue;
    }
    for (const k of keys) {
      const list = claimed.get(scope + k) ?? [];
      list.push(f);
      claimed.set(scope + k, list);
    }
  }
  return dropped;
}
