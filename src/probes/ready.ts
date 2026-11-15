// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// When a page shows its content (late-mounting apps): one readiness test shared by the runner's wait before the
// tests that ask for it (`PageProbe.waitFor.content`) and by the tests that reload a page themselves (key shortcuts).
// Engine core: no Node-only imports.
import type { PageLike } from '../types.js';

/** Longest extra wait for a page whose main content is not shown yet. */
export const LATE_CONTENT_MS = 3000;

/** The window property a document carries once a whole wait ran out on it: later waits on it return at once. */
export const BUSY_GAVE_UP = '__grntedBusyGaveUp';

/**
 * Runs in the page (self-contained): true when its main content is shown: the main landmark (`main` or
 * `[role="main"]`, else the body) has text or a picture, media, frame or control in it, and neither it, the body,
 * nor any shown part of it is marked aria-busy="true" (an app shell's "Loading…" root, a section still mounting;
 * hidden nodes do not count). A document a whole wait already ran out on counts as shown (`BUSY_GAVE_UP`).
 */
export function contentShown(): boolean {
  if ((window as unknown as Record<string, unknown>)['__grntedBusyGaveUp'] === true) return true;
  const body = document.body;
  if (!body) return false;
  const main = document.querySelector('main, [role="main"]') ?? body;
  if (main.getAttribute('aria-busy') === 'true' || body.getAttribute('aria-busy') === 'true') return false;
  const busy = main.querySelectorAll('[aria-busy="true"]');
  for (let i = 0; i < busy.length && i < 20; i++) {
    const el = busy[i] as Element & { checkVisibility?: () => boolean };
    if (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0) return false;
  }
  if ((main.textContent ?? '').trim()) return true;
  return !!main.querySelector('img, svg, picture, video, audio, canvas, iframe, object, embed, input, button, select, textarea');
}

/** Runs in the page: marks the document a whole wait ran out on (`BUSY_GAVE_UP`), so later waits on it skip. */
export function markBusyGaveUp(): void {
  (window as unknown as Record<string, unknown>)['__grntedBusyGaveUp'] = true;
}

/**
 * Pages whose wait ran out, with the address they showed then: a later wait on the same document returns at once,
 * even when the page is too slow to answer the in-page mark (Sol round 3). The runner and the tests that load or reload a
 * page forget it (`forgetBusy`), so a new document is waited for again.
 */
const busyMemo = new WeakMap<object, string>();

/** A new document was loaded into `page` (a load or reload by the test): its next wait is a fresh one. */
export function forgetBusy(page: object): void {
  busyMemo.delete(page);
}

/**
 * Waits until the page shows its main content (`contentShown`), polling every 100 ms. One deadline, `maxMs` from the
 * call, bounds the whole wait (Sol round 2): every readiness check gets only the time left before `MARK_RESERVE_MS`. A
 * check that does not answer within a full `callMs` counts as shown (a page that does not answer is not held up); one
 * cut short by the deadline does not. When the deadline is reached the document is marked (in the page, and here for a
 * page too slow to answer) and the result is 'timeout', never 'shown' (Sol round 3). Returns 'shown', 'timeout' or
 * 'interrupted' (a call failed while waiting: the page closed or went to another document; the caller checks which).
 * Never throws.
 */
export async function waitForContent(page: PageLike, maxMs: number, callMs: number, signal?: AbortSignal): Promise<'shown' | 'timeout' | 'interrupted'> {
  const end = Date.now() + maxMs;
  const left = () => end - Date.now();
  const at = (() => { try { return page.url?.() ?? ''; } catch { return ''; } })();
  if (busyMemo.has(page) && busyMemo.get(page) === at) return 'timeout';
  const CUT = Symbol('cut');
  const bounded = <T>(p: Promise<T>, ms: number): Promise<T | typeof CUT> => Promise.race([p, new Promise<typeof CUT>((r) => setTimeout(() => r(CUT), Math.max(0, ms)))]);
  try {
    for (;;) {
      if (signal?.aborted) break;
      const budget = Math.min(callMs, left() - MARK_RESERVE_MS);
      if (budget <= 0) break;
      const r = await bounded(page.evaluate(contentShown, undefined), budget);
      if (r === CUT) {
        if (budget < callMs) break; // the deadline cut it short: not an unresponsive page
        return 'shown';
      }
      if (r !== false) return 'shown';
      const pause = Math.min(100, left() - MARK_RESERVE_MS);
      if (pause <= 0) break;
      await page.waitForTimeout(pause);
    }
  } catch {
    return 'interrupted';
  }
  busyMemo.set(page, at);
  // The in-page mark (for later waits after the page answered) within the time left; not awaited past the deadline.
  await bounded(page.evaluate(markBusyGaveUp, undefined).catch(() => {}), Math.max(0, left()));
  return 'timeout';
}

/** Time of the content wait kept for marking the document (`waitForContent`). */
export const MARK_RESERVE_MS = 150;
