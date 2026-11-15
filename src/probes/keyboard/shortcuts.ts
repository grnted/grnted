// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.1.4 Character key shortcuts (Plan 4 Task 4.1): single printable keys pressed with focus on the
// page (never in a text field), watching for what they do. Keys go in small batches; a batch that
// does something is retried key by key on a reloaded page. Engine core: no Node-only imports.
import type { ProbeFinding } from '../../types.js';
import { ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext } from '../types.js';
import { stoppedReason } from './findings.js';
import { kitAfterKey, kitBeforeKey, kitBlurAll, kitControlMatching, kitKeyState, kitStop, kitTake, type Counters, type KeyState } from './page.js';
import {
  clip, confirmed, SHORTCUT_BATCH, SHORTCUT_CONTROL, SHORTCUT_KEYS, SHORTCUT_NOISE_MS, SHORTCUT_QUIET_TRIES, SHORTCUT_SETTLE_MS, shortcutEffect, shortcutRemapPattern,
} from './rules.js';
import { fullLogFindings, navigationRace, reloadPage, startKit } from './traverse.js';
import { LATE_CONTENT_MS, waitForContent } from '../ready.js';

const KEY_TYPES = new Set(['keydown', 'keypress', 'keyup']);

interface Press {
  effect: { what: string; confirm: boolean; recheck?: true } | null;
  /** The effect is a navigation, popup or dialog (decisive, but a timer can cause it too). */
  event: boolean;
  /** A request the guard blocked, or a navigation it held, while the keys were pressed. */
  stopped?: GuardEvent;
  /** A text field kept keyboard focus after blur: no key was pressed. */
  stuck?: string;
  /** Where the effect happened: the element focus moved to, or the first element the page changed. */
  target?: string;
}

/** Presses `keys` one after the other (no wait between them) and reports what changed. */
async function press(ctx: ProbeContext, keys: readonly string[], url: string, noise: { changed: number; toggled: number }): Promise<Press> {
  const { page } = ctx;
  const before = await page.evaluate(kitBeforeKey, undefined);
  const mark = ctx.guard.mark();
  let sent = 0;
  for (const k of keys) {
    // Never type into a field: a key that focused one ends the batch (the keys left are retried one
    // by one); a field that takes focus back after blur ends the test.
    const st = sent ? await page.evaluate(kitKeyState, undefined) : before;
    if (st.textField) {
      if (sent) break;
      await page.evaluate(kitBeforeKey, undefined);
      await page.waitForTimeout(20);
      const again = await page.evaluate(kitKeyState, undefined);
      if (again.textField) return { effect: null, event: false, stuck: again.activePath ?? 'a text field' };
    }
    await page.keyboard!.press(k);
    sent++;
  }
  const after: KeyState & Counters = await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS);
  const events = ctx.guard.since(mark);
  const guarded = events.find((e) => e.kind === 'navigation' || (e.kind === 'url-change' && e.url && e.url.split('#')[0] !== url.split('#')[0]));
  // The page's own count of navigations it started: the guard can lag behind on a busy machine.
  const nav = guarded ? guarded.url ?? 'another address' : after.navs ? after.navTo ?? 'another address' : undefined;
  const popup = events.find((e) => e.kind === 'popup');
  const dialog = events.find((e) => e.kind === 'dialog');
  const effect = shortcutEffect({
    ...(after.active && after.active !== before.active ? { focus: after.activePath ?? 'another element' } : {}),
    scrolled: Math.abs(after.sy - before.sy) + Math.abs(after.sx - before.sx),
    ...(nav ? { navigation: nav } : {}),
    ...(popup || after.opens ? { popup: popup?.url ?? '' } : {}),
    ...(dialog ? { dialog: dialog.dialog ?? 'alert' } : {}),
    changed: after.added + after.removed,
    toggled: after.semantic,
  }, noise);
  const stopped = events.find((e) => e.kind === 'blocked');
  const target = effect && /^moved keyboard focus/.test(effect.what) ? after.activePath : after.where;
  return { effect, event: !!(nav || popup || dialog || after.opens), ...(stopped ? { stopped } : {}), ...(target ? { target } : {}) };
}

/** The same effect again (a recheck): of the same kind, at the same element (Sol round 1: not merely another change). */
export function sameEffect(a: Pick<Press, 'effect' | 'target'>, b: Pick<Press, 'effect' | 'target'>): boolean {
  if (!a.effect || !b.effect || !a.target || a.target !== b.target) return false;
  const kind = (w: string) => w.replace(/\s.*$/, '');
  return kind(a.effect.what) === kind(b.effect.what);
}

/** Blocked requests while idle and while pressing `key` again: did the key cause them? */
async function blockedAgain(ctx: ProbeContext, key: string): Promise<boolean> {
  const { page } = ctx;
  let mark = ctx.guard.mark();
  await page.evaluate(kitBeforeKey, undefined);
  await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS);
  const idle = ctx.guard.since(mark).filter((e) => e.kind === 'blocked').length;
  mark = ctx.guard.mark();
  await page.evaluate(kitBeforeKey, undefined);
  await page.keyboard!.press(key);
  await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS);
  return idle === 0 && ctx.guard.since(mark).some((e) => e.kind === 'blocked');
}

/** A navigation, popup or dialog: none while idle, and again on a second press of the same key. */
async function confirmEvent(ctx: ProbeContext, key: string, url: string): Promise<'yes' | 'no' | 'noisy'> {
  const { page } = ctx;
  const happened = (events: readonly GuardEvent[], c: { opens: number; navs: number }) => c.opens > 0 || c.navs > 0
    || events.some((e) => e.kind === 'navigation' || e.kind === 'popup' || e.kind === 'dialog' || (e.kind === 'url-change' && e.url && e.url.split('#')[0] !== url.split('#')[0]));
  await page.waitForTimeout(150);
  let mark = ctx.guard.mark();
  await page.evaluate(kitBeforeKey, undefined);
  const quiet = await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS + 100);
  if (happened(ctx.guard.since(mark), quiet)) return 'noisy';
  mark = ctx.guard.mark();
  await page.evaluate(kitBeforeKey, undefined);
  await page.keyboard!.press(key);
  const again = await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS + 100);
  return happened(ctx.guard.since(mark), again) ? 'yes' : 'no';
}

/** On a page that changes by itself: compare a quiet window with a second press of the same key. */
async function confirmChange(ctx: ProbeContext, key: string): Promise<boolean> {
  const { page } = ctx;
  await page.evaluate(kitBeforeKey, undefined);
  const quiet = await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS);
  await page.evaluate(kitBeforeKey, undefined);
  await page.keyboard!.press(key);
  const again = await page.evaluate(kitAfterKey, SHORTCUT_SETTLE_MS);
  return confirmed(again.added + again.removed + again.semantic, quiet.added + quiet.removed + quiet.semantic);
}

/**
 * Waits (at most `SHORTCUT_QUIET_TRIES` idle windows) for a moment in which the page changes nothing by itself: no
 * element added, removed or changed, no focus move, navigation or window. False when none came (inconclusive).
 */
async function quietMoment(ctx: ProbeContext): Promise<boolean> {
  for (let i = 0; i < SHORTCUT_QUIET_TRIES && !ctx.signal.aborted; i++) {
    const before = await ctx.page.evaluate(kitBeforeKey, undefined);
    const idle = await ctx.page.evaluate(kitAfterKey, SHORTCUT_NOISE_MS);
    if (!idle.added && !idle.removed && !idle.semantic && !idle.navs && !idle.opens && !idle.focusins && idle.active === before.active) return true;
  }
  return false;
}

/** Time a recheck needs before the probe's deadline: a reload, the content wait, a quiet moment, the key, the cleanup reload. */
export const SHORTCUT_RECHECK_RESERVE_MS = 7000;

async function reload(ctx: ProbeContext, url: string): Promise<void> {
  await reloadPage(ctx, url);
  // The page's shortcuts may come with content it mounts late: the runner's own readiness test, within the time left.
  const left = ctx.deadline - Date.now() - 4000;
  if (left > 0) await waitForContent(ctx.page, Math.min(LATE_CONTENT_MS, left), 2000, ctx.signal);
  await startKit(ctx);
  await ctx.page.evaluate(kitBlurAll, undefined);
}

/** Runs in the page: activate a safe candidate, never a link or a form submission. */
function activateShortcutControl(path: string): 'clicked' | 'disabled' | 'unknown' {
  let el = document.querySelector<HTMLElement>(path);
  if (el instanceof HTMLLabelElement) el = el.control;
  if (!el) return 'unknown';
  if (el.matches(':disabled, [aria-disabled="true"]')) return 'disabled';
  if (el.closest('a[href]') || el.matches('[role="link"], select')
    || (el instanceof HTMLButtonElement && el.form && el.type !== 'button')
    || (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio'].includes(el.type))) return 'unknown';
  el.click();
  return 'clicked';
}

export const keyShortcutsProbe: PageProbe = {
  id: 'key-shortcuts',
  criteria: ['2.1.4'],
  kind: 'interaction',
  tier: 'core',
  // An app that installs its shortcuts when its content mounts late is tested with them.
  waitFor: { content: true },
  timeoutMs: 15_000,
  async run(ctx) {
    const mark = ctx.guard.mark();
    const findings = await shortcuts(ctx).catch((err) => navigationRace(ctx, mark, err));
    // A full guard log proves nothing.
    return [...findings, ...fullLogFindings(ctx, ['2.1.4'], findings)];
  },
};

const NOISY: ProbeFinding = {
  criterion: '2.1.4',
  status: 'not_testable',
  detail: 'the page loads other pages or opens windows by itself while no key is pressed, so what a key does could not be told apart',
};

const stuckField = (path: string): ProbeFinding[] => [{
  criterion: '2.1.4', status: 'not_testable', target: path,
  detail: `a text field (${clip(path, 100)}) takes keyboard focus back whenever it loses it, so single keys would be typed into it; none was pressed`,
}];

async function shortcuts(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page } = ctx;
  if (!page.keyboard) throw new ProbeNotTestable('the browser cannot send key presses to this page');
  // Keys pressed with focus on the page reach handlers on window, document, html and body only.
  const pageWide = (await ctx.listeners()).filter((l) => KEY_TYPES.has(l.type)
    && (l.target.kind === 'window' || l.target.kind === 'document' || (l.target.kind === 'element' && (l.target.tag === 'body' || l.target.tag === 'html'))));
  if (!pageWide.length) {
    return [{ criterion: '2.1.4', status: 'not_applicable', detail: 'no keyboard handlers on the page as a whole (window, document or body), so no single-key shortcut can fire' }];
  }
  const url = page.url?.() ?? ctx.url;
  await startKit(ctx);
  let changedPage = false;
  try {
    await page.evaluate(kitBlurAll, undefined);
    await page.waitForTimeout(SHORTCUT_NOISE_MS);
    const idle = await page.evaluate(kitTake, undefined);
    const noise = { changed: idle.added + idle.removed, toggled: idle.semantic };
    const late = () => ctx.signal.aborted || Date.now() > ctx.deadline - 3000;
    let hit: { key: string; what: string } | null = null;
    let stoppedKey: { key: string; event: GuardEvent } | null = null;
    let untested = 0;
    // Navigations the page started while nothing was pressed: what a key does cannot be told apart.
    if (idle.navs > 0) return [NOISY];
    let noisy = false;
    for (let b = 0; b < SHORTCUT_KEYS.length && !hit; b += SHORTCUT_BATCH) {
      const batch = SHORTCUT_KEYS.slice(b, b + SHORTCUT_BATCH);
      if (late()) {
        untested += SHORTCUT_KEYS.length - b;
        break;
      }
      const r = await press(ctx, batch, url, noise);
      if (r.stuck) return stuckField(r.stuck);
      if (!r.effect && !r.stopped) continue;
      // Something happened: find the key, one at a time, from a fresh page when the batch changed it.
      if (r.effect) changedPage = true;
      if (r.effect && !r.effect.confirm) await reload(ctx, url);
      for (const key of batch) {
        if (late()) {
          untested++;
          continue;
        }
        const one = await press(ctx, [key], url, noise);
        if (one.stuck) return stuckField(one.stuck);
        if (one.effect) {
          changedPage = true;
          if (one.effect.confirm && !(await confirmChange(ctx, key))) continue;
          // A change on a quiet page is done again from a fresh load: a timer's change that met the key does not repeat.
          if (one.effect.recheck) {
            // No time left for a recheck: inconclusive, never a failure.
            if (Date.now() > ctx.deadline - SHORTCUT_RECHECK_RESERVE_MS) { untested++; continue; }
            await reload(ctx, url);
            // No quiet moment: what the key does cannot be told apart from what the page does by itself.
            if (!(await quietMoment(ctx))) { noisy = true; continue; }
            const again = await press(ctx, [key], url, noise);
            if (again.stuck) return stuckField(again.stuck);
            if (!sameEffect(one, again)) continue;
          }
          if (one.event) {
            const c = await confirmEvent(ctx, key, url);
            if (c === 'noisy') noisy = true;
            if (c !== 'yes') continue;
          }
          hit = { key, what: one.effect.what };
          break;
        }
        if (one.stopped && !stoppedKey && (await blockedAgain(ctx, key))) stoppedKey = { key, event: one.stopped };
      }
    }
    if (hit) {
      // Wording discovers candidates; only behavior after activation establishes an exception.
      const skip: string[] = [];
      let uncertain = false;
      const pattern = `(?:${SHORTCUT_CONTROL.source})|(?:${shortcutRemapPattern(hit.key)})`;
      for (;;) {
        const control = await page.evaluate(kitControlMatching, { pattern, skip });
        if (!control) break;
        skip.push(control);
        if (late()) { uncertain = true; break; }
        const mark = ctx.guard.mark();
        const activated = await page.evaluate(activateShortcutControl, control);
        if (activated === 'disabled') continue;
        if (activated !== 'clicked' || ctx.guard.since(mark).length) { uncertain = true; continue; }
        await page.evaluate(kitBlurAll, undefined);
        if (!(await quietMoment(ctx))) { uncertain = true; continue; }
        const first = await press(ctx, [hit.key], url, { changed: 0, toggled: 0 });
        const second = await press(ctx, [hit.key], url, { changed: 0, toggled: 0 });
        if (first.stuck || second.stuck || first.stopped || second.stopped || ctx.guard.since(mark).length) { uncertain = true; continue; }
        if (!first.effect && !second.effect) return [];
      }
      if (uncertain) return [{ criterion: '2.1.4', status: 'not_testable', target: `key "${hit.key}"`, detail: `A control may turn off or remap the single-key shortcut, but its effect could not be verified.` }];
      const finding: ProbeFinding = {
        criterion: '2.1.4',
        status: 'failed',
        target: `key "${hit.key}"`,
        detail: `Pressing the single key "${hit.key}" with focus on the page (not in a text field) ${hit.what}. No control to turn this shortcut off or change its key was found, and it works without any particular element having focus.`,
      };
      // Kept before the cleanup reload: a slow reload that runs out the time box does not lose it.
      ctx.keep?.([finding]);
      return [finding];
    }
    if (stoppedKey) {
      return [{
        criterion: '2.1.4',
        status: 'not_testable',
        target: `key "${stoppedKey.key}"`,
        detail: `Pressing the single key "${stoppedKey.key}" sends a request, and what it does depends on the answer: ${stoppedReason(stoppedKey.event)}.`,
      }];
    }
    if (noisy) return [NOISY];
    if (untested) {
      return [{
        criterion: '2.1.4',
        status: 'not_testable',
        detail: `timed out: the page answered key presses too slowly; ${untested} of ${SHORTCUT_KEYS.length} keys (${clip(SHORTCUT_KEYS.join(' '), 60)}) were not tried`,
      }];
    }
    return [];
  } finally {
    await page.evaluate(kitStop, undefined).catch(() => {});
    if (changedPage) {
      // Put the page back for the probes after this one.
      await reloadPage(ctx, url).catch(() => {});
    }
  }
}
