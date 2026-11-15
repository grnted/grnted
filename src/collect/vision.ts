// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Vision collector (Plan 3, Task 5): a viewport screenshot plus numbered page facts the vision check
// sends with it. Engine core: no Node-only or AI imports. The screenshot bytes live only in
// `PageAudit.collected.vision`; the report never includes them.
import type { CDPSessionLike, PageCollector } from '../types.js';

/** [x, y, width, height] in CSS px, relative to the top-left of the screenshot (scroll position 0). */
export type Box = [x: number, y: number, width: number, height: number];

/** One visible block of the page, in DOM order (the order a screen reader reads it). */
export interface VisionBlock {
  /** Fact number, unique across blocks, links and icons on the page. */
  n: number;
  /** 'heading 2', 'paragraph', 'list item', 'link', 'button', 'label', 'field (email)', 'image', 'background image', 'text', … */
  role: string;
  /** Visible text (alt text for images), whitespace-collapsed and trimmed. */
  text: string;
  box: Box;
  /** The block shows a CSS background image, which assistive technology cannot read. */
  backgroundImage?: true;
  /**
   * The picture's file, when the block is one (an img, an image button, a background image): the address the
   * browser shows (`currentSrc`, the computed background's url), so a finding about it names the same picture the
   * picture checks name (one cost per picture, src/aiDedupe.ts). http(s) only, at most 2,000 characters.
   */
  file?: string;
}

/** A link in running text whose only visible difference from the text around it is its color (1.4.1). */
export interface ColorOnlyLink {
  n: number;
  text: string;
  href: string;
  /** The paragraph (or other block) the link sits in. */
  context: string;
  linkColor: string;
  textColor: string;
  /** Contrast ratio between the link color and the surrounding text color, e.g. 2.4. */
  contrastWithText: number;
  box: Box;
}

export type AccessibleNameSource = 'aria-labelledby' | 'aria-label' | 'label' | 'alt' | 'value' | 'content' | 'title' | 'browser' | 'none';

/** A control or image shown only as an icon (no visible words), with its accessible name (1.1.1 / 4.1.2). */
export interface IconCandidate {
  n: number;
  /** true for links, buttons and other controls; false for images drawn with CSS. */
  interactive: boolean;
  role: string;
  /**
   * Accessible name: the browser's computed name (CDP Accessibility) when `nameVerified`, else the page-side
   * approximation (prompt wording only); '' when there is none.
   */
  name: string;
  nameFrom: AccessibleNameSource;
  /**
   * true when `name` is the browser's own computed accessible name. Only then can an answer about the icon's name count
   * toward the score (Sol r3 ruling 1); a name the browser did not confirm (no CDP, a timeout) is an opinion at most.
   */
  nameVerified?: boolean;
  /**
   * Whether the browser's WHOLE computed name gives screen readers anything to say (speakableName), judged before
   * `name` is cut to 150 characters for the prompt (Sol r4 #3). Set with `nameVerified`.
   */
  nameSpeakable?: boolean;
  /** How the icon is drawn: 'svg', 'img', 'image button', 'background image', 'icon font' or 'symbol "×"'. */
  graphic: string;
  href?: string;
  /** Visible text of the block around the icon. */
  nearbyText: string;
  /** The icon is inside aria-hidden="true". */
  hidden?: true;
  box: Box;
  /** The icon's picture file (its img, image button or background image), as `VisionBlock.file`. */
  file?: string;
}

/** Consecutive blocks whose visual order is the reverse of their DOM order. */
export interface OrderInversion {
  /** The block a screen reader reaches first. */
  domFirst: number;
  /** The next block in the DOM, which the screenshot shows first (above it, or before it in the row). */
  shownFirst: number;
  how: 'above' | 'left' | 'right';
}

export interface VisionFacts {
  /** The screenshot and every box refer to this viewport, scrolled to the top. */
  viewport: { width: number; height: number };
  /** JPEG (quality 70) of the viewport. Absent when the capture failed (see `screenshotError`). */
  screenshot?: Uint8Array;
  screenshotError?: string;
  blocks: VisionBlock[];
  links: ColorOnlyLink[];
  icons: IconCandidate[];
  inversions: OrderInversion[];
  /** DOM-shape key for template sampling: landmark, heading, form, table and article counts. */
  shape: string;
}

/** Caps per page. Blocks, links and icons count only what is inside the screenshot. */
export const VISION_LIMITS = { blocks: 40, links: 20, icons: 20, elements: 5000, text: 80 } as const;

type Unnumbered<T> = Omit<T, 'n'>;
interface RawVisionFacts {
  viewport: { width: number; height: number };
  blocks: Unnumbered<VisionBlock>[];
  links: Unnumbered<ColorOnlyLink>[];
  icons: Unnumbered<IconCandidate>[];
  /** Indexes into `blocks`. */
  inversions: { first: number; second: number; how: OrderInversion['how'] }[];
  shape: string;
}

/** Runs inside the page. Self-contained: it is serialized into the browser. Scrolls to the top. */
function collectVisionFacts(limits: typeof VISION_LIMITS): RawVisionFacts {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const styles = new Map<Element, CSSStyleDeclaration>();
  const css = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const boxOf = (r: DOMRect): [number, number, number, number] => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const inView = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const visible = (el: Element) => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const s = css(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const bgUrl = (el: Element) => /url\(/i.test(css(el).backgroundImage);
  /** The picture file an element shows (img, image button, the first CSS background), as the picture checks name it. */
  const fileOf = (el: Element | null | undefined): string | undefined => {
    if (!el) return undefined;
    let u: string | undefined;
    if (el instanceof HTMLImageElement) u = el.currentSrc || el.src;
    else if (el instanceof HTMLInputElement && el.type === 'image') u = el.src;
    else u = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(css(el).backgroundImage)?.[2];
    return u && /^https?:/i.test(u) && u.length <= 2000 ? u : undefined;
  };
  const pseudoContent = (el: Element) =>
    ['::before', '::after'].some((p) => !/^(none|normal|""|'')$/.test(getComputedStyle(el, p).content));
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE']);
  const WORDS = /[\p{L}\p{N}]/u;
  const INTERACTIVE = 'a[href], button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], summary, [tabindex]:not([tabindex="-1"])';

  // The nearest ancestor (or self) that is not inline: the block a piece of text belongs to.
  const blockOf = new Map<Element, Element>();
  const nearestBlock = (el: Element): Element => {
    const path: Element[] = [];
    let e: Element | null = el;
    let found: Element = document.body;
    while (e && e !== document.body) {
      const cached = blockOf.get(e);
      if (cached) {
        found = cached;
        break;
      }
      path.push(e);
      const d = css(e).display;
      if (d !== 'inline' && d !== 'contents') {
        found = e;
        break;
      }
      e = e.parentElement;
    }
    for (const p of path) blockOf.set(p, found);
    return found;
  };

  const roleOf = (el: Element): string => {
    const explicit = clean(el.getAttribute('role'), 40).split(' ')[0];
    if (explicit === 'heading') return `heading ${el.getAttribute('aria-level') ?? '2'}`;
    if (explicit) return explicit;
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return `heading ${t[1]}`;
    if (t === 'input') return `field (${(el as HTMLInputElement).type})`;
    const map: Record<string, string> = {
      p: 'paragraph', li: 'list item', a: 'link', button: 'button', label: 'label', img: 'image', svg: 'graphic',
      select: 'field (select)', textarea: 'field (text area)', td: 'table cell', th: 'table header', caption: 'caption',
      figcaption: 'caption', blockquote: 'quote', legend: 'legend', summary: 'summary', dt: 'term', dd: 'definition',
      video: 'video', canvas: 'canvas', iframe: 'frame',
    };
    return map[t] ?? 'text';
  };

  // Text a sighted user sees inside `el` (skips visually hidden "screen reader only" text).
  const visibleText = (el: Element): string => {
    if (el instanceof HTMLInputElement) return /^(submit|button|reset)$/.test(el.type) ? el.value || el.type : '';
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !/\S/.test(node.nodeValue ?? '')) continue;
      const r = parent.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2 || !visible(parent)) continue;
      out += `${node.nodeValue} `;
    }
    return clean(out, 200);
  };

  // Approximate accessible name (accname 1.2 order, simplified).
  const nameFromContent = (el: Element, depth: number): string => {
    if (depth > 12) return '';
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const c = child as Element;
      if (c.getAttribute('aria-hidden') === 'true' || SKIP.has(c.tagName)) continue;
      const s = css(c);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const label = c.getAttribute('aria-label');
      if (label && label.trim()) out += ` ${label} `;
      else if (c.tagName === 'IMG') out += ` ${c.getAttribute('alt') ?? ''} `;
      else if (c.tagName.toLowerCase() === 'svg') out += ` ${c.querySelector('title')?.textContent ?? ''} `;
      else out += ` ${nameFromContent(c, depth + 1)} `;
    }
    return out;
  };
  const labelText = (node: Node, control: Element): string => {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        out += c.nodeValue ?? '';
        continue;
      }
      if (!(c instanceof Element) || c === control || SKIP.has(c.tagName)) continue;
      if (c.hasAttribute('hidden') || c.hasAttribute('inert') || c.getAttribute('aria-hidden') === 'true') continue;
      const st = css(c);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      out += ` ${labelText(c, control)} `;
    }
    return out;
  };
  const accName = (el: Element): { name: string; nameFrom: AccessibleNameSource } => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '), 150);
      if (t) return { name: t, nameFrom: 'aria-labelledby' };
    }
    const label = clean(el.getAttribute('aria-label'), 150);
    if (label) return { name: label, nameFrom: 'aria-label' };
    // A labelable control (button, input, select, textarea, ...) is named by its <label for> or wrapping <label>
    // before its content (accessible name computation; Grok r1: a labelled icon button was reported nameless).
    // An image button is named by its alt before any label (HTML-AAM: aria-labelledby, aria-label, alt, title).
    if (el instanceof HTMLInputElement && el.type === 'image' && clean(el.alt, 150)) return { name: clean(el.alt, 150), nameFrom: 'alt' };
    const labels = (el as Partial<HTMLButtonElement>).labels;
    if (labels && labels.length) {
      // Only the label text a screen reader reads: no hidden, aria-hidden, inert or display:none subtree, no script or
      // style, and not the labelled control itself (a wrapping label). Empty: fall through (Grok r2).
      const t = clean([...labels].map((l) => labelText(l, el)).join(' '), 150);
      if (t) return { name: t, nameFrom: 'label' };
    }
    if (el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type) && clean(el.value, 150)) return { name: clean(el.value, 150), nameFrom: 'value' };
    const content = clean(nameFromContent(el, 0), 150);
    if (content) return { name: content, nameFrom: 'content' };
    const title = clean(el.getAttribute('title'), 150);
    if (title) return { name: title, nameFrom: 'title' };
    return { name: '', nameFrom: 'none' };
  };

  // --- Blocks: every block that holds visible text, plus images, fields and CSS background images.
  const ownText = new Map<Element, string>();
  // Where a block's own text starts in the DOM: a block's number follows what a screen reader reads first. A
  // container whose own text comes after a child block (<a><h4>Phone</h4>(208) 555-0100</a>) is read after that
  // child, so it is ordered by its first own text node, not by its start tag (accuracy audit 2026-11-07: a phone
  // number listed before its heading made the visual review report a reversed label and value).
  const firstText = new Map<Element, Node>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node && seen < limits.elements; node = walker.nextNode()) {
    seen++;
    const parent = node.parentElement;
    if (!parent || SKIP.has(parent.tagName) || !/\S/.test(node.nodeValue ?? '')) continue;
    const block = nearestBlock(parent);
    if (block === document.body) continue;
    ownText.set(block, `${ownText.get(block) ?? ''}${node.nodeValue} `);
    // Only text a screen reader reads sets the order (Grok r1: an aria-hidden "#" before a heading; r2: inert text).
    if (!firstText.has(block) && !parent.closest('[aria-hidden="true"], [inert]') && visible(parent)) firstText.set(block, node);
  }
  const candidates = new Set<Element>(ownText.keys());
  for (const el of document.body.querySelectorAll('img, svg, video, canvas, iframe, input:not([type="hidden"]), select, textarea')) {
    if (el.parentElement?.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (/^(img|svg)$/i.test(el.tagName) && (r.width < 24 || r.height < 24)) continue;
    candidates.add(el);
  }
  const all = document.body.getElementsByTagName('*');
  const backgrounds: Element[] = [];
  for (let i = 0; i < all.length && i < limits.elements; i++) {
    const el = all[i]!;
    if (!SKIP.has(el.tagName) && bgUrl(el)) backgrounds.push(el);
  }
  for (const el of backgrounds) {
    const r = el.getBoundingClientRect();
    // Large backgrounds are blocks (they may carry information); small ones are icon candidates below.
    if (r.width > 64 || r.height > 64) candidates.add(el);
  }
  // Every block is numbered by its first read text (Grok r2: a background-image container too); a background-image block
  // is still never dropped by the cap (below).
  const readAt = (el: Element): Node => firstText.get(el) ?? el;
  const BACKGROUND_EXTRA = 10;
  const ordered = [...candidates].sort((a, b) => {
    if (a === b) return 0;
    const x = readAt(a);
    const y = readAt(b);
    if (x === y) return 0;
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  const blocks: RawVisionFacts['blocks'] = [];
  const blockEls: Element[] = [];
  const blockRects: DOMRect[] = [];
  // Past the cap only background-image blocks are added (they may carry information that is nowhere else; Grok r1), so
  // the list keeps the reading order and a trailing text node never costs a background its place.
  for (const el of ordered) {
    if (blocks.length >= limits.blocks + BACKGROUND_EXTRA) break;
    if (blocks.length >= limits.blocks && !bgUrl(el)) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r) || !visible(el)) continue;
    const bg = bgUrl(el);
    let text = clean(ownText.get(el), limits.text);
    if (el.tagName === 'IMG') text = clean(el.getAttribute('alt'), limits.text);
    else if (el instanceof HTMLInputElement && /^(submit|button|reset)$/.test(el.type)) text = clean(el.value, limits.text);
    else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = clean(el.placeholder, limits.text);
    else if (bg && !text) text = clean((el as HTMLElement).innerText, limits.text);
    const role = bg && !ownText.has(el) && !/^(IMG|INPUT|SELECT|TEXTAREA|VIDEO|CANVAS|IFRAME)$/.test(el.tagName) ? 'background image' : roleOf(el);
    const file = el.tagName === 'IMG' || el instanceof HTMLInputElement || bg ? fileOf(el) : undefined;
    blocks.push({ role, text, box: boxOf(r), ...(bg ? { backgroundImage: true as const } : {}), ...(file ? { file } : {}) });
    blockEls.push(el);
    blockRects.push(r);
  }

  // --- Reading order: consecutive blocks the screenshot shows in the opposite order.
  const inversions: RawVisionFacts['inversions'] = [];
  for (let i = 0; i + 1 < blockRects.length && inversions.length < 10; i++) {
    const a = blockRects[i]!;
    const b = blockRects[i + 1]!;
    if (blockEls[i]!.contains(blockEls[i + 1]!) || blockEls[i + 1]!.contains(blockEls[i]!)) continue;
    const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (hOverlap > 0 && b.bottom <= a.top) inversions.push({ first: i, second: i + 1, how: 'above' });
    else if (vOverlap > 0.5 * Math.min(a.height, b.height) && (rtl ? b.left >= a.right : b.right <= a.left)) {
      inversions.push({ first: i, second: i + 1, how: rtl ? 'right' : 'left' });
    }
  }

  // --- Links in running text that differ from the text around them only by color: `findColorOnlyLinks`,
  // run as its own step so the probes (src/probes/linkColor.ts) use the same rules.

  // --- Icons: controls with no visible words, then CSS-drawn icons (background images, icon fonts).
  const icons: RawVisionFacts['icons'] = [];
  const graphicOf = (el: Element, symbols: string): string | undefined => {
    if (el instanceof HTMLInputElement && el.type === 'image') return 'image button';
    if (el.querySelector('img')) return 'img';
    if (el.querySelector('svg') || el.tagName.toLowerCase() === 'svg') return 'svg';
    const parts = [el, ...[...el.querySelectorAll('*')].slice(0, 8)];
    if (parts.some(bgUrl)) return 'background image';
    if (parts.some((p) => p.childElementCount === 0 && pseudoContent(p))) return 'icon font';
    if (symbols) return `symbol ${JSON.stringify(symbols.slice(0, 8))}`;
    return undefined;
  };
  const nearby = (el: Element) => {
    const block = nearestBlock(el.parentElement ?? el);
    return block === document.body ? '' : clean((block as HTMLElement).innerText, limits.text);
  };
  const iconEls = new Set<Element>();
  const iconNodes: Element[] = [];
  const ICON_KEY = '__grntedVisionIcons';
  for (const el of document.body.querySelectorAll(INTERACTIVE)) {
    if (icons.length >= limits.icons) break;
    const r = el.getBoundingClientRect();
    if (!inView(r) || r.width < 8 || r.height < 8 || r.width > 96 || r.height > 96 || !visible(el)) continue;
    if (el.parentElement?.closest(INTERACTIVE)) continue;
    const words = visibleText(el);
    if (WORDS.test(words)) continue;
    const graphic = graphicOf(el, words);
    if (!graphic) continue;
    iconEls.add(el);
    const href = el instanceof HTMLAnchorElement ? el.href.slice(0, 200) : undefined;
    const iconFile = graphic === 'img' ? fileOf(el.querySelector('img')) : graphic === 'image button' ? fileOf(el) : graphic === 'background image' ? fileOf([el, ...el.querySelectorAll('*')].find(bgUrl)) : undefined;
    icons.push({ interactive: true, role: roleOf(el), ...accName(el), graphic, ...(href ? { href } : {}), nearbyText: nearby(el), box: boxOf(r), ...(iconFile ? { file: iconFile } : {}) });
    iconNodes.push(el);
  }
  const cssIcons = [...backgrounds, ...[...document.body.querySelectorAll('i:empty, span:empty')].filter(pseudoContent)];
  for (const el of cssIcons.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))) {
    if (icons.length >= limits.icons) break;
    if (el.closest(INTERACTIVE) || [...iconEls].some((i) => i.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (!inView(r) || r.width < 8 || r.height < 8 || r.width > 64 || r.height > 64 || !visible(el)) continue;
    if (WORDS.test(visibleText(el))) continue;
    icons.push({
      interactive: false, role: el.getAttribute('role') ?? 'none', ...accName(el), graphic: bgUrl(el) ? 'background image' : 'icon font',
      nearbyText: nearby(el), ...(el.closest('[aria-hidden="true"]') ? { hidden: true as const } : {}), box: boxOf(r),
      ...(bgUrl(el) && fileOf(el) ? { file: fileOf(el) } : {}),
    });
    iconNodes.push(el);
  }
  // The icon elements, in icon order, for the browser's accessible names (`browserIconNames`, over CDP).
  Object.defineProperty(window, ICON_KEY, { value: iconNodes, configurable: true, enumerable: false, writable: true });

  // --- DOM shape for template sampling. Counts are capped or bucketed so content length matters little.
  const count = (sel: string) => document.querySelectorAll(sel).length;
  const cap = (x: number, max: number) => (x >= max ? `${max}+` : String(x));
  const bucket = (x: number) => (x === 0 ? '0' : x === 1 ? '1' : x <= 3 ? '2-3' : x <= 7 ? '4-7' : x <= 15 ? '8-15' : '16+');
  const shape = [
    `header:${cap(count('header, [role="banner"]'), 2)}`,
    `nav:${cap(count('nav, [role="navigation"]'), 3)}`,
    `main:${cap(count('main, [role="main"]'), 2)}`,
    `aside:${cap(count('aside, [role="complementary"]'), 2)}`,
    `footer:${cap(count('footer, [role="contentinfo"]'), 2)}`,
    `form:${cap(count('form, [role="search"], [role="form"]'), 2)}`,
    `table:${cap(count('table'), 2)}`,
    `iframe:${cap(count('iframe'), 1)}`,
    `article:${cap(count('article'), 3)}`,
    `h1:${cap(count('h1'), 2)}`,
    `h2-6:${bucket(count('h2, h3, h4, h5, h6'))}`,
  ].join(' ');

  return { viewport: { width: vw, height: vh }, blocks, links: [], icons, inversions, shape };
}

/** Options for `findColorOnlyLinks`. */
export interface ColorOnlyLinkOptions {
  /** At most this many links. */
  links: number;
  /** Text length cap. */
  text: number;
  /** Only links inside the viewport (the vision screenshot); otherwise every visible link on the page. */
  inView: boolean;
  /**
   * Probes: keep the link elements in `window[key]` (`ref` is the index) and add the exact colours as
   * sRGB with alpha (`linkRgba`, `textRgba`), unrounded.
   */
  key?: string;
}

/** A colour-only link as found in the page; probes also get `ref` and the exact colours. */
export type FoundColorOnlyLink = Unnumbered<ColorOnlyLink> & {
  ref?: number;
  linkRgba?: [number, number, number, number];
  textRgba?: [number, number, number, number];
};

/**
 * Runs inside the page (self-contained). Links in running text whose only visible difference from
 * the text around them is their color: inline, in a block with at least 20 more characters of text,
 * no underline, border, shadow, outline, weight, style, family, size, case or background of their
 * own (or on a descendant), no image or pseudo-element content. Shared by the vision collector (in
 * view) and the 1.4.1 probe (the whole page).
 */
export function findColorOnlyLinks(o: ColorOnlyLinkOptions): FoundColorOnlyLink[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const styles = new Map<Element, CSSStyleDeclaration>();
  const css = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const boxOf = (r: DOMRect): [number, number, number, number] => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const inView = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const shown = (r: DOMRect) => r.width > 0 && r.height > 0;
  const visible = (el: Element) => {
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const s = css(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  const WORDS = /[\p{L}\p{N}]/u;
  const blockOf = new Map<Element, Element>();
  const nearestBlock = (el: Element): Element => {
    const path: Element[] = [];
    let e: Element | null = el;
    let found: Element = document.body;
    while (e && e !== document.body) {
      const cached = blockOf.get(e);
      if (cached) {
        found = cached;
        break;
      }
      path.push(e);
      const d = css(e).display;
      if (d !== 'inline' && d !== 'contents') {
        found = e;
        break;
      }
      e = e.parentElement;
    }
    for (const p of path) blockOf.set(p, found);
    return found;
  };
  const canvas = o.key ? document.createElement('canvas') : null;
  const g = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  const rgba = (c: string): [number, number, number, number] => {
    if (!g) return [0, 0, 0, 1];
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, Math.round((d[3]! / 255) * 1000) / 1000];
  };
  const store: Element[] = [];
  if (o.key) (window as unknown as Record<string, unknown>)[o.key] = store;
  // --- Links in running text that differ from the text around them only by color.
  // Batch 18, D11 (docs/atlas/visual.md): a cue counts only when it paints something. An underline, border or outline
  // in a see-through colour or in the colour behind the link, a shadow of no size or colour, and a background picture
  // sized to nothing at rest (an underline that only grows on hover) leave the link told apart by colour alone.
  const alphaOf = (c: string): number => {
    if (!c || c === 'transparent') return 0;
    const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/.exec(c);
    if (!m) return 1;
    const v = parseFloat(m[1]!);
    return m[2] ? v / 100 : v;
  };
  const backdropOf = (el: Element): string => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const bg = css(e).backgroundColor;
      if (alphaOf(bg) >= 0.5) return bg;
    }
    return 'rgb(255, 255, 255)';
  };
  const paints = (colour: string, back: string) => alphaOf(colour) > 0.1 && colour.replace(/\s/g, '') !== back.replace(/\s/g, '');
  const ZERO = /^-?0(\.0+)?(px|%|em|rem)?$/;
  const sizedToNothing = (sizes: string) => sizes.split(',').every((layer) => layer.trim().split(/\s+/).some((t) => ZERO.test(t)));
  const shadowPaints = (sh: string) => sh !== 'none' && sh.split(/,(?![^(]*\))/).some((part) => {
    const col = /(rgba?|color)\([^)]*\)/.exec(part);
    const lengths = (part.replace(/(rgba?|color)\([^)]*\)/g, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    return (col ? alphaOf(col[0]) > 0.1 : true) && lengths.some((v) => v !== 0);
  });
  const decorated = (s: CSSStyleDeclaration, p: CSSStyleDeclaration, el?: Element) => {
    const back = el ? backdropOf(el) : 'rgb(255, 255, 255)';
    return (s.textDecorationLine !== 'none' && s.textDecorationLine !== p.textDecorationLine && paints(s.textDecorationColor, back))
    || ['top', 'right', 'bottom', 'left'].some((side) => s.getPropertyValue(`border-${side}-style`) !== 'none' && s.getPropertyValue(`border-${side}-style`) !== 'hidden'
      && parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 && paints(s.getPropertyValue(`border-${side}-color`), back))
    || shadowPaints(s.boxShadow)
    || (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && paints(s.outlineColor, back))
    || Math.abs(Number(s.fontWeight) - Number(p.fontWeight)) >= 200
    || s.fontStyle !== p.fontStyle
    || s.fontFamily !== p.fontFamily
    || Math.abs(parseFloat(s.fontSize) - parseFloat(p.fontSize)) > 0.1 * parseFloat(p.fontSize)
    || s.textTransform !== p.textTransform
    || s.fontVariantCaps !== p.fontVariantCaps
    || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== p.backgroundColor && paints(s.backgroundColor, back))
    || (s.backgroundImage !== 'none' && !sizedToNothing(s.backgroundSize));
  };
  const channels = (c: string): number[] => {
    const m = c.match(/-?[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    return c.startsWith('color(') ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3);
  };
  const luminance = (c: string) => {
    const [r = 0, g = 0, b = 0] = channels(c).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (x: string, y: string) => {
    const [hi, lo] = [luminance(x), luminance(y)].sort((m, k) => k - m) as [number, number];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
  };
  // Batch 18, round 2: a cue drawn by the link's own ::before or ::after counts when it paints something at rest: text
  // or a symbol, or an empty box at least 4 px one way and 1 px the other (an icon drawn by a mask or a picture, a
  // drawn underline) filled, pictured or bordered in a colour that shows; never one scaled to nothing (an underline
  // that only grows on hover) or hidden.
  const pseudoPaints = (el: Element): boolean => ['::before', '::after'].some((pseudo) => {
    const ps = getComputedStyle(el, pseudo);
    if (/^(none|normal)$/.test(ps.content) || ps.display === 'none' || ps.visibility === 'hidden' || Number(ps.opacity) < 0.1) return false;
    if (!/^(""|'')$/.test(ps.content)) return true;
    const w = parseFloat(ps.width);
    const h = parseFloat(ps.height);
    if (!(Math.max(w, h) >= 4 && Math.min(w, h) >= 1)) return false;
    const t = ps.transform;
    if (t && t !== 'none') {
      const m = /matrix\(([^)]+)\)/.exec(t);
      const v = m ? m[1]!.split(',').map(Number) : [];
      if (v.length >= 4 && (Math.hypot(v[0]!, v[1]!) < 0.05 || Math.hypot(v[2]!, v[3]!) < 0.05)) return false;
    }
    // Batch 18, round 3: a pseudo-element cut away whole by clip-path (an inset() of 100% across, a circle or ellipse of
    // no size) or by clip: rect() of no area draws nothing at rest (an underline bar revealed only on hover).
    const len = (s: string, of: number) => (/%$/.test(s) ? (parseFloat(s) / 100) * of : parseFloat(s) || 0);
    const cp = ps.clipPath || 'none';
    const inset = /^inset\(([^)]*)\)/.exec(cp);
    if (inset) {
      const parts = inset[1]!.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
      const [t, r = t, b = t, l = r] = parts as [string, string?, string?, string?];
      if (len(t, h) + len(b!, h) >= h - 0.5 || len(l!, w) + len(r!, w) >= w - 0.5) return false;
    }
    if (/^(circle|ellipse)\(\s*0(px|%)?(\s|\)|at)/.test(cp)) return false;
    const clip = /^rect\(([^)]*)\)/.exec(ps.clip || '');
    if (clip && ps.position === 'absolute') {
      const [ct, cr, cb, cl] = clip[1]!.split(/[\s,]+/).map((x) => (x === 'auto' ? NaN : parseFloat(x)));
      if ([ct, cr, cb, cl].every((x) => Number.isFinite(x)) && (cr! - cl! <= 0 || cb! - ct! <= 0)) return false;
    }
    const back = backdropOf(el);
    return paints(ps.backgroundColor, back) || ps.backgroundImage !== 'none'
      || ['top', 'right', 'bottom', 'left'].some((side) => !/^(none|hidden)$/.test(ps.getPropertyValue(`border-${side}-style`))
        && parseFloat(ps.getPropertyValue(`border-${side}-width`)) > 0 && paints(ps.getPropertyValue(`border-${side}-color`), back));
  });
  // Links in open shadow roots too (batch 18, round 2: a web component's text is the page's text).
  const deepLinks = (): Element[] => {
    const out: Element[] = [];
    const visit = (root: Document | ShadowRoot | Element, depth: number) => {
      out.push(...Array.from(root.querySelectorAll('a[href]')));
      if (depth > 6) return;
      for (const h of Array.from(root.querySelectorAll('*'))) if (h.shadowRoot) visit(h.shadowRoot, depth + 1);
    };
    visit(document.body, 0);
    return out;
  };
  const links: FoundColorOnlyLink[] = [];
  const contexts = new Map<Element, string>();
  /** Characters of each block's text outside its links. */
  const plainText = new Map<Element, number>();
  let scanned = 0;
  for (const a of deepLinks()) {
    // Huge pages: the first 3000 links are enough (each costs a style and layout read).
    if (links.length >= o.links || ++scanned > 3000) break;
    const r = a.getBoundingClientRect();
    if (!(o.inView ? inView(r) : shown(r)) || !visible(a) || css(a).display !== 'inline' || !a.parentElement) continue;
    const block = nearestBlock(a);
    if (block === document.body || block === a) continue;
    const linkText = clean((a as HTMLElement).innerText, 200);
    let context = contexts.get(block);
    if (context === undefined) contexts.set(block, (context = clean((block as HTMLElement).innerText, 300)));
    // Running text is text outside links (batch 18, Sol r1 L3): a list of links set inline (a short navigation) has none.
    let outside = plainText.get(block);
    if (outside === undefined) {
      let linked = 0;
      for (const l of Array.from(block.querySelectorAll('a[href]'))) linked += clean((l as HTMLElement).innerText, 300).length;
      plainText.set(block, (outside = Math.max(0, clean((block as HTMLElement).innerText, 2000).length - linked)));
    }
    if (!WORDS.test(linkText) || context.length - linkText.length < 20 || outside < 20) continue;
    const s = css(a);
    const p = css(a.parentElement);
    if (s.color === p.color) continue;
    if (a.querySelector('img, svg') || pseudoPaints(a) || decorated(s, p, a.parentElement)) continue;
    if ([...a.querySelectorAll('*')].slice(0, 10).some((d) => decorated(css(d), p, a) || pseudoPaints(d))) continue;
    links.push({
      text: clean(linkText, o.text), href: (a as HTMLAnchorElement).href.slice(0, 200), context: clean(context, 200),
      linkColor: s.color, textColor: p.color, contrastWithText: contrast(s.color, p.color), box: boxOf(r),
      ...(o.key ? { ref: store.push(a) - 1, linkRgba: rgba(s.color), textRgba: rgba(p.color) } : {}),
    });
  }

  return links;
}

/** Numbers the facts (blocks, then links, then icons) so the model can refer to each one. */
export function numberFacts(raw: RawVisionFacts): Omit<VisionFacts, 'screenshot' | 'screenshotError'> {
  let n = 0;
  const blocks = raw.blocks.map((b) => ({ n: ++n, ...b }));
  const links = raw.links.map((l) => ({ n: ++n, ...l }));
  const icons = raw.icons.map((i) => ({ n: ++n, ...i }));
  const inversions = raw.inversions.flatMap(({ first, second, how }) => {
    const a = blocks[first];
    const b = blocks[second];
    return a && b ? [{ domFirst: a.n, shownFirst: b.n, how }] : [];
  });
  return { viewport: raw.viewport, blocks, links, icons, inversions, shape: raw.shape };
}

/**
 * Pages (in scan order) the collector runs on. The vision check samples templates from the start
 * of the scan order, and a screenshot costs about 50–100 ms per page on a quiet machine but
 * 250–300 ms (p90 500–800 ms) while a 25-page scan loads 12 pages at once on 4 cores, so pages
 * after these are skipped. Measured 2026-10-31; see Plan 3, Task 5.
 */
export const VISION_SCREENSHOT_PAGES = 10;

/**
 * Desktop only: one image per page keeps each vision call within its budget, and the desktop layout
 * is where columns, grids and icon toolbars reorder or hide meaning. The screenshot is the viewport
 * at the top of the page (not the full page), JPEG quality 70: about 30–150 KB. Returns null (no
 * work at all) for pages at or after VISION_SCREENSHOT_PAGES in the scan order.
 */
/** Time box for asking the browser for the icons' accessible names (every icon together). */
export const ICON_NAMES_MS = 2000;

/** Opens a CDP session from the collector's factory, runs `fn`, detaches; undefined when there is no session. */
async function withSession<T>(open: (() => Promise<CDPSessionLike>) | undefined, fn: (s: CDPSessionLike) => Promise<T>): Promise<T | undefined> {
  if (!open) return undefined;
  let session: CDPSessionLike | undefined;
  try {
    session = await open();
    return await fn(session);
  } catch {
    return undefined;
  } finally {
    await session?.detach?.().catch(() => undefined);
  }
}

type AxNode = { ignored?: boolean; ignoredReasons?: { name: string }[]; name?: { value?: unknown } };

/**
 * The browser's computed accessible name of each icon the page-side collection listed (in its order, from the
 * element list it left in the page), through CDP: Runtime.evaluate for the list, Runtime.getProperties for each
 * element, Accessibility.getPartialAXTree for its node. A name the browser computes is the accessible name (Sol r3
 * ruling 1: our own name code leaked a new edge case every round). An element the accessibility tree ignores has no
 * name (''). An entry is undefined when the browser did not answer within `ms`; such an icon's name is never proof.
 */
/**
 * Whether a name gives screen readers anything to say: an icon font's private-use glyph (U+F082), zero-width and other
 * format characters, spaces and punctuation alone do not (lead ruling 11-07; symbols such as a star are spoken).
 */
export const speakableName = (name: string): boolean => name.replace(/[\p{Co}\p{Cf}\p{Z}\p{P}\s]/gu, '').length > 0;

/**
 * CDP ignoredReasons that mean the node is not exposed to assistive technology at all, so its name is truly empty:
 * aria-hidden, inert, a presentational role, or "uninteresting" (a box with nothing for screen readers, such as an icon
 * drawn as a CSS background). "notRendered" and other reasons are not proof either way.
 */
const HIDDEN_FROM_AT = new Set(['ariaHiddenElement', 'ariaHiddenSubtree', 'inertElement', 'inertSubtree', 'presentationalRole', 'uninteresting']);

/** The prompt shows at most this much of an icon's name; the judgement uses all of it. */
const ICON_NAME_SHOWN = 150;

export async function browserIconNames(cdp: CDPSessionLike, count: number, ms: number): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = new Array(count).fill(undefined);
  if (!count) return out;
  const group = 'grnted-vision-icons';
  const work = (async () => {
    await cdp.send('Accessibility.enable').catch(() => undefined);
    const list = (await cdp.send('Runtime.evaluate', { expression: 'window.__grntedVisionIcons', objectGroup: group })) as { result?: { objectId?: string } };
    const listId = list.result?.objectId;
    if (!listId) return;
    const props = (await cdp.send('Runtime.getProperties', { objectId: listId, ownProperties: true })) as { result?: { name: string; value?: { objectId?: string } }[] };
    for (const prop of props.result ?? []) {
      const i = Number(prop.name);
      const objectId = prop.value?.objectId;
      if (!Number.isInteger(i) || i < 0 || i >= count || !objectId) continue;
      const tree = (await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false })) as { nodes?: AxNode[] };
      const node = tree.nodes?.[0];
      if (!node) continue;
      // Only an explicit computed string is the browser's answer (Sol r4 #2). A node ignored because it is hidden from
      // assistive technology (aria-hidden, inert, a presentational role) really has no name: ''. Any other ignored node
      // (not rendered, …) or a name missing or malformed in the answer says nothing: it stays unknown, never proof.
      const hiddenFromAt = node.ignored && (node.ignoredReasons ?? []).some((r) => HIDDEN_FROM_AT.has(r.name));
      const name = hiddenFromAt ? '' : node.ignored ? undefined : node.name?.value;
      if (typeof name === 'string') out[i] = name.replace(/\s+/g, ' ').trim();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  await Promise.race([work.catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(() => { timedOut = true; r(); }, Math.max(0, ms)); })]);
  clearTimeout(timer);
  // A late answer must not fill names in after the time box: an icon the browser did not name in time stays unknown.
  const result = timedOut ? new Array<string | undefined>(count).fill(undefined) : out;
  void cdp.send('Runtime.evaluate', { expression: 'delete window.__grntedVisionIcons' }).catch(() => undefined);
  void cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
  return result;
}

/** The icons with the browser's names: verified where the browser answered, the page-side name (unverified) elsewhere. */
function withBrowserNames<T extends Omit<IconCandidate, 'n'>>(icons: T[], names: (string | undefined)[] | undefined): T[] {
  return icons.map((icon, i) => {
    const name = names?.[i];
    if (name === undefined) return { ...icon, nameVerified: false };
    const shown = name.slice(0, ICON_NAME_SHOWN);
    return { ...icon, name: shown, nameFrom: name === icon.name ? icon.nameFrom : name ? 'browser' : 'none', nameVerified: true, nameSpeakable: speakableName(name) };
  });
}

export const visionCollector: PageCollector<VisionFacts | null> = {
  id: 'vision',
  viewport: 'desktop',
  timeoutMs: 8000,
  async collect(page, { index, cdp }) {
    if (index !== undefined && index >= VISION_SCREENSHOT_PAGES) return null;
    const raw = await page.evaluate(collectVisionFacts, VISION_LIMITS);
    const names = await withSession(cdp, (s) => browserIconNames(s, raw.icons.length, ICON_NAMES_MS));
    const links = await page.evaluate(findColorOnlyLinks, { links: VISION_LIMITS.links, text: VISION_LIMITS.text, inView: true });
    const facts = numberFacts({ ...raw, icons: withBrowserNames(raw.icons, names), links });
    try {
      const shot = await page.screenshot({ type: 'jpeg', quality: 70 });
      // A plain Uint8Array view (Playwright returns a Node Buffer), so nothing Node-specific leaks out.
      return { ...facts, screenshot: new Uint8Array(shot.buffer, shot.byteOffset, shot.byteLength) };
    } catch (err) {
      return { ...facts, screenshotError: err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'Screenshot failed' };
    }
  },
};

/** Base64 to bytes (engine core: no Node Buffer). */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The vision facts (blocks, icons, links and the screenshot) read through a CDP session rather than through
 * Playwright: Runtime.evaluate and Page.captureScreenshot still answer while the page's script is paused in the
 * debugger, which is how the screen-reader pass takes them at the same moment as the accessibility tree (a carousel
 * cannot move between the two). Each call is bounded by `ms`; undefined when any part fails.
 */
export async function visionFactsVia(cdp: CDPSessionLike, ms: number): Promise<VisionFacts | undefined> {
  const bounded = <T>(p: Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(0, ms)); });
    return Promise.race([p.catch(() => undefined), limit]).finally(() => clearTimeout(timer));
  };
  const value = async <T>(fn: (arg: never) => T, arg: unknown): Promise<T | undefined> => {
    const r = (await bounded(cdp.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, returnByValue: true }))) as { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    return r && !r.exceptionDetails ? r.result?.value : undefined;
  };
  const raw = await value(collectVisionFacts as (a: never) => RawVisionFacts, VISION_LIMITS);
  if (!raw) return undefined;
  const names = await browserIconNames(cdp, raw.icons.length, Math.min(ms, ICON_NAMES_MS));
  const links = (await value(findColorOnlyLinks as (a: never) => FoundColorOnlyLink[], { links: VISION_LIMITS.links, text: VISION_LIMITS.text, inView: true })) ?? [];
  const facts = numberFacts({ ...raw, icons: withBrowserNames(raw.icons, names), links });
  const shot = (await bounded(cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }))) as { data?: string } | undefined;
  if (!shot?.data) return { ...facts, screenshotError: 'Screenshot failed' };
  return { ...facts, screenshot: fromBase64(shot.data) };
}
