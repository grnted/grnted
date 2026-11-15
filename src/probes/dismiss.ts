// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Proving that a box on the page (a cookie banner, a survey panel, a dialog, a pop-up) can be dismissed
// by keyboard: `proveDismiss`. WCAG's Understanding 1.4.10 gives dismissing sticky or fixed content as the
// remedy for it covering the page; a test may only count that when it has done it. Reusable by any probe
// that needs a box out of the way (the overlays test today; measuring the page behind a pop-up later).
// Engine core: no Node-only imports.
//
// What it does, in order:
// 1. In the box (its open shadow roots included), finds the controls named to close it (close, dismiss,
//    accept, OK, ×…; the name only picks what to try) that are in the Tab order: buttons, links, role=button
//    and input type=button only. Never a text field, a select or a text area (Enter there sends a form),
//    never one whose href is `javascript:`, nor a submit button or a control with formaction inside a form.
//    They are tried in this order: one that closes without consenting to anything (Close, Reject, Decline, No
//    thanks, ×), then a neutral one (OK, Got it, Continue), then one that consents (Accept, Allow, Agree).
//    The box's path may go into open shadow roots and same-origin frames (parts joined by ' >>> ').
// 2. Focuses each in turn (it must take keyboard focus) and presses Enter; for a control that is not a
//    link, Space after Enter did nothing. With `escapeFirst`, Escape is pressed first (where focus is). With
//    `keyboardReach`, a control is never focused by script: it is reached by real Tab presses (then Shift+Tab)
//    from where focus is (inside the box) or from the document, at most `maxTabs` each way; one the Tab key
//    does not reach is not tried. The controls reached are found first, then each is reached again and
//    pressed in the order above (a Reject after an Accept in the Tab order is still tried first).
// 3. The box must then be gone: the box itself no longer painted (removed, not rendered, transparent, of
//    no size on screen, or `visibility: hidden` with no part of it still visible), AND no new layer that
//    stays on screen (fixed or sticky) of half its size or more painted where it was (a close that
//    replaces the box with another is not a close). It must still be gone `stayMs` later, and again after
//    the scroll position and focus are put back (a box that a scroll brings back is not closed).
// 4. Anything the request guard held from the first focus or key on (a request it stopped, a page load), ANY
//    request the page made from then on (an allowed GET too: the click, or a focus handler, may have told the site
//    something; analytics hits aside), or a change of the page's address other than its fragment
//    (pushState, a new history entry for the same address) means "not dismissed". A link to "#" that
//    only changes the fragment is allowed.
// 5. Puts focus and the scroll position back as they were (the box itself stays closed when it closed).
import { isAnalyticsAddress } from '../analytics.js';
import type { PageLike, RequestLike } from '../types.js';
import type { GuardEvent } from './types.js';
import type { ProbeContext } from './types.js';

/** Names of controls that may dismiss a box (the name only picks what to try; pressing it is the proof). */
export const DISMISS_NAME = /\b(close|dismiss|accept|agree|got it|ok|okay|no,? thanks|reject|decline|deny|allow|continue|hide|minimi[sz]e)\b|^\s*[×✕✖xX]\s*$/i;

export interface DismissOptions {
  /** Wait after the key before checking the box (ms; default 400). */
  settleMs?: number;
  /** How long the box must then stay gone (ms; default 2200: a box back 2 s after the press is not closed). */
  stayMs?: number;
  /** Wait after focus and scroll are put back before the last check (ms; default 300). */
  restoreMs?: number;
  /** Controls tried at most (default 3). */
  maxControls?: number;
  /**
   * Never press a link whose address is only a fragment (`#`, `#main`): its press only moves within the page,
   * so it proves nothing about closing the box (the page-load pop-ups, `popupAside.ts`). Default false.
   */
  noHashLinks?: boolean;
  /** Press Escape first, under the same checks (the page-load pop-ups). Default false. */
  escapeFirst?: boolean;
  /**
   * Reach each control by real Tab presses (then Shift+Tab), never by script focus: a control the Tab key does not
   * reach (a focus trap that leaves it out) is not tried (the page-load pop-ups). Default false.
   */
  keyboardReach?: boolean;
  /** Tab presses at most each way with `keyboardReach` (default 30). */
  maxTabs?: number;
}

export interface DismissTry {
  /** The control's accessible name (at most 60 characters) and CSS path. */
  name: string;
  path: string;
  key?: 'Enter' | 'Space' | 'Escape';
  outcome: 'dismissed' | 'no-focus' | 'not-closed' | 'came-back' | 'guard' | 'address' | 'request';
}

export interface DismissResult {
  dismissed: boolean;
  /** The control and key that dismissed it. */
  by?: { name: string; path: string; key: 'Enter' | 'Space' | 'Escape' };
  /** Why it was not dismissed, in words for a finding ("pressing Enter on its “Close” control does not close it"). */
  why?: string;
  /** Every control tried, in order, and what happened. */
  tried: DismissTry[];
  /** What the request guard held while a key was handled (the first one), when that is why. */
  held?: GuardEvent;
  /** The first request the page made after a press, when that is why. */
  request?: string;
}

interface Candidate { i: number; name: string; path: string; link: boolean }
interface Rect { x: number; y: number; w: number; h: number }
interface DismissState {
  box: Element | null; els: Element[]; active: Element | null; rect: Rect;
  /** Elements that stayed on screen (fixed or sticky) before any press: a close may reveal them, not add them. */
  fixedBefore: Set<Element>;
  /** Elements added to the document since the box was found (by a MutationObserver), and the observer. */
  added: Set<Element>; observer: MutationObserver | null;
}

/** Runs in the page (self-contained). Finds the box and its dismiss controls; keeps them on window for the next calls. */
export function dismissCandidates(arg: { box: string; pattern: string; max: number; noHash?: boolean; peek?: boolean }): { found: boolean; candidates: Candidate[]; href: string; hist: number; sx: number; sy: number } {
  const w = window as unknown as { __grntedDismiss?: DismissState };
  const re = new RegExp(arg.pattern, 'i');
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el, i = 0; cur && i < 40; cur = cur.parentElement, i++) {
      const root = cur.getRootNode() as Document | ShadowRoot;
      if (cur.id && root.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
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
      const root = el.getRootNode() as Document | ShadowRoot;
      const t = by.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id))?.textContent ?? '').join(' ');
      if (t.trim()) return clean(t);
    }
    const text = clean((el as HTMLElement).innerText ?? el.textContent);
    if (text) return text;
    const v = (el as HTMLInputElement).value;
    return clean(el.getAttribute('title') || (typeof v === 'string' && el.localName === 'input' ? v : ''));
  };
  const visible = (el: Element): boolean => {
    const e = el as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && !el.closest('[inert], [aria-hidden="true"]');
  };
  let box: Element | null = null;
  // The box's path: parts joined by ' >>> ' go into an open shadow root or a same-origin frame (popupAside.ts).
  try {
    let root: Document | ShadowRoot = document;
    const parts = arg.box.split(' >>> ');
    for (let k = 0; k < parts.length; k++) {
      box = root.querySelector(parts[k]!);
      if (!box || k === parts.length - 1) break;
      const inner: Document | ShadowRoot | null | undefined = box.shadowRoot ?? (box as HTMLIFrameElement).contentDocument;
      if (!inner) { box = null; break; }
      root = inner;
    }
  } catch { box = null; }
  const r = box?.getBoundingClientRect();
  const rect = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
  const state: DismissState = { box, els: [], active: document.activeElement, rect, fixedBefore: new Set(), added: new Set(), observer: null };
  w.__grntedDismiss = state;
  const out = { found: !!box, candidates: [] as Candidate[], href: location.href, hist: history.length, sx: scrollX, sy: scrollY };
  if (!box) return out;
  // `peek`: only which controls it would try (the page-load pop-up classifier); nothing watched, nothing kept.
  if (arg.peek) w.__grntedDismiss = { ...state };
  // Every layer that already stays on screen, anywhere in the document (a header under the banner among them).
  const all0 = arg.peek ? [] as unknown as NodeListOf<Element> : document.querySelectorAll('*');
  for (let i = 0; i < all0.length && i < 8000; i++) {
    const p = getComputedStyle(all0[i]!).position;
    if (p === 'fixed' || p === 'sticky') state.fixedBefore.add(all0[i]!);
  }
  // What the page adds from now on (a close that puts another box in the old one's place, whatever its position).
  if (!arg.peek) try {
    state.observer = new MutationObserver((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1 && state.added.size < 2000) state.added.add(n as Element);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch { state.observer = null; }
  // The box and its open shadow roots.
  const found: Candidate[] = [];
  const scopes: (Element | ShadowRoot)[] = [box];
  if (box.shadowRoot) scopes.push(box.shadowRoot);
  const all = box.querySelectorAll('*');
  for (let i = 0; i < all.length && i < 2000 && scopes.length < 30; i++) if (all[i]!.shadowRoot) scopes.push(all[i]!.shadowRoot!);
  for (let k = 0; k < scopes.length && k < 30; k++) {
    const scope = scopes[k]!;
    if (k > 0) {
      const inner = scope.querySelectorAll('*');
      for (let i = 0; i < inner.length && i < 500 && scopes.length < 30; i++) if (inner[i]!.shadowRoot && !scopes.includes(inner[i]!.shadowRoot!)) scopes.push(inner[i]!.shadowRoot!);
    }
    const cands = scope.querySelectorAll('button, a[href], [role="button"], input[type="button"]');
    for (let i = 0; i < cands.length && i < 80 && found.length < 20; i++) {
      const c = cands[i] as HTMLElement;
      // Safety: only controls that are buttons or links. A text field, select or text area (with role=button or not):
      // Enter there sends its form.
      if (c.localName === 'select' || c.localName === 'textarea' || (c.localName === 'input' && (c as HTMLInputElement).type !== 'button')) continue;
      if ((c as HTMLButtonElement).disabled || c.tabIndex < 0 || !visible(c)) continue;
      // Safety: never a javascript: link, nor anything that would submit a form.
      if (/^\s*javascript:/i.test(c.getAttribute('href') ?? '')) continue;
      if (arg.noHash && c.localName === 'a' && /^\s*#/.test(c.getAttribute('href') ?? '')) continue;
      const form = (c as HTMLButtonElement).form ?? c.closest('form');
      if (form && (c.hasAttribute('formaction') || (c.localName === 'button' && ((c as HTMLButtonElement).type || 'submit') === 'submit'))) continue;
      const name = nameOf(c);
      if (!re.test(name) && !re.test(c.getAttribute('title') ?? '')) continue;
      w.__grntedDismiss.els.push(c);
      found.push({ i: w.__grntedDismiss.els.length - 1, name, path: cssPath(c), link: c.localName === 'a' });
    }
  }
  // Tried in this order (stable within each): a control that closes without consenting to anything (Close, Reject,
  // Decline, "No thanks"), then a neutral one (OK, Got it, Continue), then one that consents (Accept, Allow, Agree).
  // An account or destructive action never receives closing priority merely because its name also says Close.
  const rank = (n: string) => (/\b(account|delete|remove|sign\s*out|log\s*out|unsubscribe|cancel\s+subscription)\b/i.test(n) ? 1 : /\b(accept|agree|allow)/i.test(n) ? 2 : /\b(close|dismiss|no,? thanks|reject|decline|deny|hide|minimi[sz]e)\b|^\s*[×✕✖xX]\s*$/i.test(n) ? 0 : 1);
  out.candidates = found.map((c, k) => ({ c, k, r: rank(c.name) })).sort((a, b) => a.r - b.r || a.k - b.k).slice(0, arg.max).map((x) => x.c);
  if (arg.peek) delete w.__grntedDismiss;
  return out;
}

/** Runs in the page (self-contained). The candidate that has keyboard focus now (through open shadow roots), else -1. */
export function dismissActive(): number {
  const s = (window as unknown as { __grntedDismiss?: { els: Element[] } }).__grntedDismiss;
  let a: Element | null = document.activeElement;
  for (let k = 0; a && k < 20; k++) {
    let inner: Element | null | undefined = a.shadowRoot?.activeElement;
    if (!inner) try { inner = (a as HTMLIFrameElement).contentDocument?.activeElement; } catch { inner = null; }
    if (!inner || inner === a) break;
    a = inner;
  }
  return s && a ? s.els.indexOf(a) : -1;
}

/**
 * Runs in the page (self-contained). Where a Tab walk starts: focus stays where it is when it is inside the box (a
 * dialog that took focus); otherwise it is let go (blurred: no element is focused by script), so Tab starts at the
 * document's start and Shift+Tab at its end.
 */
export function dismissStart(): boolean {
  const s = (window as unknown as { __grntedDismiss?: { box: Element | null } }).__grntedDismiss;
  let a: Element | null = document.activeElement;
  for (let k = 0; a && a.shadowRoot?.activeElement && k < 20; k++) a = a.shadowRoot.activeElement;
  const inside = !!(s?.box && a && (s.box.contains(a) || s.box.contains((a.getRootNode() as ShadowRoot).host ?? null)));
  if (!inside) (document.activeElement as HTMLElement | null)?.blur?.();
  return inside;
}

/** Runs in the page (self-contained). Whether the box comes in the second half of the document (where Shift+Tab reaches it first). */
export function dismissLate(): boolean {
  const s = (window as unknown as { __grntedDismiss?: { box: Element | null } }).__grntedDismiss;
  let el: Element | null = s?.box ?? null;
  // A box in a shadow root or a frame: where its host or frame is in the top document.
  for (let k = 0; el && el.ownerDocument !== document && k < 10; k++) { try { el = el.ownerDocument.defaultView?.frameElement ?? null; } catch { el = null; } }
  for (let k = 0; el && el.getRootNode() !== document && k < 10; k++) el = (el.getRootNode() as ShadowRoot).host ?? null;
  if (!el) return false;
  const all = document.querySelectorAll('*');
  let at = -1;
  for (let i = 0; i < all.length; i++) if (all[i] === el) { at = i; break; }
  return at >= 0 && at > all.length / 2;
}

/** Runs in the page (self-contained). Focuses candidate `i`; true when keyboard focus is on it. */
export function dismissFocus(i: number): boolean {
  const s = (window as unknown as { __grntedDismiss?: { els: Element[] } }).__grntedDismiss;
  const c = s?.els[i] as HTMLElement | undefined;
  if (!c || !c.isConnected || typeof c.focus !== 'function') return false;
  c.focus();
  let a: Element | null = document.activeElement;
  for (let k = 0; a && a.shadowRoot?.activeElement && k < 20; k++) a = a.shadowRoot.activeElement;
  return a === c;
}

/**
 * Runs in the page (self-contained). Whether the box found by `dismissCandidates` is gone from the screen
 * (see the top of this file), the address now and the length of the session history.
 */
export function dismissGone(): { gone: boolean; href: string; hist: number } {
  const s = (window as unknown as { __grntedDismiss?: DismissState }).__grntedDismiss;
  const href = location.href;
  const hist = history.length;
  if (!s) return { gone: false, href, hist };
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = innerHeight;
  const onScreen = (r: { left: number; top: number; right: number; bottom: number }) =>
    Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  type Vis = Element & { checkVisibility?: (o: object) => boolean };
  const painted = (el: Element) => {
    const e = el as Vis;
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return onScreen(el.getBoundingClientRect()) >= 1;
  };
  // The box itself: still painted, or hidden only on itself while a part of it (visibility: visible) still shows.
  const box = s.box;
  if (box && box.isConnected && onScreen(box.getBoundingClientRect()) >= 0.005 * vw * vh) {
    const e = box as Vis;
    const transparent = typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true });
    if (!transparent) {
      if (painted(box)) return { gone: false, href, hist };
      const inner = box.querySelectorAll('*');
      for (let i = 0; i < inner.length && i < 300; i++) if (painted(inner[i]!)) return { gone: false, href, hist };
    }
  }
  // Something new painted over half the box's place or more, whatever its position and whether or not it takes the
  // pointer (a close that puts another box there, or a pointer-events:none layer); or a layer that stays on screen
  // and was not one before the press (a class that made an element fixed). Layers that already stayed on screen (a
  // header the banner lay over) are what the close revealed.
  const r = s.rect;
  const x0 = Math.max(0, r.x), x1 = Math.min(vw, r.x + r.w), y0 = Math.max(0, r.y), y1 = Math.min(vh, r.y + r.h);
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const over = (el: Element) => {
    const b = el.getBoundingClientRect();
    return Math.max(0, Math.min(b.right, x1) - Math.max(b.left, x0)) * Math.max(0, Math.min(b.bottom, y1) - Math.max(b.top, y0));
  };
  const opaqueish = (el: Element) => {
    const st = getComputedStyle(el);
    const bg = st.backgroundColor;
    const alpha = /rgba?\(([^)]+)\)/.exec(bg)?.[1]?.split(',')[3];
    return st.backgroundImage !== 'none' || (bg !== 'transparent' && (alpha === undefined || Number(alpha) > 0.1)) || /^(img|video|canvas|iframe|svg)$/i.test(el.localName);
  };
  if (area >= 1) {
    let n = 0;
    for (const a of s.added) {
      if (!a.isConnected) continue;
      for (const el of [a, ...Array.from(a.querySelectorAll('*')).slice(0, 200)]) {
        if (++n > 3000) break;
        if (painted(el) && opaqueish(el) && over(el) >= 0.5 * area) return { gone: false, href, hist };
      }
    }
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i]!;
      if (s.fixedBefore.has(el) || el === box || (box && box.contains(el))) continue;
      const p = getComputedStyle(el).position;
      if ((p === 'fixed' || p === 'sticky') && painted(el) && over(el) >= 0.5 * area) return { gone: false, href, hist };
    }
  }
  return { gone: true, href, hist };
}

/** Runs in the page (self-contained). Puts focus and scroll back (the box's record stays for a last check). */
export function dismissRestore(arg: { sx: number; sy: number }): void {
  const w = window as unknown as { __grntedDismiss?: { active: Element | null } };
  const prev = w.__grntedDismiss?.active as HTMLElement | null | undefined;
  const a = document.activeElement as HTMLElement | null;
  if (prev && prev.isConnected && prev !== document.body && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
  else if (a && a !== document.body && typeof a.blur === 'function') a.blur();
  window.scrollTo({ left: arg.sx, top: arg.sy, behavior: 'instant' as ScrollBehavior });
}

/** Runs in the page (self-contained). Forgets the box. */
export function dismissForget(): void {
  const w = window as unknown as { __grntedDismiss?: DismissState };
  try { w.__grntedDismiss?.observer?.disconnect(); } catch { /* gone */ }
  delete w.__grntedDismiss;
}

const quoteName = (n: string) => `“${n.length > 40 ? `${n.slice(0, 39)}…` : n}”`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withoutHash = (u: string) => u.split('#')[0]!;

/** Requests a page made, in order (one listener per page for its life: Playwright has no listener removal in `PageLike`). */
const watched = new WeakMap<PageLike, string[]>();
function requestLog(page: PageLike): string[] | null {
  const had = watched.get(page);
  if (had) return had;
  if (typeof page.on !== 'function') return null;
  const log: string[] = [];
  page.on('request', (r: RequestLike) => {
    if (log.length < 5000) {
      try { log.push(r.url()); } catch { log.push(''); }
    }
  });
  watched.set(page, log);
  return log;
}

/**
 * Proves that the box at CSS selector `box` can be dismissed by keyboard (see the top of this file).
 * Needs `page.keyboard` and request events (`page.on`). Never throws: a page that stops answering gives
 * "not dismissed" with the reason. The box stays closed when it closed (the caller decides whether the
 * page must be reloaded).
 */
export async function proveDismiss(ctx: Pick<ProbeContext, 'page' | 'guard'>, boxSelector: string, opts: DismissOptions = {}): Promise<DismissResult> {
  const { page, guard } = ctx;
  const box = boxSelector;
  const settleMs = opts.settleMs ?? 400;
  const stayMs = opts.stayMs ?? 2200;
  const restoreMs = opts.restoreMs ?? 300;
  const tried: DismissTry[] = [];
  if (!page.keyboard) return { dismissed: false, why: 'the browser cannot send key presses to this page', tried };
  const requests = requestLog(page);
  if (!requests) return { dismissed: false, why: 'the test cannot see the requests a key press sends on this page', tried };
  let start: Awaited<ReturnType<typeof dismissCandidates>>;
  try {
    start = await page.evaluate(dismissCandidates, { box, pattern: DISMISS_NAME.source, max: opts.maxControls ?? 3, ...(opts.noHashLinks ? { noHash: true } : {}) });
  } catch {
    return { dismissed: false, why: 'the page did not answer', tried };
  }
  const gone = () => page.evaluate(dismissGone, undefined).catch(() => ({ gone: false, href: start.href, hist: start.hist }));
  // Only the fragment may change (a link to "#"): any other address, or a new history entry for the same one, is the page moving on.
  const moved = (now: { href: string; hist: number }) =>
    withoutHash(now.href) !== withoutHash(start.href) || (now.hist > start.hist && now.href === start.href);
  const held = (mark: number) => guard.since(mark).find((e) => e.kind !== 'websocket' && !(e.kind === 'url-change' && !!e.url && withoutHash(e.url) === withoutHash(start.href)));
  const sent = (from: number) => requests.slice(from).find((u) => !isAnalyticsAddress(u));
  try {
    if (!start.found) return { dismissed: false, why: 'the box is no longer on the page', tried };
    if (!start.candidates.length && !opts.escapeFirst) return { dismissed: false, why: 'nothing in it that closes it can be reached with the keyboard', tried };
    let heldEv: GuardEvent | undefined;
    let request: string | undefined;
    // Observation starts before the first focus or key: a focus handler that sends something counts too.
    const mark = guard.mark();
    const from = requests.length;
    const check = async (): Promise<DismissTry['outcome'] | 'gone'> => {
      const now = await gone();
      const ev = held(mark);
      if (ev) { heldEv = ev; return ev.kind === 'url-change' ? 'address' : 'guard'; }
      const req = sent(from);
      if (req !== undefined) { request = req; return 'request'; }
      if (moved(now)) return 'address';
      return now.gone ? 'gone' : 'not-closed';
    };
    const bad = (o: DismissTry['outcome']) => o === 'guard' || o === 'address' || o === 'came-back' || o === 'request';
    /** Presses `key` where focus is and judges it; 'dismissed', 'not-closed' or a stopping outcome. */
    const tryKey = async (base: { name: string; path: string }, key: 'Enter' | 'Space' | 'Escape'): Promise<DismissTry['outcome']> => {
      await page.keyboard!.press(key === 'Space' ? ' ' : key);
      await sleep(settleMs);
      const first = await check();
      if (first !== 'gone') { tried.push({ ...base, key, outcome: first }); return first; }
      await sleep(stayMs);
      const later = await check();
      if (later !== 'gone') { const o = later === 'not-closed' ? 'came-back' : later; tried.push({ ...base, key, outcome: o }); return o; }
      // Focus and the scroll position put back: a box that a scroll (or focus) brings back is not closed.
      await page.evaluate(dismissRestore, { sx: start.sx, sy: start.sy }).catch(() => {});
      await sleep(restoreMs);
      const last = await check();
      if (last !== 'gone') { const o = last === 'not-closed' ? 'came-back' : last; tried.push({ ...base, key, outcome: o }); return o; }
      tried.push({ ...base, key, outcome: 'dismissed' });
      return 'dismissed';
    };
    const done = (base: { name: string; path: string }, key: 'Enter' | 'Space' | 'Escape'): DismissResult => ({ dismissed: true, by: { ...base, key }, tried });
    const failed = (): DismissResult => ({ dismissed: false, why: whyNot(tried), tried, ...(heldEv ? { held: heldEv } : {}), ...(request !== undefined ? { request } : {}) });
    if (opts.escapeFirst) {
      const base = { name: 'Escape', path: box };
      const o = await tryKey(base, 'Escape');
      if (o === 'dismissed') return done(base, 'Escape');
      if (bad(o)) return failed();
    }
    /** Presses Enter (then Space, for a control that is not a link and still has focus) on the focused candidate. */
    const pressOn = async (c: Candidate, focused: () => Promise<boolean>): Promise<DismissTry['outcome']> => {
      const base = { name: c.name, path: c.path };
      for (const key of (c.link ? ['Enter'] : ['Enter', 'Space']) as ('Enter' | 'Space')[]) {
        if (key === 'Space' && !(await focused())) break;
        const o = await tryKey(base, key);
        if (o !== 'not-closed') return o;
      }
      return 'not-closed';
    };
    if (opts.keyboardReach) {
      // Each control is reached by real Tab presses (Tab, then Shift+Tab; Shift+Tab first for a box in the second half
      // of the document, so the walk crosses as little of the page as it can), from where focus was: inside the box, or
      // the document. A control reached is pressed unless one that ranks before it (Close or Reject before Accept) has
      // not been tried yet; a second round presses, in their order, the ones reached and passed over.
      const pending = new Set(start.candidates.map((c) => c.i));
      const reached = new Set<number>();
      const rankOf = (i: number) => {
        const n = start.candidates.find((c) => c.i === i)?.name ?? '';
        return /\b(account|delete|remove|sign\s*out|log\s*out|unsubscribe|cancel\s+subscription)\b/i.test(n) ? 1 : /\b(accept|agree|allow)/i.test(n) ? 2 : /\b(close|dismiss|no,? thanks|reject|decline|deny|hide|minimi[sz]e)\b|^\s*[×✕✖xX]\s*$/i.test(n) ? 0 : 1;
      };
      const late = await page.evaluate(dismissLate, undefined).catch(() => false);
      const dirs = (late ? ['Shift+Tab', 'Tab'] : ['Tab', 'Shift+Tab']) as ('Tab' | 'Shift+Tab')[];
      for (let round = 0; round < 2 && pending.size; round++) {
        for (const dir of dirs) {
          if (!pending.size) break;
          await page.evaluate(dismissRestore, { sx: start.sx, sy: start.sy }).catch(() => {});
          await page.evaluate(dismissStart, undefined).catch(() => false);
          for (let n = 0; n <= (opts.maxTabs ?? 30) && pending.size; n++) {
            if (n > 0) await page.keyboard.press(dir);
            const i = await page.evaluate(dismissActive, undefined).catch(() => -1);
            // Tabbing itself must send nothing and go nowhere (a focus handler that posts is the page acting).
            const quiet = await check();
            if (quiet !== 'not-closed' && quiet !== 'gone') { tried.push({ name: dir, path: box, outcome: quiet }); return failed(); }
            const c = start.candidates.find((x) => x.i === i);
            if (!c || !pending.has(i)) continue;
            reached.add(i);
            if ([...pending].some((j) => j !== i && rankOf(j) < rankOf(i) && (round === 0 || reached.has(j)))) continue;
            pending.delete(i);
            const o = await pressOn(c, async () => (await page.evaluate(dismissActive, undefined).catch(() => -1)) === i);
            if (o === 'dismissed') return done({ name: c.name, path: c.path }, tried[tried.length - 1]!.key as 'Enter' | 'Space');
            if (bad(o)) return failed();
          }
        }
        if (![...pending].some((j) => reached.has(j))) break;
      }
      for (const c of start.candidates) if (pending.has(c.i)) tried.push({ name: c.name, path: c.path, outcome: 'no-focus' });
      return failed();
    }
    for (const c of start.candidates) {
      const base = { name: c.name, path: c.path };
      if (!(await page.evaluate(dismissFocus, c.i).catch(() => false))) { tried.push({ ...base, outcome: 'no-focus' }); continue; }
      // A focus that already sent something or went somewhere stops the proof.
      const quiet = await check();
      if (quiet !== 'not-closed' && quiet !== 'gone') { tried.push({ ...base, outcome: quiet }); break; }
      const o = await pressOn(c, () => page.evaluate(dismissFocus, c.i).catch(() => false));
      if (o === 'dismissed') return done(base, tried[tried.length - 1]!.key as 'Enter' | 'Space');
      if (bad(o)) break;
    }
    return failed();
  } finally {
    await page.evaluate(dismissRestore, { sx: start.sx, sy: start.sy }).catch(() => {});
    await page.evaluate(dismissForget, undefined).catch(() => {});
  }
}

/** Why the box was not dismissed, in words, from the last decisive try. */
export function whyNot(tried: readonly DismissTry[]): string {
  const last = [...tried].reverse().find((t) => t.outcome !== 'no-focus') ?? tried[tried.length - 1];
  if (!last) return 'nothing in it that closes it can be reached with the keyboard';
  const c = `its ${quoteName(last.name)} control`;
  if (last.key === 'Escape' || !last.key && (last.name === 'Tab' || last.name === 'Shift+Tab') && last.outcome !== 'no-focus') {
    const what = last.key === 'Escape' ? 'pressing Escape' : 'moving keyboard focus into it';
    const unreached = tried.filter((t) => t.outcome === 'no-focus');
    switch (last.outcome) {
      case 'not-closed': return `pressing Escape does not close it${unreached.length ? `, and the Tab key does not reach its ${quoteName(unreached[0]!.name)} control` : ''}`;
      case 'came-back': return 'it comes back right after it is closed';
      case 'guard': return `${what} sends a request or loads a page, which the test does not let happen`;
      case 'request': return `${what} also sends a request to the site, so the test cannot count it as closing the box`;
      case 'address': return `${what} changes the page's address`;
      default: return 'it could not be closed';
    }
  }
  switch (last.outcome) {
    case 'no-focus': return `${c} does not take keyboard focus`;
    case 'not-closed': return `pressing Enter${last.key === 'Space' ? ' or Space' : ''} on ${c} does not close it`;
    case 'came-back': return 'it comes back right after it is closed';
    case 'guard': return `pressing ${last.key ?? 'Enter'} on ${c} sends a request or loads a page, which the test does not let happen`;
    case 'request': return `pressing ${last.key ?? 'Enter'} on ${c} also sends a request to the site, so the test cannot count it as closing the box`;
    case 'address': return `pressing ${last.key ?? 'Enter'} on ${c} changes the page's address`;
    default: return 'it could not be closed';
  }
}
