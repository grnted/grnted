// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Reading the start tag of an element's HTML as axe reported it (report v2): for the snippets
// (copy/snippets.ts) and the repetition signature (build.ts). The input is untrusted page content:
// the reader is a small, linear scanner (no regular expressions over the whole input, no DOM), reads
// at most HTML_MAX characters and gives up (null) on anything it can't read with certainty.

/** axe keeps the start of each element's HTML; the report keeps at most this much. */
export const HTML_MAX = 300;
/** Longest signature kept per element. */
export const SIGNATURE_MAX = 200;

export interface StartTagAttr {
  /** Lowercased name. */
  name: string;
  /** The attribute exactly as written, e.g. `aria-label='Go'`. */
  raw: string;
  /** Its value (quotes removed), '' for a bare attribute. */
  value: string;
  /** Offset of `raw` in the start tag, and the whitespace before it. */
  start: number;
  lead: number;
}

export interface StartTag {
  /** Lowercased tag name. */
  name: string;
  /** The start tag as written, from `<` to `>`. */
  raw: string;
  attrs: StartTagAttr[];
  /** What follows the start tag (within the first HTML_MAX characters). */
  rest: string;
}

const isSpace = (ch: string) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
const isAlpha = (ch: string) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
const isNameChar = (ch: string) => isAlpha(ch) || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_' || ch === ':' || ch === '.';

/** The element's start tag, or null when the HTML doesn't begin with one that closes. */
export function parseStartTag(html: string | undefined | null): StartTag | null {
  if (typeof html !== 'string') return null;
  const src = html.slice(0, HTML_MAX);
  let i = 0;
  while (i < src.length && isSpace(src[i]!)) i++;
  const open = i;
  if (src[i] !== '<' || !isAlpha(src[i + 1] ?? '')) return null;
  i++;
  const nameStart = i;
  while (i < src.length && isNameChar(src[i]!)) i++;
  const name = src.slice(nameStart, i).toLowerCase();
  const attrs: StartTagAttr[] = [];
  for (;;) {
    const ws = i;
    while (i < src.length && (isSpace(src[i]!) || src[i] === '/')) i++;
    if (i >= src.length) return null;
    if (src[i] === '>') {
      const raw = src.slice(open, i + 1);
      return { name, raw, attrs: attrs.map((a) => ({ ...a, start: a.start - open })), rest: src.slice(i + 1) };
    }
    if (i === ws && attrs.length) return null; // attributes must be separated by whitespace
    const aStart = i;
    while (i < src.length && !isSpace(src[i]!) && src[i] !== '>' && src[i] !== '/' && src[i] !== '=' && src[i] !== '"' && src[i] !== "'" && src[i] !== '<') i++;
    if (i === aStart) return null; // a quote or `<` where a name should be
    const aName = src.slice(aStart, i).toLowerCase();
    let value = '';
    let j = i;
    while (j < src.length && isSpace(src[j]!)) j++;
    if (src[j] === '=') {
      j++;
      while (j < src.length && isSpace(src[j]!)) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const end = src.indexOf(q, j + 1);
        if (end < 0) return null; // unclosed quote
        value = src.slice(j + 1, end);
        i = end + 1;
      } else {
        const vStart = j;
        while (j < src.length && !isSpace(src[j]!) && src[j] !== '>') j++;
        if (j === vStart) return null;
        value = src.slice(vStart, j);
        i = j;
      }
    }
    attrs.push({ name: aName, raw: src.slice(aStart, i), value, start: aStart, lead: aStart - ws });
  }
}

/** The start tag without the attributes `drop` matches, the rest kept exactly as written. */
export function withoutAttrs(tag: StartTag, drop: (a: StartTagAttr) => boolean): string {
  let out = '';
  let at = 0;
  for (const a of tag.attrs) {
    if (!drop(a)) continue;
    out += tag.raw.slice(at, a.start - a.lead);
    at = a.start + a.raw.length;
  }
  return out + tag.raw.slice(at);
}

/** Class names CSS-in-JS and scoped-style tools generate per build or per component. */
const GENERATED_CLASS = /^(?:css|sc|svelte|jsx|astro|emotion|styled|tw)-[A-Za-z0-9_-]+$/;
/** Attributes that differ between pages for the same element: ids, data-*, framework scope marks. */
const VOLATILE_ATTR = (name: string) => name === 'id' || name.startsWith('data-') || name.startsWith('astro-cid') || name.startsWith('_ng') || name.startsWith('ng-reflect-');

function normaliseClass(value: string): string {
  const tokens = new Set<string>();
  for (const token of value.split(/\s+/)) {
    if (!token || GENERATED_CLASS.test(token)) continue;
    const trimmed = token.replace(/[-_]?\d+$/, '');
    tokens.add(trimmed || token);
  }
  return [...tokens].sort().join(' ');
}

/**
 * A page-independent signature of an element, for finding the same failing element on many pages
 * (spec §5): its start tag with `id`, `data-*` and framework scope attributes dropped, numeric class
 * suffixes and generated class names removed, attributes sorted, whitespace collapsed. '' when the
 * HTML has no readable start tag.
 */
export function elementSignature(html: string | undefined | null): string {
  const tag = parseStartTag(html);
  if (!tag) return '';
  const parts: string[] = [];
  for (const a of tag.attrs) {
    if (VOLATILE_ATTR(a.name)) continue;
    const value = (a.name === 'class' ? normaliseClass(a.value) : a.value).replace(/\s+/g, ' ').trim();
    if (a.name === 'class' && !value) continue;
    parts.push(a.raw.includes('=') ? `${a.name}="${value.replace(/"/g, '&quot;')}"` : a.name);
  }
  parts.sort();
  const sig = `<${[tag.name, ...parts].join(' ')}>`;
  return sig.length > SIGNATURE_MAX ? sig.slice(0, SIGNATURE_MAX) : sig;
}
