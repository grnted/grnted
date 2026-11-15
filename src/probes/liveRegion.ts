// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Live regions (4.1.3, ARIA22): what screen readers watch for changes. One definition for every test that asks
// whether a message is announced (the controls kit, the forms agent; act-watch review r1, finding F2): an element
// whose role (any token) is status, alert, log, marquee or timer, an `output` (its implicit role is status), or an
// element with aria-live that is not "off". The in-page code gets it as a selector string.
// Engine core: no Node-only imports.

/** A CSS selector for a live region (matches the element itself; use `closest` for "inside one"). */
export const LIVE_REGION_SELECTOR =
  '[role~="status"], [role~="alert"], [role~="log"], [role~="marquee"], [role~="timer"], output, [aria-live]:not([aria-live="off" i])';
