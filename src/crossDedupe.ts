// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// One problem and one cost per element across methods (scoring v9): when an axe rule, a scored automated
// test and an AI check fail the same element on the same page for the same criterion, the strongest method
// keeps it (axe over the tests, both over the AI) and the others are listed with its problem. Elements are
// named by keys (src/aiDedupe.ts): a selector, a name, a role. The automated side is here; the AI side is the
// closed AI package's (`ReportExtension`), given the automated elements. Pure. Engine core: no Node-only imports.
import { axeNodeElements, probeFindingElements, sameElement } from './aiDedupe.js';
import { SCORED_PROBES } from './probes/registry.js';
import { ruleCriterion } from './scoreCore.js';
import type { PageAudit, ProbeFinding, ProbeRun } from './types.js';

/** One failing element of an automated method: where, for which criterion, its keys and the problem that counts it. */
export interface AutomatedElement {
  page: string;
  criterion: string;
  keys: string[];
  /** The problem's key: `rule:<id>` or `criterion:<n.n.n>`. */
  source: string;
}

const scope = (page: string, criterion: string) => `${page}\n${criterion}`;

function byScope(list: readonly AutomatedElement[]): Map<string, AutomatedElement[]> {
  const out = new Map<string, AutomatedElement[]>();
  for (const e of list) {
    const k = scope(e.page, e.criterion);
    const l = out.get(k) ?? [];
    l.push(e);
    out.set(k, l);
  }
  return out;
}

/** Every node an axe rule fails on the loaded pages, under the rule's first criterion (where it counts). */
export function axeElements(okPages: readonly Pick<PageAudit, 'url' | 'violations'>[]): AutomatedElement[] {
  const out: AutomatedElement[] = [];
  for (const p of okPages) {
    for (const v of p.violations ?? []) {
      const criterion = ruleCriterion(v.id);
      if (!criterion) continue;
      for (const node of v.nodes ?? []) {
        const keys = axeNodeElements(node);
        if (keys.length) out.push({ page: p.url, criterion, keys, source: `rule:${v.id}` });
      }
    }
  }
  return out;
}

/**
 * Marks each test failure that an axe rule fails on the same element of the same page for the same
 * criterion (`coveredBy: 'rule:<id>'`): it costs nothing and is listed with the rule's problem. Any earlier
 * mark is recomputed. Runs without such a failure are returned as they are.
 */
export function coverProbeRuns(runs: readonly ProbeRun[], axe: readonly AutomatedElement[]): ProbeRun[] {
  const index = byScope(axe);
  return runs.map((run) => {
    let changed = false;
    const findings = run.findings.map((f) => {
      const { coveredBy: _prev, ...plain } = f;
      let next: ProbeFinding = f.coveredBy === undefined ? f : plain;
      if (f.status === 'failed') {
        const keys = probeFindingElements(f);
        const hit = keys.length ? (index.get(scope(run.page, f.criterion)) ?? []).find((a) => sameElement(keys, a.keys)) : undefined;
        if (hit) next = { ...plain, coveredBy: hit.source };
      }
      if (next !== f) changed = true;
      return next;
    });
    return changed ? { ...run, findings } : run;
  });
}

/**
 * The scored tests' failures on the loaded pages: the problem that counts each (its covering rule, else its
 * criterion). Only the runs the score counts (`probeChecksFrom`): a run of the wider coverage or a targeted
 * check (`ProbeRun.coverage`, `ProbeRun.checked`) is listed, never scored, so it keeps no element from another
 * method. (Review r1, 2026-11-10: such a run took an AI finding's cost away and charged nothing itself.)
 */
export function probeElements(runs: readonly ProbeRun[], okUrls: ReadonlySet<string>): AutomatedElement[] {
  const out: AutomatedElement[] = [];
  for (const run of runs) {
    if (!SCORED_PROBES.has(run.probe) || run.coverage || run.checked || !okUrls.has(run.page)) continue;
    for (const f of run.findings) {
      if (f.status !== 'failed') continue;
      const keys = probeFindingElements(f);
      if (keys.length) out.push({ page: run.page, criterion: f.criterion, keys, source: f.coveredBy ?? `criterion:${f.criterion}` });
    }
  }
  return out;
}

/** The automated elements that fail a page for a criterion, looked up in `list` (for the AI side's one cost per element). */
export function automatedAt(list: readonly AutomatedElement[]): (page: string, criterion: string) => readonly AutomatedElement[] {
  const index = byScope(list);
  return (page, criterion) => index.get(scope(page, criterion)) ?? [];
}
