// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.5.1 Pointer gestures and 2.5.7 Dragging movements (Plan 4 Task 4.5): what a multipoint or
// path-based gesture does, or a drag does, must also be possible with a single pointer without a
// path (a tap or click), unless essential. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { changedPixels, type RgbaImage } from './pixels.js';
import { mergePlanned, plannedFor } from './plan.js';
import { byTarget, framesReason, installKit, kit, pointerStop, requestKey, untestedFrames, type Box } from './pointerKit.js';
import { GUARD_SETTLE_MS } from './motionShared.js';
import { shoot } from './shots.js';
import { ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext } from './types.js';
import { withoutDownloads } from './pressSafely.js';

/** Listener types that start a gesture or a drag on an element. */
export const GESTURE_DOWN_TYPES = ['pointerdown', 'touchstart', 'mousedown'] as const;
/** Types of the frame check: anything that starts a gesture or a drag. */
const FRAME_TYPES = [...GESTURE_DOWN_TYPES, 'dragstart'];
/** Waits (ms): the page is watched for movement of its own; after a gesture, for transitions. */
export const GESTURE_TIMING = { scroll: 150, quiet: 300, settle: 450 } as const;
/** Regions and drag items tested per page, and the time kept back before the time box ends. */
export const GESTURE_LIMITS = { regions: 3, items: 4, reserveMs: 3000 } as const;
/** A pinch changes the size of what a region shows by at least this factor (or its inverse) to count as a zoom. */
export const ZOOM_FACTOR = 1.15;

export type Family = 'pointer' | 'touch' | 'mouse';

export interface GestureCandidate {
  i: number;
  kind: 'region' | 'draggable' | 'slider' | 'handle';
  path: string;
  name: string;
  types: string[];
  skip?: 'action';
  /** A planned region (src/probes/plan.ts), tested after the test's own. */
  planned?: true;
}

export type GestureOutcome =
  /** The gesture or drag changed something, and an alternative named `alternative` is next to it. */
  | { kind: 'ok'; what: GestureWhat; alternative?: string }
  /** Nothing the probe did changed anything (e.g. a press handler that is not a gesture). */
  | { kind: 'none' }
  | { kind: 'failed'; what: GestureWhat; zoom?: number }
  | { kind: 'unmeasured'; reason: 'moving' | 'covered' | 'gone' | 'stopped' | 'time' | 'action' | 'unnamed' | 'elsewhere' | 'hover'; detail?: string };

/** swipe: content swiped (carousel); pinch: two-pointer zoom; pan: content dragged around (maps); sort: an item dragged in its list; slider: a slider's thumb. */
export type GestureWhat = 'swipe' | 'pinch' | 'pan' | 'sort' | 'slider';

/** Which criterion a measured gesture belongs to: multipoint and path gestures 2.5.1, dragging 2.5.7. */
export const CRITERION_OF: Record<GestureWhat, '2.5.1' | '2.5.7'> = { swipe: '2.5.1', pinch: '2.5.1', pan: '2.5.7', sort: '2.5.7', slider: '2.5.7' };

export interface GestureResult {
  candidate: GestureCandidate;
  outcomes: GestureOutcome[];
  /** Content fixed on the screen the test hid to reach the candidate (tag and id), put back after it. */
  uncovered?: string[];
}

/** Families of synthetic events to try, from the element's own down listeners: pointer, touch, mouse. */
export function familiesOf(types: readonly string[]): Family[] {
  const out: Family[] = [];
  if (types.includes('pointerdown')) out.push('pointer');
  if (types.includes('touchstart')) out.push('touch');
  if (types.includes('mousedown')) out.push('mouse');
  return out;
}

/** A gesture changed the region: changed pixels (outside those that moved by themselves) over 1% of it and at least 50. */
export function regionChanged(before: RgbaImage, after: RgbaImage, at: readonly number[]): boolean {
  if (before.width !== after.width || before.height !== after.height) return true;
  return changedPixels(before, after, at) > Math.max(50, 0.01 * at.length);
}

/**
 * Screenshots of a region taken a moment apart with nothing done to it: the pixel positions that never
 * changed between consecutive ones, and whether the region moves by itself (one pair differs in more
 * than 0.5% of its pixels and at least 3, as `isMoving` in pixels.ts).
 */
export function quietPixels(shots: readonly RgbaImage[], tolerance = 2): { at: number[]; moving: boolean } {
  const first = shots[0];
  if (!first || !first.width || !first.height || shots.some((x) => x.width !== first.width || x.height !== first.height)) return { at: [], moving: true };
  const n = first.width * first.height;
  const changed = new Array<number>(Math.max(0, shots.length - 1)).fill(0);
  const at: number[] = [];
  for (let p = 0; p < n; p++) {
    const k = p * 4;
    let still = true;
    for (let s = 1; s < shots.length; s++) {
      const a = shots[s - 1]!.data;
      const b = shots[s]!.data;
      const d = Math.max(Math.abs(a[k]! - b[k]!), Math.abs(a[k + 1]! - b[k + 1]!), Math.abs(a[k + 2]! - b[k + 2]!));
      if (d > tolerance) { still = false; changed[s - 1]!++; }
    }
    if (still) at.push(p);
  }
  return { at, moving: changed.some((c) => c > Math.max(3, 0.005 * n)) };
}

const quote = (s: string) => `“${s}”`;
/**
 * Finding detail for a failed gesture or drag (what was measured). A failure means no control at all
 * was found next to it: a control with any name or none leaves the result `not_testable` instead.
 */
export function gestureDetail(c: GestureCandidate, o: GestureOutcome & { kind: 'failed' }): string {
  const it = c.name ? ` (${quote(c.name.length > 50 ? `${c.name.slice(0, 49)}…` : c.name)})` : '';
  switch (o.what) {
    case 'swipe':
      return `Swiping across this content${it} changes what it shows (a path-based gesture), and there is no control next to it that could do the same with a single tap or click`;
    case 'pinch':
      return `Pinching with two fingers on this content${it} zooms it (×${(o.zoom ?? 1).toFixed(1)}), a multipoint gesture, and there is no control next to it that could zoom with a single tap or click`;
    case 'pan':
      return `Dragging across this content${it} moves what it shows, and there is no control next to it that could move it with a single tap or click`;
    case 'sort':
      return `Dragging this item${it} onto another item reorders the list, clicking its items does not, and the page has no other control that could move it with a single tap or click`;
    case 'slider':
      return `Dragging this slider's handle${it} changes its value, and neither pressing on its track nor any control next to it changes the value with a single tap or click`;
  }
}

/**
 * What a page offers the keyboard for a list the test measured reordering by dragging (keyboard-op lane, 2026-11-11;
 * fix round 1, F1: every possible way on the whole page, not only near the list). Runs in the page (self-contained)
 * with the dragged item's path:
 * - `focusable`: the list, one of its items, or anything inside it takes keyboard focus (a keyboard way may be there:
 *   the keyboard and controls tests judge it, this rule says nothing);
 * - `around`: an element around the list that Tab reaches (a list box or grid wrapper may take the keys for it);
 * - `nearby`: controls and links Tab reaches near the list (its section, article, form, fieldset, region or group
 *   within 4 levels, else the list's own parent): any of them may do it, or lead to what does;
 * - `named`: controls and links anywhere on the page, shown or not, named for moving, ordering, sorting, ranking or
 *   choosing ("Move up", "Sort", "Rank them with a form instead", "▲"), for the keyboard or for another way
 *   ("Keyboard sorting", "Accessible version", "Alternative"; a plain "Accessibility" link is none);
 * - `setters`: fields anywhere on the page that may set the order: a list box whose options repeat the list's items
 *   or are places (1, 2, 3; first, second), or a field (a list box, a number or text box, a choice) labelled for an
 *   order, a rank, a place, a priority or a choice ("First choice"), or labelled with one of the list's items;
 * - `told`: the text near the list mentions the keyboard, a key or an arrow, or the page's text mentions the keyboard,
 *   arrow keys or a way without dragging (instructions for another way).
 * Null when the item or its list is not there.
 */
export function sortKeyboardWay(arg: { path: string }): { focusable: boolean; around: string; nearby: string[]; named: string[]; setters: string[]; told: boolean } | null {
  let item: Element | null = null;
  try { item = document.querySelector(arg.path); } catch { return null; }
  const list = item?.parentElement;
  if (!item || !list) return null;
  const FOCUSABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';
  const tabbable = (e: Element): boolean => {
    if (!e.matches(FOCUSABLE) || e.closest('[inert]') || (e as HTMLButtonElement).disabled) return false;
    const ti = e.getAttribute('tabindex');
    if (ti !== null && ti.trim() !== '' && Number(ti) < 0) return false;
    const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0;
  };
  const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  const inside = list.querySelectorAll('*');
  let focusable = tabbable(list);
  for (let k = 0; k < inside.length && k < 3000 && !focusable; k++) if (tabbable(inside[k]!)) focusable = true;
  const nameOf = (e: Element): string => {
    const label = (e as HTMLInputElement).labels?.[0]?.textContent ?? '';
    let by = '';
    const ids = e.getAttribute('aria-labelledby');
    if (ids) by = ids.split(/\s+/).map((x) => document.getElementById(x)?.textContent ?? '').join(' ');
    return clean(e.getAttribute('aria-label') || by || label || (e as HTMLElement).innerText || e.textContent || e.getAttribute('title') || (e as HTMLInputElement).placeholder || (e as HTMLInputElement).value || '').slice(0, 80);
  };
  // An element around the list that Tab reaches: it may take the keys for the list (a list box wrapper).
  let around = '';
  for (let a = list.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    if (tabbable(a)) { around = nameOf(a).slice(0, 60) || a.localName; break; }
  }
  // Its neighbourhood: the nearest section, article, form, fieldset, region or group within 4 levels; with none, the
  // list's own parent (all of the main content, when the list sits right in it).
  let region: Element = list.parentElement ?? list;
  for (let a = list.parentElement, k = 0; a && a !== document.body && k < 4; a = a.parentElement, k++) {
    if (a.matches('section, article, form, fieldset, aside, dialog, [role="region"], [role="group"], [role="form"], [role="dialog"]')) { region = a; break; }
    if (a.matches('main, [role="main"]')) break;
  }
  const nearby: string[] = [];
  const near = region.querySelectorAll(FOCUSABLE);
  for (let k = 0; k < near.length && k < 1000 && nearby.length < 4; k++) {
    const e = near[k]!;
    if (list.contains(e) || !tabbable(e)) continue;
    nearby.push(nameOf(e) || e.localName);
  }
  // Named for moving, ordering, sorting, ranking or choosing, or for another way (the keyboard, an accessible version):
  // controls and links, shown or not (a menu that is closed still holds its "Move up"; a link may lead to a form).
  // ("Accessibility" alone, a site's statement link in every footer, names no way to do this.)
  const ORDER = /\b(move[sd]?|moving|re-?order(s|ed|ing)?|order(s|ed|ing)?|sort(s|ed|ing)?|rank(s|ed|ing)?|re-?arrang\w*|arrang\w*|priorit\w*|choos\w*|choices?|chosen|pick|prefer\w*|keyboard|accessible (version|format|form|list|view|way|option)s?|alternatives?|another way|other ways?|without (dragging|a mouse))\b/i;
  const ARROW = /^\s*(up|down|[▲▼↑↓⬆⬇↕⇅])\s*$/i;
  const named: string[] = [];
  const CONTROL = `${FOCUSABLE}, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="link"]`;
  const all = document.querySelectorAll(CONTROL);
  for (let k = 0; k < all.length && k < 4000 && named.length < 4; k++) {
    const e = all[k]!;
    // Fields are judged by what they may set (below); buttons made of inputs are controls.
    if (list.contains(e) || e.matches('select, textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"])')) continue;
    const n = clean(e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || (e as HTMLInputElement).value || '').slice(0, 80);
    if (ORDER.test(n) || ARROW.test(n) || ORDER.test(e.getAttribute('title') ?? '')) named.push(n);
  }
  // Fields that may set the order: by what they offer (the list's items, places) or by their label.
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const items = new Set<string>();
  for (let k = 0; k < list.children.length && k < 50; k++) {
    const t = norm(((list.children[k] as HTMLElement).innerText ?? list.children[k]!.textContent ?? '').slice(0, 120));
    if (t.length >= 2) items.add(t);
    // A card's title alone (its first line), as a field would name it.
    const first = norm(((list.children[k] as HTMLElement).innerText ?? '').split('\n')[0] ?? '');
    if (first.length >= 2) items.add(first);
  }
  const PLACE = /^(\d{1,2}|(1st|2nd|3rd|\d{1,2}th)|first|second|third|fourth|fifth|last|top|bottom)\b/i;
  // Labelled for an order ("Position", "Priority", "First choice"); an ordinal alone is no order ("First name").
  const LABELLED = /\b(order\w*|rank\w*|position\w*|priorit\w*|choices?|prefer\w*|sort\w*|move\w*)\b|\b(first|second|third|fourth|fifth|1st|2nd|3rd|top|last)\s+(pick|place|spot)\b/i;
  const setters: string[] = [];
  const fields = document.querySelectorAll('select, input:not([type="hidden"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="image"]), textarea, [role="listbox"], [role="combobox"], [role="spinbutton"], [role="radio"], [role="slider"]');
  for (let k = 0; k < fields.length && k < 2000 && setters.length < 4; k++) {
    const f = fields[k]!;
    if (list.contains(f)) continue;
    const label = nameOf(f);
    let why = LABELLED.test(label) || items.has(norm(label));
    if (!why && f instanceof HTMLSelectElement) {
      const opts = [...f.options].slice(0, 60).map((o) => clean(o.textContent));
      why = opts.some((o) => items.has(norm(o))) || opts.filter((o) => PLACE.test(o)).length >= 2;
    }
    if (why) setters.push(label || f.localName);
  }
  const KEY_NEAR = /\b(keyboard|keys?|arrows?|press(ing)?)\b/i;
  const KEY_PAGE = /\b(keyboard|arrow keys?|without (dragging|a mouse))\b/i;
  const told = KEY_NEAR.test((region as HTMLElement).innerText ?? region.textContent ?? '') || KEY_PAGE.test(document.body?.innerText ?? '');
  return { focusable, around, nearby, named, setters, told };
}

/** The keyboard facts of a list measured reordering by dragging (`sortKeyboardWay`), per result. */
export type SortKeys = NonNullable<ReturnType<typeof sortKeyboardWay>>;

/** A result's drag that the test measured reordering its list (its outcome, from `judged`), or null. */
export function measuredSort(r: GestureResult): GestureOutcome | null {
  if (r.candidate.kind !== 'draggable') return null;
  return r.outcomes.find((o) => ((o.kind === 'failed' || o.kind === 'ok') && o.what === 'sort') || (o.kind === 'unmeasured' && (o.reason === 'elsewhere' || o.reason === 'unnamed'))) ?? null;
}

/** The single-pointer way the 2.5.7 rule confirmed that is no keyboard way: clicking an item, then another. */
export const CLICK_ITEMS = 'a click on an item, then on another';

/**
 * 2.1.1 for the lists the test measured reordering by dragging (keyboard-op lane, 2026-11-11; F54, G202). Failed only
 * when no keyboard way may exist anywhere on the page (fix round 1, F1): none of its items (nor the list, nor anything
 * in it, nor anything around it) takes focus; the 2.5.7 rule found the list's single-pointer way to be no control
 * at all (clicking its items one after the other) or found no other control on the page; no control or link near it;
 * no control or link on the page named for moving, ordering, sorting, ranking, choosing, the keyboard or another way;
 * no field on the page that may set the order; no text naming a key. A way that might be there leaves it not
 * testable: also when the 2.5.7 rule's own doubt says another control on the page, or one next to the list that it
 * cannot name, may do it (`elsewhere`, `unnamed`), and when it confirmed another control does it with the pointer.
 * A list whose items take focus is the keyboard tests' to judge (nothing here). No measured reordering: not applicable.
 */
export function sortKeyboardFindings(results: readonly GestureResult[], keys: ReadonlyMap<GestureResult, SortKeys | null>): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  let measured = 0;
  const q = (s: string) => quote(s.length > 40 ? `${s.slice(0, 39)}…` : s);
  for (const r of results) {
    const o = measuredSort(r);
    if (!o) continue;
    measured++;
    const it = r.candidate.name ? ` (${quote(r.candidate.name.length > 50 ? `${r.candidate.name.slice(0, 49)}…` : r.candidate.name)})` : '';
    const k = keys.get(r);
    if (k === undefined) continue;
    if (k === null) { out.push({ criterion: '2.1.1', status: 'not_testable', target: r.candidate.path, detail: `Dragging this item${it} reorders its list, but the list could not be read again to see whether the keyboard has a way to reorder it` }); continue; }
    if (k.focusable) continue;
    const doubt = o.kind === 'unmeasured' ? (o.reason === 'unnamed'
      ? 'controls next to it, with no name or one the test does not recognise, may do it, and the keyboard may reach them'
      : `another control or link on the page${o.detail ? ` (${q(o.detail)})` : ''} may do it, or lead to what does, and the keyboard may reach it`)
      : o.kind === 'ok' && o.alternative !== CLICK_ITEMS ? `another control (${quote(o.alternative ?? 'a control')}) reorders it, and the test does not know whether the keyboard reaches that control's function`
        : k.around ? `the element around it (${q(k.around)}) takes keyboard focus and may take the keys for it`
          : k.nearby.length ? `controls near it (${k.nearby.slice(0, 2).map((n) => q(n)).join(', ')}) may do it with the keyboard, and the test does not press them`
            : k.named.length ? `a control or link on the page is named for ordering or another way (${q(k.named[0]!)}), and may do it with the keyboard`
              : k.setters.length ? `a field on the page (${q(k.setters[0]!)}) may set the order with the keyboard`
                : k.told ? 'the page\'s text mentions a key or the keyboard, which may describe another way'
                  : '';
    if (doubt) { out.push({ criterion: '2.1.1', status: 'not_testable', target: r.candidate.path, detail: `Dragging this item${it} reorders its list and none of its items can take keyboard focus, but ${doubt}` }); continue; }
    out.push({ criterion: '2.1.1', status: 'failed', target: r.candidate.path, detail: `Dragging this item${it} reorders its list, but none of its items can take keyboard focus, nothing near the list takes keyboard input, and no control, link or field on the page is named for ordering it or offers another way: the list cannot be put in order with the keyboard` });
  }
  if (!out.length) out.push({ criterion: '2.1.1', status: 'not_applicable', detail: measured ? 'the lists the test reordered by dragging have items that take keyboard focus (the keyboard tests judge them)' : 'no list was measured reordering by dragging' });
  return out;
}

/**
 * After the guard stopped a request during a candidate's test: failures measured in the DOM (a list's
 * order, a slider's value, element sizes for a pinch) are kept, since an aborted request does not
 * produce them; anything else, a pixel change included, is replaced by the stop.
 */
export function keptAfterStop(outcomes: readonly GestureOutcome[], stop: (GestureOutcome & { kind: 'unmeasured' }) | undefined): GestureOutcome[] {
  if (!stop) return [...outcomes];
  const kept = outcomes.filter((o) => o.kind === 'failed' && (o.what === 'sort' || o.what === 'slider' || o.what === 'pinch'));
  return kept.length ? kept : [stop];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The page's results for 2.5.1 and 2.5.7: failures first; for a criterion without a failure,
 * `not_testable` when a candidate for it could not be measured (moves by itself, stopped by the guard,
 * unreachable, named for an action, time) or a frame from the site was not tested; `not_applicable`
 * when there was nothing to test for it; otherwise no finding (no failures found).
 */
/** Reason when gesture handlers are only on the document or the window. */
export const DOCUMENT_GESTURES = 'the page handles gestures on the whole document (pointer, touch or mouse down and move handlers on the document or window), not on an element the test can find, so it was not tested';

export function gestureFindings(
  results: readonly GestureResult[],
  frames: readonly string[] = [],
  more: { regions: number; items: number } = { regions: 0, items: 0 },
  /** Down and move handlers of one family on the document or the window. */
  documentGestures = false,
): ProbeFinding[] {
  const out: ProbeFinding[] = [];
  for (const criterion of ['2.5.1', '2.5.7'] as const) {
    const relevant = results.filter((r) => criterion === '2.5.7' || r.candidate.kind === 'region');
    const failed: ProbeFinding[] = [];
    for (const r of relevant) {
      for (const o of r.outcomes) {
        if (o.kind === 'failed' && CRITERION_OF[o.what] === criterion) failed.push({ criterion, status: 'failed', target: r.candidate.path, detail: gestureDetail(r.candidate, o) });
      }
    }
    if (failed.length) {
      out.push(...failed);
      continue;
    }
    const un = relevant.flatMap((r) => r.outcomes.filter((o): o is GestureOutcome & { kind: 'unmeasured' } => o.kind === 'unmeasured').map((o) => ({ r, o })));
    const what = criterion === '2.5.1' ? 'content with gesture handlers' : 'draggable content';
    const stopped = un.find((u) => u.o.reason === 'stopped');
    const count = (reason: string) => un.filter((u) => u.o.reason === reason);
    let reason: string | undefined;
    if (stopped) reason = stopped.o.detail;
    else if (count('action').length) {
      const a = count('action');
      const names = a.filter((u) => u.r.candidate.name).slice(0, 3).map((u) => quote(u.r.candidate.name.length > 40 ? `${u.r.candidate.name.slice(0, 39)}…` : u.r.candidate.name));
      reason = `${plural(a.length, 'element')} of ${what} ${a.length === 1 ? 'was' : 'were'} not tested because every point to start a gesture on is a link, a submit button, a form field or named for an action${names.length ? ` (${names.join(', ')})` : ''}`;
    } else if (count('moving').length) reason = `${plural(count('moving').length, 'element')} of ${what} ${count('moving').length === 1 ? 'changes' : 'change'} by itself, so a change made by a gesture could not be attributed`;
    else if (count('hover').length) {
      const n = count('hover').length;
      reason = `${plural(n, 'element')} of ${what} ${n === 1 ? 'changes' : 'change'} when the pointer only moves over ${n === 1 ? 'it' : 'them'}, without pressing (a tooltip or a highlight that follows the pointer), and dragging changed nothing beyond that, so no change made by dragging could be told from it`;
    }
    else if (count('covered').length || count('gone').length) {
      const unreached = [...count('covered'), ...count('gone')];
      const hid = [...new Set(unreached.flatMap((u) => u.r.uncovered ?? []))];
      reason = `the pointer could not reach ${plural(unreached.length, 'element')} of ${what} (covered by other content or gone, after scrolling ${unreached.length === 1 ? 'it' : 'them'} into view${hid.length ? ` and hiding the content fixed over ${unreached.length === 1 ? 'it' : 'them'}: ${hid.slice(0, 3).join(', ')}` : ''})`;
    }
    else if (count('unnamed').length) {
      const u = count('unnamed');
      reason = `${plural(u.length, 'element')} of ${what} ${u.length === 1 ? 'reacts' : 'react'} to a gesture or drag, and the controls next to ${u.length === 1 ? 'it have' : 'them have'} no name, or a name the test does not recognize as doing the same (next, previous, a slide number, zoom in or out, pan, move up or down, increase or decrease, or an arrow), so the test cannot tell whether they do the same`;
    } else if (count('elsewhere').length) {
      const u = count('elsewhere');
      const named = u.map((x) => x.o.detail).find((d) => d);
      reason = `${plural(u.length, 'list')} can be put in order by dragging, and no control the test tried does the same with single taps or clicks, but another control on the page${named ? ` (${quote(named.length > 40 ? `${named.slice(0, 39)}…` : named)})` : ''} may, or may open what does: the test presses only controls named for moving an item, so it could not tell`;
    } else if (count('time').length) reason = `the time ran out after ${relevant.length - count('time').length} of ${relevant.length} ${relevant.length === 1 ? 'element' : 'elements'} of ${what}`;
    else if (more.regions || (criterion === '2.5.7' && more.items)) {
      const n = more.regions + (criterion === '2.5.7' ? more.items : 0);
      reason = `${plural(n, 'more kind')} of ${what} ${n === 1 ? 'was' : 'were'} not tested (the test takes ${GESTURE_LIMITS.regions} regions and ${GESTURE_LIMITS.items} draggable items per page)`;
    }
    else if (frames.length) reason = framesReason(frames, criterion === '2.5.1' ? 'Content with gesture handlers' : 'Draggable content');
    if (reason) {
      out.push({ criterion, status: 'not_testable', detail: reason });
      continue;
    }
    if (!relevant.length && documentGestures) {
      out.push({ criterion, status: 'not_testable', detail: DOCUMENT_GESTURES });
      continue;
    }
    if (!relevant.length) {
      out.push({
        criterion, status: 'not_applicable',
        detail: criterion === '2.5.1'
          ? 'no swipe, pinch or other gesture handlers found on page content'
          : 'no draggable content found (no draggable elements, custom sliders, drag handles or content that pans)',
      });
    }
  }
  return out;
}

/**
 * The test's result from its own candidates (`gestureFindings`), with what it measured on planned regions:
 * their failures added; a criterion a planned region was measured on (a gesture that changed it, with a
 * named alternative) becomes clean where the test had nothing to test, or could not find the element of a
 * page that handles gestures on the whole document. An unmeasured planned region changes nothing.
 */
export function withPlannedGestures(
  results: readonly GestureResult[], frames: readonly string[], more: { regions: number; items: number }, documentGestures: boolean,
): ProbeFinding[] {
  const own = results.filter((r) => !r.candidate.planned);
  const planned = results.filter((r) => r.candidate.planned);
  const base = gestureFindings(own, frames, more, documentGestures);
  const failed = gestureFindings(planned.map((r) => ({ ...r, outcomes: r.outcomes.filter((o) => o.kind === 'failed') }))).filter((f) => f.status === 'failed');
  const clean = [...new Set(planned.flatMap((r) => r.outcomes.flatMap((o) => (o.kind === 'ok' ? [CRITERION_OF[o.what]] : []))))];
  return mergePlanned(base, { failed, clean }, (f) => f.status === 'not_testable' && f.detail === DOCUMENT_GESTURES);
}

const wait = (ctx: ProbeContext, ms: number) => ctx.page.waitForTimeout(ms);

type AltKind = 'swipe' | 'pan' | 'zoom' | 'sort' | 'slider';
/** The outcome once a gesture or drag changed something: an alternative named for it, controls without a name, or none. */
async function judged(ctx: ProbeContext, i: number, what: GestureWhat, kinds: AltKind[], clickRefs: number[], zoom?: number): Promise<GestureOutcome> {
  const alt = await kit<{ names: string[]; unnamed: number; unknown: number }>(ctx, 'alternatives', { i, kinds, clickRefs });
  if (alt.names.length) return { kind: 'ok', what, alternative: alt.names[0]! };
  // A control with no name, or a name that is none of the accepted ones, might do the same: not judged.
  if (alt.unnamed || alt.unknown) return { kind: 'unmeasured', reason: 'unnamed' };
  // A sortable list with no control next to it (review round 1, ruling 10): its single-pointer way may be
  // anywhere on the page (a toolbar, a menu), or a click on one item and then on another. An unsuccessful
  // search proves nothing: the list fails only when no control anywhere on the page may do it, and clicking
  // the items was tried and does nothing. The test's click canceller is lifted for these clicks alone (no link,
  // submitter, form control or control named for an action is clicked: the kit refuses those; the request
  // guard stays strict).
  if (what === 'sort') {
    await kit(ctx, 'block', { on: false }).catch(() => {});
    type Elsewhere = { names: string[]; changed: boolean; candidates: number; sample: string; refused?: string };
    type Clicks = { changed: boolean; refused?: string };
    type Revealed = { names: string[]; changed: boolean; candidates: number; sample: string };
    let elsewhere = null as Elsewhere | null;
    let clicks = null as Clicks | null;
    let revealed = null as Revealed | null;
    try {
      elsewhere = await kit<Elsewhere | null>(ctx, 'sortElsewhere', { i, clickRefs });
      if (!elsewhere?.changed) clicks = await kit<Clicks | null>(ctx, 'clickItems', { i });
      // Controls that show only once an item is selected (the clicks above selected one): looked for now.
      if (elsewhere && !elsewhere.changed && clicks && !clicks.changed && !clicks.refused) {
        revealed = await kit<Revealed | null>(ctx, 'sortRevealed', { i });
        // The list is gone or changed past recognising after the clicks: nothing more could be looked for.
        if (!revealed) return { kind: 'unmeasured', reason: 'gone' };
      }
    } finally {
      await kit(ctx, 'block', { on: true, i, drag: true }).catch(() => {});
    }
    if (elsewhere?.changed) return { kind: 'ok', what, alternative: `${elsewhere.names[0] ?? 'a control'} (elsewhere on the page, after selecting an item)` };
    if (clicks?.changed) return { kind: 'ok', what, alternative: CLICK_ITEMS };
    if (revealed?.changed) return { kind: 'ok', what, alternative: `${revealed.names[0] ?? 'a control'} (shown once an item is selected)` };
    // A control that may do it, which the test could not confirm; or nothing could be tried at all.
    if (!elsewhere || !clicks) return { kind: 'unmeasured', reason: 'gone' };
    if (elsewhere.names.length || elsewhere.candidates || revealed?.names.length || revealed?.candidates) {
      return { kind: 'unmeasured', reason: 'elsewhere', detail: elsewhere.names[0] || revealed?.names[0] || elsewhere.sample || revealed?.sample || '' };
    }
    if (elsewhere.refused || clicks.refused) return { kind: 'unmeasured', reason: 'action' };
  }
  return { kind: 'failed', what, ...(zoom !== undefined ? { zoom } : {}) };
}

/** Swipes a region (each family, left then right) and pinches it; screenshots tell what changed. */
async function testRegion(ctx: ProbeContext, c: GestureCandidate, clickRefs: number[]): Promise<GestureOutcome[]> {
  const rb = await kit<{ box: Box; point: { x: number; y: number } | null; refused?: string } | null>(ctx, 'regionBox', { i: c.i, uncover: true });
  if (!rb) return [{ kind: 'unmeasured', reason: 'gone' }];
  if (rb.refused) return [{ kind: 'unmeasured', reason: 'action' }];
  if (!rb.point) return [{ kind: 'unmeasured', reason: 'covered' }];
  await wait(ctx, GESTURE_TIMING.scroll);
  const [bx, by, bw, bh] = rb.box;
  // Three screenshots 150 ms apart: content that changes by itself (autoplay, video, a ticker) cannot be
  // told apart from what a gesture does (two samples could catch an autoplay at the same slide).
  const s0 = await shoot(ctx.page, rb.box);
  await wait(ctx, GESTURE_TIMING.quiet / 2);
  const s1 = await shoot(ctx.page, rb.box);
  await wait(ctx, GESTURE_TIMING.quiet / 2);
  const s2 = await shoot(ctx.page, rb.box);
  const still = quietPixels([s0, s1, s2]);
  if (still.moving) return [{ kind: 'unmeasured', reason: 'moving' }];
  const out: GestureOutcome[] = [];
  const families = familiesOf(c.types);
  const { x, y } = rb.point;
  const clampX = (v: number) => Math.round(Math.min(Math.max(v, bx + 2), bx + bw - 3));
  const reach = Math.max(120, bw * 0.45);
  let swiped = false;
  /** Moving the pointer over the content without pressing changed it (a drag must change it beyond that). */
  let hoverSeen = false;
  let last = s2;
  for (const family of families) {
    for (const dir of [-1, 1]) {
      const path: [number, number][] = [];
      for (let s = 0; s <= 10; s++) path.push([clampX(x + (dir * reach * s) / 10), y]);
      // What the pointer moving over the content shows by itself (a tooltip that follows it, a hovered bar) is no drag
      // (Sol r1 S10: compared from the same state as the drag). The same moves without pressing come first, and the
      // picture after them is what the drag is compared with: a drag changes the content beyond that.
      const h = await kit<{ ok: boolean; refused?: string }>(ctx, 'gesture', { family, i: c.i, paths: [path], hover: true });
      if (h.refused) return [{ kind: 'unmeasured', reason: 'action' }];
      await wait(ctx, GESTURE_TIMING.settle);
      const base = await shoot(ctx.page, rb.box);
      if (regionChanged(last, base, still.at)) hoverSeen = true;
      const t0 = await kit<number>(ctx, 'now');
      const g = await kit<{ ok: boolean; refused?: string }>(ctx, 'gesture', { family, i: c.i, paths: [path] });
      if (g.refused) return [{ kind: 'unmeasured', reason: 'action' }];
      await wait(ctx, GESTURE_TIMING.settle);
      const now = await shoot(ctx.page, rb.box);
      if (regionChanged(base, now, still.at)) {
        // A timer of 1 s or more ran meanwhile (an autoplay): the change may not be the gesture's.
        if (await kit<number>(ctx, 'timersSince', { t: t0 })) return [{ kind: 'unmeasured', reason: 'moving' }];
        swiped = true;
        break;
      }
      last = now;
    }
    if (swiped) break;
  }
  if (!swiped && hoverSeen) out.push({ kind: 'unmeasured', reason: 'hover' });
  if (swiped) {
    const what: GestureWhat = (await kit<boolean>(ctx, 'isCarousel', { i: c.i })) ? 'swipe' : 'pan';
    // A next button moves panned content too, and arrows pan a carousel: either kind of name counts.
    out.push(await judged(ctx, c.i, what, ['swipe', 'pan'], clickRefs));
  }
  // Pinch: two pointers moving apart vertically around the same point (touch first: pinch handlers read
  // touches). The first pointer alone on the same path first: content that also grows or shrinks then
  // (a carousel that scales its slides) is not a multipoint gesture.
  const pinchFamily = families.includes('touch') ? 'touch' : families.includes('pointer') ? 'pointer' : null;
  if (pinchFamily) {
    const clampY = (v: number) => Math.round(Math.min(Math.max(v, by + 2), by + bh - 3));
    const spread = Math.max(30, Math.min(110, bh / 2 - 6));
    const p1: [number, number][] = [];
    const p2: [number, number][] = [];
    for (let s = 0; s <= 10; s++) {
      const d = 20 + ((spread - 20) * s) / 10;
      p1.push([x, clampY(y - d)]);
      p2.push([x, clampY(y + d)]);
    }
    const zoomed = (r: number | null) => r !== null && (r >= ZOOM_FACTOR || r <= 1 / ZOOM_FACTOR);
    await kit(ctx, 'scale', { i: c.i, save: true });
    const g1 = await kit<{ ok: boolean; refused?: string }>(ctx, 'gesture', { family: pinchFamily, i: c.i, paths: [p1] });
    await wait(ctx, GESTURE_TIMING.settle);
    if (g1.refused) out.push({ kind: 'unmeasured', reason: 'action' });
    else if (!zoomed(await kit<number | null>(ctx, 'scale', { i: c.i }))) {
      await kit(ctx, 'scale', { i: c.i, save: true });
      const t0 = await kit<number>(ctx, 'now');
      const g2 = await kit<{ ok: boolean; refused?: string }>(ctx, 'gesture', { family: pinchFamily, i: c.i, paths: [p1, p2] });
      if (g2.refused) return [...out, { kind: 'unmeasured', reason: 'action' }];
      await wait(ctx, GESTURE_TIMING.settle);
      const ratio = await kit<number | null>(ctx, 'scale', { i: c.i });
      if (zoomed(ratio)) {
        if (await kit<number>(ctx, 'timersSince', { t: t0 })) out.push({ kind: 'unmeasured', reason: 'moving' });
        else out.push(await judged(ctx, c.i, 'pinch', ['zoom'], clickRefs, ratio!));
      }
    }
  }
  return out.length ? out : [{ kind: 'none' }];
}

/** Drags an item onto its sibling (native drag events, then the pointer families of its handlers). */
async function testItem(ctx: ProbeContext, c: GestureCandidate, clickRefs: number[]): Promise<GestureOutcome[]> {
  const families: ('native' | Family)[] = c.kind === 'draggable' ? ['native', ...familiesOf(c.types)] : familiesOf(c.types);
  if (!families.length) families.push('pointer', 'mouse', 'touch');
  for (const family of families) {
    const r = await kit<{ changed: boolean; refused?: string } | null>(ctx, 'dragItem', { i: c.i, family, uncover: true });
    if (!r) return [{ kind: 'unmeasured', reason: 'gone' }];
    if (r.refused) return [{ kind: 'unmeasured', reason: 'action' }];
    if (r.changed) return [await judged(ctx, c.i, 'sort', ['sort'], clickRefs)];
  }
  return [{ kind: 'none' }];
}

/** Drags a slider's thumb; when that changes the value, presses its track (and clicks a plain track) and looks for named buttons. */
async function testSlider(ctx: ProbeContext, c: GestureCandidate, clickRefs: number[]): Promise<GestureOutcome[]> {
  const prep = await kit<{ x: number; y: number } | { refused: string } | null>(ctx, 'prepare', { i: c.i, uncover: true });
  if (!prep) return [{ kind: 'unmeasured', reason: 'covered' }];
  if (!('x' in prep)) return [{ kind: 'unmeasured', reason: 'action' }];
  await wait(ctx, GESTURE_TIMING.scroll);
  let family: Family | null = null;
  for (const f of ['pointer', 'mouse', 'touch'] as const) {
    const r = await kit<{ changed: boolean; refused?: string } | null>(ctx, 'slide', { i: c.i, family: f, how: 'drag' });
    if (!r) return [{ kind: 'unmeasured', reason: 'gone' }];
    if (r.refused) return [{ kind: 'unmeasured', reason: 'action' }];
    if (r.changed) { family = f; break; }
  }
  if (!family) return [{ kind: 'none' }];
  for (const how of ['tap', 'click'] as const) {
    const r = await kit<{ changed: boolean } | null>(ctx, 'slide', { i: c.i, family, how });
    if (r?.changed) return [{ kind: 'ok', what: 'slider', alternative: how === 'tap' ? 'pressing on the track' : 'clicking the track' }];
  }
  return [await judged(ctx, c.i, 'slider', ['slider'], clickRefs)];
}

/** One candidate under the click blocker; anything the request guard stopped makes it unmeasured. */
async function testCandidate(ctx: ProbeContext, c: GestureCandidate, clickRefs: number[], loaded: readonly string[]): Promise<GestureResult> {
  if (c.skip === 'action') return { candidate: c, outcomes: [{ kind: 'unmeasured', reason: 'action' }] };
  const background: GuardEvent[] = ctx.guard.events.slice();
  const mark = ctx.guard.mark();
  await kit(ctx, 'block', { on: true, i: c.i, drag: true });
  let outcomes: GestureOutcome[];
  /** What the test hid to reach the candidate (put back now). */
  let uncovered: string[] = [];
  try {
    outcomes = c.kind === 'region' ? await testRegion(ctx, c, clickRefs)
      : c.kind === 'slider' ? await testSlider(ctx, c, clickRefs)
      : await testItem(ctx, c, clickRefs);
  } finally {
    await kit(ctx, 'block', { on: false }).catch(() => {});
    uncovered = await kit<string[]>(ctx, 'uncovered').catch(() => []);
  }
  // Anything the guard stopped that is not the same GET the page already made: only failures measured
  // in the DOM are kept (see keptAfterStop); otherwise the candidate is not measured.
  const known = new Set([...loaded, ...background.map((e) => requestKey(e.method, e.url))]);
  // The guard's decisions, and what caused each write it blocked, before its log is read.
  await ctx.guard.settled?.(GUARD_SETTLE_MS).catch(() => false);
  const stopped = pointerStop(ctx.guard.since(mark), known, 'during the gesture or drag', { shownFiles: true });
  return { candidate: c, outcomes: keptAfterStop(outcomes, stopped ? { kind: 'unmeasured', reason: 'stopped', detail: stopped } : undefined), ...(uncovered.length ? { uncovered } : {}) };
}

/**
 * Finds content with gesture or drag handlers: regions (at least 160×100 px) with pointerdown,
 * touchstart or mousedown handlers, explicit `draggable="true"` items in a list, custom sliders
 * (`role="slider"`), and drag handles (a down handler and a grab or move cursor). In a context with a
 * touch screen (1280×900, like a tablet in landscape), each region is swiped left and right with
 * synthetic pointer, touch and mouse events (the families its handlers listen to) and pinched with two
 * pointers; screenshots and element sizes tell whether it changed (a region's change counts only when the drag
 * changes it beyond what the same moves without pressing show: a tooltip that follows the pointer is no drag; batch
 * 17). Items are dragged onto their own
 * sibling (an empty DataTransfer, never onto another drop zone); sliders' thumbs are dragged. When a
 * gesture or drag changes something, a single-pointer alternative is looked for by accessible name and
 * title only (next/previous, slide numbers, arrows, zoom, pan, move up/down, increase/decrease, a
 * select of positions) next to it, and for sliders pressing or clicking a plain part of the track.
 * None found: failed (swipes of carousels and pinches under 2.5.1; panning, sorting and sliders under
 * 2.5.7). A candidate is scrolled into view first, and content fixed on the screen over it (a header, a
 * banner, a cookie notice) is hidden while it is tested (visibility only, put back after it). Safety:
 * the guard sends nothing while it runs (`sendsNothing`), and a file the page only shows (a stylesheet,
 * font, image or media file) that it blocks does not stop the test; the listener hook's canceller
 * cancels the page's clicks and submits and stops form.submit(); no gesture, tap or drag starts on a
 * link, a submitter, a form field or a control named for an action (every such point refused:
 * `not_testable`), and drops land only on the sibling item itself. Deep: each region takes 1–3 s.
 */
export const pointerGesturesProbe: PageProbe = {
  id: 'pointer-gestures',
  usesPlan: true,
  criteria: ['2.5.1', '2.5.7', '2.1.1'],
  // 2.1.1 only through the reordered-list rule's own verdicts: a run that timed out, could not start or does not
  // stand says nothing for it, so the keyboard test's 2.1.1 stands (fix round 1, F5).
  measuredOnly: ['2.1.1'],
  kind: 'interaction',
  tier: 'deep',
  timeoutMs: 45_000,
  isolate: true,
  contextOptions: { hasTouch: true },
  // Strict guard: nothing a gesture, drag or drop makes the page ask for is sent. A stylesheet, font,
  // image or media file it asks for is blocked too, and does not stop the test (`pointerStop`).
  sendsNothing: true,
  // Its regions are what the page mounted: a page still putting its content in is waited for first
  // (bounded, `LATE_CONTENT_MS`; own page, so no other test waits with it; fix/late-mount).
  waitFor: { content: true },
  // Nothing it drags or clicks may save a file (`withoutDownloads`).
  run: withoutDownloads(async (ctx): Promise<ProbeFinding[]> => {
    const listeners = await ctx.listeners();
    const refs = byTarget(listeners, new Set<string>(GESTURE_DOWN_TYPES)).map(({ ref, types }) => ({ ref, types }));
    const clickRefs = byTarget(listeners, new Set(['click', 'pointerup', 'mouseup', 'touchend'])).map((r) => r.ref);
    const frames = await untestedFrames(ctx, FRAME_TYPES, true);
    // Down and move handlers of one family on the document or window: gestures the page handles anywhere.
    const onPage = new Set(listeners.filter((l) => l.target.kind !== 'element').map((l) => l.type));
    const documentGestures = [['pointerdown', 'pointermove'], ['touchstart', 'touchmove'], ['mousedown', 'mousemove']].some(([d, m]) => onPage.has(d!) && onPage.has(m!));
    if (!(await installKit(ctx))) throw new ProbeNotTestable('the test could not run its helpers in this page');
    const loaded = (await kit<string[]>(ctx, 'loadedUrls')).map((u) => requestKey('GET', u));
    try {
      // Planned regions are swiped with the down events the page handles on the document or on the window.
      const pageDown = [...onPage].filter((t) => (GESTURE_DOWN_TYPES as readonly string[]).includes(t));
      const planned = pageDown.length ? plannedFor(ctx.planned, 'pointer-gestures', ['carousel']).map((t) => ({ path: t.selector, types: pageDown })) : [];
      const { list: found, more } = await kit<{ list: GestureCandidate[]; more: { regions: number; items: number } }>(ctx, 'gestureCandidates', {
        refs, maxRegions: GESTURE_LIMITS.regions, maxItems: GESTURE_LIMITS.items, ...(planned.length ? { planned } : {}),
      });
      const results: GestureResult[] = [];
      for (const c of found) {
        if (ctx.signal.aborted || ctx.deadline - Date.now() < GESTURE_LIMITS.reserveMs) {
          // A planned region left for want of time is not part of the result.
          if (!c.planned) results.push({ candidate: c, outcomes: [{ kind: 'unmeasured', reason: 'time' }] });
          continue;
        }
        results.push(await testCandidate(ctx, c, clickRefs, loaded));
      }
      // 2.1.1: what the page offers the keyboard for each list measured reordering by dragging.
      const keys = new Map<GestureResult, SortKeys | null>();
      for (const r of results) if (measuredSort(r)) keys.set(r, await ctx.page.evaluate(sortKeyboardWay, { path: r.candidate.path }).catch(() => null));
      const sorted = sortKeyboardFindings(results, keys);
      if (!found.some((c) => c.planned)) return [...gestureFindings(results, frames, more, documentGestures), ...sorted];
      return [...withPlannedGestures(results, frames, more, documentGestures), ...sorted];
    } finally {
      await kit(ctx, 'drop').catch(() => {});
    }
  }),
};
