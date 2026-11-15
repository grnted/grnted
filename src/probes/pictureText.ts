// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The words a picture draws, measured: an SVG file shown as an image (`<img>`, an image button, a CSS background)
// keeps its words as text elements in the file, so what it says can be read exactly, and what it draws can be
// measured by drawing it. Nothing here guesses at a bitmap: a photo, a scan or an SVG whose letters are outlines is
// left to the AI review.
//
// Three steps, the first two in the page (self-contained functions), the third pure:
// - `readPictures`: the elements that show a picture file, their text alternative and place, and the page's text
//   in blocks (what the page gives as real text, shown or not: a description behind a toggle still counts);
// - `measureSvgPictures`: each SVG file's source parsed into an inert document (DOMParser: no script runs, nothing
//   loads), drawn as an image on a canvas with and without its text elements. The difference is the ink of the
//   words; an element whose removal changes no pixel is not drawn (hidden, off the canvas, covered, in unused
//   `defs`) and never counts. The drawing without the words is split into flat regions, which shows what else
//   the picture draws: grounds the words sit on, rules, frames, or shapes of their own (a map, a chart, an icon);
// - `judgePictures`: the decisions (docs/scoring.md, "Pictures and the words they draw").
// Reads only; it changes nothing on the page (the canvas and the images it draws are never added to it).
// Engine core: no Node-only imports.

/** Where the page keeps nothing: every function below is self-contained and leaves no global behind. */

export const PICTURE_LIMITS = {
  /** Picture elements read per page, and elements whose computed background is read. */
  pictures: 400,
  elements: 6_000,
  /** Page text: blocks, characters per block (a longer block is split, never cut) and in all (a longer page is "not compared"). */
  blocks: 4_000,
  blockChars: 600,
  pageChars: 120_000,
  /** Characters read of one of a picture's own texts (alt, name, title, description, caption); a longer one is marked cut. */
  sourceChars: 4_000,
  /** SVG files measured per page, the largest shown first; and the bytes of one file. */
  files: 10,
  fileBytes: 400_000,
  /** Text elements measured one by one in a file, and words measured one by one (a file with more is not judged). */
  texts: 40,
  words: 160,
  /** The canvas: its long side is between these (a small file is drawn larger, a large one smaller). */
  minSide: 480,
  maxSide: 900,
  /** Time in the page for all files of a page, and for drawing one image (ms). */
  budgetMs: 6_000,
  drawMs: 2_000,
} as const;

/** How a CSS background picture is laid out in its element: the computed values of its own layer, and the element's boxes. */
export interface BackgroundLayout {
  /** Background layers of the element, and which one is the file (0 is painted on top). */
  layers: number;
  layer: number;
  size: string;
  position: string;
  repeat: string;
  origin: string;
  clip: string;
  attachment: string;
  /** The border box as laid out (CSS px), and the border and padding widths: top, right, bottom, left. */
  box: [number, number];
  border: [number, number, number, number];
  padding: [number, number, number, number];
  /** Rendered size over laid-out size (a transform), per axis. */
  scale: [number, number];
  /** The largest corner radius (CSS px). */
  radius: number;
  /** The element holds rendered content of its own (it may lie over the background). */
  inner: boolean;
  /** Another effect changes how the background is painted (a blend mode, a filter, a clip or a mask on the element). */
  effect: boolean;
}

/** An element that shows a picture file. */
export interface Picture {
  kind: 'img' | 'input' | 'background';
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
  /** The file's address, absolute; '' when it cannot be read (no address, or one with a fragment: a sprite's view). */
  src: string;
  /** The address names an SVG file (`.svg`, or a `data:image/svg+xml` address). */
  svg: boolean;
  /** The file is the page's own site's (or a data: address). */
  local: boolean;
  /** The alt attribute; null when there is none (always null for a background). */
  alt: string | null;
  /** aria-label, or the text aria-labelledby points to. */
  name: string;
  title: string;
  /** Kept from assistive technology by a presentation role, or aria-hidden on it or a wrapper within three levels. */
  hidden: boolean;
  /** The text aria-describedby and aria-details point to. */
  described: string;
  /** Its figure's caption ('' when it has none). */
  caption: string;
  /** One of its own texts above was longer than is read: nothing is said about what they give. */
  cut: boolean;
  /** Shown size, CSS px; 0 for a lazy picture the browser has not loaded yet (it is judged at its file's size). */
  width: number;
  height: number;
  /** `<img>` and image buttons: how the file is fitted in the box (object-fit, object-position) and the file's size as the browser decoded it. */
  fit?: string;
  fitAt?: string;
  decoded?: [number, number];
  /** The share of its box that containers cutting off their overflow leave showing (1 when nothing cuts it). */
  showing: number;
  /**
   * How much of its box is painted is not worked out (the full-tree review's S4): padding or a border on the picture
   * (an image is painted in its content box), a legacy `clip`, or rounded corners on it or on a container that cuts
   * it off. Undefined when none is there.
   */
  unresolved?: string;
  /** Its opacity with its containers' (1 when fully opaque). */
  opacity: number;
  /** A filter on it or on a container, or a blend mode, a clip path or a mask on it, changes how it is painted. */
  effect: boolean;
  /** Times the browser loaded this address for the page (resource timing; 0 when it has no record). */
  loads: number;
  /** The place in `blocks` of the first block of text after it in document order (-1 when unknown). */
  at: number;
  /** The place of the page it stands in: 0 for the content (see `PicturesRead.regions`). */
  region: number;
  /** Inside a link or a button: 'only' when the picture is all it holds, 'text' when it has words too. */
  control: '' | 'only' | 'text';
  /** Named, classed or placed like a logo (a logo's words may be a picture: WCAG 1.4.5's exception). */
  logo: boolean;
  /** Named or classed like a CAPTCHA (its letters are the test). */
  captcha: boolean;
  /**
   * Said to show how something looks (a typeface, handwriting, a signature, a specimen, a screenshot, an example or
   * a sample of a document), or to stand in for a picture that is not there (a placeholder): its look may be the
   * point (1.4.5's "essential"), so its words are never judged. Said by its alternative, its name, its title, its
   * figure's caption, the heading it comes right under, or its file's or class's name.
   */
  sample: boolean;
  /** A link next to it offers a text version or a description of it. */
  textVersion: boolean;
  /** A background's element: its own text, and how the background is laid out. */
  ownText?: string;
  background?: BackgroundLayout;
}

export interface PicturesRead {
  pictures: Picture[];
  /**
   * The page's text, in document order: one entry per block of text (a paragraph, a list item, a cell, a heading; a
   * long one in several pieces, never cut), and one per text alternative an element carries (alt, aria-label, title).
   */
  blocks: string[];
  /**
   * Per block, the place of the page it stands in: 0 for the page's content (the main content with its articles,
   * sections, side notes and forms, and a page with no such parts), and a number of its own for each part that is
   * set apart from it: the site's header and footer (not an article's or a section's own), a navigation, a dialog.
   * Text set apart from a picture is not "beside" it (the footer's address after the last picture of the content).
   */
  regions: number[];
  /**
   * Per block, whether it is a heading (h1 to h6, role="heading") or stands in one: a heading starts a section of
   * the page, and the text of a picture's own section is the text beside it.
   */
  heads?: boolean[];
  /** The page has more text than is compared: nothing is said about what its text gives. */
  blocksTruncated: boolean;
  /** A frame of the page could not be read (another site's, or nested deeper than is read): its text is not known. */
  framesUnread?: boolean;
  /** More pictures or elements than are read. */
  truncated: boolean;
}

/** Runs in the page (self-contained). */
export function readPictures(limits: { pictures: number; elements: number; blocks: number; blockChars: number; pageChars: number; sourceChars?: number }): PicturesRead {
  const SOURCE = limits.sourceChars ?? 4000;
  const tidy = (s: string | null | undefined) => (s ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const clean = (s: string | null | undefined, max = 300) => {
    const t = tidy(s);
    return t.length > max ? t.slice(0, max) : t;
  };
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
  const rendered = (el: Element): boolean => {
    const c = el as Element & { checkVisibility?: (o: object) => boolean };
    return typeof c.checkVisibility !== 'function' || c.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  /**
   * The element an element is drawn in, as the page is rendered: the slot it is placed in, else its parent, else (at
   * the top of a shadow root) the root's host. The guards that read where a picture stands (a link, a control, the
   * page's header, a figure, the words that mark a logo) follow it, as the painting does (the full-tree review's S2).
   */
  const up = (a: Element): Element | null => a.assignedSlot ?? a.parentElement ?? ((a.parentNode as ShadowRoot | null)?.host ?? null);
  /** The nearest of an element and the elements it is drawn in that matches a selector. */
  const closestUp = (el: Element, sel: string): Element | null => {
    for (let a: Element | null = el, i = 0; a && i < 400; a = up(a), i++) if (a.matches(sel)) return a;
    return null;
  };
  /** Rendered, with a box people can see (not clipped away, not moved off the page's left or top). */
  const seen = (el: Element): boolean => {
    if (!rendered(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 12) return false;
    if (r.right + window.scrollX < 0 || r.bottom + window.scrollY < 0) return false;
    for (let a: Element | null = el, i = 0; a && i < 5; a = a.parentElement, i++) {
      const st = getComputedStyle(a);
      // An element with no box of its own (`display: contents`) cuts nothing off.
      if (st.display === 'contents') continue;
      if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(st.clip) || /inset\(\s*(50%|100%)/.test(st.clipPath)) return false;
      const b = a.getBoundingClientRect();
      if ((b.width < 2 || b.height < 2) && st.overflow !== 'visible') return false;
    }
    return true;
  };
  /** Rounded corners: any corner radius other than none. */
  const rounded = (st: CSSStyleDeclaration): boolean => [st.borderTopLeftRadius, st.borderTopRightRadius, st.borderBottomLeftRadius, st.borderBottomRightRadius].some((v) => /[1-9]/.test(v || '0'));
  /**
   * What its containers leave of an element: the share of its box inside every container that cuts off its overflow
   * (hidden or clip, or paint containment; what a scrolling container holds can be scrolled to, so the walk stops
   * there), and its opacity multiplied with theirs. A filter, a clip path or a mask on a container changes what shows
   * of it in a way not worked out here (`effect`). The containers are those it is drawn in: up through the slot it is
   * placed in and out of a shadow root to its host, as the page is rendered, not only its parent elements.
   */
  const leftShowing = (el: Element): { showing: number; opacity: number; effect: boolean; unresolved?: string } => {
    const r = el.getBoundingClientRect();
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    type Masked = CSSStyleDeclaration & { maskImage?: string; webkitMaskImage?: string; contentVisibility?: string };
    let unresolved: string | undefined;
    const cuts = (st: Masked) => (st.clipPath || 'none') !== 'none' || (st.maskImage || 'none') !== 'none' || (st.webkitMaskImage || 'none') !== 'none';
    const own = getComputedStyle(el) as Masked;
    let opacity = Number(own.opacity);
    let effect = own.filter !== 'none' || own.mixBlendMode !== 'normal' || cuts(own);
    let clipping = true;
    for (let a: Element | null = up(el), i = 0; a && i < 40; a = up(a), i++) {
      const st = getComputedStyle(a) as Masked;
      // An element with no box of its own (a slot, `display: contents`) paints nothing and cuts nothing.
      if (st.display === 'contents') continue;
      const o = Number(st.opacity);
      if (Number.isFinite(o)) opacity *= o;
      if (st.filter !== 'none' || cuts(st)) effect = true;
      // A legacy clip on a container cuts off what it holds, in a way not worked out here.
      if ((st.clip || 'auto') !== 'auto') unresolved ??= 'a clip on a container';
      // Overflow and paint containment do not apply to an inline box (a link or a span around the picture).
      if (!clipping || st.display === 'inline') continue;
      const sx = st.overflowX, sy = st.overflowY;
      // A container that cuts off its overflow with rounded corners cuts the picture's corners too (not worked out).
      if ((!/visible/.test(sx) || !/visible/.test(sy) || /\b(paint|strict|content)\b/.test(st.contain || '') || st.contentVisibility === 'auto') && rounded(st)) unresolved ??= 'rounded corners on a container that cuts it off';
      if (/auto|scroll/.test(sx) || /auto|scroll/.test(sy)) { clipping = false; continue; }
      // Paint containment cuts off what overflows the container, as `overflow: clip` does (`content-visibility: auto`
      // brings it too).
      const paint = /\b(paint|strict|content)\b/.test(st.contain || '') || st.contentVisibility === 'auto';
      const cx = paint || /hidden|clip/.test(sx), cy = paint || /hidden|clip/.test(sy);
      if (!cx && !cy) continue;
      const b = a.getBoundingClientRect();
      if (cx) { x0 = Math.max(x0, b.left); x1 = Math.min(x1, b.right); }
      if (cy) { y0 = Math.max(y0, b.top); y1 = Math.min(y1, b.bottom); }
    }
    const area = r.width * r.height;
    return { showing: area > 0 ? (Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) / area : 0, opacity: Number.isFinite(opacity) ? opacity : 1, effect, ...(unresolved ? { unresolved } : {}) };
  };
  /**
   * Kept from assistive technology by its own markup: a presentation role, or aria-hidden on it or on a wrapper
   * within three levels (a figure, a slide). A region closed off further up (the page behind an open dialog, a
   * whole section) says nothing about the picture, and is not read as hiding it.
   */
  const hiddenFromAt = (el: Element): boolean => {
    for (let a: Element | null = el, i = 0; a && i < 4; a = a.parentElement, i++) if (a.getAttribute('aria-hidden') === 'true') return true;
    return /^(presentation|none)$/.test((el.getAttribute('role') ?? '').trim().toLowerCase());
  };
  /** A text of the picture's own, read whole up to the limit; `cut` says it was longer. */
  let cutNow = false;
  const own = (s: string | null | undefined): string => {
    const t = tidy(s);
    if (t.length > SOURCE) { cutNow = true; return t.slice(0, SOURCE); }
    return t;
  };
  const byIds = (el: Element, attr: string): string => {
    const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const root = el.getRootNode() as Document | ShadowRoot;
    return ids.map((id) => (root.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? '').join(' ');
  };
  const absolute = (raw: string): string => {
    if (!raw) return '';
    if (/^data:/i.test(raw)) return raw;
    try {
      const u = new URL(raw, document.baseURI);
      if (!/^https?:$/.test(u.protocol) || u.hash) return '';
      return u.href;
    } catch { return ''; }
  };
  const isSvg = (src: string): boolean => (/^data:/i.test(src) ? /^data:image\/svg\+xml[;,]/i.test(src) : /\.svgz?$/i.test((() => { try { return new URL(src).pathname; } catch { return ''; } })()));
  const isLocal = (src: string): boolean => { if (/^data:/i.test(src)) return true; try { return new URL(src).origin === location.origin; } catch { return false; } };
  const loadsOf = (src: string): number => {
    if (/^data:/i.test(src)) return 1;
    // Loads for showing it; a script's own read of the file (fetch, XHR) shows nothing.
    try { return performance.getEntriesByName(src).filter((e) => !/^(fetch|xmlhttprequest|beacon)$/.test((e as PerformanceResourceTiming).initiatorType ?? '')).length; } catch { return 0; }
  };
  const LOGO = /(^|[^a-z])(logo|logos|logotype|wordmark|brand|branding|seal|crest|emblem|badge|sponsor|sponsors|partner|partners|masthead)([^a-z]|$)/i;
  /** In an alt text only the word itself says "this is a logo": "badge", "seal" and "partner" are ordinary words there. */
  const LOGO_WORD = /\b(logo|logos|logotype|wordmark)\b/i;
  const CAPTCHA = /captcha|verification code|security code|human check|challenge/i;
  const SAMPLE = /\b(font|typeface|typography|lettering|calligraphy|handwriting|handwritten|signature|autograph|specimen|facsimile|screen ?shot|mock-?up|sample|example|placeholder|coming soon)\b/i;
  const SAMPLE_MARK = /placeholder|no[-_ ]?image|no[-_ ]?photo|noimage|specimen|screenshot|coming[-_ ]?soon/i;
  const TEXT_VERSION = /\b(text|accessible|plain[- ]text|screen[- ]reader|described|long|written)\b[^.]{0,30}\b(version|alternative|equivalent|description|format|copy)\b|\btranscript\b|\bdescription of (this|the)\b/i;
  /** The words that say what an element is: its and its near ancestors' class and id, and its file's name. */
  const marks = (el: Element, src: string): string => {
    const out: string[] = [];
    for (let a: Element | null = el, i = 0; a && i < 4; a = up(a), i++) out.push(String(a.getAttribute('class') ?? ''), a.id);
    // (A data: address has no file name: what follows its comma is the picture itself.)
    if (!/^data:/i.test(src)) { try { out.push(decodeURIComponent(new URL(src, document.baseURI).pathname.split('/').pop() ?? '')); } catch { /* no name */ } }
    return out.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  };
  const homeLink = (a: HTMLAnchorElement): boolean => {
    try {
      const u = new URL(a.href, document.baseURI);
      return u.origin === location.origin && /^\/?(index\.[a-z]+|home\/?)?$/i.test(u.pathname.replace(/^\/+/, '/').replace(/^\//, ''));
    } catch { return false; }
  };
  const controlOf = (el: Element): Element | null => closestUp(el, 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary');
  /** A link next to the picture (in its figure, or its nearest two wrappers) that offers its text. */
  const textVersionNear = (el: Element): boolean => {
    let scope: Element | null = closestUp(el, 'figure') ?? up(el);
    for (let i = 0; scope && i < 2; scope = up(scope), i++) {
      const links = scope.querySelectorAll('a[href], button, summary');
      if (links.length > 40) break;
      for (const a of links) if (!a.contains(el) && TEXT_VERSION.test(clean((a as HTMLElement).innerText || a.textContent, 160))) return true;
      if (scope.matches('figure, section, article, main, li, td')) break;
    }
    return false;
  };
  /**
   * The heading a picture comes right under, which a reader takes as its caption: the element before it (past one
   * short paragraph), from the picture itself or from wrappers that hold nothing but the picture.
   */
  const headingBefore = (el: Element): string => {
    /** The element before one, past what shows nothing (a picture's sources, a line break, a script or a style). */
    const before = (e: Element): Element | null => {
      let p = e.previousElementSibling;
      while (p && /^(SOURCE|BR|SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(p.tagName)) p = p.previousElementSibling;
      return p;
    };
    let at: Element = el;
    for (let up = 0; up < 4; up++) {
      let prev = before(at);
      if (prev && prev.tagName === 'P' && clean(prev.textContent, 260).length <= 240) prev = before(prev);
      if (prev) return /^H[1-6]$/.test(prev.tagName) || prev.getAttribute('role') === 'heading' ? clean(prev.textContent, 200) : '';
      const parent: Element | null = at.parentElement ?? ((at.parentNode as ShadowRoot | null)?.host ?? null);
      if (!parent || parent === document.body || parent.matches('main, article, section, td, th, li')) return '';
      for (const node of (at.parentElement ? parent.childNodes : at.parentNode!.childNodes)) {
        if (node === at) continue;
        if (node.nodeType === 3 ? (node.textContent ?? '').trim() : node.nodeType === 1 && !/^(FIGCAPTION|SOURCE|BR|SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test((node as Element).tagName)) return '';
      }
      at = parent;
    }
    return '';
  };
  /** A list of computed values split at its top-level commas (one entry per background layer). */
  const layersOf = (v: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const px = (v: string): number => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  // The parts of a page set apart from its content: the site's header and footer, a navigation, a dialog. The
  // content's own containers (main, article, section, aside, form) are not: a paragraph in the next section, or
  // in the main content after an article, is as near a picture as one in its own.
  const APART = 'nav, dialog, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="dialog"]';
  // A header or a footer inside one of these is that part's own (HTML: no landmark there), so it is content.
  const HOLDS_ITS_OWN = 'article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]';
  const partIds = new Map<Element, number>();
  /** The place of the page an element stands in, as a number (0 for the content). */
  const regionOf = (el: Element | null): number => {
    for (let part = el?.closest(APART) ?? null; part; part = part.parentElement?.closest(APART) ?? null) {
      const plain = (part.localName === 'header' || part.localName === 'footer') && !part.hasAttribute('role');
      if (plain && part.parentElement?.closest(HOLDS_ITS_OWN)) continue;
      let id = partIds.get(part);
      if (!id) { id = partIds.size + 1; partIds.set(part, id); }
      return id;
    }
    return 0;
  };
  const pictures: Picture[] = [];
  /** The element of each picture, for its place in the page's text. */
  const elements: Element[] = [];
  let truncated = false;
  const common = (el: Element, src: string, altText: string) => {
    const control = controlOf(el);
    const text = control ? clean((control as HTMLElement).innerText || control.textContent, 200) : '';
    const m = marks(el, src);
    const inBanner = !!closestUp(el, 'header, [role="banner"], footer, [role="contentinfo"], nav');
    const link = closestUp(el, 'a[href]') as HTMLAnchorElement | null;
    const labelledBy = byIds(el, 'aria-labelledby');
    const caption = closestUp(el, 'figure')?.querySelector('figcaption')?.textContent ?? '';
    const left = leftShowing(el);
    return {
      name: own(el.getAttribute('aria-label')) || own(labelledBy),
      title: own(el.getAttribute('title')),
      hidden: hiddenFromAt(el),
      described: own(`${byIds(el, 'aria-describedby')} ${byIds(el, 'aria-details')}`),
      caption: own(caption),
      showing: left.showing,
      ...(left.unresolved ? { unresolved: left.unresolved } : {}),
      opacity: left.opacity,
      effect: left.effect,
      loads: loadsOf(src),
      at: -1,
      region: regionOf(el),
      control: (control ? (text ? 'text' : 'only') : '') as Picture['control'],
      logo: LOGO.test(m) || LOGO_WORD.test(altText) || (!!link && (homeLink(link) || inBanner)),
      captcha: CAPTCHA.test(m) || CAPTCHA.test(altText),
      sample: SAMPLE_MARK.test(m) || SAMPLE.test(`${altText} ${el.getAttribute('aria-label') ?? ''} ${clean(labelledBy, 300)} ${el.getAttribute('title') ?? ''} ${clean(caption, 300)} ${headingBefore(el)}`),
      textVersion: textVersionNear(el),
    };
  };
  const walk = (root: Document | ShadowRoot, visit: (el: Element) => void, budget: { left: number }) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (budget.left-- <= 0) { truncated = true; return; }
      const el = all[i]!;
      visit(el);
      if (el.shadowRoot) walk(el.shadowRoot, visit, budget);
    }
  };
  walk(document, (el) => {
    const tag = el.localName;
    if (tag === 'img' || (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'image')) {
      if (pictures.length >= limits.pictures) { truncated = true; return; }
      // A lazy picture the browser has not loaded yet has no size of its own: it is read at its file's size.
      const im = el as HTMLImageElement;
      const waiting = tag === 'img' && im.loading === 'lazy' && !im.complete && rendered(el) && el.getBoundingClientRect().width < 24;
      if (!waiting && !seen(el)) return;
      const src = absolute((el as HTMLImageElement).currentSrc || el.getAttribute('src') || '');
      const r = waiting ? { width: 0, height: 0 } : el.getBoundingClientRect();
      const alt = el.getAttribute('alt');
      const st = getComputedStyle(el);
      cutNow = false;
      const altText = alt === null ? null : own(alt);
      const rest = common(el, src, alt ?? '');
      // An image is painted in its content box: padding or a border moves and shrinks it, a legacy clip or rounded
      // corners cut it. None of that is worked out here (the full-tree review's S4).
      const ownCut = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some((k) => px((st as unknown as Record<string, string>)[k] ?? '0') > 0) ? 'padding or a border on it'
        : (st.clip || 'auto') !== 'auto' ? 'a clip on it'
          : rounded(st) ? 'rounded corners on it'
            : undefined;
      if (ownCut) rest.unresolved = ownCut;
      pictures.push({
        kind: tag === 'img' ? 'img' : 'input', target: cssPath(el), src, svg: !!src && isSvg(src), local: isLocal(src), alt: altText,
        ...rest, cut: cutNow, width: Math.round(r.width), height: Math.round(r.height),
        fit: st.objectFit || 'fill', fitAt: st.objectPosition || '50% 50%',
        ...(tag === 'img' && im.complete && im.naturalWidth > 0 ? { decoded: [im.naturalWidth, im.naturalHeight] as [number, number] } : {}),
      });
      elements.push(el);
      return;
    }
    if (tag === 'html' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'svg' || el.closest('svg')) return;
    const st = getComputedStyle(el);
    const bg = st.backgroundImage;
    if (!bg || bg === 'none' || !/url\(/.test(bg) || !/svg/i.test(bg)) return;
    const layers = layersOf(bg);
    const urlOf = (layer: string): string => { const m = /^url\((["']?)(.*?)\1\)$/.exec(layer); return m ? absolute((m[2] ?? '').replace(/\\(["'])/g, '$1')) : ''; };
    const files = layers.map((l, i) => ({ i, url: urlOf(l) })).filter((x) => x.url && isSvg(x.url));
    if (files.length !== 1 || !seen(el)) return;
    if (pictures.length >= limits.pictures) { truncated = true; return; }
    const r = el.getBoundingClientRect();
    const layer = files[0]!.i;
    const pick = (v: string): string => { const l = layersOf(v); return l.length ? l[layer % l.length]! : ''; };
    const h = el as HTMLElement;
    const bw = h.offsetWidth || r.width, bh = h.offsetHeight || r.height;
    const corner = (v: string): number => Math.max(...v.split(/\s+/).map((part, k) => (part.endsWith('%') ? (px(part) / 100) * (k === 0 ? bw : bh) : px(part))), 0);
    let inner = false;
    const kids = el.querySelectorAll('*');
    for (let k = 0; k < kids.length && k < 60 && !inner; k++) {
      const c = kids[k]!;
      if (!rendered(c)) continue;
      const cb = c.getBoundingClientRect();
      if (cb.width >= 4 && cb.height >= 4) inner = true;
    }
    cutNow = false;
    const rest = common(el, files[0]!.url, '');
    pictures.push({
      kind: 'background', target: cssPath(el), src: files[0]!.url, svg: true, local: isLocal(files[0]!.url), alt: null,
      ...rest, cut: cutNow, width: Math.round(r.width), height: Math.round(r.height),
      ownText: clean((el as HTMLElement).innerText || '', 300),
      background: {
        layers: layers.length, layer,
        size: pick(st.backgroundSize), position: pick(st.backgroundPosition), repeat: pick(st.backgroundRepeat),
        origin: pick(st.backgroundOrigin), clip: pick(st.backgroundClip), attachment: pick(st.backgroundAttachment),
        box: [bw, bh],
        border: [px(st.borderTopWidth), px(st.borderRightWidth), px(st.borderBottomWidth), px(st.borderLeftWidth)],
        padding: [px(st.paddingTop), px(st.paddingRight), px(st.paddingBottom), px(st.paddingLeft)],
        scale: [bw > 0 ? r.width / bw : 1, bh > 0 ? r.height / bh : 1],
        radius: Math.max(corner(st.borderTopLeftRadius), corner(st.borderTopRightRadius), corner(st.borderBottomLeftRadius), corner(st.borderBottomRightRadius)),
        inner,
        effect: (pick(st.backgroundBlendMode) || 'normal') !== 'normal' || st.mixBlendMode !== 'normal' || st.filter !== 'none'
          || (st.clipPath || 'none') !== 'none' || ((st as CSSStyleDeclaration & { maskImage?: string }).maskImage || 'none') !== 'none'
          || ((st as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage || 'none') !== 'none',
      },
    });
    elements.push(el);
  }, { left: limits.elements });

  // The page's text in blocks: every text node (shown or not), grouped by its nearest ancestor that is not an
  // inline element, in document order, through open shadow roots and the page's own frames; and the text
  // alternatives elements carry (alt, aria-label, title), each as a block where its element stands. A long block
  // is split at a space into pieces, never cut: what is not compared is said (`blocksTruncated`).
  const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'tspan', 'textpath']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head']);
  const placeOf = new Map<Element, number[]>();
  elements.forEach((el, i) => { const at = placeOf.get(el); if (at) at.push(i); else placeOf.set(el, [i]); });
  const blocks: string[] = [];
  const regions: number[] = [];
  const heads: boolean[] = [];
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const headOf = (el: Element | null): boolean => !!el?.closest(HEADING);
  let chars = 0;
  let blocksTruncated = false;
  let framesUnread = false;
  let cur: Element | null = null;
  let buf: string[] = [];
  const push = (t: string, region: number, head: boolean) => {
    if (blocksTruncated || t.length < 2) return;
    if (blocks.length >= limits.blocks || chars + t.length > limits.pageChars) { blocksTruncated = true; return; }
    blocks.push(t);
    regions.push(region);
    heads.push(head);
    chars += t.length;
  };
  const add = (text: string, region: number, head: boolean) => {
    let t = tidy(text);
    while (t.length > limits.blockChars) {
      let cutAt = t.lastIndexOf(' ', limits.blockChars);
      if (cutAt < limits.blockChars / 2) cutAt = limits.blockChars;
      push(t.slice(0, cutAt).trim(), region, head);
      t = t.slice(cutAt).trim();
    }
    push(t, region, head);
  };
  /** Text alternatives met inside the block being read: added right after it, so a paragraph stays one block. */
  let carried: { text: string; region: number; head: boolean }[] = [];
  const flush = () => {
    if (buf.length) add(buf.join(' '), regionOf(cur), headOf(cur));
    buf = [];
    for (const a of carried) add(a.text, a.region, a.head);
    carried = [];
  };
  let held = 0;
  const texts = (root: Node, depth: number) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n && !blocksTruncated; n = tw.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        const mine = placeOf.get(el);
        // Its place: after the block being read and the text alternatives already met (its own come after it).
        if (mine) for (const i of mine) pictures[i]!.at = blocks.length + (buf.length ? 1 : 0) + carried.length;
        // A text alternative an element carries, where the element stands: only one that reaches assistive
        // technology (not on an element kept from it, nor the alt text of a picture marked as decoration).
        if ((el.hasAttribute('alt') || el.hasAttribute('aria-label') || el.hasAttribute('title')) && !el.closest('head, [aria-hidden="true"]')) {
          const decoration = /^(presentation|none)$/.test((el.getAttribute('role') ?? '').trim().toLowerCase());
          for (const attr of ['alt', 'aria-label', 'title']) {
            const v = el.getAttribute(attr);
            if (v && v.trim().length > 1 && !(decoration && attr === 'alt')) carried.push({ text: v, region: regionOf(el), head: headOf(el) });
          }
        }
        if (el.shadowRoot) { flush(); cur = null; texts(el.shadowRoot, depth); flush(); cur = null; }
        if (el.localName === 'iframe' || el.localName === 'frame') {
          // The page's own frames (same site): their text is the page's too. Another site's frame, or one nested
          // deeper than is read, cannot be read: what it says is not known, so nothing is said of words "given
          // nowhere" (the full-tree review's S6).
          let body: HTMLElement | null = null;
          if (depth < 2) { try { body = (el as HTMLIFrameElement).contentDocument?.body ?? null; } catch { body = null; } }
          if (body) { flush(); cur = null; texts(body, depth + 1); flush(); cur = null; } else framesUnread = true;
        }
        continue;
      }
      const raw = n.nodeValue ?? '';
      if (!raw.trim()) continue;
      let holder: Element | null = n.parentElement;
      let skip = false;
      for (let a: Element | null = holder; a; a = a.parentElement) if (SKIP.has(a.localName)) { skip = true; break; }
      if (skip) continue;
      while (holder && INLINE.has(holder.localName)) holder = holder.parentElement;
      if (holder !== cur) { flush(); cur = holder; held = 0; }
      held += raw.length;
      if (chars + held > limits.pageChars) { blocksTruncated = true; break; }
      buf.push(raw);
    }
  };
  if (document.body) texts(document.body, 0);
  flush();
  return { pictures, blocks, regions, heads, blocksTruncated, truncated, ...(framesUnread ? { framesUnread } : {}) };
}

/** One text element of an SVG file, as drawn. */
export interface DrawnText {
  /** Its words that are shown, as written in the file: each word's own removal changes the picture. */
  text: string;
  /** Pixels its removal changes; 0 when it is not drawn (hidden, off the canvas, covered). -1 when not measured. */
  ink: number;
  /** Its words that are not shown (a part kept out of sight, moved off the canvas, covered or clipped away). */
  unseen: number;
  /** Its lines on the canvas: [x0, y0, x1, y1] of each run of rows with its ink. */
  bands: [number, number, number, number][];
}

/** A flat region of the drawing without its text elements. */
export interface FlatRegion {
  /** Pixels. */
  n: number;
  box: [number, number, number, number];
  /** Pixels of the words' ink that sit on it. */
  text: number;
  /** Nothing is drawn there (the file's transparent ground). */
  clear: boolean;
}

export interface SvgMeasure {
  /** The canvas, px. */
  width: number;
  height: number;
  /** The file's own size (its width and height, else its viewBox). */
  natural: [number, number];
  /**
   * What the file says of its size: 'size' (a width and a height in px), 'ratio' (a viewBox only: it takes the size
   * it is given) or 'unknown' (sizes in units this test does not convert).
   */
  intrinsic: 'size' | 'ratio' | 'unknown';
  /**
   * How the drawing is fitted in a box of another shape: the root's preserveAspectRatio as written ('' for the
   * default: whole and centred), or 'none' for a file with no viewBox (it is stretched like a bitmap).
   */
  aspect: string;
  /** The viewBox's size (the file's own size when it has none). */
  view?: [number, number];
  texts: DrawnText[];
  /** Pixels all the text elements together change. */
  textInk: number;
  /**
   * The share of the shown words' glyphs (drawn alone, with nothing over them and nothing cutting them) that show
   * in the picture: under 1 when something covers or cuts part of a word. -1 when it could not be measured.
   */
  seen: number;
  /** The largest flat regions of the drawing without the words (at most 60). */
  regions: FlatRegion[];
  /** Ink of the regions not listed that hold no words and are not hairlines. */
  restInk: number;
}

/**
 * Why a file was not measured: 'unread' (the browser's copy could not be had), 'too-large', 'unsafe' (it declares
 * entities or a stylesheet), 'unsupported' (it moves or changes by itself, draws HTML, or depends on the size it
 * is shown at: drawn here it could differ from what the page shows), 'heavy' (it embeds pictures or applies a
 * filter: their decoding is not bounded by the file's size or the time box), 'reloaded' (the browser loaded its
 * address again while it was measured), 'not-svg', 'not-drawn', 'time'.
 */
export type SvgMeasureError = 'unread' | 'too-large' | 'unsafe' | 'unsupported' | 'heavy' | 'reloaded' | 'not-svg' | 'not-drawn' | 'time';

export interface SvgMeasured {
  src: string;
  measure?: SvgMeasure;
  error?: SvgMeasureError;
  /** With an error: the file's source was read and has a text element (words that could not be measured). */
  hasText?: boolean;
}

/**
 * Runs in the page (self-contained): measures each file from its source: handed in (the browser's own copy), the
 * address itself (a data: address), or, for the page's own site, the browser's stored copy of what it loaded
 * (`only-if-cached`: the network is never asked, so a file that is not stored is "unread"). Nothing is added to
 * the page; nothing in the file runs or loads (it is parsed into an inert document and drawn as an image).
 */
export async function measureSvgPictures(arg: {
  /** `source`: the file's text, handed in. `read: false`: not to be read by the page (another site's file). */
  files: { src: string; source?: string; read?: boolean }[];
  limits: { fileBytes: number; texts: number; words?: number; minSide: number; maxSide: number; budgetMs: number; drawMs: number };
}): Promise<SvgMeasured[]> {
  const L = arg.limits;
  const WORDS = L.words ?? 160;
  /** Pixels a text element's, and one word's, removal must change to count as shown. */
  const DRAWN_INK = 12;
  const WORD_INK = 3;
  const started = performance.now();
  const left = () => L.budgetMs - (performance.now() - started);
  type Source = { text: string } | { error: SvgMeasureError };
  const read = async (src: string): Promise<Source> => {
    try {
      if (/^data:/i.test(src)) {
        const comma = src.indexOf(',');
        if (comma < 0) return { error: 'unread' };
        const head = src.slice(0, comma);
        const body = src.slice(comma + 1);
        if (body.length > L.fileBytes * 2) return { error: 'too-large' };
        if (/;base64/i.test(head)) {
          const bin = atob(body.replace(/\s+/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return { text: new TextDecoder('utf-8').decode(bytes) };
        }
        try { return { text: decodeURIComponent(body) }; } catch { return { text: body }; }
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Math.max(200, Math.min(3000, left())));
      try {
        // The browser's stored copy of the address the page loaded, and nothing else: with `only-if-cached` the
        // network is never asked, so the words read are the ones of the file the browser has, not of a newer one.
        const res = await fetch(src, { cache: 'only-if-cached', mode: 'same-origin', signal: ctl.signal });
        if (!res.ok) return { error: 'unread' };
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > L.fileBytes) { ctl.abort(); return { error: 'too-large' }; }
        // Read piece by piece and stopped at the limit: a file with no stated length is never held whole.
        const reader = res.body?.getReader();
        if (!reader) return { error: 'unread' };
        const parts: Uint8Array[] = [];
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          n += value.byteLength;
          if (n > L.fileBytes) { await reader.cancel().catch(() => {}); ctl.abort(); return { error: 'too-large' }; }
          parts.push(value);
        }
        const all = new Uint8Array(n);
        let at = 0;
        for (const part of parts) { all.set(part, at); at += part.byteLength; }
        return { text: new TextDecoder('utf-8').decode(all) };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { error: 'unread' };
    }
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const measure = async (given: string): Promise<SvgMeasure | SvgMeasureError> => {
    // A plain doctype (no internal subset: nothing it can declare) is dropped; a file that declares entities or
    // names a stylesheet is never parsed (an entity bomb, an external stylesheet).
    const source = given.replace(/<!DOCTYPE[^>[]*>/i, '');
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) return 'unsafe';
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) return 'not-svg';
    // What the file draws must be what the page shows. A file that changes by itself (SMIL animation and timing, CSS
    // animations and transitions), draws HTML (foreignObject) or lays itself out by the size it is shown at (media
    // and container queries) could look different here, so it is not measured at all.
    if (doc.querySelector('animate, animateTransform, animateMotion, animateColor, set, discard, foreignObject')) return 'unsupported';
    let css = '';
    for (const st of doc.querySelectorAll('style')) css += `${st.textContent ?? ''}\n`;
    for (const el of doc.querySelectorAll('[style]')) css += `${el.getAttribute('style') ?? ''};\n`;
    if (/@media|@container|@keyframes|animation|transition/i.test(css)) return 'unsupported';
    // A script never runs in a file shown as a picture and draws nothing: taking it out changes nothing shown.
    for (const el of [...doc.querySelectorAll('script')]) el.remove();
    const clean = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
    const items = [...doc.querySelectorAll('text')].filter((t) => !t.parentElement?.closest('text')).map((el) => ({ el, text: clean(el.textContent) })).filter((x) => x.text);
    // A text element longer than any line of a notice is not read in part.
    if (items.some((x) => x.text.length > 2000)) return 'too-large';
    // Pictures embedded in the file (a data: or a linked bitmap: its decoded size is not bounded by the file's) and
    // filters (whose painting no timer can stop once it starts) cost what the canvas's size does not bound: a file
    // with words and either is never decoded (the full-tree review's S7, and its cut-round check's S5). A file with
    // no words is not drawn at all.
    if (items.length && (doc.querySelector('image, feImage, filter, [filter]') || /(^|[;{\s])filter\s*:/i.test(css))) return 'heavy';
    const num = (v: string | null) => { const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(v ?? ''); return m ? Number(m[1]) : NaN; };
    const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const hasBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0;
    const rawW = (root.getAttribute('width') ?? '').trim();
    const rawH = (root.getAttribute('height') ?? '').trim();
    let w = num(rawW);
    let h = num(rawH);
    const sized = w > 0 && h > 0;
    const relative = (v: string) => v === '' || /%$/.test(v) || v === 'auto';
    // One side in px and a viewBox give the other side: a size of its own all the same.
    const intrinsic: SvgMeasure['intrinsic'] = sized || (hasBox && ((w > 0 && rawH === '') || (h > 0 && rawW === ''))) ? 'size'
      : relative(rawW) && relative(rawH) ? 'ratio' : 'unknown';
    if (hasBox) {
      if (!(w > 0) && !(h > 0)) { w = vb[2]!; h = vb[3]!; }
      else if (!(w > 0)) w = (h * vb[2]!) / vb[3]!;
      else if (!(h > 0)) h = (w * vb[3]!) / vb[2]!;
    } else if (sized) {
      root.setAttribute('viewBox', `0 0 ${w} ${h}`);
    } else {
      // No viewBox and no size of its own: what shows depends on the size it is given.
      return items.length ? 'unsupported' : { width: 0, height: 0, natural: [300, 150], intrinsic: 'unknown', aspect: 'none', texts: [], textInk: 0, seen: 1, regions: [], restInk: 0 };
    }
    const aspect = hasBox ? (root.getAttribute('preserveAspectRatio') ?? '').trim() : 'none';
    const view: [number, number] = hasBox ? [vb[2]!, vb[3]!] : [w, h];
    if (!items.length) return { width: 0, height: 0, natural: [w, h], intrinsic, aspect, view, texts: [], textInk: 0, seen: 1, regions: [], restInk: 0 };
    const long = Math.max(w, h);
    const k = long > L.maxSide ? L.maxSide / long : long < L.minSide ? Math.min(4, L.minSide / long) : 1;
    const W = Math.max(8, Math.round(w * k));
    const H = Math.max(8, Math.round(h * k));
    root.setAttribute('width', String(W));
    root.setAttribute('height', String(H));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return 'not-drawn';
    const ser = new XMLSerializer();
    const draw = async (of: XMLDocument = doc): Promise<Uint8ClampedArray | null> => {
      if (left() <= 0) return null;
      const xml = ser.serializeToString(of);
      // A drawing that runs out of time is stopped (its picture's address taken away), and no second one is started.
      const load = (url: string) => new Promise<{ img: HTMLImageElement | null; late: boolean }>((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => { img.onload = null; img.onerror = null; img.src = ''; resolve({ img: null, late: true }); }, Math.max(100, Math.min(L.drawMs, left())));
        img.onload = () => { clearTimeout(timer); resolve({ img, late: false }); };
        img.onerror = () => { clearTimeout(timer); resolve({ img: null, late: false }); };
        img.src = url;
      });
      const first = await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
      let img = first.img;
      if (!img && !first.late) {
        // A page whose policy refuses data: images may still allow blob: ones.
        let url = '';
        try {
          url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
          img = (await load(url)).img;
        } catch { img = null; } finally { if (url) URL.revokeObjectURL(url); }
      }
      if (!img) return null;
      try {
        g.clearRect(0, 0, W, H);
        g.drawImage(img, 0, 0, W, H);
        return g.getImageData(0, 0, W, H).data;
      } catch {
        return null;
      }
    };
    /** Pixels where two drawings differ, their box, and (when given) a mask of them. */
    const diff = (X: Uint8ClampedArray, Y: Uint8ClampedArray, mask?: Uint8Array) => {
      let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0, i = 0; y < H; y++) {
        for (let x = 0; x < W; x++, i += 4) {
          const d = Math.abs(X[i]! - Y[i]!) + Math.abs(X[i + 1]! - Y[i + 1]!) + Math.abs(X[i + 2]! - Y[i + 2]!) + Math.abs(X[i + 3]! - Y[i + 3]!);
          if (d > 48) {
            n++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (mask) mask[y * W + x] = 1;
          }
        }
      }
      return { n, x0, y0, x1, y1 };
    };
    /** The words of a text element, each with the text node that holds it: runs of letters or digits between spaces. */
    type Word = { node: Text; start: number; end: number; word: boolean };
    const wordsOf = (el: Element): Word[] => {
      const out: Word[] = [];
      const tw = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const data = (n as Text).data;
        const re = /\S+/g;
        for (let m = re.exec(data); m; m = re.exec(data)) out.push({ node: n as Text, start: m.index, end: m.index + m[0].length, word: /[\p{L}\p{N}]/u.test(m[0]) });
      }
      return out;
    };
    /**
     * Takes one word out of sight without moving anything: the word is wrapped in a tspan that is not painted but
     * keeps its place. Returns how to put the text node back as it was.
     */
    const hide = (w: Word): (() => void) => {
      const parent = w.node.parentNode!;
      const data = w.node.data;
      const before = doc.createTextNode(data.slice(0, w.start));
      const span = doc.createElementNS(SVG_NS, 'tspan');
      span.setAttribute('visibility', 'hidden');
      span.setAttribute('style', 'visibility:hidden !important');
      span.textContent = data.slice(w.start, w.end);
      const after = doc.createTextNode(data.slice(w.end));
      parent.insertBefore(before, w.node);
      parent.insertBefore(span, w.node);
      parent.insertBefore(after, w.node);
      parent.removeChild(w.node);
      return () => { parent.insertBefore(w.node, before); before.remove(); span.remove(); after.remove(); };
    };
    const A = await draw();
    if (!A) return left() <= 0 ? 'time' : 'not-drawn';
    const places = items.map((x) => ({ parent: x.el.parentNode!, next: x.el.nextSibling }));
    for (const x of items) x.el.remove();
    const B = await draw();
    for (let i = items.length - 1; i >= 0; i--) places[i]!.parent.insertBefore(items[i]!.el, places[i]!.next);
    if (!B) return left() <= 0 ? 'time' : 'not-drawn';
    const textMask = new Uint8Array(W * H);
    const all = diff(A, B, textMask);
    const texts: DrawnText[] = [];
    /** Per text element: which of its words are not shown (by their place in `wordsOf`). */
    const unseenWords: Set<number>[] = [];
    let each = items.length <= L.texts;
    if (each) {
      const mask = new Uint8Array(W * H);
      let measuredWords = 0;
      for (let i = 0; i < items.length && each; i++) {
        const { parent, next } = places[i]!;
        items[i]!.el.remove();
        const Bi = await draw();
        parent.insertBefore(items[i]!.el, next);
        if (!Bi) return left() <= 0 ? 'time' : 'not-drawn';
        mask.fill(0);
        const d = diff(A, Bi, mask);
        const bands: [number, number, number, number][] = [];
        if (d.n) {
          let start = -1;
          for (let y = d.y0; y <= d.y1 + 1; y++) {
            let any = false;
            if (y <= d.y1) for (let x = d.x0; x <= d.x1; x++) if (mask[y * W + x]) { any = true; break; }
            if (any && start < 0) start = y;
            if (!any && start >= 0) {
              let bx0 = W, bx1 = -1;
              for (let yy = start; yy < y; yy++) for (let x = d.x0; x <= d.x1; x++) if (mask[yy * W + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
              if (bands.length < 12) bands.push([bx0, start, bx1, y - 1]);
              start = -1;
            }
          }
        }
        // Each word of a shown element by itself: some ink of the element does not show that all its words are
        // there (a part kept out of sight, a word covered or cut away). A word is shown when taking it out of
        // sight, and nothing else, changes the picture.
        const tokens = wordsOf(items[i]!.el);
        const gone = new Set<number>();
        let shownText = items[i]!.text;
        const count = tokens.filter((t) => t.word).length;
        if (d.n >= DRAWN_INK && count > 1) {
          measuredWords += count;
          if (measuredWords > WORDS) { each = false; break; }
          for (let t = 0; t < tokens.length; t++) {
            if (!tokens[t]!.word) continue;
            const restore = hide(tokens[t]!);
            const Bw = await draw();
            restore();
            if (!Bw) return left() <= 0 ? 'time' : 'not-drawn';
            if (diff(A, Bw).n < WORD_INK) gone.add(t);
          }
          if (gone.size) {
            // What is quoted and judged: the shown words, each with the marks that follow it.
            const kept: string[] = [];
            let last = false;
            tokens.forEach((t, at) => {
              if (t.word) last = !gone.has(at);
              if (last) kept.push(t.node.data.slice(t.start, t.end));
            });
            shownText = kept.join(' ');
          }
        }
        unseenWords.push(gone);
        texts.push({ text: shownText, ink: d.n, unseen: gone.size, bands });
      }
    }
    if (!each) {
      texts.length = 0;
      for (const x of items.slice(0, 200)) texts.push({ text: x.text, ink: -1, unseen: 0, bands: [] });
    }
    // The shown words drawn alone: the same file with everything that is not a shown text element taken out, and
    // nothing cutting or covering what is left. Where its glyphs are solid, the picture must show the words: the
    // share that does is `seen` (under 1 when a shape lies over part of a word, or a clip path or a mask cuts it).
    let seen = -1;
    if (each) {
      const shown = items.map((x, i) => ({ el: x.el, i })).filter((x) => texts[x.i]!.ink >= DRAWN_INK && texts[x.i]!.text);
      if (!shown.length) {
        seen = 1;
      } else {
        for (const x of shown) x.el.setAttribute('data-grnted-kept', String(x.i));
        const alone = doc.cloneNode(true) as XMLDocument;
        for (const x of shown) x.el.removeAttribute('data-grnted-kept');
        const keep = new Set<Element>();
        for (const el of alone.querySelectorAll('[data-grnted-kept]')) {
          keep.add(el);
          for (const inner of el.querySelectorAll('*')) keep.add(inner);
          for (let a = el.parentElement; a; a = a.parentElement) keep.add(a);
        }
        for (const el of alone.querySelectorAll('defs, style')) { keep.add(el); for (const inner of el.querySelectorAll('*')) keep.add(inner); }
        for (const el of [...alone.querySelectorAll('*')]) if (!keep.has(el) && el.isConnected) el.remove();
        // The words not shown stay out of sight here too.
        for (const el of [...alone.querySelectorAll('[data-grnted-kept]')]) {
          const gone = unseenWords[Number(el.getAttribute('data-grnted-kept'))];
          if (!gone?.size) continue;
          const tw = alone.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const nodes: Text[] = [];
          for (let n = tw.nextNode(); n; n = tw.nextNode()) nodes.push(n as Text);
          let at = 0;
          for (const node of nodes) {
            const data = node.data;
            const re = /\S+/g;
            const frag = alone.createDocumentFragment();
            let from = 0;
            for (let m = re.exec(data); m; m = re.exec(data), at++) {
              if (!gone.has(at)) continue;
              frag.append(alone.createTextNode(data.slice(from, m.index)));
              const span = alone.createElementNS(SVG_NS, 'tspan');
              span.setAttribute('style', 'visibility:hidden !important');
              span.textContent = m[0];
              frag.append(span);
              from = m.index + m[0].length;
            }
            if (from > 0) { frag.append(alone.createTextNode(data.slice(from))); node.parentNode!.replaceChild(frag, node); }
          }
        }
        const free = alone.createElementNS(SVG_NS, 'style');
        // The letters themselves: an outline or a halo around them (a stroke) is not what must show.
        free.textContent = '*{clip-path:none !important;mask:none !important;-webkit-mask:none !important;filter:none !important}svg{overflow:visible !important}text,text *{stroke:none !important}';
        alone.documentElement.append(free);
        const C = await draw(alone);
        if (!C) return left() <= 0 ? 'time' : 'not-drawn';
        let solid = 0, showing = 0;
        for (let p = 0, i = 3; p < W * H; p++, i += 4) {
          if (C[i]! < 128) continue;
          solid++;
          if (textMask[p]) showing++;
        }
        // Too little of the words is solid when drawn alone (faint or outlined letters): nothing is shown either way.
        seen = solid >= 0.15 * all.n && solid > 0 ? showing / solid : -1;
      }
    }
    // Words that reach the edge of the file's own drawing may run past it: what lies past the edge is drawn neither
    // here nor on the page, so the glyphs drawn alone cannot show that a word is whole. Not all of them show.
    if (seen >= 0 && all.n > 0 && (all.x0 <= 0 || all.y0 <= 0 || all.x1 >= W - 1 || all.y1 >= H - 1)) seen = 0;
    // The drawing without the words, in flat regions (neighbours of nearly one colour: a smooth gradient is one region).
    const N = W * H;
    const label = new Uint8Array(N);
    const stack = new Int32Array(N);
    const near = (p: number, q: number) => {
      const i = p * 4, j = q * 4;
      return Math.abs(B[i]! - B[j]!) + Math.abs(B[i + 1]! - B[j + 1]!) + Math.abs(B[i + 2]! - B[j + 2]!) + Math.abs(B[i + 3]! - B[j + 3]!) <= 12;
    };
    const hair = Math.max(4, Math.round(0.012 * Math.min(W, H)));
    const regions: FlatRegion[] = [];
    // Ink of what is not listed: the specks (a photo or a texture inside the file is thousands of them; the soft
    // edge of a few shapes is not), and the unlisted regions that hold no words and are not hairlines.
    let restInk = 0;
    for (let s = 0; s < N; s++) {
      if (label[s]) continue;
      let top = 0;
      stack[top++] = s;
      label[s] = 1;
      let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, text = 0;
      while (top) {
        const p = stack[--top]!;
        const x = p % W, y = (p - x) / W;
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (textMask[p]) text++;
        if (x > 0 && !label[p - 1] && near(p, p - 1)) { label[p - 1] = 1; stack[top++] = p - 1; }
        if (x < W - 1 && !label[p + 1] && near(p, p + 1)) { label[p + 1] = 1; stack[top++] = p + 1; }
        if (y > 0 && !label[p - W] && near(p, p - W)) { label[p - W] = 1; stack[top++] = p - W; }
        if (y < H - 1 && !label[p + W] && near(p, p + W)) { label[p + W] = 1; stack[top++] = p + W; }
      }
      if (n < 12) { if (!text && B[s * 4 + 3]! >= 16) restInk += n; continue; }
      regions.push({ n, box: [x0, y0, x1, y1], text, clear: B[s * 4 + 3]! < 16 });
    }
    regions.sort((a, b) => b.n - a.n);
    for (const r of regions.slice(60)) {
      if (!r.clear && !r.text && Math.min(r.box[2] - r.box[0], r.box[3] - r.box[1]) + 1 > hair) restInk += r.n;
    }
    return { width: W, height: H, natural: [w, h], intrinsic, aspect, view, texts, textInk: all.n, seen, regions: regions.slice(0, 60), restInk };
  };
  const out: SvgMeasured[] = [];
  for (const f of arg.files) {
    if (left() <= 0) { out.push({ src: f.src, error: 'time' }); continue; }
    const got: Source = f.source !== undefined ? { text: f.source } : f.read === false ? { error: 'unread' } : await read(f.src);
    if ('error' in got) { out.push({ src: f.src, error: got.error }); continue; }
    if (got.text.length > L.fileBytes) { out.push({ src: f.src, error: 'too-large' }); continue; }
    let m: SvgMeasure | SvgMeasureError;
    try { m = await measure(got.text); } catch { m = 'not-drawn'; }
    out.push(typeof m === 'string' ? { src: f.src, error: m, hasText: /<text[\s>]/i.test(got.text) } : { src: f.src, measure: m });
  }
  return out;
}
