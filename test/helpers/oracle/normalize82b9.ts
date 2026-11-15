// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// normalize.ts as of 82b90661 (before the linear scanners): the oracle for test/unit/normalizeLinear.test.ts only.
// Monitoring scans (Plan 7, W6; docs/monitoring.md "Normalisation"): the page HTML as compared between
// two scans, and the site's stylesheets and scripts a page uses. Deterministic, regex-only (no DOM: the
// engine runs in Node and in Workers). Engine core: no Node-only imports.
import { sitemapHostAllowed } from '../../../src/crawl.js';

/** Bumped when a rule below changes: every stored hash then differs once, so those pages are audited. */
export const NORMALIZE_VERSION = 2;

/** Query parameters that only bust caches (their value changes, the content does not). */
export const CACHE_BUST_PARAM = /^(v|ver|version|rev|build|t|ts|time|timestamp|cb|cachebust|cachebuster|nocache|_|hash|bust|rnd|rand|random)$/i;
/** Tracking parameters (as url.ts strips from page addresses, and the ad and analytics ones it does not). */
export const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|yclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|_ga|_gl|mkt_tok|igshid|ref_src)$/i;
/** Session parameters (as a long scan strips them, wide.ts). */
export const SESSION_PARAM = /^(sid|sessionid|session_id|session|jsessionid|phpsessid|aspsessionid|cfid|cftoken|sessid|zenid|oscsid)$/i;
/** Names of hidden fields and meta tags that hold per-request tokens. */
export const TOKEN_NAME = /(csrf|xsrf|token|nonce|authenticity|verification|viewstate|eventvalidation|form_build_id|form_key|session|^sid$)/i;

const dropParam = (k: string) => CACHE_BUST_PARAM.test(k) || TRACKING_PARAM.test(k) || SESSION_PARAM.test(k);

/** An address with its per-request parts removed (cache busting, tracking, session ids); relative ones stay relative. */
function cleanAddress(raw: string): string {
  const v = raw.trim();
  const q = v.indexOf('?');
  const hashAt = v.indexOf('#');
  const end = hashAt >= 0 ? hashAt : v.length;
  let path = (q >= 0 && q < end ? v.slice(0, q) : v.slice(0, end)).replace(/;(jsessionid|sid|phpsessid)=[^/?#]*/gi, '');
  if (q < 0 || q > end) return path + v.slice(end);
  const params = v.slice(q + 1, end).split(/&amp;|&/).filter((p) => p && !dropParam(decodeSafe(p.split('=')[0] ?? '')));
  if (params.length) path += `?${params.join('&')}`;
  return path + v.slice(end);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

const URL_ATTR = /(\s(?:href|src|action|poster|data-src|data-href|formaction)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SRCSET_ATTR = /(\s(?:srcset|data-srcset)\s*=\s*)("([^"]*)"|'([^']*)')/gi;
/** An ISO 8601 date with a time of day (a date alone is content: an event's date). */
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const TIME_DATA_ATTR = /\s(data-(?:timestamp|time|ts|now|generated|rendered|build|cache|request-id|nonce))\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * The HTML as compared between scans (docs/monitoring.md, rules 1–7, in order):
 * 1. comments removed; 2. `nonce` values blanked; 3. hidden form fields and meta tags whose name is a
 * per-request token (CSRF, session, view state) blanked; 4. inside tags only, ISO date-times with a time
 * of day blanked, and time-stamp `data-*` attributes (visible text is never changed); 5. in addresses (href, src, srcset, action, poster, data-src),
 * cache-busting, tracking and session parameters and `;jsessionid=` removed; 6. every run of whitespace
 * one space, and none between two tags; 7. the result prefixed with the rule version. The page's own
 * address is not part of it (the caller adds the address a redirect ended at), so identical shells
 * of a client-rendered site hash the same. `_url` is for future rules that resolve addresses.
 */
export function normalizeHtml(html: string, _url: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/(\snonce\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1""');
  s = s.replace(/<input\b[^>]*>/gi, (tag) => (/\stype\s*=\s*["']?hidden\b/i.test(tag) && TOKEN_NAME.test(attr(tag, 'name') ?? '')
    ? tag.replace(/(\svalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, '$1""') : tag));
  s = s.replace(/<meta\b[^>]*>/gi, (tag) => (TOKEN_NAME.test(attr(tag, 'name') ?? attr(tag, 'property') ?? '')
    ? tag.replace(/(\scontent\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, '$1""') : tag));
  s = s.replace(TIME_DATA_ATTR, ' $1=""');
  // Date-times only inside tags (attribute values: <time datetime>, meta, hidden inputs, data-*): the
  // text people read is content, so a visible time that changes is a change (r1-4).
  s = s.replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(ISO_TIME, '[time]'));
  s = s.replace(URL_ATTR, (_m, pre: string, _q: string, d?: string, sq?: string, bare?: string) => {
    const v = d ?? sq ?? bare ?? '';
    return `${pre}"${cleanAddress(v)}"`;
  });
  s = s.replace(SRCSET_ATTR, (_m, pre: string, _q: string, d?: string, sq?: string) => {
    const v = (d ?? sq ?? '').split(',').map((part) => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [cleanAddress(u ?? ''), ...rest].join(' ');
    }).join(', ');
    return `${pre}"${v}"`;
  });
  s = s.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  return `grnted-normalize-v${NORMALIZE_VERSION}\n${s}`;
}

/** An attribute's value in one start tag, entity-decoded for &amp; only; undefined when absent. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!m) return undefined;
  return (m[2] ?? m[3] ?? m[4] ?? '').replace(/&amp;/g, '&');
}

/** An asset's identity: the absolute address without its fragment, cache-busting, tracking or session parameters; the rest sorted. */
export function assetIdentity(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (dropParam(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.href;
}

export interface AssetRef {
  /** `assetIdentity`: how the asset is known across scans. */
  id: string;
  /** The address the page names (what is fetched). */
  url: string;
}

/**
 * Every stylesheet and script a page names, of any origin (r1-2a): `<link rel=stylesheet>`,
 * `<link rel=modulepreload>`, `<link rel=preload as=script|style>` and `<script src>`, each identity
 * once, sorted. (`_site` is kept for callers; same-site `@import` targets are read from the
 * stylesheets themselves, `cssImports`.)
 */
export function assetRefs(html: string, pageUrl: string, _site: string): AssetRef[] {
  const head = html.replace(/<!--[\s\S]*?-->/g, '');
  const baseHref = /<base\b[^>]*>/i.exec(head)?.[0];
  let base = pageUrl;
  try {
    const b = baseHref ? attr(baseHref, 'href') : undefined;
    if (b) base = new URL(b, pageUrl).href;
  } catch {
    // keep the page's address
  }
  const found = new Map<string, AssetRef>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    let abs: URL;
    try {
      abs = new URL(raw.trim(), base);
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    abs.hash = '';
    const id = assetIdentity(abs.href);
    if (!found.has(id)) found.set(id, { id, url: abs.href });
  };
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/);
    const as = (attr(m[0], 'as') ?? '').toLowerCase();
    if (rel.includes('stylesheet') || rel.includes('modulepreload') || (rel.includes('preload') && (as === 'script' || as === 'style'))) add(attr(m[0], 'href'));
  }
  for (const m of head.matchAll(/<script\b[^>]*>/gi)) add(attr(m[0], 'src'));
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Text a page shows without running scripts, below which it is a client-rendered shell. */
export const THIN_TEXT_CHARS = 64;

/** A page whose HTML holds (almost) no text outside its scripts and styles: rendered by scripts, so its HTML says little. */
export function isThinHtml(html: string): boolean {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < THIN_TEXT_CHARS;
}

/** SHA-256 of a text or bytes, hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A stylesheet's same-site `@import` targets (r1-2a), absolute, in order; others are left to the page's own refs. */
export function cssImports(css: string, cssUrl: string, site: string): AssetRef[] {
  const out = new Map<string, AssetRef>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')/gi)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (!raw) continue;
    let abs: URL;
    try {
      abs = new URL(raw, cssUrl);
    } catch {
      continue;
    }
    if ((abs.protocol !== 'http:' && abs.protocol !== 'https:') || !sitemapHostAllowed(abs.href, site)) continue;
    abs.hash = '';
    const id = assetIdentity(abs.href);
    if (!out.has(id)) out.set(id, { id, url: abs.href });
  }
  return [...out.values()];
}

/** The page's HTML as the browser would show it before scripts ran: characters of text and elements (r1-2b). */
export function staticCounts(html: string): { text: number; elements: number } {
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' <$1></$1> ');
  const elements = [...clean.matchAll(/<[a-zA-Z][\w-]*/g)].length;
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(clean)?.[1] ?? clean;
  const text = body.replace(/<(noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length;
  return { text, elements };
}

/**
 * Scripts build what people see: the rendered DOM (after load and the scroll pass) has materially more
 * elements or text than the HTML (r1-2b). Errs toward auditing: more than 20% and 25 elements more, or
 * more than 20% and 200 characters more text.
 */
export function renderedDiffers(fromHtml: { text: number; elements: number }, rendered: { text: number; elements: number }): boolean {
  return rendered.elements > fromHtml.elements * 1.2 + 25 || rendered.text > fromHtml.text * 1.2 + 200;
}
