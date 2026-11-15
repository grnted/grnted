// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A later axe run of the same page at the same width: after a fade settled, or after content the page mounted
// late (fix/late-mount, review r2: "axe judges the settled page"). Engine core: no Node-only imports.

/** Longest wait for the later axe run; past it, the earlier run stands. */
export const AXE_RERUN_MS = 30_000;
/** Longest wait for the later run to be ready (the fade or mount wait is bounded on its own; this is a backstop). */
export const AXE_READY_MS = 10_000;

/** `p`'s value, or `fallback` when it rejects or has not settled within `ms`. Never throws. */
async function bounded<T, F>(p: () => Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p().catch(() => fallback), new Promise<F>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * When `ready()` says the page has settled (a fade at rest, content mounted), axe runs again and that later
 * run IS the result for this width: nothing of the earlier run is merged in (no stale failure of an element
 * the page replaced, a later "incomplete" stands, a frame's result is the later run's). The earlier run is
 * the result only when there is no later run: not ready, the page now shows another document
 * (`sameDocument`), or the later run threw or did not finish within `AXE_RERUN_MS`. Every call is bounded,
 * nothing is left to clean up, and it never throws.
 */
export async function laterAxe<T>(earlier: T, opts: { ready: () => Promise<boolean>; rerun: () => Promise<T>; sameDocument: () => boolean; rerunMs?: number; readyMs?: number }): Promise<{ outcome: T; later: boolean }> {
  const ready = await bounded(opts.ready, opts.readyMs ?? AXE_READY_MS, false);
  if (ready !== true) return { outcome: earlier, later: false };
  let same = false;
  try { same = opts.sameDocument(); } catch { same = false; }
  if (!same) return { outcome: earlier, later: false };
  const later = await bounded(opts.rerun, opts.rerunMs ?? AXE_RERUN_MS, null);
  if (later === null) return { outcome: earlier, later: false };
  try { same = opts.sameDocument(); } catch { same = false; }
  return same ? { outcome: later, later: true } : { outcome: earlier, later: false };
}
