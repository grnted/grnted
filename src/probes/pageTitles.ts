// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.4.2 Page Titled, beyond "the page has a title" (which axe checks): a title that cannot describe
// the page's topic or purpose (failure technique F25). Deterministic rules only, on every page that loaded.
//
// Failed, on one page, only for the definite cases F25 itself names:
// - a known placeholder: "Untitled", "Untitled Document", "New Page", "Document", "Page", "Page Title",
//   "Insert title here", a site builder's default ("Sample Page", "My Site");
// - a file name that is not descriptive in its own right: a default name (index.html, page1.htm,
//   untitled.html), a number or a hash. A file name that describes the page (meeting-agendas.html) is not
//   failed.
// Not failed, only "not testable" (a person, or the AI page-text review, has to judge whether the title
// describes the page):
// - "Home" on a page that is not the site's home page, when nothing else in the title names the page (failed where the
//   site's pages demonstrate it: `genericTitleFindings`, below);
// - across the scanned pages (`acrossPages`): the same title on pages about different things (their main
//   headings differ and share no word with the title), never on the start page; and a title that is the site's
//   name alone (the part at least half of the scanned pages' titles share).
// Nothing is concluded from a title that only happens to be another page's main heading ("Contact" on the contact
// page, beside a directory headed "Contact": review r1, finding 9).
// A doubt across the scanned pages since batch 17 (structure lane), the stale title, on two facts together:
// - the title's own part (the site's name left out; two topic words or more) is, word for word, the main heading
//   of ANOTHER scanned page that its own title names too; and
// - none of the title's words is in this page's main heading, its other headings, the text of its main content,
//   its description or its address (read on the page: `TitleData.hits`).
// The title may name another page of the site (F25: a title copied with a template or a page and never changed);
// but a page can be about its title in other words, so this is listed for a person, never failed (Sol review of
// batch 17, S3). The second fact alone (a title none of whose words the page uses, that is no other page's heading)
// is a doubt too, where it used to pass in silence.
// Failed across the scanned pages since batch 17's fix round (lead's ruling (c)), a generic title or the site's name
// alone, only where the site demonstrates it (`genericTitleFindings`):
// - a page that is not the home page, titled with a generic word ("Home", "Welcome", "Index"…) and nothing but the
//   site's name besides, whose own level-1 heading, in text, names something else (a word that is in neither the
//   title nor the home page's title and heading); or
// - the site's name alone as the title of two or more scanned pages (not the home page) whose main headings differ,
//   each heading naming something else.
// A one-page scan, a home page in another language, a heading that is a picture or the same on several pages, and a
// heading that shares a word with the title stay as they were (the one-page "Home" doubt, or nothing).
// A title is compared with the page's main heading by its words (stop words and endings left out): a title
// that shares a topic word with its own heading raises no doubt. Engine core: no Node-only imports.
import type { ProbeFinding, ProbeRun } from '../types.js';
import type { PageProbe, ProbeContext } from './types.js';

export const PAGE_TITLES_PROBE_ID = 'page-titles';

/** What the test reads on a page (`ProbeRun.data`). */
export interface TitleData {
  v: 1;
  /** document.title, spaces collapsed (max 300). */
  title: string;
  /** The page's main heading: its first level-1 heading with text, else its first heading (max 200). */
  h1: string;
  /**
   * Since batch 17's fix round: `h1` is a level-1 heading (not the first heading of another level), and it shows text
   * of its own (`h1text`: not only a picture's text alternative or an aria-label). Absent in data read before
   * 2026-11-12, and then the rule that needs them (`genericTitleFindings`) concludes nothing.
   */
  h1top?: boolean;
  h1text?: boolean;
  /**
   * Since batch 17: the title's words (as `topicWords` reads them) that the page itself uses: anywhere in its text
   * (side columns and the links in them too), in the text alternatives and labels of its elements, in its
   * description or in its address. Left out: its menus (navigation), which name every other page; a breadcrumb
   * trail and a link marked as the current page are read even there, since they say where this page is. The
   * words found only in the page's own header and footer are kept apart (`frameHits`). Absent in data read
   * before 2026-11-12, and then nothing is concluded from it.
   */
  hits?: string[];
  /**
   * The title's words found in the page's own header or footer (not those of an article or a section), and a
   * fingerprint of all the text there (`frame`: its word count and a hash). They count as the page's own words
   * unless most of the site's pages have the very same header and footer text: the site's frame around every
   * page says nothing about one page.
   */
  frameHits?: string[];
  frame?: string;
  /**
   * Where the page's own content leads: a short hash (`pathHash`) of each address of this site that a link or a
   * form of its content goes to (the menus and the page's own header and footer left out; at most 150).
   */
  out?: string[];
  /** Topic words of content read for `hits`. */
  read?: number;
  /** The read stopped at `TITLE_LIMITS` before the end of the page: "no word of the title is on it" is not known. */
  partial?: true;
  /** The page's language as its markup says it (the primary subtag of `html lang`, lower case). */
  lang?: string;
  /** Addresses (path and query) of the page's other-language versions (`link rel="alternate" hreflang`, at most 10). */
  alts?: string[];
  /**
   * The words of the page's own content (its header, footer, side columns and menus left out), and how many of
   * them are common English function words: tells an English text from one in another language.
   */
  words?: number;
  en?: number;
}

/** Limits of the content read for `TitleData.hits`. */
export const TITLE_LIMITS = { nodes: 20_000, chars: 200_000 } as const;
/** Words of its own content a page needs before "none of the title's words is on it" is said. */
export const STALE_MIN_WORDS = 20;
/** Topic words the title's own part needs before it can be said to name another page. */
export const STALE_MIN_NAME_WORDS = 2;

export const isTitleData = (d: unknown): d is TitleData =>
  !!d && typeof d === 'object' && (d as TitleData).v === 1 && typeof (d as TitleData).title === 'string' && typeof (d as TitleData).h1 === 'string';

/**
 * Runs in the page (self-contained): the title and the main heading; with `arg` also which of the title's words
 * the page's own content uses (`TitleData.hits`). `arg.stop`: the stop words of `topicWords`; `arg.probe`: words
 * to return as this function reads them (the unit test's check that it reads words as `topicWords` does).
 */
export function readTitle(arg?: { stop: readonly string[]; nodes: number; chars: number; probe?: readonly string[] }): { title: string; h1: string; h1top?: boolean; h1text?: boolean; hits?: string[]; read?: number; partial?: true; lang?: string; alts?: string[]; words?: number; en?: number; frameHits?: string[]; frame?: string; out?: string[]; probed?: string[] } {
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const shown = (el: Element) => {
    const e = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    return typeof e.checkVisibility === 'function' ? e.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
  };
  const text = (el: Element) => clean(el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || el.querySelector('img[alt]')?.getAttribute('alt'), 200);
  let h1 = '';
  /** The main heading is a level-1 heading, and it shows text of its own (not only a picture's text or a label). */
  let h1top = false;
  let h1text = false;
  const firsts = document.querySelectorAll('h1, [role="heading"][aria-level="1"]');
  for (let i = 0; i < firsts.length && i < 20 && !h1; i++) {
    if (!shown(firsts[i]!)) continue;
    h1 = text(firsts[i]!);
    h1top = !!h1;
    h1text = !!h1 && !!clean((firsts[i] as HTMLElement).innerText || firsts[i]!.textContent, 200);
  }
  if (!h1) {
    const any = document.querySelectorAll('h2, h3, [role="heading"]');
    for (let i = 0; i < any.length && i < 40 && !h1; i++) if (shown(any[i]!)) h1 = text(any[i]!);
  }
  const title = clean(document.title, 300);
  if (!arg) return { title, h1, ...(h1 ? { h1top, h1text } : {}) };
  // The same reading of words as `topicWords` (kept in step by test/unit/pageTitles.test.ts).
  const STOP = new Set(arg.stop);
  const stem = (word: string): string => {
    let w = word.replace(/ies$/, 'y');
    if (w.length > 3 && !w.endsWith('ss')) w = w.replace(/s$/, '');
    if (w.length > 5) w = w.replace(/(ing|ed)$/, '');
    return w.length > 3 ? w.replace(/e$/, '') : w;
  };
  const wordsOf = (text: string): string[] => {
    const out: string[] = [];
    for (const w of text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/)) if (w.length >= 2 && !STOP.has(w)) out.push(stem(w));
    return out;
  };
  const wanted = new Set(wordsOf(title));
  const hits = new Set<string>();
  // The words of the title found only in the page's own header and footer (the site's frame around every page),
  // and a fingerprint of that frame's text: where most of the site's pages have the very same frame, a word in it
  // says nothing about this page (`titleFindingsAcross`).
  const frameHits = new Set<string>();
  let frame = 2166136261;
  let framed = 0;
  let read = 0;
  let all = 0;
  let en = 0;
  let partial = false;
  // Function words of English that no other widely written language shares: their share of a text tells an English
  // text from one in another language (`ENGLISH_SHARE`).
  const EN = new Set(['the', 'and', 'of', 'to', 'for', 'is', 'are', 'with', 'from', 'this', 'that', 'you', 'your', 'will', 'be', 'or', 'by', 'it', 'not', 'have', 'were', 'can', 'our', 'we', 'they', 'their', 'which', 'but', 'if', 'when', 'about', 'each', 'every', 'before', 'after', 'there', 'who', 'what', 'how', 'does', 'any']);
  // (`own`: text of the page's own content, not of the header, footer and side columns every page of a site shares:
  // the language of a page is told from it.)
  // (`inFrame`: text of the page's own header or footer.)
  const take = (text: string | null | undefined, own: boolean, inFrame = false) => {
    for (const w of (text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/)) {
      if (!w) continue;
      if (own) { all++; if (EN.has(w)) en++; }
      if (inFrame) { framed++; for (let i = 0; i < w.length; i++) frame = Math.imul(frame ^ w.charCodeAt(i), 16777619); frame = Math.imul(frame ^ 32, 16777619); }
      if (w.length < 2 || STOP.has(w)) continue;
      read++;
      const stemmed = stem(w);
      if (wanted.has(stemmed)) (inFrame ? frameHits : hits).add(stemmed);
    }
  };
  // The page's address and description.
  let path = location.pathname;
  try { path = decodeURIComponent(path); } catch { /* as it is */ }
  for (const w of wordsOf(path)) if (wanted.has(w)) hits.add(w);
  for (const w of wordsOf(document.querySelector('meta[name="description" i]')?.getAttribute('content') ?? '')) if (wanted.has(w)) hits.add(w);
  // Every word the page shows or holds, wherever it is (a title that names the site, a section, a side box or a
  // page this one links to in its text is about something on the page), except its menus (navigation), which name
  // every other page. A breadcrumb trail and a link marked as the current page say where THIS page is: read.
  const SKIP = 'script, style, noscript, template';
  const HERE = '[aria-current]:not([aria-current="false"]), [aria-label*="breadcrumb" i], [class*="breadcrumb" i], [id*="breadcrumb" i], [aria-label*="you are here" i], [aria-label*="trail" i], [class*="crumb" i], [id*="crumb" i], [itemtype*="BreadcrumbList" i]';
  const AWAY = 'nav, [role="navigation"]';
  const outside = (el: Element): boolean => !!el.closest(SKIP) || (!!el.closest(AWAY) && !el.closest(HERE));
  const SHARED = 'header, footer, aside, nav, [role="banner"], [role="contentinfo"], [role="complementary"], [role="navigation"]';
  /** In the page's own header or footer: not the header or footer of an article, a section or the main content. */
  const inFrameOf = (el: Element): boolean => {
    // (What is read inside a menu, the trail and the current page's link, says where THIS page is: never the frame.)
    if (el.closest(AWAY)) return false;
    const top = el.closest('header, footer, [role="banner"], [role="contentinfo"]');
    return !!top && !top.closest('main, article, section, aside, [role="main"]');
  };
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let nodes = 0;
    let chars = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (nodes >= arg.nodes || chars >= arg.chars) { partial = true; break; }
      nodes++;
      const t = n.nodeValue ?? '';
      if (!t.trim() || !n.parentElement || outside(n.parentElement)) continue;
      chars += t.length;
      take(t, !n.parentElement.closest(SHARED), inFrameOf(n.parentElement));
    }
    const named = document.body.querySelectorAll('img[alt], [aria-label], [title]');
    if (named.length > 2000) partial = true;
    for (let i = 0; i < named.length && i < 2000; i++) {
      const el = named[i]!;
      if (!outside(el)) take(`${el.getAttribute('alt') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`, false, inFrameOf(el));
    }
  }
  // Where the page's own content leads (links and forms outside the menus and the page's own header and footer):
  // a page that leads to another, or is led to from it, may belong with it (a section's page, a form's next step).
  const out = new Set<string>();
  const hashOf = (text: string): string => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };
  if (document.body) {
    const leads = document.body.querySelectorAll('a[href], area[href], form[action]');
    if (leads.length > 3000) partial = true;
    for (let i = 0; i < leads.length && i < 3000 && out.size < 150; i++) {
      const el = leads[i]!;
      if (el.closest(AWAY) || inFrameOf(el)) continue;
      try {
        const u = new URL(el.getAttribute('href') ?? el.getAttribute('action') ?? '', location.href);
        if (u.origin === location.origin && u.pathname !== location.pathname) out.add(hashOf(u.pathname));
      } catch { /* not an address */ }
    }
  }
  const lang = (document.documentElement.getAttribute('lang') ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  const alts: string[] = [];
  const links = document.querySelectorAll('link[rel~="alternate" i][hreflang][href]');
  for (let i = 0; i < links.length && alts.length < 10; i++) {
    try { const u = new URL(links[i]!.getAttribute('href') ?? '', location.href); if (u.origin === location.origin) alts.push(u.pathname + u.search); } catch { /* not an address */ }
  }
  return {
    title, h1, ...(h1 ? { h1top, h1text } : {}), hits: [...hits], read, words: all, en, ...(partial ? { partial: true as const } : {}), ...(lang ? { lang } : {}), ...(alts.length ? { alts } : {}),
    ...(frameHits.size ? { frameHits: [...frameHits] } : {}), ...(framed ? { frame: `${framed}:${(frame >>> 0).toString(36)}` } : {}),
    ...(out.size ? { out: [...out] } : {}),
    ...(arg.probe ? { probed: arg.probe.flatMap((w) => wordsOf(w)) } : {}),
  };
}

const quote = (s: string, n = 80) => `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;

/** Whole titles that are an editor's or a site builder's placeholder (F25's "Untitled Document"). */
export const PLACEHOLDER_TITLE = /^(untitled(\s+(document|page))?|(new\s+)?(page|document)|page\s+title|title|default|blank(\s+page)?|new\s+tab|(insert|enter|your|add)\s+(the\s+|a\s+)?(page\s+)?title(\s+(here|of\s+.*))?|sample\s+page|(your\s+)?site\s+title|my\s+(site|website|blog))$/i;
/** A title that is a web file's name. */
const FILE_TITLE = /^([\w.-]+)\.(html?|php|aspx?|jsp|cfm)$/i;
/** File names every editor and server gives by default: they describe nothing. */
const DEFAULT_FILE = /^(index|default|home|main|start|page|new|untitled|document|doc|test|temp|tmp|blank|noname|file)\d*$/i;
/**
 * A title that is a web file's name, and what its words say:
 * - `default`: not descriptive in its own right (F25): every word is a default name, with or without a number
 *   ("index.html", "page1.htm", "new-page-2.html"), a number or a hash ("48213.html");
 * - `short`: nothing but such words and words of one or two characters, with at least one of those ("hr.html",
 *   "cv.html"). A short word can name the page (HR, CV, IT): its length proves nothing, so this is a doubt;
 * - null: not a file name, or one with a word of its own ("public-meeting-agendas.html"), which describes the page.
 */
export function fileTitleKind(title: string): 'default' | 'short' | null {
  const m = FILE_TITLE.exec(title.trim());
  if (!m) return null;
  const words = m[1]!.split(/[-_.\s]+/).filter(Boolean);
  // A number, a hash (hex with a digit in it, 6 characters or more) or a default name: nothing describes the page.
  const empty = (w: string) => /^\d+$/.test(w) || (/^[0-9a-f]{6,}$/i.test(w) && /\d/.test(w)) || DEFAULT_FILE.test(w);
  if (words.every(empty)) return 'default';
  return words.every((w) => empty(w) || w.length < 3) ? 'short' : null;
}
/** The title is a file name that is not descriptive in its own right (F25): `fileTitleKind` 'default'. */
export const isDefaultFileTitle = (title: string): boolean => fileTitleKind(title) === 'default';
/** A title part that says the page is the home page. */
export const HOME_TITLE = /^(home|home\s?page)$/i;

/** Words that say nothing about a page's topic (the in-page read gets the same list: `readTitle`). */
export const TITLE_STOP_WORDS: readonly string[] = ['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'our', 'your', 'my', 'is', 'are', 'be', 'about', 'us', 'page', 'home', 'site', 'website', 'official', 'welcome', 'new', 'all'];
const STOP = new Set(TITLE_STOP_WORDS);
/** A word as the comparison reads it: lower case, a plural or verb ending left out. */
const stem = (word: string): string => {
  let w = word.replace(/ies$/, 'y');
  if (w.length > 3 && !w.endsWith('ss')) w = w.replace(/s$/, '');
  if (w.length > 5) w = w.replace(/(ing|ed)$/, '');
  return w.length > 3 ? w.replace(/e$/, '') : w;
};

/** The words of a title or heading that say what it is about (stop words left out). */
export function topicWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/** The two texts share a word that says what they are about. */
export function sharesTopic(a: string, b: string): boolean {
  const x = topicWords(a);
  for (const w of topicWords(b)) if (x.has(w)) return true;
  return false;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** A title's parts, as sites join them: "Plots | Marsh Lane Allotments", "Marsh Lane Allotments: Plots", "Home » Plots". */
export const titleParts = (title: string) => title.split(/\s+[|–—·»:>-]\s+|\s*[|»]\s*/).map((p) => p.trim()).filter(Boolean);

/** The site's home page: the scan's start page, or the root address. */
function isHome(url: string, index: number): boolean {
  if (index === 0) return true;
  try {
    return /^\/(index\.[a-z]+|home\/?|default\.[a-z]+)?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * The rules that need one page only. Failed: a placeholder title, a file name that describes nothing. Not
 * testable: "Home" on a page that is not the home page, and a file name of one or two characters (doubts, for a
 * person to judge).
 */
export function ownTitleFindings(d: TitleData, url: string, index: number): ProbeFinding[] {
  const title = d.title;
  if (!title) return [];
  const heading = d.h1 ? ` (its main heading is ${quote(d.h1)})` : '';
  if (PLACEHOLDER_TITLE.test(title)) {
    return [{ criterion: '2.4.2', status: 'failed', target: 'title', detail: `The page's title is ${quote(title)}, which says nothing about the page${heading}.` }];
  }
  const file = fileTitleKind(title);
  if (file === 'default') {
    return [{ criterion: '2.4.2', status: 'failed', target: 'title', detail: `The page's title is ${quote(title)}, a file name that says nothing about the page${heading}.` }];
  }
  if (file === 'short') {
    return [{ criterion: '2.4.2', status: 'not_testable', target: 'title', detail: `The page's title is ${quote(title)}, a file name too short for the test to tell whether it names the page${heading}; that is for a person to judge.` }];
  }
  const parts = titleParts(title);
  if (d.h1 && !isHome(url, index) && parts.some((p) => HOME_TITLE.test(p)) && !/\bhome\b/i.test(d.h1) && !parts.some((p) => !HOME_TITLE.test(p) && sharesTopic(p, d.h1))) {
    return [{ criterion: '2.4.2', status: 'not_testable', target: 'title', detail: `The page's title is ${quote(title)}, though this is not the home page${heading}; whether that title describes the page is for a person to judge.` }];
  }
  return [];
}

/**
 * Words that name a kind of page rather than one page ("Frequently Asked Questions", "Meeting Agendas", "News and
 * Events"): a title made only of them may say what kind of page this is, in words the page itself never uses.
 */
const KIND_WORDS = topicWords('frequently asked questions question faq faqs contact contacts news event events calendar directory document documents form forms resource resources information info service services help support overview detail details general latest more link links quick search result results introduction update updates notice notices announcement announcements press release releases media gallery photo photos video videos blog post posts article articles archive archives download downloads publication publications report reports minutes agenda agendas meeting meetings staff team member members department departments program programs project projects career careers job jobs employment opportunity opportunities online portal center centre office main menu index list listing listings');
/** A page's directory: "/hr/" for "/hr", "/hr/" and "/hr/index.html". */
const dirOf = (path: string): string => {
  const p = path.replace(/[?#].*$/, '').replace(/\/(?:index|default|home)\.[a-z0-9]+$/i, '/');
  return p.endsWith('/') ? p : /\.[a-z0-9]+$/i.test(p) ? p.replace(/[^/]+$/, '') : `${p}/`;
};
/**
 * Running English text has the function words counted in `TitleData.en` as a sixth of its words or more, and a
 * terse English page of lists and tables seldom under 6% (429 English pages of the training sites: median 18%,
 * 1 in 100 under 6.8%); text in another language has next to none. Between the two (a page in another language
 * with English boilerplate in its content, a page of names and figures) the language is not told.
 */
export const ENGLISH_SHARE = { english: 0.06, other: 0.02, words: 40 } as const;
/** Whether a page's own content reads as English ('en') or as another language ('other'); null where it cannot be told. */
const tongueOf = (d: Pick<TitleData, 'words' | 'en'>): 'en' | 'other' | null => {
  if ((d.words ?? 0) < ENGLISH_SHARE.words || typeof d.en !== 'number') return null;
  const share = d.en / d.words!;
  return share >= ENGLISH_SHARE.english ? 'en' : share <= ENGLISH_SHARE.other ? 'other' : null;
};

/**
 * What else may explain a title that is another page's main heading and has no word on this page (pure; batch 17,
 * after review): null when nothing does, and the title is then the other page's, left on this one. Else the
 * reason, and the title stays a doubt:
 * - the other page is the site's home page (the title is the site's name);
 * - this page lies under the other page (the title names the section it is in), or is the same address with
 *   another query;
 * - the other page's content leads to this page, or this page's to it (a section's first page and its pages, a
 *   form and its next step: `TitleData.out`);
 * - other pages carry the title too (a section's or a kind's name, not one page's);
 * - every word of the title names a kind of page ("Frequently Asked Questions");
 * - the two pages are in different languages, by their markup or by their words, or are each other's translation
 *   (the title may describe this page in the other language); and where the language of either could not be told.
 */
export function staleDoubt(
  p: TitleData & { page: string; index: number }, others: readonly (TitleData & { page: string; index: number })[], name: string, alsoTitled: number,
): { why: string; page: string } | null {
  const path = (u: string) => { try { const x = new URL(u); return { path: x.pathname, full: x.pathname + x.search }; } catch { return { path: u, full: u }; } };
  const mine = path(p.page);
  const first = others[0]?.page ?? p.page;
  if (alsoTitled > 0) return { why: `${alsoTitled === 1 ? 'another scanned page carries' : `${alsoTitled} other scanned pages carry`} that title too, so it may name a section of the site`, page: first };
  if ([...topicWords(name)].every((w) => KIND_WORDS.has(w))) return { why: 'its words name a kind of page, not one page', page: first };
  for (const q of others) {
    const theirs = path(q.page);
    const say = (why: string) => ({ why, page: q.page });
    if (isHome(q.page, q.index)) return say('that page is the site\'s home page, so the title may be the site\'s name');
    if (theirs.path === mine.path) return say('the two are one address');
    const dir = dirOf(theirs.path);
    if (dir !== '/' && mine.path.startsWith(dir)) return say('this page lies under that page, so the title may name the section it is in');
    // (A section's first page lists its pages; a form leads to its next step; a page points back to where it belongs.)
    if ((q.out ?? []).includes(pathHash(mine.path))) return say('that page leads to this one from its content, so this page may belong to the section, or the task, that page heads');
    if ((p.out ?? []).includes(pathHash(theirs.path))) return say('this page leads to that page from its content, so the two may belong together');
    if (p.lang && q.lang && p.lang !== q.lang) return say('the two pages are marked as being in different languages');
    if ((p.alts ?? []).includes(theirs.full) || (q.alts ?? []).includes(mine.full)) return say('the two pages are marked as each other\'s translation');
    const a = tongueOf(p);
    const b = tongueOf(q);
    if (a === null || b === null) return say('the language of one of the two pages could not be told from its words');
    if (a !== b) return say('the two pages read as being in different languages');
  }
  return null;
}

/** The hash `readTitle` keeps of an address a page's content leads to (FNV-1a of the path, base 36). */
export function pathHash(path: string): string {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** A title part that is a generic word: it names no page ("Home", "Welcome", "Index", "Main page"…). */
export const GENERIC_TITLE_PART = /^(home(\s?page)?|welcome|index|main(\s+page)?|start(\s+page)?|default(\s+page)?|landing(\s+page)?|front\s+page)$/i;
/** A site's home page in another language ("/es/", "/fr-ca/index.html"): a home page too. */
const LANGUAGE_HOME = /^\/[a-z]{2}(?:[-_][a-z]{2,4})?\/?(?:(?:index|default|home)(?:\.[a-z0-9]+)?\/?)?$/i;

/**
 * A generic title, or the site's name alone, demonstrated wrong by the site's own pages (2.4.2, F25; lead's ruling (c)
 * in batch 17's fix round). Fails a page, never the start page or a home page by its address, only where:
 * - the page has a level-1 heading that shows text of its own (`TitleData.h1top`, `h1text`; a heading that is a picture
 *   says nothing), that no other scanned page has (a heading every page shares is the site's, not the page's), and
 *   that shares no word with the title; that heading names something else: at least one of its words is in neither the
 *   title, the start page's title and main heading, nor the site's name;
 * - the title is made of generic words ("Home", "Welcome": `GENERIC_TITLE_PART`) and the site's name only, with at
 *   least one generic word (A); OR it is the site's name alone and two or more scanned pages that are not the home page
 *   carry it with different main headings (B). The site's name: a title part that at least half of the scanned pages
 *   have (on three or more, of four pages or more), the start page's title, or the one part of it that is no generic
 *   word.
 * A one-page scan decides nothing here (the page alone cannot tell the home page from another: the one-page "Home"
 * doubt stays). A landing page that alone carries the site's name, a page whose heading is a picture, a heading that
 * shares a word with the title or holds the generic word itself, and a page in another language than the start page
 * (it may be that language's home page) are left as they were. Pure. Pages a one-page rule failed are left out; the one-page
 * "Home" doubt is settled by this failure (`acrossSettles`).
 */
export function genericTitleFindings(runs: readonly { run: ProbeRun; index: number }[]): Map<string, ProbeFinding[]> {
  const out = new Map<string, ProbeFinding[]>();
  const pages = runs
    .filter(({ run }) => run.status === 'ok' && isTitleData(run.data) && !run.findings.some((f) => f.status === 'failed'))
    .map(({ run, index }) => ({ page: run.page, index, ...(run.data as TitleData) }))
    .filter((p) => p.title);
  if (pages.length < 2) return out;
  const start = pages.find((p) => p.index === 0);
  if (!start) return out;
  const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  const homeLike = (p: (typeof pages)[number]) => p === start || isHome(p.page, p.index) || LANGUAGE_HOME.test(pathOf(p.page).replace(/[?#].*$/, ''));
  // The site's name: a part at least half of the pages' titles have (of four pages or more), the start page's title,
  // and the one part of it that is no generic word.
  const names = new Set<string>([norm(start.title)]);
  const partCount = new Map<string, number>();
  for (const p of pages) for (const part of new Set(titleParts(p.title).map(norm))) partCount.set(part, (partCount.get(part) ?? 0) + 1);
  if (pages.length >= 4) for (const [part, n] of partCount) if (n >= 3 && n * 2 >= pages.length) names.add(part);
  const startOwn = titleParts(start.title).filter((x) => !GENERIC_TITLE_PART.test(x));
  if (startOwn.length === 1) names.add(norm(startOwn[0]!));
  const homeWords = topicWords(`${start.title} ${start.h1} ${[...names].join(' ')}`);
  const headed = new Map<string, number>();
  for (const p of pages) if (p.h1) headed.set(norm(p.h1), (headed.get(norm(p.h1)) ?? 0) + 1);
  const byTitle = new Map<string, typeof pages>();
  for (const p of pages) byTitle.set(norm(p.title), [...(byTitle.get(norm(p.title)) ?? []), p]);
  for (const p of pages) {
    if (homeLike(p) || !p.h1 || p.h1top !== true || p.h1text !== true || (headed.get(norm(p.h1)) ?? 0) > 1 || sharesTopic(p.title, p.h1)) continue;
    // A page in another language than the start page (by its markup, by a translation link, or by its words) may be
    // the home page of that language ("/espanol/" titled "Home"): not judged here.
    const tongue = tongueOf(p);
    const startTongue = tongueOf(start);
    // (A start page with no language in its markup is taken for English, the language of the generic words.)
    if ((p.lang && p.lang !== (start.lang || 'en')) || tongue === 'other' || (tongue && startTongue && tongue !== startTongue)
      || (p.alts ?? []).includes(pathOf(start.page)) || (start.alts ?? []).includes(pathOf(p.page))) continue;
    const parts = titleParts(p.title);
    if (!parts.length || parts.some((x) => !GENERIC_TITLE_PART.test(x) && !names.has(norm(x)))) continue;
    const generic = parts.filter((x) => GENERIC_TITLE_PART.test(x));
    // A heading that holds the generic word itself ("Home energy rebates" under "Home", "Welcome new residents" under
    // "Welcome") may be what the title was cut from: not judged (as the one-page "Home" doubt does).
    if (generic.some((g) => g.toLowerCase().split(/\s+/).some((w) => w !== 'page' && new RegExp(`\\b${w}\\b`, 'i').test(p.h1)))) continue;
    // (B) The site's name alone: carried by another page that is not the home page, headed otherwise.
    const twins = (byTitle.get(norm(p.title)) ?? []).filter((q) => q !== p && !homeLike(q) && q.h1 && norm(q.h1) !== norm(p.h1));
    if (!generic.length && !twins.length) continue;
    // Its heading names something else: a word of it that is in neither the title nor the home page's title, heading
    // or the site's name.
    const named = [...topicWords(p.h1)].filter((w) => !homeWords.has(w));
    if (!named.length) continue;
    const heading = quote(p.h1, 60);
    out.set(p.page, [{
      criterion: '2.4.2', status: 'failed', target: 'title',
      detail: generic.length
        ? `The page's title, ${quote(p.title)}, does not describe the page: it is ${generic.length === 1 ? `the word ${quote(generic[0]!)}` : 'generic words'}${parts.length > generic.length ? ' and the site\'s name' : ''}, while this is not the home page (${pathOf(p.page)}) and its main heading, ${heading}, names what it is about.`
        : `The page's title, ${quote(p.title)}, is the site's name alone, the title of ${twins.length === 1 ? 'another scanned page' : `${twins.length} other scanned pages`} as well (${pathOf(twins[0]!.page)}: ${quote(twins[0]!.h1, 60)}), so it does not tell this page from them; its main heading, ${heading}, names what it is about.`,
    }]);
  }
  return out;
}

/**
 * The rules that need every page's title (`PageProbe.acrossPages`). One fails a page: a generic title or the site's
 * name alone where the site demonstrates it (`genericTitleFindings`, lead's ruling (c)); its failure takes the place of
 * any doubt below for that page. The others never do: the stale title (the title's own part is another page's main
 * heading word for word, and the page uses none of its words; see the top of this file), the same title on pages about
 * different things, and a title that is the site's name alone, leave 2.4.2 "not testable" there (a person has to judge
 * whether the title describes the page). Pages with no main heading, the start page, and pages a one-page rule already
 * settled are left out of those; so is every page whose title shares a word with its own main heading. A title that is
 * another page's main heading is no sign of anything.
 */
export function titleFindingsAcross(runs: readonly { run: ProbeRun; index: number }[]): Map<string, ProbeFinding[]> {
  const out = new Map<string, ProbeFinding[]>();
  const pages = runs
    .filter(({ run }) => run.status === 'ok' && isTitleData(run.data) && !run.findings.some((f) => f.status === 'failed' || f.status === 'not_testable'))
    .map(({ run, index }) => ({ page: run.page, index, ...(run.data as TitleData) }))
    .filter((p) => p.title && p.h1);
  if (pages.length < 2) return out;
  const byTitle = new Map<string, typeof pages>();
  for (const p of pages) byTitle.set(norm(p.title), [...(byTitle.get(norm(p.title)) ?? []), p]);
  const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  /** Parts that at least half of the scanned pages' titles have (on three pages or more): the site's name. */
  const shared = new Set<string>();
  const partCount = new Map<string, number>();
  for (const p of pages) for (const part of new Set(titleParts(p.title).map(norm))) partCount.set(part, (partCount.get(part) ?? 0) + 1);
  if (pages.length >= 4) for (const [part, n] of partCount) if (n >= 3 && n * 2 >= pages.length) shared.add(part);
  const doubt = (p: (typeof pages)[number], detail: string) => out.set(p.page, [{ criterion: '2.4.2', status: 'not_testable', target: 'title', detail }]);
  /** Header-and-footer texts that at least half of the scanned pages have word for word (on three pages or more): the site's frame. */
  const frames = new Map<string, number>();
  for (const p of pages) if (p.frame) frames.set(p.frame, (frames.get(p.frame) ?? 0) + 1);
  /** The title's words this page uses: in its content, and in its header and footer where those are its own. */
  const used = (p: (typeof pages)[number]): string[] => {
    const n = p.frame ? frames.get(p.frame) ?? 0 : 0;
    const siteFrame = n >= 3 && n * 2 >= pages.length;
    return [...(p.hits ?? []), ...(siteFrame ? [] : p.frameHits ?? [])];
  };
  /** Main heading → the pages it heads whose own title names it too (the heading is that page's name). */
  const named = new Map<string, typeof pages>();
  for (const q of pages) if (sharesTopic(q.title, q.h1)) named.set(norm(q.h1), [...(named.get(norm(q.h1)) ?? []), q]);
  for (const p of pages) {
    if (isHome(p.page, p.index) || sharesTopic(p.title, p.h1)) continue;
    // The stale title (batch 17): the title's own part is another page's main heading, word for word, and none of
    // its words is anywhere in this page's own content or address (`TitleData.hits`, read on the page).
    const own = titleParts(p.title).filter((part) => !shared.has(norm(part)));
    const name = own.length === 1 ? own[0]! : '';
    const words = [...topicWords(name)];
    const others = name ? (named.get(norm(name)) ?? []).filter((q) => q !== p && norm(q.h1) !== norm(p.h1)) : [];
    const unused = Array.isArray(p.hits) && !p.partial && (p.read ?? 0) >= STALE_MIN_WORDS;
    // (A name of one word, "Contact" or "News", may describe a page in other words than the page uses: two or more.)
    const mine = used(p);
    if (others.length && words.length >= STALE_MIN_NAME_WORDS && unused && !words.some((w) => mine.includes(w))) {
      // The title names the other page and not this one only where nothing else explains it: `staleDoubt`.
      const else_ = staleDoubt(p, others, name, pages.filter((x) => x !== p && !others.includes(x) && titleParts(x.title).some((part) => norm(part) === norm(name))).length);
      if (else_) {
        doubt(p, `The page's title, ${quote(p.title)}, is, word for word, the main heading of another scanned page (${pathOf(else_.page)}), and none of its words is on this page outside the site's menus and shared header and footer (its main heading is ${quote(p.h1, 60)}); but ${else_.why}, so whether it describes this page is for a person to judge.`);
        continue;
      }
      // Listed for a person, never failed (Sol review of batch 17, S3, and the lead's ruling): that the page uses none
      // of the title's words is a fact about words, not about meaning. A tips page titled "Water conservation" and
      // headed "Save every drop" can be about water conservation in other words ("take shorter showers", "turn off
      // the tap") while another page is headed and titled "Water conservation": a lexical mismatch alone is at most
      // a doubt, whatever the other page is called.
      doubt(p, `The page's title, ${quote(p.title)}, may describe another page: ${quote(name)} is, word for word, the main heading of ${pathOf(others[0]!.page)}, and none of its words is on this page (not in its main heading, ${quote(p.h1, 60)}, its other headings, its text, its description or its address; the site's menus, and a header and footer most of its pages share, are left out); whether it describes this page in other words is for a person to judge.`);
      continue;
    }
    const tail = `and it shares no word with this page's main heading, ${quote(p.h1, 60)}; whether it describes this page is for a person to judge.`;
    // The same title on pages whose main headings differ.
    const same = (byTitle.get(norm(p.title)) ?? []).filter((q) => q !== p && norm(q.h1) !== norm(p.h1));
    if (same.length) {
      const other = same[0]!;
      doubt(p, `The page's title, ${quote(p.title)}, is also the title of ${same.length === 1 ? 'another scanned page' : `${same.length} other scanned pages`} about something else (${pathOf(other.page)}: ${quote(other.h1, 60)}), ${tail}`);
      continue;
    }
    // The site's name alone: the whole title is the part that half of the scanned pages' titles share.
    if (shared.has(norm(p.title)) && topicWords(p.title).size > 0) {
      doubt(p, `The page's title, ${quote(p.title)}, is the site's name alone (the part most of the site's titles share), ${tail}`);
      continue;
    }
    // A title none of whose words the page uses (batch 17): no proof that it names another page, and no sign that
    // it names this one. It may describe the page in words of its own ("Get in touch" on a page headed "Contact"),
    // so it is a doubt, never a failure; before, such a page read "no failures found".
    const ownWords = [...topicWords(own.join(' '))];
    if (ownWords.length >= STALE_MIN_NAME_WORDS && unused && !ownWords.some((w) => mine.includes(w))) {
      doubt(p, `The page's title, ${quote(p.title)}, uses no word that this page uses: none of its words is in the page's main heading, ${quote(p.h1, 60)}, its other headings, its text, its description or its address (the site's menus, and a header and footer most of its pages share, are left out); whether it describes this page is for a person to judge.`);
    }
  }
  // A generic title or the site's name alone, demonstrated by the site's pages: the failure, in place of a doubt.
  for (const [page, found] of genericTitleFindings(runs)) out.set(page, found);
  return out;
}

/**
 * Page titles that cannot describe their page (2.4.2, F25), on every page that loaded. Reads the title and
 * the main heading only. Fails placeholders and file names that describe nothing; raises a doubt ("not
 * testable") where a title may not describe its page. Listed, not scored, until the gold standard verifies it
 * (docs/scoring.md).
 */
export const pageTitlesProbe: PageProbe = {
  id: PAGE_TITLES_PROBE_ID,
  criteria: ['2.4.2'],
  // Reads the title and the main heading once: an app that sets them late is read with them.
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  scored: false,
  timeoutMs: 5000,
  everyPage: true,
  onlyNavigationVoids: true,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const read = await ctx.page.evaluate(readTitle, { stop: TITLE_STOP_WORDS, nodes: TITLE_LIMITS.nodes, chars: TITLE_LIMITS.chars });
    const data: TitleData = {
      v: 1, title: read.title, h1: read.h1, ...(typeof read.h1top === 'boolean' ? { h1top: read.h1top } : {}), ...(typeof read.h1text === 'boolean' ? { h1text: read.h1text } : {}),
      ...(read.hits ? { hits: read.hits.slice(0, 40), read: read.read ?? 0, words: read.words ?? 0, en: read.en ?? 0 } : {}),
      ...(read.frameHits?.length ? { frameHits: read.frameHits.slice(0, 40) } : {}), ...(read.frame ? { frame: read.frame.slice(0, 40) } : {}),
      ...(read.out?.length ? { out: read.out.slice(0, 150).map((h) => h.slice(0, 8)) } : {}),
      ...(read.partial ? { partial: true as const } : {}), ...(read.lang ? { lang: read.lang.slice(0, 12) } : {}), ...(read.alts?.length ? { alts: read.alts.slice(0, 10).map((a) => a.slice(0, 300)) } : {}),
    };
    ctx.setData?.(data);
    // A page with no title at all is the rule engine's finding (document-title), not repeated here.
    if (!data.title) return [{ criterion: '2.4.2', status: 'not_applicable', detail: 'the page has no title to judge (a missing title is found by the rule engine)' }];
    return ownTitleFindings(data, ctx.url, ctx.pageIndex);
  },
  acrossPages: titleFindingsAcross,
  // A failure across the pages settles the page's own doubt about its title (the one-page "Home" doubt): the site's
  // pages together demonstrated what the page alone could not (`withAcrossPages`).
  acrossSettles: ['2.4.2'],
};
