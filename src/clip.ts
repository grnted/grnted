// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shortening text for evidence lines (batch 19, first-run feedback: lines were cut mid-word, "fixed or sticky con…",
// and selectors mid-step, "a:nth-o..."). Engine core: no Node-only imports.

/** Connectors and open brackets a cut line must not end on (a selector's " > " combinator; never an HTML tag's own ">"). */
const DANGLING = /(?:\s[>+~]|[\s,;:([{=|–—-])+$/u;

/**
 * `s` cut to at most `max` characters at a word boundary, with an ellipsis; unchanged when it fits. A text with no
 * space near the cut (one long token: an address, a selector without spaces) is cut where it must be.
 */
export function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 2) return s.slice(0, Math.max(0, max));
  const room = max - 1;
  let at = -1;
  for (let i = room; i > 0; i--) {
    if (/\s/u.test(s[i]!)) {
      at = i;
      break;
    }
  }
  const kept = at >= Math.ceil(room * 0.6) ? s.slice(0, at).replace(DANGLING, '') : '';
  return `${kept || s.slice(0, room).trimEnd()}…`;
}

/**
 * A CSS selector path ("a > b > c") cut to at most `max` characters: its first step and as many of its last steps as
 * fit ("#main > … > p:nth-of-type(3) > a"), so the element itself stays named. Other text: `clipWords`.
 */
export function clipPath(s: string, max: number): string {
  if (s.length <= max) return s;
  const steps = s.split(' > ');
  if (steps.length < 3) return clipWords(s, max);
  const head = steps[0]!;
  let tail: string[] = [];
  for (let i = steps.length - 1; i > 0; i--) {
    const next = [steps[i]!, ...tail];
    if (head.length + ' > … > '.length + next.join(' > ').length > max) break;
    tail = next;
  }
  if (tail.length) return `${head} > … > ${tail.join(' > ')}`;
  const last = steps[steps.length - 1]!;
  return last.length + 4 <= max ? `… > ${last}` : clipWords(s, max);
}
