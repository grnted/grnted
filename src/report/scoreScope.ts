// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What counts toward a report's score, as the scorer itself says (report v2 redesign): the report never
// writes "in the score" or "not in the score" from a literal. A kind of failure counts when the
// report's own scorer (projection.ts `failingChecks`, the scoring version the report was made with)
// turns one such failure into a failing check: asked here with a one-page sample that has exactly
// that failure and nothing else. Public what, private how: only yes or no comes out, never a weight.
// Engine core: no Node-only imports.
import { PROBES } from '../probes/registry.js';
import type { SiteReport } from '../types.js';
import { failingChecks } from './projection.js';

/** The kinds of failure whose place in the score the report talks about. */
export type ScoreKind = 'third-party' | 'media' | 'consistency' | 'deep';

const PAGE = 'https://scope.invalid/';

/** A scored, one-page report with only `extra`'s failure, made with `report`'s scoring version. */
function sample(report: Pick<SiteReport, 'meta'>, extra: Record<string, unknown>): SiteReport {
  return {
    site: PAGE, status: 'scored', score: 0, letter: 'F', headline: 'Access Denied', reasons: [],
    pages: [{ url: PAGE, status: 'ok', violations: 0 }], rules: [], testIssues: [], needsReview: [], documents: [], skipped: [],
    meta: report.meta, ...extra,
  } as unknown as SiteReport;
}

const DEEP = PROBES.find((p) => p.tier === 'deep');

function samples(kind: ScoreKind, report: Pick<SiteReport, 'meta'>): SiteReport | null {
  switch (kind) {
    case 'third-party':
      return sample(report, { thirdParty: [{ id: 'image-alt', origin: 'https://other.invalid', impact: 'critical', help: '', helpUrl: '', pagesAffected: [PAGE], elements: 1, pointsLost: 0, examples: [] }] });
    case 'media':
      return sample(report, { media: [{ kind: 'native', content: 'video', url: `${PAGE}v.mp4`, foundOn: [PAGE], issues: [{ criterion: '1.2.2', level: 'problem', rule: 'captions', message: '' }] }] });
    case 'consistency':
      return sample(report, { consistency: [{ criterion: '3.2.3', method: { id: 'consistency', kind: 'rules', status: 'failed', pages: 1 }, evidence: [{ page: PAGE, detail: '' }] }] });
    case 'deep': {
      if (!DEEP) return null;
      const criterion = DEEP.criteria[0]!;
      return sample(report, {
        probes: { runs: [{ probe: DEEP.id, kind: DEEP.kind, page: PAGE, criteria: [...DEEP.criteria], status: 'ok', ms: 1, findings: [{ criterion, status: 'failed', detail: '' }] }] },
        testIssues: [{ criterion, title: '', level: 'A', pagesAffected: [PAGE], pointsLost: 0, probes: [DEEP.id], evidence: [] }],
      });
    }
  }
}

const PREFIX: Readonly<Record<ScoreKind, string>> = { 'third-party': 'third-party:', media: 'media:', consistency: 'consistency:', deep: 'criterion:' };

/** Whether failures of `kind` count toward this report's score (its scorer's answer; false when it cannot say). */
export function countsTowardScore(report: Pick<SiteReport, 'meta'>, kind: ScoreKind): boolean {
  try {
    const s = samples(kind, report);
    return !!s && (failingChecks(s) ?? []).some((c) => c.key.startsWith(PREFIX[kind]));
  } catch {
    return false;
  }
}

/** The keys of everything that costs this report points (its failing checks), deduplicated. */
export function costKeys(report: SiteReport): Set<string> {
  try {
    return new Set((failingChecks(report) ?? []).map((c) => c.key));
  } catch {
    return new Set();
  }
}
