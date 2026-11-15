// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Relative order of repeated items on two pages (WCAG 3.2.3 and 3.2.6). Pure; engine core.

/** Two items shown in opposite orders: `first` comes before `second` on page A and after it on page B. */
export interface OrderConflict {
  first: string;
  second: string;
}

/**
 * Pairs of items, among those both sequences contain, whose relative order is reversed. Items only
 * one page has (added or removed) are ignored, as WCAG allows. An item listed several times on a
 * page counts only against items that are entirely before or entirely after every one of its
 * copies, so a link repeated at the top and bottom of a menu never reads as a move.
 * O(n²) in the number of shared items; callers cap the sequences.
 */
export function orderConflicts(a: readonly string[], b: readonly string[]): OrderConflict[] {
  const span = (seq: readonly string[]) => {
    const m = new Map<string, [number, number]>();
    seq.forEach((k, i) => {
      const s = m.get(k);
      if (s) s[1] = i;
      else m.set(k, [i, i]);
    });
    return m;
  };
  const sa = span(a);
  const sb = span(b);
  const shared = [...sa.keys()].filter((k) => sb.has(k));
  // Fast path (the usual case): the shared items in the same order of first appearance cannot
  // conflict, since a reversed pair would reverse their first appearances too.
  const firsts = (s: Map<string, [number, number]>) => shared.map((k) => [k, s.get(k)![0]] as const).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
  const fa = firsts(sa);
  const fb = firsts(sb);
  if (fa.every((k, i) => k === fb[i])) return [];
  // -1: x entirely before y; 1: entirely after; 0: their copies interleave (no definite order).
  const rel = (s: Map<string, [number, number]>, x: string, y: string) => {
    const [x0, x1] = s.get(x)!;
    const [y0, y1] = s.get(y)!;
    return x1 < y0 ? -1 : y1 < x0 ? 1 : 0;
  };
  const out: OrderConflict[] = [];
  for (let i = 0; i < shared.length; i++) {
    for (let j = i + 1; j < shared.length; j++) {
      const x = shared[i]!;
      const y = shared[j]!;
      const ra = rel(sa, x, y);
      const rb = rel(sb, x, y);
      if (ra !== 0 && rb !== 0 && ra !== rb) out.push(ra < 0 ? { first: x, second: y } : { first: y, second: x });
    }
  }
  return out;
}

/**
 * Whether `orderConflicts(a, b)` would find anything, without listing the pairs: O(n log n) when no
 * shared item is repeated on a page (the usual case), where a conflict exists exactly when the
 * shared items' orders of first appearance differ.
 */
export function hasOrderConflict(a: readonly string[], b: readonly string[]): boolean {
  const inB = new Set(b);
  const fa = firstOrder(a, inB);
  const inA = new Set(a);
  const fb = firstOrder(b, inA);
  if (fa.order.length === fb.order.length && fa.order.every((k, i) => k === fb.order[i])) return false;
  if (!fa.repeated && !fb.repeated) return true;
  return orderConflicts(a, b).length > 0;
}

/** The distinct items of `seq` that `keep` has, in order of first appearance, and whether any of them repeats. */
function firstOrder(seq: readonly string[], keep: ReadonlySet<string>): { order: string[]; repeated: boolean } {
  const seen = new Set<string>();
  const order: string[] = [];
  let repeated = false;
  for (const k of seq) {
    if (!keep.has(k)) continue;
    if (seen.has(k)) repeated = true;
    else {
      seen.add(k);
      order.push(k);
    }
  }
  return { order, repeated };
}

/**
 * The fewest items to name as moved: repeatedly the item in the most remaining conflicts (ties: the
 * one listed first in `order`), until no conflict is left. For [A, B, C, D] against [B, C, D, A]
 * that is A alone, not B, C and D.
 */
export function movedItems(conflicts: readonly OrderConflict[], order: readonly string[]): string[] {
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string) => {
    const s = adj.get(x) ?? new Set<string>();
    s.add(y);
    adj.set(x, s);
  };
  for (const c of conflicts) {
    link(c.first, c.second);
    link(c.second, c.first);
  }
  const pos = new Map(order.map((k, i) => [k, i] as const));
  const at = (k: string) => pos.get(k) ?? Number.MAX_SAFE_INTEGER;
  const moved: string[] = [];
  for (;;) {
    let pick: string | undefined;
    for (const [k, s] of adj) {
      if (!s.size) continue;
      const best = pick === undefined ? undefined : adj.get(pick)!.size;
      if (best === undefined || s.size > best || (s.size === best && at(k) < at(pick!))) pick = k;
    }
    if (pick === undefined) return moved;
    moved.push(pick);
    for (const n of adj.get(pick)!) adj.get(n)!.delete(pick);
    adj.get(pick)!.clear();
  }
}
