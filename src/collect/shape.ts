// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The page's DOM shape, the key template sampling (src/sample/templates.ts) uses next to the URL
// pattern. The vision collector computes the same key inside its own in-page function; this cheap
// collector gives it to scans that do not run vision (the probes' template sample).
import type { PageCollector } from '../types.js';

/**
 * Runs inside the page. Must be self-contained. Counts are capped or bucketed so content length
 * matters little. Keep in step with the shape in `collectVisionFacts` (src/collect/vision.ts): both
 * must give the same key for the same page (asserted in test/integration/probes.test.ts).
 */
export function pageShape(): string {
  const count = (sel: string) => document.querySelectorAll(sel).length;
  const cap = (x: number, max: number) => (x >= max ? `${max}+` : String(x));
  const bucket = (x: number) => (x === 0 ? '0' : x === 1 ? '1' : x <= 3 ? '2-3' : x <= 7 ? '4-7' : x <= 15 ? '8-15' : '16+');
  return [
    `header:${cap(count('header, [role="banner"]'), 2)}`,
    `nav:${cap(count('nav, [role="navigation"]'), 3)}`,
    `main:${cap(count('main, [role="main"]'), 2)}`,
    `aside:${cap(count('aside, [role="complementary"]'), 2)}`,
    `footer:${cap(count('footer, [role="contentinfo"]'), 2)}`,
    `form:${cap(count('form, [role="search"], [role="form"]'), 2)}`,
    `table:${cap(count('table'), 2)}`,
    `iframe:${cap(count('iframe'), 1)}`,
    `article:${cap(count('article'), 3)}`,
    `h1:${cap(count('h1'), 2)}`,
    `h2-6:${bucket(count('h2, h3, h4, h5, h6'))}`,
  ].join(' ');
}

/** Desktop only (a handful of `querySelectorAll` counts). Added to a scan when probes run. */
export const shapeCollector: PageCollector<string> = {
  id: 'shape',
  viewport: 'desktop',
  timeoutMs: 2000,
  collect: (page) => page.evaluate(pageShape, undefined),
};
