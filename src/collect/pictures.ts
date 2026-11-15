// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The picture inventory (batch 18, lane images; docs/atlas/images.md section 10, G1-G13): every picture on the page by
// any technique, with what assistive technology is given for it and the context around it, for the AI review. Neutral
// data only: it says what is there, never whether anything fails. It reads the page and changes nothing on it (crops
// are screenshots of regions; nothing is clicked, typed or scrolled except to take them).
//
// What it reads (G1): `img` (with every `<source>` and `srcset` candidate and its media condition, G12), image buttons,
// `role="img"` elements, inline `svg`, `canvas`, `object`/`embed`/`iframe` whose file is a picture, image-map `area`s,
// CSS background and mask pictures on any element, pseudo-element `content: url()` pictures, and icon-font glyphs
// (private-use characters drawn by generated content); in open shadow roots and same-origin frames too (G2); hidden
// from assistive technology or not shown yet included, marked so (G3, G4). For each: the browser's computed name,
// description and role (G5, through CDP; the page-side reading is kept apart and marked unverified), a crop as painted
// (G6, capped) and the same region drawn larger, what zooming in can reveal of its file (the lead's ruling, 2026-11-13),
// the real text drawn over it (G7), the control and form it sits in (G8), the links next to it (G9).
// Also the page's links to image files, which a site uses as documents (G10). Engine core: no Node-only or AI imports.
// No AI-off scan runs it: it is in COLLECTORS (asked for by an AI plan), never in DEFAULT_COLLECTORS.
import type { CDPSessionLike, PageCollector } from '../types.js';

/** How a picture is put on the page. */
export type PictureTechnique =
  | 'img' | 'input-image' | 'role-img' | 'svg' | 'canvas' | 'object' | 'embed' | 'frame-image' | 'area'
  | 'background' | 'mask' | 'pseudo' | 'icon-glyph';

/** One candidate file of an `img` (a `srcset` entry or a `<source>`), with the condition the page gives for it. */
export interface PictureSource {
  url: string;
  /** The `<source>`'s media query, or its type. */
  media?: string;
  type?: string;
  /** The srcset descriptor ("2x", "640w"). */
  descriptor?: string;
}

/** [x, y, width, height], CSS px, in the page's coordinates (scrolled to the top). */
export type PictureBox = [number, number, number, number];

export interface PictureFact {
  /** Its number on the page (crops and names refer to it). */
  n: number;
  technique: PictureTechnique;
  /** CSS path, parts joined by ' >>> ' across shadow roots; a same-origin frame's pictures are prefixed by the frame's path and ' |frame| '. */
  target: string;
  /** The address of the same-origin frame it is in, when it is in one. */
  frame?: string;
  /** The file it shows, absolute (the browser's current choice for an `img`); absent for a drawing with no file. */
  file?: string;
  /** Every candidate file of an `img` and its `<picture>` sources. */
  sources?: PictureSource[];
  /** The alt attribute exactly: null when there is none (`img`, image buttons, areas). */
  alt?: string | null;
  /** The naming attributes as written (page-side; the browser's own name is `name`). */
  ariaLabel?: string;
  labelledBy?: string;
  title?: string;
  describedBy?: string;
  /** An inline svg's own `<title>` and `<desc>`; a canvas's or object's fallback content. */
  svgTitle?: string;
  svgDesc?: string;
  fallback?: string;
  /** The browser's computed role, name and description (CDP); `nameVerified` false when the browser did not answer. */
  role?: string;
  name?: string;
  description?: string;
  nameVerified: boolean;
  /** How it is kept from assistive technology, when it is: 'aria-hidden', 'aria-hidden ancestor', 'presentation role', 'inert'. */
  hidden?: string;
  /** Rendered with a box and visible as the page is now (false: a closed tab, a later slide, a lightbox target). */
  shown: boolean;
  box?: PictureBox;
  /** The file's own size as the browser decoded it (`img`), or a canvas's own pixel size. */
  natural?: [number, number];
  /** An icon glyph's character (as a code point, U+XXXX). */
  glyph?: string;
  /** An image map's areas (an `img` with `usemap`): each area's alt as written (null: none) and destination, at most 30. */
  mapAreas?: { alt: string | null; href?: string }[];
  /** The control it is in or is: its role, its text as shown, its destination. The browser's name is `controlName`. */
  control?: { role: string; text: string; href?: string };
  controlName?: string;
  /** For a picture in a form: the form's other controls (page-side names, unverified) and its frames' hosts. */
  form?: { controls: { role: string; name: string }[]; frames: string[] };
  caption?: string;
  /** The text around it, closest first, up to its section (at most 1,500 characters), and the heading of that section. */
  nearbyText?: string;
  sectionHeading?: string;
  /** The links right before and after it in reading order (text and destination). */
  linksNear?: { text: string; href: string; where: 'before' | 'after' }[];
  /** Real text drawn over it (DOM text at points inside its box, above it), and a background element's own text. */
  textOver?: string;
  ownText?: string;
  /** A crop of its box as painted (JPEG), or why there is none. Only `collected`, never the report. */
  crop?: Uint8Array;
  cropError?: string;
  /**
   * The same painted region drawn larger (JPEG, `zoomScale` image pixels per CSS pixel): what zooming in can reveal of
   * the picture's own file inside the region the page shows, never anything the page crops away. Taken through CDP
   * (`Page.captureScreenshot` with a clip scale: the browser draws the region again from the decoded file; no request).
   * Absent with `zoomNote` saying why: 'not finer' (the file holds no finer detail than shown), 'large' (the crop is
   * already as large as a view is taken), 'time', 'no session' (no CDP), 'failed'. Only `collected`, never the report.
   */
  zoom?: Uint8Array;
  zoomScale?: number;
  zoomNote?: ZoomNote;
}

/** Why a cropped picture has no zoomed view. */
export type ZoomNote = 'not finer' | 'large' | 'time' | 'no session' | 'failed';

/** A link whose target is an image file (a flyer linked as a document; G10). Found by its address: the review sniffs it. */
export interface ImageDocumentLink {
  href: string;
  text: string;
  nearbyText: string;
}

export interface PicturesFacts {
  pictures: PictureFact[];
  imageDocuments: ImageDocumentLink[];
  /** More pictures than `PICTURES_LIMITS.pictures`, or more elements than `elements`: the rest are not listed. */
  cut: boolean;
}

export const PICTURES_LIMITS = {
  /** Pictures listed per page, shown ones first; elements whose style is read; image-file links. */
  pictures: 300,
  elements: 8_000,
  documents: 40,
  /** Characters of nearby text, and of any other text field. */
  nearby: 1_500,
  text: 300,
  /** Crops per page (largest shown first, one per file and size), the smallest side cropped, and the time for all of them. */
  crops: 24,
  cropMin: 16,
  cropMax: 2_000,
  cropMs: 6_000,
  /**
   * Zoomed views of the cropped pictures: at most `zoomMax` times (a user zooming to 300%), at most `zoomPx` image
   * pixels on the longer side (a larger view is scaled down by the reviewing model anyway), none below `zoomMin` (too
   * little to gain), and the time for all of them (after the crops).
   */
  zoomMax: 3,
  zoomMin: 1.25,
  zoomPx: 2_048,
  zoomMs: 3_000,
  /** Time for the browser's names, in all. */
  namesMs: 3_000,
} as const;

type RawPicture = Omit<PictureFact, 'n' | 'nameVerified' | 'crop' | 'cropError' | 'zoom' | 'zoomScale' | 'zoomNote' | 'role' | 'name' | 'description' | 'controlName'>;

/** Runs inside the page (self-contained). Leaves the pictures' elements (and their controls) on `window[key]` for CDP. */
export function collectPictures(o: typeof PICTURES_LIMITS & { key: string }): { pictures: RawPicture[]; imageDocuments: ImageDocumentLink[]; cut: boolean } {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  const clean = (s: string | null | undefined, max: number = o.text) => (s ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|svgz?|bmp|tiff?|avif|heic|ico)(?:[?#]|$)/i;
  const PUA = /^[-]$|^[\u{F0000}-\u{FFFFD}]$|^[\u{100000}-\u{10FFFD}]$/u;
  const CONTROL = 'a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"]';
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const SECTION = 'section, article, main, aside, li, td, th, dialog, body';
  const out: (RawPicture & { el: Element })[] = [];
  const docs: ImageDocumentLink[] = [];
  let cut = false;
  let seenElements = 0;

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
  const abs = (u: string | null | undefined, base: string): string | undefined => {
    const v = (u ?? '').trim();
    if (!v) return undefined;
    try { return new URL(v, base).href; } catch { return undefined; }
  };
  const textOfIds = (el: Element, attr: string) => {
    const ids = (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean);
    if (!ids.length) return undefined;
    const root = el.getRootNode() as Document | ShadowRoot;
    return clean(ids.map((id) => (root.getElementById?.(id) ?? el.ownerDocument.getElementById(id))?.textContent ?? '').join(' ')) || undefined;
  };
  const hiddenHow = (el: Element): string | undefined => {
    if (el.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
    if (/^(presentation|none)$/.test((el.getAttribute('role') ?? '').trim())) return 'presentation role';
    for (let a: Element | null = el.parentElement; a; a = a.parentElement) {
      if (a.getAttribute('aria-hidden') === 'true') return 'aria-hidden ancestor';
      if (a.hasAttribute('inert')) return 'inert';
    }
    if (el.hasAttribute('inert')) return 'inert';
    return undefined;
  };
  const boxOf = (el: Element, dx: number, dy: number): PictureBox | undefined => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return undefined;
    return [Math.round(r.left + dx + window.scrollX), Math.round(r.top + dy + window.scrollY), Math.round(r.width), Math.round(r.height)];
  };
  const visible = (el: Element) => {
    const c = el as Element & { checkVisibility?: (x: object) => boolean };
    return typeof c.checkVisibility === 'function' ? c.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true;
  };
  const visibleText = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const el = n as HTMLElement;
    if (/^(script|style|template|noscript)$/.test(el.localName) || !visible(el)) return '';
    return el.innerText ?? '';
  };
  /** The text around the element, closest first, up to its section (the image collector's walk), and that section's heading. */
  const context = (el: Element): { nearbyText?: string; sectionHeading?: string } => {
    const parts: string[] = [];
    let left = o.nearby;
    let heading: string | undefined;
    let cur: Element = el;
    for (let i = 0; i < 40 && left > 0; i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      let prev = cur.previousSibling;
      let next = cur.nextSibling;
      while ((prev || next) && left > 0) {
        if (next) { const t = clean(visibleText(next), left); if (t) { parts.push(t); left -= t.length + 1; } next = next.nextSibling; }
        if (prev) {
          if (!heading && prev.nodeType === Node.ELEMENT_NODE) {
            const p = prev as Element;
            const h = p.matches(HEADING) ? p : [...p.querySelectorAll(HEADING)].pop();
            if (h) heading = clean(h.textContent);
          }
          const t = clean(visibleText(prev), left); if (t) { parts.push(t); left -= t.length + 1; }
          prev = prev.previousSibling;
        }
      }
      if (parent.matches(SECTION)) break;
      cur = parent;
    }
    const nearbyText = clean(parts.join(' '), o.nearby);
    return { ...(nearbyText ? { nearbyText } : {}), ...(heading ? { sectionHeading: heading } : {}) };
  };
  /** The links right before and after the element in document order, outside the control it is in. */
  const linksNear = (el: Element, control: Element | null): PictureFact['linksNear'] => {
    const doc = el.ownerDocument;
    const all = [...doc.querySelectorAll('a[href]')] as HTMLAnchorElement[];
    const anchor = control ?? el;
    let before: HTMLAnchorElement | undefined;
    let after: HTMLAnchorElement | undefined;
    for (const a of all) {
      if (a === control || a.contains(el)) continue;
      const pos = anchor.compareDocumentPosition(a);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) before = a;
      else if (pos & Node.DOCUMENT_POSITION_FOLLOWING && !after) { after = a; break; }
    }
    const list: NonNullable<PictureFact['linksNear']> = [];
    if (before) list.push({ text: clean(before.innerText || before.getAttribute('aria-label')), href: before.href, where: 'before' });
    if (after) list.push({ text: clean(after.innerText || after.getAttribute('aria-label')), href: after.href, where: 'after' });
    return list.length ? list : undefined;
  };
  const controlOf = (el: Element): { el: Element; fact: NonNullable<PictureFact['control']> } | undefined => {
    const c = el.matches(CONTROL) ? el : el.closest(CONTROL);
    if (!c) return undefined;
    const role = (c.getAttribute('role') ?? '').trim() || (c.localName === 'a' ? 'link' : c.localName);
    const href = (c as HTMLAnchorElement).href || undefined;
    return { el: c, fact: { role, text: clean((c as HTMLElement).innerText), ...(href ? { href } : {}) } };
  };
  const formOf = (el: Element): PictureFact['form'] => {
    const f = el.closest('form');
    if (!f) return undefined;
    const controls = [...f.querySelectorAll('input:not([type="hidden"]), select, textarea, button, a[href], [role="button"]')].slice(0, 20).map((c) => {
      const lab = (c as HTMLInputElement).labels?.[0]?.textContent;
      const role = (c.getAttribute('role') ?? '').trim() || (c.localName === 'input' ? `input ${(c.getAttribute('type') ?? 'text').toLowerCase()}` : c.localName === 'a' ? 'link' : c.localName);
      const name = clean(c.getAttribute('aria-label') || lab || (c as HTMLElement).innerText || (c as HTMLInputElement).value || c.getAttribute('title') || c.getAttribute('alt') || c.getAttribute('placeholder'), 120);
      return { role, name };
    });
    const frames = [...f.querySelectorAll('iframe')].slice(0, 10).map((fr) => { try { return new URL((fr as HTMLIFrameElement).src, el.ownerDocument.baseURI).host; } catch { return ''; } }).filter(Boolean);
    return { controls, frames };
  };
  /**
   * Real text laid out over the picture: the text nodes of its container (three levels up; a background's own element
   * included) whose boxes intersect the picture's box, shown, at most 400 nodes read. Layout only: no hit testing, so a
   * picture anywhere on the page is read the same way.
   */
  const textOver = (el: Element): string | undefined => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return undefined;
    let container: Element = el;
    for (let i = 0; i < 3 && container.parentElement && !/^(body|html)$/.test(container.parentElement.localName); i++) container = container.parentElement;
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const words: string[] = [];
    let k = 0;
    for (let n = walker.nextNode(); n && k < 400; n = walker.nextNode(), k++) {
      const t = (n.nodeValue ?? '').trim();
      const parent = n.parentElement;
      if (!t || !parent || /^(script|style|template|noscript|title|desc)$/.test(parent.localName) || !visible(parent)) continue;
      const range = doc.createRange();
      range.selectNodeContents(n);
      const hit = [...range.getClientRects()].some((q) => q.width > 0 && q.height > 0 && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top);
      if (hit) words.push(clean(t, 200));
    }
    const out = clean(words.join(' · '));
    return out || undefined;
  };
  const parseSrcset = (v: string | null, base: string, media?: string, type?: string): PictureSource[] => (v ?? '').split(/,\s+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const [u, d] = part.split(/\s+/);
    const url = abs(u, base);
    return url ? { url, ...(media ? { media } : {}), ...(type ? { type } : {}), ...(d ? { descriptor: d } : {}) } : undefined;
  }).filter((x): x is PictureSource => !!x);
  const bgUrls = (v: string, base: string): string[] => [...v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((m) => abs(m[2], base)).filter((x): x is string => !!x);

  const add = (el: Element, p: Omit<RawPicture, 'target' | 'shown' | 'hidden'> & { shown?: boolean }, dx: number, dy: number, frame?: string, framePath?: string) => {
    if (out.length >= o.pictures) { cut = true; return; }
    const box = boxOf(el, dx, dy);
    const shown = p.shown ?? (!!box && visible(el));
    const c = controlOf(el);
    const caption = clean(el.closest('figure')?.querySelector('figcaption')?.textContent) || undefined;
    const hidden = hiddenHow(el);
    out.push({
      ...p, el,
      target: framePath ? `${framePath} |frame| ${cssPath(el)}` : cssPath(el),
      ...(frame ? { frame } : {}),
      shown,
      ...(box ? { box } : {}),
      ...(hidden ? { hidden } : {}),
      ...(el.getAttribute('aria-label')?.trim() ? { ariaLabel: clean(el.getAttribute('aria-label')) } : {}),
      ...(textOfIds(el, 'aria-labelledby') ? { labelledBy: textOfIds(el, 'aria-labelledby') } : {}),
      ...(el.getAttribute('title')?.trim() ? { title: clean(el.getAttribute('title')) } : {}),
      ...(textOfIds(el, 'aria-describedby') || textOfIds(el, 'aria-details') ? { describedBy: clean(`${textOfIds(el, 'aria-describedby') ?? ''} ${textOfIds(el, 'aria-details') ?? ''}`) } : {}),
      ...(c ? { control: c.fact } : {}),
      ...(formOf(el) ? { form: formOf(el) } : {}),
      ...(caption ? { caption } : {}),
      ...context(el),
      ...(linksNear(el, c?.el ?? null) ? { linksNear: linksNear(el, c?.el ?? null) } : {}),
      ...(shown && textOver(el) ? { textOver: textOver(el) } : {}),
    });
  };

  /** One document or shadow root, and the open shadow roots and same-origin frames inside it. */
  const walk = (root: Document | ShadowRoot, dx: number, dy: number, frame?: string, framePath?: string) => {
    // A frame's document is another realm's Document: tell it by its node type, never by instanceof.
    const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root as ShadowRoot).ownerDocument;
    const base = doc.baseURI;
    const win = doc.defaultView ?? window;
    for (const el of root.querySelectorAll('*')) {
      if (++seenElements > o.elements) { cut = true; return; }
      const name = el.localName;
      if (/^(script|style|template|noscript|head|title|meta|link)$/.test(name)) continue;
      if (name !== 'svg' && el.closest('svg')) continue;
      if (name === 'img') {
        const img = el as HTMLImageElement;
        const pic = img.parentElement?.localName === 'picture' ? img.parentElement : null;
        const sources = [
          ...(pic ? [...pic.querySelectorAll('source')].flatMap((s) => parseSrcset(s.getAttribute('srcset'), base, s.getAttribute('media') ?? undefined, s.getAttribute('type') ?? undefined)) : []),
          ...parseSrcset(img.getAttribute('srcset'), base),
          ...(abs(img.getAttribute('src'), base) ? [{ url: abs(img.getAttribute('src'), base)! }] : []),
        ];
        const mapName = (img.getAttribute('usemap') ?? '').trim().replace(/^#/, '');
        const map = mapName ? [...(img.getRootNode() as Document | ShadowRoot).querySelectorAll('map')].find((m) => m.getAttribute('name') === mapName || m.id === mapName) : undefined;
        const mapAreas = map ? [...map.querySelectorAll('area')].slice(0, 30).map((a) => ({ alt: a.hasAttribute('alt') ? clean(a.getAttribute('alt')) : null, ...((a as HTMLAreaElement).href ? { href: (a as HTMLAreaElement).href } : {}) })) : [];
        add(el, {
          technique: 'img', file: img.currentSrc || abs(img.getAttribute('src'), base), ...(sources.length > 1 ? { sources } : {}),
          alt: img.getAttribute('alt'), ...(img.naturalWidth ? { natural: [img.naturalWidth, img.naturalHeight] as [number, number] } : {}),
          ...(mapAreas.length ? { mapAreas } : {}),
        }, dx, dy, frame, framePath);
      } else if (name === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'image') {
        add(el, { technique: 'input-image', file: abs(el.getAttribute('src'), base), alt: el.getAttribute('alt') }, dx, dy, frame, framePath);
      } else if (name === 'area') {
        add(el, { technique: 'area', alt: el.getAttribute('alt'), shown: false }, dx, dy, frame, framePath);
      } else if (name === 'svg') {
        // A sprite sheet (only defs and symbols) draws nothing of its own.
        if ([...el.children].every((c) => /^(defs|symbol|title|desc|style)$/.test(c.localName))) continue;
        const title = [...el.children].find((c) => c.localName === 'title');
        const desc = [...el.children].find((c) => c.localName === 'desc');
        add(el, { technique: 'svg', ...(title ? { svgTitle: clean(title.textContent) } : {}), ...(desc ? { svgDesc: clean(desc.textContent) } : {}) }, dx, dy, frame, framePath);
      } else if (name === 'canvas') {
        const cv = el as HTMLCanvasElement;
        add(el, { technique: 'canvas', ...(clean(el.textContent) ? { fallback: clean(el.textContent) } : {}), ...(cv.width && cv.height ? { natural: [cv.width, cv.height] as [number, number] } : {}) }, dx, dy, frame, framePath);
      } else if ((name === 'object' || name === 'embed') && IMAGE_FILE.test(el.getAttribute(name === 'object' ? 'data' : 'src') ?? '')) {
        const file = abs(el.getAttribute(name === 'object' ? 'data' : 'src'), base);
        add(el, { technique: name, ...(file ? { file } : {}), ...(name === 'object' && clean(el.textContent) ? { fallback: clean(el.textContent) } : {}) }, dx, dy, frame, framePath);
      } else if (name === 'iframe' && IMAGE_FILE.test(el.getAttribute('src') ?? '')) {
        add(el, { technique: 'frame-image', file: abs(el.getAttribute('src'), base) }, dx, dy, frame, framePath);
      } else if ((el.getAttribute('role') ?? '').trim() === 'img') {
        add(el, { technique: 'role-img' }, dx, dy, frame, framePath);
      }
      if (name !== 'svg' && name !== 'img' && name !== 'input') {
        const st = win.getComputedStyle(el);
        const own = () => clean((el as HTMLElement).innerText) || undefined;
        for (const u of bgUrls(st.backgroundImage, base)) add(el, { technique: 'background', file: u, ...(own() ? { ownText: own() } : {}) }, dx, dy, frame, framePath);
        for (const u of bgUrls(st.maskImage || st.getPropertyValue('-webkit-mask-image'), base)) add(el, { technique: 'mask', file: u }, dx, dy, frame, framePath);
        for (const pseudo of ['::before', '::after']) {
          const content = win.getComputedStyle(el, pseudo).content;
          if (!content || /^(none|normal)$/.test(content)) continue;
          const urls = bgUrls(content, base);
          if (urls.length) { for (const u of urls) add(el, { technique: 'pseudo', file: u }, dx, dy, frame, framePath); continue; }
          const ch = content.replace(/^["']|["']$/g, '');
          if (PUA.test(ch)) add(el, { technique: 'icon-glyph', glyph: `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}` }, dx, dy, frame, framePath);
        }
      }
      if (name === 'a' && IMAGE_FILE.test((el as HTMLAnchorElement).href) && docs.length < o.documents) {
        docs.push({ href: (el as HTMLAnchorElement).href, text: clean((el as HTMLElement).innerText || el.getAttribute('aria-label')), nearbyText: clean(context(el).nearbyText, o.text) });
      }
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) walk(shadow, dx, dy, frame, framePath);
      if (name === 'iframe') {
        try {
          const fd = (el as HTMLIFrameElement).contentDocument;
          if (fd && fd.documentElement) {
            const r = el.getBoundingClientRect();
            walk(fd, dx + r.left, dy + r.top, fd.URL, cssPath(el));
          }
        } catch { /* another site's frame: not readable, never listed */ }
      }
      if (cut) return;
    }
  };
  walk(document, 0, 0);
  // Shown pictures first (the crops and the review take them in this order), then the rest, in document order.
  const ordered = [...out.filter((p) => p.shown), ...out.filter((p) => !p.shown)];
  (window as unknown as Record<string, unknown>)[o.key] = ordered.map((p) => p.el);
  (window as unknown as Record<string, unknown>)[`${o.key}Controls`] = ordered.map((p) => (p.el.matches(CONTROL) ? p.el : p.el.closest(CONTROL)) ?? null);
  return { pictures: ordered.map(({ el: _el, ...p }) => p), imageDocuments: docs, cut };
}

type AxNode = { ignored?: boolean; ignoredReasons?: { name: string }[]; role?: { value?: unknown }; name?: { value?: unknown }; description?: { value?: unknown } };
/** Ignored reasons that mean assistive technology is given nothing for the node: its name is ''. `emptyAlt`: alt="". */
const HIDDEN_FROM_AT = new Set(['ariaHiddenElement', 'ariaHiddenSubtree', 'inertElement', 'inertSubtree', 'presentationalRole', 'emptyAlt']);

/**
 * The browser's computed role, name and description of each element listed on `window[key]` (in its order), through
 * CDP. A node hidden from assistive technology has the name ''. An entry is undefined where the browser did not answer
 * within `ms`, so a name is never guessed. Never throws.
 */
export async function browserNamesOf(cdp: CDPSessionLike, key: string, count: number, ms: number): Promise<({ role?: string; name: string; description?: string } | undefined)[]> {
  const out: ({ role?: string; name: string; description?: string } | undefined)[] = new Array(count).fill(undefined);
  if (!count) return out;
  const group = `grnted-pictures-${key}`;
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : undefined);
  const work = (async () => {
    await cdp.send('Accessibility.enable').catch(() => undefined);
    const list = (await cdp.send('Runtime.evaluate', { expression: `window[${JSON.stringify(key)}]`, objectGroup: group })) as { result?: { objectId?: string } };
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
      const hidden = node.ignored && (node.ignoredReasons ?? []).some((r) => HIDDEN_FROM_AT.has(r.name));
      if (hidden) { out[i] = { name: '' }; continue; }
      if (node.ignored) continue;
      const name = str(node.name?.value);
      if (name === undefined) continue;
      const role = str(node.role?.value);
      const description = str(node.description?.value);
      out[i] = { name, ...(role ? { role } : {}), ...(description ? { description } : {}) };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  await Promise.race([work.catch(() => undefined), new Promise<void>((r) => { timer = setTimeout(() => { timedOut = true; r(); }, Math.max(0, ms)); })]);
  clearTimeout(timer);
  void cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
  return timedOut ? new Array(count).fill(undefined) : out;
}

/**
 * Which pictures get a crop: shown, not too small, at most `crops`, the largest first, one per file and size (the same
 * picture repeated in a list is cropped once). Pure.
 */
export function cropPlan(pictures: readonly Pick<PictureFact, 'n' | 'shown' | 'box' | 'file'>[], limits: Pick<typeof PICTURES_LIMITS, 'crops' | 'cropMin'> = PICTURES_LIMITS): number[] {
  const seen = new Set<string>();
  return pictures
    .filter((p) => p.shown && p.box && Math.min(p.box[2], p.box[3]) >= limits.cropMin)
    .sort((a, b) => b.box![2] * b.box![3] - a.box![2] * a.box![3] || a.n - b.n)
    .filter((p) => { const k = `${p.file ?? `#${p.n}`}\u0000${p.box![2]}x${p.box![3]}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, limits.crops)
    .map((p) => p.n);
}

/** The region a crop takes of a picture's box (CSS px, page coordinates): the box, each side capped. */
export function cropClip(box: PictureBox, limits: Pick<typeof PICTURES_LIMITS, 'cropMax'> = PICTURES_LIMITS): { x: number; y: number; width: number; height: number } {
  return { x: box[0], y: box[1], width: Math.min(box[2], limits.cropMax), height: Math.min(box[3], limits.cropMax) };
}

const VECTOR_FILE = /^data:image\/svg\+xml|\.svgz?(?:[?#]|$)/i;

/**
 * The scale of a picture's zoomed view: how much larger its painted region can be drawn while the browser still finds
 * finer detail in the picture's own file. A drawing (inline svg, an icon glyph, an SVG file) stays sharp at any size; a
 * bitmap whose own size the page tells (`natural`: an img, a canvas) holds at most its own pixels (the larger of its
 * two ratios to the box, so no axis loses detail); a bitmap whose size the page does not tell (a CSS background, an image
 * button) is drawn at the cap and shows only what its file holds. Capped at `zoomMax` and at `zoomPx` image pixels on the
 * longer side of the crop's region; under `zoomMin` there is no view, with the reason ('not finer': the file is the
 * limit; 'large': the region is). Pure.
 */
export function zoomScaleFor(
  p: Pick<PictureFact, 'technique' | 'file' | 'natural' | 'box'>,
  limits: Pick<typeof PICTURES_LIMITS, 'cropMax' | 'zoomMax' | 'zoomMin' | 'zoomPx'> = PICTURES_LIMITS,
): { scale: number } | { none: 'not finer' | 'large' } {
  if (!p.box) return { none: 'large' };
  const clip = cropClip(p.box, limits);
  const vector = p.technique === 'svg' || p.technique === 'icon-glyph' || (!!p.file && VECTOR_FILE.test(p.file));
  const own = !vector && p.natural && p.natural[0] > 0 && p.natural[1] > 0
    ? Math.max(p.natural[0] / p.box[2], p.natural[1] / p.box[3])
    : Infinity;
  const room = limits.zoomPx / Math.max(clip.width, clip.height);
  const scale = Math.min(limits.zoomMax, own, room);
  if (scale >= limits.zoomMin) return { scale: Math.round(scale * 100) / 100 };
  return { none: own <= room ? 'not finer' : 'large' };
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The zoomed views of the pictures that get one (`want`: picture number and scale, in crop order), one
 * `Page.captureScreenshot` each: the crop's region in page coordinates at that scale. The browser paints the region again
 * at that scale from what it has decoded; nothing is requested, scrolled or changed. Bounded by `ms` in all; a picture
 * left when the time is up is 'time'.
 */
async function takeZooms(cdp: CDPSessionLike, pictures: PictureFact[], want: readonly [number, number][], ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (const [n, scale] of want) {
    const p = pictures[n]!;
    if (Date.now() >= until) { p.zoomNote = 'time'; continue; }
    try {
      const shot = (await cdp.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 80, clip: { ...cropClip(p.box!), scale }, captureBeyondViewport: true, fromSurface: true,
      })) as { data?: unknown } | undefined;
      if (typeof shot?.data !== 'string' || !shot.data) { p.zoomNote = 'failed'; continue; }
      p.zoom = fromBase64(shot.data);
      p.zoomScale = scale;
    } catch {
      p.zoomNote = 'failed';
    }
  }
}

const KEY = '__grntedPictures';
/** The collector's own time, and what the zoomed views leave of it for the rest. */
const PICTURES_TIMEOUT_MS = 15_000;
const ZOOM_SPARE_MS = 1_500;

/** Opens the collector's one CDP session (names, then zoomed views), or undefined without one. Never throws. */
async function openSession(open: (() => Promise<CDPSessionLike>) | undefined): Promise<CDPSessionLike | undefined> {
  if (!open) return undefined;
  try { return await open(); } catch { return undefined; }
}

/** The picture inventory (desktop). Asked for by an AI plan only. */
export const picturesCollector: PageCollector<PicturesFacts> = {
  id: 'pictures',
  viewport: 'desktop',
  timeoutMs: PICTURES_TIMEOUT_MS,
  async collect(page, { cdp }) {
    const started = Date.now();
    const raw = await page.evaluate(collectPictures, { ...PICTURES_LIMITS, key: KEY });
    const count = raw.pictures.length;
    const session = await openSession(cdp);
    try {
      return await inventory(page, session, raw, count, started);
    } finally {
      await session?.detach?.().catch(() => undefined);
    }
  },
};

/** The browser's names, the crops and the zoomed views of the pictures the page evaluation found. */
async function inventory(page: Parameters<PageCollector['collect']>[0], session: CDPSessionLike | undefined, raw: ReturnType<typeof collectPictures>, count: number, started: number): Promise<PicturesFacts> {
  let names: { own: Awaited<ReturnType<typeof browserNamesOf>>; ctl: Awaited<ReturnType<typeof browserNamesOf>> } | undefined;
  if (session) {
    try {
      const own = await browserNamesOf(session, KEY, count, PICTURES_LIMITS.namesMs);
      const ctl = await browserNamesOf(session, `${KEY}Controls`, count, Math.max(500, PICTURES_LIMITS.namesMs / 2));
      names = { own, ctl };
    } catch { names = undefined; }
  }
  await page.evaluate((k: string) => { delete (window as unknown as Record<string, unknown>)[k]; delete (window as unknown as Record<string, unknown>)[`${k}Controls`]; }, KEY).catch(() => undefined);
  const pictures: PictureFact[] = raw.pictures.map((p, n) => {
    const got = names?.own[n];
    const ctl = p.control ? names?.ctl[n] : undefined;
    return {
      n, ...p,
      nameVerified: got !== undefined,
      ...(got ? { name: got.name, ...(got.role ? { role: got.role } : {}), ...(got.description ? { description: got.description } : {}) } : {}),
      ...(ctl ? { controlName: ctl.name } : {}),
    };
  });
  // Crops as painted (G6): page coordinates on the full page, so nothing is scrolled by hand.
  const until = Date.now() + PICTURES_LIMITS.cropMs;
  const plan = cropPlan(pictures);
  for (const n of plan) {
    const p = pictures[n]!;
    if (Date.now() >= until) { p.cropError = 'time'; continue; }
    try {
      const shot = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: true, clip: cropClip(p.box!) });
      p.crop = new Uint8Array(shot.buffer, shot.byteOffset, shot.byteLength);
    } catch (err) {
      p.cropError = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 120) : 'screenshot failed';
    }
  }
  // Zoomed views of the same regions (the lead's ruling, 2026-11-13): after every crop, in the same order, inside
  // what is left of the collector's own time (a zoom never costs the inventory).
  const want: [number, number][] = [];
  for (const n of plan) {
    const p = pictures[n]!;
    if (!p.crop) continue;
    const z = zoomScaleFor(p);
    if ('none' in z) p.zoomNote = z.none;
    else want.push([n, z.scale]);
  }
  if (want.length) {
    const ms = Math.min(PICTURES_LIMITS.zoomMs, started + PICTURES_TIMEOUT_MS - ZOOM_SPARE_MS - Date.now());
    if (session && ms > 0) await takeZooms(session, pictures, want, ms);
    else for (const [n] of want) pictures[n]!.zoomNote = session ? 'time' : 'no session';
  }
  return { pictures, imageDocuments: raw.imageDocuments, cut: raw.cut };
}
