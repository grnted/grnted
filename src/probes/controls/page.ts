// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The in-page side of the controls test (`./index.ts`): finds the page's own controls, records what a
// key press or a mouse click on one changes, and describes what a press opened. `installControlsKit`
// runs once per page through `page.evaluate` and is self-contained (no imports, no outer variables),
// so a bundler cannot break it. It only reads the page, except for the focus it sets, the scroll
// position it puts back and `window.print`, which it silences while it is installed. Engine core: no
// Node-only imports.

/** Where the kit lives on `window` (non-enumerable). */
export const CONTROLS_KEY = '__grntedControls';

/** Event types that make an element answer to a pointer. */
export const POINTER_TYPES = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'] as const;
/** Event types that make an element answer to a key. */
export const KEY_TYPES = ['keydown', 'keyup', 'keypress'] as const;

/** What kind of control a candidate is (decides how it is pressed). */
export type ControlKind =
  /** Not a native control, and it takes keyboard focus (a tabindex, or a widget role with one). */
  | 'custom'
  /** One of several choices in a composite widget (tabs, a radio group, a list box, a menu, a tree, a toolbar with one Tab stop). */
  | 'composite'
  /** A native button that is not a form's submit button. */
  | 'native'
  /** Answers to the pointer and cannot take keyboard focus. */
  | 'clickable';

export interface ControlCandidate {
  i: number;
  path: string;
  name: string;
  tag: string;
  role?: string;
  kind: ControlKind;
  /** In the Tab order. */
  tabbable: boolean;
  /** Takes focus from a script (tabindex="-1" too). */
  focusable: boolean;
  /** Pointer listeners on the element itself. */
  types: string[];
  /** Its own listeners are for the pointer only (no click, no key listener on it): the first to test. */
  pointerOnly: boolean;
  /** Composite widgets: the container, its role, and the member that holds the Tab stop (an index into the kit's elements). */
  composite?: { path: string; role: string; members: number; current: number; horizontal: boolean };
  /** A native button that says it opens or toggles something (aria-expanded, aria-haspopup, aria-controls). */
  opener?: true;
}

/** A search or filter field the test types into (4.1.3: the result count it shows). */
export interface FieldCandidate {
  i: number;
  path: string;
  name: string;
}

export interface CandidateList {
  list: ControlCandidate[];
  /** Controls beyond the limit (not pressed). */
  more: number;
  /** Controls left out because their name says they act on the site, or they are links, form fields or submit buttons. */
  refused: number;
}

/** What one press changed. */
export interface Effect {
  /** Something a person would notice changed, by a script. */
  changed: boolean;
  /** Elements that came into view (outermost ones) and went out of view. */
  shown: number;
  hidden: number;
  /** Text of the first element that came into view, or the new text of one that changed. */
  text?: string;
  textChange?: { from: string; to: string };
  /** Form fields whose value or checked state changed. */
  values: number;
  /** The control's own state or text changed. */
  own?: string;
  /** The address changed without a page load. */
  url?: string;
  /** Keyboard focus moved to another element. */
  focus?: { path: string; name: string };
  /** For a composite: focus moved to another of its members. */
  member?: boolean;
  /**
   * Where the page changed and what it says there, for comparing two presses: `+path=text` for each
   * outermost element that came into view, `-path` for each that went out of view, `~path=text` for each
   * element whose text changed, `=path=value` for each form field whose value changed (at most six of
   * each; texts cut short, numbers left out). `ids`: the ids of those elements.
   */
  where?: string[];
  ids?: string[];
  /**
   * Every change counted here was made by a script while the browser was dispatching the press's own
   * events (the key or pointer events, the click): the press did it. False: something changed in the
   * moments after the press, which a timer or the page itself may have done (see `timers`, `quiet`).
   */
  direct: boolean;
  /**
   * Timers of 1 s or more that ran between the press and the comparison (the listener hook's record):
   * one-off timeouts, and intervals (which run again, so what they change can be learned: `quiet`).
   */
  timeouts: number;
  intervals: number;
  /**
   * With `since` (a click's window, from the moment the pointer comes to rest on the control): how many changes were
   * left out because a timer the page set before the window wrote them inside it (the listener hook's timer notes,
   * `__grntedTimerWrote`, as the forms test reads them). What the page writes by itself is never the click's
   * (lead's cut, batch 17).
   */
  self?: number;
}

/** What a control says about its own keys: aria-keyshortcuts, accesskey, and the texts that describe it. */
export interface ShortcutSource { aria: string; access: string; texts: string[] }

/**
 * Another control Tab can reach that may do what a control does: it has the same name, or it points at the
 * same content (aria-controls, a target attribute, a link to it). `refused`: why the test never presses it
 * (a link, a form field, a submit button, a name that acts on the site), or ''.
 */
export interface Alternative { id: number; path: string; name: string; why: 'name' | 'target'; refused: string }

/** What a press opened: a dialog, a list of choices, a layer over the page, or a part of the page. */
export interface Opened {
  k: number;
  path: string;
  name: string;
  kind: 'dialog' | 'menu' | 'overlay' | 'panel';
  modal: boolean;
  /** Elements in it that Tab can reach, and elements that only a script can focus. */
  tabbables: number;
  focusables: number;
  /** Keyboard focus is in it now. */
  hasFocus: boolean;
}

/** A short text that appeared or changed: a candidate status message. */
export interface Message {
  /** Handle for `messageShown`. */
  id: number;
  path: string;
  text: string;
  /**
   * Announced: in a live region (itself or any ancestor, across shadow roots) that was in the page before the
   * message was put into it (there before the press, or added empty since), or in an alert added with its text.
   */
  live: boolean;
  /**
   * Its announcement could not be told (then `live` is false): the only live region around it is inside a shadow
   * root and was not there, or not live, before the press. The kit's observer sees nothing inside a shadow root,
   * so the region may have come before the message or together with it.
   */
  unsure?: boolean;
  /** Keyboard focus moved to it (or into it). */
  focus: boolean;
  /** It came into view (true) or its text changed in an element already in view (false). */
  appeared: boolean;
  /** It reads as a status message (`STATUS_TEXT`), and the control is not one that shows and hides content. */
  status: boolean;
  /** It is inside what the press opened and focus went there, or it is tied to the control (its panel). */
  ofOpened: boolean;
}

export interface AfterState {
  active: { path: string; name: string; inControl: boolean; none: boolean };
  focusMoved: boolean;
  opened: Opened[];
  messages: Message[];
}

interface KitArg { key: string; action: string; status: string; disclosure: string; /** `LIVE_REGION_SELECTOR` (src/probes/liveRegion.ts). */ live?: string }

/**
 * Runs in the page (self-contained): installs the kit on `window[key]`. Every operation is called as
 * `window[key].<op>(arg)` (see `controlsKit`). Returns false when the page blocked it.
 */
export function installControlsKit(arg: KitArg): boolean {
  type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const W = window as unknown as Record<string, Any>;
  // Batch 19 (precision lane): what the page announces through the accessibility API itself (`ariaNotify`, WCAG's
  // ARIA27; Understanding 4.1.3 counts "direct access to accessibility APIs that result in assistive technology
  // alerts/announcements"): each call's text and time, shared with the forms agent; the call goes on as made.
  const notified: { t: number; text: string }[] = (W.__grntedNotified ??= []);
  for (const proto of [typeof Document !== 'undefined' ? Document.prototype : null, typeof Element !== 'undefined' ? Element.prototype : null]) {
    const own = proto as unknown as Record<string, Any> | null;
    const orig = own?.ariaNotify;
    if (!own || typeof orig !== 'function' || orig.__grntedNotify) continue;
    const wrapped = function (this: unknown, ...a: Any[]) { if (notified.length < 200) notified.push({ t: performance.now(), text: String(a[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) }); return orig.apply(this, a); };
    (wrapped as Any).__grntedNotify = true;
    try { Object.defineProperty(own, 'ariaNotify', { value: wrapped, configurable: true, writable: true }); } catch { /* left as it was */ }
  }
  const actionRe = new RegExp(arg.action, 'i');
  const statusRe = new RegExp(arg.status, 'i');
  const disclosureRe = new RegExp(arg.disclosure, 'i');
  const target = (ref: number): unknown => (typeof W.__grntedTarget === 'function' ? W.__grntedTarget(ref) : undefined);
  const clean = (s: string | null | undefined, max = 80) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const parentOf = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  const within = (outer: Node, inner: Node | null): boolean => {
    for (let n: Node | null = inner; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === outer) return true;
    return false;
  };
  /** CSS path from the nearest unique id (or the root of its document or shadow root). */
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    const host = root.nodeType === 11 ? (root as ShadowRoot).host : null;
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
  /** Accessible name, close to the spec: aria-labelledby, aria-label, image alt, button value, contents, title. */
  const nameOf = (el: Element, max = 80): string => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const s = lb.split(/\s+/).map((id) => (id ? root.getElementById?.(id) ?? document.getElementById(id) : null)).map((x) => (x ? textName(x, 1) : '')).join(' ');
      if (s.trim()) return clean(s, max);
    }
    const a = el.getAttribute('aria-label');
    if (a && a.trim()) return clean(a, max);
    if (el.matches('img, area, input[type="image"]')) { const alt = el.getAttribute('alt'); if (alt && alt.trim()) return clean(alt, max); }
    if (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type) && el.value) return clean(el.value, max);
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement)) {
      const text = clean(textName(el), max);
      if (text) return text;
    }
    const title = el.getAttribute('title') || el.querySelector('[title]')?.getAttribute('title');
    return clean(title, max);
  };
  /** Rendered with a box, not hidden by display, visibility, content-visibility or (unless `opacity` is false) opacity. */
  const shown = (el: Element, opacity = true): boolean => {
    if (!el.isConnected) return false;
    const e = el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: opacity, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const deepActive = (): Element | null => {
    let a: Element | null = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  };
  /** Whether Tab can reach the element (as the keyboard kit decides it). */
  const tabbable = (el: Element): boolean => {
    const t = (el as HTMLElement).tabIndex;
    if (typeof t !== 'number' || t < 0) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (!el.hasAttribute('tabindex')) {
      const tag = el.localName;
      if ((tag === 'a' || tag === 'area') && !el.hasAttribute('href')) return false;
      if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return false;
      if (tag === 'summary' && !(el.parentElement && el.parentElement.localName === 'details' && el.parentElement.querySelector('summary') === el)) return false;
      if ((tag === 'audio' || tag === 'video') && !el.hasAttribute('controls')) return false;
      const native = /^(a|area|button|input|select|textarea|iframe|frame|object|embed|summary|audio|video)$/.test(tag);
      if (!native && !(el as HTMLElement).isContentEditable) return false;
    }
    if (el.closest('[inert]')) return false;
    return shown(el, false);
  };
  /** Takes focus from a script: in the Tab order, or any tabindex attribute. */
  const focusable = (el: Element): boolean => tabbable(el) || (el.hasAttribute('tabindex') && !(el as HTMLButtonElement).disabled && !el.closest('[inert]') && shown(el, false));
  const FOCUSABLE_SEL = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';
  /** Tabbable elements inside `root` (its open shadow roots included), up to `cap`. */
  const tabbablesIn = (root: Element, cap: number, except: Element | null = null): Element[] => {
    const out: Element[] = [];
    const scopes: (Element | ShadowRoot)[] = [root];
    for (let k = 0; k < scopes.length && k < 40 && out.length < cap; k++) {
      const scope = scopes[k]!;
      if ((scope as Element).shadowRoot) scopes.push((scope as Element).shadowRoot!);
      const all = scope.querySelectorAll(FOCUSABLE_SEL);
      for (let i = 0; i < all.length && i < 400 && out.length < cap; i++) {
        const e = all[i]!;
        if (except && (except === e || except.contains(e))) continue;
        if (tabbable(e)) out.push(e);
      }
      const hosts = scope.querySelectorAll('*');
      for (let i = 0; i < hosts.length && i < 2000 && scopes.length < 40; i++) if ((hosts[i] as Element).shadowRoot) scopes.push((hosts[i] as Element).shadowRoot!);
    }
    return out;
  };
  const deepHit = (x: number, y: number): Element | null => {
    let h = document.elementFromPoint(x, y);
    for (let i = 0; h?.shadowRoot && i < 20; i++) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  };

  // --- Safety: what is never pressed ---------------------------------------------------------------
  const SUBMITTER = 'button, input[type="submit"], input[type="image"], input[type="reset"]';
  const isSubmitter = (e: Element) => e.matches(SUBMITTER) && (e.matches('input[type="image"]') || (/^(submit|reset)$/.test((e as HTMLButtonElement).type) && !!(e as HTMLButtonElement).form));
  const FORM_CONTROL = 'input:not([type="button"]):not([type="reset"]):not([type="submit"]):not([type="image"]), select, textarea, option, [contenteditable=""], [contenteditable="true"]';
  /**
   * Why pressing this element could act on the site, or '' when it may be pressed: it or an ancestor is a
   * link with an address, a form's submit or reset button, a form field, or its name says it performs an
   * action on the site (log out, delete, pay…; the pointer tests' rule).
   */
  const refusal = (start: Element | null): string => {
    for (let n: Element | null = start, d = 0; n && d < 60; d++) {
      if (n === document.body || n === document.documentElement) break;
      if (n.matches('a[href], area[href]')) return 'link';
      if (isSubmitter(n)) return 'submitter';
      if (n.matches(FORM_CONTROL)) return 'form';
      if (n === start || n.matches('button, [role="button"], [onclick]')) {
        if (actionRe.test(`${n.getAttribute('aria-label') ?? ''} | ${n.getAttribute('title') ?? ''} | ${nameOf(n, 200)}`)) return 'action';
      }
      n = parentOf(n);
    }
    return '';
  };

  // --- Candidates --------------------------------------------------------------------------------
  const cands: Element[] = [];
  const WIDGET = new Set(['button', 'link', 'tab', 'switch', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem']);
  const MEMBER_OF: Record<string, string> = {
    tab: '[role="tablist"]', radio: '[role="radiogroup"]', option: '[role="listbox"]', menuitem: '[role="menu"], [role="menubar"]',
    menuitemcheckbox: '[role="menu"], [role="menubar"]', menuitemradio: '[role="menu"], [role="menubar"]', treeitem: '[role="tree"]',
  };
  const roleOf = (el: Element) => (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const isWrapper = (el: Element) => {
    const r = el.getBoundingClientRect();
    return el === document.body || el === document.documentElement || !!el.querySelector('main, header, nav, footer, [role="main"], [role="banner"]')
      || r.height > innerHeight * 2 || (r.width >= innerWidth * 0.95 && r.height >= innerHeight * 0.9);
  };
  /** A carousel's own slide or track (the keyboard test's rule): its listeners drag or pause, they are no function of their own. */
  const CAROUSEL_CLASSES = new Set([
    'slick-slider', 'slick-list', 'slick-track', 'slick-slide', 'swiper', 'swiper-container', 'swiper-wrapper', 'swiper-slide',
    'splide', 'splide__track', 'splide__list', 'splide__slide', 'owl-carousel', 'owl-stage', 'owl-stage-outer', 'owl-item',
    'flickity-slider', 'flickity-viewport', 'glide__track', 'glide__slides', 'glide__slide', 'keen-slider', 'keen-slider__slide',
    'carousel-inner', 'carousel-item', 'cycle-slideshow', 'cycle-slide', 'bx-viewport', 'bxslider', 'flexslider', 'flex-viewport',
  ]);
  const carouselPart = (el: Element): boolean => {
    if (/^(carousel|slide|slideshow)$/i.test(el.getAttribute('aria-roledescription') ?? '')) return true;
    for (const c of Array.from(el.classList)) if (CAROUSEL_CLASSES.has(c)) return true;
    return false;
  };
  /** Content the pointer works by place or path (a map, a drawing surface, a slider): never judged by a single click. */
  const PLACED = 'canvas, [role="application"], [role="slider"], [role="scrollbar"], [role="separator"], input[type="range"], .leaflet-container, .mapboxgl-map, .maplibregl-map, .gm-style, .ol-viewport';
  const signature = (el: Element) => {
    const STATE = /active|current|open|show|selected|hover|focus|first|last|odd|even|\d/i;
    const cls = (e: Element | null) => (e ? [...e.classList].filter((x) => !STATE.test(x)).sort().slice(0, 3).join('.') : '');
    return `${el.localName}@${roleOf(el)}.${cls(el)}|${el.parentElement?.localName ?? ''}.${cls(el.parentElement)}`;
  };
  /** The native kinds whose keyboard use is the browser's own. */
  const NATIVE = /^(a|area|button|input|select|textarea|summary|details|label|option|iframe|frame|object|embed|video|audio)$/;

  // --- Changes a script makes (never CSS alone) ---------------------------------------------------
  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE|BASE|BR)$/;
  const touched = new Set<Element>();
  /** What scripts changed while the browser dispatched a trusted key, pointer or click event (the press's own doing). */
  const byInput = new Set<Element>();
  let touchedCount = 0;
  let began = 0;
  const noisy = new Set<Element>();
  const ours = (n: Node | null): boolean => !!n && n.nodeType === 1 && ((n as Element).hasAttribute('data-grnted-kb') || (n as Element).hasAttribute('data-grnted-start'));
  const INPUT_EVENTS = new Set(['keydown', 'keypress', 'keyup', 'click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'input', 'change']);
  // The browser's own `window.event` (a page that replaced it leaves nothing to tell apart: `direct` is then never true).
  const eventGetter = (() => {
    try {
      const g = Object.getOwnPropertyDescriptor(window, 'event')?.get ?? Object.getOwnPropertyDescriptor(Window.prototype, 'event')?.get;
      return g && /\[native code\]/.test(Function.prototype.toString.call(g)) ? g : null;
    } catch {
      return null;
    }
  })();
  /**
   * Live regions (4.1.3, ARIA22): an element screen readers watch for changes. Its own role (status, alert, log,
   * marquee, timer), an `output`, or aria-live that is not "off".
   */
  const LIVE_ROLES = /^(status|alert|log|marquee|timer)$/;
  // One definition with the forms agent (`LIVE_REGION_SELECTOR`, act-watch review r1 F2); this rule when it is not given.
  const isLive = (e: Element): boolean => {
    if (arg.live) { try { return e.matches(arg.live); } catch { /* the rule below */ } }
    const al = e.getAttribute('aria-live');
    if (al !== null) return al.trim().toLowerCase() !== 'off';
    return LIVE_ROLES.test((e.getAttribute('role') ?? '').trim().toLowerCase()) || e.localName === 'output';
  };
  /**
   * Live regions that came into being since the press began (added to the page, or made live by an attribute),
   * with whether they were empty at that moment. The observer's callback runs at the end of the script that made
   * the change: a region that already holds its message then came in together with it, which is not announced;
   * one that is empty then and gets its text later was there first.
   */
  const born = new Map<Element, boolean>();
  const noteLive = (e: Element): void => {
    if (!born.has(e) && isLive(e)) born.set(e, !(e.textContent ?? '').trim());
  };
  const record = (recs: MutationRecord[]): void => {
    let ev: Event | undefined;
    try { ev = eventGetter ? (eventGetter.call(window) as Event | undefined) : undefined; } catch { ev = undefined; }
    const input = !!ev && ev.isTrusted && INPUT_EVENTS.has(ev.type);
    const add = (e: Element) => { touched.add(e); if (input) byInput.add(e); };
    for (const r of recs) {
      if (++touchedCount > 20000) return;
      const t = r.target.nodeType === 1 ? r.target as Element : r.target.parentElement;
      if (!t || SKIP_TAGS.test(t.tagName) || t.closest('head') || ours(t)) continue;
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || ours(n)) continue;
          noteLive(n as Element);
          const inner = (n as Element).querySelectorAll('[aria-live], [role], output');
          for (let k = 0; k < inner.length && k < 200; k++) noteLive(inner[k]!);
        }
      } else if (r.type === 'attributes' && (r.attributeName === 'role' || r.attributeName === 'aria-live')) {
        noteLive(t);
      }
      if (r.type === 'childList') {
        let any = false;
        for (const n of r.addedNodes) { if (ours(n)) continue; any = true; if (n.nodeType === 1 && !SKIP_TAGS.test((n as Element).tagName)) add(n as Element); }
        for (const n of r.removedNodes) { if (ours(n)) continue; any = true; if (n.nodeType === 1 && !SKIP_TAGS.test((n as Element).tagName)) add(n as Element); }
        if (any) add(t);
      } else {
        // The scroll-behavior the keyboard kit sets on the root is not the page's doing.
        if (r.type === 'attributes' && (t === document.documentElement || t === document.body) && r.attributeName === 'style') continue;
        add(t);
        // A class or state set on an element can show or hide what is next to it (a sibling selector).
        if (r.type === 'attributes' && t.parentElement && t.parentElement !== document.documentElement) add(t.parentElement);
      }
    }
  };
  // The callback runs in the microtask after each handler, while `window.event` is still the event being dispatched.
  const observer = new MutationObserver((recs) => record(recs));
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  // The listener hook's timer notes (what each timer's own callback writes), read for a click's window (`diff`'s
  // `since`); turned off again by `drop`. No hook: nothing is left out.
  try { (W.__grntedTimerChanges as ((on: boolean) => boolean) | undefined)?.(true); } catch { /* no hook */ }
  /** Records what is pending, so `touched` holds everything scripts changed up to now. */
  const flush = (): void => record(observer.takeRecords());
  /** Timers of 1 s or more (the listener hook's record) that ran since `t`: [index, times run, kind]. */
  const ranSince = (t: number): { k: number; fired: number; interval: boolean }[] => {
    try {
      const hooks = typeof W.__grntedHooks === 'function' ? W.__grntedHooks() as { timers: { kind?: string; fired?: number; lastFiredAt?: number }[] } : null;
      if (!hooks) return [];
      return hooks.timers.map((x, k) => ({ k, fired: x.fired ?? 0, interval: x.kind === 'interval', at: x.lastFiredAt ?? -Infinity })).filter((x) => x.at >= t);
    } catch {
      return [];
    }
  };
  const firedNow = (k: number): number => {
    try { return ((W.__grntedHooks() as { timers: { fired?: number }[] }).timers[k]?.fired) ?? 0; } catch { return 0; }
  };
  /** What scripts changed during the last press (`effect`), kept for `rediff`. */
  let lastTouched = new Set<Element>();
  let lastDirect = new Set<Element>();
  /** `e` is, is inside, or (for a container that changed its children) holds an element in `set`. */
  const covered = (set: ReadonlySet<Element>, e: Element): boolean => {
    for (const x of set) if (x === e || x.contains(e)) return true;
    return false;
  };

  // --- Page state --------------------------------------------------------------------------------
  interface Snap {
    url: string; shown: Set<Element>; texts: Map<Element, string>; values: Map<Element, string>; own: string; ownText: string;
    active: Element | null;
    /** The live regions inside shadow roots at this moment (the observer does not see them come and go). */
    live: Set<Element>;
    /** When it was taken (the page's clock): `ariaNotify` calls after it are the press's (batch 19). */
    t: number;
  }
  const OWN_ATTRS = ['aria-pressed', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-current', 'open', 'hidden'];
  const snaps = new Map<string, Snap>();
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
    const texts = new Map<Element, string>();
    const values = new Map<Element, string>();
    const live = new Set<Element>();
    for (const e of elements(6000)) {
      if (e.shadowRoot) {
        const inner = e.shadowRoot.querySelectorAll('[aria-live], [role], output');
        for (let k = 0; k < inner.length && k < 200; k++) if (isLive(inner[k]!)) live.add(inner[k]!);
      }
      if (el && within(el, e)) continue; // the control's own subtree: only its text and state count
      if (SKIP_TAGS.test(e.tagName) || ours(e)) continue;
      const v = valueOf(e);
      if (v !== null) values.set(e, v);
      if (!shown(e)) continue;
      set.add(e);
      let own = '';
      for (const n of e.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      if (own.trim()) texts.set(e, clean(own, 240));
    }
    const ownText = el ? clean(textName(el), 200) : '';
    const own = el ? `${OWN_ATTRS.map((a) => `${a}=${el.getAttribute(a) ?? ''}`).join('|')}|${ownText}|${valueOf(el) ?? ''}` : '';
    return { url: location.href, shown: set, texts, values, own, ownText, active: deepActive(), live, t: performance.now() };
  };
  /** The last comparison's outermost elements that came into view, and the texts that changed (for `after`). */
  let lastRoots: Element[] = [];
  let lastTexts: Element[] = [];
  const diff = (a: Snap, b: Snap, el: Element | null, by: ReadonlySet<Element>, since?: number): Effect => {
    const quiet = (e: Element) => !covered(noisy, e);
    // Shown or hidden by a script: the element, or something around it, was changed by one.
    const scripted = (e: Element) => covered(by, e) && quiet(e);
    // Lead's cut (batch 17): with `since`, a change that a timer the page set before `since` wrote at or after it
    // (the listener hook's timer notes) is the page's own doing, never the press's: it is left out and counted.
    const wrote = typeof since === 'number' && typeof W.__grntedTimerWrote === 'function' ? W.__grntedTimerWrote as (e: Element, s: number) => boolean : null;
    const left = new Set<Element>();
    const bySelf = (e: Element): boolean => {
      if (!wrote) return false;
      let yes = false;
      try { yes = wrote(e, since!) === true; } catch { yes = false; }
      if (yes) left.add(e);
      return yes;
    };
    const outermost = (list: Element[]) => {
      const all = new Set(list);
      return list.filter((e) => { for (let p = parentOf(e); p; p = parentOf(p)) if (all.has(p)) return false; return true; });
    };
    // What came into view or went out of it as one piece (an outermost element) and was the page's own: the whole piece.
    const withoutSelf = (list: Element[]): Element[] => {
      if (!wrote || !list.length) return list;
      const drop = outermost(list).filter(bySelf);
      return drop.length ? list.filter((e) => !drop.some((d) => within(d, e))) : list;
    };
    const appearedAll: Element[] = [];
    const wentAll: Element[] = [];
    for (const e of b.shown) if (!a.shown.has(e) && scripted(e)) appearedAll.push(e);
    for (const e of a.shown) if (!b.shown.has(e) && scripted(e)) wentAll.push(e);
    const appeared = withoutSelf(appearedAll);
    const went = withoutSelf(wentAll);
    const hidden = went.length;
    const roots = outermost(appeared);
    const out: Effect = { changed: false, shown: roots.length, hidden, values: 0, direct: false, timeouts: 0, intervals: 0 };
    const changedValues: Element[] = [];
    const changedTexts: Element[] = [];
    for (const [e, t] of b.texts) {
      const before = a.texts.get(e);
      if (before === t || !quiet(e)) continue;
      // New text in an element that was already there (empty before, or changed).
      if ((a.shown.has(e) || before !== undefined) && !bySelf(e)) {
        changedTexts.push(e);
        if (!out.textChange) out.textChange = { from: clean(before ?? '', 60), to: clean(t, 60) };
      }
    }
    for (const [e, t] of a.texts) if (!b.texts.has(e) && b.shown.has(e) && quiet(e) && t && !bySelf(e)) { changedTexts.push(e); if (!out.textChange) out.textChange = { from: clean(t, 60), to: '' }; }
    for (const [e, v] of b.values) if (a.values.has(e) && a.values.get(e) !== v && quiet(e) && !bySelf(e)) { out.values++; changedValues.push(e); }
    if (a.url !== b.url) out.url = b.url;
    if (a.own !== b.own && !(el && noisy.has(el)) && !(el && bySelf(el))) out.own = b.ownText !== a.ownText ? `its text becomes “${clean(b.ownText, 60)}”` : 'its state changes';
    if (left.size) out.self = left.size;
    const first = roots.find((e) => clean((e as HTMLElement).innerText ?? e.textContent));
    if (first) out.text = clean((first as HTMLElement).innerText ?? first.textContent, 80);
    if (b.active && b.active !== a.active && !(el && within(el, b.active))) out.focus = { path: cssPath(b.active), name: nameOf(b.active) };
    out.changed = !!(out.shown || out.hidden || out.textChange || out.values || out.url || out.own || out.focus);
    if (out.shown || out.hidden || changedTexts.length || changedValues.length) {
      // An element taken out of the document has no path any more: its text stands for it.
      const place = (e: Element) => (e.isConnected ? cssPath(e) : `gone:${clean(e.textContent, 60)}`);
      // What it says now, numbers left out (a time or a count differs from one press to the next): two
      // presses that put different words in the same place did different things.
      const says = (t: string | null | undefined) => clean(t, 48).replace(/\d+/g, '#');
      const gone = outermost(went);
      const sets: [string, Element[]][] = [['+', roots], ['-', gone], ['~', changedTexts], ['=', changedValues]];
      out.where = [
        ...roots.slice(0, 6).map((e) => `+${place(e)}=${says((e as HTMLElement).innerText ?? e.textContent)}`),
        ...gone.slice(0, 6).map((e) => `-${place(e)}`),
        ...changedTexts.slice(0, 6).map((e) => `~${place(e)}=${says(b.texts.get(e))}`),
        ...changedValues.slice(0, 6).map((e) => `=${place(e)}=${says(b.values.get(e))}`),
      ];
      out.ids = [...new Set(sets.flatMap(([, list]) => list.slice(0, 6).map((e) => e.id)).filter(Boolean))].slice(0, 8);
    }
    lastRoots = roots;
    lastTexts = changedTexts;
    return out;
  };

  // --- What a press opened -------------------------------------------------------------------------
  const opened: Element[] = [];
  /** The messages of the last `after`, by id. */
  const msgs: { el: Element; text: string; path: string }[] = [];
  const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const MENU = '[role="menu"], [role="listbox"], [role="tree"], [role="grid"]';
  /** The dialog, menu or layer a root is, or wraps as its one main part (a backdrop around a dialog). */
  const mainPart = (root: Element): { el: Element; kind: Opened['kind'] } => {
    if (root.matches(DIALOG)) return { el: root, kind: 'dialog' };
    const d = root.querySelector(DIALOG);
    if (d && shown(d)) return { el: d, kind: 'dialog' };
    if (root.matches(MENU)) return { el: root, kind: 'menu' };
    const m = root.querySelector(MENU);
    if (m && shown(m)) return { el: m, kind: 'menu' };
    for (let e: Element | null = root, k = 0; e && e !== document.body && k < 3; e = e.parentElement, k++) {
      const st = getComputedStyle(e);
      if (st.position === 'fixed' || (st.position === 'absolute' && st.zIndex !== 'auto' && Number(st.zIndex) > 0)) return { el: root, kind: 'overlay' };
    }
    return { el: root, kind: 'panel' };
  };
  const isModal = (el: Element): boolean => {
    try { if (el.matches(':modal')) return true; } catch { /* no :modal */ }
    return el.getAttribute('aria-modal') === 'true';
  };

  /** Elements kept by handle for later calls (a composite's current member). */
  const kept: Element[] = [];
  function keep(el: Element): number {
    const at = kept.indexOf(el);
    if (at >= 0) return at;
    kept.push(el);
    return kept.length - 1;
  }

  const api = {
    /**
     * The page's controls to press, the most telling first: custom controls that take focus, composite
     * widgets, native buttons with pointer-only listeners, other native buttons (not a form's submit
     * button), then elements that only answer to the pointer. One per look-alike group first; links, form
     * fields, submit buttons and controls named for an action on the site are never listed.
     */
    candidates(o: { refs: { ref: number; types: string[] }[]; delegated: string[]; max: number }): CandidateList {
      const typesOf = new Map<Element, string[]>();
      for (const r of o.refs) {
        const el = target(r.ref);
        if (el instanceof Element) typesOf.set(el, r.types);
      }
      const pointerTypes = new Set<string>(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']);
      const keyTypes = new Set<string>(['keydown', 'keyup', 'keypress']);
      const pointerOf = (el: Element) => (typesOf.get(el) ?? []).filter((t) => pointerTypes.has(t));
      const hasKey = (el: Element) => (typesOf.get(el) ?? []).some((t) => keyTypes.has(t));
      const delegatedPointer = o.delegated.some((t) => pointerTypes.has(t));
      /** A pointer handler on an ancestor (or the document) may act for this element. */
      const delegatedFor = (el: Element): boolean => {
        if (delegatedPointer) return true;
        for (let a = parentOf(el); a && a !== document.body && a !== document.documentElement; a = parentOf(a)) if (pointerOf(a).length) return true;
        return false;
      };
      const pool = new Set<Element>(typesOf.keys());
      const SEMANTIC = '[role], [tabindex], [aria-expanded], [aria-pressed], [aria-haspopup], button, input[type="button"]';
      const scan = (root: Document | ShadowRoot) => {
        const all = root.querySelectorAll(SEMANTIC);
        for (let k = 0; k < all.length && pool.size < 4000; k++) pool.add(all[k]!);
        const every = root.querySelectorAll('*');
        for (let k = 0; k < every.length && k < 8000; k++) if ((every[k] as Element).shadowRoot) scan((every[k] as Element).shadowRoot!);
      };
      scan(document);
      // Elements with a pointer cursor under a handler on an ancestor or the document (event delegation).
      const pointy = document.querySelectorAll('div, span, li, img, svg, i, p, td, th, figure, a:not([href])');
      for (let k = 0; k < pointy.length && k < 3000 && pool.size < 5000; k++) {
        const el = pointy[k]!;
        if (pool.has(el) || getComputedStyle(el).cursor !== 'pointer') continue;
        const p = el.parentElement;
        if (p && getComputedStyle(p).cursor === 'pointer') continue;
        if (delegatedFor(el)) pool.add(el);
      }

      type Draft = Omit<ControlCandidate, 'i'> & { el: Element; rank: number; sig: string };
      const drafts: Draft[] = [];
      const composites = new Set<Element>();
      let refused = 0;
      const consider = (el: Element): void => {
        if (!el.isConnected || el === document.body || el === document.documentElement) return;
        if (!shown(el) || el.closest('[inert], [aria-hidden="true"], [aria-disabled="true"]') || (el as HTMLButtonElement).disabled) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || isWrapper(el)) return;
        if (el.closest(PLACED)) return;
        const tag = el.localName;
        const role = roleOf(el);
        const own = pointerOf(el);
        // A choice in a composite widget: judged as the widget, once.
        const box = MEMBER_OF[role] ? el.closest(MEMBER_OF[role]!) : el.closest('[role="toolbar"]');
        if (box && !composites.has(box)) {
          const memberSel = MEMBER_OF[role] ? `[role="${role}"]` : 'button, [role="button"], input[type="button"]';
          const members = [...box.querySelectorAll(memberSel)].filter((m) => shown(m) && !(m as HTMLButtonElement).disabled && m.getAttribute('aria-disabled') !== 'true');
          // A toolbar counts only with a roving Tab stop (some members out of the Tab order).
          const roving = members.some((m) => !tabbable(m));
          if (members.length >= 2 && members.includes(el) && (MEMBER_OF[role] || roving)) {
            composites.add(box);
            const cur = members.find((m) => tabbable(m)) ?? members.find((m) => /^true$/.test(m.getAttribute('aria-selected') ?? m.getAttribute('aria-checked') ?? '')) ?? members[0]!;
            const chosen = (m: Element) => /^true$/.test(m.getAttribute('aria-selected') ?? m.getAttribute('aria-checked') ?? m.getAttribute('aria-pressed') ?? '');
            const pick = members.find((m) => m !== cur && !chosen(m)) ?? members.find((m) => m !== cur);
            if (!pick) return;
            const why = refusal(pick) || refusal(cur);
            if (why) { refused++; return; }
            const tops = members.map((m) => Math.round(m.getBoundingClientRect().top));
            const horizontal = box.getAttribute('aria-orientation') !== 'vertical' && (Math.max(...tops) - Math.min(...tops) < 8 || role === 'tab');
            drafts.push({
              el: pick, path: cssPath(pick), name: nameOf(pick), tag: pick.localName, ...(roleOf(pick) ? { role: roleOf(pick) } : {}), kind: 'composite',
              tabbable: tabbable(pick), focusable: focusable(pick), types: pointerOf(pick), pointerOnly: false, rank: 1, sig: `composite|${cssPath(box)}`,
              composite: { path: cssPath(box), role: roleOf(box) || 'toolbar', members: members.length, current: keep(cur), horizontal },
            });
            return;
          }
        }
        if (box && composites.has(box) && (MEMBER_OF[role] || tag === 'button')) return;
        const native = NATIVE.test(tag);
        if (native) {
          if (tag !== 'button' && !(tag === 'input' && (el as HTMLInputElement).type === 'button')) return;
          const why = refusal(el);
          if (why) { refused++; return; }
          const pointerOnly = own.length > 0 && !own.includes('click') && !hasKey(el);
          const opener = el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-controls');
          drafts.push({
            el, path: cssPath(el), name: nameOf(el), tag, ...(role ? { role } : {}), kind: 'native', tabbable: tabbable(el), focusable: focusable(el),
            types: own, pointerOnly, rank: pointerOnly ? 2 : opener ? 3 : 4, sig: signature(el), ...(opener ? { opener: true as const } : {}),
          });
          return;
        }
        // Not native: a control when it has a widget role, its own pointer listener, or a pointer cursor under a delegated handler.
        const pointer = getComputedStyle(el).cursor === 'pointer';
        const isControl = WIDGET.has(role) || own.length > 0 || (pointer && delegatedFor(el));
        if (!isControl) return;
        if (role && !WIDGET.has(role) && !own.length) return;
        if (carouselPart(el) && !own.includes('click') && !WIDGET.has(role)) return;
        // A wrapper around real controls, or a part of one: those controls are the keyboard's way in.
        if (tabbablesIn(el, 1).length) return;
        for (let a = parentOf(el); a && a !== document.body; a = parentOf(a)) if (tabbable(a) || a.matches('label, summary')) return;
        const why = refusal(el);
        if (why) { refused++; return; }
        const canFocus = focusable(el);
        const pointerOnly = own.length > 0 && !own.includes('click') && !hasKey(el);
        drafts.push({
          el, path: cssPath(el), name: nameOf(el), tag, ...(role ? { role } : {}), kind: canFocus ? 'custom' : 'clickable', tabbable: tabbable(el), focusable: canFocus,
          types: own, pointerOnly, rank: canFocus ? 0 : 5, sig: signature(el),
        });
      };
      for (const el of pool) consider(el);
      // Document order within a rank; one per look-alike group first, the rest after them.
      drafts.sort((x, y) => x.rank - y.rank || (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const seen = new Set<string>();
      const firsts: Draft[] = [];
      const rest: Draft[] = [];
      for (const d of drafts) {
        if (seen.has(d.sig)) rest.push(d);
        else { seen.add(d.sig); firsts.push(d); }
      }
      const ordered = [...firsts, ...rest.filter((d) => d.rank <= 2)];
      const list: ControlCandidate[] = [];
      for (const d of ordered.slice(0, o.max)) {
        const { el, rank: _rank, sig: _sig, ...c } = d;
        list.push({ i: cands.length, ...c });
        cands.push(el);
      }
      return { list, more: Math.max(0, ordered.length - list.length) + rest.filter((d) => d.rank > 2).length, refused };
    },
    /**
     * Search and filter fields to type into (at most `max`; fields in the main content first): a search
     * input, a search box, a field in a search landmark, or a text field whose label, name or placeholder
     * (or whose form's own button) says search, filter or find. Never a password, an email or any other kind of field.
     */
    searchFields(o: { max: number }): FieldCandidate[] {
      const SEARCHY = /\b(search|filter|find|keywords?|query|look ?up)\b/i;
      const found: { el: Element; main: boolean }[] = [];
      const all = document.querySelectorAll('input, [role="searchbox"]');
      for (let k = 0; k < all.length && k < 2000; k++) {
        const el = all[k]!;
        if (el instanceof HTMLInputElement) {
          if (!/^(search|text)$/.test(el.type || 'text') || el.readOnly || el.disabled || el.list) continue;
        } else if (!(el as HTMLElement).isContentEditable) continue;
        if (!shown(el) || el.closest('[inert], [aria-hidden="true"], [aria-disabled="true"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 12) continue;
        const labels = el instanceof HTMLInputElement && el.labels ? [...el.labels].map((l) => l.textContent ?? '').join(' ') : '';
        const words = `${el.getAttribute('aria-label') ?? ''} ${labels} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('name') ?? ''} ${el.id}`.replace(/[-_]+/g, ' ');
        // A form with one or two text fields whose own button says search, find or filter is a search form.
        const form = el instanceof HTMLInputElement ? el.form : null;
        const byButton = !!form && form.querySelectorAll('input:not([type]), input[type="text"], input[type="search"], textarea').length <= 2
          && [...form.querySelectorAll('button, input[type="submit"]')].some((b) => SEARCHY.test(nameOf(b)));
        const searchy = (el instanceof HTMLInputElement && el.type === 'search') || roleOf(el) === 'searchbox' || !!el.closest('[role="search"], search') || SEARCHY.test(words) || byButton;
        if (!searchy || actionRe.test(words)) continue;
        found.push({ el, main: !!el.closest('main, [role="main"]') && !el.closest('header, nav, [role="banner"], [role="navigation"], footer') });
      }
      found.sort((x, y) => Number(y.main) - Number(x.main));
      const out: FieldCandidate[] = [];
      for (const f of found.slice(0, o.max)) {
        const labels = f.el instanceof HTMLInputElement && f.el.labels ? [...f.el.labels].map((l) => l.textContent ?? '').join(' ') : '';
        out.push({ i: cands.length, path: cssPath(f.el), name: clean(f.el.getAttribute('aria-label') || labels || f.el.getAttribute('placeholder') || f.el.getAttribute('name') || '', 60) });
        cands.push(f.el);
      }
      return out;
    },
    /**
     * Scrolls a candidate into view and gives a point on it the pointer reaches (null: covered or off the
     * screen; `refused`: every reachable point is a link, a form field, a submit button or an action).
     */
    prepare(o: { i: number }): { x: number; y: number } | { refused: string } | null {
      const el = cands[o.i];
      if (!el || !el.isConnected || !shown(el)) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      let refused = '';
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.15, 0.5], [0.85, 0.5]] as const) {
        const x = Math.round(r.left + r.width * fx);
        const y = Math.round(r.top + r.height * fy);
        if (x < 1 || y < 1 || x > innerWidth - 2 || y > innerHeight - 2) continue;
        const hit = deepHit(x, y);
        if (!hit || !within(el, hit)) continue;
        const why = refusal(hit);
        if (!why) return { x, y };
        refused ||= why;
      }
      return refused ? { refused } : null;
    },
    /** Focuses a candidate (or a kept element) from a script, without scrolling; true when it holds focus. */
    focus(o: { i?: number; id?: number }): boolean {
      const el = typeof o.id === 'number' ? kept[o.id] : cands[o.i ?? -1];
      if (!el || !el.isConnected) return false;
      (el as HTMLElement).focus?.({ preventScroll: true });
      return deepActive() === el;
    },
    /**
     * A choice beside a candidate that pressing it may act on (a filter's month, a sort order, a district): the
     * nearest container around it, at most 3 levels up, that holds 1 to 4 form fields, none of them typed into
     * (no text field). Its first single-choice list with another enabled option gets that option, or its first
     * radio group the first unchosen choice; `input` and `change` are sent as a person's choice sends them.
     * Returns what was chosen ("December" in "Month"), or null when there is no such choice.
     */
    choose(o: { i: number }): string | null {
      const el = cands[o.i];
      if (!el || !el.isConnected) return null;
      const labelOf = (f: Element): string => clean(((f as HTMLInputElement).labels?.[0]?.textContent) || f.getAttribute('aria-label') || f.getAttribute('name') || '', 40);
      for (let a: Element | null = el.parentElement, d = 0; a && d < 3 && a !== document.body && a !== document.documentElement; a = a.parentElement, d++) {
        const fields = Array.from(a.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), select, textarea'));
        if (!fields.length) continue;
        if (fields.length > 4 || fields.some((f) => f.matches('textarea, input:not([type="radio"]):not([type="checkbox"])'))) return null;
        for (const f of fields) {
          if (!(f instanceof HTMLSelectElement) || f.multiple || f.disabled || !shown(f)) continue;
          const next = Array.from(f.options).findIndex((opt, k) => k !== f.selectedIndex && !opt.disabled && opt.value !== '');
          if (next < 0) continue;
          f.selectedIndex = next;
          f.dispatchEvent(new Event('input', { bubbles: true }));
          f.dispatchEvent(new Event('change', { bubbles: true }));
          return `${clean(f.options[next]!.text, 40)}${labelOf(f) ? ` in ${labelOf(f)}` : ''}`;
        }
        const radio = fields.find((f) => f instanceof HTMLInputElement && f.type === 'radio' && !f.checked && !f.disabled && shown(f)) as HTMLInputElement | undefined;
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event('input', { bubbles: true }));
          radio.dispatchEvent(new Event('change', { bubbles: true }));
          return labelOf(radio) || 'another choice';
        }
        return null;
      }
      return null;
    },
    /** Blurs whatever has focus. */
    blur(): void {
      const a = deepActive();
      if (a) (a as HTMLElement).blur?.();
    },
    /**
     * Starts a press: what scripts changed until now is forgotten (with `idle`, it is the page's own doing,
     * since nothing was pressed: those elements are left out from then on), and the state is recorded
     * under `label`. From here on, what scripts change is the next `effect`'s.
     */
    begin(o: { i: number; label: string; idle?: boolean }): number {
      flush();
      if (o.idle) for (const e of touched) noisy.add(e);
      touched.clear();
      byInput.clear();
      born.clear();
      touchedCount = 0;
      began = performance.now();
      snaps.set(o.label, snap(cands[o.i] ?? null));
      return noisy.size;
    },
    /**
     * Watches the page with nothing pressed, for `ms` and until every interval of 1 s or more that ran
     * during the last press has run again (at most `maxMs`): what scripts change meanwhile changes by
     * itself, and is left out from then on (`rediff` then shows what the press alone did). Returns how
     * many elements changed by themselves.
     */
    async quiet(o: { ms: number; maxMs?: number }): Promise<number> {
      flush();
      touched.clear();
      const waitFor = ranSince(began).filter((x) => x.interval);
      const t0 = performance.now();
      const cap = Math.max(o.ms, o.maxMs ?? o.ms);
      for (;;) {
        await new Promise<void>((r) => { setTimeout(r, 50); });
        const ms = performance.now() - t0;
        if (ms >= cap) break;
        if (ms >= o.ms && waitFor.every((x) => firedNow(x.k) > x.fired)) {
          // The timer's own changes land with it; one more moment for what it started.
          await new Promise<void>((r) => { setTimeout(r, 30); });
          break;
        }
      }
      flush();
      let n = 0;
      for (const e of touched) { if (!covered(noisy, e)) n++; noisy.add(e); }
      touched.clear();
      byInput.clear();
      return n;
    },
    /** The last press compared again (states `a` and `b`), with what was since seen changing by itself left out. */
    rediff(o: { i: number; a: string; b: string; since?: number }): Effect | null {
      const a = snaps.get(o.a);
      const b = snaps.get(o.b);
      if (!a || !b) return null;
      const el = cands[o.i] ?? null;
      const direct = lastDirect.size ? diff(a, b, el, lastDirect, o.since) : null;
      const out = direct?.changed ? direct : diff(a, b, el, lastTouched, o.since);
      out.direct = !!direct?.changed;
      return out;
    },
    /** Records the page state under a label (`i`: the control, whose own subtree is read as its state). */
    snap(o: { i: number; label: string }): void { snaps.set(o.label, snap(cands[o.i] ?? null)); },
    /** The page's clock (`performance.now()` ms), the start of a click's window (`since` of `effect` and `rediff`). */
    clock(): number { return performance.now(); },
    /**
     * Waits `ms` and two animation frames (capped), records the state under `b`, and compares it with
     * `a`: what scripts changed since the last `watch`. One round trip per press.
     */
    async effect(o: { i: number; a: string; b: string; ms: number; member?: boolean; since?: number }): Promise<Effect | null> {
      await new Promise<void>((r) => { setTimeout(r, o.ms); });
      await new Promise<void>((r) => {
        let done = false;
        const go = () => { if (!done) { done = true; r(); } };
        setTimeout(go, 60);
        try { requestAnimationFrame(() => requestAnimationFrame(go)); } catch { go(); }
      });
      const a = snaps.get(o.a);
      if (!a) return null;
      const el = cands[o.i] ?? null;
      const b = snap(el);
      snaps.set(o.b, b);
      flush();
      lastTouched = new Set(touched);
      lastDirect = new Set(byInput);
      const ran = ranSince(began);
      // What the press's own events changed, when that alone is a change; else everything since `begin`.
      const direct = byInput.size ? diff(a, b, el, byInput, o.since) : null;
      const out = direct?.changed ? direct : diff(a, b, el, touched, o.since);
      out.direct = !!direct?.changed;
      out.timeouts = ran.filter((x) => !x.interval).length;
      out.intervals = ran.filter((x) => x.interval).length;
      if (o.member && el) {
        // A composite: focus that moved to another of its members is the arrow key working.
        const box = el.parentElement?.closest('[role="tablist"], [role="radiogroup"], [role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="toolbar"]');
        if (box && b.active && b.active !== a.active && box.contains(b.active)) { out.member = true; out.changed = true; }
      }
      return out;
    },
    /** What the last press left: where focus is, what it opened, and short texts that appeared or changed. */
    after(o: { i: number; a: string; b: string }): AfterState {
      const el = cands[o.i] ?? null;
      const a = snaps.get(o.a);
      const b = snaps.get(o.b);
      const act = deepActive();
      const active = { path: act ? cssPath(act) : '', name: act ? nameOf(act) : '', inControl: !!(act && el && within(el, act)), none: !act };
      const out: AfterState = { active, focusMoved: !!(a && b && b.active !== a.active), opened: [], messages: [] };
      if (!a || !b) return out;
      opened.length = 0;
      msgs.length = 0;
      const seen = new Set<Element>();
      const controlled = new Set((el?.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x));
      for (const root of lastRoots) {
        if (!root.isConnected || !shown(root)) continue;
        const r = root.getBoundingClientRect();
        if (r.width < 16 || r.height < 16) continue;
        const part = mainPart(root);
        if (seen.has(part.el)) continue;
        seen.add(part.el);
        const tabs = tabbablesIn(part.el, 30);
        const focusables = [...part.el.querySelectorAll('[tabindex]')].filter((e) => !tabbable(e) && shown(e)).length;
        const k = opened.length;
        opened.push(part.el);
        out.opened.push({
          k, path: cssPath(part.el), name: clean(part.el.getAttribute('aria-label') ?? nameOf(part.el.querySelector('h1, h2, h3, h4, [role="heading"]') ?? part.el, 60), 60),
          kind: part.kind, modal: isModal(part.el), tabbables: tabs.length, focusables, hasFocus: !!(act && within(part.el, act)),
        });
        if (out.opened.length >= 4) break;
      }
      // Short texts that appeared (a small element that came into view) or changed (an element already there).
      const cand = new Map<Element, boolean>();
      for (const root of lastRoots) {
        if (!root.isConnected) continue;
        const text = clean((root as HTMLElement).innerText ?? root.textContent, 400);
        if (text && text.length <= 240 && !tabbablesIn(root, 1).length) cand.set(root, true);
      }
      for (const e of lastTexts) if (![...cand.keys()].some((r) => within(r, e))) cand.set(e, false);
      const name = el ? nameOf(el, 120) : '';
      const disclosureLike = !!el && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup') || /^(tab|menuitem|treeitem|option|switch|checkbox|radio)$/.test(roleOf(el)) || el.localName === 'summary' || disclosureRe.test(name));
      for (const [m, appeared] of cand) {
        if (!m.isConnected || !shown(m) || (el && (within(el, m) || within(m, el)))) continue;
        const text = clean((m as HTMLElement).innerText ?? m.textContent, 400);
        if (text.length < 2 || text.length > 240) continue;
        // Announced: every piece of the message's text is in a live region (an ancestor of the text, also across
        // a slot and a shadow root) that was in the page before the text was put into it: there before the
        // press, or added empty since. An alert is announced when it comes in with its text too.
        // Inside a shadow root the observer sees nothing: a region there counts only when it was there, and live,
        // before the press (`Snap.live`). One that is new there may have come with the message: not told (null).
        flush();
        const announced = (n: Node): boolean | null => {
          let unseen = false;
          let e: Element | null = n.nodeType === 1 ? n as Element : ((n as Text).assignedSlot as Element | null) ?? n.parentElement;
          for (; e; e = (e.assignedSlot as Element | null) ?? parentOf(e)) {
            if (!isLive(e)) continue;
            if ((e.getAttribute('role') ?? '').trim().toLowerCase() === 'alert') return true;
            if ((e.getRootNode() as Node).nodeType === 11) {
              if (a.live.has(e)) return true;
              unseen = true;
              continue;
            }
            if (!born.has(e) || born.get(e) === true) return true;
          }
          return unseen ? null : false;
        };
        let pieces = 0;
        let live = true;
        let unsure = false;
        const judge = (n: Node): void => {
          const r = announced(n);
          if (r === false) live = false;
          else if (r === null) unsure = true;
        };
        const walker = document.createTreeWalker(m, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n && pieces < 40 && live; n = walker.nextNode()) {
          if (!(n.nodeValue ?? '').trim()) continue;
          pieces++;
          judge(n);
        }
        if (!pieces) judge(m);
        // A piece that is certainly not announced makes the message unannounced; else one that could not be told makes it unsure.
        unsure = live && unsure;
        if (unsure) live = false;
        // Announced through `ariaNotify` since the press (batch 19): the message's words, or words that hold them.
        if (!live) {
          const said = text.toLowerCase().replace(/\s+/g, ' ').trim();
          if (said && notified.some((n) => n.t >= a.t && n.text && (n.text.toLowerCase().includes(said) || said.includes(n.text.toLowerCase())))) { live = true; unsure = false; }
        }
        const focus = !!act && (within(m, act) || within(act, m));
        const inOpened = out.opened.some((op) => (op.hasFocus || op.kind === 'dialog' || op.kind === 'menu') && within(opened[op.k]!, m) && opened[op.k] !== m);
        const tied = [...controlled].some((c) => within(c, m)) || !!m.closest('[role="tabpanel"], [role="tooltip"], [role="dialog"], [role="alertdialog"], dialog, [role="menu"], [role="listbox"]');
        out.messages.push({ id: msgs.length, path: cssPath(m), text: clean(text, 160), live, ...(unsure ? { unsure: true } : {}), focus, appeared, status: !disclosureLike && statusRe.test(text), ofOpened: inOpened || tied });
        msgs.push({ el: m, text, path: cssPath(m) });
        if (out.messages.length >= 6) break;
      }
      return out;
    },
    /** Whether a message from the last `after` is still in view with the same text (a second press did not take it away). */
    messageShown(o: { id: number }): boolean {
      const m = msgs[o.id];
      if (!m) return false;
      const same = (e: Element | null) => !!e && e.isConnected && shown(e) && clean((e as HTMLElement).innerText ?? e.textContent, 400) === m.text;
      if (same(m.el)) return true;
      // Shown again in a new element at the same place (a note that is put back on every press).
      try { return same(document.querySelector(m.path)); } catch { return false; }
    },
    /** Whether keyboard focus is inside what a press opened (`k` from `after`); null when it is gone. */
    focusIn(o: { k: number }): boolean | null {
      const root = opened[o.k];
      if (!root || !root.isConnected || !shown(root)) return null;
      const a = deepActive();
      return !!a && within(root, a);
    },
    /** The focused element: its path and name, and whether it uses aria-activedescendant to point into `k`. */
    activeNow(o: { k?: number }): { path: string; name: string; points: boolean } {
      const a = deepActive();
      const root = typeof o.k === 'number' ? opened[o.k] : undefined;
      const ad = a?.getAttribute('aria-activedescendant');
      const pointed = ad ? document.getElementById(ad) : null;
      return { path: a ? cssPath(a) : '', name: a ? nameOf(a) : '', points: !!(root && pointed && within(root, pointed)) };
    },
    /** Focuses the first element Tab can reach inside what a press opened; false when there is none. */
    focusInto(o: { k: number }): boolean {
      const root = opened[o.k];
      if (!root || !root.isConnected) return false;
      const first = tabbablesIn(root, 1)[0];
      if (!first) return false;
      (first as HTMLElement).focus?.({ preventScroll: true });
      const a = deepActive();
      return !!a && within(root, a);
    },
    /** A button inside what a press opened whose whole name only dismisses (`pattern`), as a point to click. */
    closer(o: { k: number; pattern: string }): { x: number; y: number } | null {
      const root = opened[o.k];
      if (!root || !root.isConnected) return null;
      const re = new RegExp(o.pattern, 'i');
      for (const b of root.querySelectorAll('button, [role="button"], input[type="button"], a:not([href]), span, div, i, svg')) {
        if (!shown(b) || b.childElementCount > 2 || !re.test(nameOf(b)) || refusal(b)) continue;
        const r = b.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = deepHit(x, y);
        if (hit && within(b, hit)) return { x, y };
      }
      return null;
    },
    /** Closes native dialogs and details a press opened that are still open (what Escape and a second press left). */
    closeNative(): number {
      let n = 0;
      for (const root of opened) {
        if (!root.isConnected) continue;
        for (const d of [root, ...root.querySelectorAll('dialog[open]')]) {
          if (d instanceof HTMLDialogElement && d.open) { try { d.close(); n++; } catch { /* not closable */ } }
        }
      }
      return n;
    },
    /** Whether anything a press opened is still in view, and whether it stands in the way of the next press (a dialog, or a layer over 30% of the screen or more). */
    stillOpen(): { open: number; blocking: boolean } {
      let open = 0;
      let blocking = false;
      for (const root of opened) {
        if (!root.isConnected || !shown(root)) continue;
        open++;
        const part = mainPart(root);
        // A dialog, or a layer over a good part of the screen, stands in the way of the next control; a
        // note in a corner (a toast) does not.
        const r = part.el.getBoundingClientRect();
        if (part.kind === 'dialog' || (part.kind === 'overlay' && r.width * r.height >= 0.3 * innerWidth * innerHeight)) blocking = true;
      }
      return { open, blocking };
    },
    /**
     * A keyboard way to the same thing next to a control that only answers to the pointer: a link Tab can
     * reach with the address the click went to, or (`card`) a card around the control with one to three
     * controls of its own (a clickable tile beside its own link). The card must be one: a list item, an
     * article, a figure or a table cell, or a wrapper up to six times the control's size. A column of
     * content with a few links in it is no keyboard way to what this control does.
     */
    equivalent(o: { i: number; url?: string; card?: boolean }): string {
      const el = cands[o.i];
      if (!el) return '';
      if (o.url) {
        const want = o.url.split('#')[0];
        const links = document.querySelectorAll('a[href]');
        for (let k = 0; k < links.length && k < 2000; k++) if ((links[k] as HTMLAnchorElement).href.split('#')[0] === want && tabbable(links[k]!)) return 'a link with the same address';
      }
      if (!o.card) return '';
      const LANDMARK = 'main, [role="main"], form, [role="form"], [role="search"]';
      for (const anc of [el.parentElement, el.parentElement ? el.parentElement.parentElement : null]) {
        if (!anc || anc === document.body || anc.matches(LANDMARK)) break;
        const n = tabbablesIn(anc, 4, el).length;
        if (n < 1 || n > 3) continue;
        // A card, not a column of content that happens to hold a few links: a list item, an article, a
        // figure or a table cell, or a wrapper no more than six times the control's own size.
        const a = anc.getBoundingClientRect();
        const e = el.getBoundingClientRect();
        if (anc.matches('li, article, figure, td, th') || a.width * a.height <= 6 * Math.max(1, e.width * e.height)) return 'controls next to it';
      }
      return '';
    },
    /**
     * What the control says about its own keys (Understanding 2.1.1: any key will do): aria-keyshortcuts
     * and accesskey on it or inside it, and the texts tied to it (its title, its description, its name,
     * and the short text of the element around it), where an instruction such as "press F2" would be.
     */
    shortcuts(o: { i: number }): ShortcutSource {
      const el = cands[o.i];
      if (!el) return { aria: '', access: '', texts: [] };
      const attr = (a: string) => el.getAttribute(a) ?? el.querySelector(`[${a}]`)?.getAttribute(a) ?? '';
      const texts: string[] = [];
      const add = (t: string | null | undefined) => {
        const c = (t ?? '').replace(/\s+/g, ' ').trim();
        if (c && c.length <= 300 && !texts.includes(c)) texts.push(c);
      };
      add(el.getAttribute('title'));
      add(el.getAttribute('aria-description'));
      const root = el.getRootNode() as Document | ShadowRoot;
      for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/)) if (id) add((root.getElementById?.(id) ?? document.getElementById(id))?.textContent);
      add(nameOf(el, 200));
      const around = el.parentElement;
      if (around && around !== document.body) add((around as HTMLElement).innerText ?? around.textContent);
      return { aria: attr('aria-keyshortcuts').slice(0, 120), access: attr('accesskey').slice(0, 20), texts: texts.slice(0, 5) };
    },
    /**
     * Other controls Tab can reach that may do what this control does (Understanding 2.1.1: the function
     * may be offered another way): one with the same name, or one that points at the same content — the
     * same aria-controls or target attribute, or (`ids`) the id of something the click showed, hid or
     * changed. The ones the test may press come first; at most `max`.
     */
    alternatives(o: { i: number; ids?: string[]; max: number }): Alternative[] {
      const el = cands[o.i];
      if (!el) return [];
      const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const targets = (e: Element): string[] => {
        const out: string[] = [];
        for (const a of ['aria-controls', 'data-target', 'data-bs-target', 'popovertarget', 'commandfor']) {
          for (const t of (e.getAttribute(a) ?? '').split(/\s+/)) if (t.replace(/^#/, '')) out.push(t.replace(/^#/, ''));
        }
        const href = e.matches('a, area') ? e.getAttribute('href') ?? '' : '';
        if (/^#./.test(href)) out.push(href.slice(1));
        return out;
      };
      const name = norm(nameOf(el, 120));
      const mine = new Set([...targets(el), ...(o.ids ?? [])]);
      const found: Alternative[] = [];
      for (const e of tabbablesIn(document.body ?? document.documentElement, 800, el)) {
        if (found.length >= 12) break;
        // Only a control can do the same. A frame, a media player, or an element whose role says it is content
        // (a tab's own panel, named by its tab; a region, a dialog, a heading) is none: never pressed, never compared.
        if (ours(e) || e.matches('iframe, frame, object, embed, audio, video')) continue;
        const role = roleOf(e);
        if (role && !WIDGET.has(role)) continue;
        const why = name.length >= 3 && norm(nameOf(e, 120)) === name ? 'name' : targets(e).some((t) => mine.has(t)) ? 'target' : '';
        if (!why) continue;
        found.push({ id: keep(e), path: cssPath(e), name: nameOf(e), why, refused: refusal(e) });
      }
      return [...found.filter((a) => !a.refused), ...found.filter((a) => a.refused)].slice(0, o.max);
    },
    /** A short digest of a recorded state (what is in view and says what, the form values, the address), for telling whether a press was undone. */
    digest(o: { label: string }): string {
      const sn = snaps.get(o.label);
      if (!sn) return '';
      let h = 0;
      let n = 0;
      const mix = (t: string) => { for (let k = 0; k < t.length; k++) h = (Math.imul(h, 31) + t.charCodeAt(k)) | 0; n++; };
      for (const [e, t] of sn.texts) if (!covered(noisy, e)) mix(t);
      for (const [e, v] of sn.values) if (!covered(noisy, e)) mix(v);
      mix(sn.url);
      return `${n}:${h}`;
    },
    /** The window's scroll position, and a way to put it back. */
    scroll(o: { x?: number; y?: number }): { x: number; y: number } {
      if (typeof o.x === 'number' && typeof o.y === 'number') window.scrollTo({ left: o.x, top: o.y, behavior: 'instant' as ScrollBehavior });
      return { x: Math.round(scrollX), y: Math.round(scrollY) };
    },
    /** A kept element's path and name. */
    describe(o: { id: number }): { path: string; name: string } | null {
      const el = kept[o.id];
      return el ? { path: cssPath(el), name: nameOf(el) } : null;
    },
    /** Forgets everything and stops watching. */
    drop(): void {
      observer.disconnect();
      try { (W.__grntedTimerChanges as ((on: boolean) => boolean) | undefined)?.(false); } catch { /* no hook */ }
      cands.length = 0;
      kept.length = 0;
      opened.length = 0;
      msgs.length = 0;
      snaps.clear();
      touched.clear();
      byInput.clear();
      noisy.clear();
      if (printBefore) { try { window.print = printBefore; } catch { /* leave it */ } }
      delete W[arg.key];
    },
  };
  // A press must never open the browser's print dialog.
  let printBefore: (() => void) | null = null;
  try {
    printBefore = window.print;
    window.print = () => {};
  } catch {
    printBefore = null;
  }
  try {
    Object.defineProperty(W, arg.key, { value: api, configurable: true, enumerable: false, writable: false });
  } catch {
    observer.disconnect();
    return false;
  }
  return true;
}

/** Calls a kit operation in the page. */
export function controlsKit<R>(ctx: { page: { evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> } }, op: string, a: unknown = {}): Promise<R> {
  return ctx.page.evaluate(
    (x: { key: string; op: string; a: unknown }) => {
      const k = (window as unknown as Record<string, Record<string, (a: unknown) => unknown>>)[x.key];
      if (!k || typeof k[x.op] !== 'function') throw new Error('the controls kit is not installed');
      return k[x.op]!(x.a) as R;
    },
    { key: CONTROLS_KEY, op, a },
  );
}
