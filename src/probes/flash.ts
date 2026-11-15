// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 Three Flashes or Below Threshold (Plan 4 Task 4.4): deep probe. Frames of the viewport,
// then the general-flash and red-flash analysis of `flashMath.ts`. What is filmed (2026-11-10: flashing
// that is over within seconds of arrival, or starts later, was never seen by a film that began after the
// page had loaded and only looked where something was already moving):
// - the top of the page from the moment the page starts: the test loads the page again while it films
//   (flashing that starts on arrival), and goes on for `ARRIVAL.afterLoadMs` once it has loaded;
// - what the page's own timers start (flashing that starts after a delay): timers the page set for up to
//   20 s ahead are run early, straight after the top is filmed, in the page's order and with the page's
//   own gaps (a timer that stops, 0.4 s later, what another started is run 0.4 s after it; repeating
//   timers keep their own time, and the group starts when their ticks fall where they would have). A
//   group that changes something on screen is filmed from its first timer; what cannot be run with the
//   page's timing kept is not testable (`runTimers`, `FLASH_TIMERS`);
// - places further down where moving content sits (animations, playing video, canvas, frames, animated
//   images; at most two), and places where the page watches for content to come into view (its
//   IntersectionObserver targets, read by the probe's init script): each is filmed from the moment it
//   comes into view, and one where nothing starts needs no more film (`FLASH_VIEW`);
// - animations that played where the film was not (further down, as the page arrived or when a timer
//   ran): played again where they sit, each for as long as it really ran (`FLASH_REPLAY`);
// - buttons that say they show or play something, each filmed from the click.
// Every limit above that is reached (more timers, places, animations or buttons than the test
// runs or films, or the time running out) is said in the result as not testable: what was not filmed
// is never clean. Timers under a second are not tracked (they run in the page's own time), and timers
// set for more than 20 s ahead are outside this test (the clean result says how many).
// The frames come from Chromium's screencast (CDP `Page.startScreencast`: small PNG frames pushed as the
// screen changes, a few dozen a second even on a remote browser), or, without a CDP session, from
// screenshots taken one after the other (then the page is not loaded again). Fewer than `FLASH.minFps`
// frames a second decide nothing: the page is then judged by the animation and media check
// (`flashMotion.ts`, not scored), which the report puts first only on such pages.
// Isolated: a fresh page, so nothing an earlier probe did (timers run early, controls clicked)
// changes what is on screen. Every scroll the test makes is instant (`instantScrollStart`), each place
// is filmed only once the window stands still there (`settleScroll`), and frames drawn while the window
// scrolled are dropped (`stillShots`): a page with smooth scrolling would otherwise be filmed racing
// past, and text moving by reads as flashing. A place that cannot be filmed still is not testable,
// never a failure. The test never makes a rate of its own: a group of timers is run with the page's own
// gaps, the next group only once the film of the one before has ended. Engine core: no Node-only imports.
import type { CDPSessionLike, PageLike } from '../types.js';
import { FLASH, type FlashFinding } from './flashMath.js';
import { isActionUrl } from './guard.js';
import { reloadPage } from './keyboard/traverse.js';
import type { Kit, KitBox, KitElement } from './kit.js';
import { MOTION_CONTEXT, SCROLL_SETTLE_MS, clickControl, hasTime, instantScrollStart, instantScrollStop, kitReady, scrollWatchStart, scrollWatchTake, settleScroll, startBlockedAutoplay, within } from './motionShared.js';
import { PixelFlashMeter, meterImage, type PixelFlashAnalysis } from './flashPixels.js';
import { decodePng } from './pixels.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext, type ProbeFinding } from './types.js';

/** Length of each capture and the frame rate aimed at. */
export const CAPTURE_MS = 3000;
export const TARGET_FPS = 30;
/** Grid cell (CSS px) for the analysis of animated images (`flashMotion.ts`): fine enough for a 25% share of a 10° field. */
export const FLASH_CELL = 16;
/** Places on the page captured besides the top. */
const MORE_PLACES = 2;

/**
 * The film of the page's first seconds, across the test's own load of it: how long it goes on once the page
 * has loaded and settled (the runner's settle wait is filmed too, so the top gets about 3 s after the load,
 * as before), the most frames kept (the meter's frame numbers are bytes) and the closest two may be. On a link
 * to the browser slower than `maxRoundTripMs` a call the page is not loaded again: such a link cannot bring
 * 8 frames a second either, so the test ends at once without a verdict, as before.
 */
export const ARRIVAL = { afterLoadMs: 2000, maxFrames: 250, minGapMs: 33, maxRoundTripMs: 500 } as const;
/**
 * The page's timers run early at the top, in the order and with the gaps the page set them (review r1, finding 1).
 * A group is the soonest timer and every timer due within `filmMs` of the one before it; the group is run as the
 * page would have run it, later (each timer its gap after the first), and filmed from its first timer until
 * `filmMs` after its last (longer than the one-second window the threshold counts in). `runs` groups are run and
 * `max` of them filmed (one that changes nothing a person could see needs no film); a group longer than `groupMs`
 * is not run. The page's repeating timers keep their own time, so a group starts at a moment when their ticks fall
 * where they would have (`phaseMs` either way), at most `waitMs` from now (the last `fineMs` of it on film), and a timer run more than `lateMs` late
 * throws the group's film away. What could not be run that way is said in the result (not testable), never
 * clean. Timers the page set for more than `maxDelayMs` ahead are outside this test.
 */
export const FLASH_TIMERS = { runs: 12, max: 4, maxDelayMs: 20_000, filmMs: 1300, groupMs: 4000, phaseMs: 40, lateMs: 60, waitMs: 2500, fineMs: 450 } as const;
/**
 * Places where the page watches for content to come into view. Each is filmed from the moment it comes into view
 * (`looks` places at most); after `lookMs` a place where nothing started and nothing keeps changing needs no more
 * film, and any other is filmed for `filmMs` in all (`places` of those at most). `minArea`: the smallest watched
 * element that takes a place (CSS px²; a tracking pixel or a lazy icon cannot flash a quarter of the 10° field).
 * A place beyond those limits is not measured: the result is then not testable (review r1, finding 11).
 */
export const FLASH_VIEW = { places: 4, looks: 16, lookMs: 350, filmMs: 2000, minArea: 10_000 } as const;
/**
 * Animations that played where the film was not (below the first screen as the page arrived, or when a timer ran):
 * how many places are filmed with them played again, and the shortest and longest such film. Places beyond that
 * are not measured (not testable).
 */
export const FLASH_REPLAY = { places: 4, minMs: 1300, maxMs: CAPTURE_MS } as const;
/** Buttons that say they show or play something: how many are pressed (the rest: not testable), and how long each is filmed from the click. */
export const FLASH_BUTTONS = { max: 4, filmMs: 1300 } as const;

/**
 * The probe's init script (runs in every frame before the page's own scripts). It remembers two things, and
 * changes nothing else (the observer and the animations work as before):
 * - the elements the page asks an IntersectionObserver to watch, so the test can film them coming into view
 *   (`watchedPlaces`);
 * - the CSS animations that start, as objects, with when: one that plays below the first screen as the page
 *   arrives (or when a timer runs) is over before the window can be moved there, so the test plays that same
 *   animation again from its start at its own place (`startedPlaces`, `replayStarted`).
 */
export const FLASH_INIT_SCRIPT = `(() => {
  try {
    if (window.__grntedWatched) return;
    const seen = [];
    Object.defineProperty(window, '__grntedWatched', { value: () => seen, configurable: true });
    const started = [];
    Object.defineProperty(window, '__grntedStarted', { value: () => started, configurable: true });
    document.addEventListener('animationstart', (e) => {
      try {
        const el = e.target;
        if (!el || typeof el.getAnimations !== 'function' || started.length >= 300) return;
        for (const a of el.getAnimations()) {
          if (a.animationName === e.animationName && !started.some((x) => x.a === a)) started.push({ a, el, name: e.animationName, at: performance.now() });
        }
      } catch (err) { /* the page's animation runs as it would */ }
    }, true);
    // When it ended or the page cancelled it: it is played again only for as long as it really ran.
    const over = (e) => {
      try {
        for (let i = started.length - 1; i >= 0; i--) {
          const x = started[i];
          if (x.el === e.target && x.name === e.animationName && x.ended === undefined) { x.ended = performance.now(); break; }
        }
      } catch (err) { /* nothing to record */ }
    };
    document.addEventListener('animationend', over, true);
    document.addEventListener('animationcancel', over, true);
    const IO = window.IntersectionObserver;
    if (!IO) return;
    const observe = IO.prototype.observe;
    IO.prototype.observe = function (el) {
      try { if (el && seen.length < 400 && seen.indexOf(el) < 0) seen.push(el); } catch (e) { /* keep the page's call */ }
      return observe.apply(this, arguments);
    };
  } catch (e) { /* the page keeps its own observer */ }
})();`;

/**
 * The screencast: frame size (CSS px are scaled down to this width; a 16 px cell is still 4 image px
 * at 1280 px), the closest two kept frames may be (at most 40 a second are decoded), the most frames
 * kept per capture, the largest frame accepted (base64 characters), and the time each CDP call may take.
 */
export const SCREENCAST = { width: 320, minGapMs: 25, maxFrames: 150, maxChars: 1_000_000, callMs: 5000 } as const;

/** Runs in the page: starts recording mutations, so flashPlaces can find what a script keeps restyling. */
function flashObserve(): void {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  kit.observe();
  kit.take();
}

/**
 * Runs in the page: new scroll positions (document y) where moving content sits below the first
 * screen, at most `more`, outside the top and the viewports already filmed (`have`); `left` counts the
 * moving content no place was left for. Content already moving takes the places first (running
 * animations, playing video, canvas, frames, animated images, what a script restyles); a muted
 * autoplay video the browser holds paused off screen (it plays once scrolled to) takes a place only
 * when one is left, and only when it has a frame to show. `calm`: scroll positions the test watched from the
 * moment they came into view, where nothing started; what was restyled there is not counted again.
 */
function flashPlaces(arg: { more: number; have?: number[]; calm?: number[] }): { places: number[]; height: number; left: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const h = innerHeight;
  const moving: KitBox[] = [];
  const later: KitBox[] = [];
  const add = (el: Element, to: KitBox[] = moving) => { if (kit.visible(el) && kit.area(el) >= 400) to.push(kit.box(el)); };
  for (const a of document.getAnimations()) {
    const t = (a.effect as KeyframeEffect | null)?.target;
    if (a.playState === 'running' && t) add(t);
  }
  for (const v of document.querySelectorAll('video')) {
    if (!v.paused) add(v);
    else if (v.autoplay && v.muted && !v.ended && v.readyState >= 2 && v.videoWidth > 0) add(v, later);
  }
  document.querySelectorAll('canvas, iframe, embed, object').forEach((el) => add(el));
  // SVG with SMIL animation (CSS-animated SVG is in getAnimations above); still icons are left out.
  for (const svg of document.querySelectorAll('svg')) if (svg.querySelector('animate, animateTransform, animateMotion, set')) add(svg);
  for (const img of document.images) if (/\.(gif|png|webp|apng)(\?|#|$)/i.test(img.currentSrc || img.src)) add(img);
  // Elements a script keeps restyling (a timer swapping colours): their style or class changed since
  // the test started recording (flashObserve), with no CSS animation to show for it.
  const restyled = new Set<Element>();
  for (const b of kit.take()) for (const r of b.records) if (r.type === 'attributes' && (r.attributeName === 'style' || r.attributeName === 'class') && r.target instanceof Element) restyled.add(r.target);
  kit.stop();
  // Not where the test already watched content come into view and saw it settle (`calm`: those scroll positions):
  // a class set once as it appeared is not something a script keeps restyling.
  const settled = (el: Element) => { const b = kit.box(el); return (arg.calm ?? []).some((p) => b.y + b.h > p && b.y < p + h); };
  restyled.forEach((el) => { if (!settled(el)) add(el); });
  // Viewports already covered: the top and the places filmed before.
  const covered = [0, ...(arg.have ?? [])];
  const fresh: number[] = [];
  const inView = (b: KitBox) => [...covered, ...fresh].some((p) => b.y >= p && b.y + Math.min(b.h, h) <= p + h);
  let left = 0;
  const place = (boxes: KitBox[], countLeft: boolean) => {
    for (const b of boxes.sort((p, q) => p.y - q.y)) {
      if (b.y + b.h <= h || inView(b)) continue;
      // Moving content beyond the places captured is counted, so the result can say so.
      if (fresh.length >= arg.more) { if (countLeft) left++; continue; }
      fresh.push(Math.max(0, Math.round(b.y - h / 4)));
    }
  };
  place(moving, true);
  place(later, true);
  return { places: fresh.sort((p, q) => p - q), height: document.documentElement.scrollHeight, left };
}

/**
 * Runs in the page: new scroll positions (document y) that bring into view the elements the page watches for
 * that (`FLASH_INIT_SCRIPT`), at most `more`, each with the watched element in the middle of the screen; `left`
 * counts the watched elements no place was left for. Not counted: an element at least half in a viewport already
 * filmed (`have`, and the top), one smaller than `minArea`, and images, pictures, video and frames (a lazy
 * picture loading is not content that starts; moving ones have their own places).
 */
function watchedPlaces(arg: { more: number; have: number[]; minArea: number }): { places: number[]; left: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const seen = (window as unknown as { __grntedWatched?: () => Element[] }).__grntedWatched?.() ?? [];
  const h = innerHeight;
  const root = document.scrollingElement || document.documentElement;
  const boxes: KitBox[] = [];
  for (const el of seen) {
    if (!el.isConnected || /^(IMG|PICTURE|VIDEO|IFRAME|SOURCE|EMBED|OBJECT)$/.test(el.tagName)) continue;
    // Content that waits to come into view is often transparent until it does.
    if (!kit.visible(el, true) || kit.area(el) < arg.minArea) continue;
    boxes.push(kit.box(el));
  }
  const fresh: number[] = [];
  const shownAt = (b: KitBox, p: number) => Math.max(0, Math.min(b.y + b.h, p + h) - Math.max(b.y, p)) >= Math.min(b.h, h) / 2;
  let left = 0;
  const limit = Math.max(0, root.scrollHeight - h);
  for (const b of boxes.sort((p, q) => p.y - q.y)) {
    if ([0, ...arg.have, ...fresh].some((p) => shownAt(b, p))) continue;
    if (fresh.length >= arg.more) { left++; continue; }
    // Where the window can really be put (the end of the page is as far as it goes).
    fresh.push(Math.max(0, Math.min(limit, Math.round(b.y + b.h / 2 - h / 2))));
  }
  return { places: fresh, left };
}

/** A place where animations that already played sit: which ones (indexes into the init script's list), and how long each ran. */
interface StartedPlace { y: number; ids: number[]; lives: number[]; ms: number }

/**
 * Runs in the page: where the CSS animations that started since `from` (an index into the init script's list)
 * and are over, or have an end, sit, when that is outside the viewports already filmed (`have`): at most `more`
 * scroll positions, each with its animations and how long each really ran (`lives`: until it ended or the page
 * cancelled it; for one still running, its own length), the longest being `ms`. Small elements (`minArea`) and
 * endless animations still running (moving content has its own places) are left out.
 */
function startedPlaces(arg: { from: number; more: number; have: number[]; minArea: number }): { places: StartedPlace[]; left: number; count: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const list = (window as unknown as { __grntedStarted?: () => { a: Animation; el: Element; at: number; ended?: number }[] }).__grntedStarted?.() ?? [];
  const h = innerHeight;
  const shownAt = (b: KitBox, p: number) => Math.max(0, Math.min(b.y + b.h, p + h) - Math.max(b.y, p)) >= Math.min(b.h, h) / 2;
  const places: (StartedPlace & { boxes: KitBox[] })[] = [];
  let left = 0;
  for (let i = arg.from; i < list.length; i++) {
    const { a, el, at: startedAt, ended } = list[i]!;
    let active = Infinity;
    try { active = Number((a.effect as KeyframeEffect | null)?.getComputedTiming().activeDuration ?? Infinity); } catch { active = Infinity; }
    // How long it really ran: to its end or its cancelling when that is known, else its own length.
    const life = ended !== undefined ? Math.min(active, Math.max(0, ended - startedAt)) : active;
    if (!el.isConnected || !Number.isFinite(life) || life <= 0 || !kit.visible(el, true) || kit.area(el) < arg.minArea) continue;
    const b = kit.box(el);
    if (arg.have.some((p) => shownAt(b, p))) continue;
    const at = places.find((p) => shownAt(b, p.y));
    if (at) { at.ids.push(i); at.lives.push(Math.round(life)); at.ms = Math.max(at.ms, life); continue; }
    if (places.length >= arg.more) { left++; continue; }
    places.push({ y: Math.max(0, Math.round(b.y + b.h / 2 - h / 2)), ids: [i], lives: [Math.round(life)], ms: life, boxes: [b] });
  }
  return { places: places.map(({ y, ids, lives, ms }) => ({ y, ids, lives, ms: Math.round(ms) })), left, count: list.length };
}

/**
 * Runs in the page: plays the listed animations again from their start (the same animation objects the page
 * made: seeked back, or played again when the page has let go of them), each for as long as it really ran
 * (`lives`, ms: one the page cancelled after 0.4 s is cancelled again after 0.4 s), or brings them to their end
 * (`finish`). Returns how many are running.
 */
function replayStarted(arg: { ids: number[]; lives?: number[]; finish?: boolean }): number {
  const list = (window as unknown as { __grntedStarted?: () => { a: Animation }[] }).__grntedStarted?.() ?? [];
  let running = 0;
  const stops: { a: Animation; at: number; done?: boolean }[] = [];
  arg.ids.forEach((i, k) => {
    const a = list[i]?.a;
    if (!a) return;
    try {
      if (arg.finish) { if (a.playState === 'running') a.finish(); return; }
      a.currentTime = 0;
      if ((a.playState as string) !== 'running') a.play();
      if ((a.playState as string) === 'running') {
        running++;
        const life = arg.lives?.[k];
        if (life !== undefined && Number.isFinite(life)) stops.push({ a, at: performance.now() + life });
      }
    } catch {
      // an animation that cannot be played again is left as it is
    }
  });
  if (stops.length) {
    const tick = () => {
      const now = performance.now();
      for (const x of stops) if (!x.done && now >= x.at) { x.done = true; try { if (x.a.playState === 'running') x.a.cancel(); } catch { /* it is over */ } }
      if (stops.some((x) => !x.done)) setTimeout(tick, 8);
    };
    setTimeout(tick, 8);
  }
  return running;
}

/** What one go at the page's timers came to. */
type TimerRun =
  /** Nothing is due: `later` timers are set for further ahead than this test runs. */
  | { kind: 'none'; later: number }
  /** A group is ready `ms` from now (`followers`: the timers that follow its first; `natural`: it is due then anyway). */
  | { kind: 'plan'; ms: number; followers: number; natural: boolean }
  /** The next group cannot be run with the page's timing kept; it is left to the page. */
  | { kind: 'blocked'; why: 'repeating' | 'chain' | 'dropped' }
  /**
   * The group ran: timers run, whether anything a person could see changed (`visible`), whether any of that is
   * on screen now (`inView`), where the list of started animations stood before, and how late the latest timer ran.
   */
  | { kind: 'ran'; fired: number; visible: boolean; inView: boolean; started: number; late: number; y?: number; timer?: number };

/**
 * Runs in the page: runs once more, now, the timer that repeats the code of `timer` (an interval, or a timeout the
 * page set again after the test ran it): the test has moved to where its changes are, to film them from their start.
 */
function rerunTimer(timer: number): boolean {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const p = kit.pending().find((x) => x.timer === timer && !x.string);
  return !!p && kit.fire(p.handle).ok;
}

/**
 * Runs in the page (async): the next group of the page's pending timers, run early with the page's own timing kept.
 *
 * The group: the soonest timer the page set for at most `maxDelay` ahead, and every one-off timer due within
 * `window` of the one before it (a group longer than `cap` is not run: "chain"). The first is run now, each other
 * its own gap after it, as the page would have, later. Timers that repeat (an interval; a timeout that sets itself
 * again once the test has run it) are never run in between: they keep their own time, so the group starts at a
 * moment when each of their ticks falls where it would have fallen after the group's first timer (`tol` either
 * way), or outside the film. A timer already due within `wait` is simply left to run by itself (everything is then
 * in the page's own time). No such moment within `wait`: "repeating", and the group is left to the page.
 *
 * `mode` "plan" only says when (`ms` from now); "go" waits up to `fine` ms for that moment and runs the group,
 * returning once its last timer has run; "drop" leaves the next group to the page. What ran says whether it
 * changed something a person could see (an element shown on the page was changed, an animation started, or a
 * video started to play). Its own observer, so the kit's record of what scripts restyle (`flashPlaces`) is kept.
 */
async function runTimers(arg: { mode: 'plan' | 'go' | 'drop'; maxDelay: number; window: number; cap: number; tol: number; wait: number; fine: number }): Promise<TimerRun> {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const w = window as unknown as { __grntedFlashTimers?: { done: Set<number>; chains: Map<number, { due: number; from: number }> } };
  const st = (w.__grntedFlashTimers ??= { done: new Set(), chains: new Map() });
  const clock = () => performance.now();
  const until = (t: number) => new Promise<void>((done) => { const look = () => (clock() >= t ? done() : setTimeout(look, 4)); look(); });
  const mod = (x: number, d: number) => ((x % d) + d) % d;
  const now = clock();
  const all = kit.pending().filter((p) => p.delay > 0);
  // A timeout the page set again after the test ran it early: it repeats, like an interval.
  const again = (p: { kind: string; timer: number; at: number }) => { const c = st.chains.get(p.timer); return p.kind === 'timeout' && !!c && p.at >= c.from - 1; };
  const due = (p: { kind: string; at: number; delay: number }, t: number) => (p.kind === 'interval' ? p.at + p.delay * Math.max(1, Math.ceil((t - p.at) / p.delay - 1e-9)) : p.at + p.delay);
  const starters = all.filter((p) => !st.done.has(p.handle) && !again(p));
  const soon = starters.filter((p) => p.delay <= arg.maxDelay).map((p) => ({ p, due: due(p, now) })).sort((a, b) => a.due - b.due);
  const first = soon[0];
  if (!first) return { kind: 'none', later: starters.length };
  const D = first.due;
  const block = (why: 'repeating' | 'chain' | 'dropped'): TimerRun => { st.done.add(first.p.handle); return { kind: 'blocked', why }; };
  if (arg.mode === 'drop') return block('dropped');
  // The one-off timers that follow, each within `window` of the one before.
  const oneOffs = all.filter((p) => p.kind === 'timeout' && !again(p) && p !== first.p).map((p) => ({ p, due: p.at + p.delay })).sort((a, b) => a.due - b.due);
  const followers: { p: (typeof all)[number]; off: number; due: number }[] = [];
  let span = 0;
  for (const t of oneOffs) {
    const off = t.due - D;
    if (off < 0) continue;
    if (off > span + arg.window) break;
    if (off > arg.cap - arg.window) return block('chain');
    followers.push({ p: t.p, off, due: t.due });
    span = off;
  }
  const film = span + arg.window;
  // Whether the page's other timers fall where they would have, were the group started at `t0`.
  const fits = (t0: number): boolean => {
    for (const t of oneOffs) {
      // One the page runs before the group (it is due sooner): never in the middle of the film.
      if (t.due < D && t.due >= t0 - arg.tol && t.due <= t0 + film + arg.tol) return false;
    }
    for (const p of all) {
      const same = p === first.p;
      if (!(p.kind === 'interval' || again(p)) || (same && p.kind !== 'interval')) continue;
      const d = p.delay;
      // Where its ticks fall in the page's own time, and where they fall now.
      const paged = p.kind === 'interval' ? p.at : st.chains.get(p.timer)!.due;
      const real = p.kind === 'interval' ? p.at : p.at + p.delay;
      // Its first tick after the group's first timer: as the page would have had it, and as it will be.
      const would = same ? d : mod(paged - D, d);
      const will = mod(real - t0, d);
      if (Math.abs(would - will) <= arg.tol) continue;
      if (would > film && will > film + arg.tol) continue;
      return false;
    }
    return true;
  };
  let at = -1;
  const natural = D - now <= arg.wait;
  for (let wait = 0; wait <= arg.wait && now + wait < D - 30; wait += 10) if (fits(now + wait)) { at = wait; break; }
  // Due by itself within the wait: left to the page, everything in its own time.
  const own = at < 0 && natural;
  if (at < 0 && !own) return block('repeating');
  const ms = own ? Math.max(0, D - now - 40) : at;
  if (arg.mode === 'plan' || ms > arg.fine) return { kind: 'plan', ms: Math.round(ms), followers: followers.length, natural: own };

  // Go.
  const started = (window as unknown as { __grntedStarted?: () => unknown[] }).__grntedStarted?.().length ?? 0;
  const runningNow = () => { try { return document.getAnimations().filter((a) => a.playState === 'running'); } catch { return [] as Animation[]; } };
  const playingNow = () => [...document.querySelectorAll('video')].filter((v) => !v.paused);
  const before = { running: new Set(runningNow()), playing: new Set(playingNow()) };
  const touched = new Set<Element>();
  // The screencast's own mark (`tickerStart`) is the test's, not the page's.
  const mark = () => (window as unknown as { __grntedTicker?: { el: Element } }).__grntedTicker?.el;
  const note = (records: MutationRecord[]) => {
    const own = mark();
    for (const r of records) {
      const el = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!el || el === own || el === document.documentElement) continue;
      // The mark being put in or taken out is a change of the root's children only.
      if (touched.size < 400) touched.add(el);
    }
  };
  const mo = new MutationObserver(note);
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  let fired = 0;
  let late = 0;
  try {
    if (ms > 0) await until(now + ms);
    // The browser was busy and the moment passed: nothing is run, and the test plans again.
    if (!own && clock() - (now + ms) > arg.tol / 2) return { kind: 'plan', ms: 0, followers: followers.length, natural: false };
    if (own) {
      // The page runs them itself.
      await until(D + span + 30);
      fired = [first.p, ...followers.map((f) => f.p)].filter((p) => p.kind === 'interval' || !kit.pending().some((q) => q.handle === p.handle)).length;
      st.done.add(first.p.handle);
    } else {
      if (!kit.pending().some((q) => q.handle === first.p.handle)) { st.done.add(first.p.handle); return { kind: 'ran', fired: 0, visible: false, inView: false, started, late: 0 }; }
      const t0 = clock();
      const run = (p: (typeof all)[number], paged: number) => {
        if (p.kind === 'timeout' && !st.chains.has(p.timer)) st.chains.set(p.timer, { due: paged, from: clock() });
        st.done.add(p.handle);
        if (kit.fire(p.handle).ok) fired++;
      };
      run(first.p, D);
      for (const f of followers) {
        await until(t0 + f.off);
        late = Math.max(late, clock() - (t0 + f.off));
        // One the page cleared in the meantime is not run: the page would not have run it either.
        if (kit.pending().some((q) => q.handle === f.p.handle)) run(f.p, f.due);
      }
      // Code given as text runs a moment later.
      await until(clock() + 30);
    }
  } finally {
    note(mo.takeRecords());
    mo.disconnect();
  }
  const onScreen = (el: Element | null | undefined) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const changed = [...touched].filter((el) => el.isConnected && kit.visible(el, true));
  const newRunning = runningNow().filter((a) => !before.running.has(a));
  const newPlaying = playingNow().filter((v) => !before.playing.has(v));
  const startedNow = ((window as unknown as { __grntedStarted?: () => unknown[] }).__grntedStarted?.().length ?? 0) > started;
  const inView = changed.some(onScreen) || newPlaying.some(onScreen) || newRunning.some((a) => onScreen((a.effect as KeyframeEffect | null)?.target));
  // Where the largest thing it changed is, when none of it is on screen: the window can be put there.
  let y: number | undefined;
  if (!inView && changed.length) {
    const big = changed.map((el) => kit.box(el)).sort((a, b) => b.w * b.h - a.w * a.h)[0]!;
    const root = document.scrollingElement || document.documentElement;
    y = Math.max(0, Math.min(Math.max(0, root.scrollHeight - innerHeight), Math.round(big.y + Math.min(big.h, innerHeight) / 2 - innerHeight / 2)));
  }
  return {
    kind: 'ran', fired, started, late: Math.round(late), inView, timer: first.p.timer, ...(y !== undefined ? { y } : {}),
    visible: changed.length > 0 || newRunning.length > 0 || newPlaying.length > 0 || startedNow,
  };
}

/**
 * Runs in the page (async): watches a place for `ms` from the moment it came into view, and says whether it
 * stayed quiet, so that no more film of it is needed: no animation started (a CSS one since `from`, an index into
 * the init script's list, or any other, transitions aside, that is running now and was not before), nothing that draws
 * by itself is on screen (a canvas, video, frame, plug-in or animated picture), and what changed on the page
 * changed at no more than three moments, none in the last third of the look. Content that only appears (a fade
 * set by a transition, a class added once) is quiet.
 */
async function quietAfterView(arg: { from: number; ms: number; anywhere?: boolean }): Promise<{ quiet: boolean }> {
  const count = () => (window as unknown as { __grntedStarted?: () => unknown[] }).__grntedStarted?.().length ?? 0;
  // A transition is one change from one look to another: it cannot flash by itself, and is not counted.
  const running = () => { try { return document.getAnimations().filter((a) => a.playState === 'running' && !/Transition/.test(a.constructor?.name ?? '')).length; } catch { return 0; } };
  const before = running();
  const moments: number[] = [];
  // The screencast's own mark (`tickerStart`) is the test's, not the page's.
  const mark = () => (window as unknown as { __grntedTicker?: { el: Element } }).__grntedTicker?.el;
  const mo = new MutationObserver((records) => {
    const own = mark();
    if (!records.some((r) => r.target !== own && r.target !== document.documentElement)) return;
    const t = performance.now();
    if (!moments.length || t - moments[moments.length - 1]! > 30) moments.push(t);
  });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const t0 = performance.now();
  await new Promise<void>((done) => { const look = () => (performance.now() >= t0 + arg.ms ? done() : setTimeout(look, 16)); look(); });
  mo.disconnect();
  const onScreen = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  // `anywhere`: the look is at changes off screen, so what draws on screen says nothing about them.
  const draws = !arg.anywhere && ([...document.querySelectorAll('canvas, video, iframe, embed, object')].some(onScreen)
    || [...document.querySelectorAll('svg')].some((el) => !!el.querySelector('animate, animateTransform, animateMotion, set') && onScreen(el))
    || [...document.images].some((img) => /\.(gif|webp|apng)(\?|#|$)/i.test(img.currentSrc || img.src) && onScreen(img)));
  const calm = moments.length <= 3 && !moments.some((t) => t > t0 + (arg.ms * 2) / 3);
  return { quiet: count() <= arg.from && running() <= before && !draws && calm };
}

/** Runs in the page: how many CSS animations the init script has seen start. */
function startedCount(): number {
  return (window as unknown as { __grntedStarted?: () => unknown[] }).__grntedStarted?.().length ?? 0;
}

/** A button's name starts with one of these: it says it shows, plays or starts something. */
const SHOWS = /^(?:show|play|start|view|open|watch|launch|reveal|animate|preview|display|run|try|see|replay|celebrate)\b/i;
/** Names never clicked (as the motion test's): the visitor's account, money, messages or data. */
const NEVER_CLICK = /account|subscri|membership|trial|profile|order|\bpay|billing|donat|purchas|checkout|\bcart\b|cancel|delete|remov|log ?(?:in|out)|sign ?(?:in|out|up)|password|e-?mails?\b|notification|newsletter|sharing|\bshare\b|alert|delivery|shipment|download|print|submit|send|search|apply|register|book\b/i;

/**
 * Runs in the page: visible buttons whose short name says they show, play or start something, in document order,
 * at most `max` (`more`: the ones left over). Never a link (it goes somewhere), a form's submit button, a disabled
 * button, or a name about the visitor's account, money or data.
 */
function showButtons(arg: { shows: string; never: string; max: number }): { buttons: KitElement[]; more: number } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const shows = new RegExp(arg.shows, 'i');
  const never = new RegExp(arg.never, 'i');
  const out: KitElement[] = [];
  // Every such button counts, also one that looks and reads like another (review r2, finding 1: two "Play preview"
  // buttons may start different things). Those beyond `max` are counted in `more`, and the result then says so.
  let more = 0;
  for (const el of document.querySelectorAll('button, input[type="button"], [role="button"]')) {
    if (!kit.visible(el) || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('a[href], form') || el.hasAttribute('href')) continue;
    const name = kit.name(el).replace(/\s+/g, ' ').trim();
    if (!name || name.split(' ').length > 5 || !shows.test(name) || never.test(name)) continue;
    if (out.length >= arg.max) { more++; continue; }
    out.push(kit.describe(el));
  }
  return { buttons: out, more };
}

/** Runs in the page: where the window is, when this document was first answered (epoch ms; 0 when unknown), and the browser's clock now. */
function documentStart(): { x: number; y: number; answered: number; now: number } {
  let answered = 0;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.responseStart > 0) answered = performance.timeOrigin + nav.responseStart;
  } catch {
    answered = 0;
  }
  return { x: Math.round(scrollX), y: Math.round(scrollY), answered, now: Date.now() };
}

/**
 * Runs in the page: the element under the flashing area (its CSS path): of the elements at the
 * flashing cells' centres (viewport points) and their ancestors, the deepest one that holds at least
 * half of them. Not an ancestor that happens to hold one point: a flashing banner is named, not the
 * footer around it. Null when only the page itself (body, html) holds them.
 */
export function flashTarget(arg: { points: { x: number; y: number }[] }): string | null {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const counts = new Map<Element, number>();
  const depth = new Map<Element, number>();
  let hits = 0;
  for (const p of arg.points) {
    const el = document.elementFromPoint(p.x, p.y);
    if (!el) continue;
    hits++;
    const chain: Element[] = [];
    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) chain.push(e);
    chain.forEach((e, i) => { counts.set(e, (counts.get(e) ?? 0) + 1); depth.set(e, chain.length - i); });
  }
  let best: Element | null = null;
  for (const [e, n] of counts) if (n * 2 >= hits && (!best || depth.get(e)! > depth.get(best)!)) best = e;
  return best ? kit.describe(best).path : null;
}

/** Screenshots for `ms` at up to `fps` per second; times are the middle of each capture. */
async function capture(page: PageLike, ms: number, fps: number, ctx: ProbeContext): Promise<{ t: number; bytes: Uint8Array }[] | null> {
  const frames: { t: number; bytes: Uint8Array }[] = [];
  const gap = 1000 / fps;
  const start = Date.now();
  while (Date.now() - start < ms && !ctx.signal.aborted && frames.length < SCREENCAST.maxFrames) {
    const t0 = Date.now();
    let bytes: Uint8Array;
    try {
      bytes = await page.screenshot({ type: 'png' });
    } catch {
      return null;
    }
    const t1 = Date.now();
    frames.push({ t: (t0 + t1) / 2, bytes });
    const wait = gap - (t1 - t0);
    if (wait > 1) await page.waitForTimeout(wait);
  }
  return frames;
}

/**
 * Runs in the page: a 2 px mark in the bottom right corner that changes shade on every animation frame
 * (black to almost black, far below any flash), so the screencast keeps sending frames at the rate it
 * can, also while the page itself is still. Removed by `tickerStop`.
 */
function tickerStart(): boolean {
  const w = window as unknown as { __grntedTicker?: { el: HTMLElement; on: boolean } };
  if (w.__grntedTicker) return true;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;background:#000';
  document.documentElement.append(el);
  const t = { el, on: false };
  w.__grntedTicker = t;
  const step = () => {
    if (w.__grntedTicker !== t) return;
    t.on = !t.on;
    el.style.background = t.on ? '#010101' : '#000';
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
}

/** Runs in the page: removes the screencast's mark. */
function tickerStop(): void {
  const w = window as unknown as { __grntedTicker?: { el: HTMLElement } };
  w.__grntedTicker?.el.remove();
  delete w.__grntedTicker;
}

interface ScreencastFrameEvent { data?: unknown; sessionId?: unknown; metadata?: { timestamp?: unknown; scrollOffsetX?: unknown; scrollOffsetY?: unknown } }

/** A captured frame: its time (ms), and the window's scroll position it shows when the browser says (CSS px). */
export interface Shot { t: number; bytes: Uint8Array; sx?: number; sy?: number }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One screencast session per run: frames go to the capture running at the time (every frame is acked). */
export class Screencast {
  private sink: ((t: number, data: string, sx?: number, sy?: number) => void) | null = null;
  constructor(private readonly cdp: CDPSessionLike) {
    cdp.on('Page.screencastFrame', ((e: ScreencastFrameEvent) => {
      if (typeof e?.sessionId === 'number') void this.cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
      const ts = e?.metadata?.timestamp;
      const t = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts * 1000 : Date.now();
      if (typeof e?.data === 'string') this.sink?.(t, e.data, num(e?.metadata?.scrollOffsetX), num(e?.metadata?.scrollOffsetY));
    }) as (params: never) => void);
  }

  /**
   * Frames for `ms` (times are the compositor's), at most `SCREENCAST.maxFrames`, none closer than
   * `minGapMs`; null when the screencast could not start. Every CDP call is time-boxed. Each frame
   * carries the window's scroll position the compositor drew it at, when it says.
   */
  async capture(
    page: PageLike, ms: number | (() => number), viewport: { width: number; height: number }, ctx: ProbeContext,
    opts: { during?: () => Promise<void>; maxFrames?: number; minGapMs?: number } = {},
  ): Promise<{ t: number; data: string; sx?: number; sy?: number }[] | null> {
    const frames: { t: number; data: string; sx?: number; sy?: number }[] = [];
    const maxFrames = opts.maxFrames ?? SCREENCAST.maxFrames;
    const minGap = opts.minGapMs ?? SCREENCAST.minGapMs;
    let last = -Infinity;
    this.sink = (t, data, sx, sy) => {
      if (frames.length >= maxFrames || data.length > SCREENCAST.maxChars || t - last < minGap) return;
      last = t;
      frames.push({ t, data, ...(sx !== undefined ? { sx } : {}), ...(sy !== undefined ? { sy } : {}) });
    };
    const scale = SCREENCAST.width / Math.max(1, viewport.width);
    try {
      await within(SCREENCAST.callMs, page.evaluate(tickerStart, undefined), false);
      const started = await within(SCREENCAST.callMs, this.cdp.send('Page.startScreencast', {
        format: 'png', maxWidth: SCREENCAST.width, maxHeight: Math.ceil(viewport.height * scale) + 1, everyNthFrame: 1,
      }).then(() => true), false);
      if (!started) return null;
      // What the film is of (a scroll, a click, the page loading again) happens once it has started.
      if (opts.during) await opts.during();
      const end = Date.now() + (typeof ms === 'function' ? ms() : ms);
      while (Date.now() < end && !ctx.signal.aborted) await page.waitForTimeout(Math.min(250, Math.max(1, end - Date.now())));
      return frames;
    } finally {
      this.sink = null;
      await within(SCREENCAST.callMs, this.cdp.send('Page.stopScreencast'), undefined);
      await within(SCREENCAST.callMs, page.evaluate(tickerStop, undefined), undefined);
    }
  }
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const EMPTY = new Uint8Array(0);
const same = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Meters the frames pixel by pixel (`PixelFlashMeter`), at no more than the screencast's width: a
 * screenshot (the fallback without a CDP session) is downscaled to it first, so the meter's memory
 * stays the same whatever the viewport. An identical frame is not decoded again.
 */
async function measure(shots: Shot[], viewport: { width: number; height: number }, maxFrames: number = SCREENCAST.maxFrames): Promise<PixelFlashAnalysis | null> {
  let meter: PixelFlashMeter | null = null;
  let cssPx = 1;
  let prev: Uint8Array | null = null;
  const t0 = shots[0]?.t ?? 0;
  for (const s of shots.slice(0, maxFrames)) {
    // Each screenshot is dropped once used; only the last one is kept, for the comparison.
    const bytes = s.bytes;
    s.bytes = EMPTY;
    if (meter && prev && same(prev, bytes)) {
      meter.add(s.t - t0, null);
      continue;
    }
    const img = meterImage(await decodePng(bytes), SCREENCAST.width);
    if (!meter) {
      meter = new PixelFlashMeter(img.width, img.height, maxFrames);
      cssPx = viewport.width / img.width;
    }
    if (img.width !== meter.width || img.height !== meter.height) return null;
    meter.add(s.t - t0, img);
    prev = bytes;
  }
  return meter ? meter.analyse(viewport, cssPx) : null;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * The page's result from its captures: a capture at `minFps` frames per second or fewer cannot show
 * the threshold, so it decides nothing (not even a flash it seems to show); otherwise any flash fails.
 */
export function flashDecision(places: readonly { fps: number; flashes: number }[]): 'not_testable' | 'failed' | 'no_failures_found' {
  if (places.some((p) => p.fps <= FLASH.minFps)) return 'not_testable';
  return places.some((p) => p.flashes > 0) ? 'failed' : 'no_failures_found';
}

/**
 * The frames of a capture that show the place it was made for. With the scroll position of every
 * frame (the screencast says where the compositor drew it), the longest run of frames drawn at `at`;
 * without it, every frame when the window never scrolled during the capture, and none when it did. A
 * page that scrolls while it is filmed shows content moving past, which can look like flashing.
 */
export function stillShots<T extends { sx?: number; sy?: number }>(shots: readonly T[], at: { x: number; y: number }, moved: boolean): T[] {
  if (shots.length && shots.every((s) => s.sy !== undefined)) {
    let best = { from: 0, to: 0 };
    let from = 0;
    for (let i = 0; i <= shots.length; i++) {
      const s = shots[i];
      const here = !!s && Math.abs(s.sy! - at.y) <= 1 && (s.sx === undefined || Math.abs(s.sx - at.x) <= 1);
      if (here) continue;
      if (i - from > best.to - best.from) best = { from, to: i };
      from = i + 1;
    }
    return shots.slice(best.from, best.to);
  }
  return moved ? [] : [...shots];
}

/** "at 120,3016 on the page": the flashing area's top left, in page coordinates. */
function flashText(f: FlashFinding, at: { x: number; y: number }): string {
  const share = Math.min(1, f.share);
  const what = f.kind === 'red' ? 'red flashing' : 'flashing';
  const change = f.kind === 'red' ? 'changes to or from saturated red' : 'changes of brightness';
  return `${what}: ${f.transitions} ${change} in one second (more than three flashes) over ${pct(share)} of a 10° field of view (more than 25% fails), at ${Math.round(f.spot.x + at.x)},${Math.round(f.spot.y + at.y)} on the page`;
}

const notTestable = (detail: string): ProbeFinding => ({ criterion: '2.3.1', status: 'not_testable', detail });

/** Where the window is when a film starts (its frames are the ones drawn there); `skip`: nothing came of the action, so nothing is filmed; `ms`: film this much longer, not the usual length. */
type FilmAt = { x: number; y: number; skip?: boolean; ms?: number };

/** What a film was of, for its findings and for the frames that count. */
interface FilmOf {
  /** Frames before this moment (epoch ms, the browser's clock) are of the document before (the test's own load). */
  from?: number;
  /** From this moment the screen is redrawn every frame (the test's mark runs): the frame rate is read from here. */
  steadyFrom?: number;
  maxFrames?: number;
  /** Said after a finding's place: what started the flashing. */
  when?: string;
  /** Why this place could not be filmed, when the page scrolled by itself. */
  where: string;
}

/** The capture itself (`flashProbe.run`, with every scroll instant). */
async function flashRun(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page, viewport } = ctx;
  const findings: ProbeFinding[] = [];
  const skipped: string[] = [];
  const skip = (why: string) => { if (!skipped.includes(why)) skipped.push(why); };
  let slowest = Infinity;
  const captured: { fps: number; flashes: number }[] = [];
  /** One finding per kind of flash and flashing element (the same flasher is in several films). */
  const reported = new Set<string>();
  // The screencast when the browser has a CDP session; screenshots otherwise (or when it sends nothing).
  const cdp = ctx.cdp ? await within(SCREENCAST.callMs, ctx.cdp(), undefined) : undefined;
  let cast: Screencast | null = cdp ? new Screencast(cdp) : null;
  let method: 'screencast' | 'screenshots' = cast ? 'screencast' : 'screenshots';

  /**
   * One film of `ms` from the moment `act` has run. With the screencast, `act` runs once filming has started, so
   * what it starts (a scroll into view, a click, the page loading again) is on film from its first frame; with
   * screenshots it runs first. `act` says where the window then is; null: it is not where the test moved it.
   */
  const film = async (ms: number, act: () => Promise<FilmAt | null>, limits: { maxFrames?: number; minGapMs?: number } = {}): Promise<{ shots: Shot[]; at: FilmAt; moved: boolean } | 'unsettled' | 'skipped'> => {
    let at: FilmAt | null = null;
    let acted = false;
    const during = async () => {
      at = await act();
      acted = true;
      if (at && !at.skip) await page.evaluate(scrollWatchStart, undefined).catch(() => undefined);
    };
    const span = () => (at && !at.skip ? (at.ms ?? ms) : 0);
    let shots: Shot[] | null = null;
    if (cast) {
      const frames = await cast.capture(page, span, viewport, ctx, { during, ...limits });
      if (frames && frames.length >= 2) shots = frames.map((f) => ({ t: f.t, bytes: fromBase64(f.data), ...(f.sx !== undefined ? { sx: f.sx } : {}), ...(f.sy !== undefined ? { sy: f.sy } : {}) }));
      else if (!acted || span()) { cast = null; method = 'screenshots'; }
    }
    if (!acted) await during();
    const where = at as FilmAt | null;
    if (!where) return 'unsettled';
    if (where.skip) return 'skipped';
    shots ??= await capture(page, where.ms ?? ms, TARGET_FPS, ctx);
    const watch = await page.evaluate(scrollWatchTake, undefined).catch(() => ({ moved: true, x: where.x, y: where.y }));
    if (!shots || shots.length < 2) throw new ProbeNotTestable('the browser could not take screenshots, so flashing could not be measured');
    return { shots, at: where, moved: watch.moved };
  };

  /** Meters a film and adds its findings. False when it had less than a second of frames of its place. */
  const judge = async (f: { shots: Shot[]; at: FilmAt; moved: boolean }, of: FilmOf): Promise<boolean> => {
    const mine = of.from ? f.shots.filter((x) => x.t >= of.from!) : f.shots;
    // Only frames of this place, at least a second of them (the threshold is per second).
    const still = stillShots(mine.length >= 2 ? mine : f.shots, f.at, f.moved);
    if (still.length < 2 || still[still.length - 1]!.t - still[0]!.t < FLASH.window) {
      skip(`the page scrolled by itself while the test filmed ${of.where}, so flashing there could not be measured`);
      return false;
    }
    // While a page loads the screen is only redrawn when it changes: the frame rate is that of the part the test's mark kept redrawing.
    const steady = of.steadyFrom ? still.filter((x) => x.t >= of.steadyFrom!) : still;
    const steadyMs = steady.length >= 2 ? steady[steady.length - 1]!.t - steady[0]!.t : 0;
    const a = await measure(still, viewport, of.maxFrames);
    if (!a) throw new ProbeNotTestable('the frames of the screen changed size while the test filmed it, so flashing could not be measured');
    const fps = of.steadyFrom && steadyMs > 0 ? Math.round(((steady.length - 1) * 10_000) / steadyMs) / 10 : a.fps;
    slowest = Math.min(slowest, fps);
    captured.push({ fps, flashes: (a.general ? 1 : 0) + (a.red ? 1 : 0) });
    const found = [a.general, a.red].filter((x): x is FlashFinding => !!x);
    // The element under the flashing area, read where it was filmed.
    const back = found.length ? await page.evaluate(settleScroll, { y: f.at.y, maxMs: SCROLL_SETTLE_MS }).catch(() => null) : null;
    for (const x of found) {
      const target = back?.settled && back.y === f.at.y && back.x === f.at.x ? await page.evaluate(flashTarget, { points: x.points }).catch(() => null) : null;
      const key = `${x.kind}|${target ?? `${Math.round((x.spot.x + f.at.x) / 64)},${Math.round((x.spot.y + f.at.y) / 64)}`}`;
      if (reported.has(key)) continue;
      reported.add(key);
      findings.push({ criterion: '2.3.1', status: 'failed', ...(target ? { target } : {}), detail: `${flashText(x, f.at)}${of.when ? `, ${of.when}` : ''}` });
    }
    return true;
  };

  const settleAt = async (y: number): Promise<FilmAt | null> => {
    const at = await page.evaluate(settleScroll, { y, maxMs: SCROLL_SETTLE_MS });
    return at.settled ? { x: at.x, y: at.y } : null;
  };
  const tooSlow = () => {
    const what = method === 'screencast' ? 'frames' : 'screenshots';
    return new ProbeNotTestable(`the browser sent only ${Math.round(slowest * 10) / 10} ${what} per second (more than ${FLASH.minFps} needed), too few to count flashes; the animation and media check judges this page instead`);
  };
  /** Viewports filmed (the window's scroll position of each). */
  const seen: number[] = [];

  // 1. The top of the page. With the screencast, from the moment the page starts: the test loads it again while
  //    it films, so flashing that is over within seconds of arrival is on film. (A page whose address looks like
  //    an action is never loaded twice; without a screencast the top is filmed as it stands.)
  const address = page.url?.() ?? ctx.url;
  const asked = Date.now();
  await page.evaluate(() => 0, undefined).catch(() => 0);
  const roundTripMs = Date.now() - asked;
  const arrival = !!cast && !isActionUrl(address) && roundTripMs <= ARRIVAL.maxRoundTripMs && hasTime(ctx, ARRIVAL.afterLoadMs + 20_000);
  let from = 0;
  let steadyFrom = 0;
  if (!arrival) {
    await page.evaluate(startBlockedAutoplay, undefined);
    await page.evaluate(flashObserve, undefined);
    await page.waitForTimeout(300);
  }
  const top = await film(arrival ? ARRIVAL.afterLoadMs : CAPTURE_MS, async () => {
    if (arrival) {
      // Throws when the page cannot be loaded again: the test then has no verdict (the runner says why).
      await reloadPage(ctx, address);
      await kitReady(page);
      await page.evaluate(instantScrollStart, undefined);
      await within(SCREENCAST.callMs, page.evaluate(tickerStart, undefined), false);
      const st = await page.evaluate(documentStart, undefined).catch(() => null);
      from = st?.answered ?? 0;
      steadyFrom = st?.now ?? 0;
      // Media the browser held back, as a browser that allows autoplay would play it; what scripts restyle from here on.
      await page.evaluate(startBlockedAutoplay, undefined);
      await page.evaluate(flashObserve, undefined);
    }
    const at = await settleAt(0);
    if (at && !arrival) await page.waitForTimeout(150);
    return at;
  }, arrival ? { maxFrames: ARRIVAL.maxFrames, minGapMs: ARRIVAL.minGapMs } : {});
  if (top === 'unsettled') skip('the window did not stay where the test moved it (0 px down), so flashing there could not be measured');
  else if (top !== 'skipped') {
    seen.push(top.at.y);
    await judge(top, { where: 'the top of the page', ...(arrival && from ? { from } : {}), ...(arrival && steadyFrom ? { steadyFrom } : {}), ...(arrival ? { maxFrames: ARRIVAL.maxFrames } : {}) });
    // Too few frames a second decide nothing, whatever else would be filmed: the other check judges the page.
    if (captured.length && flashDecision(captured) === 'not_testable') {
      ctx.setData?.({ method, fps: Number.isFinite(slowest) ? slowest : 0, places: captured.length, arrival });
      throw tooSlow();
    }
  }
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  // Animations that played where the film was not (below the first screen as the page arrived; further down when
  // a timer ran) are over by now: each such place is filmed with those same animations played again from their
  // start, each for as long as it really ran.
  let replays = 0;
  let replaysLeft = 0;
  const replay = async (place: StartedPlace, when: string): Promise<void> => {
    const f = await film(Math.max(FLASH_REPLAY.minMs, Math.min(FLASH_REPLAY.maxMs, place.ms + 300)), async () => {
      const at = await settleAt(place.y);
      if (!at) return null;
      const running = await page.evaluate(replayStarted, { ids: place.ids, lives: place.lives }).catch(() => 0);
      return { ...at, skip: !running };
    });
    await page.evaluate(replayStarted, { ids: place.ids, finish: true }).catch(() => 0);
    if (f === 'unsettled') return skip(`the window did not stay where the test moved it (${place.y} px down), so flashing there could not be measured`);
    if (f === 'skipped') return skip(`an animation that played ${place.y} px down the page could not be played again, so it was not filmed`);
    replays++;
    await judge(f, { where: `it ${f.at.y} px down`, when });
  };
  const replayAll = async (found: { places: StartedPlace[]; left: number } | null, when: string): Promise<void> => {
    for (const [i, place] of (found?.places ?? []).entries()) {
      if (replays >= FLASH_REPLAY.places || !hasTime(ctx, FLASH_REPLAY.maxMs + SCROLL_SETTLE_MS + 6000)) { replaysLeft += found!.places.length - i; break; }
      await replay(place, when);
    }
    replaysLeft += found?.left ?? 0;
  };
  const topOk = top !== 'unsettled' && top !== 'skipped';
  // What played as the page arrived is read now, before the page's timers are run (they start animations too).
  const played = arrival && topOk ? await page.evaluate(startedPlaces, { from: 0, more: FLASH_REPLAY.places, have: seen, minArea: FLASH_VIEW.minArea }).catch(() => null) : null;

  // 2. What the page's own timers start (flashing that begins some seconds after arrival). They are run early,
  //    straight after the top is filmed, in the page's order and with the page's gaps (`runTimers`): a timer that
  //    stops, 0.4 s later, what another started is run 0.4 s after it. A group that changed something on screen
  //    is filmed from its first timer to `filmMs` after its last; the next is run only once that film has ended,
  //    so the test never makes a rate of its own. What cannot be run that way is not testable, never clean.
  let timersRun = 0;
  let timerFilms = 0;
  let timersLater = 0;
  if (topOk) {
    const timing = { maxDelay: FLASH_TIMERS.maxDelayMs, window: FLASH_TIMERS.filmMs, cap: FLASH_TIMERS.groupMs, tol: FLASH_TIMERS.phaseMs, wait: FLASH_TIMERS.waitMs, fine: FLASH_TIMERS.fineMs };
    const groupFrames = Math.ceil((FLASH_TIMERS.groupMs + FLASH_TIMERS.filmMs + FLASH_TIMERS.fineMs) / SCREENCAST.minGapMs) + 20;
    const kept = { repeating: 0, chain: 0, dropped: 0, late: 0, stirred: 0 };
    const timerTime = () => hasTime(ctx, FLASH_TIMERS.groupMs + FLASH_TIMERS.filmMs + SCROLL_SETTLE_MS + 6000);
    let open = true;
    let slips = 0;
    for (let runs = 0; runs < FLASH_TIMERS.runs && timerFilms < FLASH_TIMERS.max && timerTime(); ) {
      const plan = await page.evaluate(runTimers, { mode: 'plan' as const, ...timing }).catch(() => null);
      if (!plan || plan.kind === 'none') { timersLater = plan?.later ?? 0; open = false; break; }
      if (plan.kind === 'blocked') { kept[plan.why]++; runs++; continue; }
      if (plan.kind !== 'plan') break;
      // Several timers, or one left to the page, are filmed in one piece while they run: that takes the screencast.
      if ((plan.followers > 0 || plan.natural) && !cast) {
        await page.evaluate(runTimers, { mode: 'drop' as const, ...timing }).catch(() => null);
        kept.dropped++;
        runs++;
        continue;
      }
      // The last quarter second or so is waited in the page, on film, so the film has started when the group does.
      if (plan.ms > 300) await page.waitForTimeout(plan.ms - 250);
      const got: { ran: TimerRun | null } = { ran: null };
      const f = await film(FLASH_TIMERS.filmMs, async () => {
        const at = await settleAt(top.at.y);
        if (!at) return null;
        const ran = await page.evaluate(runTimers, { mode: 'go' as const, ...timing }).catch(() => null);
        got.ran = ran;
        return ran?.kind === 'ran' && ran.visible && ran.inView && ran.late <= FLASH_TIMERS.lateMs ? at : { ...at, skip: true };
      }, { maxFrames: groupFrames });
      const ran = got.ran;
      if (f === 'unsettled' || !ran) { skip('the window did not stay at the top of the page, so what the page’s timers start could not be filmed'); break; }
      if (ran.kind === 'plan') {
        // The moment passed (the browser was busy): planned again, a few times.
        if (++slips <= 3) continue;
        await page.evaluate(runTimers, { mode: 'drop' as const, ...timing }).catch(() => null);
        kept.repeating++;
      }
      slips = 0;
      runs++;
      if (ran.kind === 'blocked') kept[ran.why]++;
      if (ran.kind === 'none') { timersLater = ran.later; open = false; break; }
      if (ran.kind !== 'ran') continue;
      timersRun += ran.fired;
      // A timer the browser ran late: the gaps were not the page's, so this film says nothing.
      if (ran.late > FLASH_TIMERS.lateMs) { kept.late++; continue; }
      if (!ran.visible) continue;
      if (f !== 'skipped') {
        timerFilms++;
        await judge(f, { where: 'the top of the page', when: 'once a timer the page set has run', maxFrames: groupFrames });
      }
      // Animations it started further down are played again where they sit, for as long as they ran. (The page
      // hears that an animation started on the next frame, so the list is read a moment later.)
      await page.waitForTimeout(80);
      const far = await page.evaluate(startedPlaces, { from: ran.started, more: FLASH_REPLAY.places, have: [top.at.y], minArea: FLASH_VIEW.minArea }).catch(() => null);
      await replayAll(far, 'once a timer the page set has run (the test played it again where it sits)');
      if (ran.inView || far?.places.length || ran.y === undefined) continue;
      // It changed something further down by script, with no animation to play again. A change made once is
      // nothing to film; one that keeps going is filmed where it is, from the start, by running the same timer
      // once more there, when the page repeats it (an interval, a timeout that sets itself again).
      const from = await page.evaluate(startedCount, undefined).catch(() => 0);
      const calm = await page.evaluate(quietAfterView, { from, ms: FLASH_VIEW.lookMs, anywhere: true }).catch(() => ({ quiet: false }));
      if (calm.quiet) continue;
      let again = false;
      const g = timerFilms < FLASH_TIMERS.max && timerTime() ? await film(FLASH_TIMERS.filmMs, async () => {
        const at = await settleAt(ran.y!);
        if (!at) return null;
        again = await page.evaluate(rerunTimer, ran.timer ?? -1).catch(() => false);
        return again ? at : { ...at, skip: true };
      }) : 'skipped';
      if (g === 'unsettled' || g === 'skipped') { kept.stirred++; continue; }
      timerFilms++;
      seen.push(g.at.y);
      await judge(g, { where: `it ${g.at.y} px down`, when: 'once a timer the page set has run' });
    }
    // Timers still due that the test did not get to.
    if (open) {
      const rest = await page.evaluate(runTimers, { mode: 'plan' as const, ...timing }).catch(() => null);
      if (rest?.kind === 'none') timersLater = rest.later;
      else skip(`the page set more timers for the next ${FLASH_TIMERS.maxDelayMs / 1000} s than the test ran (it runs ${FLASH_TIMERS.runs} groups of timers early and films ${FLASH_TIMERS.max}, as time allows), so what the others start was not filmed`);
    }
    const unkept = (n: number, why: string) => {
      if (n) skip(`${n} of the page’s timers could not be run early with the page’s own timing kept (${why}), so what ${plural(n, 'it starts', 'they start')} was not filmed`);
    };
    unkept(kept.repeating, 'a repeating timer of the page ticks in between');
    unkept(kept.chain, `more timers follow one another than the test films in one piece, ${FLASH_TIMERS.groupMs / 1000} s`);
    unkept(kept.dropped, 'timers that run close together are filmed in one piece, which the browser’s screencast is needed for');
    unkept(kept.late, 'the browser ran a timer late');
    if (kept.stirred) skip(`${kept.stirred} of the page’s timers started changes further down the page that kept going and could not be filmed from their start`);
  }
  await replayAll(played, 'as it plays when the page arrives (the test played it again where it sits)');
  if (replaysLeft) skip(`animations that played in ${replaysLeft} more ${plural(replaysLeft, 'place', 'places')} further down the page were not filmed (the test plays them again in ${FLASH_REPLAY.places} places, as time allows)`);

  const first = await page.evaluate(flashPlaces, { more: MORE_PLACES, have: seen }).catch(() => ({ places: [] as number[], height: 0, left: 0 }));
  let left = first.left;
  // Recording again: what a script restyles while the test films counts for the second look.
  await page.evaluate(flashObserve, undefined).catch(() => undefined);

  // 3. Places further down: where moving content sits, then where the page watches for content to come into view.
  const places = async (queue: number[], ms: number, of: (y: number) => string): Promise<void> => {
    for (const place of queue) {
      if (!hasTime(ctx, ms + SCROLL_SETTLE_MS + 6000)) {
        findings.push(notTestable(`the time for this test ran out before the page could be checked further down (at ${place} px)`));
        return;
      }
      // There, and staying put: a place the window does not settle at is not testable, never a failure.
      const f = await film(ms, async () => {
        const at = await settleAt(place);
        return at && seen.includes(at.y) ? { ...at, skip: true } : at;
      });
      if (f === 'unsettled') { skip(`the window did not stay where the test moved it (${place} px down), so flashing there could not be measured`); continue; }
      if (f === 'skipped') continue;
      seen.push(f.at.y);
      await judge(f, { where: of(f.at.y) });
    }
  };
  await places(first.places, CAPTURE_MS, (y) => `it ${y} px down`);
  // Where content waits to come into view: each place is filmed from the moment it does. After a short look, a
  // place where nothing started and nothing keeps changing needs no more film; any other is filmed in full.
  const watched = await page.evaluate(watchedPlaces, { more: FLASH_VIEW.looks, have: seen, minArea: FLASH_VIEW.minArea }).catch(() => ({ places: [] as number[], left: 0 }));
  let viewsFilmed = 0;
  let viewsQuiet = 0;
  const calmAt: number[] = [];
  let viewsLeft = watched.left;
  for (const [i, place] of watched.places.entries()) {
    if (!hasTime(ctx, FLASH_VIEW.filmMs + SCROLL_SETTLE_MS + 6000)) { viewsLeft += watched.places.length - i; break; }
    const full = viewsFilmed < FLASH_VIEW.places;
    const look = { quiet: false, over: false };
    const from = await page.evaluate(startedCount, undefined).catch(() => 0);
    const f = await film(FLASH_VIEW.filmMs, async () => {
      const at = await settleAt(place);
      if (!at) return null;
      if (seen.includes(at.y)) { look.quiet = true; return { ...at, skip: true }; }
      // Without the screencast the film starts once the place is in view, so there is no look first.
      if (!cast) { look.over = !full; return full ? at : { ...at, skip: true }; }
      look.quiet = (await page.evaluate(quietAfterView, { from, ms: FLASH_VIEW.lookMs }).catch(() => ({ quiet: false }))).quiet;
      if (look.quiet) { calmAt.push(at.y); return { ...at, skip: true }; }
      look.over = !full;
      return full ? { ...at, ms: FLASH_VIEW.filmMs - FLASH_VIEW.lookMs } : { ...at, skip: true };
    });
    if (f === 'unsettled') { skip(`the window did not stay where the test moved it (${place} px down), so flashing there could not be measured`); continue; }
    if (look.over) { viewsLeft++; continue; }
    if (f === 'skipped') { if (look.quiet) viewsQuiet++; continue; }
    seen.push(f.at.y);
    viewsFilmed++;
    await judge(f, { where: `it ${f.at.y} px down` });
  }
  if (viewsLeft) skip(`${viewsLeft} more ${plural(viewsLeft, 'place', 'places')} where content waits to come into view ${plural(viewsLeft, 'was', 'were')} not filmed (the test looks at ${FLASH_VIEW.looks} such places and films ${FLASH_VIEW.places} where something starts, as time allows)`);
  // A second look once the first places are filmed (3 s or more after the first; also when one of them could not
  // be): moving content a page builds late is further down by then. It may add up to MORE_PLACES places outside
  // the viewports already filmed.
  if (hasTime(ctx, CAPTURE_MS + SCROLL_SETTLE_MS + 6000)) {
    // Media the page put in since the start, as a browser that allows autoplay would play it.
    await page.evaluate(startBlockedAutoplay, undefined).catch(() => 0);
    const again = await page.evaluate(flashPlaces, { more: MORE_PLACES, have: seen, calm: calmAt }).catch(() => null);
    if (again) {
      left = Math.max(left, again.left);
      await places(again.places, CAPTURE_MS, (y) => `it ${y} px down`);
    }
  }

  // 4. Buttons that say they show or play something, each filmed from the click.
  let buttonsTried = 0;
  const shown = await page.evaluate(showButtons, { shows: SHOWS.source, never: NEVER_CLICK.source, max: FLASH_BUTTONS.max }).catch(() => ({ buttons: [] as KitElement[], more: 0 }));
  let buttonsLeft = shown.more;
  for (const [i, b] of shown.buttons.entries()) {
    if (!hasTime(ctx, FLASH_BUTTONS.filmMs + 6000)) { buttonsLeft += shown.buttons.length - i; break; }
    const name = (b.name ?? '').slice(0, 40);
    const f = await film(FLASH_BUTTONS.filmMs, async () => {
      if (!(await clickControl(page, b))) return { x: 0, y: 0, skip: true };
      buttonsTried++;
      const st = await page.evaluate(documentStart, undefined).catch(() => null);
      return st ? { x: st.x, y: st.y } : null;
    });
    if (f === 'unsettled') skip(`the page did not stay where it was once the button “${name}” was pressed, so what it shows could not be filmed`);
    else if (f !== 'skipped') await judge(f, { where: `the button “${name}”`, when: `once the button “${name}” was pressed` });
  }
  if (buttonsLeft) skip(`${buttonsLeft} more ${plural(buttonsLeft, 'button that says it shows or plays something was', 'buttons that say they show or play something were')} not pressed (the test presses ${FLASH_BUTTONS.max}, as time allows)`);

  if (left) findings.push(notTestable(`moving content in ${left} more place${left === 1 ? '' : 's'} further down the page was not captured (the test captures the top and ${MORE_PLACES} more places)`));
  findings.push(...skipped.map(notTestable));
  ctx.setData?.({ method, fps: Number.isFinite(slowest) ? slowest : 0, places: captured.length, arrival, replays, timers: timersRun, timerFilms, views: viewsFilmed, viewsQuiet, buttons: buttonsTried });
  // No place could be filmed standing still: nothing was measured.
  if (!captured.length) throw new ProbeNotTestable(skipped[0] ?? 'the test could not film any place on the page, so flashing could not be measured');
  // Too few frames cannot show flashing, even when the samples look still (they may share a phase),
  // and a flash they seem to show may be an artefact: such a capture decides nothing.
  const decision = flashDecision(captured);
  if (decision === 'not_testable') throw tooSlow();
  if (decision === 'failed') return findings;
  const down = seen.length - 1;
  const parts = [
    arrival ? 'the top of the page from the moment it loads' : `the top of the page for ${CAPTURE_MS / 1000} s`,
    ...(replays ? [`${replays} ${plural(replays, 'place', 'places')} further down where an animation played while the window was elsewhere (played again there)`] : []),
    ...(timersRun ? [`${timersRun} of the page's timers run early, in the page's order and with the page's gaps`] : []),
    ...(down > 0 ? [`${down} ${plural(down, 'place', 'places')} further down (where moving content sits${viewsFilmed ? ', and where content that waits to come into view starts something' : ''})`] : []),
    ...(viewsQuiet ? [`${viewsQuiet} ${plural(viewsQuiet, 'place', 'places')} where content waits to come into view and nothing started when it did`] : []),
    ...(buttonsTried ? [`${buttonsTried} button${buttonsTried === 1 ? '' : 's'} that show${buttonsTried === 1 ? 's' : ''} or play${buttonsTried === 1 ? 's' : ''} something`] : []),
  ];
  // Outside this test, and said so: timers the page set for further ahead than it runs.
  const later = timersLater ? `. Not run: ${timersLater} ${plural(timersLater, 'timer', 'timers')} the page set for more than ${FLASH_TIMERS.maxDelayMs / 1000} s ahead` : '';
  findings.push({
    criterion: '2.3.1', status: 'no_failures_found',
    detail: `no general or red flashes above the threshold in the frames of the screen, at ${Math.round(slowest)} or more a second: ${parts.join('; ')}${later}`,
  });
  return findings;
}

export const flashProbe: PageProbe = {
  id: 'flash',
  criteria: ['2.3.1'],
  kind: 'pixels',
  tier: 'deep',
  timeoutMs: 45_000,
  contextOptions: MOTION_CONTEXT,
  isolate: true,
  initScript: FLASH_INIT_SCRIPT,
  async run(ctx) {
    await kitReady(ctx.page);
    // Every scroll the test makes is instant: smooth scrolling would film the page racing past.
    await ctx.page.evaluate(instantScrollStart, undefined);
    try {
      return await flashRun(ctx);
    } finally {
      await within(SCREENCAST.callMs, ctx.page.evaluate(instantScrollStop, undefined), undefined);
    }
  },
};
