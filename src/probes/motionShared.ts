// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared by the Task 4.4 probes (motion, audio, watch, motion-actuation, timing): their context,
// screenshots, clicking a control like a person would, and starting media a browser that allows
// autoplay would have started. Engine core: no Node-only imports.
import type { PageLike } from '../types.js';
import { installKit, type Kit, type KitBox, type KitElement } from './kit.js';
import { changedRegions, type ChangedRegion } from './motionPixels.js';
import { decodePng, type RgbaImage } from './pixels.js';
import { guardStop } from './guard.js';
import { ProbeNotTestable, type GuardEvent, type ProbeContext, type ProbeContextOptions } from './types.js';

/**
 * The context of the motion, audio, watch, motion-actuation and timing probes: the desktop viewport
 * with `prefers-reduced-motion: no-preference` (the audit uses 'reduce', which hides exactly the
 * motion 2.2.2 is about). They share one page per sampled page, in registry order; timing runs last
 * because it runs the page's timers early.
 */
export const MOTION_CONTEXT: ProbeContextOptions = { reducedMotion: 'no-preference' };

/** Moving or changing content smaller than this (CSS px²) is ignored (about 20×20 px). */
export const MIN_AREA = 400;
/** WCAG 2.2.2: moving, blinking or scrolling content that lasts more than 5 s needs a control. */
export const MOTION_LIMIT_MS = 5000;

/** Installs the in-page kit; a page where it cannot run cannot be tested. */
export async function kitReady(page: PageLike): Promise<void> {
  const ok = await page.evaluate(installKit, undefined).catch(() => false);
  if (!ok) throw new ProbeNotTestable('the test could not run its code in this page');
}

/** The page's screenshot of the viewport, decoded; null when the browser cannot take one. */
export async function viewportShot(page: PageLike, clip?: KitBox): Promise<RgbaImage | null> {
  // The screenshot briefly restyles text fields (to hide the caret): keep that out of the kit's
  // mutation record, or a still form looks like content the page keeps changing.
  const mute = (on: boolean) => page.evaluate((m: boolean) => { (window as unknown as { __grntedKit?: Kit }).__grntedKit?.mute(m); }, on).catch(() => {});
  await mute(true);
  try {
    const bytes = await page.screenshot({ type: 'png', scale: 'css', ...(clip ? { clip: { x: clip.x, y: clip.y, width: Math.max(1, clip.w), height: Math.max(1, clip.h) } } : {}) });
    return await decodePng(bytes);
  } catch {
    return null;
  } finally {
    await mute(false);
  }
}

/**
 * One pair of shots that differ in a region, with when (monotonic clock, `performance.now()` in Node): the
 * region changed at some moment no later than `by` (the later shot's return) and no earlier than `after` (the
 * earlier shot's call). `shots`: which of the window's three shots (0, 1, 2) the pair compares; `at`: the
 * region as that pair found it.
 */
export interface SeenPair { shots: readonly [number, number]; by: number; after: number; at: ChangedRegion }

/**
 * A changed region with when it was seen changing: at some moment no later than `by` (the earliest pair's
 * `by`) and no earlier than `after` (the latest pair's `after`), and every pair of shots that found it (`pairs`).
 * So motion seen in one window by `by` and in a later one from `after` lasted at least `after - by`.
 */
export interface SeenRegion extends ChangedRegion { by: number; after: number; pairs: SeenPair[] }

/** Full-viewport comparison cells in CSS px; identity sampling uses the same cell boundaries. */
export const MOTION_CELL = 32;

/**
 * Changed regions between two screenshots taken `gapMs` apart (viewport CSS px at scale 1), with when
 * (`SeenRegion`). `sample`, when given, runs right after each shot returns and its results are kept in
 * `sample.taken` by shot (what was on the page when that shot was taken, e.g. which element is where).
 */
export async function visualChanges(page: PageLike, gapMs: number, clip?: KitBox, sample?: { take: () => Promise<unknown>; taken: unknown[] }): Promise<SeenRegion[] | null> {
  // Three shots over the same time, at uneven gaps (60 % then 40 %), every pair compared: content that
  // cycles (a ticker through three texts every 250 ms) can look the same in two shots a whole cycle
  // apart, whatever the machine's speed, but never in all three.
  const opts = clip ? { cell: 8, minPixels: 40 } : { cell: MOTION_CELL };
  const shot = async () => {
    const asked = performance.now();
    const img = await viewportShot(page, clip);
    const back = performance.now();
    if (img && sample) sample.taken.push(await sample.take().catch(() => null));
    return img ? { img, asked, back } : null;
  };
  const a = await shot();
  if (!a) return null;
  await page.waitForTimeout(Math.round(gapMs * 0.6));
  const b = await shot();
  if (!b) return null;
  await page.waitForTimeout(Math.round(gapMs * 0.4));
  const c = await shot();
  if (!c) return null;
  const out: SeenRegion[] = [];
  const shots = [a, b, c];
  for (const [i, j] of [[0, 1], [1, 2], [0, 2]] as const) {
    const x = shots[i]!;
    const y = shots[j]!;
    for (const r of changedRegions(x.img, y.img, opts)) {
      const pair: SeenPair = { shots: [i, j], by: y.back, after: x.asked, at: r };
      const same = out.find((o) => overlapShare(o, r) > 0.9 && Math.abs(o.w * o.h - r.w * r.h) <= 0.1 * Math.max(o.w * o.h, r.w * r.h));
      if (same) { same.by = Math.min(same.by, y.back); same.after = Math.max(same.after, x.asked); same.pairs.push(pair); } else out.push({ ...r, by: y.back, after: x.asked, pairs: [pair] });
    }
  }
  return out;
}

/** Overlap of two boxes, as a share of the smaller one. */
export function overlapShare(a: KitBox, b: KitBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/**
 * Runs in the page: makes every scroll instant until `instantScrollStop` (counted, so nested probes
 * share it). A page with `scroll-behavior: smooth` animates every scroll a test makes, also
 * `scrollTo(x, y)` and `scrollIntoView()` without a behavior: what the test then films or measures is
 * the page racing past, not the place it asked for (2.3.1 read text scrolling by as flashing). Scroll
 * snapping is off too: a mandatory snap moves the window to the nearest snap point, so the place asked
 * for is never reached. The test's own style, `scroll-behavior: auto` and `scroll-snap-type: none`
 * (!important, inline on html and body above any author rule, and on every element); the kit records
 * none of it as a change the page made.
 */
export function instantScrollStart(): boolean {
  type Saved = { n: number; style: HTMLStyleElement; inline: [HTMLElement, string, [string, string][], boolean][] };
  const w = window as unknown as { __grntedInstantScroll?: Saved; __grntedKit?: Kit };
  if (w.__grntedInstantScroll) { w.__grntedInstantScroll.n++; return true; }
  w.__grntedKit?.mute(true);
  try {
    const inline: Saved['inline'] = [];
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const props = ['scroll-behavior', 'scroll-snap-type'];
      const before = props.map((p) => [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)] as [string, string]);
      inline.push([el, '', before, el.hasAttribute('style')]);
      el.style.setProperty('scroll-behavior', 'auto', 'important');
      el.style.setProperty('scroll-snap-type', 'none', 'important');
    }
    const style = document.createElement('style');
    style.setAttribute('data-grnted-instant-scroll', '');
    style.textContent = '*, *::before, *::after { scroll-behavior: auto !important; scroll-snap-type: none !important; }';
    (document.head || document.documentElement).appendChild(style);
    w.__grntedInstantScroll = { n: 1, style, inline };
  } finally {
    w.__grntedKit?.mute(false);
  }
  return true;
}

/** Runs in the page: undoes `instantScrollStart` once every start has been stopped. */
export function instantScrollStop(): void {
  type Saved = { n: number; style: HTMLStyleElement; inline: [HTMLElement, string, [string, string][], boolean][] };
  const w = window as unknown as { __grntedInstantScroll?: Saved; __grntedKit?: Kit };
  const s = w.__grntedInstantScroll;
  if (!s || --s.n > 0) return;
  delete w.__grntedInstantScroll;
  w.__grntedKit?.mute(true);
  try {
    const props = ['scroll-behavior', 'scroll-snap-type'];
    for (const [el, , before, had] of s.inline) {
      props.forEach((p, i) => {
        const [v, prio] = before[i]!;
        if (v) el.style.setProperty(p, v, prio);
        else el.style.removeProperty(p);
      });
      if (!had && !el.getAttribute('style')) el.removeAttribute('style');
    }
    s.style.remove();
  } finally {
    w.__grntedKit?.mute(false);
  }
}

/** Longest wait for the window to stay put at a scroll position (`settleScroll`). */
export const SCROLL_SETTLE_MS = 1000;

/**
 * Runs in the page: scrolls the window to `y` at once and waits (at most `maxMs`) until it is there
 * (the page's largest scroll when `y` is beyond it) and has stayed put for two animation frames. Not
 * settled: the window is not there (a script moving it or holding it elsewhere, smooth scrolling or
 * snapping the test could not turn off), so nothing measured is about that place; filming where the
 * window stopped instead would not stand for the place asked for.
 */
export async function settleScroll(arg: { y: number; maxMs: number }): Promise<{ x: number; y: number; settled: boolean }> {
  const root = document.scrollingElement || document.documentElement;
  const target = () => Math.max(0, Math.min(arg.y, root.scrollHeight - innerHeight));
  window.scrollTo({ top: arg.y, left: 0, behavior: 'instant' as ScrollBehavior });
  const frame = () => new Promise<void>((r) => {
    // A frame, or 50 ms when the page gets none (a hidden page).
    const t = setTimeout(r, 50);
    requestAnimationFrame(() => { clearTimeout(t); r(); });
  });
  const end = performance.now() + arg.maxMs;
  let last = NaN;
  let still = 0;
  for (;;) {
    await frame();
    const now = scrollY;
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 2 && Math.abs(now - target()) <= 1) return { x: Math.round(scrollX), y: Math.round(now), settled: true };
    if (performance.now() > end) return { x: Math.round(scrollX), y: Math.round(now), settled: false };
    // Pulled away (a script, a scroll the test could not make instant): ask again.
    if (still >= 2) { window.scrollTo({ top: arg.y, left: 0, behavior: 'instant' as ScrollBehavior }); still = 0; }
  }
}

/** Runs in the page: starts watching the window's scroll position (`scrollWatchTake` says whether it moved). */
export function scrollWatchStart(): void {
  const w = window as unknown as { __grntedScrollWatch?: { x: number; y: number; moved: boolean; off: () => void } };
  w.__grntedScrollWatch?.off();
  const s = { x: scrollX, y: scrollY, moved: false, off: () => {} };
  const on = () => { if (scrollX !== s.x || scrollY !== s.y) s.moved = true; };
  window.addEventListener('scroll', on, { passive: true, capture: true });
  s.off = () => window.removeEventListener('scroll', on, { capture: true });
  w.__grntedScrollWatch = s;
}

/** Runs in the page: whether the window scrolled since `scrollWatchStart` (or is elsewhere now), and where it is. */
export function scrollWatchTake(): { moved: boolean; x: number; y: number } {
  const w = window as unknown as { __grntedScrollWatch?: { x: number; y: number; moved: boolean; off: () => void } };
  const s = w.__grntedScrollWatch;
  delete w.__grntedScrollWatch;
  s?.off();
  const moved = !s || s.moved || scrollX !== s.x || scrollY !== s.y;
  return { moved, x: Math.round(scrollX), y: Math.round(scrollY) };
}

/** Runs in the page: scrolls the element into view; its box in viewport coordinates, or null. */
function prepareClick(arg: { id: number; hoverId?: number }): { x: number; y: number; w: number; h: number; visible: boolean } | null {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = kit.get(arg.id);
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, visible: kit.visible(el) };
}

/** Runs in the page: the element at a viewport point is the target or inside it. */
function hits(arg: { id: number; x: number; y: number }): boolean {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = kit.get(arg.id);
  const at = document.elementFromPoint(arg.x, arg.y);
  return !!el && !!at && (el === at || el.contains(at) || at.contains(el));
}

/**
 * Clicks a control the way a person would: scrolls it into view, hovers `hoverId` first when the
 * control only shows on hover, clicks its centre with the mouse (falling back to a DOM click when
 * something covers it), then moves the mouse away. Returns false when it could not be clicked.
 */
export async function clickControl(page: PageLike, control: KitElement, hoverId?: number): Promise<boolean> {
  let box = await page.evaluate(prepareClick, { id: control.id }).catch(() => null);
  if (!box) return false;
  if (!box.visible && hoverId !== undefined && page.mouse) {
    const h = await page.evaluate(prepareClick, { id: hoverId }).catch(() => null);
    if (h) await page.mouse.move(h.x + h.w / 2, h.y + h.h / 2, { steps: 2 });
    await page.waitForTimeout(150);
    box = await page.evaluate(prepareClick, { id: control.id }).catch(() => null);
    if (!box) return false;
  }
  const x = box.x + box.w / 2;
  const y = box.y + box.h / 2;
  const onTop = page.mouse && (await page.evaluate(hits, { id: control.id, x, y }).catch(() => false));
  try {
    if (onTop) await page.mouse!.click(x, y);
    else await page.evaluate((id: number) => { ((window as unknown as { __grntedKit: Kit }).__grntedKit.get(id) as HTMLElement | undefined)?.click(); }, control.id);
  } catch {
    return false;
  }
  await page.waitForTimeout(250);
  await page.mouse?.move(0, 0).catch(() => {});
  return true;
}

/** Candidate controls, and the matching ones left out because a click could act on the site. */
export interface Candidates { controls: KitElement[]; refused: { name: string; why: string }[] }

/** Runs in the page: candidate controls for an element, by name pattern (see `Kit.controls`). */
export function controlsFor(arg: { id: number | null; words: readonly string[]; max: number; nearOnly?: boolean; closers?: boolean; toggles?: readonly string[]; unknown?: boolean }): Candidates {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const near = arg.id === null ? null : kit.get(arg.id) ?? null;
  // `toggles` (1.4.2, batch 18): switches named for what they control are candidates too, and open shadow roots are looked in.
  // `unknown` (2.2.2, batch 19): controls the vocabulary does not name, in the moving item's own container or named for motion.
  const controls = kit.controls(near, arg.words, arg.max, { nearOnly: !!arg.nearOnly, closers: !!arg.closers, ...(arg.toggles ? { toggles: arg.toggles } : {}), ...(arg.unknown ? { unknown: true } : {}) }).map((el) => kit.describe(el));
  return { controls, refused: kit.refused() };
}

/** "…; matching controls not tried: "Pause" (it would submit a form)", or '' when none were left out. */
export function refusedText(refused: Candidates['refused']): string {
  if (!refused.length) return '';
  return `controls not tried because a click could act on the site: ${refused.slice(0, 3).map((r) => `"${r.name.slice(0, 40)}" (${r.why})`).join(', ')}`;
}

/** Runs in the page: stops the kit's mutation recording (each probe calls it when done). */
export function kitStop(): void {
  (window as unknown as { __grntedKit?: Kit }).__grntedKit?.stop();
}

/**
 * Runs in the page: starts media that has the `autoplay` attribute (or that the page tried to play)
 * but never started because the browser blocked autoplay, as a browser that allows autoplay would
 * have. `page.evaluate` counts as a user gesture, so play() is allowed. Returns how many it started.
 */
export function startBlockedAutoplay(): number {
  const sound = (window as unknown as { __grntedSound?: () => { played: HTMLMediaElement[] } }).__grntedSound?.();
  const tried = new Set(sound?.played ?? []);
  const all = new Set<HTMLMediaElement>([...document.querySelectorAll('video, audio')] as HTMLMediaElement[]);
  for (const m of tried) all.add(m);
  let started = 0;
  // A media fragment (`#t=8,10`) starts at its own time: that is not having played.
  const start = (m: HTMLMediaElement) => {
    const f = /#(?:.*&)?t=(?:npt:)?([\d:.]+)/.exec(m.currentSrc || m.src);
    return f ? f[1]!.split(':').map(Number).reduce((a, n) => a * 60 + n, 0) || 0 : 0;
  };
  for (const m of all) {
    if (!m.paused || m.ended || m.played.length > 0 || m.currentTime > start(m) + 0.05) continue;
    if (!m.autoplay && !tried.has(m)) continue;
    if (!m.currentSrc && !m.src && !m.querySelector('source')) continue;
    started++;
    (m as HTMLMediaElement & { __grntedStarted?: boolean }).__grntedStarted = true;
    m.play().catch(() => {});
  }
  return started;
}

/** Plain duration: "8 s", "2 min", "no end". */
export function lasting(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'with no end';
  if (ms < 120_000) return `for ${Math.round(ms / 1000)} s`;
  return `for ${Math.round(ms / 60_000)} min`;
}

/** "the run's time is up" helper: false when less than `reserveMs` is left in the time box. */
/**
 * Time (ms) left in the test's time box: on the monotonic clock when the runner gives its end there (`ends`),
 * so a wall-clock correction neither uses up nor extends it (review r5 of fix/late-mount).
 */
export const timeLeft = (ctx: ProbeContext): number => (ctx.ends !== undefined ? ctx.ends - performance.now() : ctx.deadline - Date.now());

export const hasTime = (ctx: ProbeContext, reserveMs: number) => reserveMs < timeLeft(ctx) && !ctx.signal.aborted;

export { guardStop } from './guard.js';

/** Longest wait, at a verdict, for the guard to decide the requests the page made (`GuardLog.settled`). */
export const GUARD_SETTLE_MS = 3000;
export const GUARD_UNSETTLED = 'the request guard was still checking requests the page made when the test had to decide, so it could not tell whether the page tried to send data';

/**
 * `guardStop` for what the guard stopped since `mark`, read once it has decided every request the
 * page had made by now: on a busy machine its decisions can arrive after the test's own steps, and a
 * request it stops is never missed. A guard that does not finish in time is a stop too.
 */
export async function settledStop(ctx: ProbeContext, mark: number): Promise<string | null> {
  const wait = Math.min(GUARD_SETTLE_MS, Math.max(0, timeLeft(ctx) - 1000));
  const settled = (await ctx.guard.settled?.(wait)) ?? true;
  return guardStop(ctx.guard.since(mark)) ?? (settled ? null : GUARD_UNSETTLED);
}

/**
 * The listener hook must be in the page (timers, sound sources, dialogs): without it these probes
 * would miss what they look for, so they report not_testable instead (`ctx.hooks()` throws).
 */
export async function requireHook(ctx: ProbeContext): Promise<void> {
  await ctx.hooks();
}

/** Resolves to the promise's value, or to `fallback` after `ms` (a frame that never finishes loading). */
export async function within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}
