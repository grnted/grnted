// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { asciiLower, isSpace } from './scanText.js';

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const LT = 60; // <
const RSQB = 93; // ]

/**
 * The element whose start tag `<tag>` sits at `at` in `text` (`lower` is `text` with ASCII letters
 * lowered): its value trimmed and the index just past `</tag>`, or null when it is not one.
 *
 * The same reading as the regex this replaced, /<tag>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/tag>/i,
 * without its backtracking (about n^5 on an unclosed tag before a run of spaces, staging incident class
 * of robots.ts:30): the value is everything up to the first `<` or `]` after the start tag (or after a
 * `<![CDATA[` that follows only spaces), at least one character; then `]]>` and spaces may come, then
 * `</tag>`. One pass, each character read a bounded number of times.
 */
function element(text: string, lower: string, at: number, tag: string): { value: string; end: number } | null {
  const n = text.length;
  let start = at + tag.length + 2;
  let i = start;
  while (i < n && isSpace(text.charCodeAt(i))) i++;
  if (lower.startsWith('<![cdata[', i)) start = i + 9;
  let t = start;
  while (t < n) {
    const c = text.charCodeAt(t);
    if (c === LT || c === RSQB) break;
    t++;
  }
  if (t === start || t >= n) return null;
  let k = t;
  if (text.charCodeAt(k) === RSQB) {
    if (!text.startsWith(']]>', k)) return null;
    k += 3;
    while (k < n && isSpace(text.charCodeAt(k))) k++;
  }
  const close = `</${tag}>`;
  if (!lower.startsWith(close, k)) return null;
  return { value: text.slice(start, t).trim(), end: k + close.length };
}

/** The first `<tag>…</tag>` element in `text`, as `element` reads it. */
function firstElement(text: string, lower: string, tag: string): string | null {
  const open = `<${tag}>`;
  for (let at = lower.indexOf(open); at >= 0; at = lower.indexOf(open, at + 1)) {
    const el = element(text, lower, at, tag);
    if (el) return el.value;
  }
  return null;
}

/** Scanned by hand (no RegExp over the body) so it runs anywhere and in linear time. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const lower = asciiLower(xml);
  const locs: string[] = [];
  for (let at = lower.indexOf('<loc>'); at >= 0; ) {
    const el = element(xml, lower, at, 'loc');
    if (el) {
      const url = decodeEntities(el.value);
      if (url) locs.push(url);
    }
    at = lower.indexOf('<loc>', el ? el.end : at + 1);
  }
  return /<sitemapindex[\s>]/i.test(xml) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

/**
 * Each page address's `<lastmod>`, as written (monitoring scans, docs/monitoring.md): only `<url>`
 * entries that have both. Read separately from `parseSitemap` so discovery's address list never
 * depends on it. A `<url>` entry runs from `<url` and a space or `>` to the next `</url>`.
 */
export function sitemapLastmods(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = asciiLower(xml);
  for (let at = lower.indexOf('<url'); at >= 0; ) {
    const next = xml.charCodeAt(at + 4);
    if (next !== 62 /* > */ && !isSpace(next)) {
      at = lower.indexOf('<url', at + 1);
      continue;
    }
    const close = lower.indexOf('</url>', at + 5);
    // No closer after this opener means none after any later one either.
    if (close < 0) break;
    const end = close + 6;
    const block = xml.slice(at, end);
    const blockLower = lower.slice(at, end);
    const loc = firstElement(block, blockLower, 'loc');
    const mod = firstElement(block, blockLower, 'lastmod');
    if (loc !== null && mod !== null) {
      const url = decodeEntities(loc);
      if (url && !(url in out)) out[url] = mod.slice(0, 64);
    }
    at = lower.indexOf('<url', end);
  }
  return out;
}
