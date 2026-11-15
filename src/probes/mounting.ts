// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Content a page mounts late (an app that hydrates 1 to 2 s after load; lab and gold hazard `late-mount`):
// how a test tells that a page is still putting its main content in, and a bounded wait for it. Engine core:
// no Node-only imports.
//
// Two ways a test uses it (docs/scoring.md, v9 note of 2026-11-07, fix/late-mount):
// - a wait BEFORE it starts (`PageProbe.waitFor.content`), for tests that misread an empty shell (headings,
//   hover, gestures, text spacing, reflow);
// - a LATE PASS (`PageProbe.late`: audio, motion, device motion; axe's second run in audit.ts), for tests
//   that must never wait first: a short sound, motion or trap right after load is real, and the first pass
//   judges it as it is. On the motion page the late passes run after the timing test (nothing waits in real
//   time before it). A late pass looks again only when the page went from mounting to mounted
//   (`MountResult.mounted`): a signal that never clears, a page that stops answering or closes, never.
// The watch only decides WHEN a late pass looks: it never times anything a test judges (review r4: motion's
// "more than 5 s" comes from motion's own observations of the same element, never from when the page mounted).
// Every elapsed time here is on the monotonic clock (`performance.now()`, a global in Node and Workers): a
// wall-clock correction (`Date.now()` jumping) is never counted as time the page was watched.
import type { PageLike } from '../types.js';

/**
 * Longest wait for a page whose content is still mounting (`stillMounting`): an app that hydrates late
 * (1 to 2 s after load is common) is tested with its content, never as an empty shell.
 */
export const LATE_CONTENT_MS = 3000;
/**
 * The content counts as mounted once consecutive completed looks have found the page not mounting over at
 * least this long (an app that clears its busy state for a moment while it hydrates, then shows "Loading…"
 * again, is still mounting; a flicker shorter than the gap between two looks is not seen: an accepted limit).
 */
export const MOUNT_HOLD_MS = 500;
/** Longest wait for one look at the page: one that does not answer in time ends the wait as not mounted. */
export const MOUNT_LOOK_MS = 1500;
/** How often the page is looked at while it mounts. */
const POLL_MS = 150;

/**
 * Runs in the page: true while its PRIMARY placeholder says it is still putting its main content in
 * (reviews r1 and r2 of fix/late-mount: only the page's own placeholder counts, never a widget):
 * - `aria-busy="true"` on the body, the first main landmark or the app root (`#root`, `#app`, `#__next`,
 *   `#__nuxt`, or the ONLY element child of the body or of that main), not a live region or status widget;
 * - no real content at all: no really visible text, picture, media, frame or control outside the page chrome
 *   (header, navigation, footer, complementary regions). Really visible: a box of non-zero size, and neither
 *   it nor any ancestor has `visibility: hidden`, `opacity: 0` or `display: none` (a skeleton with hidden
 *   template text, or a transparent picture, is still empty);
 * - a placeholder that says only "Loading…" or "Please wait", really shown (as above, not aria-hidden, at
 *   least 8×8 px, at least partly on screen, not in a live region or status widget), on a page whose other
 *   visible text outside the chrome is short (under 280 characters).
 * Self-contained (it is passed to `page.evaluate`); reads only, changes nothing.
 */
export function stillMounting(): boolean {
  const body = document.body;
  if (!body) return true;
  const CHROME = 'header, nav, footer, aside, [role="banner"], [role="navigation"], [role="contentinfo"], [role="complementary"]';
  const MEDIA = 'img, svg, picture, video, audio, canvas, iframe, object, embed, input, button, select, textarea';
  const WIDGET = '[aria-live], [role="status"], [role="log"], [role="alert"], [role="progressbar"], [role="marquee"], [role="timer"]';
  const main = document.querySelector('main, [role="main"]');
  const busy = (el: Element | null) => !!el && el.getAttribute('aria-busy') === 'true' && !el.matches(WIDGET);
  if (busy(body) || busy(main)) return true;
  const roots = new Set<Element>();
  for (const sel of ['#root', '#app', '#__next', '#__nuxt']) { const r = document.querySelector(sel); if (r) roots.add(r); }
  for (const parent of [body, main]) if (parent && parent.children.length === 1) roots.add(parent.children[0]!);
  for (const r of roots) if (busy(r)) return true;
  // Visible: neither it nor an ancestor hidden, transparent or not displayed (cached per element).
  const seen = new Map<Element, boolean>();
  const visible = (el: Element): boolean => {
    const known = seen.get(el);
    if (known !== undefined) return known;
    const st = getComputedStyle(el);
    const own = st.display !== 'none' && st.visibility !== 'hidden' && st.visibility !== 'collapse' && Number(st.opacity) !== 0;
    const v = own && (!el.parentElement || visible(el.parentElement));
    seen.set(el, v);
    return v;
  };
  const sized = (el: Element, min: number) => { const r = el.getBoundingClientRect(); return r.width >= min && r.height >= min; };
  /** Shown to a sighted person: visible, not aria-hidden, at least 8×8, at least partly on screen. */
  const shown = (el: Element) => {
    if (el.closest('[aria-hidden="true"]') || !visible(el) || !sized(el, 8)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  // The page's visible text outside its chrome (counted up to 600 characters, at most 2000 text nodes), its
  // placeholders (an element whose whole text is a loading word, outside live regions and status widgets),
  // and whether it has a visible picture, media or control there.
  const inChrome = (el: Element) => !!el.closest(CHROME);
  const loading = /^(loading|please wait)(\s*(\.{1,3}|…))?$/i;
  const placeholders: { el: Element; len: number }[] = [];
  let realText = 0;
  const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walk.nextNode(); t && n < 2000 && realText < 600; t = walk.nextNode(), n++) {
    const v = (t.nodeValue ?? '').trim();
    const el = t.parentElement;
    if (!v || !el || el.closest('script, style, template, noscript') || inChrome(el) || !sized(el, 1) || !visible(el)) continue;
    realText += v.length;
    if (v.length <= 16 && loading.test(v) && (el.textContent ?? '').trim() === v && !el.closest(WIDGET)) placeholders.push({ el, len: v.length });
  }
  const realMedia = [...body.querySelectorAll(MEDIA)].some((m) => !inChrome(m) && sized(m, 8) && visible(m));
  if (!realText && !realMedia) return true;
  // A shown placeholder on a page with little else.
  for (const p of placeholders) if (realText - p.len < 280 && shown(p.el)) return true;
  return false;
}

/**
 * One look: true while the page is still mounting, false once it is not; null when it could not be told (the
 * page threw, closed or did not answer within `MOUNT_LOOK_MS`).
 */
export async function mountingNow(page: PageLike): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      page.evaluate(stillMounting, undefined),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), MOUNT_LOOK_MS); }),
    ]);
    return typeof answer === 'boolean' ? answer : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The end of a wait for the page's content. `mounted`: the page went from mounting to mounted, and completed
 * looks have found it mounted with answers at least `MOUNT_HOLD_MS` apart (monotonic clock) and no look
 * still pending (only then does a test take a second look); `failed`: a look could not be made (the wait
 * ended there, as not mounted); `ms`: how long the wait took. There is deliberately no "mounted since": the
 * watch schedules a late look and never feeds a duration (review r4).
 */
export interface MountResult {
  mounted: boolean;
  failed: boolean;
  ms: number;
}

/**
 * Watches a page that was still mounting when a test started (looks every `POLL_MS`, from Node: nothing is
 * left in the page), across the tests that share the page, until `stop()`. `settle(maxMs)` then waits at
 * most `maxMs` more for the page to be mounted (`MountResult`). It never throws; it stops by itself at its
 * first failed look, and its own deadline (`maxLifeMs`) bounds it if `stop()` is never called.
 */
export interface MountTracker {
  settle(maxMs: number): Promise<MountResult>;
  stop(): void;
}

/** Elapsed time, monotonic (never `Date.now()`, which a clock correction can move either way). */
const now = () => performance.now();

export function trackMount(page: PageLike, maxLifeMs = 120_000): MountTracker {
  const t0 = now();
  let stopped = false;
  let failed = false;
  /** A look has started and not completed: nothing is certified while it is out. */
  let pending = false;
  /** When the first completed not-mounting look of the current run answered, and when its last one answered. */
  let first: number | null = null;
  let last: number | null = null;
  const waiter: { wake: (() => void) | null } = { wake: null };
  const loop = (async () => {
    while (!stopped && now() - t0 < maxLifeMs) {
      pending = true;
      const look = await mountingNow(page);
      // Each look is timed by when it ANSWERED (review r3: a slow look asked at 0 and answered at 1.4 s
      // says nothing about the page before 1.4 s).
      const answered = now();
      pending = false;
      if (look === null) { failed = true; break; }
      if (look) { first = null; last = null; } else { first ??= answered; last = answered; }
      waiter.wake?.();
      if (stopped) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    stopped = true;
    pending = false;
    waiter.wake?.();
  })();
  void loop;
  const held = () => !pending && !failed && first !== null && last !== null && last - first >= MOUNT_HOLD_MS;
  return {
    async settle(maxMs) {
      const s0 = now();
      const end = s0 + maxMs;
      while (!failed && !held() && !stopped && now() < end) {
        await new Promise<void>((r) => {
          const timer = setTimeout(r, Math.max(1, Math.min(POLL_MS, end - now())));
          waiter.wake = () => { clearTimeout(timer); r(); };
        });
        waiter.wake = null;
      }
      return { mounted: held(), failed, ms: Math.round(now() - s0) };
    },
    stop() {
      stopped = true;
      waiter.wake?.();
    },
  };
}

/** Documents whose full content wait ran out, keyed by the page and the runner's document identity. */
const timedOut = new WeakMap<PageLike, unknown>();

/**
 * The wait before a test (`PageProbe.waitFor.content`): when the page is still mounting, at most `maxMs` for
 * it to be mounted (`trackMount`). Never throws; leaves nothing in the page. A page that was not mounting
 * answers at once (`mounted: true`); one whose look fails ends the wait at once (`failed`). A document
 * whose wait timed out is never waited for again; a new document at the same address gets a fresh wait.
 */
export async function waitForMount(page: PageLike, maxMs: number, document: unknown): Promise<MountResult & { waited: boolean }> {
  if (timedOut.has(page) && timedOut.get(page) === document) return { mounted: false, failed: false, ms: 0, waited: false };
  const t0 = now();
  const firstLook = await mountingNow(page);
  if (firstLook === null) return { mounted: false, failed: true, ms: Math.round(now() - t0), waited: false };
  if (!firstLook) return { mounted: true, failed: false, ms: Math.round(now() - t0), waited: false };
  const tracker = trackMount(page);
  try {
    const r = await tracker.settle(Math.max(0, maxMs - (now() - t0)));
    if (!r.mounted && !r.failed) timedOut.set(page, document);
    return { ...r, ms: Math.round(now() - t0), waited: true };
  } finally {
    tracker.stop();
  }
}
