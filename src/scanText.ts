// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Linear-time text scanning for site-controlled input (sitemaps, stylesheets, page HTML). A RegExp with a
// lazy or open-ended run before a delimiter (`<!--[\s\S]*?-->`, `<a[^>]*>`) rescans to the end of the
// text from every opener that has no closer: quadratic or worse on hostile input, synchronously on the
// scan's thread (staging 2026-11-03, robots.ts). These helpers give the same results in one pass.

/** JavaScript's `\s` (the set `String.prototype.trim` strips), one UTF-16 unit at a time. */
export function isSpace(c: number): boolean {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  return (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** RegExp `\w` (no `u` flag): ASCII letters, digits and `_`. */
export function isWordChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/**
 * ASCII letters lowered and nothing else touched, so indexes match the original text (what a RegExp's
 * `i` flag compares for an ASCII pattern: without `u`, no other character folds to an ASCII letter).
 */
export const asciiLower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * Every `open … close` span replaced with `repl`; an opener with no closer after it is kept as written.
 * Same result as `s.replace(/open[\s\S]*?close/g, repl)` (the closer is looked for after the whole
 * opener), in one pass.
 */
export function stripDelimited(s: string, open: string, close: string, repl = ''): string {
  let out = '';
  let from = 0;
  for (;;) {
    const at = s.indexOf(open, from);
    if (at < 0) break;
    const end = s.indexOf(close, at + open.length);
    // No closer after this opener means none after any later one either: the rest stays as written.
    if (end < 0) break;
    out += s.slice(from, at) + repl;
    from = end + close.length;
  }
  return out + s.slice(from);
}

/**
 * Every raw-text element named in `names` (lower case, none a prefix of another) replaced with
 * `repl(name as written)`. Same result as `s.replace(/<(a|b)\b[\s\S]*?<\/\1>/gi, …)`, in one pass: an
 * element runs from `<name` (then a non-word character) to the next `</name>` in any case; an opener
 * with no closer is kept as written.
 */
export function stripRawElements(s: string, names: readonly string[], repl: (asWritten: string) => string): string {
  const lower = asciiLower(s);
  // Per name: where its next closer was found (-1: there is none left).
  const closer = new Map<string, number>();
  let out = '';
  let from = 0;
  let at = lower.indexOf('<');
  while (at >= 0) {
    const name = names.find((n) => lower.startsWith(n, at + 1) && !isWordChar(lower.charCodeAt(at + 1 + n.length)));
    if (name) {
      const bodyAt = at + 1 + name.length;
      let end = closer.get(name);
      if (end === undefined || (end >= 0 && end < bodyAt)) {
        end = lower.indexOf(`</${name}>`, bodyAt);
        closer.set(name, end);
      }
      if (end >= 0) {
        out += s.slice(from, at) + repl(s.slice(at + 1, bodyAt));
        from = end + name.length + 3;
        at = lower.indexOf('<', from);
        continue;
      }
    }
    at = lower.indexOf('<', at + 1);
  }
  return out + s.slice(from);
}

/**
 * `s.replace(re, fn)` for a tag pattern that ends at the first `>` it reaches (`<x\b[^>]*>`): run only
 * up to the last `>`. Every match ends at a `>`, so the result is the same; and past the last `>` an
 * opener would scan to the end of the text and fail, from every opener (quadratic).
 */
export function replaceTags(s: string, re: RegExp, fn: (tag: string) => string): string {
  const end = s.lastIndexOf('>') + 1;
  return s.slice(0, end).replace(re, fn) + s.slice(end);
}

/** The text up to and including its last `>` (for `matchAll`/`exec` with a tag pattern, as `replaceTags`). */
export const upToLastTagEnd = (s: string): string => s.slice(0, s.lastIndexOf('>') + 1);
