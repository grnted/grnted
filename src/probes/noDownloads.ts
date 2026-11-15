// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// No test that presses things may save a file. Two layers:
// - the browser context of every strict test (`PageProbe.sendsNothing`) refuses downloads (the runner opens it
//   with `acceptDownloads: false`);
// - in the page, a download a script starts by clicking a link it made is stopped before it starts
//   (`stopDownloads`): the link's click() and a synthetic click on it do nothing, and a real click that lands on
//   a download link has its default action cancelled. The page's own listeners still run.
// A download link is one with a `download` attribute or a `blob:` or `data:` address (a page cannot navigate to
// those from a click that matters to the tests; a plain link to a file is a navigation, which the guard holds).
// A frame's own document is not covered here (its click() is the frame's): the browser's refusal is.
// Engine core: no Node-only imports.

/** Where `stopDownloads` keeps its undo on `window` (non-enumerable). */
export const DOWNLOAD_STOP_KEY = '__grntedNoDownloads';

/**
 * Runs in the page (self-contained): installs the stop (once). Returns false when the page would not take it.
 * `undoDownloadStop` takes it out again.
 */
export function stopDownloads(key: string): boolean {
  const W = window as unknown as Record<string, { undo(): void; stopped: number } | undefined>;
  if (W[key]) return true;
  try {
    const isDownload = (el: unknown): boolean => {
      if (!el || (el as Node).nodeType !== 1) return false;
      const a = (el as Element).closest ? (el as Element).closest('a, area') : null;
      if (!a) return false;
      const href = String((a as HTMLAnchorElement).href || a.getAttribute('href') || '');
      return a.hasAttribute('download') || /^\s*(blob|data):/i.test(href);
    };
    const state = { stopped: 0, undo: () => {} };
    const onClick = (e: Event) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (isDownload(path[0] ?? e.target)) { e.preventDefault(); state.stopped++; }
    };
    const click = HTMLElement.prototype.click;
    const dispatch = EventTarget.prototype.dispatchEvent;
    HTMLElement.prototype.click = function (this: HTMLElement) {
      if (isDownload(this)) { state.stopped++; return; }
      return click.call(this);
    };
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, ev: Event) {
      if (ev && (ev.type === 'click' || ev.type === 'auxclick') && isDownload(this)) { state.stopped++; return true; }
      return dispatch.call(this, ev);
    };
    window.addEventListener('click', onClick, true);
    state.undo = () => {
      HTMLElement.prototype.click = click;
      EventTarget.prototype.dispatchEvent = dispatch;
      window.removeEventListener('click', onClick, true);
    };
    Object.defineProperty(W, key, { value: state, configurable: true, enumerable: false, writable: true });
    return true;
  } catch {
    return false;
  }
}

/** Runs in the page (self-contained): takes the stop out; returns how many downloads it stopped. */
export function undoDownloadStop(key: string): number {
  const W = window as unknown as Record<string, { undo(): void; stopped: number } | undefined>;
  const s = W[key];
  if (!s) return 0;
  try { s.undo(); } catch { /* the page is not used again */ }
  delete W[key];
  return s.stopped;
}
