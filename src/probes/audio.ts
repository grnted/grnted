// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.2 Audio Control (Plan 4 Task 4.4): sound that plays by itself for more than 3 s needs a
// way to pause or stop it, or to set its volume apart from the system volume. Core probe. Engine
// core: no Node-only imports.
//
// Sound sources, after media blocked by the browser's autoplay policy has been started (and audio
// contexts it suspended resumed) as a permissive browser would:
// - audio and video elements playing, not muted, volume above 0 (also ones never added to the
//   document), whose own sound, captured and listened to, is above the audible level. It lasts more
//   than 3 s when it loops, is a stream or is longer than 3 s;
// - Web Audio connected to the speakers: the probe listens with an analyser on the nodes connected
//   to the output and counts sound still audible after 3 s;
// - media in embedded frames (checked with the frame's own code).
// Each source then needs a control: a media element's own controls count; otherwise the probe clicks
// controls named pause, stop, mute, sound, volume or similar (near the element first), and switches named for
// sound, and checks that the sound stopped. No sound → no failures found.
//
// A failure is filed only when every link of it is shown (batch 18, the lead's ruling 12; anything else is not
// testable, with the link that did not hold):
// - it makes sound: the source's own sound is measured above the audible level (an <audio> or <video> element
//   captured and listened to; Web Audio heard on the context's speaker connections). A media element whose sound
//   the page routes into Web Audio is heard, and judged, through that context, with the element's own controls;
// - it plays by itself: it has the autoplay attribute, or the page started it outside a click, press or key (a
//   source the test's or an earlier test's press started is not automatic);
// - more than 3 s (its length, a loop or a stream; Web Audio heard 3 s after its sound started);
// - no way to stop it: every control tried did nothing, and no other control is left that could be the way to stop
//   it: a switch, check box or slider named for sound or with no name, a control with no name or only a symbol near
//   the sound or in a fixed bar or header, one in a web component, more such controls than the test tries, or words
//   on the page that say a key stops it. While an earlier test holds the page's timers, a timer of the page's own
//   that would stop the sound could not run, so "it kept playing" proves nothing (the late pass).
import type { FrameLike, PageLike } from '../types.js';
import { AUDIO_VOCAB, installKit, type Kit, type KitElement } from './kit.js';
import { MOTION_CONTEXT, clickControl, controlsFor, guardStop, hasTime, kitReady, kitStop, within, refusedText, requireHook, lasting, settledStop, startBlockedAutoplay, type Candidates } from './motionShared.js';
import { LATE_CONTENT_MS, mountingNow, trackMount, type MountTracker } from './mounting.js';
import type { PageProbe, ProbeContext, ProbeFinding } from './types.js';

/** WCAG 1.4.2: sound that plays automatically for more than 3 s needs a control. */
export const AUDIO_LIMIT_MS = 3000;
/** Peak level (linear, full scale 1) above which an analyser hears sound: about -60 dBFS. */
export const AUDIBLE_PEAK = 0.001;
/**
 * Web Audio: margin (ms) past the 3 s, from when the sound started, before a sound still audible is
 * counted, and how often (ms) the test listens while it waits for sound to start.
 */
export const WEB_AUDIO_TIMING = { margin: 250, listen: 50, startWindow: 400, quietGap: 750, warmUp: 100 } as const;

/**
 * What the test knows of a Web Audio context's sound (page clock, ms): when it started (null while
 * silent), when it was last heard, and the last listen that heard it silent (a real silence: not the
 * first moments of a fresh analyser, which reads silence while its buffer fills).
 */
export interface SoundClock {
  startAt: number | null;
  lastAudible: number | null;
  lastSilent: number | null;
}

/**
 * One listen to a Web Audio context. A sound heard is timed from when its source was scheduled to start
 * (the hook records start(when) and stop(when) on the context's clock: `sourceStart`, the earliest
 * source playing now), but never before the last real silence the test heard (a source started silent
 * and turned up later) nor after now; without a source record, from this listen. A rest of up to
 * `quietGap` ms does not stop the clock (a bed with a pause still plays); a longer silence does, and the
 * next sound is timed anew. `soundClock` does the same in the page.
 */
export function nextSoundClock(prev: SoundClock | undefined, sample: { audible: boolean; now: number; sourceStart?: number | null; warmingUp?: boolean }): SoundClock {
  const { audible, now } = sample;
  const p: SoundClock = prev ?? { startAt: null, lastAudible: null, lastSilent: null };
  if (!audible) {
    if (sample.warmingUp) return p;
    const resting = p.startAt != null && p.lastAudible != null && now - p.lastAudible <= WEB_AUDIO_TIMING.quietGap;
    return resting ? { ...p, lastSilent: now } : { startAt: null, lastAudible: p.lastAudible, lastSilent: now };
  }
  if (p.startAt != null) return { ...p, lastAudible: now };
  const from = Math.min(now, Math.max(sample.sourceStart ?? now, p.lastSilent ?? -Infinity));
  return { startAt: from, lastAudible: now, lastSilent: p.lastSilent };
}

/** A Web Audio sound counts as playing by itself for more than 3 s once it was heard 3 s and a margin after it started. */
export function webAudioCounted(c: SoundClock): boolean {
  return c.startAt != null && c.lastAudible != null && c.lastAudible >= webAudioDeadline(c.startAt);
}

/** When a Web Audio sound that started at `startAt` counts as lasting more than 3 s if it still sounds. */
export function webAudioDeadline(startAt: number): number {
  return startAt + AUDIO_LIMIT_MS + WEB_AUDIO_TIMING.margin;
}

/** A sound source in the page. `key` finds it again: a kit id (media) or 'ctx:<tag>' (Web Audio: the context's own tag in the page). */
export interface SoundSource {
  key: string;
  kind: 'media' | 'webaudio';
  what: string;
  /** Element in the document (media only), for controls near it and its own controls. */
  el?: KitElement;
  /** Total length in ms; null when it loops, is a stream or (Web Audio) has no known end. */
  lastsMs: number | null;
  /** The element shows the browser's own controls. */
  nativeControls: boolean;
  /**
   * Sound confirmed (true: its own sound measured above the audible level), or not known (null: not heard yet,
   * or, with `unmeasured`, it cannot be listened to at all).
   */
  heard: boolean | null;
  /** Its sound cannot be captured to be measured (a file on another site that does not allow reading it). */
  unmeasured?: boolean;
  /** It was started by a click, press or key (the page did not start it by itself). */
  byInput?: boolean;
  /** Web Audio fed by media elements the page routed into it (their sound, played through the context). */
  feeds?: number;
}

type Taps = Map<BaseAudioContext, AnalyserNode>;
type Sound = {
  played: HTMLMediaElement[]; contexts: BaseAudioContext[]; outputs: AudioNode[]; pageSuspended(c: BaseAudioContext): boolean;
  sources?: { ctx: BaseAudioContext; start: number; stop: number; byInput?: boolean }[];
  /** The page called play() on it outside an input event (absent from an older hook: then every play counts). */
  playedAuto?(m: HTMLMediaElement): boolean;
  /** The context was made while an input event was being dispatched. */
  ctxByInput?(c: BaseAudioContext): boolean;
  /** Media elements whose sound the page routed into a context (createMediaElementSource). */
  routed?: { el: HTMLMediaElement; ctx: BaseAudioContext }[];
  /** Text the page spoke with speech synthesis. */
  speech?: { at: number; byInput: boolean; chars: number }[];
};

/**
 * Runs in the page (or a frame), after `startBlockedAutoplay`: resumes audio contexts the browser
 * (not the page) suspended, and puts an analyser on each context's speaker connections.
 */
function startSound(): number {
  const w = window as unknown as { __grntedSound?: () => Sound; __grntedTaps?: Map<BaseAudioContext, AnalyserNode> };
  let started = 0;
  const sound = w.__grntedSound?.();
  if (!sound) return started;
  const taps = (w.__grntedTaps ??= new Map());
  for (const c of sound.contexts) {
    try {
      if (c.state === 'suspended' && !sound.pageSuspended(c) && 'resume' in c) {
        void (c as AudioContext).resume().catch(() => {});
        ((window as unknown as { __grntedResumed?: Set<BaseAudioContext> }).__grntedResumed ??= new Set()).add(c);
        started++;
      }
      if (taps.has(c)) continue;
      const outs = sound.outputs.filter((o) => o.context === c);
      if (!outs.length) continue;
      const an = c.createAnalyser();
      an.fftSize = 2048;
      for (const o of outs) { try { o.connect(an); } catch { /* a node that cannot fan out */ } }
      taps.set(c, an);
      ((window as unknown as { __grntedTapAt?: Map<BaseAudioContext, number> }).__grntedTapAt ??= new Map()).set(c, performance.now());
    } catch { /* a closed context */ }
  }
  return started;
}

/**
 * Runs in the page (or a frame): listens once to each Web Audio context with an analyser and updates
 * when its sound started (`nextSoundClock`, inlined: this runs in the page). Returns the start time
 * (page clock, ms) by key ('ctx:<n>'), null while silent, and the page's clock now.
 */
function soundClock(arg: { peak: number; quietGap: number; warmUp: number }): { now: number; clock: Record<string, { startAt: number | null; lastAudible: number | null; lastSilent: number | null }> } {
  type C = { startAt: number | null; lastAudible: number | null; lastSilent: number | null };
  const w = window as unknown as {
    __grntedSound?: () => Sound & { sources?: { ctx: BaseAudioContext; start: number; stop: number }[] };
    __grntedTaps?: Map<BaseAudioContext, AnalyserNode>; __grntedTapAt?: Map<BaseAudioContext, number>;
    __grntedClock?: Map<BaseAudioContext, C>;
  };
  const clocks = (w.__grntedClock ??= new Map());
  const now = performance.now();
  const out: Record<string, C> = {};
  const buf = new Float32Array(2048);
  const sound = w.__grntedSound?.();
  // Each context by its own tag (fix/late-mount r1: never by its place in the list, which another context can take).
  const ctxId = (c: BaseAudioContext): number => { const ids = ((window as unknown as { __grntedCtxIds?: WeakMap<BaseAudioContext, number> }).__grntedCtxIds ??= new WeakMap()); let id = ids.get(c); if (id === undefined) { const g = window as unknown as { __grntedCtxNext?: number }; id = g.__grntedCtxNext = (g.__grntedCtxNext ?? 0) + 1; ids.set(c, id); } return id; };
  (sound?.contexts ?? []).forEach((c) => {
    const an = w.__grntedTaps?.get(c);
    if (!an) return;
    let peak = 0;
    if (c.state === 'running') {
      an.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
    const audible = peak > arg.peak;
    // The earliest source of this context playing now, by its scheduled start (page clock).
    const ct = c.currentTime;
    const playing = (sound?.sources ?? []).filter((r) => r.ctx === c && r.start <= ct && r.stop > ct);
    const sourceStart = playing.length ? now - (ct - Math.min(...playing.map((r) => r.start))) * 1000 : null;
    const warmingUp = now - (w.__grntedTapAt?.get(c) ?? -Infinity) < arg.warmUp;
    // nextSoundClock, inlined (this runs in the page).
    const p: C = clocks.get(c) ?? { startAt: null, lastAudible: null, lastSilent: null };
    let next: C;
    if (!audible) {
      if (warmingUp) next = p;
      else if (p.startAt != null && p.lastAudible != null && now - p.lastAudible <= arg.quietGap) next = { ...p, lastSilent: now };
      else next = { startAt: null, lastAudible: p.lastAudible, lastSilent: now };
    } else if (p.startAt != null) next = { ...p, lastAudible: now };
    else next = { startAt: Math.min(now, Math.max(sourceStart ?? now, p.lastSilent ?? -Infinity)), lastAudible: now, lastSilent: p.lastSilent };
    clocks.set(c, next);
    out[`ctx:${ctxId(c)}`] = next;
  });
  return { now, clock: out };
}

/**
 * Runs in the page (or a frame): counts the calls that stop or quieten sound (a context suspended or
 * closed, a source stopped, a node disconnected, a gain or other parameter set or scheduled, a media
 * element paused, muted or turned down) that a control's own click handler makes: only calls made while
 * a click (or the press around it) is being dispatched, so the page's timers, `onended` handlers and
 * animation frames in the moments after the click are never taken for the control. 'install' wraps
 * them (once), 'count' reads the count, 'remove' puts them back.
 */
function audioActs(arg: { op: 'install' | 'count' | 'remove' }): number {
  type Saved = { obj: object; key: string; desc: PropertyDescriptor };
  const w = window as unknown as { __grntedActs?: { n: number; saved: Saved[] }; __grntedInInput?: () => boolean };
  if (arg.op === 'count') return w.__grntedActs?.n ?? -1;
  if (arg.op === 'remove') {
    for (const sv of w.__grntedActs?.saved ?? []) { try { Object.defineProperty(sv.obj, sv.key, sv.desc); } catch { /* sealed */ } }
    delete w.__grntedActs;
    return 0;
  }
  if (w.__grntedActs) return w.__grntedActs.n;
  const st = (w.__grntedActs = { n: 0, saved: [] as Saved[] });
  // `change` and `input`: what a switch, check box or slider fires from the same click or key (batch 18: a sound switch).
  const input = new Set(['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'change', 'input']);
  // The event being dispatched now (window.event): set only while its handlers run, synchronously. Inside a shadow
  // tree window.event is undefined (the DOM standard; batch 18: a web component's Mute button): the listener hook
  // tells it then (`__grntedInInput`, from the window's own capture and bubble listeners, which it never records).
  const inClick = () => { const e = (window as unknown as { event?: Event }).event; return (!!e && input.has(e.type)) || !!w.__grntedInInput?.(); };
  const wrap = (from: object | undefined, key: string) => {
    // On the prototype that owns it (window.AudioContext may be the page hook's subclass).
    let proto: object | null | undefined = from;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, key)) proto = Object.getPrototypeOf(proto) as object | null;
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc || !desc.configurable) return;
    try {
      if (typeof desc.value === 'function') {
        const orig = desc.value as (...a: unknown[]) => unknown;
        Object.defineProperty(proto, key, { ...desc, value: function (this: unknown, ...a: unknown[]) { if (inClick()) st.n++; return orig.apply(this, a); } });
        st.saved.push({ obj: proto, key, desc });
      } else if (desc.set) {
        const setter = desc.set;
        Object.defineProperty(proto, key, { ...desc, set: function (this: unknown, v: unknown) { if (inClick()) st.n++; setter.call(this, v); } });
        st.saved.push({ obj: proto, key, desc });
      }
    } catch { /* not configurable */ }
  };
  const g = window as unknown as Record<string, { prototype?: object } | undefined>;
  wrap(g.AudioContext?.prototype, 'suspend');
  wrap(g.AudioContext?.prototype, 'close');
  wrap(g.AudioScheduledSourceNode?.prototype, 'stop');
  wrap(g.AudioNode?.prototype, 'disconnect');
  for (const k of ['value', 'setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) wrap(g.AudioParam?.prototype, k);
  for (const k of ['pause', 'muted', 'volume']) wrap(g.HTMLMediaElement?.prototype, k);
  return 0;
}


/**
 * Runs in the page (or a frame): starts media inside open shadow roots that has the autoplay attribute and never
 * started because the browser blocked autoplay, as `startBlockedAutoplay` does for the document (batch 18: a web
 * component's player). Only the audio test does this. Returns how many it started.
 */
function startShadowAutoplay(): number {
  let started = 0;
  const roots: ShadowRoot[] = [];
  for (const el of [...document.querySelectorAll('*')].slice(0, 20_000)) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (let i = 0; i < roots.length && i < 100; i++) {
    for (const el of [...roots[i]!.querySelectorAll('*')].slice(0, 5000)) {
      if (el.shadowRoot && roots.length < 200) roots.push(el.shadowRoot);
      if (!(el instanceof HTMLMediaElement) || !el.autoplay || !el.paused || el.ended || el.played.length > 0 || el.currentTime > 0.05) continue;
      if (!el.currentSrc && !el.src && !el.querySelector('source')) continue;
      started++;
      el.play().catch(() => {});
    }
  }
  return started;
}

/** Runs in the page (or a frame): whether it has any media element or audio context at all. */
function hasSoundSources(): boolean {
  const sound = (window as unknown as { __grntedSound?: () => Sound }).__grntedSound?.();
  return !!document.querySelector('audio, video') || !!sound?.played.length || !!sound?.contexts.length;
}

/** Runs in the page (or a frame): the sources playing now (not muted, volume above 0). */
function soundSources(arg: { limitMs: number; peak: number }): { sources: SoundSource[]; media: number; contexts: number; speech: { at: number; chars: number }[] } {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const w = window as unknown as { __grntedSound?: () => Sound; __grntedTaps?: Map<BaseAudioContext, AnalyserNode> };
  const sound = w.__grntedSound?.();
  const all = new Set<HTMLMediaElement>([...document.querySelectorAll('audio, video')] as HTMLMediaElement[]);
  for (const m of sound?.played ?? []) all.add(m);
  // Media inside open shadow roots (a web component's player) that autoplays without a play() call (batch 18).
  {
    const roots: ShadowRoot[] = [];
    for (const el of [...document.querySelectorAll('*')].slice(0, 20_000)) if (el.shadowRoot) roots.push(el.shadowRoot);
    for (let i = 0; i < roots.length && i < 100; i++) {
      for (const el of [...roots[i]!.querySelectorAll('*')].slice(0, 5000)) {
        if (el.shadowRoot && roots.length < 200) roots.push(el.shadowRoot);
        if (el instanceof HTMLMediaElement) all.add(el);
      }
    }
  }
  const sources: SoundSource[] = [];
  /** Seconds a media fragment in the address selects (`#t=8,10`: 2 s, then the browser pauses it), or null. */
  const fragment = (src: string, duration: number): number | null => {
    const f = /#(?:.*&)?t=(?:npt:)?([\d:.]*)(?:,([\d:.]+))?/.exec(src);
    if (!f || (!f[1] && !f[2])) return null;
    const secs = (t: string | undefined, fallback: number) => (t ? t.split(':').map(Number).reduce((a, n) => a * 60 + n, 0) : fallback);
    const start = Math.min(secs(f[1], 0), duration);
    const end = Math.min(secs(f[2], duration), duration);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  };
  type Tap = { ctx: AudioContext; timer: number; loud: boolean; tracks: MediaStreamTrack[] };
  const taps = ((window as unknown as { __grntedMediaTaps?: Map<HTMLMediaElement, Tap | 'none'> }).__grntedMediaTaps ??= new Map());
  /**
   * A video's sound, from its own audio: the tracks of a capture of the element (Chromium lists them once the
   * file's metadata is read, before any audio is decoded). No audio track beside a video track: 'none', the file has
   * no sound. Otherwise an analyser listens to the captured audio every 50 ms while it plays (the element's muting
   * and the browser's speakers do not change what is captured): 'loud' once a peak passes `peak`; otherwise
   * 'listening' (also while its metadata has not loaded). A quiet observation window cannot establish absence of
   * later audio. null when the element cannot be captured (cross-origin media without CORS): its sound cannot be
   * measured.
   */
  const soundOf = (m: HTMLMediaElement): 'none' | 'loud' | 'listening' | null => {
    let tap = taps.get(m);
    if (!tap) {
      // Not loaded yet: listened to on a later look.
      if (m.readyState < 1) return 'listening';
      try {
        const stream = (m as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream?.();
        if (!stream) return null;
        const audio = stream.getAudioTracks();
        if (!audio.length) {
          const video = stream.getVideoTracks().length > 0;
          stream.getTracks().forEach((t) => t.stop());
          if (!video) return null;
          taps.set(m, 'none');
          return 'none';
        }
        stream.getVideoTracks().forEach((t) => t.stop());
        const ctx = new AudioContext();
        void ctx.resume().catch(() => {});
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        ctx.createMediaStreamSource(new MediaStream(audio)).connect(an);
        const buf = new Float32Array(2048);
        const t: Tap = { ctx, timer: 0, loud: false, tracks: audio };
        t.timer = window.setInterval(() => {
          if (m.paused || m.ended || ctx.state !== 'running') return;
          an.getFloatTimeDomainData(buf);
          for (const v of buf) if (Math.abs(v) > arg.peak) { t.loud = true; break; }
        }, 50);
        taps.set(m, (tap = t));
      } catch {
        return null;
      }
    }
    if (tap === 'none') return 'none';
    if (tap.loud) return 'loud';
    return 'listening';
  };
  // Media elements whose sound the page routed into Web Audio: heard, and judged, through their context.
  const routedTo = new Map<HTMLMediaElement, BaseAudioContext>();
  for (const r of sound?.routed ?? []) { try { if (r.el && r.ctx) routedTo.set(r.el, r.ctx); } catch { /* gone */ } }
  // Started by itself: the autoplay attribute, or the page called play() outside an input event. An older hook
  // that does not tell counts every play as by itself (as before).
  const byItself = (m: HTMLMediaElement) => m.autoplay || (sound?.playedAuto ? sound.playedAuto(m) : true);
  for (const m of all) {
    if (m.paused || m.ended || m.muted || m.volume === 0) continue;
    if (routedTo.has(m)) continue;
    const finite = Number.isFinite(m.duration) && m.duration > 0;
    const plays = finite ? fragment(m.currentSrc, m.duration) ?? m.duration : NaN;
    const lastsMs = m.loop || !finite ? null : Math.round(plays * 1000);
    if (lastsMs !== null && lastsMs <= arg.limitMs) continue;
    const isAudio = m instanceof HTMLAudioElement;
    // Its own sound, captured and listened to (`soundOf`): an audio or video element counts as making sound only
    // once that is measured above the audible level (batch 18, ruling 12: a playing <audio> may play a silent file
    // or nothing at all). Confirmed absence of an audio track rules out sound; an element that cannot be captured
    // (cross-origin media without CORS) cannot be measured: undecided, never assumed to sound.
    const own = soundOf(m);
    if (own === 'none') continue;
    const heard: true | null = own === 'loud' ? true : null;
    const inDoc = m.isConnected;
    const how = m.loop ? 'looping' : finite ? `${Math.round(m.duration)} s long` : 'a stream';
    sources.push({
      key: `m:${kit.keep(m)}`, kind: 'media', lastsMs, heard,
      ...(own === null ? { unmeasured: true } : {}),
      ...(byItself(m) ? {} : { byInput: true }),
      what: `${isAudio ? (inDoc ? 'an audio player' : 'audio started by a script') : 'a video'} (${how})`,
      nativeControls: inDoc && m.controls && kit.visible(m),
      ...(inDoc ? { el: kit.describe(m) } : {}),
    });
  }
  const contexts = sound?.contexts ?? [];
  const buf = new Float32Array(2048);
  const ctxId = (c: BaseAudioContext): number => { const ids = ((window as unknown as { __grntedCtxIds?: WeakMap<BaseAudioContext, number> }).__grntedCtxIds ??= new WeakMap()); let id = ids.get(c); if (id === undefined) { const g = window as unknown as { __grntedCtxNext?: number }; id = g.__grntedCtxNext = (g.__grntedCtxNext ?? 0) + 1; ids.set(c, id); } return id; };
  contexts.forEach((c) => {
    const an = w.__grntedTaps?.get(c);
    if (!an || c.state !== 'running') return;
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    if (peak <= arg.peak) return;
    // What feeds it: media elements routed into it that play, and source nodes playing now.
    const feeds = [...routedTo].filter(([m, x]) => x === c && !m.paused && !m.ended && !m.muted && m.volume > 0).map(([m]) => m);
    const ct = c.currentTime;
    const playing = (sound?.sources ?? []).filter((r) => r.ctx === c && r.start <= ct && r.stop > ct);
    // By itself unless what plays was started in an input event: source nodes started then, routed elements
    // started then, or (nothing recorded: a worklet or a stream) a context made then.
    const auto = playing.some((r) => !r.byInput) || feeds.some(byItself) || (!playing.length && !feeds.length && !sound?.ctxByInput?.(c));
    // A routed element's own controls pause what the context plays when nothing else plays through it.
    const player = feeds.find((m) => m.isConnected);
    const native = !playing.length && feeds.some((m) => m.isConnected && m.controls && kit.visible(m));
    sources.push({
      key: `ctx:${ctxId(c)}`, kind: 'webaudio', what: feeds.length ? 'an audio player played through Web Audio' : 'sound made with Web Audio',
      lastsMs: null, nativeControls: native, heard: true,
      ...(auto ? {} : { byInput: true }),
      ...(feeds.length ? { feeds: feeds.length } : {}),
      ...(player ? { el: kit.describe(player) } : {}),
    });
  });
  // Text the page spoke with speech synthesis outside an input event (G14): recorded, never measured.
  const speech = (sound?.speech ?? []).filter((u) => !u.byInput).slice(0, 10).map((u) => ({ at: u.at, chars: u.chars }));
  return { sources, media: all.size, contexts: contexts.length, speech };
}

/**
 * Runs in the page (or a frame): the source now. 'playing'; 'stopped' (a media element paused, muted
 * or turned down to 0, or a Web Audio context no longer running); 'ended' (a media element that played
 * to its end, or Web Audio whose context still runs but is silent: it ended, or a node was stopped or
 * turned down, which `audioActs` tells apart).
 */
function soundState(arg: { key: string; peak: number }): 'playing' | 'stopped' | 'ended' {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const w = window as unknown as { __grntedSound?: () => Sound; __grntedTaps?: Map<BaseAudioContext, AnalyserNode> };
  if (arg.key.startsWith('m:')) {
    const m = kit.get(Number(arg.key.slice(2))) as HTMLMediaElement | undefined;
    if (!m) return 'stopped';
    if (m.ended) return 'ended';
    return m.paused || m.muted || m.volume === 0 ? 'stopped' : 'playing';
  }
  const ids = (window as unknown as { __grntedCtxIds?: WeakMap<BaseAudioContext, number> }).__grntedCtxIds;
  const c = w.__grntedSound?.().contexts.find((x) => ids?.get(x) === Number(arg.key.slice(4)));
  if (!c || c.state !== 'running') return 'stopped';
  const an = w.__grntedTaps?.get(c);
  if (!an) return 'stopped';
  const buf = new Float32Array(2048);
  an.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak <= arg.peak ? 'ended' : 'playing';
}

/**
 * Runs in the page (or a frame): removes the analysers the probe added and suspends again the audio
 * contexts it resumed, so later probes on the page and the browser do not keep them running.
 */
function stopSound(): void {
  const w = window as unknown as { __grntedSound?: () => Sound; __grntedTaps?: Taps; __grntedResumed?: Set<BaseAudioContext> };
  const sound = w.__grntedSound?.();
  w.__grntedTaps?.forEach((an, c) => {
    for (const o of sound?.outputs ?? []) { if (o.context === c) { try { o.disconnect(an); } catch { /* not connected */ } } }
    try { an.disconnect(); } catch { /* gone */ }
  });
  w.__grntedTaps?.clear();
  w.__grntedResumed?.forEach((c) => { try { if (c.state === 'running') void (c as AudioContext).suspend().catch(() => {}); } catch { /* closed */ } });
  w.__grntedResumed?.clear();
  // The analysers on captured video sound (`soundSources`).
  const media = (w as { __grntedMediaTaps?: Map<HTMLMediaElement, { ctx: AudioContext; timer: number; tracks: MediaStreamTrack[] } | 'none'> }).__grntedMediaTaps;
  media?.forEach((t) => {
    if (t === 'none') return;
    clearInterval(t.timer);
    t.tracks.forEach((k) => k.stop());
    void t.ctx.close().catch(() => {});
  });
  media?.clear();
  (w as { __grntedClock?: Map<BaseAudioContext, unknown> }).__grntedClock?.clear();
  (w as { __grntedTapAt?: Map<BaseAudioContext, unknown> }).__grntedTapAt?.clear();
}

/** Words that say a switch is about sound: such a switch is tried like a pause button (its state is the off switch). */
export const SOUND_TOGGLES: readonly string[] = [
  'sound', 'sounds', 'audio', 'music', 'mute', 'muted', 'unmute', 'volume', 'speaker', 'speakers', 'narration', 'voice',
  'soundtrack', 'ambience', 'ambient', '🔇', '🔈', '🔉', '🔊',
];

/** Candidate controls the test asks for, and how many of them it clicks: one more than it clicks shows whether more are left. */
export const AUDIO_TRIES = 4;

/** A control the test did not try that could be the way to stop the sound, and why it may be. */
export interface OtherControl { name: string; why: string }

/**
 * Runs in the page (or a frame): visible controls the test did not try (not among `skip`, the kit ids of the
 * candidates) that could still be the way to stop the sound, so "nothing stops it" cannot be shown (batch 18, the
 * lead's ruling 12). Only ever turns a failure into "not testable"; it clicks nothing:
 * - a switch, check box or slider whose name is about sound, or that has no name or only a symbol;
 * - a button or link-styled button whose name is about sound;
 * - a control with no name, or a name of symbols only (other than the usual close, menu and arrow marks), near the
 *   sound (`id`), in a fixed or sticky bar, or in the page's header;
 * - any of these inside an open shadow root (a web component's player);
 * - words on the page that say a key stops, pauses or mutes it.
 */
export function otherControls(arg: { id: number | null; skip: number[]; max: number }): OtherControl[] {
  const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
  const skip = new Set(arg.skip);
  const out: OtherControl[] = [];
  const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  const SOUND = /\b(?:sounds?|audio|music|musique|m[uú]sica|volume|volumen|mute[ds]?|unmute|silence|silenciar|speakers?|ambien\w*|soundtrack|narration|voice|listen|song|radio)\b|[🔇🔈🔉🔊♪♫🎵🎶⏸⏹⏯]/iu;
  // Marks whose meaning is known and is not sound: close, menu, more, arrows, plus and minus, search.
  const KNOWN = /^[×✕✖xX☰≡⋮⋯…›‹«»←→↑↓<>+\-−–—?🔍⌄⌃▾▴▸◂]+$/u;
  const BTN = 'button, [role="button"], input[type="button"], input[type="image"], summary';
  const TOG = 'input[type="checkbox"], [role="switch"], [role="checkbox"], [role="menuitemcheckbox"], button[aria-pressed]';
  const SLD = 'input[type="range"], [role="slider"], [role="spinbutton"]';
  const near = arg.id === null ? null : (kit.get(arg.id) ?? null);
  // An element's parent, through a shadow root to its host: a sound inside a web component is near what sits beside
  // the component on the page (batch 18 lab: an icon or a slider next to a player component was never counted).
  const up = (a: Element): Element | null => a.parentElement ?? ((a.parentNode as ShadowRoot | null)?.host ?? null);
  // The part of the page around the sound, as the candidates are looked for (kit.controls): up the ancestors while
  // they stay within four times its area or 60% of the window.
  let region: Element | null = null;
  if (near) {
    const limit = Math.max(kit.area(near) * 4, innerWidth * innerHeight * 0.6);
    let depth = 0;
    for (let a: Element | null = near; a && a !== document.body && depth < 8; a = up(a), depth++) {
      if (depth > 0 && kit.area(a) > limit) break;
      region = a;
    }
  }
  const pinned = (el: Element): boolean => {
    let depth = 0;
    for (let a: Element | null = el; a && a !== document.documentElement && depth < 10; a = a.parentElement, depth++) {
      const pos = getComputedStyle(a).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  };
  const add = (el: Element, inShadow: boolean) => {
    if (out.length >= arg.max) return;
    if ((el as HTMLButtonElement).disabled || el.closest('[aria-disabled="true"]')) return;
    if (!kit.visible(el, true)) return;
    if (skip.has(kit.keep(el))) return;
    const name = clean(kit.name(el) || el.getAttribute('title'));
    const symbols = !/[\p{L}\p{N}]/u.test(name);
    const unnamed = symbols && !(name && KNOWN.test(name.replace(/\s+/g, '')));
    const sound = SOUND.test(name);
    const toggle = el.matches(TOG);
    const slider = el.matches(SLD);
    const close = (region && region.contains(el)) || pinned(el) || !!el.closest('header, [role="banner"]');
    let why = '';
    if ((toggle || slider) && (sound || unnamed)) why = slider ? 'a slider that may set the volume' : 'a switch that may turn the sound off';
    else if (sound) why = 'its name is about sound';
    else if (unnamed && close) why = name ? 'a control named only with symbols, near the sound or in a bar of the page' : 'a control with no name, near the sound or in a bar of the page';
    else if (slider && close) why = 'a slider near the sound or in a bar of the page';
    if (!why) return;
    out.push({ name: (name || el.localName).slice(0, 60), why: inShadow ? `${why}, in a web component` : why });
  };
  const SEL = `${BTN}, ${TOG}, ${SLD}`;
  document.querySelectorAll(SEL).forEach((el) => add(el, false));
  // Open shadow roots (a player component's own controls), a bounded walk.
  const roots: ShadowRoot[] = [];
  for (const el of [...document.querySelectorAll('*')].slice(0, 20_000)) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (let i = 0; i < roots.length && i < 100 && out.length < arg.max; i++) {
    const all = [...roots[i]!.querySelectorAll('*')].slice(0, 5000);
    for (const el of all) { if (el.shadowRoot && roots.length < 200) roots.push(el.shadowRoot); }
    for (const el of all) if (el.matches(SEL)) add(el, true);
  }
  // A key the page says stops the sound ("Press M to mute the music").
  if (out.length < arg.max) {
    const text = clean(document.body?.innerText).slice(0, 20_000);
    const m = /\b(?:press|hit|use|type)\s+(?:the\s+)?(?:[A-Za-z0-9]|esc(?:ape)?|space(?:bar)?|enter|ctrl|alt|shift)\b(?:\s+key)?[^.\n]{0,50}\b(?:mute|stop|pause|silence|sound|music|audio|volume)\b/i.exec(text);
    if (m) out.push({ name: m[0].slice(0, 60), why: 'the page says a key stops it, which the test does not press' });
  }
  return out;
}

/**
 * Why a failure of 1.4.2 cannot be shown (batch 18, the lead's ruling 12), or null when every link holds: controls
 * left that could stop it (`others`), more candidates than the test tries (`more`), or the page's own timers held by
 * an earlier test while it was heard (`held`: a timer of the page's that would stop it could not run).
 */
export function unprovenReason(arg: { others: readonly OtherControl[]; more: boolean; held: number }): string | null {
  if (arg.held > 0) return `an earlier test was holding ${arg.held === 1 ? 'one of the page\'s timers' : `${arg.held} of the page's timers`}, so a timer of the page's own that would stop the sound could not run, and whether it plays on by itself could not be told`;
  if (arg.more) return `the page has more controls that may stop it than the test tries (${AUDIO_TRIES}), so whether none of them stops it could not be told`;
  if (!arg.others.length) return null;
  const list = arg.others.slice(0, 3).map((o) => `"${o.name.slice(0, 40)}" (${o.why})`).join(', ');
  return `controls the test did not try may stop it: ${list}${arg.others.length > 3 ? ` and ${arg.others.length - 3} more` : ''}, so whether nothing stops it could not be told`;
}

/** Runs in a frame: clicks a control with a DOM click (frames have no page coordinates here). */
function domClick(id: number): boolean {
  const el = (window as unknown as { __grntedKit: Kit }).__grntedKit.get(id) as HTMLElement | undefined;
  if (!el || !el.isConnected) return false;
  el.click();
  return true;
}

/** The main page or one embedded frame, with how to click in it. */
interface Scope {
  name: string;
  target: PageLike | FrameLike;
  click(c: KitElement, near?: number): Promise<boolean>;
}

/** Embedded frames given the sound test. */
const MAX_FRAMES = 6;

/** The source now (`soundState`); null when that could not be read (the code failed in the page or frame). */
async function stateOf(s: Scope, key: string): Promise<'playing' | 'stopped' | 'ended' | null> {
  return s.target.evaluate(soundState, { key, peak: AUDIBLE_PEAK }).catch(() => null);
}

/** Whether the source is silent now; null when that could not be read. */
async function silent(s: Scope, key: string): Promise<boolean | null> {
  const st = await stateOf(s, key);
  return st === null ? null : st !== 'playing';
}

/** The page's Web Audio stop calls so far (`audioActs`); -1 when they are not counted. */
async function acts(s: Scope): Promise<number> {
  return s.target.evaluate(audioActs, { op: 'count' }).catch(() => -1);
}

/**
 * Whether a control stopped the source, from its state after the click and the stop calls its own click
 * handler made (`audioActs`): still playing, no effect; quiet with a stop call from the click, the
 * control worked; quiet with none, the sound stopped on its own (it ended, or the page's own timer or
 * `onended` stopped it, or suspended its context): the control is not credited. Without the count (the
 * frame would not run the test's code) a quiet source cannot be put down to the control: 'unknown'.
 */
export function controlEffect(arg: { state: 'playing' | 'stopped' | 'ended'; clickActs: number | null }): 'worked' | 'none' | 'ended' | 'unknown' {
  if (arg.state === 'playing') return 'none';
  if (arg.clickActs === null) return 'unknown';
  return arg.clickActs > 0 ? 'worked' : 'ended';
}


const elId = (key: string) => (key.startsWith('m:') ? Number(key.slice(2)) : null);

async function findSources(s: Scope): Promise<{ sources: SoundSource[]; media: number; contexts: number; speech: { at: number; chars: number }[] }> {
  return s.target.evaluate(soundSources, { limitMs: AUDIO_LIMIT_MS, peak: AUDIBLE_PEAK });
}

/** What the test found so far, across its first pass and its late pass. */
interface AudioState {
  /** Media elements and Web Audio contexts checked, per scope (the larger count of the two looks). */
  counts: Map<Scope, { media: number; contexts: number }>;
  /** Whether the test has clicked a control yet in this look (what may have stopped a later source; per look). */
  acted: boolean;
  /** A source was found (heard, or not known): then no "no sound" line. */
  heardAny: boolean;
  /** Sources already judged, per scope (by key): the second look judges only new ones. */
  seen: Map<Scope, Set<string>>;
  /** Frames already given a scope, or counted as not checked. */
  frames: Set<unknown>;
  framesLeft: number;
  /**
   * Page timers an earlier test holds now, per scope (the timing test holds the page's timers of 1 s or more):
   * while any is held, a timer of the page's own that would stop a sound cannot run (ruling 12). 0 in the first pass.
   */
  held: Map<Scope, number>;
  /** What the test found of each sound and its controls, for the run's data (the AI review's evidence). */
  evidence: AudioEvidence[];
}

/** One sound source as the test judged it (the run's data; neutral facts, no verdict). */
export interface AudioEvidence {
  scope: string;
  kind: 'media' | 'webaudio' | 'speech';
  what: string;
  target?: string;
  lastsMs: number | null;
  heard: boolean | null;
  unmeasured?: boolean;
  byInput?: boolean;
  feeds?: number;
  nativeControls?: boolean;
  tried?: string[];
  worked?: string;
  others?: OtherControl[];
  more?: boolean;
  held?: number;
}

/** Runs in the page (or a frame): page timers held now by an earlier test's hold (`__grntedTimerHold`), with the long ones still pending. */
function heldTimers(): number {
  const w = window as unknown as { __grntedTimerHold?: () => { on: boolean; held: number }; __grntedKit?: Kit };
  const h = w.__grntedTimerHold?.();
  if (!h?.on) return 0;
  const pending = (w.__grntedKit?.pending() ?? []).filter((t) => t.delay >= 1000).length;
  return h.held + pending;
}

/** Embedded frames not yet given a scope get one (at most `MAX_FRAMES`), with their kit installed. */
async function addFrames(page: PageLike, scopes: Scope[], findings: ProbeFinding[], state: AudioState): Promise<void> {
  const main = page.mainFrame?.();
  for (const f of page.frames?.() ?? []) {
    if (main && (f as unknown) === (main as unknown)) continue;
    if (!f.parentFrame()) continue;
    if (state.frames.has(f)) continue;
    state.frames.add(f);
    if (scopes.length > MAX_FRAMES) { state.framesLeft++; continue; }
    const ok = await within(2000, f.evaluate(installKit, undefined), false);
    if (!ok) {
      // Sound in a frame the test cannot run code in is neither heard nor ruled out.
      findings.push({ criterion: '1.4.2', status: 'not_testable', detail: `an embedded frame (${f.url().slice(0, 120)}) could not run the test's code, so its sound and controls were not checked` });
      continue;
    }
    scopes.push({ name: `the embedded frame ${f.url().slice(0, 120)}`, target: f, click: async (c) => f.evaluate(domClick, c.id).catch(() => false) });
  }
}

/** Runs in the page (or a frame): forgets the tags the test gave Web Audio contexts (`ctxId`). */
function forgetContextTags(): void {
  delete (window as { __grntedCtxIds?: unknown }).__grntedCtxIds;
  delete (window as { __grntedCtxNext?: unknown }).__grntedCtxNext;
}

/** Puts back what a pass changed in each scope (the contexts' tags stay for a late pass, `keepTags`). */
async function cleanScopes(scopes: readonly Scope[], keepTags: boolean): Promise<void> {
  for (const sc of scopes) {
    await within(5000, sc.target.evaluate(stopSound, undefined), undefined).catch(() => {});
    if (!keepTags) await within(5000, sc.target.evaluate(forgetContextTags, undefined), undefined).catch(() => {});
    await within(5000, sc.target.evaluate(audioActs, { op: 'remove' }), 0).catch(() => 0);
    await within(5000, sc.target.evaluate(kitStop, undefined), undefined).catch(() => {});
  }
}

/**
 * The late pass's state (fix/late-mount, review r2), by page: the first pass's scopes and what it judged, and
 * the watch on a page that was still mounting when it started. Only for such a page.
 */
interface AudioLate { scopes: Scope[]; state: AudioState; tracker: MountTracker }
const audioLate = new WeakMap<object, AudioLate>();

export const audioProbe: PageProbe = {
  id: 'audio',
  criteria: ['1.4.2'],
  kind: 'interaction',
  tier: 'core',
  timeoutMs: 15_000,
  contextOptions: MOTION_CONTEXT,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const scopes: Scope[] = [];
    audioLate.delete(ctx.page);
    let late = false;
    try {
      const out = await runAudio(ctx, scopes);
      late = audioLate.has(ctx.page);
      return out;
    } finally {
      await cleanScopes(scopes, late);
    }
  },
  late: {
    timeoutMs: 15_000,
    async run(ctx, first) {
      const st = audioLate.get(ctx.page);
      audioLate.delete(ctx.page);
      if (!st) return [...first];
      try {
        return await lateAudio(ctx, st, first);
      } finally {
        st.tracker.stop();
        await cleanScopes(st.scopes, false);
      }
    },
  },
};

/**
 * The late pass (fix/late-mount, review r2): a page still putting its content in when the test started (an
 * app that mounts 1 to 2 s after load, `stillMounting`) is looked at again once that content is there,
 * after every other test of the page (on the motion page: after the timing test, so nothing waits in real
 * time before it). It waits at most `LATE_CONTENT_MS`, and looks only when the page went from mounting to
 * mounted (`trackMount`), for sound sources that were not judged in the first pass (by element, or by the
 * Web Audio context's own tag). The first pass's findings all stand (the runner keeps them as they were if
 * the late pass fails or times out); a control the first pass clicked never excuses a source found now.
 */
async function lateAudio(ctx: ProbeContext, st: AudioLate, first: readonly ProbeFinding[]): Promise<ProbeFinding[]> {
  const { page } = ctx;
  const wait = await st.tracker.settle(LATE_CONTENT_MS);
  st.tracker.stop();
  if (!wait.mounted) {
    ctx.setData?.({ late: { waitedMs: wait.ms, mounted: false, failed: wait.failed } });
    return [...first];
  }
  await kitReady(page);
  const findings: ProbeFinding[] = [];
  const state = st.state;
  state.acted = false;
  const heardBefore = state.heardAny;
  await addFrames(page, st.scopes, findings, state);
  // The timing test runs before this pass on the motion page and holds the page's long timers.
  for (const sc of st.scopes) state.held.set(sc, await within(2000, sc.target.evaluate(heldTimers, undefined), 0).catch(() => 0));
  const before = state.evidence.length;
  await audioPass(ctx, st.scopes, findings, state);
  ctx.setData?.({ late: { waitedMs: wait.ms, mounted: true, found: findings.length }, sources: state.evidence.slice(before, before + 20) });
  // Nothing new: the first pass's findings, as they were.
  if (!findings.length && state.heardAny === heardBefore) return [...first];
  // The first pass's "no sound" line goes once the late pass heard something.
  const kept = state.heardAny ? first.filter((f) => !(f.status === 'no_failures_found' && f.detail.startsWith(NO_SOUND))) : [...first];
  return [...kept, ...findings];
}

const NO_SOUND = 'no sound plays by itself for more than 3 s';

async function runAudio(ctx: ProbeContext, scopes: Scope[]): Promise<ProbeFinding[]> {
  const { page } = ctx;
  await requireHook(ctx);
  await kitReady(page);
  // Whether the page is still putting its content in (one look before anything is judged; never a wait):
  // then it is watched from Node (nothing is put in the page) until the late pass.
  const mounting = (await mountingNow(page)) === true;
  scopes.push({
    name: 'the page', target: page,
    click: (c, near) => clickControl(page, c, near),
  });
  const findings: ProbeFinding[] = [];
  const state: AudioState = { counts: new Map(), acted: false, heardAny: false, seen: new Map(), frames: new Set(), framesLeft: 0, held: new Map(), evidence: [] };
  await addFrames(page, scopes, findings, state);
  await audioPass(ctx, scopes, findings, state);
  if (mounting) audioLate.set(page, { scopes, state, tracker: trackMount(page) });
  ctx.setData?.({ mounting, sources: state.evidence.slice(0, 20) });
  if (state.framesLeft) findings.push({ criterion: '1.4.2', status: 'not_testable', detail: `${state.framesLeft} more embedded frame${state.framesLeft === 1 ? ' was' : 's were'} not checked (the test checks ${MAX_FRAMES} per page)` });
  if (!state.heardAny) {
    const frames = scopes.length - 1;
    let media = 0;
    let contexts = 0;
    for (const c of state.counts.values()) { media += c.media; contexts += c.contexts; }
    return [...findings, { criterion: '1.4.2', status: 'no_failures_found', detail: `${NO_SOUND} (${media} audio or video element${media === 1 ? '' : 's'} and ${contexts} Web Audio context${contexts === 1 ? '' : 's'} checked${frames ? `, ${frames} embedded frame${frames === 1 ? '' : 's'} included` : ''})` }];
  }
  return findings;
}

/** One look at every scope: sources playing now that were not judged before, each given its verdict. */
async function audioPass(ctx: ProbeContext, scopes: Scope[], findings: ProbeFinding[], state: AudioState): Promise<void> {
  const { page } = ctx;
  let anything = false;
  for (const s of scopes) {
    await s.target.evaluate(startBlockedAutoplay, undefined).catch(() => 0);
    await s.target.evaluate(startShadowAutoplay, undefined).catch(() => 0);
    await s.target.evaluate(startSound, undefined).catch(() => 0);
    await s.target.evaluate(audioActs, { op: 'install' }).catch(() => -1);
    anything ||= await s.target.evaluate(hasSoundSources, undefined).catch(() => true);
  }
  // Let started media decode and analysers fill (only when there is something to hear), listening to
  // Web Audio meanwhile so the moment its sound starts is known.
  const CLOCK = { peak: AUDIBLE_PEAK, quietGap: WEB_AUDIO_TIMING.quietGap, warmUp: WEB_AUDIO_TIMING.warmUp };
  const listen = async () => { for (const s of scopes) await s.target.evaluate(soundClock, CLOCK).catch(() => null); };
  if (anything) {
    const until = Date.now() + WEB_AUDIO_TIMING.startWindow;
    await listen();
    while (Date.now() < until) {
      await page.waitForTimeout(Math.min(WEB_AUDIO_TIMING.listen, Math.max(0, until - Date.now())));
      await listen();
    }
  }

  for (const s of scopes) {
    let found = await findSources(s).catch(() => null);
    if (!found) continue;
    const had = state.counts.get(s);
    state.counts.set(s, { media: Math.max(had?.media ?? 0, found.media), contexts: Math.max(had?.contexts ?? 0, found.contexts) });
    let seen = state.seen.get(s);
    if (!seen) state.seen.set(s, (seen = new Set()));
    const judged = seen;
    // Speech synthesis the page started by itself (G14): the test cannot hear it (it is not a media element or
    // Web Audio), so it is listed for a person to check, never failed (batch 18, ruling 9: no new code verdict).
    if (found.speech.length && !seen.has('speech')) {
      seen.add('speech');
      state.heardAny = true;
      const chars = found.speech.reduce((a, u) => a + u.chars, 0);
      if (state.evidence.length < 40) state.evidence.push({ scope: s.name, kind: 'speech', what: 'text spoken with speech synthesis', lastsMs: null, heard: null });
      findings.push({ criterion: '1.4.2', status: 'not_testable', detail: `the page${s.target === page ? '' : ` (${s.name})`} speaks text aloud by itself with speech synthesis (${found.speech.length === 1 ? 'one passage' : `${found.speech.length} passages`}, ${chars} characters): the test does not hear speech synthesis, so how long it speaks and whether something stops it could not be told` });
    }
    const fresh = (x: SoundSource) => !judged.has(x.key);
    // A video whose audio is not known yet gets more looks, while the time box allows.
    while (found.sources.some((x) => fresh(x) && x.heard === null) && hasTime(ctx, 4000)) {
      await page.waitForTimeout(500);
      found = (await findSources(s).catch(() => null)) ?? found;
    }
    for (const x of found.sources.filter((y) => fresh(y) && y.heard === null)) {
      seen.add(x.key);
      findings.push({ criterion: '1.4.2', status: 'not_testable', ...(x.el && s.target === page ? { target: x.el.path } : {}), detail: x.unmeasured
        ? `${x.what} plays${x.byInput ? '' : ' by itself'}, not muted, but its sound could not be listened to (for example a file on another site that does not allow reading it), so whether it makes sound could not be told`
        : `${x.what} plays${x.byInput ? '' : ' by itself'}, not muted, but whether it has sound could not be told (no sound was heard from it in the time the test listened)` });
    }
    if (found.sources.some((x) => x.heard === null)) state.heardAny = true;
    // A sound a click, press or key started does not play by itself (an earlier test's press, or the page's own
    // click at load): not judged as automatic, never "no sound".
    for (const x of found.sources.filter((y) => fresh(y) && y.heard === true && y.byInput)) {
      seen.add(x.key);
      state.heardAny = true;
      findings.push({ criterion: '1.4.2', status: 'not_testable', ...(x.el && s.target === page ? { target: x.el.path } : {}), detail: `${x.what}${s.target === page ? '' : ` in ${s.name}`} makes sound, but it started when something on the page was pressed (by a test, or by the page's own code), so whether it plays by itself could not be told` });
    }
    let sources = found.sources.filter((x) => fresh(x) && x.heard === true && !x.byInput);
    // Web Audio has no known end: it is counted once it is heard 3 s and a margin after its sound
    // started (when its source was scheduled to start, or when it was first heard: never the page load or
    // the context's start), listened to every 250 ms. A rest shorter than the quiet gap does not drop it
    // (a bed with a pause); a longer silence does (a short chime that ends earlier is not counted).
    if (sources.some((x) => x.kind === 'webaudio')) {
      const open = new Set(sources.filter((x) => x.kind === 'webaudio').map((x) => x.key));
      const keys = new Set<string>();
      const unknown = new Set<string>();
      while (open.size) {
        const c = await s.target.evaluate(soundClock, CLOCK).catch(() => null);
        if (!c) { for (const k of open) unknown.add(k); break; } // could not listen: no verdict, never "still sounding"
        for (const k of [...open]) {
          const st = c.clock[k];
          if (!st || st.startAt == null) open.delete(k);
          else if (webAudioCounted(st)) { keys.add(k); open.delete(k); }
        }
        if (!open.size) break;
        // The time box ended before these could be heard for 3 s: no verdict, never counted as longer.
        if (!hasTime(ctx, 4000)) { for (const k of open) unknown.add(k); break; }
        const next = Math.min(...[...open].map((k) => webAudioDeadline(c.clock[k]!.startAt!) - c.now));
        await page.waitForTimeout(Math.max(50, Math.min(250, next)));
      }
      for (const k of unknown) seen.add(k);
      for (const k of unknown) findings.push({ criterion: '1.4.2', status: 'not_testable', detail: 'sound made with Web Audio could not be measured to the end of its first 3 s' });
      sources = sources.filter((x) => x.kind !== 'webaudio' || keys.has(x.key));
    }
    if (sources.length) state.heardAny = true;
    for (const x of sources) seen.add(x.key);
    for (const src of sources.slice(0, 4)) {
      const where = s.target === page ? '' : ` in ${s.name}`;
      const desc = `${src.what}${where} plays sound by itself ${lasting(src.lastsMs)}`;
      // A path inside a frame would read as a path in the page: frames are named in the text instead.
      const target = s.target === page ? src.el?.path : undefined;
      const ev: AudioEvidence = {
        scope: s.name, kind: src.kind, what: src.what, ...(target ? { target } : {}), lastsMs: src.lastsMs, heard: src.heard,
        ...(src.feeds ? { feeds: src.feeds } : {}), ...(src.nativeControls ? { nativeControls: true } : {}),
      };
      if (state.evidence.length < 40) state.evidence.push(ev);
      if (src.nativeControls) {
        findings.push({ criterion: '1.4.2', status: 'no_failures_found', ...(target ? { target } : {}), detail: `${desc}: its own player controls can pause it or turn it down` });
        continue;
      }
      const near = elId(src.key) ?? (src.el ? src.el.id : null);
      const held = state.held.get(s) ?? 0;
      // The controls that could stop it: the candidates (one more than are tried, to know whether more are left),
      // and the others that could be the way to stop it (never clicked). A failure needs none of them left.
      const cands: Candidates = await s.target.evaluate(controlsFor, { id: near, words: AUDIO_VOCAB, max: AUDIO_TRIES + 1, toggles: SOUND_TOGGLES }).catch(() => ({ controls: [], refused: [] }));
      const more = cands.controls.length > AUDIO_TRIES;
      const others = await within(3000, s.target.evaluate(otherControls, { id: near, skip: cands.controls.map((c) => c.id), max: 5 }), null).catch(() => null);
      if (others === null) {
        // The look for other controls failed: nothing can be said about them.
        findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: the page's controls could not be read, so whether something stops it could not be told` });
        continue;
      }
      ev.others = others;
      if (more) ev.more = true;
      if (held) ev.held = held;
      /** Why a failure cannot be shown, or null; `untried` are candidates never clicked (it ended first). */
      const doubt = (untried: readonly string[]) => unprovenReason({ others: [...untried.map((n) => ({ name: n, why: 'a control that may stop it, not tried before the sound ended' })), ...others], more, held });
      const stateNow = await stateOf(s, src.key);
      if (stateNow === null) {
        findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: whether it is still playing could not be read` });
        continue;
      }
      if (stateNow !== 'playing') {
        // Web Audio heard for more than 3 s, or media that played to its end (it is longer than 3 s),
        // ran its 3 s by itself: stopping later does not pass it, unless a way to stop it is there to be found
        // (a control it ended before, or one left). Media the page paused may have played less: no failure found.
        if (!state.acted && (src.kind === 'webaudio' || stateNow === 'ended')) {
          const why = doubt(cands.controls.slice(0, AUDIO_TRIES).map((c) => c.name ?? c.path));
          findings.push(why
            ? { criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}; it played for more than 3 s by itself and then stopped before any control was tried, but ${why}` }
            : { criterion: '1.4.2', status: 'failed', ...(target ? { target } : {}), detail: `${desc}; it played for more than 3 s by itself and then stopped before any control was tried, and the page has no control that could pause, stop or mute it` });
          continue;
        }
        findings.push({ criterion: '1.4.2', status: 'no_failures_found', ...(target ? { target } : {}), detail: `${desc}: ${state.acted ? 'it stopped after a control tried earlier' : 'it was no longer playing when the test came back to it, before any control was tried'}` });
        continue;
      }
      if (!hasTime(ctx, 3000)) {
        findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: the time for this test ran out before a control could be tried` });
        continue;
      }
      const mark = ctx.guard.mark();
      const tried: string[] = [];
      let worked: string | null = null;
      let outOfTime = false;
      let unreadable = false;
      /** It went quiet while a control was tried, and not because of it (it ended on its own). */
      let endedDuring: string | null = null;
      /** It went quiet after a control, but the click's own calls could not be counted: cannot be told. */
      let unclear: string | null = null;
      const tryList = cands.controls.slice(0, AUDIO_TRIES);
      let next = 0;
      for (const c of tryList) {
        if (!hasTime(ctx, 2000)) { outOfTime = true; break; }
        next++;
        tried.push(c.name ?? c.path);
        const a0 = await acts(s);
        if (!(await s.click(c, near ?? undefined))) continue;
        state.acted = true;
        await page.waitForTimeout(300);
        if (await settledStop(ctx, mark)) break;
        const st = await stateOf(s, src.key);
        if (st === null) { unreadable = true; break; }
        const a1 = await acts(s);
        const effect = controlEffect({ state: st, clickActs: a0 < 0 || a1 < 0 ? null : a1 - a0 });
        if (effect === 'worked') { worked = c.name ?? c.path; break; }
        if (effect === 'ended') { endedDuring = c.name ?? c.path; break; }
        if (effect === 'unknown') { unclear = c.name ?? c.path; break; }
      }
      ev.tried = tried;
      if (worked) ev.worked = worked;
      const stopped = await settledStop(ctx, mark);
      const triedText = tried.length ? `controls tried, without effect: ${tried.map((t) => `"${t.slice(0, 40)}"`).join(', ')}` : 'no pause, stop, mute or volume control was found';
      const notTried = refusedText(cands.refused);
      // Candidates never clicked because the sound ended first (endedDuring) are still ways to stop it.
      const why = worked ? null : doubt(endedDuring ? tryList.slice(next).map((c) => c.name ?? c.path) : []);
      if (stopped) findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: ${stopped} (${triedText})` });
      else if (worked) findings.push({ criterion: '1.4.2', status: 'no_failures_found', ...(target ? { target } : {}), detail: `${desc}: the control "${worked}" stops it` });
      else if (unclear) findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: it went quiet after "${unclear.slice(0, 40)}" was clicked, but what that click did could not be read, so whether it stopped the sound could not be told (${triedText})` });
      else if (unreadable) findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: whether a control stopped it could not be read (${triedText})` });
      else if (notTried) findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: ${notTried} (${triedText})` });
      else if (outOfTime) findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}: the time for this test ran out before every control could be tried (${triedText})` });
      else if (why) findings.push({ criterion: '1.4.2', status: 'not_testable', ...(target ? { target } : {}), detail: `${desc}${endedDuring ? `; it stopped on its own while "${endedDuring.slice(0, 40)}" was tried (not because of it)` : ''}, but ${why} (${triedText})` });
      else if (endedDuring) findings.push({ criterion: '1.4.2', status: 'failed', ...(target ? { target } : {}), detail: `${desc}; it stopped on its own while "${endedDuring.slice(0, 40)}" was tried (not because of it), and no control was shown to pause, stop or mute it (${triedText})` });
      else findings.push({ criterion: '1.4.2', status: 'failed', ...(target ? { target } : {}), detail: `${desc}; nothing on the page pauses, stops or mutes it (${triedText})` });
    }
    if (sources.length > 4) findings.push({ criterion: '1.4.2', status: 'not_testable', detail: `${sources.length - 4} more sound sources were not tried (the test tries 4 per page)` });
  }
}
