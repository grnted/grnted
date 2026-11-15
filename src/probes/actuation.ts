// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.5.4 Motion Actuation (Plan 4 Task 4.4): what the page does when the device is shaken or
// tilted must also be possible with a control, and the response to motion must be possible to turn
// off. Core probe. Engine core: no Node-only imports.
//
// Pages without devicemotion/deviceorientation listeners (the listener hook) are not applicable.
// Otherwise the probe fires synthetic events at the window (a shake: alternating acceleration of
// 20 m/s² every 50 ms; a tilt: beta and gamma swinging ±60°) with script navigations trapped and
// records what changed. Changes to inline styles only (parallax and similar effects) are a visual
// effect, not an action. An action (content, structure or state changed, a navigation, a dialog or a
// request) then needs:
// - a control that does the same: controls near the changed content are clicked and must change it
//   too (or navigate, or show a dialog, as the motion did);
// - a way to turn the motion response off: a control named motion, shake, tilt or similar, clicked,
//   after which the same motion must do nothing. A toggle (check box, switch, aria-pressed button)
//   may say more ("Shake to undo"): it counts only when clicking it changes its state, the motion
//   then does nothing, and clicking it back restores both its state and the motion response.
// Missing either → failed.
import { GESTURE_VOCAB, MOTION_OFF_VOCAB, MOTION_TOGGLE_WORDS, type Kit, type KitElement } from './kit.js';
import { MOTION_CONTEXT, clickControl, controlsFor, guardStop, hasTime, kitReady, kitStop, refusedText, settledStop, type Candidates } from './motionShared.js';
import { LATE_CONTENT_MS, mountingNow, trackMount, type MountTracker } from './mounting.js';
import type { GuardEvent, PageProbe, ProbeContext, ProbeFinding } from './types.js';

export type Gesture = 'shake' | 'tilt';

type ActionChange = { id: number; field: string };
type ActionTracking = { start(): void; take(records: MutationRecord[], control?: number): ActionChange[] };

/** Runs in the page: retain actual mutation targets and field changes, before any region expansion. */
function installActionTracking(): void {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  let values = new Map<Element, { value: string; checked?: boolean }>();
  const snapshot = () => new Map([...document.querySelectorAll('input, textarea, select')].map((el) => [el, {
    value: (el as HTMLInputElement).value,
    ...(el instanceof HTMLInputElement ? { checked: el.checked } : {}),
  }]));
  (window as unknown as { __grntedActionTracking: ActionTracking }).__grntedActionTracking = {
    start() { values = snapshot(); },
    take(records, control) {
      const changes = new Map<string, ActionChange>();
      const add = (el: Element, field: string) => {
        const id = kit.keep(el);
        if (id === control && field !== 'content') return;
        changes.set(`${id}:${field}`, { id, field });
      };
      for (const r of records) {
        const el = r.target instanceof Element ? r.target : r.target.parentElement;
        if (!el || (r.type === 'attributes' && r.attributeName === 'style')) continue;
        add(el, r.type === 'attributes' ? `attribute:${r.attributeName}` : 'content');
      }
      for (const [el, before] of values) {
        if (!el.isConnected || !kit.visible(el, true)) continue;
        if ((el as HTMLInputElement).value !== before.value) add(el, 'value');
        if (el instanceof HTMLInputElement && el.checked !== before.checked) add(el, 'checked');
      }
      return [...changes.values()];
    },
  };
}

/** What one gesture did. */
interface Effect {
  changes: ActionChange[];
  /** Changes beyond inline styles: text, structure, attributes other than style. */
  functional: boolean;
  /** Only inline styles changed. */
  visualOnly: boolean;
  /** The changed content (lowest common ancestor), when there is some. */
  region: KitElement | null;
  navs: string[];
  calls: string[];
}

/**
 * Runs in the page: fires a shake or tilt at the window, 12 events 50 ms apart, with navigations
 * trapped and mutations recorded; returns what changed.
 */
async function gesture(arg: { kind: Gesture; minArea: number }): Promise<Effect> {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const tracking = (window as unknown as { __grntedActionTracking: ActionTracking }).__grntedActionTracking;
  tracking.start();
  kit.trap(true);
  kit.observe();
  kit.take();
  const navStart = kit.navs.length;
  const callStart = kit.calls().length;
  const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
  try {
    for (let i = 0; i < 12; i++) {
      let ev: Event;
      if (arg.kind === 'shake') {
        const a = i % 2 ? -20 : 20;
        const init = { acceleration: { x: a, y: a / 2, z: 0 }, accelerationIncludingGravity: { x: a, y: a / 2, z: 9.8 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 50 };
        ev = typeof DeviceMotionEvent === 'function' ? new DeviceMotionEvent('devicemotion', init) : Object.assign(new Event('devicemotion'), init);
      } else {
        const swing = [0, 30, 60, 30, 0, -30, -60, -30, 0, 30, 60, 0][i]!;
        const init = { alpha: 0, beta: swing, gamma: swing, absolute: false };
        ev = typeof DeviceOrientationEvent === 'function' ? new DeviceOrientationEvent('deviceorientation', init) : Object.assign(new Event('deviceorientation'), init);
      }
      window.dispatchEvent(ev);
      await sleep(50);
    }
    await sleep(250);
  } finally {
    kit.trap(false);
  }
  const records = kit.take().flatMap((b) => b.records);
  const styleOnly = (r: MutationRecord) => r.type === 'attributes' && r.attributeName === 'style';
  const functionalRecords = records.filter((r) => !styleOnly(r));
  const changes = tracking.take(functionalRecords);
  const changed = [...new Set([...kit.changed(functionalRecords), ...changes.map((c) => kit.get(c.id)).filter((e): e is Element => !!e)])].filter((e) => kit.visible(e, true));
  let region: Element | null = kit.lca(changed);
  if (!region && changed.length) region = changed[0]!;
  for (let i = 0; region && i < 4 && kit.area(region) < arg.minArea; i++) region = region.parentElement;
  if (region === document.body || region === document.documentElement) region = null;
  const navs = kit.navs.slice(navStart).filter((n) => !n.sameDocument).map((n) => n.url.slice(0, 200));
  const calls = kit.calls().slice(callStart).map((c) => c.api);
  return {
    changes,
    functional: changed.length > 0 || navs.length > 0 || calls.length > 0,
    visualOnly: records.length > 0 && !functionalRecords.length,
    region: region ? kit.describe(region) : null,
    navs, calls,
  };
}

/** Runs in the page: starts recording what a click changes (navigations trapped). */
function watchClick(): { navStart: number; callStart: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  kit.trap(true);
  kit.observe();
  kit.take();
  (window as unknown as { __grntedActionTracking: ActionTracking }).__grntedActionTracking.start();
  return { navStart: kit.navs.length, callStart: kit.calls().length };
}

/** Runs in the page: whether the click changed the region (or navigated, or made a call), then trapping off. */
function clickEffect(arg: { navStart: number; callStart: number; changes: ActionChange[]; control: number }): { region: boolean; uncertain: boolean; navs: number; calls: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  kit.trap(false);
  const records = kit.take().flatMap((b) => b.records).filter((r) => !(r.type === 'attributes' && r.attributeName === 'style'));
  const changed = (window as unknown as { __grntedActionTracking: ActionTracking }).__grntedActionTracking.take(records, arg.control);
  return {
    region: arg.changes.length > 0 && arg.changes.every((c) => changed.some((x) => x.id === c.id && x.field === c.field)),
    // Replacing the motion's node loses its identity: a real effect, but its equivalence is unknown.
    // No-op clicks, control state, and changes to known different nodes carry no such uncertainty.
    uncertain: changed.length > 0 && arg.changes.some((c) => {
      const el = kit.get(c.id);
      return !!el && !el.isConnected && records.some((r) => r.type === 'childList' && [...r.removedNodes].some((n) => n === el || n.contains(el)));
    }),
    navs: kit.navs.slice(arg.navStart).filter((n) => !n.sameDocument).length,
    calls: kit.calls().slice(arg.callStart).length,
  };
}

/** Plain description of what a gesture did. */
function effectText(kind: Gesture, e: Effect, dialogs: GuardEvent[], blocked: GuardEvent[]): string {
  const verb = kind === 'shake' ? 'shaking the device' : 'tilting the device';
  const parts: string[] = [];
  if (e.navs.length) parts.push(`sends the user to ${e.navs[0]}`);
  if (dialogs.length) parts.push(`shows a ${dialogs[0]!.dialog ?? 'dialog'}`);
  if (e.calls.includes('submit') || e.calls.includes('requestSubmit')) parts.push('submits a form');
  if (blocked.length) parts.push(`sends a request to ${blocked[0]!.url ?? 'the server'}`);
  if (e.region) parts.push(`changes the content of ${e.region.path}`);
  return `${verb} ${parts.length ? parts.join(', ') : 'changes the page'}`;
}

/** Clicks each candidate until one does what the gesture did. Returns its name, or null. */
async function findAlternative(ctx: ProbeContext, e: Effect, tried: string[], refused: Candidates['refused'], stopMark: number): Promise<{ name: string | null; plausible: boolean }> {
  const { page } = ctx;
  const near = e.region!.id;
  // Only next to the content the gesture changed, never the whole page.
  const found = await page.evaluate(controlsFor, { id: near, words: GESTURE_VOCAB, max: 5, nearOnly: true });
  refused.push(...found.refused);
  let plausible = false;
  for (const c of found.controls) {
    if (!hasTime(ctx, 3000)) break;
    // Stop at the first request, navigation or popup the guard had to stop.
    if (await settledStop(ctx, stopMark)) break;
    tried.push(c.name ?? c.path);
    const mark = ctx.guard.mark();
    const w = await page.evaluate(watchClick, undefined);
    const clicked = await clickControl(page, c);
    await page.waitForTimeout(200);
    const got = await page.evaluate(clickEffect, { ...w, changes: e.changes, control: c.id });
    const dialogs = ctx.guard.since(mark).filter((g) => g.kind === 'dialog');
    if (!clicked) continue;
    plausible ||= got.uncertain;
    if (got.region || (e.navs.length && got.navs) || (e.calls.length && (got.calls || dialogs.length))) return { name: c.name ?? c.path, plausible: true };
  }
  return { name: null, plausible };
}

/**
 * Runs in the page: "turn motion off" candidates near an element (open shadow roots included), toggles
 * named for the motion included. Controls whose whole name is the vocabulary's words ("Turn shake
 * off") come first; toggles that only share a motion word ("Shake sounds") after them.
 */
function offCandidates(arg: { id: number; words: readonly string[]; toggles: readonly string[]; max: number }): Candidates {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const near = kit.get(arg.id) ?? null;
  const vocab = new Set(arg.words);
  const els = kit.controls(near, arg.words, arg.max, { nearOnly: true, toggles: arg.toggles });
  const rank = (el: Element) => {
    const tokens = kit.name(el).toLowerCase().split(/[\s,.:;!?()[\]"/\-–—]+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => vocab.has(t)) ? 0 : 1;
  };
  const controls = els.map((el, i) => ({ el, i, r: rank(el) })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => kit.describe(x.el));
  return { controls, refused: kit.refused() };
}

/** Runs in the page: a toggle's state (checked, aria-checked or aria-pressed), or null for a plain control. */
function toggleState(id: number): string | null {
  const el = (window as unknown as { __grntedKit: Kit }).__grntedKit.get(id);
  if (!el) return null;
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return String(el.checked);
  if (el.matches('[role="switch"], [role="checkbox"]')) return el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? 'false';
  if (el.matches('button[aria-pressed]')) return el.getAttribute('aria-pressed');
  return null;
}

/**
 * Runs in the page: the visible label to click for a check box hidden behind a styled switch (not
 * shown, or a box under 8 px, often clipped to nothing), else null (click the control itself).
 */
function labelToClick(id: number): KitElement | null {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = kit.get(id);
  if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return null;
  const r = el.getBoundingClientRect();
  if (kit.visible(el, true) && r.width >= 8 && r.height >= 8) return null;
  const label = [...(el.labels ?? [])].find((l) => kit.visible(l, true));
  return label ? kit.describe(label) : null;
}

/** Tries of the gesture in one step, and the wait between them: together longer than a shake cooldown of a few seconds. */
export const OFF_TRIES = 3;
export const OFF_TRY_GAP_MS = 1000;
/** Off-switch candidates tried near the changed content (vocabulary-named controls first). */
export const OFF_CANDIDATES = 6;
/** How long a toggle's state may take to follow a click (a script that updates it late). */
const STATE_SETTLE_MS = 1500;

/**
 * What the off-switch search found: the switch, or the candidates it could not test because the
 * time box ran out (`outOfTime`). A candidate before which the gesture never worked again (a gesture
 * that acts only once) is tried and simply not proven: it does not make the result untested.
 */
interface OffResult { name: string | null; outOfTime: string[] }

/**
 * Finds a "turn motion off" control. For each candidate, in order (controls named with the
 * vocabulary's words before toggles that only share a motion word):
 * 1. the gesture must work now (tried again over a few seconds, for a page that ignores gestures
 *    for a while after one); a candidate it never works before cannot be proven and is passed over;
 * 2. the click: a toggle must change state (a state that follows the click late is waited for);
 * 3. the gesture must then do nothing (over the same few seconds when the page has such a pause);
 * 4. a toggle is clicked back, and must return to its state and bring the gesture back.
 * A toggle whose state the test changed is put back on every path, a late state update included.
 */
async function findOff(ctx: ProbeContext, kind: Gesture, near: number, minArea: number, tried: string[], refused: Candidates['refused'], stopMark: number): Promise<OffResult> {
  const { page } = ctx;
  const found = await page.evaluate(offCandidates, { id: near, words: MOTION_OFF_VOCAB, toggles: MOTION_TOGGLE_WORDS, max: OFF_CANDIDATES });
  refused.push(...found.refused);
  const outOfTime: string[] = [];
  /** The gesture once: whether it did anything (content, a dialog, a request or a navigation). */
  const acts = async (): Promise<boolean> => {
    const mark = ctx.guard.mark();
    const again = await page.evaluate(gesture, { kind, minArea });
    const events = ctx.guard.since(mark);
    return again.functional || events.some((g) => g.kind === 'dialog' || g.kind === 'blocked' || g.kind === 'navigation');
  };
  /** Whether the gesture works within `tries` tries; null when the time ran out first. */
  const worksWithin = async (tries: number): Promise<boolean | null> => {
    for (let i = 0; i < tries; i++) {
      if (i > 0) await page.waitForTimeout(OFF_TRY_GAP_MS);
      if (!hasTime(ctx, 2500)) return null;
      if (await acts()) return true;
    }
    return false;
  };
  /** A toggle's state once it has had time to follow a click: waits (up to STATE_SETTLE_MS) while it is `from`. */
  const stateAfter = async (id: number, from: string | null): Promise<string | null> => {
    let s = await page.evaluate(toggleState, id).catch(() => from);
    for (let waited = 0; s === from && waited < STATE_SETTLE_MS; waited += 250) {
      await page.waitForTimeout(250);
      s = await page.evaluate(toggleState, id).catch(() => from);
    }
    return s;
  };
  /** Whether the page ignores a gesture right after one that worked (a cooldown): learned once. */
  let pause: boolean | undefined;
  for (const c of found.controls) {
    if (!hasTime(ctx, 5000)) { outOfTime.push(c.name ?? c.path); continue; }
    if (await settledStop(ctx, stopMark)) break;
    tried.push(c.name ?? c.path);
    // 1. The gesture works before the click.
    const pre = await worksWithin(OFF_TRIES);
    if (pre === null) { outOfTime.push(c.name ?? c.path); continue; }
    if (!pre) continue;
    if (pause === undefined) {
      pause = !(await acts());
      if (pause) {
        const again = await worksWithin(OFF_TRIES);
        if (again === null) { outOfTime.push(c.name ?? c.path); continue; }
        if (!again) continue;
      }
    }
    const tries = pause ? OFF_TRIES : 1;
    // 2. The click (on its label, for a check box hidden behind a styled switch).
    const target = (await page.evaluate(labelToClick, c.id)) ?? c;
    const before = await page.evaluate(toggleState, c.id);
    try {
      if (!(await clickControl(page, target))) continue;
      await page.waitForTimeout(150);
      if (before !== null && (await stateAfter(c.id, before)) === before) continue;
      // 3. The gesture now does nothing.
      const still = await worksWithin(tries);
      if (still === null) { outOfTime.push(c.name ?? c.path); continue; }
      if (before === null) {
        if (!still) return { name: c.name ?? c.path, outOfTime };
        continue;
      }
      // 4. A toggle: clicked back; its state and the gesture return.
      const now = await page.evaluate(toggleState, c.id);
      await clickControl(page, target);
      await page.waitForTimeout(150);
      if ((await stateAfter(c.id, now)) !== before || still) continue;
      const back = await worksWithin(tries);
      if (back === null) { outOfTime.push(c.name ?? c.path); continue; }
      if (back) return { name: c.name ?? c.path, outOfTime };
    } finally {
      // A toggle the test changed is put back on every path, after giving a late update its time.
      if (before !== null) {
        let s = await page.evaluate(toggleState, c.id).catch(() => before);
        for (let waited = 0; s !== before && waited < STATE_SETTLE_MS; waited += 250) {
          await page.waitForTimeout(250);
          s = await page.evaluate(toggleState, c.id).catch(() => before);
        }
        if (s !== before) {
          await clickControl(page, target).catch(() => false);
          await page.waitForTimeout(150);
        }
      }
    }
  }
  return { name: null, outOfTime };
}

const MIN_AREA = 400;

/** Pages still mounting when the first pass ran (fix/late-mount, review r2): their watch, for the late pass. */
const actuationLate = new WeakMap<object, MountTracker>();

export const motionActuationProbe: PageProbe = {
  id: 'motion-actuation',
  criteria: ['2.5.4'],
  kind: 'interaction',
  tier: 'core',
  // Off-switch candidates on a page that ignores gestures for a few seconds after one take ~10 s each.
  timeoutMs: 40_000,
  contextOptions: MOTION_CONTEXT,
  async run(ctx) {
    actuationLate.get(ctx.page)?.stop();
    actuationLate.delete(ctx.page);
    // A page still putting its content in (one look; never a wait): watched from Node until the late pass.
    if ((await mountingNow(ctx.page)) === true) actuationLate.set(ctx.page, trackMount(ctx.page));
    try {
      return await runActuation(ctx);
    } finally {
      await ctx.page.evaluate(kitStop, undefined).catch(() => {});
    }
  },
  /**
   * The late pass (fix/late-mount, review r2): the listeners it shakes are what the page mounted. On a page
   * still mounting when the first pass ran, after every other test of the page (on the motion page: after
   * the timing test, so nothing waits in real time before it), the content is waited for (at most
   * `LATE_CONTENT_MS`) and, when the page went from mounting to mounted and the first pass found no device
   * motion listener, the test runs again on the mounted page. Otherwise the first pass stands.
   */
  late: {
    timeoutMs: 40_000,
    async run(ctx, first) {
      const tracker = actuationLate.get(ctx.page);
      actuationLate.delete(ctx.page);
      if (!tracker) return [...first];
      try {
        if (!first.every((f) => f.status === 'not_applicable')) return [...first];
        const wait = await tracker.settle(LATE_CONTENT_MS);
        tracker.stop();
        ctx.setData?.({ late: { waitedMs: wait.ms, mounted: wait.mounted } });
        if (!wait.mounted) return [...first];
        return await runActuation(ctx);
      } finally {
        tracker.stop();
        await ctx.page.evaluate(kitStop, undefined).catch(() => {});
      }
    },
  },
};

async function runActuation(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const { page } = ctx;
    const listeners = await ctx.listeners();
    const types = new Set(listeners.filter((l) => /^device(motion|orientation)/.test(l.type)).map((l) => l.type));
    if (!types.size) return [{ criterion: '2.5.4', status: 'not_applicable', detail: 'the page does not listen for device motion or orientation' }];
    await kitReady(page);
    await page.evaluate(installActionTracking, undefined);
    const gestures: Gesture[] = [];
    if (types.has('devicemotion')) gestures.push('shake');
    if (types.has('deviceorientation') || types.has('deviceorientationabsolute')) gestures.push('tilt');
    const findings: ProbeFinding[] = [];
    for (const kind of gestures) {
      const mark = ctx.guard.mark();
      const e = await page.evaluate(gesture, { kind, minArea: MIN_AREA });
      const events = ctx.guard.since(mark);
      const dialogs = events.filter((g) => g.kind === 'dialog');
      const blocked = events.filter((g) => g.kind === 'blocked' || g.kind === 'navigation');
      const name = kind === 'shake' ? 'shaking' : 'tilting';
      if (!e.functional && !dialogs.length && !blocked.length) {
        findings.push({
          criterion: '2.5.4', status: 'no_failures_found',
          detail: e.visualOnly ? `${name} the device only moves things on screen (a visual effect, not an action)` : `the page listens for device ${kind === 'shake' ? 'motion' : 'orientation'}, but ${name} the device changed nothing`,
        });
        continue;
      }
      const what = effectText(kind, e, dialogs, blocked);
      const target = e.region?.path;
      if (!hasTime(ctx, 4000)) {
        findings.push({ criterion: '2.5.4', status: 'not_testable', ...(target ? { target } : {}), detail: `${what}; the time for this test ran out before a control could be tried` });
        continue;
      }
      if (!e.region) {
        // A navigation, dialog or request with no changed content: no control can be tied to it.
        findings.push({ criterion: '2.5.4', status: 'not_testable', detail: `${what}; no control could be tied to the gesture (it changed no content on the page)` });
        continue;
      }
      const tried: string[] = [];
      const refused: Candidates['refused'] = [];
      const altMark = ctx.guard.mark();
      const alternative = await findAlternative(ctx, e, tried, refused, altMark);
      const alt = alternative.name;
      const offResult = alt && !(await settledStop(ctx, altMark)) ? await findOff(ctx, kind, e.region.id, MIN_AREA, tried, refused, altMark) : null;
      const off = offResult?.name ?? null;
      const untested = offResult?.outOfTime ?? [];
      const stopped = await settledStop(ctx, altMark);
      const triedText = tried.length ? `controls tried: ${tried.map((t) => `"${t.slice(0, 40)}"`).join(', ')}` : 'no related controls found near it';
      const notTried = refusedText(refused);
      if (stopped) {
        findings.push({ criterion: '2.5.4', status: 'not_testable', ...(target ? { target } : {}), detail: `${what}; ${stopped} (${triedText})` });
      } else if (alt && off) {
        findings.push({ criterion: '2.5.4', status: 'no_failures_found', ...(target ? { target } : {}), detail: `${what}; the control "${alt}" does the same, and "${off}" turns the motion response off` });
      } else if (notTried) {
        // A control that may do the same, or turn motion off, was not clicked: no verdict.
        findings.push({ criterion: '2.5.4', status: 'not_testable', ...(target ? { target } : {}), detail: `${what}; ${notTried} (${triedText})` });
      } else if (alt && untested.length) {
        // The time box ran out before a candidate off switch could be tried: no verdict.
        findings.push({ criterion: '2.5.4', status: 'not_testable', ...(target ? { target } : {}), detail: `${what}; the control "${alt}" does the same, but the time for this test ran out before ${untested.slice(0, 3).map((u) => `"${u.slice(0, 40)}"`).join(', ')} could be tried as a way to turn the motion off (${triedText})` });
      } else if (!alt) {
        findings.push({ criterion: '2.5.4', status: alternative.plausible ? 'not_testable' : 'failed', ...(target ? { target } : {}), detail: `${what}; ${alternative.plausible ? 'a nearby control may be an alternative, but it did not demonstrably change the same content or value' : 'no control next to it does the same'} (${triedText})` });
      } else {
        findings.push({ criterion: '2.5.4', status: 'failed', ...(target ? { target } : {}), detail: `${what}; the control "${alt}" does the same, but nothing turns the response to motion off (${triedText})` });
      }
    }
    return findings;
}

