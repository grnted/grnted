// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Floating content that covers the page (scoring v5, part B): boxes that stay on screen while the
// page scrolls (translate widgets, chat bubbles, promotions, cookie banners, sticky bars) and cover
// links, buttons and fields, or much of the screen, at 320 CSS px wide (the reflow test's setup) and
// at a phone's width; and, when tabbing, a focused control hidden behind one (2.4.11). Engine core:
// no Node-only imports.
import type { CDPSessionLike, ProbeFinding } from '../types.js';
import { before, pageWords, timeFor } from './evidence.js';
import { obscuredBy, type GridPoint } from './keyboard/rules.js';
import { excerpt, stoppedSince } from './layout.js';
import { GUARD_SETTLE_MS } from './motionShared.js';
import { PORTRAIT } from './orientation.js';
import { REFLOW_VIEWPORT } from './reflow.js';
import { pressTab } from './keys.js';
import { proveDismiss } from './dismiss.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';
export { pressTab } from './keys.js';

/** The widths the test lays the page out at: the reflow test's 320×256 (1280 px at 400% zoom) and a phone. */
export const OVERLAY_VIEWPORTS: readonly { width: number; height: number; label: 'zoom' | 'phone' }[] = [
  { ...REFLOW_VIEWPORT, label: 'zoom' },
  { ...PORTRAIT, label: 'phone' },
];

export const OVERLAY_LIMITS = {
  /**
   * A floating box covering more than this share of the screen at 320 px wide leaves little of the screen for
   * the content: a RECOMMENDATION since 2026-11-10 (scoring v11), never a failure. WCAG 1.4.10 fails content
   * that is lost or needs scrolling in two directions; a large box the content scrolls clear of loses nothing.
   * (2026-11-07 real-site audit: boxes measured at 50% and 58% were what auditors remarked on, one at 35% was not.)
   */
  areaShare: 0.4,
  /**
   * From this share of the screen, a box that stays fixed on screen FAILS 1.4.10 when some of the page's text
   * stays under it wherever the page is scrolled (`OvRoot.stuck`): that text is lost (a page too short to scroll
   * cannot bring it clear).
   */
  areaLow: 0.2,
  /** A dialog with a keyboard-reachable close button is allowed while it covers less than this share. */
  dialogShare: 0.5,
  /** A full-width bar at the top or bottom of the screen is the page's own header or footer up to this share of its height. */
  barHeight: 1 / 3,
  /** Share of the screen width a bar spans. */
  barWidth: 0.9,
  /** Scroll positions per width (the top and the bottom always included). */
  maxSteps: 16,
  /**
   * Covered controls never seen clear that are tried again at the top, middle and bottom of the
   * screen, per width, in document order. More than this leaves the width unfinished (1.4.10 is then
   * not_testable unless a checked failure stands).
   */
  verify: 40,
  /** Links, buttons and fields in view looked at per scroll position (more leaves the width unfinished). */
  maxControls: 3000,
  /** Tab presses per width, and Shift+Tab presses from the end of the page. */
  forward: 40,
  backward: 10,
  /**
   * Before each width is swept the page must have stopped changing (its size, its number of
   * elements, the classes on html and body) for `quietMs`, waited for up to `settleMaxMs`: a script
   * that makes room for a widget, or content that loads late, decides what covers what.
   */
  quietMs: 500,
  settleMaxMs: 2500,
  /** Background alpha (and opacity) from which an element hides what is under it. */
  opaque: 0.9,
  /** Longest wait for the page to stop scrolling after a key press (ms). */
  settleMs: 300,
  /** Grid over the 320 px screen for the covered share (columns × rows). */
  grid: [16, 12] as const,
  /** Findings per criterion. */
  maxFindings: 4,
} as const;

// ---------------------------------------------------------------------------------------------
// What the in-page kit reports.

export interface OvRect { x: number; y: number; w: number; h: number }

/** A box that stays on screen while the page scrolls (position fixed, or sticky while stuck). */
export interface OvRoot {
  /** Index into the kit's roots (stable for the run). */
  ref: number;
  path: string;
  /** Its accessible name or text (max 60 characters). */
  name: string;
  /** What it looks like from its markup: translate, chat, cookie, accessibility, back-to-top, notice, or ''. */
  kind: string;
  pos: 'fixed' | 'sticky';
  /** Viewport box when first seen at this width. */
  rect: OvRect;
  /** Share of the screen its box covers when first seen (0–1). */
  share: number;
  /** A full-width bar at the top or bottom edge, at most a third of the screen high (the page's header or footer). */
  bar: boolean;
  /**
   * It IS a dialog (role dialog or alertdialog, aria-modal, or an open <dialog>) with its own close
   * button inside it, reachable by keyboard. Data only since 2026-11-07: a box passes 1.4.10 when the
   * test proves it can be closed (`dismiss`), dialog or not.
   */
  dialog: boolean;
  /** A skip link. */
  skip: boolean;
  /**
   * Most of the 320 px grid it covers at one scroll position (0 when not measured), and where.
   */
  paint: number;
  paintAt: number;
  /**
   * For a fixed box painting more than `areaLow` at 320 px: lines of the page's text (up to 3 counted)
   * that stay under it at every scroll position (no scroll position shows them in the strip it leaves).
   */
  stuck?: number;
}

/** A control a counted root covers at some scroll position. */
export interface OvCover {
  root: number;
  control: number;
  path: string;
  name: string;
  role: 'link' | 'button' | 'form field' | 'control';
  /** Scroll position (window.scrollY) where it was first seen covered, and both boxes there (0: the first screen, as the page opens). */
  at: number;
  rect: OvRect;
  rootRect: OvRect;
  /**
   * Seen in full and clear of every counted root at some scroll position (it can be read and used):
   * true; never clear after a finished sweep and all three tries (top, middle, bottom): false; not
   * checked (the sweep was cut, or more controls than `verify`, or it left the page, or a try could
   * not place it on the screen): null, unknown. A control the screen cannot hold whole (taller or
   * wider than it) is clear once every point a root covered has been seen uncovered at some position.
   */
  reachable: boolean | null;
}

/**
 * Why a width's sweep did not finish: time ran out, more covered controls than `verify`, more
 * controls in view than `maxControls`, or the page's floating content kept changing from one sweep
 * to the next (`agreedSweep`).
 */
export type OvCut = 'time' | 'verify' | 'controls' | 'unstable';

export interface OvSweep {
  ok: true;
  vw: number;
  vh: number;
  maxScroll: number;
  steps: number;
  roots: OvRoot[];
  covers: OvCover[];
  title: string;
  text: number;
  /** The sweep did not finish (false when it did): what it did not check is unknown, never a failure. */
  cut: false | OvCut;
  /** The page's layout (`layoutOf`) when the sweep started, and back at the top when it ended. */
  layout: string;
  layoutEnd: string;
}

/** One focus stop after Tab or Shift+Tab. */
export interface OvFocus {
  /** Measured with the press (`FocusArg.after`) but its keyup never came in time: measure again. */
  missed?: boolean;
  /** Tab and Shift keyups this document saw so far (to send the next check with the next press). */
  keys?: { tab: number; shift: number };
  /** No element has focus (focus left the page). */
  none?: boolean;
  /** Focus is inside a frame (not measured here). */
  frame?: boolean;
  control?: number;
  path?: string;
  name?: string;
  role?: OvCover['role'];
  box?: OvRect;
  /** 5×5 grid over its visible part; `by` is a root ref as a string. */
  grid?: GridPoint[];
  roots?: OvRoot[];
}

interface Kit {
  sweep(arg: SweepArg): Promise<OvSweep>;
  /** The page's size at the top (scroll height and width): what a sweep's positions depend on. */
  layout(): string;
  /** Waits until the page stops changing (`OVERLAY_LIMITS.quietMs`), at most `maxMs`; true when it did. */
  settle(arg: { quietMs: number; maxMs: number }): Promise<boolean>;
  /** Moves the focus starting point to the top; the Tab and Shift keyups seen so far. */
  focusStart(): { tab: number; shift: number };
  focusCheck(arg: FocusArg): Promise<OvFocus>;
  /** Stops counting key presses (when the kit is removed). */
  stop(): void;
  place(arg: { y: number; root: number; control?: number }): Promise<{ root: OvRect | null; control: OvRect | null; title: string; sy: number }>;
  blur(): void;
}

/**
 * A focus check. With `after`, it is sent together with the key press (one round trip on a remote
 * browser) and first waits, in the page, until the press's last keyup (`key`) has been seen `n`
 * times (at most `cap` ms; then `missed`), one task and one frame more for the page's own handlers.
 */
interface FocusArg {
  settleMs: number;
  after?: { key: 'Tab' | 'Shift'; n: number; cap: number };
}

interface SweepArg {
  maxSteps: number;
  verify: number;
  maxControls: number;
  area: boolean;
  grid: readonly [number, number];
  budgetMs: number;
  /** Epoch ms by which the sweep returns whatever it has (it stops itself; the caller's race cannot). */
  until: number;
  /** Epoch ms when the caller sent the call (a page whose clock is far off is timed from this instead). */
  sentAt: number;
}

interface KitConfig {
  opaque: number;
  barHeight: number;
  barWidth: number;
  dialogShare: number;
  /** `OVERLAY_LIMITS.areaLow`: from this share up, a fixed box is checked for text it hides at every scroll position. */
  areaLow: number;
}

// ---------------------------------------------------------------------------------------------
// The in-page kit (self-contained: serialized into the page).

/**
 * Runs in the page (self-contained). Installs `window.__grntedOverlay`, the measuring kit (replacing
 * anything the page put there); true when it is installed. It changes nothing on the page; `overlayDrop` removes it.
 */
export function installOverlayKit(cfg: KitConfig): boolean {
  // Always a fresh kit: never one the page put there.
  try {
    delete (window as unknown as { __grntedOverlay?: Kit }).__grntedOverlay;
  } catch {
    return false;
  }
  const de = document.documentElement;
  const SEL = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
  const CLOSE = /\b(close|dismiss|accept|agree|got it|ok|okay|no,? thanks|reject|decline|deny|allow|continue|hide|minimi[sz]e)\b|^\s*[×✕✖xX]\s*$/i;
  const SKIP = /\b(skip|jump)\b.*\b(content|main|navigation|nav|menu)\b|^\s*skip\b/i;
  const roots: Element[] = [];
  const rootIds = new Map<Element, number>();
  const controls: Element[] = [];
  const controlIds = new Map<Element, number>();
  const idIn = (list: Element[], ids: Map<Element, number>, el: Element) => {
    let i = ids.get(el);
    if (i === undefined) {
      i = list.length;
      list.push(el);
      ids.set(el, i);
    }
    return i;
  };
  const parentOf = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  const deepContains = (a: Element, b: Element): boolean => {
    for (let cur: Element | null = b, i = 0; cur && i < 200; cur = parentOf(cur), i++) if (cur === a) return true;
    return false;
  };
  const vw = () => de.clientWidth || innerWidth;
  const vh = () => de.clientHeight || innerHeight;
  const maxScroll = () => Math.max(0, (document.scrollingElement ?? de).scrollHeight - vh());
  const clean = (s: string | null | undefined, n = 60) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el, i = 0; cur && i < 40; cur = cur.parentElement, i++) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const nameOf = (el: Element): string => {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return clean(label);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (t.trim()) return clean(t);
    }
    const f = el as HTMLInputElement;
    if (f.labels && f.labels.length) return clean(f.labels[0]!.textContent);
    const text = clean((el as HTMLElement).innerText ?? el.textContent);
    if (text) return text;
    const img = el.localName === 'img' ? el : el.querySelector('img[alt]');
    if (img && img.getAttribute('alt')) return clean(img.getAttribute('alt'));
    return clean(el.getAttribute('title') || f.placeholder || (typeof f.value === 'string' && /^(button|submit|reset)$/.test(f.type) ? f.value : ''));
  };
  const roleOf = (el: Element): OvCover['role'] => {
    const r = el.getAttribute('role');
    if (el.localName === 'a' || el.localName === 'area' || r === 'link') return 'link';
    if (el.localName === 'button' || el.localName === 'summary' || r === 'button') return 'button';
    if (el.localName === 'input') return /^(button|submit|reset|image)$/.test((el as HTMLInputElement).type) ? 'button' : 'form field';
    if (el.localName === 'select' || el.localName === 'textarea') return 'form field';
    return 'control';
  };
  const kindOf = (el: Element): string => {
    let s = '';
    const add = (e: Element) => { s += ` ${e.id} ${typeof e.className === 'string' ? e.className : ''} ${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('src') ?? ''}`; };
    add(el);
    const inner = el.querySelectorAll('*');
    for (let i = 0; i < inner.length && i < 30; i++) add(inner[i]!);
    s = `${s} ${clean((el as HTMLElement).innerText, 80)}`.toLowerCase();
    if (/translat|gtranslate|weglot|google_translate|language.?(switch|select|picker)/.test(s)) return 'translate';
    if (/cookie|consent|gdpr|ccpa/.test(s)) return 'cookie';
    if (/chat|chatbot|messenger|livechat|intercom|drift|zendesk|tawk|crisp/.test(s)) return 'chat';
    if (/accessib|userway|audioeye|equalweb|accessibe/.test(s)) return 'accessibility';
    if (/back.?to.?top|scroll.?(to.?)?top|to-top|gotop/.test(s)) return 'back-to-top';
    if (/promo|popup|pop-up|newsletter|subscribe|announce|alert|notice|banner|emergency/.test(s)) return 'notice';
    return '';
  };
  const alphaOf = (color: string): number => {
    if (!color || color === 'transparent') return 0;
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (!m) return 1;
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parts[3]!;
    return a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a);
  };
  const opacityChain = (el: Element): number => {
    let o = 1;
    for (let cur: Element | null = el, i = 0; cur && i < 60; cur = parentOf(cur), i++) {
      o *= parseFloat(getComputedStyle(cur).opacity) || 0;
      if (o <= 0) return 0;
    }
    return o;
  };
  /** The element hides what is under it: a solid background or image, or replaced content, and not see-through. */
  const isOpaque = (c: Element): boolean => {
    const cs = getComputedStyle(c);
    if (cs.visibility !== 'visible') return false;
    const replaced = /^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED)$/i.test(c.tagName);
    if (!replaced && alphaOf(cs.backgroundColor) < cfg.opaque && cs.backgroundImage === 'none') return false;
    return opacityChain(c) >= cfg.opaque;
  };
  const toRect = (r: DOMRect): OvRect => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  // Per scroll position: computed positions and stuck checks change when the page scrolls.
  let posCache = new Map<Element, string>();
  let pinCache = new Map<Element, boolean>();
  const posOf = (el: Element) => {
    let p = posCache.get(el);
    if (p === undefined) posCache.set(el, (p = getComputedStyle(el).position));
    return p;
  };
  const shellCache = new Map<Element, boolean>();
  let bodyText = -1;
  const shown = (el: Element) => ((el as HTMLElement).innerText ?? '').length;
  /** The page's own frame: a fixed box holding the main content (an app shell that scrolls inside itself). */
  const isShell = (el: Element): boolean => {
    let s = shellCache.get(el);
    if (s !== undefined) return s;
    const main = document.querySelector('main, [role="main"]');
    const body = document.body;
    if (bodyText < 0) bodyText = body ? shown(body) : 0;
    const all = bodyText;
    const r = el.getBoundingClientRect();
    s = (!!main && deepContains(el, main))
      || (all > 200 && shown(el) > all * 0.5)
      || (r.width * r.height >= vw() * vh() * 0.9 && el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
    shellCache.set(el, s);
    return s;
  };
  /** A sticky element stuck to an edge of the screen now (not inside a box that scrolls by itself). */
  const stuck = (el: Element): boolean => {
    for (let a = parentOf(el), i = 0; a && a !== document.body && a !== de && i < 60; a = parentOf(a), i++) {
      const s = getComputedStyle(a);
      if (/(auto|scroll|hidden|overlay)/.test(`${s.overflowX} ${s.overflowY}`)) return false;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.top !== 'auto' && scrollY > 0 && Math.abs(r.top - parseFloat(cs.top)) <= 1.5) return true;
    if (cs.bottom !== 'auto' && scrollY < maxScroll() - 1 && Math.abs(vh() - r.bottom - parseFloat(cs.bottom)) <= 1.5) return true;
    return false;
  };
  const pinned = (el: Element): boolean => {
    let p = pinCache.get(el);
    if (p !== undefined) return p;
    const pos = posOf(el);
    p = el !== de && el !== document.body && (pos === 'fixed' || (pos === 'sticky' && stuck(el))) && !isShell(el);
    pinCache.set(el, p);
    return p;
  };
  /** The outermost box that stays on screen holding `c` and not holding `not`; null when there is none. */
  const rootOf = (c: Element, not?: Element): Element | null => {
    let best: Element | null = null;
    for (let cur: Element | null = c, i = 0; cur && i < 80; cur = parentOf(cur), i++) {
      if (cur === de || cur === document.body) break;
      const p = posOf(cur);
      if ((p === 'fixed' || p === 'sticky') && pinned(cur) && (!not || !deepContains(cur, not))) best = cur;
    }
    return best;
  };
  const visible = (el: Element): boolean => {
    const e = el as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return !el.closest('[inert], [aria-hidden="true"]');
  };
  /** The visible box of a root: its own box, or its children's when it has no size of its own. */
  const boxOf = (el: Element): DOMRect => {
    const r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) return r;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const inner = el.querySelectorAll('*');
    for (let i = 0; i < inner.length && i < 50; i++) {
      const b = inner[i]!.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    return x1 > x0 ? new DOMRect(x0, y0, x1 - x0, y1 - y0) : r;
  };
  const shareOf = (r: DOMRect) => {
    const w = Math.max(0, Math.min(r.right, vw()) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh()) - Math.max(r.top, 0));
    return (w * h) / Math.max(1, vw() * vh());
  };
  /** Facts about a root, per width (measured when first seen at that width). */
  let info = new Map<Element, OvRoot>();
  const rootInfo = (el: Element): OvRoot => {
    let o = info.get(el);
    if (o) return o;
    const r = boxOf(el);
    const share = shareOf(r);
    const bar = r.width >= vw() * cfg.barWidth && (r.top <= 2 || r.bottom >= vh() - 2) && r.height <= vh() * cfg.barHeight + 0.5;
    // Only a box that IS the dialog: a box that merely holds one (a promotion with a small dialog in it) is not.
    const isDialog = el.matches('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]');
    let close = false;
    if (isDialog) {
      const cands = el.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"], input[type="reset"]');
      for (let i = 0; i < cands.length && i < 40 && !close; i++) {
        const c = cands[i] as HTMLElement;
        if ((c as HTMLButtonElement).disabled || c.tabIndex < 0 || !visible(c)) continue;
        const b = c.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        if (CLOSE.test(nameOf(c)) || CLOSE.test(c.getAttribute('title') ?? '')) close = true;
      }
    }
    const text = clean((el as HTMLElement).innerText ?? el.textContent, 200);
    const skip = text.length < 80 && SKIP.test(text) && !!el.querySelector('a[href^="#"]') || (el.localName === 'a' && SKIP.test(text) && (el.getAttribute('href') ?? '').startsWith('#'));
    o = {
      ref: idIn(roots, rootIds, el), path: cssPath(el), name: nameOf(el), kind: kindOf(el), pos: posOf(el) === 'sticky' ? 'sticky' : 'fixed',
      rect: toRect(r), share: Math.round(share * 1000) / 1000, bar, dialog: isDialog && close, skip, paint: 0, paintAt: 0,
    };
    info.set(el, o);
    return o;
  };
  /** Counts for covering a control (1.4.10): not the page's header or footer bar, not a skip link. A dialog counts. */
  const counted = (o: OvRoot) => !o.bar && !o.skip;
  type Point = { k: 's' | 'f' | 'o' | 'm'; r?: Element };
  /** What is at (x, y) over control `el`: it shows (s), a root covers it (f), other content does (o), or it is not there (m). */
  const classify = (el: Element, x: number, y: number): Point => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const src = typeof (root as Document).elementsFromPoint === 'function' ? root : document;
    const list = src.elementsFromPoint(x, y);
    const at = list.findIndex((c) => c === el || el.contains(c));
    if (at < 0) return { k: 'm' };
    for (let i = 0; i < at; i++) {
      const c = list[i]!;
      if (c.contains(el) || !isOpaque(c)) continue;
      const r = rootOf(c, el);
      return r ? { k: 'f', r } : { k: 'o' };
    }
    return { k: 's' };
  };
  type Box = { x: number; y: number; w: number; h: number };
  const minusBox = (a: Box, b: Box): Box[] => {
    const x0 = Math.max(a.x, b.x); const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w); const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return [a];
    const out: Box[] = [];
    if (y0 > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: y0 - a.y });
    if (y1 < a.y + a.h) out.push({ x: a.x, y: y1, w: a.w, h: a.y + a.h - y1 });
    if (x0 > a.x) out.push({ x: a.x, y: y0, w: x0 - a.x, h: y1 - y0 });
    if (x1 < a.x + a.w) out.push({ x: x1, y: y0, w: a.x + a.w - x1, h: y1 - y0 });
    return out;
  };
  /**
   * 2.4.11, exactly (2026-11-07, simulation lab: a 1 px strip that a 5×5 grid misses): whether any part of
   * the element's visible parts (`views`, in the viewport) is not under an opaque box that stays on screen (a counted root, not a skip link).
   * The parts are cut by each covering box found, and the centre of the largest part left is hit-tested
   * again, until a point shows the element (or other, non-fixed content) or nothing is left. WCAG says
   * "entirely hidden": any part that shows is enough (parts under a quarter of a pixel are rounding).
   */
  const someShows = (el: Element, views: Box[]): boolean => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const src = typeof (root as Document).elementsFromPoint === 'function' ? root : document;
    let rest: Box[] = views.filter((v) => v.w > 0.25 && v.h > 0.25);
    for (let n = 0; n < 32 && rest.length; n++) {
      rest.sort((a, b) => b.w * b.h - a.w * a.h);
      const r = rest[0]!;
      // A visible part holds at least one whole pixel (a sliver of a pixel at the edge of a cover is not something
      // anyone sees: ltd.org's link 0.6 px below its header, 2026-11-07 audit); hit testing reads whole pixels too
      // (a fractional point is rounded up), so the part is sampled at a whole-pixel point inside it.
      const inside = (lo: number, len: number) => {
        const v = Math.max(Math.ceil(lo), Math.floor(lo + len / 2));
        return v + 1 <= lo + len + 1e-6 ? v : Math.ceil(lo) + 1 <= lo + len + 1e-6 ? Math.ceil(lo) : null;
      };
      const x = inside(r.x, r.w);
      const y = inside(r.y, r.h);
      if (x === null || y === null) { rest.shift(); continue; }
      const list = src.elementsFromPoint(x, y);
      const at = list.findIndex((c) => c === el || el.contains(c));
      // The element is not at this point (cut away by a parent): no visible part there.
      let cut: Box = { x: x - 0.5, y: y - 0.5, w: 1, h: 1 };
      if (at >= 0) {
        let cover: Element | null = null;
        for (let k = 0; k < at; k++) {
          const c = list[k]!;
          if (c.contains(el) || !isOpaque(c)) continue;
          const fr = rootOf(c, el);
          if (!fr || rootInfo(fr).skip) return true;
          cover = c;
          break;
        }
        if (!cover) return true;
        const b = cover.getBoundingClientRect();
        if (b.left <= x && x <= b.right && b.top <= y && y <= b.bottom) cut = { x: b.left, y: b.top, w: b.width, h: b.height };
      }
      rest = rest.flatMap((p) => minusBox(p, cut)).filter((p) => p.w > 0.25 && p.h > 0.25);
    }
    return false;
  };
  /**
   * Where a control's name is shown: the centres of up to three of its text lines (the visible text of a
   * link or button; none for a field or an icon, whose middle stands for it).
   */
  const namePoints = (el: Element): [number, number][] => {
    if (el.matches('input, select, textarea')) return [];
    const out: [number, number][] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(), i = 0; n && i < 40 && out.length < 3; n = walker.nextNode(), i++) {
      if (!(n.nodeValue ?? '').trim()) continue;
      range.selectNodeContents(n);
      for (const b of Array.from(range.getClientRects())) {
        if (b.width < 1 || b.height < 1) continue;
        out.push([b.left + b.width / 2, b.top + b.height / 2]);
        if (out.length >= 3) break;
      }
    }
    return out;
  };
  const pointsOf = (r: DOMRect): [number, number][] => {
    const ix = Math.min(3, r.width / 4);
    const iy = Math.min(3, r.height / 4);
    return [[r.left + r.width / 2, r.top + r.height / 2], [r.left + ix, r.top + iy], [r.right - ix, r.top + iy], [r.left + ix, r.bottom - iy], [r.right - ix, r.bottom - iy]];
  };
  const frames = () => new Promise<void>((res) => {
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 120);
  });
  const scrollToY = async (y: number) => {
    window.scrollTo({ left: 0, top: y, behavior: 'instant' as ScrollBehavior });
    await frames();
    posCache = new Map();
    pinCache = new Map();
  };
  /**
   * Lines of the page's text (up to 3) that box `root` (fixed, at viewport box `b`) hides at every scroll
   * position from 0 to `M`: for each text line under the box's width, no scroll position puts its middle
   * (half a line clear) in the strip above or below the box. Text inside boxes that stay on screen is not
   * the page's.
   */
  const stuckUnder = (root: Element, b: DOMRect, M: number, H: number): number => {
    let n = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const meets = (lo: number, hi: number) => lo <= hi && Math.max(lo, 0) <= Math.min(hi, M);
    for (let t = walker.nextNode(), i = 0; t && i < 4000 && n < 3; t = walker.nextNode(), i++) {
      if ((t.nodeValue ?? '').trim().length < 2) continue;
      const p = t.parentElement;
      if (!p || deepContains(root, p) || p.closest('script, style, noscript, template') || !visible(p) || rootOf(p)) continue;
      range.selectNodeContents(t);
      // Every line of it (a paragraph's last lines are the ones a bottom box keeps).
      for (const r of Array.from(range.getClientRects()).slice(0, 40)) {
        if (r.width < 1 || r.height < 1) continue;
        const cx = r.left + r.width / 2;
        if (cx < b.left || cx > b.right) continue;
        const cy = r.top + r.height / 2 + scrollY;
        const hh = r.height / 2;
        const above = meets(cy - (b.top - hh), cy - hh);
        const below = meets(cy - (H - hh), cy - (b.bottom + hh));
        if (!above && !below && ++n >= 3) break;
      }
    }
    return n;
  };
  /**
   * One control at the current scroll position: the counted roots covering it, whether it shows whole
   * and clear, and which of its five points (centre, corners) show (`shown`) or a counted root covers
   * (`covered`), as bit masks. `fits`: the screen can hold it whole (not taller or wider than the
   * screen, and not off its sides, which scrolling down never changes).
   */
  const look = (el: Element) => {
    const r = el.getBoundingClientRect();
    const W = vw();
    const H = vh();
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= W || r.bottom <= 0 || r.top >= H) return null;
    const by = new Set<Element>();
    const masks = new Map<Element, number>();
    let shows = 0;
    let shown = 0;
    let covered = 0;
    let hit = 0;
    // Points 0-4: the middle and the corners; 5-7: the middle of its name's text lines.
    [...pointsOf(r), ...namePoints(el)].forEach(([x, y], i) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const p = classify(el, x, y);
      if (p.k !== 'm') hit++;
      if (p.k === 's') { shows++; shown |= 1 << i; }
      else if (p.k === 'f' && p.r && counted(rootInfo(p.r))) { masks.set(p.r, (masks.get(p.r) ?? 0) | (1 << i)); covered |= 1 << i; }
    });
    // A box covers the control where it hides its middle, its name (any of its text lines' middles) or three or
    // more of its corners, or anywhere when both stay on screen (the control in a fixed or sticky box of its own,
    // under another): scrolling never moves one off the other, so any part hidden stays hidden. A corner or a
    // side under a box that scrolling moves leaves the control readable and usable (2026-11-07 audit: beaverton-sd).
    const pinnedSelf = !!rootOf(el);
    const corners = (m: number) => [1, 2, 3, 4].filter((b) => m & (1 << b)).length;
    for (const [root, m] of masks) if ((m & ~0b11110) !== 0 || corners(m) >= 3 || (pinnedSelf && !deepContains(root, el))) by.add(root);
    const whole = r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1;
    const fits = r.width <= W + 1 && r.height <= H + 1 && r.left >= -1 && r.right <= W + 1;
    // `placed`: some point of it is on the screen and hit (not clipped away by a box that scrolls by itself).
    return { r, by, clear: whole && !by.size && shows > 0, fits, shown, covered, placed: hit > 0 };
  };
  /** Points of each control seen shown, and seen covered by a counted root, over the sweep (bit masks). */
  let marks = new Map<number, { shown: number; covered: number }>();
  /**
   * Records a look at control `id`; true when it counts as clear: seen whole and clear, or, for a
   * control the screen cannot hold whole, every point a root covered has shown uncovered at some
   * scroll position (and some point has shown).
   */
  const seen = (id: number, l: NonNullable<ReturnType<typeof look>>): boolean => {
    let m = marks.get(id);
    if (!m) marks.set(id, (m = { shown: 0, covered: 0 }));
    m.shown |= l.shown;
    m.covered |= l.covered;
    if (l.clear) return true;
    // Every part of it a box hid has shown at another scroll position: a control taller than the strip the
    // boxes leave (a card) is read and used a part at a time (2026-11-07 audit: boise, manzanita).
    return m.shown !== 0 && (m.covered & ~m.shown) === 0;
  };
  const layoutOf = () => {
    const se = document.scrollingElement ?? de;
    return `${se.scrollHeight}x${se.scrollWidth}`;
  };
  // Tab and Shift keyups, counted before the page's own handlers (a focus check sent with a press
  // waits for its keyup: `FocusArg.after`).
  const keyCount = { tab: 0, shift: 0 };
  let keyWaiter: (() => void) | null = null;
  const onKeyup = (e: KeyboardEvent) => {
    if (e.key === 'Tab') keyCount.tab++;
    else if (e.key === 'Shift') keyCount.shift++;
    keyWaiter?.();
  };
  addEventListener('keyup', onKeyup, true);
  const kit: Kit = {
    stop() {
      removeEventListener('keyup', onKeyup, true);
    },
    layout: layoutOf,
    async settle(arg) {
      const t0 = performance.now();
      // Size, number of elements and the classes on html and body (a script marking a widget as
      // running, which the page's CSS makes room for).
      const now = () => `${layoutOf()}|${document.getElementsByTagName('*').length}|${de.className}|${document.body?.className ?? ''}`;
      let last = now();
      let since = performance.now();
      while (performance.now() - t0 < arg.maxMs) {
        await new Promise((r) => setTimeout(r, 100));
        const cur = now();
        if (cur !== last) { last = cur; since = performance.now(); }
        else if (performance.now() - since >= arg.quietMs) return true;
      }
      return false;
    },
    async sweep(arg) {
      const t0 = performance.now();
      const layout = layoutOf();
      // `until` is the caller's deadline, so the sweep stops itself in time. The page's own clock is
      // trusted only when it agrees with the caller's (a page may fake Date.now); otherwise the time
      // left when the call was sent counts from now.
      const skew = Date.now() - arg.sentAt;
      const hard = t0 + Math.max(0, skew >= 0 && skew < 60_000 ? arg.until - Date.now() : arg.until - arg.sentAt);
      const stepsEnd = Math.min(t0 + arg.budgetMs, hard);
      const verifyEnd = Math.min(t0 + arg.budgetMs * 1.5, hard);
      info = new Map();
      marks = new Map();
      const W = vw();
      const H = vh();
      const total = maxScroll();
      const stride = Math.max(H * 0.75, total / Math.max(1, arg.maxSteps - 1));
      const ys: number[] = [];
      for (let y = 0; y < total && ys.length < arg.maxSteps - 1; y += stride) ys.push(Math.round(y));
      if (!ys.length || ys[ys.length - 1] !== total) ys.push(Math.round(total));
      const covers = new Map<string, OvCover>();
      /** Each root's box where it painted most (for `stuckUnder`, without scrolling there again). */
      const paintRects = new Map<Element, DOMRect>();
      const clear = new Set<number>();
      const never = new Set<number>();
      let cut: false | OvCut = false;
      const late = (end: number) => performance.now() > end;
      let steps = 0;
      for (const y of ys) {
        if (late(stepsEnd)) { cut = 'time'; break; }
        await scrollToY(y);
        if (late(stepsEnd)) { cut = 'time'; break; }
        const sy = Math.round(scrollY);
        const found = document.querySelectorAll(SEL);
        let looked = 0;
        let done = true;
        for (let i = 0; i < found.length; i++) {
          if (late(stepsEnd)) { done = false; cut = 'time'; break; }
          const el = found[i]!;
          const r0 = el.getBoundingClientRect();
          if (r0.bottom <= 0 || r0.top >= H || r0.right <= 0 || r0.left >= W || !visible(el)) continue;
          if (++looked > arg.maxControls) { cut = cut || 'controls'; break; }
          const l = look(el);
          if (!l) continue;
          const id = idIn(controls, controlIds, el);
          if (seen(id, l)) clear.add(id);
          for (const root of l.by) {
            const o = rootInfo(root);
            const key = `${o.ref}:${id}`;
            if (!covers.has(key)) {
              covers.set(key, {
                root: o.ref, control: id, path: cssPath(el), name: nameOf(el), role: roleOf(el), at: sy,
                rect: toRect(l.r), rootRect: toRect(boxOf(root)), reachable: null,
              });
            }
          }
        }
        if (!done) break;
        if (arg.area) {
          const [cols, rows] = arg.grid;
          const hits = new Map<Element, number>();
          for (let i = 0; i < cols && done; i++) {
            if (late(stepsEnd)) { done = false; cut = 'time'; break; }
            for (let j = 0; j < rows; j++) {
              const list = document.elementsFromPoint(((i + 0.5) * W) / cols, ((j + 0.5) * H) / rows);
              const top = list[0];
              if (!top) continue;
              const root = rootOf(top);
              if (!root) continue;
              // Painted: something solid of the root at this point, above the page.
              let painted = false;
              for (const c of list) {
                if (!deepContains(root, c)) break;
                if (isOpaque(c)) { painted = true; break; }
              }
              if (painted) hits.set(root, (hits.get(root) ?? 0) + 1);
            }
          }
          // A partial grid only undercounts, so a share it does reach stands.
          for (const [root, n] of hits) {
            const o = rootInfo(root);
            const share = Math.round((n / (cols * rows)) * 1000) / 1000;
            if (share > o.paint) { o.paint = share; o.paintAt = sy; paintRects.set(root, boxOf(root)); }
          }
        }
        steps++;
        if (!done) break;
      }
      // Covered controls never seen whole and clear: tried with the control at the top, the middle and
      // the bottom of the screen, in document order, up to `verify` of them. Only after every scroll
      // position was looked at: a control is unreachable only when none of them showed it clear either.
      if (cut !== 'time') {
        const ids = [...new Set([...covers.values()].filter((c) => !clear.has(c.control)).map((c) => c.control))]
          .filter((id) => controls[id]!.isConnected)
          .sort((a, b) => (controls[a]!.compareDocumentPosition(controls[b]!) & 4 /* DOCUMENT_POSITION_FOLLOWING */ ? -1 : 1));
        if (ids.length > arg.verify) cut = cut || 'verify';
        verify: for (const id of ids.slice(0, arg.verify)) {
          const el = controls[id]!;
          // Tries that placed it on the screen: a try that could not (it is off the screen, or clipped
          // away by a box that scrolls by itself, or the page moved it) proves nothing, so the control
          // stays unknown.
          let tries = 0;
          for (const place of ['top', 'middle', 'bottom'] as const) {
            if (late(verifyEnd)) { cut = 'time'; break verify; }
            if (!el.isConnected) break;
            const r = el.getBoundingClientRect();
            const docY = r.top + scrollY;
            const want = place === 'top' ? docY - 8 : place === 'middle' ? docY + r.height / 2 - H / 2 : docY + r.height - H + 8;
            await scrollToY(Math.max(0, Math.min(maxScroll(), Math.round(want))));
            const l = look(el);
            if (!l || !l.placed) continue;
            tries++;
            if (seen(id, l)) { clear.add(id); break; }
          }
          if (tries === 3 && !clear.has(id)) never.add(id);
        }
      }
      for (const c of covers.values()) c.reachable = clear.has(c.control) ? true : never.has(c.control) ? false : null;
      // Fixed boxes between `areaLow` and the area line: text they hide at every scroll position.
      // Measured from the box where it painted most and the text's place in the page, without scrolling again (a
      // scroll here can change a header that becomes fixed only once the page scrolls, and the sweeps then disagree).
      // On every page, long ones included: the end of a long article under a fixed bottom panel is text no scroll
      // position shows (Grok round 2).
      if (arg.area && cut !== 'time') {
        for (const [el, o] of info) {
          const b = paintRects.get(el);
          if (!b || o.pos !== 'fixed' || !counted(o) || o.paint <= cfg.areaLow || !el.isConnected) continue;
          // Out of time: unknown, never a clean result.
          if (late(verifyEnd)) { cut = cut || 'time'; break; }
          o.stuck = stuckUnder(el, b, total, H);
        }
      }
      await scrollToY(0);
      return {
        ok: true, vw: W, vh: H, maxScroll: Math.round(total), steps, roots: [...info.values()], covers: [...covers.values()],
        title: clean(document.title, 80), text: clean(document.body?.innerText, 400).length, cut, layout, layoutEnd: layoutOf(),
      };
    },
    focusStart() {
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
      // Focusing the body (briefly focusable) moves the sequential focus starting point to the top.
      const b = document.body;
      if (!b) return { ...keyCount };
      const had = b.getAttribute('tabindex');
      b.tabIndex = -1;
      b.focus({ preventScroll: true });
      if (had === null) b.removeAttribute('tabindex');
      else b.setAttribute('tabindex', had);
      return { ...keyCount };
    },
    async focusCheck(arg) {
      if (arg.after) {
        const { key, n, cap } = arg.after;
        const seen = () => (key === 'Tab' ? keyCount.tab : keyCount.shift) >= n;
        if (!seen()) {
          const ok = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => { keyWaiter = null; resolve(false); }, cap);
            keyWaiter = () => { if (seen()) { clearTimeout(timer); keyWaiter = null; resolve(true); } };
          });
          if (!ok) return { missed: true, keys: { ...keyCount } };
        }
        // The page's own handlers for the keyup (and what they queued at once) run first.
        await new Promise((r) => setTimeout(r, 0));
      }
      // The page may scroll smoothly to the focused element: wait until it stands still (bounded).
      const t0 = performance.now();
      let last = `${scrollX},${scrollY}`;
      let same = 0;
      while (performance.now() - t0 < arg.settleMs) {
        await frames();
        const now = `${scrollX},${scrollY}`;
        same = now === last ? same + 1 : 0;
        last = now;
        if (same >= 2) break;
      }
      posCache = new Map();
      pinCache = new Map();
      info = new Map();
      let el: Element | null = document.activeElement;
      for (let i = 0; el && (el as Element).shadowRoot?.activeElement && i < 20; i++) el = el.shadowRoot!.activeElement;
      if (!el || el === document.body || el === de) return { none: true, keys: { ...keyCount } };
      if (/^(iframe|frame|object|embed)$/.test(el.localName)) return { frame: true, keys: { ...keyCount } };
      const id = idIn(controls, controlIds, el);
      const r = el.getBoundingClientRect();
      const W = vw();
      const H = vh();
      const x0 = Math.max(0, r.left); const y0 = Math.max(0, r.top);
      const x1 = Math.min(W, r.right); const y1 = Math.min(H, r.bottom);
      const out: OvFocus = { control: id, path: cssPath(el), name: nameOf(el), role: roleOf(el), box: toRect(r), keys: { ...keyCount } };
      if (x1 - x0 < 2 || y1 - y0 < 2) return out;
      const at = (x: number, y: number): GridPoint => {
        const p = classify(el!, x, y);
        if (p.k !== 'f' || !p.r) return { k: p.k };
        const o = rootInfo(p.r);
        return o.skip ? { k: 'o' } : { k: 'f', by: String(o.ref) };
      };
      const center = at((x0 + x1) / 2, (y0 + y1) / 2);
      let grid: GridPoint[] = [center];
      if (center.k === 'f' || center.k === 'm') {
        grid = [];
        for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) grid.push(at(x0 + ((i + 0.5) * (x1 - x0)) / 5, y0 + ((j + 0.5) * (y1 - y0)) / 5));
      }
      // Every point that reached it is under a floating box: check the whole area exactly before calling it hidden.
      const reached = grid.filter((p) => p.k !== 'm');
      if (reached.length && reached.every((p) => p.k === 'f') && someShows(el, [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }])) grid.push({ k: 's' });
      out.grid = grid;
      out.roots = [...info.values()];
      return out;
    },
    async place(arg) {
      await scrollToY(arg.y);
      const root = roots[arg.root];
      const control = arg.control !== undefined ? controls[arg.control] : undefined;
      const rr = root && root.isConnected ? boxOf(root) : null;
      const cr = control && control.isConnected ? control.getBoundingClientRect() : null;
      return {
        root: rr && rr.width >= 1 && rr.height >= 1 ? toRect(rr) : null,
        control: cr && cr.width >= 1 && cr.height >= 1 ? toRect(cr) : null,
        title: clean(document.title, 80), sy: Math.round(scrollY),
      };
    },
    blur() {
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    },
  };
  try {
    Object.defineProperty(window, '__grntedOverlay', { value: kit, configurable: true, enumerable: false, writable: false });
  } catch {
    return false;
  }
  return (window as unknown as { __grntedOverlay?: Kit }).__grntedOverlay === kit;
}

/** Runs in the page (self-contained): removes the kit, blurs focus and scrolls back to the top. */
export function overlayDrop(): void {
  const w = window as unknown as { __grntedOverlay?: Kit };
  try {
    w.__grntedOverlay?.blur();
    w.__grntedOverlay?.stop();
  } catch {
    // The page may have replaced the kit.
  }
  try {
    delete w.__grntedOverlay;
  } catch {
    // Already gone.
  }
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
}

const kitSweep = (arg: SweepArg) => (window as unknown as { __grntedOverlay: Kit }).__grntedOverlay.sweep(arg);
const kitFocusStart = () => (window as unknown as { __grntedOverlay: Kit }).__grntedOverlay.focusStart();
const kitFocusCheck = (arg: FocusArg) => (window as unknown as { __grntedOverlay: Kit }).__grntedOverlay.focusCheck(arg);
const kitPlace = (arg: { y: number; root: number; control?: number }) => (window as unknown as { __grntedOverlay: Kit }).__grntedOverlay.place(arg);
const kitBlur = () => (window as unknown as { __grntedOverlay: Kit }).__grntedOverlay.blur();
const kitSettle = (arg: { quietMs: number; maxMs: number }) => (window as unknown as { __grntedOverlay: Kit }).__grntedOverlay.settle(arg);

// ---------------------------------------------------------------------------------------------
// Decisions (pure).

/** One width's results. */
export interface OverlayWidth {
  width: number;
  height: number;
  label: 'zoom' | 'phone';
  sweep: OvSweep;
  /** Focus stops entirely hidden behind a root (2.4.11). */
  hidden: { stop: OvFocus; root: OvRoot; dir: 'forward' | 'backward' }[];
  /** Tab stops measured. */
  stops: number;
}

/** Pictures taken in this run, per criterion (one each: the first width that fails, 320 px first). */
type Shots = Set<string>;

const rectText = (r: OvRect) => `${r.x},${r.y},${r.w},${r.h}`;
const quoted = (s: string) => `“${excerpt(s, 60)}”`;

const KIND_WORDS: Record<string, string> = {
  translate: 'a translate widget', chat: 'a chat button', cookie: 'a cookie banner', accessibility: 'an accessibility menu button',
  'back-to-top': 'a back-to-top button', notice: 'a notice or promotion',
};

/** "a box that stays on screen while the page scrolls (“English”, a translate widget)". */
export function overlayWords(o: Pick<OvRoot, 'name' | 'kind'>): string {
  const kind = KIND_WORDS[o.kind];
  const parts = [o.name ? quoted(o.name) : '', kind ?? ''].filter(Boolean).join(', ');
  return `a box that stays on screen while the page scrolls${parts ? ` (${parts})` : ''}`;
}

/** Short name for captions: “English” (translate widget), or the kind, or "floating box". */
export function overlayShortName(o: Pick<OvRoot, 'name' | 'kind'>): string {
  const kind = KIND_WORDS[o.kind]?.replace(/^an? /, '');
  if (o.name) return `${quoted(excerpt(o.name, 30))}${kind ? ` ${kind}` : ' box'}`;
  return kind ?? 'floating box';
}

const controlWords = (c: Pick<OvCover, 'role' | 'name'>) => (c.name ? `the ${c.role} ${quoted(c.name)}` : `an unnamed ${c.role}`);

const widthWords = (labels: readonly ('zoom' | 'phone')[]): string => {
  const zoom = labels.includes('zoom');
  const phone = labels.includes('phone');
  if (zoom && phone) return `At ${REFLOW_VIEWPORT.width} px wide and on a phone-sized screen (${PORTRAIT.width} px wide)`;
  return zoom ? `At ${REFLOW_VIEWPORT.width} px wide` : `On a phone-sized screen (${PORTRAIT.width} px wide)`;
};

/** A root counts for covering a control (1.4.10): not the page's header or footer bar, not a skip link. A dialog counts. */
export const countsForCover = (o: Pick<OvRoot, 'bar' | 'skip'>) => !o.bar && !o.skip;

/** A root counts for the area rule (more than 40% of the screen at 320 px) as for covering. */
export const countsForArea = (o: Pick<OvRoot, 'bar' | 'skip'>) => countsForCover(o);

/**
 * A covered control fails when the sweep checked it and no scroll position showed it whole and clear: what it
 * does is lost at that width (WCAG 1.4.10, "without loss of information or functionality"). A control a box
 * only passes over while the page scrolls, and that shows clear elsewhere, does not; nor does one the sweep did
 * not check (unknown). Review r1 of fix/redteam-visual, finding 7 (scoring v11): a control covered only on the
 * first screen, which scrolling brings clear, is no longer a failure (`coverAdvised`).
 */
export const coverFails = (c: Pick<OvCover, 'reachable'>) => c.reachable === false;

/** Covered on the first screen, as the page opens, and clear once the page is scrolled: a recommendation, never a failure. */
export const coverAdvised = (c: Pick<OvCover, 'at' | 'reachable'>) => c.at === 0 && c.reachable === true;

/** A fixed box that keeps some of the page's text under it wherever the page is scrolled: that text is lost (a failure). */
export const areaFails = (o: Pick<OvRoot, 'paint' | 'stuck'>) => o.paint > OVERLAY_LIMITS.areaLow && (o.stuck ?? 0) > 0;

/** A box over more than 40% of the screen that the content can be scrolled clear of: a recommendation, never a failure. */
export const areaAdvised = (o: Pick<OvRoot, 'paint' | 'stuck'>) => o.paint > OVERLAY_LIMITS.areaShare && !areaFails(o);

/**
 * Two sweeps of one width, combined into what both agree on. Boxes that stay on screen count only
 * when both sweeps found them at the same place; a covered control fails only when both sweeps
 * found it failing (the area rule: the smaller of the two shares). Anything they disagree on (a
 * box or a failure in one only, a different page size) is left out and the width is marked
 * 'unstable', so 1.4.10 is not_testable there unless a failure both agreed on stands. Two sweeps of
 * a page that holds still are the same, so this changes nothing for it.
 */
export function agreedSweep(a: OvSweep, b: OvSweep): { sweep: OvSweep; agreed: boolean } {
  const rootKey = (r: OvRoot) => `${r.ref}|${r.rect.x},${r.rect.y},${r.rect.w},${r.rect.h}|${r.bar}|${r.skip}|${r.dialog}|${r.pos}`;
  const inA = new Map(a.roots.map((r) => [r.ref, r]));
  let agreed = a.layout === b.layout && a.layoutEnd === b.layoutEnd && a.roots.length === b.roots.length;
  const roots: OvRoot[] = [];
  for (const r of b.roots) {
    const o = inA.get(r.ref);
    if (!o || rootKey(o) !== rootKey(r)) { agreed = false; continue; }
    if (areaFails(o) !== areaFails(r)) agreed = false;
    roots.push(o.paint < r.paint ? { ...r, paint: o.paint, paintAt: o.paintAt } : r);
  }
  const kept = new Set(roots.map((r) => r.ref));
  const key = (c: OvCover) => `${c.root}:${c.control}`;
  const coversA = new Map(a.covers.map((c) => [key(c), c]));
  const coversB = new Map(b.covers.map((c) => [key(c), c]));
  const covers: OvCover[] = [];
  for (const c of b.covers) {
    if (!kept.has(c.root)) continue;
    const o = coversA.get(key(c));
    const fails = coverFails(c);
    if (fails !== (!!o && coverFails(o))) { agreed = false; continue; }
    covers.push(c);
  }
  for (const c of a.covers) if (coverFails(c) && !coversB.has(key(c))) agreed = false;
  const cut = a.cut || b.cut || (agreed ? false : 'unstable' as const);
  return { sweep: { ...b, roots, covers, cut }, agreed };
}

/**
 * A width's result from all its sweeps, in order. Only finished sweeps (not cut) are compared: a
 * sweep that ran out of time (or was cut by a limit) adds nothing and takes nothing away.
 * - Two or more finished: what the last two agree on (`agreedSweep`; 'unstable' when they disagree).
 * - One finished: its result, and its failures stand (checked in full), but nothing confirmed it,
 *   so a clean 1.4.10 is unproven there (the cut of the sweep that did not finish, else 'time').
 * - None finished: the first sweep as it is (unfinished: only what it did check can fail).
 */
export function judgeSweeps(sweeps: readonly OvSweep[]): OvSweep {
  const finished = sweeps.filter((x) => !x.cut);
  if (finished.length >= 2) return agreedSweep(finished[finished.length - 2]!, finished[finished.length - 1]!).sweep;
  if (finished.length === 1) return { ...finished[0]!, cut: sweeps.find((x) => x.cut)?.cut || 'time' };
  return sweeps[0]!;
}

/** 1.4.10 problems at one width: per counted root, the controls it covers that fail (`coverFails`), and (at 320 px) its share of the screen. */
export function reflowProblems(w: OverlayWidth): { root: OvRoot; covered: OvCover[]; area: number }[] {
  const out: { root: OvRoot; covered: OvCover[]; area: number }[] = [];
  for (const root of w.sweep.roots) {
    if (!countsForCover(root)) continue;
    const covered = w.sweep.covers.filter((c) => c.root === root.ref && coverFails(c))
      // Controls checked and never clear first: they name the finding.
      .sort((a, b) => Number(a.reachable !== false) - Number(b.reachable !== false));
    // More than a fifth of the screen, fixed, with text that stays under it at every scroll position: that text is lost.
    const area = w.label === 'zoom' && countsForArea(root) && areaFails(root) ? root.paint : 0;
    if (covered.length || area) out.push({ root, covered, area });
  }
  return out;
}

/**
 * What a width only recommends changing (never a failure): per counted root, the controls it covers on the first
 * screen that scrolling brings clear, and (at 320 px) its share of the screen when over 40% with nothing lost under it.
 */
export function reflowAdvice(w: OverlayWidth): { root: OvRoot; covered: OvCover[]; area: number }[] {
  const out: { root: OvRoot; covered: OvCover[]; area: number }[] = [];
  for (const root of w.sweep.roots) {
    if (!countsForCover(root)) continue;
    const covered = w.sweep.covers.filter((c) => c.root === root.ref && coverAdvised(c));
    const area = w.label === 'zoom' && countsForArea(root) && areaAdvised(root) ? root.paint : 0;
    if (covered.length || area) out.push({ root, covered, area });
  }
  return out;
}

/**
 * Proves a floating box can be dismissed (Understanding 1.4.10) with `proveDismiss` (its rules there):
 * a control in it closes it by keyboard and it stays closed. Whether the page under it then reads without
 * scrolling sideways at 320 px is the reflow test's verdict (it knows what may scroll: maps, data tables),
 * not this box's: a page-wide sideways scroll check here failed a closable banner over a wide map.
 */
async function dismiss(ctx: ProbeContext, root: OvRoot): Promise<OvDismissal> {
  const r = await proveDismiss(ctx, root.path);
  if (!r.dismissed) return { why: r.why ?? 'it could not be closed' };
  return { closedBy: r.by!.name };
}

/** Why 1.4.10 is not_testable after an unfinished sweep at this width. */
export function cutWords(w: OverlayWidth): string {
  const where = w.label === 'zoom' ? `at ${w.width} px wide` : `on a phone-sized screen (${w.width} px wide)`;
  if (w.sweep.cut === 'verify') return `more links, buttons or fields are covered than the test checks one by one (${OVERLAY_LIMITS.verify}) ${where}`;
  if (w.sweep.cut === 'controls') return `the page has more links, buttons or fields in view than the test looks at (${OVERLAY_LIMITS.maxControls}) ${where}`;
  if (w.sweep.cut === 'unstable') return `the content that stays on screen kept changing while the test checked it ${where}`;
  return `the page took too long to check every covered link, button or field ${where}`;
}

/**
 * Findings from every width, one per floating box and criterion (at most `maxFindings` each), in the
 * order found. 1.4.10 fails when something is lost at that width: a box covers a link, button or field
 * wherever the page is scrolled, or keeps some of the page's text under it wherever the page is scrolled. A box
 * that covers a control only on the first screen, or more than 40% of the screen with nothing lost under it,
 * is a recommendation (`advice`), never a failure. 2.4.11: a focused control entirely hidden behind a box
 * that stays on screen.
 */
/**
 * What the test proved about closing a floating box that would fail 1.4.10 (by root ref): `closedBy`
 * names the control whose Enter closed it for good, with the page then readable without scrolling
 * sideways at 320 px; `why` says why it could not be closed (it then fails as before, with the reason).
 */
export type OvDismissal = { closedBy: string } | { why: string };

export function overlayFindings(widths: readonly OverlayWidth[], dismissed: ReadonlyMap<number, OvDismissal> = new Map()): ProbeFinding[] {
  const reflow = new Map<number, { root: OvRoot; covered: OvCover[]; area: number; where: ('zoom' | 'phone')[]; width: number }>();
  for (const w of widths) {
    for (const p of reflowProblems(w)) {
      // Understanding 1.4.10: sticky or fixed content that can be dismissed does not fail, at any size,
      // once the test closed it by keyboard and it stayed closed (2026-11-07 ruling).
      const d = dismissed.get(p.root.ref);
      if (d && 'closedBy' in d) continue;
      const had = reflow.get(p.root.ref);
      if (!had) reflow.set(p.root.ref, { ...p, where: [w.label], width: w.width });
      else {
        had.where.push(w.label);
        for (const c of p.covered) if (!had.covered.some((x) => x.control === c.control)) had.covered.push(c);
        had.area = Math.max(had.area, p.area);
      }
    }
  }
  const out: ProbeFinding[] = [];
  for (const p of [...reflow.values()].slice(0, OVERLAY_LIMITS.maxFindings)) {
    const d = dismissed.get(p.root.ref);
    const why = d && 'why' in d ? ` It cannot be closed: ${d.why}.` : '';
    const what = overlayWords(p.root);
    const first = p.covered[0];
    const pct = Math.round(p.area * 100);
    if (first) {
      const more = p.covered.length - 1;
      out.push({
        criterion: '1.4.10', status: 'failed', target: first.path,
        detail: `${widthWords(p.where)}, ${what} covers ${controlWords(first)} wherever the page is scrolled${more ? `; ${more === 1 ? '1 more link, button or field is' : `${more} more links, buttons or fields are`} covered too` : ''}${pct ? `, and it covers ${pct}% of the screen at ${REFLOW_VIEWPORT.width} px wide` : ''}.${why}`,
        data: { width: p.width, overlay: rectText(first.rootRect), control: rectText(first.rect), scrollY: first.at },
      });
    } else {
      out.push({
        criterion: '1.4.10', status: 'failed', target: p.root.path,
        detail: `At ${REFLOW_VIEWPORT.width} px wide, ${what} covers ${pct}% of the screen, and some of the page's text stays under it wherever the page is scrolled.${why}`,
        data: { width: REFLOW_VIEWPORT.width, overlay: rectText(p.root.rect), share: pct, scrollY: p.root.paintAt },
      });
    }
  }
  // A width whose sweep did not finish leaves a clean 1.4.10 unproven; a checked failure still stands.
  const unfinished = widths.find((w) => w.sweep.cut);
  if (unfinished && !out.length) out.push({ criterion: '1.4.10', status: 'not_testable', detail: cutWords(unfinished) });
  // A covered control that was never checked at the other scroll positions is unknown: not a failure, and not clean.
  const unchecked = widths.find((w) => w.sweep.covers.some((c) => c.reachable === null && w.sweep.roots.some((r) => r.ref === c.root && countsForCover(r))));
  if (unchecked && !out.length) {
    out.push({ criterion: '1.4.10', status: 'not_testable', detail: `a covered link, button or field could not be checked at every scroll position ${unchecked.label === 'zoom' ? `at ${unchecked.width} px wide` : `on a phone-sized screen (${unchecked.width} px wide)`}, so whether it can be scrolled clear is not known` });
  }
  // Recommendations (never failures, never the criterion's result): a control covered only on the first screen,
  // and a box over more than 40% of the screen that the content scrolls clear of. Nothing is lost in either.
  const advised = new Map<number, { root: OvRoot; covered: OvCover[]; area: number; where: ('zoom' | 'phone')[] }>();
  for (const w of widths) {
    for (const p of reflowAdvice(w)) {
      if (reflow.has(p.root.ref)) continue;
      const d = dismissed.get(p.root.ref);
      if (d && 'closedBy' in d) continue;
      const had = advised.get(p.root.ref);
      if (!had) advised.set(p.root.ref, { ...p, where: [w.label] });
      else {
        had.where.push(w.label);
        for (const c of p.covered) if (!had.covered.some((x) => x.control === c.control)) had.covered.push(c);
        had.area = Math.max(had.area, p.area);
      }
    }
  }
  for (const p of [...advised.values()].slice(0, OVERLAY_LIMITS.maxFindings)) {
    const what = overlayWords(p.root);
    const first = p.covered[0];
    const pct = Math.round(p.area * 100);
    const d = dismissed.get(p.root.ref);
    const why = d && 'why' in d ? ` It cannot be closed now: ${d.why}.` : '';
    out.push(pct ? {
      criterion: '1.4.10', status: 'no_failures_found', advice: true, target: p.root.path,
      detail: `At ${REFLOW_VIEWPORT.width} px wide, ${what} covers ${pct}% of the screen; the content can be scrolled clear of it. Recommended: make it smaller on small screens, or let it be closed.${why}`,
    } : {
      criterion: '1.4.10', status: 'no_failures_found', advice: true, target: first!.path,
      detail: `${widthWords(p.where)}, ${what} covers ${controlWords(first!)} on the first screen, as the page opens${p.covered.length > 1 ? ` (and ${p.covered.length - 1} more)` : ''}; scrolling the page brings ${p.covered.length > 1 ? 'them' : 'it'} clear. Recommended: keep the first screen’s links, buttons and fields clear of it.`,
    });
  }
  const focus = new Map<number, { root: OvRoot; stops: OvFocus[]; where: ('zoom' | 'phone')[]; width: number }>();
  for (const w of widths) {
    for (const h of w.hidden) {
      const had = focus.get(h.root.ref);
      if (!had) focus.set(h.root.ref, { root: h.root, stops: [h.stop], where: [w.label], width: w.width });
      else {
        if (!had.where.includes(w.label)) had.where.push(w.label);
        if (!had.stops.some((s) => s.control === h.stop.control)) had.stops.push(h.stop);
      }
    }
  }
  for (const f of [...focus.values()].slice(0, OVERLAY_LIMITS.maxFindings)) {
    const s = f.stops[0]!;
    const more = f.stops.length - 1;
    out.push({
      criterion: '2.4.11', status: 'failed', ...(s.path ? { target: s.path } : {}),
      detail: `${widthWords(f.where)}, ${controlWords({ role: s.role ?? 'control', name: s.name ?? '' })} is entirely hidden behind ${overlayWords(f.root)} when it receives keyboard focus${more ? `; so ${more === 1 ? 'is 1 more focus stop' : `are ${more} more focus stops`}` : ''}.`,
      data: { coverHeight: f.root.rect.h, width: f.width, overlay: rectText(f.root.rect), ...(s.box ? { focus: rectText(s.box) } : {}) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The probe.

const isSweep = (v: unknown): v is OvSweep => !!v && typeof v === 'object' && (v as OvSweep).ok === true && Array.isArray((v as OvSweep).roots) && Array.isArray((v as OvSweep).covers);



/** The 1.4.10 picture at this width: the box and the control it covers (or the box alone), where it was found. Never throws. */
async function reflowShot(ctx: ProbeContext, w: OverlayWidth, p: { root: OvRoot; covered: OvCover[]; area: number }, shots: Shots): Promise<boolean> {
  if (shots.has('1.4.10') || !ctx.evidence || !(ctx.evidenceWanted?.('1.4.10', 'overlay') ?? false) || !timeFor(ctx, 3000)) return false;
  try {
    const first = p.covered[0];
    const at = await before(ctx.page.evaluate(kitPlace, { y: first ? first.at : p.root.paintAt, root: p.root.ref, ...(first ? { control: first.control } : {}) }), ctx.deadline - 1500);
    if (!at?.root) return false;
    const box = (r: OvRect) => ({ x: r.x, y: r.y, width: r.w, height: r.h });
    const short = overlayShortName(p.root);
    const where = w.label === 'zoom' ? `at ${w.width} px wide` : `on a phone-sized screen`;
    const control = first && at.control ? at.control : null;
    const caption = first && control
      ? `A floating ${short} covers ${controlWords(first)} ${where}`
      : `A floating ${short} covers ${Math.round(p.area * 100)}% of the screen ${where}`;
    const ok = await ctx.evidence({
      criterion: '1.4.10', variant: 'overlay',
      boxes: [{ ...box(at.root), kind: 'fail' }, ...(control ? [{ ...box(control), kind: 'ghost' as const }] : [])],
      caption,
      alt: `${pageWords(at.title)} ${w.label === 'zoom' ? `in a window ${w.width} px wide` : `on a phone-sized screen (${w.width} px wide)`}: the outlined floating box stays on screen while the page scrolls${control ? ' and covers the dashed control' : ' and covers much of the screen'}.`,
      target: first ? first.path : p.root.path,
    });
    if (ok) shots.add('1.4.10');
    return ok;
  } catch {
    return false;
  }
}

/** The 2.4.11 picture at the moment of failure: the hidden focused control and the box over it. Never throws. */
async function focusShot(ctx: ProbeContext, w: OverlayWidth, stop: OvFocus, root: OvRoot, title: string, shots: Shots): Promise<boolean> {
  if (shots.has('2.4.11') || !ctx.evidence || !(ctx.evidenceWanted?.('2.4.11', 'overlay') ?? false) || !stop.box || !timeFor(ctx, 3000)) return false;
  try {
    const box = (r: OvRect) => ({ x: r.x, y: r.y, width: r.w, height: r.h });
    const ok = await ctx.evidence({
      criterion: '2.4.11', variant: 'overlay',
      boxes: [{ ...box(stop.box), kind: 'ghost' }, { ...box(root.rect), kind: 'fail', label: `${root.rect.h} px` }],
      caption: `Focus hidden behind a floating ${overlayShortName(root)} ${w.label === 'zoom' ? `at ${w.width} px wide` : 'on a phone-sized screen'}`,
      alt: `${pageWords(title)} ${w.label === 'zoom' ? `in a window ${w.width} px wide` : 'on a phone-sized screen'} after pressing Tab: the focused ${stop.role ?? 'control'} is hidden under a box that stays on screen.`,
      ...(stop.path ? { target: stop.path } : {}),
    });
    if (ok) shots.add('2.4.11');
    return ok;
  } catch {
    return false;
  }
}

/**
 * Tabs through the page at the current width (up to `forward` Tab and `backward` Shift+Tab stops) and
 * records the stops entirely hidden behind a box that stays on screen. 'done' when every press was
 * made (or focus came round or left the page), 'time' when the time box left no room for the rest:
 * then the stops it did not reach are unknown.
 */
async function tabWalk(ctx: ProbeContext, w: OverlayWidth, title: string, shots: Shots, cdp: CDPSessionLike | undefined): Promise<'done' | 'time'> {
  const L = OVERLAY_LIMITS;
  for (const dir of ['forward', 'backward'] as const) {
    const max = dir === 'forward' ? L.forward : L.backward;
    if (!max) continue;
    if (!timeFor(ctx, 2000)) return 'time';
    let keys: { tab: number; shift: number } | null = await before(ctx.page.evaluate(kitFocusStart, undefined), Math.min(ctx.deadline - 1000, Date.now() + 3000));
    if (!keys) return 'time';
    let first: number | undefined;
    const back = dir === 'backward';
    for (let i = 0; i < max; i++) {
      if (!timeFor(ctx, 2000)) return 'time';
      const until = Math.min(ctx.deadline - 1000, Date.now() + 3000);
      let stop: OvFocus | null;
      if (keys) {
        // The check goes with the press and waits in the page for its last keyup: one round trip per stop.
        const seenUps: number = back ? keys.shift : keys.tab;
        const after: NonNullable<FocusArg['after']> = { key: back ? 'Shift' : 'Tab', n: seenUps + 1, cap: 900 };
        const check: Promise<OvFocus | null> = before(ctx.page.evaluate(kitFocusCheck, { settleMs: L.settleMs, after }), until);
        await pressTab(ctx, cdp, back);
        stop = await check;
        if (stop?.missed) stop = await before(ctx.page.evaluate(kitFocusCheck, { settleMs: L.settleMs }), until);
      } else {
        // Focus was in a frame (its keyups never reach this document): the press, then the check.
        await pressTab(ctx, cdp, back);
        stop = await before(ctx.page.evaluate(kitFocusCheck, { settleMs: L.settleMs }), until);
      }
      if (!stop) return 'time';
      keys = stop.frame ? null : stop.keys ?? null;
      if (stop.none) break;
      if (stop.frame || stop.control === undefined) continue;
      if (first === undefined) first = stop.control;
      else if (stop.control === first) break;
      w.stops++;
      const by = stop.grid ? obscuredBy(stop.grid) : null;
      if (by === null) continue;
      const root = stop.roots?.find((r) => String(r.ref) === by);
      if (!root) continue;
      const known = w.hidden.some((h) => h.root.ref === root.ref);
      w.hidden.push({ stop, root, dir });
      if (!known) await focusShot(ctx, w, stop, root, title, shots);
    }
  }
  return 'done';
}

/**
 * Lays the page out at 320×256 CSS px (the reflow test's setup: 1280 px at 400% zoom) and at a
 * phone's 390×844, scrolls through it in steps (up to 16, the top and the bottom included), and looks
 * for boxes that stay on screen while the page scrolls (position fixed, or sticky while stuck) and
 * are visible. At each step it hit-tests the centre and corners of every link, button and field in
 * view. Failed:
 * - 1.4.10: a box covers part of a link, button or field on the first screen (as the page opens), or
 *   anywhere when no scroll position shows that control whole and clear (each covered control never
 *   seen clear is also tried at the top, middle and bottom of the screen, in document order, up to 40);
 * - 1.4.10: at 320 px wide, a box covers more than 40% of the screen (by a 16×12 grid), or a fixed one over
 *   20% hides some of the page's text at every scroll position (`stuckUnder`);
 * A box covers a control where it hides its middle or its name, or anywhere when both stay on screen;
 * - 2.4.11: after Tab (up to 40 stops) or Shift+Tab from the end (up to 10), the focused control is
 *   entirely hidden behind such a box.
 * Not counted for 1.4.10: a full-width bar at the top or bottom edge at most a third of the screen
 * high (the page's own header or footer), skip links, content that scrolls normally, boxes off
 * screen, and the page's own frame when the whole page scrolls inside a fixed box. A box the test
 * closes by keyboard, and that stays closed, passes 1.4.10 (`dismiss`, last). A control taller or wider than the screen
 * is clear once every point a box covered has scrolled clear; a control no try could place on the
 * screen stays unknown. Only solid parts
 * of a box count (a background at least 90% opaque, an image or a frame). A width whose sweep did not
 * finish (time, or more covered controls than it checks) leaves what it did not check unknown: 1.4.10
 * is then not_testable unless a checked failure stands. The sweep stops itself at the deadline.
 * Before each width the page should stand still (`quietMs`, at most `settleMaxMs`); each width is
 * swept twice, and once more before its tab walk, and judged on what the sweeps agree on
 * (`agreedSweep`): what changed between them is not judged, and the width is 'unstable' (1.4.10
 * not_testable unless an agreed failure stands), so a script still adding to the page cannot
 * decide the result. Both widths are swept before either
 * is tabbed through; the tab walks are bounded by count (`forward`, `backward`), and one the time
 * box cuts short leaves 2.4.11 not_testable unless a failure it reached stands. The
 * test runs on a page of its own and never closes or presses anything on a box, so it cannot tell
 * whether a closed banner comes back. It restores the viewport, the scroll position and focus.
 */
export const overlaysProbe: PageProbe = {
  id: 'overlays',
  criteria: ['1.4.10', '2.4.11'],
  // Compares sweeps of the page: a page still mounting its content disagrees with itself (gold hazard late mount).
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  // A safety net: on a remote browser (Browser Rendering, ~80 ms a round trip) the 2 × 50 tab stops
  // take most of the time, ~20 s; the tab walks are bounded by count, so the time box never decides
  // what is checked unless the browser is far slower than that.
  timeoutMs: 60_000,
  // Its own page: it scrolls the whole page and tabs through it, which can add content (loaded on
  // scroll) or open panels (on focus) that would stay for the next test.
  isolate: true,
  note: 'it closes a banner only to prove it can be closed (last, after measuring), so a banner that comes back on a later visit is not found',
  async run(ctx): Promise<ProbeFinding[]> {
    const page = ctx.page;
    if (!page.setViewportSize) throw new ProbeNotTestable('the browser cannot change the viewport size, which this test needs');
    const mark = ctx.guard.mark();
    const { width, height } = ctx.viewport;
    const L = OVERLAY_LIMITS;
    const widths: OverlayWidth[] = [];
    let cut = false;
    /** Widths whose tab walk ran out of time: their 2.4.11 is unknown. */
    const walkCut: OverlayWidth[] = [];
    let text = 0;
    const shots: Shots = new Set();
    const cdp = page.keyboard ? await ctx.cdp?.() : undefined;
    const dismissed = new Map<number, OvDismissal>();
    let before1: ReturnType<typeof stoppedSince>;
    try {
      const ok = await page.evaluate(installOverlayKit, { opaque: L.opaque, barHeight: L.barHeight, barWidth: L.barWidth, dialogShare: L.dialogShare, areaLow: L.areaLow });
      if (ok !== true) throw new ProbeNotTestable('the measuring script could not run on this page');
      /** Lays the page out at a width and waits for it to stop changing (bounded). */
      const layOut = async (vp: { width: number; height: number }) => {
        await page.setViewportSize!({ width: vp.width, height: vp.height });
        // The settle below waits until the layout has stood still for `quietMs` (resize handlers included).
        await before(page.evaluate(kitSettle, { quietMs: L.quietMs, maxMs: L.settleMaxMs }), Math.min(ctx.deadline - 3000, Date.now() + L.settleMaxMs + 1000));
      };
      /** One sweep at the current width; null when the page did not answer (it may still be running there). */
      const sweepNow = async (label: 'zoom' | 'phone'): Promise<OvSweep | null> => {
        const left = ctx.deadline - Date.now();
        // The sweep stops itself at `until` (a race here cannot stop a call into the page), well before the race gives up.
        const sweep = await before(page.evaluate(kitSweep, {
          maxSteps: L.maxSteps, verify: L.verify, maxControls: L.maxControls, area: label === 'zoom', grid: L.grid,
          budgetMs: Math.max(500, Math.min(6000, left / 8)), until: ctx.deadline - 3500, sentAt: Date.now(),
        }), ctx.deadline - 2500);
        if (isSweep(sweep)) return sweep;
        if (sweep === null) return null;
        throw new ProbeNotTestable('the page could not be measured');
      };
      /**
       * The width swept twice and judged on what both sweeps agree on (`agreedSweep`); when they
       * disagree, the page settles and a third sweep is compared with the second. A page whose
       * floating content keeps changing is 'unstable' there, never judged on whichever state one
       * sweep happened to see.
       */
      /** Every sweep of each width, in order (`judgeSweeps` decides from the finished ones). */
      const sweepsOf = new Map<'zoom' | 'phone', OvSweep[]>();
      const measure = async (vp: (typeof OVERLAY_VIEWPORTS)[number]): Promise<OverlayWidth | null> => {
        const all: OvSweep[] = [];
        sweepsOf.set(vp.label, all);
        const first = await sweepNow(vp.label);
        if (!first) {
          ctx.discardPage?.();
          return null;
        }
        all.push(first);
        // A second sweep to confirm the first (a first one cut for time: no room for another).
        if (first.cut !== 'time') {
          const second = await sweepNow(vp.label);
          if (!second) {
            ctx.discardPage?.();
            return null;
          }
          all.push(second);
          const done = all.filter((x) => !x.cut);
          // Two finished sweeps that disagree: the page settles and is swept once more.
          if (done.length === 2 && !agreedSweep(done[0]!, done[1]!).agreed && timeFor(ctx, 8000)) {
            await before(page.evaluate(kitSettle, { quietMs: L.quietMs, maxMs: L.settleMaxMs }), Math.min(ctx.deadline - 3000, Date.now() + L.settleMaxMs + 1000));
            const third = await sweepNow(vp.label);
            if (third) all.push(third);
          }
        }
        const sweep = judgeSweeps(all);
        text = Math.max(text, sweep.text);
        return { width: vp.width, height: vp.height, label: vp.label, sweep, hidden: [], stops: 0 };
      };
      // 1.4.10 first, at both widths (the tab walks after: they take the longest on a remote browser).
      for (const vp of OVERLAY_VIEWPORTS) {
        if (!timeFor(ctx, 4000)) { cut = true; break; }
        await layOut(vp);
        const w = await measure(vp);
        if (!w) { cut = true; break; }
        widths.push(w);
        // A picture of the first problem at this width, while it is laid out (320 px first).
        const problem = reflowProblems(w)[0];
        if (problem) await reflowShot(ctx, w, problem, shots);
      }
      if (page.keyboard) {
        for (const [i, w] of widths.entries()) {
          if (!timeFor(ctx, 4000)) { walkCut.push(w); continue; }
          // Laid out at this width again (after the sweeps the page is at the last width; 320 px is walked first).
          if (widths.length > 1) await layOut(OVERLAY_VIEWPORTS[i]!);
          // Swept once more before tabbing: what changed since (a script still adding to the page,
          // a widget that came late) is no longer agreed on, so it is not judged either way.
          // Only with room for the tab walk after it; a later sweep cut for time changes nothing.
          if (timeFor(ctx, 15_000)) {
            const later = await sweepNow(w.label);
            const all = sweepsOf.get(w.label);
            if (later && all) {
              all.push(later);
              widths[i] = { ...w, sweep: judgeSweeps(all) };
            }
          }
          const walked = widths[i]!;
          if ((await tabWalk(ctx, walked, walked.sweep.title, shots, cdp)) === 'time') walkCut.push(walked);
          await page.evaluate(kitBlur, undefined).catch(() => {});
        }
      }
      // Last (it changes the page): each box that would fail 1.4.10 is closed by keyboard, if it can be.
      await ctx.guard.settled?.(GUARD_SETTLE_MS).catch(() => false);
      before1 = stoppedSince(ctx.guard, mark);
      // Then each large box the test would only recommend making smaller: one that closes by keyboard needs no remark.
      const failing = [...new Map([
        ...widths.flatMap((w) => reflowProblems(w).map((p) => [p.root.ref, p.root] as const)),
        ...widths.flatMap((w) => reflowAdvice(w).filter((p) => p.area > 0).map((p) => [p.root.ref, p.root] as const)),
      ]).values()];
      if (failing.length && page.keyboard && widths.length && timeFor(ctx, 8000)) {
        await layOut(OVERLAY_VIEWPORTS[0]!);
        for (const root of failing.slice(0, 3)) {
          if (!timeFor(ctx, 4500)) break;
          dismissed.set(root.ref, await dismiss(ctx, root));
        }
      }
    } finally {
      await page.setViewportSize({ width, height }).catch(() => {});
      await page.waitForTimeout(200);
      await page.evaluate(overlayDrop, undefined).catch(() => {});
    }
    await ctx.guard.settled?.(GUARD_SETTLE_MS).catch(() => false);
    // What the closing step sent is its own business (it proves nothing there); the measuring before it is judged here.
    const stopped = before1 ?? (dismissed.size ? undefined : stoppedSince(ctx.guard, mark));
    if (stopped?.navigation) throw new ProbeNotTestable(stopped.reason);
    if (!widths.length) throw new ProbeNotTestable('the page took too long to measure');
    if (!text && widths.every((w) => !w.sweep.covers.length && !w.stops)) {
      return ['1.4.10', '2.4.11'].map((criterion) => ({ criterion, status: 'not_applicable' as const, detail: 'no visible text or controls on the page' }));
    }
    ctx.setData?.({
      overlays: widths.flatMap((w) => w.sweep.roots.slice(0, 10).map((r) => ({
        width: w.width, name: r.name, kind: r.kind, pos: r.pos, rect: r.rect, share: r.share, paint: r.paint, ...(r.stuck !== undefined ? { stuck: r.stuck } : {}), bar: r.bar, dialog: r.dialog,
        covers: w.sweep.covers.filter((c) => c.root === r.ref).length, unreachable: w.sweep.covers.filter((c) => c.root === r.ref && c.reachable === false).length,
        unchecked: w.sweep.covers.filter((c) => c.root === r.ref && c.reachable === null).length, firstScreen: w.sweep.covers.filter((c) => c.root === r.ref && c.at === 0).length,
      }))),
      stops: widths.map((w) => ({ width: w.width, stops: w.stops, steps: w.sweep.steps, ...(w.sweep.cut ? { cut: w.sweep.cut } : {}) })),
    });
    const findings = overlayFindings(widths, dismissed);
    const has = (c: string) => findings.some((f) => f.criterion === c);
    const reason = `the page took too long to measure at both widths (${REFLOW_VIEWPORT.width} px and a phone's ${PORTRAIT.width} px)`;
    // A width never measured (time ran out) leaves a clean result unproven.
    if (cut) for (const c of ['1.4.10', '2.4.11']) if (!has(c)) findings.push({ criterion: c, status: 'not_testable', detail: reason });
    // A tab walk the time box cut short leaves the stops it did not reach unknown: a clean 2.4.11 is unproven.
    if (!has('2.4.11') && walkCut.length) {
      findings.push({ criterion: '2.4.11', status: 'not_testable', detail: `the page took too long to tab through ${walkCut.map((w) => (w.label === 'zoom' ? `at ${w.width} px wide` : `on a phone-sized screen (${w.width} px wide)`)).join(' and ')}` });
    }
    if (!page.keyboard && !has('2.4.11')) findings.push({ criterion: '2.4.11', status: 'not_testable', detail: 'the browser cannot send key presses to this page' });
    if (stopped && !findings.some((f) => f.status === 'failed')) throw new ProbeNotTestable(stopped.reason);
    return findings;
  },
};
