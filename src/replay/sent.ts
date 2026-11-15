// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Whether an answer came from the site or from the scan's own copy of it (src/replay), as the browser's
// own timing tells it: an answer given by an interception has a first byte and no request start.
// What judges the site by its answers (the pace controller's page limit, the session pool's evidence of
// which sessions the site lets in) must not count an answer the site never gave.
// Engine core: no Node-only imports.

/**
 * False when the browser timed an answer for which it sent no request (Playwright `request().timing()`:
 * `responseStart` set, `requestStart` not). True for every answer a server sent, and whenever the
 * timing cannot be read.
 */
export function sentToSite(resp: unknown): boolean {
  try {
    const t = (resp as { request?: () => { timing?: () => { requestStart?: number; responseStart?: number } } }).request?.().timing?.();
    return !(typeof t?.responseStart === 'number' && t.responseStart >= 0 && typeof t.requestStart === 'number' && t.requestStart < 0);
  } catch {
    return true;
  }
}
