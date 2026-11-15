// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Heading structure (WCAG 1.3.1 and 2.4.6), from the DOM at the desktop width, on every page that
// loaded. Failures: headings with no text (1.3.1, ACT ffd0e9), a paragraph marked up as a heading (1.3.1,
// F43), text the page proves it shows as a section heading with no heading markup (1.3.1, F2: set exactly like
// a real heading as the browser draws it; or, since batch 17, a line the markup names a heading that is set at
// least as large as the real heading its neighbour box begins with, or that divides a block with others of its
// make: `shownVerdict`), a table header
// cell that is the header of no data cell (1.3.1, `tableHeaders.ts`), tabular data shown with no header
// relationships (1.3.1, `tablesShown.ts`) and (across pages) the
// same level-1 heading on nearly every page (usually the site's name), so it
// names no page (2.4.6), and a line one page shows as a heading that another scanned page marks up as a real
// heading, the same words in the same type (1.3.1, `siteTwinFindings`). WCAG requires neither a level-1 heading nor heading levels in order (H42 is
// sufficient with any levels): a page with no level-1 heading and levels that skip downwards are
// recommendations (`ProbeFinding.advice`), never failures. Reads only; it changes nothing on the page.
// Engine core: no Node-only imports.
import type { ProbeFinding, ProbeRun } from '../types.js';
import { pageWords, shootElements } from './evidence.js';
import { installNamesSomething, NAMES_SOMETHING_KEY, type NamesSomething } from './namesSomething.js';
import { loneHeaderFindings, readLoneHeaders, TABLE_HEADER_LIMITS } from './tableHeaders.js';
import { readShownTables, shownTableFindings, TABLES_SHOWN_LIMITS } from './tablesShown.js';
import type { PageProbe, ProbeContext } from './types.js';

export const HEADINGS_PROBE_ID = 'headings';

export const HEADINGS_LIMITS = {
  /** Elements walked per document; a larger page is read up to here. */
  elements: 200_000,
  /** Exposed headings kept per page. */
  headings: 2000,
  /** Same-origin frames looked into for a level-1 heading. */
  frames: 20,
  /** Findings of one kind (empty headings, skipped levels) listed per page. */
  perKind: 5,
  /**
   * A heading whose own visible text is at least this long AND reads as prose (two sentences) is a paragraph
   * marked up as a heading (1.3.1, F43): a heading names a section.
   * A long one-clause title ("…to take public comment on the 2026 facilities plan") is a title.
   */
  paragraphChars: 200,
  /** Own visible text this long is a paragraph whatever its punctuation: far above any title. */
  paragraphLongChars: 320,
  /** The longest wait for the page's web fonts before the type of its lines is read (ms). */
  fontsMs: 1500,
  /** Blocks read for section titles not marked up as headings (F2), per page. */
  styled: 4000,
  /** Section titles not marked up (F2) a page needs before they fail: one bold line is not a page structure. */
  styledMin: 2,
} as const;

/** The site-wide template heading rule: share of the pages with a level-1 heading, and the least number of pages. */
export const TEMPLATE_H1 = { share: 0.8, minPages: 3 } as const;

/** One heading exposed to assistive technology, in reading (flat tree) order. */
export interface HeadingRead {
  /** h1–h6, or aria-level (role="heading" defaults to 2). */
  level: number;
  /** Its accessible name, whitespace collapsed (at most 120 characters); '' when it has none. */
  text: string;
  /** The length of its whole accessible name (before `text` is cut). Absent in reads made before 2026-11-07. */
  chars?: number;
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
  /**
   * For a name of `paragraphChars` or more: the heading's own text that is seen (visually hidden parts, such
   * as a screen-reader-only suffix, left out; at most 1000 characters). F43 is judged on it.
   */
  own?: string;
  /** How a heading that is seen on screen is set (`sigOf`); absent in reads made before 2026-11-12. */
  sig?: string;
  /** How it is drawn (`drawnOf`), where the page's fonts let that be proved. */
  drawn?: string;
  /** Its own letters as drawn (`glyphsOf`): Latin text of a short name in a type the picture can prove. */
  glyphs?: string;
}

/** What `readHeadings` reports for a page. */
export interface HeadingsRead {
  title: string;
  /** Headings in the page's own document, open shadow roots included; hidden ones left out. */
  headings: HeadingRead[];
  /** The page was larger than the read limits, so some headings may be missing. */
  truncated: boolean;
  /** A same-origin frame shown on the page has a level-1 heading with text. */
  frameH1: boolean;
  /** A frame the test cannot read (another site's) covers at least half of the first screen. */
  bigUnreadableFrame: boolean;
  /**
   * Native h1–h6 made presentational (role none or presentation that applies) and still shown as a heading
   * (bold or larger than the body text), with letters in their text (F92). Absent in reads made before 2026-11-07.
   */
  presented?: StyledBlock[];
  /**
   * Text shown as a section heading (a short bold or larger line, not inside a heading, link, button,
   * label, list, table or landmark other than main, followed by body text in plain style) that is not
   * marked up as one (F2). Read only on a page whose headings include none below level 1. Absent in reads
   * made before 2026-11-07.
   */
  styled?: StyledBlock[];
  /** Headings inside same-origin frames (judged for placeholder text only). Absent in older reads. */
  frameHeadings?: HeadingRead[];
  /**
   * Text the page shows as a section heading without marking it up as one (F2): a
   * line of its own, larger than the body copy (and bold, or much larger), that introduces the content after it,
   * and that the page's own class or id calls a heading or title (`named`), or that is set exactly like the
   * page's real headings (`twin`), or whose box sits among boxes that begin with a real heading (`peers`).
   * Which of these the page proves (a failure) and which stay candidates (undecided) is `shownVerdict`.
   * Read on every page, whatever its real headings. Absent in reads made before 2026-11-10.
   */
  shown?: StyledBlock[];
  /**
   * Lines that pass every test of `shown` except its proofs (on their own line, larger than the text they introduce,
   * at the head of that text, set one way from end to end; no naming class, no twin, no neighbouring boxes) and that
   * nothing says may be something else (no `StyledBlock.doubt`, since the Sol review of batch 17): nothing on this
   * page says they are headings, so they are never reported from it. Kept (at most 10) only so that the site's other
   * pages can decide them (`siteTwinFindings`). Absent in reads made before 2026-11-12.
   */
  plain?: StyledBlock[];
}

/** A block shown as a heading but not exposed as one. */
export interface StyledBlock {
  /** Its visible text, whitespace collapsed (at most 120 characters). */
  text: string;
  target: string;
  /** The heading level of a native h1–h6 made presentational. */
  level?: number;
  /** For `shown`: what proves it is shown as a heading. */
  why?: 'named' | 'twin' | 'peers';
  /**
   * For `shown` (since 2026-11-12, batch 17): every proof the page itself gives, beside `why` (the first of twin,
   * named, peers). A line that is not a twin fails only on two of them together (`shownVerdict`).
   */
  /** The word in its class or id that calls it a heading or a title. */
  named?: string;
  /**
   * The real heading a box beside its box begins with (its text, at most 60 characters), when the line is the
   * first line of its own box; `prominent`: the line is set at least as large and as heavy as that heading, in
   * the same typeface (so it shows as a heading at least as much as the real one beside it does).
   */
  peer?: { text: string; prominent: boolean };
  /** Lines of the same make (element, class and type) that head parts of the same block, this one included. */
  repeated?: number;
  /** For a twin: one real heading of the page that is set the same way (its text, at most 60 characters, and its level). */
  twinOf?: { text: string; level: number };
  /**
   * How it is set (`sigOf`), when the whole line is set one way: compared with the real headings of the site's
   * other pages (`siteTwinFindings`).
   */
  sig?: string;
  /** How it is drawn (`drawnOf`), where the page's fonts let that be proved. */
  drawn?: string;
  /** Its own letters as drawn (`glyphsOf`), where `drawn` is known and its text is Latin. */
  glyphs?: string;
  /** Its font size in CSS px, for the finding. */
  px?: number;
  /**
   * Why the line, whatever its name and place, may be something other than a section title, so that no proof but
   * a twin is taken from it (`shownVerdict`): it reads on into the text after it, it is a quotation, it begins
   * with a figure, it is a date or a time, it stands under another title-like line, it takes clicks, or the text
   * after it is not shown.
   */
  doubt?: string;
}

/**
 * Runs in the page (self-contained). Walks the document in reading order (into open shadow roots,
 * through slots) and lists the headings assistive technology is given: native h1–h6 and
 * role="heading", not those hidden with display, visibility, content-visibility, aria-hidden or
 * inert. Visually hidden headings (screen-reader-only) count.
 */
export function readHeadings(limits: { elements: number; headings: number; frames: number; styled?: number; namesKey: string; clicks?: number[] }): HeadingsRead {
  // The shared rule (./namesSomething.ts), put on the window before this runs (the probe does it).
  const namesSomething = (window as unknown as Record<string, NamesSomething | undefined>)[limits.namesKey];
  if (typeof namesSomething !== 'function') throw new Error('readHeadings: the names-something rule is not installed on this page');
  const NOT_HEADING_ROLES = new Set([
    'none', 'presentation', 'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'listitem', 'generic', 'img',
    'option', 'treeitem', 'gridcell', 'cell', 'columnheader', 'rowheader', 'region', 'group', 'banner', 'navigation', 'main',
    'complementary', 'contentinfo', 'dialog', 'alertdialog', 'alert', 'status', 'note', 'article', 'document', 'paragraph',
    'separator', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'listbox', 'list', 'menu', 'menubar', 'tablist', 'tabpanel',
    'tree', 'grid', 'table', 'row', 'rowgroup', 'toolbar', 'tooltip', 'figure', 'math', 'term', 'definition', 'log', 'marquee',
    'timer', 'progressbar', 'scrollbar', 'slider', 'spinbutton', 'searchbox', 'search', 'form', 'feed', 'application',
    'blockquote', 'caption', 'code', 'deletion', 'emphasis', 'insertion', 'strong', 'subscript', 'superscript', 'time', 'meter',
    'mark', 'comment', 'suggestion', 'text',
  ]);
  const clean = (s: string | null | undefined, max = 120) => {
    const t = (s ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      // A shadow root's top-level elements have no parent element: count their place among the root's children.
      const parent: Element | ShadowRoot | null = cur.parentElement ?? (cur.parentNode && cur.parentNode.nodeType === 11 ? (cur.parentNode as ShadowRoot) : null);
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
      if (!cur.parentElement) break;
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
    // display: contents has no box of its own: its parent decides.
    let box: Element | null = el;
    while (box && styleOf(box).display === 'contents') box = parentOf(box);
    if (!box) return false;
    if (typeof box.checkVisibility === 'function') return box.checkVisibility({ visibilityProperty: true });
    const s = styleOf(box);
    return s.display !== 'none' && s.visibility !== 'hidden' && box.getClientRects().length > 0;
  };
  /** Global ARIA attributes: one on an element keeps a role of none or presentation from applying. */
  const GLOBAL_ARIA = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-details', 'aria-owns', 'aria-controls', 'aria-live', 'aria-keyshortcuts', 'aria-roledescription', 'aria-errormessage', 'aria-flowto', 'aria-dropeffect', 'aria-grabbed', 'aria-haspopup', 'aria-invalid', 'aria-atomic', 'aria-busy', 'aria-relevant', 'aria-current', 'aria-disabled'];
  /** Role none or presentation that applies (none of its conflicts: a global ARIA attribute, or focusable). */
  const presentational = (el: Element): boolean => {
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (role !== 'none' && role !== 'presentation') return false;
    if (GLOBAL_ARIA.some((a) => el.hasAttribute(a))) return false;
    return !el.hasAttribute('tabindex');
  };
  /** Nodes a name may still read (a heading that wraps a whole section must not cost a style read per node). */
  let budget = 0;
  /** Text of a subtree as an accessible name counts it: aria-label, image alt and svg title; not hidden parts. */
  const textName = (n: Node, depth: number): string => {
    if (depth > 30 || --budget < 0) return '';
    if (n.nodeType === 3) return n.nodeValue ?? '';
    if (n.nodeType !== 1) return '';
    const el = n as Element;
    if (el.getAttribute('aria-hidden') === 'true' || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/i.test(el.tagName)) return '';
    if (depth > 0) {
      const s = styleOf(el);
      if (s.display === 'none' || s.visibility === 'hidden') return '';
      const label = el.getAttribute('aria-label');
      if (label && label.trim()) return ` ${label} `;
    }
    if (el.matches('img, area, input[type="image"]')) {
      // An image made presentational (role none or presentation, with no global ARIA attribute to undo it) has no name.
      return presentational(el) ? '' : ` ${el.getAttribute('alt') ?? ''} `;
    }
    if (el.localName === 'svg') return ` ${el.querySelector('title')?.textContent ?? ''} `;
    let out = '';
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes];
    for (const k of kids) out += textName(k, depth + 1);
    return ` ${out} `;
  };
  /** The whole accessible name, whitespace collapsed (cut to 120 characters where it is stored). */
  const nameOf = (el: Element): string => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    budget = 500;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const s = lb.split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id) ?? el.ownerDocument.getElementById(id)).map((x) => (x ? textName(x, 1) : '')).join(' ');
      if (clean(s)) return clean(s);
    }
    const label = el.getAttribute('aria-label');
    if (label && clean(label)) return clean(label);
    budget = 500;
    const text = clean(textName(el, 0));
    if (text) return text;
    return clean(el.getAttribute('title'));
  };
  /** The text in `el` a sighted person sees: text in parts that are not rendered or are visually hidden (under 2×2 px, clipped away) is left out. */
  const seenText = (el: Element): string => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let len = 0;
    for (let n = walker.nextNode(); n && len < 1000; n = walker.nextNode()) {
      const t = n.nodeValue ?? '';
      if (!t.trim()) { parts.push(' '); continue; }
      const p = n.parentElement;
      if (!p) continue;
      const v = p as Element & { checkVisibility?: (o: object) => boolean };
      if (typeof v.checkVisibility === 'function' && !v.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      let hidden = false;
      for (let a: Element | null = p, i = 0; a && a !== el.parentElement && i < 20; a = a.parentElement, i++) {
        const r = a.getBoundingClientRect();
        const st = getComputedStyle(a);
        if ((r.width < 2 || r.height < 2) && (st.overflow !== 'visible' || st.position === 'absolute')) { hidden = true; break; }
        if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(st.clip) || /inset\(\s*(50%|100%)/.test(st.clipPath)) { hidden = true; break; }
      }
      if (hidden) continue;
      parts.push(t);
      len += t.length;
    }
    return parts.join('').replace(/\s+/g, ' ').trim().slice(0, 1000);
  };
  const levelOf = (el: Element): number => {
    let role = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    // ARIA's presentational roles conflict resolution: role none or presentation on an element with a
    // global ARIA attribute (an aria-label, even empty) or that takes focus is ignored (ACT ffd0e9).
    if ((role === 'none' || role === 'presentation') && !presentational(el)) role = '';
    const m = /^h([1-6])$/i.exec(el.localName);
    const native = m && el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? Number(m[1]) : 0;
    const heading = role === 'heading' || (native > 0 && !NOT_HEADING_ROLES.has(role));
    if (!heading) return 0;
    const aria = Number.parseInt(el.getAttribute('aria-level') ?? '', 10);
    if (Number.isFinite(aria) && aria >= 1) return aria;
    return native || 2;
  };
  let walked = 0;
  let truncated = false;
  /** Elements of a document in reading order: into open shadow roots, through slots (or their fallback). */
  const walk = (root: Node, each: (el: Element) => void) => {
    const stack: Node[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.nodeType === 1) {
        if (++walked > limits.elements) { truncated = true; return; }
        const el = n as Element;
        if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|svg)$/i.test(el.localName)) continue;
        each(el);
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

  /**
   * Font size of the actual body copy (px): the median computed size of the paragraphs with a sentence of text in the
   * main content (or the body), not the body element's own size; the body's size when there is no such paragraph.
   */
  const bodyCopyPx = (doc: Document): number => {
    const scope = doc.querySelector('main, [role="main"]') ?? doc.body;
    const sizes: number[] = [];
    const ps = scope ? scope.querySelectorAll('p') : [];
    for (let i = 0; i < ps.length && sizes.length < 200; i++) {
      const p = ps[i]!;
      if ((p.textContent ?? '').replace(/\s+/g, ' ').trim().length < 40) continue;
      const px = parseFloat(styleOf(p).fontSize);
      if (px > 0) sizes.push(px);
    }
    if (!sizes.length) return parseFloat(styleOf(doc.body ?? doc.documentElement).fontSize) || 16;
    sizes.sort((x, y) => x - y);
    return sizes[Math.floor(sizes.length / 2)]!;
  };
  /** Weight and size of the text a block shows: its first text's own element (a lone strong inside a p is the title). */
  const textStyle = (el: Element): { weight: number; px: number } => {
    const w = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let holder: Element = el;
    for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.nodeValue ?? '').trim()) { holder = n.parentElement ?? el; break; }
    const s = styleOf(holder);
    const weight = Number.parseInt(s.fontWeight, 10);
    return { weight: Number.isFinite(weight) ? weight : s.fontWeight === 'bold' ? 700 : 400, px: parseFloat(s.fontSize) || 16 };
  };
  /** Styled as a heading against the body copy: bold, or clearly larger. */
  const headingStyled = (st: { weight: number; px: number }, copy: number) => st.weight >= 600 || st.px >= 1.15 * copy;
  /** Seen on screen: a box of 2×2 px or more, not clipped away (screen-reader-only), not transparent. */
  const seenBox = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const v = el as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof v.checkVisibility === 'function' && !v.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    for (let a: Element | null = el, i = 0; a && i < 12; a = a.parentElement, i++) {
      const st = styleOf(a);
      const ar = a.getBoundingClientRect();
      if ((ar.width < 2 || ar.height < 2) && (st.overflow !== 'visible' || st.position === 'absolute')) return false;
      if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(st.clip) || /inset\(\s*(50%|100%)/.test(st.clipPath)) return false;
    }
    return true;
  };
  /** A figure, not a title: a number with an optional currency, unit, suffix or percent ("1.2k", "$3M", "45%"). */
  const METRIC = /^[$€£¥+~≈-]?\s*\d[\d.,]*\s*(%|[kmb]\+?|x|×|\+|pts?|hrs?|yrs?|mins?|mi|km|ft|lbs?|kg|st|nd|rd|th)?\s*\+?$/i;
  /** F92 (in `walk`): a native heading made presentational that still shows as one against the body copy. */
  const presentedOf = (el: Element, copy: number, prefix: string): StyledBlock | null => {
    const m = /^h([1-6])$/i.exec(el.localName);
    if (!m || !presentational(el) || !exposed(el) || el.querySelector('button, input, select, textarea, [role="button"]')) return null;
    const name = clean(nameOf(el));
    if (!/\p{L}/u.test(name) || METRIC.test(name) || name.length > 150 || /^[*†‡§¹²³]/u.test(name) || !seenBox(el)) return null;
    const st = textStyle(el);
    if (st.px < copy - 0.5 || !headingStyled(st, copy)) return null;
    return { text: name, target: `${prefix}${cssPath(el)}`, level: Number(m[1]) };
  };
  const pageCopy = bodyCopyPx(document);
  const presented: StyledBlock[] = [];
  const headings: HeadingRead[] = [];
  /**
   * How the page's real headings are set, for text set exactly like them: as the style sheet says it (`sigOf`),
   * and as the browser draws it (`drawnOf`, marked "~").
   */
  const headingSigs = new Set<string>();
  /** The first real heading set each way (for the finding: which heading a twin is set like). */
  const headingBySig = new Map<string, { text: string; level: number }>();
  /** The style of the first real heading drawn each way (`~` signatures only): the twin by the picture draws the line's own letters in it. */
  const headingStyleBySig = new Map<string, { st: CSSStyleDeclaration; doc: Document }>();
  /**
   * How a style is set, as its style sheet says it: size, weight, first family, case, slant, width and small
   * capitals (a condensed or small-caps line is no twin of a plain one).
   */
  const weightOf = (st: CSSStyleDeclaration): number => {
    const n = Number.parseInt(st.fontWeight, 10);
    return Number.isFinite(n) ? n : st.fontWeight === 'bold' ? 700 : 400;
  };
  const family0 = (st: CSSStyleDeclaration): string => (st.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase();
  /**
   * The font settings that change how a face draws its letters, beyond its size, weight, slant and width (Sol review
   * of batch 17, S6): OpenType features and variation axes the style sheet asks for (alternate letters, small
   * figures, a variable font's weight axis), ligatures, kerning, optical sizing, a size adjustment, synthesis, and the
   * spacing of letters and words. Two styles that differ in any of them are not set exactly alike, whatever face the
   * browser picks for each. (A canvas draws none of them, so the picture below cannot tell them apart: they are
   * compared as the style sheet says them, in both signatures.)
   */
  const SETTINGS = ['font-feature-settings', 'font-variation-settings', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-alternates',
    'font-variant-east-asian', 'font-variant-position', 'font-kerning', 'font-optical-sizing', 'font-size-adjust', 'font-synthesis', 'letter-spacing', 'word-spacing'];
  const settingsOf = (st: CSSStyleDeclaration): string => SETTINGS.map((p) => st.getPropertyValue(p).replace(/\s+/g, ' ').trim()).join('|');
  const sigOfStyle = (st: CSSStyleDeclaration): string =>
    `${Math.round((parseFloat(st.fontSize) || 16) * 2) / 2}|${weightOf(st)}|${family0(st)}|${st.textTransform}|${st.fontStyle}|${st.fontStretch || 'normal'}|${st.fontVariantCaps || 'normal'}|${settingsOf(st)}`;
  /**
   * How a style is DRAWN (batch 17): two styles of one family that name different weights are the same type when
   * the browser draws them with the same face (weight 500 of a family that has no medium face is its regular face;
   * 800 of a family whose one heavy face is its bold is that bold). Proved by the picture, never guessed: a sample
   * line is drawn on a canvas with the style's own slant and weight in its first family, and the ink it leaves is
   * compared (two faces of one width, as in a monospaced family, still leave different ink).
   * Only for a family the page itself serves (a web font, `@font-face`), so that every reader draws from the
   * same faces: which faces a font of the reader's own device has (a semibold beside the bold, or not) differs
   * from device to device, and the scan's machine is one device (review of batch 17, round 2). And only where:
   * every web font the page asked for has arrived and none failed (a face still loading, or one that did not load
   * here, is drawn with a stand-in); no source of the family is a font of the device (`local()`); and the sample's
   * letters all come from the family (the ink is the same whatever stands behind it). Otherwise '' and the style
   * sheet's own words stand, as before. The first family is part of the signature.
   */
  const faces = new WeakMap<Document, { ctx: CanvasRenderingContext2D | null; served: Set<string>; seen: Map<string, string> }>();
  const drawnOfStyle = (st: CSSStyleDeclaration, doc: Document): string => {
    let f = faces.get(doc);
    if (!f) {
      let ctx: CanvasRenderingContext2D | null = null;
      const served = new Set<string>();
      const name = (v: string) => v.replace(/["']/g, '').trim().toLowerCase();
      try {
        const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
        let settled = !!fonts && fonts.status === 'loaded';
        let k = 0;
        if (settled) {
          fonts!.forEach((face) => {
            if (k++ >= 500) return;
            if (face.status !== 'loaded' && face.status !== 'unloaded') settled = false;
            else if (face.status === 'loaded') served.add(name(face.family));
          });
        }
        // A family with a source on the reader's own device is not the same faces for every reader.
        const sheets = doc.styleSheets;
        let rules = 0;
        for (let i = 0; i < sheets.length && i < 60 && rules < 5000; i++) {
          let list: CSSRuleList | null = null;
          try { list = sheets[i]!.cssRules; } catch { list = null; }
          for (let j = 0; list && j < list.length && rules < 5000; j++, rules++) {
            const rule = list[j] as CSSRule & { style?: CSSStyleDeclaration };
            if (rule.constructor.name !== 'CSSFontFaceRule' || !rule.style) continue;
            if (/\blocal\(/i.test(rule.style.getPropertyValue('src'))) served.delete(name(rule.style.getPropertyValue('font-family')));
          }
        }
        if (settled && k <= 500 && served.size) {
          const canvas = doc.createElement('canvas');
          canvas.width = 320;
          canvas.height = 72;
          ctx = canvas.getContext('2d', { willReadFrequently: true });
        }
      } catch { ctx = null; }
      faces.set(doc, (f = { ctx, served, seen: new Map() }));
    }
    const first = family0(st);
    if (!f.ctx || !f.served.has(first)) return '';
    const ctx = f.ctx;
    const weight = weightOf(st);
    const key = `${st.fontStyle}|${weight}|${first}`;
    let face = f.seen.get(key);
    if (face === undefined) {
      face = '';
      try {
        if (f.seen.size < 300) {
          /** The ink of the sample in the first family, with `behind` standing behind it; '' when the canvas does not take the font. */
          const ink = (behind: string): string => {
            // A font the canvas does not take leaves the one set before: told by the marker.
            ctx.font = '10px monospace';
            const marker = ctx.font;
            ctx.font = `${st.fontStyle} ${weight} 48px "${first.replace(/["\\]/g, '')}", ${behind}`;
            if (ctx.font === marker) return '';
            ctx.clearRect(0, 0, 320, 72);
            ctx.fillStyle = '#000';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText('Rag 38&', 4, 52);
            const width = ctx.measureText('Hamburgefonstiv 0123456789').width;
            const px = ctx.getImageData(0, 0, 320, 72).data;
            let hash = 2166136261;
            let dots = 0;
            for (let i = 3; i < px.length; i += 4) {
              const alpha = px[i]!;
              if (alpha) dots++;
              hash = Math.imul(hash ^ alpha, 16777619);
            }
            return dots >= 50 && width > 0 ? `${(hash >>> 0).toString(36)}.${Math.round(width * 10)}` : '';
          };
          // The same ink over two different stand-ins: every letter of the sample is the family's own.
          const one = ink('monospace');
          if (one && one === ink('serif')) face = one;
        }
      } catch { face = ''; }
      f.seen.set(key, face);
    }
    if (!face) return '';
    return `${Math.round((parseFloat(st.fontSize) || 16) * 2) / 2}|${face}|${family0(st)}|${st.textTransform}|${st.fontStyle}|${st.fontStretch || 'normal'}|${st.fontVariantCaps || 'normal'}|${settingsOf(st)}`;
  };
  /**
   * Text in the Latin script only (letters of no other script; figures, punctuation and accents are common to all):
   * the sample line above is Latin, and which faces a family has for the letters of another script, and whether it
   * has them at all, it cannot show. A line with letters of another script is never a twin by the picture (Sol review
   * of batch 17, S6: "non-Latin or mixed script undecided").
   */
  const latinOnly = (text: string): boolean => /\p{Script=Latin}/u.test(text) && !/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text);
  /**
   * The line's OWN letters as drawn in a style (Sol review of batch 17, S6): its text, as the style shows it (upper or
   * lower case), drawn on a canvas in the style's slant and weight in its first family, over two different stand-ins;
   * the ink, where both leave the same (every letter of the line is the family's own, none drawn by a stand-in), else
   * ''. Two styles whose sample leaves the same ink may still draw a letter of the line differently (a face served
   * for some letters only, `unicode-range`): the twin by the picture also needs the line's own letters to leave the
   * same ink in both. Only for a family the page serves (as `drawnOfStyle`); '' for text of another script.
   */
  const glyphCanvas = new WeakMap<Document, CanvasRenderingContext2D | null>();
  const glyphsOf = (text: string, st: CSSStyleDeclaration, doc: Document): string => {
    const first = family0(st);
    const f = faces.get(doc);
    if (!f?.ctx || !f.served.has(first) || !latinOnly(text)) return '';
    let ctx = glyphCanvas.get(doc);
    if (ctx === undefined) {
      try {
        const canvas = doc.createElement('canvas');
        canvas.width = 1800;
        canvas.height = 56;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      } catch { ctx = null; }
      glyphCanvas.set(doc, ctx);
    }
    if (!ctx) return '';
    const shown = (st.textTransform === 'uppercase' ? text.toUpperCase() : st.textTransform === 'lowercase' ? text.toLowerCase() : text).replace(/\s+/g, ' ').trim();
    // (Capitalised text, and text longer than the canvas, are not drawn as shown: not compared.)
    if (!shown || shown.length > 60 || st.textTransform === 'capitalize') return '';
    const c = ctx;
    const ink = (behind: string): string => {
      c.font = '10px monospace';
      const marker = c.font;
      c.font = `${st.fontStyle} ${weightOf(st)} 32px "${first.replace(/["\\]/g, '')}", ${behind}`;
      if (c.font === marker) return '';
      if (c.measureText(shown).width > 1790) return '';
      c.clearRect(0, 0, 1800, 56);
      c.fillStyle = '#000';
      c.textBaseline = 'alphabetic';
      c.fillText(shown, 4, 40);
      const px = c.getImageData(0, 0, 1800, 56).data;
      let hash = 2166136261;
      let dots = 0;
      for (let i = 3; i < px.length; i += 4) {
        const alpha = px[i]!;
        if (alpha) dots++;
        hash = Math.imul(hash ^ alpha, 16777619);
      }
      return dots >= 20 ? `${(hash >>> 0).toString(36)}.${dots}` : '';
    };
    try {
      const one = ink('monospace');
      return one && one === ink('serif') ? one : '';
    } catch { return ''; }
  };
  /** The element that holds the first text of `el` (a lone strong inside a p is the line). */
  const holderOf = (el: Element): Element => {
    const w = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.nodeValue ?? '').trim()) return n.parentElement ?? el;
    return el;
  };
  const sigOf = (el: Element): string => sigOfStyle(styleOf(holderOf(el)));
  const drawnOf = (el: Element): string => drawnOfStyle(styleOf(holderOf(el)), el.ownerDocument ?? document);
  /**
   * Whether all of a line's text is set one way (the same size, weight, family, case and slant from its first
   * word to its last). A word set like a heading that runs into a sentence of body text is a lead-in; a line with
   * a smaller note after it is a label with a note. Neither is a line set like a heading.
   */
  const setOneWay = (el: Element): boolean => {
    const w = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let sig = '';
    let k = 0;
    for (let n = w.nextNode(); n && k < 60; n = w.nextNode()) {
      if (!(n.nodeValue ?? '').trim() || !n.parentElement) continue;
      k++;
      const one = sigOfStyle(styleOf(n.parentElement));
      if (!sig) sig = one;
      else if (one !== sig) return false;
    }
    return k < 60;
  };
  /** Headings of same-origin frames: judged only for placeholder text (`frameHeadings`). */
  const frameHeadings: HeadingRead[] = [];
  const frames: Element[] = [];
  /** Open shadow roots met by the walk, read for F2 section titles too. */
  const shadows: ShadowRoot[] = [];
  walk(document, (el) => {
    if (el.localName === 'iframe' || el.localName === 'frame') { frames.push(el); return; }
    if (el.shadowRoot && shadows.length < 50) shadows.push(el.shadowRoot);
    const level = levelOf(el);
    if (!level) {
      if (presented.length < 20) { const b = presentedOf(el, pageCopy, ''); if (b) presented.push(b); }
      return;
    }
    if (!exposed(el)) return;
    if (headings.length >= limits.headings) { truncated = true; return; }
    const name = nameOf(el);
    const sig = name && headings.length < 400 && seenBox(el) ? sigOf(el) : '';
    const drawn = sig ? drawnOf(el) : '';
    // The heading's own letters as drawn, for the site's other pages (`siteTwinFindings`: the same line, drawn alike):
    // only for a short name (SITE_TWIN.chars, in the page) in a type the picture can prove.
    const glyphs = drawn && name.length <= 80 && headings.length < 60 ? glyphsOf(clean(name), styleOf(holderOf(el)), el.ownerDocument ?? document) : '';
    headings.push({ level, text: clean(name), chars: name.length, target: cssPath(el), ...(name.length >= 200 /* HEADINGS_LIMITS.paragraphChars (in the page) */ ? { own: seenText(el) } : {}), ...(sig ? { sig } : {}), ...(drawn ? { drawn } : {}), ...(glyphs ? { glyphs } : {}) });
    for (const one of sig && headingSigs.size < 400 ? [sig, ...(drawn ? [`~${drawn}`] : [])] : []) {
      headingSigs.add(one);
      if (!headingBySig.has(one)) headingBySig.set(one, { text: clean(name, 60), level });
      // (The style of the first heading drawn each way: a line taken for its twin by the picture is drawn in it too.)
      if (one.startsWith('~') && !headingStyleBySig.has(one)) headingStyleBySig.set(one, { st: styleOf(holderOf(el)), doc: el.ownerDocument ?? document });
    }
  });

  let frameH1 = false;
  let bigUnreadableFrame = false;
  /** Same-origin frame documents read, and whether each has a heading below level 1 (F2 reads only those without). */
  const frameDocs: { doc: Document; sections: boolean; prefix: string }[] = [];
  const vw = window.innerWidth || document.documentElement.clientWidth || 1;
  const vh = window.innerHeight || document.documentElement.clientHeight || 1;
  for (const f of frames.slice(0, limits.frames)) {
    if (!exposed(f)) continue;
    let doc: Document | null = null;
    try {
      doc = (f as HTMLIFrameElement).contentDocument;
    } catch {
      doc = null;
    }
    if (doc?.documentElement) {
      // A frame's own walk has its own element budget, and does not mark the page's read as cut short.
      const before: number = walked;
      const cut: boolean = truncated;
      walked = 0;
      const prefix = `${cssPath(f)} >>> `;
      const copy = bodyCopyPx(doc);
      let sections = false;
      walk(doc, (el) => {
        const lv = levelOf(el);
        if (!lv) {
          if (presented.length < 20) { const b = presentedOf(el, copy, prefix); if (b) presented.push(b); }
          return;
        }
        if (!exposed(el)) return;
        const name = nameOf(el);
        if (lv === 1 && name) frameH1 = true;
        if (lv >= 2 && name) sections = true;
        if (name && frameHeadings.length < 200) frameHeadings.push({ level: lv, text: clean(name), target: `${prefix}${cssPath(el)}` });
      });
      frameDocs.push({ doc, sections, prefix });
      walked = before;
      truncated = cut;
      continue;
    }
    const r = f.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (w * h >= 0.5 * vw * vh) bigUnreadableFrame = true;
  }
  // F2: section titles shown as headings but not marked up, read only where the page (its document, its open shadow
  // roots, a same-origin frame) has no heading below level 1. A candidate is seen on screen (never clipped), a block of
  // its own outside live regions, lists, tables and landmarks other than main, short with no sentence punctuation at the
  // end, followed by a block of body copy, and bold or larger against that copy; two or more in one pattern (the same
  // element, weight and size) fail.
  const styled: StyledBlock[] = [];
  const NOT_IN = 'h1, h2, h3, h4, h5, h6, [role="heading"], a, button, label, legend, summary, th, td, caption, figcaption, dt, dd, li, [role="listitem"], [role="cell"], [role="gridcell"], [role="row"], [role="option"], [role="treeitem"], nav, header, footer, aside, form, table, dialog, blockquote, address, output, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="menu"], [role="menubar"], [role="tablist"], [role="dialog"], [role="alertdialog"], [role="button"], [role="link"], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [aria-live], [aria-hidden="true"]';
  const INSIDE = 'a, button, input, select, textarea, img, svg, picture, video, iframe, [role], [tabindex], h1, h2, h3, h4, h5, h6, ul, ol, table';
  const words = (t: string) => t.replace(/\s+/g, ' ').trim();
  const titlesIn = (root: ParentNode, copy: number, prefix: string): StyledBlock[] => {
    const groups = new Map<string, StyledBlock[]>();
    const blocks = root.querySelectorAll('div, p, section > span, center, font');
    const max = limits.styled ?? 4000;
    for (let i = 0; i < blocks.length && i < max; i++) {
      const el = blocks[i]!;
      const text = words(el.textContent ?? '');
      // A title: short, with letters, not a sentence or a label ("Hours:"), and nothing but text inside.
      if (text.length < 3 || text.length > 80 || !/\p{L}/u.test(text) || /[.!?:;,]$/.test(text) || el.querySelector(INSIDE) || el.closest(NOT_IN)) continue;
      const display = styleOf(el).display;
      if (!/^(block|flex|grid|flow-root|table-caption)$/.test(display) || !exposed(el) || !seenBox(el)) continue;
      // Followed by body copy: the next shown sibling block has a sentence or more, in a plain style.
      let next = el.nextElementSibling;
      while (next && (!words(next.textContent ?? '') || styleOf(next).display === 'none')) next = next.nextElementSibling;
      if (!next || words(next.textContent ?? '').length < 40 || next.closest(NOT_IN) || /^(h[1-6]|ul|ol|table|form|nav)$/i.test(next.localName)) continue;
      const own = textStyle(el);
      const body = textStyle(next);
      const base = Math.max(body.px, copy);
      if (body.weight >= 600 || own.px < base - 0.5 || !(own.weight >= 600 || own.px >= 1.15 * base)) continue;
      const key = `${el.localName}|${own.weight}|${Math.round(own.px)}`;
      const g = groups.get(key) ?? [];
      g.push({ text: clean(text), target: `${prefix}${cssPath(el)}` });
      groups.set(key, g);
    }
    return [...groups.values()].filter((g) => g.length >= 2).flat();
  };
  if (!headings.some((h) => h.level >= 2 && h.text)) {
    if (document.body) styled.push(...titlesIn(document.body, pageCopy, ''));
    // cssPath already names the host of an element in a shadow root.
    for (const sr of shadows) if (styled.length < 20) styled.push(...titlesIn(sr, pageCopy, ''));
  }
  for (const fd of frameDocs) if (!fd.sections && fd.doc.body && styled.length < 20) styled.push(...titlesIn(fd.doc.body, bodyCopyPx(fd.doc), fd.prefix));
  // F2 as a failure: text the page itself proves it shows as a section heading (see `HeadingsRead.shown`). Read on
  // every page. A candidate is a line of its own with nothing but text in it, short, with no sentence punctuation
  // at its end, seen on screen, outside headings, links, labels, lists, tables, forms, navigation, the page's
  // header and footer and live regions; larger than the body copy and bold, or much larger; with body copy or a
  // list after it; not under a real heading (a subtitle) and not above one (an overline).
  const SHOWN_NOT_IN = 'h1, h2, h3, h4, h5, h6, [role="heading"], a, button, label, legend, summary, th, td, caption, figcaption, dt, dd, li, [role="listitem"], [role="cell"], [role="gridcell"], [role="row"], [role="option"], [role="treeitem"], nav, header, footer, form, table, dialog, blockquote, address, output, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"], [role="tablist"], [role="dialog"], [role="alertdialog"], [role="button"], [role="link"], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [aria-live], [aria-hidden="true"]';
  const INLINE = new Set(['b', 'strong', 'em', 'i', 'span', 'u', 'small', 'mark', 'font', 'sup', 'sub', 'abbr', 'cite', 'q']);
  /** Words in a class or id that call the element a heading. */
  const NAMES = new Set(['heading', 'headline', 'title', 'subheading', 'subhead', 'header', 'hdr']);
  /**
   * The words of `NAMES` that say "heading" or "title" outright. Only these count toward a proof (`StyledBlock.named`):
   * "header" also names a bar, a banner and the top of a card or a message, so it makes a candidate and no more.
   */
  const NAMES_PLAIN = new Set(['heading', 'headline', 'title', 'subheading', 'subhead']);
  /**
   * Words that make a class a way of setting type, not a name for what the element is: "font-heading-lg",
   * "text-title", "has-heading-font-family", "title-large", "heading-2" set text in the heading typeface or size
   * wherever they are put (a figure, a quotation, a lead-in), so they name nothing (review of batch 17).
   */
  const TYPE_WORDS = new Set(['font', 'fonts', 'text', 'type', 'typo', 'typography', 'typescale', 'family', 'size', 'weight', 'style', 'styled', 'has', 'is', 'u', 'util', 'utility', 'leading', 'tracking', 'color', 'colour', 'xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'small', 'medium', 'large', 'larger', 'big', 'tiny', 'huge', 'bold', 'light', 'display', 'level', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  /** The plain naming word of the first class or id among `els` that names its element a heading or a title. */
  const plainNameOf = (els: Element[]): string | undefined => {
    for (const e of els) {
      for (const name of [e.id, ...(typeof e.className === 'string' ? e.className.split(/\s+/) : [])]) {
        if (!name) continue;
        const t = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const word = t.find((x) => NAMES_PLAIN.has(x));
        if (word && !t.some((x) => TYPE_WORDS.has(x) || /^\d/.test(x))) return word;
      }
    }
    return undefined;
  };
  /** Words that say it is something else a designer sets large: a subtitle, a date, a price, a name, a label. */
  const NOT_NAMES = new Set(['subtitle', 'tagline', 'eyebrow', 'kicker', 'overline', 'lede', 'lead', 'intro', 'caption', 'byline', 'meta', 'date', 'time', 'price', 'cost', 'fee', 'label', 'badge', 'quote', 'stat', 'job', 'position', 'author', 'breadcrumb', 'logo', 'brand', 'site']);
  const tokensOf = (el: Element): string[] => `${el.id} ${typeof el.className === 'string' ? el.className : ''}`.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const DATE = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})$/i;
  const isHeadingEl = (el: Element) => /^h[1-6]$/i.test(el.localName) || (el.getAttribute('role') ?? '').trim().toLowerCase() === 'heading';
  /** A heading assistive technology is given as one: not an h1–h6 whose role says it is something else. */
  const isRealHeading = (el: Element) => {
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
    return role ? role === 'heading' : /^h[1-6]$/i.test(el.localName);
  };
  /** A date, a span of dates, a month, a weekday or a time and nothing else ("November 18–20", "Monday", "9:00 AM", "Spring 2026"). */
  const DATE_PART = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i;
  const DATE_FILL = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|spring|summer|fall|autumn|winter|today|tomorrow|yesterday|noon|midnight|am|pm|a\.m|p\.m|to|through|thru|until|till|from|and|at|on|of|the|week|weeks|day|days|q[1-4]|fy)\b/gi;
  const dateLike = (t: string): boolean => (/\d/.test(t) || DATE_PART.test(t)) && !/\p{L}{2,}/u.test(t.replace(/\d+(?:st|nd|rd|th)?/gi, ' ').replace(DATE_FILL, ' '));
  /** The line is a quotation by its markup (a `q` element holds it) or by marks the style sheet puts around it. */
  const quoted = (el: Element): boolean => {
    try {
      if (el.localName === 'q' || el.closest('q') || el.querySelector('q')) return true;
      const view = el.ownerDocument.defaultView ?? window;
      for (const pseudo of ['::before', '::after']) {
        const content = view.getComputedStyle(el, pseudo).content.replace(/^["'](.*)["']$/, '$1').trim();
        if (/^(?:open-quote|close-quote)$/.test(content) || /^["“”‘’«»„‹›]$/.test(content)) return true;
      }
    } catch { /* not told */ }
    return false;
  };
  /** Elements with a click listener of their own (the listener hook's records; main document only). */
  const clickers = new Set<Element>();
  try {
    const target = (window as unknown as { __grntedTarget?: (ref: number) => unknown }).__grntedTarget;
    for (const ref of (limits.clicks ?? []).slice(0, 2000)) {
      const el = target?.(ref);
      if (el instanceof Element && el !== document.body && el !== document.documentElement) clickers.add(el);
    }
  } catch { /* no listener records: the cursor and the attributes still tell */ }
  const TOGGLES = '[aria-expanded], [aria-controls], [aria-haspopup], [aria-pressed], [data-toggle], [data-bs-toggle], [data-target], [data-bs-target], [onclick]';
  /** The line, or a wrapper that holds it, acts when it is clicked: it is (also) a control, an accordion's bar or a card's link. */
  const takesClicks = (el: Element): boolean => {
    for (let cur: Element | null = el, i = 0; cur && i < 4 && cur !== document.body && !/^(main|body|html)$/i.test(cur.localName); cur = cur.parentElement, i++) {
      if (clickers.has(cur) || cur.matches(TOGGLES) || (i === 0 && styleOf(cur).cursor === 'pointer')) return true;
    }
    return false;
  };
  /** The first element with text in `el` that is a heading, through wrappers that hold nothing else before it. */
  const startsWithHeading = (el: Element): boolean => {
    for (let cur: Element | null = el, i = 0; cur && i < 4; i++) {
      if (isHeadingEl(cur)) return true;
      let first: Element | null = null;
      for (const k of Array.from(cur.children)) if (words(k.textContent ?? '') && styleOf(k).display !== 'none') { first = k; break; }
      cur = first;
    }
    return false;
  };
  /** The heading `el` begins with (as `startsWithHeading`), when it has text and is seen on screen. */
  const headingAtStart = (el: Element): Element | null => {
    for (let cur: Element | null = el, i = 0; cur && i < 4; i++) {
      if (isHeadingEl(cur)) return isRealHeading(cur) && words(cur.textContent ?? '') && exposed(cur) && seenBox(cur) ? cur : null;
      let first: Element | null = null;
      for (const k of Array.from(cur.children)) if (words(k.textContent ?? '') && styleOf(k).display !== 'none') { first = k; break; }
      cur = first;
    }
    return null;
  };
  /** The families the first text of `el` is set in, as the browser resolved them. */
  const familiesOf = (el: Element): string => {
    const w = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let holder: Element = el;
    for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.nodeValue ?? '').trim()) { holder = n.parentElement ?? el; break; }
    return styleOf(holder).fontFamily;
  };
  /** Lines shown like headings that this page gives no proof for (`HeadingsRead.plain`). */
  const unproven: StyledBlock[] = [];
  // Text that names something else is never an unmarked heading (review round 1, ruling 4): `namesSomething` above.
  const shownIn = (root: ParentNode, copy: number, prefix: string): StyledBlock[] => {
    const out: StyledBlock[] = [];
    /** For each line kept: the block it heads a part of and its make (element, class and type), for `repeated`. */
    const makes: { parent: Element | null; make: string; oneWay: boolean }[] = [];
    const taken: Element[] = [];
    const refs = new Set<string>();
    const tied = root.querySelectorAll('[aria-labelledby], [aria-describedby]');
    for (let i = 0; i < tied.length && i < 5000; i++) for (const id of `${tied[i]!.getAttribute('aria-labelledby') ?? ''} ${tied[i]!.getAttribute('aria-describedby') ?? ''}`.split(/\s+/)) if (id) refs.add(id);
    const blocks = root.querySelectorAll('div, p, span, b, strong, center, font');
    const max = limits.styled ?? 4000;
    for (let i = 0; i < blocks.length && i < max && out.length < 20; i++) {
      const el = blocks[i]!;
      const text = words(el.textContent ?? '');
      if (text.length < 3 || text.length > 80 || text.split(' ').length > 12 || !/\p{L}/u.test(text) || /[.!?:;,]$/.test(text) || METRIC.test(text) || DATE.test(text) || /^[$€£¥]\s?\d/.test(text)) continue;
      if (el.closest(SHOWN_NOT_IN) || taken.some((t) => t.contains(el))) continue;
      const inner = el.querySelectorAll('*');
      let plain = true;
      for (let k = 0; k < inner.length && plain; k++) plain = INLINE.has(inner[k]!.localName) && !inner[k]!.hasAttribute('role') && !inner[k]!.hasAttribute('tabindex');
      if (!plain || el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('onclick')) continue;
      if (!/^(block|flex|grid|flow-root|list-item|table-caption)$/.test(styleOf(el).display) || !exposed(el) || !seenBox(el)) continue;
      // What it calls itself (its own class and id, and those of the elements that hold all its text).
      const tokens = [...tokensOf(el), ...Array.from(inner).filter((d) => words(d.textContent ?? '') === text).flatMap(tokensOf)];
      if (tokens.some((t) => NOT_NAMES.has(t))) continue;
      // The content it introduces: its next shown sibling (or its wrapper's, when it is alone in a wrapper).
      let at: Element = el;
      let next: Element | null = null;
      for (let up = 0; up < 3; up++) {
        next = at.nextElementSibling;
        while (next && (!words(next.textContent ?? '') || styleOf(next).display === 'none')) next = next.nextElementSibling;
        const parent: Element | null = at.parentElement;
        if (next || !parent || parent === document.body || /^(main|section|article|aside|body)$/i.test(parent.localName) || words(parent.textContent ?? '') !== text) break;
        at = parent;
      }
      if (!next || startsWithHeading(next)) continue;
      // Under a real heading it is a subtitle.
      let prev = at.previousElementSibling;
      while (prev && (!words(prev.textContent ?? '') || styleOf(prev).display === 'none')) prev = prev.previousElementSibling;
      if (prev && isHeadingEl(prev)) continue;
      const own = textStyle(el);
      // Larger than the text it introduces, and than the page's ordinary text (the body's own size, or the
      // body copy when that is smaller: a page with one large lead paragraph has no other measure).
      let base = Math.min(copy, parseFloat(styleOf(el.ownerDocument.body ?? el).fontSize) || copy);
      if (/^(ul|ol|dl)$/i.test(next.localName)) {
        const items = next.querySelectorAll(':scope > li, :scope > dt');
        if (!items.length) continue;
        base = Math.max(base, textStyle(items[0]!).px);
      } else {
        // A line above a table may be the table's title (a caption's job, or aria-labelledby): not judged here.
        if (next.localName === 'table' || words(next.textContent ?? '').length < 40) continue;
        const body = textStyle(next);
        if (body.weight >= 600 || body.px > own.px - 1) continue;
        base = Math.max(base, body.px);
      }
      if (!((own.weight >= 600 && own.px >= 1.15 * base) || own.px >= 1.4 * base)) continue;
      const named = tokens.some((t) => NAMES.has(t));
      const namedBy = plainNameOf([el, ...Array.from(inner).filter((d) => words(d.textContent ?? '') === text)]);
      // The structural proof: set exactly like one of the page's real headings, from its first word to its last
      // (as the style sheet says it, or as the browser draws it).
      const sig = sigOf(el);
      const drawn = drawnOf(el);
      const oneWay = setOneWay(el);
      // The line's own letters as drawn (its text in Latin letters only, every letter from the family): needed for
      // a twin by the picture, on this page and on the site's other pages (Sol review of batch 17, S6).
      const glyphs = drawn && oneWay ? glyphsOf(clean(text), styleOf(holderOf(el)), el.ownerDocument ?? document) : '';
      const drawnHeading = drawn ? headingStyleBySig.get(`~${drawn}`) : undefined;
      // By the picture only where the line's own letters leave the same ink in its style and in the heading's: the
      // sample shows the same face; the letters of this very line must come out the same too.
      const drawnTwin = !!glyphs && !!drawnHeading && headingSigs.has(`~${drawn}`) && glyphs === glyphsOf(clean(text), drawnHeading.st, drawnHeading.doc);
      const twinKey = headingSigs.has(sig) ? sig : drawnTwin ? `~${drawn}` : '';
      const twin = !!twinKey && oneWay;
      // Its place: the first line of a box, beside boxes of the same element that begin with a real heading; and
      // whether it is set at least as large and as heavy as such a heading, in the same typeface.
      let peers = false;
      let peer: { text: string; prominent: boolean } | undefined;
      const box = at.parentElement;
      if (!twin && box && box.parentElement && box !== document.body && !/^(main|body)$/i.test(box.localName)) {
        let first: Element | null = null;
        for (const k of Array.from(box.children)) if (words(k.textContent ?? '') && styleOf(k).display !== 'none') { first = k; break; }
        if (first === at) {
          const sibs = Array.from(box.parentElement.children).filter((x) => x !== box && x.localName === box.localName).slice(0, 12);
          peers = sibs.some(startsWithHeading);
          // Against every real heading the boxes beside it begin with: at least as large and as heavy as each
          // (never only as the smallest of them), in the typeface each is set in.
          const heads = (peers ? sibs : []).map(headingAtStart).filter((h): h is Element => !!h);
          if (heads.length) {
            const families = familiesOf(el);
            const styles = heads.map((h) => textStyle(h));
            const prominent = oneWay && heads.every((h, k) => own.px >= styles[k]!.px - 0.5 && own.weight >= Math.min(styles[k]!.weight, 600) && familiesOf(h) === families);
            let largest = 0;
            styles.forEach((st, k) => { if (st.px > styles[largest]!.px) largest = k; });
            peer = { text: clean(nameOf(heads[largest]!), 60), prominent };
          }
        }
      }
      // What else the line may be, whatever its name, place or type (`StyledBlock.doubt`). Read for every candidate,
      // before any proof is taken: a recorded doubt is never set aside, not by a twin on this page nor by the site's
      // other pages (Sol review of batch 17, S1: "Riders of every age" over "took a bus…" is one sentence in two
      // blocks, whatever another page marks up).
      const after = words(next.textContent ?? '');
      const above = prev ? words(prev.textContent ?? '') : '';
      const doubt = /^\p{Ll}/u.test(after) && !/^(ul|ol|dl)$/i.test(next.localName) ? 'it reads on into the text after it'
        : /^["“”‘’'«»]|["“”‘’'«»]$/.test(text) || quoted(el) ? 'it is in quotation marks'
        : /^[\d$€£¥#+~≈(-]/.test(text) ? 'it begins with a figure'
        : dateLike(text) ? 'it is a date or a time'
        : prev && above.length <= 80 && !/[.!?:;,]$/.test(above) && textStyle(prev).px >= own.px - 0.5 ? 'it stands under another line set like a title'
        : takesClicks(el) || takesClicks(at) ? 'it takes clicks'
        : !seenBox(next) || !exposed(next) ? 'the text after it is not shown'
        : '';
      if (!named && !twin && !peers) {
        // No proof on this page: kept only for the site's other pages to decide (`siteTwinFindings`), never reported
        // here; and only where nothing says it may be something else (a line with a doubt is no candidate there).
        if (oneWay && !doubt && unproven.length < 10 && !namesSomething(el, at, refs)) {
          unproven.push({ text: clean(text), target: `${prefix}${cssPath(el)}`, sig, ...(drawn ? { drawn } : {}), ...(glyphs ? { glyphs } : {}), px: Math.round(own.px * 10) / 10 });
          // (Its inner elements hold the same line: one candidate, not two.)
          taken.push(el);
        }
        continue;
      }
      if (namesSomething(el, at, refs)) continue;
      taken.push(el);
      // Set exactly like the page's real headings, at the head of content: the proof. A name or a place alone is not
      // (`shownVerdict` says which of them together are).
      out.push({
        text: clean(text), target: `${prefix}${cssPath(el)}`, why: twin ? 'twin' : named ? 'named' : 'peers',
        ...(namedBy ? { named: namedBy } : {}), ...(peer ? { peer } : {}), ...(twin && headingBySig.has(twinKey) ? { twinOf: headingBySig.get(twinKey)! } : {}),
        ...(oneWay ? { sig, ...(drawn ? { drawn } : {}), ...(glyphs ? { glyphs } : {}) } : {}), px: Math.round(own.px * 10) / 10, ...(doubt ? { doubt } : {}),
      });
      makes.push({ parent: at.parentElement, make: `${el.localName}|${typeof el.className === 'string' ? el.className.trim().split(/\s+/).sort().join('.') : ''}|${sig}`, oneWay: oneWay && !doubt });
    }
    // Lines of one make that each head a part of the same block: they divide it into titled parts. (Lines set one
    // way from end to end, with nothing that says they may be something else: `doubt`.)
    out.forEach((b, i) => {
      const m = makes[i]!;
      if (!m.parent || !m.oneWay) return;
      const n = makes.filter((x) => x.parent === m.parent && x.make === m.make && x.oneWay).length;
      if (n >= 2) b.repeated = n;
    });
    return out;
  };
  const shown: StyledBlock[] = [];
  if (document.body) shown.push(...shownIn(document.body, pageCopy, ''));
  for (const sr of shadows) if (shown.length < 20) shown.push(...shownIn(sr, pageCopy, ''));
  for (const fd of frameDocs) if (fd.doc.body && shown.length < 20) shown.push(...shownIn(fd.doc.body, bodyCopyPx(fd.doc), fd.prefix));
  const shownTargets = new Set(shown.map((b) => b.target));
  return {
    title: clean(document.title, 200), headings, truncated, frameH1, bigUnreadableFrame,
    ...(presented.length ? { presented } : {}), ...(styled.some((b) => !shownTargets.has(b.target)) ? { styled: styled.filter((b) => !shownTargets.has(b.target)).slice(0, 20) } : {}),
    ...(frameHeadings.length ? { frameHeadings } : {}),
    ...(shown.length ? { shown: shown.slice(0, 20) } : {}),
    ...(unproven.length ? { plain: unproven } : {}),
  };
}

const quote = (s: string) => (s ? `“${s}”` : '(no text)');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Runs in the page: resolves when the page's web fonts have arrived, or after `ms` (never rejects). */
export function fontsSettled(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => { clearTimeout(timer); resolve(); };
    try {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (!fonts) { done(); return; }
      fonts.ready.then(done, done);
    } catch { done(); }
  });
}

/** One page's findings from what `readHeadings` reported (the cross-page rule is `templateH1Findings`). */
/** Abbreviations whose full stop ends no sentence ("St. Helens", "Dr. Lee", "No. 5"). */
const ABBREVIATIONS = new Set(['st', 'dr', 'mr', 'mrs', 'ms', 'no', 'vs', 'inc', 'jr', 'sr', 'co', 'corp', 'ltd', 'ave', 'mt', 'ft', 'dept', 'gov', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'etc', 'e.g', 'i.e', 'approx', 'est']);

/**
 * F43 (1.3.1): a heading's own text of `paragraphChars` or more reads as a paragraph, not a section title,
 * when it holds two sentences (a full stop, question or exclamation mark after a real word, then a second
 * clause of three words or more), or when it is `paragraphLongChars` long whatever its punctuation. One
 * sentence ending with a full stop is still a title (Grok round 2: a 210-character meeting title with a period).
 */
export function readsAsParagraph(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < HEADINGS_LIMITS.paragraphChars) return false;
  if (t.length >= HEADINGS_LIMITS.paragraphLongChars) return true;
  const re = /([\p{L}\p{N}.]+)[.!?]["'”’)\]]?\s+(?=\S)/gu;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const word = m[1]!.toLowerCase().replace(/\.$/, '');
    if (word.length < 2 || ABBREVIATIONS.has(word) || /\.[a-z]$/i.test(word) || /^[a-z]$/i.test(word)) continue;
    const rest = t.slice(m.index + m[0].length);
    if (rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= 3) return true;
  }
  return false;
}

/**
 * Template residue (2.4.6, scored): heading text that can only be a template's placeholder: "Lorem ipsum…", "Heading
 * text", "Your heading here", "Insert a title here", "Section title", "Title goes here", "Heading 2" (lead's ruling,
 * Sol round 1, 2026-11-07).
 */
const TEMPLATE_RESIDUE = /^(?:(?:heading|title) text|your (?:heading|title) here|(?:insert|add) (?:a |the |your )?(?:heading|title)(?: here)?|section (?:title|heading)|(?:heading|title) goes here|heading \d{1,2})$/;
/**
 * A bare word that may be a placeholder ("Heading", "Title", "Section", "Untitled", "Text", "TBD"): it may also be the
 * real topic ("Section" in a writing guide, an artwork named "Untitled"), so it is a recommendation, never scored.
 */
const PLACEHOLDER_WORD = /^(?:heading|header|headline|title|subtitle|sub heading|subheading|section|untitled|placeholder|text|tbd|todo|to be determined|new section|new heading|new title|sample (?:heading|title)|dummy (?:heading|title|text))$/;

const placeholderKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\s ]+/g, ' ').replace(/^[\s"'“”‘’([]+|[\s"'“”‘’)\].:!?…-]+$/g, '').trim();

/** The standard "Lorem ipsum" filler's words (the passage's first sentences). */
const LOREM_WORDS = new Set('lorem ipsum dolor sit amet consectetur consectetuer adipiscing adipisicing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' '));

/**
 * Filler and nothing else (lead's ruling, Sol round 2): it starts "Lorem ipsum" and every word is a standard filler
 * word, punctuation ignored. "Lorem ipsum alternatives for designers" names a topic.
 */
function isLoremFiller(t: string): boolean {
  // Punctuation around a word is ignored; digits and any other token are content ("Lorem ipsum 2.0", Sol round 3).
  const words = t.split(/\s+/).map((w) => w.replace(/^\p{P}+|\p{P}+$/gu, '')).filter(Boolean);
  return words.length >= 2 && words[0] === 'lorem' && words[1] === 'ipsum' && words.every((w) => LOREM_WORDS.has(w));
}

/** The whole heading is template residue (`TEMPLATE_RESIDUE` or lorem ipsum filler, scored), case, punctuation and spacing ignored. */
export function isPlaceholderHeading(text: string): boolean {
  const t = placeholderKey(text);
  return !!t && (TEMPLATE_RESIDUE.test(t) || isLoremFiller(t));
}

/** The whole heading is a bare word that may be a placeholder (`PLACEHOLDER_WORD`): a recommendation only. */
export function mayBePlaceholderHeading(text: string): boolean {
  const t = placeholderKey(text);
  return !!t && !TEMPLATE_RESIDUE.test(t) && PLACEHOLDER_WORD.test(t);
}

/**
 * What the page itself proves about a line it shows as a heading (pure; batch 17):
 * - 'twin': it is set exactly like one of the page's real headings (drawn in the same type, from its first word to
 *   its last);
 * - 'peer': the page's own markup calls it a heading or a title, AND it is the first line of a box beside boxes that
 *   begin with a real heading, AND it is set at least as large and as heavy as such a heading in the same typeface:
 *   the page marks up its neighbours' titles and shows this one at least as much a heading as they are;
 * - 'repeated': the page's own markup calls it a heading or a title, AND two or more lines of that one make (the
 *   same element, class and type) each head a part of the same block: they divide it into titled parts.
 * A naming class alone, a place among boxes alone, or a repeated line the page does not name stay undecided (null):
 * it may be a lead-in, a callout or a label (review round 1, ruling 4). A line with a doubt (`StyledBlock.doubt`: it
 * reads on into the text after it, it is a quotation, a figure or a date, it takes clicks…) is undecided whatever
 * proves it, a twin included (Sol review of batch 17, S1).
 */
export function shownVerdict(b: StyledBlock): 'twin' | 'peer' | 'repeated' | null {
  // A doubt the read recorded is never set aside, by any proof (Sol review of batch 17, S1).
  if (b.doubt) return null;
  if ((b.why ?? 'named') === 'twin') return 'twin';
  if (b.named && b.peer?.prominent) return 'peer';
  if (b.named && (b.repeated ?? 0) >= 2) return 'repeated';
  return null;
}

/** A line the page shows as a section heading with no heading markup (F2), as a failure. */
export const isShownHeading = (f: ProbeFinding) => f.criterion === '1.3.1' && f.status === 'failed' && / is shown as a section heading /.test(f.detail);

export function headingFindings(read: HeadingsRead): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const { headings } = read;
  // Empty headings (1.3.1, ACT ffd0e9: heading markup with no name in it gives the structure an empty entry).
  const empty = headings.filter((h) => !h.text);
  empty.slice(0, HEADINGS_LIMITS.perKind).forEach((h, i, shown) => {
    const more = i === shown.length - 1 && empty.length > shown.length ? ` (${plural(empty.length - shown.length, 'more empty heading')} on this page)` : '';
    // Batch 19 (the lead's ruling, real-site dev split): Needs review, never a failure. ACT ffd0e9 ("Heading has
    // non-empty accessible name") maps to ARIA 1.2 only, and axe's empty-heading rule is a best practice.
    out.push({ criterion: '1.3.1', status: 'flagged', target: h.target, detail: `A level-${h.level} heading has no text, so screen readers announce an empty heading${more}; whether that hides structure is for a person to check` });
  });
  // A paragraph marked up as a heading (1.3.1, F43): structure markup that does not match the content.
  const long = headings.filter((h) => (h.chars ?? h.text.length) >= HEADINGS_LIMITS.paragraphChars && readsAsParagraph(h.own ?? h.text));
  long.slice(0, HEADINGS_LIMITS.perKind).forEach((h, i, shown) => {
    const more = i === shown.length - 1 && long.length > shown.length ? ` (${plural(long.length - shown.length, 'more')} on this page)` : '';
    out.push({
      criterion: '1.3.1', status: 'failed', target: h.target,
      detail: `A paragraph is marked up as a level-${h.level} heading (${(h.own ?? '').length || (h.chars ?? h.text.length)} characters): ${quote(h.text)}, so screen readers list it among the page's headings${more}`,
    });
  });
  // F2 where the page itself proves the text is shown as a section heading (`HeadingsRead.shown`): text set
  // exactly like the page's real headings at the head of a section of content is a failure. A class that calls
  // it a title, or its place in a box beside boxes that begin with a real heading, makes it a candidate only
  // (review round 1, ruling 4): it may be a lead-in, a callout or a card's label, so it is undecided.
  // Since batch 17 two of the page's own proofs together fail too (`shownVerdict`): a line the markup names a
  // heading that is set at least as large as the real heading its neighbour box begins with, or that divides a
  // block into titled parts with others of its make.
  const shownBlocks = (read.shown ?? []).filter((b) => shownVerdict(b) !== null);
  const PROOF = (b: StyledBlock): string => {
    const v = shownVerdict(b);
    const size = b.px ? `${b.px} px` : 'larger type';
    if (v === 'peer') return `the first line of its box, in ${size}, set at least as large as ${quote(b.peer!.text)}, the real heading the box beside it begins with; the page's own markup calls it a “${b.named}”`;
    if (v === 'repeated') return `one of ${b.repeated} lines of one make, each on its own line at the head of the text it introduces, in ${size}; the page's own markup calls them a “${b.named}”`;
    return `on its own line, at the head of the text it introduces, and set exactly like the page's real headings${b.twinOf ? `: the same type as its level-${b.twinOf.level} heading ${quote(b.twinOf.text)}${b.px ? `, ${b.px} px` : ''}` : ''}`;
  };
  shownBlocks.slice(0, HEADINGS_LIMITS.perKind).forEach((b, i, list) => {
    const more = i === list.length - 1 && shownBlocks.length > list.length ? ` (${plural(shownBlocks.length - list.length, 'more')} on this page)` : '';
    out.push({
      criterion: '1.3.1', status: 'failed', target: b.target,
      detail: `${quote(b.text)} is shown as a section heading (${PROOF(b)}) but is not marked up as a heading, so screen readers cannot list it or jump to it${more}`,
    });
  });
  const WHY: Record<'twin' | 'named' | 'word' | 'peers', string> = {
    twin: 'it is set exactly like the page\'s real headings, at the head of the text it introduces',
    named: 'it is set larger than the text it introduces, and the page\'s own markup names it a heading or title',
    // (A class that sets type, or one that says "header": the word is there, and names nothing.)
    word: 'it is set larger than the text it introduces, and a class or id of its markup has a word such as heading, title or header in it',
    peers: 'it is set larger than the text it introduces, at the top of a box whose neighbours begin with a real heading',
  };
  const maybeShown = (read.shown ?? []).filter((b) => shownVerdict(b) === null);
  maybeShown.slice(0, HEADINGS_LIMITS.perKind).forEach((b, i, list) => {
    const more = i === list.length - 1 && maybeShown.length > list.length ? ` (${plural(maybeShown.length - list.length, 'more')} on this page)` : '';
    out.push({
      criterion: '1.3.1', status: 'not_testable', target: b.target,
      detail: `${quote(b.text)} may be a section heading that is not marked up as one (${WHY[b.why === 'twin' ? 'twin' : b.why === 'peers' ? 'peers' : b.named ? 'named' : 'word']}), or a lead-in, a callout or a label${b.doubt ? ` (${b.doubt})` : ''}: this could not be told${more}`,
    });
  });
  // F92, and F2 without that proof, are recommendations, never failures (lead's ruling, Sol round 2): whether a
  // de-roled heading or bold text serves as a section heading is a judgement, left to the AI review. Listed so a person can look.
  const presented = read.presented ?? [];
  presented.slice(0, HEADINGS_LIMITS.perKind).forEach((b) => {
    out.push({
      criterion: '1.3.1', status: 'no_failures_found', advice: true, target: b.target,
      detail: `${quote(b.text)} looks like a heading, but a presentation role on its h${b.level ?? 2} element keeps it out of the headings list screen readers use: check whether it names a section`,
    });
  });
  const styled = read.styled ?? [];
  if (styled.length >= HEADINGS_LIMITS.styledMin) {
    styled.slice(0, HEADINGS_LIMITS.perKind).forEach((b) => {
      out.push({
        criterion: '1.3.1', status: 'no_failures_found', advice: true, target: b.target,
        detail: `${quote(b.text)} looks like a section heading but is not marked up as one: if it names a section, mark it up as a heading so screen readers can list it and jump to it`,
      });
    });
  }
  // 2.4.6: headings that are template residue ("Lorem ipsum", "Your heading here"), in the page and its same-origin
  // frames; a bare word that may be a placeholder ("Heading", "Untitled") is a recommendation only.
  const all = [...headings, ...(read.frameHeadings ?? [])];
  const placeholders = all.filter((h) => h.text && isPlaceholderHeading(h.text));
  placeholders.slice(0, HEADINGS_LIMITS.perKind).forEach((h, i, shown) => {
    const more = i === shown.length - 1 && placeholders.length > shown.length ? ` (${plural(placeholders.length - shown.length, 'more')} on this page)` : '';
    out.push({
      criterion: '2.4.6', status: 'failed', target: h.target,
      detail: `A level-${h.level} heading reads ${quote(h.text)}, placeholder text left from a template that does not say what its section is about${more}`,
    });
  });
  const maybe = all.filter((h) => h.text && mayBePlaceholderHeading(h.text));
  maybe.slice(0, HEADINGS_LIMITS.perKind).forEach((h) => {
    out.push({
      criterion: '2.4.6', status: 'no_failures_found', advice: true, target: h.target,
      detail: `A level-${h.level} heading reads only ${quote(h.text)}: check that it says what its section is about`,
    });
  });
  // Recommendations, never failures (WCAG requires neither): no level-1 heading, and levels that skip downwards.
  const named = headings.some((h) => h.level === 1 && h.text);
  if (!named && !read.frameH1 && !read.bigUnreadableFrame && !read.truncated) {
    const first = headings.find((h) => h.text);
    out.push({
      criterion: '2.4.6', status: 'no_failures_found', advice: true, ...(first ? { target: first.target } : {}),
      detail: first
        ? `The page has no level-1 heading; its first heading is ${quote(first.text)} at level ${first.level}`
        : 'The page has no headings',
    });
  }
  const skips: { from: HeadingRead; to: HeadingRead }[] = [];
  for (let i = 1; i < headings.length; i++) {
    if (headings[i]!.level - headings[i - 1]!.level >= 2) skips.push({ from: headings[i - 1]!, to: headings[i]! });
  }
  skips.slice(0, HEADINGS_LIMITS.perKind).forEach((s, i, shown) => {
    const more = i === shown.length - 1 && skips.length > shown.length ? ` (${plural(skips.length - shown.length, 'more skip')} on this page)` : '';
    out.push({
      criterion: '1.3.1', status: 'no_failures_found', advice: true, target: s.to.target,
      detail: `Heading levels skip from ${s.from.level} to ${s.to.level}: ${quote(s.to.text)} (level ${s.to.level}) follows ${quote(s.from.text)} (level ${s.from.level})${more}`,
    });
  });
  return out;
}

/** What the probe keeps from a page for the cross-page rules (`ProbeRun.data`). */
export interface HeadingsData {
  title: string;
  /** The page's level-1 headings with text (at most 5). */
  h1: { text: string; target: string }[];
  /**
   * How the page's real headings that are seen on screen are set, by their text (compared as `normalizeHeading`
   * reads it; at most `SITE_TWIN.headings`, texts of at most `SITE_TWIN.chars` characters): what `siteTwinFindings`
   * sets another page's unmarked line against. Absent in runs made before 2026-11-12.
   */
  sigs?: { text: string; level: number; sig: string; drawn?: string; glyphs?: string }[];
  /**
   * The lines this page shows as headings that it could not decide alone (`shownVerdict` null), each set one way
   * from its first word to its last and with no doubt (`StyledBlock.doubt`), at most `SITE_TWIN.lines`.
   */
  maybe?: { text: string; target: string; sig: string; drawn?: string; glyphs?: string }[];
}

/** Limits of what a page keeps for the site-wide heading rule (the run's data stays small). */
export const SITE_TWIN = { headings: 60, lines: 10, chars: 80 } as const;

/** What a page's read keeps for the cross-page rules (`HeadingsData`). */
export function headingsData(read: HeadingsRead): HeadingsData {
  const sigs = read.headings
    .filter((h) => h.sig && h.text && (h.chars ?? h.text.length) <= SITE_TWIN.chars)
    .slice(0, SITE_TWIN.headings).map((h) => ({ text: h.text, level: h.level, sig: h.sig!, ...(h.drawn ? { drawn: h.drawn } : {}), ...(h.glyphs ? { glyphs: h.glyphs } : {}) }));
  // (A line with a doubt is never offered to the site's other pages: what they mark up says nothing against the doubt.)
  const maybe = [...(read.shown ?? []).filter((b) => shownVerdict(b) === null), ...(read.plain ?? [])]
    .filter((b) => b.sig && !b.doubt && b.text.length <= SITE_TWIN.chars)
    .slice(0, SITE_TWIN.lines).map((b) => ({ text: b.text, target: b.target, sig: b.sig!, ...(b.drawn ? { drawn: b.drawn } : {}), ...(b.glyphs ? { glyphs: b.glyphs } : {}) }));
  return {
    title: read.title, h1: read.headings.filter((h) => h.level === 1 && h.text).slice(0, 5).map((h) => ({ text: h.text, target: h.target })),
    ...(sigs.length ? { sigs } : {}), ...(maybe.length ? { maybe } : {}),
  };
}

function isHeadingsData(d: unknown): d is HeadingsData {
  if (!d || typeof d !== 'object') return false;
  const x = d as Partial<HeadingsData>;
  return typeof x.title === 'string' && Array.isArray(x.h1) && x.h1.every((h) => h && typeof h.text === 'string' && typeof h.target === 'string');
}

/** Heading text compared across pages: case, width variants and whitespace ignored. */
export const normalizeHeading = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The site-wide template heading (2.4.6), usually the site's name: one level-1 heading text on at least 80% of the scanned
 * pages that have a level-1 heading, and on at least 3 of them, while those pages' titles differ. Each
 * such page whose level-1 headings are all that text fails, except the start page (index 0). Pages
 * whose run did not end ok, that have no data, or with a result that could not be tested are left out.
 */
export function templateH1Findings(runs: readonly { run: ProbeRun; index: number }[]): Map<string, ProbeFinding[]> {
  const pages = runs
    .filter(({ run }) => run.status === 'ok' && isHeadingsData(run.data) && !run.findings.some((f) => f.status === 'not_testable'))
    .map(({ run, index }) => {
      const data = run.data as HeadingsData;
      const h1 = data.h1.map((h) => ({ ...h, norm: normalizeHeading(h.text) })).filter((h) => h.norm);
      return { page: run.page, index, title: normalizeHeading(data.title), rawTitle: data.title, h1, texts: new Set(h1.map((h) => h.norm)) };
    })
    .filter((p) => p.h1.length);
  const out = new Map<string, ProbeFinding[]>();
  if (pages.length < TEMPLATE_H1.minPages) return out;
  const on = new Map<string, typeof pages>();
  for (const p of pages) for (const t of p.texts) on.set(t, [...(on.get(t) ?? []), p]);
  const template = new Map<string, number>();
  for (const [text, list] of on) {
    if (list.length < TEMPLATE_H1.minPages || list.length < TEMPLATE_H1.share * pages.length) continue;
    if (new Set(list.map((p) => p.title)).size < 2) continue;
    template.set(text, list.length);
  }
  if (!template.size) return out;
  for (const p of pages) {
    if (p.index === 0 || ![...p.texts].every((t) => template.has(t))) continue;
    const h = p.h1[0]!;
    out.set(p.page, [{
      criterion: '2.4.6', status: 'failed', target: h.target,
      detail: `The main heading ${quote(h.text)} is the same on nearly every page, so it does not name this page: it is the level-1 heading on ${template.get(h.norm)} of the ${pages.length} scanned pages that have one, while their titles differ (this page is titled ${quote(p.rawTitle)})`,
    }]);
  }
  return out;
}

const pathOf = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

/**
 * The site's own proof that a line is a heading (1.3.1, F2; batch 17): a line one page shows as a section heading
 * without marking it up (on its own line, larger than the text it introduces, at the head of that text; a candidate
 * the page alone could not decide) fails when another scanned page of the site marks up **the same line, set the
 * same way,** as a real heading: the same text (case and spacing aside) drawn in the same type (`sigOf`). The site
 * itself says what the line is; only its markup differs between the two pages (a template or a widget that writes
 * its title as a heading on some pages and as a plain paragraph on others). The finding names the other page.
 * Pages whose run did not end ok or that kept no data are left out. Never fails a page for a line it has no
 * candidate for, and never from a heading with other words or set another way.
 */
export function siteTwinFindings(runs: readonly { run: ProbeRun; index: number }[]): Map<string, ProbeFinding[]> {
  const out = new Map<string, ProbeFinding[]>();
  const pages = runs.filter(({ run }) => run.status === 'ok' && isHeadingsData(run.data)).map(({ run }) => ({ page: run.page, data: run.data as HeadingsData }));
  if (pages.length < 2 || !pages.some((p) => p.data.maybe?.length)) return out;
  /** text and type → the pages where it is a real heading, with its level there. */
  const real = new Map<string, { page: string; level: number }[]>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const h of p.data.sigs ?? []) {
      const text = normalizeHeading(h.text);
      // As the style sheet sets it, and as the browser draws it ("~", with the line's own letters drawn alike: Sol
      // review of batch 17, S6): either is the same way.
      for (const key of text ? [`${text}\n${h.sig}`, ...(h.drawn && h.glyphs ? [`${text}\n~${h.drawn}\n${h.glyphs}`] : [])] : []) {
        if (seen.has(key)) continue;
        seen.add(key);
        real.set(key, [...(real.get(key) ?? []), { page: p.page, level: h.level }]);
      }
    }
  }
  for (const p of pages) {
    const found: ProbeFinding[] = [];
    for (const m of p.data.maybe ?? []) {
      const text = normalizeHeading(m.text);
      const others = (real.get(`${text}\n${m.sig}`) ?? (m.drawn && m.glyphs ? real.get(`${text}\n~${m.drawn}\n${m.glyphs}`) : undefined) ?? []).filter((o) => o.page !== p.page);
      if (!others.length || found.length >= HEADINGS_LIMITS.perKind) continue;
      const first = others[0]!;
      found.push({
        criterion: '1.3.1', status: 'failed', target: m.target,
        detail: `${quote(m.text)} is shown as a section heading (on its own line, at the head of the text it introduces) but is not marked up as a heading: on ${others.length === 1 ? 'another scanned page' : `${others.length} other scanned pages`} of this site the same line, set the same way, is a level-${first.level} heading (${pathOf(first.page)}), so screen readers can list it and jump to it there and not here`,
      });
    }
    if (found.length) out.set(p.page, found);
  }
  return out;
}

/** The headings test's rules across pages: the template's main heading (2.4.6) and the site's own headings (1.3.1). */
export function headingsAcrossPages(runs: readonly { run: ProbeRun; index: number }[]): Map<string, ProbeFinding[]> {
  const out = new Map<string, ProbeFinding[]>();
  for (const rule of [templateH1Findings, siteTwinFindings]) {
    let found: Map<string, ProbeFinding[]>;
    try { found = rule(runs); } catch { continue; }
    for (const [page, list] of found) out.set(page, [...(out.get(page) ?? []), ...list]);
  }
  return out;
}

/** The cross-page rule's failure (`templateH1Findings`), for the picture taken before it is decided. */
export const isTemplateH1 = (f: ProbeFinding) => f.criterion === '2.4.6' && f.detail.startsWith('The main heading ');

/**
 * Report evidence (core tests): the first empty heading boxed, the first paragraph marked up as a
 * heading boxed, and (not on the start page) the page's level-1 heading, kept only if the cross-page
 * rule later finds it the same on nearly every page. Recommendations get no picture. Main document
 * only; reads and scrolls, and puts the scroll back.
 */
async function headingEvidence(ctx: ProbeContext, read: HeadingsRead, findings: readonly ProbeFinding[]): Promise<void> {
  const main = (t: string | undefined) => !!t && !t.includes(' >>> ');
  const isEmpty = (f: ProbeFinding) => f.criterion === '1.3.1' && (f.status === 'failed' || f.status === 'flagged') && /heading has no text/.test(f.detail);
  const isParagraph = (f: ProbeFinding) => f.criterion === '1.3.1' && f.status === 'failed' && f.detail.startsWith('A paragraph is marked up as ');
  const empty = findings.find((f) => isEmpty(f) && main(f.target));
  if (empty) {
    await shootElements(ctx, {
      criterion: '1.3.1', variant: 'empty', handles: [{ sel: empty.target! }], when: isEmpty, caption: 'This heading has no text',
      alt: (title) => `${pageWords(title)}: the outlined heading has no text, so screen readers announce an empty heading.`,
    });
  }
  const paragraph = findings.find((f) => isParagraph(f) && main(f.target));
  if (paragraph) {
    await shootElements(ctx, {
      criterion: '1.3.1', variant: 'paragraph', handles: [{ sel: paragraph.target! }], when: isParagraph, caption: 'A paragraph marked up as a heading',
      alt: (title) => `${pageWords(title)}: the outlined paragraph is marked up as a heading, so screen readers list it among the headings.`,
    });
  }
  // A line shown as a section heading with no heading markup: the first one the page proves, else the first one
  // only the site's other pages can decide (the picture is kept only when the run ends failing that very line).
  // (A line the page gives no proof for at all, `plain`, is among them: another page may mark it up as a heading.)
  const shown = [...(read.shown ?? []), ...(read.plain ?? [])].filter((b) => main(b.target));
  const line = shown.find((b) => shownVerdict(b) !== null) ?? shown[0];
  if (line) {
    const text = line.text.length > 60 ? `${line.text.slice(0, 59)}…` : line.text;
    await shootElements(ctx, {
      criterion: '1.3.1', variant: 'shown-heading', handles: [{ sel: line.target }], target: line.target,
      when: (f) => isShownHeading(f) && f.target === line.target,
      caption: 'Shown as a heading, but not marked up as one',
      alt: (title) => `${pageWords(title)}: the outlined line “${text}” is shown as a section heading but is not marked up as a heading.`,
    });
  }
  // The cross-page rule never fails the start page; elsewhere the picture waits for its verdict.
  const h1 = read.headings.find((h) => h.level === 1 && h.text && main(h.target));
  if (ctx.pageIndex > 0 && h1) {
    const text = h1.text.length > 60 ? `${h1.text.slice(0, 59)}…` : h1.text;
    await shootElements(ctx, {
      criterion: '2.4.6', variant: 'template', handles: [{ sel: h1.target }], when: isTemplateH1, homeOnly: false,
      caption: 'This main heading is the same on nearly every page',
      alt: (title) => `${pageWords(title)}: its outlined main heading “${text}” is the same on nearly every page of the site, so it does not name this page.`,
    });
  }
}

/**
 * Heading structure, on every page that loaded (`everyPage`): reads the headings assistive technology
 * is given at the desktop width and fails 1.3.1 for headings with no text and paragraphs marked up as
 * headings. A page with no level-1 heading (2.4.6) and levels that skip downwards by two or more (1.3.1)
 * are recommendations only. Across pages (`acrossPages`), the same level-1 heading on nearly every page
 * (usually the site's name) fails 2.4.6 on those pages (not the start page).
 */
export const headingsProbe: PageProbe = {
  id: HEADINGS_PROBE_ID,
  criteria: ['1.3.1', '2.4.6'],
  // Reads the page's headings once: an app that mounts its content late is read with it (gold hazard late mount).
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  timeoutMs: 10_000,
  everyPage: true,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    await ctx.page.evaluate(installNamesSomething, NAMES_SOMETHING_KEY);
    // The type a line is drawn in is read once the page's web fonts have arrived (bounded; a face still loading
    // then leaves only the style sheet's own words to compare: `drawnOf`).
    await Promise.race([ctx.page.evaluate(fontsSettled, HEADINGS_LIMITS.fontsMs).catch(() => undefined), new Promise((r) => setTimeout(r, HEADINGS_LIMITS.fontsMs + 500))]);
    // The elements the page's script listens for clicks on: a line that takes clicks is (also) a control.
    let clicks: number[] = [];
    try { clicks = [...new Set((await ctx.listeners()).filter((l) => l.type === 'click' && l.target.kind === 'element').map((l) => l.ref))].slice(0, 2000); } catch { clicks = []; }
    const read = await ctx.page.evaluate(readHeadings, { elements: HEADINGS_LIMITS.elements, headings: HEADINGS_LIMITS.headings, frames: HEADINGS_LIMITS.frames, styled: HEADINGS_LIMITS.styled, namesKey: NAMES_SOMETHING_KEY, clicks });
    ctx.setData?.(headingsData(read));
    const findings = headingFindings(read);
    await headingEvidence(ctx, read, findings);
    // Table header cells that label no data cell (1.3.1, 2026-11-09).
    const lone = await ctx.page.evaluate(readLoneHeaders, { ...TABLE_HEADER_LIMITS });
    // Tabular data with no header relationships at all (1.3.1, 2026-11-10): `tablesShown.ts`.
    const shownTables = await ctx.page.evaluate(readShownTables, { ...TABLES_SHOWN_LIMITS });
    const tableFindings = shownTableFindings(shownTables);
    // A picture of the first one (batch 17): the rows and columns a sighted person reads as a table.
    const table = tableFindings.find((f) => f.status === 'failed' && !!f.target && !f.target.includes(' >>> '));
    if (table) {
      await shootElements(ctx, {
        criterion: '1.3.1', variant: 'shown-table', handles: [{ sel: table.target! }], target: table.target!,
        when: (f) => f.criterion === '1.3.1' && f.status === 'failed' && f.target === table.target,
        caption: 'Shown as a table, with no header cells',
        alt: (title) => `${pageWords(title)}: the outlined rows and columns are shown as a table, but nothing tells screen readers which cells are its headers.`,
      });
    }
    return [...findings, ...loneHeaderFindings(lone), ...tableFindings];
  },
  acrossPages: headingsAcrossPages,
  // Only 1.3.1: `siteTwinFindings` fails a line the page's own run left undecided (the same line, set the same
  // way, is a real heading on another scanned page). The template-heading rule (2.4.6) settles nothing.
  acrossSettles: ['1.3.1'],
};
