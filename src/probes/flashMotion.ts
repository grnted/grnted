// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.3.1 without frames of the screen (Plan 4, item A4): the animation and media check. The flash
// test (`flash.ts`) needs more than `FLASH.minFps` frames a second; when the browser cannot send that
// many, this check judges the page from what makes a screen flash:
// - CSS animations, transitions and script animations (`document.getAnimations()`): each one's states
//   from its keyframes, played over time from its duration, direction and iterations;
// - elements a script keeps restyling (a timer swapping colours), recorded for `OBSERVE_MS`;
// - animated GIFs, decoded frame by frame (`gif.ts`, bounded);
// then the same thresholds as the frames (`flashMath.ts`: luminance pairs, saturated red, the 25% of a
// 10° field scaled to the viewport). It reports a failure only on clear evidence (opaque colours it can
// read, a single area larger than the threshold); a large source it cannot read (a playing video, an
// animated PNG or WebP, a canvas, a frame, a SMIL animation, a fast animation of something it cannot
// colour) makes the page not testable. Not scored (`scored: false`) until the gold standard verifies
// it; the report keeps its result only on pages the frames could not decide (`flashPrecedence`).
// Read-only: it changes nothing on the page. Engine core: no Node-only imports.
import type { CDPSessionLike, ProbeRun } from '../types.js';
import { analyseFlashes, fieldShare, FLASH, isSaturatedRed, luminanceTransitions, mostInWindow, padToField, redTransitions, type FlashFrame } from './flashMath.js';
import { FLASH_CELL } from './flash.js';
import { decodeGif, GIF_LIMITS, isGif } from './gif.js';
import type { Kit } from './kit.js';
import { cellGrid } from './motionPixels.js';
import { MOTION_CONTEXT, kitReady, within } from './motionShared.js';
import { LINEAR } from './pixels.js';
import type { PageProbe, ProbeContext, ProbeFinding } from './types.js';

/** How long script restyles are recorded. */
export const OBSERVE_MS = 1200;
/** Played time of an animation that repeats for ever. */
const PLAY_MS = 2000;
/** Step of the played timeline. */
const STEP_MS = 5;
/** Most animations, restyled elements and images examined. */
const MAX_ITEMS = 60;
/** Time for each CDP call and for reading one image. */
const CALL_MS = 4000;
/** Most large images read and decoded per page (each within `GIF_LIMITS`); the rest count as unread. */
export const MAX_DECODED = 6;

type Rgb = [number, number, number];

export interface AnimState {
  offset: number;
  /** The colour the element shows in this state (sRGB 0–255), or null when it cannot be read. */
  rgb: Rgb | null;
  /** Paint-relevant values (for counting changes when the colour cannot be read). */
  key: string;
  /** Easing from this state to the next (CSS: 'linear', 'ease', 'steps(1)', ...). */
  easing?: string;
}

export interface MotionAnimation {
  path: string;
  w: number;
  h: number;
  pseudo: boolean;
  durationMs: number;
  /** -1: for ever. */
  iterations: number;
  direction: string;
  rate: number;
  states: AnimState[];
  /** Only position, size or transform change (things that move, not flash). */
  moveOnly: boolean;
}

export interface MotionRestyled {
  path: string;
  w: number;
  h: number;
  /** Each recorded change: time (ms) and the colour shown after it (null when unreadable). */
  samples: { t: number; rgb: Rgb | null; key: string }[];
}

export interface MotionImage { path: string; src: string; w: number; h: number; backdrop: Rgb }
export interface MotionOther { path: string; w: number; h: number; kind: 'video' | 'canvas' | 'frame' | 'smil' }

export interface MotionScan {
  animations: MotionAnimation[];
  restyled: MotionRestyled[];
  images: MotionImage[];
  others: MotionOther[];
}

/**
 * Runs in the page: the animations, the elements restyled during `observeMs`, the images and the other
 * sources that could flash. Self-contained (serialized into the page). Never changes the page.
 */
export async function flashMotionScan(arg: { observeMs: number; max: number; minArea: number }): Promise<MotionScan> {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const parse = (c: string | null | undefined): [number, number, number, number] | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec((c ?? '').trim());
    if (!m) return null;
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!Number.isFinite(a)) a = 1;
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  };
  const mix = (a: number[], b: number[], t: number): [number, number, number] => [a[0]! * t + b[0]! * (1 - t), a[1]! * t + b[1]! * (1 - t), a[2]! * t + b[2]! * (1 - t)];
  /** The opaque colour behind an element: its nearest ancestor with an opaque background, else white. */
  const backdropOf = (el: Element): [number, number, number] => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const c = parse(getComputedStyle(p).backgroundColor);
      if (c && c[3] >= 0.999) return [c[0], c[1], c[2]];
    }
    return [255, 255, 255];
  };
  /** Ancestors at full opacity, no blending or filter (else the shown colour is not the element's own). */
  const plain = (el: Element): boolean => {
    for (let p: Element | null = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (p !== el && parseFloat(s.opacity) < 0.999) return false;
      if (s.mixBlendMode !== 'normal' || (s.filter && s.filter !== 'none')) return false;
    }
    return true;
  };
  /** The colour an element shows with this background and opacity, over its backdrop; null when its background is not solid. */
  const shown = (bg: string | null | undefined, opacity: number, backdrop: [number, number, number]): [number, number, number] | null => {
    const c = parse(bg);
    if (!c || c[3] < 0.5) return null;
    const solid = mix(c, backdrop, c[3]);
    return mix(solid, backdrop, Math.max(0, Math.min(1, opacity)));
  };
  const PAINT = ['backgroundColor', 'opacity', 'visibility', 'display', 'filter', 'backgroundImage', 'color', 'borderColor', 'boxShadow', 'outlineColor', 'fill', 'stroke', 'mixBlendMode', 'clipPath', 'content', 'background'];
  const big = (el: Element) => kit.visible(el) && kit.area(el) >= arg.minArea;
  const rect = (el: Element) => { const b = kit.box(el); return { w: Math.round(b.w), h: Math.round(b.h) }; };

  // Script restyles: each style or class change of an element, with the colour it shows afterwards.
  const restyled = new Map<Element, MotionRestyled>();
  let records = 0;
  const sample = (el: Element) => {
    if (!(el instanceof HTMLElement) || !big(el)) return;
    let r = restyled.get(el);
    if (!r) {
      if (restyled.size >= arg.max) return;
      r = { path: kit.describe(el).path, ...rect(el), samples: [] };
      restyled.set(el, r);
    }
    if (r.samples.length >= 400) return;
    const s = getComputedStyle(el);
    const key = PAINT.map((k) => (s as unknown as Record<string, string>)[k] ?? '').join('|');
    const rgb = plain(el) ? shown(s.backgroundColor, parseFloat(s.opacity), backdropOf(el)) : null;
    r.samples.push({ t: performance.now(), rgb, key });
  };
  const observer = new MutationObserver((list) => {
    const seen = new Set<Element>();
    for (const m of list) {
      if (records++ > 5000) break;
      if (m.type === 'attributes' && m.target instanceof Element && !seen.has(m.target)) { seen.add(m.target); sample(m.target); }
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'hidden'], subtree: true });
  await new Promise((r) => setTimeout(r, arg.observeMs));
  observer.takeRecords();
  observer.disconnect();

  // Animations (CSS animations and transitions, script animations), read from their keyframes.
  const animations: MotionAnimation[] = [];
  for (const a of document.getAnimations()) {
    if (animations.length >= arg.max) break;
    if (a.playState !== 'running') continue;
    const effect = a.effect as KeyframeEffect | null;
    const el = effect?.target;
    if (!effect || !el || !big(el)) continue;
    const timing = effect.getComputedTiming();
    const duration = typeof timing.duration === 'number' ? timing.duration : 0;
    const frames = effect.getKeyframes() as (Record<string, unknown> & { computedOffset?: number; offset?: number | null })[];
    const s = getComputedStyle(el);
    const backdrop = backdropOf(el);
    const ok = plain(el);
    // The properties whose value changes between keyframes (a shorthand brings constant longhands too).
    const props = new Set<string>();
    const all = new Set<string>();
    for (const f of frames) for (const k of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(k)) all.add(k);
    for (const k of all) if (new Set(frames.map((f) => String(f[k] ?? ''))).size > 1) props.add(k);
    const moveOnly = [...props].every((k) => /^(transform|translate|rotate|scale|left|right|top|bottom|inset.*|margin.*|width|height|offset.*|backgroundPosition.*)$/.test(k));
    const states: AnimState[] = frames.map((f) => {
      const bg = typeof f.backgroundColor === 'string' ? f.backgroundColor : s.backgroundColor;
      const op = typeof f.opacity === 'string' || typeof f.opacity === 'number' ? Number(f.opacity) : parseFloat(s.opacity);
      const reads = ok && [...props].every((k) => k === 'backgroundColor' || k === 'opacity' || /^(transform|translate|rotate|scale|backgroundPosition.*)$/.test(k));
      const key = [...props].sort().map((k) => String(f[k] ?? '')).join('|');
      return { offset: typeof f.computedOffset === 'number' ? f.computedOffset : Number(f.offset ?? 0), rgb: reads ? shown(bg, op, backdrop) : null, key, easing: String(f.easing ?? 'linear') };
    });
    animations.push({
      path: kit.describe(el).path, ...rect(el), pseudo: !!effect.pseudoElement, durationMs: duration,
      iterations: timing.iterations === Infinity || timing.iterations === null ? -1 : Number(timing.iterations ?? 1),
      direction: String(timing.direction ?? 'normal'), rate: a.playbackRate || 1, states, moveOnly,
    });
  }

  // Images that may be animated (any format: the bytes decide), and the other sources.
  const images: MotionImage[] = [];
  const others: MotionOther[] = [];
  for (const img of document.images) {
    if (images.length >= arg.max) break;
    if (!big(img) || !(img.currentSrc || img.src) || img.currentSrc.startsWith('data:image/jpeg')) continue;
    images.push({ path: kit.describe(img).path, src: img.currentSrc || img.src, ...rect(img), backdrop: backdropOf(img) });
  }
  const add = (el: Element, kind: MotionOther['kind']) => { if (others.length < arg.max && big(el)) others.push({ path: kit.describe(el).path, ...rect(el), kind }); };
  for (const v of document.querySelectorAll('video')) if (!v.paused || v.autoplay) add(v, 'video');
  document.querySelectorAll('canvas').forEach((c) => add(c, 'canvas'));
  document.querySelectorAll('iframe, embed, object').forEach((f) => add(f, 'frame'));
  for (const svg of document.querySelectorAll('svg')) if (svg.querySelector('animate, animateTransform, animateMotion, animateColor, set')) add(svg, 'smil');
  return { animations, restyled: [...restyled.values()].filter((r) => r.samples.length > 1), images, others };
}

// ---------------------------------------------------------------------------------------------------
// Judging (pure).

const lin = (rgb: Rgb): Rgb => [LINEAR[Math.round(Math.max(0, Math.min(255, rgb[0])))]!, LINEAR[Math.round(Math.max(0, Math.min(255, rgb[1])))]!, LINEAR[Math.round(Math.max(0, Math.min(255, rgb[2])))]!];
const lumOf = (l: Rgb) => 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];

export type Verdict =
  | { kind: 'fails'; red: boolean; transitions: number }
  | { kind: 'clear' }
  | { kind: 'unclear'; why: string };

/** The played timeline of an animation: sample times (ms) and the state segment at each. */
function play(a: MotionAnimation): { t: number; p: number }[] {
  const dur = a.durationMs / Math.max(0.01, Math.abs(a.rate));
  if (!(dur > 0)) return [];
  const total = a.iterations < 0 ? PLAY_MS : Math.min(PLAY_MS, dur * Math.max(0, a.iterations));
  const out: { t: number; p: number }[] = [];
  for (let t = 0; t <= total; t += STEP_MS) {
    const it = Math.floor(t / dur);
    let p = (t - it * dur) / dur;
    if (a.iterations >= 0 && t >= total) p = 1;
    const reverse = a.direction === 'reverse' || (a.direction === 'alternate' && it % 2 === 1) || (a.direction === 'alternate-reverse' && it % 2 === 0);
    if (reverse) p = 1 - p;
    if (a.rate < 0) p = 1 - p;
    out.push({ t, p });
  }
  return out;
}

/**
 * A step easing applied to the weight w (0–1) between two states; any other easing is taken as linear
 * (it changes when a state is reached, not which states are shown, except that steps hold a state).
 */
export function eased(easing: string | undefined, w: number): number {
  const e = (easing ?? '').replace(/\s+/g, '');
  if (e === 'step-start') return w > 0 ? 1 : 0;
  if (e === 'step-end') return w >= 1 ? 1 : 0;
  const m = /^steps\((\d+)(?:,(jump-start|start|jump-end|end|jump-none|jump-both))?\)$/.exec(e);
  if (!m) return w;
  const n = Math.max(1, Number(m[1]));
  const pos = m[2] ?? 'end';
  if (w >= 1) return 1;
  if (pos === 'start' || pos === 'jump-start') return Math.min(1, Math.floor(w * n + 1) / n);
  if (pos === 'jump-none') return n > 1 ? Math.min(1, Math.floor(w * n) / (n - 1)) : (w >= 1 ? 1 : 0);
  if (pos === 'jump-both') return Math.min(1, Math.floor(w * n + 1) / (n + 1));
  return Math.floor(w * n) / n;
}

/** The state segment for progress p: [index before, weight of the next (eased)]. */
function segment(states: readonly AnimState[], p: number): [number, number] {
  for (let i = 0; i + 1 < states.length; i++) {
    const a = states[i]!.offset;
    const b = states[i + 1]!.offset;
    if (p < b || i + 2 === states.length) return [i, eased(states[i]!.easing, b > a ? Math.max(0, Math.min(1, (p - a) / (b - a))) : 1)];
  }
  return [0, 0];
}

/** Whether an animation can flash, judged from its keyframes. */
export function judgeAnimation(a: MotionAnimation, viewport: { width: number; height: number }): Verdict {
  if (a.states.length < 2) return { kind: 'clear' };
  const timeline = play(a);
  // Upper bound first: a change of state counts once at most, whatever the colours.
  const changes: number[] = [];
  let lastKey: string | null = null;
  for (const { t, p } of timeline) {
    const [i, w] = segment(a.states, p);
    const key = w < 0.5 ? a.states[i]!.key : a.states[i + 1]!.key;
    if (lastKey !== null && key !== lastKey) changes.push(t);
    lastKey = key;
  }
  if (mostInWindow(changes) <= FLASH.maxTransitions || a.moveOnly) return { kind: 'clear' };
  if (fieldShare(a.w, a.h, viewport) <= FLASH.areaShare) return { kind: 'clear' };
  if (a.pseudo || a.states.some((s) => !s.rgb)) return { kind: 'unclear', why: 'a fast animation whose colors could not be read' };
  const times: number[] = [];
  const lums: number[] = [];
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const { t, p } of timeline) {
    const [i, w] = segment(a.states, p);
    const x = a.states[i]!.rgb!;
    const y = a.states[i + 1]!.rgb!;
    const l = lin([x[0] + (y[0] - x[0]) * w, x[1] + (y[1] - x[1]) * w, x[2] + (y[2] - x[2]) * w]);
    times.push(t); lums.push(lumOf(l)); rs.push(l[0]); gs.push(l[1]); bs.push(l[2]);
  }
  return series(times, lums, rs, gs, bs);
}

function series(times: number[], lums: number[], rs: number[], gs: number[], bs: number[]): Verdict {
  const general = mostInWindow(luminanceTransitions(lums, times));
  const red = mostInWindow(redTransitions(rs, gs, bs, times));
  if (general > FLASH.maxTransitions) return { kind: 'fails', red: false, transitions: general };
  if (red > FLASH.maxTransitions) return { kind: 'fails', red: true, transitions: red };
  return { kind: 'clear' };
}

/** Whether an element a script restyled flashed while it was recorded. */
export function judgeRestyled(r: MotionRestyled, viewport: { width: number; height: number }): Verdict {
  const changes: number[] = [];
  for (let i = 1; i < r.samples.length; i++) if (r.samples[i]!.key !== r.samples[i - 1]!.key) changes.push(r.samples[i]!.t);
  if (mostInWindow(changes) <= FLASH.maxTransitions) return { kind: 'clear' };
  if (fieldShare(r.w, r.h, viewport) <= FLASH.areaShare) return { kind: 'clear' };
  if (r.samples.some((s) => !s.rgb)) return { kind: 'unclear', why: 'an element a script keeps restyling, whose colors could not be read' };
  const times = r.samples.map((s) => s.t);
  const l = r.samples.map((s) => lin(s.rgb!));
  return series(times, l.map(lumOf), l.map((x) => x[0]), l.map((x) => x[1]), l.map((x) => x[2]));
}

/** Kinds of animated image bytes: a GIF (decoded), an animated PNG or WebP (not decoded), or still. */
export function imageKind(bytes: Uint8Array): 'gif' | 'animated' | 'still' {
  if (isGif(bytes)) return 'gif';
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  const text = String.fromCharCode(...head.subarray(0, Math.min(head.length, 4096)));
  // PNG: an acTL chunk before the image data makes it an animated PNG.
  if (bytes[0] === 0x89 && text.startsWith('\x89PNG')) {
    const idat = text.indexOf('IDAT');
    const actl = text.indexOf('acTL');
    return actl >= 0 && (idat < 0 || actl < idat) ? 'animated' : 'still';
  }
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return text.includes('ANIM') ? 'animated' : 'still';
  // SVG with its own animation.
  if (/<svg[\s>]/i.test(text) || /^\s*<\?xml/.test(text)) {
    const all = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 200_000)));
    return /<(animate|animateTransform|animateColor|set)\b|@keyframes|animation\s*:/i.test(all) ? 'animated' : 'still';
  }
  return 'still';
}

/**
 * An animated GIF's frames played over 2 s (looping as the file says), analysed like frames of the
 * screen at its size on the page. Throws on a GIF it cannot read or that hits a limit.
 */
export function judgeGif(bytes: Uint8Array, img: Pick<MotionImage, 'w' | 'h' | 'backdrop'>, viewport: { width: number; height: number }): Verdict {
  const frames: FlashFrame[] = [];
  const dw = Math.min(img.w, viewport.width);
  const dh = Math.min(img.h, viewport.height);
  let t = 0;
  let cell = 1;
  let cssCell = FLASH_CELL;
  let scratch: Uint8Array | null = null;
  const bd = img.backdrop;
  const result = decodeGif(bytes, (f) => {
    if (!scratch) {
      // Cells of about FLASH_CELL CSS px at the image's size on the page.
      const scale = Math.sqrt((dw / f.width) * (dh / f.height)) || 1;
      cell = Math.max(1, Math.round(FLASH_CELL / scale));
      cssCell = cell * scale;
      scratch = new Uint8Array(f.rgba.length);
    }
    // Transparent pixels show the backdrop.
    const out = scratch;
    const src = f.rgba;
    for (let p = 0; p < src.length; p += 4) {
      if (src[p + 3]) { out[p] = src[p]!; out[p + 1] = src[p + 1]!; out[p + 2] = src[p + 2]!; } else { out[p] = bd[0]; out[p + 1] = bd[1]; out[p + 2] = bd[2]; }
      out[p + 3] = 255;
    }
    frames.push({ t, grid: padToField(cellGrid({ width: f.width, height: f.height, data: out }, cell), cssCell, viewport) });
    t += f.delayMs;
  });
  if (result.truncated && frames.length < 2) throw new Error('GIF over the decoding limits');
  if (frames.length < 2) return { kind: 'clear' };
  // Played for 2 s, looping as the file says (a GIF without a loop block plays once); the last frame
  // stays up for its delay, so the end is marked with it again.
  const once = t;
  const loops = result.loops === null ? 0 : result.loops === 0 ? Infinity : result.loops;
  const timed: FlashFrame[] = [...frames];
  let end = once;
  for (let k = 1; k <= loops && end < PLAY_MS && timed.length < 1000; k++) {
    for (const f of frames) timed.push({ t: f.t + once * k, grid: f.grid });
    end = once * (k + 1);
  }
  timed.push({ t: end, grid: timed[timed.length - 1]!.grid });
  const a = analyseFlashes(timed, cssCell, viewport);
  if (a.general) return { kind: 'fails', red: false, transitions: a.general.transitions };
  if (a.red) return { kind: 'fails', red: true, transitions: a.red.transitions };
  return { kind: 'clear' };
}

// ---------------------------------------------------------------------------------------------------
// Reading image bytes through CDP (the page's own cache; cross-origin images too).

interface ResourceEntry { url: string; contentSize?: number }

async function imageBytes(cdp: CDPSessionLike, frameId: string, resources: ReadonlyMap<string, ResourceEntry>, url: string): Promise<Uint8Array | 'unread' | 'large'> {
  const r = resources.get(url);
  if (!r) return 'unread';
  if (typeof r.contentSize === 'number' && r.contentSize > GIF_LIMITS.maxBytes) return 'large';
  const got = await within(CALL_MS, cdp.send('Page.getResourceContent', { frameId, url }) as Promise<{ content?: unknown; base64Encoded?: unknown }>, null);
  if (!got || typeof got.content !== 'string') return 'unread';
  if (got.content.length > GIF_LIMITS.maxBytes * 1.4) return 'large';
  if (!got.base64Encoded) return new TextEncoder().encode(got.content);
  const bin = atob(got.content);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function resourceIndex(cdp: CDPSessionLike): Promise<{ frameId: string; resources: Map<string, ResourceEntry> } | null> {
  // Reading a resource's content needs the Page domain on this session (Playwright's own is separate).
  await within(CALL_MS, cdp.send('Page.enable'), undefined);
  const tree = await within(CALL_MS, cdp.send('Page.getResourceTree') as Promise<{ frameTree?: { frame?: { id?: unknown }; resources?: unknown } }>, null);
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || !Array.isArray(tree?.frameTree?.resources)) return null;
  const resources = new Map<string, ResourceEntry>();
  for (const r of tree.frameTree.resources as ResourceEntry[]) if (r && typeof r.url === 'string') resources.set(r.url, r);
  return { frameId, resources };
}

// ---------------------------------------------------------------------------------------------------
// The probe.

const share = (w: number, h: number, viewport: { width: number; height: number }) => fieldShare(w, h, viewport);
const pct = (n: number) => `${Math.round(n * 100)}%`;

export interface MotionJudgement {
  failed: { path: string; detail: string }[];
  unclear: string[];
  checked: { animations: number; restyled: number; images: number };
}

/** The page's sources judged (images already read: `bytes` by src). Pure. */
export function judgeMotion(scan: MotionScan, bytes: ReadonlyMap<string, Uint8Array | 'unread' | 'large'>, viewport: { width: number; height: number }): MotionJudgement {
  const failed: MotionJudgement['failed'] = [];
  const unclear: string[] = [];
  const fail = (path: string, what: string, v: Extract<Verdict, { kind: 'fails' }>, w: number, h: number) => failed.push({
    path, detail: `${v.red ? 'red flashing' : 'flashing'} ${what}: ${v.transitions} ${v.red ? 'changes to or from saturated red' : 'changes of brightness'} in one second (more than three flashes) over ${pct(Math.min(1, share(w, h, viewport)))} of a 10° field of view (more than 25% fails), found without frames of the screen`,
  });
  let animations = 0;
  for (const a of scan.animations) {
    animations++;
    const v = judgeAnimation(a, viewport);
    if (v.kind === 'fails') fail(a.path, 'in an animation (from its keyframes)', v, a.w, a.h);
    else if (v.kind === 'unclear') unclear.push(`${v.why} (${a.path})`);
  }
  for (const r of scan.restyled) {
    const v = judgeRestyled(r, viewport);
    if (v.kind === 'fails') fail(r.path, 'as a script restyles it', v, r.w, r.h);
    else if (v.kind === 'unclear') unclear.push(`${v.why} (${r.path})`);
  }
  let images = 0;
  for (const img of scan.images) {
    const b = bytes.get(img.src);
    const large = share(img.w, img.h, viewport) > FLASH.areaShare;
    if (!b || b === 'unread' || b === 'large') {
      if (large) unclear.push(`an image whose file could not be read${b === 'large' ? ' (too large)' : ''} (${img.path})`);
      continue;
    }
    const kind = imageKind(b);
    if (kind === 'still') continue;
    images++;
    if (!large) continue;
    if (kind === 'animated') { unclear.push(`an animated image in a format the check does not decode (${img.path})`); continue; }
    try {
      const v = judgeGif(b, img, viewport);
      if (v.kind === 'fails') fail(img.path, 'in an animated GIF', v, img.w, img.h);
    } catch {
      unclear.push(`an animated GIF too large to decode (${img.path})`);
    }
  }
  const words: Record<MotionOther['kind'], string> = { video: 'a playing video', canvas: 'a canvas', frame: 'an embedded frame', smil: 'an SVG animation' };
  for (const o of scan.others) if (share(o.w, o.h, viewport) > FLASH.areaShare) unclear.push(`${words[o.kind]} (${o.path})`);
  return { failed, unclear, checked: { animations, restyled: scan.restyled.length, images } };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const flashMotionProbe: PageProbe = {
  id: 'flash-motion',
  criteria: ['2.3.1'],
  kind: 'render',
  tier: 'deep',
  // Not scored until a gold-standard mutation verifies it (docs/scoring.md); the report keeps its
  // result only where the frames of the screen could not decide (`flashPrecedence`).
  scored: false,
  timeoutMs: 20_000,
  contextOptions: MOTION_CONTEXT,
  async run(ctx: ProbeContext) {
    const { page, viewport } = ctx;
    await kitReady(page);
    const scan = await page.evaluate(flashMotionScan, { observeMs: OBSERVE_MS, max: MAX_ITEMS, minArea: 400 });
    const bytes = new Map<string, Uint8Array | 'unread' | 'large'>();
    const wanted = scan.images.filter((i) => share(i.w, i.h, viewport) > FLASH.areaShare);
    if (wanted.length) {
      const cdp = ctx.cdp ? await within(CALL_MS, ctx.cdp(), undefined) : undefined;
      const index = cdp ? await resourceIndex(cdp) : null;
      for (const img of wanted) {
        if (bytes.has(img.src)) continue;
        if (bytes.size >= MAX_DECODED) { bytes.set(img.src, 'unread'); continue; }
        if (ctx.signal.aborted || Date.now() > ctx.deadline - 3000) { bytes.set(img.src, 'unread'); continue; }
        bytes.set(img.src, cdp && index ? await imageBytes(cdp, index.frameId, index.resources, img.src) : 'unread');
      }
    }
    const j = judgeMotion(scan, bytes, viewport);
    ctx.setData?.({ checked: j.checked, failed: j.failed.length, unclear: j.unclear.slice(0, 5) });
    const method = `${plural(j.checked.animations, 'animation')}, ${plural(j.checked.restyled, 'element')} a script restyled and ${plural(j.checked.images, 'animated image')}, judged from their keyframes, style changes and image frames, without frames of the screen`;
    if (j.failed.length) {
      return j.failed.slice(0, 3).map((f): ProbeFinding => ({ criterion: '2.3.1', status: 'failed', target: f.path, detail: f.detail }));
    }
    if (j.unclear.length) {
      return [{ criterion: '2.3.1', status: 'not_testable', detail: `without frames of the screen, these could not be checked for flashing: ${j.unclear.slice(0, 3).join('; ')}${j.unclear.length > 3 ? `; and ${j.unclear.length - 3} more` : ''}` }];
    }
    return [{ criterion: '2.3.1', status: 'no_failures_found', detail: `no flashing above the threshold in ${method}` }];
  },
};

/**
 * The flash test's frames decide a page when they could (a failure, or no failure at the needed frame
 * rate); there the animation and media check's result gives way (not applicable, with the reason).
 * Pure: runs in, runs out.
 */
export function flashPrecedence(runs: readonly ProbeRun[]): ProbeRun[] {
  const decided = new Set<string>();
  for (const r of runs) {
    if (r.probe === 'flash' && r.findings.some((f) => f.criterion === '2.3.1' && (f.status === 'failed' || f.status === 'no_failures_found'))) decided.add(r.page);
  }
  if (!decided.size) return [...runs];
  return runs.map((r) => (r.probe === flashMotionProbe.id && decided.has(r.page)
    ? { ...r, findings: [{ criterion: '2.3.1', status: 'not_applicable' as const, detail: 'the frames of the screen decided this page (the flash test)' }] }
    : r));
}
