// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Link purpose in context (WCAG 2.4.4), from the DOM at the desktop width, on every page that loaded:
// links whose whole accessible name is a generic phrase ("click here", "read more", "learn more") or says
// only what kind of thing they open ("Open", "File", "Download"), with no programmatically determined
// context that gives their purpose. Reads only; it changes
// nothing on the page. Engine core: no Node-only imports.
//
// What counts as context follows WCAG 2.4.4's sufficient techniques: the link's own accessible name
// (ARIA7 aria-labelledby, ARIA8 aria-label), its description (ARIA1 aria-describedby, H33 title), the
// enclosing sentence or paragraph (H78; a plain block that holds only text and inline elements is a
// paragraph in all but its tag), list item (H77, H81), table cell or row (H79), and the heading before it (H80). A generic link passes when any of these gives text of its own. Links of
// one generic name whose context is the same (the same heading before them, say) but that go to
// different places fail: name and context together cannot say which is which.
// A link whose own sentence, block, list item, cell or description has words of its own, but too few to be
// sure they give its purpose ("Read more about the EU", "Agenda: View"), is undecided (`not_testable`), never
// failed: only a link with no such words around it at all is shown to have no context (W3C precision lane,
// 2026-11-11).
import { elementKeys, roleElement, selElement, textElement } from '../aiDedupe.js';
import type { ProbeFinding } from '../types.js';
import { pageWords, shootElements } from './evidence.js';
import type { PageProbe, ProbeContext } from './types.js';

export const LINK_PURPOSE_PROBE_ID = 'link-purpose';

/**
 * Whole link names that say nothing about where a link goes, normalized (`normalizeLinkName`). A
 * name is generic only when it is one of these exactly: "Read more about the concert" is not.
 */
export const VAGUE_LINK_PHRASES: readonly string[] = [
  'click here', 'click', 'here', 'tap here', 'press here', 'go here', 'this link', 'link', 'click for more',
  'click here for more', 'click here for more information', 'more', 'more here', 'more info', 'more information',
  'more details', 'details', 'info', 'information', 'read more', 'read more here', 'read on', 'keep reading',
  'continue', 'continue reading', 'learn more', 'learn more here', 'find out more', 'see more', 'see details',
  'see all', 'view', 'view more', 'view details', 'view all', 'full story', 'read full story', 'read the full story',
  'go',
  // Spanish, French and German: a short list of the commonest.
  'aquí', 'haga clic aquí', 'haz clic aquí', 'clic aquí', 'más', 'más información', 'leer más', 'ver más',
  'lire la suite', 'en savoir plus', 'cliquez ici', 'ici', 'plus', 'mehr erfahren', 'weiterlesen', 'hier klicken', 'mehr', 'hier',
];

/**
 * Whole link names that say only what kind of thing the link opens, or that it opens something ("Open",
 * "File", "Download", "PDF") (2026-11-10, red-team lane D: a list of documents whose every link reads
 * "Open"). Judged only against each other: two of one name in one context (or with none) that go to
 * different places cannot be told apart. One alone never fails: "Download PDF" in a page's toolbar is the
 * page's own action, clear to everyone (2.4.4's exception). Kept apart from the phrases above because their
 * words are real context for another link ("Budget document: read more").
 */
export const KIND_LINK_NAMES: readonly string[] = [
  'open', 'file', 'download', 'document', 'pdf', 'attachment', 'website', 'open file', 'open pdf', 'open document', 'open link',
  'view file', 'view pdf', 'view document', 'view online', 'download file', 'download pdf', 'download document', 'visit website', 'visit site',
  // Spanish: the commonest.
  'abrir', 'descargar', 'archivo', 'documento', 'ver documento', 'ver pdf', 'descargar pdf',
];

/**
 * Words that carry no purpose in a link's context (r1-2): the words of the generic phrases, articles,
 * prepositions and page furniture ("home", "page", "welcome"). They are removed, with the link's own
 * words, before context is judged.
 */
export const GENERIC_CONTEXT_WORDS: readonly string[] = [
  ...new Set([
    ...VAGUE_LINK_PHRASES.flatMap((p) => p.split(' ')),
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'on', 'in', 'at', 'by', 'with', 'from', 'about', 'is', 'are', 'be', 'it', 'its',
    'this', 'that', 'these', 'those', 'our', 'your', 'you', 'we', 'us', 'please', 'see', 'page', 'pages', 'home', 'homepage', 'welcome',
    'main', 'menu', 'site', 'website', 'back', 'top', 'next', 'previous', 'new', 'all', 'here', 'there', 'now', 'today',
    'de', 'la', 'le', 'les', 'du', 'des', 'el', 'los', 'las', 'y', 'et', 'der', 'die', 'das', 'und', 'zu', 'für',
  ]),
];

export const LINK_PURPOSE_LIMITS = {
  /** Elements walked per document; a larger page is read up to here. */
  elements: 200_000,
  /** Generic links kept per page. */
  links: 500,
  phrases: [...VAGUE_LINK_PHRASES, ...KIND_LINK_NAMES] as readonly string[],
  generic: GENERIC_CONTEXT_WORDS,
  /**
   * What a context needs to give a link its purpose (r1-2), once the link's own words and the generic
   * words are removed: at least 2 words and 8 letters or digits.
   */
  purpose: { words: 2, chars: 8 },
  /**
   * Words that describe a file or a date, never where a link goes ("(PDF, 2 MB)", "Nov 3"): no word of its own for
   * `partial` (W3C precision lane, 2026-11-11). Numbers are none either.
   */
  metadata: [
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf', 'odt', 'ods', 'odp', 'zip', 'mp3', 'mp4', 'jpg', 'jpeg', 'png', 'gif',
    'kb', 'mb', 'gb', 'byte', 'bytes', 'pages', 'pp', 'am', 'pm',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ] as readonly string[],
} as const;

/** Findings listed per page; the last one counts the rest. */
const PER_PAGE = 5;


/**
 * A link name as compared with the phrases: Unicode NFKC, lower case, arrows, chevrons, bullets and
 * ellipses dropped, punctuation and symbols trimmed from both ends, spacing collapsed. The page
 * reader repeats this exactly (it must be self-contained); the integration test checks they agree.
 */
export function normalizeLinkName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .toLowerCase()
    .replace(/[«»‹›<>→←↗➔➜▶►▸·•|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
}

const PHRASES = new Set([...VAGUE_LINK_PHRASES, ...KIND_LINK_NAMES]);
const KIND_NAMES: ReadonlySet<string> = new Set(KIND_LINK_NAMES);
export const isVagueLinkName = (name: string): boolean => PHRASES.has(normalizeLinkName(name));

/** One generic link exposed to assistive technology, with the context that may give its purpose. */
export interface LinkRead {
  /** Its accessible name, normalized (one of `VAGUE_LINK_PHRASES` or `KIND_LINK_NAMES`). */
  name: string;
  /** Its accessible name as the page gives it (whitespace collapsed, at most 80 characters). */
  text: string;
  /** Where it goes (resolved), '' when it has no address of its own (role="link"). */
  href: string;
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
  /** The context text (at most 200 characters); '' when there is none. */
  context: string;
  contextFrom: 'description' | 'sentence' | 'heading' | 'none';
  /**
   * Words of its own in the link's sentence, block, list item, cell or description (at most 80 characters) that are
   * too few to be sure they give its purpose (`LINK_PURPOSE_LIMITS.purpose`), with no sentence or description context
   * ('none' or 'heading'). With no context at all the link is undecided, never failed. It is compared only with links
   * of the same name, context and own words (different words tell it from the others; the same words do not).
   */
  partial?: string;
}

export interface LinkPurposeRead {
  /** Generic links only, in reading order. */
  links: LinkRead[];
  /** The page was larger than the read limits, so some links may be missing. */
  truncated: boolean;
}

/**
 * Runs in the page (self-contained). Walks the document in reading order (into open shadow roots,
 * through slots), keeps the last heading seen, and for each link (`a[href]`, `area[href]`,
 * role="link") that assistive technology is given and whose accessible name is a generic phrase,
 * finds the context that may give its purpose.
 */
export function readLinkPurpose(limits: { elements: number; links: number; phrases: readonly string[]; generic: readonly string[]; purpose?: { words: number; chars: number }; metadata?: readonly string[] }): LinkPurposeRead {
  const phrases = new Set(limits.phrases);
  const generic = new Set(limits.generic);
  const metadata = new Set(limits.metadata ?? []);
  const need = limits.purpose ?? { words: 2, chars: 8 };
  const norm = (s: string) => s
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .toLowerCase()
    .replace(/[«»‹›<>→←↗➔➜▶►▸·•|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
  const clean = (s: string | null | undefined, max = 200) => {
    const t = (s ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  /** The context gives a purpose: 2+ words and 8+ letters or digits beyond the link's own and generic words. */
  const contentWords = (text: string, key: string): string[] => {
    const own = new Set(key.split(' '));
    return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !generic.has(w) && !own.has(w));
  };
  const purposeful = (text: string, key: string): boolean => {
    const words = contentWords(text, key);
    return words.length >= need.words && words.join('').length >= need.chars;
  };
  /**
   * Some words of its own, too few for `purposeful`: one of two letters or more that is no number and no file or date
   * word (`metadata`). No proof either way.
   */
  const someWords = (text: string, key: string): boolean => contentWords(text, key).some((w) => w.length >= 2 && !/^\d+$/.test(w) && !metadata.has(w));
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    const host = (root as ShadowRoot).host;
    return host ? `${cssPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as Node & { host?: Element };
    return root.host ?? null;
  };
  const styleOf = (el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  /** Shown to assistive technology: rendered, and not under aria-hidden or inert. */
  const exposed = (el: Element): boolean => {
    if (!el.isConnected) return false;
    for (let a: Element | null = el; a; a = parentOf(a)) {
      if (a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('inert')) return false;
    }
    let box: Element | null = el;
    while (box && styleOf(box).display === 'contents') box = parentOf(box);
    if (!box) return false;
    if (typeof box.checkVisibility === 'function') return box.checkVisibility({ visibilityProperty: true });
    const s = styleOf(box);
    return s.display !== 'none' && s.visibility !== 'hidden' && box.getClientRects().length > 0;
  };
  let budget = 0;
  /** Text of a subtree as an accessible name or a context reads it; `skip` (the link itself) left out. */
  const textOf = (n: Node, depth: number, skip?: Element): string => {
    if (depth > 30 || --budget < 0) return '';
    if (n.nodeType === 3) return n.nodeValue ?? '';
    if (n.nodeType !== 1) return '';
    const el = n as Element;
    if (el === skip) return ' ';
    if (el.getAttribute('aria-hidden') === 'true' || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/i.test(el.tagName)) return '';
    if (depth > 0) {
      const s = styleOf(el);
      if (s.display === 'none' || s.visibility === 'hidden') return '';
      const label = el.getAttribute('aria-label');
      if (!skip && label && label.trim()) return ` ${label} `;
    }
    if (el.matches('img, area, input[type="image"]')) return ` ${el.getAttribute('alt') ?? ''} `;
    if (el.localName === 'svg') return ` ${el.querySelector('title')?.textContent ?? ''} `;
    let out = '';
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes];
    for (const k of kids) out += textOf(k, depth + 1, skip);
    return ` ${out} `;
  };
  const byIds = (el: Element, ids: string) => {
    const root = el.getRootNode() as Document | ShadowRoot;
    budget = 2000;
    return clean(ids.split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id) ?? el.ownerDocument.getElementById(id)).map((x) => (x ? textOf(x, 1) : '')).join(' '));
  };
  /** The accessible name, and whether it came from the title attribute. */
  const nameOf = (el: Element): { name: string; fromTitle: boolean } => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const s = byIds(el, lb);
      if (s) return { name: s, fromTitle: false };
    }
    const label = clean(el.getAttribute('aria-label'));
    if (label) return { name: label, fromTitle: false };
    budget = 2000;
    const text = clean(textOf(el, 0));
    if (text) return { name: text, fromTitle: false };
    return { name: clean(el.getAttribute('title')), fromTitle: true };
  };
  const NOT_HEADING_ROLES = new Set(['none', 'presentation', 'button', 'link', 'tab', 'menuitem', 'listitem', 'generic', 'img', 'option', 'treeitem']);
  const isHeading = (el: Element): boolean => {
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (role === 'heading') return true;
    return /^h[1-6]$/i.test(el.localName) && el.namespaceURI === 'http://www.w3.org/1999/xhtml' && !NOT_HEADING_ROLES.has(role);
  };
  const isLink = (el: Element): boolean => {
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (role === 'link') return true;
    if (role && role !== 'link') return false;
    return (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href') && el.namespaceURI === 'http://www.w3.org/1999/xhtml';
  };
  // Native containers and their ARIA equivalents (r1-3), and headings: the rest of the heading a link
  // sits in is its context (r1-5).
  const CONTAINERS = 'p, li, td, th, dd, dt, figcaption, caption, blockquote, label, legend, summary, h1, h2, h3, h4, h5, h6, '
    + '[role="paragraph"], [role="listitem"], [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"], [role="row"], [role="heading"]';
  const CELL = 'td, th, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]';
  /** The enclosing sentence, list item, cell or heading's own text, without the link (H77–H79, H81). */
  /** A block whose content is all inline (text, spans, links): laid out and read as a paragraph, whatever its tag. */
  const inlineOnly = (el: Element): boolean => {
    if (!/^(block|list-item|flow-root|table-cell|inline-block)$/.test(styleOf(el).display)) return false;
    for (const k of Array.from(el.children)) {
      if (k.localName === 'br') continue;
      const d = styleOf(k).display;
      if (d !== 'none' && d !== 'contents' && !d.startsWith('inline')) return false;
    }
    return true;
  };
  /**
   * `full`: the first sentence, block, list item, cell or row around the link whose text gives a purpose; `partial`:
   * else the first of them with some words of its own (`someWords`), too few to be sure.
   */
  const sentenceOf = (link: Element, key: string): { full: string; partial: string } => {
    /** The first block around the link is judged once as a paragraph in all but its tag. */
    let block = false;
    let partial = '';
    const note = (rest: string) => { if (!partial && someWords(rest, key)) partial = rest; };
    for (let a: Element | null = parentOf(link); a; a = parentOf(a)) {
      if (!a.matches(CONTAINERS)) {
        // Text and the link together in one plain block (a div with no blocks inside it): its text is the
        // link's context, as a paragraph's is (2026-11-10; the 2026-11-07 audit's "sentences in a div").
        if (!block && a !== document.body && a.localName !== 'html' && !styleOf(a).display.startsWith('inline') && styleOf(a).display !== 'contents') {
          block = true;
          if (inlineOnly(a)) {
            budget = 3000;
            const rest = clean(textOf(a, 0, link));
            if (purposeful(rest, key)) return { full: rest, partial: '' };
            note(rest);
          }
        }
        continue;
      }
      budget = 3000;
      let rest = clean(textOf(a, 0, link));
      // A cell with nothing else in it: the rest of its row (and its headers) gives the context.
      if (!purposeful(rest, key) && a.matches(CELL)) {
        const row = a.closest('tr, [role="row"]');
        if (row) { budget = 3000; rest = clean(textOf(row, 0, link)); }
      }
      if (purposeful(rest, key)) return { full: rest, partial: '' };
      note(rest);
    }
    return { full: '', partial };
  };
  const levelOf = (el: Element): number => {
    const aria = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
    if (Number.isFinite(aria) && aria >= 1) return aria;
    const m = /^h([1-6])$/i.exec(el.localName);
    return m ? Number(m[1]) : 2;
  };

  let walked = 0;
  let truncated = false;
  /** The last heading seen, and the one before it (for a link inside the last one). */
  let lastHeading = { text: '', el: null as Element | null };
  let prevHeading = '';
  const links: LinkRead[] = [];
  const walk = (root: Node) => {
    const stack: Node[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.nodeType === 1) {
        if (++walked > limits.elements) { truncated = true; return; }
        const el = n as Element;
        if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|svg|iframe|frame)$/i.test(el.localName)) continue;
        if (isHeading(el) && exposed(el)) {
          budget = 2000;
          const h = clean(el.getAttribute('aria-label')) || clean(textOf(el, 0));
          // A page-level heading (level 1) is no context for links deep in the page (r1-2), and a heading
          // that is only a generic phrase ("Learn more") gives none either.
          if (h && levelOf(el) > 1 && !phrases.has(norm(h))) { prevHeading = lastHeading.text; lastHeading = { text: h, el }; }
        } else if (isLink(el) && exposed(el)) {
          const { name, fromTitle } = nameOf(el);
          const key = norm(name);
          if (phrases.has(key)) {
            if (links.length >= limits.links) { truncated = true; return; }
            const href = el.localName === 'a' || el.localName === 'area' ? (el as HTMLAnchorElement).href : '';
            const described = el.getAttribute('aria-describedby');
            // Its description: aria-describedby, its own title, or the title of an image inside it (r1-4).
            const description = (described ? byIds(el, described) : '')
              || (fromTitle ? '' : clean(el.getAttribute('title')))
              || clean(el.querySelector('img[title], svg[title], [role="img"][title]')?.getAttribute('title'));
            let context = '';
            let contextFrom: LinkRead['contextFrom'] = 'none';
            let partial = '';
            if (purposeful(description, key)) { context = description; contextFrom = 'description'; }
            else {
              const sentence = sentenceOf(el, key);
              if (sentence.full) { context = sentence.full; contextFrom = 'sentence'; }
              else {
                // A link inside a heading gets the heading before it: its own text is no context.
                const inside = !!lastHeading.el && (lastHeading.el === el || lastHeading.el.contains(el));
                const heading = inside ? prevHeading : lastHeading.text;
                if (purposeful(heading, key)) { context = heading; contextFrom = 'heading'; }
                // Words of its own, too few to be sure (the heading before it is no part of them: H80 needs a purpose).
                partial = sentence.partial || (someWords(description, key) ? description : '');
              }
            }
            links.push({ name: key, text: clean(name, 80), href, target: cssPath(el), context, contextFrom, ...(partial ? { partial: clean(partial, 80) } : {}) });
          }
        }
        let kids: Node[];
        if (el.shadowRoot) kids = [...el.shadowRoot.childNodes];
        else if (el.localName === 'slot' && typeof (el as HTMLSlotElement).assignedNodes === 'function' && (el as HTMLSlotElement).assignedNodes({ flatten: true }).length) {
          kids = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        } else kids = [...el.childNodes];
        for (let i = kids.length - 1; i >= 0; i--) if (kids[i]!.nodeType === 1) stack.push(kids[i]!);
      } else {
        const kids = [...n.childNodes];
        for (let i = kids.length - 1; i >= 0; i--) if (kids[i]!.nodeType === 1) stack.push(kids[i]!);
      }
    }
  };
  walk(document);
  return { links, truncated };
}

const CONTEXT_WORDS: Record<Exclude<LinkRead['contextFrom'], 'none'>, string> = {
  heading: 'after the heading',
  sentence: 'in the same text',
  description: 'with the same description',
};

const short = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/** One page's findings from what `readLinkPurpose` reported. */
export function linkPurposeFindings(read: Pick<LinkPurposeRead, 'links'>): ProbeFinding[] {
  const failing: { at: number; target: string; text: string; detail: string }[] = [];
  /** Generic links with a few words of their own around them: undecided. */
  const unsure: LinkRead[] = [];
  read.links.forEach((l, at) => {
    // A name that says only the kind of thing ("Download PDF", "Open") with nothing around it is often the
    // page's own action (this page as a PDF): alone it is not ambiguous. Two of them are judged below.
    if (l.contextFrom !== 'none' || KIND_NAMES.has(l.name)) return;
    if (l.partial) { unsure.push(l); return; }
    failing.push({
      at, target: l.target, text: l.text,
      detail: `The link “${l.text}” has nothing around it that says where it goes: no sentence, list item, table cell or heading before it gives its purpose`,
    });
  });
  const groups = new Map<string, { at: number; links: LinkRead[] }>();
  read.links.forEach((l, at) => {
    // A sentence, list item or cell is each link's own: two links in one paragraph each have their sentence. Kind-only
    // names with no context at all are compared with each other too ("PDF" and "PDF"). Links with a few words of their
    // own are compared only with links of the same name, context and own words (Fable review F4): "Budget: Open" and
    // "Minutes: Open" are told apart by their words, two "PDF icon: Open" that lead to different files are not.
    if ((l.contextFrom === 'none' && !KIND_NAMES.has(l.name) && !l.partial) || l.contextFrom === 'sentence') return;
    const own = l.partial ? l.partial.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
    const key = `${l.name}\u0000${l.contextFrom}\u0000${l.context}\u0000${own}`;
    const g = groups.get(key);
    if (g) g.links.push(l);
    else groups.set(key, { at, links: [l] });
  });
  for (const g of groups.values()) {
    if (new Set(g.links.map((l) => l.href).filter(Boolean)).size < 2) continue;
    const first = g.links[0]!;
    failing.push({
      at: g.at, target: first.target, text: first.text,
      detail: first.partial
        ? `${g.links.length} links named “${first.text}”${first.contextFrom === 'none' ? '' : ` ${CONTEXT_WORDS[first.contextFrom]} “${short(first.context)}”`}, each beside the same words “${short(first.partial)}”, go to different pages, so their names and context do not say which is which`
        : first.contextFrom === 'none'
          ? `${g.links.length} links named “${first.text}” with nothing around them that says where they go lead to different pages, so their names do not say which is which`
          : `${g.links.length} links named “${first.text}” ${CONTEXT_WORDS[first.contextFrom]} “${short(first.context)}” go to different pages, so their names and context do not say which is which`,
    });
  }
  failing.sort((a, b) => a.at - b.at);
  const shown = failing.slice(0, PER_PAGE);
  const out: ProbeFinding[] = shown.map((f, i) => {
    const more = i === shown.length - 1 && failing.length > shown.length ? ` (${failing.length - shown.length} more like this on this page)` : '';
    // The link by its path, its name and its role: one link another method also fails is one problem.
    return { criterion: '2.4.4', status: 'failed', target: f.target, elements: elementKeys(selElement(f.target), textElement(f.text), roleElement('link')), detail: `${f.detail}${more}` };
  });
  if (unsure.length) {
    const first = unsure[0]!;
    const n = unsure.length;
    out.push({
      criterion: '2.4.4', status: 'not_testable', target: first.target,
      detail: `${n === 1 ? `the link “${first.text}” has` : `${n} links with a generic name (the first “${first.text}”) have`} only a few words of ${n === 1 ? 'its' : 'their'} own around ${n === 1 ? 'it' : 'them'} (“${short(first.partial!)}”), too few to tell whether they say where ${n === 1 ? 'it goes' : 'they go'}`,
    });
  }
  return out;
}

/** The first failing link boxed, in the main document. */
async function linkEvidence(ctx: ProbeContext, findings: readonly ProbeFinding[]): Promise<void> {
  const first = findings.find((f) => f.status === 'failed' && f.target && !f.target.includes(' >>> '));
  if (!first) return;
  await shootElements(ctx, {
    criterion: '2.4.4', handles: [{ sel: first.target! }], caption: 'This link’s name does not say where it goes',
    alt: (title) => `${pageWords(title)}: the outlined link has a generic name, and nothing around it says where it goes.`,
  });
}

/**
 * Link purpose, on every page that loaded (`everyPage`): fails 2.4.4 for each generic link ("read
 * more", "click here") with no context that gives its purpose, and for generic links of one name and
 * one context that go to different places.
 */
export const linkPurposeProbe: PageProbe = {
  id: LINK_PURPOSE_PROBE_ID,
  criteria: ['2.4.4'],
  kind: 'render',
  tier: 'core',
  timeoutMs: 10_000,
  everyPage: true,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const read = await ctx.page.evaluate(readLinkPurpose, LINK_PURPOSE_LIMITS);
    const findings = linkPurposeFindings(read);
    if (!findings.length && read.truncated) {
      return [{ criterion: '2.4.4', status: 'not_testable', detail: 'this page is too large to read every link' }];
    }
    await linkEvidence(ctx, findings);
    return findings;
  },
};
