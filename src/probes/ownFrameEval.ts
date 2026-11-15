// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, round 2: the page's own frames (same origin, or a srcdoc frame) hold the page's content too: a
// chart, a switch or a tab list embedded through an <iframe> is judged as on the page. Runs a self-contained in-page
// check in each such frame and names what it returns through the frame ("iframe 1 >>> path"). Engine core: no
// Node-only imports.
import type { PageLike } from '../types.js';

/** Most frames looked into per page. */
export const OWN_FRAMES_MAX = 4;

/**
 * `fn(arg)` in each of the page's own child frames (at most `OWN_FRAMES_MAX`), its results' `path` prefixed with the
 * frame. Frames of other sites, frames that fail and a page without frames give nothing. Never throws.
 */
export async function inOwnFrames<A, R extends { path: string }>(page: PageLike, fn: (arg: A) => R[], arg: A): Promise<R[]> {
  let origin = '';
  try {
    origin = new URL(page.url?.() ?? '').origin;
  } catch {
    return [];
  }
  const out: R[] = [];
  let n = 0;
  let frames: ReturnType<NonNullable<PageLike['frames']>> = [];
  try {
    frames = (page.frames?.() ?? []).filter((f) => f.parentFrame() !== null);
  } catch {
    return [];
  }
  for (const f of frames) {
    if (n >= OWN_FRAMES_MAX) break;
    let url = '';
    try {
      url = f.url();
    } catch {
      continue;
    }
    let own = url === 'about:srcdoc';
    if (!own) {
      try {
        own = new URL(url).origin === origin;
      } catch {
        own = false;
      }
    }
    if (!own) continue;
    n++;
    try {
      const list = await f.evaluate(fn, arg);
      for (const r of list) out.push({ ...r, path: `iframe ${n} >>> ${r.path}` });
    } catch {
      // A frame that navigated or refused the call: nothing from it.
    }
  }
  return out;
}
