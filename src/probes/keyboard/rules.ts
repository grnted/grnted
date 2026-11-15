// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { clipPath, clipWords } from '../../clip.js';
import { boxPixels, changeContrast, contrastRatio, NON_TEXT_THRESHOLD, px, type PxBox, type Rgb, type Rgba, type RgbaImage } from '../pixels.js';
import type { GuardEvent } from '../types.js';

// The keyboard and focus probes' decisions (Plan 4 Task 4.1): pure functions over what the in-page
// kit measured, so every rule and threshold is unit-tested. Engine core: no Node-only imports.

// ---------------------------------------------------------------------------------------------
// Thresholds (documented in the README and Plan 4's Task 4.1 notes).

export const KEYBOARD_LIMITS = {
  core: {
    /** Tab presses from the top of the page. */
    forward: 60,
    /** Shift+Tab presses from the end of the page. */
    backward: 40,
    /** Focus stops whose focus indicator is measured (one per kind of element first). */
    focusSamples: 25,
    /** Longest focus cycle recognised as a possible trap. */
    maxCycle: 15,
    /** Soft time budget for the traversal; what was measured by then is reported. */
    budgetMs: 7000,
  },
  deep: { forward: 300, backward: 300, focusSamples: 100, maxCycle: 60, budgetMs: 60_000 },
} as const;

/** A pixel counts as changed when one of its colour channels differs by this much (0–255). */
export const PIXEL_CHANNEL_DELTA = 16;
/** Fewer changed pixels than this in the element's box and ring: no visible focus change. */
export const PIXEL_MIN_CHANGED = 4;
/** Margin around the element's box in the focus screenshots (plus the outline's own extent, up to 12). */
export const FOCUS_RING_PX = 4;
/** Longest wait for scrolling to stop before a focus stop that looks hidden or covered is measured again. */
export const SETTLE_CAP_MS = 600;
/** Opacity at or below which a focused element is invisible. */
export const INVISIBLE_OPACITY = 0.05;
/** A covering element counts as opaque from this background alpha and opacity. */
export const OPAQUE_ALPHA = 0.9;
/** On-focus DOM change that counts as a change of context: this many elements added or removed… */
export const CONTEXT_MIN_ELEMENTS = 100;
/** …and at least this share of the page's elements. */
export const CONTEXT_SHARE = 0.3;

// ---------------------------------------------------------------------------------------------
// 2.1.2 No keyboard trap: focus cycles.

export interface Cycle {
  /** Element ids of one turn of the cycle, in focus order. */
  members: number[];
}

/**
 * Finds a focus cycle at the end of a Tab sequence. `seq` holds one element id per key press (0:
 * focus left the page's content, as after the last element). Without scripts, Tab never revisits an
 * element before focus leaves the content, so a repeating tail with no 0 is focus held by a script.
 * Recognised: a cycle of 2..maxLength distinct elements seen twice in a row at the end, or one
 * element kept for 3 presses. Cycles made only of frames are ignored (Tab moves inside the frame
 * while the page sees the frame element).
 */
export function findCycle(seq: readonly number[], maxLength: number, frames: ReadonlySet<number> = new Set()): Cycle | null {
  for (let len = 1; len <= maxLength; len++) {
    const need = len === 1 ? 3 : 2 * len;
    if (seq.length < need) break;
    const tail = seq.slice(seq.length - need);
    if (tail.some((id) => id === 0)) continue;
    let periodic = true;
    for (let i = len; i < need; i++) {
      if (tail[i] !== tail[i - len]) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;
    const members = tail.slice(0, len);
    if (new Set(members).size !== len) continue;
    if (members.every((m) => frames.has(m))) continue;
    return { members };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Visibility of a focused element (2.4.3) and whether it is hidden behind other content (2.4.11).

/** Raw facts the kit measures for a focused element, after the browser scrolled it into view. */
export interface VisibilityFacts {
  /** Product of the element's and its ancestors' opacity. */
  opacity: number;
  /** Size of the element's box (or of its visible descendants when its own box is empty). */
  width: number;
  height: number;
  /** Area of the box inside the viewport (CSS px²). */
  inViewport: number;
  /** Grid points sampled in the box (inside the viewport). */
  points: number;
  /** Points where the element or a descendant is under the pointer (covered or not). */
  hits: number;
  /** Hit testing applies (pointer-events is not none), so `hits === 0` means clipped away. */
  hitTestable: boolean;
}

export type Hidden = 'style' | 'size' | 'offscreen' | 'clipped';

/**
 * Why a focused element cannot be seen, or null when it can:
 * - `style`: opacity ≤ INVISIBLE_OPACITY (with its ancestors);
 * - `size`: its box is under 2×2 px (the "visually hidden" pattern);
 * - `offscreen`: no part of the box is inside the viewport after the browser scrolled to it;
 * - `clipped`: no sampled point of the box reaches it (cut away by a parent's overflow or clip-path).
 */
export function hiddenReason(f: VisibilityFacts): Hidden | null {
  if (f.opacity <= INVISIBLE_OPACITY) return 'style';
  if (f.width < 2 || f.height < 2) return 'size';
  if (f.inViewport < 4) return 'offscreen';
  if (f.hitTestable && f.points > 0 && f.hits === 0) return 'clipped';
  return null;
}

export const HIDDEN_TEXT: Record<Hidden, string> = {
  style: 'fully transparent',
  size: 'visually hidden (smaller than 2 px)',
  offscreen: 'outside the visible page area',
  clipped: 'cut off by a parent element',
};

/**
 * One grid point of a focused element's box:
 * - `s`: the element shows at this point (nothing opaque above it);
 * - `f`: an opaque fixed or sticky element (header, footer, banner) covers it; `by` is its path;
 * - `p`: opaque content laid over it covers it (an absolutely positioned element that does not hold it
 *   and is not the control's own skin); `by` is its path;
 * - `o`: other opaque content covers it (the control's own skin, content in the normal flow);
 * - `m`: the element is not under this point (gaps in a wrapped link's box).
 */
export interface GridPoint {
  k: 's' | 'f' | 'p' | 'o' | 'm';
  by?: string;
}

/**
 * 2.4.11: the focused element is entirely hidden by author-created content when every sampled point
 * that reaches it is covered by an opaque fixed or sticky element, or by opaque content laid over it
 * (`p`), over at least 3 points. Partly hidden is not a failure (the AA criterion is "entirely
 * hidden"). Returns the path of the element that covers most of it.
 */
export function obscuredBy(points: readonly GridPoint[]): string | null {
  const reached = points.filter((p) => p.k !== 'm');
  if (reached.length < 3 || reached.some((p) => p.k !== 'f' && p.k !== 'p')) return null;
  const counts = new Map<string, number>();
  for (const p of reached) counts.set(p.by ?? '', (counts.get(p.by ?? '') ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0] || 'fixed content';
}

/** The cover found by `obscuredBy` is content laid over the element (`p`), not fixed or sticky content. */
export function laidOver(points: readonly GridPoint[]): boolean {
  const reached = points.filter((p) => p.k !== 'm');
  return reached.length > 0 && reached.filter((p) => p.k === 'p').length * 2 > reached.length;
}

// ---------------------------------------------------------------------------------------------
// 2.4.7 Focus visible.

export interface FocusMeasure {
  /** Changed pixels between the focused and unfocused screenshots (undefined: not measured). */
  changed?: number;
  total?: number;
  /** The computed outline, box-shadow or border shows a visible indicator when focused. */
  styleIndicator: boolean;
  /** That indicator is cut off by a parent's overflow (geometry). */
  styleClipped: boolean;
  /** Computed properties that differ between focused and unfocused (element, pseudo-elements, parents). */
  styleChanged: readonly string[];
  /** Text fields show the text cursor when focused. */
  textField: boolean;
  /**
   * The focused picture was taken with the element's keyboard-focus look (the same computed styles), so a style
   * indicator missing from the pixels is missing on screen (`refocusShots`). Undefined: not known.
   */
  styleKept?: boolean;
  /** The element and the reach of its indicator lie wholly inside the viewport, so the pictures see all of it. */
  ringInView?: boolean;
  /** Its changed ::before/::after are drawn near the element, inside the pictures (round 2). */
  pseudoLocal?: boolean;
}

/** Style snapshots of things drawn outside the element's own box. */
const FAR_STYLES = new Set(['::before', '::after', 'parent', 'grandparent', 'ancestor3', 'ancestor4']);

/**
 * 2.4.7 decision, conservative (no failure when the measurements disagree):
 * - an unclipped outline, box-shadow or border indicator by computed style: visible;
 * - otherwise pixels decide: PIXEL_MIN_CHANGED or more changed pixels in the box and ring is visible;
 * - no pixel change but a style indicator that is not clipped: visible (it may be drawn outside the
 *   measured ring); a clipped one is not;
 * - text fields are never failed (the text cursor shows focus); without a pixel measurement, no failure.
 */
export function focusVerdict(m: FocusMeasure): 'visible' | 'none' | 'clipped' | 'unseen' | 'unknown' {
  if (m.styleIndicator && !m.styleClipped) {
    // Batch 18, D7: a drawn indicator must also change pixels. When nothing changes in the pictures although the
    // focused look was kept and all of the element and its indicator were in view, the indicator is drawn in the
    // colour behind it or under something (the element's own content, a clip-path): no one can see it ('unseen').
    // Anything short of that proof keeps the old reading (visible); a text field has its text cursor.
    if (m.changed === undefined || m.changed >= PIXEL_MIN_CHANGED || m.textField) return 'visible';
    if (m.styleKept !== true || m.ringInView !== true) return 'visible';
    // A pseudo-element drawn near the element is inside the pictures (round 2): only ancestors stay far.
    if (m.styleChanged.some((k) => FAR_STYLES.has(k) && !(m.pseudoLocal && (k === '::before' || k === '::after')))) return 'visible';
    return 'unseen';
  }
  if (m.changed === undefined) return 'unknown';
  if (m.changed >= PIXEL_MIN_CHANGED) return 'visible';
  if (m.textField) return 'unknown';
  // A pseudo-element or an ancestor changed on focus where the screenshot may not reach it.
  if (m.styleChanged.some((k) => FAR_STYLES.has(k))) return 'unknown';
  return m.styleIndicator ? 'clipped' : 'none';
}

// ---------------------------------------------------------------------------------------------
// 1.4.11 Non-text contrast of the focus indicator (Task 4.10). WCAG 1.4.11 asks for 3:1 between
// the visual information that identifies a state, such as a focus ring, and the colours next to it.
// The keyboard probe already takes the screenshots: the element focused and unfocused.

/** Fewer changed pixels than this around the element's box: no ring to measure. */
export const MIN_RING_PIXELS = 12;
/** Colour distance (0–441) within which the strongest ring pixel shows the outline's own colour. */
export const RING_COLOUR_MATCH = 48;

export type FocusContrast =
  | {
    kind: 'ok' | 'failed';
    /** The contrast nearly all of the strongest changed pixels stay under (98th percentile), see `changeContrast`. */
    ratio: number;
    /** The ring's colour at that pixel and the colour it covers there. */
    colour: Rgb;
    behind: Rgb;
    /** Changed pixels in the band around the box. */
    pixels: number;
  }
  | {
    kind: 'unmeasured';
    /**
     * - `no-ring`: nothing changed around the box (the indicator is inside it: a fill, border or
     *   inner outline), or the screenshots cannot be compared;
     * - `unconfirmed`: the pixels read under 3:1 but never show the outline's own colour, which has
     *   3:1 against what it covers (scaling or a filter changed it): not a failure, not a clean result;
     * - `combined`: the ring reads under 3:1, but focus also changes something else (the element's
     *   fill, border, text colour or underline, a pseudo-element, a parent), which may be the
     *   indicator 1.4.11 judges: not a failure on the ring alone.
     * - `adjacent` (batch 18 precision): the ring reads under 3:1 against what it covered, but has 3:1 against a colour
     *   next to it in the focused picture (the element's own fill or edge on its inner side, or what lies beyond it):
     *   1.4.11 asks for contrast with adjacent colours, so the ring is not proven insufficient.
     * - `appears` (batch 18 precision): the element is elsewhere or not shown without focus (a skip link that appears
     *   when focused): the covered pixels are not its unfocused look and the element appearing is a change of its own.
     */
    reason: 'no-ring' | 'unconfirmed' | 'combined' | 'adjacent' | 'appears';
  };

/**
 * The band of `band` pixels around a box, as four strips outside it. The box is rounded outward, so
 * the element's own anti-aliased edge (where a focused fill or border would show) is not part of it.
 */
export function ringBands(box: PxBox, band: number): PxBox[] {
  const x0 = Math.floor(box[0]);
  const y0 = Math.floor(box[1]);
  const x1 = Math.ceil(box[0] + box[2]);
  const y1 = Math.ceil(box[1] + box[3]);
  const b = Math.max(1, Math.ceil(band));
  return [[x0 - b, y0 - b, x1 - x0 + 2 * b, b], [x0 - b, y1, x1 - x0 + 2 * b, b], [x0 - b, y0, b, y1 - y0], [x1, y0, b, y1 - y0]];
}

export interface RingShot {
  /** Screenshot of the area without focus, and with focus. */
  before: RgbaImage;
  after: RgbaImage;
  /** The element's border box, in image pixels. */
  box: PxBox;
  /** How far outside the box the ring reaches (outline offset and width, or the shadow's extent), in image pixels. */
  band: number;
  /** The focused outline's colour, when the ring is an outline. */
  outline?: Rgba;
  /** Focus also changes something besides the ring (see `FOCUS_OTHER_CUES`). */
  alsoChanged?: boolean;
  /** The ring lies inside the box (an inset shadow): its band runs along the inside of the box's edges. */
  inset?: boolean;
  /**
   * Focus also changes the border's colour and nothing else besides the ring: the border's width in image pixels, so
   * that change is measured too (batch 18, round 2: a faint glow next to a faint border is no indicator either).
   */
  border?: number;
  /** An outer ring's distance from the box (an outline's offset), in image pixels: what lies on its inner side. */
  gap?: number;
}

/** The band of `band` pixels just inside a box, as four strips (an inset ring), the box rounded inward. */
export function innerBands(box: PxBox, band: number): PxBox[] {
  const x0 = Math.ceil(box[0]);
  const y0 = Math.ceil(box[1]);
  const x1 = Math.floor(box[0] + box[2]);
  const y1 = Math.floor(box[1] + box[3]);
  const b = Math.max(1, Math.floor(band));
  if (x1 - x0 <= 2 * b || y1 - y0 <= 2 * b) return [];
  return [[x0, y0, x1 - x0, b], [x0, y1 - b, x1 - x0, b], [x0, y0 + b, b, y1 - y0 - 2 * b], [x1 - b, y0 + b, b, y1 - y0 - 2 * b]];
}

/** Style changes on focus that are a cue of their own besides a ring (keys of the kit's style snapshot). */
export const FOCUS_OTHER_CUES: ReadonlySet<string> = new Set([
  'background', 'border', 'color', 'text-decoration', 'font-weight', '::before', '::after', 'parent', 'grandparent', 'ancestor3', 'ancestor4',
]);

/**
 * 1.4.11 for a focus ring drawn outside the element (an outline or an outer box-shadow): every pixel
 * around the box that focus changed is compared with the pixel it covered (`changeContrast`), so the
 * ring is judged against the colours next to it. The 98th percentile is used: anti-aliased edges and
 * corners do not lower it, and a ring fails only when even its most solid pixels stay under 3:1.
 * Changes inside the box (a fill or border colour change) are not measured: 1.4.11 does not require
 * contrast between the focused and unfocused states of the component itself. A low ring next to such
 * a change is not failed either (`combined`): the other change may be the indicator.
 */
/** The median colour of `boxes` in `img`, or null when they hold fewer than 8 pixels. */
function medianIn(img: RgbaImage, boxes: PxBox[]): Rgb | null {
  const all = boxPixels(img, boxes).map((i) => px(img, i % img.width, (i - (i % img.width)) / img.width));
  if (all.length < 8) return null;
  const mid = (k: 0 | 1 | 2) => [...all.map((c) => c[k])].sort((a, b) => a - b)[Math.floor(all.length / 2)]!;
  return [mid(0), mid(1), mid(2)];
}

/**
 * Batch 18 precision: the colours next to the ring in the focused picture, on its inner side (the element's own edge or
 * fill for a ring that touches it, the gap for one set off from it, the fill inside an inner ring) and on its outer side
 * (beyond its reach). A ring under 3:1 against what it covered may still have 3:1 against one of them.
 */
export function ringNeighbours(shot: RingShot): Rgb[] {
  const [x, y, w, h] = shot.box;
  const grow = (d: number): PxBox => [x - d, y - d, w + 2 * d, h + 2 * d];
  const strips: PxBox[][] = shot.inset
    ? [innerBands(grow(-shot.band - 1), 2), ringBands(shot.box, 2)]
    : [(shot.gap ?? 0) >= 3 ? ringBands(grow((shot.gap ?? 0) - 2), 1) : innerBands(shot.box, 2), ringBands(grow(shot.band + 1), 2)];
  return strips.map((b) => medianIn(shot.after, b)).filter((c): c is Rgb => !!c);
}

export function focusRingContrast(shot: RingShot): FocusContrast {
  const r = focusRingContrastCovered(shot);
  if (r.kind !== 'failed') return r;
  // Whatever the ring covered, it is judged against the colours next to it (1.4.11): 3:1 against either side, or an
  // element that appears on focus, is not a proven failure.
  if (ringNeighbours(shot).some((c) => contrastRatio(r.colour, c) >= NON_TEXT_THRESHOLD)) return { kind: 'unmeasured', reason: 'adjacent' };
  return r;
}

function focusRingContrastCovered(shot: RingShot): FocusContrast {
  const { before, after } = shot;
  if (before.width !== after.width || before.height !== after.height) return { kind: 'unmeasured', reason: 'no-ring' };
  const v = changeContrast(before, after, shot.inset ? innerBands(shot.box, shot.band) : ringBands(shot.box, shot.band));
  if (v.pixels < MIN_RING_PIXELS) return { kind: 'unmeasured', reason: 'no-ring' };
  const measured = { ratio: v.ratio, colour: v.colour, behind: v.behind, pixels: v.pixels };
  if (v.ratio >= NON_TEXT_THRESHOLD) return { kind: 'ok', ...measured };
  const o = shot.outline;
  if (o && o[3] >= 0.99) {
    const own: Rgb = [o[0], o[1], o[2]];
    const shown = Math.hypot(v.colour[0] - own[0], v.colour[1] - own[1], v.colour[2] - own[2]) <= RING_COLOUR_MATCH;
    if (!shown && contrastRatio(own, v.behind) >= NON_TEXT_THRESHOLD) return { kind: 'unmeasured', reason: 'unconfirmed' };
  }
  if (shot.alsoChanged) {
    // The other change is the border's colour: it is a cue only if the focused border stands out (3:1) against the
    // colour around the box (what the ring covered) or the fill inside it. Both under 3:1: the focus has no visible
    // part of 3:1. Anything else that changed may be the indicator (not measured).
    if (!shot.border || shot.border < 1) return { kind: 'unmeasured', reason: 'combined' };
    const edge = innerBands(shot.box, shot.border);
    const inside = innerBands([shot.box[0] + shot.border + 1, shot.box[1] + shot.border + 1, shot.box[2] - 2 * shot.border - 2, shot.box[3] - 2 * shot.border - 2], 2);
    if (!edge.length || !inside.length) return { kind: 'unmeasured', reason: 'combined' };
    const median = (img: RgbaImage, boxes: PxBox[]): Rgb | null => {
      const all = boxPixels(img, boxes).map((i) => px(img, i % img.width, (i - (i % img.width)) / img.width));
      if (all.length < 8) return null;
      const mid = (k: 0 | 1 | 2) => [...all.map((c) => c[k])].sort((a, b) => a - b)[Math.floor(all.length / 2)]!;
      return [mid(0), mid(1), mid(2)];
    };
    const borderNow = median(after, edge);
    const fill = median(after, inside);
    if (!borderNow || !fill) return { kind: 'unmeasured', reason: 'combined' };
    if (Math.max(contrastRatio(borderNow, v.behind), contrastRatio(borderNow, fill)) >= NON_TEXT_THRESHOLD) return { kind: 'unmeasured', reason: 'combined' };
    return { kind: 'failed', ...measured };
  }
  return { kind: 'failed', ...measured };
}

// ---------------------------------------------------------------------------------------------
// 2.4.3 Focus order: the main content skipped.

export interface OrderStop {
  inMain: boolean;
  inFooter: boolean;
  /** Inside a fixed or sticky container (its place on screen does not follow the document). */
  fixed: boolean;
}

/**
 * 2.4.3 "main content skipped": the page has one main landmark and a footer (contentinfo) shown
 * entirely below it, and Tab from the top reaches a footer stop before any stop in the main content.
 * Stops in fixed or sticky containers are ignored. Returns the number of footer stops reached first.
 */
export function footerBeforeMain(stops: readonly OrderStop[], layout: { mainBottom?: number; footerTop?: number }): number {
  if (layout.mainBottom === undefined || layout.footerTop === undefined) return 0;
  if (layout.footerTop < layout.mainBottom - 2) return 0;
  const flow = stops.filter((s) => !s.fixed);
  const firstMain = flow.findIndex((s) => s.inMain);
  const firstFooter = flow.findIndex((s) => s.inFooter);
  if (firstMain < 0 || firstFooter < 0 || firstFooter > firstMain) return 0;
  return flow.slice(0, firstMain).filter((s) => s.inFooter).length;
}

/** A focus stop as the positive-tabindex rule sees it (page coordinates). */
export interface JumpStop {
  /** Positive tabindex attribute, if any. */
  tabIndex?: number;
  pageX: number;
  pageY: number;
  w: number;
  h: number;
}

/**
 * 2.4.3 positive tabindex (failure technique F44): consecutive Tab stops A → B, at least one with a
 * positive tabindex, where B lies more than a viewport height above A and not to the right of A's
 * column, i.e. the tabindex sends focus far back against the visual reading order. Callers pass only
 * stops in the page flow (not fixed or sticky, not hidden, not in a dialog). Returns the index of A
 * for each jump.
 */
export function tabindexJumps(stops: readonly JumpStop[], viewportHeight: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (!(a.tabIndex && a.tabIndex > 0) && !(b.tabIndex && b.tabIndex > 0)) continue;
    if (b.pageY + b.h >= a.pageY - viewportHeight) continue;
    if (b.pageX >= a.pageX + a.w) continue;
    out.push(i);
  }
  return out;
}

/** A focus stop as the in-container order rule sees it (page coordinates). */
export interface OrderBoxStop extends JumpStop {
  /** The container it is compared in (`StopFacts.ord.box`). */
  box?: string;
  /** CSS shows it out of its document order (`StopFacts.ord.moved`). */
  moved?: boolean;
  rtl?: boolean;
  /** Its place in the document order (`StopFacts.ord.dom`). */
  dom?: number;
  /** The form its container is a fieldset or a group of (`StopFacts.ord.group`). */
  group?: string;
}

/**
 * 2.4.3 inside one container (F44): consecutive Tab stops A → B in the same form, list, menu, toolbar or other
 * container (fieldsets of one form count as that form: its steps), where a positive tabindex on either sends focus to B although B comes before A both in the document
 * and on screen (above it and not in a column to its right, or on the same line and wholly before it; mirrored on a
 * right-to-left page), at any distance: `fail`. Focus that follows the document while CSS shows the controls in
 * another order (a reversed flex direction, a flex or grid `order`; C27 is a sufficient technique, not a requirement:
 * WCAG allows focus order to differ from the layout) is a recommendation only: `advice`. Returns indexes of A.
 */
export function containerOrderJumps(stops: readonly OrderBoxStop[]): { fail: number[]; advice: number[] } {
  const fail: number[] = [];
  const advice: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    // The same container, or two fieldsets (or a fieldset and the form's own fields) of one form.
    const together = !!a.box && !!b.box && (a.box === b.box || (!!a.group && (a.group === b.group || a.group === b.box)) || (!!b.group && b.group === a.box));
    if (!together) continue;
    const tab = (a.tabIndex !== undefined && a.tabIndex > 0) || (b.tabIndex !== undefined && b.tabIndex > 0);
    if (!tab && !a.moved && !b.moved) continue;
    const overlap = Math.min(a.pageY + a.h, b.pageY + b.h) - Math.max(a.pageY, b.pageY);
    const sameLine = overlap >= 0.5 * Math.min(a.h, b.h);
    const shownBefore = sameLine
      ? (a.rtl ? b.pageX >= a.pageX + a.w - 1 : b.pageX + b.w <= a.pageX + 1)
      : b.pageY + b.h / 2 < a.pageY && (a.rtl ? b.pageX + b.w > a.pageX : b.pageX < a.pageX + a.w);
    if (!shownBefore) continue;
    if (tab && a.dom !== undefined && b.dom !== undefined && b.dom < a.dom) fail.push(i);
    else if (!tab) advice.push(i);
  }
  return { fail, advice };
}

// ---------------------------------------------------------------------------------------------
// 2.4.1 Bypass blocks.

export interface SkipLinkTest {
  name: string;
  path: string;
  /** The fragment names an element that exists. */
  targetFound: boolean;
  /** After Enter, focus is in the target, or the next Tab lands in it or after it. */
  works: boolean;
  /** The target is, contains or is inside the main landmark, or the next stop after it is in main. */
  toMain: boolean;
  /**
   * The target is past the repeated blocks (`skipPast` in page.ts): no focus stop between the link and the
   * content comes at or after it, and it is not past the content's end. Absent: not measured (as true).
   */
  past?: boolean;
  /** It did not work, and a request the guard blocked (or a navigation it held) may be why. */
  stopped?: { url?: string; method?: string; reason?: GuardEvent['reason']; kind: string };
  /** It could not be activated, or its result cannot be trusted: why. */
  untested?: string;
  /**
   * A skip control (a button whose script moves to the content, `isSkipControl` in traverse.ts), not a link: it can
   * only make a bypass, never a failure of its own (its name may mean something else). `targetFound`: pressing it
   * set a fragment that names an element, or moved focus.
   */
  control?: true;
}

export type BypassResult =
  | { status: 'failed'; target?: string; detail: string }
  | { status: 'flagged'; target?: string; detail: string }
  | { status: 'not_testable'; target?: string; detail: string }
  | { status: 'ok'; detail: string };

/**
 * 2.4.1, in order (WCAG's sufficient techniques G1, G123, G124, ARIA11, H69, SCR28):
 * - a skip link among the first focus stops whose target is missing or that does not move focus → failed, unless the
 *   page has a main landmark or headings (batch 19, precision lane: ARIA11 and H69 are sufficient techniques of their
 *   own, so a mechanism to bypass the blocks is available; the broken link is listed for a person to check, never failed);
 * - a working skip link (not to the footer, the bottom or the top) whose target is past the repeated blocks
 *   and not past the content (the main content, a section, another skip link) → no failure;
 * - a main landmark or headings (ARIA11, H69) → no failure;
 * - the content comes before any repeated block in the Tab order (nothing to bypass) → no failure;
 * - a control among the first focus stops that, pressed, takes the navigation's links out of the Tab order
 *   (SCR28; `toggleWorks`) → no failure; one merely named so is nothing;
 * - a skip control (a button named skip, `control`) counts like a skip link when it works; one that could not be
 *   pressed or trusted leaves the result not tested; one that moved nothing is nothing (never a broken skip link);
 * - otherwise → failed (no way to bypass repeated blocks).
 */
export function bypassVerdict(
  skips: readonly SkipLinkTest[],
  page: { hasMain: boolean; headings: number; contentFirst?: boolean; toggle?: string; toggleWorks?: boolean; toggleUntested?: string },
  untested = 0,
): BypassResult {
  const working = skips.some((s) => s.works && s.past !== false && !s.untested && !/\b(footer|bottom|top)\b/i.test(s.name));
  const controls = skips.filter((s) => s.control);
  const links = skips.filter((s) => !s.control);
  const untestedSkip = links.find((s) => s.untested);
  if (untestedSkip && !working) return { status: 'not_testable', target: untestedSkip.path, detail: untestedSkip.untested! };
  const stopped = links.find((s) => s.targetFound && !s.works && s.stopped);
  if (stopped && !working) {
    const what = stopped.stopped!.kind === 'navigation' ? 'a page load' : `a ${stopped.stopped!.method ?? ''} request`.replace('  ', ' ');
    return {
      status: 'not_testable', target: stopped.path,
      detail: `the skip link "${clip(stopped.name, 60)}" did not move keyboard focus, and it tried ${what}${stopped.stopped!.url ? ` to ${clip(stopped.stopped!.url, 120)}` : ''} that the test stopped so as not to change the live site`,
    };
  }
  const broken = links.find((s) => !s.untested && (!s.targetFound || (!s.works && !s.stopped)));
  if (broken) {
    const why = broken.targetFound ? 'does not move keyboard focus to its target' : 'points to a target that does not exist';
    if (!working && (page.hasMain || page.headings > 0)) {
      return { status: 'flagged', target: broken.path, detail: `The skip link "${broken.name}" ${why}; the page's ${page.hasMain ? 'main landmark' : 'headings'} still let people bypass the repeated content (a way WCAG accepts), so whether the broken link fails 2.4.1 is for a person to check.` };
    }
    if (!working) return { status: 'failed', target: broken.path, detail: `The skip link "${broken.name}" ${why}.` };
  }
  if (working) return { status: 'ok', detail: 'a working skip link moves focus past the repeated content' };
  if (page.hasMain || page.headings > 0) return { status: 'ok', detail: 'the page has a main landmark or headings to skip repeated content' };
  if (page.contentFirst) return { status: 'ok', detail: 'the content comes before any repeated block, so there is nothing to bypass' };
  if (page.toggle && page.toggleWorks) return { status: 'ok', detail: `"${clip(page.toggle, 60)}" takes the navigation's links out of the Tab order, so they can be bypassed` };
  if (page.toggle && page.toggleUntested) return { status: 'not_testable', detail: page.toggleUntested };
  const misplaced = links.find((s) => s.works && s.past === false && !s.untested);
  if (misplaced) {
    return {
      status: 'failed', target: misplaced.path,
      detail: `The skip link "${clip(misplaced.name, 60)}" moves focus to a place before the repeated links (or past all the content), so it bypasses nothing, and the page has no main landmark or headings.`,
    };
  }
  const unsure = controls.find((s) => s.untested);
  if (unsure) return { status: 'not_testable', target: unsure.path, detail: unsure.untested! };
  if (untested > 0) return { status: 'not_testable', detail: 'the page responded too slowly to test its skip link in the time allowed' };
  // Every control left here was pressed and made no bypass (moved nothing, or not past the repeated blocks).
  const idle = controls[0];
  return {
    status: 'failed',
    ...(idle ? { target: idle.path } : {}),
    detail: idle
      ? `No working skip link among the first focus stops, no main landmark and no headings: the button "${clip(idle.name, 60)}" was pressed and did not move keyboard focus past the repeated content, so keyboard and screen reader users cannot bypass repeated content.`
      : 'No skip link among the first focus stops, no main landmark and no headings: keyboard and screen reader users cannot bypass repeated content.',
  };
}

/** Names of skip links ("Skip to main content", "Jump to content", "Aller au contenu"…). */
export const SKIP_LINK_NAME = /\b(skip|jump|bypass)\b|\bgo to (the )?(main )?content\b|\bmain content\b|^\s*(to )?content\s*$|zum inhalt|aller au contenu|saltar|ir al contenido|vai al contenuto|naar (de )?inhoud/i;

// ---------------------------------------------------------------------------------------------
// 3.2.1 On focus: a change of context when an element receives focus.

export interface FocusEffects {
  /** Guard events while the key was pressed: a navigation attempt (or a new address), a popup, a dialog. */
  navigation?: string;
  popup?: string;
  dialog?: string;
  /** Focus landed on the element and a script took it away (failure technique F55). */
  focusLost?: boolean;
  /** Receiving focus, the element opened this dialog and focus moved into it. */
  dialogOpened?: string;
  /** window.open calls (even ones the browser's popup blocker stopped). */
  opens?: number;
  /** Elements added and removed, and the page's element count after. */
  added: number;
  removed: number;
  elements: number;
}

/**
 * What changed the context when an element received focus, or null:
 * - a navigation attempt or a new address (path or query, not just the fragment), a popup, a dialog;
 * - focus taken away again by a script, or moved into a dialog the element opened as it received focus
 *   (Understanding 3.2.1's own example of a failure: a help dialog that opens when a field gets focus);
 * - a large replacement of content: at least CONTEXT_MIN_ELEMENTS elements added or removed, at least
 *   CONTEXT_SHARE of the page's elements, with removals at least CONTEXT_SHARE of the change (content
 *   only added, as by lazy loading or a menu built on focus, is a change of content, not of context).
 */
export function contextChange(e: FocusEffects): string | null {
  if (e.navigation) return `started a navigation to ${clip(e.navigation, 120)}`;
  if (e.popup !== undefined) return `opened a new window${e.popup ? ` (${clip(e.popup, 120)})` : ''}`;
  if (e.opens) return 'tried to open a new window';
  if (e.dialog) return `opened a browser ${e.dialog} dialog`;
  if (e.dialogOpened) return `opened a dialog (${clip(e.dialogOpened, 100)}) and moved keyboard focus into it`;
  if (e.focusLost) return 'took the focus away again (a script removes focus when it is received)';
  const changed = e.added + e.removed;
  if (changed >= CONTEXT_MIN_ELEMENTS && changed >= CONTEXT_SHARE * Math.max(e.elements, 1) && e.removed >= CONTEXT_SHARE * changed) {
    return `replaced a large part of the page (${plural(e.added, 'element')} added, ${e.removed} removed)`;
  }
  return null;
}

/** What the guard and the kit saw while one key press moved focus to an element. */
export interface StopEvents {
  events: readonly { kind: string; url?: string; reason?: string; resourceType?: string; dialog?: string; mainFrame?: boolean }[];
  opens?: number;
  /** Navigations to another address the page started (seen in the page, before the guard sees them). */
  navs?: number;
  navTo?: string;
}

const sameAddress = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];

/**
 * The event-based changes of context (navigation, popup, dialog, window.open) seen while focus moved
 * to an element: held top-level navigations, top-level navigations the guard blocked (a form post,
 * an action address), and new addresses (history API); not frame documents, which can load lazily as
 * the page scrolls.
 */
export function eventEffects(s: StopEvents, pageUrl: string): Pick<FocusEffects, 'navigation' | 'popup' | 'dialog' | 'opens'> {
  const nav = s.events.find((e) => e.kind === 'navigation' || (e.kind === 'blocked' && e.resourceType === 'document' && e.mainFrame))
    ?? s.events.find((e) => e.kind === 'url-change' && e.url && !sameAddress(e.url, pageUrl));
  const popup = s.events.find((e) => e.kind === 'popup');
  const dialog = s.events.find((e) => e.kind === 'dialog');
  const navigation = nav ? nav.url ?? 'another address' : s.navs ? s.navTo ?? 'another address' : undefined;
  return {
    ...(navigation ? { navigation } : {}),
    ...(popup ? { popup: popup.url ?? '' } : {}),
    ...(dialog ? { dialog: dialog.dialog ?? 'alert' } : {}),
    ...(s.opens ? { opens: s.opens } : {}),
  };
}

/** Focus stops whose on-focus change of context is confirmed by focusing them again (at most this many). */
export const ONFOCUS_CONFIRM = 8;

// ---------------------------------------------------------------------------------------------
// 2.1.4 Character key shortcuts.

/**
 * Single printable keys pressed with focus on the page: the common shortcut keys of web apps and libraries first,
 * then every other lower-case letter, the digits and the punctuation keys of a US keyboard (2026-11-07, simulation
 * lab: shortcuts on a, b, q, r, w, z, 1 and . were never pressed).
 */
export const SHORTCUT_KEYS = [
  '/', '?', 's', 'k', 'j', 'f', 'm', 'c', 't', 'n', 'p', 'g', 'h', 'e', 'l', 'x',
  'a', 'b', 'd', 'i', 'o', 'q', 'r', 'u', 'v', 'w', 'y', 'z',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  // Every other printable punctuation and symbol character of a US keyboard (Sol round 1).
  '`', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+', '[', ']', '{', '}', '\\', '|', ';', ':', "'", '"', ',', '<', '.', '>',
] as const;
/** The US keyboard's printable punctuation and symbol characters (all of them are in `SHORTCUT_KEYS`). */
export const US_PUNCTUATION = '`~!@#$%^&*()-_=+[]{}\\|;:\'",<.>/?';
/** Wait after each key for its effects (plus two animation frames). */
export const SHORTCUT_SETTLE_MS = 50;
/** Keys pressed together before looking for an effect; a batch with one is retried key by key. */
export const SHORTCUT_BATCH = 10;
/** Idle time used to measure the page's own DOM activity before pressing keys. */
export const SHORTCUT_NOISE_MS = 250;
/** Idle windows (`SHORTCUT_NOISE_MS` each) waited at most, after a fresh load, for a quiet moment before a recheck press. */
export const SHORTCUT_QUIET_TRIES = 8;
/** A control that turns character shortcuts off or remaps them ("Keyboard shortcuts", "Hotkeys", "Access keys"). */
export const SHORTCUT_CONTROL = /\b(keyboard\s+)?short[\s-]?cuts?\b|\bhot[\s-]?keys?\b|\bkey\s*bindings?\b|\baccess\s*keys?\b/i;

/** Generous discovery trigger only; activating the control and re-testing the key establishes remapping. */
export function shortcutRemapPattern(key: string): string {
  const k = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `^(?=[\\s\\S]*\\b(?:ctrl|control|alt|option|shift|cmd|command|meta|modifier)\\b)(?=[\\s\\S]*(?:^|[^a-z0-9])${k}(?:$|[^a-z0-9]))`;
}

export interface KeyEffect {
  /** Focus moved from the page to this element. */
  focus?: string;
  /** Scroll distance (px). */
  scrolled: number;
  navigation?: string;
  popup?: string;
  dialog?: string;
  /** Elements added or removed. */
  changed: number;
  /** Visible elements whose hidden, open, aria-hidden or aria-expanded state changed. */
  toggled: number;
}

/**
 * What a single key did, or null. Scrolling (40 px or more), navigation attempts, popups and dialogs are
 * decisive. A focus move and DOM changes on a quiet page are done again from a fresh load (`recheck`: reload,
 * wait for a quiet moment, the key once, which must do something again); DOM changes on a page that changes by
 * itself need confirming (`confirm`) by pressing the key again. 2026-11-07, real sites: a carousel quiet for the
 * idle sample advanced while a key was down, and a pop-up opened by itself took focus; with every key pressed the
 * test lasts long enough to meet such events.
 */
export function shortcutEffect(e: KeyEffect, noise: { changed: number; toggled: number }): { what: string; confirm: boolean; recheck?: true } | null {
  if (e.navigation) return { what: `started a navigation to ${clip(e.navigation, 120)}`, confirm: false };
  if (e.popup !== undefined) return { what: 'opened a new window', confirm: false };
  if (e.dialog) return { what: `opened a browser ${e.dialog} dialog`, confirm: false };
  if (e.focus) return { what: `moved keyboard focus to ${clip(e.focus, 100)}`, confirm: false, recheck: true };
  if (e.scrolled >= 40) return { what: `scrolled the page by ${Math.round(e.scrolled)} px`, confirm: false };
  if (e.changed > 0 || e.toggled > 0) {
    const parts = [e.changed ? `${plural(e.changed, 'element')} added or removed` : '', e.toggled ? `${e.toggled} shown, hidden, opened or closed` : ''].filter(Boolean);
    const noisy = noise.changed + noise.toggled > 0;
    return { what: `changed the page (${parts.join(', ')})`, confirm: noisy, ...(noisy ? {} : { recheck: true as const }) };
  }
  return null;
}

/**
 * A confirming press: on a page that was quiet for the same time, any change again (a help panel closing on the
 * second press); on one that changed by itself, a change that clearly exceeds it.
 */
export function confirmed(withKey: number, idle: number): boolean {
  return idle === 0 ? withKey >= 1 : withKey >= 3 + 3 * idle;
}

// ---------------------------------------------------------------------------------------------
// 2.1.2 escape attempts.

/**
 * Whole names of buttons that only dismiss, from an exact list: the only buttons a trap test presses.
 * Primary actions (Continue, OK, Done, Skip, Back, Accept) and names that only start like these
 * ("Close account", "Cancel subscription") are never pressed.
 */
export const CLOSE_NAME = /^\s*(close|close (dialog|window|modal|menu|popup)|cancel|dismiss|no thanks|no, thanks|not now|[×✕✖x])\s*$/i;

// ---------------------------------------------------------------------------------------------
// Text helpers.

// Batch 19: cut at a word boundary, and a selector keeps its element's own step (src/clip.ts).
export const clip = (s: string, n = 80) => clipWords(s, n);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "Link text" (path) for a finding detail. */
export const label = (name: string | undefined, path: string) => (name ? `"${clip(name, 60)}" (${clipPath(path, 100)})` : clipPath(path, 120));
