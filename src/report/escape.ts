// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// HTML escaping shared by the HTML outputs. Everything from a scanned site or a model goes through these.

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) links are rendered as links; everything else becomes plain text. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function link(url: string, text = url): string {
  const href = safeHref(url);
  return href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
}

/** The last path segment of a URL, decoded (e.g. "agenda.pdf"), or '' when there is none. */
export function fileNameOf(url: string): string {
  let last = '';
  try {
    last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A link labelled with the URL's file name (the full URL when it has none). Non-http(s) URLs become plain text. */
export function fileLink(url: string): string {
  return safeHref(url) ? link(url, fileNameOf(url) || url) : esc(url);
}
