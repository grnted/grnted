// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The review's second look (the closed AI package's precision guard): failures
// its package moves to Needs review (`ReportExtension.demotions`) are applied here, to the report's inputs, before
// anything is scored, so the score, the criteria table, the problems and the jobs all read the same results. Plain
// data only: which failure moves, and why, is the package's decision; this file never judges one.
import type { AiReport, PageAudit, ProbeRun, SecondLookDemotion } from '../types.js';

/** The first criterion an AI finding is filed under (a finding may list several, the first is the one that counts). */
const firstCriterion = (c: string) => c.split(',')[0]!.trim();

export interface SecondLookInputs {
  pages: PageAudit[];
  probeRuns?: ProbeRun[];
  ai?: AiReport;
}

/**
 * The inputs with each demoted failure moved to Needs review, with the reviewer's reason (`secondLook`):
 * - `axe`: the rule's violation on the page goes to the page's undecided results (its outcome there `incomplete`);
 * - `test`: the test's failed findings of the criterion on the page become `flagged`;
 * - `ai`: the check's confirmed findings of the criterion on the page stop counting (`scored` dropped).
 * Nothing else changes; a demotion that matches nothing is ignored; the inputs are not modified.
 */
export function applySecondLook<T extends SecondLookInputs>(input: T, demotions: readonly SecondLookDemotion[]): T {
  if (!demotions.length) return input;
  const key = (page: string, id: string) => `${page}\n${id}`;
  const axe = new Map<string, string>();
  const test = new Map<string, string>();
  const ai = new Map<string, string>();
  for (const d of demotions) {
    if (d.method === 'axe') axe.set(key(d.page, d.id), d.reason);
    else if (d.method === 'test') test.set(key(d.page, `${d.id}\n${d.criterion}`), d.reason);
    else if (d.method === 'ai') ai.set(key(d.page, `${d.id}\n${d.criterion}`), d.reason);
  }
  const pages = axe.size
    ? input.pages.map((p) => {
      const moved = p.violations.filter((f) => axe.has(key(p.url, f.id)));
      if (!moved.length) return p;
      const rules = { ...p.rules };
      for (const f of moved) rules[f.id] = 'incomplete';
      return {
        ...p, rules,
        violations: p.violations.filter((f) => !axe.has(key(p.url, f.id))),
        incomplete: [...p.incomplete, ...moved.map((f) => ({ ...f, secondLook: axe.get(key(p.url, f.id))! }))],
      };
    })
    : input.pages;
  const probeRuns = test.size && input.probeRuns
    ? input.probeRuns.map((r) => {
      if (!r.findings.some((f) => f.status === 'failed' && test.has(key(r.page, `${r.probe}\n${f.criterion}`)))) return r;
      return {
        ...r,
        findings: r.findings.map((f) => {
          const reason = f.status === 'failed' ? test.get(key(r.page, `${r.probe}\n${f.criterion}`)) : undefined;
          return reason === undefined ? f : { ...f, status: 'flagged' as const, secondLook: reason };
        }),
      };
    })
    : input.probeRuns;
  const review = ai.size && input.ai
    ? {
      ...input.ai,
      runs: input.ai.runs.map((run) => ({
        ...run,
        findings: run.findings.map((f) => {
          const reason = f.scored === true && typeof f.page === 'string' ? ai.get(key(f.page, `${run.check}\n${firstCriterion(f.criterion)}`)) : undefined;
          if (reason === undefined) return f;
          const { scored: _scored, ...rest } = f;
          return { ...rest, secondLook: reason };
        }),
      })),
    }
    : input.ai;
  return {
    ...input,
    pages,
    ...(probeRuns ? { probeRuns } : {}),
    ...(review ? { ai: review } : {}),
  };
}
