// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The live view's provisional "found so far" events (ScanEvent `found`; plan 2026-11-04, the live scan
// page). As each page's audit, each test run and each AI review item finishes, the scan says which
// criteria now have a problem found and which were checked with nothing found yet. Provisional: the
// verdict still comes from scoring, and an event never carries a weight, share, threshold or point
// (public what, private how). Observation only, and bounded. Engine core: no Node-only imports.
import { AXE_RULES } from './report/criteria.js';
import type { AiCheckId, AiFinding, FoundProblem, PageAudit, ProbeRun, ScanEvent } from './types.js';

/**
 * `found` events sent one by one per scan. Past it nothing is dropped: what is new is gathered and sent
 * as one event per FOUND_FLUSH_EVERY finished pages, runs or AI items (each problem then names the pages
 * it adds on), at once when it changes a square (a criterion's first check or first problem: at most two
 * per criterion), and at every flush() (each stage's end, a segment's end, before scoring). So a scan
 * sends at most FOUND_EVENTS_MAX + (items past the cap) / FOUND_FLUSH_EVERY + 2 × 55 + its flushes, and
 * the counts the live view shows at the end are the whole scan's.
 */
export const FOUND_EVENTS_MAX = 300;
export const FOUND_FLUSH_EVERY = 50;

/** Each axe rule's criteria (the inverse of AXE_RULES): a failing rule is a problem under each. */
const RULE_CRITERIA: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [criterion, rules] of Object.entries(AXE_RULES)) for (const r of rules) m.set(r, [...(m.get(r) ?? []), criterion]);
  return m;
})();

type Source = 'rules' | 'test' | 'ai';

export interface FoundTracker {
  /** A page's audit (its axe rules), at its index in the selection. */
  page(page: PageAudit, index: number): void;
  /** One test run (one test on one page). */
  run(run: ProbeRun): void;
  /** AI review findings as they answer (any order; the same finding twice counts once). */
  ai(check: AiCheckId, findings: readonly AiFinding[]): void;
  /** Sends what was gathered past the cap (a stage's end, a segment's end, before scoring). */
  flush(): void;
}

/**
 * The tracker for one scan (`budget`: the events it may send one by one, at most FOUND_EVENTS_MAX; a long
 * scan's later segments get what its earlier ones left, ScanOptions.foundBudget). `indexOf` gives a page address's index in the selection (undefined for an
 * address that isn't one of the scan's pages, such as a PDF). Each event carries only what is new: a
 * criterion that kind already checked is not sent again, and a problem is sent once per check,
 * criterion and page with the count it adds.
 */
export function foundTracker(emit: (e: ScanEvent) => void, indexOf: (url: string) => number | undefined, budget = FOUND_EVENTS_MAX): FoundTracker {
  const direct = Math.max(0, Math.min(FOUND_EVENTS_MAX, Math.floor(budget)));
  const checked = new Set<string>(); // `${source}|${criterion}`
  /** Criteria any kind has checked, and criteria with a problem (or a flag): a square's state. */
  const anyChecked = new Set<string>();
  const problemCriteria = new Set<string>();
  const problemSeen = new Map<string, number>(); // `${source}|${check}|${criterion}|${page}` -> count sent
  const aiSeen = new Set<string>();
  let sent = 0;
  /** Past the cap: what is new, by kind of check, until the next flush. */
  const pending = new Map<Source, { checked: Set<string>; problems: Map<string, { p: FoundProblem; pages: Set<number>; off: number }> }>();
  let gathered = 0;

  const send = (source: Source, page: number | undefined, criteria: Iterable<string>, problems: FoundProblem[]) => {
    const fresh = [...new Set(criteria)].filter((c) => !checked.has(`${source}|${c}`)).sort();
    const delta: FoundProblem[] = [];
    for (const p of problems) {
      const k = `${source}|${p.check}|${p.criterion}|${page ?? ''}`;
      const before = problemSeen.get(k) ?? 0;
      if (p.count <= before) continue;
      delta.push({ ...p, count: p.count - before });
    }
    if (!fresh.length && !delta.length) return;
    // Something that changes a square (a criterion first checked, or its first problem): past the cap it
    // goes out at once, with what was gathered, so the grid never waits.
    const firstState = fresh.some((c) => !anyChecked.has(c)) || delta.some((p) => !problemCriteria.has(`${p.criterion}|${p.flag ? 'f' : 'p'}`));
    for (const c of fresh) { checked.add(`${source}|${c}`); anyChecked.add(c); }
    for (const p of delta) {
      const k = `${source}|${p.check}|${p.criterion}|${page ?? ''}`;
      problemSeen.set(k, (problemSeen.get(k) ?? 0) + p.count);
      problemCriteria.add(`${p.criterion}|${p.flag ? 'f' : 'p'}`);
    }
    if (sent < direct) {
      sent++;
      emit({ type: 'found', provisional: true, source, ...(page !== undefined ? { page } : {}), checked: fresh, problems: delta });
      return;
    }
    // Past the cap: gathered, and sent together.
    const bin = pending.get(source) ?? { checked: new Set<string>(), problems: new Map<string, { p: FoundProblem; pages: Set<number>; off: number }>() };
    pending.set(source, bin);
    for (const c of fresh) bin.checked.add(c);
    for (const p of delta) {
      const k = `${p.check}|${p.criterion}|${p.flag ? 'f' : ''}`;
      const g = bin.problems.get(k) ?? { p: { check: p.check, criterion: p.criterion, count: 0, ...(p.flag ? { flag: true as const } : {}) }, pages: new Set<number>(), off: 0 };
      bin.problems.set(k, g);
      if (page === undefined) g.off += p.count;
      else { g.p.count += p.count; g.pages.add(page); }
    }
    if (firstState || ++gathered >= FOUND_FLUSH_EVERY) flush();
  };

  /** One event per kind of check: its new criteria, and each problem with the pages it adds on (and, apart, what it adds off any page). */
  const flush = () => {
    gathered = 0;
    for (const [source, bin] of pending) {
      const problems: FoundProblem[] = [];
      for (const g of bin.problems.values()) {
        if (g.p.count) problems.push({ ...g.p, pages: [...g.pages].sort((a, b) => a - b) });
        if (g.off) problems.push({ check: g.p.check, criterion: g.p.criterion, count: g.off, ...(g.p.flag ? { flag: true as const } : {}) });
      }
      if (!bin.checked.size && !problems.length) continue;
      emit({ type: 'found', provisional: true, source, checked: [...bin.checked].sort(), problems });
    }
    pending.clear();
  };

  return {
    page(page, index) {
      if (page.status !== 'ok') return;
      const criteria: string[] = [];
      for (const [rule, outcome] of Object.entries(page.rules)) {
        if (outcome === 'pass' || outcome === 'fail') criteria.push(...(RULE_CRITERIA.get(rule) ?? []));
      }
      const problems: FoundProblem[] = [];
      for (const v of page.violations) {
        const count = v.nodes.length;
        if (!count) continue;
        for (const criterion of RULE_CRITERIA.get(v.id) ?? []) {
          problems.push({ check: v.id, criterion, count });
          criteria.push(criterion);
        }
      }
      send('rules', index, criteria, problems);
    },
    run(run) {
      const index = indexOf(run.page);
      const criteria: string[] = [];
      // As the report reads a run (probes/criteria.ts probeCriteriaResults): a criterion of the run with
      // no finding of its own had no failures found there. A run that timed out or failed carries
      // not_testable findings, so it checks nothing.
      if (run.status === 'ok') for (const c of run.criteria) if (!run.findings.some((f) => f.criterion === c)) criteria.push(c);
      const counts = new Map<string, { n: number; flag: boolean }>();
      for (const f of run.findings) {
        if (f.status === 'not_testable' || f.status === 'not_applicable') continue;
        criteria.push(f.criterion);
        if (f.status === 'failed' || f.status === 'flagged') {
          const k = `${f.criterion}|${f.status}`;
          counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, flag: f.status === 'flagged' });
        }
      }
      const problems = [...counts].map(([k, v]): FoundProblem => ({ check: run.probe, criterion: k.split('|')[0]!, count: v.n, ...(v.flag ? { flag: true as const } : {}) }));
      send('test', index, criteria, problems);
    },
    ai(check, findings) {
      // One event per page (an item belongs to one page or document): the pages a finding names.
      const byPage = new Map<number | undefined, { criteria: string[]; problems: Map<string, number> }>();
      for (const f of findings) {
        if (!f || typeof f.criterion !== 'string') continue;
        const k = `${check}|${f.criterion}|${f.page}|${f.target}|${f.verdict}`;
        if (aiSeen.has(k)) continue;
        aiSeen.add(k);
        const index = indexOf(f.page);
        const slot = byPage.get(index) ?? { criteria: [], problems: new Map<string, number>() };
        byPage.set(index, slot);
        slot.criteria.push(f.criterion);
        if (f.flagged) slot.problems.set(f.criterion, (slot.problems.get(f.criterion) ?? 0) + 1);
      }
      for (const [index, slot] of byPage) {
        // A flag is counted per page: what the page already sent is added to, never sent again.
        const problems = [...slot.problems].map(([criterion, n]): FoundProblem => {
          const k = `ai|${check}|${criterion}|${index ?? ''}`;
          return { check, criterion, count: (problemSeen.get(k) ?? 0) + n, flag: true };
        });
        send('ai', index, slot.criteria, problems);
      }
    },
    flush,
  };
}
