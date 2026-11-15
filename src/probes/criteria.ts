// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Probe runs aggregated per criterion and probe: the probe side of the "WCAG results by criterion"
// table (Plan 4 rule 3). Engine core: no Node-only imports.
import type { CriterionEvidence, CriterionStatus, ProbeCriterionResult, ProbeRun } from '../types.js';

/** Higher is worse: failed > flagged > not_testable > no_failures_found > not_applicable. */
export const STATUS_RANK: Record<CriterionStatus, number> = {
  failed: 4, flagged: 3, not_testable: 2, no_failures_found: 1, not_applicable: 0,
};

export function worstStatus(list: readonly CriterionStatus[]): CriterionStatus {
  return list.reduce<CriterionStatus>((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w), 'not_applicable');
}

/** Orders criteria by number: 1.4.4 before 1.4.10. */
export function compareCriteria(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return Number.isNaN(d) ? (a < b ? -1 : 1) : d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A check the time limit cut short: "Partly tested: 2 of 5 pages (the scan ran out of time)". */
export const partlyTested = (done: number, of: number, unit: string) => `Partly tested: ${done} of ${plural(of, unit)} (the scan ran out of time)`;

/** Load failures where the test never started on the page (`ProbeFinding.loadFailure`); a lost browser is not one. */
const NEVER_STARTED: ReadonlySet<string> = new Set(['not-loaded', 'challenge']);

/** Evidence items kept per criterion and probe. */
export const PROBE_EVIDENCE_CAP = 20;
const NOTE_REASONS = 3;
/** Longest note carried from a clean result's detail. */
const CLEAN_NOTE_MAX = 120;

/**
 * One entry per criterion and probe, in criterion order, then the order the probes first appear in
 * `runs` (runProbes orders them by page, then registry order).
 * - A page's status for a criterion is the worst of the probe's findings for it there, or
 *   `no_failures_found` when the probe ran and found nothing for it.
 * - The method's status is the worst over its pages; `pages` counts the pages it ran on. Except: one
 *   page where it could not run never sinks the pages where it did (no page failed, none cut short by
 *   the time limit, no content left out by the scan's limits): a page where it tested the criterion and
 *   found no failure gives `no_failures_found` ("no failures found on the N pages tested"), and pages
 *   that had nothing for it to test give `not_applicable` ("nothing to test on the N pages tested"),
 *   when every untested page is one it never started on (`NEVER_STARTED`) or had nothing to test with
 *   (`nothingToTest`); any other untested page (it ran and could not judge, broke, timed out, lost the
 *   browser) keeps the method `not_testable`;
 *   the untested pages and their reasons are in the note, the tested ones in the evidence.
 *   `not_testable` only when no page could run it.
 * - `note` gives the reasons when the status is `not_testable` or `not_applicable`, the first detail a
 *   probe gave with a `no_failures_found` finding (what the clean result covered, at most 120
 *   characters), and says on how
 *   many pages a test could not run when the status is another.
 * - Pages the scan's time limit stopped the test on (`ProbeFinding.timeLimit`) are not tested: a
 *   method with no failure elsewhere is `not_testable`, "Partly tested: N of M pages (the scan ran
 *   out of time)", never `no_failures_found`.
 * - Evidence: failed, then flagged, then not_testable findings, capped at PROBE_EVIDENCE_CAP.
 * - Pages where single elements were measured, not the whole test (`ProbeRun.checked`: a failure measured
 *   on that page's own element), count in `pages` and fail; the note says which is which ("full test on
 *   5 pages; on 40 more pages the element that failed was measured on that page by itself").
 */
/** How a failure on a page was measured, in the words every surface uses (the WCAG table, the problems, the ACR, the exports). */
export const METHOD_FULL = 'full test';
export const METHOD_CHECKED = 'checked on this page';

/**
 * One run's result for one criterion, the one value every view reads (the WCAG results here, the report's
 * interaction grid): the worst of its findings for the criterion, 'no_failures_found' when it covered the
 * criterion and found nothing, undefined when the run does not cover the criterion.
 */
export function runCriterionStatus(run: ProbeRun, criterion: string): CriterionStatus | undefined {
  const found = (Array.isArray(run.findings) ? run.findings : []).filter((f) => f && f.criterion === criterion && !f.advice);
  if (found.length) return worstStatus(found.map((f) => f.status));
  return Array.isArray(run.criteria) && run.criteria.includes(criterion) ? 'no_failures_found' : undefined;
}

export function probeCriteriaResults(runs: readonly ProbeRun[]): ProbeCriterionResult[] {
  interface Acc {
    criterion: string;
    probe: string;
    kind: ProbeRun['kind'];
    first: number;
    pages: Map<string, CriterionStatus>;
    /** Pages the scan's time limit stopped this test on (`ProbeFinding.timeLimit`). */
    cut: Set<string>;
    /** The scan's own limits left content for this test untested (`ProbeFinding.limit`). */
    limited: boolean;
    /**
     * Pages where the test could not judge the criterion for a reason other than "it never started here"
     * (`NEVER_STARTED`: the page did not load for it, or answered with a bot challenge) or "nothing here
     * to test it with" (`ProbeFinding.nothingToTest`): it ran and could not judge what it found, broke,
     * timed out or lost the browser. Such a page keeps the criterion not testable, whatever the other
     * pages gave.
     */
    blind: Set<string>;
    /** Pages given a targeted check of single elements, not the whole test (`ProbeRun.checked`). */
    checked: Set<string>;
    reasons: Map<CriterionStatus, Map<string, Set<string>>>;
    evidence: (CriterionEvidence & { rank: number; seq: number })[];
  }
  const byKey = new Map<string, Acc>();
  let seq = 0;
  runs.forEach((run, i) => {
    for (const criterion of run.criteria) {
      const key = `${criterion}\u0000${run.probe}`;
      let a = byKey.get(key);
      if (!a) byKey.set(key, (a = { criterion, probe: run.probe, kind: run.kind, first: i, pages: new Map(), cut: new Set(), limited: false, blind: new Set(), checked: new Set(), reasons: new Map(), evidence: [] }));
      if (run.checked) a.checked.add(run.page);
      // Recommendations (`ProbeFinding.advice`) are never a criterion's result (`runCriterionStatus` leaves them out).
      const found = run.findings.filter((f) => f.criterion === criterion && !f.advice);
      const status = runCriterionStatus(run, criterion)!;
      const prev = a.pages.get(run.page);
      a.pages.set(run.page, prev ? worstStatus([prev, status]) : status);
      if (found.some((f) => f.status === 'not_testable' && !NEVER_STARTED.has(f.loadFailure ?? '') && !f.nothingToTest)) a.blind.add(run.page);
      for (const f of found) {
        if (f.status === 'not_testable' && f.timeLimit) a.cut.add(run.page);
        if (f.status === 'not_testable' && f.limit) a.limited = true;
        if (f.status === 'not_testable' || f.status === 'not_applicable' || f.status === 'no_failures_found') {
          let byDetail = a.reasons.get(f.status);
          if (!byDetail) a.reasons.set(f.status, (byDetail = new Map()));
          let pages = byDetail.get(f.detail);
          if (!pages) byDetail.set(f.detail, (pages = new Set()));
          pages.add(run.page);
        }
        if (f.status === 'failed' || f.status === 'flagged' || f.status === 'not_testable') {
          a.evidence.push({ page: run.page, ...(f.target ? { target: f.target } : {}), detail: f.detail, rank: STATUS_RANK[f.status], seq: seq++ });
        }
      }
    }
  });

  const reasonsNote = (a: Acc, status: CriterionStatus, total: number, counts = true): string | undefined => {
    const byDetail = a.reasons.get(status);
    if (!byDetail?.size) return undefined;
    const parts = [...byDetail.entries()].slice(0, NOTE_REASONS).map(([detail, pages]) =>
      (counts && pages.size < total ? `${detail} (${pages.size} of ${total} pages)` : detail));
    return parts.join('; ') + (byDetail.size > NOTE_REASONS ? '; …' : '');
  };

  return [...byKey.values()]
    .sort((x, y) => compareCriteria(x.criterion, y.criterion) || x.first - y.first)
    .map((a) => {
      const statuses = [...a.pages.values()];
      const worst = worstStatus(statuses);
      const total = a.pages.size;
      // One page where the test could not run never sinks the pages where it did (no page failed it,
      // none was cut short by the time limit, which stays "Partly tested", and no content was left
      // untested by the scan's limits): the result of the pages tested, with the untested pages named in
      // the note (and in the evidence, with the tested pages).
      // Only pages the test could not run on at all (the page did not load for it) or that had nothing
      // for it to test with are set aside: a page where it ran and could not judge what it found keeps
      // the criterion not testable, whatever the other pages gave (a clean page beside it is no pass).
      const ran = statuses.filter((s) => s !== 'not_testable');
      const passedSomewhere = ran.includes('no_failures_found');
      const partial = worst === 'not_testable' && !a.cut.size && !a.limited && ran.length > 0 && !a.blind.size;
      const status: CriterionStatus = partial ? (passedSomewhere ? 'no_failures_found' : 'not_applicable') : worst;
      let note: string | undefined;
      if (partial) {
        const untested = statuses.length - ran.length;
        const tested = `the ${plural(ran.length, 'page')} tested`;
        const untestedNote = `could not be tested automatically on ${untested} of ${total} ${total === 1 ? 'page' : 'pages'}: ${reasonsNote(a, 'not_testable', total, false) ?? 'no reason given'}`;
        if (passedSomewhere) {
          const first = a.reasons.get('no_failures_found')?.keys().next().value;
          const clean = first ? (first.length > CLEAN_NOTE_MAX ? `${first.slice(0, CLEAN_NOTE_MAX - 1)}…` : first) : '';
          note = `no failures found on ${tested}${clean ? ` (${clean})` : ''}; ${untestedNote}`;
          for (const [page, st] of a.pages) {
            if (st !== 'no_failures_found') continue;
            const detail = runs.find((r) => r.page === page && r.probe === a.probe)?.findings.find((f) => f.criterion === a.criterion && f.status === 'no_failures_found')?.detail;
            a.evidence.push({ page, detail: `No failures found${detail ? `: ${detail}` : ''}`, rank: STATUS_RANK.no_failures_found, seq: seq++ });
          }
        } else {
          const why = reasonsNote(a, 'not_applicable', ran.length, false);
          note = `nothing to test on ${tested}${why ? ` (${why})` : ''}; ${untestedNote}`;
        }
      } else if (status === 'not_testable' && a.cut.size) {
        // Cut short by the time limit: never "no failures found", and it says how far it got.
        const done = statuses.filter((s) => s !== 'not_testable' && s !== 'not_applicable').length;
        const cutDetails = new Set(runs.filter((r) => a.cut.has(r.page) && r.probe === a.probe).flatMap((r) => r.findings.filter((f) => f.timeLimit).map((f) => f.detail)));
        const rest: Acc = { ...a, reasons: new Map([[status, new Map([...(a.reasons.get(status) ?? new Map<string, Set<string>>())].filter(([d]) => !cutDetails.has(d)))]]) };
        const other = reasonsNote(rest, status, total);
        note = `${partlyTested(done, total, 'page')}${other ? `; ${other}` : ''}`;
      } else if (status === 'not_testable' || status === 'not_applicable') {
        note = reasonsNote(a, status, total);
      } else if (status === 'no_failures_found') {
        // What a clean result covered, in the probe's own words (e.g. how many focus stops were
        // checked): the first one only, kept short.
        const first = a.reasons.get(status)?.keys().next().value;
        if (first) note = first.length > CLEAN_NOTE_MAX ? `${first.slice(0, CLEAN_NOTE_MAX - 1)}…` : first;
      } else {
        // Only failed or flagged can sit above pages that could not be tested.
        const untested = statuses.filter((s) => s === 'not_testable').length;
        if (untested) note = `could not be tested automatically on ${untested} of ${total} ${total === 1 ? 'page' : 'pages'}: ${reasonsNote(a, 'not_testable', total, false) ?? 'no reason given'}`;
        // How each page was measured: the whole test, or the element that failed elsewhere on its own.
        const checked = [...a.checked].filter((page) => a.pages.get(page) === 'failed').length;
        if (checked) note = `${note ? `${note}; ` : ''}${METHOD_FULL} on ${plural(total - checked, 'page')}; on ${checked} more ${checked === 1 ? 'page' : 'pages'} the element that failed was measured on that page by itself`;
      }
      const evidence = a.evidence
        .sort((x, y) => y.rank - x.rank || x.seq - y.seq)
        .slice(0, PROBE_EVIDENCE_CAP)
        .map(({ rank: _r, seq: _s, ...e }) => e);
      return {
        criterion: a.criterion,
        method: { id: a.probe, kind: a.kind, status, pages: total, ...(note ? { note } : {}) },
        evidence,
      };
    });
}
