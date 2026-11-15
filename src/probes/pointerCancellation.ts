// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.5.2 Pointer cancellation (Plan 4 Task 4.5): a function must not complete on the down event
// unless releasing reverses it (or it is essential). Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { isActionUrl } from './guard.js';
import { GUARD_SETTLE_MS } from './motionShared.js';
import { byTarget, framesReason, installKit, kit, pointerStop, requestKey, untestedFrames, type StateDiff } from './pointerKit.js';
import { ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext } from './types.js';
import { withoutDownloads } from './pressSafely.js';

/** Listener types that act on the down event. */
export const DOWN_TYPES = ['pointerdown', 'mousedown', 'touchstart'] as const;
/**
 * Waits (ms): focus settles, the page is watched for changes of its own, hover, the press is held,
 * after release, after Escape; `watch`: how long the page is watched, when a change may not be the
 * press's, for changes of its own (at least, at most: until the timers that ran have run again).
 */
export const CANCEL_TIMING = { focus: 80, quiet: 200, hover: 120, hold: 300, release: 300, escape: 200, restoreChecks: [0, 500, 700], watch: [600, 3000], lookback: 1000 } as const;
/** Elements pressed per page, and the time kept back before the time box ends. */
export const CANCEL_LIMITS = { candidates: 6, reserveMs: 2500 } as const;

export interface DownCandidate {
  i: number;
  path: string;
  name: string;
  tag: string;
  types: string[];
  /** The address of the link around it. */
  href?: string;
  /** Picked as a control under a handler on the document or a page-wide wrapper (event delegation). */
  delegated?: boolean;
  /**
   * Not pressed: it (or an ancestor) is a link, a submitter, a form field or named for an action
   * ('action'); a native picker the browser opens on press ('picker'); a slider, which sets its value
   * where it is pressed ('slider'); unreachable ('covered').
   */
  skip?: 'action' | 'picker' | 'slider' | 'covered';
  /**
   * Batch 19: a key of an on-screen keypad or keyboard (`downCandidates`): it may type on the down event, as a keyboard's
   * keys do (2.5.2 Note 1: keyboard emulation is essential). Not pressed; never a failure.
   */
  key?: true;
}

export type CancelOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; how: 'navigation' | 'popup' | 'submit' | 'content'; url?: string; diff?: StateDiff }
  | { kind: 'unmeasured'; reason: 'moving' | 'covered' | 'gone' | 'stopped' | 'click' | 'time' | 'action' | 'closed' | 'left' | 'hover'; detail?: string };

export interface CancelResult {
  candidate: DownCandidate;
  outcome: CancelOutcome;
  /** The test left the page changed. */
  changedPage?: boolean;
  /** Tested after an earlier press had changed the page (and Escape put it back). */
  afterChange?: boolean;
  /** The page's clock when the press's baseline was taken (timers that ran since then may have changed the page). */
  since?: number;
}

/** What one press measured (input of `cancelOutcome`). */
export interface PressFacts {
  /** The page changed by itself (address, scroll, the element's own state) while it was watched before the press. */
  moving: boolean;
  /** Guard events from the press until the end (`down`: up to the release). */
  down: readonly GuardEvent[];
  all: readonly GuardEvent[];
  /** Guard events before the press (what the page asked for meanwhile is not new). */
  background: readonly GuardEvent[];
  /** Requests the page made before the test (`requestKey`: resource timing, as GET). */
  known?: readonly string[];
  /** Hovered → pressed (before release). */
  onPress: StateDiff | null;
  /** Before hovering → after moving away and releasing. */
  afterRelease: StateDiff | null;
  /** Click events that would have reached the element (all cancelled). */
  clicks: readonly string[];
  /** form.submit()/requestSubmit() calls the canceller stopped: while pressed, and in all. */
  submits?: { down: number; all: number };
}

/**
 * The decision for one press:
 * - a navigation, a new window, an address change or a form sent while the button is still down:
 *   failed (moving away cannot cancel it);
 * - the page changed while pressed (shown or hidden content, text, form values, the element's own
 *   text or ARIA state) and is still changed after moving away and releasing: failed, even when the
 *   guard also stopped a request (a measured failure stays failed; the comparison leaves out media whose
 *   request was stopped, which is what an aborted request would have shown). Opening a list of choices (menu,
 *   listbox) on press is not counted: the choice is made on release, as in a native select;
 * - otherwise a request the guard stopped (one the page had not already made), a navigation, window
 *   or form after release, a click that reached the element, or a page that changes by itself: not
 *   measured (never a clean result).
 */
export function cancelOutcome(f: PressFacts): CancelOutcome {
  const nav = f.down.find((e) => e.kind === 'navigation' || e.kind === 'url-change');
  if (nav) return { kind: 'failed', how: 'navigation', ...(nav.url ? { url: nav.url } : {}) };
  const popup = f.down.find((e) => e.kind === 'popup');
  if (popup) return { kind: 'failed', how: 'popup', ...(popup.url ? { url: popup.url } : {}) };
  if (f.submits?.down) return { kind: 'failed', how: 'submit' };
  if (f.moving) return { kind: 'unmeasured', reason: 'moving' };
  if (f.clicks.length) return { kind: 'unmeasured', reason: 'click' };
  if (f.onPress?.changed && !f.onPress.choices && f.afterRelease?.changed && !f.afterRelease.choices) {
    return { kind: 'failed', how: 'content', diff: f.onPress };
  }
  const known = new Set([...(f.known ?? []), ...f.background.map((e) => requestKey(e.method, e.url))]);
  const stopped = pointerStop(f.all, known, 'when it was pressed or released');
  if (stopped) return { kind: 'unmeasured', reason: 'stopped', detail: stopped };
  if (f.submits?.all) return { kind: 'unmeasured', reason: 'stopped', detail: 'the page tried to send a form when the button was released; the test stopped it, so the result could not be measured' };
  if (!f.onPress || !f.afterRelease) return { kind: 'unmeasured', reason: 'gone' };
  return { kind: 'ok' };
}

const quote = (s: string) => `“${s}”`;

/** Finding detail for a failed press (what was measured). */
export function cancelDetail(r: CancelResult & { outcome: { kind: 'failed' } }): string {
  const who = r.candidate.name ? `Pressing down on ${quote(r.candidate.name)}` : `Pressing down on this ${r.candidate.tag}`;
  const o = r.outcome;
  if (o.how === 'navigation') return `${who} goes to ${o.url ?? 'another address'} before the button is released, so moving the pointer away cannot cancel it`;
  if (o.how === 'popup') return `${who} opens a new window${o.url ? ` (${o.url})` : ''} before the button is released, so moving the pointer away cannot cancel it`;
  if (o.how === 'submit') return `${who} sends a form before the button is released, so moving the pointer away cannot cancel it`;
  const d = o.diff!;
  const what = d.url ? `changes the address to ${d.url}`
    : d.shown && d.text ? `shows ${quote(d.text)}`
    : d.shown ? `shows ${d.shown === 1 ? 'new content' : `${d.shown} new pieces of content`}`
    : d.hidden ? `hides ${d.hidden === 1 ? 'content' : `${d.hidden} pieces of content`}`
    : d.textChange ? `changes ${quote(d.textChange.from)} to ${quote(d.textChange.to)}`
    : d.values ? `changes the value of ${d.values === 1 ? 'a form field' : `${d.values} form fields`}`
    : d.own ? d.own
    : 'scrolls the page';
  return `${who} ${what} before the button is released, and moving the pointer away before releasing does not undo it`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The page's result: failures first; otherwise `not_testable` when an element was not pressed for
 * safety, could not be reached or measured, or the time ran out (never a clean result unmeasured);
 * `not_applicable` when nothing on the page reacts to pressing down (or only sliders and native
 * pickers do).
 */
/** Reason when the page has a down handler on the document (or a page-wide wrapper) and nothing to sample for it. */
export const DELEGATED_EMPTY = 'the page reacts to pressing down anywhere (a handler on the document or the window), and it has no buttons, tabs or summaries the test could press for it, so that handler was not tested';

export function cancelFindings(results: readonly CancelResult[], frames: readonly string[] = [], more = 0, delegatedEmpty = false): ProbeFinding[] {
  const failed = results.filter((r): r is CancelResult & { outcome: { kind: 'failed' } } => r.outcome.kind === 'failed');
  if (failed.length) return failed.map((r) => ({ criterion: '2.5.2', status: 'failed' as const, target: r.candidate.path, detail: cancelDetail(r) }));
  const un = results.filter((r): r is CancelResult & { outcome: { kind: 'unmeasured' } } => r.outcome.kind === 'unmeasured');
  const total = results.filter((r) => r.candidate.skip !== 'picker' && r.candidate.skip !== 'slider').length;
  const count = (reason: string) => un.filter((r) => r.outcome.reason === reason);
  const stopped = count('stopped')[0];
  if (stopped) throw new ProbeNotTestable(stopped.outcome.detail!);
  const action = count('action');
  if (action.length) {
    const one = action.length === 1;
    const names = action.slice(0, 3).map((r) => quote(r.candidate.name || r.candidate.tag)).join(', ') + (action.length > 3 ? ', …' : '');
    throw new ProbeNotTestable(`${plural(action.length, 'element')} that ${one ? 'reacts' : 'react'} to pressing down ${one ? 'was' : 'were'} not pressed because ${one ? 'it is a link, a submit button or a form field, or its name says it performs' : 'they are links, submit buttons or form fields, or their names say they perform'} an action (${names})`);
  }
  const closed = count('closed').length;
  if (closed) throw new ProbeNotTestable(`${plural(closed, 'element')} that ${closed === 1 ? 'reacts' : 'react'} to pressing down ${closed === 1 ? 'is' : 'are'} inside a closed shadow root, where the pressed target cannot be seen, so ${closed === 1 ? 'it was' : 'they were'} not pressed`);
  const left = count('left').length;
  if (left) throw new ProbeNotTestable(`an earlier press left the page changed (Escape did not undo it), so ${plural(left, 'element')} that ${left === 1 ? 'reacts' : 'react'} to pressing down could not be pressed`);
  const reasons: [string, string][] = [
    ['moving', 'changes by itself while it is watched, so a change on pressing could not be attributed'],
    ['hover', 'shows the same change when the pointer only rests on it (a tooltip that waits before it shows and hides a while after the pointer leaves), so a change on pressing could not be told from it'],
    ['click', 'received a click although the pointer moved away before releasing (the click was canceled)'],
    ['covered', 'could not be reached by the pointer (covered by other content)'],
    ['gone', 'disappeared before it could be pressed'],
  ];
  for (const [reason, text] of reasons) {
    const n = count(reason).length;
    if (n) throw new ProbeNotTestable(`${plural(n, 'element')} of ${total} that react to pressing down ${text}`);
  }
  const time = count('time').length;
  if (time) throw new ProbeNotTestable(`the time ran out after ${total - time} of ${total} ${total === 1 ? 'element' : 'elements'} that react to pressing down`);
  if (more) throw new ProbeNotTestable(`${plural(more, 'more kind')} of element that ${more === 1 ? 'reacts' : 'react'} to pressing down ${more === 1 ? 'was' : 'were'} not pressed (the test presses ${CANCEL_LIMITS.candidates} kinds per page)`);
  if (delegatedEmpty) throw new ProbeNotTestable(DELEGATED_EMPTY);
  if (frames.length) throw new ProbeNotTestable(framesReason(frames, 'Content that reacts to pressing down'));
  if (!total) {
    return [{
      criterion: '2.5.2', status: 'not_applicable',
      detail: results.length
        ? 'only sliders and native pickers react to pressing down on this page; they set or open on press as the browser’s own controls do'
        : 'no element on the page reacts to pressing down (no pointerdown, mousedown or touchstart handlers on page elements)',
    }];
  }
  return [];
}

const wait = (ctx: ProbeContext, ms: number) => ctx.page.waitForTimeout(ms);

interface Press {
  outcome: CancelOutcome;
  changedPage: boolean;
  /**
   * A timer of 1 s or more ran while it was pressed (or in the second before), an animation was already
   * under way at the baseline, or the page changed by itself right after: the change may not be the press's.
   */
  doubtful: boolean;
  /** The page's clock before the press's baseline. */
  since?: number;
}

/**
 * Watches the page while nothing is done (kit `watch`, label `w`) until the timers that ran since
 * `since` have run again: at least 600 ms, at most 3 s, and never into the time kept back.
 */
async function watchSelfChanges(ctx: ProbeContext, i: number, since: number): Promise<boolean> {
  const [min, max] = CANCEL_TIMING.watch;
  const maxMs = Math.max(min, Math.min(max, ctx.deadline - Date.now() - CANCEL_LIMITS.reserveMs));
  return kit<boolean>(ctx, 'watch', { i, label: 'w', since, minMs: min, maxMs });
}

/** One press: baseline, press and hold, move away and release, compare. */
async function pressOnce(ctx: ProbeContext, c: DownCandidate, known: readonly string[]): Promise<Press> {
  type Diff = (a: string, b: string, noise?: boolean, stopped?: string[]) => Promise<StateDiff | null>;
  const { page } = ctx;
  const mouse = page.mouse!;
  const i = c.i;
  const snap = (label: string) => kit(ctx, 'snap', { i, label });
  const NOISE: [string, string] = ['a', 'a2'];
  const diff: Diff = (a, b, noise = true, stopped = []) => kit<StateDiff | null>(ctx, 'diff', { i, a, b, stopped, ...(noise ? { noise: NOISE } : {}) });
  const touch = !c.types.includes('pointerdown') && !c.types.includes('mousedown');
  await mouse.move(-1, -1);
  const at = await kit<{ x: number; y: number } | { refused: string } | null>(ctx, 'prepare', { i, focus: true, real: true });
  if (!at) return { outcome: { kind: 'unmeasured', reason: 'covered' }, changedPage: false, doubtful: false };
  // Inside a closed shadow root what the pointer would press cannot be seen; otherwise every point of
  // it the pointer reaches is a link, a submitter, a form field or named for an action.
  if (!('x' in at)) return { outcome: { kind: 'unmeasured', reason: at.refused === 'closed' ? 'closed' : 'action' }, changedPage: false, doubtful: false };
  await wait(ctx, CANCEL_TIMING.focus);
  // From the baseline on, what the press's own handlers change is told apart from everything else.
  await kit(ctx, 'trace', { on: true }).catch(() => false);
  await snap('a');
  await wait(ctx, CANCEL_TIMING.quiet);
  await snap('a2');
  // What changes by itself while nothing is done (a rotating notice) is left out of the comparisons;
  // an address, scroll position or the element's own state changing by itself makes the press unmeasurable.
  const quiet = await diff('a', 'a2', false);
  const moving = !!(quiet && (quiet.url || quiet.scrolled || quiet.own));
  if (!touch) {
    await mouse.move(at.x, at.y, { steps: 2 });
    await wait(ctx, CANCEL_TIMING.hover);
  }
  // The clock is read before the baseline: a timer that runs between the baseline and the press (a
  // slow round trip on a busy machine) changes what the press is compared with, so it counts.
  const t0 = await kit<number>(ctx, 'now');
  await snap('b');
  // A change already under way at the baseline (an animation or transition the page started before the
  // press) is not the press's: a failure then is in doubt, and the press is tried again.
  const underWay = await kit<number>(ctx, 'animating', { i }).catch(() => 0);
  const background = ctx.guard.events.slice();
  const mark = ctx.guard.mark();
  await kit(ctx, 'block', { on: true, i });
  let held = { reached: [] as string[], submits: 0 };
  let downSubmits = 0;
  let down: GuardEvent[] = [];
  let pressed = false;
  let timers = 0;
  try {
    // Marked pressed before the press, so the release always runs.
    pressed = true;
    if (touch) pressed = await kit<boolean>(ctx, 'touch', { i, phase: 'down', x: at.x, y: at.y });
    else await mouse.down();
    await wait(ctx, CANCEL_TIMING.hold);
    await snap('c');
    down = ctx.guard.since(mark);
    downSubmits = (await kit<{ submits: number }>(ctx, 'held')).submits;
    // A timer that ran just before the baseline may still be changing the page (it started a fade): counted too.
    timers = await kit<number>(ctx, 'timersSince', { t: t0 - CANCEL_TIMING.lookback });
  } finally {
    // Move away first, then release: the click a release would make never reaches the element, and
    // the canceller cancels whatever click there is.
    if (touch) {
      if (pressed) {
        const away = await kit<{ x: number; y: number }>(ctx, 'awayPoint', { i }).catch(() => ({ x: 2, y: 2 }));
        await kit(ctx, 'touch', { i, phase: 'away', x: at.x, y: at.y, to: away }).catch(() => {});
      }
    } else {
      await mouse.move(-1, -1, { steps: 3 }).catch(() => {});
      if (pressed) await mouse.up().catch(() => {});
    }
    await wait(ctx, CANCEL_TIMING.release).catch(() => {});
    held = await kit<{ reached: string[]; submits: number }>(ctx, 'block', { on: false }).catch(() => held);
  }
  await snap('d');
  await kit(ctx, 'trace', { on: false }).catch(() => false);
  // The guard's decisions on what the page asked for, before its log is read.
  await ctx.guard.settled?.(GUARD_SETTLE_MS).catch(() => false);
  const all = ctx.guard.since(mark);
  // What an aborted request would have shown (its image or frame) is not counted as a change.
  const stoppedUrls = all.filter((e) => e.kind === 'blocked' && e.url).map((e) => e.url!);
  const facts: PressFacts = {
    moving, down, all, background, known, clicks: held.reached, submits: { down: downSubmits, all: held.submits },
    onPress: await diff('b', 'c', true, stoppedUrls), afterRelease: await diff('a', 'd', true, stoppedUrls),
  };
  let outcome = cancelOutcome(facts);
  // The page is left changed only by what the comparison sees (not by a request the guard stopped).
  let changedPage = !!(await diff('a', 'd', false))?.changed;
  let doubtful = false;
  let watchedRan = false;
  if (outcome.kind === 'failed' && outcome.how === 'content') {
    // Was it the press? A timer that ran meanwhile, or a page still changing on its own, could have
    // done it. The page is watched until those timers have run again: whatever changes meanwhile
    // changes by itself (a notice that rotates every second, whatever the moment it last changed) and
    // is left out of the comparisons; a change of the press is still there without it.
    if ((watchedRan = await watchSelfChanges(ctx, i, t0))) {
      const watched = (a: string, b: string, noise: boolean) => kit<StateDiff | null>(ctx, 'diff', { i, a, b, stopped: stoppedUrls, watched: 'w', ...(noise ? { noise: NOISE } : {}) });
      outcome = cancelOutcome({ ...facts, onPress: await watched('b', 'c', true), afterRelease: await watched('a', 'd', true) });
      changedPage = !!(await watched('a', 'd', false))?.changed;
      doubtful = outcome.kind === 'failed' && outcome.how === 'content';
    } else {
      doubtful = timers > 0 || underWay > 0;
    }
    if (doubtful) {
      // What the press's own handlers changed (while the down event was dispatched) and nothing else
      // touched: when that alone is still changed after moving away and releasing, it is the press's.
      // A second press would find it already so and change nothing (a message shown again), so the
      // doubt is settled here, never by pressing again.
      const own = async (a: string, b: string) => kit<StateDiff | null>(ctx, 'diff', { i, a, b, stopped: stoppedUrls, by: 'press', ...(watchedRan ? { watched: 'w' } : {}), noise: NOISE }).catch(() => null);
      const onPress = await own('b', 'c');
      const afterRelease = onPress ? await own('a', 'd') : null;
      const mine = onPress && afterRelease ? cancelOutcome({ ...facts, onPress, afterRelease }) : null;
      if (mine?.kind === 'failed' && mine.how === 'content') {
        outcome = mine;
        doubtful = false;
      }
    }
  }
  return { outcome, changedPage, doubtful, since: t0 };
}

/**
 * Presses one element down (real mouse, or a synthetic touch for touch-only handlers), moves away,
 * releases. A failure that may have been caused by something else (a timer ran, the page kept
 * changing) is tried once more from the new state; still in doubt, it is not measured.
 */
export async function testPress(ctx: ProbeContext, c: DownCandidate, known: readonly string[] = []): Promise<CancelResult> {
  const r = await pressTwice(ctx, c, known);
  // A change of content: was it the press's, or what the pointer resting there shows by itself? (Batch 17: a chart's
  // tooltip that waits before it shows was read as "pressing down shows the tooltip".)
  if (r.outcome.kind === 'failed' && r.outcome.how === 'content' && (c.types.includes('pointerdown') || c.types.includes('mousedown'))) {
    if (await hoverAlone(ctx, c).catch(() => false)) return { ...r, outcome: { kind: 'unmeasured', reason: 'hover' } };
  }
  return r;
}

async function pressTwice(ctx: ProbeContext, c: DownCandidate, known: readonly string[]): Promise<CancelResult> {
  const first = await pressOnce(ctx, c, known);
  const since = first.since !== undefined ? { since: first.since } : {};
  if (!first.doubtful) return { candidate: c, outcome: first.outcome, changedPage: first.changedPage, ...since };
  const again = await pressOnce(ctx, c, known);
  const changedPage = first.changedPage || again.changedPage;
  if (again.doubtful) return { candidate: c, outcome: { kind: 'unmeasured', reason: 'moving' }, changedPage, ...since };
  return { candidate: c, outcome: again.outcome, changedPage, ...since };
}

/**
 * The control for a press that changed content (batch 17, 2.5.2 precision): the same moves without pressing. What the
 * press left is let go first (looked at over about 1.2 s, as after any press), then the pointer rests on the element
 * as long as the press and its hover lasted, moves away and waits as long as after a release. True when that alone
 * changed the page while the pointer rested there and it is still changed after (a tooltip with a show delay and a
 * hide delay): the press's change cannot be told from it. Presses nothing; the canceller stays off (no press, no click).
 */
async function hoverAlone(ctx: ProbeContext, c: DownCandidate): Promise<boolean> {
  const mouse = ctx.page.mouse!;
  const i = c.i;
  const NOISE: [string, string] = ['a', 'a2'];
  await mouse.move(-1, -1);
  for (const pause of CANCEL_TIMING.restoreChecks) {
    if (pause) await wait(ctx, pause);
    await kit(ctx, 'snap', { i, label: 'r' });
    if (await kit<boolean>(ctx, 'restored', { a: 'a', d: 'd', r: 'r' })) break;
  }
  const at = await kit<{ x: number; y: number } | { refused: string } | null>(ctx, 'prepare', { i, focus: true, real: true });
  if (!at || !('x' in at)) return false;
  await wait(ctx, CANCEL_TIMING.focus);
  await kit(ctx, 'snap', { i, label: 'h0' });
  await mouse.move(at.x, at.y, { steps: 2 });
  await wait(ctx, CANCEL_TIMING.hover + CANCEL_TIMING.hold);
  await kit(ctx, 'snap', { i, label: 'h1' });
  await mouse.move(-1, -1, { steps: 3 });
  await wait(ctx, CANCEL_TIMING.release);
  await kit(ctx, 'snap', { i, label: 'h2' });
  const shown = await kit<StateDiff | null>(ctx, 'diff', { i, a: 'h0', b: 'h1', noise: NOISE });
  const stays = await kit<StateDiff | null>(ctx, 'diff', { i, a: 'h0', b: 'h2', noise: NOISE });
  return !!(shown?.changed && !shown.choices && stays?.changed && !stays.choices);
}

/**
 * Finds elements with pointerdown, mousedown or touchstart handlers (the listener hook; one per set
 * of handlers, at most 6 pressed, controls first; page-wide wrappers left out; with a handler on the
 * document, plain controls as a sample) and presses each down without releasing: the real mouse for
 * pointer and mouse handlers (focus and hover applied first, so their effects are not counted), a
 * synthetic touch for touch-only handlers. After 300 ms the page is compared with how it was; then the
 * pointer moves off the page and is released, and the page is compared with how it was before the
 * test. A navigation, new window, form sent or content change on press that moving away does not undo
 * is failed. Safety: the guard sends nothing while it runs (`sendsNothing`); the listener hook's
 * canceller, registered before any page script, cancels every click, submit and native drag and stops
 * form.submit(); links, submitters, form fields and controls named for an action are never pressed,
 * wherever the pointer would land. Deep: about 1 s per element pressed.
 */
export const pointerCancellationProbe: PageProbe = {
  id: 'pointer-cancellation',
  criteria: ['2.5.2'],
  kind: 'interaction',
  // Each press takes about 1 s (baseline, hold, release, compare), up to 6 per page: over the core
  // budget (about 3 s per 25-page scan), so it runs with --full.
  tier: 'deep',
  timeoutMs: 15_000,
  // Strict guard: nothing a down or up handler asks for is sent (every request blocked, every
  // navigation held), and the page is not reused after this probe.
  sendsNothing: true,
  // Nothing it presses may save a file (`withoutDownloads`).
  run: withoutDownloads(async (ctx): Promise<ProbeFinding[]> => {
    const { page } = ctx;
    const listeners = await ctx.listeners();
    const refs = byTarget(listeners, new Set<string>(DOWN_TYPES));
    // Down handlers on the window or the document may act for any control (event delegation).
    const delegated = listeners.some((l) => l.target.kind !== 'element' && (DOWN_TYPES as readonly string[]).includes(l.type));
    const frames = await untestedFrames(ctx, DOWN_TYPES);
    if (!refs.length && !delegated) return cancelFindings([], frames);
    if (!page.mouse) throw new ProbeNotTestable('the browser cannot move the pointer, which this test needs');
    if (!(await installKit(ctx))) throw new ProbeNotTestable('the test could not run its helpers in this page');
    const known = (await kit<string[]>(ctx, 'loadedUrls')).map((u) => requestKey('GET', u));
    const results: CancelResult[] = [];
    try {
      const { list: found, more, delegatedEmpty } = await kit<{ list: DownCandidate[]; more: number; delegatedEmpty: boolean }>(ctx, 'downCandidates', {
        refs: refs.map(({ ref, types }) => ({ ref, types })), max: CANCEL_LIMITS.candidates, delegated,
      });
      let dirty: CancelResult | null = null;
      let left = false;
      let afterChange = false;
      for (const c of found) {
        // A link whose address looks like an action is never pressed either.
        if (!c.skip && c.href && isActionUrl(c.href)) c.skip = 'action';
        if (c.skip) {
          results.push({ candidate: c, outcome: c.skip === 'action' ? { kind: 'unmeasured', reason: 'action' } : { kind: 'ok' } });
          continue;
        }
        // A keypad's or keyboard's key: typing on the down event is essential (2.5.2 Note 1); not pressed.
        if (c.key) {
          results.push({ candidate: c, outcome: { kind: 'ok' } });
          continue;
        }
        if (left) {
          results.push({ candidate: c, outcome: { kind: 'unmeasured', reason: 'left' } });
          continue;
        }
        if (ctx.signal.aborted || ctx.deadline - Date.now() < CANCEL_LIMITS.reserveMs) {
          results.push({ candidate: c, outcome: { kind: 'unmeasured', reason: 'time' } });
          continue;
        }
        if (dirty) {
          // The page cannot be loaded again (the strict guard holds every navigation). Escape (with the
          // canceller on) may close what the earlier press opened; if what it changed is not back as it
          // was, the rest is not pressed on a changed page.
          afterChange = true;
          await kit(ctx, 'block', { on: true });
          await page.keyboard?.press('Escape').catch(() => {});
          await wait(ctx, CANCEL_TIMING.escape);
          await kit(ctx, 'block', { on: false });
          // Looked at again over about 1.2 s: content that changes by itself (a rotating notice) comes back
          // to how it was; what the press left open does not.
          let back = false;
          for (const pause of CANCEL_TIMING.restoreChecks) {
            if (pause) await wait(ctx, pause);
            await kit(ctx, 'snap', { i: dirty.candidate.i, label: 'r' });
            if ((back = await kit<boolean>(ctx, 'restored', { a: 'a', d: 'd', r: 'r' }))) break;
          }
          // Content that changes by itself can look unrestored at every look (a busy machine, a slow
          // timer): the page is watched until the timers that ran since that press have run again, and
          // what changes meanwhile is left out.
          if (!back && (await watchSelfChanges(ctx, dirty.candidate.i, dirty.since ?? 0))) {
            await kit(ctx, 'snap', { i: dirty.candidate.i, label: 'r' });
            back = await kit<boolean>(ctx, 'restored', { a: 'a', d: 'd', r: 'r', watched: 'w' });
          }
          if (!back) {
            left = true;
            results.push({ candidate: c, outcome: { kind: 'unmeasured', reason: 'left' } });
            continue;
          }
          dirty = null;
        }
        const r = await testPress(ctx, c, known);
        results.push({ ...r, ...(afterChange ? { afterChange: true } : {}) });
        if (r.changedPage) dirty = r;
      }
      // A control sampled under a handler on the document that the pointer could not reach (covered,
      // gone) leaves no gap, unless an earlier press changed the page; one not pressed for safety, a
      // click that reached it or the time running out does.
      const kept = results.filter((r) => !(r.candidate.delegated && !r.afterChange && r.outcome.kind === 'unmeasured' && (r.outcome.reason === 'covered' || r.outcome.reason === 'gone')));
      return cancelFindings(kept, frames, more, delegatedEmpty);
    } finally {
      await kit(ctx, 'drop').catch(() => {});
      await page.mouse.move(-1, -1).catch(() => {});
    }
  }),
};
