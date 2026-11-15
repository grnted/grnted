// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Which of a rule's failing elements share one evidence image (report v2, Plan 5 Task 5.8). Pure: no
// browser, no I/O. Engine core: no Node-only imports.
import { MAX_TARGETS } from './select.js';

/** One found target, in document CSS px, and whether it shows text on screen. */
export interface TargetCandidate { x0: number; y0: number; x1: number; y1: number; text: boolean }

const area = (c: TargetCandidate) => Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0);

/** All index sets of size `k` from 0..n-1, in lexicographic order. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push(acc); return; }
    for (let i = start; i <= n - (k - acc.length); i++) pick(i + 1, [...acc, i]);
  };
  pick(0, []);
  return out;
}

/**
 * The indices (ascending) of the targets to box in one image: the largest group, at most
 * `MAX_TARGETS`, whose union plus `pad` on every side fits `max`. Among groups of that size it prefers
 * more targets with visible text, then a larger painted area, then the earliest targets. A single
 * target always "fits" (its clip is cut to the limits). Deterministic.
 */
export function chooseTargets(cands: readonly TargetCandidate[], pad: number, max: { width: number; height: number }): number[] {
  const n = cands.length;
  const fits = (g: number[]) => {
    if (g.length === 1) return true;
    const x0 = Math.min(...g.map((i) => cands[i]!.x0));
    const y0 = Math.min(...g.map((i) => cands[i]!.y0));
    const x1 = Math.max(...g.map((i) => cands[i]!.x1));
    const y1 = Math.max(...g.map((i) => cands[i]!.y1));
    return x1 - x0 + 2 * pad <= max.width && y1 - y0 + 2 * pad <= max.height;
  };
  for (let k = Math.min(MAX_TARGETS, n); k >= 1; k--) {
    let best: { g: number[]; text: number; area: number } | null = null;
    for (const g of combinations(n, k)) {
      if (!fits(g)) continue;
      const text = g.filter((i) => cands[i]!.text).length;
      const a = g.reduce((s, i) => s + area(cands[i]!), 0);
      // Combinations come in lexicographic order, so a strict improvement keeps the earliest on a tie.
      if (!best || text > best.text || (text === best.text && a > best.area)) best = { g, text, area: a };
    }
    if (best) return best.g;
  }
  return [];
}
