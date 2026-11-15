// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.2.2 Pause, Stop, Hide (Plan 4 Task 4.4): moving, blinking, scrolling and auto-updating
// content that starts by itself and lasts more than 5 s needs a control that pauses, stops or hides
// it. Core probe. Engine core: no Node-only imports.
//
// What moves (context `prefers-reduced-motion: no-preference`, after media blocked by the
// browser's autoplay policy has been started as a permissive browser would):
// - CSS and Web Animations (`document.getAnimations()`) that change something visible and run more
//   than 5 s (infinite, or duration × iterations);
// - videos playing by themselves for more than 5 s (looping, a stream, or longer);
// - animated GIF, APNG and WebP images whose frames last more than 5 s in total (the file is read in
//   the page, from the browser cache; cross-origin files without CORS are seen by screenshots only);
// - SVG (SMIL) animations;
// - content changed by the page's own timers: every timer of 1–20 s is run early twice (the hook's
//   __grntedFire), 0.9 s apart; a timer that repeats and changes the same visible region both times
//   is a carousel, slideshow, ticker or auto-updating region;
// - anything else that changes on screen (canvas, scripted scrolling, frames) or in the DOM in a
//   0.7 s window: when it is not explained by the above, the probe looks again more than 5 s after it
//   first saw it changing (monotonic clock) and counts it only when the SAME element (by identity, not
//   by place) is still changing then (review r4 of fix/late-mount: never timed from the page's load or
//   from when a late-mounting page's content appeared).
// Each moving item is then given a control: native video controls count; otherwise the probe clicks
// nearby (then page-wide) controls named pause, stop, hide, close, play or similar, moves the mouse
// away (so hover-pause does not count) and checks that the motion stopped or the content is hidden.
// No working control → failed. Nothing moving → no failures found (the criterion applies to every
// page).
import type { FrameLike, PageLike } from '../types.js';
import type { Kit, KitBox, KitElement } from './kit.js';
import { PAUSE_VOCAB, installKit } from './kit.js';
import {
  MIN_AREA, MOTION_CELL, MOTION_CONTEXT, MOTION_LIMIT_MS, clickControl, controlsFor, guardStop, hasTime, kitReady, kitStop, within, requireHook, lasting, overlapShare, refusedText, settledStop,
  instantScrollStart, instantScrollStop, startBlockedAutoplay, visualChanges, type Candidates,
} from './motionShared.js';
import type { SeenPair, SeenRegion } from './motionShared.js';
import { LATE_CONTENT_MS, mountingNow, trackMount, type MountTracker } from './mounting.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext, type ProbeFinding } from './types.js';

type Kind = 'animation' | 'video' | 'image' | 'svg' | 'timer' | 'visual' | 'dom' | 'frame';

/** A moving item: what moves, how long, and where. */
export interface MovingItem {
  kind: Kind;
  el: KitElement;
  box: KitBox;
  what: string;
  /** Total running time in ms; null when it has no end. */
  lastsMs: number | null;
  /** A video with its own controls. */
  nativeControls?: boolean;
  /** For 'timer' items: the timer indexes (RecordedHooks.timers) that change it. */
  timers?: number[];
  /** For 'image' items: the source when found. */
  src?: string;
  /**
   * For 'timer' items: when its timer was first set (the first of a chain of timeouts), and when the
   * test's own early runs of it ended (the page's monotonic clock, `performance.now()`): its natural runs, and the changes they
   * made to its region (watched from then on), tell how long it changed by itself.
   */
  timerSince?: { document: string; setAt: number; testedAt: number; delay: number };
}

/**
 * An item that no longer moves, seen by the test: 'ended' when its own timing ran its course and that
 * course was more than 5 s (a CSS animation that finished all its iterations; a repeating timer whose
 * natural runs went on for more than 5 s before the page cleared it). Such an item was not stopped by
 * a control, and having stopped by itself does not pass it.
 */
export type ItemState = boolean | 'ended';

/**
 * Whether a cleared repeating timer changed content by itself for more than 5 s after it was first set.
 * `lastChangeAt` is the last of its own natural runs whose callback changed the DOM (the hook stamps it
 * on the timer's record while the probe watches; another script's writes never count): that is when it
 * last changed something, whether or not that run also cleared it. Without one, its last natural run is
 * used, less one period (that run may only have cleared it, so the change before it is a period earlier).
 */
export function timerRanLong(since: { setAt: number; testedAt: number; delay: number }, seen: { lastFiredAt?: number; lastChangeAt?: number }, limitMs = MOTION_LIMIT_MS): boolean {
  if (seen.lastChangeAt !== undefined && seen.lastChangeAt > since.testedAt) return seen.lastChangeAt - since.setAt > limitMs;
  if (seen.lastFiredAt === undefined || seen.lastFiredAt <= since.testedAt) return false;
  return seen.lastFiredAt - since.delay - since.setAt > limitMs;
}

interface Inventory {
  items: MovingItem[];
  /** Images to read (animated GIF/APNG/WebP?). */
  images: { el: KitElement; box: KitBox; src: string }[];
  /** Boxes of everything running now (any duration) that explains a visual change. */
  explained: { box: KitBox; endsInMs: number | null }[];
  counts: { animations: number; videos: number; svgs: number; indicators: number };
  sinceLoad: number;
}

/** Runs in the page. */
function motionInventory(arg: { minArea: number; minMs: number; maxImages: number }): Inventory {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const items: MovingItem[] = [];
  const explained: Inventory['explained'] = [];
  const byEl = new Map<Element, MovingItem>();
  let animations = 0;
  // Loading indicators: progress bars, status regions, busy content and small spinners (an endless
  // rotation of an element of 64×64 px or less). They show that something is happening.
  let indicators = 0;
  const indicator = (el: Element, k: Keyframe[] | null): boolean => {
    // The element itself, not any ancestor: aria-busy on <main> must not hide a carousel inside it.
    if (el.matches('[role="progressbar"], [role="status"], [aria-busy="true"], progress')) return true;
    // Layout size, not the box on screen: a rotating square's box grows by up to 41%.
    const size = el instanceof HTMLElement ? el.offsetWidth * el.offsetHeight : kit.area(el);
    if (!k || size > 4096) return false;
    const props = new Set<string>();
    for (const f of k) for (const p of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
    if (!props.size || ![...props].every((p) => p === 'transform' || p === 'rotate' || p === 'translate')) return false;
    // A small rotating spinner, or a small moving part of a progress bar.
    return k.some((f) => /rotate|turn|deg/.test(String(f.transform ?? f.rotate ?? ''))) || !!el.closest('progress, [role="progressbar"]');
  };
  const visual = (k: Keyframe[]): boolean => {
    const props = new Set<string>();
    for (const f of k) for (const p of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
    if (!props.size) return false;
    if (k.length < 2) return true;
    for (const p of props) if (new Set(k.map((f) => String(f[p] ?? ''))).size > 1) return true;
    return false;
  };
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    const eff = a.effect as KeyframeEffect | null;
    const el = eff?.target;
    if (!eff || !el) continue;
    let changes = true;
    let frames: Keyframe[] | null = null;
    try { frames = eff.getKeyframes(); changes = visual(frames); } catch { /* keep */ }
    // An element its own animation fades in and out (a blink) is moving, not hidden, at opacity 0.
    const fades = !!frames?.some((f) => 'opacity' in f);
    if (!changes || !kit.visible(el, fades)) continue;
    if (indicator(el, frames)) {
      indicators++;
      explained.push({ box: kit.box(el), endsInMs: null });
      continue;
    }
    animations++;
    const t = eff.getComputedTiming();
    const active = Number(t.activeDuration);
    const local = Number(t.localTime ?? 0);
    const endsIn = Number.isFinite(active) ? Math.max(0, Number(t.endTime ?? active) - local) : null;
    // Finite animations explain screen changes; endless small ones do not (many together still move).
    if (endsIn !== null) explained.push({ box: kit.box(el), endsInMs: endsIn });
    if (!(active > arg.minMs) || kit.area(el) < arg.minArea) continue;
    const css = a as Animation & { animationName?: string; transitionProperty?: string };
    const label = css.animationName ? `CSS animation "${css.animationName}"` : css.transitionProperty ? `CSS transition of ${css.transitionProperty}` : a.id ? `animation "${a.id}"` : 'a scripted animation';
    const lastsMs = Number.isFinite(active) ? Math.round(active) : null;
    const prev = byEl.get(el);
    if (prev && (prev.lastsMs === null || (lastsMs !== null && prev.lastsMs >= lastsMs))) continue;
    const item: MovingItem = { kind: 'animation', el: kit.describe(el), box: kit.box(el), what: `${label} on ${el.localName}`, lastsMs };
    if (prev) items.splice(items.indexOf(prev), 1, item);
    else items.push(item);
    byEl.set(el, item);
    // Kept to tell later whether it finished its own course (an animation that finished and does not
    // fill is no longer listed by getAnimations).
    // With when it started and when its own timing ends (document timeline ms): one cancelled after it ran
    // its course (an animationend handler removing it) is told from one stopped early.
    type Kept = { a: Animation; start: number; end: number; active: number; fades: boolean; css: string; kf: Keyframe[]; timing: EffectTiming };
    const reg = ((window as unknown as { __grntedMotionAnims?: Map<Element, Kept[]> }).__grntedMotionAnims ??= new Map<Element, Kept[]>());
    const tl = Number(document.timeline.currentTime ?? 0);
    reg.set(el, [...(reg.get(el) ?? []).filter((x: Kept) => x.a !== a), {
      a, start: tl - local, end: Number(t.endTime ?? active), active, fades, css: css.animationName ?? '', kf: frames ?? [], timing: eff.getTiming(),
    }]);
  }
  let videos = 0;
  for (const v of document.querySelectorAll('video')) {
    if (v.paused || v.ended || !kit.visible(v)) continue;
    videos++;
    const finite = Number.isFinite(v.duration) && v.duration > 0;
    const lastsMs = v.loop || !finite ? null : Math.round(v.duration * 1000);
    explained.push({ box: kit.box(v), endsInMs: lastsMs === null ? null : Math.max(0, lastsMs - v.currentTime * 1000) });
    if (kit.area(v) < arg.minArea || (lastsMs !== null && lastsMs <= arg.minMs)) continue;
    const how = v.loop ? 'looping' : finite ? `${Math.round(v.duration)} s long` : 'a stream';
    items.push({ kind: 'video', el: kit.describe(v), box: kit.box(v), what: `a video that plays by itself (${how}${v.muted ? ', muted' : ''})`, lastsMs, nativeControls: v.controls });
  }
  let svgs = 0;
  const clock = (s: string | null): number => {
    const m = /^\s*([\d.]+)\s*(ms|s|min|h)?\s*$/.exec(s ?? '');
    if (!m) return 0;
    const n = Number(m[1]);
    return m[2] === 'ms' ? n : m[2] === 'min' ? n * 60_000 : m[2] === 'h' ? n * 3_600_000 : n * 1000;
  };
  for (const svg of document.querySelectorAll('svg')) {
    const anims = svg.querySelectorAll('animate, animateTransform, animateMotion, set');
    if (!anims.length || svg.animationsPaused() || !kit.visible(svg)) continue;
    svgs++;
    let lastsMs: number | null = 0;
    for (const an of anims) {
      const rc = an.getAttribute('repeatCount');
      const rd = an.getAttribute('repeatDur');
      if (rc === 'indefinite' || rd === 'indefinite') { lastsMs = null; break; }
      const total = clock(an.getAttribute('begin')) + (rd ? clock(rd) : clock(an.getAttribute('dur')) * (rc ? Number(rc) || 1 : 1));
      lastsMs = Math.max(lastsMs, total);
    }
    explained.push({ box: kit.box(svg), endsInMs: lastsMs });
    if (kit.area(svg) < arg.minArea || (lastsMs !== null && lastsMs <= arg.minMs)) continue;
    items.push({ kind: 'svg', el: kit.describe(svg), box: kit.box(svg), what: 'an SVG animation', lastsMs });
  }
  const images: Inventory['images'] = [];
  for (const img of document.images) {
    if (images.length >= arg.maxImages) break;
    const src = img.currentSrc || img.src;
    if (!src || !kit.visible(img) || kit.area(img) < arg.minArea) continue;
    if (/\.(jpe?g|svg|avif|bmp|ico|tiff?)(\?|#|$)/i.test(src) || /^data:image\/(jpe?g|svg)/i.test(src)) continue;
    if (indicator(img, null) || (kit.area(img) <= 4096 && /\b(load\w*|spinner|spinning|progress|wait\w*|busy)\b/i.test(`${img.alt} ${src.split(/[?#]/)[0]!.split('/').pop()}`))) {
      indicators++;
      explained.push({ box: kit.box(img), endsInMs: null });
      continue;
    }
    images.push({ el: kit.describe(img), box: kit.box(img), src });
  }
  return { items, images, explained, counts: { animations, videos, svgs, indicators }, sinceLoad: Math.round(performance.now() - kit.loadEnd()) };
}

/** Frames, one loop's duration and loop count of an animated GIF, APNG or WebP (frames 1 = still). */
export interface ImageAnimation { frames: number; loopMs: number; loops: number | null }

/**
 * Runs in the page (and in Node for tests: it only needs `fetch`): reads each image (browser cache
 * first, at most `maxBytes`) and parses its frames. null for an image it could not read (for
 * example a cross-origin file without CORS) or that is not GIF, PNG or WebP.
 */
export async function readImageAnimations(arg: { srcs: string[]; maxBytes: number }): Promise<(ImageAnimation | null)[]> {
  const parse = (b: Uint8Array): ImageAnimation | null => {
    const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
    const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
    const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
    const u32le = (i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + ((b[i + 3]! << 24) >>> 0);
    const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
    // Browsers show frames of 10 ms or less for 100 ms.
    const frameMs = (ms: number) => (ms <= 10 ? 100 : ms);
    if (b.length >= 13 && ascii(0, 3) === 'GIF') {
      let pos = 13;
      if (b[10]! & 0x80) pos += 3 * (1 << ((b[10]! & 7) + 1));
      let frames = 0, loopMs = 0, delay = 0;
      let loops: number | null = 1;
      const skipBlocks = () => { while (pos < b.length && b[pos]) pos += b[pos]! + 1; pos++; };
      while (pos < b.length) {
        const id = b[pos];
        if (id === 0x21) {
          const label = b[pos + 1];
          if (label === 0xf9) delay = u16le(pos + 4) * 10;
          // Application extension: 0x21 0xFF 11 "NETSCAPE2.0", then a 3-byte sub-block: 1, loop count (LE).
          if (label === 0xff && pos + 17 < b.length && /^(NETSCAPE2\.0|ANIMEXTS1\.0)$/.test(ascii(pos + 3, 11)) && b[pos + 15] === 1) {
            const n = u16le(pos + 16);
            loops = n === 0 ? null : n + 1;
          }
          pos += 2;
          skipBlocks();
        } else if (id === 0x2c) {
          frames++;
          loopMs += frameMs(delay);
          delay = 0;
          const packed = b[pos + 9]!;
          pos += 10;
          if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1));
          pos++;
          skipBlocks();
        } else break;
      }
      return { frames, loopMs: frames > 1 ? loopMs : 0, loops };
    }
    if (b.length >= 16 && b[0] === 0x89 && ascii(1, 3) === 'PNG') {
      let pos = 8, frames = 1, loopMs = 0;
      let loops: number | null = 1, animated = false;
      while (pos + 8 <= b.length) {
        const len = u32be(pos);
        const type = ascii(pos + 4, 4);
        const d = pos + 8;
        if (type === 'acTL') { animated = true; frames = u32be(d); const n = u32be(d + 4); loops = n === 0 ? null : n; }
        if (type === 'fcTL' && d + 26 <= b.length) {
          const num = (b[d + 20]! << 8) | b[d + 21]!;
          const den = ((b[d + 22]! << 8) | b[d + 23]!) || 100;
          loopMs += frameMs((num / den) * 1000);
        }
        if (type === 'IDAT' && !animated) break;
        if (type === 'IEND') break;
        pos = d + len + 4;
      }
      return animated ? { frames, loopMs: frames > 1 ? Math.round(loopMs) : 0, loops } : { frames: 1, loopMs: 0, loops: 1 };
    }
    if (b.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      let pos = 12, frames = 0, loopMs = 0;
      let loops: number | null = 1, animated = false;
      while (pos + 8 <= b.length) {
        const type = ascii(pos, 4);
        const len = u32le(pos + 4);
        const d = pos + 8;
        if (type === 'VP8X') animated = !!(b[d]! & 0x02);
        if (type === 'ANIM' && d + 6 <= b.length) { const n = u16le(d + 4); loops = n === 0 ? null : n; }
        if (type === 'ANMF' && d + 16 <= b.length) { frames++; loopMs += frameMs(u24le(d + 12)); }
        pos = d + len + (len & 1);
      }
      return animated && frames > 1 ? { frames, loopMs, loops } : { frames: 1, loopMs: 0, loops: 1 };
    }
    return null;
  };
  const out: (ImageAnimation | null)[] = [];
  for (const src of arg.srcs) {
    try {
      const res = await fetch(src, { cache: 'force-cache' });
      const size = Number(res.headers.get('content-length') ?? 0);
      if (!res.ok || size > arg.maxBytes || !res.body) { await res.body?.cancel().catch(() => {}); out.push(null); continue; }
      // Read the stream and stop past maxBytes (a missing Content-Length must not download a huge file).
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      let tooBig = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > arg.maxBytes) { tooBig = true; await reader.cancel().catch(() => {}); break; }
        parts.push(value);
      }
      if (tooBig) { out.push(null); continue; }
      const buf = new Uint8Array(total);
      let o = 0;
      for (const part of parts) { buf.set(part, o); o += part.length; }
      out.push(parse(buf));
    } catch {
      out.push(null);
    }
  }
  return out;
}

/** Runs in the page: starts recording mutations and drops what was recorded so far. */
function startObserving(): number {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  kit.observe();
  kit.take();
  return performance.now();
}

/** A region the page's code changed: the changed elements' nearest visible container of a useful size. */
interface DomRegion { el: KitElement; box: KitBox; batches: number; firstAt: number; lastAt: number }

/** Runs in the page: regions changed by mutations since the last take, with how often they changed. */
function domChanges(arg: { minArea: number }): DomRegion[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const batches = kit.take();
  const changedNodes = ((window as unknown as { __grntedMotionChanged?: Set<Node> }).__grntedMotionChanged ??= new Set());
  for (const b of batches) for (const r of b.records) {
    if (r.type === 'childList') r.addedNodes.forEach((n) => changedNodes.add(n));
    else changedNodes.add(r.target);
  }
  const regions = new Map<Element, DomRegion>();
  for (const b of batches) {
    const seen = new Set<Element>();
    for (const el of kit.changed(b.records)) {
      // Batch 19 (precision lane): what is never drawn changes nothing on screen (a form's hidden time stamp a script
      // refreshes every half second, a script or style element, a template): it is no motion of the region around it.
      if (el.matches('input[type="hidden" i], script, style, template, noscript, meta, link, title') || el.closest('head, template, noscript')) continue;
      let r: Element | null = el;
      for (let i = 0; r && i < 5 && (!kit.visible(r, true) || kit.area(r) < arg.minArea); i++) r = r.parentElement;
      if (!r || r === document.body || r === document.documentElement || !kit.visible(r, true) || seen.has(r)) continue;
      seen.add(r);
      const prev = regions.get(r);
      if (prev) { prev.batches++; prev.lastAt = b.t; } else regions.set(r, { el: kit.describe(r), box: kit.box(r), batches: 1, firstAt: b.t, lastAt: b.t });
    }
  }
  // Keep the outermost of nested regions, adding up their changes.
  const list = [...regions.entries()];
  const out: DomRegion[] = [];
  for (const [el, r] of list) {
    const outer = list.find(([o]) => o !== el && o.contains(el));
    if (outer) {
      outer[1].batches = Math.max(outer[1].batches, r.batches);
      outer[1].firstAt = Math.min(outer[1].firstAt, r.firstAt);
      outer[1].lastAt = Math.max(outer[1].lastAt, r.lastAt);
    }
  }
  for (const [el, r] of list) if (!list.some(([o]) => o !== el && o.contains(el))) out.push(r);
  return out.slice(0, 50);
}

/** One run of a timer's callback and what it changed. */
interface TimerFire { handle: number; timer: number; kind: 'timeout' | 'interval'; delay: number; region: KitElement | null; box: KitBox | null; next: number[] }

/**
 * Runs in the page: runs each listed (or every pending, 1 s to `maxDelay`) timer's callback once,
 * one at a time, and records the visible region its synchronous changes touched and the timers it
 * set (a timeout that sets itself again repeats).
 */
function fireTimers(arg: { handles: number[] | null; maxDelay: number; minArea: number; max: number }): TimerFire[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  kit.observe();
  const all = kit.pending().filter((p) => !p.string && p.delay <= arg.maxDelay);
  const list = (arg.handles ? all.filter((p) => arg.handles!.includes(p.handle)) : all).slice(0, arg.max);
  const out: TimerFire[] = [];
  for (const p of list) {
    const before = new Set(kit.pending().map((q) => q.handle));
    kit.take();
    kit.fire(p.handle);
    const records = kit.take().flatMap((b) => b.records);
    const changedNodes = ((window as unknown as { __grntedMotionChanged?: Set<Node> }).__grntedMotionChanged ??= new Set());
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach((n) => changedNodes.add(n));
      else changedNodes.add(r.target);
    }
    const changed = kit.changed(records).filter((e) => kit.visible(e, true));
    let region: Element | null = kit.lca(changed);
    if (!region && changed.length) region = changed.reduce((a, b) => (kit.area(b) > kit.area(a) ? b : a));
    for (let i = 0; region && i < 5 && kit.area(region) < arg.minArea; i++) region = region.parentElement;
    if (region && (region === document.body || region === document.documentElement || kit.area(region) < arg.minArea)) region = null;
    const next = kit.pending().filter((q) => !before.has(q.handle) && q.timer === p.timer).map((q) => q.handle);
    out.push({ handle: p.handle, timer: p.timer, kind: p.kind, delay: p.delay, region: region ? kit.describe(region) : null, box: region ? kit.box(region) : null, next });
  }
  return out;
}

/** Runs in the page: the handles of every pending timer now (to tell later which ones were set since). */
function pendingHandles(): number[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  return kit.pending().map((p) => p.handle);
}

/**
 * Runs in the page: pending timers of at most `maxDelay` set since `before` was read (not in it, not in
 * `known`), soonest first, at most `max`: what a callback (or a click) left behind to run later.
 */
function freshTimers(arg: { before: number[]; known: number[]; maxDelay: number; max: number }): { handle: number; delay: number }[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const old = new Set([...arg.before, ...arg.known]);
  return kit.pending().filter((p) => !old.has(p.handle) && !p.string && p.delay <= arg.maxDelay)
    .sort((a, b) => a.delay - b.delay).slice(0, arg.max).map((p) => ({ handle: p.handle, delay: p.delay }));
}

/**
 * What is where on screen at one moment (review r5 of fix/late-mount: identity is taken when the evidence is,
 * right after each screenshot): at every possible centre of a union of comparison cells, the element there
 * and its ancestors up to the body's child (or the first at least half the viewport), as kit ids and areas.
 * Screenshots and hit tests both use viewport CSS px, including at device pixel ratios other than 1.
 */
export interface ShotIdentity { x: number[]; y: number[]; hit: number[]; chains: number[][] }

/** Runs in the page: `ShotIdentity` now. */
function shotIdentity(arg: { cell: number }): ShotIdentity {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const centres = (extent: number): number[] => {
    const points = new Set<number>();
    // Unions of whole cells have their centres on this half-cell lattice.
    for (let p = arg.cell / 2; p < extent; p += arg.cell / 2) points.add(p);
    // The last cell may be clipped by the viewport. A union ending there has its centre at
    // (its starting cell boundary + extent) / 2, which need not lie on the regular lattice.
    if (extent % arg.cell) for (let start = 0; start < extent; start += arg.cell) points.add((start + extent) / 2);
    return [...points].sort((a, b) => a - b);
  };
  const x = centres(innerWidth);
  const y = centres(innerHeight);
  const half = (innerWidth * innerHeight) / 2;
  const chains: number[][] = [];
  const byHit = new Map<Element, number>();
  const hit: number[] = [];
  for (const py of y) {
    for (const px of x) {
      const el = document.elementFromPoint(px, py);
      if (!el || el === document.body || el === document.documentElement) { hit.push(-1); continue; }
      let k = byHit.get(el);
      if (k === undefined) {
        const chain: number[] = [];
        for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
          const area = kit.area(e);
          chain.push(kit.keep(e), area);
          if (area >= half || e.parentElement === document.body) break;
        }
        k = chains.length;
        chains.push(chain);
        byHit.set(el, k);
      }
      hit.push(k);
    }
  }
  return { x, y, hit, chains };
}

/**
 * The element a changed region (viewport px) was when `seen` was taken: the element at its centre, climbing to
 * a useful size (at least `minArea` and half the region), as `elementsAt` did; null when none.
 */
export function identityAt(seen: ShotIdentity | null | undefined, r: { x: number; y: number; w: number; h: number }, minArea: number): number | null {
  if (!seen) return null;
  const col = seen.x.indexOf(r.x + r.w / 2);
  const row = seen.y.indexOf(r.y + r.h / 2);
  if (col < 0 || row < 0) return null;
  const k = seen.hit[row * seen.x.length + col] ?? -1;
  const chain = k >= 0 ? seen.chains[k] : undefined;
  if (!chain?.length) return null;
  const need = Math.max(minArea, r.w * r.h * 0.5);
  for (let i = 0; i < chain.length; i += 2) if (chain[i + 1]! >= need) return chain[i]!;
  return chain[chain.length - 2]!;
}

/**
 * The element behind each pair of shots that found a region changing, when it is the same element at both
 * shots (each identity taken right after its shot): only then does that pair's time count for it (review r5,
 * Sol 1: an element replaced between two shots is not one element changing).
 */
export function pairsByElement(regions: readonly SeenRegion[], seen: readonly unknown[]): { id: number; pair: SeenPair }[] {
  const out: { id: number; pair: SeenPair }[] = [];
  for (const r of regions) {
    for (const pair of r.pairs) {
      const a = identityAt(seen[pair.shots[0]] as ShotIdentity | null, pair.at, MIN_AREA);
      const b = identityAt(seen[pair.shots[1]] as ShotIdentity | null, pair.at, MIN_AREA);
      if (a !== null && a === b) out.push({ id: a, pair });
    }
  }
  return out;
}

/** Runs in the page: each kit element still in the document, described with its box; null otherwise. */
function describeIds(ids: number[]): ((KitElement & { box: KitBox }) | null)[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  return ids.map((id) => {
    const el = kit.get(id);
    if (!el || !el.isConnected) return null;
    return { ...kit.describe(el), box: kit.box(el) };
  });
}

/** Runs in the page: whether each item still moves (null: the probe must look with screenshots or mutations). */
function stillMoving(arg: { items: { kind: Kind; id: number; src?: string; document?: string }[]; minMs: number }): (boolean | 'ended' | 'src' | 'document' | null)[] {
  const named = (window as unknown as { __grntedDocument?: () => string }).__grntedDocument;
  const doc = typeof named === 'function' ? named() : `t${performance.timeOrigin}`;
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const reg = (window as unknown as { __grntedMotionAnims?: Map<Element, { a: Animation; start: number; end: number; active: number; fades: boolean }[]> }).__grntedMotionAnims;
  return arg.items.map((it) => {
    if (it.document !== undefined && it.document !== doc) return 'document';
    const el = kit.get(it.id);
    if (it.kind === 'animation' && el) {
      const kept = reg?.get(el) ?? [];
      const anims = [...new Set([...el.getAnimations(), ...kept.map((k) => k.a)])];
      const active = (a: Animation) => Number((a.effect as KeyframeEffect | null)?.getComputedTiming().activeDuration ?? 0);
      // Its own fading (a blink at opacity 0, or a fade-out that ends at 0) does not hide it: only a hide
      // that is not the animation's.
      const fades = kept.some((k) => k.fades) || anims.some((a) => {
        if (a.playState !== 'running') return false;
        try { return (a.effect as KeyframeEffect | null)?.getKeyframes().some((f) => 'opacity' in f) ?? false; } catch { return false; }
      });
      // Ran its own course of more than 5 s: by the document's clock its end has come (not one jumped to
      // the end or stopped early), and it then finished, or was removed after it ended (animationend
      // cleanup leaves it idle; so does removing or hiding its element). Paused is not ended. Told
      // before visibility: an element the page removes or hides once its run has ended has still run.
      const now = Number(document.timeline.currentTime ?? 0);
      const running = anims.some((a) => a.playState === 'running' && active(a) > arg.minMs);
      // While the test runs it again (replayEnded), only the animation running now counts: one paused by
      // a control is stopped, whatever the earlier run did.
      const replay = (window as unknown as { __grntedReplay?: { seek: Animation[]; copies: Animation[] } }).__grntedReplay;
      const replaying = !!replay;
      const ranCourse = !replaying && kept.some((k) => k.active > arg.minMs && now - k.start >= k.end - 50 && (k.a.playState === 'finished' || k.a.playState === 'idle'));
      if (ranCourse && !running) return 'ended';
      // The run the test started again (replayEnded) ran to its own end too (batch 17, item 1): ended, not stopped.
      const again = replay ? [...replay.seek, ...replay.copies] : [];
      if (again.length && !running && again.every((a) => a.playState === 'finished')) return 'ended';
      if (!kit.visible(el, fades)) return false;
      return running;
    }
    // A timer's region (it may be one slide the carousel hides between steps) is looked at by stillChanging.
    if (it.kind === 'timer' && el) return null;
    if (!el || !kit.visible(el)) return false;
    if (it.kind === 'video') return !(el as HTMLVideoElement).paused && !(el as HTMLVideoElement).ended;
    if (it.kind === 'svg') return !(el as SVGSVGElement).animationsPaused();
    if (it.kind === 'image') return ((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src) === it.src ? true : 'src';
    return null;
  });
}

const TIMER_MAX_DELAY = 20_000;
/** An item whose state could not be read on a recheck: no verdict for that item (others keep theirs). */
class Unreadable extends Error {}
const NO_SHOTS = 'the browser could not take screenshots, so motion drawn on a canvas, inside frames or by scripts could not be checked';
/** Embedded frames given their own motion test. */
const MAX_FRAMES = 8;
const MAX_ITEMS = 6;
const CANDIDATES = 4;

interface IdentityCost { hitTests: number | null; evaluations: 1; ms: number }

/** The screenshot window, with what was where on screen right after each shot (`seen`, by shot). */
async function shotRegions(page: PageLike, gapMs: number, costs: IdentityCost[]): Promise<{ regions: SeenRegion[]; seen: unknown[] } | null> {
  const sample = { take: async () => {
    const start = performance.now();
    let hitTests: number | null = null;
    try {
      // The whole lattice, including clipped-edge centres, is one page round trip per shot.
      const seen = await page.evaluate(shotIdentity, { cell: MOTION_CELL });
      hitTests = seen.hit.length;
      return seen;
    } finally {
      costs.push({ hitTests, evaluations: 1, ms: Math.round((performance.now() - start) * 10) / 10 });
    }
  }, taken: [] as unknown[] };
  const regions = await visualChanges(page, gapMs, undefined, sample);
  return regions ? { regions, seen: sample.taken } : null;
}

/**
 * Unexplained change is looked at again once this long (ms, monotonic) has passed since it was first seen
 * changing, so the same element seen changing then has changed over more than `MOTION_LIMIT_MS`.
 */
export const MOTION_RECHECK_MARGIN_MS = 50;

/**
 * Whether motion seen first by `first.by` (monotonic ms: it changed at some moment no later than that) and
 * again from `later.after` (it changed at some moment no earlier than that) proves it ran more than 5 s, and
 * is the same element both times (the kit's element identity: a canvas replaced by another one in the same
 * place is two elements, each with its own clock). The only duration motion's look-again uses (review r4 of
 * fix/late-mount): never the page's load, nor when a late-mounting page's content appeared.
 */
export function seenRanLong(first: { by: number; id: number | null }, later: { after: number; id: number | null }, limitMs = MOTION_LIMIT_MS): boolean {
  return first.id !== null && first.id === later.id && later.after - first.by > limitMs;
}

/** Viewport scroll offset (to turn screenshot regions into document boxes). */
const scrollOf = (page: PageLike) => page.evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY) }), undefined);

/**
 * Whether a 'timer', 'visual' or 'dom' item still changes; for timers, runs them again. `first`: the
 * look before any control was tried, the only one where a timer the page cleared can be told to have
 * ended by itself (after a click, the click may be what cleared it).
 */
async function stillChanging(page: PageLike, item: MovingItem, first = false): Promise<ItemState> {
  if (item.kind === 'timer') {
    const fires = await page.evaluate((a: { timers: number[]; id: number; minArea: number; document?: string }) => {
      const named = (window as unknown as { __grntedDocument?: () => string }).__grntedDocument;
      const doc = typeof named === 'function' ? named() : `t${performance.timeOrigin}`;
      if (a.document !== undefined && a.document !== doc) return null;
      const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
      const el = kit.get(a.id);
      // The region the timer changed may be one slide, which the carousel itself hides between steps:
      // hidden means the slide and the element holding it (what a hide control hides).
      if (!el || (!kit.visible(el, true) && !(el.parentElement && kit.visible(el.parentElement, true)))) return { hidden: true, handles: [] as number[], lastFiredAt: [] as (number | undefined)[] };
      const hooks = (window as unknown as { __grntedHooks?: () => { timers: { lastFiredAt?: number; lastChangeAt?: number }[] } }).__grntedHooks?.();
      const changes = a.timers.map((t) => hooks?.timers[t]?.lastChangeAt).filter((x): x is number => typeof x === 'number');
      return {
        hidden: false, handles: kit.pending().filter((p) => a.timers.includes(p.timer) && !p.string).map((p) => p.handle),
        lastFiredAt: a.timers.map((t) => hooks?.timers[t]?.lastFiredAt), lastChangeAt: changes.length ? Math.max(...changes) : undefined,
      };
    }, { timers: item.timers ?? [], id: item.el.id, minArea: MIN_AREA, document: item.timerSince?.document });
    if (fires === null) throw new Unreadable('the page loaded another page by itself, so this moving item could not be checked');
    if (fires.hidden) return false;
    if (!fires.handles.length) {
      // Cleared by the page: ended when it went on changing its region for more than 5 s.
      const last = Math.max(0, ...fires.lastFiredAt.map((x) => x ?? 0));
      return first && item.timerSince && timerRanLong(item.timerSince, { ...(last ? { lastFiredAt: last } : {}), ...(fires.lastChangeAt !== undefined ? { lastChangeAt: fires.lastChangeAt } : {}) }) ? 'ended' : false;
    }
    // Twice, 0.7 s apart: a carousel still in its last slide transition ignores the first run.
    for (let i = 0; i < 2; i++) {
      if (i) await page.waitForTimeout(700);
      const runs = await page.evaluate(fireTimers, { handles: fires.handles, maxDelay: Number.MAX_SAFE_INTEGER, minArea: MIN_AREA, max: 10 });
      if (runs.some((r) => r.box && overlapShare(r.box, item.box) > 0.3)) return true;
    }
    return false;
  }
  const visible = await page.evaluate((id: number) => {
    const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
    const el = kit.get(id);
    if (!el || !kit.visible(el)) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) };
  }, item.el.id);
  if (!visible || visible.w < 1 || visible.h < 1) return false;
  if (item.kind === 'dom') {
    await page.evaluate(startObserving, undefined);
    await page.waitForTimeout(700);
    const regions = await page.evaluate(domChanges, { minArea: 1 });
    return regions.some((r) => overlapShare(r.box, item.box) > 0.3);
  }
  // The page's code changing the region in the meantime counts too (screenshots that happen to show the
  // same frame of a fast ticker are not "stopped").
  await page.evaluate(startObserving, undefined);
  const changes = await visualChanges(page, 600, visible);
  const dom = await page.evaluate(domChanges, { minArea: 1 }).catch(() => [] as DomRegion[]);
  if (dom.some((r) => overlapShare(r.box, item.box) > 0.3)) return true;
  // A recheck without screenshots says nothing either way: no verdict for this item.
  if (changes === null) throw new Unreadable('screenshots failed while checking whether it stopped');
  return changes.length > 0;
}

/** The frame behind each 'frame' item. */
const itemFrames = new WeakMap<MovingItem, FrameLike>();

/**
 * Whether something in an embedded frame moves by itself for more than 5 s: long animations, video
 * or SVG animation (the frame's own inventory), or a timer that changes the same region twice when
 * run early (as on the page). Returns what moves, or null.
 */
async function frameMotion(page: PageLike, f: FrameLike): Promise<string | null | 'unentered'> {
  if (!(await within(2000, f.evaluate(installKit, undefined), false))) return 'unentered';
  await f.evaluate(startBlockedAutoplay, undefined).catch(() => 0);
  const inv = await f.evaluate(motionInventory, { minArea: MIN_AREA, minMs: MOTION_LIMIT_MS, maxImages: 0 }).catch(() => null);
  if (inv?.items.length) return inv.items[0]!.what;
  const r1 = await f.evaluate(fireTimers, { handles: null, maxDelay: TIMER_MAX_DELAY, minArea: MIN_AREA, max: 20 }).catch(() => [] as TimerFire[]);
  const changing = r1.filter((r) => r.box && (r.kind === 'interval' || r.next.length));
  if (!changing.length) return null;
  await page.waitForTimeout(900);
  const r2 = await f.evaluate(fireTimers, {
    handles: changing.flatMap((r) => (r.kind === 'interval' ? [r.handle] : r.next)), maxDelay: Number.MAX_SAFE_INTEGER, minArea: MIN_AREA, max: 20,
  }).catch(() => [] as TimerFire[]);
  const again = changing.find((a) => r2.some((b) => b.timer === a.timer && b.box && overlapShare(b.box, a.box!) > 0.3));
  return again ? `content that changes by itself every ${Math.round(again.delay / 100) / 10} s` : null;
}

/** Runs in the page: the iframe element of a frame handle, when it is visible and big enough. */
function frameBox(arg: { el: unknown; minArea: number }): (KitElement & { box: KitBox }) | null {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = arg.el as Element | null;
  if (!el || !kit.visible(el) || kit.area(el) < arg.minArea) return null;
  return { ...kit.describe(el), box: kit.box(el) };
}

async function stillMovingAll(page: PageLike, items: MovingItem[], first = false): Promise<ItemState[]> {
  const quick = await page.evaluate(stillMoving, { items: items.map((i) => ({ kind: i.kind, id: i.el.id, document: i.timerSince?.document, ...(i.src ? { src: i.src } : {}) })), minMs: MOTION_LIMIT_MS });
  const out: ItemState[] = [];
  for (const [i, q] of quick.entries()) {
    const item = items[i]!;
    if (q === 'document') throw new Unreadable('the page loaded another page by itself, so this moving item could not be checked');
    if (q === 'src') {
      const src = await page.evaluate((id: number) => {
        const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
        const el = kit.get(id) as HTMLImageElement | undefined;
        return el ? el.currentSrc || el.src : '';
      }, item.el.id);
      const [anim] = await page.evaluate(readImageAnimations, { srcs: [src], maxBytes: 5_000_000 });
      out.push(!!anim && anim.frames > 1);
    } else if (q === null && item.kind === 'frame') {
      const f = itemFrames.get(item);
      const m = f ? await frameMotion(page, f) : null;
      if (m === 'unentered') throw new Unreadable('the embedded frame stopped running the test\'s code, so whether its motion stopped could not be checked');
      out.push(!!m);
    } else if (q === null) {
      out.push(await stillChanging(page, item, first));
    } else out.push(q);
  }
  return out;
}

/** Runs in the page: moves keyboard focus into the element (itself or its first focusable descendant). */
function focusInside(id: number): boolean {
  const el = (window as unknown as { __grntedKit: Kit }).__grntedKit.get(id) as HTMLElement | undefined;
  if (!el || !el.isConnected) return false;
  const sel = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const target = (el.matches(sel) ? el : el.querySelector<HTMLElement>(sel)) ?? null;
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

/** Runs in the page: blurs the focused element. */
function blurActive(): void {
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body) el.blur();
}

/** Runs in a frame: a playing video there shows its own controls. */
function frameVideoControls(): boolean {
  return [...document.querySelectorAll('video')].some((v) => !v.paused && v.controls);
}

/** Runs in a frame: clicks a control (a DOM click: frames have no page coordinates here). */
function frameClick(id: number): boolean {
  const el = (window as unknown as { __grntedKit: Kit }).__grntedKit.get(id) as HTMLElement | undefined;
  if (!el || !el.isConnected) return false;
  el.click();
  return true;
}

/**
 * Moving content inside an embedded frame: its own video controls, or pause, stop or hide controls
 * inside the frame, clicked and verified on screen. Returns the control's name, or null.
 */
async function frameControl(ctx: ProbeContext, item: MovingItem, tried: string[], refused: Candidates['refused'], acted: { any: boolean }): Promise<{ worked: string | null; entered: boolean }> {
  const { page } = ctx;
  for (const f of page.frames?.() ?? []) {
    const parent = f.parentFrame();
    if (!parent || parent.parentFrame()) continue;
    const handle = await f.frameElement().catch(() => null);
    if (!handle) continue;
    const id = await page.evaluate((el: unknown) => (window as unknown as { __grntedKit: Kit }).__grntedKit.keep(el as Element), handle).catch(() => -1);
    if (id !== item.el.id) continue;
    if (!(await within(2000, f.evaluate(installKit, undefined), false))) return { worked: null, entered: false };
    if (await f.evaluate(frameVideoControls, undefined).catch(() => false)) return { worked: 'the video controls inside the frame', entered: true };
    const found = await f.evaluate(controlsFor, { id: null, words: PAUSE_VOCAB, max: CANDIDATES }).catch(() => null);
    if (!found) return { worked: null, entered: false };
    refused.push(...found.refused);
    for (const c of found.controls) {
      if (!hasTime(ctx, 3000)) break;
      const name = `${c.name ?? c.path} (inside the frame)`;
      tried.push(name);
      if (!(await f.evaluate(frameClick, c.id).catch(() => false))) continue;
      acted.any = true;
      await f.evaluate(blurActive, undefined);
      await page.waitForTimeout(300);
      const [still] = await stillMovingAll(page, [item]);
      if (!still) return { worked: name, entered: true };
    }
    return { worked: null, entered: true };
  }
  return { worked: null, entered: false };
}

/** Puts back what a pass changed in the page (the motion test's own state, the kit, instant scrolling). */
async function cleanMotion(page: PageLike): Promise<void> {
  await within(5000, page.evaluate(() => {
    const w = window as unknown as { __grntedMotionAnims?: unknown; __grntedTimerChanges?: (on: boolean) => boolean };
    delete w.__grntedMotionAnims;
    w.__grntedTimerChanges?.(false);
  }, undefined), undefined).catch(() => {});
  await within(5000, page.evaluate(kitStop, undefined), undefined).catch(() => {});
  await within(5000, page.evaluate(instantScrollStop, undefined), undefined);
}

/**
 * The late pass's state (fix/late-mount, review r2), by page: what the first pass found moving, and the watch
 * on a page that was still mounting when it started. Only for such a page.
 */
interface MotionLate { known: MovingItem[]; tracker: MountTracker }
const motionLate = new WeakMap<object, MotionLate>();

export const motionProbe: PageProbe = {
  id: 'motion',
  criteria: ['2.2.2'],
  kind: 'interaction',
  tier: 'core',
  timeoutMs: 25_000,
  contextOptions: MOTION_CONTEXT,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    motionLate.delete(ctx.page);
    // The test scrolls to items and focuses controls, then compares screenshots: every scroll is
    // instant, or a page with smooth scrolling would look like content still moving.
    await ctx.page.evaluate(instantScrollStart, undefined).catch(() => false);
    try {
      return await runMotion(ctx);
    } finally {
      await cleanMotion(ctx.page);
    }
  },
  late: {
    timeoutMs: 25_000,
    async run(ctx, first) {
      const st = motionLate.get(ctx.page);
      motionLate.delete(ctx.page);
      if (!st) return [...first];
      try {
        return await lateMotion(ctx, st, first);
      } finally {
        st.tracker.stop();
        await cleanMotion(ctx.page);
      }
    },
  },
};

const NOTHING_MOVED = 'nothing moved, blinked or updated by itself for more than 5 s';

async function runMotion(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page } = ctx;
  await requireHook(ctx);
  await kitReady(page);
  // Whether the page is still putting its content in (one look before anything is judged; never a wait):
  // then it is watched from Node (nothing is put in the page) until the late pass. The first pass may itself
  // make the content appear (it runs the page's timers early): the watch sees when.
  const mounting = (await mountingNow(page)) === true;
  // Whether the test has clicked a control or moved focus into content yet in this pass (what may have
  // stopped a later item). Per pass: a control tried in the first pass never excuses an item found later.
  const acted = { any: false };
  // The watch only schedules the late pass; it never times anything a look judges (review r4).
  const tracker = mounting ? trackMount(page) : null;
  let first: MotionLook;
  try {
    first = await lookForMotion(ctx, []);
  } catch (err) {
    tracker?.stop();
    throw err;
  }
  if (tracker) motionLate.set(page, { known: first.moving, tracker });
  ctx.setData?.({ mounting, identitySampling: first.identitySampling });
  const findings = first.moving.length ? await judgeLook(ctx, first, acted) : [];
  if (first.moving.length) return findings;
  if (first.windowStop) throw new ProbeNotTestable(`${first.windowStop}; motion that depends on it could not be seen (${first.checked})`);
  if (first.unresolved) throw new ProbeNotTestable(unresolvedText(first));
  return [...first.openFindings, { criterion: '2.2.2', status: 'no_failures_found', detail: `${NOTHING_MOVED} (${first.checked})` }];
}

/**
 * The late pass (fix/late-mount, review r2): a page still putting its content in when the test started (an
 * app that mounts 1 to 2 s after load, `stillMounting`) is looked at again once that content is there,
 * after every other test of the page (on the motion page: after the timing test, so nothing waits in real
 * time before it). It waits at most `LATE_CONTENT_MS`, and looks only when the page went from mounting to
 * mounted (`trackMount`), for moving content the first pass did not find (not the same element or place,
 * nor the same source: `sameSource`); its "more than 5 s" is timed by its own observations, exactly as in the
 * first pass (`seenRanLong`), never from when the page mounted. The first pass's findings all stand (the
 * runner keeps them as they were if the late pass fails or times out); a control the first pass tried never
 * excuses an item found now.
 */
async function lateMotion(ctx: ProbeContext, st: MotionLate, first: readonly ProbeFinding[]): Promise<ProbeFinding[]> {
  const { page } = ctx;
  const wait = await st.tracker.settle(LATE_CONTENT_MS);
  st.tracker.stop();
  if (!wait.mounted) {
    ctx.setData?.({ late: { waitedMs: wait.ms, mounted: false, failed: wait.failed } });
    return [...first];
  }
  await page.evaluate(instantScrollStart, undefined).catch(() => false);
  await kitReady(page);
  const second = await lookForMotion(ctx, st.known);
  ctx.setData?.({ late: { waitedMs: wait.ms, mounted: true, moving: second.moving.length }, identitySampling: second.identitySampling });
  const added = second.moving.length ? await judgeLook(ctx, second, { any: false }) : openNotTestable(second);
  if (!added.length) return [...first];
  const kept = first.filter((f) => !(f.status === 'no_failures_found' && f.detail.startsWith(NOTHING_MOVED)));
  return [...kept, ...added];
}

/**
 * Whether two items found in different passes are the same motion though the page put in a new element for
 * it or moved it (a hydrated carousel), by specific identity only (review r2 of fix/late-mount): the same
 * timer, or the same image or video file. Never by an animation's name, an element type or a role: two
 * separate elements with the same CSS animation are two items, each judged.
 */
export function sameSource(a: MovingItem, b: MovingItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'timer') return !!a.timers?.length && !!a.timers.some((t) => b.timers?.includes(t));
  return !!a.src && a.src === b.src;
}

/** One look for moving content: what moves (outer items only), and what kept it from a clean result. */
interface MotionLook {
  moving: MovingItem[];
  openFindings: ProbeFinding[];
  windowStop: string | null;
  unresolved: boolean;
  checked: string;
  identitySampling: IdentityCost[];
}

const unresolvedText = (look: MotionLook) => `something changed on screen, but the time for this test ran out before it could be checked again more than 5 s after it was first seen changing (${look.checked})`;

/** A look with nothing moving whose clean result does not stand, as a finding (the other look's results stand with it). */
function openNotTestable(look: MotionLook): ProbeFinding[] {
  if (look.windowStop) return [{ criterion: '2.2.2', status: 'not_testable', detail: `${look.windowStop}; motion that depends on it could not be seen (${look.checked})` }];
  if (look.unresolved) return [{ criterion: '2.2.2', status: 'not_testable', detail: unresolvedText(look) }];
  return [];
}

/**
 * One look for moving content, leaving out what `known` (on the late pass: what the first pass found) holds.
 * Both passes time unexplained change the same way, by their own observations of the same element.
 */
async function lookForMotion(ctx: ProbeContext, known: MovingItem[]): Promise<MotionLook> {
  const { page } = ctx;
  const identitySampling: IdentityCost[] = [];
  await page.evaluate(startBlockedAutoplay, undefined);
  await page.waitForTimeout(150);
  const inv = await page.evaluate(motionInventory, { minArea: MIN_AREA, minMs: MOTION_LIMIT_MS, maxImages: 30 });
  const items: MovingItem[] = [...inv.items];
  const explainedFrames: KitBox[] = [];

  // From reading animated images to the second round of timers, navigations are trapped and the
  // guard's log is read: a request, navigation or popup it had to stop there means motion may have
  // been missed (a slideshow whose next slide is fetched, an image that could not be read).
  const windowMark = ctx.guard.mark();
  const navStart = await page.evaluate(() => {
    const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
    kit.trap(true);
    return kit.navs.length;
  }, undefined);

  // Animated images.
  if (inv.images.length) {
    const anims = await page.evaluate(readImageAnimations, { srcs: inv.images.map((i) => i.src), maxBytes: 5_000_000 });
    inv.images.forEach((img, i) => {
      const a = anims[i];
      if (!a || a.frames < 2) return;
      const lastsMs = a.loops === null ? null : a.loopMs * a.loops;
      inv.explained.push({ box: img.box, endsInMs: lastsMs });
      if (lastsMs !== null && lastsMs <= MOTION_LIMIT_MS) return;
      items.push({ kind: 'image', el: img.el, box: img.box, src: img.src, what: `an animated image (${a.frames} frames${a.loops === null ? ', looping forever' : ''})`, lastsMs });
    });
  }

  // The page's own timers, round 1; then a 0.7 s look at the screen and the DOM; then round 2.
  const t1 = performance.now();
  const pendingAtStart = await page.evaluate(pendingHandles, undefined).catch(() => [] as number[]);
  const round1 = await page.evaluate(fireTimers, { handles: null, maxDelay: TIMER_MAX_DELAY, minArea: MIN_AREA, max: 40 });
  // Motion that starts some seconds after the page loaded (WCAG 2.2.2: "starts automatically"; a notice that
  // begins to scroll after 6 s, estimates that begin to update after 11 s): the timer that starts it has just
  // been run. A repeating timer it set (not its own re-arm) gets its first run with the others, so the second
  // round can see it repeat; an endless animation or a video it started is found by a second inventory.
  const fresh = round1.length
    ? await page.evaluate(freshTimers, { before: pendingAtStart, known: round1.flatMap((r) => [r.handle, ...r.next]), maxDelay: TIMER_MAX_DELAY, max: 10 }).catch(() => [])
    : [];
  if (fresh.length) round1.push(...await page.evaluate(fireTimers, { handles: fresh.map((f) => f.handle), maxDelay: Number.MAX_SAFE_INTEGER, minArea: MIN_AREA, max: 10 }));
  if (round1.length) {
    const started = await page.evaluate(motionInventory, { minArea: MIN_AREA, minMs: MOTION_LIMIT_MS, maxImages: 0 }).catch(() => null);
    for (const it of started?.items ?? []) {
      if (items.some((k) => k.el.id === it.el.id)) continue;
      items.push({ ...it, what: `${it.what}, started by a timer the page set` });
      if (it.kind === 'video') inv.counts.videos++;
      else if (it.kind === 'svg') inv.counts.svgs++;
      else inv.counts.animations++;
    }
    if (started) inv.explained.push(...started.explained);
  }
  await page.evaluate(startObserving, undefined);
  const scroll = await scrollOf(page);
  const window1 = await shotRegions(page, 700, identitySampling);
  const screen = window1?.regions ?? null;
  const dom = await page.evaluate(domChanges, { minArea: MIN_AREA });
  // The DOM changes just read were all made no later than this (monotonic).
  const domBy = performance.now();
  if (screen === null) throw new ProbeNotTestable(NO_SHOTS);
  const wait = 900 - (performance.now() - t1);
  if (wait > 0) await page.waitForTimeout(wait);
  const changing = round1.filter((r) => r.box);
  const round2 = changing.length
    ? await page.evaluate(fireTimers, {
      handles: changing.flatMap((r) => (r.kind === 'interval' ? [r.handle] : r.next)), maxDelay: Number.MAX_SAFE_INTEGER, minArea: MIN_AREA, max: 40,
    })
    : [];
  const trapped = await page.evaluate((from: number) => {
    const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
    const navs = kit.navs.slice(from).filter((n) => !n.sameDocument);
    kit.trap(false);
    return navs.length ? navs[0]!.url.slice(0, 200) : null;
  }, navStart);
  const windowStop = (await settledStop(ctx, windowMark))
    ?? (trapped !== null ? `the test would have opened another page (${trapped}), so it was stopped` : null);
  const timerRegions: { region: KitElement; box: KitBox; timers: Set<number>; delay: number }[] = [];
  for (const r1 of changing) {
    const repeats = r1.kind === 'interval' || r1.next.length > 0;
    const again = round2.find((r2) => r2.timer === r1.timer && r2.box && overlapShare(r2.box, r1.box!) > 0.3);
    if (!repeats || !again) continue;
    const known = timerRegions.find((t) => overlapShare(t.box, r1.box!) > 0.5);
    if (known) known.timers.add(r1.timer);
    else timerRegions.push({ region: r1.region!, box: r1.box!, timers: new Set([r1.timer]), delay: r1.delay });
  }
  // When each timer was set, and the end of the test's own early runs (page clock): how long it then
  // keeps changing the content by itself is told by its natural runs (`timerRanLong`).
  const timerClock = timerRegions.length
    ? await page.evaluate(() => {
      const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
      const w = window as unknown as { __grntedHooks?: () => { timers: { firstAt?: number }[] }; __grntedTimerChanges?: (on: boolean) => boolean };
      // From now on the hook stamps each timer's own DOM changes (its callback's, never another script's).
      w.__grntedTimerChanges?.(true);
      const hooks = w.__grntedHooks?.();
      const named = (window as unknown as { __grntedDocument?: () => string }).__grntedDocument;
      const doc = typeof named === 'function' ? named() : `t${performance.timeOrigin}`;
      return { document: doc, now: performance.now(), pending: kit.pending().map((p) => ({ timer: p.timer, at: p.at })), firstAt: (hooks?.timers ?? []).map((t) => t.firstAt ?? null) };
    }, undefined).catch(() => null)
    : null;
  for (const t of timerRegions) {
    const setAt = Math.min(
      ...(timerClock?.pending ?? []).filter((p) => t.timers.has(p.timer)).map((p) => p.at),
      ...[...t.timers].map((k) => timerClock?.firstAt[k] ?? Infinity),
    );
    items.push({
      kind: 'timer', el: t.region, box: t.box, timers: [...t.timers], lastsMs: null,
      what: `content that the page changes by itself every ${Math.round(t.delay / 100) / 10} s (a carousel, slideshow, ticker or updating region)`,
      ...(timerClock && Number.isFinite(setAt) ? { timerSince: { document: timerClock.document, setAt, testedAt: timerClock.now, delay: t.delay } } : {}),
    });
  }
  // Embedded frames: the page's code cannot see their animations and timers, so each visible
  // frame gets the same inventory and timer test inside it (screenshots above see them too).
  let framesChecked = 0;
  let framesLeft = 0;
  const openFindings: ProbeFinding[] = [];
  for (const f of page.frames?.() ?? []) {
    const parent = f.parentFrame();
    if (!parent || parent.parentFrame()) continue;
    const handle = await f.frameElement().catch(() => null);
    const at = handle ? await page.evaluate(frameBox, { el: handle, minArea: MIN_AREA }).catch(() => null) : null;
    if (!at) continue;
    if (framesChecked >= MAX_FRAMES || !hasTime(ctx, 12_000)) { framesLeft++; continue; }
    framesChecked++;
    const what = await frameMotion(page, f);
    if (what === 'unentered') {
      // Its pixels may still be seen moving; without its code there is no verdict either way.
      openFindings.push({ criterion: '2.2.2', status: 'not_testable', target: at.path, detail: `an embedded frame (${f.url().slice(0, 120)}) could not run the test's code, so motion inside it and its controls were not checked` });
      explainedFrames.push(at.box);
      continue;
    }
    if (!what) continue;
    const { box, ...el } = at;
    const item: MovingItem = { kind: 'frame', el, box, lastsMs: null, what: `moving content in an embedded frame (${what})` };
    itemFrames.set(item, f);
    items.push(item);
  }

  if (framesLeft) openFindings.push({ criterion: '2.2.2', status: 'not_testable', detail: `${framesLeft} more embedded frame${framesLeft === 1 ? ' was' : 's were'} not checked (the test checks ${MAX_FRAMES} per page)` });
  // Everything a single round-1 run changed is explained too (a one-off change is not motion).
  const explainedBoxes = [...inv.explained.map((e) => e.box), ...changing.map((r) => r.box!), ...items.map((i) => i.box), ...explainedFrames, ...known.map((i) => i.box)];

  // Unexplained change: look again more than 5 s after it was first seen changing, and keep only the same
  // element still changing then (`seenRanLong`, review r4 of fix/late-mount: motion's own observations are its
  // only clock; never the page's load, nor when a late-mounting page's content appeared).
  const unexplained = (b: KitBox) => !explainedBoxes.some((e) => overlapShare(b, e) > 0.5);
  // Each element seen changing (unexplained), with the earliest moment it is known to have changed: its first
  // observation, from a pair of shots with that same element there at both. A region whose element could not
  // be told, or was not the same at both shots, has no identity to follow from that pair.
  const firstSeen = new Map<number, number>();
  for (const { id, pair } of pairsByElement(screen ?? [], window1?.seen ?? [])) {
    if (!unexplained({ x: pair.at.x + scroll.x, y: pair.at.y + scroll.y, w: pair.at.w, h: pair.at.h })) continue;
    firstSeen.set(id, Math.min(firstSeen.get(id) ?? Infinity, pair.by));
  }
  let domBoxes = dom.filter((d) => d.batches >= 2 && d.lastAt - d.firstAt >= 150 && unexplained(d.box));
  const unresolved = (firstSeen.size || domBoxes.length) && !hasTime(ctx, 9000);
  if ((firstSeen.size || domBoxes.length) && !unresolved) {
    const until = async (t: number) => {
      const ms = t - performance.now();
      if (ms > 0) await page.waitForTimeout(Math.min(ms, MOTION_LIMIT_MS + 1000));
    };
    // Once every element seen changing can be seen again more than 5 s after its first observation.
    const visualDue = firstSeen.size ? Math.max(...firstSeen.values()) + MOTION_LIMIT_MS + MOTION_RECHECK_MARGIN_MS : null;
    const domDue = domBoxes.length ? domBy + MOTION_LIMIT_MS + MOTION_RECHECK_MARGIN_MS : null;
    await until(Math.min(visualDue ?? Infinity, domDue ?? Infinity));
    // The DOM is watched through the screenshots when that starts late enough; otherwise on its own after them.
    let domAfter: number | null = null;
    if (domDue !== null && performance.now() >= domDue) {
      domAfter = performance.now();
      await page.evaluate(startObserving, undefined);
    }
    let later: { regions: SeenRegion[]; seen: unknown[] } | null = { regions: [], seen: [] };
    if (visualDue !== null) {
      await until(visualDue);
      later = await shotRegions(page, 600, identitySampling);
    }
    if (later === null) {
      // Changes already seen could not be looked at again: no verdict on them, the rest still counts.
      openFindings.push({ criterion: '2.2.2', status: 'not_testable', detail: `something changed on screen, but ${NO_SHOTS.replace('the browser could not take screenshots, so ', 'screenshots failed on the second look, so ')}` });
    }
    let dom2: DomRegion[] = [];
    if (domDue !== null) {
      if (domAfter === null) {
        await until(domDue);
        domAfter = performance.now();
        await page.evaluate(startObserving, undefined);
        await page.waitForTimeout(600);
      } else if (visualDue === null) {
        await page.waitForTimeout(600);
      }
      dom2 = await page.evaluate(domChanges, { minArea: MIN_AREA });
    }
    // The same DOM region (by identity), watched from more than 5 s after its first changes were all made.
    const domAt = domAfter;
    domBoxes = domAt === null ? [] : domBoxes.filter((d) => dom2.some((e) => seenRanLong({ by: domBy, id: d.el.id }, { after: domAt, id: e.el.id })));
    // What changes now, by element (the same element at both shots of a pair): only an element first seen
    // changing more than 5 s earlier counts (by identity, wherever in it the change is now: a bar moving across
    // a canvas; another element now in the same place has its own clock, and was not seen changing for 5 s).
    const proven = new Map<number, SeenPair>();
    for (const { id, pair } of pairsByElement(later?.regions ?? [], later?.seen ?? [])) {
      const by = firstSeen.get(id);
      if (by !== undefined && seenRanLong({ by, id }, { after: pair.after, id })) proven.set(id, pair);
    }
    if (proven.size) {
      const ids = [...proven.keys()];
      const els = await page.evaluate(describeIds, ids);
      for (const el of els) {
        if (!el) continue;
        // A frame already tested inside (a 'frame' item) is not counted again from screenshots.
        if (items.some((it) => overlapShare(it.box, el.box) > 0.5)) continue;
        if (await foldInto(page, items, el.id, el.box)) continue;
        const { box, ...rest } = el;
        items.push({ kind: 'visual', el: rest, box, lastsMs: null, what: `${rest.tag === 'canvas' ? 'a canvas animation' : rest.tag === 'iframe' ? 'moving content in an embedded frame' : 'content that keeps moving or changing on screen'} (seen still changing more than 5 s after it was first seen changing)` });
      }
    }
    for (const d of domBoxes) {
      if (items.some((i) => overlapShare(i.box, d.box) > 0.5)) continue;
      if (await foldInto(page, items, d.el.id, d.box)) continue;
      items.push({ kind: 'dom', el: d.el, box: d.box, lastsMs: null, what: 'content that the page\'s code keeps changing (seen still changing more than 5 s after it was first seen changing)' });
    }
  }

  // Nested items: keep the outer one (a carousel rather than its slides' animations).
  items.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const moving: MovingItem[] = [];
  for (const it of items) {
    const inside = moving.some((m) => it.box.x >= m.box.x - 2 && it.box.y >= m.box.y - 2 && it.box.x + it.box.w <= m.box.x + m.box.w + 2 && it.box.y + it.box.h <= m.box.y + m.box.h + 2 && m.kind !== 'video');
    // On the second look, what the first pass already found is not counted again.
    const known1 = known.some((k) => k.el.id === it.el.id || overlapShare(k.box, it.box) > 0.5 || sameSource(k, it));
    if (!inside && !known1) moving.push(it);
  }
  const checked = `${inv.counts.animations} animation${inv.counts.animations === 1 ? '' : 's'}, ${inv.counts.videos} playing video${inv.counts.videos === 1 ? '' : 's'}, ${inv.images.length} image${inv.images.length === 1 ? '' : 's'}, ${round1.length} timer${round1.length === 1 ? '' : 's'}${framesChecked ? ` and ${framesChecked} embedded frame${framesChecked === 1 ? '' : 's'}` : ''} checked${inv.counts.indicators ? `; ${inv.counts.indicators} loading indicator${inv.counts.indicators === 1 ? '' : 's'} (progress bars, busy regions, small spinners) left out` : ''}`;
  return { moving, openFindings, windowStop, unresolved: !!unresolved, checked, identitySampling };
}

/** A control for each moving item of a look, verified by clicking it. */
async function judgeLook(ctx: ProbeContext, look: MotionLook, acted: { any: boolean }): Promise<ProbeFinding[]> {
  const { windowStop } = look;
  const findings: ProbeFinding[] = [...look.openFindings];
  const moving = look.moving;
  const list = moving.slice(0, MAX_ITEMS);
  for (const item of list) {
    // Each region is considered alone: another updating region is other content too.
    if (await ctx.page.evaluate(onlyContent, { id: item.el.id, kind: item.kind }).catch(() => false)) {
      findings.push({ criterion: '2.2.2', status: 'not_applicable', target: item.el.path, detail: `${item.what} is all the page shows: nothing else is presented in parallel with it (${look.checked})` });
      continue;
    }
    const desc = `${item.what} (runs ${lasting(item.lastsMs)})`;
    try {
      await judgeItem(ctx, item, desc, findings, acted);
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: ${err.message}` });
    }
  }
  if (moving.length > list.length) {
    // Moving items not tried get no verdict, so the page can never look clean because of the cap.
    findings.push({ criterion: '2.2.2', status: 'not_testable', detail: `${moving.length - list.length} more moving item${moving.length - list.length === 1 ? ' was' : 's were'} not tried (the test tries ${MAX_ITEMS} per page)` });
  }
  // The guard stopped something while the probe was measuring: an item that then looked still (or
  // stopped) has no clean verdict, since what was stopped may be what kept it moving.
  if (windowStop) return findings.map((f) => (f.status === 'no_failures_found' ? { ...f, status: 'not_testable', detail: `${windowStop}; ${f.detail}` } : f));
  return findings;
}

/** Runs in the page: the first of `ids` whose element is `id`'s element, inside it, or around it; -1 if none. */
function relatedElement(arg: { id: number; ids: number[] }): number {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const a = kit.get(arg.id);
  if (!a) return -1;
  return arg.ids.findIndex((id) => {
    const b = kit.get(id);
    return !!b && (a === b || a.contains(b) || b.contains(a));
  });
}

/**
 * A region seen changing on screen (or in the DOM) whose element holds, or sits inside, an item
 * already found (an animation, video, image, SVG or timer region) is that item's motion: one moving
 * region, one item. Decided by the elements, not by boxes: an animation that moves its element (a
 * ticker's text sliding through its box) has a box that depends on when it was read. The item keeps
 * its element (its recheck and controls need it) and takes the region's box too. True when folded.
 */
async function foldInto(page: PageLike, items: MovingItem[], id: number, box: KitBox): Promise<boolean> {
  const known = items.filter((i) => i.kind !== 'visual' && i.kind !== 'dom' && i.kind !== 'frame');
  if (!known.length) return false;
  const at = await page.evaluate(relatedElement, { id, ids: known.map((i) => i.el.id) }).catch(() => -1);
  const item = known[at];
  if (!item) return false;
  const x = Math.min(item.box.x, box.x);
  const y = Math.min(item.box.y, box.y);
  item.box = { x, y, w: Math.max(item.box.x + item.box.w, box.x + box.w) - x, h: Math.max(item.box.y + item.box.h, box.y + box.h) - y };
  return true;
}

/** The verdict for one moving item: native controls, a control that stops it, pause on focus, or failed. */
/** Why an item looked still: a control the test tried earlier, or (nothing tried yet) it had stopped on its own. */
const STILL_BY_CONTROL = 'it stopped or was hidden by a control tried earlier';
const STILL_BY_ITSELF = 'it was no longer moving or changing when the test came back to it, before any pause, stop or hide control was tried';

/** How long (ms) until a timer item has run more than 5 s since its timer was set (0: already, or not a timer item). */
async function timerWait(page: PageLike, item: MovingItem): Promise<number> {
  if (item.kind !== 'timer' || !item.timerSince) return 0;
  const now = await page.evaluate((expected: string) => {
    const named = (window as unknown as { __grntedDocument?: () => string }).__grntedDocument;
    const doc = typeof named === 'function' ? named() : `t${performance.timeOrigin}`;
    return doc === expected ? performance.now() : null;
  }, item.timerSince.document);
  if (now === null) throw new Unreadable('the page loaded another page by itself, so this moving item could not be checked');
  return timerDue(item.timerSince, now);
}

/**
 * How long (ms) until an endless animation item has run more than 5 s since it started (0: already, a finite one,
 * or not an animation). An animation declared endless that the page's script stops after 3 s (a pulse, a shimmer
 * until content mounts) is not failed for being caught early (act-watch review r1, F6b). Its start (document
 * timeline ms) was kept when it was listed (`__grntedMotionAnims`).
 */
async function animationWait(page: PageLike, item: MovingItem): Promise<number> {
  if (item.kind !== 'animation' || item.lastsMs !== null) return 0;
  const left = await page.evaluate((a: { id: number; limit: number }) => {
    const kit = (window as unknown as { __grntedKit?: Kit }).__grntedKit;
    const el = kit?.get(a.id);
    const kept = el ? (window as unknown as { __grntedMotionAnims?: Map<Element, { start: number; active: number }[]> }).__grntedMotionAnims?.get(el) : undefined;
    const starts = (kept ?? []).filter((k) => !Number.isFinite(k.active)).map((k) => k.start);
    if (!starts.length) return 0;
    return Math.min(...starts) + a.limit - Number(document.timeline.currentTime ?? 0);
  }, { id: item.el.id, limit: MOTION_LIMIT_MS }).catch(() => 0);
  return Math.max(0, Math.min(MOTION_TIMER_RECHECK.maxWaitMs, left + MOTION_TIMER_RECHECK.marginMs));
}

/** Time (ms) until `since.setAt` plus 5 s and a margin, at most `MOTION_TIMER_RECHECK.maxWaitMs`. */
export function timerDue(since: { setAt: number }, now: number): number {
  return Math.max(0, Math.min(MOTION_TIMER_RECHECK.maxWaitMs, since.setAt + MOTION_LIMIT_MS + MOTION_TIMER_RECHECK.marginMs - now));
}

/** A repeating timer is looked at again once it has run 5 s and this margin (ms), waiting at most `maxWaitMs`. */
export const MOTION_TIMER_RECHECK = { marginMs: 500, maxWaitMs: 5500 } as const;

/**
 * An item whose own timing ran its course of more than 5 s by itself ('ended'). WCAG 2.2.2 asks for a
 * way to pause, stop or hide motion that lasts more than 5 s; this one already did, and no control was
 * shown to stop it, so it failed, also when a control that looks like one is on the page (it can no
 * longer be checked on motion that has ended, and the motion ran its 5 s without it). The one case with
 * no verdict: it ended while a control was being tried and other controls were still to be tried.
 */
function endedItem(findings: ProbeFinding[], item: MovingItem, desc: string, found: Candidates, tried: string[], notOperable = false): void {
  const left = found.controls.map((c) => c.name ?? c.path).filter((n) => !tried.includes(n));
  const quote = (xs: string[]) => xs.map((t) => `"${t.slice(0, 40)}"`).join(', ');
  if (notOperable && !tried.length && left.length) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: it ran by itself for more than 5 s and stopped on its own, and it could not be run again (the page removed, hid or reset it), so whether ${quote(left)} could pause, stop or hide it could not be checked` });
    return;
  }
  if (tried.length && left.length) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: it ran by itself for more than 5 s and stopped on its own while ${quote(tried.slice(-1))} was tried (not because of it), so whether ${quote(left)} could pause, stop or hide it could not be checked` });
    return;
  }
  // Nothing to try and nothing left out: the same sentence as an item still moving with no control (judgeOne's
  // last branch), so the verdict's text does not depend on whether it ended before the test came back to it
  // (act-watch review r1, F6c: the timing fixture's 8 s fades landed on one or the other by the host's speed).
  if (!tried.length && !left.length && !found.refused.length) {
    findings.push({ criterion: '2.2.2', status: 'failed', target: item.el.path, detail: `${item.what} starts by itself and runs ${lasting(item.lastsMs)}; nothing on the page pauses, stops or hides it (no pause, stop or hide control was found)` });
    return;
  }
  const how = tried.length
    ? `it stopped on its own while ${quote(tried.slice(-1))} was tried (not because of it), and no control was shown to pause, stop or hide it (controls tried, without effect: ${quote(tried)})`
    : `it ran by itself for more than 5 s and then stopped on its own before any control was tried, and no control was shown to pause, stop or hide it (${left.length || found.refused.length ? `controls on the page that could not be checked on it any more: ${quote([...left, ...found.refused.map((r) => r.name)].slice(0, 4))}` : 'no pause, stop or hide control was found'})`;
  findings.push({ criterion: '2.2.2', status: 'failed', target: item.el.path, detail: `${item.what} starts by itself and runs ${lasting(item.lastsMs)}; ${how}` });
}

/**
 * Runs in the page: an animation item that ran its own course (`stillMoving` 'ended') is run again from
 * its start, so the controls on the page can be checked on it. A finished animation is seeked back
 * (currentTime, not play(), which would override the page's CSS animation-play-state). A CSS animation
 * the page removed when it ended with an inline `animation: none` gets that inline value lifted, so the
 * page's own CSS runs it again (its controls reach it as before). Otherwise it is rebuilt from the
 * keyframes kept at the inventory, as a copy page styles do not reach ('copy': a control that seems not
 * to work on it proves nothing). An element removed or not displayed is not run again. The animation
 * events these cause are kept from the page (its animationend handlers do not run twice). 'restore'
 * puts everything back: seeked ones at their end, the inline value back, the copy cancelled.
 */
function replayEnded(arg: { id: number; op: 'replay' | 'restore' }): { replayed: number; copy: boolean } {
  type Kept = { a: Animation; css: string; kf: Keyframe[]; timing: EffectTiming };
  type Done = { seek: Animation[]; inline: { el: HTMLElement; animation: string; name: string } | null; copies: Animation[]; block: (e: Event) => void };
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const w = window as unknown as { __grntedMotionAnims?: Map<Element, Kept[]>; __grntedReplay?: Done };
  const events = ['animationstart', 'animationend', 'animationiteration', 'animationcancel'];
  if (arg.op === 'restore') {
    const d = w.__grntedReplay;
    if (!d) return { replayed: 0, copy: false };
    for (const a of d.seek) {
      try {
        const end = Number((a.effect as KeyframeEffect | null)?.getComputedTiming().endTime ?? NaN);
        if (Number.isFinite(end) && a.playState !== 'idle') a.currentTime = end;
      } catch { /* gone */ }
    }
    if (d.inline) { d.inline.el.style.animation = d.inline.animation; if (d.inline.name) d.inline.el.style.animationName = d.inline.name; }
    for (const c of d.copies) { try { c.cancel(); } catch { /* gone */ } }
    delete w.__grntedReplay;
    // The events the restore itself causes are dispatched on the next frames.
    requestAnimationFrame(() => requestAnimationFrame(() => { for (const t of events) window.removeEventListener(t, d.block, true); }));
    return { replayed: d.seek.length + d.copies.length + (d.inline ? 1 : 0), copy: d.copies.length > 0 };
  }
  const el = kit.get(arg.id) as HTMLElement | undefined;
  if (!el || !el.isConnected || !kit.visible(el, true)) return { replayed: 0, copy: false };
  const kept = w.__grntedMotionAnims?.get(el) ?? [];
  const block = (e: Event) => { if (e.target === el) e.stopImmediatePropagation(); };
  for (const t of events) window.addEventListener(t, block, true);
  const d: Done = { seek: [], inline: null, copies: [], block };
  w.__grntedReplay = d;
  for (const k of kept) {
    if (k.a.playState === 'finished') {
      try { k.a.currentTime = 0; if ((k.a.playState as string) === 'running') d.seek.push(k.a); } catch { /* not seekable */ }
    }
  }
  if (!d.seek.length) {
    const cssKept = kept.find((k) => k.a.playState === 'idle' && k.css);
    if (cssKept && !d.inline && (/\bnone\b/.test(el.style.animation) || el.style.animationName === 'none')) {
      d.inline = { el, animation: el.style.animation, name: el.style.animationName };
      el.style.removeProperty('animation');
      el.style.removeProperty('animation-name');
      const back = el.getAnimations().some((x) => (x as Animation & { animationName?: string }).animationName === cssKept.css && x.playState === 'running');
      if (!back) { el.style.animation = d.inline.animation; if (d.inline.name) el.style.animationName = d.inline.name; d.inline = null; }
    }
    if (!d.inline) {
      for (const k of kept.filter((x) => x.a.playState === 'idle' && x.kf.length)) {
        try {
          const t = k.timing;
          d.copies.push(el.animate(k.kf, { duration: t.duration, iterations: t.iterations, direction: t.direction, easing: t.easing, fill: t.fill }));
        } catch { /* cannot be built */ }
      }
    }
  }
  const replayed = d.seek.length + d.copies.length + (d.inline ? 1 : 0);
  if (!replayed) { for (const t of events) window.removeEventListener(t, block, true); delete w.__grntedReplay; }
  return { replayed, copy: d.copies.length > 0 };
}

/** Runs in the page: no meaningful content is shown alongside this particular moving region. */
function onlyContent(arg: { id: number; kind: Kind }): boolean {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const item = kit.get(arg.id);
  if (!item || !document.body) return false;
  const changed = (window as unknown as { __grntedMotionChanged?: Set<Node> }).__grntedMotionChanged;
  // A canvas is itself the measured region: its pixels can move without any DOM mutation.
  // Expanded DOM regions still need ownership of the nodes that actually changed (ACT).
  const expanded = (arg.kind === 'timer' || arg.kind === 'dom' || arg.kind === 'visual') && item.localName !== 'canvas';
  if (expanded) {
    // Region expansion can combine independent changing nodes. Their union is not one region's exception.
    const nodes = [...(changed ?? [])].filter((n) => n.isConnected && (n === item || item.contains(n)));
    let root = nodes[0];
    if (!root) return false;
    for (const n of nodes) if (n.contains(root)) root = n;
    const outer = root;
    if (!nodes.every((n) => outer.contains(n))) return false;
  }
  const inside = (n: Node) => {
    if (item !== n && !item.contains(n)) return false;
    // A timer/DOM/screenshot region may be an expanded container. Only its observed changing nodes count.
    if (expanded) {
      return !!changed && [...changed].some((c) => c === n || c.contains(n));
    }
    return true;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || !/\S/.test(n.nodeValue ?? '') || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || inside(n)) continue;
    if (kit.visible(parent, true)) return false;
  }
  for (const el of document.body.querySelectorAll('img, svg, video, canvas, iframe, object, embed, input, select, textarea, button, a[href], [role="img"]')) {
    if (inside(el) || el.contains(item)) continue;
    if (kit.visible(el, true)) return false;
  }
  return true;
}

/** A pause, stop or hide control's verbs (never play or resume: a hidden "Play" is the other half of a working toggle). */
const HIDDEN_PAUSE = /(^|[\s"'(])(pause|stop|hide|freeze)\b|⏸|⏹|❚❚/i;
/** Names of a button that shows more controls: a settings or controls panel. */
const REVEAL = /\b(controls?|settings|options|preferences|accessibility|motion|animations?)\b/i;
/** Names never clicked (as `Kit.controls`' FORBIDDEN): the visitor's account, money, messages or data. */
const NEVER = /account|subscri|membership|trial|profile|order|\bpay|billing|donat|purchas|checkout|\bcart\b|cancel|delete|remov|log ?out|sign ?out|password|e-?mails?\b|notification|newsletter|sharing|\bshare\b|alert|delivery|shipment|service/i;

/** Runs in the page: names of buttons named to pause, stop or hide that are not shown now (at most 5). */
function hiddenPauseControls(arg: { pattern: string; never: string }): string[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const re = new RegExp(arg.pattern, 'i');
  const never = new RegExp(arg.never, 'i');
  const out: string[] = [];
  for (const el of document.querySelectorAll('button, input[type="button"], [role="button"]')) {
    if (out.length >= 5) break;
    if (kit.visible(el, true)) continue;
    const name = (el.getAttribute('aria-label') || (el as HTMLInputElement).value || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || name.split(' ').length > 4 || !re.test(name) || never.test(name)) continue;
    if (el instanceof HTMLButtonElement && el.form && el.type === 'submit') continue;
    out.push(name);
  }
  return out;
}

/**
 * Runs in the page: visible buttons that may open a panel of controls: named for controls or settings, or saying
 * they expand something (aria-expanded="false", aria-haspopup). Never a form's submit button or a name about the
 * visitor's account or money. At most `max`.
 */
function revealCandidates(arg: { pattern: string; never: string; max: number }): KitElement[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const re = new RegExp(arg.pattern, 'i');
  const never = new RegExp(arg.never, 'i');
  const out: KitElement[] = [];
  for (const el of document.querySelectorAll('button, input[type="button"], [role="button"], summary')) {
    if (out.length >= arg.max) break;
    if (!kit.visible(el) || (el as HTMLButtonElement).disabled) continue;
    if (el instanceof HTMLButtonElement && el.form && el.type === 'submit') continue;
    const name = kit.name(el);
    if (!name || name.split(/\s+/).length > 4 || never.test(name)) continue;
    const expands = el.getAttribute('aria-expanded') === 'false' || el.hasAttribute('aria-haspopup') || el.localName === 'summary';
    if (!re.test(name) && !expands) continue;
    out.push(kit.describe(el));
  }
  return out;
}

/**
 * When no shown control worked: pause controls the page keeps hidden are looked for. A visible button that may open
 * them (`revealCandidates`) is clicked, and each pause control it shows is tried. `worked`: "<control>" (shown by
 * "<button>"); `hidden`: the hidden pause controls still not shown (and not tried) at the end.
 */
async function revealPause(ctx: ProbeContext, item: MovingItem, tried: string[], acted: { any: boolean }, mark: number, after?: (at: number, live?: boolean, shownBefore?: boolean) => Promise<ItemState>): Promise<{ worked: string | null; hidden: string[]; ended?: true }> {
  const { page } = ctx;
  const ask = { pattern: HIDDEN_PAUSE.source, never: NEVER.source };
  const hidden = await page.evaluate(hiddenPauseControls, ask).catch(() => [] as string[]);
  if (!hidden.length) return { worked: null, hidden: [] };
  const openers = await page.evaluate(revealCandidates, { pattern: REVEAL.source, never: NEVER.source, max: 3 }).catch(() => [] as KitElement[]);
  for (const o of openers) {
    if (!hasTime(ctx, 3000) || (await settledStop(ctx, mark))) break;
    if (!(await clickControl(page, o, item.el.id))) continue;
    acted.any = true;
    const found = await page.evaluate(controlsFor, { id: item.el.id, words: PAUSE_VOCAB, max: CANDIDATES, closers: true, unknown: true }).catch(() => null);
    for (const c of (found?.controls ?? []).filter((x) => !tried.includes(x.name ?? x.path) && hidden.includes((x.name ?? '').slice(0, 60)))) {
      if (!hasTime(ctx, 3000)) break;
      tried.push(c.name ?? c.path);
      const shownBefore = await page.evaluate(itemShown, item.el.id).catch(() => false);
      const at = await page.evaluate(() => performance.now(), undefined).catch(() => Number.NaN);
      if (!(await clickControl(page, c, item.el.id))) continue;
      await page.evaluate(blurActive, undefined);
      await page.waitForTimeout(300);
      if (await settledStop(ctx, mark)) return { worked: null, hidden: [] };
      // The same attribution as a visible control's (Sol r1 S11): an end of its own is no control's; hidden right after
      // the press is the control's doing, whether or not the motion's own end came then too.
      let still: ItemState;
      if (after) still = await after(at, undefined, shownBefore);
      else {
        [still = false] = await stillMovingAll(page, [item]);
        if (still === 'ended' && shownBefore && !(await page.evaluate(itemShown, item.el.id).catch(() => true))) still = false;
      }
      // The same attribution rule as a control that was already visible: an end during this check
      // cannot prove that the control failed.
      if (still === false || still === 'ended') return { worked: `"${(c.name ?? c.path).slice(0, 40)}" (shown by "${(o.name ?? o.path).slice(0, 40)}")`, hidden: [], ...(still === 'ended' ? { ended: true as const } : {}) };
    }
  }
  const left = await page.evaluate(hiddenPauseControls, ask).catch(() => hidden);
  return { worked: null, hidden: left.filter((n) => !tried.includes(n)) };
}

/** Runs in the page: the moving item is in the page and shown (its own fading aside). */
function itemShown(id: number): boolean {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = kit.get(id);
  return !!el && el.isConnected && kit.visible(el, true);
}

/** Marks a control whose label could not be read (`frequencyControl`): never a name a page can give a control. */
const UNREAD_LABEL = '\u0000unread:';

/** A visible control that sets how often content updates, and its setting that stops the updates when it has one. */
export interface FrequencyControl {
  id: number;
  /** Its name, or `UNREAD_LABEL` and its tag when its label could not be read (what it sets is then not known). */
  name: string;
  /** The option (of a select, or of a group of radio buttons) that says updates stop: "Manual only", "Off", "Never". */
  stop?: { kind: 'select' | 'radio'; value: string; label: string };
}

/**
 * Runs in the page: a visible control that sets how often content updates ("Update scores every", "Refresh
 * interval", "Update frequency"), or null. It is named by its own label: a label's words without the text of
 * the control inside it (a select wrapped in its label reads "Update frequencyEvery 5 seconds…" as one string,
 * in which no word "frequency" is found), aria-label, aria-labelledby, title, or the legend or name of its
 * group of radio buttons. Its option that stops the updates is reported so the test can try it.
 *
 * Every name the coverage lane's reading finds is read too: the accessible name and the words of each of its labels,
 * a label ancestor included, read text node by text node without the control's own (its options), so whatever
 * sits between a label and the control inside it, the label's words are read as words (2026-11-10, round-2
 * review: with the words and the select in a span inside the label, dropping the child that held the control
 * dropped the words too).
 *
 * A control that sets a value (a select, a slider, a number field) under a label ancestor with no words of its
 * own, and with no other name, cannot be read at all: what it is for is not known, so it is returned as
 * unreadable (`UNREAD_LABEL` and its tag) and the content is not failed. A label that can be read and says
 * nothing of how often is no frequency control.
 */
function frequencyControl(): FrequencyControl | null {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const re = /\b(?:frequency|interval|how often|(?:update|refresh|reload)\w*(?:\s+\w+){0,2}\s+(?:every|rate|interval))\b/i;
  const STOP = /^(?:manual(?:ly)?(?: only| updates?| refresh)?|off|never|none|paused?|stop(?:ped)?|disabled?|no (?:auto(?:matic)?[- ]?)?(?:updates?|refresh(?:ing)?)|do(?:n['’]?t| not) (?:update|refresh))$/i;
  const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  const ownText = (root: Element): string => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), i = 0; n && i < 400; n = walker.nextNode(), i++) {
      if (n.parentElement?.closest('select, option, datalist, input, textarea, button, script, style') && n.parentElement.closest('select, option, datalist, input, textarea, button, script, style') !== root) continue;
      parts.push(n.nodeValue ?? '');
    }
    return clean(parts.join(' '));
  };
  /** The label's own words: every text node in it that is not inside the control, joined by spaces. */
  const own = (label: Element, el: Element): string => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), i = 0; n && i < 400; n = walker.nextNode(), i++) {
      if (el.contains(n)) continue;
      const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  };
  const labelled = (el: Element): string[] => [
    clean(el.getAttribute('aria-label')), clean(el.getAttribute('title')),
    ...clean(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean).map((id) => clean(document.getElementById(id)?.textContent)),
    ...[...((el as HTMLInputElement).labels ?? [])].map(ownText),
  ].filter(Boolean);
  const VALUE = 'select, input[type="range"], input[type="number"], [role="slider"], [role="spinbutton"], [role="combobox"]';
  let unread: FrequencyControl | null = null;
  for (const el of document.querySelectorAll('select, input, button, fieldset, [role="slider"], [role="spinbutton"], [role="combobox"], [role="radiogroup"]')) {
    if (!kit.visible(el, true)) continue;
    const group = el.localName === 'fieldset' || el.getAttribute('role') === 'radiogroup';
    if (el.localName === 'fieldset' && !el.querySelector('input[type="radio"]')) continue;
    const labels: Element[] = [...((el as HTMLInputElement).labels ?? [])];
    const around = el.closest('label');
    if (around && !labels.includes(around)) labels.push(around);
    const names = [
      ...labelled(el),
      ...(group ? [clean(el.querySelector(':scope > legend')?.textContent)] : []),
      // A button, a slider or a field is named by what it shows too; a select's text is its options.
      ...(el.localName !== 'select' && !group ? [clean(kit.name(el))] : []),
      // The coverage lane's names stay found: the accessible name, and each label's text and its own words.
      clean(kit.name(el)), ...labels.map((l) => clean(l.textContent)), ...labels.map((l) => own(l, el)),
    ].filter(Boolean);
    const hit = names.find((n) => re.test(n));
    if (!hit) {
      if (unread || !around || !el.matches(VALUE)) continue;
      // No word of the label outside the control, and no name given another way: what it sets cannot be read.
      const named = [el.getAttribute('aria-label'), el.getAttribute('title'), ...(el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent : ''))]
        .some((t) => /\p{L}/u.test(t ?? ''));
      const pictured = [...around.querySelectorAll('img[alt], svg title, [aria-label]')].some((x) => !el.contains(x) && /\p{L}/u.test(x.getAttribute('alt') ?? x.getAttribute('aria-label') ?? x.textContent ?? ''));
      if (!named && !pictured && !/\p{L}/u.test(own(around, el))) unread = { id: kit.keep(el), name: `\u0000unread:${el.localName}${el.id ? `#${el.id}` : ''}` };
      continue;
    }
    const out: FrequencyControl = { id: kit.keep(el), name: hit.slice(0, 80) };
    if (el instanceof HTMLSelectElement) {
      const o = [...el.options].find((x) => !x.disabled && STOP.test(clean(x.textContent)));
      if (o) out.stop = { kind: 'select', value: o.value, label: clean(o.textContent).slice(0, 40) };
    } else if (group) {
      for (const r of el.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
        const label = [...(r.labels ?? [])].map(ownText).find(Boolean) ?? clean(r.getAttribute('aria-label'));
        if (!r.disabled && label && STOP.test(label)) { out.stop = { kind: 'radio', value: r.value, label: label.slice(0, 40) }; break; }
      }
    }
    return out;
  }
  return unread;
}

/** Runs in the page: sets a frequency control to its setting that stops the updates, as a person would (input and change events). */
function setFrequencyStop(arg: { id: number; kind: 'select' | 'radio'; value: string }): boolean {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = kit.get(arg.id);
  if (!el || !el.isConnected) return false;
  if (arg.kind === 'select' && el instanceof HTMLSelectElement) {
    const o = [...el.options].find((x) => x.value === arg.value);
    if (!o) return false;
    el.value = o.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const radio = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === arg.value && !r.disabled);
  if (!radio) return false;
  radio.click();
  return true;
}

/** How long, in real time, what a control stopped is watched after keyboard focus left the control. */
export const HOLD_WINDOW_MS = 1200;

/**
 * Whether a control that stopped something keeps it stopped: `held`; `undone` with what started it again; or
 * `unverified` when no time was left to look (never the same answer as `held`: a hold that was not checked is
 * not a hold).
 */
export type Hold = { kind: 'held' } | { kind: 'undone'; how: string } | { kind: 'unverified' };

/**
 * Whether what a control stopped starts again by itself (WCAG's "paused": "stopped by user request and not
 * resumed until requested by user"; G4's test: "the moving or scrolling has stopped and does not restart by
 * itself"). Keyboard focus leaves the control (the mouse has left it already), the item is watched for
 * `HOLD_WINDOW_MS`, and the timers the page set when the control was used are run (a hide that brings the content
 * back after some seconds, a "manual" setting that goes back to updating).
 */
export async function holdCheck(ctx: ProbeContext, item: MovingItem, before: number[]): Promise<Hold> {
  const { page } = ctx;
  if (!hasTime(ctx, 6000)) return { kind: 'unverified' };
  await page.evaluate(blurActive, undefined).catch(() => {});
  await page.waitForTimeout(350);
  let [again] = await stillMovingAll(page, [item]);
  if (again === true) return { kind: 'undone', how: 'it stopped, then started again by itself when keyboard focus left the control' };
  await page.waitForTimeout(HOLD_WINDOW_MS - 350);
  [again] = await stillMovingAll(page, [item]);
  if (again === true) return { kind: 'undone', how: `it stopped, then started again by itself within ${Math.round(HOLD_WINDOW_MS / 100) / 10} s` };
  if (!hasTime(ctx, 3500)) return { kind: 'unverified' };
  const fresh = await page.evaluate(freshTimers, { before, known: [], maxDelay: TIMER_MAX_DELAY, max: 6 }).catch(() => []);
  if (!fresh.length) return { kind: 'held' };
  await page.evaluate(fireTimers, { handles: fresh.map((f) => f.handle), maxDelay: Number.MAX_SAFE_INTEGER, minArea: MIN_AREA, max: 6 }).catch(() => []);
  await page.waitForTimeout(300);
  [again] = await stillMovingAll(page, [item]);
  const s = Math.round(Math.max(...fresh.map((f) => f.delay)) / 100) / 10;
  if (again === true) return { kind: 'undone', how: `it stopped, then started again by itself (a timer the page set when the control was used brings it back within ${s} s)` };
  return { kind: 'held' };
}

/**
 * Runs in the page (batch 17, item 1): records when each canvas was last drawn on (2D and WebGL draw calls, by the
 * page's clock), so that a canvas that went still after a control was pressed can be told from one whose own end
 * came: drawing that went on after the press was not stopped by it. Installed once; `restore` puts the originals back.
 */
function trackDraws(arg: { op: 'start' | 'restore'; draws?: boolean }): boolean {
  type Kept = { proto: Record<string, unknown>; name: string; f: unknown }[];
  type Draws = { last: WeakMap<object, number>; kept: Kept; pressAt: number; onPress: () => void };
  const w = window as unknown as { __grntedDraws?: Draws };
  if (arg.op === 'restore') {
    const d = w.__grntedDraws;
    if (!d) return false;
    for (const k of d.kept) { try { k.proto[k.name] = k.f; } catch { /* sealed */ } }
    window.removeEventListener('click', d.onPress, true);
    delete w.__grntedDraws;
    return true;
  }
  if (w.__grntedDraws) return true;
  const last = new WeakMap<object, number>();
  const kept: Kept = [];
  // When the last click reached the page (the press a stop is weighed against: the test's own clock reading comes
  // before it scrolls and aims at the control).
  const d: Draws = { last, kept, pressAt: -Infinity, onPress: () => { d.pressAt = performance.now(); } };
  window.addEventListener('click', d.onPress, true);
  w.__grntedDraws = d;
  if (!arg.draws) return true;
  const wrap = (ctor: unknown, names: string[]) => {
    const proto = (ctor as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    if (!proto) return;
    for (const name of names) {
      const f = proto[name];
      if (typeof f !== 'function') continue;
      const orig = f as (...a: unknown[]) => unknown;
      try {
        proto[name] = function (this: { canvas?: object }, ...a: unknown[]) {
          try { if (this && this.canvas) last.set(this.canvas, performance.now()); } catch { /* no canvas */ }
          return orig.apply(this, a);
        };
        kept.push({ proto, name, f });
      } catch { /* sealed */ }
    }
  };
  const g = window as unknown as Record<string, unknown>;
  wrap(g.CanvasRenderingContext2D, ['fillRect', 'clearRect', 'strokeRect', 'fill', 'stroke', 'drawImage', 'putImageData', 'fillText', 'strokeText']);
  wrap(g.WebGLRenderingContext, ['drawArrays', 'drawElements', 'clear']);
  wrap(g.WebGL2RenderingContext, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'clear']);
  return true;
}

/**
 * Runs in the page (batch 17, item 1): whether a moving item that went still after a control was pressed at `at`
 * (the page's clock) came to its own end instead, so the stop proves nothing about the control: a video that played
 * to its end; a timer that ran again after the press and is no longer set (it cleared itself); a canvas that was
 * drawn on after the press (the press did not stop the drawing) or not since well before it. Unknown is false.
 */
function endedOnItsOwn(arg: { id: number; kind: Kind; timers: number[]; at: number; live?: boolean }): boolean {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const el = kit.get(arg.id);
  // Hidden or removed: a Hide or Close control's doing (what goes on drawing out of sight is out of sight).
  if (!el || !el.isConnected || !kit.visible(el)) return false;
  const d = (window as unknown as { __grntedDraws?: { last: WeakMap<object, number>; pressAt: number } }).__grntedDraws;
  // The press: the click that reached the page after the test's clock reading, else that reading.
  const at = d && d.pressAt >= arg.at ? d.pressAt : arg.at;
  if (arg.kind === 'video') { const v = el as HTMLVideoElement; return v.ended && !v.loop; }
  if (arg.kind === 'timer') {
    if (!arg.timers.length || kit.pending().some((p) => arg.timers.includes(p.timer) && !p.string)) return false;
    // None of its timers was set any more right before the press: it had stopped by itself.
    if (arg.live === false) return true;
    const hooks = (window as unknown as { __grntedHooks?: () => { timers: { lastFiredAt?: number }[] } }).__grntedHooks?.();
    return arg.timers.some((t) => (hooks?.timers[t]?.lastFiredAt ?? -Infinity) > at + 30);
  }
  if (arg.kind === 'visual') {
    if (!d) return false;
    const canvases = el.localName === 'canvas' ? [el] : [...el.querySelectorAll('canvas')].slice(0, 20);
    const times = canvases.map((c) => d.last.get(c)).filter((x): x is number => typeof x === 'number');
    if (!times.length) return false;
    // Drawn on after the press (the next frame or two aside), or not in the frames right before it (it had stopped:
    // a canvas that moves is drawn on at least about 20 times a second).
    const drawn = Math.max(...times);
    return drawn > at + 50 || drawn < at - 60;
  }
  return false;
}

async function judgeItem(ctx: ProbeContext, item: MovingItem, desc: string, findings: ProbeFinding[], acted: { any: boolean } = { any: false }): Promise<void> {
  try {
    await judgeOne(ctx, item, desc, findings, acted);
  } finally {
    await ctx.page.evaluate(replayEnded, { id: item.el.id, op: 'restore' }).catch(() => null);
    await ctx.page.evaluate(trackDraws, { op: 'restore' }).catch(() => false);
  }
}

async function judgeOne(ctx: ProbeContext, item: MovingItem, desc: string, findings: ProbeFinding[], acted: { any: boolean }): Promise<void> {
  const { page } = ctx;
  if (item.nativeControls) {
    findings.push({ criterion: '2.2.2', status: 'no_failures_found', target: item.el.path, detail: `${desc}: its own video controls can pause it` });
    return;
  }
  if (!hasTime(ctx, 4000)) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: the time for this test ran out before a pause, stop or hide control could be tried` });
    return;
  }
  // A canvas's drawing is watched from now on, so that a stop after a press can be told from its own end (item 1).
  await page.evaluate(trackDraws, { op: 'start', draws: item.kind === 'visual' }).catch(() => false);
  // A repeating timer or an endless animation has no end of its own, but the page may stop it: before it is
  // judged it must have run more than 5 s (a carousel that stops after 3 or 4.5 s is not failed for being caught early).
  const wait = Math.max(await timerWait(page, item), await animationWait(page, item));
  if (wait > 0) {
    if (!hasTime(ctx, wait + 4000)) {
      findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: the time for this test ran out before it could be checked again more than 5 s after it started` });
      return;
    }
    await page.waitForTimeout(wait);
  }
  let [moves] = await stillMovingAll(page, [item], !acted.any);
  /** The controls are tried on a copy of the animation, which page styles do not reach. */
  let onCopy = false;
  if (moves === 'ended') {
    const cands = await page.evaluate(controlsFor, { id: item.el.id, words: PAUSE_VOCAB, max: CANDIDATES, closers: true, unknown: true });
    // An animation that ran its course, with controls on the page: it is run again from its start so
    // they can be checked on it (a working Pause or Hide is then shown to work). With no control on the
    // page it failed; with controls the test cannot operate on it (it cannot be run again) there is no
    // verdict, never a failure blamed on a control that could not be tried.
    let replay: { replayed: number; copy: boolean } | null = null;
    if (item.kind === 'animation' && cands.controls.length) replay = await page.evaluate(replayEnded, { id: item.el.id, op: 'replay' }).catch(() => null);
    if (replay?.replayed) {
      [moves] = await stillMovingAll(page, [item]);
      onCopy = replay.copy;
      desc = `${desc} (it had ended by itself; its controls were checked on it run again from its start)`;
    }
    if (moves === 'ended' || !moves) {
      endedItem(findings, item, desc, cands, [], !!cands.controls.length);
      return;
    }
  }
  if (!moves) {
    findings.push({ criterion: '2.2.2', status: 'no_failures_found', target: item.el.path, detail: `${desc}: ${acted.any ? STILL_BY_CONTROL : STILL_BY_ITSELF}` });
    return;
  }
  const tried: string[] = [];
  /** Controls that stopped it but did not hold (`holdCheck`), with what undid them. */
  const notHeld: string[] = [];
  /** Controls that stopped it when the time ran out before it could be checked that it stays stopped: not credited. */
  const unverified: string[] = [];
  /** A control that stopped it is credited only once it is verified to keep it stopped (review r1, finding 14). */
  const holds = async (name: string, before: number[]): Promise<boolean> => {
    const hold = await holdCheck(ctx, item, before);
    if (hold.kind === 'held') return true;
    if (hold.kind === 'undone') notHeld.push(`"${name.slice(0, 40)}": ${hold.how}`);
    else unverified.push(name);
    return false;
  };
  /**
   * Every press (a control, its replay, focus moved inside, a revealed control, a setting) runs under the strict guard
   * (Sol r1 S9): from the first press on, nothing it or its later work asks for leaves the page, until the page is
   * loaded again. Not before: watching the page play needs its media and data.
   */
  const strict = () => ctx.guard.latchStrict?.();
  let worked: string | null = null;
  /**
   * Controls during whose check the motion came to its own end (batch 17, item 1): a stop its own end explains is
   * no control's. A CSS animation is run again from its start and the control tried once more on it; other motion
   * cannot be run again, and the control is left undecided.
   */
  const endedUnsure: string[] = [];
  /** The motion was run again from its start for a control (a CSS animation whose end came during a check). */
  let replayedAgain = false;
  /** The page's clock right before a press. */
  const clock = () => page.evaluate(() => performance.now(), undefined).catch(() => Number.NaN);
  /** The state after a press at `at`, with a stop that the motion's own end explains read as 'ended'. */
  /** The moving item is in the page and shown (its own fading aside). */
  const shownNow = (): Promise<boolean> => page.evaluate(itemShown, item.el.id).catch(() => true);
  const afterPress = async (at: number, live?: boolean, shownBefore?: boolean): Promise<ItemState> => {
    const [st = false] = await stillMovingAll(page, [item]);
    // Shown right before the press and hidden or removed right after it: a Hide or Close control did that, whether or
    // not the motion's own end came in the same moment (hiding it is what 2.2.2 asks of such a control).
    if (st === 'ended' && shownBefore && !(await shownNow())) return false;
    if (st !== false || !Number.isFinite(at)) return st;
    const own = await page.evaluate(endedOnItsOwn, { id: item.el.id, kind: item.kind, timers: item.timers ?? [], at, ...(live === undefined ? {} : { live }) }).catch(() => false);
    return own ? 'ended' : st;
  };
  /** For a timer's motion: one of its timers is set right before a press (it was still running). */
  const timerLive = (): Promise<boolean | undefined> => (item.kind !== 'timer' ? Promise.resolve(undefined)
    : page.evaluate((t: number[]) => (window as unknown as { __grntedKit: Kit }).__grntedKit.pending().some((p) => t.includes(p.timer) && !p.string), item.timers ?? []).catch(() => undefined));
  let outOfTime = false;
  let frameEntered = true;
  const mark = ctx.guard.mark();
  const found = await page.evaluate(controlsFor, { id: item.el.id, words: PAUSE_VOCAB, max: CANDIDATES, closers: true, unknown: true });
  const refused = [...found.refused];
  for (const c of found.controls) {
    if (!hasTime(ctx, 3000)) { outOfTime = true; break; }
    tried.push(c.name ?? c.path);
    const pendingBefore = await page.evaluate(pendingHandles, undefined).catch(() => [] as number[]);
    let live = await timerLive();
    let shown = await shownNow();
    let at = await clock();
    strict();
    if (!(await clickControl(page, c, item.el.id))) continue;
    acted.any = true;
    await page.waitForTimeout(300);
    // Stop at the first request, navigation or popup the guard had to stop.
    if (await settledStop(ctx, mark)) break;
    let still = await afterPress(at, live, shown);
    // Focus leaves the control before anything is credited (ACT): a stop that lasts only while the control has focus is
    // no pause. A blur that fails ends the test. `holdCheck` then watches it with focus gone, so a stop that undoes
    // itself is named as one (review r1, finding 14) rather than as a control without effect.
    await page.evaluate(blurActive, undefined);
    // The motion's own end came during the check (batch 17, item 1: it was credited to the control before): the stop
    // proves nothing. A CSS animation is run again from its start and the control pressed once more while it runs.
    if (still === 'ended' && item.kind === 'animation' && !replayedAgain && hasTime(ctx, 3500)) {
      replayedAgain = true;
      await page.evaluate(replayEnded, { id: item.el.id, op: 'restore' }).catch(() => null);
      const replay = await page.evaluate(replayEnded, { id: item.el.id, op: 'replay' }).catch(() => null);
      const [running] = replay?.replayed ? await stillMovingAll(page, [item]) : [false as ItemState];
      if (running === true) {
        onCopy ||= !!replay?.copy;
        live = await timerLive();
        shown = await shownNow();
        at = await clock();
        if (await clickControl(page, c, item.el.id)) {
          await page.waitForTimeout(300);
          if (await settledStop(ctx, mark)) break;
          still = await afterPress(at, live, shown);
          await page.evaluate(blurActive, undefined);
        }
      }
    }
    // Once the motion has come to its own end, no later control can be judged on it.
    if (still === 'ended') { endedUnsure.push(c.name ?? c.path); break; }
    if (!still) {
      // A pause holds until the user asks for more: one that undoes itself, or that could not be checked, is not credited.
      if (!(await holds(c.name ?? c.path, pendingBefore))) continue;
      worked = c.name ?? c.path;
      break;
    }
  }
  if (!worked && !outOfTime && !endedUnsure.length && item.el.tag === 'iframe' && !(await settledStop(ctx, mark))) {
    const before = await page.evaluate(pendingHandles, undefined).catch(() => [] as number[]);
    strict();
    const r = await frameControl(ctx, item, tried, refused, acted);
    // A control inside a frame: what stopped the frame's motion cannot be told from the motion's own end there (Sol r1
    // S11), so only the frame's own video controls are credited; any other control is left undecided.
    if (r.worked && !r.worked.startsWith('the video controls')) endedUnsure.push(r.worked);
    else worked = r.worked && (await holds(r.worked, before)) ? r.worked : null;
    frameEntered = r.entered;
  }
  // A focus-triggered pause counts only when it persists after focus leaves.
  let onFocus = false;
  /** It stopped while focus was inside it and moved again once focus left: that is not a pause (review r2, finding 10). */
  let focusOnly: string | null = null;
  if (!worked && !outOfTime && !endedUnsure.length && hasTime(ctx, 2500) && !(await settledStop(ctx, mark))) {
    const before = await page.evaluate(pendingHandles, undefined).catch(() => [] as number[]);
    const at0 = await clock();
    strict();
    if (await page.evaluate(focusInside, item.el.id).catch(() => false)) {
      acted.any = true;
      await page.waitForTimeout(300);
      const still = await afterPress(at0);
      // An end during the focus check proves nothing either way (batch 17, item 1: it was credited before).
      if (still === 'ended') endedUnsure.push('keyboard focus inside it');
      onFocus = still === false;
      // Otherwise the pause must persist after focus leaves (ACT): like any other control, it counts only when the
      // content stays stopped once focus has left (`holdCheck` moves focus away and watches); a pause that ends
      // with the focus is not credited (review r2, finding 10). Focus must leave: a blur that fails ends the test.
      if (still === false) {
        await page.evaluate(blurActive, undefined);
        const hold = await holdCheck(ctx, item, before);
        if (hold.kind !== 'held') {
          onFocus = false;
          if (hold.kind === 'undone') focusOnly = hold.how.replace('left the control', 'left it');
          else unverified.push('keyboard focus inside it');
        }
      }
      await page.evaluate(blurActive, undefined);
    }
  }
  // A pause control kept in a panel or dialog that a visible button opens ("Settings", "Animation controls"):
  // the button is clicked and the control it shows is tried. One that stays hidden leaves no verdict.
  let hiddenLeft: string[] = [];
  if (!worked && !onFocus && !outOfTime && !endedUnsure.length && frameEntered && !onCopy && !refused.length && !(await settledStop(ctx, mark))) {
    const before = await page.evaluate(pendingHandles, undefined).catch(() => [] as number[]);
    strict();
    const r = await revealPause(ctx, item, tried, acted, mark, afterPress);
    if (r.worked && r.ended) endedUnsure.push(r.worked);
    worked = r.worked && !r.ended && (await holds(r.worked, before)) ? r.worked : null;
    hiddenLeft = r.hidden;
  }
  // Content that updates by itself may instead let the user set how often it updates (WCAG 2.2.2).
  const frequency = !worked && !onFocus && (item.kind === 'timer' || item.kind === 'dom')
    ? await page.evaluate(frequencyControl, undefined).catch(() => null) : null;
  // Its setting that stops the updates ("Manual only", "Off") is tried, and counts once the updates stopped.
  let frequencyStops: string | null = null;
  if (frequency?.stop && !outOfTime && !endedUnsure.length && hasTime(ctx, 3000) && !(await settledStop(ctx, mark))) {
    const before = await page.evaluate(pendingHandles, undefined).catch(() => [] as number[]);
    strict();
    const live1 = await timerLive();
    const at1 = await clock();
    if (await page.evaluate(setFrequencyStop, { id: frequency.id, kind: frequency.stop.kind, value: frequency.stop.value }).catch(() => false)) {
      acted.any = true;
      await page.waitForTimeout(300);
      // The same attribution as a control's (Sol r1 S11): an end of its own is no setting's.
      const still = await afterPress(at1, live1);
      // The setting counts only when the updates stay stopped: a "manual" setting the page undoes is no control.
      const setting = `"${frequency.name.slice(0, 60)}" set to "${frequency.stop.label}"`;
      if (still === false && (await holds(`${frequency.name.slice(0, 24)}: ${frequency.stop.label}`, before))) frequencyStops = setting;
    }
  }
  const stopped = await settledStop(ctx, mark);
  const held = tried.filter((t) => !notHeld.some((n) => n.startsWith(`"${t.slice(0, 40)}":`)) && !unverified.includes(t) && !endedUnsure.includes(t));
  const triedText = [
    ...(held.length ? [`controls tried, without effect: ${held.map((t) => `"${t.slice(0, 40)}"`).join(', ')}`] : []),
    ...(notHeld.length ? [`controls that did not keep it stopped: ${notHeld.join('; ')}`] : []),
  ].join('; ') || 'no pause, stop or hide control was found';
  const notTried = refusedText(refused);
  if (stopped) {
    // A control that needs the server, another page or a popup could not be tried: no verdict,
    // even when the content stopped (what the page meant to do next could not happen).
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: ${stopped} (${triedText})` });
  } else if (worked) {
    const how = worked.startsWith('the video controls') ? `${worked} can pause it` : worked.startsWith('"') ? `the control ${worked} stops it` : `the control "${worked}" stops it`;
    findings.push({ criterion: '2.2.2', status: 'no_failures_found', target: item.el.path, detail: `${desc}: ${how}` });
  } else if (onFocus) {
    findings.push({ criterion: '2.2.2', status: 'no_failures_found', target: item.el.path, detail: `${desc}: it stops while keyboard focus is inside it, and stays stopped when focus moves on` });
  } else if (frequencyStops) {
    findings.push({ criterion: '2.2.2', status: 'no_failures_found', target: item.el.path, detail: `${desc}: the control ${frequencyStops} stops it` });
  } else if (focusOnly) {
    // Not a pause, and not failed on this alone: whether keeping focus there serves as a way to stop it is left undecided.
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: it stops only while keyboard focus is inside it (${focusOnly}), which is not a pause that holds; no control that keeps it stopped was found (${triedText})` });
  } else if (unverified.length) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: ${unverified[0] === 'keyboard focus inside it' ? 'keyboard focus inside it' : `the control "${unverified[0]!.slice(0, 60)}"`} stopped it, but the time for this test ran out before it could be checked that it stays stopped (${triedText})` });
  } else if (outOfTime) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: the time for this test ran out before every control could be tried (${triedText})` });
  } else if (notTried) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: ${notTried} (${triedText})` });
  } else if (!frameEntered) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: the embedded frame could not run the test's code, so controls inside it were not tried (${triedText})` });
  } else if (onCopy) {
    // Tried on a copy of the animation the page had removed: page styles do not reach a copy, so a
    // control that did not stop it proves nothing.
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: the page removed its animation when it ended, and its controls could only be tried on a copy, which page styles do not reach (${triedText})` });
  } else if (hiddenLeft.length) {
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: the page has a pause, stop or hide control that is hidden (${hiddenLeft.slice(0, 3).map((t) => `"${t.slice(0, 40)}"`).join(', ')}), and no control found shows it, so it could not be tried (${triedText})` });
  } else if (frequency) {
    const control = frequency.name.startsWith(UNREAD_LABEL) ? `a control whose label could not be read (${frequency.name.slice(UNREAD_LABEL.length, UNREAD_LABEL.length + 60)})` : `"${frequency.name.slice(0, 60)}"`;
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: `${desc}: ${control} may set how often it updates, which WCAG 2.2.2 allows for content that updates by itself; whether its slowest setting is enough was not checked (${triedText})` });
  } else if (endedUnsure.length) {
    // Batch 17, item 1: the motion came to its own end while a control was checked (and could not be run again):
    // whether that control stops it could not be seen. Never credited, never failed.
    const first = endedUnsure[0]!;
    const named = first.startsWith('"') ? first.slice(0, 80) : `"${first.slice(0, 60)}"`;
    const which = first === 'keyboard focus inside it' ? 'keyboard focus was moved inside it' : `the control ${named} was checked`;
    findings.push({ criterion: '2.2.2', status: 'not_testable', target: item.el.path, detail: first.endsWith('(inside the frame)')
      ? `${desc}: it stopped when the control ${named} was pressed, but inside an embedded frame a control's stop cannot be told from the motion's own end (${triedText})`
      : `${desc}: it came to its own end while ${which}, so whether that stops it could not be told (${triedText})` });
  } else {
    findings.push({ criterion: '2.2.2', status: 'failed', target: item.el.path, detail: `${item.what} starts by itself and runs ${lasting(item.lastsMs)}; nothing on the page pauses, stops or hides it (${triedText})` });
  }
}
