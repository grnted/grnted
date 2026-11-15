// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Holds a page still while a pixel test looks at it, and lets it go again afterwards (the text
// contrast probe): background videos are paused on a fixed frame, CSS and Web Animations
// are paused on a fixed frame, transitions jump to their end, and the page's timers of 1 s or more
// (carousels, slideshows) are held by the listener hook (`__grntedFreeze`). Everything is undone by
// `thaw`, so the next probe on the page finds it playing as before. Nothing here sends a request:
// seeking a video only reads the file the page already loads. Engine core: no Node-only imports.
//
// One hold per window: every call of a hold (`freezePage`'s token) shares one in-page state, so a
// call that answers late (after its time limit) only settles animations, and once the hold's thaw
// has run in a window, a call of that hold arriving after it does nothing. `thaw` reports whether
// every document confirmed it: when one did not, the probe tells the runner not to reuse the page.
import type { FrameLike, PageLike } from '../types.js';

/** The in-page store of what was paused (on each frame's window). */
export const FREEZE_KEY = '__grntedFrozen';

/** What a frame call gets: the store's key and the hold's token. */
export interface FreezeArg {
  key: string;
  token: string;
}

/** What `freezeFrame` did in one document. */
export interface FrozenFrame {
  /** Videos paused (and seeking to their first frame). */
  media: number;
  /** Animations paused. */
  animations: number;
  /** The listener hook held the page's long timers. */
  timers: boolean;
}

/**
 * Runs in a frame (self-contained). Pauses the document: every playing (or autoplaying) video is
 * paused and, when it had started, sought to its first frame; every running
 * animation is paused at a fixed point (`settleAnimations`); a style sheet turns transitions off
 * (a transition under way jumps to its end); and the listener hook holds timers of 1 s or more.
 * Open shadow roots are included. Re-entrant: while the window is held, a call (of any hold) only
 * settles new animations. A call of a hold whose thaw already ran in this window does nothing (it
 * arrived late), so it can never hold the page again after the thaw.
 */
export function freezeFrame(arg: FreezeArg): FrozenFrame {
  const w = window as unknown as Record<string, unknown>;
  type Media = { el: HTMLMediaElement; t: number; resume: boolean };
  type Anim = { a: Animation; t: number | null };
  type State = { media: Media[]; anims: Anim[]; sheets: [Document | ShadowRoot, CSSStyleSheet][]; seen: WeakSet<Animation>; held: boolean };
  const thawed = w[`${arg.key}Thawed`];
  if (Array.isArray(thawed) && thawed.includes(arg.token)) return { media: 0, animations: 0, timers: false };
  let state = w[arg.key] as State | undefined;
  const fresh = !state;
  if (!state) {
    state = { media: [], anims: [], sheets: [], seen: new WeakSet(), held: false };
    try {
      Object.defineProperty(window, arg.key, { value: state, configurable: true, enumerable: false, writable: true });
    } catch {
      w[arg.key] = state;
    }
  }
  const roots: (Document | ShadowRoot)[] = [document];
  if (fresh) {
    // Open shadow roots (at most a few hundred elements are looked at for them).
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && roots.length < 200; i++) {
      const sr = (all[i] as Element).shadowRoot;
      if (sr) roots.push(sr);
    }
    for (const root of roots) {
      for (const el of root.querySelectorAll('video')) {
        const m = el as HTMLMediaElement;
        const playing = !m.paused;
        // An autoplaying element that has not started yet would start while the test looks.
        if (!playing && !m.autoplay) continue;
        // Only a video that was playing is played again: a paused autoplay video may be one the page
        // stopped itself (a reduced-motion check), and the thaw must not start what the page held.
        const rec: Media = { el: m, t: m.currentTime, resume: playing };
        try {
          m.pause();
          // A fixed frame: the first one (a video that never played still shows its poster).
          if (m.played.length > 0 || m.currentTime > 0) m.currentTime = 0;
        } catch {
          // keep what it shows
        }
        state.media.push(rec);
      }
      if (!('adoptedStyleSheets' in root)) continue;
      try {
        const win = (document.defaultView ?? window) as Window & typeof globalThis;
        const sheet = new win.CSSStyleSheet();
        // Over the page's own `!important` transitions too: `:is()` takes the specificity of ids no element has.
        const all = ':is(*, #grnted-freeze-none#grnted-freeze-none#grnted-freeze-none#grnted-freeze-none#grnted-freeze-none)';
        sheet.replaceSync(`${all}, ${all}::before, ${all}::after { transition-duration: 0s !important; transition-delay: 0s !important; }`);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        state.sheets.push([root, sheet]);
      } catch {
        // a root that cannot adopt it keeps its transitions (a moving area stays unmeasured)
      }
    }
    const hold = (window as unknown as { __grntedFreeze?: (on: boolean) => number }).__grntedFreeze;
    if (typeof hold === 'function') {
      try {
        hold(true);
        state.held = true;
      } catch {
        // not held
      }
    }
  }
  // Animations: running ones are paused at a fixed point, so every run sees the same frame. A finite
  // one (a fade-in, a slide moving in) is shown just before its end, as it will stay; an endless
  // one (a slideshow in CSS, a slow zoom on a photo) at its start.
  let paused = 0;
  const list = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  for (const a of list) {
    if (state.seen.has(a) || a.playState !== 'running') continue;
    state.seen.add(a);
    try {
      const timing = a.effect?.getComputedTiming();
      const delay = Number(timing?.delay) || 0;
      const active = Number(timing?.activeDuration);
      const t = Number.isFinite(active) ? Math.max(0, delay + active - 1) : Math.max(0, delay);
      state.anims.push({ a, t: a.currentTime === null ? null : Number(a.currentTime) });
      a.pause();
      a.currentTime = t;
      paused++;
    } catch {
      // left running: a moving area stays unmeasured
    }
  }
  const hooked = typeof (window as unknown as { __grntedFreeze?: unknown }).__grntedFreeze === 'function';
  return { media: fresh ? state.media.length : 0, animations: paused, timers: hooked };
}

/** Runs in a frame (self-contained): the videos `freezeFrame` paused have their frame shown (not still seeking). */
export function frozenMediaReady(arg: FreezeArg): boolean {
  const state = (window as unknown as Record<string, { media: { el: HTMLMediaElement }[] } | undefined>)[arg.key];
  if (!state) return true;
  return state.media.every(({ el }) => !el.isConnected || !el.seeking);
}

/**
 * Runs in a frame (self-contained). Undoes every `freezeFrame` call in this window: animations go
 * back to where they were and run again, videos go back to their time and play again when they were
 * playing (or autoplaying), the style sheets go, and the hook runs the timeouts it held. First it
 * records the hold's token, so a call of the hold that arrives later does nothing. Returns true.
 */
export function thawFrame(arg: FreezeArg): boolean {
  const w = window as unknown as Record<string, unknown>;
  const doneKey = `${arg.key}Thawed`;
  const done = Array.isArray(w[doneKey]) ? (w[doneKey] as string[]) : [];
  if (!done.includes(arg.token)) done.push(arg.token);
  if (done.length > 50) done.splice(0, done.length - 50);
  try {
    Object.defineProperty(window, doneKey, { value: done, configurable: true, enumerable: false, writable: true });
  } catch {
    w[doneKey] = done;
  }
  const state = w[arg.key] as {
    media: { el: HTMLMediaElement; t: number; resume: boolean }[];
    anims: { a: Animation; t: number | null }[];
    sheets: [Document | ShadowRoot, CSSStyleSheet][];
    held?: boolean;
  } | undefined;
  if (!state) return true;
  try {
    delete w[arg.key];
  } catch {
    w[arg.key] = undefined;
  }
  for (const [root, sheet] of state.sheets) {
    try {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    } catch {
      // gone
    }
  }
  for (const { a, t } of state.anims) {
    try {
      if (t !== null) a.currentTime = t;
      a.play();
    } catch {
      // gone
    }
  }
  for (const { el, t, resume } of state.media) {
    try {
      if (Math.abs(el.currentTime - t) > 0.01) el.currentTime = t;
      if (resume) void el.play().catch(() => {});
    } catch {
      // gone
    }
  }
  const hold = (window as unknown as { __grntedFreeze?: (on: boolean) => number }).__grntedFreeze;
  if (state.held && typeof hold === 'function') {
    try {
      hold(false);
    } catch {
      // released anyway when the page is loaded again
    }
  }
  return true;
}

/** Longest wait for one frame's answer, and for paused videos to show their first frame. */
const FRAME_CALL_MS = 2000;
const SEEK_WAIT_MS = 1500;

/** At most this many frames (the main one first) are held. */
export const MAX_FROZEN_FRAMES = 12;

/** A frame's call with a time limit: a frame that does not answer is left as it is. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** A call that failed because its document is gone (the frame navigated or was removed): nothing of the hold is left there. */
function documentGone(err: unknown): boolean {
  return /detached|context was destroyed|navigat|target (page, context or browser )?(has been )?closed/i.test(String((err as Error)?.message ?? err));
}

/** The page's documents: every frame when the browser lists them (main first), else the main one. */
function documents(page: PageLike): (PageLike | FrameLike)[] {
  let frames: FrameLike[] = [];
  try {
    frames = page.frames?.() ?? [];
  } catch {
    frames = [];
  }
  if (!frames.length) return [page];
  const main = frames.filter((f) => !f.parentFrame());
  const rest = frames.filter((f) => f.parentFrame());
  return [...(main.length ? main : [page]), ...rest].slice(0, MAX_FROZEN_FRAMES);
}

export interface FrozenPage {
  /** What was held, summed over the page's documents. */
  held: FrozenFrame;
  /** Pauses animations that started since (after scrolling, or at another viewport width). */
  settle(): Promise<void>;
  /**
   * Undoes everything every call of the hold did, in every document (once; later calls get the same
   * answer). Never throws. Resolves true when it is confirmed: each document answered the thaw (or
   * is gone), and no freeze call is still unanswered. False means the page may still be held: the
   * caller must not let it be reused (`ProbeContext.discardPage`).
   */
  thaw(): Promise<boolean>;
}

/**
 * Holds the page still (`freezeFrame` in each of its documents) and waits, briefly, for paused videos
 * to show their first frame. Never throws (a page that cannot wait keeps what is held until `thaw`).
 * Call `thaw` when done, also after a failure, and act on its answer.
 */
export async function freezePage(page: PageLike): Promise<FrozenPage> {
  const docs = documents(page);
  const token = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  const arg: FreezeArg = { key: FREEZE_KEY, token };
  const held: FrozenFrame = { media: 0, animations: 0, timers: false };
  /** Freeze calls sent and not answered yet (a time limit does not stop the call in the page). */
  const out = new Set<Promise<unknown>>();
  const freezeCall = (d: PageLike | FrameLike): Promise<FrozenFrame | null> => {
    let p: Promise<FrozenFrame>;
    try {
      p = d.evaluate(freezeFrame, arg);
    } catch (err) {
      p = Promise.reject(err);
    }
    out.add(p);
    const settled = () => {
      out.delete(p);
    };
    p.then(settled, settled);
    return within<FrozenFrame | null>(p, FRAME_CALL_MS, null);
  };
  try {
    // All at once (a frame that does not answer costs FRAME_CALL_MS once); each is thawed, even one that answers late.
    const answers = await Promise.all(docs.map(freezeCall));
    answers.forEach((r, i) => {
      if (!r) return;
      held.media += r.media;
      held.animations += r.animations;
      if (i === 0) held.timers = r.timers;
    });
    if (held.media) {
      const until = Date.now() + SEEK_WAIT_MS;
      while (Date.now() < until) {
        const ready = await Promise.all(docs.map((d) => within(d.evaluate(frozenMediaReady, arg), 500, true)));
        if (ready.every(Boolean)) break;
        await page.waitForTimeout(50);
      }
      // The decoded frame reaches the screen on the next paint.
      await page.waitForTimeout(100);
    }
  } catch {
    // The page could not wait (closed, say): what is held stays held until `thaw`.
  }
  let thawing: Promise<boolean> | undefined;
  return {
    held,
    async settle() {
      await freezeCall(page);
    },
    thaw() {
      thawing ??= (async () => {
        const answered = await Promise.all(docs.map(async (d) => {
          let p: Promise<boolean>;
          try {
            p = d.evaluate(thawFrame, arg);
          } catch (err) {
            p = Promise.reject(err);
          }
          const gone = Symbol('gone');
          const r = await within<boolean | typeof gone | null>(p.catch((err) => (documentGone(err) ? gone : null)), FRAME_CALL_MS, null);
          return r === true || r === gone;
        }));
        return answered.every(Boolean) && out.size === 0;
      })();
      return thawing;
    },
  };
}
