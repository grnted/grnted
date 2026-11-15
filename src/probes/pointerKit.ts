// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared parts of the pointer probes (Plan 4 Task 4.5: 2.5.1, 2.5.2, 2.5.7): the name vocabularies,
// the in-page kit (hit testing through shadow roots, names, state snapshots, synthetic gestures, the
// click blocker), and the check for pointer handlers inside the page's own frames. Engine core: no
// Node-only imports.
//
// Safety (Plan 4 rule 1; on top of the request guard):
// - Elements whose name says they perform an action (log out, delete, subscribe, checkout, pay…) are
//   never pressed, dragged or swiped.
// - While a pointer test runs, a capture listener on window cancels every click, auxclick, dblclick,
//   contextmenu, submit and native drag start (preventDefault + stopImmediatePropagation), so no click
//   ever completes, and records which elements a click would have reached.
// - Gestures are synthetic events dispatched in the page: they never produce a click or a browser
//   default action (untrusted events do not activate links or submit forms).
// - Drags only drop an item onto its own sibling in the same list, with an empty DataTransfer (no
//   files). Anything the request guard stops makes that test `not_testable`, never a clean result.
import type { FrameLike } from '../types.js';
import { isAnalyticsAddress } from '../analytics.js';
import { STATIC_FILE_HOSTS, blockedReason, isBackgroundWrite, onHostList } from './guard.js';
import type { GuardEvent, ProbeContext, RecordedListener } from './types.js';

/** Where the kit lives on `window` (non-enumerable). */
export const POINTER_KEY = '__grntedPointer';

/**
 * Names that mark an action on the live site (log out, sign off, delete, subscribe, checkout, pay,
 * end session, close account…): such elements are never pressed, dragged or swiped.
 */
export const ACTION_NAME = String.raw`\b(log\s*-?\s*(out|off)|log\s+me\s+(out|off)|sign\s*-?\s*(out|off)|sign\s+me\s+(out|off)|delete|remove|subscribe|unsubscribe|check\s*-?\s*out|buy|pay|payment|purchase|donate|cancel|place\s+order|order\s+now|end\s+(the\s+|my\s+|this\s+)?session|deactivate|close\s+(my\s+|your\s+|the\s+|this\s+)?account)\b`;

/**
 * The single-pointer alternatives a probe accepts next to a gesture or a drag: unambiguous whole
 * names (accessible name or title, never a class name). A nearby word from a long list is no proof;
 * other names leave the result `not_testable` when no accepted name is found.
 */
export const ALTERNATIVES = {
  /** Carousels: next/previous (slide), go to slide N, slide N, a number, an arrow. */
  swipe: String.raw`^\s*(next|previous|prev)(\s+(slide|item|image|picture|photo|page|story))?\s*$|^\s*(go\s+to\s+)?(slide|item|image|picture|photo|page)\s+\d{1,3}\s*$|^\s*\d{1,2}\s*$|^\s*[‹›«»<>←→⟨⟩❮❯◀▶◁▷⇐⇒〈〉]\s*$`,
  /** Panned content (maps): pan up/down/left/right, or an arrow. */
  pan: String.raw`^\s*pan\s+(up|down|left|right|north|south|east|west)\s*$|^\s*[←→↑↓⇐⇒⇑⇓▲▼◀▶]\s*$`,
  /** Zoomed content: zoom in/out, plus or minus signs. */
  zoom: String.raw`^\s*zoom\s+(in|out)\s*$|^\s*[+\-−–]\s*$`,
  /** Sliders: increase/decrease (something), plus, minus, an arrow. */
  slider: String.raw`^\s*(increase|decrease)(\s+[\w ]{1,30})?\s*$|^\s*[+\-−–‹›←→]\s*$`,
  /** Sortable lists: move up/down (something), move (something) up/down, an arrow. */
  sort: String.raw`^\s*move\s+(up|down)(\s+[\w ]{1,30})?\s*$|^\s*move\s+[\w ]{1,30}?\s+(up|down)(\s+[\w ]{1,30})?\s*$|^\s*[↑↓▲▼]\s*$`,
} as const;
export type AlternativeKind = keyof typeof ALTERNATIVES;

/** The name says the element performs an action (never pressed or dragged). */
export function isActionName(name: string | undefined): boolean {
  return !!name && new RegExp(ACTION_NAME, 'i').test(name);
}

/** The name fits a single-pointer alternative of this kind. */
export function isAlternativeName(kind: AlternativeKind, name: string | undefined): boolean {
  return !!name && new RegExp(ALTERNATIVES[kind], 'i').test(name);
}

/** A rectangle in viewport CSS pixels. */
export type Box = [x: number, y: number, w: number, h: number];

/** A page-state difference, as the kit reports it. */
export interface StateDiff {
  changed: boolean;
  url?: string;
  scrolled?: boolean;
  /** Elements that became visible / hidden (outside the pressed element). */
  shown: number;
  hidden: number;
  /** The pressed element's own text or state (aria-pressed/expanded/checked/selected) changed. */
  own?: string;
  /** Text of the first element that became visible, or the new text. */
  text?: string;
  /** Everything that became visible is a list of choices (menu, listbox), opened by the pressed element. */
  choices?: boolean;
  /** Text of another element that changed (the first one, before and after). */
  textChange?: { from: string; to: string };
  /** Form fields whose value or checked state changed. */
  values?: number;
}

/** Arguments of the in-page gesture. */
export interface GestureArg {
  key: string;
  family: 'pointer' | 'touch' | 'mouse';
  /** Start target: the deepest element at the first point (default) or a candidate element. */
  i?: number;
  /** Points of each pointer (one or two pointers), in viewport CSS px. */
  paths: [number, number][][];
  /** Release at the end (default true). */
  release?: boolean;
  stepMs?: number;
  /**
   * Only the moves along the paths, with no button down and nothing pressed or released (to the same targets as a
   * drag's moves): what moving the pointer over the content does by itself, such as a tooltip that follows it.
   */
  hover?: boolean;
}

/**
 * Runs in the page (self-contained): installs the kit on `window[key]`. Every operation is called as
 * `window[key].<op>(arg)` (see `kit`). Returns false when the page blocked it.
 */
export function installPointerKit(arg: { key: string; action: string; alternatives: Record<string, string> }): boolean {
  type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const W = window as unknown as Record<string, Any>;
  // Always the kit's own (a page could have put something else under this name); a page that made the
  // name unchangeable gets `false`, and the test does not run there.
  const actionRe = new RegExp(arg.action, 'i');
  const altRe: Record<string, RegExp> = {};
  for (const k of Object.keys(arg.alternatives)) altRe[k] = new RegExp(arg.alternatives[k]!, 'i');
  const target = (ref: number): unknown => (typeof W.__grntedTarget === 'function' ? W.__grntedTarget(ref) : undefined);
  const clean = (s: string | null | undefined, max = 80) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  /** CSS path from the nearest unique id (or the root of its document or shadow root). */
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
  /** Text of a subtree as an accessible name counts it: descendants' aria-label and image alt, not hidden parts. */
  const textName = (n: Node, depth = 0): string => {
    if (depth > 25) return '';
    if (n.nodeType === 3) return n.nodeValue ?? '';
    if (!(n instanceof Element)) return '';
    if (n.getAttribute('aria-hidden') === 'true' || (n instanceof HTMLElement && n.hidden) || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) return '';
    const label = n.getAttribute('aria-label');
    if (depth > 0 && label && label.trim()) return ` ${label} `;
    if (n.matches('img, area, input[type="image"]')) return ` ${n.getAttribute('alt') ?? ''} `;
    if (n.localName === 'svg') return ` ${n.querySelector('title')?.textContent ?? ''} `;
    let out = '';
    for (const k of n.shadowRoot ? [...n.shadowRoot.childNodes] : [...n.childNodes]) out += textName(k, depth + 1);
    return getComputedStyle(n).display === 'inline' ? out : ` ${out} `;
  };
  /** Accessible name, close to the spec: aria-labelledby, aria-label, image alt, button value, contents, title, placeholder. */
  const nameOf = (el: Element, max = 80): string => {
    const clean0 = clean;
    const clean1 = (x: string | null | undefined) => clean0(x, max);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const s = lb.split(/\s+/).map((id) => (id ? root.getElementById?.(id) ?? document.getElementById(id) : null)).map((x) => (x ? textName(x, 1) : '')).join(' ');
      if (s.trim()) return clean1(s);
    }
    const a = el.getAttribute('aria-label');
    if (a && a.trim()) return clean1(a);
    if (el.matches('img, area, input[type="image"]')) { const alt = el.getAttribute('alt'); if (alt && alt.trim()) return clean1(alt); }
    if (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type) && el.value) return clean1(el.value);
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
      const text = clean1(textName(el));
      if (text) return text;
    }
    const title = el.getAttribute('title') || el.querySelector('[title]')?.getAttribute('title');
    if (title && title.trim()) return clean1(title);
    return clean1(el.getAttribute('placeholder'));
  };
  const shown = (el: Element, opacity = true): boolean => {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: opacity, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  /** The deepest element at a point, through open shadow roots. */
  const deepHit = (x: number, y: number): Element | null => {
    let h = document.elementFromPoint(x, y);
    for (let i = 0; h?.shadowRoot && i < 20; i++) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  };
  /** `inner` is `outer` or inside it, across shadow roots (closed ones through their host). */
  const within = (outer: Node, inner: Node | null): boolean => {
    for (let n: Node | null = inner; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === outer) return true;
    return false;
  };
  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [tabindex]';
  const box = (el: Element): [number, number, number, number] => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };
  /** The hosts of the closed shadow roots around an element (hit testing stops at them). */
  const closedHosts = (el: Element): Element[] => {
    const out: Element[] = [];
    for (let root = el.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) if (root.mode === 'closed') out.push(root.host);
    return out;
  };
  const SUBMITTER = 'button, input[type="submit"], input[type="image"]';
  const isSubmitter = (e: Element) => e.matches(SUBMITTER) && (e.matches('input[type="image"]') || ((e as HTMLButtonElement).type === 'submit' && !!(e as HTMLButtonElement).form));
  const FORM_CONTROL = 'input:not([type="button"]):not([type="reset"]), select, textarea, option, [contenteditable=""], [contenteditable="true"]';
  /** Named for an action: its own label or title, or (for a control or an image) its accessible name. */
  /** Controls by their element or role (`INTERACTIVE` without the bare tabindex). */
  const CONTROL = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"]';
  const actionNamed = (e: Element): boolean => {
    if (actionRe.test(`${e.getAttribute('aria-label') ?? ''} | ${e.getAttribute('title') ?? ''}`)) return true;
    if (e.matches(CONTROL) || e.matches('img, [onclick]')) return actionRe.test(nameOf(e, 300));
    // An element that only takes focus (a tabindex): a control when it is a Tab stop with a control's short
    // name. A focus target (tabindex="-1": the main content a skip link jumps to, a section) or a whole
    // region of text is not "named for an action" by a word in its text (2026-11-10: a main content that
    // mentions paying refused every drag and press test on its page).
    if (e.matches('[tabindex]') && e.getAttribute('tabindex') !== '-1') {
      const name = nameOf(e, 300);
      return name.length <= 80 && actionRe.test(name);
    }
    return false;
  };
  /**
   * Why pressing, tapping or dropping at this element could act on the site, or '' when it may be
   * used: it or an ancestor (through shadow hosts) is a link, a submitter, a form control or native
   * picker, or named for an action. The elements in `full` (the pressed element, the deepest hit) are
   * refused when their accessible name names an action, whatever they are; ancestors only when they
   * are controls or carry that name in a label or title (a section that mentions "delete" is not refused).
   */
  const refusal = (start: Element | null, full: readonly (Element | null)[] = []): string => {
    for (let n: Element | null = start, d = 0; n && d < 60; d++) {
      if (n === document.body || n === document.documentElement) break;
      if (n.matches('a[href], area[href], [role="link"]')) return 'link';
      if (isSubmitter(n)) return 'submitter';
      if (n.matches(FORM_CONTROL)) return 'form';
      if (actionNamed(n) || (full.includes(n) && actionRe.test(nameOf(n, 300)))) return 'action';
      n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
    }
    return '';
  };
  /**
   * A point on the element the pointer reaches (the deepest hit is inside it) and may be used there;
   * `refused` when every reachable point is a control the probes never use; null when none is reachable.
   */
  const pointOn = (el: Element, grid = false, realMouse = false): { x: number; y: number } | { refused: string } | null => {
    const r = el.getBoundingClientRect();
    const vw = innerWidth;
    const vh = innerHeight;
    const hosts = closedHosts(el);
    // The real mouse hit-tests into a closed shadow root, which the page cannot: what it would press there cannot be seen.
    if (hosts.length && realMouse) return { refused: 'closed' };
    if (hosts.length) {
      const own = refusal(el);
      // Inside a closed shadow root the hit test ends at its host: trust the centre when the host is hit there.
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = x > 0 && y > 0 && x < vw - 1 && y < vh - 1 ? deepHit(x, y) : null;
      if (!hit || !hosts.includes(hit)) return null;
      return own ? { refused: own } : { x, y };
    }
    const F = [0.5, 0.3, 0.7, 0.15, 0.85];
    const points: [number, number][] = grid ? F.flatMap((fx) => F.map((fy) => [fx, fy] as [number, number])) : [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.15, 0.5], [0.85, 0.5]];
    let refused = '';
    for (const [fx, fy] of points) {
      const x = Math.round(r.left + r.width * fx);
      const y = Math.round(r.top + r.height * fy);
      if (x < 1 || y < 1 || x > vw - 2 || y > vh - 2) continue;
      const hit = deepHit(x, y);
      if (!hit || !within(el, hit)) continue;
      const why = refusal(hit, realMouse ? [hit, el] : [hit]);
      if (!why) return { x, y };
      refused ||= why;
    }
    return refused ? { refused } : null;
  };
  const isPoint = (p: unknown): p is { x: number; y: number } => !!p && typeof (p as { x?: unknown }).x === 'number';
  /** Content `reach` hid to get to a candidate, with its own visibility style, to put back (`uncovered`). */
  const covers: { el: HTMLElement; value: string; priority: string; name: string }[] = [];
  /** The outermost box fixed or sticky on the screen that the hit at a point belongs to, when it is not the element's own content and does not contain it. */
  const coverAt = (el: Element, x: number, y: number): HTMLElement | null => {
    const hit = deepHit(x, y);
    if (!hit || within(el, hit) || within(hit, el)) return null;
    let top: HTMLElement | null = null;
    for (let n: Element | null = hit, d = 0; n && d < 60; d++) {
      if (n === document.body || n === document.documentElement) break;
      const pos = getComputedStyle(n).position;
      if ((pos === 'fixed' || pos === 'sticky') && n instanceof HTMLElement && !within(n, el)) top = n;
      n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
    }
    return top;
  };
  /**
   * A point on a candidate (`pointOn`) after scrolling it to the middle of the screen; when content
   * fixed to the screen covers it (a header, a banner, a cookie notice, a chat button), that content is
   * hidden (visibility only, until `uncovered` puts it back), at most 3 boxes, and the point is looked
   * for again.
   */
  const reach = (el: Element, grid: boolean, realMouse: boolean, block: ScrollLogicalPosition = 'center'): ReturnType<typeof pointOn> => {
    el.scrollIntoView({ block, inline: 'center', behavior: 'instant' as ScrollBehavior });
    let p = pointOn(el, grid, realMouse);
    for (let k = 0; k < 3 && p === null; k++) {
      const r = el.getBoundingClientRect();
      const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2));
      const y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2));
      const cover = coverAt(el, x, y);
      if (!cover) break;
      const id = cover.id ? `#${cover.id}` : '';
      covers.push({ el: cover, value: cover.style.getPropertyValue('visibility'), priority: cover.style.getPropertyPriority('visibility'), name: `${cover.localName}${id}` });
      cover.style.setProperty('visibility', 'hidden', 'important');
      p = pointOn(el, grid, realMouse);
    }
    return p;
  };

  // --- Page state (2.5.2) -----------------------------------------------------------------------
  interface Snap {
    url: string; sx: number; sy: number; shown: Set<Element>; hosts: Map<Element, string>; own: string; text: string;
    /** Each shown element's own text (its text nodes), and each form field's value or checked state. */
    texts: Map<Element, string>; values: Map<Element, string>;
  }
  const OWN_ATTRS = ['aria-pressed', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-current', 'open', 'hidden'];
  const snaps = new Map<string, Snap>();
  /** Elements of the document and of open shadow roots, in order (at most `max`). */
  const elements = (max: number): Element[] => {
    const out: Element[] = [];
    const walk = (root: Document | ShadowRoot | Element) => {
      const all = root.querySelectorAll('*');
      for (let k = 0; k < all.length && out.length < max; k++) {
        const e = all[k]!;
        out.push(e);
        if (e.shadowRoot) walk(e.shadowRoot);
      }
    };
    walk(document.body ?? document.documentElement);
    return out;
  };
  const valueOf = (e: Element): string | null => {
    if (e instanceof HTMLInputElement) return /^(checkbox|radio)$/.test(e.type) ? String(e.checked) : e.value;
    if (e instanceof HTMLSelectElement) return String(e.selectedIndex);
    if (e instanceof HTMLTextAreaElement) return e.value;
    return null;
  };
  const snap = (el: Element | null): Snap => {
    const set = new Set<Element>();
    const hosts = new Map<Element, string>();
    const texts = new Map<Element, string>();
    const values = new Map<Element, string>();
    for (const e of elements(6000)) {
      if (el && within(el, e)) continue; // the pressed element's own subtree: only its text and state count
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|BR)$/.test(e.tagName)) continue;
      const v = valueOf(e);
      if (v !== null) values.set(e, v);
      if (!shown(e)) continue;
      set.add(e);
      let own = '';
      for (const n of e.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      if (own.trim()) texts.set(e, clean(own, 200));
      // A component whose shadow root cannot be read (closed): its size tells when its content changes.
      if (e.localName.includes('-') && !e.shadowRoot) {
        const r = e.getBoundingClientRect();
        hosts.set(e, `${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    const text = el ? clean(textName(el), 200) : '';
    const own = el ? OWN_ATTRS.map((a) => `${a}=${el.getAttribute(a) ?? ''}`).join('|') + `|${text}|${el ? valueOf(el) ?? '' : ''}` : '';
    return { url: location.href, sx: Math.round(scrollX), sy: Math.round(scrollY), shown: set, hosts, own, text, texts, values };
  };
  /** Adds to `into` the elements that differ between two snapshots (shown or hidden, own text, value, size of a closed component). */
  const noisyInto = (n0: Snap, n1: Snap, into: Set<Element>) => {
    for (const e of n0.shown) if (!n1.shown.has(e)) into.add(e);
    for (const e of n1.shown) if (!n0.shown.has(e)) into.add(e);
    for (const [e, t] of n1.texts) if (n0.texts.has(e) && n0.texts.get(e) !== t) into.add(e);
    for (const [e, v] of n1.values) if (n0.values.get(e) !== v) into.add(e);
    for (const [e, v] of n1.hosts) if (n0.hosts.has(e) && n0.hosts.get(e) !== v) into.add(e);
  };
  /**
   * Who changed what during a press (`trace`): elements changed while the browser dispatched the real
   * pointerdown, mousedown or touchstart (the page's own down handlers, their promises included: the
   * changes reach the observer before the event is over, while `window.event` is still that event), and
   * elements changed by anything else (timers, animation frames, other events). `press` is null when the
   * page replaced `window.event` (nothing can be told apart then) or changed too much to follow.
   */
  const PRESS_EVENTS = new Set(['pointerdown', 'mousedown', 'touchstart']);
  const eventGetter = (() => {
    try {
      const g = Object.getOwnPropertyDescriptor(window, 'event')?.get ?? Object.getOwnPropertyDescriptor(Window.prototype, 'event')?.get;
      return g && /\[native code\]/.test(Function.prototype.toString.call(g)) ? g : null;
    } catch {
      return null;
    }
  })();
  const trace: { obs: MutationObserver | null; press: Set<Element> | null; other: Set<Element>; records: number } = { obs: null, press: null, other: new Set(), records: 0 };
  const recordInto = (recs: MutationRecord[]) => {
    let ev: Event | undefined;
    try { ev = eventGetter ? (eventGetter.call(window) as Event | undefined) : undefined; } catch { ev = undefined; }
    const into = ev && ev.isTrusted && PRESS_EVENTS.has(ev.type) ? trace.press : trace.other;
    for (const r of recs) {
      if (++trace.records > 20000) { trace.press = null; return; }
      const t = r.target.nodeType === 1 ? r.target as Element : r.target.parentElement;
      if (t) (into ?? trace.other).add(t);
      for (const n of r.addedNodes) if (n.nodeType === 1) (into ?? trace.other).add(n as Element);
    }
  };
  /** Elements seen changing by themselves while the page was watched (`watch`), by label. */
  const watchedSets = new Map<string, Set<Element>>();
  /**
   * The element, or one around it, was seen changing by itself. Its ancestors are not: a panel a
   * press opened stays a change of the press when a clock inside it ticks.
   */
  const selfChanging = (seen: ReadonlySet<Element> | undefined, e: Element) => !!seen?.size && [...seen].some((x) => x === e || x.contains(e));
  const MEDIA = 'img, picture, source, video, audio, iframe, embed, object';
  const srcOf = (m: Element) => { const v = m.getAttribute('src') ?? m.getAttribute('data') ?? ''; try { return new URL(v, location.href).href.split('#')[0]!; } catch { return v; } };
  /** It shows nothing but media whose request the guard stopped (what an aborted request would have shown). */
  const onlyStopped = (e: Element, stopped: ReadonlySet<string>): boolean => {
    if (!stopped.size) return false;
    const media = e.matches(MEDIA) ? [e] : [...e.querySelectorAll(MEDIA)];
    return media.length > 0 && media.every((m) => stopped.has(srcOf(m))) && !clean(textName(e));
  };
  const diff = (a: Snap, b: Snap, el: Element | null, stopped: ReadonlySet<string> = new Set()) => {
    const appeared: Element[] = [];
    let hidden = 0;
    for (const e of b.shown) if (!a.shown.has(e) && !onlyStopped(e, stopped)) appeared.push(e);
    for (const e of a.shown) if (!b.shown.has(e)) hidden++;
    let resized = 0;
    for (const [e, size] of b.hosts) if (a.hosts.has(e) && a.hosts.get(e) !== size) resized++;
    // Elements that only moved in or out with a list of choices the pressed element opened.
    const CHOICES = '[role="menu"], [role="listbox"], [role="tree"], [role="grid"], [role="dialog"][aria-modal="false"]';
    const roots = appeared.filter((e) => !appeared.some((o) => o !== e && o.contains(e)));
    const choices = !!el && roots.length > 0 && hidden === 0 && resized === 0 && roots.every((e) => e.matches(CHOICES) || !!e.closest('[role="menu"], [role="listbox"], [role="tree"]'))
      && a.url === b.url && a.sx === b.sx && a.sy === b.sy;
    const first = roots.find((e) => clean((e as HTMLElement).innerText ?? e.textContent));
    const out: StateDiff = { changed: false, shown: roots.length + resized, hidden };
    if (a.url !== b.url) out.url = b.url;
    if (a.sx !== b.sx || a.sy !== b.sy) out.scrolled = true;
    if (a.own !== b.own) out.own = b.text !== a.text ? `its text becomes “${clean(b.text, 60)}”` : 'its state changes';
    if (first) out.text = clean((first as HTMLElement).innerText ?? first.textContent, 60);
    if (choices) out.choices = true;
    for (const [e, t] of b.texts) {
      const before = a.texts.get(e);
      if (before !== undefined && before !== t) { out.textChange = { from: clean(before, 60), to: clean(t, 60) }; break; }
    }
    let values = 0;
    for (const [e, v] of b.values) if (a.values.has(e) && a.values.get(e) !== v) values++;
    if (values) out.values = values;
    out.changed = !!(out.url || out.scrolled || out.own || out.shown || hidden || out.textChange || values);
    return out;
  };

  // --- Clicks cancelled while a test runs: the listener hook's canceller (registered before any page
  // script, on window in the capture phase), turned on and off here.
  type Hold = (op: string, a?: unknown) => { reached: string[]; submits: number; on?: boolean } | boolean;
  const hold = (): Hold => {
    const h = W.__grntedHold as Hold | undefined;
    if (typeof h !== 'function') throw new Error('the click canceller of the listener hook is not installed');
    return h;
  };
  /** The element a synthetic touch started on (touch events keep it as their target). */
  let touchStart: Element | null = null;
  /** Element sizes saved before a pinch, per candidate. */
  const sizes = new Map<number, Map<Element, number>>();

  // --- Candidates --------------------------------------------------------------------------------
  const cands: Element[] = [];
  /** The controls shown when a sortable list's page-wide search began (`sortElsewhere`), for `sortRevealed`. */
  let sortShown: WeakSet<Element> | null = null;
  /** The elements the page listens for clicks on (listener references), as that search was given them. */
  let sortClicks: number[] = [];
  /** Every element that had a box then (null: too many to compare). */
  let sortBoxed: WeakSet<Element> | null = null;
  const STATE = /active|current|open|show|selected|hover|focus|first|last|odd|even|\d/i;
  const signature = (el: Element) => {
    const cls = (e: Element | null) => (e ? [...e.classList].filter((x) => !STATE.test(x)).sort().slice(0, 3).join('.') : '');
    const host = (el.getRootNode() as ShadowRoot).host;
    // An id marks a widget of its own; elements without one that look alike share their handlers.
    return `${el.localName}${el.id ? `#${el.id}` : ''}.${cls(el)}|${el.parentElement?.localName ?? ''}.${cls(el.parentElement)}|${host ? host.localName : ''}`;
  };
  const isWrapper = (el: Element) => {
    const r = el.getBoundingClientRect();
    return el === document.body || el === document.documentElement || !!el.querySelector('main, header, nav, footer, [role="main"], [role="banner"]')
      || r.height > innerHeight * 2 || (r.width >= innerWidth * 0.95 && r.height >= innerHeight * 0.95);
  };
  const sliderRoot = (el: Element): Element | null => el.closest('[role="slider"], input[type="range"]') ?? el.querySelector('[role="slider"], input[type="range"]');

  // --- Synthetic gestures ------------------------------------------------------------------------
  const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
  const pointerInit = (x: number, y: number, id: number, primary: boolean, buttons: number, type: string): PointerEventInit => ({
    bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y,
    pointerId: id, pointerType: type, isPrimary: primary, button: 0, buttons, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
  });
  const touchOf = (t: EventTarget, id: number, x: number, y: number) =>
    new Touch({ identifier: id, target: t, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY, screenX: x, screenY: y, radiusX: 1, radiusY: 1, force: 0.5 });
  const touchEvent = (type: string, touches: Touch[], changed: Touch[]) =>
    new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, touches, targetTouches: touches, changedTouches: changed });

  async function gesture(a: GestureArg): Promise<{ ok: boolean; refused?: string }> {
    const paths = a.paths;
    const p0 = paths[0]?.[0];
    if (!p0) return { ok: false };
    const start = typeof a.i === 'number' ? cands[a.i] ?? null : null;
    const starts = paths.map((p) => deepHit(p[0]![0], p[0]![1]) ?? start ?? document.body);
    // Never start a gesture on a link, a submitter, a form control or a control named for an action.
    for (const t of starts) { const why = refusal(t, [t]); if (why) return { ok: false, refused: why }; }
    const upOn = (x: number, y: number) => { const h = deepHit(x, y); return h && !refusal(h, [h]) ? h : starts[0]!; };
    const steps = Math.max(...paths.map((p) => p.length));
    const stepMs = a.stepMs ?? 16;
    const release = a.release !== false;
    const at = (k: number, s: number): [number, number] => { const p = paths[k]!; return p[Math.min(s, p.length - 1)]!; };
    if (a.hover) {
      for (let s = 0; s < steps; s++) {
        if (s) await sleep(stepMs);
        paths.forEach((_, k) => {
          const [x, y] = at(k, s);
          if (a.family === 'pointer') starts[k]!.dispatchEvent(new PointerEvent('pointermove', pointerInit(x, y, k + 1, k === 0, 0, 'touch')));
          else if (a.family === 'touch') { const t = touchOf(starts[k]!, k + 1, x, y); starts[k]!.dispatchEvent(touchEvent('touchmove', [t], [t])); }
          else (deepHit(x, y) ?? starts[0]!).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0 }));
        });
      }
      return { ok: true };
    }
    if (a.family === 'pointer') {
      paths.forEach((_, k) => { const [x, y] = at(k, 0); starts[k]!.dispatchEvent(new PointerEvent('pointerdown', pointerInit(x, y, k + 1, k === 0, 1, 'touch'))); });
      for (let s = 1; s < steps; s++) {
        await sleep(stepMs);
        paths.forEach((_, k) => { const [x, y] = at(k, s); starts[k]!.dispatchEvent(new PointerEvent('pointermove', pointerInit(x, y, k + 1, k === 0, 1, 'touch'))); });
      }
      if (release) {
        await sleep(stepMs);
        paths.forEach((_, k) => { const [x, y] = at(k, steps - 1); starts[k]!.dispatchEvent(new PointerEvent('pointerup', pointerInit(x, y, k + 1, k === 0, 0, 'touch'))); });
      }
    } else if (a.family === 'touch') {
      const now = (s: number) => paths.map((_, k) => { const [x, y] = at(k, s); return touchOf(starts[k]!, k + 1, x, y); });
      const first = now(0);
      for (let k = 0; k < paths.length; k++) starts[k]!.dispatchEvent(touchEvent('touchstart', first.slice(0, k + 1), [first[k]!]));
      for (let s = 1; s < steps; s++) {
        await sleep(stepMs);
        const t = now(s);
        starts[0]!.dispatchEvent(touchEvent('touchmove', t, t));
      }
      if (release) {
        await sleep(stepMs);
        const last = now(steps - 1);
        for (let k = paths.length - 1; k >= 0; k--) starts[k]!.dispatchEvent(touchEvent('touchend', last.slice(0, k), [last[k]!]));
      }
    } else {
      const init = (x: number, y: number, buttons: number): MouseEventInit => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons });
      const [x0, y0] = at(0, 0);
      starts[0]!.dispatchEvent(new MouseEvent('mousedown', init(x0, y0, 1)));
      for (let s = 1; s < steps; s++) {
        await sleep(stepMs);
        const [x, y] = at(0, s);
        (deepHit(x, y) ?? starts[0]!).dispatchEvent(new MouseEvent('mousemove', init(x, y, 1)));
      }
      if (release) {
        await sleep(stepMs);
        const [x, y] = at(0, steps - 1);
        upOn(x, y).dispatchEvent(new MouseEvent('mouseup', init(x, y, 0)));
      }
    }
    return { ok: true };
  }

  // --- Drag helpers (2.5.7) ----------------------------------------------------------------------
  /** The list an item belongs to, and its sibling to drop on (next, else previous). */
  /**
   * A sortable item's list and the sibling it is dropped on (the next one, else the last), and the
   * sibling on the other side for a second drop (see `dragItem`): the previous one, else the one after
   * `other`.
   */
  const listOf = (el: Element): { item: Element; list: Element; other: Element; otherSide?: Element } | null => {
    for (let item: Element | null = el, depth = 0; item && item.parentElement && depth < 4; item = item.parentElement, depth++) {
      const list = item.parentElement!;
      const sibs = [...list.children].filter((c) => c !== item && c.localName === item!.localName && shown(c));
      if (sibs.length) {
        const kids = [...list.children];
        const idx = kids.indexOf(item);
        const next = sibs.find((c) => kids.indexOf(c) > idx);
        const other = next ?? sibs[sibs.length - 1]!;
        const prev = sibs.filter((c) => kids.indexOf(c) < idx).pop();
        const beyond = sibs.find((c) => kids.indexOf(c) > kids.indexOf(other));
        const otherSide = prev && prev !== other ? prev : beyond;
        return { item, list, other, ...(otherSide ? { otherSide } : {}) };
      }
    }
    return null;
  };
  const orderOf = (list: Element) => [...list.children].map((c) => clean((c as HTMLElement).innerText ?? c.textContent, 40)).join('|');
  /** Value of a slider: aria-valuenow, else its thumb's position. */
  const sliderValue = (el: Element) => {
    const v = el.getAttribute('aria-valuenow');
    const r = el.getBoundingClientRect();
    return { now: v, pos: Math.round(r.left + r.width / 2) * 10000 + Math.round(r.top + r.height / 2) };
  };
  /** A slider thumb's track: the nearest ancestor at least 3 times the thumb's length (up to 3 levels). */
  const trackOf = (thumb: Element): Element | null => {
    const t = thumb.getBoundingClientRect();
    const vertical = thumb.getAttribute('aria-orientation') === 'vertical';
    let track: Element | null = thumb.parentElement;
    for (let d = 0; track && d < 3; track = track.parentElement, d++) {
      const r = track.getBoundingClientRect();
      if (vertical ? r.height >= t.height * 3 : r.width >= t.width * 3) break;
    }
    return track && track !== document.body && track !== document.documentElement ? track : null;
  };
  /**
   * Every control on the page, for a page-wide search: interactive elements, menu buttons, elements with a tab
   * stop or an inline click handler, and elements the page listens for clicks on now (the listener registry,
   * read afresh, with `clickRefs`: plain spans and divs a script makes clickable), in the document and in its
   * open shadow roots. Bounded: 30 roots, 20,000 elements looked at for roots, 6,000 matches looked at a root,
   * 4,000 controls, 2,000 listener targets.
   */
  const pageControls = (clickRefs: readonly number[]): Element[] => {
    const NATIVE = `${INTERACTIVE.replace(', [tabindex]', '')}, [aria-haspopup]`;
    const SELECTOR = `${NATIVE}, [tabindex], [onclick]`;
    const set = new Set<Element>();
    // An element with no role is a control only when it can be tabbed to or clicked and holds a control's worth of
    // text: a focus target (`main tabindex="-1"`) and a wrapper that listens for its children's clicks are none.
    const plainControl = (c: Element, listens: boolean): boolean => {
      if (c.matches(NATIVE)) return true;
      const tab = c.getAttribute('tabindex');
      if (!listens && !c.hasAttribute('onclick') && !(tab !== null && Number(tab) >= 0)) return false;
      return (c.textContent ?? '').replace(/\s+/g, ' ').trim().length <= 80 && !c.querySelector(NATIVE);
    };
    const roots: (Document | ShadowRoot)[] = [document];
    const every = document.querySelectorAll('*');
    for (let k = 0; k < every.length && k < 20_000 && roots.length < 30; k++) { const sr = every[k]!.shadowRoot; if (sr) roots.push(sr); }
    for (const root of roots) {
      const found = root.querySelectorAll(SELECTOR);
      for (let k = 0; k < found.length && k < 6000 && set.size < 4000; k++) if (plainControl(found[k]!, false)) set.add(found[k]!);
      if (root !== document) {
        const inner = root.querySelectorAll('*');
        for (let k = 0; k < inner.length && k < 2000 && roots.length < 30; k++) { const sr = inner[k]!.shadowRoot; if (sr) roots.push(sr); }
      }
    }
    // The elements the page listens for clicks on: those the test was given, and those registered since.
    const refs = new Set<number>(clickRefs.slice(0, 2000));
    try {
      const live = typeof W.__grntedListeners === 'function' ? (W.__grntedListeners() as { type?: unknown; ref?: unknown }[]) : [];
      for (let k = 0; k < live.length && k < 5000 && refs.size < 2000; k++) {
        const l = live[k]!;
        if (typeof l.ref === 'number' && typeof l.type === 'string' && /^(click|pointerup|mouseup|touchend)$/.test(l.type)) refs.add(l.ref);
      }
    } catch { /* no registry on this page */ }
    for (const ref of refs) {
      const t = target(ref);
      if (t instanceof Element && t !== document.body && t !== document.documentElement && set.size < 4000 && plainControl(t, true)) set.add(t);
    }
    return [...set];
  };
  /** Controls (by name and title only) next to a region: inside it, in ancestors up to 3 levels no more than 4× its area, or aria-controls pointing into it. */
  const nearbyControls = (el: Element, clickRefs: number[]): Element[] => {
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 1) return [];
    const area = Math.max(1, r.width * r.height);
    let scope: Element = el;
    for (let p = el.parentElement, d = 0; p && d < 3; p = p.parentElement, d++) {
      const pr = p.getBoundingClientRect();
      if (p === document.body || pr.width * pr.height > area * 4) break;
      scope = p;
    }
    const set = new Set<Element>();
    for (const c of scope.querySelectorAll(`${INTERACTIVE}, [role="slider"]`)) set.add(c);
    // Controls right next to it (within 60 px), wherever they are in the document (dots under a carousel).
    const near = 60;
    const all = document.querySelectorAll(INTERACTIVE);
    for (let k = 0; k < all.length && k < 3000; k++) {
      const c = all[k]!;
      const b = c.getBoundingClientRect();
      if (b.width && b.height && b.right > r.left - near && b.left < r.right + near && b.bottom > r.top - near && b.top < r.bottom + near) set.add(c);
    }
    for (const ref of clickRefs) { const t = target(ref); if (t instanceof Element && within(scope, t)) set.add(t); }
    const ids = new Set([el, ...el.querySelectorAll('[id]')].map((e) => e.id).filter(Boolean));
    for (const c of document.querySelectorAll('[aria-controls]')) if ((c.getAttribute('aria-controls') ?? '').split(/\s+/).some((id) => ids.has(id))) set.add(c);
    return [...set].filter((c) => c !== el && shown(c, false) && !(c instanceof HTMLInputElement && c.type === 'hidden'));
  };

  const api = {
    /**
     * Elements with down handlers (2.5.2), at most `max` pressed, with what to do with each. Elements
     * are told apart by their handlers, accessible name and id; every element not pressed (beyond the
     * limit, or the same handlers, name and id again) is counted in `more`. Refused elements (links,
     * submitters, form fields, action names) and exempt ones (sliders, native pickers) are listed
     * without taking a place. With a down handler on the document or a page-wide wrapper (event
     * delegation), plain controls (buttons, tabs, summaries; one per look and name) fill the remaining
     * places: refused ones are listed as not pressed; `delegatedEmpty` when there was none to sample.
     */
    downCandidates(o: { refs: { ref: number; types: string[] }[]; max: number; delegated: boolean }) {
      type C = { i: number; path: string; name: string; tag: string; types: string[]; href?: string; delegated?: boolean; skip?: 'action' | 'picker' | 'slider' | 'covered'; key?: true };
      // Batch 19 (precision lane): a key of an on-screen keypad or keyboard (2.5.2 Note 1: "Functions that emulate a
      // keyboard or numeric keypad key press are considered essential"): a control named with one character, or a key's
      // own word, among at least ten such controls in its group that hold every digit (a keypad) or twenty letters (a
      // keyboard). A row of page numbers is no keypad (no 0, and fewer than ten).
      const KEY_WORD = /^(?:clear|clr|back|backspace|del|delete|enter|space|shift|caps|tab|ok|go|⌫|⌦|⏎|↵|←|→)$/i;
      const keyName = (e: Element): string | null => { const n = nameOf(e, 20).trim(); return [...n].length === 1 || KEY_WORD.test(n) ? n.toLowerCase() : null; };
      const isKey = (el: Element): boolean => {
        if (!keyName(el)) return false;
        for (let g = el.parentElement, d = 0; g && d < 3; g = g.parentElement, d++) {
          const keys = [...g.querySelectorAll('button, [role="button"], input[type="button"]')].slice(0, 200).filter((e) => shown(e)).map(keyName).filter((k): k is string => !!k);
          if (keys.length < 10) continue;
          const set = new Set(keys);
          return [...'0123456789'].every((x) => set.has(x)) || [...set].filter((x) => /^\p{L}$/u.test(x)).length >= 20;
        }
        return false;
      };
      const seen = new Set<string>();
      const out: C[] = [];
      let more = 0;
      let sampled = 0;
      const ids = typeof W.__grntedHandlerIds === 'function' ? W.__grntedHandlerIds as (ref: number, types: string[]) => string[] : null;
      const list = o.refs.map((x) => ({ ...x, el: target(x.ref) })).filter((x): x is { ref: number; types: string[]; el: Element } => x.el instanceof Element);
      const rank = (el: Element) => (el.matches(INTERACTIVE) || getComputedStyle(el).cursor === 'pointer' ? 0 : 1);
      list.sort((a, b) => rank(a.el) - rank(b.el));
      const pressed = () => out.filter((x) => !x.skip).length;
      const consider = (el: Element, types: string[], key: string, delegated: boolean): void => {
        if (!el.isConnected || !shown(el) || cands.includes(el)) return;
        if (!delegated && isWrapper(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        const name = nameOf(el);
        const k = `${key}|${name}|${el.id}`;
        if (seen.has(k)) { more++; return; }
        let skip: C['skip'];
        if (el.matches('select, option, input[type="file"], input[type="range"], input[type="color"], input[type="date"], input[type="datetime-local"], input[type="month"], input[type="week"], input[type="time"]') || el.closest('select')) skip = 'picker';
        else if (sliderRoot(el)) skip = 'slider';
        else if (refusal(el, [el])) skip = 'action';
        if (delegated) sampled++;
        if (!skip && pressed() >= o.max) { more++; return; }
        if (!skip || !delegated) seen.add(k); // a refused sample does not stand for the others that look like it
        const c: C = { i: cands.length, path: cssPath(el), name, tag: el.localName, types };
        if (skip) c.skip = skip;
        else if (isKey(el)) c.key = true;
        if (delegated) c.delegated = true;
        const href = el.closest('a[href]')?.getAttribute('href') ?? undefined;
        if (href) try { c.href = new URL(href, location.href).href; } catch { /* not an address */ }
        cands.push(el);
        out.push(c);
      };
      for (const x of list) {
        const h = ids ? ids(x.ref, ['pointerdown', 'mousedown', 'touchstart']) : [];
        consider(x.el, x.types, h.length ? `h:${h.join(',')}` : `e:${x.ref}`, false);
      }
      const roots = list.filter((x) => isWrapper(x.el)).map((x) => x.el);
      const delegating = o.delegated || roots.length > 0;
      if (delegating) {
        const scope = o.delegated ? [document.body ?? document.documentElement] : roots;
        for (const root of scope) {
          const controls = root.querySelectorAll('button, [role="button"], [role="tab"], summary');
          for (let k = 0; k < controls.length && k < 600; k++) consider(controls[k]!, ['pointerdown', 'mousedown'], `s:${signature(controls[k]!)}`, true);
        }
      }
      return { list: out, more, delegatedEmpty: delegating && sampled === 0 };
    },
    /** Scrolls a candidate into view; focuses it (so focus effects are part of the baseline); its point. */
    prepare(o: { i: number; focus?: boolean; real?: boolean; uncover?: boolean }): { x: number; y: number; box: Box } | { refused: string } | null {
      const el = cands[o.i];
      if (!el || !el.isConnected) return null;
      let p: ReturnType<typeof pointOn>;
      if (o.uncover) p = reach(el, false, !!o.real);
      else {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        p = pointOn(el, false, !!o.real);
      }
      if (!isPoint(p)) return p;
      if (o.focus) (el as HTMLElement).focus?.({ preventScroll: true });
      return { ...p, box: box(el) };
    },
    /** Records the page state under a label. */
    snap(o: { i: number; label: string }) { snaps.set(o.label, snap(cands[o.i] ?? null)); },
    /** The difference between two snapshots; elements that changed by themselves between the `noise` snapshots are left out. */
    trace(o: { on: boolean }): boolean {
      if (o.on) {
        trace.obs?.disconnect();
        trace.press = eventGetter ? new Set() : null;
        trace.other = new Set();
        trace.records = 0;
        trace.obs = new MutationObserver(recordInto);
        trace.obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        return !!trace.press;
      }
      if (trace.obs) {
        recordInto(trace.obs.takeRecords());
        trace.obs.disconnect();
        trace.obs = null;
      }
      return !!trace.press;
    },
    /**
     * The difference between two snapshots; elements that changed by themselves between the `noise`
     * snapshots, or while the page was `watched`, are left out. `by: 'press'`: only what the press's own
     * handlers changed (`trace`) and nothing else touched (null when that cannot be told).
     */
    diff(o: { i: number; a: string; b: string; noise?: [string, string]; stopped?: string[]; watched?: string; by?: 'press' }): StateDiff | null {
      const a = snaps.get(o.a);
      const b = snaps.get(o.b);
      if (!a || !b) return null;
      const stopped = new Set((o.stopped ?? []).map((u) => u.split('#')[0]!));
      const noisy = new Set<Element>();
      if (o.noise) {
        const n0 = snaps.get(o.noise[0]);
        const n1 = snaps.get(o.noise[1]);
        if (!n0 || !n1) return null;
        noisyInto(n0, n1, noisy);
      }
      const seen = o.watched ? watchedSets.get(o.watched) : undefined;
      const press = o.by === 'press' ? trace.press : undefined;
      // Nothing to tell apart (no window.event, too many changes), or too much to compare in time.
      if (press === null || (press && press.size + trace.other.size > 1500)) return null;
      const covers = (set: ReadonlySet<Element>, e: Element) => [...set].some((x) => x === e || x.contains(e));
      const byPress = (e: Element) => !press || (covers(press, e) && !covers(trace.other, e));
      const quiet = (e: Element) => ![...noisy].some((x) => x === e || x.contains(e) || e.contains(x)) && !selfChanging(seen, e) && byPress(e);
      const strip = (s0: Snap): Snap => ({
        ...s0, shown: new Set([...s0.shown].filter(quiet)),
        hosts: new Map([...s0.hosts].filter(([e, v]) => !noisy.has(e) && quiet(e) && v !== undefined)),
        texts: new Map([...s0.texts].filter(([e]) => quiet(e))), values: new Map([...s0.values].filter(([e]) => quiet(e))),
        // Only content changes are told apart: the address, the scroll position and the element's own state are not.
        ...(press ? { url: a.url, sx: a.sx, sy: a.sy, own: a.own, text: a.text } : {}),
      });
      const any = noisy.size || !!seen?.size || !!press;
      return diff(any ? strip(a) : a, any ? strip(b) : b, cands[o.i] ?? null, stopped);
    },
    /**
     * Watches the page while nothing is done, for at least `minMs` and until every timer of 1 s or
     * more that ran since `since` (listener hook) has run again (at most `maxMs`): the elements that
     * change meanwhile change by themselves (stored under `label`, left out of `diff` and `restored`
     * given `watched`). A snapshot is taken on every change the page makes (so a notice that changes
     * twice is still seen) and every 100 ms (form values, open shadow roots). True when anything changed.
     */
    async watch(o: { i: number; label: string; since: number; minMs: number; maxMs: number }): Promise<boolean> {
      const el = cands[o.i] ?? null;
      const set = new Set<Element>();
      let prev = snap(el);
      let taken = 0;
      const look = () => {
        if (taken++ > 400) return;
        const next = snap(el);
        noisyInto(prev, next, set);
        prev = next;
      };
      const fired = () => (typeof W.__grntedHooks === 'function' ? (W.__grntedHooks() as { timers: { fired?: number; lastFiredAt?: number }[] }).timers : []);
      const waitFor = fired().map((t, k) => [k, t.fired ?? 0, t.lastFiredAt ?? 0] as const).filter(([, , at]) => at >= o.since);
      const observer = new MutationObserver(look);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const start = Date.now();
      try {
        for (;;) {
          await sleep(100);
          look();
          const ms = Date.now() - start;
          if (ms >= o.maxMs) break;
          const now = fired();
          if (ms >= o.minMs && waitFor.every(([k, n]) => (now[k]?.fired ?? 0) > n)) break;
        }
      } finally {
        observer.disconnect();
      }
      watchedSets.set(o.label, set);
      return set.size > 0;
    },
    /**
     * After a press changed the page (snapshots `a` before, `d` after) and Escape was pressed (`r`):
     * whether everything the press changed is back as it was in `a`.
     */
    restored(o: { a: string; d: string; r: string; watched?: string }): boolean {
      const a = snaps.get(o.a);
      const d = snaps.get(o.d);
      const r = snaps.get(o.r);
      if (!a || !d || !r) return false;
      const seen = o.watched ? watchedSets.get(o.watched) : undefined;
      if ((a.url !== d.url || a.sx !== d.sx || a.sy !== d.sy) && (r.url !== a.url || r.sx !== a.sx || r.sy !== a.sy)) return false;
      if (a.own !== d.own && r.own !== a.own) return false;
      const touched = new Set<Element>();
      for (const e of d.shown) if (!a.shown.has(e)) touched.add(e);
      for (const e of a.shown) if (!d.shown.has(e)) touched.add(e);
      for (const [e, t] of d.texts) if (a.texts.has(e) && a.texts.get(e) !== t) touched.add(e);
      for (const [e, v] of d.values) if (a.values.get(e) !== v) touched.add(e);
      for (const [e, v] of d.hosts) if (a.hosts.has(e) && a.hosts.get(e) !== v) touched.add(e);
      for (const e of touched) {
        if (selfChanging(seen, e)) continue;
        if (a.shown.has(e) !== r.shown.has(e)) return false;
        if (a.texts.get(e) !== r.texts.get(e) && a.shown.has(e)) return false;
        if (a.values.get(e) !== r.values.get(e)) return false;
        if (a.hosts.get(e) !== r.hosts.get(e) && a.hosts.has(e)) return false;
      }
      return true;
    },
    /** Starts or stops cancelling clicks, submits and (unless `drag`) native drags; returns what a cancelled click would have reached and the form sends stopped. */
    block(o: { on: boolean; i?: number; drag?: boolean }): { reached: string[]; submits: number } {
      const h = hold();
      if (o.on) {
        h('on', { drag: !!o.drag, watch: typeof o.i === 'number' ? cands[o.i] ?? null : null });
        return { reached: [], submits: 0 };
      }
      return h('off') as { reached: string[]; submits: number };
    },
    /** What the canceller saw so far (it stays on). */
    held(): { reached: string[]; submits: number } {
      return hold()('state') as { reached: string[]; submits: number };
    },
    /** Dispatches a synthetic touch for 2.5.2 (touchstart only, or the move away and lift). */
    touch(o: { i: number; phase: 'down' | 'away'; x: number; y: number; to?: { x: number; y: number } }) {
      const el = cands[o.i];
      if (!el) return false;
      if (o.phase === 'down') {
        const t0 = deepHit(o.x, o.y) ?? el;
        if (refusal(t0, [t0, el])) return false;
        touchStart = t0;
        const t = touchOf(t0, 1, o.x, o.y);
        t0.dispatchEvent(touchEvent('touchstart', [t], [t]));
        return true;
      }
      // Touch events keep the element the touch started on as their target.
      const start = touchStart ?? el;
      const to = o.to ?? { x: o.x, y: o.y };
      const t = touchOf(start, 1, to.x, to.y);
      start.dispatchEvent(touchEvent('touchmove', [t], [t]));
      start.dispatchEvent(touchEvent('touchend', [], [t]));
      return true;
    },
    /** A point outside a candidate, inside the viewport, for the synthetic touch to move to. */
    awayPoint(o: { i: number }) {
      const el = cands[o.i];
      const r = el ? el.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
      const x = r.right + 60 < innerWidth - 2 ? Math.round(r.right + 60) : Math.max(2, Math.round(r.left - 60));
      return { x, y: Math.round(Math.min(Math.max(r.top + r.height / 2, 2), innerHeight - 2)) };
    },

    /**
     * Gesture regions and drag items (2.5.1, 2.5.7). Elements running the same handlers (by identity),
     * and the other items of a list already taken, are tested once; anything else beyond the limits is
     * counted in `more`.
     */
    gestureCandidates(o: { refs: { ref: number; types: string[] }[]; maxRegions: number; maxItems: number; planned?: { path: string; types: string[] }[] }) {
      const out: { i: number; kind: 'region' | 'draggable' | 'slider' | 'handle'; path: string; name: string; types: string[]; skip?: 'action'; planned?: true }[] = [];
      const seen = new Set<string>();
      const ids = typeof W.__grntedHandlerIds === 'function' ? W.__grntedHandlerIds as (ref: number, types: string[]) => string[] : null;
      const typesOf = new Map<Element, string[]>();
      const keyOf = new Map<Element, string>();
      for (const x of o.refs) {
        const el = target(x.ref);
        if (!(el instanceof Element)) continue;
        typesOf.set(el, x.types);
        const h = ids ? ids(x.ref, ['pointerdown', 'mousedown', 'touchstart', 'pointermove', 'touchmove', 'mousemove']) : [];
        keyOf.set(el, h.length ? `h:${h.join(',')}` : `e:${x.ref}`);
      }
      const more = { regions: 0, items: 0 };
      const add = (el: Element, kind: (typeof out)[number]['kind'], key: string) => {
        if (cands.includes(el)) return;
        // Regions are told apart by handlers, name and id; a repeat is counted. Items of a list already taken are the same test.
        const k = kind === 'region' ? `${kind}|${key}|${nameOf(el)}|${el.id}` : `${kind}|${key}`;
        if (seen.has(k)) {
          if (kind === 'region') more.regions++;
          return;
        }
        seen.add(k);
        const regions = out.filter((c) => c.kind === 'region').length;
        if (kind === 'region' ? regions >= o.maxRegions : out.length - regions >= o.maxItems) {
          if (kind === 'region') more.regions++;
          else more.items++;
          return;
        }
        const c: (typeof out)[number] = { i: cands.length, kind, path: cssPath(el), name: nameOf(el), types: typesOf.get(el) ?? [] };
        if (refusal(el)) c.skip = 'action';
        cands.push(el);
        out.push(c);
      };
      const lists = new Map<Element, number>();
      const listKey = (el: Element) => {
        const l = listOf(el)?.list;
        if (!l) return null;
        if (!lists.has(l)) lists.set(l, lists.size);
        return `list:${lists.get(l)}`;
      };
      for (const [el] of typesOf) {
        if (!shown(el) || isWrapper(el) || el.matches(INTERACTIVE) || sliderRoot(el) || el.closest('[draggable="true"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 160 || r.height < 100) continue;
        add(el, 'region', keyOf.get(el)!);
      }
      for (const el of document.querySelectorAll('[draggable="true"]')) { const k = shown(el) ? listKey(el) : null; if (k) add(el, 'draggable', k); }
      for (const el of document.querySelectorAll('[role="slider"]')) if (shown(el) && !(el instanceof HTMLInputElement)) add(el, 'slider', `s:${cssPath(el)}`);
      for (const [el] of typesOf) {
        if (!shown(el) || sliderRoot(el) || el.closest('[draggable="true"]') || cands.includes(el)) continue;
        if (!/^(grab|move|grabbing|all-scroll)$/.test(getComputedStyle(el).cursor)) continue;
        const k = listKey(el);
        if (k) add(el, 'handle', k);
      }
      // Planned regions (src/probes/plan.ts) after the test's own, beyond its limits: swiped with the
      // families the page handles on the document (their handlers are not on the region itself).
      for (const pl of (o.planned ?? []).slice(0, 10)) {
        let el: Element | null = null;
        try { el = document.querySelector(pl.path); } catch { el = null; }
        if (!el || cands.includes(el) || !shown(el) || el.matches(INTERACTIVE)) continue;
        const c: (typeof out)[number] = { i: cands.length, kind: 'region', path: cssPath(el), name: nameOf(el), types: pl.types, planned: true };
        if (refusal(el)) c.skip = 'action';
        cands.push(el);
        out.push(c);
      }
      return { list: out, more };
    },
    /** The visible part of a candidate (viewport CSS px), after scrolling it into view. */
    regionBox(o: { i: number; uncover?: boolean }): { box: Box; point: { x: number; y: number } | null; refused?: string } | null {
      const el = cands[o.i];
      if (!el || !el.isConnected) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      // Covered: hide what is fixed over it (`reach`), then measure the box it shows.
      if (o.uncover && pointOn(el, true) === null) reach(el, true, false);
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left);
      const y = Math.max(0, r.top);
      const w = Math.min(innerWidth, r.right) - x;
      const h = Math.min(innerHeight, r.bottom) - y;
      if (w < 8 || h < 8) return null;
      const p = pointOn(el, true);
      return { box: [Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h)], point: isPoint(p) ? p : null, ...(p && !isPoint(p) ? { refused: p.refused } : {}) };
    },
    gesture,
    /** Sizes of what a region shows (for zoom): median growth of its visible descendants since `save`. */
    scale(o: { i: number; save?: boolean }): number | null {
      const el = cands[o.i];
      if (!el) return null;
      const r0 = el.getBoundingClientRect();
      const items = [...el.querySelectorAll('*')].slice(0, 400).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8 && r.right > r0.left && r.left < r0.right && r.bottom > r0.top && r.top < r0.bottom;
      });
      if (o.save) {
        const m = new Map<Element, number>();
        for (const e of items) { const r = e.getBoundingClientRect(); m.set(e, r.width * r.height); }
        sizes.set(o.i, m);
        return 1;
      }
      const before = sizes.get(o.i);
      if (!before) return null;
      const ratios: number[] = [];
      for (const [e, a0] of before) {
        if (!e.isConnected) continue;
        const r = e.getBoundingClientRect();
        if (a0 > 0) ratios.push(Math.sqrt((r.width * r.height) / a0));
      }
      if (!ratios.length) return null;
      ratios.sort((a, b) => a - b);
      return ratios[Math.floor(ratios.length / 2)]!;
    },
    /** A swiped region is a carousel (a row of slides, or named so) rather than panned content. */
    isCarousel(o: { i: number }): boolean {
      const el = cands[o.i];
      if (!el) return false;
      const hint = /carousel|slide|slideshow|swiper|gallery/i;
      const named = [el, ...el.querySelectorAll('[aria-roledescription], [aria-label]')].slice(0, 50)
        .some((e) => hint.test(e.getAttribute('aria-roledescription') ?? '') || (e === el && hint.test(e.getAttribute('aria-label') ?? '')));
      if (named) return true;
      const rw = el.getBoundingClientRect().width;
      const rows = [el, ...el.querySelectorAll('*')].slice(0, 300);
      return rows.some((p) => {
        const kids = [...p.children].filter((k) => k.getBoundingClientRect().width >= rw * 0.5);
        if (kids.length < 2) return false;
        const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top));
        const lefts = kids.map((k) => Math.round(k.getBoundingClientRect().left));
        const row = tops.every((t) => Math.abs(t - tops[0]!) < 4) && new Set(lefts).size === kids.length;
        // Slides stacked in one place (a fading carousel): same box, at least two of the same size.
        const stacked = lefts.every((l) => Math.abs(l - lefts[0]!) < 4) && tops.every((t) => Math.abs(t - tops[0]!) < 4);
        return row || stacked;
      });
    },
    /**
     * Names of the single-pointer alternatives of the given kinds next to a candidate, and how many
     * controls next to it have no name or title at all (they might do the same; the probe cannot tell).
     */
    alternatives(o: { i: number; kinds: string[]; clickRefs: number[] }): { names: string[]; unnamed: number; unknown: number } {
      const el = cands[o.i];
      const res = o.kinds.map((k) => altRe[k]).filter((r): r is RegExp => !!r);
      if (!el || !res.length) return { names: [], unnamed: 0, unknown: 0 };
      // Where to look from: a sortable item's list, a slider's track, else the element itself.
      const sorted = o.kinds.includes('sort') ? listOf(el) : null;
      const base = sorted ? sorted.list : o.kinds.includes('slider') ? trackOf(el) ?? el : el;
      const names: string[] = [];
      let unnamed = 0;
      let unknown = 0;
      for (const c of nearbyControls(base, o.clickRefs)) {
        if (c === el || within(c, el)) continue;
        // The other items of the list are what is sorted, not controls next to it (items that take focus for
        // the arrow keys); whether a click on one moves anything is tried (`clickItems`), not guessed.
        if (sorted && c.parentElement === sorted.list && c.localName === sorted.item.localName) continue;
        const name = nameOf(c);
        const title = c.getAttribute('title') ?? '';
        if (res.some((re) => re.test(name) || re.test(title))) names.push(name || title);
        else if (!name && !title.trim()) unnamed++;
        else unknown++; // a name the test does not recognise: it might do the same
        if (names.length >= 3) break;
      }
      return { names, unnamed, unknown };
    },
    /**
     * A sortable list's single-pointer way with no control of its own: a click on an item, then a click on
     * another (pick up, put down), in both orders. True when the list's order changed. Refused, like a drag,
     * when an item is a link, a submitter, a form control or named for an action.
     */
    clickItems(o: { i: number }): { changed: boolean; refused?: string } | null {
      const el = cands[o.i];
      const l = el ? listOf(el) : null;
      if (!el || !l) return null;
      const why = refusal(l.item) || refusal(l.other);
      if (why) return { changed: false, refused: why };
      const before = orderOf(l.list);
      for (const [a, b] of [[l.item, l.other], [l.other, l.item]] as const) {
        if (!a.isConnected || !b.isConnected) break;
        (a as HTMLElement).click();
        (b as HTMLElement).click();
        if (orderOf(l.list) !== before) return { changed: true };
      }
      return { changed: false };
    },
    /**
     * A sortable list's single-pointer way anywhere else on the page (review round 1, ruling 10: WCAG does not ask
     * for it to be next to the list, and an unsuccessful search proves nothing). Every control on the page is
     * looked at (`pageControls`), shown or not, in the document and its open shadow roots. `names`: shown controls
     * with an accepted move name ("Move selected item up", an arrow) that the kit may press; each of the first two
     * is tried once, after a click on an item to select it (`changed` when the order changed). `candidates`:
     * every other control or link, which the test does not press: any of them may be the way, or open it (a
     * menu, a toolbar, a button named for something else, a link to a page that does it; `sample`: one's name, a
     * name for moving or ordering first). Not counted: the list's own items, what the list is inside, and the
     * controls in another sortable list's rows (they move that list's items). Refused, like a drag, when the
     * item is a link, a submitter, a form control or named for an action.
     */
    sortElsewhere(o: { i: number; clickRefs?: number[] }): { names: string[]; changed: boolean; candidates: number; sample: string; refused?: string } | null {
      const el = cands[o.i];
      const l = el ? listOf(el) : null;
      const sortRe = altRe.sort;
      if (!el || !l || !sortRe) return null;
      const BROAD = /\b(?:move|moves|up|down|reorder|re-order|sort|order|arrange|rearrange|rank|position|priority|first|last|top|bottom|earlier|later|higher|lower|raise|promote|demote|swap|shift)\b|[↑↓▲▼⬆⬇↕⇅]/i;
      const ITEM_ROLE = 'li, [role="option"], [role="listitem"], [role="row"], [role="treeitem"]';
      const ROW = 'li, tr, [role="listitem"], [role="option"], [role="row"], [role="treeitem"]';
      const accepted: Element[] = [];
      const names: string[] = [];
      let candidates = 0;
      let sample = '';
      let sampleBroad = false;
      const count = (name: string) => {
        candidates++;
        const broad = BROAD.test(name);
        if (!sample || (broad && !sampleBroad)) { sample = name || sample; sampleBroad = broad && !!name; }
      };
      // What is shown now, for `sortRevealed`: the controls, and every element with a box (20,000 at most; a
      // larger page cannot be compared, and is then treated as one where something may have shown).
      const shownNow = new WeakSet<Element>();
      const boxed = new WeakSet<Element>();
      const every = document.querySelectorAll('*');
      for (let k = 0; k < every.length && k < 20_000; k++) if (every[k]!.getClientRects().length) boxed.add(every[k]!);
      sortBoxed = every.length <= 20_000 ? boxed : null;
      sortClicks = o.clickRefs ?? [];
      const all = pageControls(sortClicks);
      for (let k = 0; k < all.length; k++) {
        const c = all[k]!;
        if (c instanceof HTMLInputElement && c.type === 'hidden') continue;
        const seen = shown(c, false);
        if (seen) shownNow.add(c);
        // The list's own items, and what the list is inside, are no controls of it.
        if (c === l.list || within(c, l.list) || c === l.item || c === l.other) continue;
        const name = nameOf(c);
        const title = c.getAttribute('title') ?? '';
        if (within(l.list, c)) {
          // A control inside the list that is not shown now (it may show on hover or once its item is selected)
          // is a way the test could not try. Shown ones are the controls next to the item, judged before this.
          if (!seen && !c.matches(ITEM_ROLE)) count(name || title || (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80));
          continue;
        }
        // The controls in another sortable list's rows ("Move up" on its item) move that list's items.
        const row = c.closest(ROW);
        if (row && row.parentElement && !within(l.list, row) && Array.from(row.parentElement.children).some((x) => x.getAttribute('draggable') === 'true' || cands.includes(x))) continue;
        if (seen && (sortRe.test(name) || sortRe.test(title)) && !refusal(c, [c])) { accepted.push(c); if (names.length < 3) names.push(name || title); continue; }
        count(name || title || (seen ? '' : (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)));
      }
      sortShown = shownNow;
      if (!accepted.length) return { names, changed: false, candidates, sample };
      const why = refusal(l.item) || refusal(l.other);
      if (why) return { names, changed: false, candidates, sample, refused: why };
      // Selection, then move: a click on an item selects it, a click on the control moves it.
      const before = orderOf(l.list);
      for (const c of accepted.slice(0, 2)) {
        if (!l.other.isConnected || !c.isConnected) continue;
        (l.other as HTMLElement).click();
        (c as HTMLElement).click();
        if (orderOf(l.list) !== before) return { names, changed: true, candidates, sample };
      }
      return { names, changed: false, candidates, sample };
    },
    /**
     * After `sortElsewhere` and `clickItems` (which click the list's items): what shows now and did not before.
     * A control shown now that was not (anywhere on the page, inside the list's items too, also one made with
     * its click handler just now), and any element outside the list that has a box now and had none: whatever
     * it is called, it showed when an item was selected, so it may be the list's single-pointer way. Controls
     * with an accepted move name that the kit may press are tried (two at most for each of two items:
     * `changed` when the order changed); everything else is counted (`candidates`), never pressed. When the
     * clicks before left nothing selected (a second click takes a selection away) and nothing new shows, one
     * item is clicked once more and the page is looked at again.
     */
    sortRevealed(o: { i: number }): { names: string[]; changed: boolean; candidates: number; sample: string } | null {
      const el = cands[o.i];
      const l = el ? listOf(el) : null;
      const sortRe = altRe.sort;
      const was = sortShown;
      if (!el || !l || !sortRe || !was) return null;
      const ITEM_ROLE = 'li, [role="option"], [role="listitem"], [role="row"], [role="treeitem"]';
      const look = () => {
        const accepted: Element[] = [];
        const names: string[] = [];
        let candidates = 0;
        let sample = '';
        const controls = new Set<Element>();
        const all = pageControls(sortClicks);
        for (let k = 0; k < all.length; k++) {
          const c = all[k]!;
          controls.add(c);
          if (was.has(c) || (c instanceof HTMLInputElement && c.type === 'hidden') || !shown(c, false)) continue;
          if (c === l.list || within(c, l.list) || c === l.item || c === l.other || c.matches(ITEM_ROLE)) continue;
          const name = nameOf(c);
          const title = c.getAttribute('title') ?? '';
          if ((sortRe.test(name) || sortRe.test(title)) && !refusal(c, [c])) { accepted.push(c); if (names.length < 3) names.push(name || title); continue; }
          candidates++;
          if (!sample) sample = name || title || 'a control that shows once an item is selected';
        }
        // Anything else outside the list that has a box now and had none (a panel, a row of plain text "buttons").
        if (!sortBoxed) { candidates++; if (!sample) sample = 'something that may show once an item is selected (the page is too large to compare)'; }
        else {
          const every = document.querySelectorAll('*');
          for (let k = 0; k < every.length && k < 20_000; k++) {
            const e = every[k]!;
            if (sortBoxed.has(e) || controls.has(e) || within(l.list, e) || !e.getClientRects().length) continue;
            // Counted once, at the outermost element that showed.
            if (e.parentElement && !sortBoxed.has(e.parentElement) && e.parentElement !== document.body) continue;
            candidates++;
            if (!sample) sample = (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'something that shows once an item is selected';
          }
        }
        return { accepted, names, candidates, sample };
      };
      const refused = !!(refusal(l.item) || refusal(l.other));
      let found = look();
      if (!found.accepted.length && !found.candidates && !refused && l.other.isConnected) {
        (l.other as HTMLElement).click();
        found = look();
      }
      const { accepted, names, candidates, sample } = found;
      if (!accepted.length || refused) return { names, changed: false, candidates, sample };
      const before = orderOf(l.list);
      // The control in the selected item first (a button of its own item moves that item), then any other. An item
      // is clicked only when no accepted control is shown (a click on the selected item may take its selection away).
      for (const item of [l.other, l.item]) {
        if (!item.isConnected) continue;
        const usable = () => accepted.filter((c) => c.isConnected && shown(c, false) && (within(item, c) || !within(l.list, c)));
        if (!usable().length) (item as HTMLElement).click();
        for (const c of usable().slice(0, 2)) {
          (c as HTMLElement).click();
          if (orderOf(l.list) !== before) return { names, changed: true, candidates, sample };
        }
      }
      return { names, changed: false, candidates, sample };
    },
    /**
     * Drags an item onto its sibling: native HTML5 drag events (an empty DataTransfer) dispatched on
     * the item and on the sibling element itself, or a pointer path from a point on the item. Refused
     * when the item or the sibling is a link, a submitter, a form control or named for an action.
     * The drop lands past the middle of the next sibling; when that changes nothing (a list that
     * inserts the item before the sibling it is dropped on leaves it where it was), it is dropped once
     * more on the other side: before the middle of the previous sibling, else past the middle of the
     * sibling after the next one. In a list of two there is no other sibling: the second item is then
     * dragged before the middle of the first (dropping the first before the second changes nothing in
     * such a list either). Only ever sibling items, dragged and dropped on each other.
     */
    async dragItem(o: { i: number; family: 'native' | 'pointer' | 'touch' | 'mouse'; uncover?: boolean }): Promise<{ changed: boolean; refused?: string } | null> {
      const el = cands[o.i];
      const l = el ? listOf(el) : null;
      if (!el || !l) return null;
      const why = refusal(el) || refusal(l.other);
      if (why) return { changed: false, refused: why };
      // Scrolled into view (and what is fixed over it hidden) first: an item below the fold or under a
      // fixed bar is still dragged. Before the boxes are read, so the drop point is where the sibling is.
      const reached = o.uncover && o.family !== 'native' ? reach(el, false, false, 'nearest') : undefined;
      const before = orderOf(l.list);
      const drop = async (dragged: Element, target: Element, side: 'before' | 'after'): Promise<{ changed: boolean; refused?: string } | null> => {
        const src = dragged.getBoundingClientRect();
        const dst = target.getBoundingClientRect();
        const horizontal = Math.abs(dst.left - src.left) > Math.abs(dst.top - src.top);
        const f = side === 'after' ? 0.75 : 0.25;
        const tx = Math.round(dst.left + dst.width * (horizontal ? f : 0.5));
        const ty = Math.round(dst.top + dst.height * (horizontal ? 0.5 : f));
        if (o.family === 'native') {
          const dt = new DataTransfer();
          const init = (x: number, y: number): DragEventInit => ({ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, dataTransfer: dt });
          const sx = Math.round(src.left + src.width / 2);
          const sy = Math.round(src.top + src.height / 2);
          if (!dragged.dispatchEvent(new DragEvent('dragstart', init(sx, sy)))) return { changed: false };
          dragged.dispatchEvent(new DragEvent('drag', init(sx, sy)));
          await sleep(16);
          target.dispatchEvent(new DragEvent('dragenter', init(tx, ty)));
          target.dispatchEvent(new DragEvent('dragover', init(tx, ty)));
          await sleep(16);
          target.dispatchEvent(new DragEvent('drop', init(tx, ty)));
          dragged.dispatchEvent(new DragEvent('dragend', init(tx, ty)));
        } else {
          const p = dragged === el && reached !== undefined ? reached : pointOn(dragged);
          if (!isPoint(p)) return p ? { changed: false, refused: p.refused } : null;
          // A page that finds the drop target with elementFromPoint would see what is painted there.
          const atDrop = deepHit(tx, ty);
          const whyDrop = atDrop ? refusal(atDrop, [atDrop]) : '';
          if (whyDrop) return { changed: false, refused: whyDrop };
          const path: [number, number][] = [];
          for (let s = 0; s <= 8; s++) path.push([Math.round(p.x + ((tx - p.x) * s) / 8), Math.round(p.y + ((ty - p.y) * s) / 8)]);
          const g = await gesture({ key: arg.key, family: o.family, i: o.i, paths: [path] });
          if (g.refused) return { changed: false, refused: g.refused };
        }
        await sleep(50);
        return { changed: orderOf(l.list) !== before };
      };
      const first = await drop(el, l.other, 'after');
      if (!first || first.changed || first.refused) return first;
      if (!l.otherSide) {
        // A list of two: the other item dragged before this one.
        if (!l.other.isConnected || !el.isConnected) return first;
        return drop(l.other, el, 'before');
      }
      if (!l.otherSide.isConnected || refusal(l.otherSide)) return first;
      const prevSide = l.otherSide.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
      return drop(el, l.otherSide, prevSide ? 'before' : 'after');
    },
    /** Puts back what `reach` hid; the names of what it had hidden (tag and id). */
    uncovered(): string[] {
      const names: string[] = [];
      for (let k = covers.length - 1; k >= 0; k--) {
        const c = covers[k]!;
        if (c.value) c.el.style.setProperty('visibility', c.value, c.priority);
        else c.el.style.removeProperty('visibility');
        if (!names.includes(c.name)) names.unshift(c.name);
      }
      covers.length = 0;
      return names;
    },
    /** Drags a slider's thumb; or taps (presses and releases without moving) its track; reports the value before and after. */
    async slide(o: { i: number; family: 'pointer' | 'touch' | 'mouse'; how: 'drag' | 'tap' | 'click' }): Promise<{ changed: boolean; skipped?: string; refused?: string } | null> {
      const thumb = cands[o.i];
      if (!thumb) return null;
      const vertical = thumb.getAttribute('aria-orientation') === 'vertical';
      const before = sliderValue(thumb);
      const t = thumb.getBoundingClientRect();
      const cx = Math.round(t.left + t.width / 2);
      const cy = Math.round(t.top + t.height / 2);
      if (o.how === 'drag') {
        const path: [number, number][] = [];
        for (let s = 0; s <= 8; s++) path.push(vertical ? [cx, cy - s * 6] : [cx + s * 6, cy]);
        const g = await gesture({ key: arg.key, family: o.family, i: o.i, paths: [path] });
        if (g.refused) return { changed: false, refused: g.refused };
      } else {
        const track = trackOf(thumb);
        if (!track) return { changed: false, skipped: 'no track' };
        const r = track.getBoundingClientRect();
        const far = vertical ? (cy - r.top > r.height / 2 ? r.top + r.height * 0.15 : r.top + r.height * 0.85) : (cx - r.left > r.width / 2 ? r.left + r.width * 0.15 : r.left + r.width * 0.85);
        const x = Math.round(vertical ? r.left + r.width / 2 : far);
        const y = Math.round(vertical ? far : r.top + r.height / 2);
        const hit = deepHit(x, y);
        if (!hit || !within(track, hit)) return { changed: false, skipped: 'track not reachable' };
        const why = refusal(hit, [hit]);
        if (why) return { changed: false, refused: why };
        if (o.how === 'click') {
          // Only a plain part of the track (no control at all); the canceller lets this one click through
          // to the page's listeners and still prevents its default action on a link or a submitter.
          if (hit.closest(INTERACTIVE)) return { changed: false, skipped: 'not a plain track' };
          const own = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 });
          const h = hold();
          h('own', own);
          try { hit.dispatchEvent(own); } finally { h('own', null); }
        } else {
          await gesture({ key: arg.key, family: o.family, paths: [[[x, y]]] });
        }
      }
      await sleep(50);
      const after = sliderValue(thumb);
      return { changed: after.now !== before.now || after.pos !== before.pos };
    },
    /** The page's monotonic clock (`performance.now()` ms), as the listener hook stamps timers with it. */
    now(): number { return performance.now(); },
    /**
     * Finite animations and transitions running or about to run (in their delay) on the page, other
     * than inside the pressed element: a change they make during the press is already under way, never
     * the press's (a carousel's fade that started just before). Endless ones (a spinner) are left out.
     */
    animating(o: { i: number }): number {
      const el = cands[o.i] ?? null;
      try {
        return document.getAnimations().filter((a) => {
          if (a.playState !== 'running' && !a.pending) return false;
          const end = Number(a.effect?.getComputedTiming().endTime ?? Infinity);
          if (!Number.isFinite(end)) return false;
          const target = (a.effect as KeyframeEffect | null)?.target ?? null;
          return !(el && target && (el === target || el.contains(target)));
        }).length;
      } catch {
        return 0;
      }
    },
    /** Timers of 1 s or more (recorded by the listener hook) that ran since `t`: something else changed the page then. */
    timersSince(o: { t: number }): number {
      const hooks = typeof W.__grntedHooks === 'function' ? W.__grntedHooks() as { timers: { lastFiredAt?: number }[] } : null;
      return hooks ? hooks.timers.filter((x) => (x.lastFiredAt ?? -Infinity) >= o.t).length : 0;
    },
    /** Whole addresses (fragment left out) the page has loaded so far (resource timing): asking for one again with GET is not new. */
    loadedUrls(): string[] {
      const out = new Set<string>();
      try {
        for (const e of performance.getEntries()) {
          if (e.entryType !== 'resource' && e.entryType !== 'navigation') continue;
          try { out.add(new URL(e.name, location.href).href.split('#')[0]!); } catch { /* not an address */ }
          if (out.size > 2000) break;
        }
      } catch { /* no timing */ }
      return [...out];
    },
    /** Forgets the candidates and stops blocking. */
    drop() {
      try { hold()('off'); } catch { /* no hook */ }
      trace.obs?.disconnect();
      trace.obs = null;
      cands.length = 0;
      snaps.clear();
      sizes.clear();
      touchStart = null;
      delete W[arg.key];
    },
  };
  try {
    Object.defineProperty(W, arg.key, { value: api, configurable: true, enumerable: false, writable: false });
  } catch {
    return false;
  }
  return true;
}

/** Calls a kit operation in the page. */
export function kit<R>(ctx: Pick<ProbeContext, 'page'>, op: string, a: unknown = {}): Promise<R> {
  return ctx.page.evaluate(
    (x: { key: string; op: string; a: unknown }) => {
      const k = (window as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[x.key];
      if (!k || typeof k[x.op] !== 'function') throw new Error('the pointer kit is not installed');
      return k[x.op]!(x.a) as R;
    },
    { key: POINTER_KEY, op, a },
  );
}

export async function installKit(ctx: Pick<ProbeContext, 'page'>): Promise<boolean> {
  return ctx.page.evaluate(installPointerKit, { key: POINTER_KEY, action: ACTION_NAME, alternatives: { ...ALTERNATIVES } });
}

/** Element listeners by target, with their types. */
export function byTarget(list: readonly RecordedListener[], types: ReadonlySet<string>): { ref: number; types: string[]; path: string }[] {
  const m = new Map<number, { ref: number; types: string[]; path: string }>();
  for (const l of list) {
    if (l.target.kind !== 'element' || !types.has(l.type)) continue;
    let e = m.get(l.ref);
    if (!e) m.set(l.ref, (e = { ref: l.ref, types: [], path: l.target.path }));
    if (!e.types.includes(l.type)) e.types.push(l.type);
  }
  return [...m.values()];
}

/** Runs in a frame (self-contained): listeners of the given types (on elements, the document or the window), and explicit draggables. -1 without the hook. */
export function frameHandlers(arg: { types: string[]; drag: boolean }): number {
  const w = window as unknown as { __grntedListeners?: () => { type: string; target: { kind: string } }[] };
  if (typeof w.__grntedListeners !== 'function') return -1;
  const set = new Set(arg.types);
  const listeners = w.__grntedListeners().filter((l) => set.has(l.type)).length;
  return listeners + (arg.drag ? document.querySelectorAll('[draggable="true"], [role="slider"]').length : 0);
}

/**
 * Frames from the page's own site whose content has handlers of these types (on elements, the
 * document or the window), or that could not be read (an error, no hook, 2 s without an answer): they
 * were not tested (the probes test the main frame). Frames from other sites are third-party content
 * (Paul's 2026-10-30 decision) and are left out.
 */
export async function untestedFrames(ctx: Pick<ProbeContext, 'page' | 'url'>, types: readonly string[], drag = false): Promise<string[]> {
  const frames = ctx.page.frames?.() ?? [];
  let origin = '';
  try {
    origin = new URL(ctx.page.url?.() ?? ctx.url).origin;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of frames as FrameLike[]) {
    if (!f.parentFrame()) continue;
    let u: URL;
    try {
      u = new URL(f.url());
    } catch {
      continue;
    }
    if (u.origin !== origin) continue;
    const n = await Promise.race([
      f.evaluate(frameHandlers, { types: [...types], drag }).catch(() => -1),
      new Promise<number>((r) => { setTimeout(() => r(-1), 2000); }),
    ]);
    if (n !== 0) out.push(u.pathname + u.search);
  }
  return out;
}

/** The not_testable reason for untested frames. */
export function framesReason(paths: readonly string[], what: string): string {
  const list = paths.slice(0, 3).join(', ') + (paths.length > 3 ? ', …' : '');
  return `${what} inside ${paths.length === 1 ? 'an embedded frame' : `${paths.length} embedded frames`} from this site ${paths.length === 1 ? 'was' : 'were'} not tested (${list})`;
}

/** Files a page only shows (never runs or submits): what `pointerStop`'s `shownFiles` sets aside once blocked. */
export const SHOWN_FILE_TYPES: ReadonlySet<string> = new Set(['stylesheet', 'font', 'image', 'media']);

/** A request as the pointer probes match it: method and the whole address (fragment left out). */
export function requestKey(method: string | undefined, url: string | undefined): string {
  return `${(method ?? 'GET').toUpperCase()} ${(url ?? '').split('#')[0]}`;
}

/**
 * What the request guard stopped during a pointer test that makes its result untrustworthy, with the
 * reason, or undefined. The pointer probes run with the strict guard (`sendsNothing`): nothing is
 * sent. A navigation held, a new window, or a blocked request that is not the same GET (method and
 * whole address) as one the page already made (`known`: resource timing at the start, and what the
 * guard stopped before the test) counts; a POST or a GET with another query always counts.
 * `shownFiles` (the gesture test): a GET or HEAD for a stylesheet, font, image or media file
 * (`SHOWN_FILE_TYPES`) from a public font or static-file server or an analytics service
 * (`STATIC_FILE_HOSTS`, `isAnalyticsAddress`), with no query string, blocked like everything else, does
 * not count either: those servers give everyone the same files and change nothing. Any other blocked
 * file (the page's own `/api/session/end` as an image, a counting pixel with a query) counts.
 */
export function pointerStop(events: readonly GuardEvent[], known: ReadonlySet<string>, doing: string, opts: { shownFiles?: boolean } = {}): string | undefined {
  // Only the same GET or HEAD as one the page already made is not new; a blocked request with any other method never is.
  const isKnown = (e: GuardEvent) => /^(GET|HEAD)$/i.test(e.method ?? 'GET') && known.has(requestKey(e.method, e.url));
  const nav = events.find((e) => e.kind === 'navigation');
  if (nav) return `the page tried to go to another address ${doing} (${nav.url ?? 'unknown'}); the test holds such navigations, so the result could not be measured`;
  const popup = events.find((e) => e.kind === 'popup');
  if (popup) return `the page tried to open a new window ${doing}${popup.url ? ` (${popup.url})` : ''}; the test closed it, so the result could not be measured`;
  const shown = (e: GuardEvent) => !!opts.shownFiles && /^(GET|HEAD)$/i.test(e.method ?? 'GET') && SHOWN_FILE_TYPES.has(e.resourceType ?? '') && !e.mainFrame
    && !/[?]/.test(e.url ?? '?') && (onHostList(e.url, STATIC_FILE_HOSTS) || isAnalyticsAddress(e.url));
  const block = events.find((e) => e.kind === 'blocked' && !isKnown(e) && !isBackgroundWrite(e) && !shown(e));
  if (!block) return undefined;
  if (block.reason !== 'data') return blockedReason(block);
  return `the page made a request ${doing} (${block.resourceType ?? 'a'} request to ${block.url ?? 'an address'}); the test sends nothing while it uses the pointer, so it was stopped and the result could not be measured`;
}
