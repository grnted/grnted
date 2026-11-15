// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A test's context scoped to one of the page's own embedded frames (keyboard-op lane, 2026-11-11): what a test does
// through `ctx.page` then happens inside the frame's document. Scripts run in the frame (`evaluate`), key presses go
// where focus is (a focused element inside the frame gets them, as a person's keys would), the listeners are the
// frame's own (the listener hook runs in every frame), and a mouse position the test computed inside the frame is
// moved to the same point of the top page, over the frame. A point the frame does not show there (scrolled out of
// the top page's view, covered by the top page's own content, or in a frame the page scales or turns) is never
// clicked: the pointer goes off the page, no button is pressed, and the test hears that the point was missed
// (`pointMissed`), so the control is not testable (fix round 1, F4, F6). Every call into a frame is bounded
// (`FRAME_CALL_MS`, under the test's own deadline): a frame that does not answer costs only its own coverage (F3).
// Engine core: no Node-only imports.
import type { FrameLike, MouseLike, PageLike } from '../types.js';
import { readHooks, readListeners } from './listeners.js';
import { ProbeNotTestable, type GuardEvent, type ProbeContext } from './types.js';

/** The longest one call into a frame, or about a frame, may take (ms); never past the test's own deadline. */
export const FRAME_CALL_MS = 1500;

/** A frame that did not answer a call in time. */
export class FrameTimeout extends Error {
  constructor() {
    super('the frame did not answer in time');
    this.name = 'FrameTimeout';
  }
}

/** `p`, or a `FrameTimeout` after `ms`. */
export async function bounded<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FrameTimeout()), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The time one call may take now: `FRAME_CALL_MS`, less near `deadline` (at least 100 ms). */
export const callMs = (deadline: number, max = FRAME_CALL_MS): number => Math.max(100, Math.min(max, deadline - Date.now()));

/** Why a click inside a frame was not made (the control is then not testable). */
export const FRAME_MISS = {
  covered: 'the page covers the frame at that point, so it was not clicked',
  hidden: 'the page does not show the frame at that point, so it was not clicked',
  scaled: 'the page scales or turns the frame, so where a click would land could not be told, and it was not clicked',
  nested: 'it is in a frame inside another frame, which the test does not click into',
} as const;
const MISSES: ReadonlySet<string> = new Set(Object.values(FRAME_MISS));
/** A reason `FRAME_MISS` gave. */
export const isFrameMiss = (reason: string): boolean => MISSES.has(reason);

/** A frame context's pointer: `missed` tells why its last move did not reach the point ('' when it did). */
interface FramePointer extends MouseLike {
  missed(): string;
}

/** Why the last move of a frame context's pointer did not reach its point, or '' (always '' for any other pointer). */
export function pointMissed(m: MouseLike | undefined): string {
  const f = m as Partial<FramePointer> | undefined;
  return typeof f?.missed === 'function' ? f.missed() : '';
}

/**
 * Runs in the top page: where the frame's content box starts in the viewport, once the point is in view and the frame
 * shows it; else why not ('hidden': out of view, 'covered': the page's own content is over it, 'scaled': the frame
 * or one of its ancestors is scaled, turned or zoomed, so a point inside it cannot be mapped by adding offsets).
 */
function frameOrigin(arg: { el: unknown; x: number; y: number }): { x: number; y: number } | 'hidden' | 'covered' | 'scaled' {
  const el = arg.el as HTMLElement | null;
  if (!el || !el.isConnected) return 'hidden';
  // Scaled, turned or zoomed (on the frame or an ancestor): its box on screen differs from its layout size.
  const box = el.getBoundingClientRect();
  if (Math.abs(box.width - el.offsetWidth) > 1 || Math.abs(box.height - el.offsetHeight) > 1) return 'scaled';
  for (let a: Element | null = el; a; a = a.parentElement) {
    const z = parseFloat((getComputedStyle(a) as CSSStyleDeclaration & { zoom?: string }).zoom ?? '1');
    if (Number.isFinite(z) && Math.abs(z - 1) > 0.001) return 'scaled';
  }
  const at = () => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0) };
  };
  let o = at();
  const inView = (p: { x: number; y: number }) => p.x + arg.x >= 1 && p.y + arg.y >= 1 && p.x + arg.x <= innerWidth - 2 && p.y + arg.y <= innerHeight - 2;
  if (!inView(o)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    o = at();
    if (!inView(o)) return 'hidden';
  }
  // The top page's own content over the frame at that point: the frame does not get the click there.
  let hit = document.elementFromPoint(o.x + arg.x, o.y + arg.y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(o.x + arg.x, o.y + arg.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit === el ? o : 'covered';
}

/** A frame a test looks inside: the frame and how the top page names its element. */
export interface ScopedFrame {
  frame: FrameLike;
  /** CSS path of its element in the page (parts joined by ' >>> ' for a frame inside a frame). */
  path: string;
}

/**
 * The context for running a test inside `f`. `top` is the page the frame belongs to. Only a frame directly in the
 * page is supported for the pointer (a frame inside a frame gets no pointer: its moves go off the page). Every call
 * into the frame, and every call about it, is bounded by `FRAME_CALL_MS` and the test's deadline: a call the frame
 * does not answer rejects (`FrameTimeout`), and the test treats it as a frame it could not look into.
 */
export function frameProbeContext(ctx: ProbeContext, f: ScopedFrame): ProbeContext {
  const top = ctx.page;
  const { frame } = f;
  const nested = frame.parentFrame()?.parentFrame() != null;
  const ms = () => callMs(ctx.deadline);
  let missed = '';
  const mouse: FramePointer | undefined = top.mouse && {
    async move(x, y, opts) {
      missed = '';
      // Off the page stays off the page (how the tests take the pointer away).
      if (x < 0 || y < 0) return top.mouse!.move(-1, -1, opts);
      if (nested) { missed = FRAME_MISS.nested; return top.mouse!.move(-1, -1, opts); }
      const handle = await bounded(ms(), frame.frameElement()).catch(() => null);
      const o = handle ? await bounded(ms(), top.evaluate(frameOrigin, { el: handle, x, y })).catch(() => 'hidden' as const) : 'hidden' as const;
      if (typeof o === 'object') return top.mouse!.move(o.x + x, o.y + y, opts);
      missed = FRAME_MISS[o];
      return top.mouse!.move(-1, -1, opts);
    },
    async click(x, y, opts) {
      await this.move(x, y);
      await this.down(opts);
      await this.up(opts);
    },
    // A point the frame does not show is not pressed at all (never on the top page instead).
    down: (opts) => (missed ? Promise.resolve() : top.mouse!.down(opts)),
    up: (opts) => (missed ? Promise.resolve() : top.mouse!.up(opts)),
    wheel: (dx, dy) => top.mouse!.wheel(dx, dy),
    missed: () => missed,
  };
  const page: PageLike = {
    goto: () => { throw new Error('a test inside a frame cannot load another page'); },
    evaluate: (fn, arg) => bounded(ms(), frame.evaluate(fn, arg)),
    addScriptTag: (opts) => bounded(ms(), frame.evaluate(opts.content)),
    waitForTimeout: (wait) => top.waitForTimeout(wait),
    screenshot: () => { throw new Error('a test inside a frame takes no pictures'); },
    close: async () => {},
    ...(top.keyboard ? { keyboard: top.keyboard } : {}),
    ...(mouse ? { mouse } : {}),
    url: () => frame.url(),
  };
  const { setData: _setData, attach: _attach, ...rest } = ctx;
  return {
    ...rest,
    page,
    url: frame.url(),
    async listeners(opts?: { shadowInline?: boolean }) {
      const list = await bounded(ms(), frame.evaluate(readListeners, opts?.shadowInline ? { shadowInline: true } : undefined)).catch(() => null);
      if (!list) throw new ProbeNotTestable('the event listener hook did not run in this frame');
      return list;
    },
    async hooks() {
      const all = await bounded(ms(), frame.evaluate(readHooks, undefined)).catch(() => null);
      if (!all) throw new ProbeNotTestable('the event listener hook did not run in this frame');
      return all;
    },
  };
}

/**
 * Runs in the top page: for each name, whether a control outside the frame (one Tab reaches, not a frame) has that
 * name, and whether one points at the frame. Such a control may do with the keyboard what a pointer-only control
 * inside the frame does; the test does not compare presses across documents. Self-contained.
 */
export function controlsOutsideFrame(arg: { el: unknown; names: string[] }): { named: boolean[]; pointing: boolean } {
  const frameEl = arg.el as Element | null;
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const wanted = arg.names.map(norm);
  const named = wanted.map(() => false);
  let pointing = false;
  const id = frameEl?.id ?? '';
  const nameOf = (e: Element): string => {
    const label = e.getAttribute('aria-label');
    if (label && label.trim()) return label;
    const by = e.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((x) => document.getElementById(x)?.textContent ?? '').join(' ');
      if (t.trim()) return t;
    }
    const text = (e as HTMLElement).innerText ?? e.textContent ?? '';
    if (text.trim()) return text;
    return e.getAttribute('title') ?? (e as HTMLInputElement).value ?? '';
  };
  const all = document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), [role]');
  for (let i = 0; i < all.length && i < 3000; i++) {
    const e = all[i]!;
    if (e.matches('iframe, frame, object, embed') || (e as HTMLElement).tabIndex < 0 || (e as HTMLButtonElement).disabled) continue;
    if (id && ['aria-controls', 'data-target', 'data-bs-target', 'popovertarget', 'commandfor'].some((a) => (e.getAttribute(a) ?? '').split(/\s+/).some((t) => t.replace(/^#/, '') === id))) pointing = true;
    const n = norm(nameOf(e).slice(0, 200));
    if (n.length < 3) continue;
    wanted.forEach((w, k) => { if (w.length >= 3 && w === n) named[k] = true; });
  }
  return { named, pointing };
}

/**
 * Runs in a frame (self-contained): the names of the members of the widget at `path` (its tabs, options, menu items,
 * radios, tree items, grid cells or buttons; at most 20). A control outside the frame named after any of them is
 * related to the widget (a "Next week" button outside a frame's tab list).
 */
export function widgetMemberNames(arg: { path: string }): string[] {
  let box: Element | null = null;
  try { box = document.querySelector(arg.path); } catch { return []; }
  if (!box) return [];
  const out: string[] = [];
  const all = box.querySelectorAll('[role="tab"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="radio"], [role="treeitem"], [role="gridcell"], [role="button"], button');
  for (let i = 0; i < all.length && out.length < 20; i++) {
    const e = all[i]!;
    const n = (e.getAttribute('aria-label') || (e as HTMLElement).innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (n) out.push(n);
  }
  return out;
}

/** One frame element of the page, as `frameSlots` reads it from the page itself. */
export interface FrameSlot {
  /** CSS path of its element (its id, else its place under its parent). */
  path: string;
  /** Its address resolved against the page ('' with none). */
  src: string;
  /**
   * What its address is: none (no src, no srcdoc), blank (about:), script (javascript:), data, srcdoc, own (the page's
   * own origin) or other (another site).
   */
  kind: 'none' | 'blank' | 'script' | 'data' | 'srcdoc' | 'own' | 'other';
  /** Shown and at least `minWidth` × `minHeight` CSS px (the size of frame the tests look into). */
  shown: boolean;
  /** Its own document is there (past the first about:blank) and finished loading; false when not yet. */
  ready: boolean;
  /** Its address names a document file (a PDF, an Office file, a spreadsheet, an archive), not a web page. */
  file: boolean;
  /** `loading="lazy"`, and not within one screen of the viewport (the browser waits to load it). */
  lazyAway: boolean;
}

/**
 * Runs in the top page (self-contained): the page's own frame elements (directly in its document, at most 60), read
 * from the page alone (a frame on another site is never called into). A frame's document is read through its
 * element: the first about:blank of a frame whose address was not loaded yet, the frame's own document once it is
 * (same origin), nothing for another site's.
 */
export function frameSlots(arg: { minWidth: number; minHeight: number }): FrameSlot[] {
  const FILE = /\.(pdf|docx?|dotx?|xlsx?|xlsm|pptx?|ppsx?|od[tsp]|rtf|csv|zip)$/i;
  const esc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v);
  const out: FrameSlot[] = [];
  const all = document.querySelectorAll('iframe, frame');
  for (let k = 0; k < all.length && k < 60; k++) {
    const el = all[k] as HTMLIFrameElement;
    if (!el.isConnected) continue;
    const raw = el.getAttribute('src') ?? '';
    let kind: FrameSlot['kind'] = 'none';
    let src = '';
    let file = false;
    if (el.hasAttribute('srcdoc')) kind = 'srcdoc';
    else if (raw.trim()) {
      if (/^\s*about:/i.test(raw)) kind = 'blank';
      else if (/^\s*javascript:/i.test(raw)) kind = 'script';
      else if (/^\s*data:/i.test(raw)) kind = 'data';
      else {
        try {
          const u = new URL(raw, document.baseURI);
          src = u.href;
          kind = u.origin === location.origin ? 'own' : 'other';
          file = FILE.test(u.pathname);
        } catch {
          kind = 'other';
        }
      }
    }
    const r = el.getBoundingClientRect();
    const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length > 0;
    const shown = visible && r.width >= arg.minWidth && r.height >= arg.minHeight;
    let ready = true;
    try {
      const doc = el.contentDocument;
      // A document from another site is not readable here: not this page's to wait for.
      if (doc) ready = doc.readyState === 'complete' && !((kind === 'own' || kind === 'srcdoc') && doc.URL === 'about:blank');
    } catch {
      ready = true;
    }
    const lazyAway = el.getAttribute('loading') === 'lazy' && (r.top > innerHeight * 2 || r.bottom < -innerHeight || r.left > innerWidth * 2);
    const same = el.parentElement ? [...el.parentElement.children].filter((c) => c.localName === el.localName) : [el];
    const path = el.id ? `#${esc(el.id)}` : `${el.parentElement?.id ? `#${esc(el.parentElement.id)} > ` : ''}${el.localName}:nth-of-type(${same.indexOf(el) + 1})`;
    out.push({ path, src, kind, shown, ready, file, lazyAway });
  }
  return out;
}

/** Runs in the top page (self-contained): brings the frame at `path` into view; the scroll position before, for `scrollBack`. */
function scrollToFrame(arg: { path: string }): { x: number; y: number } | null {
  let el: Element | null = null;
  try { el = document.querySelector(arg.path); } catch { return null; }
  if (!el) return null;
  const was = { x: scrollX, y: scrollY };
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  return was;
}

function scrollBack(arg: { x: number; y: number }): void {
  window.scrollTo({ left: arg.x, top: arg.y, behavior: 'instant' as ScrollBehavior });
}

/** What `settleFrames` needs of the request guard: what it stopped, and the frame documents still on the wire. */
export interface FrameGuard {
  events: readonly GuardEvent[];
  /** Addresses of documents the browser is still loading; undefined when the browser does not report requests. */
  inFlight?(): string[] | undefined;
}

const sameAddress = (a: string, b: string) => {
  const cut = (u: string) => u.replace(/#.*$/, '');
  const x = cut(a);
  const y = cut(b);
  // The guard's log keeps 300 characters of an address.
  return x === y || (y.length >= 290 && x.startsWith(y.replace(/…$/, '')));
};

/**
 * Waits, at most `ms` (and never past `deadline`), until the page's own frames that the tests look into have their
 * documents, and returns those that should be looked into and cannot be (fix round 1, F2, F3), with why:
 * - frames are read from the page itself (`frameSlots`): a frame on another site is never waited for or called into;
 * - frames that cannot hold a control a person can use are no gap and cost no wait: hidden, 0×0 or smaller than
 *   120×60, about:blank, javascript: or data: ones, and frames whose address names a document file (a PDF, an
 *   Office file: the documents test's), or whose document came to nothing (a download, such as a PDF the browser
 *   does not show, or an empty answer: the browser ended its request and the guard did not stop it);
 * - a frame the request guard stopped (the page put it in, or pointed it elsewhere, after it loaded) is a gap at once;
 * - a frame that loads only when scrolled to (`loading="lazy"`) is scrolled into view once (`scroll`; the page's
 *   scroll position is put back), then waited for like the others;
 * - a shown, sizeable frame from the page's own site whose document did not come in time is a gap (not testable,
 *   never clean).
 * Never throws; the top page not answering ends the wait with what was known.
 */
export async function settleFrames(page: PageLike, ms: number, opts: { guard?: FrameGuard; deadline?: number; scroll?: boolean } = {}): Promise<{ path: string; why: string }[]> {
  const started = Date.now();
  const end = Math.min(started + ms, opts.deadline ?? Infinity);
  const gaps: { path: string; why: string }[] = [];
  const done = new Set<string>();
  const firstSeen = new Map<string, number>();
  /** Frames whose document request was seen on the wire. */
  const seen = new Set<string>();
  let scrolledFrom: { x: number; y: number } | null = null;
  const scrolled = new Set<string>();
  try {
    // No frame of any kind: nothing to read (a browser connection without frames, too).
    try { if ((page.frames?.() ?? []).length <= 1) return []; } catch { return []; }
    for (;;) {
      const slots = await bounded(callMs(end + 1000), page.evaluate(frameSlots, { minWidth: 120, minHeight: 60 })).catch(() => null);
      if (!slots) return gaps;
      const waiting: FrameSlot[] = [];
      for (const s of slots) {
        if (done.has(s.path) || s.ready || !s.shown || s.file || (s.kind !== 'own' && s.kind !== 'srcdoc')) continue;
        if (!firstSeen.has(s.path)) firstSeen.set(s.path, Date.now());
        if (s.kind === 'own' && opts.guard?.events.some((e) => (e.kind === 'frame' || e.kind === 'blocked') && !!e.url && sameAddress(s.src, e.url))) {
          done.add(s.path);
          gaps.push({ path: s.path, why: 'the page put it in or changed its address after it loaded, and the test does not let such a frame load' });
          continue;
        }
        if (s.lazyAway && !scrolled.has(s.path)) {
          scrolled.add(s.path);
          if (opts.scroll) {
            const was = await bounded(callMs(end + 1000), page.evaluate(scrollToFrame, { path: s.path })).catch(() => null);
            scrolledFrom ??= was;
            firstSeen.set(s.path, Date.now());
          } else {
            done.add(s.path);
            gaps.push({ path: s.path, why: 'it loads only when scrolled to, and this test does not let a frame load' });
            continue;
          }
        }
        waiting.push(s);
      }
      if (!waiting.length) return gaps;
      // Ended without a document (a download, an empty answer): nothing to look into. A frame is given a moment first,
      // so that a request just started has been reported; one scrolled to only once its request was seen on the wire
      // (a lazy frame whose load had not started yet is not one that came to nothing).
      const loading = opts.guard?.inFlight?.();
      const open = waiting.filter((s) => {
        if (!loading || s.kind !== 'own') return true;
        if (loading.some((u) => sameAddress(s.src, u))) { seen.add(s.path); return true; }
        if (!seen.has(s.path) && (scrolled.has(s.path) || Date.now() - firstSeen.get(s.path)! < 400)) return true;
        done.add(s.path);
        return false;
      });
      if (!open.length) return gaps;
      if (Date.now() >= end) {
        for (const s of open) gaps.push({ path: s.path, why: s.kind === 'own' && loading?.some((u) => sameAddress(s.src, u)) ? 'its content did not load in time for the test' : 'its content did not load for the test' });
        return gaps;
      }
      await page.waitForTimeout(Math.min(150, Math.max(0, end - Date.now()))).catch(() => {});
    }
  } finally {
    if (scrolledFrom) await bounded(callMs(end + 1000), page.evaluate(scrollBack, scrolledFrom)).catch(() => {});
  }
}
