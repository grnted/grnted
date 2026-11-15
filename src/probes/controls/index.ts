// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The controls test (deep): presses the page's own controls and judges what happens.
//
// The keyboard test walks a page with Tab and never activates anything, so a control that takes focus
// but answers only to the pointer, and everything that happens only after a control is pressed, is
// outside it. This test presses each control (one of each kind first, at most `CONTROLS_LIMITS.candidates`
// per page):
// - with the keyboard: Enter and Space on a control that takes focus; the arrow keys, then Enter and
//   Space, on a composite widget (tabs, a radio group, a list box, a menu, a toolbar with one Tab stop);
// - with the mouse, when no key did anything: a real click;
// and compares what scripts changed on the page each time (never CSS alone: focus and hover are part of
// the baseline). Findings:
// - 2.1.1 (failure F54): a click does something a person would notice, and no key does: not Enter or
//   Space, not a key the control names for itself (aria-keyshortcuts, accesskey, "press F2"), and no other
//   control with the same name or target does the same with the keyboard (where that cannot be told, the
//   result is "not testable", never a failure);
// - 4.1.3: the press shows a status message that is in no live region and takes no focus;
// - 2.4.3 (failure F85): the press opens a dialog, a menu or a layer with controls in it, focus is not
//   moved into it, and the next Tab presses do not reach it;
// - 2.4.11: after the press, the element that holds focus is entirely hidden behind fixed or sticky content;
// - 2.1.2: focus cannot leave what the press opened (the keyboard test's own trap rules).
// Then the same presses inside the page's own embedded frames (same origin, shown; at most 2 frames and 4 controls
// each, keyboard-op lane 2026-11-11), for 2.1.1 and 2.1.2 only: a map, a calendar or a booking tool in a frame is
// part of the page. A pointer-only control there is failed only when nothing outside the frame has its name or
// points at the frame (the presses are not compared across documents); a frame that should have been looked into
// and was not leaves 2.1.1 not testable.
//
// Safety: the guard sends nothing while it runs (`sendsNothing`: every request is blocked, every
// navigation held), and the page is never reused. Links, form fields, a form's submit and reset buttons
// and controls named for an action on the site (log out, delete, pay…) are never pressed.
// Cost: one page load of its own, and about 1 s per control pressed (up to 8). Engine core: no
// Node-only imports.
import type { ProbeFinding } from '../../types.js';
import { oneTrap } from '../keyboard/findings.js';
import { kitActiveId, kitDescribe, kitFocusId, kitHold, kitMeasureKeyed, kitOutside, kitSettleRemeasure, kitStop, kitTrapExits, kitTrapRegion, type StopFacts } from '../keyboard/page.js';
import { CLOSE_NAME, findCycle, hiddenReason, obscuredBy, SETTLE_CAP_MS } from '../keyboard/rules.js';
import { escapeTrap, startKit, type TrapResult } from '../keyboard/traverse.js';
import { ACTION_NAME, isActionName } from '../pointerKit.js';
import { DOWNLOAD_STOP_KEY, stopDownloads, undoDownloadStop } from '../noDownloads.js';
import { frameGapFindings, frameWords, ownFrames } from '../frameLayout.js';
import { bounded, callMs, controlsOutsideFrame, FRAME_CALL_MS, frameProbeContext, isFrameMiss, pointMissed, settleFrames, widgetMemberNames } from '../frameContext.js';
import { ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext } from '../types.js';
import { LIVE_REGION_SELECTOR } from '../liveRegion.js';
import {
  CONTROLS_KEY, controlsKit, installControlsKit, KEY_TYPES, POINTER_TYPES,
  type AfterState, type Alternative, type CandidateList, type ControlCandidate, type Effect, type FieldCandidate, type Message, type Opened, type ShortcutSource,
} from './page.js';
import {
  clickDid, CONTROLS_LIMITS, controlsFindings, DISCLOSURE_NAME, effectWords, hiddenDoubt, hiddenFinding, keyDid, orderFinding, changeOwner, sameEffect, shortcutPlan, STATUS_TEXT, unannounced,
  type ControlResult, type Did, type FieldResult, type Operation,
} from './rules.js';

export const CONTROLS_PROBE_ID = 'controls';
export const CONTROLS_CRITERIA = ['2.1.1', '2.1.2', '2.4.3', '2.4.11', '4.1.3'] as const;

type Point = { x: number; y: number };
/** One press that did something: how, and the two states it lies between (kit labels). */
interface Press { did: Did; how: 'keys' | 'pointer'; key: string; a: string; b: string; effect: Effect | null }

const L = CONTROLS_LIMITS;
const isStop = (e: GuardEvent) => (e.kind === 'blocked' && e.cause !== 'background') || e.kind === 'navigation';

/** The cover of the element that holds focus now, when it is entirely hidden behind fixed or sticky content. */
async function focusCover(ctx: ProbeContext): Promise<string | null> {
  const { page } = ctx;
  let s: StopFacts = (await page.evaluate(kitMeasureKeyed, undefined)).facts;
  if (!s.id || s.frame || !s.facts) return null;
  const cover = (x: StopFacts) => (x.facts && !hiddenReason(x.facts) && x.grid ? obscuredBy(x.grid) : null);
  if (!cover(s)) return null;
  // Looks covered: measure again once scrolling has stopped (the keyboard walk's rule).
  const settle = await page.evaluate(kitSettleRemeasure, { id: s.id, cap: SETTLE_CAP_MS });
  if (!settle.settled) return null;
  if (settle.again) s = { ...s, box: settle.again.box, facts: settle.again.facts, grid: settle.again.grid };
  return cover(s);
}

/**
 * A focus loop inside what a press opened: Tab from inside it, the keyboard test's cycle rule, its ways
 * out (Shift+Tab, Esc, buttons named Close or the like, a key the page advises), and, since nothing can
 * be sent here, the loop's other plain buttons too. Returns the keyboard test's own finding for the trap.
 */
async function trapIn(ctx: ProbeContext, c: ControlCandidate, o: Opened, late: (need?: number) => boolean): Promise<{ findings: ProbeFinding[]; trapped: boolean }> {
  const { page } = ctx;
  const k = <R>(op: string, a: unknown = {}) => controlsKit<R>(ctx, op, a);
  const none = { findings: [], trapped: false };
  if (!(await k<boolean | null>('focusIn', { k: o.k })) && !(await k<boolean>('focusInto', { k: o.k }))) return none;
  const inside = async () => (await k<boolean | null>('focusIn', { k: o.k })) === true;
  const members = await tabLoop(ctx, inside, late);
  if (!members) return none;
  const who = c.name ? `“${c.name.length > 60 ? `${c.name.slice(0, 59)}…` : c.name}”` : c.path;
  return judgeLoop(ctx, members, inside, late, `After ${who} is pressed: `);
}

/** Tab, up to `L.trapTabs` times, while `inside` holds: the members of the focus cycle found, or null (focus left, or no cycle). */
async function tabLoop(ctx: ProbeContext, inside: () => Promise<boolean>, late: (need?: number) => boolean): Promise<number[] | null> {
  const { page } = ctx;
  const seq: number[] = [];
  for (let n = 0; n < L.trapTabs && !late(4000); n++) {
    await page.keyboard!.press('Tab');
    await page.evaluate(kitHold, undefined).catch(() => {});
    const id = await page.evaluate(kitActiveId, undefined);
    // Focus left it (or it closed): no loop.
    if (!(await inside())) return null;
    seq.push(id);
    const cycle = findCycle(seq, L.maxCycle);
    if (cycle) return cycle.members;
  }
  return null;
}

/**
 * Judges a focus cycle with the keyboard test's trap rules (`escapeTrap`, `oneTrap`); since nothing can be sent here,
 * the loop's other plain buttons are pressed too. `inside`: focus is still in what holds the loop; `more`: focusable
 * elements outside this document that the loop keeps out of reach (a frame's page). `lead` starts each detail.
 */
async function judgeLoop(ctx: ProbeContext, members: number[], inside: () => Promise<boolean>, late: (need?: number) => boolean, lead: string, more = 0): Promise<{ findings: ProbeFinding[]; trapped: boolean }> {
  const { page } = ctx;
  const none = { findings: [], trapped: false };
  const outside = (await page.evaluate(kitOutside, members)) + more;
  if (!outside) return none;
  const region = await page.evaluate(kitTrapRegion, members);
  const names: string[] = [];
  for (const m of members.slice(0, 4)) {
    const d = await page.evaluate(kitDescribe, m).catch(() => null);
    if (d?.name) names.push(d.name);
  }
  const t0 = Date.now();
  const lateTrap = () => late(4000) || Date.now() > t0 + L.trapMs;
  const esc = await escapeTrap(ctx, members, lateTrap);
  const trap: TrapResult = { members, names, region: { path: region.path, ...(region.name ? { name: region.name } : {}) }, dialog: region.dialog, ...esc, outside };
  // Nothing can be sent here, so the loop's other plain buttons are pressed too: one that lets focus out
  // is the way out; when none does, they are no exits.
  if (!trap.escaped && !trap.stopped && !trap.untested && !trap.logFull && trap.exits.buttons.length && !trap.exits.links.length && !trap.exits.submits.length) {
    const all = await page.evaluate(kitTrapExits, { members, pattern: '[\\s\\S]*', max: 4 });
    const others = all.press.filter((b) => !CLOSE_NAME.test(b.name ?? ''));
    let tried = 0;
    for (const b of others) {
      if (isActionName(b.name)) continue;
      if (lateTrap()) { trap.untested = 'there was no time left to press its other buttons'; break; }
      if (!(await page.evaluate(kitFocusId, b.id).catch(() => false))) continue;
      tried++;
      const mark = ctx.guard.mark();
      await page.keyboard!.press('Enter');
      await page.waitForTimeout(150);
      await page.evaluate(kitHold, undefined).catch(() => {});
      const stop = ctx.guard.since(mark).find(isStop);
      if (stop) { trap.stopped = stop; break; }
      trap.pressed.push(b.name ?? b.path);
      if (!(await inside())) { trap.escaped = 'close'; break; }
    }
    // Every plain button was pressed and focus is still inside: they are not ways out.
    if (!trap.escaped && !trap.stopped && !trap.untested && tried === others.length && tried === trap.exits.buttons.length) trap.exits = { ...trap.exits, buttons: [] };
  }
  const findings = oneTrap(trap).map((f) => ({ ...f, detail: `${lead}${f.detail}` }));
  return { findings, trapped: !trap.escaped };
}

/** Why a control was not clicked: the page's own content covers it. */
const COVERED = 'it is covered by other content, so it was not clicked';

/** Presses one control with the keyboard and, when the keys do nothing, the mouse; then looks at what the press left. */
async function pressControl(ctx: ProbeContext, c: ControlCandidate, late: (need?: number) => boolean): Promise<ControlResult> {
  const { page } = ctx;
  const k = <R>(op: string, a: unknown = {}) => controlsKit<R>(ctx, op, a);
  const wait = (ms: number) => page.waitForTimeout(ms);
  const result: ControlResult = { candidate: c, operation: { kind: 'none' }, looked: false, status: [], announced: 0, after: [], openedControls: false, focusJudged: false, trapJudged: false };

  // In view, the pointer away, nothing pressed for a moment: what changes meanwhile is the page's own doing.
  await k('prepare', { i: c.i });
  await page.mouse!.move(-1, -1).catch(() => {});
  await k('begin', { i: c.i, label: 'idle' });
  await wait(L.idleMs);
  await k('begin', { i: c.i, label: 'idle', idle: true });

  /** The press changed the page (content, a form value, the control's state, the address), not only where focus is. */
  const acted = (e: Effect | null) => !!e && (e.shown > 0 || e.hidden > 0 || !!e.textChange || !!e.own || e.values > 0 || !!e.url);
  /**
   * The press's own effect: what it changed with what the page changes by itself left out. `uncertain`
   * when a one-off timer ran in the same moment (the change may be the timer's); null when nothing is left;
   * `self` (a click's window, `since`) when what is left out was written by the page's own timers and nothing else is.
   */
  const settle = async (did: Did | null, effect: Effect | null, a: string, b: string, since?: number): Promise<{ did: Did; effect: Effect | null } | 'uncertain' | 'self' | null> => {
    if (!did) return null;
    if (!did.page || !effect) return { did, effect };
    // Focus that moved (to another member of a composite, to another element) is the key's own doing:
    // no script change stands behind it that the page could have made by itself.
    if (!acted(effect)) return { did, effect };
    const owner = changeOwner(effect);
    if (owner === 'press') return { did, effect };
    if (owner === 'unknown') return 'uncertain';
    await k('quiet', { ms: L.quietMs, maxMs: L.quietMaxMs });
    const again = await k<Effect | null>('rediff', { i: c.i, a, b, ...(since !== undefined ? { since } : {}) });
    if (!again) return null;
    const kept: Effect = { ...again, ...(effect.member ? { member: true } : {}), ...(again.focus ?? effect.focus ? { focus: (again.focus ?? effect.focus)! } : {}) };
    kept.changed = again.changed || !!kept.member || !!kept.focus;
    if (!kept.changed) return again.self ? 'self' : null;
    return { did: { ...did, what: effectWords(kept) }, effect: kept };
  };
  /** A key press whose effect could not be told from the page's own changes. */
  let unsure = false;
  /** Presses keys in turn on the focused control until one does something. */
  const tryKeys = async (keys: readonly string[], o: { id?: number; member?: boolean; stay?: boolean } = {}): Promise<Press | 'no-focus' | null> => {
    if (!o.stay) {
      if (!(await k<boolean>('focus', o.id !== undefined ? { id: o.id } : { i: c.i }))) return 'no-focus';
      await wait(L.focusMs);
    }
    for (const key of keys) {
      if (late(1500)) return null;
      await k('begin', { i: c.i, label: 'a' });
      const mark = ctx.guard.mark();
      // A key name the browser does not know is a key that does nothing.
      if (!(await page.keyboard!.press(key).then(() => true, () => false))) continue;
      const effect = await k<Effect | null>('effect', { i: c.i, a: 'a', b: 'b', ms: L.settleMs, ...(o.member ? { member: true } : {}) });
      const own = await settle(keyDid(effect, ctx.guard.since(mark)), effect, 'a', 'b');
      if (own === 'uncertain') { unsure = true; continue; }
      if (own && own !== 'self') return { did: own.did, how: 'keys', key, a: 'a', b: 'b', effect: own.effect };
    }
    return null;
  };
  /** Why the click was not made: covered by the page's own content, or (in a frame) a point the page does not show there. */
  let coveredWhy: string = COVERED;
  /**
   * A real click on the control (hover and focus are part of the baseline). `self`: what changed in the click's
   * window was written by the page's own timers, and nothing else was left (the lead's cut, batch 17).
   */
  const tryClick = async (first = false): Promise<Press | 'covered' | 'refused' | 'uncertain' | 'self' | null> => {
    const at = await k<Point | { refused: string } | null>('prepare', { i: c.i });
    if (!at) return 'covered';
    if (!('x' in at)) return 'refused';
    if (c.focusable) await k('focus', { i: c.i });
    else await k('blur');
    // The click's window starts as the pointer comes to rest on the control (the rest below included): a change in
    // it that a timer the page set before then wrote (the listener hook's timer notes, as the forms test reads them)
    // is the page's own, never credited to the click.
    const since = await k<number>('clock').catch(() => undefined);
    await page.mouse!.move(at.x, at.y, { steps: 2 });
    // Inside a frame, a point the page does not show there (covered, out of view, scaled) is not pressed at all.
    const missed = pointMissed(page.mouse);
    if (missed) { coveredWhy = missed; return 'covered'; }
    // The first click rests on the control longer first (Sol r1 S7): content that waits a moment before it shows on
    // hover (a tooltip) is then part of what the click is compared with, not an effect of it.
    await wait(L.hoverMs + (first ? L.hoverShowMs : 0));
    await k('begin', { i: c.i, label: 'p' });
    const mark = ctx.guard.mark();
    await page.mouse!.down();
    await page.mouse!.up();
    const effect = await k<Effect | null>('effect', { i: c.i, a: 'p', b: 'q', ms: L.settleMs, ...(typeof since === 'number' ? { since } : {}) });
    const did = clickDid(effect, ctx.guard.since(mark));
    // Nothing of the click's own is left once what the page's timers wrote is left out: not testable, never credited.
    if (!did && effect?.self) return 'self';
    const own = await settle(did, effect, 'p', 'q', typeof since === 'number' ? since : undefined);
    if (own === 'uncertain' || own === 'self') return own;
    if (!own) return null;
    // Compared again, the click may have left only focus that moved: not a function of its own.
    if (own.did.page && !clickDid(own.effect, [])) return own.effect?.self ? 'self' : null;
    return { did: own.did, how: 'pointer', key: 'click', a: 'p', b: 'q', effect: own.effect };
  };
  const isPress = (p: Press | 'no-focus' | 'covered' | 'refused' | 'uncertain' | 'self' | null): p is Press => !!p && typeof p === 'object';
  /**
   * Whether the changes a click was credited with are the click's, or what resting the pointer on the control shows by
   * itself (batch 17; three-way since Sol r1 S7). Content that waits a moment before it shows on hover (a tooltip) can
   * appear after the click's short hover baseline and be read as the click's. A change the click's own events made
   * (`direct`), a form value and an address are the click's. Otherwise the pointer leaves and the page must return to
   * how it was before the click (within `hoverRestoreMs`); then the pointer rests on the control again without
   * clicking: every change shows again, it is the hover's. Still there once the pointer has been away that long: the
   * click's. Anything that could not be done: unknown (not testable).
   */
  const hoverCheck = async (click: Press): Promise<'hover' | 'click' | 'unknown'> => {
    const e = click.effect;
    const sig = (x: Effect | null | undefined): string[] => (x ? [...(x.where ?? []), ...(x.own ? [`own ${x.own}`] : [])] : []);
    const changes = sig(e);
    if (!e || e.values || e.url || e.direct) return 'click';
    if (!changes.length || ((e.shown || e.hidden || e.textChange) && !e.where?.length)) return 'unknown';
    const before = await k<string>('digest', { label: click.a });
    await page.mouse!.move(-1, -1).catch(() => {});
    let restored = false;
    for (let waited = 0; waited <= L.hoverRestoreMs && !restored; waited += 250) {
      await wait(waited ? 250 : L.hoverAwayMs);
      await k('snap', { i: c.i, label: 'r' });
      restored = (await k<string>('digest', { label: 'r' })) === before;
    }
    // Still there 3.4 s after the pointer left: what a hover shows has gone by then (and what shows within the first
    // click's longer rest was already part of what it was compared with): the click's.
    if (!restored) return 'click';
    const at = await k<Point | { refused: string } | null>('prepare', { i: c.i });
    if (!at || !('x' in at)) return 'unknown';
    if (c.focusable) await k('focus', { i: c.i });
    else await k('blur');
    await k('begin', { i: c.i, label: 'h' });
    await page.mouse!.move(at.x, at.y, { steps: 2 });
    if (pointMissed(page.mouse)) return 'unknown';
    await wait(L.hoverMs + L.hoverShowMs);
    const hovered = await k<Effect | null>('effect', { i: c.i, a: 'h', b: 'h2', ms: L.settleMs });
    const again = new Set(sig(hovered));
    return changes.every((w) => again.has(w)) ? 'hover' : 'click';
  };
  const SELF = 'the page changes by itself, so what a press did could not be told apart';

  // 1. The keyboard.
  let press: Press | null = null;
  if (c.kind === 'composite' && c.composite) {
    const arrows = c.composite.horizontal ? ['ArrowRight', 'ArrowDown'] : ['ArrowDown', 'ArrowRight'];
    const moved = await tryKeys(arrows, { id: c.composite.current, member: true });
    if (isPress(moved) && (acted(moved.effect) || !moved.effect?.member)) press = moved;
    else if (isPress(moved)) {
      // The arrow keys move focus between the members: Enter or Space must then choose the one tested.
      const chose = await tryKeys(['Enter', 'Space']);
      if (isPress(chose)) press = chose;
    } else if (c.tabbable) {
      // No arrow keys, but Tab reaches it.
      const direct = await tryKeys(['Enter', 'Space']);
      if (isPress(direct)) press = direct;
    }
  } else if (c.focusable) {
    const pressed = await tryKeys(['Enter', 'Space']);
    if (isPress(pressed)) press = pressed;
  }

  // 2. The mouse, when no key did anything.
  let state: AfterState | null = null;
  if (press) result.operation = { kind: 'keys', key: press.key, did: press.did };
  else if (!late(2500)) {
    const clicked = await tryClick(true);
    if (clicked === 'covered') result.operation = { kind: 'unmeasured', reason: coveredWhy };
    else if (clicked === 'refused') result.operation = { kind: 'unmeasured', reason: 'clicking it would press a link, a form field or a submit button' };
    else if (clicked === 'uncertain') result.operation = { kind: 'unmeasured', reason: SELF };
    else if (clicked === 'self') result.operation = { kind: 'self' };
    else if (isPress(clicked)) {
      // What the click left is read first; then the keys once more, in the state the click made.
      state = await k<AfterState>('after', { i: c.i, a: clicked.a, b: clicked.b });
      press = clicked;
      let operation: Operation = { kind: 'pointer-only', did: clicked.did };
      if (c.kind !== 'composite' && c.focusable && !state.opened.some((o) => o.modal)) {
        const again = await tryKeys(['Enter', 'Space']);
        if (isPress(again)) operation = { kind: 'keys', key: again.key, did: again.did };
      }
      if (operation.kind === 'pointer-only' && c.kind !== 'composite') {
        // A link with the address the click went to; for a control that takes no focus, controls right next to it.
        const how = await k<string>('equivalent', { i: c.i, ...(clicked.did.url ? { url: clicked.did.url } : {}), card: !c.focusable });
        if (how) operation = { kind: 'equivalent', did: clicked.did, how };
      }
      // A key press whose effect could not be told from the page's own changes: no failure on the click alone.
      if (operation.kind === 'pointer-only' && unsure) operation = { kind: 'unsure', did: clicked.did, reason: `${SELF} (a key may have done the same)` };
      result.operation = operation;
    }
  }
  // 2b. A control that did nothing may act on a choice beside it (a filter's month, a sort order): another choice
  // is made, and the control pressed again with the keys. Only for the status its press then shows (4.1.3), and
  // only when the choice itself changed nothing and asked for nothing (a list that loads a page on change is left).
  if (!press && result.operation.kind === 'none' && c.focusable && c.kind !== 'composite' && !late(3000)) {
    await k('begin', { i: c.i, label: 'c' });
    const mark = ctx.guard.mark();
    const chose = await k<string | null>('choose', { i: c.i }).catch(() => null);
    if (chose) {
      const fx = await k<Effect | null>('effect', { i: c.i, a: 'c', b: 'd', ms: L.settleMs });
      // The choice's own new value is no change of the page; content it showed, hid or rewrote, or an address, is.
      const visible = !!fx && (fx.shown > 0 || fx.hidden > 0 || !!fx.textChange || !!fx.url);
      if (!ctx.guard.since(mark).some(isStop) && !visible) {
        const again = await tryKeys(['Enter', 'Space']);
        if (isPress(again)) {
          press = again;
          result.operation = { kind: 'keys', key: again.key, did: again.did };
          result.chose = chose;
        }
      }
    }
  }
  if (!press) return result;
  result.effect = press.effect;

  // 3. What the press left.
  state ??= await k<AfterState>('after', { i: c.i, a: press.a, b: press.b });
  result.looked = true;
  const byKeys = press.how === 'keys';
  const said = state.messages.filter((m) => m.status && !m.ofOpened);
  result.announced = said.filter((m) => m.live || m.focus).length;
  const quiet: Message[] = said.filter((m) => !m.live && !m.focus && !m.unsure);
  // In a live region inside a shadow root that the test did not see come: announced or not could not be told.
  result.statusUnsure = said.filter((m) => m.unsure && !m.focus);

  // 2.4.11: where the press left focus (measured before any other key is pressed).
  if (byKeys && !state.active.none && (state.focusMoved || state.opened.length > 0)) {
    result.focusJudged = true;
    const cover = await focusCover(ctx).catch(() => null);
    if (cover) {
      // Understanding 2.4.11, note 2: content the user opened may cover the focused component when the user can
      // bring it back into view without moving focus. So dismissal is tried first: Escape, then (with focus
      // still on the control that was pressed) the same press again. Only a cover that stays is a failure.
      const held = await page.evaluate(kitActiveId, undefined).catch(() => 0);
      const inView = async () => (await page.evaluate(kitActiveId, undefined).catch(() => -1)) === held && !(await focusCover(ctx).catch(() => 'unknown'));
      await page.keyboard!.press('Escape').catch(() => {});
      await wait(150);
      let revealed = held !== 0 && (await inView());
      let again = false;
      if (!revealed && held !== 0 && state.active.inControl && !late(2500) && (await page.evaluate(kitActiveId, undefined).catch(() => -1)) === held) {
        again = true;
        await page.keyboard!.press(press.key).catch(() => {});
        await wait(L.settleMs);
        revealed = await inView();
      }
      if (!revealed) {
        // What opened may have a control of its own that closes it without moving focus (a Close button that
        // keeps focus, a key it names). The test does not press it: with one there, the cover is not a failure
        // the test can show.
        let closer = false;
        for (const o of state.opened) {
          if (await k<Point | null>('closer', { k: o.k, pattern: CLOSE_NAME.source }).catch(() => null)) { closer = true; break; }
        }
        result.after.push(closer ? hiddenDoubt(c, state.active, cover, state.active.inControl) : hiddenFinding(c, state.active, cover, state.active.inControl, again));
      }
    }
  }

  // 2.4.3 (F85): a dialog, menu or layer with controls in it that focus was not moved into.
  for (const o of state.opened) {
    if (o.kind === 'panel' || !o.tabbables) continue;
    result.openedControls = true;
    if (!byKeys || o.hasFocus || late(3500)) continue;
    if ((await k<{ points: boolean }>('activeNow', { k: o.k })).points) continue;
    let reached = false;
    let went = '';
    for (let t = 0; t < L.tabs && !reached; t++) {
      await page.keyboard!.press('Tab');
      await wait(60);
      const inside = await k<boolean | null>('focusIn', { k: o.k });
      // Gone after a Tab (it closes when its control loses focus): another matter, not judged here.
      if (inside === null || inside) reached = true;
      else if (!went) {
        const now = await k<{ path: string; name: string }>('activeNow', {});
        went = now.name ? `“${now.name.length > 50 ? `${now.name.slice(0, 49)}…` : now.name}”` : now.path;
      }
    }
    if (!reached && o.kind === 'menu' && (await k<boolean>('focus', { i: c.i }))) {
      // A list of choices is entered with the arrow keys.
      await page.keyboard!.press('ArrowDown');
      await wait(80);
      reached = (await k<boolean | null>('focusIn', { k: o.k })) !== false || (await k<{ points: boolean }>('activeNow', { k: o.k })).points;
    }
    if (!reached) result.after.push(orderFinding(c, o, L.tabs, went));
    await k('focus', { i: c.i });
  }

  // 2.1.2: a focus loop in the dialog it opened, or in what focus moved into.
  const into = state.opened.find((o) => o.kind === 'dialog' && o.tabbables > 0) ?? state.opened.find((o) => o.hasFocus && o.tabbables > 0);
  let trapped = false;
  if (into && !late(5000)) {
    result.trapJudged = true;
    const t = await trapIn(ctx, c, into, late).catch(() => ({ findings: [] as ProbeFinding[], trapped: false }));
    result.after.push(...t.findings);
    trapped = t.trapped;
  }

  // 4. Put the page back: Escape, the same press again, a Close button, a native dialog's own close.
  let toggled = false;
  if (state.opened.length || state.focusMoved || quiet.some((m) => m.appeared)) {
    await page.keyboard!.press('Escape').catch(() => {});
    await wait(120);
    let still = await k<{ open: number; blocking: boolean }>('stillOpen');
    if (still.open && !trapped) {
      if (byKeys) {
        if (await k<boolean>('focus', { i: c.i })) { await page.keyboard!.press(press.key).catch(() => {}); await wait(L.settleMs); }
      } else {
        const at = await k<Point | { refused: string } | null>('prepare', { i: c.i });
        if (at && 'x' in at) { await page.mouse!.move(at.x, at.y); await page.mouse!.down(); await page.mouse!.up(); await wait(L.settleMs); }
      }
      toggled = true;
      still = await k<{ open: number; blocking: boolean }>('stillOpen');
    }
    if (still.blocking) {
      for (const o of state.opened) {
        const at = await k<Point | null>('closer', { k: o.k, pattern: CLOSE_NAME.source });
        if (at) { await page.mouse!.move(at.x, at.y); await page.mouse!.down(); await page.mouse!.up(); await wait(150); }
      }
      await k('closeNative');
      still = await k<{ open: number; blocking: boolean }>('stillOpen');
    }
    if (still.blocking) result.left = true;
  }
  // A message that came into view and went away again with Escape or the second press was a panel, not a status.
  for (const m of quiet) {
    const gone = m.appeared && !(await k<boolean>('messageShown', { id: m.id }).catch(() => true));
    if (unannounced(m, gone)) result.status.push(m);
  }
  void toggled;

  // 5. Before "pointer only" is a failure (Understanding 2.1.1: any key will do, and so will any other
  // way to the same function): the keys the control names for itself, then the other controls with the
  // same name or target. Whatever cannot be tried or compared leaves the control not testable.
  if (result.operation.kind === 'pointer-only') {
    const did = result.operation.did;
    const ref: Press = press;
    const quoted = (a: { name: string; path: string }) => (a.name ? `“${a.name.length > 60 ? `${a.name.slice(0, 59)}…` : a.name}” (${a.path.slice(0, 100)})` : a.path.slice(0, 120));
    const TIME = 'the time for this test ran out';
    const LEFT = 'the click left something open that could not be closed';
    const otherWays = async (): Promise<Operation> => {
      type Verdict = 'same' | 'different' | 'nothing' | 'doubt';
      const digest = (label: string) => k<string>('digest', { label });
      const layered = state!.opened.some((o) => o.kind === 'dialog' || o.kind === 'overlay' || o.modal);
      const judge = (p: Press, click: Press): Verdict => {
        const same = sameEffect(click, p);
        return same === 'unknown' ? 'doubt' : same;
      };
      /** Another control pressed with Enter, then Space, and what it did set against a click's effect. */
      const pressOther = async (a: Alternative, click: Press): Promise<Verdict> => {
        unsure = false;
        const p = await tryKeys(['Enter', 'Space'], { id: a.id });
        if (isPress(p)) return judge(p, click);
        return unsure || p === 'no-focus' || late(1500) ? 'doubt' : 'nothing';
      };
      /** A key the control names, pressed with focus on it (or, when it takes none, on nothing: such keys are the page's). */
      const pressKey = async (key: string, click: Press): Promise<Verdict> => {
        unsure = false;
        let p: Press | 'no-focus' | null = c.focusable ? await tryKeys([key]) : 'no-focus';
        if (p === 'no-focus') { await k('blur'); p = await tryKeys([key], { stay: true }); }
        if (isPress(p)) return judge(p, click);
        return unsure || late(1500) ? 'doubt' : 'nothing';
      };
      /**
       * One keyboard way against the click. The click is made first (what it does now is the reference)
       * and then taken back (Escape for a dialog or a layer, else the same click again), so that the
       * keyboard way is tried in the state the click started from. A click that toggles has two states,
       * and the other way may work from one of them only (a "Show" button beside a toggle): it is tried
       * from both before it is said not to do the same. A click that cannot be repeated leaves nothing to
       * compare: a doubt. One that can be repeated but not taken back still shows a way that does nothing.
       */
      const compare = async (other: (click: Press) => Promise<Verdict>): Promise<Verdict> => {
        const there = await tryClick();
        if (!isPress(there)) return 'doubt';
        const before = await digest(there.a);
        let back: Press | null = null;
        let restored = false;
        if (layered) {
          await k('begin', { i: c.i, label: 'u' });
          await page.keyboard!.press('Escape').catch(() => {});
          await k<Effect | null>('effect', { i: c.i, a: 'u', b: 'v', ms: 120 });
          restored = (await digest('v')) === before;
        }
        if (!restored) {
          const again = await tryClick();
          if (isPress(again) && (await digest(again.b)) === before) { restored = true; back = again; }
        }
        const first = await other(there);
        if (first === 'same' || first === 'doubt') return first;
        // Not taken back: the other way was tried in the state the click left. Where the click can be made
        // again from there (the next slide, one more row), a way that did nothing there does not do what the
        // click does; anything else cannot be compared across two different states.
        if (!restored) return first === 'nothing' && !late(2500) && isPress(await tryClick()) ? 'nothing' : 'doubt';
        if (!back || late(4000)) return back ? 'doubt' : first;
        // From the click's other state, against what the click does from there.
        if (!isPress(await tryClick())) return 'doubt';
        const second = await other(back);
        if (second !== 'same' && !late(2500)) await tryClick();
        if (second === 'same' || second === 'doubt') return second;
        return first === 'different' || second === 'different' ? 'different' : 'nothing';
      };

      // (a) Its own keys. Every key it names has to be tried before "no key works" can be said.
      const plan = shortcutPlan(await k<ShortcutSource>('shortcuts', { i: c.i }));
      const named = plan.press;
      for (const key of named) {
        if (result.left || late(4500)) return { kind: 'unsure', did, reason: `its own key, ${key}, could not be tried (${result.left ? LEFT : TIME})` };
        const verdict = await compare((click) => pressKey(key, click));
        if (verdict === 'same') return { kind: 'keys', key, did };
        // A key that does something else may belong to another function: a doubt, never a pass.
        if (verdict === 'different') return { kind: 'unsure', did, reason: `${key}, a key named for it, does something else, so whether that key is this control's could not be told` };
        if (verdict === 'doubt') return { kind: 'unsure', did, reason: `what its own key, ${key}, does could not be compared with the click (the click could not be repeated or undone, or the page changes by itself)` };
      }
      if (plan.never.length) return { kind: 'unsure', did, reason: `it names ${plan.never.join(' and ')} as its key${plan.never.length === 1 ? '' : 's'}, which the test does not press` };
      if (plan.more) return { kind: 'unsure', did, reason: `it names more keys than the test tries (${L.shortcuts})` };

      // (b) Other controls Tab can reach with the same name, or that point at the same content.
      const alts = await k<Alternative[]>('alternatives', { i: c.i, ids: ref.effect?.ids ?? [], max: L.alternatives });
      if (!alts.length) return { kind: 'pointer-only', did, keys: named };
      const why = (a: Alternative) => (a.why === 'name' ? 'has the same name' : 'points at the same content');
      const others: string[] = [];
      let doubt = '';
      for (const a of alts.filter((x) => x.refused)) {
        doubt ||= a.refused === 'link'
          ? `a link, ${quoted(a)}, ${why(a)} and goes to another place, which the test does not follow, so the two could not be compared`
          : `${quoted(a)} ${why(a)}, but the test never presses it (a form field, a submit button, or a control named for an action on the site), so the two could not be compared`;
      }
      const pressable = alts.filter((x) => !x.refused);
      for (const a of pressable.slice(0, L.alternativesPressed)) {
        if (result.left || late(4500)) { doubt ||= `${quoted(a)} ${why(a)}, but it could not be pressed (${result.left ? LEFT : TIME}), so the two could not be compared`; break; }
        const verdict = await compare((click) => pressOther(a, click));
        if (verdict === 'same') return { kind: 'equivalent', did, how: `${quoted(a)} does the same with the keyboard` };
        if (verdict === 'doubt') doubt ||= `what ${quoted(a)}, which ${why(a)}, does with the keyboard could not be compared with the click`;
        else others.push(`${quoted(a)} ${why(a)} but does ${verdict === 'different' ? 'something else' : 'nothing'} with the keyboard`);
      }
      // One that was found and not tried may be the one that does the same: no failure without it.
      const untried = pressable.length - Math.min(pressable.length, L.alternativesPressed);
      if (untried > 0) doubt ||= `${untried} more control${untried === 1 ? '' : 's'} with the same name or target ${untried === 1 ? 'was' : 'were'} not tried (the test tries ${L.alternativesPressed})`;
      if (doubt) return { kind: 'unsure', did, reason: doubt };
      return { kind: 'pointer-only', did, keys: named, others };
    };
    result.operation = await otherWays().catch((): Operation => ({ kind: 'unsure', did, reason: 'the other keyboard ways to it could not be tried' }));
    // 6. Last, before the failure stands: the change was the click's, not what resting the pointer there shows.
    // Sol r1 S7: a check that could not be made (no time left, an error, the page not back as it was) leaves the
    // failure unproven: not testable.
    if (result.operation.kind === 'pointer-only') {
      const owner = late(2500 + L.hoverRestoreMs) ? 'unknown' : await hoverCheck(ref).catch(() => 'unknown' as const);
      if (owner === 'hover') result.operation = { kind: 'unsure', did, reason: 'the same change shows on hover alone', hover: true };
      else if (owner === 'unknown') result.operation = { kind: 'unsure', did, reason: 'whether that change is the click\'s or what resting the pointer on it shows by itself (a tooltip that waits before it shows) could not be told: the check could not be made' };
    }
  }
  await k('blur').catch(() => {});
  await page.mouse!.move(-1, -1).catch(() => {});
  return result;
}

/**
 * Types into a search or filter field ("a", then two letters that match little, then Enter) and looks at
 * the short texts each step shows: a result count or "no results" that is in no live region is a status
 * message screen readers are not told about (WCAG's own first example for 4.1.3). Nothing is sent: a
 * search that loads another page is held by the guard, and then there is nothing to judge.
 */
async function typeInField(ctx: ProbeContext, f: FieldCandidate, late: (need?: number) => boolean): Promise<FieldResult> {
  const { page } = ctx;
  const k = <R>(op: string, a: unknown = {}) => controlsKit<R>(ctx, op, a);
  const out: FieldResult = { field: { name: f.name, path: f.path }, status: [], announced: 0 };
  await k('prepare', { i: f.i });
  await k('begin', { i: f.i, label: 'idle' });
  await page.waitForTimeout(L.idleMs);
  await k('begin', { i: f.i, label: 'idle', idle: true });
  if (!(await k<boolean>('focus', { i: f.i }))) return out;
  await page.waitForTimeout(L.focusMs);
  let typed = 0;
  for (const step of ['a', 'qz', 'Enter']) {
    if (late(2000)) break;
    await k('begin', { i: f.i, label: 'a' });
    const mark = ctx.guard.mark();
    if (step === 'Enter') await page.keyboard!.press('Enter');
    else { await page.keyboard!.type(step); typed += step.length; }
    let effect = await k<Effect | null>('effect', { i: f.i, a: 'a', b: 'b', ms: L.settleMs });
    // A page load the guard held, or a request it stopped: the results are on the live site, not here.
    if (ctx.guard.since(mark).some(isStop)) break;
    if (!effect?.changed) continue;
    if (!effect.direct) {
      if (changeOwner(effect) === 'unknown') continue;
      await k('quiet', { ms: L.quietMs, maxMs: L.quietMaxMs });
      effect = await k<Effect | null>('rediff', { i: f.i, a: 'a', b: 'b' });
      if (!effect?.changed) continue;
    }
    const state = await k<AfterState>('after', { i: f.i, a: 'a', b: 'b' });
    const said = state.messages.filter((m) => m.status && !m.ofOpened);
    out.announced += said.filter((m) => m.live || m.focus).length;
    out.status.push(...said.filter((m) => !m.live && !m.focus && !m.unsure && !out.status.some((x) => x.path === m.path)));
    (out.unsure ??= []).push(...said.filter((m) => m.unsure && !m.focus && !out.unsure!.some((x) => x.path === m.path)));
    if (out.status.length) break;
  }
  // Put the field back as it was.
  if (typed && (await k<boolean>('focus', { i: f.i }).catch(() => false))) for (let n = 0; n < typed; n++) await page.keyboard!.press('Backspace').catch(() => {});
  await k('blur').catch(() => {});
  return out;
}

/** What pressing one document's controls gave. */
interface DocumentRun {
  /** It had controls or search fields to press (what the test hands the AI review then says so). */
  listed: boolean;
  results: ControlResult[];
  typed: FieldResult[];
  info: { more: number; refused: number; skipped: number; skippedWhy?: string; max?: number; per?: string };
}

/**
 * Presses one document's controls (the page's, or one of its own frames' through `frameProbeContext`): at most
 * `max` controls and `fields` search fields. Throws `ProbeNotTestable` when its listeners or the test's helpers
 * cannot be read there.
 */
async function pressDocument(ctx: ProbeContext, late: (need?: number) => boolean, max: number, fields: number): Promise<DocumentRun> {
  const { page } = ctx;
  const listeners = await ctx.listeners();
  const wanted = new Set<string>([...POINTER_TYPES, ...KEY_TYPES]);
  const byRef = new Map<number, string[]>();
  const delegated = new Set<string>();
  for (const l of listeners) {
    if (!wanted.has(l.type)) continue;
    if (l.target.kind !== 'element') { delegated.add(l.type); continue; }
    byRef.set(l.ref, [...(byRef.get(l.ref) ?? []), l.type]);
  }
  const installed = await page.evaluate(installControlsKit, { key: CONTROLS_KEY, action: ACTION_NAME, status: STATUS_TEXT, disclosure: DISCLOSURE_NAME, live: LIVE_REGION_SELECTOR }).catch(() => false);
  if (!installed) throw new ProbeNotTestable('the test could not run its helpers in this page');
  // No press may save a file (the listeners were read above, so the stop's own listener is not among them).
  if (!(await page.evaluate(stopDownloads, DOWNLOAD_STOP_KEY).catch(() => false))) throw new ProbeNotTestable('the test could not make sure that no press saves a file on this page');
  let kbStarted = false;
  try {
    const found = await controlsKit<CandidateList>(ctx, 'candidates', { refs: [...byRef].map(([ref, types]) => ({ ref, types })), delegated: [...delegated], max });
    const searchFields = fields ? await controlsKit<FieldCandidate[]>(ctx, 'searchFields', { max: fields }) : [];
    if (!found.list.length && !searchFields.length) return { listed: false, results: [], typed: [], info: { more: 0, refused: found.refused, skipped: 0 } };
    // The keyboard test's kit: element ids, the focused element's cover, the trap's ways out.
    await startKit(ctx);
    kbStarted = true;
    const results: ControlResult[] = [];
    let skipped = 0;
    let skippedWhy: string | undefined;
    for (const [n, c] of found.list.entries()) {
      if (late()) { skipped = found.list.length - n; skippedWhy = 'the time for this test ran out'; break; }
      const r = await pressControl(ctx, c, late);
      results.push(r);
      if (r.left) { skipped = found.list.length - n - 1; skippedWhy = 'an earlier press opened something that could not be closed again'; break; }
    }
    // A control that answers the pointer only, where another control pressed here did the same with a key:
    // the function can be reached with the keyboard (Understanding 2.1.1), whatever the two are called.
    for (const r of results) {
      if (r.operation.kind !== 'pointer-only') continue;
      const mine = { did: r.operation.did, effect: r.effect ?? null };
      // Only for a click that changed something with a place on the page, or went to an address: a control's
      // own state (pressed, expanded) is its own, and two controls that each change theirs did not do the same.
      if (!mine.effect?.where?.length && !mine.did.url && !mine.effect?.url) continue;
      const twin = results.find((x) => x !== r && x.operation.kind === 'keys' && sameEffect(mine, { did: x.operation.did, effect: x.effect ?? null }) === 'same');
      if (twin) r.operation = { kind: 'equivalent', did: mine.did, how: `${twin.candidate.name ? `“${twin.candidate.name.slice(0, 60)}”` : twin.candidate.path.slice(0, 100)} does the same with the keyboard` };
    }
    // Search and filter fields last (typing can replace a list the controls above sit in).
    const typed: FieldResult[] = [];
    if (!results.some((r) => r.left)) for (const f of searchFields) if (!late(4000)) typed.push(await typeInField(ctx, f, late));
    return { listed: true, results, typed, info: { more: found.more, refused: found.refused, skipped, ...(skippedWhy ? { skippedWhy } : {}), max } };
  } finally {
    if (kbStarted) await page.evaluate(kitStop, undefined).catch(() => {});
    await controlsKit(ctx, 'drop').catch(() => {});
    await page.evaluate(undoDownloadStop, DOWNLOAD_STOP_KEY).catch(() => {});
    await page.mouse?.move(-1, -1).catch(() => {});
  }
}

/** Criteria the test also judges inside the page's own frames: a control there and what it opens. */
export const FRAME_CRITERIA: ReadonlySet<string> = new Set(['2.1.1', '2.1.2']);

/** Runs in a document (self-contained): focuses its first element Tab reaches; how many Tab reaches (at most 50). */
export function focusFirstStop(arg: { focus: boolean }): number {
  const SEL = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable]:not([contenteditable="false"])';
  const all = document.querySelectorAll(SEL);
  let n = 0;
  for (let i = 0; i < all.length && i < 3000 && n < 50; i++) {
    const e = all[i] as HTMLElement;
    if ((e as HTMLButtonElement).disabled || e.tabIndex < 0 || e.closest('[inert], [hidden]')) continue;
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !e.getClientRects().length) continue;
    if (n === 0 && arg.focus) { e.focus({ preventScroll: true }); if (document.activeElement !== e) return 0; }
    n++;
  }
  return n;
}

/**
 * A focus loop in a frame's own content, with nothing pressed (keyboard-op lane, 2026-11-11): the keyboard walk stops
 * where focus goes into a frame and stays there, so from the frame's first stop Tab is pressed (up to 12 times)
 * while focus stays in the frame; a cycle found is judged with the keyboard test's trap rules (`judgeLoop`), the
 * page's own stops outside the frame counting as out of reach. Focus that leaves the frame: no loop.
 */
async function frameLoop(ctx: ProbeContext, late: (need?: number) => boolean, pageStops: number): Promise<ProbeFinding[]> {
  const { page } = ctx;
  await startKit(ctx);
  try {
    if (!(await page.evaluate(focusFirstStop, { focus: true }).catch(() => 0))) return [];
    const inFrame = async () => (await page.evaluate(kitActiveId, undefined).catch(() => 0)) !== 0;
    const members = await tabLoop(ctx, inFrame, late);
    if (!members) return [];
    const set = new Set(members);
    const onLoop = async () => set.has(await page.evaluate(kitActiveId, undefined).catch(() => 0));
    return (await judgeLoop(ctx, members, onLoop, late, '', pageStops)).findings;
  } finally {
    await page.evaluate(kitStop, undefined).catch(() => {});
  }
}

/** Frames looked inside per page, controls pressed in each, the time a frame needs, the wait for frames to load. */
const FRAMES = { max: 2, candidates: 4, needMs: 8000, settleMs: 3000 } as const;

/**
 * The same presses inside the page's own embedded frames (same origin, shown and big enough: `ownFrames`), after the
 * page's own: a control inside a frame is part of the page (a map, a calendar, a booking tool), and a keyboard user
 * has to be able to use it there. Only 2.1.1 and 2.1.2 are kept from a frame. A pointer-only control in a frame is
 * failed only when nothing outside the frame has its name or points at the frame (else not testable: the presses
 * are not compared across documents). A control whose keys did nothing and that could not be clicked where the page
 * shows the frame (covered, out of view, a scaled frame) is not testable (fix round 1, F4, F6). A frame that should be
 * looked into and was not is not testable for 2.1.1 and 2.1.2; one that cannot hold a control is nothing to look into
 * (`settleFrames`). Every call into a frame is bounded (`frameProbeContext`).
 */
async function framesFindings(ctx: ProbeContext, late: (need?: number) => boolean): Promise<ProbeFinding[]> {
  // No child frame: no browser round trip.
  try { if ((ctx.page.frames?.() ?? []).length <= 1) return []; } catch { return []; }
  // The strict guard never lets a frame load now, so a frame that loads only when scrolled to is not scrolled to.
  const unloaded = await settleFrames(ctx.page, FRAMES.settleMs, { guard: ctx.guard, deadline: ctx.deadline - FRAMES.needMs, scroll: false });
  const own = await ownFrames(ctx.page, { callMs: FRAME_CALL_MS, deadline: ctx.deadline }).catch(() => ({ frames: [], gaps: [] }));
  const out: ProbeFinding[] = [];
  const gaps = [...own.gaps, ...unloaded];
  /** Frames whose own focus loop was not looked for (2.1.2 only). */
  const loopGaps: { path: string; why: string }[] = [];
  let n = 0;
  for (const f of own.frames) {
    if (n >= FRAMES.max) { gaps.push({ path: f.path, why: `the test presses controls in ${FRAMES.max} frames a page` }); continue; }
    if (late(FRAMES.needMs)) { gaps.push({ path: f.path, why: 'the time for this test ran out first' }); continue; }
    n++;
    let run: DocumentRun;
    const fctx = frameProbeContext(ctx, f);
    try {
      run = await pressDocument(fctx, late, FRAMES.candidates, 0);
    } catch {
      gaps.push({ path: f.path, why: 'its controls could not be pressed' });
      continue;
    }
    const words = frameWords({ name: f.name });
    // A focus loop in what the frame shows by itself (nothing pressed), unless a press there already found one. When a
    // press there left something open that could not be closed, the loop was not looked for: 2.1.2 not testable there
    // (the controls not pressed are named in the notes, as on the page).
    const trapFound = run.results.some((r) => r.after.some((x) => x.criterion === '2.1.2' && x.status === 'failed'));
    if (!trapFound && run.results.some((r) => r.left)) loopGaps.push({ path: f.path, why: 'a press there left something open that could not be closed, so a focus loop in it was not looked for' });
    else if (!trapFound && !late(FRAMES.needMs)) {
      const pageStops = await bounded(callMs(ctx.deadline), ctx.page.evaluate(focusFirstStop, { focus: false })).catch(() => 0);
      for (const x of await frameLoop(fctx, late, pageStops).catch(() => [])) out.push({ ...x, ...(x.target ? { target: `${f.path} >>> ${x.target}` } : {}), detail: `${words}${x.detail}` });
    }
    // A control whose keys did nothing and that was not clicked where the page shows the frame: whether it works
    // with the mouse only was not shown, so it is not testable (never "nothing to press").
    for (const r of run.results) {
      if (r.operation.kind !== 'unmeasured' || !isFrameMiss(r.operation.reason)) continue;
      const name = r.candidate.name ? `“${r.candidate.name.length > 60 ? `${r.candidate.name.slice(0, 59)}…` : r.candidate.name}”` : r.candidate.path;
      out.push({ criterion: '2.1.1', status: 'not_testable', target: `${f.path} >>> ${r.candidate.path}`, detail: `${words}${name}: Enter and Space did nothing on it, and ${r.operation.reason}, so whether only the mouse can use it could not be told.` });
    }
    if (!run.results.length) continue;
    const pointerOnly = run.results.filter((r) => r.operation.kind === 'pointer-only');
    // The names a control outside may have to stand in for one: the control's own, and for a widget (tabs, a list
    // box) every member's.
    const groups: string[][] = [];
    for (const r of pointerOnly) {
      const members = r.candidate.composite ? await bounded(callMs(ctx.deadline), f.frame.evaluate(widgetMemberNames, { path: r.candidate.composite.path })).catch(() => [] as string[]) : [];
      groups.push([r.candidate.name ?? '', ...members]);
    }
    let outside: { named: boolean[]; pointing: boolean } | null = { named: [], pointing: false };
    if (pointerOnly.length) {
      const handle = await bounded(callMs(ctx.deadline), f.frame.frameElement()).catch(() => null);
      outside = handle ? await bounded(callMs(ctx.deadline), ctx.page.evaluate(controlsOutsideFrame, { el: handle, names: groups.flat() })).catch(() => null) : null;
    }
    let at = 0;
    for (const [i, r] of pointerOnly.entries()) {
      const named = !!outside && outside.named.slice(at, at + groups[i]!.length).some(Boolean);
      at += groups[i]!.length;
      const why = !outside ? 'the controls outside the frame could not be read'
        : outside.pointing ? 'a control outside the frame points at it'
          : named ? `a control outside the frame has the same name as ${r.candidate.composite ? 'one of its widget\'s members' : 'it'}`
            : '';
      if (why) r.operation = { kind: 'unsure', did: (r.operation as { did: Did }).did, reason: `${why}, and the test does not compare presses across documents` };
    }
    for (const x of controlsFindings(run.results, { ...run.info, per: 'frame' })) {
      if (!FRAME_CRITERIA.has(x.criterion) || x.status === 'not_applicable') continue;
      out.push({ ...x, ...(x.target ? { target: `${f.path} >>> ${x.target}` } : {}), detail: `${words}${x.detail}` });
    }
  }
  return [...out, ...frameGaps(gaps), ...frameGapFindings('2.1.2', loopGaps, 'for a focus loop')];
}

/** The not testable findings for frames that should have been looked into and were not (2.1.1 and 2.1.2). */
const frameGaps = (gaps: readonly { path: string; why: string }[]): ProbeFinding[] =>
  [...frameGapFindings('2.1.1', gaps, 'for controls the keyboard cannot use'), ...frameGapFindings('2.1.2', gaps, 'for a focus loop')];

/**
 * The page's own frames when they were not looked into at all (a press on the page left something open, or the frame
 * pass failed; fix round 1, F4): each that should have been is a gap, never a silent skip. Never throws.
 */
async function framesNotLookedInto(ctx: ProbeContext, why: string): Promise<ProbeFinding[]> {
  try { if ((ctx.page.frames?.() ?? []).length <= 1) return []; } catch { return []; }
  const own = await ownFrames(ctx.page, { callMs: FRAME_CALL_MS, deadline: ctx.deadline }).catch(() => ({ frames: [], gaps: [] }));
  return frameGaps([...own.frames.map((f) => ({ path: f.path, why })), ...own.gaps]);
}

/** Runs the test on the loaded page. */
export async function runControls(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page } = ctx;
  if (!page.keyboard || !page.mouse) throw new ProbeNotTestable('the browser cannot send key presses or move the pointer, which this test needs');
  const started = Date.now();
  const late = (need: number = L.reserveMs) => ctx.signal.aborted || Date.now() > Math.min(started + L.budgetMs, ctx.deadline - need);
  const main = await pressDocument(ctx, late, L.candidates, L.fields);
  if (main.listed) ctx.setData?.({
    v: 1,
    pressed: main.results.map((r) => ({
      path: r.candidate.path.slice(0, 200), name: r.candidate.name, kind: r.candidate.kind, result: r.operation.kind,
      ...('did' in r.operation ? { did: r.operation.did.what.slice(0, 160) } : {}),
      ...(r.operation.kind === 'keys' ? { key: r.operation.key } : {}),
      ...(r.operation.kind === 'equivalent' ? { how: r.operation.how.slice(0, 200) } : {}),
    })),
  });
  const findings = controlsFindings(main.results, main.info, main.typed);
  // Frames after the page's own controls; not when a press there opened something that could not be closed (then
  // the frames are gaps, as when the frame pass fails: never a silent skip).
  const inFrames = main.results.some((r) => r.left)
    ? await framesNotLookedInto(ctx, 'a press on the page left something open that could not be closed')
    : await framesFindings(ctx, late).catch(() => framesNotLookedInto(ctx, 'the test failed while it looked into them'));
  // A criterion a frame had something to say about is no longer "nothing to press here".
  const said = new Set(inFrames.map((f) => f.criterion));
  return [...findings.filter((f) => !(said.has(f.criterion) && f.status === 'not_applicable')), ...inFrames];
}

/**
 * Presses the page's own controls with the keyboard and the mouse and judges what happens (see the top of
 * this file). Deep; listed, not scored, until the gold standard verifies it (docs/scoring.md).
 */
export const controlsProbe: PageProbe = {
  id: CONTROLS_PROBE_ID,
  criteria: [...CONTROLS_CRITERIA],
  kind: 'interaction',
  // A page that mounts its content late has no controls yet when it loads: wait for them (bounded).
  waitFor: { content: true },
  // About 1 s per control pressed, up to 8 per page, on a page of its own: over the core budget.
  tier: 'deep',
  scored: false,
  timeoutMs: 45_000,
  // Presses change the page (open panels, fill status lines): no other test before or after it on this page.
  isolate: true,
  // Strict guard: nothing a press asks for is sent (every request blocked, every navigation held).
  sendsNothing: true,
  run: runControls,
};
