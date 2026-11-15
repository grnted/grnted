// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The in-page side of the keyboard and focus probes. `installKeyboardKit` runs once per page through
// `page.evaluate` and leaves `window.__grntedKb`; the small wrappers below call it. Every function
// passed to `page.evaluate` here is self-contained (no imports, no outer variables), so a bundler
// cannot break it. The kit only reads the page, except where a method says otherwise (focus and
// blur, a scroll-behavior override while it runs, and putting the address back after a skip link).
// Engine core: no Node-only imports.
import type { GridPoint, VisibilityFacts } from './rules.js';

export interface Box { x: number; y: number; w: number; h: number }

/** What the kit measured about the focused element right after a key press. */
export interface StopFacts {
  /** Kit id of the focused element; 0 when no element has focus (focus left the page content). */
  id: number;
  /** An iframe, frame, object or embed (Tab then moves inside it). */
  frame?: boolean;
  /** A player with controls or a date/time field: Tab moves through the browser's own parts of it. */
  inner?: boolean;
  tag?: string;
  role?: string;
  name?: string;
  path?: string;
  /** Element kind: tag, type, role, classes and parent (focus indicators are measured once per kind first). */
  sig?: string;
  /**
   * How the element looks while it has keyboard focus, and the colour behind it (batch 18, D8): the focused outline,
   * shadow, border, fill, text colour and decoration, its ::before and ::after, and the nearest ancestor background.
   * Set only when the element is the focused one. Two stops of one markup kind whose focus looks different (a reset
   * scoped to the footer, a ring the colour of one band's background) are measured as two kinds.
   */
  look?: string;
  /** The nearest list, menu, navigation or other container (to group findings). */
  group?: string;
  textField?: boolean;
  box?: Box;
  /** Inside a fixed or sticky container. */
  fixed?: boolean;
  facts?: VisibilityFacts;
  /** The element's visible labels (custom checkboxes hide the input and style the label). */
  proxy?: VisibilityFacts;
  grid?: GridPoint[];
  inMain?: boolean;
  inFooter?: boolean;
  /** The innermost landmark the element is in (navigation, header, footer, aside, main, form, search, dialog), for the AI focus-order review. */
  region?: string;
  /** Text of the last heading before the element in the document (at most 60 characters), for the AI focus-order review. */
  section?: string;
  /** An input's or button's type attribute (e.g. checkbox, submit). */
  itype?: string;
  /** Path of the dialog the element is in. */
  dialog?: string;
  /** Same-page link: whether its target exists and is (in) the main landmark. */
  anchor?: { targetFound: boolean; toMain: boolean };
  /** A positive tabindex attribute (it moves the element ahead of the document order). */
  tabIndex?: number;
  /**
   * For the focus order inside one container (2.4.3, F44 and C27): the nearest form, fieldset, list, menu, toolbar,
   * tab list, radio group, navigation or table around the element (`box`, a CSS path); `moved` when CSS shows the
   * element out of its document order inside that container (a reversed flex direction, or a flex or grid `order`
   * other than 0 on it or an ancestor below the container); `rtl` on a right-to-left page. `group`: the
   * form around that container, when the container is a fieldset or a group of one form (its steps are
   * compared with each other). A form that wraps the page itself (its header, navigation or main content)
   * is no container.
   */
  ord?: { box: string; moved?: 1; rtl?: 1; dom?: number; group?: string };
  /** The page, or a scrolling region around the element, snaps its scroll position (`scroll-snap-type`). */
  snap?: true;
  /**
   * Out of the Tab order and the target of a same-page link (a skip link's target, tabindex="-1") whose place
   * is on the screen when focused: focus got there by the link, not by Tab, and the next Tab goes on into the
   * content. Its `size` (an empty marker box) is then not a 2.4.3 stop; off screen, clipped or transparent still is.
   */
  linkTarget?: true;
  /** Top-left corner of the box in page coordinates (box plus the page's scroll). */
  pageX?: number;
  pageY?: number;
  /** Since the previous measurement: focus events, elements added, elements removed, visible elements whose state attributes changed, window.open calls. */
  focusins: number;
  added: number;
  removed: number;
  semantic: number;
  opens: number;
  /**
   * Navigations the page started to another address (the Navigation API's navigate event: seen in
   * the page at once, before the request guard sees the request), and the last address.
   */
  navs: number;
  navTo?: string;
  /** No element has focus although one received it since the last measurement: a script took focus away. */
  lostFrom?: { id: number; path: string; name?: string };
  /**
   * The element the key moved focus to opened a dialog while it received focus (its own focus handlers
   * did, before the event was over) and focus is now inside that dialog: the element, and the dialog.
   * Never a dialog that was open before, or one something else opened (a timer).
   */
  openedBy?: { id: number; path: string; name?: string; dialog: string };
  /** Elements in the document now. */
  elements: number;
}

export interface FocusStyle {
  /** An outline, box-shadow or border appears (or clearly changes) on focus, on the element or its ::before/::after. */
  indicator: boolean;
  /** That indicator is cut off by a parent's overflow. */
  clipped: boolean;
  /** Computed properties that differ between focused and unfocused. */
  changed: string[];
  /** The focused outline (for the finding's detail). */
  outline: string;
  /** Area for the screenshots: the box plus the ring, inside the viewport. */
  crop: Box | null;
  /** Focus is back on the element. */
  refocused: boolean;
  /** The element's border box (viewport CSS px), focused. */
  box: Box;
  /**
   * 1.4.11: what draws the indicator. `ring`: an outline (not the browser's own `auto` style) or an
   * outer box-shadow that appears or changes on focus and reaches outside the box; `browser`: only
   * the browser's own focus ring (`outline-style: auto`); `other`: anything else.
   */
  kind: 'ring' | 'browser' | 'other';
  /** For a ring: how far outside the box it reaches (CSS px, at most 12) and, for an outline, its colour (RGB 0–255 and alpha 0–1, opacity included). */
  ring: { extent: number; color?: [number, number, number, number]; inset?: true; gap?: number } | null;
  /**
   * The element is somewhere else, or not shown, without focus (a skip link off-screen or visually hidden until it is
   * focused): the pixels its ring covers are not its unfocused look, and the element appearing is a change of its own
   * (1.4.11, batch 18 precision).
   */
  appears?: boolean;
  /** The element's box with the indicator's reach around it lies wholly inside the viewport (the pictures can see all of it). */
  ringInView: boolean;
  /** The focused border width (CSS px; 0 without a border), for a border colour change next to a ring (1.4.11). */
  borderWidth?: number;
  /**
   * Every ::before or ::after that changed on focus is drawn within 20 px of the element's box (in the flow, or
   * positioned against the element itself with small offsets): the pictures' margin sees all of it (round 2).
   */
  pseudoLocal?: boolean;
  /**
   * 1.4.11 (batch 18, round 3): the focus ring a ::before or ::after draws when nothing else draws one (`kind` is
   * `other`): positioned against the element, painting only a border, an outline or a spread shadow. Its border box
   * (viewport CSS px) and the ring's reach, inside that box (`inset`, a border or an outline pulled in) or outside it.
   */
  pseudoRing?: { box: Box; extent: number; inset?: true; color?: [number, number, number, number]; key: '::before' | '::after' };
}

/** `refocusShots`: focus is back, and the element's focused look is the one its keyboard focus had (`kept`). */
export interface Refocused { ok: boolean; kept: boolean }

export interface ClickableGroup {
  path: string;
  name?: string;
  tag: string;
  why: string;
  count: number;
  /**
   * A candidate, not a failure (2026-11-12): nothing the page itself says declares the element a control, and this
   * test presses nothing, so no effect of a click was shown. Listed as not testable, never failed and never dropped.
   * - 'element': a script listens for clicks on it (or a handler is written on it), and it has no widget role and no
   *   pointer cursor of its own (an inherited one is the wrapper's, not its);
   * - 'surface': a drawing (a canvas, an svg, an element with the image role, a wrapper whose whole content is one
   *   drawing) that listens for clicks or presses. A charting library listens on what it draws whether or not a
   *   click does anything, so no cursor, role or handler alone fails a drawing: only an effect that was shown;
   * - 'shadow': its content is in a closed shadow root (or more shadow roots than the test reads), so whether it is a
   *   drawing, or holds a control the keyboard reaches, cannot be seen (fix round 2, 2026-11-12).
   */
  listed?: 'element' | 'surface' | 'shadow';
}

export interface KeyState {
  active: number;
  activePath?: string;
  textField: boolean;
  url: string;
  sx: number;
  sy: number;
}

/** The controls of a focus cycle that could lead out of it. */
export interface TrapExits {
  /** Buttons with a dismissive name ("Close", "×", "No thanks"…): the only ones the test presses. */
  press: { id: number; name?: string; path: string }[];
  /** Links (anything with an href) and form-owned submit, reset and image buttons: never activated. */
  links: string[];
  submits: string[];
  /** Other buttons ("Accept all", "OK"…): never pressed. */
  buttons: string[];
}

export interface Counters {
  focusins: number; added: number; removed: number; semantic: number; opens: number; navs: number; navTo?: string;
  /** Where the first change since the last reading happened (the element whose children or attributes changed). */
  where?: string;
}

/**
 * Trusted key events the kit counted while it ran (Tab keydowns, Tab and Shift keyups). A count read
 * after the last key press tells the kit, in the next walk step, which keyup ends the next press.
 */
export interface KeyCounts { tabDown: number; tabUp: number; shiftUp: number }

/** A focus stop measured in the page, with the key counts at that moment. */
export interface KeyedStop { facts: StopFacts; keys: KeyCounts }

/** `focusStyle()` and whether the element was blurred for its screenshots (see `KeyboardKit.focusStyleShots`). */
export type FocusStyleShots = FocusStyle & { blurred: boolean };

export interface KitConfig {
  opaque: number;
  invisibleOpacity: number;
  /**
   * Element ids start after this number (default 0). A kit installed again after the test loaded the
   * page anew gets a base of its own, so a stop measured after the reload never shares an id with one
   * measured before it (the findings tell stops apart by id).
   */
  idBase?: number;
}

/** The kit's methods, as called from the wrappers below. */
export interface KeyboardKit {
  start(): void;
  stop(): void;
  resetStart(): void;
  topPrepare(): void;
  topFinish(): void;
  measure(): StopFacts;
  /** `measure()` with the key counts now. */
  measureKeyed(): KeyedStop;
  /** Waits until the focused element has stayed the same for HOLD_STILL_MS (at most HOLD_CAP_MS). */
  hold(): Promise<boolean>;
  /**
   * One walk step in one round trip with its key press (sent alongside it): waits until the `n`th
   * trusted keyup of `key` (the last event of the press: 'Tab', or 'Shift' for Shift+Tab), or a Tab
   * keydown that moved focus into a frame (whose keyup goes to the frame), and measures one task
   * later, as a call made right after the press would; at once when it already came. `missed`: none
   * came within `cap` ms. A newer call ends an older one as missed.
   */
  stopAfter(key: 'Tab' | 'Shift', n: number, cap: number): Promise<KeyedStop | { missed: true; keys: KeyCounts }>;
  /** The press finished but its keyup never reached this document: the waiting `stopAfter` measures now. False when none waits. */
  release(): boolean;
  remeasure(id: number): StopFacts | null;
  settle(id: number, cap: number): Promise<{ settled: boolean }>;
  /** `settle`, then `remeasure` (one round trip). */
  settleRemeasure(id: number, cap: number): Promise<{ settled: boolean; again: StopFacts | null }>;
  /** Waits `ms` in the page, then `remeasure` (one round trip). */
  waitRemeasure(id: number, ms: number): Promise<StopFacts | null>;
  /**
   * `focusStyle()`, then, when its screenshots are needed (no unclipped style indicator, or a ring whose
   * contrast is measured, with the element focused again and a crop of at least 4×4 px), the element
   * blurred for the first of them (`blurred`). Null when nothing has focus.
   */
  focusStyleShots(id: number, contrast: boolean): FocusStyleShots | null;
  /**
   * `refocus(id)` between the two screenshots; the counters are then taken again at the next key press,
   * so what the page does while the second one is taken is not counted for the next stop.
   */
  refocusShots(id: number): Refocused;
  activeId(): number;
  /** Ids of the elements that can take focus with Tab, in document order (at most `cap`). */
  tabOrder(cap: number): number[];
  /**
   * The focused element's ring (an outline or an outer shadow) shows somewhere outside `cover` (the covering element's
   * path): true when a point in the ring's band is not under it. False when there is no ring outside the box or every
   * point of its band is covered; null when the cover cannot be found.
   */
  ringClear(id: number, cover: string): boolean | null;
  /** Puts focus on the element (no scrolling), or takes it off every element with 0: the place a Tab press starts from. */
  focusBefore(id: number): boolean;
  focusStyle(): FocusStyle | null;
  blur(id: number): boolean;
  refocus(id: number): boolean;
  focusId(id: number): boolean;
  refire(id: number): { connected: boolean; opens: number; navs: number; navTo?: string };
  /** Navigations to another address the page started since the kit started (never reset). */
  navCount(): number;
  tabbables(cap: number): number;
  outside(members: number[]): number;
  trapInstructions(members: number[]): { text: string; exits: string };
  trapExits(members: number[], pattern: string, max: number): TrapExits;
  trapRegion(members: number[]): { path: string; name?: string; dialog: boolean };
  /**
   * Before a skip control (a button, not a link) is pressed: notes the address's fragment, and whether pressing it
   * would send a form (a submit button in a form: it is then never pressed).
   */
  skipArm(id: number): { sends: boolean };
  /**
   * After a skip control was pressed: its target, the element the fragment it set names or the element it put focus
   * on (never itself), kept for `skipLanding` and `skipAfter`. `found`: there is one.
   */
  skipScripted(id: number): { found: boolean; by?: 'fragment' | 'focus'; inMain?: boolean };
  skipLanding(id: number): { inTarget: boolean };
  skipAfter(id: number): { pos: 'inside' | 'after' | 'before' | 'none'; inMain: boolean; past?: boolean; nothingAfter?: boolean; targetShown?: boolean; wrapped?: boolean };
  /**
   * The links in the Tab order now in the navigation a toggle (`layout().toggleId`) is for: the navigation around
   * it or the first one after it (else the region its aria-controls names); -1: no such region. `controls`: that
   * navigation is the region its aria-controls names.
   */
  toggleLinks(id: number): { links: number; controls: boolean };
  restore(url: string): { expanded: number };
  layout(): { mainBottom?: number; footerTop?: number; hasMain: boolean; headings: number; contentFirst?: boolean; toggle?: string; toggleId?: number };
  clickables(refs: { ref: number; types: string[] }[], max: number): ClickableGroup[];
  take(): Counters;
  keyState(): KeyState;
  beforeKey(): KeyState;
  afterKey(ms: number): Promise<KeyState & Counters>;
  byPath(path: string): number;
  blurAll(): void;
  controlMatching(pattern: string, skip: readonly string[]): string | null;
  describe(id: number): { path: string; name?: string } | null;
  /** Closes a native dialog by its path (focus taken out of it, then its own close()); true when the dialog at that path is no longer in view. No key is pressed. */
  closeDialog(path: string): boolean;
  /**
   * Report v2 evidence: the element's box and the fixed or sticky element that covers most of it now
   * (viewport CSS px), the window's scroll position and the document's title. Null when the element is gone.
   */
  cover(id: number): CoverView | null;
  /**
   * Scrolls the window (instantly) so the element's middle is at the viewport's middle and waits two
   * animation frames (at most 100 ms): its box then, and whether fixed content still covers it.
   */
  center(id: number): Promise<{ box: Box; covered: boolean } | null>;
  /** Puts the window's scroll position back (instantly). */
  scrollTo(x: number, y: number): void;
}

/** What `KeyboardKit.cover` returns. */
export interface CoverView {
  box: Box;
  cover: Box | null;
  coverTag?: string;
  coverRole?: string;
  coverPosition?: string;
  sx: number;
  sy: number;
  vw: number;
  vh: number;
  title: string;
}

type KitWindow = { __grntedKb?: KeyboardKit };

/** Installs the kit (once per page). Self-contained. */
export function installKeyboardKit(cfg: KitConfig): boolean {
  const W = window as unknown as KitWindow & { __grntedTarget?: (ref: number) => unknown; __grntedClosedHost?: (el: Element) => boolean };
  if (W.__grntedKb) return true;

  // --- Element ids ------------------------------------------------------------------------------
  const ids = new WeakMap<Element, number>();
  const els: Element[] = [];
  let nextId = (cfg.idBase ?? 0) + 1;
  const idOf = (el: Element): number => {
    let i = ids.get(el);
    if (!i) {
      i = nextId++;
      ids.set(el, i);
      els[i] = el;
    }
    return i;
  };

  // --- Change counters (focusin events, DOM changes) --------------------------------------------
  let focusins = 0;
  let added = 0;
  let removed = 0;
  let opens = 0;
  let navs = 0;
  let navTotal = 0;
  let navTo: string | undefined;
  const strip = (u: string) => u.split('#')[0];
  const onNavigate = (e: Event) => {
    const dest = (e as Event & { destination?: { url?: string } }).destination?.url;
    if (dest && strip(dest) !== strip(location.href)) {
      navs++;
      navTotal++;
      navTo = dest;
    }
  };
  const navApi = (window as unknown as { navigation?: EventTarget }).navigation;
  let lastIn: Element | null = null;
  /**
   * Since the last measurement: a trusted Tab keydown was seen, and the last element that received focus
   * after it. Focus that arrived before the key (a dialog a timer opened, which took focus by itself)
   * is not what the key moved focus to, so the key leaving it is no "focus taken away".
   */
  let keySeen = false;
  let lastInAfterKey: Element | null = null;
  /** The element whose focus events are being dispatched now (from the capture listener to the last focusin listener). */
  let focusing: Element | null = null;
  /** Dialogs in view at the last measurement, and one a focus opened since (with the element that received the focus). */
  let openDialogs = new Set<Element>();
  let openedDuring: { from: Element; dialog: Element } | null = null;
  const DIALOG_SEL = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const dialogsNow = (): Element[] => deepAll(DIALOG_SEL, 200).filter((d) => rendered(d));
  const attrTargets = new Set<Element>();
  const SKIP_NODES = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'BASE']);
  const weigh = (n: Node): number => {
    if (n.nodeType !== 1) return 0;
    const e = n as Element;
    if (SKIP_NODES.has(e.tagName)) return 0;
    return 1 + Math.min(e.getElementsByTagName('*').length, 5000);
  };
  let firstTarget: Element | null = null;
  const onRecords = (list: MutationRecord[]) => {
    for (const r of list) {
      const t = r.target as Element;
      if (r.type === 'childList') {
        if (t === document.head || (t.closest && t.closest('head'))) continue;
        if (!SKIP_NODES.has(t.tagName) && rendered(t)) {
          const text = (nodes: NodeList) => [...nodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? '').join('');
          if (text(r.addedNodes) !== text(r.removedNodes)) attrTargets.add(t);
        }
        if (!firstTarget && t.nodeType === 1 && (r.addedNodes.length || r.removedNodes.length)) firstTarget = t;
        r.addedNodes.forEach((n) => { added += weigh(n); });
        r.removedNodes.forEach((n) => { removed += weigh(n); });
      } else if (t !== document.documentElement && t !== document.body && attrTargets.size < 200) {
        attrTargets.add(t);
        if (!firstTarget && t.isConnected && rendered(t)) firstTarget = t;
      }
    }
  };
  const observer = new MutationObserver(onRecords);
  // Only announcements made while focus is in the eventual trap can belong to its exit advice.
  const announcements: { focus: Element; text: string }[] = [];
  const instructionObserver = new MutationObserver((records) => {
    const focus = deepActive();
    if (!focus) return;
    for (const r of records) {
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      const live = el?.closest('[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"]');
      if (live && announcements.length < 100) announcements.push({ focus, text: live.textContent ?? '' });
    }
  });
  // 'focus' in the capture phase on the document: it runs before the element's own handlers, so a
  // handler that blurs the element at once (no focusin follows) is still seen.
  const onFocusIn = (e: Event) => {
    focusins++;
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    if (t instanceof Element) {
      lastIn = t;
      if (keySeen) lastInAfterKey = t;
      // The outermost focus being dispatched: a handler of its own that moves focus on is still inside it.
      if (!focusing) focusing = t;
    }
  };
  /**
   * Bubble phase on the window: after every focus and focusin handler of the page for this element. A
   * dialog in view now that was not before, opened while the outermost focus was being dispatched, was
   * opened by that focus.
   */
  const onFocusInLast = (e: Event) => {
    const t = (e.composedPath && e.composedPath()[0]) || e.target;
    const from = focusing;
    if (t === from) focusing = null;
    if (openedDuring || !(from instanceof Element)) return;
    for (const d of dialogsNow()) {
      if (openDialogs.has(d) || d.contains(from)) continue;
      openedDuring = { from, dialog: d };
      break;
    }
  };
  const saved: [HTMLElement, string, string][] = [];
  let instant: HTMLStyleElement | null = null;
  let running = false;
  // window.open calls while the kit runs (a popup the browser blocks still counts as an attempt).
  let openBefore: unknown = null;
  // What was open when the kit started (restore() closes what the walk opened).
  let openAtStart = new Set<Element>();
  let expandedAtStart = new Map<Element, string | null>();
  const openThings = () => deepAll('details[open], dialog[open]', 500);
  const expandables = () => deepAll('[aria-expanded]', 500);

  /** Take the counters again at the next trusted keydown (`refocusShots`). */
  let takeAtKey = false;
  /** The focused look `focusStyle` read last (while keyboard focus was on the element), for `refocusShots`. */
  let focusedSnap: { id: number; snap: string } | null = null;
  const take = () => {
    takeAtKey = false;
    onRecords(observer.takeRecords());
    let semantic = 0;
    attrTargets.forEach((t) => { if (t.isConnected && rendered(t)) semantic++; });
    let where: string | undefined;
    try { where = firstTarget && firstTarget.isConnected ? cssPath(firstTarget) : undefined; } catch { where = undefined; }
    firstTarget = null;
    const out = { focusins, added, removed, semantic, opens, navs, ...(navTo ? { navTo } : {}), ...(where ? { where } : {}) };
    focusins = 0;
    added = 0;
    removed = 0;
    opens = 0;
    navs = 0;
    navTo = undefined;
    lastIn = null;
    keySeen = false;
    lastInAfterKey = null;
    attrTargets.clear();
    return out;
  };

  // --- Geometry and style helpers -------------------------------------------------------------
  const vw = () => document.documentElement.clientWidth || innerWidth;
  const vh = () => document.documentElement.clientHeight || innerHeight;
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as ShadowRoot;
    return root && root.nodeType === 11 && (root as ShadowRoot).host ? (root as ShadowRoot).host : null;
  };
  const rendered = (el: Element): boolean => {
    const e = el as Element & { checkVisibility?: (o: object) => boolean };
    return typeof e.checkVisibility === 'function' ? e.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
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
  const rgbOf = (color: string): number[] => {
    const m = /rgba?\(([^)]+)\)/.exec(color || '');
    return m ? m[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(parseFloat) : [0, 0, 0];
  };
  const colorDiff = (a: string, b: string): number => {
    const x = rgbOf(a);
    const y = rgbOf(b);
    return Math.max(Math.abs(x[0]! - y[0]!), Math.abs(x[1]! - y[1]!), Math.abs(x[2]! - y[2]!), Math.round(Math.abs(alphaOf(a) - alphaOf(b)) * 255));
  };
  const opacityChain = (el: Element): number => {
    let o = 1;
    let cur: Element | null = el;
    for (let i = 0; cur && i < 60; i++) {
      o *= parseFloat(getComputedStyle(cur).opacity) || 0;
      if (o <= 0) return 0;
      cur = parentOf(cur);
    }
    return o;
  };
  /** The outermost fixed or sticky element containing el (el included), or null. */
  const fixedRoot = (el: Element): Element | null => {
    let found: Element | null = null;
    let cur: Element | null = el;
    for (let i = 0; cur && i < 60; i++) {
      const p = getComputedStyle(cur).position;
      if (p === 'fixed' || p === 'sticky') found = cur;
      cur = parentOf(cur);
    }
    return found;
  };
  const toBox = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const union = (a: Box | null, b: Box): Box => {
    if (!a) return b;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  };
  const intersect = (a: Box, b: Box): Box | null => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w);
    const btm = Math.min(a.y + a.h, b.y + b.h);
    return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
  };
  /** The element's box; when it is empty, the union of its visible descendants' boxes (a link around a positioned image). */
  const boxOf = (el: Element): Box => {
    if (el.tagName === 'AREA') {
      const map = el.closest('map');
      const img = map && map.getAttribute('name') ? document.querySelector(`img[usemap="#${CSS.escape(map.getAttribute('name')!)}"]`) : null;
      if (img) return toBox(img.getBoundingClientRect());
    }
    const r = toBox(el.getBoundingClientRect());
    if (r.w >= 2 && r.h >= 2) return r;
    let u: Box | null = null;
    const kids = el.querySelectorAll('*');
    for (let i = 0; i < kids.length && i < 60; i++) {
      const k = kids[i]!.getBoundingClientRect();
      if (k.width >= 2 && k.height >= 2) u = union(u, toBox(k));
    }
    return u || r;
  };
  const finishTransitions = (el: Element) => {
    const d = document as Document & { getAnimations?: () => Animation[] };
    if (typeof d.getAnimations !== 'function') return;
    let list: Animation[] = [];
    try { list = d.getAnimations(); } catch { return; }
    for (const a of list) {
      try {
        const eff = a.effect as KeyframeEffect | null;
        const t = eff && eff.target;
        if (!t || !(t === el || el.contains(t) || t.contains(el))) continue;
        const end = eff!.getComputedTiming().endTime;
        if (typeof end === 'number' && Number.isFinite(end)) a.finish();
      } catch {
        // an infinite or already finished animation
      }
    }
  };
  const isOpaque = (c: Element): boolean => {
    const cs = getComputedStyle(c);
    if (cs.visibility !== 'visible') return false;
    const replaced = /^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|EMBED)$/.test(c.tagName);
    if (!replaced && alphaOf(cs.backgroundColor) < cfg.opaque && cs.backgroundImage === 'none') return false;
    return opacityChain(c) >= cfg.opaque;
  };
  /**
   * Batch 18, round 2: a cover drawn inside a web component's open shadow root (a chat panel, a masthead): hit testing
   * from the outside returns the host, whose own box may be see-through. The opaque element inside it at this point,
   * else null (`c` itself when it is opaque).
   */
  const opaqueAt = (c: Element, x: number, y: number): Element | null => {
    if (isOpaque(c)) return c;
    const sr = c.shadowRoot;
    if (!sr) return null;
    for (const inner of sr.elementsFromPoint(x, y)) {
      if (inner === c || !sr.contains(inner)) continue;
      if (isOpaque(inner)) return inner;
    }
    return null;
  };

  // --- Names and paths --------------------------------------------------------------------------
  const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const clean = (s: string | null | undefined) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    const root = el.getRootNode() as Document | ShadowRoot;
    while (cur && cur.nodeType === 1) {
      if (cur.id && root.querySelectorAll && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) {
        parts.unshift(`#${esc(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const name = esc(cur.localName);
      if (!parent) {
        parts.unshift(name);
        break;
      }
      let n = 1;
      let only = true;
      for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === cur.localName) n++;
      if (n > 1) only = false;
      else for (let s = cur.nextElementSibling; s; s = s.nextElementSibling) if (s.localName === cur.localName) { only = false; break; }
      parts.unshift(only ? name : `${name}:nth-of-type(${n})`);
      cur = parent;
    }
    // Only a shadow root has a host: a removed link is its own root, and a link's `host` is its address's host.
    const host = root.nodeType === 11 ? (root as ShadowRoot).host : null;
    return (host ? `${cssPath(host)} >>> ` : '') + parts.join(' > ');
  };
  const nameOf = (el: Element): string | undefined => {
    const a = el.getAttribute('aria-label');
    if (a && a.trim()) return clean(a);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const s = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (s.trim()) return clean(s);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const s = Array.from(labels).map((l) => l.textContent || '').join(' ');
      if (s.trim()) return clean(s);
    }
    const tag = el.localName;
    if ((tag === 'img' || tag === 'area' || (tag === 'input' && (el as HTMLInputElement).type === 'image')) && el.getAttribute('alt')) return clean(el.getAttribute('alt'));
    if (tag === 'input' && /^(button|submit|reset)$/.test((el as HTMLInputElement).type) && (el as HTMLInputElement).value) return clean((el as HTMLInputElement).value);
    if (tag !== 'html' && tag !== 'body' && tag !== 'select') {
      const t = clean(el.textContent);
      if (t) return t;
    }
    const img = el.querySelector('img[alt]');
    if (img && img.getAttribute('alt')) return clean(img.getAttribute('alt'));
    const title = el.getAttribute('title') || el.getAttribute('placeholder');
    return title ? clean(title) : undefined;
  };
  const sigOf = (el: Element): string => {
    const cls = (e: Element | null, n: number) => (e ? Array.from(e.classList).slice(0, n).sort().join('.') : '');
    const type = el.getAttribute('type');
    const p = el.parentElement;
    return `${el.localName}${type ? `[${type}]` : ''}${el.getAttribute('role') ? `@${el.getAttribute('role')}` : ''}.${cls(el, 3)}<${p ? p.localName : ''}.${cls(p, 2)}`;
  };
  const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time)$/;
  const isTextField = (el: Element): boolean => {
    const tag = el.localName;
    if (tag === 'textarea') return true;
    if (tag === 'input') return TEXT_INPUT.test((el as HTMLInputElement).type || 'text');
    if ((el as HTMLElement).isContentEditable) return true;
    const role = el.getAttribute('role');
    return role === 'textbox' || role === 'searchbox';
  };
  /**
   * Batch 18, round 2: a text field's cursor shows focus only when it can be seen. A caret made transparent, or set to
   * the field's own fill (under 1.5:1 against it), shows nothing: such a field is judged like any other stop.
   */
  const caretShows = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    const caret = cs.caretColor;
    if (!caret || alphaOf(caret) < 0.1) return false;
    if (alphaOf(cs.backgroundColor) < 0.5) return true;
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
    };
    const [a, b] = [lum(rgbOf(caret)), lum(rgbOf(cs.backgroundColor))].sort((x, y) => y - x) as [number, number];
    return (a + 0.05) / (b + 0.05) >= 1.5;
  };
  const mainEl = () => document.querySelector('main, [role="main"]');
  /** `SKIP_LINK_NAME` (rules.ts), here for the in-page code. */
  const SKIP_NAME = /\b(skip|jump|bypass)\b|\bgo to (the )?(main )?content\b|\bmain content\b|^\s*(to )?content\s*$|zum inhalt|aller au contenu|saltar|ir al contenido|vai al contenuto|naar (de )?inhoud/i;
  /** The page's repeated regions (WCAG 2.4.1's blocks of content repeated on many pages). */
  const REPEATED_SEL = 'nav, [role="navigation"], header, [role="banner"], aside, [role="complementary"], footer, [role="contentinfo"]';
  /** Paragraphs of content: rendered text of 40 characters or more outside the repeated regions, in document order (400 looked at). */
  const contentBlocks = (): Element[] => {
    const out: Element[] = [];
    const blocks = document.querySelectorAll('p, li, blockquote, dd');
    for (let i = 0; i < blocks.length && i < 400; i++) {
      const b = blocks[i]!;
      if (!b.closest(REPEATED_SEL) && rendered(b) && clean(b.textContent).length >= 40) out.push(b);
    }
    return out;
  };
  /**
   * 2.4.1: a skip link's target is past the repeated blocks. No focus stop between the link and the start of
   * the content (the main landmark, else the first paragraph of content) comes at or after the target (a
   * target before the navigation, or a wrapper around it, skips nothing), and the target is not past the
   * content's end (an empty box after every link, from which Tab wraps to the page's start, bypasses
   * nothing). Without any content to go by, no stop in the page's navigation or header may follow the target,
   * and some stop must be at or after it (an empty box at the end is no content).
   */
  const skipPast = (link: Element, target: Element): boolean => {
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const main = mainEl();
    const m = main && rendered(main) ? main : null;
    const blocks = contentBlocks();
    const start = m ?? blocks[0] ?? null;
    const end = m ?? blocks[blocks.length - 1] ?? null;
    const stops = deepAll(FOCUSABLE_SEL, 3000).filter((e) => e !== link && e.getRootNode() === document && tabbable(e) && follows(link, e));
    const repeated = start
      ? stops.filter((e) => follows(e, start) && !start.contains(e))
      : stops.filter((e) => !!e.closest('nav, [role="navigation"], header, [role="banner"]'));
    if (repeated.some((e) => e === target || follows(target, e))) return false;
    // Without any content to go by, a target with nothing to focus at or after it is the page's end, not its content.
    if (!start && !stops.some((e) => e === target || follows(target, e))) return false;
    if (end && follows(end, target) && !end.contains(target)) return false;
    return true;
  };
  const footerOf = (el: Element): Element | null => {
    const ci = el.closest('[role="contentinfo"]');
    if (ci) return ci;
    const f = el.closest('footer');
    if (!f || f.getAttribute('role')) return null;
    return f.parentElement && f.parentElement.closest('article, aside, main, nav, section') ? null : f;
  };
  const pageFooter = (): Element | null => {
    const ci = document.querySelector('[role="contentinfo"]');
    if (ci) return ci;
    const all = document.querySelectorAll('footer:not([role])');
    for (let i = 0; i < all.length; i++) if (footerOf(all[i]!) === all[i]) return all[i]!;
    return null;
  };
  const deepActive = (): Element | null => {
    let a: Element | null = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  };
  /** Targets of skip controls (buttons), found once they were pressed (`skipScripted`), by kit id. */
  const scriptTargets = new Map<number, Element>();
  let armedHash = '';
  const anchorTarget = (a: HTMLAnchorElement): Element | null | undefined => {
    if (a.localName !== 'a' || !a.hash || !a.href) return undefined;
    if (a.origin + a.pathname + a.search !== location.origin + location.pathname + location.search) return undefined;
    let frag = a.hash.slice(1);
    try { frag = decodeURIComponent(frag); } catch { /* keep the raw fragment */ }
    // "#/path" and "#!/path" are client-side routes, not in-page targets.
    if (!frag || frag.toLowerCase() === 'top' || /^[/!]/.test(frag)) return undefined;
    return document.getElementById(frag) || document.getElementsByName(frag)[0] || null;
  };
  /** A skip link's target (its fragment's element), or a pressed skip control's (`skipScripted`); null: none. */
  const skipTargetOf = (id: number): Element | null => {
    const el = els[id];
    if (!el) return null;
    const t = anchorTarget(el as HTMLAnchorElement);
    return t === undefined ? scriptTargets.get(id) ?? null : t;
  };

  // --- Shadow roots ------------------------------------------------------------------------------
  /** querySelectorAll through open shadow roots (light DOM first), up to `cap` matches. */
  const deepAll = (selector: string, cap = 3000): Element[] => {
    const out: Element[] = [];
    const roots: (Document | ShadowRoot)[] = [document];
    for (let r = 0; r < roots.length && r < 500 && out.length < cap; r++) {
      const root = roots[r]!;
      const found = root.querySelectorAll(selector);
      for (let i = 0; i < found.length && out.length < cap; i++) out.push(found[i]!);
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const sr = (all[i] as Element).shadowRoot;
        if (sr) roots.push(sr);
      }
    }
    return out;
  };
  /**
   * Visits every element, through open shadow roots, in tree order until `visit` returns false (no
   * cap on the light DOM before the shadow roots, unlike a capped match list).
   */
  const walkAll = (visit: (el: Element) => boolean, limit = 50_000): void => {
    let seen = 0;
    const walk = (root: Document | ShadowRoot): boolean => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (++seen > limit || !visit(n as Element)) return false;
        const sr = (n as Element).shadowRoot;
        if (sr && !walk(sr)) return false;
      }
      return true;
    };
    walk(document);
  };
  const FOCUSABLE_SEL = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';
  /** a contains b, across shadow roots. */
  const deepContains = (a: Element, b: Element): boolean => {
    for (let cur: Element | null = b, i = 0; cur && i < 200; cur = parentOf(cur), i++) if (cur === a) return true;
    return false;
  };

  // --- Visibility and cover --------------------------------------------------------------------
  /**
   * The outermost absolutely positioned element around `c` (itself included) that does not hold `el`:
   * content laid over the element. Null when `c` is in the normal flow.
   */
  const overRoot = (c: Element, el: Element): Element | null => {
    let found: Element | null = null;
    for (let cur: Element | null = c, i = 0; cur && i < 60; cur = parentOf(cur), i++) {
      if (cur.contains(el)) break;
      if (getComputedStyle(cur).position === 'absolute') found = cur;
    }
    return found;
  };
  /** The outermost ancestor of `c` that does not hold `el` (the branch of the page that lies over it). */
  const flowRoot = (c: Element, el: Element): Element | null => {
    let found: Element | null = null;
    for (let cur: Element | null = c, i = 0; cur && i < 60; cur = parentOf(cur), i++) {
      if (cur.contains(el)) break;
      found = cur;
    }
    return found;
  };
  /**
   * The cover is the control's own skin: (part of) a label of it; inside a wrapper no more than two and
   * a half times the control's size (a styled check box, a button's face); or, for a form field, a
   * sibling of it (a styled select's face). Such a cover is how the control looks, not what hides it.
   */
  const skinOf = (el: Element, cover: Element): boolean => {
    const labels = (el as HTMLInputElement).labels;
    if (labels) for (let i = 0; i < labels.length && i < 4; i++) if (labels[i] === cover || labels[i]!.contains(cover) || cover.contains(labels[i]!)) return true;
    const par = el.parentElement;
    if (!par || !par.contains(cover)) return false;
    const pb = par.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    if (pb.width * pb.height <= 2.5 * Math.max(1, eb.width * eb.height)) return true;
    return /^(input|select|textarea)$/.test(el.localName) && cover.parentElement === par;
  };
  const classify = (el: Element, x: number, y: number): GridPoint => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const list = (typeof (root as Document).elementsFromPoint === 'function' ? root : document).elementsFromPoint(x, y);
    const at = list.findIndex((c) => c === el || el.contains(c));
    if (at < 0) return { k: 'm' };
    for (let i = 0; i < at; i++) {
      const c = list[i]!;
      if (c.contains(el)) continue;
      const shown = opaqueAt(c, x, y);
      if (!shown) continue;
      const fx = fixedRoot(shown);
      if (fx && !fx.contains(el)) return { k: 'f', by: cssPath(fx) };
      // Batch 18, round 2: content in the normal flow can lie over a stop too (grid items stacked in one cell, a
      // section pulled up by a negative margin): the outermost box of the covering branch, unless it is the control's
      // own skin.
      const over = overRoot(c, el) ?? flowRoot(c, el);
      return over && !skinOf(el, over) ? { k: 'p', by: cssPath(over) } : { k: 'o' };
    }
    return { k: 's' };
  };
  /**
   * The parts of the element in the viewport to hit-test: each line fragment of an element that
   * wraps (an inline link across two lines: `getClientRects()`, at most 6), else its box. The union box
   * of a wrapped inline element spans both lines at full width, so points over it land on the text
   * around the element, never on it, and the element would read as cut off.
   */
  const fragmentViews = (el: Element, box: Box): Box[] => {
    const screen = { x: 0, y: 0, w: vw(), h: vh() };
    const rects = el.tagName === 'AREA' ? [] : [...el.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2);
    const parts = rects.length > 1 ? rects.slice(0, 6).map(toBox) : [box];
    return parts.map((p) => intersect(p, screen)).filter((v): v is Box => !!v && v.w * v.h >= 1);
  };
  /**
   * The outermost opaque fixed or sticky element (not containing el) on top of el at the most points
   * of a 5×5 grid over its visible part, as `classify` finds them; null when none.
   */
  const coverOf = (el: Element, box: Box): Element | null => {
    const views = fragmentViews(el, box);
    if (!views.length) return null;
    const root = el.getRootNode() as Document | ShadowRoot;
    const src = typeof (root as Document).elementsFromPoint === 'function' ? root : document;
    const counts = new Map<Element, number>();
    for (const view of views) for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const x = view.x + ((i + 0.5) * view.w) / 5;
        const y = view.y + ((j + 0.5) * view.h) / 5;
        const list = src.elementsFromPoint(x, y);
        const at = list.findIndex((c) => c === el || el.contains(c));
        if (at < 0) continue;
        for (let k = 0; k < at; k++) {
          const c = list[k]!;
          if (c.contains(el)) continue;
          const shown = opaqueAt(c, x, y);
          if (!shown) continue;
          const fx = fixedRoot(shown);
          if (fx && !fx.contains(el)) counts.set(fx, (counts.get(fx) ?? 0) + 1);
          break;
        }
      }
    }
    let best: Element | null = null;
    let most = 0;
    for (const [c, n] of counts) if (n > most) { best = c; most = n; }
    return best;
  };
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
   * the element's visible parts (`views`, in the viewport) is not under opaque fixed or sticky content.
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
          if (c.contains(el)) continue;
          const shown = opaqueAt(c, x, y);
          if (!shown) continue;
          const fx = fixedRoot(shown);
          if (!fx || fx.contains(el)) {
            // Content laid over it (not its own skin) hides this part as fixed content does; normal-flow content too
            // (batch 18, round 2: the same rule as `classify`).
            const over = overRoot(c, el) ?? flowRoot(c, el);
            if (!over || skinOf(el, over)) return true;
          }
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
  const geometry = (el: Element) => {
    finishTransitions(el);
    const box = boxOf(el);
    const view = intersect(box, { x: 0, y: 0, w: vw(), h: vh() });
    const facts: VisibilityFacts = {
      opacity: opacityChain(el), width: box.w, height: box.h, inViewport: view ? view.w * view.h : 0,
      points: 0, hits: 0, hitTestable: getComputedStyle(el).pointerEvents !== 'none',
    };
    let grid: GridPoint[] = [];
    if (view && view.w * view.h >= 4 && facts.hitTestable) {
      // The centre of each part first (one part unless the element wraps across lines); only when no
      // centre shows the element itself, a 5×5 grid over each part.
      const parts = fragmentViews(el, box);
      const views = parts.length ? parts : [view];
      grid = views.map((v) => classify(el, v.x + v.w / 2, v.y + v.h / 2));
      if (grid.every((p) => p.k === 'f' || p.k === 'p' || p.k === 'm')) {
        grid = [];
        for (const v of views) {
          for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) grid.push(classify(el, v.x + ((i + 0.5) * v.w) / 5, v.y + ((j + 0.5) * v.h) / 5));
          }
        }
      }
      // Every point that reached it is under fixed content: check the whole area exactly before calling it hidden.
      const reached = grid.filter((p) => p.k !== 'm');
      if (reached.length && reached.every((p) => p.k === 'f' || p.k === 'p') && someShows(el, views)) grid.push({ k: 's' });
      facts.points = grid.length;
      facts.hits = grid.filter((p) => p.k !== 'm').length;
    }
    return { box, facts, grid };
  };
  const proxyFacts = (el: Element): VisibilityFacts | undefined => {
    const labels = (el as HTMLInputElement).labels;
    if (!labels || !labels.length) return undefined;
    let best: VisibilityFacts | undefined;
    for (let i = 0; i < labels.length && i < 3; i++) {
      const g = geometry(labels[i]!).facts;
      if (!best || g.inViewport > best.inViewport) best = g;
    }
    return best;
  };

  /**
   * The focused look and the colour behind it (`StopFacts.look`): properties that draw a focus indicator, on the
   * element and its ::before and ::after, and the first ancestor (across shadow roots) with a background. Short: the
   * key only groups stops, it is never reported.
   */
  const lookOf = (el: Element): string => {
    try {
      const s = getComputedStyle(el);
      const p = (ps: string) => {
        const x = getComputedStyle(el, ps);
        return !x.content || x.content === 'none' || x.content === 'normal' ? '' : [x.boxShadow, x.outlineStyle, x.outlineColor, x.borderBottomColor, x.backgroundColor, x.width, x.height].join(',');
      };
      let back = '';
      for (let a: Element | null = el, i = 0; a && i < 40; a = parentOf(a), i++) {
        const cs = getComputedStyle(a);
        if (cs.backgroundImage !== 'none') { back = 'image'; break; }
        if (alphaOf(cs.backgroundColor) >= 0.5) { back = cs.backgroundColor; break; }
      }
      return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.borderBottomWidth,
        s.backgroundColor, s.backgroundImage === 'none' ? '' : 'bgimg', s.color, s.textDecorationLine, p('::before'), p('::after')].join(';') + '@' + (back || 'none');
    } catch {
      return '';
    }
  };
  const describeStop = (el: Element, counters: Counters): StopFacts => {
    const g = geometry(el);
    const out: StopFacts = {
      id: idOf(el), tag: el.localName, path: cssPath(el), sig: sigOf(el), textField: isTextField(el) && caretShows(el),
      box: g.box, facts: g.facts, grid: g.grid, ...counters, elements: document.getElementsByTagName('*').length,
    };
    if (el === deepActive()) {
      const look = lookOf(el);
      if (look) out.look = look;
    }
    if (/^(iframe|frame|object|embed)$/.test(el.localName)) out.frame = true;
    // The browser's own controls inside the element take several Tab presses while the page sees one
    // element: a player's buttons, the parts of a date or time field.
    else if ((/^(video|audio)$/.test(el.localName) && el.hasAttribute('controls'))
      || (el.localName === 'input' && /^(date|time|datetime-local|month|week)$/.test((el as HTMLInputElement).type))) out.inner = true;
    const role = el.getAttribute('role');
    if (role) out.role = role;
    const name = nameOf(el);
    if (name) out.name = name;
    const grp = el.parentElement && el.parentElement.closest('nav, [role="navigation"], [role="menu"], [role="menubar"], ul, ol, dialog, [role="dialog"], header, footer, aside, form, section, table');
    out.group = grp ? cssPath(grp) : el.parentElement ? cssPath(el.parentElement) : out.path;
    if (fixedRoot(el)) out.fixed = true;
    const f = g.facts;
    const unseen = f.opacity <= cfg.invisibleOpacity || f.width < 2 || f.height < 2 || f.inViewport < 4 || (f.hitTestable && f.points > 0 && f.hits === 0);
    const proxy = unseen ? proxyFacts(el) : undefined;
    if (proxy) out.proxy = proxy;
    const main = mainEl();
    if (main && main.contains(el)) out.inMain = true;
    if (footerOf(el)) out.inFooter = true;
    const dlg = el.closest('dialog, [role="dialog"], [role="alertdialog"]');
    if (dlg) out.dialog = cssPath(dlg);
    // Context for the AI focus-order review (it changes no finding): the landmark and the section.
    try {
      const lm = el.closest('dialog, [role="dialog"], [role="alertdialog"], nav, [role="navigation"], header, [role="banner"], footer, [role="contentinfo"], aside, [role="complementary"], [role="search"], form, main, [role="main"]');
      if (lm) {
        const r = lm.getAttribute('role');
        const t = lm.localName;
        out.region = r === 'dialog' || r === 'alertdialog' || t === 'dialog' ? 'dialog'
          : r === 'navigation' || t === 'nav' ? 'navigation'
          : r === 'banner' || t === 'header' ? 'header'
          : r === 'contentinfo' || t === 'footer' ? 'footer'
          : r === 'complementary' || t === 'aside' ? 'aside'
          : r === 'search' ? 'search'
          : t === 'form' ? 'form' : 'main';
      }
      const hs = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
      let last: Element | undefined;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i]!;
        if (h === el || h.contains(el) || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) last = h;
        else break;
      }
      const ht = last ? (last.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
      if (ht) out.section = ht.length > 60 ? `${ht.slice(0, 59)}…` : ht;
      if (el.localName === 'input' || el.localName === 'button') {
        const ty = el.getAttribute('type');
        out.itype = (ty ?? (el.localName === 'input' ? 'text' : 'submit')).toLowerCase().slice(0, 20);
      }
    } catch {
      // Context only: a page that breaks it leaves the stop without it.
    }
    const ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti, 10) > 0) out.tabIndex = parseInt(ti, 10);
    try {
      // A form around the whole page (some site builders make one) holds everything: no container at all.
      const LANDMARKS = 'main, header, nav, footer, [role="main"], [role="banner"], [role="navigation"], [role="contentinfo"]';
      const pageWide = (f: Element | null) => !!f && f.localName === 'form' && !!f.querySelector(LANDMARKS);
      const found = el.parentElement?.closest('form, fieldset, ul, ol, menu, nav, table, [role="navigation"], [role="menu"], [role="menubar"], [role="toolbar"], [role="tablist"], [role="radiogroup"], [role="group"], [role="listbox"], [role="grid"], [role="tree"]') ?? null;
      const box = pageWide(found) ? null : found;
      if (box) {
        const ord: { box: string; moved?: 1; rtl?: 1; dom?: number; group?: string } = { box: cssPath(box) };
        // The steps of one form: fieldsets and groups of the same form are compared with each other.
        if (box.matches('fieldset, [role="group"], [role="radiogroup"]')) {
          const form = box.parentElement?.closest('form') ?? null;
          if (form && !pageWide(form)) ord.group = cssPath(form);
        }
        for (let a: Element | null = el; a && a !== box.parentElement; a = a.parentElement) {
          const st = getComputedStyle(a);
          if (/flex/.test(st.display) && /reverse/.test(st.flexDirection) && a.childElementCount > 1) { ord.moved = 1; break; }
          const p = a.parentElement;
          if (a !== box && p && /flex|grid/.test(getComputedStyle(p).display) && st.order !== '0') { ord.moved = 1; break; }
        }
        if (getComputedStyle(box).direction === 'rtl') ord.rtl = 1;
        // Its place in the document order (light DOM only; absent in a shadow root).
        const dom = Array.prototype.indexOf.call(document.getElementsByTagName('*'), el) as number;
        if (dom >= 0) ord.dom = dom;
        out.ord = ord;
      }
    } catch {
      // Order facts only: a page that breaks them leaves the stop without them.
    }
    try {
      const snaps = (x: Element | null) => !!x && !/^none\b/.test(getComputedStyle(x).scrollSnapType || 'none');
      let snap = snaps(document.documentElement) || snaps(document.body);
      for (let a = el.parentElement, k = 0; !snap && a && a !== document.body && k < 40; a = a.parentElement, k++) {
        const st = getComputedStyle(a);
        if (/(auto|scroll)/.test(`${st.overflowX} ${st.overflowY}`) && snaps(a)) snap = true;
      }
      // Only an element inside the part of the page scrolling can reach: one parked off the page is hidden, not snapped away.
      const r = el.getBoundingClientRect();
      const de = document.documentElement;
      const x = r.left + scrollX;
      const y = r.top + scrollY;
      if (snap && r.width > 0 && r.height > 0 && x + r.width > 0 && y + r.height > 0 && x < de.scrollWidth && y < de.scrollHeight) out.snap = true;
    } catch {
      // As above.
    }
    // A skip link's target marks a place in the content: it counts as shown when that place is on the screen
    // (an empty marker box at the start of the content), never when the target is off screen or transparent.
    const atSpot = () => {
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || innerWidth;
      return r.top >= -1 && r.top <= innerHeight && r.left >= -1 && r.left <= vw && Number(getComputedStyle(el).opacity) > 0.1;
    };
    if (!tabbable(el) && el.id && atSpot()) {
      const links = document.querySelectorAll('a[href*="#"]');
      for (let i = 0; i < links.length && i < 500; i++) {
        const a = links[i] as HTMLAnchorElement;
        // Only a skip link's target (its name says skip, jump, bypass or main content: `SKIP_LINK_NAME` in rules.ts),
        // never any in-page link's (Grok round 2).
        if (a.hash && a.hash.slice(1) === el.id && anchorTarget(a) === el && SKIP_NAME.test(clean(nameOf(a)))) { out.linkTarget = true; break; }
      }
    }
    out.pageX = g.box.x + scrollX;
    out.pageY = g.box.y + scrollY;
    const target = anchorTarget(el as HTMLAnchorElement);
    if (target !== undefined) out.anchor = { targetFound: !!target, toMain: !!(target && main && (target === main || main.contains(target) || target.contains(main))) };
    return out;
  };

  // --- Focus styles (2.4.7) ---------------------------------------------------------------------
  const styleSnap = (el: Element): Record<string, string> => {
    const s = getComputedStyle(el);
    const pseudo = (p: string) => {
      const x = getComputedStyle(el, p);
      return [x.content, x.display, x.backgroundColor, x.backgroundImage, x.borderTopColor, x.borderBottomColor, x.borderTopWidth, x.borderBottomWidth,
        x.boxShadow, x.outlineStyle, x.outlineColor, x.opacity, x.transform, x.width, x.height].join('|');
    };
    const around = (e: Element | null) => {
      if (!e) return '';
      const x = getComputedStyle(e);
      return [x.outlineStyle, x.outlineWidth, x.outlineColor, x.boxShadow, x.backgroundColor, x.borderTopColor, x.borderBottomColor, x.borderLeftColor].join('|');
    };
    return {
      outline: [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset].join(' '),
      'box-shadow': s.boxShadow,
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderTopStyle, s.borderRightStyle, s.borderBottomStyle,
        s.borderLeftStyle, s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].join(' '),
      background: `${s.backgroundColor} ${s.backgroundImage}`,
      color: s.color,
      'text-decoration': `${s.textDecorationLine} ${s.textDecorationColor} ${s.textDecorationThickness} ${s.textDecorationStyle}`,
      opacity: s.opacity,
      transform: s.transform,
      filter: s.filter,
      'font-weight': s.fontWeight,
      '::before': pseudo('::before'),
      '::after': pseudo('::after'),
      parent: around(ancestorsOf(el)[0] ?? null),
      grandparent: around(ancestorsOf(el)[1] ?? null),
      ancestor3: around(ancestorsOf(el)[2] ?? null),
      ancestor4: around(ancestorsOf(el)[3] ?? null),
    };
  };
  /** Up to four ancestors (across shadow roots), body and html excluded. */
  const ancestorsOf = (el: Element): Element[] => {
    const out: Element[] = [];
    for (let a = parentOf(el); a && a !== document.body && a !== document.documentElement && out.length < 4; a = parentOf(a)) out.push(a);
    return out;
  };
  /** A ::before or ::after drawn as a ring: an outline, a visible box-shadow or a border. */
  const pseudoRing = (el: Element, p: string): boolean => {
    const x = getComputedStyle(el, p);
    if (!x.content || x.content === 'none' || x.content === 'normal' || x.display === 'none') return false;
    const outline = x.outlineStyle !== 'none' && (parseFloat(x.outlineWidth) || 0) >= 1 && alphaOf(x.outlineColor) >= 0.5;
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => {
      const st = x as unknown as Record<string, string>;
      return (parseFloat(st[`border${side}Width`] ?? '') || 0) >= 1 && st[`border${side}Style`] !== 'none' && alphaOf(st[`border${side}Color`] ?? '') >= 0.5;
    });
    return outline || border || shadowVisible(x.boxShadow);
  };
  const pxList = (s: string) => (s.match(/-?\d+(\.\d+)?px/g) || []).map((v) => Math.abs(parseFloat(v)));
  const shadowExtent = (s: string) => (s === 'none' ? 0 : s.split(/,(?![^(]*\))/).reduce((m, part) => Math.max(m, pxList(part).reduce((a, b) => a + b, 0)), 0));
  const shadowVisible = (s: string) => s !== 'none' && s.split(/,(?![^(]*\))/).some((part) => {
    const m = /rgba?\([^)]*\)/.exec(part);
    return (m ? alphaOf(m[0]) >= 0.5 : true) && pxList(part).some((v) => v > 0);
  });
  const clippedBy = (el: Element, ring: Box): boolean => {
    if (getComputedStyle(el).position === 'fixed') return false;
    let cur = parentOf(el);
    for (let i = 0; cur && i < 60 && cur !== document.body && cur !== document.documentElement; i++) {
      const cs = getComputedStyle(cur);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const r = cur.getBoundingClientRect();
        const pad = { x: r.left + cur.clientLeft, y: r.top + cur.clientTop, w: cur.clientWidth || r.width, h: cur.clientHeight || r.height };
        if (ring.x < pad.x - 0.5 || ring.y < pad.y - 0.5 || ring.x + ring.w > pad.x + pad.w + 0.5 || ring.y + ring.h > pad.y + pad.h + 0.5) return true;
      }
      if (cs.position === 'fixed') break;
      cur = parentOf(cur);
    }
    return false;
  };

  // --- Key presses the walk waits for (stopAfter) ----------------------------------------------
  const keys: KeyCounts = { tabDown: 0, tabUp: 0, shiftUp: 0 };
  const counts = (): KeyCounts => ({ tabDown: keys.tabDown, tabUp: keys.tabUp, shiftUp: keys.shiftUp });
  type Waiter = { key: 'Tab' | 'Shift'; n: number; done: (v: KeyedStop | { missed: true; keys: KeyCounts }) => void; fail: (e: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined };
  let waiting: Waiter | null = null;
  const reached = (w: Waiter) => (w.key === 'Tab' ? keys.tabUp : keys.shiftUp) >= w.n;
  // A stop is recorded once focus has stayed put (2026-11-07, simulation lab: a trap that takes focus back
  // 60 ms after Tab was never seen): the focused element is polled every HOLD_POLL_MS after the key until it
  // has not changed for HOLD_STILL_MS, at most HOLD_CAP_MS, on every stop of every page. Polling sees every way a
  // page moves focus again (a timer, a nested timer, a frame callback, an interval with no listener at all, a timer
  // function the page saved before the test began), and costs nothing extra on pages that start timers and cancel
  // them (a debounce on keydown). The walk's budget grows by HOLD_STILL_MS per stop (`FOCUS_STILL_MS`).
  const HOLD_POLL_MS = 20;
  const HOLD_STILL_MS = 100;
  const HOLD_CAP_MS = 400;
  const nativeTimeout: (fn: () => void, ms: number) => unknown = window.setTimeout.bind(window);
  /** Calls `done` once the focused element has stayed the same for HOLD_STILL_MS (at most HOLD_CAP_MS). */
  const whenStill = (done: () => void) => {
    const t0 = performance.now();
    let last = deepActive();
    let since = t0;
    const tick = () => {
      const now = performance.now();
      const a = deepActive();
      if (a !== last) { last = a; since = now; }
      if (now - since >= HOLD_STILL_MS || now - t0 >= HOLD_CAP_MS) { done(); return; }
      nativeTimeout(tick, HOLD_POLL_MS);
    };
    nativeTimeout(tick, HOLD_POLL_MS);
  };
  const finish = (w: Waiter) => {
    if (waiting !== w) return;
    waiting = null;
    if (w.timer !== undefined) clearTimeout(w.timer);
    whenStill(() => {
      try {
        w.done({ facts: kit.measure(), keys: counts() });
      } catch (e) {
        w.fail(e);
      }
    });
  };
  // One task after the event: the page's own handlers for it (and what they queued at once) run first.
  const later = (w: Waiter, check?: () => boolean) => setTimeout(() => { if (waiting === w && (!check || check())) finish(w); }, 0);
  // After the keyup the waiter counts: what a press followed by a separate measurement sees. The page's
  // own keyup handlers run after the capture listener that counts the key, and the timers they queue
  // (setTimeout(0)) come before a task queued from the bubble-phase listener, which runs last; then one
  // animation frame (capped: a frame that never comes must not hold the walk). A page that stops the
  // keyup's propagation never reaches the bubble listener: two tasks after the capture listener stand in.
  const FRAME_CAP_MS = 50;
  const afterFrame = (fn: () => void) => {
    let done = false;
    const go = () => { if (!done) { done = true; fn(); } };
    const timer = nativeTimeout(go, FRAME_CAP_MS) as ReturnType<typeof setTimeout>;
    try {
      requestAnimationFrame(() => { clearTimeout(timer); go(); });
    } catch {
      // no animation frames here: the timer measures
    }
  };
  let keyupPending: Waiter | null = null;
  const settle = (w: Waiter) => {
    if (keyupPending !== w) return;
    keyupPending = null;
    setTimeout(() => afterFrame(() => { if (waiting === w) finish(w); }), 0);
  };
  const afterKeyup = (w: Waiter) => {
    keyupPending = w;
    setTimeout(() => setTimeout(() => settle(w), 0), 0);
  };
  const inFrame = () => {
    const a = deepActive();
    return !!a && /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(a.tagName);
  };
  const onKeyDown = (e: Event) => {
    if (!e.isTrusted) return;
    if (takeAtKey) take();
    if ((e as KeyboardEvent).key !== 'Tab') return;
    keys.tabDown++;
    keySeen = true;
    lastInAfterKey = null;
    // Focus moved into a frame: the keyup goes to the frame's document, never to this one.
    if (waiting) later(waiting, inFrame);
  };
  const onKeyUp = (e: Event) => {
    if (!e.isTrusted) return;
    const k = (e as KeyboardEvent).key;
    if (k === 'Tab') keys.tabUp++;
    else if (k === 'Shift') keys.shiftUp++;
    else return;
    if (waiting && reached(waiting)) afterKeyup(waiting);
  };
  /** Bubble phase on the window: after every handler of the page for this keyup. */
  const onKeyUpLast = (e: Event) => {
    if (!e.isTrusted || !keyupPending) return;
    settle(keyupPending);
  };

  const kit: KeyboardKit = {
    start() {
      if (running) return;
      running = true;
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        saved.push([el, el.style.getPropertyValue('scroll-behavior'), el.style.getPropertyPriority('scroll-behavior')]);
        el.style.setProperty('scroll-behavior', 'auto', 'important');
      }
      // Instant scrolling in every scroll container too (smooth scrolling would be measured mid-way).
      instant = document.createElement('style');
      instant.setAttribute('data-grnted-kb', '');
      instant.textContent = '*, *::before, *::after { scroll-behavior: auto !important; }';
      (document.head || document.documentElement).appendChild(instant);
      openAtStart = new Set(openThings());
      expandedAtStart = new Map(expandables().map((e) => [e, e.getAttribute('aria-expanded')]));
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden', 'aria-expanded'] });
      announcements.length = 0;
      const instructionOptions = { childList: true, characterData: true, subtree: true };
      instructionObserver.observe(document.documentElement, instructionOptions);
      walkAll((el) => { if (el.shadowRoot) instructionObserver.observe(el.shadowRoot, instructionOptions); return true; });
      document.addEventListener('focus', onFocusIn, true);
      window.addEventListener('focusin', onFocusInLast, false);
      openDialogs = new Set(dialogsNow());
      openedDuring = null;
      focusing = null;
      // Removed by stop(), before another probe reads the page's own key handlers.
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('keyup', onKeyUpLast, false);
      if (navApi && typeof navApi.addEventListener === 'function') navApi.addEventListener('navigate', onNavigate);
      const orig = window.open;
      if (typeof orig === 'function') {
        openBefore = orig;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          opens++;
          return (orig as (...a: unknown[]) => unknown).apply(this, args);
        };
        try { Object.defineProperty(wrapped, 'name', { value: 'open' }); } catch { /* keep the name */ }
        try { window.open = wrapped as typeof window.open; } catch { openBefore = null; }
      }
      take();
    },
    stop() {
      if (!running) return;
      running = false;
      observer.disconnect();
      instructionObserver.disconnect();
      document.removeEventListener('focus', onFocusIn, true);
      window.removeEventListener('focusin', onFocusInLast, false);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('keyup', onKeyUpLast, false);
      keyupPending = null;
      if (waiting) {
        const w = waiting;
        waiting = null;
        if (w.timer !== undefined) clearTimeout(w.timer);
        w.done({ missed: true, keys: counts() });
      }
      if (navApi && typeof navApi.removeEventListener === 'function') navApi.removeEventListener('navigate', onNavigate);
      if (openBefore) {
        try { window.open = openBefore as typeof window.open; } catch { /* leave it */ }
        openBefore = null;
      }
      for (const [el, v, p] of saved.splice(0)) {
        if (v) el.style.setProperty('scroll-behavior', v, p);
        else el.style.removeProperty('scroll-behavior');
      }
      instant?.remove();
      instant = null;
    },
    settle(id, cap) {
      // Scrolling still going on (a script sliding the page, say): wait until the window, the element
      // and its scroll containers stay put for two animation frames, at most `cap` ms.
      const el = els[id];
      if (!el || !el.isConnected) return Promise.resolve({ settled: true });
      const scrollers: Element[] = [];
      for (let a = parentOf(el); a && scrollers.length < 10; a = parentOf(a)) if (a.scrollHeight > a.clientHeight || a.scrollWidth > a.clientWidth) scrollers.push(a);
      const snap = () => {
        const r = el.getBoundingClientRect();
        return [scrollX, scrollY, r.left, r.top, ...scrollers.flatMap((s) => [s.scrollLeft, s.scrollTop])].join(',');
      };
      const t0 = performance.now();
      return new Promise((resolve) => {
        let last = snap();
        let same = 0;
        const tick = () => {
          const now = snap();
          same = now === last ? same + 1 : 0;
          last = now;
          if (same >= 2) resolve({ settled: true });
          else if (performance.now() - t0 > cap) resolve({ settled: false });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    resetStart() {
      // Focusing the body (briefly focusable) moves the sequential focus starting point to the top:
      // the next Tab goes to the first element, Shift+Tab to the last.
      const b = document.body;
      if (!b) return;
      const had = b.getAttribute('tabindex');
      b.tabIndex = -1;
      b.focus({ preventScroll: true });
      if (had === null) b.removeAttribute('tabindex');
      else b.setAttribute('tabindex', had);
      take();
    },
    // Tab from a fresh page starts at the top of the sequential focus order, positive tabindex
    // first; Tab from the body (resetStart) skips positive tabindex. To start like a fresh page:
    // focus a temporary last element, press Tab (focus leaves the document), remove it.
    topPrepare() {
      const b = document.body;
      if (!b) return;
      const t = document.createElement('span');
      t.setAttribute('data-grnted-start', '');
      t.tabIndex = 0;
      t.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      b.appendChild(t);
      t.focus({ preventScroll: true });
    },
    topFinish() {
      const t = document.querySelector('[data-grnted-start]');
      const a = deepActive();
      if (t) t.remove();
      if (a && a !== t) (a as HTMLElement).blur();
      take();
    },
    measure() {
      // What received focus since the key was pressed (when the key was seen here; inside a frame it is not).
      const last = keySeen ? lastInAfterKey : lastIn;
      const counters = take();
      const el = deepActive();
      const od = openedDuring;
      openedDuring = null;
      focusing = null;
      openDialogs = new Set(dialogsNow());
      if (el && od && od.from.isConnected && od.dialog.isConnected && deepContains(od.dialog, el) && !deepContains(od.dialog, od.from)) {
        const out = describeStop(el, counters);
        const name = nameOf(od.from);
        out.openedBy = { id: idOf(od.from), path: cssPath(od.from), ...(name ? { name } : {}), dialog: cssPath(od.dialog) };
        return out;
      }
      if (!el) {
        const out: StopFacts = { id: 0, ...counters, elements: document.getElementsByTagName('*').length };
        if (counters.focusins > 0 && last && last !== document.body && last !== document.documentElement) {
          const name = nameOf(last);
          out.lostFrom = { id: idOf(last), path: cssPath(last), ...(name ? { name } : {}) };
        }
        return out;
      }
      return describeStop(el, counters);
    },
    measureKeyed() {
      return { facts: kit.measure(), keys: counts() };
    },
    hold() {
      // After a key press outside a walk step (the trap's ways out): until the focused element stays put.
      return new Promise((resolve) => whenStill(() => resolve(true)));
    },
    stopAfter(key, n, cap) {
      return new Promise((resolve, reject) => {
        const old = waiting;
        if (old) {
          waiting = null;
          if (old.timer !== undefined) clearTimeout(old.timer);
          old.done({ missed: true, keys: counts() });
        }
        const w: Waiter = { key, n, done: resolve, fail: reject, timer: undefined };
        waiting = w;
        w.timer = setTimeout(() => {
          if (waiting !== w) return;
          waiting = null;
          resolve({ missed: true, keys: counts() });
        }, cap);
        if (reached(w)) later(w);
      });
    },
    release() {
      const w = waiting;
      if (!w) return false;
      finish(w);
      return true;
    },
    remeasure(id) {
      const el = els[id];
      if (!el || !el.isConnected) return null;
      return describeStop(el, { focusins: 0, added: 0, removed: 0, semantic: 0, opens: 0, navs: 0 });
    },
    async settleRemeasure(id, cap) {
      const s = await kit.settle(id, cap);
      return { settled: s.settled, again: kit.remeasure(id) };
    },
    waitRemeasure(id, ms) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(kit.remeasure(id));
          } catch (e) {
            reject(e);
          }
        }, ms);
      });
    },
    focusStyleShots(id, contrast) {
      const st = kit.focusStyle();
      if (!st) return null;
      // Pictures for every indicator (batch 18, D7): an indicator the styles draw must also change pixels, or it is drawn
      // in the colour behind it or covered. The same two pictures serve a ring whose contrast is measured.
      void contrast;
      const shots = st.refocused && !!st.crop && st.crop.w >= 4 && st.crop.h >= 4;
      return { ...st, blurred: shots && kit.blur(id) };
    },
    refocusShots(id) {
      const ok = kit.refocus(id);
      takeAtKey = true;
      // A focus look a script gives only for keyboard focus may not come back for focus set from script: the focused
      // picture then shows another look, and an indicator missing from it proves nothing (`kept: false`).
      const el = els[id];
      const kept = ok && !!el && focusedSnap !== null && focusedSnap.id === id && JSON.stringify(styleSnap(el)) === focusedSnap.snap;
      return { ok, kept };
    },
    ringClear(id, cover) {
      const el = els[id];
      if (!el || !el.isConnected) return null;
      let over: Element | null = null;
      try {
        over = document.querySelector(cover);
      } catch {
        over = null;
      }
      if (!over) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && cs.outlineStyle !== 'hidden' && (parseFloat(cs.outlineWidth) || 0) > 0 && alphaOf(cs.outlineColor) > 0.1
        ? (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0) : 0;
      const extent = Math.max(outline, shadowExtent(cs.boxShadow));
      if (extent <= 0.5) return false;
      const r = el.getBoundingClientRect();
      const d = Math.max(1, extent / 2);
      const pts: [number, number][] = [];
      for (const f of [0.15, 0.5, 0.85]) {
        pts.push([r.left + r.width * f, r.top - d], [r.left + r.width * f, r.bottom + d], [r.left - d, r.top + r.height * f], [r.right + d, r.top + r.height * f]);
      }
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x >= vw() || y >= vh()) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && !over.contains(hit) && hit !== over) return true;
      }
      return false;
    },
    tabOrder(cap) {
      const out: number[] = [];
      walkAll((e) => {
        if (e.matches(FOCUSABLE_SEL) && tabbable(e)) out.push(idOf(e));
        return out.length < cap;
      });
      return out;
    },
    focusBefore(id) {
      if (!id) {
        const a = deepActive();
        if (a) (a as HTMLElement).blur();
        return true;
      }
      const el = els[id];
      if (!el || !el.isConnected) return false;
      (el as HTMLElement).focus({ preventScroll: true });
      return deepActive() === el;
    },
    activeId() {
      const el = deepActive();
      return el ? idOf(el) : 0;
    },
    focusStyle() {
      const el = deepActive();
      if (!el) return null;
      finishTransitions(el);
      const f = styleSnap(el);
      focusedSnap = { id: idOf(el), snap: JSON.stringify(f) };
      const fs = getComputedStyle(el);
      const focused = {
        outlineStyle: fs.outlineStyle, outlineWidth: parseFloat(fs.outlineWidth) || 0, outlineColor: fs.outlineColor,
        outlineOffset: parseFloat(fs.outlineOffset) || 0, shadow: fs.boxShadow,
        borderWidth: Math.max(parseFloat(fs.borderTopWidth) || 0, parseFloat(fs.borderBottomWidth) || 0, parseFloat(fs.borderLeftWidth) || 0, parseFloat(fs.borderRightWidth) || 0),
        borderColor: fs.borderBottomColor, borderStyle: fs.borderBottomStyle,
      };
      const ringsFocused = ['::before', '::after'].filter((p) => pseudoRing(el, p));
      const boxFocused = boxOf(el);
      const clipFocused = `${fs.clipPath}|${fs.clip}`;
      (el as HTMLElement).blur();
      finishTransitions(el);
      const u = styleSnap(el);
      // Where it is and whether it shows without focus (a skip link moved off-screen, clipped to a pixel, faded out).
      const boxUnfocused = boxOf(el);
      const ucs = getComputedStyle(el);
      const shownUnfocused = opacityChain(el) > 0.1 && ucs.visibility !== 'hidden' && boxUnfocused.w >= 2 && boxUnfocused.h >= 2;
      const appears = !shownUnfocused || `${ucs.clipPath}|${ucs.clip}` !== clipFocused
        || Math.abs(boxUnfocused.x - boxFocused.x) > 4 || Math.abs(boxUnfocused.y - boxFocused.y) > 4
        || Math.abs(boxUnfocused.w - boxFocused.w) > 4 || Math.abs(boxUnfocused.h - boxFocused.h) > 4;
      const ringsUnfocused = ['::before', '::after'].filter((p) => pseudoRing(el, p));
      const us = getComputedStyle(el);
      const unfocused = {
        outlineStyle: us.outlineStyle, outlineWidth: parseFloat(us.outlineWidth) || 0, outlineColor: us.outlineColor,
        borderWidth: Math.max(parseFloat(us.borderTopWidth) || 0, parseFloat(us.borderBottomWidth) || 0, parseFloat(us.borderLeftWidth) || 0, parseFloat(us.borderRightWidth) || 0),
        borderColor: us.borderBottomColor, shadow: us.boxShadow,
      };
      (el as HTMLElement).focus({ preventScroll: true });
      finishTransitions(el);
      const refocused = deepActive() === el;
      take();

      const changed = Object.keys(f).filter((k) => f[k] !== u[k]);
      const outlineOn = (o: { outlineStyle: string; outlineWidth: number; outlineColor: string }) =>
        o.outlineStyle !== 'none' && o.outlineStyle !== 'hidden' && o.outlineWidth >= 1 && alphaOf(o.outlineColor) >= 0.5;
      const outlineInd = outlineOn(focused) && (!outlineOn(unfocused) || colorDiff(focused.outlineColor, unfocused.outlineColor) >= 48 || focused.outlineWidth >= unfocused.outlineWidth + 1);
      const shadowInd = changed.includes('box-shadow') && shadowVisible(focused.shadow) && !shadowVisible(unfocused.shadow);
      const borderInd = changed.includes('border') && focused.borderWidth >= 1 && focused.borderStyle !== 'none' && alphaOf(focused.borderColor) >= 0.5
        && (focused.borderWidth >= unfocused.borderWidth + 1 || colorDiff(focused.borderColor, unfocused.borderColor) >= 48);
      const pseudoInd = ringsFocused.some((p) => changed.includes(p) && !ringsUnfocused.includes(p));
      const indicator = outlineInd || shadowInd || borderInd || pseudoInd;
      // 1.4.11: a ring outside the element (any alpha: a faint ring is what the contrast test is for).
      // A shadow is a ring when it has a positive spread (Chromium writes "colour x y blur spread"); a
      // drop shadow for elevation (no spread, or a negative one) is not.
      const spreadOf = (part: string) => parseFloat((part.match(/-?\d+(\.\d+)?px/g) || [])[3] ?? '0') || 0;
      const outerShadow = (sh: string) => (sh === 'none' ? 0 : sh.split(/,(?![^(]*\))/).filter((part) => !/\binset\b/.test(part) && spreadOf(part) >= 1)
        .reduce((mx, part) => Math.max(mx, pxList(part).reduce((a, b) => a + b, 0)), 0));
      const outlineAny = focused.outlineStyle !== 'none' && focused.outlineStyle !== 'hidden' && focused.outlineWidth >= 1 && alphaOf(focused.outlineColor) > 0;
      const ringOutline = changed.includes('outline') && outlineAny && focused.outlineStyle !== 'auto' && focused.outlineOffset + focused.outlineWidth > 0;
      const ringShadow = changed.includes('box-shadow') && outerShadow(focused.shadow) > 0;
      // Batch 18 (V44): a ring drawn inside the box by an inset shadow with a spread (not an outline, not an outer ring).
      const innerShadow = (sh: string) => (sh === 'none' ? 0 : sh.split(/,(?![^(]*\))/).filter((part) => /\binset\b/.test(part) && spreadOf(part) >= 1)
        .reduce((mx, part) => Math.max(mx, spreadOf(part)), 0));
      // Batch 18, round 2: an outline pulled inside the box (a negative offset at least its width) is an inset ring too.
      const outlineInside = changed.includes('outline') && outlineAny && focused.outlineStyle !== 'auto' && focused.outlineOffset + focused.outlineWidth <= 0;
      const ringInset = !ringOutline && !ringShadow && ((changed.includes('box-shadow') && innerShadow(focused.shadow) > 0 && innerShadow(unfocused.shadow) === 0) || outlineInside);
      const browserRing = changed.includes('outline') && focused.outlineStyle === 'auto' && !shadowInd && !borderInd && !pseudoInd;
      const kind: FocusStyle['kind'] = ringOutline || ringShadow || ringInset ? 'ring' : browserRing ? 'browser' : 'other';
      const ringExtent = Math.min(12, Math.max(ringOutline ? focused.outlineOffset + focused.outlineWidth : 0, ringShadow ? outerShadow(focused.shadow) : 0));
      const ringColor: [number, number, number, number] | undefined = ringOutline && /^rgba?\(/.test(focused.outlineColor)
        ? [...rgbOf(focused.outlineColor).slice(0, 3), alphaOf(focused.outlineColor) * opacityChain(el)] as [number, number, number, number] : undefined;
      const extent = Math.min(12, Math.max(outlineOn(focused) ? focused.outlineOffset + focused.outlineWidth : 0, shadowExtent(focused.shadow), 0));
      const box = boxOf(el);
      // Batch 18, round 3 (V44): a ring a pseudo-element draws over or around the element, measured like the element's
      // own ring. Only one pseudo-element that appears on focus, positioned against the element (no transform), with
      // no fill and exactly one of a border, an outline or a spread shadow: anything else stays unmeasured.
      const pseudoRingOf = (): FocusStyle['pseudoRing'] => {
        if (kind !== 'other' || getComputedStyle(el).position === 'static') return undefined;
        const fresh = ringsFocused.filter((p) => changed.includes(p) && !ringsUnfocused.includes(p));
        if (fresh.length !== 1) return undefined;
        const key = fresh[0] as '::before' | '::after';
        const ps = getComputedStyle(el, key);
        const st = ps as unknown as Record<string, string>;
        if (ps.position !== 'absolute' || (ps.transform !== 'none' && ps.transform !== '')) return undefined;
        if (alphaOf(ps.backgroundColor) > 0.05 || ps.backgroundImage !== 'none' || (ps.filter !== 'none' && ps.filter !== '')) return undefined;
        const num = (v: string | undefined) => (v && /px$/.test(v) ? parseFloat(v) : NaN);
        const [l, t, w, h] = [num(ps.left), num(ps.top), num(ps.width), num(ps.height)];
        if (![l, t, w, h].every(Number.isFinite) || w < 4 || h < 4) return undefined;
        const sides = ['Top', 'Right', 'Bottom', 'Left'];
        const bw = (x: Record<string, string>, side: string) => (x[`border${side}Style`] !== 'none' ? num(x[`border${side}Width`]) || 0 : 0);
        const pad = (side: string) => num(st[`padding${side}`]) || 0;
        const W = ps.boxSizing === 'border-box' ? w : w + pad('Left') + pad('Right') + bw(st, 'Left') + bw(st, 'Right');
        const H = ps.boxSizing === 'border-box' ? h : h + pad('Top') + pad('Bottom') + bw(st, 'Top') + bw(st, 'Bottom');
        const es = getComputedStyle(el) as unknown as Record<string, string>;
        const pbox: Box = { x: box.x + bw(es, 'Left') + l, y: box.y + bw(es, 'Top') + t, w: W, h: H };
        const widths = sides.map((side) => bw(st, side));
        const colours = sides.map((side) => st[`border${side}Color`] ?? '');
        const borderOn = Math.min(...widths) >= 1 && colours.every((c) => c === colours[0]) && alphaOf(colours[0]!) > 0;
        const ow = num(ps.outlineWidth) || 0;
        const outlineOn = ps.outlineStyle !== 'none' && ps.outlineStyle !== 'hidden' && ps.outlineStyle !== 'auto' && ow >= 1 && alphaOf(ps.outlineColor) > 0;
        const shadowOn = ps.boxShadow !== 'none' && ps.boxShadow !== '';
        const spread = outerShadow(ps.boxShadow);
        if ([borderOn, outlineOn, shadowOn].filter(Boolean).length !== 1 || (shadowOn && spread <= 0)) return undefined;
        const colourOf = (c: string): [number, number, number, number] | undefined =>
          (/^rgba?\(/.test(c) ? [...rgbOf(c).slice(0, 3), alphaOf(c) * opacityChain(el) * (Number.isFinite(parseFloat(ps.opacity)) ? parseFloat(ps.opacity) : 1)] as [number, number, number, number] : undefined);
        const off = num(ps.outlineOffset) || 0;
        if (borderOn) return { box: pbox, extent: Math.min(12, Math.max(...widths)), inset: true, key, ...(colourOf(colours[0]!) ? { color: colourOf(colours[0]!)! } : {}) };
        if (outlineOn) {
          return off + ow <= 0
            ? { box: pbox, extent: Math.min(12, -off), inset: true, key }
            : { box: pbox, extent: Math.min(12, off + ow), key, ...(colourOf(ps.outlineColor) ? { color: colourOf(ps.outlineColor)! } : {}) };
        }
        return { box: pbox, extent: Math.min(12, spread), key };
      };
      const pseudoRingFound = pseudoRingOf();
      const proxyLabels = (el as HTMLInputElement).labels;
      let area = box;
      if ((box.w < 2 || box.h < 2 || opacityChain(el) <= cfg.invisibleOpacity) && proxyLabels && proxyLabels.length) {
        for (let i = 0; i < proxyLabels.length && i < 3; i++) area = union(area, boxOf(proxyLabels[i]!));
      }
      // A ring or highlight drawn on an ancestor (:focus-within) lies outside the element's box.
      const keys = ['parent', 'grandparent', 'ancestor3', 'ancestor4'];
      ancestorsOf(el).forEach((anc, i) => {
        if (!changed.includes(keys[i]!)) return;
        const ab = boxOf(anc);
        // A container up to the size of the viewport (a card, a list item), not a whole page section.
        if (ab.h > vh() || ab.w * ab.h > 0.8 * vw() * vh()) return;
        const as = getComputedStyle(anc);
        const ae = Math.min(12, Math.max(0, (parseFloat(as.outlineWidth) || 0) + (parseFloat(as.outlineOffset) || 0), shadowExtent(as.boxShadow)));
        area = union(area, { x: ab.x - ae, y: ab.y - ae, w: ab.w + 2 * ae, h: ab.h + 2 * ae });
      });
      // A pseudo-element can be drawn outside the box: a wider margin when one changed.
      const m = (changed.includes('::before') || changed.includes('::after') ? 24 : 4) + extent;
      const ring = { x: box.x - extent, y: box.y - extent, w: box.w + 2 * extent, h: box.h + 2 * extent };
      const crop = intersect({ x: area.x - m, y: area.y - m, w: area.w + 2 * m, h: area.h + 2 * m }, { x: 0, y: 0, w: vw(), h: vh() });
      return {
        indicator,
        clipped: indicator && extent > 0 ? clippedBy(el, ring) : false,
        changed,
        outline: `${focused.outlineStyle} ${focused.outlineWidth}px`,
        crop,
        refocused,
        box,
        kind,
        ring: kind === 'ring' ? (ringInset ? { extent: Math.min(12, outlineInside ? -focused.outlineOffset : innerShadow(focused.shadow)), inset: true as const } : { extent: ringExtent, ...(ringColor ? { color: ringColor } : {}), gap: ringOutline && !ringShadow ? Math.max(0, focused.outlineOffset) : 0 }) : null,
        ...(appears ? { appears: true } : {}),
        ringInView: ring.x >= 0 && ring.y >= 0 && ring.x + ring.w <= vw() && ring.y + ring.h <= vh(),
        borderWidth: focused.borderStyle !== 'none' ? focused.borderWidth : 0,
        ...(pseudoRingFound ? { pseudoRing: pseudoRingFound } : {}),
        pseudoLocal: ['::before', '::after'].filter((p) => changed.includes(p)).every((p) => {
          const ps = getComputedStyle(el, p);
          if (ps.display === 'none') return true;
          if (ps.position === 'fixed' || ps.position === 'sticky') return false;
          if (ps.position !== 'absolute') return true;
          if (getComputedStyle(el).position === 'static') return false;
          return ['top', 'right', 'bottom', 'left'].every((side) => {
            const v = ps.getPropertyValue(side);
            if (v === 'auto' || v === '') return true;
            const n = parseFloat(v);
            return /px$/.test(v) && Number.isFinite(n) && n >= -20 && n <= Math.max(box.w, box.h) + 20;
          }) && (ps.transform === 'none' || ps.transform === '');
        }),
      };
    },
    blur(id) {
      const el = els[id];
      if (!el || !el.isConnected) return false;
      (el as HTMLElement).blur();
      finishTransitions(el);
      return true;
    },
    refocus(id) {
      const el = els[id];
      if (!el || !el.isConnected) return false;
      (el as HTMLElement).focus({ preventScroll: true });
      finishTransitions(el);
      take();
      return deepActive() === el;
    },
    focusId(id) {
      const el = els[id];
      if (!el || !el.isConnected) return false;
      (el as HTMLElement).focus();
      take();
      return deepActive() === el;
    },
    // Focuses the element again from script (its focus handlers run as on a key press) and returns
    // the window.open calls they made; other counters are left for the caller.
    refire(id) {
      const el = els[id];
      if (!el || !el.isConnected) return { connected: false, opens: 0, navs: 0 };
      const a = deepActive();
      if (a) (a as HTMLElement).blur();
      take();
      (el as HTMLElement).focus();
      const c = take();
      return { connected: true, opens: c.opens, navs: c.navs, ...(c.navTo ? { navTo: c.navTo } : {}) };
    },
    navCount() {
      return navTotal;
    },
    tabbables(cap) {
      let n = 0;
      walkAll((e) => {
        if (e.matches(FOCUSABLE_SEL) && tabbable(e)) n++;
        return n < cap;
      });
      return n;
    },
    outside(members) {
      const set = members.map((m) => els[m]).filter((e): e is Element => !!e);
      let n = 0;
      walkAll((e) => {
        if (e.matches(FOCUSABLE_SEL) && !set.some((s) => deepContains(s, e) || deepContains(e, s)) && tabbable(e)) n++;
        return n < 50;
      });
      return n;
    },
    trapInstructions(members) {
      const parts = new Set<string>();
      const nearbyKeys = new Set<string>();
      const objects = new Set(['widget', 'control', 'focus']);
      const list = members.map((m) => els[m]).filter((e): e is Element => !!e);
      const WIDGET = 'dialog, [role="dialog"], [role="alertdialog"], fieldset, section, article, [role="group"], [role="application"], [role="listbox"], [role="grid"], [role="menu"], [role="tree"], [role="toolbar"]';
      const addText = (root: Node, referenced = false, keysOnly = false) => {
        const blocks = new Map<Element, string>();
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const p = n.parentElement;
          const excluded = keysOnly ? 'button, a, input, select, textarea, script, style' : 'button, a, input, select, textarea, h1, h2, h3, h4, h5, h6, [role="heading"], script, style';
          if (!p || (!referenced && !rendered(p)) || p.closest(excluded)) continue;
          const block = p.closest('p, div, li, pre, section, article, fieldset, dialog') ?? p;
          blocks.set(block, `${blocks.get(block) ?? ''} ${n.nodeValue ?? ''}`);
        }
        for (const text of blocks.values()) (keysOnly ? nearbyKeys : parts).add(text);
      };
      for (const m of members) {
        const el = els[m];
        if (!el) continue;
        // A structural widget or the trap's own container; never its neighbouring sections or the page.
        const near = el.closest(WIDGET) ?? el.parentElement ?? el.getRootNode();
        if (near !== document.body && near !== document.documentElement && near !== document) addText(near);
        // Discovery stays generous: a nearby parsed key can prove a working exit even when the
        // prose cannot establish ownership. Only owned advice can make an unparsed method unknown.
        const keyNear = el.closest('dialog, [role="dialog"], fieldset, section, article, [role="group"], [role="application"]') ?? el.parentElement ?? el.getRootNode();
        addText(keyNear, false, true);
        if (keyNear instanceof Element) {
          if (keyNear.previousElementSibling) addText(keyNear.previousElementSibling, false, true);
          if (keyNear.nextElementSibling) addText(keyNear.nextElementSibling, false, true);
        }
        for (let a: Element | null = el; a; a = parentOf(a)) {
          if (a === document.body || a === document.documentElement) break;
          const scope = a.getRootNode() as Document | ShadowRoot;
          const by = (a.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => scope.getElementById(id)?.textContent ?? '').join(' ').trim();
          const name = a.getAttribute('aria-label') || by || (a === el ? nameOf(a) : '');
          const label = a.getAttribute('aria-label');
          if (label) nearbyKeys.add(label);
          if (name) {
            objects.add(name.toLowerCase());
            // A widget named "Date picker" can also be referred to as "the picker".
            const last = name.trim().split(/\s+/).at(-1);
            if (last && last.length > 2) objects.add(last.toLowerCase());
          }
          const role = a.getAttribute('role');
          if (role) objects.add(role);
          if (a.localName === 'dialog') objects.add('dialog');
          for (const attribute of ['aria-describedby', 'aria-labelledby']) {
            for (const id of (a.getAttribute(attribute) ?? '').split(/\s+/)) {
              const scope = a.getRootNode() as Document | ShadowRoot;
              const described = id && (scope.getElementById?.(id) ?? document.getElementById(id));
              if (described) addText(described, true);
            }
          }
          if (a === near) break;
        }
      }
      for (const a of announcements) if (list.some((el) => el === a.focus || deepContains(el, a.focus))) parts.add(a.text);
      const object = [...objects].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      // This grammar only discovers advice. Parsed keys must actually free focus; an unparsed
      // method is uncertain only when the leave verb refers to this widget (or focus/"this").
      const leave = new RegExp(`\\b(?:leav(?:e|ing)|clos(?:e|ing)|exit(?:ing)?|get out of|move)\\s+(?:(?:out of|from)\\s+)?(?:(?:the|this|your)\\s+)?(?:${object})\\b|\\b(?:leave|close|exit)\\s+this(?=\\s*(?:[,;:]|$|by\\b|using\\b|with\\b))`, 'i');
      const text = [...parts, ...nearbyKeys].join('\n');
      if (text.length > 200_000) throw new Error('The widget instructions exceeded the reading limit');
      return { text, exits: [...parts].flatMap((p) => p.split(/[.!?\n]/)).filter((line) => leave.test(line)).join('\n') };
    },
    trapExits(members, pattern, max) {
      const re = new RegExp(pattern, 'i');
      const out: TrapExits = { press: [], links: [], submits: [], buttons: [] };
      for (const m of members) {
        const el = els[m];
        if (!el || !el.isConnected) continue;
        const tag = el.localName;
        const type = (el.getAttribute('type') || '').toLowerCase();
        const label = nameOf(el) || cssPath(el);
        if (el.hasAttribute('href') || tag === 'a' || tag === 'area') {
          out.links.push(label);
        } else if (((tag === 'button' && type !== 'button') || (tag === 'input' && /^(submit|reset|image)$/.test(type))) && (el as HTMLButtonElement | HTMLInputElement).form) {
          // A form owner makes this an actual submission or reset.
          out.submits.push(label);
        } else if (tag === 'button' || (tag === 'input' && /^(button|submit|reset|image)$/.test(type)) || el.getAttribute('role') === 'button') {
          const name = nameOf(el);
          if (re.test(name || '') && out.press.length < max) out.press.push({ id: m, ...(name ? { name } : {}), path: cssPath(el) });
          else out.buttons.push(label);
        }
      }
      return out;
    },
    trapRegion(members) {
      const list = members.map((m) => els[m]).filter((e): e is Element => !!e);
      if (!list.length) return { path: '', dialog: false };
      const dlg = list[0]!.closest('dialog, [role="dialog"], [role="alertdialog"]');
      let common: Element | null = dlg && list.every((e) => dlg.contains(e)) ? dlg : list[0]!;
      while (common && !list.every((e) => common!.contains(e))) common = common.parentElement;
      const region = common || list[0]!;
      const name = region.getAttribute('aria-label') || (region.getAttribute('aria-labelledby') ? document.getElementById(region.getAttribute('aria-labelledby')!)?.textContent : '') || '';
      const dialog = !!region.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      return { path: cssPath(region), ...(clean(name) ? { name: clean(name) } : {}), dialog };
    },
    skipArm(id) {
      const el = els[id];
      scriptTargets.delete(id);
      armedHash = location.hash;
      const b = el as HTMLButtonElement | HTMLInputElement | undefined;
      const type = (el?.getAttribute('type') ?? '').trim().toLowerCase();
      const submits = !!b && (el!.localName === 'button' ? type !== 'button' && type !== 'reset' : el!.localName === 'input' && (type === 'submit' || type === 'image'));
      return { sends: !!(b && 'form' in b && b.form && submits) };
    },
    skipScripted(id) {
      const el = els[id];
      if (!el) return { found: false };
      let target: Element | null = null;
      let by: 'fragment' | 'focus' | undefined;
      if (location.hash.length > 1 && location.hash !== armedHash) {
        let frag = location.hash.slice(1);
        try { frag = decodeURIComponent(frag); } catch { /* keep the raw fragment */ }
        if (!/^[/!]/.test(frag)) target = document.getElementById(frag) || document.getElementsByName(frag)[0] || null;
        if (target) by = 'fragment';
      }
      if (!target) {
        const a = deepActive();
        if (a && a !== el && !deepContains(el, a)) { target = a; by = 'focus'; }
      }
      if (!target) return { found: false };
      scriptTargets.set(id, target);
      const main = mainEl();
      return { found: true, ...(by ? { by } : {}), inMain: !!(main && (main === target || deepContains(main, target) || target.contains(main))) };
    },
    skipLanding(id) {
      const target = skipTargetOf(id);
      const a = deepActive();
      return { inTarget: !!(target && a && (a === target || deepContains(target, a))) };
    },
    skipAfter(id) {
      const link = els[id] as HTMLAnchorElement | undefined;
      const target = skipTargetOf(id);
      const a = deepActive();
      const main = mainEl();
      const inMain = !!(a && main && deepContains(main, a));
      if (!target) return { pos: 'none', inMain };
      const past = !!link && skipPast(link, target);
      // Nothing after the target takes focus: the link moved the sequential focus starting point to its target
      // and Tab had nowhere further to go, so focus left the page or wrapped to its start (ACT cf77f2 passed examples).
      const endFacts = () => ({
        nothingAfter: !deepAll(FOCUSABLE_SEL, 3000).some((e) => tabbable(e) && !!(target.compareDocumentPosition(e) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY))),
        targetShown: rendered(target) || Array.from(target.querySelectorAll('*')).slice(0, 200).some((e) => rendered(e)),
        // Tab wrapped to the page's very first stop (nothing after the target): the browser's own wrap, not focus
        // that landed somewhere before the target.
        wrapped: !!a && deepAll(FOCUSABLE_SEL, 3000).find((e) => tabbable(e)) === a,
      });
      if (!a) return { pos: 'none', inMain, past, ...endFacts() };
      if (a === target || deepContains(target, a)) return { pos: 'inside', inMain, past };
      // Positions compare in the document tree: an element in a shadow root stands at its outermost host.
      let d: Element = a;
      for (let i = 0; i < 50 && d.getRootNode().nodeType === 11 && (d.getRootNode() as ShadowRoot).host; i++) d = (d.getRootNode() as ShadowRoot).host;
      if (target.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) return { pos: 'after', inMain, past };
      return { pos: 'before', inMain, past, ...endFacts() };
    },
    toggleLinks(id) {
      const t = els[id];
      if (!t || !t.isConnected) return { links: -1, controls: false };
      let controlled: Element | null = null;
      for (const rid of (t.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)) { controlled = document.getElementById(rid); if (controlled) break; }
      // The navigation keyboard users would Tab through: the one around the toggle, else the first after it.
      let region: Element | null = t.closest('nav, [role="navigation"]');
      if (!region) {
        const navs = document.querySelectorAll('nav, [role="navigation"]');
        for (let i = 0; i < navs.length && i < 50; i++) if (t.compareDocumentPosition(navs[i]!) & Node.DOCUMENT_POSITION_FOLLOWING) { region = navs[i]!; break; }
      }
      region ??= controlled;
      if (!region) return { links: -1, controls: false };
      const controls = !!controlled && (controlled === region || controlled.contains(region) || region.contains(controlled));
      return { links: Array.from(region.querySelectorAll(FOCUSABLE_SEL)).filter((e) => e !== t && !e.contains(t) && tabbable(e)).length, controls };
    },
    restore(url) {
      try {
        if (location.href !== url) history.replaceState(history.state, '', url);
      } catch {
        // a page that forbids it keeps the fragment
      }
      const a = deepActive();
      if (a) (a as HTMLElement).blur();
      // Close the details and dialogs the walk opened; count menus it expanded (the caller presses Esc).
      for (const e of openThings()) {
        if (openAtStart.has(e)) continue;
        if (e.localName === 'dialog') (e as HTMLDialogElement).close();
        else (e as HTMLDetailsElement).open = false;
      }
      // Controls the walk expanded get their saved aria-expanded back (no key is pressed for this).
      let expanded = 0;
      for (const e of expandables()) {
        if (!expandedAtStart.has(e)) continue;
        const was = expandedAtStart.get(e)!;
        if (e.getAttribute('aria-expanded') === was) continue;
        if (was === null) e.removeAttribute('aria-expanded');
        else e.setAttribute('aria-expanded', was);
        expanded++;
      }
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
      take();
      return { expanded };
    },
    layout() {
      const main = mainEl();
      const footer = pageFooter();
      const mr = main && rendered(main) ? main.getBoundingClientRect() : null;
      const fr = footer && rendered(footer) ? footer.getBoundingClientRect() : null;
      const heads = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
      let headings = 0;
      for (let i = 0; i < heads.length && headings < 5; i++) if (rendered(heads[i]!) && clean(heads[i]!.textContent)) headings++;
      // The content comes before any repeated block (nothing to bypass; ACT cf77f2): no focus stop comes before
      // the first paragraph of content (text outside the page's navigation, header, aside and footer), and no
      // focus stop inside a repeated region comes before any later content (a paragraph or a focus stop outside
      // those regions). A paragraph before a navigation that the content then follows is not enough.
      const order = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const allStops = deepAll(FOCUSABLE_SEL, 3000).filter((e) => tabbable(e));
      const content = contentBlocks();
      let contentFirst = false;
      if (content.length && !allStops.some((e) => order(e, content[0]!))) {
        const repeatedStops = allStops.filter((e) => !!e.closest(REPEATED_SEL));
        const firstRepeated = repeatedStops[0];
        const lastContent = [...content, ...allStops.filter((e) => !e.closest(REPEATED_SEL))]
          .reduce<Element | null>((last, e) => (!last || order(last, e) ? e : last), null);
        contentFirst = !firstRepeated || !lastContent || !order(firstRepeated, lastContent);
      }
      // A control among the first focus stops that hides or shows the navigation (SCR28): `toggleId` names it for
      // `toggleLinks`, and the walk presses it before it counts (a control merely named so is no bypass).
      const TOGGLE = /\b(hide|show|toggle|collapse|expand)\b.*\b(navigation|nav|menu|table of contents?|contents|toc|links|chapters)\b/i;
      let toggle: string | undefined;
      let toggleId: number | undefined;
      for (const e of allStops.slice(0, 10)) {
        const n = clean(nameOf(e));
        if (e.matches('a, button, [role="button"], summary') && TOGGLE.test(n)) { toggle = n; toggleId = idOf(e); break; }
      }
      return {
        ...(mr && mr.height > 0 ? { mainBottom: mr.bottom + scrollY } : {}),
        ...(fr && fr.height > 0 ? { footerTop: fr.top + scrollY } : {}),
        hasMain: !!(main && rendered(main)),
        headings,
        ...(contentFirst ? { contentFirst } : {}),
        ...(toggle ? { toggle, toggleId } : {}),
      };
    },
    clickables(refs, max) {
      const target = W.__grntedTarget;
      const typesOf = new Map<Element, string[]>();
      for (const r of refs) {
        const el = target ? target(r.ref) : null;
        if (el instanceof Element) typesOf.set(el, r.types);
      }
      const groups = new Map<string, ClickableGroup>();
      const flaggedParents = new Set<Element>();
      const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';
      /** A host whose shadow root is closed (the listener hook saw it attached): what it shows cannot be read here. */
      const closedHost = (el: Element): boolean => {
        try { return !el.shadowRoot && W.__grntedClosedHost?.(el) === true; } catch { return false; }
      };
      /** The slot an element or text is shown in (null when it is shown in none, or in a closed shadow root). */
      const slotOf = (n: Element | Text): HTMLSlotElement | null => (n as (Element | Text) & { assignedSlot?: HTMLSlotElement | null }).assignedSlot ?? null;
      /**
       * The element's parent as the page is shown (the composed tree; fix round 2): the slot it is shown in, else its
       * parent, else, at the top of a shadow root, the root's host.
       */
      const composedParent = (el: Element): Element | null => slotOf(el) ?? el.parentElement ?? parentOf(el);
      /**
       * The open shadow roots of a scope's hosts, and the elements shown in a shadow root's slots that are not already
       * inside the content read (a card element's wrapper that shows a link the page put in its slot): what `root`
       * shows (fix round 2, S1/S7: a chart element's canvas in its shadow root; slots). Bounded: at most 50 scopes, 3000
       * elements a scope, 50 slots a scope and 200 slotted texts. `closed`: hosts of closed shadow roots met; `full`: false
       * when not all of it was read (a bound was reached: round 4, S2, what is not read is undecided); `slotted`: the
       * scopes that are elements shown in a slot (they count themselves, not only what is in them); `texts`: bare text a
       * slot shows from outside the content read (round 4, S6: a label the page put in a control element's slot).
       */
      interface Content { scopes: (Element | ShadowRoot)[]; slotted: Set<Element>; fromSlot: Set<Element | ShadowRoot>; texts: Text[]; closed: number; full: boolean }
      const contents = new Map<Element, Content>();
      /** `sel` in a scope: the elements in it, and the scope itself when it is an element shown in a slot. */
      const within = (c: Content, scope: Element | ShadowRoot, sel: string): Element[] => {
        const out = Array.from(scope.querySelectorAll(sel));
        if (c.slotted.has(scope as Element) && (scope as Element).matches(sel)) out.unshift(scope as Element);
        return out;
      };
      const contentOf = (root: Element): Content => {
        const known = contents.get(root);
        if (known) return known;
        const c: Content = { scopes: [root], slotted: new Set(), fromSlot: new Set(), texts: [], closed: 0, full: true };
        const add = (s: Element | ShadowRoot, viaSlot: boolean): void => {
          if (c.scopes.length >= 50) { c.full = false; return; }
          c.scopes.push(s);
          if (viaSlot) c.fromSlot.add(s);
        };
        // A custom element with no open shadow root met while reading (a closed root written in its markup is not seen
        // by the listener hook) is unread content, as a closed root is (round 4 check, S1: a nested closed button).
        const host = (h: Element, viaSlot: boolean): void => {
          if (h.shadowRoot) add(h.shadowRoot, viaSlot);
          else if (closedHost(h) || h.localName.includes('-')) c.closed++;
        };
        const inside = (e: Element): boolean => c.scopes.some((s) => s === e || s.contains(e));
        host(root, false);
        for (let k = 0; k < c.scopes.length; k++) {
          const scope = c.scopes[k]!;
          const viaSlot = c.fromSlot.has(scope);
          const all = scope.querySelectorAll('*');
          if (all.length > 3000) c.full = false;
          if (c.slotted.has(scope as Element)) host(scope as Element, true);
          for (let i = 0; i < all.length && i < 3000; i++) host(all[i]!, viaSlot);
          // A slot shows elements and text from outside the tree it is in (only a slot in a shadow tree shows any).
          const slots = within(c, scope, 'slot');
          if (slots.length > 50) c.full = false;
          for (let i = 0; i < slots.length && i < 50; i++) {
            const shown = (slots[i] as HTMLSlotElement).assignedNodes({ flatten: true });
            for (const n of shown) {
              if (n.nodeType === 1) { if (!inside(n as Element)) { c.slotted.add(n as Element); add(n as Element, true); } }
              else if (n.nodeType === 3 && !c.scopes.some((x) => x.contains(n))) {
                if (c.texts.length < 200) c.texts.push(n as Text);
                else c.full = false;
              }
            }
          }
        }
        contents.set(root, c);
        return c;
      };
      /**
       * Tabbable elements inside `root`, its open shadow roots included (a custom element's own button, 2026-11-07
       * audit), and, with `slots`, the elements its shadow roots' slots show (fix round 2), counted up to `cap`.
       * `incomplete`: fewer than `cap` were found and not everything was looked at (more than 300 focusable elements in
       * a scope, or content not all read: round 4, S2), so the count is not known.
       */
      const tabbableInside = (root: Element, except: Element | null, cap: number, slots = false): { n: number; incomplete: boolean } => {
        let n = 0;
        const c = contentOf(root);
        let incomplete = !c.full;
        for (let k = 0; k < c.scopes.length && n < cap; k++) {
          const scope = c.scopes[k]!;
          if (!slots && c.fromSlot.has(scope)) continue;
          const all = within(c, scope, FOCUSABLE);
          if (all.length > 300) incomplete = true;
          for (let i = 0; i < all.length && i < 300 && n < cap; i++) {
            const e = all[i]!;
            if (except && (except === e || except.contains(e))) continue;
            if (tabbable(e)) n++;
          }
        }
        return { n, incomplete: incomplete && n < cap };
      };
      /** ARIA's widget roles: the page says the element is a control. */
      const WIDGET_ROLES = new Set([
        'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
        'slider', 'spinbutton', 'combobox', 'searchbox', 'textbox', 'scrollbar', 'gridcell',
      ]);
      /** ARIA's composite widgets: the widget takes focus and moves it among its own parts. */
      const COMPOSITE_ROLES = new Set(['tablist', 'menu', 'menubar', 'listbox', 'grid', 'tree', 'treegrid', 'radiogroup', 'toolbar']);
      /** The element's role as ARIA reads it: the first token given, in lower case ('' for none). */
      const firstRole = (el: Element): string => (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
      /**
       * The one widget-role predicate (fix round 2, S4): the declaration of a control, the carousel's own parts and the
       * parts under a delegated listener all read a role through it.
       */
      const controlRole = (el: Element): string => {
        const first = firstRole(el);
        return WIDGET_ROLES.has(first) ? first : '';
      };
      /** The element, or the nearest element it is shown in (the composed tree, read to its end), whose role is in `roles`. */
      const roleUp = (el: Element, roles: ReadonlySet<string>): Element | null => {
        for (let a: Element | null = el; a && a !== document.body; a = composedParent(a)) if (roles.has(firstRole(a))) return a;
        return null;
      };
      const SLIDER = new Set(['slider']);
      /**
       * A carousel's own parts: a slide (and its clones the library makes for looping) or the track. Their
       * click and pointer listeners drag, swipe or pause the carousel; they are no function of their own
       * (changing slides is the carousel's controls' job, judged as those controls). Recognised only by
       * ARIA's carousel pattern (aria-roledescription carousel or slide) or a known carousel library's own
       * class on the element or an ancestor up to 6 levels (a whole class name: "camera" or "cycle" in an id
       * or a word of a class says nothing).
       */
      const CAROUSEL_CLASSES = new Set([
        'slick-slider', 'slick-list', 'slick-track', 'slick-slide', 'swiper', 'swiper-container', 'swiper-wrapper', 'swiper-slide',
        'splide', 'splide__track', 'splide__list', 'splide__slide', 'owl-carousel', 'owl-stage', 'owl-stage-outer', 'owl-item',
        'flickity-slider', 'flickity-viewport', 'glide__track', 'glide__slides', 'glide__slide', 'keen-slider', 'keen-slider__slide',
        'carousel-inner', 'carousel-item', 'camera_wrap', 'camera_target', 'cameraContents', 'cameraContent', 'cameraSlide',
        'cycle-slideshow', 'cycle-slide', 'bx-viewport', 'bxslider', 'flexslider', 'flex-viewport', 'rev_slider', 'rs-slides',
        'n2-ss-slide', 'metaslider', 'kb-advanced-slider', 'kt-blocks-carousel',
      ]);
      const carouselOf = (el: Element): Element | null => {
        for (let a: Element | null = el, i = 0; a && a !== document.body && i < 6; a = a.parentElement, i++) {
          if (/^(carousel|slide|slideshow)$/i.test(a.getAttribute('aria-roledescription') ?? '')) return a;
          for (const c of Array.from(a.classList)) if (CAROUSEL_CLASSES.has(c)) return a;
        }
        return null;
      };
      /** A copy a carousel library makes of a slide for looping (its class or id says clone), inside the carousel only. */
      const CLONE = /(^|[\s_-])(clone|cloned|duplicate)([\s_-]|$)|--clone\b/i;
      const isClone = (el: Element, widget: Element): boolean => {
        for (let a: Element | null = el, i = 0; a && i < 6; a = a.parentElement, i++) {
          if (CLONE.test(typeof a.className === 'string' ? a.className : '') || /-clone\d*$/i.test(a.id)) return true;
          if (a === widget) break;
        }
        return false;
      };
      /** A listener of the page's own written on the element (an inline handler), or a widget role: an action of its own. */
      const ownAction = (el: Element): boolean =>
        ['onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'ontouchstart'].some((a) => el.hasAttribute(a)) || !!controlRole(el);
      const urlIn = (el: Element): string | null => {
        const data = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
        const inline = el.getAttribute('onclick') || '';
        const m = /(?:location(?:\.href)?\s*=|location\.assign\(|window\.open\()\s*['"]([^'"]+)['"]/.exec(inline);
        const raw = data || (m ? m[1]! : '');
        if (!raw) return null;
        try { return new URL(raw, location.href).href; } catch { return null; }
      };
      const OUT_OF_PLAY = '[aria-disabled="true"], [inert], [aria-hidden="true"]';
      const consider = (el: Element, why: string, listed: false | 'element' | 'surface' | 'shadow' = false): boolean => {
        if (!el.isConnected || el === document.body || el === document.documentElement) return false;
        // A read that reached its bound (round 4, S2): what it did not read may hold the keyboard's way, so an element
        // that would fail is listed as undecided instead (`listed: 'shadow'`).
        let unread = false;
        const tag = el.localName;
        if (el.matches('main, [role="main"], option, optgroup')) return false;
        if (tag === 'label' && (el as HTMLLabelElement).control) return false;
        if (tabbable(el)) return false;
        if (el.matches(OUT_OF_PLAY) || (el as HTMLButtonElement).disabled) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false;
        // A box that fills the screen is a page's wrapper, no control; a drawing that size is listed (a full-screen seat
        // plan: fix round 2, S3).
        if (r.width * r.height >= 0.9 * vw() * vh() && listed !== 'surface') return false;
        if (!rendered(el) || opacityChain(el) <= 0.1) return false;
        // Inside a control, or out of play, as the page is shown (the composed tree: a slot's own button, an inert
        // block around a custom element; fix round 2).
        for (let a = composedParent(el); a && a !== document.body; a = composedParent(a)) if (tabbable(a) || a.matches(OUT_OF_PLAY)) return false;
        if (document.body?.matches(OUT_OF_PLAY) || document.documentElement.matches(OUT_OF_PLAY)) return false;
        const comp = roleUp(el, COMPOSITE_ROLES);
        if (comp) {
          if (tabbable(comp)) return false;
          const t = tabbableInside(comp, null, 1, true);
          if (t.n) return false;
          if (t.incomplete) unread = true;
        }
        const inner = tabbableInside(el, null, 1, true);
        if (inner.n) return false;
        if (inner.incomplete) unread = true;
        // A card-like wrapper with 1 to 3 controls (a clickable tile next to its own link) has its
        // keyboard equivalent in those controls. The main content or a form is not such a wrapper: a
        // link elsewhere in main, or a form's fields, are no equivalent of a click-only control in it.
        // (Counted with and without what the wrapper's slots show: either count of 1 to 3 is a card.)
        const LANDMARK = 'main, [role="main"], form, [role="form"], [role="search"]';
        for (const anc of [el.parentElement, el.parentElement ? el.parentElement.parentElement : null]) {
          if (!anc || anc === document.body || anc.matches(LANDMARK)) break;
          const n = tabbableInside(anc, el, 4);
          if (n.n >= 1 && n.n <= 3 && !n.incomplete) return false;
          const shown = tabbableInside(anc, el, 4, true);
          if (shown.n >= 1 && shown.n <= 3 && !shown.incomplete) return false;
          if (n.incomplete || shown.incomplete) unread = true;
        }
        const url = urlIn(el);
        // Carousel slides and their loop clones (2026-11-07 audit: albany, ltd-transit): their listeners are
        // the carousel's own; a slide that links somewhere (a data-href, an inline location change) or has an
        // action of its own (an inline onclick, a widget role: fix round 2, S4) still counts.
        const widget = !url && !roleUp(el, SLIDER) ? carouselOf(el) : null;
        // Only the carousel's own part (the slide, the track: the element the library's class or the carousel pattern
        // marks) is left out; a loop clone is a copy whose original is judged. An element inside a slide with its own
        // click listener (an "Add to cart" in a slide) is judged (Grok round 2).
        if (widget && (isClone(el, widget) || (widget === el && !ownAction(el)))) return false;
        if (url) {
          const links = document.querySelectorAll('a[href]');
          for (let i = 0; i < links.length && i < 2000; i++) if ((links[i] as HTMLAnchorElement).href === url && tabbable(links[i]!)) return false;
          if (links.length > 2000) unread = true;
        }
        if (!listed && unread) listed = 'shadow';
        // Candidates are counted apart from failures (their own groups, at most `MAX_LISTED`), so they never
        // take a failure's place.
        const key = `${listed ? `${listed}|` : ''}${sigOf(el)}`;
        const g = groups.get(key);
        if (g) g.count++;
        else if (listed ? listedGroups < MAX_LISTED : groups.size - listedGroups < max) {
          const name = nameOf(el);
          groups.set(key, { path: cssPath(el), ...(name ? { name } : {}), tag, why, count: 1, ...(listed ? { listed } : {}) });
          if (listed) listedGroups++;
        }
        return true;
      };
      const MAX_LISTED = 5;
      let listedGroups = 0;
      const STRONG = new Set(['click', 'dblclick']);
      const withClick = new Set<Element>();
      typesOf.forEach((types, el) => { if (types.some((t) => STRONG.has(t))) withClick.add(el); });
      /**
       * A listener alone never proves a control (2026-11-12; fix rounds 1 and 2 after review, same day). Charting and
       * map libraries put click and pointer listeners on what they draw for hit testing (Chart.js on its canvas,
       * ECharts and Highcharts on the wrapper of theirs, Google Charts on its svg and a wrapper, D3's zoom on an svg),
       * whether or not a click there does anything; scripts put them on plain elements to count clicks or to stop
       * them; a handler written on the element (onclick="void 0") says no more than one a script added. This test
       * presses nothing, so a listener, a handler or an inherited cursor is a reason to look, never proof:
       * - a surface that only draws (`surface`) is never failed here, whatever else is on it: it is listed as
       *   undecided (`listed: 'surface'`), never dropped: not for filling the screen, not for having only a press
       *   listener and the default cursor (fix round 2, S3);
       * - any other element fails only when the page itself declares it a control (`declared`): it is written as
       *   one (a link, button or form control element: `<a onclick>` with no href, a button taken out of the tab
       *   order), it has a widget role (`controlRole`), or it has a pointer cursor of its own, one it does not
       *   inherit (`ownPointer`). That goes for an element with the listener, and for a part of one that handles
       *   its clicks (a row of a list, a region of an svg map, a member with a widget role: fix round 2, S4);
       * - without such a declaration it is listed as undecided (`listed: 'element'`);
       * - a declared control whose content this test cannot read (a closed shadow root in or on it, or more than its
       *   bounded read) is listed as undecided (`listed: 'shadow'`), never failed (fix round 2);
       * - an undecided part (a drawing, unread content) never stands in for the declared control around it: the
       *   control is judged on its own, and the part is listed only when nothing was said of the control (fix
       *   round 2, S5: a div with role=button around an icon with a pointer cursor of its own and a label fails).
       * Drawings, cursors, slots and handlers are read through open shadow roots, as the page is shown (fix round 2,
       * S1, S2; S7 in listeners.ts).
       */
      /**
       * The element it inherits its style from (fix round 2, S2): its composed parent (`composedParent`). Undefined for
       * a child of a host whose shadow root is closed: it is shown through that root, so where its style comes from
       * cannot be read.
       */
      const styleParent = (el: Element): Element | null | undefined => {
        if (!slotOf(el) && el.parentElement && closedHost(el.parentElement)) return undefined;
        return composedParent(el);
      };
      const ownPointer = (el: Element): boolean => {
        if (getComputedStyle(el).cursor !== 'pointer') return false;
        const p = styleParent(el);
        if (p === undefined) return false;
        return !p || getComputedStyle(p).cursor !== 'pointer';
      };
      /** The page declares the element a control: by its element, by a widget role, or by a pointer cursor of its own. */
      const declared = (el: Element): boolean => /^(a|button|input|select|textarea|summary|area)$/.test(el.localName) || !!controlRole(el) || ownPointer(el);
      /**
       * A surface that only draws: a canvas, an svg, an element the page gives the image role, or a wrapper whose
       * whole content is one drawing (it shows a canvas or svg at least half its size, and no text of its own shows
       * outside drawings: a table kept off screen for screen readers is no shown text, nor is text a shadow root does
       * not show). Its content is read as the page shows it (`contentOf`: a chart element whose canvas is in its
       * shadow root, a frame whose slot shows a canvas; fix round 2, S1), its text too: bare text at the top of a
       * shadow root and bare text a slot shows are shown text (round 4, S6). 'incomplete' (round 4, S2): a bound was
       * reached (40 drawings, 400 texts outside drawings, or the content read), so whether it is one is not known.
       */
      /**
       * Elements whose drawing read was incomplete where it met a drawing (round 4 check, S2): more drawings than the 40
       * looked at, the text bound reached after a drawing filled it, or a read cut short after a drawing was seen.
       * Whether such an element is a wrapper of one drawing is not known. (A read cut short with no drawing met is no
       * such doubt: a wrapper whose first 3000 elements hold no drawing is no wrapper of one drawing.)
       */
      const drawingUnknown = new Set<Element>();
      const surface = (el: Element): 'yes' | 'no' | 'incomplete' => {
        const r = surfaceRead(el);
        if (r.out === 'incomplete' && r.drawing) drawingUnknown.add(el);
        return r.out;
      };
      /**
       * Where bare text shows (at the top of a shadow root, or in a slot) is visible as the page is shown (round 4
       * check, S3): the nearest element with a box around it (a slot has none) is rendered and not transparent, and the
       * text's own computed visibility is visible. Unknown (no such element) counts as not visible.
       */
      const composedVisible = (from: Element): boolean => {
        let a: Element | null = from;
        while (a && a.getClientRects().length === 0 && getComputedStyle(a).display === 'contents') a = composedParent(a);
        if (!a) return false;
        return getComputedStyle(from).visibility === 'visible' && rendered(a) && opacityChain(a) > 0.1;
      };
      const surfaceRead = (el: Element): { out: 'yes' | 'no' | 'incomplete'; drawing: boolean } => {
        const tag = el.localName;
        if (tag === 'canvas' || tag === 'svg') return { out: 'yes', drawing: true };
        const role = firstRole(el);
        if (role === 'img' || role === 'image' || role === 'graphics-document') return { out: 'yes', drawing: true };
        const c = contentOf(el);
        const box = el.getBoundingClientRect();
        let fills = false;
        let seen = 0;
        let more = false;
        for (let k = 0; k < c.scopes.length && !fills && !more; k++) {
          const drawings = within(c, c.scopes[k]!, 'canvas, svg');
          for (let i = 0; i < drawings.length && !fills; i++) {
            if (seen >= 40) { more = true; break; }
            seen++;
            const d = drawings[i]!.getBoundingClientRect();
            fills = d.width * d.height >= 0.5 * box.width * box.height;
          }
        }
        if (!fills && !more && c.full) return { out: 'no', drawing: false };
        const range = document.createRange();
        const inBox = (r: DOMRect) => r.width >= 4 && r.height >= 4 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
        /**
         * The text is shown inside the wrapper's own box (not clipped to nothing, not parked off screen): true or false;
         * 'unsure' for bare text (at the top of a shadow root, or in a slot) inside the box where the page, as it is
         * shown, does not make it visible (round 4 check, S3: what is not known to show is undecided).
         */
        const shown = (t: Text): boolean | 'unsure' => {
          const p = t.parentElement;
          const measured = (from: Element) => {
            range.selectNodeContents(t);
            if (!inBox(range.getBoundingClientRect())) return false;
            return composedVisible(from) ? true : 'unsure' as const;
          };
          if (!p) {
            // Bare text at the top of a shadow root: measured itself, visible as its host is.
            const host = (t.parentNode as ShadowRoot | null)?.host;
            return host ? measured(host) : 'unsure';
          }
          if (p.closest('canvas, svg') || !rendered(p)) return false;
          // A host's own text that its shadow root does not show (no slot takes it), or may not (a closed root), is
          // no shown text; text a slot shows is measured where it shows, visible as the slot is.
          if (t.parentNode === p && (p.shadowRoot || closedHost(p))) {
            const slot = slotOf(t);
            return slot ? measured(slot) : false;
          }
          return inBox(p.getBoundingClientRect());
        };
        // Text outside drawings only (an svg's own labels are part of the drawing), at most 400 looked at.
        const skipDrawings = { acceptNode: (x: Node) => (x.nodeType === 1 ? (/^(svg|canvas)$/.test((x as Element).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT) };
        let n = 0;
        let unsure = false;
        const look = (t: Text): boolean => {
          if (!/[\p{L}\p{N}]/u.test(t.nodeValue ?? '')) return false;
          const v = shown(t);
          if (v === 'unsure') unsure = true;
          return v === true;
        };
        /** Shown text of its own outside drawings ('shown'), none in what was read ('none'), or the 400-text bound reached. */
        const ownText = (): 'shown' | 'none' | 'bound' => {
          for (const scope of c.scopes) {
            if (scope.nodeType === 1 && /^(svg|canvas)$/.test((scope as Element).localName)) continue;
            const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, skipDrawings);
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
              if (++n > 400) return 'bound';
              if (look(t as Text)) return 'shown';
            }
          }
          for (const t of c.texts) {
            if (++n > 400) return 'bound';
            if (look(t)) return 'shown';
          }
          return 'none';
        };
        const text = ownText();
        // The drawing read was cut short (more than 40 drawings, or the bounded content read): an element that shows
        // text of its own outside its drawings is no wrapper of one drawing whatever the unread part holds (a page's
        // wrapper with an icon or a logo in it); one that shows none read may be one (round 4 check, S2).
        if (!fills) return text === 'shown' ? { out: 'no', drawing: false } : { out: 'incomplete', drawing: more || seen > 0 };
        if (text === 'shown') return { out: 'no', drawing: true };
        if (text === 'bound') return { out: 'incomplete', drawing: true };
        return c.full && !unsure ? { out: 'yes', drawing: true } : { out: 'incomplete', drawing: true };
      };
      /**
       * Why an element that listens is not simply judged: a drawing ('surface'), or content that cannot be read
       * ('shadow': a closed shadow root in or on it, or more than the bounded read covers, so whether it is a drawing,
       * or holds a control the keyboard reaches, is not known: unresolved shadow content is undecided, never failed).
       * A custom element (a tag with a hyphen) with no open shadow root is unread too (round 4, S3): a closed shadow root
       * written in its markup (declarative) is not seen by the listener hook, so what it shows cannot be read.
       * False: it is judged.
       */
      const kinds = new Map<Element, 'surface' | 'shadow' | false>();
      const listedKind = (el: Element): 'surface' | 'shadow' | false => {
        let k = kinds.get(el);
        if (k === undefined) {
          if (el.localName.includes('-') && !el.shadowRoot) k = 'shadow';
          else {
            const s = surface(el);
            if (s === 'yes') k = 'surface';
            else if (s === 'incomplete') k = 'shadow';
            else {
              const c = contentOf(el);
              k = c.closed || !c.full ? 'shadow' : false;
            }
          }
          kinds.set(el, k);
        }
        return k;
      };
      /**
       * A part of a drawing (round 4, S1, the cut ruling): an svg element, or an element shown inside a canvas, an svg,
       * an element with the image role or a wrapper of one drawing. A click there may only be a library's hit test; until
       * the scan can show what a click does and that the keyboard has no way to do it, such a part is never failed by
       * this rule: it is listed as a drawing.
       */
      const inDrawing = (el: Element): 'yes' | 'no' | 'unknown' => {
        if (el.namespaceURI === 'http://www.w3.org/2000/svg') return 'yes';
        let unknown = false;
        for (let a = composedParent(el); a && a !== document.body && a !== document.documentElement; a = composedParent(a)) {
          const tag = a.localName;
          const role = firstRole(a);
          if (tag === 'canvas' || tag === 'svg' || role === 'img' || role === 'image' || role === 'graphics-document' || listedKind(a) === 'surface') return 'yes';
          // An ancestor whose drawing read was incomplete may be a wrapper of one drawing (round 4 check, S2).
          if (drawingUnknown.has(a)) unknown = true;
        }
        return unknown ? 'unknown' : 'no';
      };
      // Parts of an element that handles their clicks (delegation): rows and tiles, and the parts of a drawing (a
      // region of an svg map whose clicks the svg handles). A part counts when it declares itself a control: a widget
      // role (fix round 2, S4: a role=button member of a list that handles its clicks), or a pointer cursor of its own.
      const cands = document.querySelectorAll('div, span, li, img, svg, i, p, td, th, figure, section, article, h1, h2, h3, h4, h5, h6, label, svg path, svg g, svg rect, svg circle, svg ellipse, svg polygon, svg polyline, svg text, svg use');
      // An undecided part (a drawing or a part of one, unread content) of a declared control that handles its clicks (an
      // icon in a div with role=button): the control is judged on its own, and the part is listed only when nothing was
      // said of it.
      const pending: { el: Element; deleg: Element; why: string; kind: 'surface' | 'shadow' }[] = [];
      for (let i = 0; i < cands.length && i < 4000; i++) {
        const el = cands[i]!;
        if (typesOf.has(el)) continue;
        const role = controlRole(el);
        if (!role) {
          const other = firstRole(el);
          if (other && other !== 'presentation' && other !== 'none') continue;
          if (!ownPointer(el)) continue;
        }
        let deleg: Element | null = null;
        for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
          if (withClick.has(a)) { deleg = a; break; }
        }
        if (!deleg) continue;
        const why = `${role ? `${role} role` : 'pointer cursor'}, click handled by ${cssPath(deleg)}`;
        const where = listedKind(el) ? 'no' : inDrawing(el);
        const kind = listedKind(el) || (where === 'yes' ? 'surface' : where === 'unknown' ? 'shadow' : false);
        if (kind && declared(deleg)) { pending.push({ el, deleg, why, kind }); continue; }
        // A drawing or a part of one with a pointer cursor in a block that listens for clicks (and declares nothing):
        // listed, like any surface, in the block's place.
        if (consider(el, why, kind)) flaggedParents.add(deleg);
      }
      const failedEls = new Set<Element>();
      const listedEls = new Set<Element>();
      /**
       * A declared control that would fail: a part of a drawing is listed as one instead (round 4, S1), and one inside an
       * element whose drawing read was incomplete is listed as unread (round 4 check, S2).
       */
      const judge = (el: Element, why: string): void => {
        const where = inDrawing(el);
        if (where === 'yes') { if (consider(el, why, 'surface')) listedEls.add(el); }
        else if (where === 'unknown') { if (consider(el, why, 'shadow')) listedEls.add(el); }
        else if (consider(el, why)) failedEls.add(el);
      };
      typesOf.forEach((types, el) => {
        if (flaggedParents.has(el) || tabbable(el)) return;
        const strong = types.filter((t) => STRONG.has(t));
        const kind = listedKind(el);
        if (strong.length) {
          const why = `${strong.join(' and ')} handler`;
          if (kind === 'surface') { if (consider(el, why, 'surface')) listedEls.add(el); }
          else if (!declared(el)) { if (consider(el, why, 'element')) listedEls.add(el); }
          else if (kind === 'shadow') { if (consider(el, why, 'shadow')) listedEls.add(el); }
          else judge(el, why);
          return;
        }
        // Press handlers alone: a drawing is listed whatever its cursor (a canvas that only listens for pointerdown;
        // fix round 2, S3); any other element counts only on a pointer cursor of its own.
        const pointer = getComputedStyle(el).cursor === 'pointer';
        const why = `${types.join(', ')} handler${pointer ? ' and pointer cursor' : ''}`;
        if (kind === 'surface') { if (consider(el, why, 'surface')) listedEls.add(el); }
        else if (pointer && ownPointer(el)) {
          if (kind === 'shadow') { if (consider(el, why, 'shadow')) listedEls.add(el); }
          else judge(el, why);
        }
      });
      // The undecided parts of declared controls: listed when nothing was said of their control (it was neither failed
      // nor listed, by itself or through another part).
      for (const p of pending) if (!failedEls.has(p.deleg) && !listedEls.has(p.deleg) && !flaggedParents.has(p.deleg)) consider(p.el, p.why, p.kind);
      return [...groups.values()];
    },
    take,
    keyState() {
      const a = deepActive();
      return {
        active: a ? idOf(a) : 0, ...(a ? { activePath: cssPath(a) } : {}), textField: !!(a && isTextField(a)),
        url: location.href, sx: scrollX, sy: scrollY,
      };
    },
    blurAll() {
      const a = deepActive();
      if (a) (a as HTMLElement).blur();
      if (document.activeElement && document.activeElement !== document.body) (document.activeElement as HTMLElement).blur?.();
      take();
    },
    beforeKey() {
      if (deepActive()) kit.blurAll();
      take();
      return kit.keyState();
    },
    afterKey(ms) {
      return new Promise((resolve) => {
        setTimeout(() => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve({ ...kit.keyState(), ...take() });
          };
          requestAnimationFrame(() => requestAnimationFrame(finish));
          setTimeout(finish, 100);
        }, ms);
      });
    },
    byPath(path) {
      try {
        // "host path >>> inner path": one segment per shadow root.
        let root: Document | ShadowRoot = document;
        let el: Element | null = null;
        for (const part of path.split(' >>> ')) {
          el = root.querySelector(part);
          if (!el) return 0;
          if (el.shadowRoot) root = el.shadowRoot;
        }
        return el ? idOf(el) : 0;
      } catch {
        return 0;
      }
    },
    controlMatching(pattern, skip) {
      const re = new RegExp(pattern, 'i');
      const all = document.querySelectorAll('button, a[href], input, select, label, summary, [role="button"], [role="switch"], [role="checkbox"], [role="menuitemcheckbox"], [role="link"], [role="tab"]');
      for (let i = 0; i < all.length && i < 3000; i++) {
        const e = all[i]!;
        if (!rendered(e)) continue;
        const text = `${nameOf(e) || ''} ${e.getAttribute('title') || ''}`;
        if (re.test(text) && !skip.includes(cssPath(e))) return cssPath(e);
      }
      return null;
    },
    cover(id) {
      const el = els[id];
      if (!el || !el.isConnected) return null;
      const box = boxOf(el);
      const by = coverOf(el, box);
      const out: CoverView = {
        box, cover: by ? toBox(by.getBoundingClientRect()) : null, sx: scrollX, sy: scrollY, vw: vw(), vh: vh(),
        title: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      };
      if (by) {
        out.coverTag = by.localName;
        const role = by.getAttribute('role');
        if (role) out.coverRole = role.slice(0, 40);
        out.coverPosition = getComputedStyle(by).position;
      }
      return out;
    },
    center(id) {
      const el = els[id];
      if (!el || !el.isConnected) return Promise.resolve(null);
      const b = boxOf(el);
      window.scrollTo({ left: scrollX, top: scrollY + b.y + b.h / 2 - vh() / 2, behavior: 'instant' as ScrollBehavior });
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const now = boxOf(el);
          resolve({ box: now, covered: coverOf(el, now) !== null });
        };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 100);
      });
    },
    scrollTo(x, y) {
      window.scrollTo({ left: x, top: y, behavior: 'instant' as ScrollBehavior });
    },
    closeDialog(path) {
      let d: Element | null = null;
      try { d = document.querySelector(path); } catch { d = null; }
      if (!d) return true;
      if (d instanceof HTMLDialogElement && d.open) {
        // Focus is taken out of it first: closing a dialog that holds focus gives focus back to the
        // element that opened it, whose focus handler would open it again.
        const a = deepActive();
        if (a) (a as HTMLElement).blur();
        try { d.close(); } catch { /* not closable */ }
      }
      const shown = d.isConnected && rendered(d);
      if (!shown) openDialogs.delete(d);
      take();
      return !shown;
    },
    describe(id) {
      const el = els[id];
      if (!el) return null;
      const name = nameOf(el);
      return { path: cssPath(el), ...(name ? { name } : {}) };
    },
  };

  /**
   * Whether Tab can reach the element. The tabIndex property alone is not enough: it is 0 for an
   * anchor without href, which is not focusable.
   */
  function tabbable(el: Element): boolean {
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
    return rendered(el);
  }

  Object.defineProperty(W, '__grntedKb', { value: kit, configurable: true, enumerable: false, writable: false });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Self-contained calls (one round trip each).

/**
 * Stops the page's timers (self-contained, no kit needed): run before the probe reloads the page, so
 * a timer that keeps assigning location.href cannot interrupt the reload.
 */
export function kitQuiet(): void {
  // No new timer or animation frame for the rest of this document's life (it is about to be replaced)…
  const w = window as unknown as Record<string, unknown>;
  const last = setTimeout(() => {}, 0) as unknown as number;
  const frame = requestAnimationFrame(() => {});
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
    Object.defineProperty(w, name, { value: function () { return 0; }, configurable: true, writable: true });
  }
  if ((w.setTimeout as () => number)() !== 0) throw new Error('the page\'s timers could not be stopped');
  // …and the ones already scheduled are cleared (ids count up from 1; at most the last million).
  for (let i = Math.max(1, last - 1_000_000); i <= last; i++) clearTimeout(i);
  for (let i = Math.max(1, frame - 1_000_000); i <= frame; i++) cancelAnimationFrame(i);
}

export const kitStart = () => (window as unknown as KitWindow).__grntedKb!.start();
export const kitStop = () => { (window as unknown as KitWindow).__grntedKb?.stop(); };
export const kitResetStart = () => (window as unknown as KitWindow).__grntedKb!.resetStart();
export const kitTopPrepare = () => (window as unknown as KitWindow).__grntedKb!.topPrepare();
export const kitTopFinish = () => (window as unknown as KitWindow).__grntedKb!.topFinish();
export const kitMeasure = () => (window as unknown as KitWindow).__grntedKb!.measure();
export const kitSettle = (a: { id: number; cap: number }) => (window as unknown as KitWindow).__grntedKb!.settle(a.id, a.cap);
export const kitMeasureKeyed = () => (window as unknown as KitWindow).__grntedKb!.measureKeyed();
export const kitHold = () => (window as unknown as KitWindow).__grntedKb!.hold();
export const kitStopAfter = (a: { key: 'Tab' | 'Shift'; n: number; cap: number }) => (window as unknown as KitWindow).__grntedKb!.stopAfter(a.key, a.n, a.cap);
export const kitRelease = () => (window as unknown as KitWindow).__grntedKb!.release();
export const kitSettleRemeasure = (a: { id: number; cap: number }) => (window as unknown as KitWindow).__grntedKb!.settleRemeasure(a.id, a.cap);
export const kitWaitRemeasure = (a: { id: number; ms: number }) => (window as unknown as KitWindow).__grntedKb!.waitRemeasure(a.id, a.ms);
export const kitFocusStyleShots = (a: { id: number; contrast: boolean }) => (window as unknown as KitWindow).__grntedKb!.focusStyleShots(a.id, a.contrast);
export const kitRefocusShots = (id: number) => (window as unknown as KitWindow).__grntedKb!.refocusShots(id);
export const kitTabOrder = (cap: number) => (window as unknown as KitWindow).__grntedKb!.tabOrder(cap);
export const kitRingClear = (a: { id: number; cover: string }) => (window as unknown as KitWindow).__grntedKb!.ringClear(a.id, a.cover);
export const kitFocusBefore = (id: number) => (window as unknown as KitWindow).__grntedKb!.focusBefore(id);
export const kitRemeasure = (id: number) => (window as unknown as KitWindow).__grntedKb!.remeasure(id);
export const kitActiveId = () => (window as unknown as KitWindow).__grntedKb!.activeId();
export const kitFocusStyle = () => (window as unknown as KitWindow).__grntedKb!.focusStyle();
export const kitBlur = (id: number) => (window as unknown as KitWindow).__grntedKb!.blur(id);
export const kitRefocus = (id: number) => (window as unknown as KitWindow).__grntedKb!.refocus(id);
export const kitFocusId = (id: number) => (window as unknown as KitWindow).__grntedKb!.focusId(id);
export const kitRefire = (id: number) => (window as unknown as KitWindow).__grntedKb!.refire(id);
export const kitNavCount = () => (window as unknown as KitWindow).__grntedKb!.navCount();
export const kitTabbables = (cap: number) => (window as unknown as KitWindow).__grntedKb!.tabbables(cap);
export const kitOutside = (members: number[]) => (window as unknown as KitWindow).__grntedKb!.outside(members);
export const kitTrapExits = (a: { members: number[]; pattern: string; max: number }) => (window as unknown as KitWindow).__grntedKb!.trapExits(a.members, a.pattern, a.max);
export const kitTrapRegion = (members: number[]) => (window as unknown as KitWindow).__grntedKb!.trapRegion(members);
export const kitSkipArm = (id: number) => (window as unknown as KitWindow).__grntedKb!.skipArm(id);
export const kitSkipScripted = (id: number) => (window as unknown as KitWindow).__grntedKb!.skipScripted(id);
export const kitSkipLanding = (id: number) => (window as unknown as KitWindow).__grntedKb!.skipLanding(id);
export const kitSkipAfter = (id: number) => (window as unknown as KitWindow).__grntedKb!.skipAfter(id);
export const kitRestore = (url: string) => (window as unknown as KitWindow).__grntedKb!.restore(url);
export const kitLayout = () => (window as unknown as KitWindow).__grntedKb!.layout();
export const kitToggleLinks = (id: number) => (window as unknown as KitWindow).__grntedKb!.toggleLinks(id);
export const kitClickables = (a: { refs: { ref: number; types: string[] }[]; max: number }) => (window as unknown as KitWindow).__grntedKb!.clickables(a.refs, a.max);
export const kitTake = () => (window as unknown as KitWindow).__grntedKb!.take();
export const kitKeyState = () => (window as unknown as KitWindow).__grntedKb!.keyState();
export const kitBlurAll = () => (window as unknown as KitWindow).__grntedKb!.blurAll();
export const kitControlMatching = (arg: { pattern: string; skip: string[] }) => (window as unknown as KitWindow).__grntedKb!.controlMatching(arg.pattern, arg.skip);
export const kitDescribe = (id: number) => (window as unknown as KitWindow).__grntedKb!.describe(id);
export const kitCloseDialog = (path: string) => (window as unknown as KitWindow).__grntedKb!.closeDialog(path);
export const kitBeforeKey = () => (window as unknown as KitWindow).__grntedKb!.beforeKey();
export const kitAfterKey = (ms: number) => (window as unknown as KitWindow).__grntedKb!.afterKey(ms);
export const kitByPath = (path: string) => (window as unknown as KitWindow).__grntedKb!.byPath(path);
export const kitCover = (id: number) => (window as unknown as KitWindow).__grntedKb!.cover(id);
export const kitCenter = (id: number) => (window as unknown as KitWindow).__grntedKb!.center(id);
export const kitScrollTo = (a: { x: number; y: number }) => (window as unknown as KitWindow).__grntedKb!.scrollTo(a.x, a.y);

export const kitTrapInstructions = (members: number[]) => (window as unknown as KitWindow).__grntedKb!.trapInstructions(members);
