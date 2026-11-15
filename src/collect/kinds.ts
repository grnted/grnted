// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Element kinds (red-team 2026-11-10, coverage lane): what a page is made of, read cheaply in every page
// audit, to decide where the tests that are too slow to run everywhere go (src/probes/components.ts,
// src/probes/sample.ts): (1) to the pages that hold something no tested page has, and (2) for a failure a
// test measured on an element, to the other pages that carry an element of the same kind, where that
// element is then measured on its own (src/probes/componentCheck.ts).
//
// A kind only ever **triggers a test**; it never stands in for one (review r1, 2026-11-10). Two elements of
// one kind can still differ in what a test measures: a name (`aria-label` values are left out), a colour
// behind it, a CSS variable set on `html`, an ancestor's `data-` attribute a script reads. So nothing is
// reported for a page from its kinds alone.
//
// A **kind** is an element as its styles and scripts see it, not as its reader does: its tag, id, classes,
// attributes and inline style; the same for each of its ancestors below `body`; and the set of kinds under
// it. Its text, link addresses and names are left out, and so is how many times a child kind repeats: the
// "Back to top" link of a shared footer is one kind on every page, a menu is the same kind whichever of its
// items is marked current, and a list of five news teasers is the kind of a list of seven.
//
// Not read: what is inside a shadow root or a frame (the walk and the selectors stay in the page's own
// document), and elements past `KINDS_LIMITS.elements`. A component that lives there triggers nothing; no
// result depends on it.
//
// Everything the reader looks at is capped where it is read (round-2 review, finding 4): it never asks the
// page for a list of every match of a selector. Elements: `KINDS_LIMITS.elements`, in one walk. Stylesheet
// links, style blocks and scripts: live lists walked by index, at most 5 × `KINDS_LIMITS.env` of each, and no
// further once the tokens are full; of an inline block longer than 4,000 characters, its first 4,000 and its
// length. Orientation: at most `ORIENT_LIMITS.selectors` selectors, checked against the walked elements one
// by one, `ORIENT_LIMITS.checks` checks in all.
//
// Engine core: no Node-only imports. The in-page functions are self-contained.
import type { PageCollector } from '../types.js';

export const KINDS_LIMITS = {
  /** Elements read per page, in document order (a page with more is `cut`: its later elements have no kind). */
  elements: 6000,
  /** Kinds kept per page. */
  kinds: 1500,
  /** Environment tokens kept per page (stylesheets, scripts, inline style blocks, body classes). */
  env: 120,
  /** Loose kinds kept per feature. */
  feature: 150,
} as const;

/**
 * Bounds of the orientation reading (`PageKinds.f.orient`): the selectors of rules inside an `orientation`
 * media query that are kept, and the element-against-selector checks made in all. (`readKinds` runs inside
 * the page and cannot read this constant: it carries the same numbers.)
 */
export const ORIENT_LIMITS = { selectors: 30, checks: 60_000 } as const;

/** What the `kinds` collector leaves on a page (`PageAudit.collected.kinds`). */
export interface PageKinds {
  /** The page's element kinds: unique, in document order of their first element. */
  k: string[];
  /**
   * The page's environment, as tokens: `c:` a stylesheet's address or an inline style block, `j:` a script's
   * address or an inline script, `b:` a class or the id of `html` or `body`. Hashes, sorted.
   */
  env: string[];
  /**
   * Loose kinds by what a test needs (tag, role, type, id and classes with digits read as one; no ancestors),
   * for choosing the pages the slow tests go to: `focus` what takes keyboard focus or a click, `form` form
   * fields, `motion` what moves or updates by itself as far as the page says so (running animations, media
   * that plays by itself, live regions), `fixed` what stays on screen while the page scrolls, `ids` every
   * element with an id (what scripts and page-specific styles hang on), `struct` tables, lists and groups,
   * `orient` the elements a stylesheet styles differently by orientation (rules inside an `orientation`
   * media query that match on this page), `reorder` what CSS shows in another order than the page's own
   * (a flex or grid item with an `order`, a reversed flex direction), `press` what a press acts on that is
   * neither a link nor a form field (a button, a summary, a tab, a switch, an element with an `onclick`: what
   * the act-and-watch tests press). `press` is missing from kinds read before 2026-11-11 (act-watch lane).
   * `operable` (the keyboard-op lane's `press` until batch 16 merged both lanes) what a script, not the browser,
   * makes operable (what only pressing or dragging it shows): a custom control (an element that is no native
   * control, with a control's role, a tabindex, an inline handler or a state such as aria-expanded), the top element
   * of a subtree with a pointer, grab or move cursor that is no native control, and anything marked draggable.
   * An `operable` key also holds the element's own text (numbers read as one), so the same widget with another label,
   * which does something else, is a new key, while a site-wide menu button is one key everywhere. `operable` is missing
   * from kinds read before batch 16.
   * Batch 18 (forms lane): `orient` also reads `aspect-ratio` media queries (an orientation lock is as often written
   * as `max-aspect-ratio: 1/1`); `orientLock` the elements such a rule hides, collapses or turns (display none,
   * visibility hidden, opacity 0, a zero height, a rotation), or that a page script that reads the orientation may
   * swap (the page's own inline scripts compare its width and height, or ask for the orientation). `form` also counts
   * fields a test reaches but the walk does not: inside a same-origin frame, inside an open shadow root, or in a frame
   * from another site whose address says it is a form, a sign-in or a payment (a trigger only, never a finding).
   * `orientLock` is missing from kinds read before batch 18.
   */
  f: { focus: string[]; form: string[]; motion: string[]; fixed: string[]; ids: string[]; struct: string[]; orient: string[]; reorder: string[]; press?: string[]; operable?: string[]; orientLock?: string[] };
  /** The page had more elements than were read. */
  cut?: true;
}

export interface ReadKindsArg {
  elements: number;
  kinds: number;
  env: number;
  feature: number;
  /**
   * Keep each element's kind in the page (`window.__grntedKind(element)`, and the first two elements of
   * each kind for `targetsOfKinds`), so a test's failing element can be named later as it was when the page
   * loaded, whatever the test did to it since (the probe runner).
   */
  stash?: boolean;
}


/**
 * Runs inside the page. Must be self-contained (no imports, no closures).
 *
 * Kind of an element = hash(its ancestors' own signatures below body, in order | its own signature | the
 * sorted set of its children's subtree hashes). Own signature: tag, id, sorted classes, every attribute
 * (name and value; for attributes that carry content or point elsewhere, the name only), the inline style
 * without the properties scripts animate, and whether it has text of its own.
 */
export function readKinds(arg: ReadKindsArg): PageKinds {
  // FNV-1a, two seeds: 48 bits, base 36.
  const hash = (s: string): string => {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
    }
    return ((a >>> 0) * 65536 + ((b >>> 0) & 0xffff)).toString(36);
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'BR', 'WBR']);
  // Attributes whose value is content, a name or a pointer: the element is the same kind whatever it holds.
  const NAME_ONLY = new Set([
    'href', 'alt', 'title', 'value', 'placeholder', 'action', 'for', 'name', 'content', 'datetime', 'cite', 'download',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-details', 'aria-controls', 'aria-owns', 'aria-activedescendant',
    'aria-valuenow', 'aria-valuetext', 'aria-posinset', 'aria-setsize', 'aria-rowindex', 'aria-colindex', 'aria-description',
    'srcset', 'sizes', 'width', 'height', 'coords', 'list', 'form', 'headers', 'data-src', 'data-srcset', 'data-href', 'data-url', 'data-id',
    'nonce', 'integrity', 'loading', 'decoding', 'fetchpriority', 'lang', 'hreflang', 'xml:lang', 'usemap', 'longdesc', 'summary', 'abbr', 'label',
    'min', 'max', 'step', 'pattern', 'maxlength', 'minlength', 'rows', 'cols', 'size', 'accesskey', 'srcdoc', 'd', 'points', 'viewbox', 'transform',
  ]);
  // Inline style properties scripts animate: an element mid-animation is the same kind as at rest.
  const MOVING = /^(transform|translate|rotate|scale|opacity|left|top|right|bottom|transition(-[a-z-]+)?|will-change|animation-delay|animation-play-state|scroll-[a-z-]+|--[a-z0-9-]*)$/;
  const styleOf = (el: Element): string => {
    const raw = el.getAttribute('style');
    if (!raw) return '';
    const kept: string[] = [];
    for (const part of raw.split(';')) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      const prop = part.slice(0, at).trim().toLowerCase();
      if (!prop || MOVING.test(prop)) continue;
      kept.push(`${prop}:${part.slice(at + 1).trim().replace(/\s+/g, ' ')}`);
    }
    return kept.sort().join(';');
  };
  const classesOf = (el: Element): string => {
    const c = el.getAttribute('class');
    return c ? c.split(/\s+/).filter(Boolean).sort().join('.') : '';
  };
  /** An element's own file (a picture, a frame) without its query or fragment. */
  const filePart = (v: string): string => v.split('#')[0]!.split('?')[0]!;
  /**
   * A stylesheet's or script's address for the environment: with its query (`theme.css?variant=dark` is
   * another stylesheet than `theme.css?variant=light`; review r1), without its fragment.
   */
  const assetPart = (v: string): string => v.split('#')[0]!;
  const own = (el: Element): string => {
    const attrs: string[] = [];
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n === 'class' || n === 'id' || n === 'style') continue;
      if (NAME_ONLY.has(n)) attrs.push(n);
      else if (n === 'src' || n === 'poster' || n === 'data' || n === 'xlink:href') attrs.push(`${n}=${filePart(a.value)}`);
      else attrs.push(`${n}=${a.value.length > 80 ? hash(a.value) : a.value}`);
    }
    let text = false;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) { text = true; break; }
    }
    return `${el.tagName}#${el.id}.${classesOf(el)}[${attrs.sort().join(',')}]{${styleOf(el)}}${text ? 't' : ''}`;
  };
  /** What an ancestor adds to its descendants' context: what selectors and inheritance can see of it. */
  const lite = (el: Element): string => `${el.tagName}#${el.id}.${classesOf(el)}{${styleOf(el)}}[${el.getAttribute('role') ?? ''},${el.getAttribute('aria-hidden') ?? ''},${el.hasAttribute('hidden') ? 'h' : ''},${el.hasAttribute('inert') ? 'i' : ''}]`;

  const body = document.body;
  const kinds: string[] = [];
  const seen = new Set<string>();
  const stash = arg.stash ? new WeakMap<Element, string>() : undefined;
  const firstOf = arg.stash ? new Map<string, Element[]>() : undefined;
  let read = 0;
  let cut = false;
  // What the features below are read from, gathered in the same bounded walk (at most `arg.elements`
  // elements are ever looked at, whatever the page holds; review r1, finding 12).
  const FOCUS = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, details, dialog, iframe, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], [onclick], [onkeydown], [onkeyup], [onkeypress], [onmousedown], [onmouseup], [onmouseover], [onfocus], [aria-haspopup], [aria-expanded], [aria-pressed], [aria-controls], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="textbox"], [role="searchbox"], [role="treeitem"], [role="gridcell"], [role="dialog"], [role="alertdialog"], [role="tooltip"], [role="menu"], [role="menubar"], [role="tablist"], [role="tree"], [role="grid"]';
  const FORM = 'input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"], form, fieldset';
  // Fields inside a frame's document or an open shadow root (what the form tests reach; `FORM` without containers).
  const FIELDS = 'input:not([type="hidden"]), select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="spinbutton"], [role="slider"], [role="switch"]';
  // A frame from another site that says, by its address, that it holds a form, a sign-in or a payment.
  const FORM_FRAME = /^https?:.*(form|survey|apply|application|register|signup|sign-up|subscribe|login|log-in|signin|sign-in|auth|pay|checkout|donat|portal|request|enrol|booking|reserv)/i;
  const MOTION = 'marquee, blink, video, audio, canvas, [aria-live], [role="status"], [role="alert"], [role="log"], [role="timer"], [role="marquee"], [role="progressbar"], img[src$=".gif" i], img[src*=".gif?" i], [autoplay]';
  const STRUCT = 'table, [role="table"], [role="grid"], [role="treegrid"], ul, ol, dl, [role="list"], fieldset, [role="group"], [role="radiogroup"], figure, blockquote';
  // What a press acts on, links and form fields aside (a link goes elsewhere; a field is typed into).
  const PRESS = 'button, input[type="button"], input[type="submit"], input[type="image"], summary, [role="button"], [role="tab"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [onclick]:not(a[href]):not(area[href])';
  const found = { focus: [] as Element[], form: [] as Element[], motion: [] as Element[], struct: [] as Element[], ids: [] as Element[], fixed: [] as Element[], reorder: [] as Element[], press: [] as Element[], operable: [] as Element[] };
  // What looks operable with the pointer (`PageKinds.f.operable`). A cursor is inherited, so only the top of a
  // subtree that shows one counts; the parent is always walked before its children.
  const NATIVE_PRESS = 'a[href], area[href], button, input, select, textarea, summary, label, option, optgroup, iframe, video, audio';
  // A custom control: no container (a region made focusable, a skip target), and a tabindex only when Tab reaches it.
  const CONTAINER = 'main, body, section, article, nav, header, footer, aside, form, fieldset, dialog, table, ul, ol, [role="dialog"], [role="main"], [role="region"], [role="navigation"], [role="tabpanel"], [role="document"], [role="application"]';
  const CUSTOM = '[tabindex]:not([tabindex^="-"]), [onclick], [onmousedown], [onmouseup], [onkeydown], [aria-expanded], [aria-pressed], [aria-haspopup], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="treeitem"], [role="gridcell"]';
  const POINTING = new Set(['pointer', 'grab', 'move']);
  const pointing = new WeakSet<Element>();
  const customs = new WeakSet<Element>();
  /** Elements whose computed style is read (what stays on screen, what CSS reorders). */
  const STYLED = Math.min(arg.elements, 3000);
  // What a stylesheet styles by orientation: the selectors of the rules inside an `orientation` media query,
  // read before the walk (at most 30, from at most 20,000 rules of at most 200 stylesheets, by index: a rule
  // list is never copied). Stylesheets from another origin cannot be read (their rules throw) and are left out.
  // The walk then checks each element it visits against them, 60,000 checks in all: the page is never asked
  // for every match of a selector (`* { … }` in such a query matches the whole page).
  const ORIENT_SELECTORS = 30;
  const ORIENT_CHECKS = 60000;
  const orientSelectors: string[] = [];
  // The orientation (or aspect-ratio) rules that hide, collapse or turn what they match: a lock candidate.
  const lockSelectors: string[] = [];
  const locked: Element[] = [];
  const HIDES = (st: CSSStyleDeclaration | undefined): boolean => {
    if (!st) return false;
    const h = (v: string) => /^0(px|em|rem|%)?$/.test(v.trim());
    return st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0' || /rotate/i.test(st.transform || '') || /rotate/i.test(st.rotate || '')
      || h(st.height || 'x') || h(st.maxHeight || 'x') || st.contentVisibility === 'hidden';
  };
  const ORIENT_MEDIA = /orientation|aspect-ratio/i;
  const turned: Element[] = [];
  let visited = 0;
  let checks = 0;
  const rulesOf = (rules: CSSRuleList, inOrientation: boolean): void => {
    for (let i = 0; i < rules.length; i++) {
      if (++visited > 20000 || orientSelectors.length >= ORIENT_SELECTORS) return;
      const rule = rules[i]!;
      const media = (rule as CSSMediaRule).media;
      const inner = (rule as CSSGroupingRule).cssRules;
      const selector = (rule as CSSStyleRule).selectorText;
      if (media && inner) rulesOf(inner, inOrientation || ORIENT_MEDIA.test(media.mediaText));
      else if (selector && inOrientation) {
        try {
          // A selector this browser does not read throws here, and is left out.
          document.documentElement.matches(selector);
          if (!orientSelectors.includes(selector)) orientSelectors.push(selector);
          if (lockSelectors.length < ORIENT_SELECTORS && !lockSelectors.includes(selector) && HIDES((rule as CSSStyleRule).style)) lockSelectors.push(selector);
        } catch {
          // not a selector
        }
      } else if (inner) rulesOf(inner, inOrientation);
    }
  };
  try {
    const sheets = document.styleSheets;
    for (let i = 0; i < sheets.length && i < 200 && orientSelectors.length < ORIENT_SELECTORS; i++) {
      try {
        rulesOf(sheets[i]!.cssRules, ORIENT_MEDIA.test(sheets[i]!.media.mediaText));
      } catch {
        // another origin's stylesheet
      }
    }
  } catch {
    // no stylesheet list
  }
  // A page script that reads the orientation (its inline scripts only: another file's text is not read here).
  let scriptLock = false;
  try {
    const inline = document.querySelectorAll('script:not([src])');
    for (let i = 0; i < inline.length && i < 200 && !scriptLock; i++) {
      const t = (inline[i]!.textContent ?? '').slice(0, 200000);
      scriptLock = /orientation|aspect-ratio|innerHeight\s*[<>]=?\s*(window\.)?innerWidth|innerWidth\s*[<>]=?\s*(window\.)?innerHeight/.test(t);
    }
  } catch {
    // no script list
  }
  const orient = (el: Element): void => {
    let hit = false;
    for (let i = 0; i < orientSelectors.length && checks < ORIENT_CHECKS && turned.length < arg.feature * 2; i++) {
      checks++;
      if (el.matches(orientSelectors[i]!)) { turned.push(el); hit = true; break; }
    }
    if (!hit) return;
    for (let i = 0; i < lockSelectors.length && checks < ORIENT_CHECKS && locked.length < arg.feature; i++) {
      checks++;
      if (el.matches(lockSelectors[i]!)) { locked.push(el); return; }
    }
  };
  if (scriptLock && body) locked.push(body);
  // A rotate wall carries its message in the page, shown or not ("Rotate your device to landscape"): a lock candidate
  // whatever script shows it (one from another file included). The words are orientation.ts's ROTATE_MESSAGE.
  const ROTATE = /\b(?:rotate|turn)\s+(?:your|the)\s+(?:device|phone|screen|tablet|mobile)\b|\b(?:switch|change)\s+to\s+(?:landscape|portrait)\b|\b(?:best\s+)?viewed?\s+in\s+(?:landscape|portrait)\b|\b(?:landscape|portrait)\s+(?:mode|orientation)\s+(?:only|required|is\s+required|please)\b|\bplease\s+use\s+(?:landscape|portrait)\b|\bonly\s+(?:works|available)\s+in\s+(?:landscape|portrait)\b/i;
  const rotateWall = (el: Element): void => {
    if (locked.length >= arg.feature) return;
    let own = '';
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue) own += c.nodeValue;
    if (own.length > 6 && own.length < 400 && ROTATE.test(own)) locked.push(el);
  };
  if (orientSelectors.length) {
    // `html` and `body` are not part of the walk, and are what such rules often style.
    orient(document.documentElement);
    if (body) orient(body);
  }
  const note = (el: Element): void => {
    if (orientSelectors.length) orient(el);
    rotateWall(el);
    const focus = el.matches(FOCUS);
    if (focus) found.focus.push(el);
    const custom = focus && el.matches(CUSTOM) && !el.matches(CONTAINER) && !(el as HTMLElement).isContentEditable;
    if (custom) customs.add(el);
    if ((custom || el.getAttribute('draggable') === 'true') && found.operable.length < arg.feature && !el.closest(NATIVE_PRESS)) found.operable.push(el);
    if (el.matches(FORM)) found.form.push(el);
    else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      // A frame's fields are the page's fields to a person: same-origin, read them; another site's, go by its address.
      let doc: Document | null = null;
      try { doc = (el as HTMLIFrameElement).contentDocument; } catch { doc = null; }
      if (doc) { try { if (doc.querySelector(FIELDS)) found.form.push(el); } catch { /* not readable */ } }
      else if (FORM_FRAME.test((el as HTMLIFrameElement).src || el.getAttribute('src') || '')) found.form.push(el);
    } else if ((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.querySelector(FIELDS)) found.form.push(el);
    if (el.matches(MOTION)) found.motion.push(el);
    if (el.matches(STRUCT)) found.struct.push(el);
    if (el.matches(PRESS)) found.press.push(el);
    if (el.id) found.ids.push(el);
    if (read > STYLED) return;
    const cs = getComputedStyle(el);
    if ((cs.position === 'fixed' || cs.position === 'sticky') && found.fixed.length < arg.feature) found.fixed.push(el);
    // Shown in another order than the page's own (WCAG failure F1 is about exactly this).
    if (((cs.order && cs.order !== '0') || /-reverse$/.test(cs.flexDirection) || cs.flexWrap === 'wrap-reverse') && found.reorder.length < arg.feature) found.reorder.push(el);
    if (POINTING.has(cs.cursor)) {
      pointing.add(el);
      const up = el.parentElement;
      if (!(up && pointing.has(up)) && !focus && found.operable.length < arg.feature && !found.operable.includes(el) && !el.closest(NATIVE_PRESS)) found.operable.push(el);
    }
  };
  // Depth-first, children before their parent (the subtree hash needs them), without recursion.
  interface Frame { el: Element; up: string; ownSig: string; kids: string[]; next: Element | null; childUp?: string }
  const stack: Frame[] = [];
  const open = (el: Element, up: string): Frame | null => {
    if (SKIP.has(el.tagName)) return null;
    if (read >= arg.elements) { cut = true; return null; }
    read++;
    note(el);
    // An inline SVG is one element: its drawing is part of what it is, not a tree of kinds.
    const isSvg = el.tagName.toLowerCase() === 'svg';
    const ownSig = isSvg ? `${own(el)}<${hash(el.innerHTML.slice(0, 4000))}>` : own(el);
    return { el, up, ownSig, kids: [], next: isSvg ? null : el.firstElementChild };
  };
  if (body) {
    for (let top = body.firstElementChild; top; top = top.nextElementSibling) {
      const first = open(top, 'B');
      if (!first) continue;
      stack.push(first);
      while (stack.length) {
        const f = stack[stack.length - 1]!;
        if (f.next) {
          const child = f.next;
          f.next = child.nextElementSibling;
          f.childUp ??= hash(`${f.up}>${lite(f.el)}`);
          const opened = open(child, f.childUp);
          if (opened) stack.push(opened);
          continue;
        }
        stack.pop();
        const down = hash(`${f.ownSig}(${[...new Set(f.kids)].sort().join(',')})`);
        const kind = hash(`${f.up}|${down}`);
        stash?.set(f.el, kind);
        if (firstOf) {
          const list = firstOf.get(kind);
          if (!list) firstOf.set(kind, [f.el]);
          else if (list.length < 2) list.push(f.el);
        }
        if (!seen.has(kind) && kinds.length < arg.kinds) { seen.add(kind); kinds.push(kind); }
        const parent = stack[stack.length - 1];
        if (parent) parent.kids.push(down);
      }
    }
  }
  if (stash && firstOf) {
    const w = window as unknown as { __grntedKind?: (el: Element) => string | undefined; __grntedKindEls?: (kind: string) => Element[] };
    w.__grntedKind = (el) => stash.get(el);
    w.__grntedKindEls = (kind) => firstOf.get(kind) ?? [];
  }

  // The environment: what could style or script the page's elements from outside them.
  const env = new Set<string>();
  const addEnv = (kind: string, v: string) => { if (v && env.size < arg.env) env.add(`${kind}:${hash(v)}`); };
  // Live lists walked by index (never a list of every match), at most 5 times the tokens kept of each kind of
  // source, and no further once the tokens are full.
  const LOOK = arg.env * 5;
  const full = () => env.size >= arg.env;
  /** An inline block as a token's text: whole when short, else its first 4,000 characters and its length. */
  const blockOf = (el: Element): string => {
    const t = el.textContent ?? '';
    return (t.length > 4000 ? `${t.slice(0, 4000)}#${t.length}` : t).replace(/\s+/g, ' ').trim();
  };
  const links = document.getElementsByTagName('link');
  for (let i = 0; i < LOOK && !full(); i++) {
    const l = links[i];
    if (!l) break;
    if (l.hasAttribute('href') && /(^|\s)stylesheet(\s|$)/i.test(l.getAttribute('rel') ?? '')) addEnv('c', assetPart(l.href));
  }
  const styles = document.getElementsByTagName('style');
  for (let i = 0; i < LOOK && !full(); i++) {
    const st = styles[i];
    if (!st) break;
    addEnv('c', blockOf(st));
  }
  const scripts = document.getElementsByTagName('script');
  for (let i = 0; i < LOOK && !full(); i++) {
    const sc = scripts[i];
    if (!sc) break;
    const type = (sc.getAttribute('type') ?? '').toLowerCase();
    // Data blocks (JSON-LD, settings) are not code.
    if (type && !/javascript|ecmascript|module/.test(type)) continue;
    const src = sc.src;
    addEnv('j', src ? assetPart(src) : blockOf(sc));
  }
  for (const root of [document.documentElement, body]) {
    if (!root) continue;
    if (root.id) addEnv('b', `#${root.id}`);
    for (const c of (root.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) addEnv('b', `.${c}`);
    for (const a of Array.from(root.attributes)) if (a.name.startsWith('data-')) addEnv('b', `${a.name}=${a.value}`);
  }

  // Loose kinds by feature: tag, role, type, id and classes with runs of digits read as one.
  const loose = (el: Element, more = ''): string => hash(`${el.tagName}|${el.getAttribute('role') ?? ''}|${el.getAttribute('type') ?? ''}|${el.id.replace(/\d+/g, 'N')}|${classesOf(el).replace(/\d+/g, 'N')}|${more}`);
  const feature = (list: Iterable<Element>, more?: (el: Element) => string): string[] => {
    const out = new Set<string>();
    for (const el of list) {
      if (out.size >= arg.feature) break;
      out.add(loose(el, more ? more(el) : ''));
    }
    return [...out];
  };
  const moving: Element[] = found.motion;
  try {
    const running = (document as Document & { getAnimations?: () => Animation[] }).getAnimations?.() ?? [];
    for (let i = 0, added = 0; i < running.length && i < arg.elements && added < arg.feature * 2; i++) {
      const a = running[i]!;
      const t = (a.effect as KeyframeEffect | null)?.target;
      if (t && a.playState === 'running') { moving.push(t); added++; }
    }
  } catch {
    // no animation list: the selector's elements stand
  }
  return {
    k: kinds,
    env: [...env].sort(),
    f: {
      focus: feature(found.focus, (el) => `${el.hasAttribute('onclick') ? 'c' : ''}${el.hasAttribute('tabindex') ? 't' : ''}${el.getAttribute('aria-haspopup') ?? ''}`),
      form: feature(found.form, (el) => `${el.getAttribute('autocomplete') ?? ''}|${el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' ? 'r' : ''}`),
      motion: feature(moving),
      fixed: feature(found.fixed),
      ids: feature(found.ids),
      struct: feature(found.struct),
      orient: feature(turned),
      orientLock: feature(locked),
      reorder: feature(found.reorder),
      press: feature(found.press),
      // A custom control's own text is part of its key (the same widget with another label does something else);
      // a pointer cursor's is not (a card or a teaser with another headline is the same thing to press).
      operable: feature(found.operable, (el) => `${el.getAttribute('draggable') === 'true' ? 'd' : ''}${customs.has(el) ? `c|${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/\d+/g, 'N')}` : ''}`),
    },
    ...(cut ? { cut: true as const } : {}),
  };
}

/**
 * Runs inside the page, after `readKinds` with `stash`: the kind of the element each selector names, as it
 * was when the page loaded (null when the selector matches nothing, is not a selector, or the element came
 * later). Null for the whole call when the document holds no kinds. Self-contained.
 */
export function kindsOfTargets(selectors: string[]): (string | null)[] | null {
  const kindOf = (window as unknown as { __grntedKind?: (el: Element) => string | undefined }).__grntedKind;
  // No kinds kept in this document (the test loaded the page again): the caller reads them, then asks again.
  if (!kindOf) return null;
  return selectors.map((sel) => {
    try {
      const el = document.querySelector(sel);
      return el ? kindOf(el) ?? null : null;
    } catch {
      return null;
    }
  });
}

/**
 * Runs inside the page, after `readKinds` with `stash`: for each kind asked for, a selector for the first
 * element of that kind on **this** page (the page's own element, named by its own path: an id that is unique
 * here, else its position under `body`). Kinds this page does not hold are left out. Null when the document
 * holds no kinds. Self-contained.
 */
export function targetsOfKinds(kinds: string[]): { kind: string; selector: string }[] | null {
  const elsOf = (window as unknown as { __grntedKindEls?: (kind: string) => Element[] }).__grntedKindEls;
  if (!elsOf) return null;
  const esc = (v: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));
  const unique = (id: string): boolean => {
    try {
      return document.querySelectorAll(`#${esc(id)}`).length === 1;
    } catch {
      return false;
    }
  };
  const pathOf = (el: Element): string | null => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      if (e.id && unique(e.id)) return [`#${esc(e.id)}`, ...parts].join(' > ');
      if (!e.parentElement) return null;
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) n++;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${n})`);
    }
    return parts.length ? `body > ${parts.join(' > ')}` : null;
  };
  const out: { kind: string; selector: string }[] = [];
  for (const kind of kinds.slice(0, 200)) {
    const el = elsOf(kind).find((e) => e.isConnected);
    const selector = el ? pathOf(el) : null;
    if (selector) out.push({ kind, selector });
  }
  return out;
}

/**
 * Desktop only: one walk of the page's elements (a few milliseconds on an ordinary page, bounded by
 * `KINDS_LIMITS.elements`). Added to a scan when its tests run.
 */
export const kindsCollector: PageCollector<PageKinds> = {
  id: 'kinds',
  viewport: 'desktop',
  timeoutMs: 3000,
  collect: (page) => page.evaluate(readKinds, { ...KINDS_LIMITS }),
};

/**
 * The same collector for a scan that keeps kinds for its first `pages` pages only (a long scan): a page past
 * them is not read at all (review r1, finding 12: collection used to run on every page and be thrown away).
 */
export function kindsCollectorFor(pages: number): PageCollector<PageKinds | null> {
  return {
    ...kindsCollector,
    collect: async (page, ctx) => (ctx.index !== undefined && ctx.index >= pages ? null : page.evaluate(readKinds, { ...KINDS_LIMITS })),
  };
}

/** A well-formed collector result, or undefined (a page audited before kinds existed, a collector that failed). */
export function pageKindsOf(collected: Record<string, unknown> | undefined): PageKinds | undefined {
  const v = collected?.[kindsCollector.id] as Partial<PageKinds> | undefined;
  if (!v || typeof v !== 'object' || !Array.isArray(v.k) || !Array.isArray(v.env) || !v.f || typeof v.f !== 'object') return undefined;
  return v as PageKinds;
}
