// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i;
/** Document file extensions (lower case). Shared with the document detector (`documents/detect.ts`). */
export const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'ppsx', 'odp'] as const;
const DOCUMENT_EXT = new RegExp(`\\.(${DOCUMENT_EXTENSIONS.join('|')})$`, 'i');
const NON_PAGE_EXT =
  /\.(jpe?g|png|gif|svg|webp|avif|ico|bmp|css|js|mjs|json|xml|txt|csv|zip|gz|mp4|mp3|mov|webm|wav|woff2?|ttf|eot|ics|rss|atom)$/i;

/** Canonical, fetchable form of a URL, or null if it isn't an http(s) URL. */
export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  // One rebuild of the query, not a delete per tracking parameter: each delete re-serialises the whole
  // query, so a site address with thousands of them was quadratic (20,000 took 10 s).
  const params = [...u.searchParams];
  const kept = params.filter(([key]) => !TRACKING_PARAM.test(key));
  if (kept.length !== params.length) u.search = new URLSearchParams(kept).toString();
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = withoutTrailingSlashes(u.pathname);
  return u.href;
}

/** The path without its trailing slashes (`/\/+$/` rescanned every run of slashes from each one). */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

export function hostKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** Identity used for de-duplication: ignores scheme and a leading www. */
export function urlKey(href: string): string {
  const u = new URL(href);
  return `${hostKey(u.hostname)}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}`;
}

/**
 * A directory's index file by its conventional names (the web servers' defaults: Apache and nginx
 * `index.html`, `index.php`; IIS `default.aspx`, `default.htm`), in the case servers use: the address a
 * server may answer the directory itself with. Case is never folded (`/a/INDEX.HTML` is its own address).
 */
const DIRECTORY_INDEX = /\/(?:index\.(?:html?|php|aspx?|shtml|jsp|cfm)|default\.(?:html?|aspx?))$/;

/**
 * The directory address an index-file address may stand for (`/news/index.html` → `/news/`), or null: not an
 * index file by name, or it has a query (an index file with parameters can be another page). Their names
 * alone never make the two one page (review r1, 2026-11-10: `/a` and `/a/index.html` can hold different
 * content): discovery asks the server (src/crawl.ts `indexAliases`).
 */
export function directoryOfIndex(href: string): string | null {
  const u = new URL(href);
  if (u.search || !DIRECTORY_INDEX.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(DIRECTORY_INDEX, '/');
  return normalizeUrl(u.href);
}

/**
 * Why an address was not visited: it looks like an action (signing out, deleting, unsubscribing, a link
 * that carries a token). Shown in a scan's list of addresses it left out.
 */
export const ACTION_SKIP_REASON = 'Not visited (looks like an action)';

/** A whole path segment, query name or query value that names an action (compared without `-` and `_`). */
const ACTION_NAMES = new Set([
  'logout', 'logoff', 'signout', 'signoff', 'delete', 'remove', 'destroy', 'purge', 'unsubscribe', 'optout', 'cancel', 'confirm',
  'approve', 'reject', 'vote', 'like', 'subscribe', 'reset',
]);
/** Query names that carry a command or a signature, whatever their value. */
const ACTION_KEYS = new Set(['action', 'do', 'cmd', 'op', 'sig']);
/** Query names that carry a secret of one visitor or one request (`token`, `csrf_token`, `_wpnonce`, `signature`). */
const SECRET_KEY = /token|nonce|csrf|signature/;
/** A token that only says where a list goes on (`pageToken`, `nextPageToken`, `continuationToken`, `cursor_token`): no secret. */
const PAGING_TOKEN = /^(?:next)?[-_]?(?:page|continuation|cursor|sync)[-_]?token$/;
/** A file extension, left out when a path segment is read (`/logout.php`, `/logout.xhtml` are `/logout`). */
const EXTENSION = /\.[a-z0-9]{1,6}$/;

/** A path segment, query name or value as a bare name: decoded, without path parameters (`;jsessionid=…`), extension, `-` and `_`. */
function nameOf(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    // keep the raw text
  }
  return s.split(';')[0]!.toLowerCase().replace(EXTENSION, '').replace(/[-_]/g, '');
}

/**
 * The address looks like an action rather than a page (review r1, 2026-11-10: discovery took `/logout`,
 * `/delete?id=7` and `/unsubscribe?token=abc` from links and from navigation written as script, and loaded
 * them). Discovery never requests such an address: one filter for every way a page list is made
 * (`selectPages`, the long scan's first list and its crawl).
 *
 * By whole names only, so that content is not taken for an action:
 * - a path segment that **is** an action's name (`/logout`, `/log-out`, `/account/delete`, `/confirm.aspx`),
 *   never one that only holds the word (`/events/cancelled-meetings-2025`, `/reset-password`,
 *   `/news/vote-by-mail-guide` are pages);
 * - a query name or a whole query value that is one (`?logout`, `?mode=delete`), a query name that carries
 *   a command (`action`, `do`, `cmd`, `op`) or a secret (`token`, `nonce`, `csrf`, `signature`, `sig`; a
 *   paging token such as `pageToken` is none). Path parameters (`;jsessionid=…`) and a file extension are
 *   not part of a segment's name.
 * A name the start address itself carries does not count (a scan started at `/vote/` visits `/vote/...`).
 * The cost, on purpose: a page whose address is exactly `/subscribe` or `/vote` is not visited unless the
 * scan starts there; it is listed with `ACTION_SKIP_REASON`.
 */
export function isActionLikeUrl(href: string, start?: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  const own = new Set<string>();
  if (start) {
    try {
      for (const seg of new URL(start).pathname.split('/')) own.add(nameOf(seg));
    } catch {
      // no start address to compare with
    }
  }
  for (const seg of u.pathname.split('/')) {
    const name = nameOf(seg);
    if (ACTION_NAMES.has(name) && !own.has(name)) return true;
  }
  for (const [key, value] of u.searchParams) {
    const k = key.toLowerCase();
    if (ACTION_KEYS.has(k) || (SECRET_KEY.test(k) && !PAGING_TOKEN.test(k))) return true;
    if (ACTION_NAMES.has(nameOf(key)) || ACTION_NAMES.has(nameOf(value))) return true;
  }
  return false;
}

export function sameSite(a: string, b: string): boolean {
  return hostKey(new URL(a).hostname) === hostKey(new URL(b).hostname);
}

export function isDocumentUrl(href: string): boolean {
  return DOCUMENT_EXT.test(new URL(href).pathname);
}

/** True for addresses whose extension names a known non-page, non-document file (image, script, zip…). */
export function isNonPageAsset(href: string): boolean {
  return NON_PAGE_EXT.test(new URL(href).pathname);
}

export function isLikelyHtml(href: string): boolean {
  const path = new URL(href).pathname;
  return !NON_PAGE_EXT.test(path) && !DOCUMENT_EXT.test(path);
}

/**
 * A site address typed without a scheme ("example.org", "www.example.org/news", "localhost:8080") gets https:// in
 * front (batch 19, first-run correctness: most people type the bare domain). Anything else is returned as given.
 */
export function withScheme(input: string): string {
  const t = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  // A file name ("report.json") is not taken for a host.
  if (/^[^/?#]+\.(?:json|html?|md|txt|csv|pdf|xml|js|ts)$/i.test(t)) return t;
  if (/^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?(?:[/?#]|$)/i.test(t)) return `https://${t}`;
  return t;
}
