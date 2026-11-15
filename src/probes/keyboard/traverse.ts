// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Drives the keyboard through a page (Plan 4 Task 4.1): Tab from the top, Shift+Tab from the end,
// measuring every focus stop with the in-page kit; focus indicators by computed style and pixels;
// escape attempts for a focus cycle; the skip link. Only Tab, Shift+Tab, Esc, and Enter on a
// same-page skip link or on a button inside a focus trap (never a link or a form's submit button)
// are pressed; the request guard stops anything those would send. Engine core: no
// Node-only imports.
import { forgetBusy } from '../ready.js';
import { pressTab } from '../keys.js';
import type { ProbeFinding } from '../../types.js';
import { discardUnlessAction, GUARD_LOG_CAP, isActionUrl } from '../guard.js';
import { isActionName } from '../pointerKit.js';
import { stoppedReason } from './findings.js';
import { ProbeNotTestable, type GuardEvent, type ProbeContext } from '../types.js';
import {
  installKeyboardKit, kitActiveId, kitCloseDialog, kitDescribe, kitHold, kitByPath, kitFocusId, kitFocusStyleShots, kitLayout, kitMeasureKeyed,
  kitNavCount, kitOutside, kitQuiet, kitRefocusShots, kitTabOrder, kitFocusBefore, kitRemeasure, kitRingClear, kitRelease, kitResetStart, kitRestore, kitSettleRemeasure, kitSkipAfter, kitSkipArm, kitSkipLanding, kitSkipScripted, kitStart, kitStopAfter, kitTabbables, kitTake, kitToggleLinks,
  kitRefire, kitTopFinish, kitTopPrepare, kitTrapExits, kitTrapInstructions, kitTrapRegion, kitWaitRemeasure, type KeyCounts, type KeyedStop, type KitConfig, type StopFacts,
} from './page.js';
import { decodePng, pixelDelta } from '../pixels.js';
import { before, cleanText, cropAround, cropAroundHidden, pageWords, timeFor, type Rect } from '../evidence.js';
import { kitCenter, kitCover, kitScrollTo, type CoverView } from './page.js';
import {
  clip, CLOSE_NAME, FOCUS_OTHER_CUES, focusRingContrast, laidOver, PIXEL_CHANNEL_DELTA, eventEffects, findCycle, ONFOCUS_CONFIRM, SETTLE_CAP_MS, focusVerdict, hiddenReason, INVISIBLE_OPACITY, OPAQUE_ALPHA, obscuredBy, SKIP_LINK_NAME,
  type FocusContrast, type FocusMeasure, type Hidden, type SkipLinkTest,
} from './rules.js';

export const KIT_CONFIG: KitConfig = { opaque: OPAQUE_ALPHA, invisibleOpacity: INVISIBLE_OPACITY };

export interface Limits {
  forward: number;
  backward: number;
  focusSamples: number;
  maxCycle: number;
  budgetMs: number;
  /** The deep test's limits, quoted in the core test's coverage note. */
  full?: { forward: number; backward: number; focusSamples: number };
}

export interface FocusResult {
  verdict: ReturnType<typeof focusVerdict>;
  changed?: number;
  total?: number;
  outline: string;
  styleChanged: string[];
  /**
   * 1.4.11: what draws the indicator — a ring outside the element (an outline or an outer
   * box-shadow; its contrast is measured), the browser's own focus ring (exempt: not modified by the
   * author), or another change (inside the element, a pseudo-element, a parent; not measured).
   */
  indicator?: 'ring' | 'browser' | 'other';
  /** 1.4.11: the ring's contrast against the colours next to it (undefined: no screenshots). */
  contrast?: FocusContrast;
}

/** One focus stop, as measured right after the key press that reached it. */
export interface Stop extends StopFacts {
  dir: 'forward' | 'backward';
  /** Guard events while the key press ran (navigation attempts, popups, dialogs, blocked requests). */
  events: GuardEvent[];
  hidden: Hidden | null;
  obscuredBy: string | null;
  /** Focus landed here and a script took it away. */
  lost?: boolean;
  /** Its navigation, popup or dialog did not happen again when it was focused a second time. */
  unconfirmed?: boolean;
  /** It looked hidden or covered, but the page never stopped scrolling, so it was not measured. */
  unsettled?: boolean;
  focus?: FocusResult;
  /** 2.4.11: the covering element's height (CSS px), measured at the first stop it covered (report v2 fix snippet). */
  coverHeight?: number;
  /** 2.4.11: what covers it is content laid over it (an absolutely positioned panel), not fixed or sticky content. */
  coverOver?: true;
  /** D9: the stop's focus ring shows outside what is laid over it (or that could not be told): no 2.4.7 failure. */
  ringShows?: true;
  /** 3.2.1: receiving focus, it opened this dialog and focus moved into it (`StopFacts.openedBy`). */
  opensDialog?: string;
}

/**
 * Report v2 evidence during the walk: at most one capture per criterion per run, on the first failing
 * stop, and one cover measurement per covering element (at most `MAX_COVERS`).
 */
export interface ShotState {
  obscured: boolean;
  focus: boolean;
  /** Covering element (path) → its height, or null when it could not be measured. */
  covers: Map<string, number | null>;
}
const MAX_COVERS = 3;

export interface TrapResult {
  members: number[];
  names: string[];
  region: { path: string; name?: string };
  /** How focus got out, or null when nothing worked. */
  escaped: 'shift-tab' | 'escape' | 'close' | 'advised' | null;
  /** Names of the buttons in the cycle that were pressed (Enter) to get out. */
  pressed: string[];
  /**
   * A request the guard blocked, or a navigation it held, while the way out was tried (or anything
   * the guard saw while a button was pressed, even when that got focus out): the way out may need
   * it, so a trap cannot be told from a guarded exit.
   */
  stopped?: GuardEvent;
  /** Controls in the cycle the test does not activate (links, form-owned submit/reset/image buttons, other buttons). */
  exits: { links: string[]; submits: string[]; buttons: string[] };
  /** The cycle is in a dialog (its buttons may close it). */
  dialog: boolean;
  /** The guard's log was full when the way out was tried: its silence proves nothing. */
  logFull: boolean;
  /** Focusable elements outside the cycle. */
  outside: number;
  /** The ways out were not all tried in the time allowed (`TRAP_EXAMINE_MS`, the probe's deadline): why. */
  untested?: string;
}

export interface Traversal {
  forward: Stop[];
  backward: Stop[];
  /** Focus cycles found (at most 3), in the order found. */
  traps: TrapResult[];
  skips: SkipLinkTest[];
  layout: { mainBottom?: number; footerTop?: number; hasMain: boolean; headings: number; contentFirst?: boolean; toggle?: string; toggleId?: number; toggleWorks?: boolean; toggleUntested?: string };
  /** Elements that can take focus with Tab (counted in the DOM, up to 2000). */
  tabbables: number;
  /** The soft time budget ended the traversal early. */
  partial: boolean;
  /** Skip-link candidates among the first stops that were not tested (time ran out). */
  skipsUntested: number;
  /** Elements can take focus, but Tab moved focus to none of them. */
  noFocus: boolean;
  viewportHeight: number;
  /** The page loads other pages or opens windows by itself, so those caused by focus cannot be told apart. */
  onFocusNoise?: boolean;
  /** Why the traversal could not finish, when it was not the time budget. */
  cutReason?: string;
  /** The limits of this walk (for the coverage note). */
  limits?: { forward: number; backward: number; fullForward?: number; fullBackward?: number };
  /** Focus indicators measured, kinds of element left unmeasured once the sample cap was reached. */
  samples?: { measured: number; skipped: number; fullCap?: number };
  /** Focus went into this frame and stayed there until the walk ended: the test cannot follow it. */
  frameStuck?: string;
  /**
   * Batch 18, D8: stops a focus loop kept both walks from, each reached by a Tab press from the stop before it in
   * document order and measured for 2.4.7 (and 1.4.11's ring) and 2.4.11 only. Never part of the focus order.
   */
  direct?: Stop[];
}

const sleep = (ctx: ProbeContext, ms: number) => ctx.page.waitForTimeout(ms);
const stripHash = (u: string) => u.split('#')[0]!;

/** Element ids of a kit installed after the test loaded the page again start here (`KitConfig.idBase`). */
export const RELOAD_ID_BASE = 100_000;

/** Installs the kit in the current document and starts its counters (`idBase`: see `KitConfig.idBase`). */
export async function startKit(ctx: ProbeContext, idBase = 0): Promise<void> {
  const ok = await ctx.page.evaluate(installKeyboardKit, idBase ? { ...KIT_CONFIG, idBase } : KIT_CONFIG);
  if (!ok) throw new Error('the keyboard test could not start in the page');
  await ctx.page.evaluate(kitStart, undefined);
}

/**
 * The kind a focus indicator is measured once for: the markup kind and, since batch 18 (D8), how the element looks
 * while focused and what is behind it. A reset scoped to one place (a footer, a widget, a dark band) gives the same
 * markup another look, so it is measured too. Empty when the stop has no markup kind.
 */
export function kindOf(s: Pick<StopFacts, 'sig' | 'look'>): string {
  if (!s.sig) return '';
  return s.look ? `${s.sig}\u0001${s.look}` : s.sig;
}

function hiddenOf(s: StopFacts): Hidden | null {
  if (!s.facts) return null;
  const own = hiddenReason(s.facts);
  if (own && s.proxy && !hiddenReason(s.proxy)) return null;
  return own;
}

/**
 * One measured focus stop's pictures, unfocused and focused (PNG bytes of the same clip), for the AI review only
 * (`ProbeContext.attach`, never in the run, the report or a store): neutral evidence, the open engine judges nothing
 * with it beyond its own rules. `box` is the element's border box in CSS px of the clip; `scale` image px per CSS px.
 */
export interface FocusShot {
  id: number;
  tag?: string;
  role?: string;
  name?: string;
  path?: string;
  box: { x: number; y: number; w: number; h: number };
  clip: { width: number; height: number };
  scale: number;
  before: Uint8Array;
  after: Uint8Array;
  /** The open engine's own reading: its 2.4.7 verdict, what draws the indicator, and the 1.4.11 measurement. */
  verdict: string;
  indicator: string;
  contrast?: string;
  changed?: number;
  total?: number;
}

/** At most this many stops' pictures per run (one per kind of stop the walk measured). */
export const FOCUS_SHOTS_MAX = 8;
const focusShots = new WeakMap<object, FocusShot[]>();
/** The pictures `focusTest` kept for this run (and forgets them). */
export function takeFocusShots(ctx: object): FocusShot[] {
  const out = focusShots.get(ctx) ?? [];
  focusShots.delete(ctx);
  return out;
}

/**
 * Measures the focus indicator of the focused stop: computed styles first, pixels when they do not
 * decide (2.4.7). With `contrast` (1.4.11), a ring drawn outside the element is also screenshotted
 * focused and unfocused (the same two screenshots), and its contrast against what it covers measured.
 *
 * Round trips (a remote browser pays for each): the computed styles and, when pictures are needed, the
 * blur for the first one come in one call; then the unfocused picture, the refocus, the focused picture.
 */
export async function focusTest(ctx: ProbeContext, s: StopFacts, contrast: boolean): Promise<FocusResult | undefined> {
  const { page } = ctx;
  const st = await page.evaluate(kitFocusStyleShots, { id: s.id, contrast });
  if (!st) return undefined;
  const m: FocusMeasure = { styleIndicator: st.indicator, styleClipped: st.clipped, styleChanged: st.changed, textField: !!s.textField, ringInView: st.ringInView, ...(st.pseudoLocal ? { pseudoLocal: true } : {}) };
  // Pixels for every indicator (batch 18, D7): a drawn indicator must change what is on screen too.
  const needPixels = true;
  const ring = contrast && st.kind === 'ring' && !st.clipped ? st.ring : null;
  // A ring a pseudo-element draws (batch 18, round 3): measured on its own box, the same way.
  const pseudo = contrast && !ring && st.pseudoRing && st.pseudoLocal ? st.pseudoRing : null;
  let measured: FocusContrast | undefined;
  // Blurred in the page for its pictures (as `KeyboardKit.focusStyleShots` decides: the same rule as above).
  if (st.blurred && st.crop) {
    const x = Math.floor(st.crop.x);
    const y = Math.floor(st.crop.y);
    const clip = { x, y, width: Math.max(1, Math.ceil(st.crop.x + st.crop.w) - x), height: Math.max(1, Math.ceil(st.crop.y + st.crop.h) - y) };
    // A screenshot or image that fails leaves the verdict undecided (no failure) and the ring
    // unmeasured. An in-page call that fails (refocus) is not swallowed: the page context broke, most
    // likely a navigation, which `navigationRace` turns into not_testable, never a clean result. The
    // element is focused again whatever the first picture gave, and the second is taken only when that
    // worked (a picture without focus would read as "no indicator").
    const shot = () => page.screenshot({ type: 'png', clip }).catch(() => null);
    const plain = await shot();
    const back = await page.evaluate(kitRefocusShots, s.id);
    m.styleKept = back.kept;
    const focused = plain && back.ok ? await shot() : null;
    const images = plain && focused ? await Promise.all([decodePng(focused), decodePng(plain)]).catch(() => null) : null;
    if (images) {
      const [after, before] = images;
      if (needPixels) {
        const d = pixelDelta(after, before, PIXEL_CHANNEL_DELTA);
        m.changed = d.changed;
        m.total = d.total;
      }
      if (ring) {
        // Image pixels per CSS px (device scale), and the box relative to the clip.
        const scale = after.width / clip.width;
        measured = focusRingContrast({
          before, after, band: (ring.inset ? ring.extent : ring.extent + 1) * scale, ...(ring.inset ? { inset: true } : {}),
          box: [(st.box.x - clip.x) * scale, (st.box.y - clip.y) * scale, st.box.w * scale, st.box.h * scale],
          ...(ring.color ? { outline: ring.color } : {}),
          ...(ring.gap ? { gap: ring.gap * scale } : {}),
          alsoChanged: st.changed.some((k) => FOCUS_OTHER_CUES.has(k)),
          // Only the border's colour changed besides the ring: measured too (batch 18, round 2).
          ...(st.changed.includes('border') && !st.changed.some((k) => k !== 'border' && FOCUS_OTHER_CUES.has(k)) && (st.borderWidth ?? 0) >= 1
            ? { border: (st.borderWidth ?? 0) * scale } : {}),
        });
      } else if (pseudo) {
        const scale = after.width / clip.width;
        // A ring drawn outward from a pseudo-element inside the element's box passes over the element's own border
        // first: like the element's own ring, it is judged where it covers the colours next to the element (outside
        // its box), or, when it ends before the border, where it covers the fill.
        const E = st.box;
        const P = pseudo.box;
        const gap = Math.min(P.x - E.x, P.y - E.y, E.x + E.w - (P.x + P.w), E.y + E.h - (P.y + P.h));
        const outside = !pseudo.inset && gap > 0 && pseudo.extent - gap >= 1;
        // An inner ring lying partly over the element's own border is judged on its part inside the border; one whose
        // box reaches past the element's is not measured.
        const bw = st.borderWidth ?? 0;
        const over = pseudo.inset ? Math.max(0, bw - gap) : 0;
        const inner: typeof E = { x: E.x + bw, y: E.y + bw, w: E.w - 2 * bw, h: E.h - 2 * bw };
        const at = outside ? E : over > 0 ? inner : P;
        const reach = pseudo.inset ? pseudo.extent - over : outside ? pseudo.extent - gap + 1 : gap > 0 ? Math.min(pseudo.extent + 1, gap) : pseudo.extent + 1;
        if ((pseudo.inset && gap < 0) || reach < 1) measured = { kind: 'unmeasured', reason: 'no-ring' };
        else measured = focusRingContrast({
          before, after, band: reach * scale, ...(pseudo.inset ? { inset: true } : {}),
          box: [(at.x - clip.x) * scale, (at.y - clip.y) * scale, at.w * scale, at.h * scale],
          ...(pseudo.color ? { outline: pseudo.color } : {}),
          // Any other change on focus besides the pseudo-element itself may be the indicator (not measured).
          alsoChanged: st.changed.some((k) => k !== pseudo.key && FOCUS_OTHER_CUES.has(k)),
        });
      }
      // Batch 18 precision: an element that is elsewhere or not shown without focus (a skip link) appears when focused;
      // the pixels its ring covered are not its unfocused look, so a low reading proves nothing.
      if (measured?.kind === 'failed' && st.appears) measured = { kind: 'unmeasured', reason: 'appears' };
      // The pictures, for the AI review (neutral evidence; batch 18, visual AI).
      const kept = focusShots.get(ctx) ?? [];
      if (ctx.aiEvidence && plain && focused && kept.length < FOCUS_SHOTS_MAX) {
        kept.push({
          id: s.id, ...(s.tag ? { tag: s.tag } : {}), ...(s.role ? { role: s.role } : {}), ...(s.name ? { name: s.name.slice(0, 120) } : {}), ...(s.path ? { path: s.path.slice(0, 300) } : {}),
          box: { x: st.box.x - clip.x, y: st.box.y - clip.y, w: st.box.w, h: st.box.h }, clip: { width: clip.width, height: clip.height }, scale: after.width / clip.width,
          before: new Uint8Array(plain), after: new Uint8Array(focused), verdict: focusVerdict(m), indicator: st.kind,
          ...(measured ? { contrast: measured.kind === 'unmeasured' ? `unmeasured:${measured.reason}` : measured.kind } : {}),
          ...(m.changed !== undefined ? { changed: m.changed, total: m.total } : {}),
        });
        focusShots.set(ctx, kept);
      }
    }
  }
  return {
    verdict: focusVerdict(m), ...(m.changed !== undefined ? { changed: m.changed, total: m.total } : {}),
    outline: st.outline, styleChanged: st.changed, indicator: st.kind, ...(measured ? { contrast: measured } : {}),
  };
}

export interface PassOptions {
  key: 'Tab' | 'Shift+Tab';
  dir: Stop['dir'];
  max: number;
  maxCycle: number;
  /** Signatures already measured and samples left, and kinds left unmeasured (null: no focus tests in this pass). */
  samples: { seen: Set<string>; left: number; skipped: Set<string>; contrast: boolean } | null;
  until: () => boolean;
  shots: ShotState;
}

export interface PassResult {
  stops: Stop[];
  ended: 'wrap' | 'cap' | 'time' | 'cycle' | 'empty';
  cycle?: number[];
  /** The walk ended while focus was inside this frame, after several presses there. */
  inFrame?: string;
}

/** Longest wait, once a key press has finished, for the in-page measurement sent with it; then the kit is asked directly. */
export const STOP_GRACE_MS = 100;
/** Longest the kit waits in the page for the key press (under 1 s: the listener hook records page timers from 1 s). */
export const STOP_CAP_MS = 900;

/** Resolves with the value, or undefined when `ms` ran out first. */
async function inTime<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Presses `key` and measures the stop it reached. With the key counts from the last measurement
 * (`keys`: no key was pressed since), the measurement is sent together with the press and taken in
 * the page one timer task and then one animation frame after the press's last keyup (a page timer
 * queued from its keyup handlers runs first; one queued from inside that timer may not): one round
 * trip per stop on a remote browser.
 * Otherwise (the first press of a walk, focus inside a frame, whose key events this document never
 * sees) the press comes first and the measurement after it. A keyup that never reaches the page (one
 * the page swallowed) is waited for `STOP_GRACE_MS` after the press, then measured at once.
 */
export async function pressAndMeasure(ctx: ProbeContext, key: 'Tab' | 'Shift+Tab', keys: KeyCounts | null, sequential: boolean): Promise<KeyedStop> {
  const { page } = ctx;
  // One batch of CDP key events where the browser has a session (one round trip, `pressTab`).
  const cdp = await ctx.cdp?.();
  const press = () => pressTab(ctx, cdp, key === 'Shift+Tab');
  if (!keys || sequential) {
    await press();
    return page.evaluate(kitMeasureKeyed, undefined);
  }
  const last = key === 'Tab' ? 'Tab' : 'Shift';
  const n = (last === 'Tab' ? keys.tabUp : keys.shiftUp) + 1;
  const outcome = page.evaluate(kitStopAfter, { key: last, n, cap: STOP_CAP_MS })
    .then((v) => ({ v }), (err: unknown) => ({ err }));
  await press();
  let r = await inTime(outcome, STOP_GRACE_MS);
  if (!r) {
    // The press is done but its keyup did not reach the page in time: measure now.
    await page.evaluate(kitRelease, undefined);
    r = await inTime(outcome, 1000);
  }
  if (r && 'err' in r) throw r.err;
  if (!r || 'missed' in r.v) return page.evaluate(kitMeasureKeyed, undefined);
  return r.v;
}

/**
 * Presses the key up to `max` times from the current starting point, measuring every stop. (Exported for the
 * targeted check of one element, src/probes/componentCheck.ts: the same measurement as in the walk.)
 */
export async function pass(ctx: ProbeContext, o: PassOptions): Promise<PassResult> {
  const { page } = ctx;
  const stops: Stop[] = [];
  /** Key counts from the last measurement (null: unknown, as at the start of a walk). */
  let keys: KeyCounts | null = null;
  /** Focus was inside a frame at the last measurement. */
  let framed = false;
  const seq: number[] = [];
  const frames = new Set<number>();
  let leading = 0;
  // Presses that kept focus inside the same frame.
  let frameRun = 0;
  /** Elements whose focus opened a dialog that the walk closed again (each once). */
  const openers = new Set<number>();
  const end = (ended: PassResult['ended']): PassResult => {
    const last = stops[stops.length - 1];
    const stuck = (ended === 'cap' || ended === 'time') && frameRun >= 3 && last?.frame;
    return { stops, ended, ...(stuck ? { inFrame: last.path ?? 'a frame' } : {}) };
  };
  for (let i = 0; i < o.max; i++) {
    if (o.until()) return end('time');
    const mark = ctx.guard.mark();
    const step = await pressAndMeasure(ctx, o.key, keys, framed);
    keys = step.keys;
    let s = step.facts;
    framed = !!s.frame;
    const events = ctx.guard.since(mark).filter((e) => e.kind !== 'websocket');
    if (s.id === 0) {
      if (s.lostFrom) {
        // A script took focus away: record it (3.2.1) and go on from that element.
        stops.push({ ...s, id: s.lostFrom.id, path: s.lostFrom.path, ...(s.lostFrom.name ? { name: s.lostFrom.name } : {}), dir: o.dir, events, hidden: null, obscuredBy: null, lost: true });
        seq.push(s.lostFrom.id);
        continue;
      }
      if (!stops.length && leading < 2) {
        leading++;
        continue;
      }
      return { stops, ended: stops.length ? 'wrap' : 'empty' };
    }
    if (s.openedBy && !openers.has(s.openedBy.id)) {
      // Focus opened a dialog and moved into it (3.2.1): the stop is the element that received the focus.
      // A native dialog is closed again (its own close(); no key is pressed, a page-wide Esc could close
      // what was open from the start), so the walk can go on behind it; one that stays open is walked as
      // any other content (its focus loop, if it has one, is examined as usual).
      const from = s.openedBy;
      openers.add(from.id);
      stops.push({ id: from.id, path: from.path, ...(from.name ? { name: from.name } : {}), focusins: s.focusins, added: 0, removed: 0, semantic: 0, opens: 0, navs: 0, elements: s.elements, dir: o.dir, events, hidden: null, obscuredBy: null, opensDialog: from.dialog });
      seq.push(from.id);
      const closed = await page.evaluate(kitCloseDialog, from.dialog).catch(() => false);
      framed = false;
      if (closed) continue;
    }
    if (s.frame || s.inner) {
      frames.add(s.id);
      // Tab moves inside the frame (or the browser's own controls) while the page sees one element: one stop.
      if (seq[seq.length - 1] === s.id) {
        if (s.frame) frameRun++;
        continue;
      }
    }
    frameRun = 0;
    let hidden = s.frame ? null : hiddenOf(s);
    let cover = !hidden && s.grid ? obscuredBy(s.grid) : null;
    let unsettled = false;
    const remeasure = (again: StopFacts | null) => {
      if (!again) return;
      s = { ...s, box: again.box, facts: again.facts, grid: again.grid, ...(again.proxy ? { proxy: again.proxy } : {}) };
      hidden = hiddenOf(s);
      cover = !hidden && s.grid ? obscuredBy(s.grid) : null;
    };
    if (hidden || cover) {
      // Looks hidden or covered: measure again once scrolling has stopped (a smooth scroll or a
      // script sliding the page can still be moving it).
      const settle = await page.evaluate(kitSettleRemeasure, { id: s.id, cap: SETTLE_CAP_MS });
      remeasure(settle.again);
      if (hidden) {
        // A transition or a script may still be bringing it into view.
        remeasure(await page.evaluate(kitWaitRemeasure, { id: s.id, ms: 150 }));
      }
      if (!settle.settled && (hidden || cover)) {
        // Never stopped moving: no result for it (and the criteria say so).
        unsettled = true;
        hidden = null;
        cover = null;
      }
    }
    const stop: Stop = { ...s, dir: o.dir, events, hidden, obscuredBy: cover, ...(cover && s.grid && laidOver(s.grid) ? { coverOver: true as const } : {}), ...(unsettled ? { unsettled } : {}) };
    // D9 (Sol r1, finding 7): a ring that shows outside the cover is a visible indicator.
    if (stop.coverOver && stop.obscuredBy && (await page.evaluate(kitRingClear, { id: s.id, cover: stop.obscuredBy }).catch(() => null)) !== false) stop.ringShows = true;
    stops.push(stop);
    seq.push(s.id);
    // Covered now, as the key left it (Shift+Tab at the top edge, Tab at the bottom): measured and pictured here.
    if (stop.obscuredBy) await obscuredEvidence(ctx, stop, o.shots);
    const cycle = findCycle(seq, o.maxCycle, frames);
    if (cycle) return { stops, ended: 'cycle', cycle: cycle.members };
    const smp = o.samples;
    const kind = kindOf(s);
    if (smp && smp.left <= 0 && !hidden && !stop.obscuredBy && !s.frame && !s.textField && kind && !smp.seen.has(kind)) smp.skipped.add(kind);
    if (smp && smp.left > 0 && !hidden && !stop.obscuredBy && !s.frame && !s.textField && kind && !smp.seen.has(kind)) {
      smp.seen.add(kind);
      smp.left--;
      const f = await focusTest(ctx, s, smp.contrast);
      if (f) stop.focus = f;
      if (f && (f.verdict === 'none' || f.verdict === 'clipped' || f.verdict === 'unseen')) await focusEvidence(ctx, stop, f.verdict === 'clipped' ? 'clipped' : 'none', o.shots);
    }
  }
  return end('cap');
}

/** "link “Item 3”": what the stop is, in words, for alt text. */
function stopWords(s: Pick<StopFacts, 'tag' | 'role' | 'name' | 'textField'>): string {
  const role = s.role ?? '';
  const kind = /^(link|button|checkbox|radio|tab|switch|menuitem|option|slider|combobox)$/.test(role) ? (role === 'menuitem' ? 'menu item' : role)
    : s.tag === 'a' || s.tag === 'area' ? 'link'
      : s.tag === 'button' || s.tag === 'summary' ? 'button'
        : s.textField ? 'text field'
          : s.tag === 'input' || s.tag === 'select' || s.tag === 'textarea' ? 'form field' : 'element';
  const name = cleanText(s.name, 60);
  return name ? `${kind} “${name}”` : kind;
}

/** "the sticky header", "the fixed bar at the bottom of the screen". */
function coverWords(v: CoverView): string {
  const pos = v.coverPosition === 'sticky' ? 'sticky' : 'fixed';
  const tag = v.coverTag ?? '';
  const role = v.coverRole ?? '';
  const what = tag === 'header' || role === 'banner' ? 'header'
    : tag === 'footer' || role === 'contentinfo' ? 'footer'
      : tag === 'nav' || role === 'navigation' ? 'navigation bar'
        : v.cover && v.cover.y + v.cover.h / 2 < v.vh / 2 ? 'bar at the top of the screen' : 'bar at the bottom of the screen';
  return `the ${pos} ${what}`;
}

const rect = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x, y: b.y, width: b.w, height: b.h });
/** A rectangle moved into a clip's coordinates (no clip: unchanged). */
const within = (r: Rect, clip: Rect | null) => (clip ? { ...r, x: r.x - clip.x, y: r.y - clip.y } : r);

/**
 * 2.4.11 at the stop itself: measures the covering element once (its height is the fix snippet's
 * `coverHeight`) and, on the run's first covered stop and with an evidence sink, pictures it at once
 * (a `ghost` box where the element is, a `fail` box on the covering element), then scrolls the element
 * to the middle of the viewport for the `expected` picture and puts the scroll position back. Both
 * images are cropped around the hidden element (`cropAroundHidden`), the second as wide as the first. Never
 * throws: a failure here leaves the walk's result as it was.
 */
async function obscuredEvidence(ctx: ProbeContext, stop: Stop, st: ShotState): Promise<void> {
  const path = stop.obscuredBy!;
  const known = st.covers.get(path);
  if (known !== undefined) {
    if (known !== null) stop.coverHeight = known;
    return;
  }
  if (st.covers.size >= MAX_COVERS) return;
  let view: CoverView | null = null;
  try {
    view = await ctx.page.evaluate(kitCover, stop.id);
  } catch {
    view = null;
  }
  const height = view?.cover && view.cover.h >= 1 ? Math.round(view.cover.h) : null;
  st.covers.set(path, height);
  if (height !== null) stop.coverHeight = height;
  if (!ctx.evidence || st.obscured || !view?.cover || height === null || !timeFor(ctx, 4000)) return;
  st.obscured = true;
  const what = stopWords(stop);
  const screen = { width: view.vw, height: view.vh };
  try {
    // Cropped around the hidden element (± 300 px, the cover's height), not the full-width union
    // with a full-width header, so the pair reads at phone width. Only the cover carries a tag: the
    // ghost lies inside the cover, and a second tag there would sit on top of the first.
    const clip = cropAroundHidden(rect(view.box), rect(view.cover), screen) ?? cropAround([rect(view.box), rect(view.cover)], screen);
    const found = await ctx.evidence({
      criterion: '2.4.11', ...(clip ? { clip } : {}),
      boxes: [{ ...within(rect(view.box), clip), kind: 'ghost' }, { ...within(rect(view.cover), clip), kind: 'fail', label: `${height} px` }],
      alt: `${pageWords(view.title)} after pressing ${stop.dir === 'backward' ? 'Shift+Tab' : 'Tab'}: the focused ${what} is hidden under ${coverWords(view)}.`,
      caption: `Focus hidden behind ${coverWords(view)}`,
      group: 'focus-obscured', groupLabel: 'Found: focus hidden',
    });
    if (!found || !timeFor(ctx, 3000)) return;
    try {
      // Two animation frames in the page, at most 100 ms; a page that stalls them is not waited for.
      const moved = await before(ctx.page.evaluate(kitCenter, stop.id), Math.min(Date.now() + 1000, ctx.deadline - 2000));
      if (moved && !moved.covered) {
        // As wide as the found image, so the pair lines up side by side.
        const clip2 = cropAround([rect(moved.box)], screen, clip ? { width: clip.width } : {});
        await ctx.evidence({
          criterion: '2.4.11', ...(clip2 ? { clip: clip2 } : {}),
          boxes: [{ ...within(rect(moved.box), clip2), kind: 'expected' }],
          alt: `The same ${what} scrolled to the middle of the screen, where it can be seen with keyboard focus.`,
          group: 'focus-obscured', groupLabel: 'Expected: focus in view',
        });
      }
    } finally {
      await ctx.page.evaluate(kitScrollTo, { x: view.sx, y: view.sy }).catch(() => {});
    }
  } catch {
    // Evidence never changes the walk's result.
  }
}

/** Smallest evidence clip around an element without a visible focus indicator (CSS px). */
const FOCUS_CLIP = { width: 480, height: 270, pad: 24 } as const;

/** 2.4.7: on the run's first stop without a visible focus indicator, a picture of the element, boxed. Never throws. */
async function focusEvidence(ctx: ProbeContext, stop: Stop, verdict: 'none' | 'clipped', st: ShotState): Promise<void> {
  if (!ctx.evidence || st.focus || !timeFor(ctx, 3000)) return;
  st.focus = true;
  try {
    const view = await ctx.page.evaluate(kitCover, stop.id);
    if (!view || view.box.w < 1 || view.box.h < 1) return;
    const b = view.box;
    const width = Math.min(view.vw, Math.max(FOCUS_CLIP.width, b.w + 2 * FOCUS_CLIP.pad));
    const height = Math.min(view.vh, Math.max(FOCUS_CLIP.height, b.h + 2 * FOCUS_CLIP.pad));
    const clip = {
      x: Math.round(Math.max(0, Math.min(view.vw - width, b.x + b.w / 2 - width / 2))),
      y: Math.round(Math.max(0, Math.min(view.vh - height, b.y + b.h / 2 - height / 2))),
      width: Math.round(width), height: Math.round(height),
    };
    const what = stopWords(stop);
    await ctx.evidence({
      criterion: '2.4.7', clip,
      boxes: [{ x: b.x - clip.x, y: b.y - clip.y, width: b.w, height: b.h, kind: 'fail' }],
      caption: verdict === 'clipped' ? 'Focus outline cut off' : 'No visible focus indicator',
      alt: `${pageWords(view.title)} with keyboard focus on the ${what}: ${verdict === 'clipped' ? 'its focus outline is cut off by the element around it, so' : 'nothing shows that it has focus, so'} a keyboard user cannot see where they are.`,
    });
  } catch {
    // Evidence never changes the walk's result.
  }
}

/**
 * Tries to move focus out of a cycle: Shift+Tab, Esc (and Tab), then Enter on its buttons with a
 * dismissive name. Anything the guard saw while a button was pressed is kept as `stopped`, even when
 * focus got out; without a way out, so is a blocked request or a held navigation.
 */
export async function escapeTrap(ctx: ProbeContext, members: number[], late: () => boolean): Promise<Pick<TrapResult, 'escaped' | 'pressed' | 'stopped' | 'exits' | 'logFull' | 'untested'>> {
  const full = logFull(ctx);
  const mark = ctx.guard.mark();
  const r = await tryEscape(ctx, members, late);
  const stopped = r.pressEvent ?? (r.escaped ? undefined : ctx.guard.since(mark).find(isStop));
  // Full before, or filled during the attempt: what a press sent may be missing from the log.
  return { escaped: r.escaped, pressed: r.pressed, exits: r.exits, logFull: full || logFull(ctx), ...(stopped ? { stopped } : {}), ...(r.untested ? { untested: r.untested } : {}) };
}

/** A blocked request or a held navigation (not a popup, a dialog or a socket). */
const isStop = (e: GuardEvent) => e.kind === 'blocked' || e.kind === 'navigation';

/**
 * A focus cycle the walk found, Tab by Tab at a person's pace: from each of its first members, Tab, then
 * wait TRAP_CONFIRM_MS. A member focus comes back to (a field whose timer takes focus back 300 ms after
 * it is left) is the trap on its own: the walk's quick presses ran ahead of the timer and saw the stops
 * after it as a cycle. Otherwise the cycle as found.
 */
async function slowCycle(ctx: ProbeContext, members: number[], late: () => boolean): Promise<number[]> {
  const { page } = ctx;
  if (members.length < 2) return members;
  for (const m of members.slice(0, 4)) {
    if (late()) break;
    if (!(await page.evaluate(kitFocusId, m).catch(() => false))) continue;
    await page.keyboard!.press('Tab');
    await sleep(ctx, TRAP_CONFIRM_MS);
    await page.evaluate(kitHold, undefined).catch(() => {});
    if ((await page.evaluate(kitActiveId, undefined).catch(() => 0)) === m) return [m];
  }
  return members;
}

async function tryEscape(ctx: ProbeContext, members: number[], late: () => boolean): Promise<{ escaped: TrapResult['escaped']; pressed: string[]; exits: TrapResult['exits']; pressEvent?: GuardEvent; untested?: string }> {
  const { page } = ctx;
  const kb = page.keyboard!;
  const set = new Set(members);
  const outNow = async () => {
    // Where focus stays, not where the key left it for a moment (a field that takes focus back 60 ms later).
    await page.evaluate(kitHold, undefined).catch(() => {});
    const id = await page.evaluate(kitActiveId, undefined);
    return id === 0 || !set.has(id);
  };
  // Out only when focus is still out a while later: a timer may take it back after the walk's own pace
  // (300 ms after Tab, Grok round 1), which a person pressing keys at a person's pace never outruns.
  const out = async () => {
    if (!(await outNow())) return false;
    await sleep(ctx, TRAP_CONFIRM_MS);
    return outNow();
  };
  const n = members.length;
  const pressed: string[] = [];
  // What the cycle offers, read before anything is pressed.
  const found = await page.evaluate(kitTrapExits, { members, pattern: CLOSE_NAME.source, max: 3 });
  const exits = { links: found.links, submits: found.submits, buttons: found.buttons };
  const outOfTime = { escaped: null, pressed, exits, untested: 'there was no time left to try every way out of it' } as const;
  for (let i = 0; i < 2 * n + 2; i++) {
    if (late()) return outOfTime;
    await kb.press('Shift+Tab');
    if (await out()) return { escaped: 'shift-tab', pressed, exits };
  }
  if (late()) return outOfTime;
  // From here the walk tries to dismiss what holds it (Escape, a close button, an advised key): like any test that tries
  // a dismissal, it asks the runner for a fresh page, so every later test sees the page as loaded (popupAside.ts, rule
  // 8). Batch 15b: text contrast and non-text contrast now wait for content and run after this walk. Never for an
  // address that looks like an action: that page is not loaded again (F6), so the next test reuses it as before.
  discardUnlessAction(ctx);
  await kb.press('Escape');
  await sleep(ctx, 100);
  if (await out()) return { escaped: 'escape', pressed, exits };
  for (let i = 0; i < n + 2; i++) {
    if (late()) return outOfTime;
    await kb.press('Tab');
    if (await out()) return { escaped: 'escape', pressed, exits };
  }
  // Only buttons with a dismissive name ("Close", "×", "Cancel", "No thanks"…); never links, form-owned
  // submit/reset/image buttons, or primary actions. Formless buttons cannot submit or reset a form.
  // The guard stops anything they would send.
  for (const b of found.press) {
    if (late()) return outOfTime;
    if (!(await page.evaluate(kitFocusId, b.id))) continue;
    pressed.push(b.name ?? b.path);
    const pm = ctx.guard.mark();
    await kb.press('Enter');
    await sleep(ctx, 100);
    let gotOut = await out();
    for (let i = 0; i < n + 2 && !gotOut; i++) {
      await kb.press('Tab');
      gotOut = await out();
    }
    const pressEvent = ctx.guard.since(pm).find((e) => e.kind !== 'websocket');
    if (pressEvent) return { escaped: gotOut ? 'close' : null, pressed, exits, pressEvent };
    if (gotOut) return { escaped: 'close', pressed, exits };
  }
  // WCAG 2.1.2: a way out that needs more than Tab, arrows or Esc is allowed when the page tells the user the method
  // ("Press Ctrl+M to exit"). A key combination the page's text advises is pressed from inside the cycle.
  const instructions = await page.evaluate(kitTrapInstructions, members).catch(() => null);
  if (instructions === null) return { escaped: null, pressed, exits, untested: 'its instructions could not be read' };
  for (const key of advisedExitKeys(instructions.text)) {
    if (late()) return outOfTime;
    if (!(await page.evaluate(kitFocusId, members[0]!).catch(() => false))) continue;
    pressed.push(key);
    const pm = ctx.guard.mark();
    await kb.press(key);
    await sleep(ctx, 100);
    const gotOut = await out();
    const pressEvent = ctx.guard.since(pm).find((e) => e.kind !== 'websocket');
    if (pressEvent) return { escaped: gotOut ? 'advised' : null, pressed, exits, pressEvent };
    if (gotOut) return { escaped: 'advised', pressed, exits };
  }
  if (instructions.exits.split('\n').some((line) => line.trim() && !advisedExitKeys(line).length)) {
    return { escaped: null, pressed, exits, untested: 'instructions describe a way out whose key could not be identified' };
  }
  return { escaped: null, pressed, exits };
}

/** Candidate keys named in nearby instructions, in any word order. Their behavior is always tested. */
export function advisedExitKeys(text: string): string[] {
  const MOD: Record<string, string> = { ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', cmd: 'Meta', command: 'Meta', meta: 'Meta' };
  const NAMES: Record<string, string> = { esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space', spacebar: 'Space', delete: 'Delete', backspace: 'Backspace', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
  const re = /\b((?:(?:ctrl|control|alt|option|shift|cmd|command|meta)\s*\+\s*)*(?:f(?:2[0-4]|1[0-9]|[1-9])|escape|esc|enter|return|tab|spacebar|space|delete|backspace|home|end|pageup|pagedown|arrow(?:up|down|left|right)|[a-z0-9]))\b/gi;
  const out: string[] = [];
  for (const line of text.split(/[.!?\n]/)) {
    if (!/\b(?:press|use|hit|type|key|leav(?:e|ing)|exit(?:ing)?|escape|clos(?:e|ing)|move|continue)\b|\+/i.test(line)) continue;
    const modifiers = [...new Set([...line.matchAll(/\b(ctrl|control|alt|option|shift|cmd|command|meta)\b/gi)].map((m) => MOD[m[1]!.toLowerCase()]!))];
    for (const m of line.matchAll(re)) {
      const parts = m[1]!.split('+').map((p) => p.trim().toLowerCase());
      const key = parts.pop()!;
      // A trailing key from an unknown chord ("Hyper+Q") does not establish that Q alone was advised.
      if (!parts.length && /\+\s*$/.test(line.slice(0, m.index))) continue;
      const name = NAMES[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key);
      // Prose such as "Control and Q" is a discovery trigger too; actual escape is still verified.
      if (!parts.length && modifiers.length) {
        const inferred = [...modifiers, name].join('+');
        if (!out.includes(inferred)) out.push(inferred);
      }
      const k = [...new Set(parts.map((p) => MOD[p]!)), name].join('+');
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

/** How long focus must stay out of a focus cycle before the way out counts (`tryEscape`). */
const TRAP_CONFIRM_MS = 500;
/** Time for examining one focus cycle (the re-walk at a person's pace and the ways out). */
const TRAP_EXAMINE_MS = 12_000;

/** How long focus must stay on an element before the walk measures it (`HOLD_STILL_MS` in page.ts). */
const FOCUS_STILL_MS = 100;

/**
 * Presses a control that says it hides or shows the navigation (SCR28) and counts the navigation's links in
 * the Tab order before and after: it bypasses them when it takes them out (or they are out already, a
 * collapsed menu). The page is put back afterwards. `sameKit`: the walk did not reload the page.
 */
async function testToggle(ctx: ProbeContext, id: number, sameKit: boolean, name: string): Promise<{ toggleWorks?: boolean; toggleUntested?: string }> {
  const { page } = ctx;
  if (!sameKit) return { toggleUntested: `the page was loaded again, so "${clip(name, 60)}" was not pressed to see whether it hides the navigation` };
  const url = page.url?.() ?? ctx.url;
  const start = await page.evaluate(kitToggleLinks, id).catch(() => ({ links: -1, controls: false }));
  const before = start.links;
  if (before < 0) return {};
  // A collapsed navigation counts only when it is the one the toggle controls (Grok round 2: an empty region named
  // by aria-controls beside a full navigation is no bypass).
  if (before === 0) return start.controls ? { toggleWorks: true } : {};
  if (!(await page.evaluate(kitFocusId, id).catch(() => false))) return {};
  try {
    const mark = ctx.guard.mark();
    await page.keyboard!.press('Enter');
    await sleep(ctx, 300);
    const after = (await page.evaluate(kitToggleLinks, id).catch(() => ({ links: -1, controls: false }))).links;
    const stopped = ctx.guard.since(mark).find(isStop);
    if (stopped) return { toggleUntested: `pressing "${clip(name, 60)}" to hide the navigation also did something the test stopped: ${stoppedReason(stopped)}` };
    return { toggleWorks: after === 0 };
  } finally {
    await page.evaluate(kitRestore, url).catch(() => {});
  }
}

/**
 * A skip control's name names where it goes (Fable review F2): "Skip to main content", "Skip navigation", "Jump to
 * content", "Main content" and the other languages' forms. "Skip", "Skip intro", "Skip tour" or "Skip this step" name
 * no destination; a name that shows, hides or closes something, or an action name (`isActionName`), is never one.
 */
export const SKIP_CONTROL_NAME = /\bskip\s+(to\b|over\b|(the\s+)?(main\s+)?(navigation|nav|menu|links|header)\b)|\bjump\s+to\b|\bbypass\s+(the\s+)?(main\s+)?(navigation|nav|menu|links|header)\b|\bmain\s+content\b|zum inhalt|aller au contenu|saltar al contenido|ir al contenido|vai al contenuto|naar (de )?inhoud/i;
const NOT_A_SKIP = /\b(hide|show|close|collapse|expand|toggle|open)\b/i;

/**
 * A skip control: a button (not a link) among the first focus stops whose name names where it skips to
 * (`SKIP_CONTROL_NAME`), whose script moves the page to its content (sets the fragment, `location.assign('#main')`, or
 * puts focus there, `main.focus()`): single-page apps whose router owns the fragment make their skip link this way.
 * W3C precision lane (2026-11-11). Pressed only where it can change 2.4.1 (`traverse`).
 */
export const isSkipControl = (s: Pick<Stop, 'tag' | 'role' | 'itype' | 'name' | 'anchor'>): boolean => {
  const name = s.name ?? '';
  if (s.anchor || !SKIP_CONTROL_NAME.test(name) || NOT_A_SKIP.test(name) || isActionName(name)) return false;
  const role = (s.role ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (role) return role === 'button';
  return s.tag === 'button' || (s.tag === 'input' && /^(button|submit)$/i.test(s.itype ?? ''));
};

/**
 * Presses a skip control with Enter and checks where keyboard focus goes, as for a skip link: its target is what the
 * fragment it set names, or where it put focus. One that moves nothing is no way to bypass anything, but never a broken
 * skip link either (`control` in `bypassVerdict`): its name may mean something else ("Skip intro"). One that would send
 * a form (a submit button in a form, "Skip this step") is never pressed and is no skip control: sending a form leaves
 * the page, it moves nothing within it (null).
 */
async function testSkipControl(ctx: ProbeContext, s: Stop, sameKit: boolean): Promise<SkipLinkTest | null> {
  const { page } = ctx;
  const base = { name: s.name ?? '', path: s.path ?? '', control: true as const };
  const untested = (why: string): SkipLinkTest => ({ ...base, targetFound: true, works: false, toMain: false, untested: why });
  const url = page.url?.() ?? ctx.url;
  const id = sameKit ? s.id : await page.evaluate(kitByPath, s.path ?? '');
  if (!id || !(await page.evaluate(kitFocusId, id))) {
    return untested(`the skip control "${clip(base.name, 60)}" could not be focused again, so it was not pressed`);
  }
  const full = logFull(ctx);
  try {
    if ((await page.evaluate(kitSkipArm, id)).sends) return null;
    const mark = ctx.guard.mark();
    await page.keyboard!.press('Enter');
    await sleep(ctx, 150);
    const found = await page.evaluate(kitSkipScripted, id);
    const stopped = ctx.guard.since(mark).find(isStop);
    if (stopped) return untested(`pressing the skip control "${clip(base.name, 60)}" also did something the test stopped: ${stoppedReason(stopped)}`);
    if (!found.found) {
      if (full || logFull(ctx)) return untested('the request log was full when the skip control was pressed, so a stopped request could not be ruled out');
      return { ...base, targetFound: false, works: false, toMain: false };
    }
    const landing = await skipLanded(ctx, id, 0);
    await page.keyboard!.press('Tab');
    const after = await page.evaluate(kitSkipAfter, id);
    const wrapped = after.pos === 'none' || (after.pos === 'before' && !!after.wrapped);
    const works = landing.inTarget || after.pos === 'inside' || after.pos === 'after' || (wrapped && !!after.nothingAfter && !!after.targetShown);
    if (!works && (full || logFull(ctx))) return untested('the request log was full when the skip control was pressed, so a stopped request could not be ruled out');
    return { ...base, targetFound: true, works, toMain: works && (!!found.inMain || after.inMain), ...(after.past === false ? { past: false } : {}) };
  } finally {
    await page.evaluate(kitRestore, url).catch(() => {});
  }
}

/**
 * Where focus is after a skip link or control was activated (`kitSkipLanding`), read again every 100 ms until it is in
 * the target or `SKIP_SETTLE_MS` has passed (batch 19, real-site dev split: a page's script scrolls to the content with
 * a 300 ms animation and moves focus at its end; read at 150 ms, the working link was failed). `first`: the first wait.
 */
export const SKIP_SETTLE_MS = 1200;
async function skipLanded(ctx: ProbeContext, id: number, first = 150): Promise<{ inTarget: boolean }> {
  if (first) await sleep(ctx, first);
  let landing = await ctx.page.evaluate(kitSkipLanding, id);
  for (let waited = first; !landing.inTarget && waited < SKIP_SETTLE_MS && !ctx.signal.aborted; waited += 100) {
    await sleep(ctx, 100);
    landing = await ctx.page.evaluate(kitSkipLanding, id);
  }
  return landing;
}

/**
 * Activates a same-page skip link with Enter and checks where keyboard focus goes. `sameKit`: the page
 * was not reloaded since the walk, so the stop's id still names the link.
 */
async function testSkipLink(ctx: ProbeContext, s: Stop, sameKit: boolean): Promise<SkipLinkTest> {
  const { page } = ctx;
  const base = { name: s.name ?? '', path: s.path ?? '' };
  if (!s.anchor?.targetFound) return { ...base, targetFound: false, works: false, toMain: false };
  const untested = (why: string): SkipLinkTest => ({ ...base, targetFound: true, works: false, toMain: false, untested: why });
  const url = page.url?.() ?? ctx.url;
  const id = sameKit ? s.id : await page.evaluate(kitByPath, s.path ?? '');
  if (!id || !(await page.evaluate(kitFocusId, id))) {
    return untested(`the skip link "${clip(base.name, 60)}" could not be focused again, so it was not activated`);
  }
  const full = logFull(ctx);
  try {
    const mark = ctx.guard.mark();
    await page.keyboard!.press('Enter');
    const landing = await skipLanded(ctx, id);
    await page.keyboard!.press('Tab');
    const after = await page.evaluate(kitSkipAfter, id);
    // Nothing after the target takes focus and the next Tab left the page, or the browser wrapped it to the page's
    // very first stop: the link still moved the sequential focus starting point there (ACT cf77f2's passed example).
    // Focus that landed anywhere else before the target is never success. A target at the page's end with no
    // content to go by is then not past the repeated links (`skipPast`; Grok round 2's empty end box).
    const wrapped = after.pos === 'none' || (after.pos === 'before' && !!after.wrapped);
    const works = landing.inTarget || after.pos === 'inside' || after.pos === 'after' || (wrapped && !!after.nothingAfter && !!after.targetShown);
    const stopped = ctx.guard.since(mark).find(isStop);
    // Focus moved, but the Enter also tried to send something: it did not finish under the guard.
    if (works && stopped) return untested(`activating the skip link "${clip(base.name, 60)}" also did something the test stopped: ${stoppedReason(stopped)}`);
    if (!works && (full || logFull(ctx))) return untested('the request log was full when the skip link was activated, so a stopped request could not be ruled out');
    return { ...base, targetFound: true, works, toMain: works && (s.anchor.toMain || after.inMain), ...(after.past === false ? { past: false } : {}), ...(stopped ? { stopped } : {}) };
  } finally {
    await page.evaluate(kitRestore, url).catch(() => {});
  }
}

/**
 * Focuses each stop that changed the context through an event (navigation, popup, dialog,
 * window.open) once more, with the page's address put back first: what does not happen again came
 * from something else, such as a timer, and is marked `unconfirmed`. Stops that cannot be focused
 * again keep their result.
 */
export async function confirmOnFocus(ctx: ProbeContext, stops: Stop[], pageUrl: string, broken: boolean, since: number): Promise<'done' | 'late' | 'noisy'> {
  const { page } = ctx;
  const ids: number[] = [];
  for (const s of stops) {
    if (ids.includes(s.id)) continue;
    if (Object.keys(eventEffects(s, pageUrl)).length) ids.push(s.id);
  }
  // Navigations or popups while the keys were pressed but between measurements: check the idle page too.
  // The page's own count of navigations it started does not wait for the guard, which can lag far
  // behind on a busy machine.
  const unattributed = Object.keys(eventEffects({ events: ctx.guard.since(since) }, pageUrl)).length > 0
    || (await page.evaluate(kitNavCount, undefined)) > 0;
  if (!ids.length && !unattributed) return 'done';
  const unconfirm = (list: readonly number[]) => { for (const s of stops) if (list.includes(s.id)) s.unconfirmed = true; };
  const late = () => ctx.signal.aborted || Date.now() > ctx.deadline - 3000;
  // Beyond the first few, or without the time or a working page to check them: not counted (and the
  // result says the test could not finish).
  if (ids.length > ONFOCUS_CONFIRM) unconfirm(ids.splice(ONFOCUS_CONFIRM));
  if (broken || late()) {
    unconfirm(ids);
    return ids.length ? 'late' : 'done';
  }
  // A page that navigates or opens windows by itself (a repeating timer): nothing is confirmed.
  // Popup events arrive a little after the call: let the last ones in before the idle window.
  await page.evaluate(kitRestore, pageUrl);
  await sleep(ctx, 150);
  const idleMark = ctx.guard.mark();
  const navsBefore = await page.evaluate(kitNavCount, undefined);
  await sleep(ctx, 100);
  const idleCounts = await page.evaluate(kitTake, undefined);
  const idleNavs = (await page.evaluate(kitNavCount, undefined)) - navsBefore;
  const idle = eventEffects({ events: ctx.guard.since(idleMark), opens: idleCounts.opens, navs: idleNavs, ...(idleCounts.navTo ? { navTo: idleCounts.navTo } : {}) }, pageUrl);
  if (Object.keys(idle).length) {
    unconfirm(ids);
    return 'noisy';
  }
  for (const [i, id] of ids.entries()) {
    if (late()) {
      unconfirm(ids.slice(i));
      return 'late';
    }
    await page.evaluate(kitRestore, pageUrl);
    const mark = ctx.guard.mark();
    const r = await page.evaluate(kitRefire, id);
    if (!r.connected) continue;
    await sleep(ctx, 150);
    const after = await page.evaluate(kitTake, undefined);
    const again = eventEffects({ events: ctx.guard.since(mark), opens: r.opens + after.opens, navs: r.navs + after.navs }, pageUrl);
    if (!Object.keys(again).length) unconfirm([id]);
  }
  return 'done';
}

/** Reloads the page (after escape attempts changed it) and restarts the kit. */
async function reload(ctx: ProbeContext): Promise<void> {
  await reloadPage(ctx, ctx.page.url?.() ?? ctx.url);
  await sleep(ctx, 500);
  // A new document and a new kit: its stops get ids of their own, apart from those measured before.
  await startKit(ctx, RELOAD_ID_BASE);
}

/**
 * Loads the page under test again. Its timers are stopped first: one that keeps assigning
 * location.href would otherwise interrupt the reload (the guard holds that navigation, and the
 * reload never finishes).
 */
export async function reloadPage(ctx: ProbeContext, url: string): Promise<void> {
  // The page was loaded once by the scan; an address that looks like an action is not loaded again.
  if (isActionUrl(url)) throw new ProbeNotTestable(`the page's address looks like an action (${clip(stripHash(url), 120)}), so the test does not load it again`);
  // A new document: its content wait starts fresh (ready.ts).
  forgetBusy(ctx.page);
  // Not caught: a page whose timers keep running could interrupt the reload.
  await ctx.page.evaluate(kitQuiet, undefined);
  await ctx.page.goto(stripHash(url), { waitUntil: 'load', timeout: Math.max(3000, Math.min(15_000, ctx.deadline - Date.now() - 2000)) });
  // The document this test checks from here on (runner.ts): one that replaces it later is not.
  await ctx.reloadedPage?.();
}

/** The guard's log is full: it no longer records what the page does, so its silence proves nothing. */
export const logFull = (ctx: ProbeContext) => ctx.guard.mark() >= GUARD_LOG_CAP;

/** For criteria judged from the guard's log: not testable when the log filled up (unless already decided otherwise). */
export function fullLogFindings(ctx: ProbeContext, criteria: readonly string[], findings: readonly ProbeFinding[]): ProbeFinding[] {
  if (!logFull(ctx)) return [];
  return criteria.filter((c) => !findings.some((f) => f.criterion === c && (f.status === 'failed' || f.status === 'not_testable' || f.status === 'not_applicable'))).map((criterion) => ({
    criterion, status: 'not_testable',
    detail: 'the page kept loading other pages or sending requests by itself, more often than the test can record, so its effects could not be told apart',
  }));
}

/**
 * A step that failed while the page was trying to load other pages (navigations the guard held
 * since `mark`): a navigation raced the step (a reload interrupted, a context destroyed). That is a
 * `not_testable` result with the reason, never an error or a clean result. Other errors are rethrown.
 */
export function navigationRace(ctx: ProbeContext, mark: number, err: unknown): never {
  if (err instanceof ProbeNotTestable || (err instanceof Error && err.name === 'ProbeNotTestable')) throw err;
  const nav = ctx.guard.since(mark).find((e) => e.kind === 'navigation') ?? (logFull(ctx) ? [...ctx.guard.events].reverse().find((e) => e.kind === 'navigation') : undefined);
  // A destroyed page context is itself proof that another page was loaded (one the guard let through
  // between two tests, say), even when the guard logged nothing.
  const destroyed = /Execution context was destroyed|frame was detached/i.test(err instanceof Error ? err.message : String(err));
  if (!nav && destroyed) throw new ProbeNotTestable('the page loaded another page by itself while the test ran, so the test could not finish');
  if (nav) {
    throw new ProbeNotTestable(`the page kept trying to load another page${nav.url ? ` (${nav.url})` : ''} by itself or on key presses while the test ran, so the test could not finish`);
  }
  throw err;
}

/** Runs in the page: closes the native modal dialogs that are open (as their own close control would). Returns how many. */
function closeModalDialogs(): number {
  let n = 0;
  for (const d of Array.from(document.querySelectorAll('dialog'))) {
    try {
      if (d.open && d.matches(':modal')) {
        d.close();
        n++;
      }
    } catch {
      // a dialog that cannot be closed from script stays
    }
  }
  return n;
}

/** Stops in document order the direct measurement looks at, at most. */
const UNREACHED_MAX = 600;

/**
 * Batch 18, D8: the focus stops a focus loop kept the walks from. Each is reached with keyboard modality: focus is put
 * on the stop before it in document order (none for the first) and Tab is pressed, so a page that shows its focus
 * look only after a key press shows it here too. A stop Tab does not land on (a script sent focus elsewhere) is
 * skipped. Each new kind (`kindOf`) is measured as on the walk, within the samples left; a stop entirely covered is
 * kept for 2.4.11 (and 2.4.7 when the cover is laid over it). Bounded by the walk's own `until`.
 */
async function measureUnreached(ctx: ProbeContext, visited: ReadonlySet<string>, samples: NonNullable<PassOptions['samples']>, shots: ShotState, until: () => boolean): Promise<Stop[]> {
  const { page } = ctx;
  const order = await page.evaluate(kitTabOrder, UNREACHED_MAX);
  const out: Stop[] = [];
  for (let i = 0; i < order.length && samples.left > 0 && !until(); i++) {
    const id = order[i]!;
    const d = await page.evaluate(kitDescribe, id).catch(() => null);
    if (!d?.path || visited.has(d.path)) continue;
    if (!(await page.evaluate(kitFocusBefore, i > 0 ? order[i - 1]! : 0).catch(() => false))) continue;
    const mark = ctx.guard.mark();
    await page.keyboard!.press('Tab');
    await page.evaluate(kitHold, undefined).catch(() => false);
    // A script sent the Tab elsewhere (the loop itself, often): focus the stop from script instead. The last input
    // was a key press, so the browser (and a script that tracks it) still treats this focus as keyboard focus.
    if ((await page.evaluate(kitActiveId, undefined).catch(() => 0)) !== id) {
      if (!(await page.evaluate(kitFocusId, id).catch(() => false))) continue;
      await page.evaluate(kitHold, undefined).catch(() => false);
      if ((await page.evaluate(kitActiveId, undefined).catch(() => 0)) !== id) continue;
    }
    const settled = await page.evaluate(kitSettleRemeasure, { id, cap: SETTLE_CAP_MS }).catch(() => null);
    const s = settled?.again ?? (await page.evaluate(kitRemeasure, id).catch(() => null));
    if (!s || s.frame || s.inner || s.textField) continue;
    const hidden = hiddenOf(s);
    const cover = !hidden && s.grid ? obscuredBy(s.grid) : null;
    const events = ctx.guard.since(mark).filter((e) => e.kind !== 'websocket');
    const stop: Stop = { ...s, dir: 'forward', events, hidden, obscuredBy: cover, ...(cover && s.grid && laidOver(s.grid) ? { coverOver: true as const } : {}), ...(settled && !settled.settled ? { unsettled: true } : {}) };
    if (stop.unsettled || hidden) continue;
    if (cover) {
      if (stop.coverOver && (await page.evaluate(kitRingClear, { id, cover }).catch(() => null)) !== false) stop.ringShows = true;
      out.push(stop);
      continue;
    }
    const kind = kindOf(s);
    if (!kind || samples.seen.has(kind)) continue;
    samples.seen.add(kind);
    samples.left--;
    const f = await focusTest(ctx, s, samples.contrast);
    if (f) stop.focus = f;
    if (f && (f.verdict === 'none' || f.verdict === 'clipped' || f.verdict === 'unseen')) await focusEvidence(ctx, stop, f.verdict === 'clipped' ? 'clipped' : 'none', shots);
    out.push(stop);
  }
  return out;
}

/**
 * The whole traversal. The kit must be started. Order: Tab from the top (focus indicators measured on
 * the way, one element kind at a time); escape attempts for a focus cycle (then a reload); the skip
 * link among the first stops; Shift+Tab from the end.
 */
export async function traverse(ctx: ProbeContext, limits: Limits, opts: { skipLinks: boolean; focusContrast?: boolean } = { skipLinks: true }): Promise<Traversal> {
  const { page } = ctx;
  const started = Date.now();
  const pageUrl = stripHash(page.url?.() ?? ctx.url);
  /** Time allowed for the browser's round trips on top of the page's own budget (set below). */
  let transport = 0;
  const until = () => ctx.signal.aborted || Date.now() > Math.min(started + limits.budgetMs + transport, ctx.deadline - 3000);
  const layout: Traversal['layout'] = await page.evaluate(kitLayout, undefined);
  const tabbables = await page.evaluate(kitTabbables, 2000);
  const samples = { seen: new Set<string>(), left: limits.focusSamples, skipped: new Set<string>(), contrast: !!opts.focusContrast };
  const shots: ShotState = { obscured: false, focus: false, covers: new Map() };

  const startMark = ctx.guard.mark();
  const timed = async (fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    await fn();
    return Date.now() - t0;
  };
  const prepare = await timed(() => page.evaluate(kitTopPrepare, undefined));
  await page.keyboard!.press('Tab');
  const finish = await timed(() => page.evaluate(kitTopFinish, undefined));
  // The budget is for the page's own slowness. A remote browser (Cloudflare's) adds a network round
  // trip to every call, the same for every page: the shorter of two trivial calls measures it, and
  // the walk gets that much more time per stop it may follow and per focus indicator it may picture
  // (about 4 calls each). Still within the probe's time box (`ctx.deadline`).
  transport = Math.min(prepare, finish) * (limits.forward + limits.backward + 4 * limits.focusSamples)
    // Each stop is measured once focus has stayed put for 100 ms (`whenStill` in page.ts): time the walk spends
    // for every page alike, so it is added like the round trips.
    + FOCUS_STILL_MS * (limits.forward + limits.backward);
  const fwd = await pass(ctx, { key: 'Tab', dir: 'forward', max: limits.forward, maxCycle: limits.maxCycle, samples, until, shots });
  const forward = [...fwd.stops];
  let partial = fwd.ended === 'time';
  let broken = false;
  let reloaded = false;
  let cutReason: string | undefined;
  let inFrame = fwd.inFrame;

  const traps: TrapResult[] = [];
  /** Elements a focus loop's own way out put focus on (by path): reached, though no Tab press landed on them. */
  const landed = new Set<string>();
  /** A focus cycle ended a walk (it may have stopped short of the page). */
  let cycleEnded = false;
  /** Examines a cycle once per region: where it is, what lies outside it, and the ways out. */
  const examine = async (found: number[], stops: readonly Stop[]): Promise<TrapResult | null> => {
    // Bounded: TRAP_EXAMINE_MS per cycle, and never past the probe's own time box (then the trap is not tested).
    const t0 = Date.now();
    const late = () => ctx.signal.aborted || Date.now() > Math.min(t0 + TRAP_EXAMINE_MS, ctx.deadline - 4000);
    const members = await slowCycle(ctx, found, late);
    const region = await page.evaluate(kitTrapRegion, members);
    if (traps.some((t) => t.region.path === region.path)) return null;
    const names = members.map((m) => stops.find((s) => s.id === m)?.name ?? '').filter(Boolean);
    const outside = await page.evaluate(kitOutside, members);
    const esc = await escapeTrap(ctx, members, late);
    const trap: TrapResult = { members, names, region: { path: region.path, ...(region.name ? { name: region.name } : {}) }, dialog: region.dialog, ...esc, outside };
    traps.push(trap);
    return trap;
  };
  let walk = fwd;
  while (walk.cycle && !broken) {
    cycleEnded = true;
    const trap = traps.length < 3 ? await examine(walk.cycle, forward) : null;
    // Back into a cycle already examined (a widget left only with Shift+Tab), or too many: stop here;
    // the Shift+Tab walk covers the rest.
    if (!trap) break;
    if (!trap.escaped || trap.stopped) {
      // Still trapped (or unsure): load the page again for the rest of the test.
      try {
        await reload(ctx);
        reloaded = true;
      } catch (err) {
        // The trap result stands; what comes after it could not be tested.
        broken = true;
        try {
          navigationRace(ctx, startMark, err);
        } catch (e) {
          cutReason = e instanceof ProbeNotTestable ? e.message : `the page could not be loaded again after the keyboard trap test (${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)})`;
        }
      }
      break;
    }
    // Out of it (a dialog closed with Esc, say): walk on over the page as it now is. Where the way out put
    // focus is a stop the walk has reached: the next Tab starts from it and so never lands on it.
    const at = await page.evaluate(kitActiveId, undefined).catch(() => 0);
    const where = at ? await page.evaluate(kitDescribe, at).catch(() => null) : null;
    if (where?.path) landed.add(where.path);
    const left = limits.forward - forward.length;
    if (left <= 0 || until()) break;
    walk = await pass(ctx, { key: 'Tab', dir: 'forward', max: left, maxCycle: limits.maxCycle, samples, until, shots });
    forward.push(...walk.stops);
    partial ||= walk.ended === 'time';
    inFrame ??= walk.inFrame;
  }

  const skips: SkipLinkTest[] = [];
  const candidates = !opts.skipLinks ? []
    : forward.slice(0, 10).filter((s) => s.anchor && (SKIP_LINK_NAME.test(s.name ?? '') || s.anchor.toMain)).slice(0, 2);
  for (const c of candidates) {
    if (broken || until()) break;
    skips.push(await testSkipLink(ctx, c, !reloaded));
  }
  const skipsUntested = candidates.length - skips.length;

  let backward: Stop[] = [];
  if (limits.backward > 0 && forward.length) {
    if (broken || until()) {
      // Shift+Tab from the end finds what Tab from the top does not (a header bar covering focus).
      partial = true;
    } else {
      await page.evaluate(kitResetStart, undefined);
      const back = await pass(ctx, { key: 'Shift+Tab', dir: 'backward', max: limits.backward, maxCycle: limits.maxCycle, samples, until, shots });
      backward = back.stops;
      partial ||= back.ended === 'time';
      inFrame ??= back.inFrame;
      if (back.cycle) {
        // A cycle only Shift+Tab from the end reaches (the last stretch of a long page).
        cycleEnded = true;
        if (traps.length < 3) await examine(back.cycle, back.stops);
      }
    }
  }
  // A cycle that kept the walks from part of the page: what they did not reach is untested.
  const followed = new Set([...[...forward, ...backward].map((s) => s.path ?? String(s.id)), ...landed]).size;
  if (cycleEnded && followed < tabbables && !cutReason) {
    partial = true;
    cutReason = `a focus loop kept the keyboard walk from the rest of the page (${followed} of ${tabbables >= 2000 ? '2000 or more' : tabbables} focus stops followed)`;
  }
  const confirm = await confirmOnFocus(ctx, [...forward, ...backward], pageUrl, broken, startMark);
  if (confirm === 'late') partial = true;
  // A skip control (a button, `isSkipControl`; Fable review F2 and F3): pressed only where it can change 2.4.1 (no main
  // landmark, no headings, the content not first, no working skip link), after both walks, never in a skip link's place.
  // Like any test that presses something, it asks for a fresh page for the next test first (`discardUnlessAction`).
  const bypassed = () => skips.some((k) => k.works && k.past !== false && !k.untested) || layout.hasMain || layout.headings > 0 || !!layout.contentFirst;
  if (opts.skipLinks && !bypassed()) {
    const control = forward.slice(0, 10).find((s) => isSkipControl(s));
    if (control) {
      if (broken || until()) {
        skips.push({ name: control.name ?? '', path: control.path ?? '', control: true, targetFound: true, works: false, toMain: false,
          untested: `there was no time left to press the skip control "${clip(control.name ?? '', 60)}"` });
      } else {
        discardUnlessAction(ctx);
        const t = await testSkipControl(ctx, control, !reloaded);
        if (t) skips.push(t);
      }
    }
  }
  // SCR28: a navigation toggle counts only once pressing it takes the navigation's links out of the Tab order.
  // Pressed only when nothing else bypasses the repeated content, last (it can hide part of the page).
  if (opts.skipLinks && layout.toggleId !== undefined && !bypassed()) {
    if (broken || until()) layout.toggleUntested = `there was no time left to press "${clip(layout.toggle ?? '', 60)}" and see whether it hides the navigation`;
    else Object.assign(layout, await testToggle(ctx, layout.toggleId, !reloaded, layout.toggle ?? ''));
  }
  // Batch 18, D8: what a focus loop kept the walks from is still measured for its focus indicator. A native modal
  // dialog that holds the loop (one a page opens on load, closed only by a pointer) is closed first, as a pointer user
  // closes it: the stops behind it are then the page's, and kitRestore below does not reopen it.
  let direct: Stop[] = [];
  if (cycleEnded && followed < tabbables && !broken && samples.left > 0 && !until()) {
    if (traps.some((t) => t.dialog) && (await page.evaluate(closeModalDialogs, undefined).catch(() => 0)) > 0) {
      // The page is no longer as it loaded: later tests get a fresh one.
      ctx.discardPage?.();
    }
    direct = await measureUnreached(ctx, new Set([...forward, ...backward].map((x) => x.path ?? '').filter(Boolean)), samples, shots, until).catch(() => [] as Stop[]);
  }
  // Put the page back as the walk found it: address, focus, scroll, the details and dialogs it opened,
  // and the aria-expanded of controls it expanded (no key is pressed for this).
  await page.evaluate(kitRestore, page.url?.() ?? ctx.url).catch(() => {});
  const noFocus = fwd.ended === 'empty' && !backward.length && tabbables > 0;
  return {
    forward, backward, traps, skips, layout, tabbables, partial, skipsUntested, noFocus,
    ...(confirm === 'noisy' ? { onFocusNoise: true } : {}),
    ...(cutReason ? { cutReason } : {}),
    ...(inFrame ? { frameStuck: inFrame } : {}),
    ...(direct.length ? { direct } : {}),
    limits: { forward: limits.forward, backward: limits.backward, ...(limits.full ? { fullForward: limits.full.forward, fullBackward: limits.full.backward } : {}) },
    samples: { measured: samples.seen.size, skipped: samples.skipped.size, ...(limits.full ? { fullCap: limits.full.focusSamples } : {}) },
    viewportHeight: ctx.viewport.height,
  };
}
