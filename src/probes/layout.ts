// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Text layout measurements shared by the render probes (Plan 4 Task 4.2): reflow (1.4.10), text
// spacing (1.4.12) and resize text (1.4.4). The in-page functions (`textLayout`, `describeLayout`)
// only gather geometry; the pure functions below decide what counts as cut off, overlapping or out
// of reach, so the rules are unit-tested without a browser. Engine core: no Node-only imports.
import { clipWords } from '../clip.js';
import { isAnalyticsAddress } from '../analytics.js';
import { STATIC_FILE_HOSTS, blockedReason, isBackgroundWrite, onHostList } from './guard.js';
import type { GuardEvent, GuardLog, ProbeFinding } from './types.js';
import type { PageLike } from '../types.js';

/** The viewport and whether the page can scroll in each direction (html/body overflow). */
export interface LayoutView {
  /** Viewport size without scrollbars (CSS px). */
  w: number;
  h: number;
  /** The document's scrollable size. */
  scrollW: number;
  scrollH: number;
  /** The page can scroll sideways / up and down (the root overflow is not hidden or clip). */
  canScrollX: boolean;
  canScrollY: boolean;
}

/**
 * One tracked item in one layout: a text node ('t'), a control with text of its own ('c', its text is
 * tracked as 't' items) or a control without text, such as a form field or an icon button ('b').
 */
export interface LayoutItem {
  /** Rendered and not hidden (display, visibility, opacity 0), and not on its way out (a running transition taking its opacity to nothing). */
  v: 0 | 1;
  /**
   * The parts of its boxes in view after clipping by every ancestor's overflow (hidden, clip, auto,
   * scroll), as flat [x, y, w, h, …] in page px (scrolled to the top): the line boxes of a text node,
   * the border box of a control.
   */
  r: number[];
  /** Font size (px). */
  fs: number;
  /** The scale it is drawn at, when not 1 (CSS transforms and zoom of it and its ancestors; batch 18, round 2). */
  sc?: number;
  /**
   * 0: not cut off; 1: partly cut off by an ancestor's `overflow: hidden|clip` (more than a quarter of
   * a line's height, or half a character's width of a line or more); 2: entirely hidden by it.
   * Scrolling regions (`auto`, `scroll`) never cut: their content can be scrolled to.
   */
  cut: 0 | 1 | 2;
  /** Element-table index of the ancestor that cuts it off. */
  by?: number;
  /**
   * 1: part of it is outside its window at this instant, but ONE running animation carries every part of it
   * through the window in turn (a ticker): `cut` is then 0, because nothing of it is lost (`carriedThrough`).
   * 2: it is cut off at this instant and several running animations move it at once: whether all of it is shown
   * in turn is not known (`cut` is as measured; it is never failed and never clean on that: `movingFindings`).
   */
  mv?: 1 | 2;
  /** Positioned out of flow or moved by a transform (it or an ancestor is `position: absolute|fixed`, or has a `transform`). */
  pos?: 1;
  /** The node is no longer in the page (a script replaced it since the 'start' measurement). */
  gone?: 1;
  /**
   * Element-table index of the nearest sideways-scrolling region (`overflow-x: auto|scroll`) that is
   * narrower than one of the item's lines: reading that line means scrolling the region sideways.
   */
  hw?: number;
  /** With `hw`: the item's text wraps onto two or more lines (prose, not a ticker's single line). */
  wl?: 1;
  /**
   * Element-table index of the outermost `position: fixed` box it sits in (fixed to the viewport: no
   * transformed ancestor above it). Such a box does not scroll with the page.
   */
  fx?: number;
  /** Why reflow does not count it (WCAG 1.4.10 exceptions), e.g. 'table', 'code', 'media', 'scroll'. */
  ex?: string;
  /**
   * Only when the item reaches past the viewport's right edge: element-table index of the outermost
   * ancestor wider than the viewport, else of the nearest ancestor whose content overflows it.
   */
  wide?: number;
}

/** Facts about an element the items refer to (`by`, `wide`), in this layout. */
export interface LayoutElement {
  /** Border-box width (px). */
  w: number;
  /** Computed overflow-x / overflow-y. */
  ox: string;
  oy: string;
  /** Border-box height (px). */
  h: number;
  /** Shows an ellipsis or clamps lines on purpose (`text-overflow: ellipsis`, `line-clamp`). */
  truncates?: 1;
  /**
   * Looks like a carousel or sliding track: class names or aria-roledescription, a `<marquee>`, scroll
   * snapping, or a clipped (`overflow: hidden|clip`) track much wider than itself.
   */
  carousel?: 1;
  /**
   * A control is near it that might scroll it (`scrollControlled`): a clipped box with Previous/Next buttons can show
   * every line in turn, so its hidden lines are not testable, never a failure (Sol rounds 1 to 3, 1.4.4).
   */
  ctl?: 1;
}

export interface LayoutState {
  view: LayoutView;
  items: LayoutItem[];
  /** By element-table index. */
  els: Record<number, LayoutElement>;
}

export interface TextLayoutArgs {
  /** 'start' collects the text nodes and controls afresh and keeps them on the page; 'again' measures the kept ones. */
  phase: 'start' | 'again';
  /** Text nodes and controls tracked at most. */
  maxText: number;
  maxControls: number;
  /** CSS applied (as a constructed style sheet) for a second measurement inside the same call, then removed. */
  css?: string;
  /** Multiplies the root font size for the second measurement (inside the same call, then removed). */
  rootFontScale?: number;
}

export interface TextLayoutResult {
  /** One letter per tracked item: 't' text node, 'c' control with text, 'b' control without text. */
  kinds: string;
  /** More text nodes or controls than the caps. */
  truncated: boolean;
  before: LayoutState;
  /** The layout with `css` / `rootFontScale` applied. */
  after?: LayoutState;
}

/** The WCAG 1.4.12 text spacing values (the Understanding document's bookmarklet). */
export const TEXT_SPACING_CSS = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } '
  + 'p { margin-bottom: 2em !important; }';

export const LAYOUT_LIMITS = { maxText: 3000, maxControls: 600 } as const;

/**
 * Runs in the page (self-contained). Measures where the text and controls are and what of them the
 * ancestors' overflow cuts off. With `css` or `rootFontScale` it measures, applies the change as a
 * constructed style sheet, measures again and removes it within one task: the page never paints the
 * change and keeps no lasting change. The tracked nodes stay on `window.__grntedLayout` for an
 * `'again'` measurement (after a viewport change) and `describeLayout`, which removes them.
 */
export function textLayout(arg: TextLayoutArgs): TextLayoutResult {
  interface Stash { items: Node[]; kinds: string; els: Element[]; index: Map<Element, number>; truncated: boolean }
  const win = window as unknown as { __grntedLayout?: Stash };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'OPTION', 'OPTGROUP', 'DATALIST', 'SELECT', 'TEXTAREA']);
  const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  const WORD = /[\p{L}\p{N}]/u;
  const root = document.documentElement;
  const body = document.body ?? root;

  let stash = win.__grntedLayout;
  if (arg.phase === 'start' || !stash) {
    const items: Node[] = [];
    let kinds = '';
    let truncated = false;
    let texts = 0;
    // Icon fonts draw a word ("search", "menu") as one glyph: it is an icon, not text, and letter
    // spacing turns it back into the word.
    const ICON_FONT = /icon|material|symbol|awesome|glyph|fontello|ionic|dashicons/i;
    const iconFont = new Map<Element, boolean>();
    const isIcon = (el: Element) => {
      let v = iconFont.get(el);
      if (v === undefined) iconFont.set(el, (v = ICON_FONT.test((getComputedStyle(el).fontFamily.split(',')[0] ?? ''))));
      return v;
    };
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || !WORD.test(n.nodeValue ?? '') || p.closest('svg, math') || isIcon(p)) continue;
      if (texts >= arg.maxText) { truncated = true; break; }
      items.push(n);
      kinds += 't';
      texts++;
    }
    let controls = 0;
    for (const el of body.querySelectorAll(CONTROLS)) {
      if (el.closest('svg, math')) continue;
      if (controls >= arg.maxControls) { truncated = true; break; }
      items.push(el);
      kinds += WORD.test(el.textContent ?? '') ? 'c' : 'b';
      controls++;
    }
    stash = { items, kinds, els: [], index: new Map(), truncated };
    win.__grntedLayout = stash;
  }
  const st = stash;
  const elIndex = (el: Element): number => {
    let i = st.index.get(el);
    if (i === undefined) {
      i = st.els.length;
      st.els.push(el);
      st.index.set(el, i);
    }
    return i;
  };

  const measure = (): LayoutState => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    const sx = window.scrollX;
    const sy = window.scrollY;
    const styles = new Map<Element, CSSStyleDeclaration>();
    const scales = new Map<Element, number>();
    const scaleOf = (el: Element | null): number => {
      if (!el || el === document.documentElement) return 1;
      const hit = scales.get(el);
      if (hit !== undefined) return hit;
      const cs = getComputedStyle(el);
      let own = parseFloat((cs as CSSStyleDeclaration & { zoom?: string }).zoom ?? '1') || 1;
      const t = cs.transform;
      if (t && t !== 'none') {
        const m = /matrix\(([^)]+)\)/.exec(t);
        const v = m ? m[1]!.split(',').map(Number) : [];
        if (v.length >= 4) own *= Math.hypot(v[2]!, v[3]!) || 1;
      }
      const up = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
      const total = own * scaleOf(up);
      scales.set(el, total);
      return total;
    };
    const css = (el: Element) => {
      let s = styles.get(el);
      if (!s) styles.set(el, (s = getComputedStyle(el)));
      return s;
    };
    const rs = css(root);
    const bs = css(body);
    const scrolls = (o: string) => o === 'auto' || o === 'scroll';
    // The page's scroller: the viewport, unless the page scrolls an element of its own that fills the
    // screen (an app layout with html/body fixed in height and a scrolling wrapper, or a scrolling body
    // under an html with overflow hidden). That element counts as the viewport.
    const vw0 = root.clientWidth;
    const vh0 = root.clientHeight;
    let scroller: Element | null = null;
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.8], [0.25, 0.5]] as const) {
      for (let a = document.elementFromPoint(vw0 * fx, vh0 * fy); a && a !== root; a = a.parentElement) {
        const s = css(a);
        if (!scrolls(s.overflowY) || a.scrollHeight <= a.clientHeight + 1) continue;
        if (a === body ? rs.overflowY === 'visible' : false) continue; // body's overflow belongs to the viewport then
        const r = a.getBoundingClientRect();
        if (r.width >= 0.9 * vw0 && r.height >= 0.8 * vh0) { scroller = a; break; }
      }
      if (scroller) break;
    }
    if (scroller) scroller.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    const isRoot = (el: Element) => el === root || el === body || el === scroller;
    const vox = rs.overflowX !== 'visible' ? rs.overflowX : bs.overflowX;
    const voy = rs.overflowY !== 'visible' ? rs.overflowY : bs.overflowY;
    const sox = scroller ? css(scroller).overflowX : '';
    const view: LayoutView = scroller
      ? {
        w: vw0, h: vh0, scrollW: Math.max(root.scrollWidth, Math.round(scroller.getBoundingClientRect().left) + scroller.scrollWidth),
        scrollH: Math.max(root.scrollHeight, scroller.scrollHeight), canScrollX: scrolls(sox), canScrollY: true,
      }
      : {
        w: vw0, h: vh0, scrollW: root.scrollWidth, scrollH: root.scrollHeight,
        canScrollX: vox !== 'hidden' && vox !== 'clip', canScrollY: voy !== 'hidden' && voy !== 'clip',
      };
    // Containing blocks: what an absolutely or fixed positioned box escapes from.
    const holdsFixed = (s: CSSStyleDeclaration) => s.transform !== 'none' || s.perspective !== 'none' || s.filter !== 'none'
      || /paint|layout|strict|content/.test(s.contain) || /transform|perspective|filter/.test(s.willChange)
      || (s.getPropertyValue('backdrop-filter') || 'none') !== 'none';
    // Per axis: 0 the overflow shows, 1 it scrolls (auto/scroll: hidden from view but reachable),
    // 2 it is cut off (hidden/clip, or paint containment).
    const axes = new Map<Element, [number, number]>();
    const clipAxes = (el: Element): [number, number] => {
      let a = axes.get(el);
      if (!a) {
        const s = css(el);
        if (isRoot(el) || s.display === 'inline' || s.display === 'contents') a = [0, 0];
        else {
          const paint = /paint|strict|content/.test(s.contain);
          const kind = (o: string) => (paint || o === 'hidden' || o === 'clip' ? 2 : o === 'auto' || o === 'scroll' ? 1 : 0);
          a = [kind(s.overflowX), kind(s.overflowY)];
        }
        axes.set(el, a);
      }
      return a;
    };
    const clips = (el: Element) => clipAxes(el)[0] > 0 || clipAxes(el)[1] > 0;
    // Ancestors whose overflow clips this element's box, nearest first (html and body are the viewport).
    const boxCache = new Map<Element, Element[]>();
    const boxClippers = (el: Element): Element[] => {
      const known = boxCache.get(el);
      if (known) return known;
      const s = css(el);
      let a = el.parentElement;
      if (s.position === 'fixed') while (a && !isRoot(a) && !holdsFixed(css(a))) a = a.parentElement;
      else if (s.position === 'absolute') while (a && !isRoot(a) && css(a).position === 'static' && !holdsFixed(css(a))) a = a.parentElement;
      let list: Element[] = [];
      if (a && !isRoot(a)) list = clips(a) ? [a, ...boxClippers(a)] : boxClippers(a);
      boxCache.set(el, list);
      return list;
    };
    const posCache = new Map<Element, boolean>();
    const outOfFlow = (el: Element | null): boolean => {
      if (!el || isRoot(el)) return false;
      let v = posCache.get(el);
      if (v === undefined) {
        const s = css(el);
        v = s.position === 'absolute' || s.position === 'fixed' || s.transform !== 'none' || outOfFlow(el.parentElement);
        posCache.set(el, v);
      }
      return v;
    };
    // The outermost box fixed to the viewport (a fixed box inside a transformed ancestor scrolls with it).
    const fixedCache = new Map<Element, Element | null>();
    const fixedRoot = (el: Element | null): Element | null => {
      if (!el || isRoot(el)) return null;
      let v = fixedCache.get(el);
      if (v === undefined) {
        const up = fixedRoot(el.parentElement);
        if (up) v = up;
        else if (css(el).position === 'fixed') {
          let held = false;
          for (let a = el.parentElement; a && !isRoot(a); a = a.parentElement) if (holdsFixed(css(a))) { held = true; break; }
          v = held ? null : el;
        } else v = null;
        fixedCache.set(el, v);
      }
      return v;
    };
    const pads = new Map<Element, { l: number; t: number; r: number; b: number }>();
    const padBox = (el: Element) => {
      let p = pads.get(el);
      if (!p) {
        const r = el.getBoundingClientRect();
        const l = r.left + el.clientLeft;
        const t = r.top + el.clientTop;
        p = { l, t, r: l + el.clientWidth, b: t + el.clientHeight };
        pads.set(el, p);
      }
      return p;
    };
    // WCAG 1.4.10 exceptions: content that needs a two-dimensional layout, and own scrolling regions.
    const EXEMPT: [string, string][] = [
      ['code', 'pre, code, samp, kbd'],
      ['media', 'svg, canvas, video, audio, iframe, object, embed, img, picture, math, map, [role="img"], [role="math"], .leaflet-container, .mapboxgl-map, .maplibregl-map, .gm-style, .ol-viewport, .esri-view, .video-js, .plyr, .jwplayer, .mejs__container'],
      ['toolbar', '[role="toolbar"]'],
      ['app', '[role="application"], [role="grid"], [role="treegrid"]'],
    ];
    const dataTable = (t: Element) => {
      const role = t.getAttribute('role');
      if (role === 'presentation' || role === 'none') return false;
      return role === 'table' || role === 'grid' || !!t.querySelector('th, caption, thead, [scope]');
    };
    const scrollCache = new Map<Element, boolean>();
    const inScrollRegion = (el: Element | null): boolean => {
      if (!el || isRoot(el)) return false;
      let v = scrollCache.get(el);
      if (v === undefined) {
        const ox = css(el).overflowX;
        v = ((ox === 'auto' || ox === 'scroll') && padBox(el).r <= view.w + 1) || inScrollRegion(el.parentElement);
        scrollCache.set(el, v);
      }
      return v;
    };
    const exemptOf = (el: Element): string | undefined => {
      for (const [code, sel] of EXEMPT) if (el.closest(sel)) return code;
      const t = el.closest('table, [role="table"]');
      if (t && dataTable(t)) return 'table';
      if (inScrollRegion(el)) return 'scroll';
      return undefined;
    };
    /** Anything that takes focus and could be a control: buttons, links, fields, tabindex. */
    const CTL = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
    /**
     * Any control near a clipped box (lead's ruling, Sol round 3: the exemption is simplified, not patched): one whose
     * aria-controls names it, one inside it or in its parent, or one among the siblings of its parent or grandparent, at
     * any distance and with any name. Such a box's hidden lines are not testable (a control might scroll them into view),
     * never a failure: an unrelated Print button costs recall, never a false failure.
     */
    const scrollControlled = (el: Element): boolean => {
      if (el.id && document.querySelector(`[aria-controls~="${CSS.escape(el.id)}"]`)) return true;
      if (el.querySelector(CTL)) return true;
      const parent = el.parentElement;
      if (!parent) return false;
      if (Array.from(parent.querySelectorAll(CTL)).some((c) => !el.contains(c))) return true;
      for (let a: Element | null = parent, k = 0; a && k < 2 && a !== document.documentElement; a = a.parentElement, k++) {
        const up: Element | null = a.parentElement;
        if (!up) break;
        for (const sib of Array.from(up.children) as Element[]) if (sib !== a && (sib.matches(CTL) || sib.querySelector(CTL))) return true;
      }
      return false;
    };
    const els: Record<number, LayoutElement> = {};
    const describeEl = (el: Element): number => {
      const i = elIndex(el);
      if (!(i in els)) {
        const s = css(el);
        const r = el.getBoundingClientRect();
        const e: LayoutElement = { w: Math.round(r.width), h: Math.round(r.height), ox: s.overflowX, oy: s.overflowY };
        const clamp = s.getPropertyValue('-webkit-line-clamp') || s.getPropertyValue('line-clamp') || 'none';
        if (s.textOverflow === 'ellipsis' || clamp !== 'none') e.truncates = 1;
        let carousel = false;
        for (let a: Element | null = el, k = 0; a && !isRoot(a) && k < 4; a = a.parentElement, k++) {
          const name = `${typeof a.className === 'string' ? a.className : ''} ${a.id} ${a.getAttribute('aria-roledescription') ?? ''}`;
          // The <marquee> element moves its own content through itself, as a track named for it does.
          if (a.localName === 'marquee' || /carousel|slider|slick|swiper|splide|glide|flickity|owl-|slideshow|marquee|ticker|scroller/i.test(name)) { carousel = true; break; }
        }
        const snap = (s.getPropertyValue('scroll-snap-type') || 'none') !== 'none';
        if (carousel || snap || ((e.ox === 'hidden' || e.ox === 'clip') && el.scrollWidth > 1.5 * Math.max(el.clientWidth, 1))) e.carousel = 1;
        if (scrollControlled(el)) e.ctl = 1;
        els[i] = e;
      }
      return i;
    };
    const round = (x: number) => Math.round(x * 10) / 10;
    // Running animations (CSS animations, transitions, animations a script made) that move an element or what is in
    // it: on the element or an ancestor. Paused ones are left out: what they would show is not being shown.
    // `offset\w*` is the motion path (offset-path, offset-distance...). A keyframe's own fields (its `offset` in the
    // cycle, `computedOffset`, `easing`, `composite`) are on every keyframe, a colour's too: they move nothing (gold
    // hazard hazard-focus-hover-transition, batch 15b: colour-only transitions read as several movers).
    const MOVES = /^(?:transform|translate|rotate|scale|left|right|top|bottom|inset\w*|margin\w*|padding\w*|textIndent|offset\w*)$/;
    const KEYFRAME_FIELDS = new Set(['offset', 'computedOffset', 'easing', 'composite']);
    const moverCache = new Map<Element, Animation[]>();
    // Most pages have nothing running: then no element is asked for its animations.
    let anyRunning = true;
    try { anyRunning = document.getAnimations().some((a) => a.playState === 'running'); } catch { anyRunning = true; }
    /**
     * Whether an element is on its way out: a transition (or an animation that ends and holds its end) that is
     * under way now is taking its opacity, or an ancestor's, to nothing. Two slides in the middle of a cross-fade are both
     * on screen for a moment; the one fading out is read as what it is becoming (not shown), so that what is
     * measured does not depend on the moment of the measurement.
     */
    const fadeCache = new Map<Element, boolean>();
    const fadingOut = (el: Element | null): boolean => {
      if (!anyRunning || !el || isRoot(el)) return false;
      let v = fadeCache.get(el);
      if (v === undefined) {
        v = false;
        try {
          for (const an of typeof el.getAnimations === 'function' ? el.getAnimations() : []) {
            const effect = an.effect as KeyframeEffect | null;
            if (an.playState !== 'running' || !effect || effect.pseudoElement) continue;
            const frames = effect.getKeyframes();
            if (!frames.some((f) => 'opacity' in f)) continue;
            const t = effect.getComputedTiming();
            // Only a fade that is under way (review r2, finding 4): its delay is over and it has made some progress. One
            // that has not begun (a delay of an hour) leaves the content as visible as it is now.
            const local = Number(t.localTime ?? an.currentTime);
            if (!(typeof t.progress === 'number' && t.progress > 0 && Number.isFinite(local) && local > (Number(t.delay) || 0))) continue;
            // A transition ends at its last keyframe and stays there; an animation only when it is finite and holds its end.
            const transition = 'transitionProperty' in an;
            const holds = transition || (Number.isFinite(Number(t.iterations)) && (t.fill === 'forwards' || t.fill === 'both') && (t.direction === 'normal' || t.direction === 'reverse'));
            if (!holds) continue;
            const end = !transition && t.direction === 'reverse' ? frames[0] : frames[frames.length - 1];
            const to = parseFloat(String((end as Record<string, unknown> | undefined)?.opacity ?? ''));
            if (Number.isFinite(to) && to <= 0.01) { v = true; break; }
          }
        } catch {
          v = false;
        }
        if (!v) v = fadingOut(el.parentElement);
        fadeCache.set(el, v);
      }
      return v;
    };
    const moversOf = (el: Element): Animation[] => {
      const out: Animation[] = [];
      if (!anyRunning) return out;
      for (let a: Element | null = el, k = 0; a && !isRoot(a) && k < 40; a = a.parentElement, k++) {
        let own = moverCache.get(a);
        if (!own) {
          own = [];
          try {
            for (const an of typeof a.getAnimations === 'function' ? a.getAnimations() : []) {
              if (an.playState !== 'running') continue;
              const frames = (an.effect as KeyframeEffect | null)?.getKeyframes?.() ?? [];
              if (frames.some((f) => Object.keys(f).some((key) => !KEYFRAME_FIELDS.has(key) && MOVES.test(key)))) own.push(an);
            }
          } catch {
            own = [];
          }
          moverCache.set(a, own);
        }
        out.push(...own);
      }
      return out;
    };
    /**
     * Whether the running animations that move an item show every part of it in turn. Each animation is set to
     * points through its present cycle (12, then 48 if that does not settle it), the item's boxes are read at
     * each, and what its window leaves in view is added up in the item's own coordinates: carried through when,
     * of every box, no more is left unseen than the test allows a still box to lose (`sideLoss` sideways with its
     * height in view, or a quarter of its height with its width in view). The animations are put back where they
     * were within the same task, so the page never paints a step of this and keeps no change.
     */
    const carriedThrough = (
      movers: Animation[], read: () => DOMRect[],
      clip: (b: DOMRect) => { cut: { l: number; t: number; r: number; b: number } }, first: DOMRect[], sideLoss: number,
    ): boolean => {
      const saved = movers.map((a) => a.currentTime);
      // The present cycle of each: where it starts on the animation's own clock, and how long it is.
      const cycles = movers.map((a) => {
        try {
          const t = (a.effect as KeyframeEffect).getComputedTiming();
          const d = Number(t.duration);
          if (t.currentIteration === null || t.currentIteration === undefined || !Number.isFinite(d) || d <= 0) return null;
          return { from: (Number(t.delay) || 0) + t.currentIteration * d, d };
        } catch {
          return null;
        }
      });
      if (!cycles.some((c) => c)) return false;
      const across: [number, number][][] = first.map(() => []);
      const down: [number, number][][] = first.map(() => []);
      /** How much of 0..len no interval covers. */
      const unseen = (list: [number, number][], len: number) => {
        let at = 0;
        let gap = 0;
        for (const [from, to] of [...list].sort((p, q) => p[0] - q[0])) {
          if (from > at) gap += Math.min(from, len) - at;
          at = Math.max(at, Math.min(to, len));
          if (at >= len) break;
        }
        return gap + Math.max(0, len - at);
      };
      let shown = false;
      try {
        for (const n of [12, 48]) {
          for (let k = 0; k < n; k++) {
            movers.forEach((a, i) => { const c = cycles[i]; if (c) a.currentTime = c.from + ((k + 0.5) / n) * c.d; });
            const now = read();
            // A step that lays the lines out differently (or resizes them) is not compared box for box.
            if (now.length !== first.length) continue;
            now.forEach((b, j) => {
              const f = first[j]!;
              if (Math.abs(b.width - f.width) > 1 || Math.abs(b.height - f.height) > 1) return;
              const { cut } = clip(b);
              const cw = Math.max(0, cut.r - cut.l);
              const ch = Math.max(0, cut.b - cut.t);
              if (cw * ch <= 1) return;
              if (b.height - ch <= 0.25 * b.height) across[j]!.push([cut.l - b.left, cut.r - b.left]);
              if (b.width - cw < sideLoss) down[j]!.push([cut.t - b.top, cut.b - b.top]);
            });
          }
          shown = first.every((f, j) => unseen(across[j]!, f.width) < sideLoss || unseen(down[j]!, f.height) <= 0.25 * f.height);
          if (shown) break;
        }
      } catch {
        shown = false;
      } finally {
        movers.forEach((a, i) => { try { a.currentTime = saved[i] ?? null; } catch { /* the animation is gone */ } });
      }
      return shown;
    };
    const items: LayoutItem[] = [];
    const range = document.createRange();
    for (const [k, node] of st.items.entries()) {
      const isText = st.kinds[k] === 't';
      const el = (isText ? node.parentElement : node) as Element | null;
      if (!el || !node.isConnected) {
        items.push({ v: 0, r: [], fs: 0, cut: 0, gone: 1 });
        continue;
      }
      const visible = (typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        : css(el).display !== 'none' && css(el).visibility !== 'hidden') && !fadingOut(el);
      const fs = parseFloat(css(el).fontSize) || 0;
      // Batch 18, round 2: the scale the element is drawn at (CSS transforms and zoom of it and its ancestors), so a
      // page that scales a fixed design to the window (a "scale to fit" stage) shows its text not growing at zoom.
      const sc = scaleOf(el);
      const readBoxes = (): DOMRect[] => {
        if (isText) {
          // The glyphs only: white space at either end of the text adds width (a trailing space before a wrap)
          // that no one sees, so half a character of it past an edge is no loss of text.
          const t = node.nodeValue ?? '';
          const lead = t.length - t.trimStart().length;
          const end = t.trimEnd().length;
          if (end > lead) { range.setStart(node, lead); range.setEnd(node, end); } else range.selectNodeContents(node);
          return [...range.getClientRects()].filter((b) => b.width >= 0.5 && b.height >= 0.5).slice(0, 60);
        }
        const b = el.getBoundingClientRect();
        return b.width >= 0.5 && b.height >= 0.5 ? [b] : [];
      };
      const boxes: DOMRect[] = visible ? readBoxes() : [];
      if (!boxes.length) {
        items.push({ v: 0, r: [], fs, cut: 0, ...(Math.abs(sc - 1) > 0.01 ? { sc: Math.round(sc * 1000) / 1000 } : {}) });
        continue;
      }
      const clippers = isText && clips(el) ? [el, ...boxClippers(el)] : boxClippers(el);
      const r: number[] = [];
      let hiddenAll = true;
      let cutAny = false;
      let reachesRight = false;
      let by: Element | undefined;
      let hw: Element | undefined;
      // One box of the item: `cut` is what hidden/clip overflow leaves of it; `seen` what every clipping ancestor leaves in view.
      const clipBox = (b: DOMRect) => {
        const cut = { l: b.left, t: b.top, r: b.right, b: b.bottom };
        const seen = { ...cut };
        let cutter: Element | undefined;
        // Inside a scrolling region, an outer hidden overflow cuts the text only where it cuts the region
        // itself: the text can be scrolled into the region's box (ACT 59br37 passed example 4).
        let scrollX: { l: number; r: number } | undefined;
        let scrollY: { t: number; b: number } | undefined;
        for (const c of clippers) {
          const [cx, cy] = clipAxes(c);
          const p = padBox(c);
          const area = Math.max(0, cut.r - cut.l) * Math.max(0, cut.b - cut.t);
          if (cx) { seen.l = Math.max(seen.l, p.l); seen.r = Math.min(seen.r, p.r); }
          if (cy) { seen.t = Math.max(seen.t, p.t); seen.b = Math.min(seen.b, p.b); }
          if (cx === 2 && (!scrollX || p.l > scrollX.l + 1 || p.r < scrollX.r - 1)) { cut.l = Math.max(cut.l, p.l); cut.r = Math.min(cut.r, p.r); }
          if (cy === 2 && (!scrollY || p.t > scrollY.t + 1 || p.b < scrollY.b - 1)) { cut.t = Math.max(cut.t, p.t); cut.b = Math.min(cut.b, p.b); }
          if (cx === 1 && !scrollX) scrollX = { l: p.l, r: p.r };
          if (cy === 1 && !scrollY) scrollY = { t: p.t, b: p.b };
          if (!cutter && Math.max(0, cut.r - cut.l) * Math.max(0, cut.b - cut.t) < area - 0.5) cutter = c;
        }
        return { cut, seen, cutter };
      };
      // Half a character's width or more cut off sideways (2026-11-07, simulation lab: justified text exactly 8 px
      // past a 320 px edge at 16 px was read as not cut, so the loss of real glyphs went unreported).
      const sideLoss = Math.max(4, fs * 0.5) - 0.01;
      for (const b of boxes) {
        // A line wider than a sideways-scrolling region it sits in.
        if (isText && !hw) for (const c of clippers) if (clipAxes(c)[0] === 1 && b.width > c.clientWidth + 1) { hw = c; break; }
        const { cut, seen, cutter } = clipBox(b);
        if (!by && cutter) by = cutter;
        const cw = Math.max(0, cut.r - cut.l);
        const ch = Math.max(0, cut.b - cut.t);
        if (cw * ch <= 1) { cutAny = true; continue; }
        hiddenAll = false;
        if (b.height - ch > 0.25 * b.height || b.width - cw >= sideLoss) cutAny = true;
        const vw = Math.max(0, seen.r - seen.l);
        const vh = Math.max(0, seen.b - seen.t);
        if (vw * vh <= 1) continue; // scrolled out of view inside its own scrolling region
        if (seen.r > view.w + 1) reachesRight = true;
        r.push(round(seen.l + sx), round(seen.t + sy), round(vw), round(vh));
      }
      // Cut off at this instant, and something is moving it: a line that a running animation carries through its
      // window in turn is not lost, wherever the animation happens to be now.
      let carried = false;
      let unsure = false;
      if (hiddenAll || cutAny) {
        const movers = moversOf(el);
        // Several animations at once (review r2, finding 3): each would be sampled on its own clock, so the samples
        // do not show where the text really is at any one moment (two that cancel each other out leave it still).
        // They prove nothing either way: the item stays as measured and is marked as not known (`mv` 2).
        if (movers.length > 1) unsure = true;
        else if (movers.length) carried = carriedThrough(movers, readBoxes, clipBox, boxes, sideLoss);
      }
      if (carried) { hiddenAll = false; cutAny = false; }
      const item: LayoutItem = { v: 1, r, fs, cut: hiddenAll ? 2 : cutAny ? 1 : 0 };
      if (Math.abs(sc - 1) > 0.01) item.sc = Math.round(sc * 1000) / 1000;
      if (carried) item.mv = 1;
      else if (unsure) item.mv = 2;
      if (item.cut && by) item.by = describeEl(by);
      if (outOfFlow(el)) item.pos = 1;
      if (hw) {
        item.hw = describeEl(hw);
        if (new Set(boxes.map((b) => Math.round(b.top))).size > 1) item.wl = 1;
      }
      const fixed = fixedRoot(el);
      if (fixed) item.fx = describeEl(fixed);
      const ex = exemptOf(el);
      if (ex) item.ex = ex;
      // When the item reaches past the right edge: the outermost ancestor wider than the viewport,
      // else the nearest one whose content overflows it (e.g. a row that does not wrap).
      if (reachesRight) {
        let wide: Element | undefined;
        let overflowing: Element | undefined;
        for (let a: Element | null = el; a && !isRoot(a); a = a.parentElement) {
          if (css(a).display === 'inline') continue;
          const b = a.getBoundingClientRect();
          if (b.right > view.w + 1 && b.width > view.w + 1) wide = a;
          if (!overflowing && a.scrollWidth > a.clientWidth + 1) overflowing = a;
        }
        const culprit = wide ?? overflowing;
        if (culprit) item.wide = describeEl(culprit);
      }
      items.push(item);
    }
    range.detach();
    return { view, items, els };
  };

  const before = measure();
  let after: LayoutState | undefined;
  if (arg.css || arg.rootFontScale) {
    let text = arg.css ?? '';
    if (arg.rootFontScale) {
      const px = parseFloat(getComputedStyle(root).fontSize) || 16;
      text += ` html { font-size: ${px * arg.rootFontScale}px !important; }`;
    }
    const doc = document as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
    if (Array.isArray(doc.adoptedStyleSheets) && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      // A copy: the property is a live array, so the original would grow with the new sheet.
      const previous = [...doc.adoptedStyleSheets];
      doc.adoptedStyleSheets = [...previous, sheet];
      // Batch 18 (V95): an author `!important` rule beats the sheet's `*` rule, so the spacing never reaches that text;
      // a person's own style sheet (or an extension's inline style) would win over it. Where the spacing did not take,
      // it is set on the element inline with !important for the measurement, and put back in the same task.
      const forced: { el: HTMLElement; was: [string, string, string][] }[] = [];
      if (/letter-spacing/.test(text)) {
        const PROPS = ['letter-spacing', 'word-spacing', 'line-height'] as const;
        const seenEl = new Set<Element>();
        for (let i = 0; i < st.items.length && forced.length < 500; i++) {
          if (st.kinds[i] !== 't') continue;
          const el = (st.items[i] as Node).parentElement as HTMLElement | null;
          if (!el || seenEl.has(el)) continue;
          seenEl.add(el);
          const cs = getComputedStyle(el);
          const fs = parseFloat(cs.fontSize) || 16;
          const ls = parseFloat(cs.letterSpacing);
          const lh = parseFloat(cs.lineHeight);
          const took = Math.abs((Number.isFinite(ls) ? ls : 0) - 0.12 * fs) <= 0.5 && (!Number.isFinite(lh) || Math.abs(lh - 1.5 * fs) <= 1);
          if (took) continue;
          forced.push({ el, was: PROPS.map((k) => [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)] as [string, string, string]) });
          el.style.setProperty('letter-spacing', '0.12em', 'important');
          el.style.setProperty('word-spacing', '0.16em', 'important');
          el.style.setProperty('line-height', '1.5', 'important');
        }
      }
      try { after = measure(); } finally {
        for (const f of forced) for (const [k, v, pr] of f.was) { if (v) f.el.style.setProperty(k, v, pr); else f.el.style.removeProperty(k); }
        doc.adoptedStyleSheets = previous;
      }
    } else {
      const style = document.createElement('style');
      style.textContent = text;
      (document.head ?? root).appendChild(style);
      try { after = measure(); } finally { style.remove(); }
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }
  return { kinds: st.kinds, truncated: st.truncated, before, ...(after ? { after } : {}) };
}

export interface LayoutDescription {
  /** By item index: the CSS path of the text's element (or the control) and an excerpt of its text. */
  items: Record<number, { path: string; text: string }>;
  /** By element-table index. */
  els: Record<number, { path: string; text: string }>;
}

/**
 * Runs in the page (self-contained): CSS paths and text excerpts for the items and elements the
 * probe reports, from the nodes `textLayout` kept. `drop` removes them from the page.
 */
export function describeLayout(arg: { items: number[]; els: number[]; drop?: boolean }): LayoutDescription {
  const win = window as unknown as { __grntedLayout?: { items: Node[]; kinds: string; els: Element[] } };
  const st = win.__grntedLayout;
  const out: LayoutDescription = { items: {}, els: {} };
  if (!st) return out;
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const clean = (s: string | null | undefined, max: number) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    const rootNode = el.getRootNode() as Document | ShadowRoot;
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && rootNode.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const name = esc(cur.localName);
      if (!parent) { parts.unshift(name); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
    }
    return parts.join(' > ');
  };
  const nameOf = (el: Element) => {
    const labels = (el as HTMLInputElement).labels;
    const label = labels && labels.length ? labels[0]!.textContent : '';
    return clean(el.getAttribute('aria-label') || el.textContent || label || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || (el as HTMLInputElement).value, 80);
  };
  for (const i of arg.items) {
    const node = st.items[i];
    if (!node) continue;
    const el = st.kinds[i] === 't' ? node.parentElement : (node as Element);
    if (!el) continue;
    out.items[i] = { path: cssPath(el), text: st.kinds[i] === 't' ? clean(node.nodeValue, 80) : nameOf(el) };
  }
  for (const i of arg.els) {
    const el = st.els[i];
    if (el) out.els[i] = { path: cssPath(el), text: clean(el.textContent, 80) };
  }
  if (arg.drop) delete win.__grntedLayout;
  return out;
}

/** Runs in the page (self-contained): forgets the nodes `textLayout` kept. */
export function dropLayout(): void {
  delete (window as unknown as { __grntedLayout?: unknown }).__grntedLayout;
}

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested).

export type Box = [x: number, y: number, w: number, h: number];

/** The item's visible boxes. */
export function boxesOf(item: LayoutItem): Box[] {
  const out: Box[] = [];
  for (let i = 0; i + 3 < item.r.length; i += 4) out.push([item.r[i]!, item.r[i + 1]!, item.r[i + 2]!, item.r[i + 3]!]);
  return out;
}

/** Overlap thresholds: at least this wide, and this tall (px or share of the shorter box). */
export const OVERLAP = { minWidth: 4, minHeight: 3, minShare: 0.3 } as const;

/** Two boxes overlap enough to make text unreadable (not just touching lines). */
export function boxesOverlap(a: Box, b: Box): boolean {
  const iw = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return iw >= OVERLAP.minWidth && ih >= Math.max(OVERLAP.minHeight, OVERLAP.minShare * Math.min(a[3], b[3]));
}

/**
 * Pairs of visible text items whose boxes overlap, as "i:j" keys (i < j). `skip` leaves items out
 * (e.g. reflow's exempt content). Text in a box fixed to the screen and text that is not (or is in
 * another fixed box) are never a pair: the page scrolls under a fixed banner or header, and a fixed
 * box that outgrows the screen is `fixedOverflow`. A sweep over boxes sorted by top keeps this
 * near-linear.
 */
export function overlapPairs(state: LayoutState, kinds: string, skip?: (item: LayoutItem, i: number) => boolean): Set<string> {
  const all: { i: number; b: Box; fx: number }[] = [];
  state.items.forEach((item, i) => {
    if (kinds[i] !== 't' || !item.v || item.cut === 2 || skip?.(item, i)) return;
    for (const b of boxesOf(item)) all.push({ i, b, fx: item.fx ?? -1 });
  });
  all.sort((p, q) => p.b[1] - q.b[1]);
  const pairs = new Set<string>();
  const active: { i: number; b: Box; fx: number }[] = [];
  for (const cur of all) {
    const top = cur.b[1];
    for (let k = active.length - 1; k >= 0; k--) if (active[k]!.b[1] + active[k]!.b[3] <= top) active.splice(k, 1);
    for (const other of active) {
      if (other.i === cur.i || other.fx !== cur.fx || !boxesOverlap(other.b, cur.b)) continue;
      pairs.add(other.i < cur.i ? `${other.i}:${cur.i}` : `${cur.i}:${other.i}`);
    }
    active.push(cur);
  }
  return pairs;
}

/** Overlapping text pairs in `after` that did not overlap in `before`, as [i, j]. */
export function newOverlaps(before: LayoutState, after: LayoutState, kinds: string, skip?: (item: LayoutItem, i: number) => boolean): [number, number][] {
  const old = overlapPairs(before, kinds, skip);
  return [...overlapPairs(after, kinds, skip)].filter((k) => !old.has(k)).map((k) => k.split(':').map(Number) as [number, number]);
}

/**
 * `overlapPlaces(newOverlaps(before, after, kinds, skip))`, the same places in the same order, without building every
 * overlapping pair: the pairs of `after` are judged as the sweep finds them (one already reported, or overlapping in
 * `before` too, is passed over), so memory stays in proportion to the items however many of them collide (Sol popup-r3
 * 14: 1,500 colliding lines are over a million pairs).
 */
export function newOverlapPlaces(before: LayoutState, after: LayoutState, kinds: string, skip?: (item: LayoutItem, i: number) => boolean, kind = 'overlap'): LayoutPlace[] {
  const counts = (state: LayoutState, i: number) => {
    const item = state.items[i];
    return !!item && kinds[i] === 't' && !!item.v && item.cut !== 2 && !skip?.(item, i);
  };
  // As `overlapPairs(before)` would have it: both counted there, in the same fixed box, and boxes that overlap.
  const overlappedBefore = (i: number, j: number) => {
    if (!counts(before, i) || !counts(before, j)) return false;
    const a = before.items[i]!;
    const b = before.items[j]!;
    if ((a.fx ?? -1) !== (b.fx ?? -1)) return false;
    const bs = boxesOf(b);
    return boxesOf(a).some((x) => bs.some((y) => boxesOverlap(x, y)));
  };
  const all: { i: number; b: Box; fx: number }[] = [];
  after.items.forEach((item, i) => {
    if (kinds[i] !== 't' || !item.v || item.cut === 2 || skip?.(item, i)) return;
    for (const b of boxesOf(item)) all.push({ i, b, fx: item.fx ?? -1 });
  });
  all.sort((p, q) => p.b[1] - q.b[1]);
  const seen = new Set<number>();
  const out: LayoutPlace[] = [];
  const active: typeof all = [];
  for (const cur of all) {
    const top = cur.b[1];
    for (let k = active.length - 1; k >= 0; k--) if (active[k]!.b[1] + active[k]!.b[3] <= top) active.splice(k, 1);
    for (const other of active) {
      if (other.i === cur.i || other.fx !== cur.fx || !boxesOverlap(other.b, cur.b)) continue;
      const i = Math.min(other.i, cur.i);
      const j = Math.max(other.i, cur.i);
      if (seen.has(i) || seen.has(j) || overlappedBefore(i, j)) continue;
      seen.add(i);
      seen.add(j);
      out.push({ kind, items: [i, j] });
    }
    active.push(cur);
  }
  return out;
}

/**
 * Text (and controls without text) that the change cut off: visible and not cut off before, cut off
 * (partly or, unless `partialOnly`, entirely) after.
 */
export function newlyCut(before: LayoutState, after: LayoutState, kinds: string, opts: { partialOnly?: boolean; skip?: (item: LayoutItem, i: number) => boolean } = {}): number[] {
  const out: number[] = [];
  after.items.forEach((a, i) => {
    const b = before.items[i];
    if ((kinds[i] !== 't' && kinds[i] !== 'b') || !b || !b.v || !a.v || b.cut !== 0 || a.cut === 0) return;
    // Moved by several animations at once: not known, never a failure (`movingFindings` says so).
    if (a.mv === 2 || b.mv === 2) return;
    if (opts.partialOnly && a.cut !== 1) return;
    const by = a.by !== undefined ? after.els[a.by] : undefined;
    if (by?.truncates) return; // an ellipsis or line clamp on purpose
    if (opts.skip?.(a, i)) return;
    out.push(i);
  });
  return out;
}

/** The part of the page a user can reach horizontally: the scroll width if the page scrolls sideways, else the viewport. */
export function reachableWidth(view: LayoutView): number {
  return view.canScrollX ? Math.max(view.w, view.scrollW) : view.w;
}

/** How far the item reaches past the left or right edge of the reachable area (px; 0 when inside). */
export function pastEdge(item: LayoutItem, limit: number): number {
  let worst = 0;
  for (const [x, , w] of boxesOf(item)) worst = Math.max(worst, x + w - limit, -x);
  return worst;
}

/**
 * Items (text or controls) inside the reachable width before the change and more than half outside it
 * after. Not counted: positioned or transformed content moved entirely out (a closed off-canvas menu).
 */
export function pushedOutOfReach(before: LayoutState, after: LayoutState): number[] {
  const out: number[] = [];
  const limBefore = reachableWidth(before.view) + 1;
  const limAfter = reachableWidth(after.view) + 1;
  after.items.forEach((a, i) => {
    const b = before.items[i];
    if (!b?.v || !a.v || b.cut === 2 || a.cut === 2 || a.ex === 'scroll' || pastEdge(b, limBefore) > 1) return;
    let total = 0;
    let outside = 0;
    for (const [x, , w, h] of boxesOf(a)) {
      total += w * h;
      outside += (Math.max(0, x + w - Math.max(x, limAfter)) + Math.max(0, Math.min(x + w, 0) - x)) * h;
    }
    if (a.pos && total > 0 && outside >= total - 0.5) return;
    if (total > 0 && outside / total > 0.5) out.push(i);
  });
  return out;
}

/** Share of the text visible before that a script took out of the page by the time of `now` (0–1). */
export function goneShare(before: LayoutState, now: LayoutState, kinds: string): number {
  let seen = 0;
  let gone = 0;
  before.items.forEach((b, i) => {
    if (kinds[i] !== 't' || !b.v) return;
    seen++;
    if (now.items[i]?.gone) gone++;
  });
  return seen ? gone / seen : 0;
}

/** Why a test's measurement cannot be trusted after what the request guard did while it ran. */
export interface GuardStop {
  reason: string;
  /** The page tried to go to another address (held): nothing measured after it is about this page. */
  navigation: boolean;
}

/** Files a page loads to show itself. */
const PAGE_FILE_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'texttrack', 'manifest']);

/**
 * What the request guard did while a test ran that makes its measurement untrustworthy: a navigation
 * it held (the page wanted to show another address), or any request it blocked except:
 * - a write to an analytics or telemetry service (`isBackgroundWrite`);
 * - a beacon (`sendBeacon`, `<a ping>`): the page can read nothing back from it, so blocking it cannot
 *   change what the test measures;
 * - a static file stopped only for its action-like address (/assets/cart.js);
 * - a request to an analytics service or a public static-file server (`isAnalyticsAddress`,
 *   `STATIC_FILE_HOSTS`) at an address, query left out, the page already asked for before the test
 *   (`background`). A request to any other host, the page's own site included, ends the test however
 *   often the page made it before.
 */
export function guardStopped(events: readonly GuardEvent[], background: readonly GuardEvent[] = []): GuardStop | undefined {
  const nav = events.find((e) => e.kind === 'navigation');
  if (nav) {
    return {
      navigation: true,
      reason: `the page tried to go to another address during the test (${nav.url ?? 'unknown'}); the test holds such navigations, so the page could not be measured`,
    };
  }
  const key = (e: GuardEvent) => `${e.method ?? ''} ${(e.url ?? '').split(/[?#]/)[0]}`;
  const listed = (e: GuardEvent) => isAnalyticsAddress(e.url) || onHostList(e.url, STATIC_FILE_HOSTS);
  const known = new Set(background.filter((e) => e.kind === 'blocked' && listed(e)).map(key));
  // A static file stopped only for its action-like address (/assets/cart.js) is not the page sending
  // anything: it stays blocked, and the measurement stands.
  const block = events.find((e) => e.kind === 'blocked' && !isBackgroundWrite(e) && e.resourceType !== 'ping' && e.resourceType !== 'beacon' && !(listed(e) && known.has(key(e))) &&
    !(e.reason === 'action' && PAGE_FILE_TYPES.has(e.resourceType ?? '')));
  return block ? { navigation: false, reason: blockedReason(block) } : undefined;
}

/** `guardStopped` for what happened since `mark`, with everything before it as the page's background traffic. */
export function stoppedSince(log: GuardLog, mark: number): GuardStop | undefined {
  return guardStopped(log.since(mark), log.events.slice(0, mark));
}

/**
 * Content in a box fixed to the viewport that runs past its top or bottom edge: it cannot be scrolled
 * to. One place per fixed box, listing the items outside. A fixed box entirely outside (a closed
 * sheet moved off screen, up, down or sideways) is not counted, nor are the exceptions or items in `not`.
 */
export function fixedOverflow(state: LayoutState, kinds: string, not: ReadonlySet<number> = new Set()): LayoutPlace[] {
  const h = state.view.h;
  const groups = new Map<number, { inside: boolean; out: number[] }>();
  state.items.forEach((it, i) => {
    if ((kinds[i] !== 't' && kinds[i] !== 'b') || !it.v || it.cut === 2 || it.fx === undefined || it.ex) return;
    let g = groups.get(it.fx);
    if (!g) groups.set(it.fx, (g = { inside: false, out: [] }));
    // Batch 19 (real-site dev split): text in a fixed box moved off the screen sideways (a closed drawer menu at
    // left: 100%) is not shown at all: it is no content the box keeps from being scrolled to.
    const boxes = boxesOf(it);
    if (!boxes.some(([x, , bw]) => x + bw > 0 && x < state.view.w)) return;
    let past = false;
    let within = false;
    for (const [, y, , bh] of boxes) {
      if (y < -1 || y + bh > h + 1) past = true;
      if (y + bh > 0 && y < h) within = true;
    }
    if (within) g.inside = true;
    if (past && !not.has(i)) g.out.push(i);
  });
  return [...groups.entries()].filter(([, g]) => g.inside && g.out.length).map(([el, g]) => ({ kind: 'fixed', el, items: g.out }));
}

/** Shortens text for evidence (batch 19: at a word boundary, src/clip.ts). */
export function excerpt(s: string, max = 60): string {
  return clipWords(s.replace(/\s+/g, ' ').trim(), max);
}

/** Groups item indexes by a key (first-seen order), e.g. by the container that cuts them off. */
export function groupBy<T>(list: readonly number[], key: (i: number) => T): Map<T, number[]> {
  const m = new Map<T, number[]>();
  for (const i of list) {
    const k = key(i);
    const g = m.get(k);
    if (g) g.push(i);
    else m.set(k, [i]);
  }
  return m;
}

/** One place a probe reports: the element it points at (`el`, else the first item's element) and the items involved. */
export interface LayoutPlace {
  kind: string;
  el?: number;
  items: number[];
}

/** What stands after cut-off text: a control named for the full text, and whether using it was verified to give that text. */
export interface ExcerptWays {
  /** Containers (tracked indexes) whose control was verified to lead to their full text. */
  verified: number[];
  /** Containers with such a control that could not be verified, with the control's name. */
  unverified: { el: number; name: string }[];
}

/** Excerpt links followed per call, the time for each fetch, and the time its page may take to lay out (`renderMs`). */
export const EXCERPT_LIMITS = { fetches: 3, fetchMs: 3000, renderMs: 2000, textMin: 20 } as const;

/**
 * Runs in the page (self-contained, async): of the tracked containers whose text is cut off, the ones followed by
 * (or whose next element only holds) a link or button named for the full text ("Read more", "Full text of the
 * poem", "Continue reading"), and for each whether the full text is verified to be where the control leads:
 * - a link to an element on the same page that holds the container's text and shows all of it;
 * - a link to a page on the same site that holds the container's text and shows all of it (its markup is fetched
 *   once, kept for the other layout tests of the page, and laid out with its own styles in a frame where nothing
 *   runs; never an address that looks like an action).
 * "Shows all of it" (review r2, finding 7): the element that holds the text is rendered and visible, and no
 * ancestor's hidden overflow cuts any of it off (a one-line box, a line clamp, a closed panel). Text that is only
 * present in the markup proves nothing.
 * A button, a link that goes nowhere ("#"), a link to another site, a page that could not be fetched or laid out,
 * or one that does not show the whole text: not verified. The caller reports those as not testable, never as fine.
 */
export async function excerptWays(arg: { els: number[]; fetches: number; fetchMs: number; renderMs: number; textMin: number }): Promise<ExcerptWays> {
  const st = (window as unknown as { __grntedLayout?: { els: Element[] } }).__grntedLayout;
  const out: ExcerptWays = { verified: [], unverified: [] };
  if (!st) return out;
  const MORE = /\b(read|view|see|show|continue)\b[^.]{0,30}\b(more|full|all|whole|rest|article|story|text|details|reading)\b|^more\b|\bfull (text|article|story|version|description)\b/i;
  const ACTION = /(log-?out|sign-?out|delete|remove|unsubscribe|cancel|destroy|logoff)/i;
  const norm = (x: string | null | undefined) => (x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const words = (el: Element) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  const control = (el: Element | null): Element | null => {
    if (!el) return null;
    const link = el.matches('a[href], button, summary, [role="button"], [role="link"]') ? el : el.children.length <= 1 ? el.querySelector('a[href], button') : null;
    if (!link) return null;
    const name = words(link);
    return name.length <= 60 && MORE.test(name) && (el === link || words(el).length <= name.length + 4) ? link : null;
  };
  /** The innermost element under `root` that holds the text. */
  const holderOf = (root: Element, text: string): Element | null => {
    if (!norm(root.textContent).includes(text)) return null;
    let cur = root;
    for (let depth = 0; depth < 80; depth++) {
      const next = [...cur.children].find((c) => !/^(script|style|noscript|template)$/.test(c.localName) && norm(c.textContent).includes(text));
      if (!next) break;
      cur = next;
    }
    return cur;
  };
  /** Whether all of an element's text is shown: rendered, visible, on the page, and cut off by no ancestor's hidden overflow. */
  const shownWhole = (holder: Element): boolean => {
    const doc = holder.ownerDocument;
    const view = doc.defaultView;
    if (!view) return false;
    if (typeof holder.checkVisibility === 'function' && !holder.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const range = doc.createRange();
    range.selectNodeContents(holder);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right + view.scrollX <= 0 || r.bottom + view.scrollY <= 0) return false;
    for (let a: Element | null = holder; a && a !== doc.documentElement && a !== doc.body; a = a.parentElement) {
      const cs = view.getComputedStyle(a);
      const clipX = /hidden|clip/.test(cs.overflowX);
      const clipY = /hidden|clip/.test(cs.overflowY);
      if (!clipX && !clipY) continue;
      const b = a.getBoundingClientRect();
      const left = b.left + a.clientLeft;
      const top = b.top + a.clientTop;
      if (clipX && (r.left < left - 1 || r.right > left + a.clientWidth + 1)) return false;
      if (clipY && (r.top < top - 1 || r.bottom > top + a.clientHeight + 1)) return false;
    }
    return true;
  };
  const cache = ((window as unknown as { __grntedExcerpts?: Record<string, string | null> }).__grntedExcerpts ??= {});
  let fetched = 0;
  /** The page's markup (kept for the other layout tests of this page); null when it could not be had. */
  const pageHtml = async (url: string): Promise<string | null> => {
    if (url in cache) return cache[url]!;
    if (fetched >= arg.fetches) return null;
    fetched++;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), arg.fetchMs);
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: stop.signal, headers: { accept: 'text/html' } });
      if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) return (cache[url] = null);
      return (cache[url] = await res.text());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  /**
   * That page laid out at this window's size with its own styles, in a frame where nothing runs (no scripts, no
   * frames of its own, no refresh, no media): only there can it be seen whether its styles show the text. Null
   * when it could not be laid out in time. The frames are removed when the call ends.
   */
  const frames: HTMLIFrameElement[] = [];
  const laid = new Map<string, Document | null>();
  const pageDoc = async (url: string): Promise<Document | null> => {
    if (laid.has(url)) return laid.get(url)!;
    let doc: Document | null = null;
    const html = await pageHtml(url);
    if (html) {
      try {
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        parsed.querySelectorAll('script, iframe, frame, object, embed, base, meta[http-equiv], link[rel~="preload"], link[rel~="prefetch"], link[rel~="modulepreload"]').forEach((n) => n.remove());
        parsed.querySelectorAll('img, source, video, audio, track, input[type="image"]').forEach((n) => { for (const at of ['src', 'srcset', 'poster']) n.removeAttribute(at); });
        const base = parsed.createElement('base');
        base.setAttribute('href', url);
        (parsed.head ?? parsed.documentElement).prepend(base);
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${innerWidth}px;height:${innerHeight}px;border:0;margin:0;padding:0;opacity:0;pointer-events:none`;
        const ready = new Promise<boolean>((done) => {
          frame.addEventListener('load', () => done(true), { once: true });
          setTimeout(() => done(false), arg.renderMs);
        });
        frame.srcdoc = `<!doctype html>${parsed.documentElement.outerHTML}`;
        frames.push(frame);
        document.documentElement.append(frame);
        // Its styles must have loaded: a page judged before they apply could show text they hide.
        doc = (await ready) ? frame.contentDocument : null;
      } catch {
        doc = null;
      }
    }
    laid.set(url, doc);
    return doc;
  };
  try {
  for (const i of arg.els) {
    const el = st.els[i];
    const way = el ? control(el.nextElementSibling) : null;
    if (!el || !way) continue;
    const name = words(way).slice(0, 60);
    const text = norm(el.textContent);
    let ok = false;
    const href = way.localName === 'a' ? way.getAttribute('href') ?? '' : '';
    if (text.length >= arg.textMin && href) {
      try {
        const url = new URL(href, document.baseURI);
        const here = new URL(document.baseURI);
        const samePage = url.origin === here.origin && url.pathname === here.pathname && url.search === here.search;
        if (samePage) {
          // A link into this page: the element it names must hold the text and show all of it.
          const id = decodeURIComponent(url.hash.slice(1));
          const target = id ? document.getElementById(id) : null;
          const holder = target && target !== el && !el.contains(target) ? holderOf(target, text) : null;
          ok = !!holder && shownWhole(holder);
        } else if (/^https?:$/.test(url.protocol) && url.origin === here.origin && !ACTION.test(url.pathname + url.search)) {
          url.hash = '';
          const doc = await pageDoc(url.href);
          const holder = doc?.body ? holderOf(doc.body, text) : null;
          ok = !!holder && shownWhole(holder);
        }
      } catch {
        ok = false;
      }
    }
    if (ok) out.verified.push(i);
    else out.unverified.push({ el: i, name });
  }
  } finally {
    for (const f of frames) f.remove();
  }
  return out;
}

/**
 * Text cut off in an excerpt whose full text is one step away is not lost (ACT rule 59br37 passes clipped text
 * that is "available through another mechanism"): `places` are the places without the excerpts whose control was
 * VERIFIED to lead to the full text (`excerptWays`). An excerpt followed by a control that only has the right name
 * (a button, a link to nowhere, a page without the text) is neither exempt nor failed: it is in `unverified`, and
 * the caller reports the criterion as not testable there (review r1, finding 8).
 */
export async function withoutExcerpts(page: { evaluate: PageLike['evaluate'] }, places: LayoutPlace[]): Promise<{ places: LayoutPlace[]; unverified: { el: number; name: string }[] }> {
  const els = [...new Set(places.filter((p) => /cut$/.test(p.kind) && p.el !== undefined).map((p) => p.el!))];
  if (!els.length) return { places, unverified: [] };
  const ways = await page.evaluate(excerptWays, { els, ...EXCERPT_LIMITS }).catch((): ExcerptWays => ({ verified: [], unverified: [] }));
  const out = new Set([...ways.verified, ...ways.unverified.map((u) => u.el)]);
  return { places: out.size ? places.filter((p) => !(/cut$/.test(p.kind) && p.el !== undefined && out.has(p.el))) : places, unverified: ways.unverified };
}

/**
 * Runs in the page: where the unverified excerpts are (path and text of each tracked container), for the finding.
 */
export function excerptTargets(arg: { els: number[] }): { path: string; text: string }[] {
  const st = (window as unknown as { __grntedLayout?: { els: Element[] } }).__grntedLayout;
  if (!st) return [];
  const esc = (x: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(x) : x);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  return arg.els.map((i) => { const el = st.els[i]; const t = (el?.textContent ?? '').replace(/\s+/g, ' ').trim(); return { path: el ? cssPath(el) : '', text: t.length > 60 ? `${t.slice(0, 59)}…` : t }; });
}

/**
 * The not_testable finding for excerpts whose control could not be verified (`when`: "At 320 px wide", "With the
 * WCAG text spacing"…). Call it while the tracked nodes are still kept. Empty when there are none.
 */
export async function excerptFindings(page: { evaluate: PageLike['evaluate'] }, criterion: string, unverified: readonly { el: number; name: string }[], when: string): Promise<{ criterion: string; status: 'not_testable'; target?: string; detail: string }[]> {
  if (!unverified.length) return [];
  const where = await page.evaluate(excerptTargets, { els: unverified.map((u) => u.el) }).catch(() => [] as { path: string; text: string }[]);
  const first = where[0];
  return [{
    criterion, status: 'not_testable', ...(first?.path ? { target: first.path } : {}),
    detail: `${when}, text is cut off by its container${first?.text ? ` (“${first.text}”)` : ''} and a control named “${unverified[0]!.name}” follows it; whether that control gives the full text could not be verified${unverified.length > 1 ? ` (and ${unverified.length - 1} more like it on this page)` : ''}`,
  }];
}

/** Places reported per page and probe; the last one kept says how many more there were. */
export const MAX_PLACES = 8;

/**
 * Text that is cut off by its container at the instant it was measured while several animations move it at once
 * (`LayoutItem.mv` 2): not testable for the criterion, never failed and never clean (review r2, finding 3).
 */
export function movingFindings(criterion: string, state: LayoutState | undefined, kinds: string, when: string): ProbeFinding[] {
  const n = state ? state.items.filter((it, i) => kinds[i] === 't' && it.v && it.mv === 2).length : 0;
  return n ? [{ criterion, status: 'not_testable', detail: `${when}, text that several animations move at the same time is cut off by its container at the moment it was measured; whether all of it is shown in turn could not be told` }] : [];
}

/** Text cut off by a container, one place per container. */
export function cutPlaces(cut: readonly number[], state: LayoutState, kind = 'cut'): LayoutPlace[] {
  return [...groupBy(cut, (i) => state.items[i]!.by ?? -1 - i).entries()].map(([by, items]) => ({ kind, ...(by >= 0 ? { el: by } : {}), items }));
}

/** Overlapping text, one place per pair; an item already reported is not reported again. */
export function overlapPlaces(pairs: readonly [number, number][], kind = 'overlap'): LayoutPlace[] {
  const seen = new Set<number>();
  const out: LayoutPlace[] = [];
  for (const [i, j] of pairs) {
    if (seen.has(i) || seen.has(j)) continue;
    seen.add(i);
    seen.add(j);
    out.push({ kind, items: [i, j] });
  }
  return out;
}

/** What `describeLayout` needs for the first `max` places. */
export function placeRefs(places: readonly LayoutPlace[], max = MAX_PLACES): { items: number[]; els: number[] } {
  const items = new Set<number>();
  const els = new Set<number>();
  for (const p of places.slice(0, max)) {
    for (const i of p.items.slice(0, 2)) items.add(i);
    if (p.el !== undefined) els.add(p.el);
  }
  return { items: [...items], els: [...els] };
}

/**
 * Probe findings for the places, at most `max`: the target is the place's element (else its first
 * item's), the detail comes from `detail`. The last finding kept counts the places left out.
 */
export function placeFindings(
  criterion: string,
  places: readonly LayoutPlace[],
  desc: LayoutDescription,
  detail: (p: LayoutPlace, text: (i: number) => string) => string,
  max = MAX_PLACES,
): { criterion: string; status: 'failed'; target?: string; detail: string }[] {
  const text = (i: number) => `“${excerpt(desc.items[i]?.text ?? '', 60)}”`;
  const kept = places.slice(0, max);
  return kept.map((p, k) => {
    const target = p.el !== undefined ? desc.els[p.el]?.path : desc.items[p.items[0]!]?.path;
    const more = k === kept.length - 1 && places.length > kept.length ? ` (and ${places.length - kept.length} more on this page)` : '';
    return { criterion, status: 'failed' as const, ...(target ? { target } : {}), detail: `${detail(p, text)}${more}` };
  });
}
