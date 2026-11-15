// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Pure helpers for the cross-page consistency rules (WCAG 2.4.5, 3.2.3, 3.2.4, 3.2.6): link
// identity, label normalisation and help-mechanism detection. Engine core: no Node-only imports.
import { normalizeUrl, urlKey } from '../url.js';

/** Index file names that address the same page as their folder (`/about/index.html` = `/about`). */
const INDEX_FILE = /\/(index|default)\.(html?|php|aspx?|jsp|cfm)$/i;

/**
 * Identity of a link target across pages: scheme, `www.`, fragment, tracking parameters, the
 * order of query parameters, a trailing slash and an index file name do not matter; the rest of
 * the query does (`?page_id=12` names a different page). `tel:` keeps only the last 10 digits and
 * `mailto:` only the lower-cased address. Undefined for anything that is not a page, phone or email
 * address (`javascript:`, empty).
 */
export function linkKey(href: string, base?: string): string | undefined {
  const raw = href.trim();
  if (/^tel:/i.test(raw)) {
    const digits = raw.slice(4).replace(/\D/g, '');
    return digits.length >= 3 ? `tel:${digits.slice(-10)}` : undefined;
  }
  if (/^mailto:/i.test(raw)) {
    const addr = decodeURIComponent(raw.slice(7).split('?')[0]!.split(',')[0]!).trim().toLowerCase();
    return addr.includes('@') ? `mailto:${addr}` : undefined;
  }
  const n = normalizeUrl(raw, base);
  if (!n) return undefined;
  const u = new URL(n);
  if (INDEX_FILE.test(u.pathname)) u.pathname = u.pathname.replace(INDEX_FILE, '') || '/';
  return urlKey(u.href);
}

/** A short form of a URL for evidence text: its path and query, or the address itself. */
export function shortUrl(url: string): string {
  if (/^(tel|mailto):/i.test(url)) return url.replace(/^(tel|mailto):/i, '');
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}

// Labels -------------------------------------------------------------------------------------------

/**
 * State and destination notes that sites add to a name and that do not change what the control
 * does: "current page", "(selected)", "opens in a new window", "external link"…
 */
const STATE_NOTES = [
  /\(?\b(current(ly)?( page| section| item)?|you are here|selected|active)\b\)?/g,
  /\(?\b(opens?|will open|opening)( (in|on))?( a)? new (window|tab)\b\)?/g,
  /\(?\b(external|outside) (link|site|website)\b\)?/g,
  /\(?\blink is external\b\)?/g,
];

/**
 * Lower case, compatibility forms, no state notes, no punctuation, symbols or numbers, single
 * spaces. Numbers go because counts and dates ("Cart (2)", "Events 2026") change from page to page
 * without the control changing.
 */
export function normalizeLabel(s: string): string {
  let t = s.normalize('NFKC').toLowerCase();
  for (const re of STATE_NOTES) t = t.replace(re, ' ');
  return t.replace(/[^\p{L}\p{M}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Words that do not identify a function ("Contact" and "Contact us" name the same thing). */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'our', 'us', 'your', 'my', 'me', 'we', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'by', 'with',
  'page', 'here', 'go', 'view', 'see', 'more', 'all', 'link', 'button', 'menu', 'item',
]);

const TOKENS = new Map<string, ReadonlySet<string>>();

/** The words of a label that identify it (normalised, without stop words, unless that is all it has: "Go", "Menu"). */
export function labelTokens(s: string): ReadonlySet<string> {
  let t = TOKENS.get(s);
  if (!t) {
    const words = normalizeLabel(s).split(' ').filter(Boolean);
    const kept = words.filter((w) => !STOP_WORDS.has(w));
    t = new Set(kept.length ? kept : words);
    // Names repeat across pages (menus): a small memo keeps the comparison of large sites cheap.
    if (TOKENS.size > 20_000) TOKENS.clear();
    TOKENS.set(s, t);
  }
  return t;
}

/**
 * How two sets of names for the same component compare. `same`: some name on one page matches one
 * on the other (after normalising and dropping stop words). `different`: no word in common at all
 * ("Search" and "Go"). `ambiguous`: some words shared, others not ("News" and "News and events"),
 * which the AI judges. `unnamed`: one side has no name at all (axe's naming rules report that).
 */
export function compareLabels(a: readonly string[], b: readonly string[]): 'same' | 'different' | 'ambiguous' | 'unnamed' {
  const ta = a.map(labelTokens).filter((t) => t.size);
  const tb = b.map(labelTokens).filter((t) => t.size);
  if (!ta.length || !tb.length) return 'unnamed';
  const key = (t: ReadonlySet<string>) => [...t].sort().join(' ');
  const kb = new Set(tb.map(key));
  if (ta.some((t) => kb.has(key(t)))) return 'same';
  const share = ta.some((x) => tb.some((y) => [...x].some((w) => y.has(w))));
  return share ? 'ambiguous' : 'different';
}

// Help mechanisms (3.2.6) --------------------------------------------------------------------------

export type HelpType = 'phone' | 'email' | 'contact' | 'help' | 'chat';

/** Words of a contact page or contact form link, in a few common languages. */
const CONTACT = /\b(contact(o|ez|ar|s)?|contact[-_ ]?us|cont[aá]ctenos|get in touch|kontakt(ieren)?|nous joindre|reach us)\b/i;
/** Words of self-help: FAQ, help and support pages. */
const HELP = /\b(faqs?|frequently asked( questions)?|help( ?desk| ?center| ?centre)?|support|ayuda|preguntas frecuentes|aide|hilfe)\b/i;
/** Words of a chat or messaging service. */
const CHAT = /\b(live ?chat|chat( with us| now)?|chatbot|message us|text us)\b/i;

/**
 * The pattern the page collector uses to pick candidate links (a superset of `helpType`), so the
 * in-page code stays small and the rules stay here, unit-tested.
 */
export const HELP_CANDIDATE_PATTERN = /contact|kontakt|joindre|get in touch|reach us|faq|frequently asked|help|support|ayuda|preguntas|aide|hilfe|chat|message us|text us/i;

/** What kind of help mechanism a link is, from its address and name, or undefined. */
export function helpType(href: string, name: string): HelpType | undefined {
  if (/^tel:/i.test(href)) return 'phone';
  if (/^mailto:/i.test(href)) return 'email';
  let path = '';
  try {
    path = decodeURIComponent(new URL(href).pathname).replace(/[-_/.]+/g, ' ');
  } catch {
    path = '';
  }
  if (CHAT.test(name)) return 'chat';
  if (CONTACT.test(name) || CONTACT.test(path)) return 'contact';
  if (HELP.test(name) || HELP.test(path)) return 'help';
  return undefined;
}

// Multiple ways (2.4.5) ------------------------------------------------------------------------------

/** Links to a site map, site index or A–Z index (an HTML page, not sitemap.xml). */
export const SITEMAP_PATTERN = /\b(site ?map|site index|a ?(-|–|to) ?z( index)?|mapa del sitio|plan du site)\b/i;

export function isSitemapLink(href: string, name: string): boolean {
  if (SITEMAP_PATTERN.test(name)) return true;
  try {
    return /\/(site-?map|site-?index|a-?z(-index)?)(\.(html?|php|aspx?))?$/i.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

/** Query parameters that carry a search, so the page is a results page. */
const SEARCH_PARAMS = ['q', 's', 'query', 'search', 'keyword', 'keywords', 'term', 'searchterm'];

/**
 * A page that is a step in a process or the result of one (2.4.5's exception), when that is clear
 * from the address or the page: a search results page (a search parameter with a value), a numbered
 * step, a thank-you or confirmation page, or a page marking its current step (`aria-current="step"`).
 */
export function processStepReason(url: string, markedStep: boolean): string | undefined {
  if (markedStep) return 'it marks a step in a process';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  for (const p of SEARCH_PARAMS) if (u.searchParams.get(p)?.trim()) return 'it is a search results page';
  const segments = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (segments.some((s) => /^(step|stage)[-_]?\d+$/.test(s)) || /^\d+$/.test(u.searchParams.get('step') ?? '')) return 'it is a step in a process';
  if (segments.some((s) => /^(thank[-_]?you|thanks|confirmation|confirmed)(\.(html?|php|aspx?))?$/.test(s))) return 'it is a confirmation page';
  return undefined;
}
