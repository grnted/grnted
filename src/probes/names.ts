// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Names that are no names, from the DOM at the desktop width, on every page that loaded. Two rules the axe
// rules do not have, each only where the markup proves it:
// - 1.1.1 (failure F30, "text alternatives that are not alternatives"): an image whose alternative is a file
//   name that says nothing (a camera's, a serial or a random one: "IMG_2041.JPG", "image1.png",
//   "a8f3k2l9.png") or placeholder text that only says it is an image ("image", "photo", "spacer"). A file name
//   that describes the picture ("Mayor-Smith-cutting-ribbon.jpg") is ordinary alt text, not judged here, and a
//   word that names the control the image is in ("Photo" on a category button) is that control's name.
//   Whether a real description fits the picture is the AI review's. Batch 18 (the lead's ruling 2): an alternative
//   that is the picture's own file name with its extension, or its address, case-insensitive, fails whatever words it
//   has ("gate-map.svg" on gate-map.svg); one that only resembles a file name ("city-hall") is the AI review's.
// - 1.1.1 (batch 18, the lead's ruling 1; F65, H30, H36): a shown control whose only content is pictures with no text
//   alternative (an img with no alt attribute, an svg with no name source, a CSS background or mask picture) and whose
//   name, as the browser computes it, is empty. An img with alt="", an icon font, an image-map area and every other
//   picture are the AI review's. The control's 4.1.2 or 2.4.4 failure (axe) stays.
// - 2.5.3 (Label in Name): a form field with a visible label whose accessible name, as the browser computes it,
//   does not hold the words the label shows, in order and together (Understanding 2.5.3), so a speech-input
//   user who says what is on screen is not understood. Only the label text that is shown counts (hidden text
//   inside the label does not). A name shorter than the label leaves words out, and fails. Words in order with
//   others between them, a long label that may hold a hint, and a name the browser did not give are undecided.
//   axe's label-content-name-mismatch covers buttons and links only.
// Reads only; it changes nothing on the page. Engine core: no Node-only imports.
import { rolelessInFrames, rolelessOnPage } from './ariaStates.js';
import { axNameOf } from './axName.js';
import type { ProbeFinding } from '../types.js';
import { pageWords, shootElements } from './evidence.js';
import type { PageProbe, ProbeContext } from './types.js';

export const NAMES_PROBE_ID = 'names';

export const NAMES_LIMITS = {
  /** Images and fields read per page. */
  images: 5_000,
  fields: 2_000,
  /** Findings of one kind kept per page. */
  kept: 100,
  /** Fields whose name is asked of the browser per page (fields with a visible label and an ARIA name of their own). */
  labels: 40,
  /** Time for asking those names, in all (ms), and for one of them; a field not asked in time is undecided. */
  namesMs: 4_000,
  nameMs: 1_500,
  /**
   * Batch 18: controls read per page for pictures with no text alternative as their only content, the candidates whose
   * name is asked of the browser, and the time for asking (in all); a candidate not asked in time is undecided.
   */
  controls: 2_000,
  pictureControls: 40,
  controlNamesMs: 3_000,
} as const;

/** Where the page keeps the label candidates' fields, by reference, for the name the browser computes. */
export const NAMES_KEY = '__grntedNames';
/** Where the page keeps the picture-only controls, by reference, for the name the browser computes (batch 18). */
export const NAMES_CONTROL_KEY = '__grntedNamesControls';

/** Findings of one kind listed per page; the last one counts the rest. */
const PER_KIND = 5;

/** Whole alternatives that only say the thing is an image (F30's "image", "picture", "spacer", and their like). */
export const PLACEHOLDER_ALTS: readonly string[] = [
  // Not here: a word that can say what a picture shows ("Alt" on a picture of the key, "None", "Blank", "Temp", "To do").
  'image', 'img', 'picture', 'pic', 'photo', 'photograph', 'graphic', 'spacer', 'placeholder', 'alt text', 'image alt', 'alt tag',
  'image description', 'insert alt text', 'add alt text', 'untitled image', 'null', 'undefined',
  // Spanish and French: the commonest.
  'imagen', 'foto', 'fotografia', 'fotografía', 'photographie',
];

export interface NameProblem {
  /** 'own-file' (batch 18, the lead's ruling 2): the alternative is the picture's own file name or address. */
  kind: 'file-name' | 'placeholder' | 'own-file';
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
  /** The alternative (at most 80 characters). */
  name: string;
  /** What it is: 'image', 'image button', 'text field'… */
  what: string;
}

/** A field with a visible label and an ARIA name of its own (aria-label or aria-labelledby): judged with the browser's name. */
export interface LabelCandidate {
  target: string;
  /** The label text that is shown (at most 80 characters), and its words as compared. */
  label: string;
  words: string;
  /** The name the page-side read worked out (aria-labelledby's text, else aria-label): used only when the browser gives none. */
  own: string;
  /** A short label of plain text: no sentence, no hint inside it. Only such a label's missing words are a failure. */
  simple: boolean;
  /**
   * The words of the label's own first text (the text of the element its first word is in: "Password" in
   * `Password <span>at least 8 characters</span>`). Text in an element of its own after it may be a hint.
   */
  lead: string;
  what: string;
}

/**
 * A control shown on the page whose only content is pictures that have no text alternative (batch 18, the lead's
 * ruling 1): an `img` with no alt attribute and no other name source, an `svg` with none, or a CSS background or mask
 * picture. Judged with the name the browser computes: empty is a failure of 1.1.1 ("Controls, Input"; F65, H30, H36).
 */
export interface PictureControl {
  target: string;
  /** What it is: 'link', 'button'… */
  what: string;
  /** How its pictures are made: 'img', 'svg', 'background' (joined with ' and '). */
  pictures: string;
}

export interface NamesRead {
  problems: NameProblem[];
  /** In the order of the elements kept on `window[key]`. */
  labels?: LabelCandidate[];
  /** In the order of the elements kept on `window[controlKey]`. */
  pictureControls?: PictureControl[];
  truncated: boolean;
}

/** Runs in the page (self-contained). */
export function readNames(limits: { images: number; fields: number; kept: number; labels?: number; placeholders?: readonly string[]; key?: string; controls?: number; pictureControls?: number; controlKey?: string }): NamesRead {
  const clean = (s: string | null | undefined, max = 80) => {
    const t = (s ?? '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
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
  /** Shown to assistive technology: rendered, and not under aria-hidden or inert. */
  const exposed = (el: Element): boolean => {
    for (let a: Element | null = el; a; a = a.parentElement) if (a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('inert')) return false;
    const c = el as Element & { checkVisibility?: (o: object) => boolean };
    return typeof c.checkVisibility === 'function' ? c.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
  };
  /** Seen on screen: a box of 2×2 px or more that is not clipped away (screen-reader-only text is not seen). */
  const seen = (el: Element): boolean => {
    const c = el as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof c.checkVisibility === 'function' && !c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    for (let a: Element | null = el, i = 0; a && i < 6; a = a.parentElement, i++) {
      const r = a.getBoundingClientRect();
      const st = getComputedStyle(a);
      if ((r.width < 2 || r.height < 2) && (st.overflow !== 'visible' || st.position === 'absolute')) return false;
      if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(st.clip) || /inset\(\s*(50%|100%)/.test(st.clipPath)) return false;
      // Moved off the page's left or top edge, text pushed out of its box, or type of no size: not shown either.
      if (r.right + window.scrollX < 0 || r.bottom + window.scrollY < 0) return false;
      if (Math.abs(parseFloat(st.textIndent) || 0) >= 500 || parseFloat(st.fontSize) === 0) return false;
    }
    return true;
  };
  /** Compared as words: lower case, no punctuation or symbols. */
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const PLACEHOLDERS = new Set((limits.placeholders ?? []).map(norm));
  const EXT = /\.(?:jpe?g|png|gif|webp|svg|bmp|tiff?|avif|heic|ico)$/i;
  const FILE = /^[^\\/]{1,160}\.(?:jpe?g|png|gif|webp|svg|bmp|tiff?|avif|heic|ico)$/i;
  // A camera's or an export's own name with no extension ("IMG_2041", "DSC00412", "Screen Shot 2026-01-02 at 10.11.12").
  const CAMERA = /^(?:img|dsc|dscn|dscf|pxl|mvimg|gopr|image|photo|pic|picture|screenshot|screen ?shot|untitled)[-_ ]?\(?\d{1,8}\)?(?:[-_ .at\d]*)$/i;
  /** Words a camera, a phone, a scanner or an export puts in a file name: they say nothing about the picture. */
  const GENERIC = new Set(['img', 'image', 'images', 'imagen', 'photo', 'photos', 'foto', 'fotos', 'pic', 'pics', 'picture', 'pictures', 'graphic', 'dsc', 'dscn', 'dscf', 'pxl', 'mvimg', 'gopr', 'cimg', 'pict', 'sam',
    'screenshot', 'screen', 'shot', 'scan', 'scanned', 'capture', 'untitled', 'unnamed', 'file', 'download', 'attachment', 'placeholder', 'spacer', 'blank', 'temp', 'tmp', 'copy', 'null', 'undefined',
    // An export's own words around its date and time ("Screen Shot 2026-01-02 at 10.11.12 AM").
    'at', 'am', 'pm', 'of']);
  /**
   * Words an editing program's export puts in a file name ("export-final-v3", "IMG_2041-edited-cropped"). They are
   * words (a picture of a cup final can be "final.jpg"), so they say nothing only beside a version or serial
   * number, or a camera's own word: batch 17.
   */
  const EXPORT = new Set(['export', 'exported', 'final', 'draft', 'copy', 'edit', 'edited', 'version', 'ver', 'rev', 'revised', 'resized', 'scaled', 'cropped', 'crop',
    'optimized', 'compressed', 'hires', 'lowres', 'thumb', 'thumbnail']);
  /**
   * A file name's stem that says nothing about the picture: no word left once the camera's and the export's own
   * words, numbers, and runs of letters and digits (serial numbers, hashes, random ids) are taken away.
   * "Mayor-Smith-cutting-ribbon" has words; "IMG_2041", "image1", "a8f3k2l9x0q1" and "7c9e6679-7425" have none.
   */
  const noWords = (stem: string): boolean => {
    const tokens = stem.normalize('NFKC').replace(/([\p{Ll}])([\p{Lu}])/gu, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    // The name has a number or a camera's word in it: an export's words beside it are the program's, not a description.
    const serial = tokens.some((t) => /\p{N}/u.test(t) || GENERIC.has(t));
    for (const t of tokens) {
      if (/\p{N}/u.test(t)) continue; // a serial number, a date, a token of letters and digits
      if (/[^\u0000-\u024f]/.test(t)) return false; // a word in a script that needs no three letters
      // (A token of letters only is a word, also when its letters are a hash's: "facade", "decade".)
      // Two letters can be a word ("US", "NY"); one letter is not.
      if (t.length < 2 || GENERIC.has(t) || (serial && EXPORT.has(t))) continue;
      return false;
    }
    return true;
  };
  /** Inside a control whose name the image's alternative gives (a link, a button, a tab): the word may name what the control does. */
  const CONTROL = 'a[href], button, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]';

  const problems: NameProblem[] = [];
  let truncated = false;
  const counts = { 'file-name': 0, placeholder: 0, 'own-file': 0 };
  /**
   * The picture's own address and file name, as an alternative copied from them would read (batch 18, the lead's
   * ruling 2): the address as written and in full (with and without its query and fragment), and its last path segment,
   * as written and decoded, when that has an extension. Lower case. A data: address has none.
   */
  const ownNames = (el: Element): Set<string> => {
    const out = new Set<string>();
    for (const s of [el.getAttribute('src') ?? '', (el as HTMLImageElement).currentSrc || '']) {
      const raw = s.trim();
      if (!raw || /^data:/i.test(raw)) continue;
      let abs: URL;
      try { abs = new URL(raw, document.baseURI); } catch { continue; }
      for (const v of [raw, abs.href, abs.href.split('#')[0]!, abs.href.split(/[?#]/)[0]!]) out.add(v.toLowerCase());
      const seg = abs.pathname.split('/').pop() ?? '';
      let decoded = seg;
      try { decoded = decodeURIComponent(seg); } catch { /* a malformed escape: the segment as written */ }
      for (const b of [seg, decoded]) if (/\.[\p{L}\p{N}]{1,5}$/u.test(b)) out.add(b.normalize('NFKC').toLowerCase());
    }
    return out;
  };
  /** The alternative as written (spaces collapsed, never shortened), compared with `ownNames`. */
  const asWritten = (s: string) => s.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim().normalize('NFKC').toLowerCase();
  /** Inside a link to the picture's own file, or a download link: the file is named on purpose ("Download IMG_2041.png"). */
  const linksOwnFile = (el: Element): boolean => {
    const link = el.closest('a[href]') as HTMLAnchorElement | null;
    if (!link) return false;
    const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
    if (link.hasAttribute('download')) return true;
    try { return !!src && !!link.href && link.href.split(/[?#]/)[0] === new URL(src, document.baseURI).href.split(/[?#]/)[0]; } catch { return false; }
  };
  const push = (p: NameProblem) => {
    if (counts[p.kind]++ >= limits.kept) { truncated = true; return; }
    problems.push(p);
  };

  // Images: their alternative as a file name or placeholder text.
  const images = document.querySelectorAll('img[alt], input[type="image"][alt], area[alt], [role="img"][aria-label]');
  for (let i = 0; i < images.length; i++) {
    if (i >= limits.images) { truncated = true; break; }
    const el = images[i]!;
    const raw = el.localName === 'img' || el.localName === 'input' || el.localName === 'area' ? el.getAttribute('aria-label') || el.getAttribute('alt') : el.getAttribute('aria-label');
    const alt = clean(raw, 200);
    if (!alt || el.hasAttribute('aria-labelledby')) continue;
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
    if (el.localName === 'img' && (role === 'presentation' || role === 'none')) continue;
    if (!exposed(el)) continue;
    const what = el.localName === 'input' ? 'image button' : el.localName === 'area' ? 'image map area' : 'image';
    // Batch 18 (the lead's ruling 2, F30): an alternative that is the picture's own file name with its extension, or
    // its address, was copied from the file, whatever words the name has. Checked only where the rules below say
    // nothing, so none of their results moves. Never inside a link to the picture's own file or a download link.
    const own = (el.localName === 'img' || el.localName === 'input') && ownNames(el).has(asWritten(raw ?? '')) && !linksOwnFile(el);
    if (FILE.test(alt)) {
      // A file name that describes the picture is ordinary alt text (its quality is the AI review's): only a
      // name with no word in it (a camera's, a serial, a random one) is no alternative.
      if (!noWords(alt.replace(EXT, ''))) { if (own) push({ kind: 'own-file', target: cssPath(el), name: clean(alt), what }); continue; }
      // A link to the picture's own file ("Download IMG_2041.png") names the file on purpose.
      const link = el.closest('a[href]') as HTMLAnchorElement | null;
      const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
      if (link && (link.hasAttribute('download') || (src && link.href && link.href.split(/[?#]/)[0] === new URL(src, document.baseURI).href.split(/[?#]/)[0]))) continue;
      push({ kind: 'file-name', target: cssPath(el), name: clean(alt), what });
    } else if (CAMERA.test(alt)) {
      push({ kind: 'file-name', target: cssPath(el), name: clean(alt), what });
    } else if (PLACEHOLDERS.has(norm(alt))) {
      // On an image that is, or is inside, a control, the word is the control's name ("Photo" on a category
      // button): whether it names what the control does is not this rule's to say.
      if (el.localName === 'input' || el.localName === 'area' || el.closest(CONTROL)) continue;
      push({ kind: 'placeholder', target: cssPath(el), name: clean(alt), what });
    } else if (own) {
      push({ kind: 'own-file', target: cssPath(el), name: clean(alt), what });
    }
  }

  // Batch 18 (the lead's ruling 1, F65, H30, H36): controls whose only content is pictures with no text alternative.
  // Candidates only: the browser's computed name decides (`pictureControlNames`). A candidate is a link, a button or a
  // control role that is shown and exposed, has no aria-label, aria-labelledby or title, holds no text node, no
  // generated content, no form field and no other kind of picture, and holds at least one shown picture, every one of
  // which has no text alternative: an `img` with no alt attribute (and no aria-label, aria-labelledby or title), an
  // `svg` with no aria-label, aria-labelledby or title child (or kept from assistive technology), or a CSS background
  // or mask picture. An `img` with any alt attribute, `alt=""` included, an icon font, a canvas, an image-map area and
  // everything else is the AI review's.
  const PICTURE_CONTROL = 'a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"]';
  const pictureControls: PictureControl[] = [];
  const heldControls: Element[] = [];
  const controls = document.querySelectorAll(PICTURE_CONTROL);
  const maxControls = limits.pictureControls ?? 40;
  const hasUrl = (v: string | null | undefined) => /url\(/i.test(v ?? '');
  const pictureOf = (e: Element): boolean => {
    const st = getComputedStyle(e);
    return hasUrl(st.backgroundImage) || hasUrl(st.maskImage) || hasUrl(st.getPropertyValue('-webkit-mask-image'));
  };
  const generated = (e: Element) => ['::before', '::after'].some((p) => !/^(none|normal)$/.test(getComputedStyle(e, p).content));
  const shownBox = (e: Element) => {
    const r = e.getBoundingClientRect();
    const c = e as Element & { checkVisibility?: (o: object) => boolean };
    return r.width >= 1 && r.height >= 1 && (typeof c.checkVisibility !== 'function' || c.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
  };
  const named = (e: Element) => ['aria-label', 'aria-labelledby', 'title'].some((a) => (e.getAttribute(a) ?? '').trim());
  for (let i = 0; i < controls.length; i++) {
    // Past the caps the rest is left alone (never a result of its own: the other rules' `truncated` is theirs).
    if (i >= (limits.controls ?? 2000)) break;
    const el = controls[i]!;
    if (named(el) || !exposed(el) || !seen(el)) continue;
    // Nested controls: the innermost one is judged.
    if (el.querySelector(PICTURE_CONTROL)) continue;
    let text = false;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // Any text is text: a word, a symbol, a glyph, shown or kept for screen readers only.
      if ((n.nodeValue ?? '').trim()) { text = true; break; }
    }
    if (text) continue;
    const kinds = new Set<string>();
    let other = generated(el);
    if (!other && pictureOf(el) && shownBox(el)) kinds.add('background');
    const inside = Array.from(el.querySelectorAll('*'));
    if (inside.length > 200) other = true;
    for (const d of inside) {
      if (other) break;
      // An svg's own drawing is the svg; nothing in it is read on its own.
      if (d.localName !== 'svg' && d.closest('svg')) continue;
      if (generated(d) || /^(input|select|textarea|canvas|video|audio|object|embed|iframe|math|slot)$/.test(d.localName) || (d.localName === 'svg' && d.parentElement?.closest('svg'))) { other = true; break; }
      if (d.localName === 'img') {
        if (d.hasAttribute('alt') || named(d)) { other = true; break; }
        if (shownBox(d)) kinds.add('img');
      } else if (d.localName === 'svg') {
        const keptFromAt = d.getAttribute('aria-hidden') === 'true';
        if (!keptFromAt && (named(d) || Array.from(d.children).some((c) => c.localName === 'title'))) { other = true; break; }
        if (shownBox(d)) kinds.add('svg');
      } else if (pictureOf(d) && shownBox(d)) {
        kinds.add('background');
      } else if ((d as HTMLElement).shadowRoot) {
        // Content of its own the light tree does not show: not read here.
        other = true;
      }
    }
    if (other || !kinds.size || (el as HTMLElement).shadowRoot) continue;
    if (pictureControls.length >= maxControls) break;
    const role = (el.getAttribute('role') ?? '').trim().toLowerCase();
    const what = role ? role.replace('menuitem', 'menu item') : el.localName === 'a' ? 'link' : el.localName === 'summary' ? 'disclosure summary' : 'button';
    pictureControls.push({ target: cssPath(el), what, pictures: [...kinds].sort().join(' and ') });
    heldControls.push(el);
  }
  if (limits.controlKey) (window as unknown as Record<string, Element[]>)[limits.controlKey] = heldControls;

  // Fields with a visible label and an ARIA name of their own: candidates, judged with the name the browser computes.
  const WORDS = /\b(?:required|optional|obligatorio|opcional)\b/g;
  const labelWords = (s: string) => norm(s.replace(/\([^)]*\)/g, ' ')).replace(WORDS, ' ').replace(/\s+/g, ' ').trim();
  const PLAIN = new Set(['span', 'b', 'strong', 'em', 'i', 'u', 'abbr', 'mark', 'font']);
  /** The label text that is shown: its rendered text nodes, outside the fields and buttons it wraps; and whether all of it is plain. */
  const shownText = (label: Element): { text: string; plain: boolean; lead: string } => {
    const parts: string[] = [];
    const lead: string[] = [];
    let first: Element | null = null;
    let plain = true;
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), k = 0; n && k < 400; n = walker.nextNode(), k++) {
      const raw = (n.nodeValue ?? '').slice(0, 400);
      if (!raw.trim()) continue;
      const parent = n.parentElement;
      if (!parent || parent.closest('input, select, textarea, button, script, style, noscript, template') || !seen(parent)) continue;
      for (let a: Element | null = parent; a && a !== label; a = a.parentElement) if (!PLAIN.has(a.localName)) plain = false;
      parts.push(raw);
      first ??= parent;
      if (parent === first) lead.push(raw);
    }
    return { text: clean(parts.join(' '), 200), plain, lead: clean(lead.join(' '), 200) };
  };
  const labels: LabelCandidate[] = [];
  const held: Element[] = [];
  const maxLabels = limits.labels ?? 40;
  const fields = document.querySelectorAll('input, select, textarea');
  for (let i = 0; i < fields.length; i++) {
    if (i >= limits.fields) { truncated = true; break; }
    const el = fields[i] as HTMLInputElement;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (el.localName === 'input' && /^(hidden|submit|button|reset|image)$/.test(type)) continue;
    const by = el.getAttribute('aria-labelledby');
    const aria = clean(el.getAttribute('aria-label'), 200);
    if (!by && !aria) continue;
    const fieldLabels = Array.from(el.labels ?? []).filter((l) => seen(l));
    if (!fieldLabels.length || !exposed(el) || !seen(el)) continue;
    const shown = fieldLabels.map(shownText);
    const labelText = clean(shown.map((x) => x.text).join(' '), 200);
    const visible = labelWords(labelText);
    if ((visible.match(/\p{L}/gu) ?? []).length < 3) continue;
    let own = aria;
    if (by) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const refs = by.split(/\s+/).filter(Boolean).map((id) => root.getElementById?.(id) ?? document.getElementById(id)).filter((x): x is HTMLElement => !!x);
      const text = clean(refs.map((r) => (r.textContent ?? '').slice(0, 400)).join(' '), 200);
      if (text) own = text;
    }
    if (labels.length >= maxLabels) { truncated = true; break; }
    const what = el.localName === 'select' ? 'drop-down list' : el.localName === 'textarea' ? 'text box' : type === 'checkbox' ? 'check box' : type === 'radio' ? 'radio button' : type === 'search' ? 'search field' : 'field';
    const simple = shown.every((x) => x.plain) && visible.split(' ').length <= 6 && !/[.!?;]/.test(labelText.replace(/[.:;]\s*$/, ''));
    labels.push({ target: cssPath(el), label: clean(labelText), words: visible, own: clean(own), simple, lead: labelWords(shown[0]?.lead ?? ''), what });
    held.push(el);
  }
  if (limits.key) (window as unknown as Record<string, Element[]>)[limits.key] = held;
  return { problems, ...(labels.length ? { labels } : {}), ...(pictureControls.length ? { pictureControls } : {}), truncated };
}

/** Compared as words: lower case, no punctuation or symbols, no parentheses, no "required" or "optional". */
const nameWords = (s: string): string[] => s.normalize('NFKC').replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\b(?:required|optional|obligatorio|opcional)\b/g, ' ').trim().split(/\s+/).filter(Boolean);

/**
 * How an accessible name holds a visible label's words (pure): 'holds' in order and together (what Understanding
 * 2.5.3 asks), 'scattered' in order with other words between them or written another way (a hyphen, a space),
 * 'missing' when a word of the label is not there.
 */
export function labelInName(label: string, name: string): 'holds' | 'scattered' | 'missing' {
  const want = nameWords(label);
  const have = nameWords(name);
  if (!want.length) return 'holds';
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, k) => have[i + k] === w)) return 'holds';
  let at = 0;
  for (const w of have) if (w === want[at]) at++;
  if (at >= want.length) return 'scattered';
  // The same letters written another way ("E-mail" in "Email address", "Zip code" in "Zipcode"): not word for
  // word, and not left out either.
  return have.join('').includes(want.join('')) ? 'scattered' : 'missing';
}

/**
 * The accessible name of each label candidate as the browser computes it (in the candidates' order), from the
 * elements `readNames` kept in the page; undefined where the browser gave none, or `NAMES_LIMITS.namesMs` ran
 * out before it was asked. Never throws.
 */
export async function labelNames(ctx: ProbeContext, read: NamesRead, key: string = NAMES_KEY): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = [];
  const until = Date.now() + NAMES_LIMITS.namesMs;
  for (let i = 0; i < (read.labels?.length ?? 0); i++) {
    const left = until - Date.now();
    if (ctx.signal?.aborted || left <= 0) { out.push(undefined); continue; }
    out.push(await axNameOf(ctx, `window[${JSON.stringify(key)}] && window[${JSON.stringify(key)}][${i}]`, Math.min(NAMES_LIMITS.nameMs, left)));
  }
  await ctx.page.evaluate((k: string) => { delete (window as unknown as Record<string, unknown>)[k]; }, key).catch(() => {});
  return out;
}

/**
 * The accessible name of each picture-only control candidate as the browser computes it (in the candidates' order),
 * from the elements `readNames` kept in the page; undefined where the browser gave none, or
 * `NAMES_LIMITS.controlNamesMs` ran out before it was asked. Never throws.
 */
export async function pictureControlNames(ctx: ProbeContext, read: NamesRead, key: string = NAMES_CONTROL_KEY): Promise<(string | undefined)[]> {
  const out: (string | undefined)[] = [];
  const until = Date.now() + NAMES_LIMITS.controlNamesMs;
  for (let i = 0; i < (read.pictureControls?.length ?? 0); i++) {
    const left = until - Date.now();
    if (ctx.signal?.aborted || left <= 0) { out.push(undefined); continue; }
    out.push(await axNameOf(ctx, `window[${JSON.stringify(key)}] && window[${JSON.stringify(key)}][${i}]`, Math.min(NAMES_LIMITS.nameMs, left)));
  }
  await ctx.page.evaluate((k: string) => { delete (window as unknown as Record<string, unknown>)[k]; }, key).catch(() => {});
  return out;
}

/** One page's findings from what `readNames` reported and the names the browser gave its label candidates (`labelNames`). */
export function nameFindings(read: NamesRead, names: readonly (string | undefined)[] = [], controlNames: readonly (string | undefined)[] = []): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  const list = (kind: NameProblem['kind'], detail: (p: NameProblem) => string, criterion: string) => {
    const all = read.problems.filter((p) => p.kind === kind);
    const shown = all.slice(0, PER_KIND);
    shown.forEach((p, i) => {
      const more = i === shown.length - 1 && all.length > shown.length ? ` (${all.length - shown.length} more like this on this page)` : '';
      out.push({ criterion, status: 'failed', target: p.target, detail: `${detail(p)}${more}` });
    });
  };
  list('file-name', (p) => `The ${p.what}'s text alternative is a file name (“${p.name}”) that says nothing about what it shows`, '1.1.1');
  list('placeholder', (p) => `The ${p.what}'s text alternative is “${p.name}”, which only says that it is an image, not what it shows`, '1.1.1');
  list('own-file', (p) => `The ${p.what}'s text alternative is its own file name or address (“${p.name}”): a file name is not a text alternative (F30), so screen readers read out the file's name instead of what the picture shows`, '1.1.1');
  // Batch 18 (ruling 1): a control whose only content is pictures with no text alternative, named nothing by the browser.
  const unnamed: PictureControl[] = [];
  const unasked: PictureControl[] = [];
  (read.pictureControls ?? []).forEach((c, i) => {
    const name = controlNames[i];
    if (name === undefined) unasked.push(c);
    else if (name === '') unnamed.push(c);
  });
  unnamed.slice(0, PER_KIND).forEach((c, i, shown) => {
    const more = i === shown.length - 1 && unnamed.length > shown.length ? ` (${unnamed.length - shown.length} more like this on this page)` : '';
    out.push({
      criterion: '1.1.1', status: 'failed', target: c.target,
      detail: `The ${c.what}'s only content is a picture (${c.pictures}) with no text alternative, and the ${c.what} has no name: screen readers cannot say what it does (F65; a control's text alternative must describe its purpose)${more}`,
    });
  });
  unasked.slice(0, PER_KIND).forEach((c) => {
    out.push({ criterion: '1.1.1', status: 'not_testable', target: c.target, detail: `the ${c.what}'s only content is a picture (${c.pictures}) with no text alternative, and the browser gave no accessible name to check` });
  });
  // 2.5.3: the label's shown words against the name the browser computes.
  const failed: { c: LabelCandidate; name: string }[] = [];
  const undecided: { c: LabelCandidate; name: string; why: string }[] = [];
  (read.labels ?? []).forEach((c, i) => {
    const name = names[i];
    // No answer from the accessibility tree (no session, a timeout, the name budget used up): undecided, before
    // any comparison. The name worked out from the page is never judged in its place, for a pass or a failure
    // (review round 2, finding 5).
    if (name === undefined) { undecided.push({ c, name: c.own, why: 'the browser gave no accessible name to compare' }); return; }
    const held = labelInName(c.words, name);
    if (held === 'holds') return;
    if (held === 'scattered') undecided.push({ c, name, why: 'the name has the label\'s words in order, but with other words between them or written another way' });
    else if (!c.simple) undecided.push({ c, name, why: 'the label is long or holds more than its own words (a hint, perhaps), and the name leaves some of them out' });
    // The name holds the label's own first text; what it leaves out is in an element of its own inside the label.
    else if (c.lead && c.lead !== c.words && labelInName(c.lead, name) === 'holds') undecided.push({ c, name, why: 'the name holds the label\'s first words, and the rest of the label is set apart inside it (a hint, perhaps)' });
    else failed.push({ c, name });
  });
  failed.slice(0, PER_KIND).forEach(({ c, name }, i, shown) => {
    const more = i === shown.length - 1 && failed.length > shown.length ? ` (${failed.length - shown.length} more like this on this page)` : '';
    out.push({
      criterion: '2.5.3', status: 'failed', target: c.target,
      detail: `The ${c.what} is labelled “${c.label}” on screen, but its name for assistive technology is “${name.length > 80 ? `${name.slice(0, 79)}…` : name}”, which leaves those words out: someone using speech input who says the label is not understood${more}`,
    });
  });
  undecided.slice(0, PER_KIND).forEach(({ c, name, why }) => {
    out.push({
      criterion: '2.5.3', status: 'not_testable', target: c.target,
      detail: `the ${c.what} is labelled “${c.label}” on screen and named “${name.length > 80 ? `${name.slice(0, 79)}…` : name}” for assistive technology: ${why}, so whether the name holds the label could not be told`,
    });
  });
  if (!out.length && read.truncated) {
    return ['1.1.1', '2.5.3'].map((criterion) => ({ criterion, status: 'not_testable' as const, detail: 'this page is too large to read every image and field' }));
  }
  return out;
}

/** The first problem of each criterion boxed, in the main document. */
async function nameEvidence(ctx: ProbeContext, findings: readonly ProbeFinding[]): Promise<void> {
  const first = (c: string) => findings.find((f) => f.criterion === c && f.status === 'failed' && f.target && !f.target.includes(' >>> '));
  const image = first('1.1.1');
  if (image && /only content is a picture/.test(image.detail ?? '')) {
    await shootElements(ctx, {
      criterion: '1.1.1', handles: [{ sel: image.target! }], caption: 'A picture with no text alternative is its only content',
      alt: (title) => `${pageWords(title)}: the outlined control shows only a picture and has no name for assistive technology.`,
    });
  } else if (image) {
    await shootElements(ctx, {
      criterion: '1.1.1', handles: [{ sel: image.target! }], caption: 'Its text alternative does not say what it shows',
      alt: (title) => `${pageWords(title)}: the outlined image has a file name or placeholder text as its text alternative.`,
    });
  }
  const field = first('2.5.3');
  if (field) {
    await shootElements(ctx, {
      criterion: '2.5.3', handles: [{ sel: field.target! }], caption: 'Its name leaves out the label shown',
      alt: (title) => `${pageWords(title)}: the outlined field has a name for assistive technology that leaves out its visible label.`,
    });
  }
}

/**
 * Names that are no names, and controls with no role, on every page that loaded (`everyPage`): fails 1.1.1 for
 * an image whose alternative is a file name or placeholder text, 2.5.3 for a field whose accessible name leaves
 * out its visible label, and 4.1.2 for an element the page's script makes a control without giving it a role
 * (F59; read in `ariaStates.ts`). Listed, not scored, until calibrated (docs/scoring.md).
 */
export const namesProbe: PageProbe = {
  id: NAMES_PROBE_ID,
  criteria: ['1.1.1', '2.5.3', '4.1.2'],
  // Reads the page once: an app that mounts its content late is read with it.
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  scored: false,
  timeoutMs: 10_000,
  everyPage: true,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const read = await ctx.page.evaluate(readNames, {
      images: NAMES_LIMITS.images, fields: NAMES_LIMITS.fields, kept: NAMES_LIMITS.kept, labels: NAMES_LIMITS.labels, placeholders: [...PLACEHOLDER_ALTS], key: NAMES_KEY,
      controls: NAMES_LIMITS.controls, pictureControls: NAMES_LIMITS.pictureControls, controlKey: NAMES_CONTROL_KEY,
    });
    const labelled = await labelNames(ctx, read);
    const findings = nameFindings(read, labelled, await pictureControlNames(ctx, read));
    await nameEvidence(ctx, findings);
    // Controls with no role: in the page, and (batch 17) in its own embedded frames.
    return [...findings, ...(await rolelessOnPage(ctx)), ...(await rolelessInFrames(ctx))];
  },
};
