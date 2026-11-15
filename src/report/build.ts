// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { pickEvidence } from './pickEvidence.js';
import type { IncrementalSummary } from '../incremental/index.js';
import { CHALLENGE_PAGE } from '../challenge.js';
import { AI_NOT_RUN_NOTE, aiDocumentsCount, confirmedDocumentProblems } from '../aiScore.js';
import { axeElements, coverProbeRuns, probeElements } from '../crossDedupe.js';
import { analyzeConsistency } from '../consistency/index.js';
import { compareCriteria, probeCriteriaResults } from '../probes/criteria.js';
import { flashPrecedence } from '../probes/flashMotion.js';
import { SCORED_PROBES } from '../probes/registry.js';
import { BROWSER_LOST, isPageLost } from '../reconnect.js';
import { AXE_ENABLED_RULES, AXE_TAGS, AXE_VERSION } from '../ruleImpacts.js';
import { accessBlockers, accessGranted, pageScoresV8, scoreReportV8 } from '../criterionScore.js';
import { IMPACT_RANK, defaultImpactOf, documentOutcome, letterFor, probeChecksFrom, roundScore, scoreSite, untestedCriteria, type ImpactOf, type ProbeChecks } from '../score.js';
import type {
  AiIssueSummary, AiReport, CriterionEvidence, DocumentCheck, EvidenceShot, Finding, MediaItem, PageAudit, ProbeRun, ReportExtension, RuleSummary, ScanInventory, ScanPace, ScreenReaderSection, SiteReport,
  TestIssueSummary, ThirdPartyRuleSummary, Viewport,
} from '../types.js';
import { ENGINE_VERSION, SCORING_VERSION } from '../version.js';
import { CRITERIA, buildCriteria, type CriterionExtra } from './criteria.js';
import { collectedValue, platformCollector } from '../collect/index.js';
import { platformSummary } from '../platform.js';
import { elementSignature } from './startTag.js';
import { buildJobs, reportCoverage, ruleCauses } from './jobs.js';
import { applySecondLook } from './secondLook.js';

export { SCORED_PROBES };

export const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
/** The axe rule set (tags and rules enabled by id) is generated from scripts/axe-rule-set.mjs. */
export { AXE_ENABLED_RULES, AXE_TAGS };
/**
 * Signatures kept per rule (report v2 repetition). Batch 19: every pattern, each with an example (was 5, and the
 * patterns of one-page failures were in no output); bounded for a pathological page.
 */
export const MAX_SIGNATURES = 200;
/** Batch 19: elements kept per pattern while the scan is read, to give each pattern an example on a page of its own. */
const SIGNATURE_CANDIDATES = 12;
/** Examples per rule (the report's evidence lines). */
export const MAX_EXAMPLES = 3;

type Example = { page: string; target: string; html: string };

/**
 * Batch 19: one example per pattern, each on a page no earlier pattern's example is on when the pattern fails on one
 * (patterns in their order: most pages first).
 */
function patternExamples(order: readonly string[], candidates: ReadonlyMap<string, Example[]>): Map<string, Example> {
  const used = new Set<string>();
  const out = new Map<string, Example>();
  for (const sig of order) {
    const list = candidates.get(sig) ?? [];
    const pick = list.find((e) => !used.has(e.page)) ?? list[0];
    if (!pick) continue;
    used.add(pick.page);
    out.set(sig, pick);
  }
  return out;
}

/**
 * Batch 19: the rule's examples: different patterns on different pages first (the patterns' own examples, in their
 * order), then other patterns, then other elements on pages not yet shown, then the first elements.
 */
function diverseExamples(patterns: readonly Example[], nodes: readonly Example[]): Example[] {
  const out: Example[] = [];
  const pages = new Set<string>();
  const has = (e: Example) => out.some((o) => o.page === e.page && o.target === e.target && o.html === e.html);
  const take = (e: Example) => {
    if (out.length >= MAX_EXAMPLES || has(e)) return;
    out.push(e);
    pages.add(e.page);
  };
  for (const e of patterns) if (!pages.has(e.page)) take(e);
  for (const e of patterns) take(e);
  for (const e of nodes) if (!pages.has(e.page)) take(e);
  for (const e of nodes) take(e);
  return out;
}
/** Failing elements listed per rule for the issue list exports (report v3): page and selector only. */
export const MAX_OCCURRENCES = 500;

function summarise(
  pages: PageAudit[],
  pick: (p: PageAudit) => Finding[],
  impactOf: ImpactOf,
  pointsLost: Record<string, number>,
  withSignatures = false,
): RuleSummary[] {
  const byId = new Map<string, RuleSummary>();
  // rule id → element signature → the pages it fails on (each page once), its failing elements and a few of them.
  const sigPages = new Map<string, Map<string, { pages: Set<string>; elements: number; candidates: Example[] }>>();
  // rule id → its first failing elements (bounded), for the examples.
  const firstNodes = new Map<string, Example[]>();
  for (const page of pages) {
    for (const f of pick(page)) {
      let s = byId.get(f.id);
      if (!s) {
        s = { id: f.id, impact: impactOf(f.id), help: f.help, helpUrl: f.helpUrl, pagesAffected: [], elements: 0,
          pointsLost: pointsLost[f.id] ?? 0, examples: [] };
        byId.set(f.id, s);
      }
      if (!s.pagesAffected.includes(page.url)) s.pagesAffected.push(page.url);
      s.elements += f.nodes.length;
      const unknown = f.nodes.filter((n) => n.unknownState).length;
      if (unknown) s.unknownState = (s.unknownState ?? 0) + unknown;
      const flagged = f.nodes.filter((n) => n.flag).length;
      if (flagged) s.flagged = (s.flagged ?? 0) + flagged;
      if (f.secondLook) s.secondLook = (s.secondLook ?? 0) + f.nodes.length;
      for (const n of f.nodes) {
        const example = { page: page.url, target: n.target, html: n.html.slice(0, 300) };
        let first = firstNodes.get(f.id);
        if (!first) firstNodes.set(f.id, (first = []));
        if (first.length < MAX_OCCURRENCES) first.push(example);
        if (!withSignatures) continue;
        if ((s.occurrences ??= []).length < MAX_OCCURRENCES) s.occurrences.push({ page: page.url, target: n.target });
        const sig = elementSignature(n.html);
        if (!sig) continue;
        let bySig = sigPages.get(f.id);
        if (!bySig) sigPages.set(f.id, (bySig = new Map()));
        let on = bySig.get(sig);
        if (!on) bySig.set(sig, (on = { pages: new Set(), elements: 0, candidates: [] }));
        on.pages.add(page.url);
        on.elements++;
        // A few elements per pattern, at most one per page: its example can then be on a page of its own.
        if (on.candidates.length < SIGNATURE_CANDIDATES && !on.candidates.some((c) => c.page === page.url)) on.candidates.push(example);
      }
    }
  }
  for (const [id, bySig] of sigPages) {
    byId.get(id)!.causes = ruleCauses(pages, id);
    const sorted = [...bySig].map(([sig, on]) => ({ sig, pages: on.pages.size, elements: on.elements }))
      .sort((a, b) => b.pages - a.pages || b.elements - a.elements || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0))
      .slice(0, MAX_SIGNATURES);
    const examples = patternExamples(sorted.map((s) => s.sig), new Map([...bySig].map(([sig, on]) => [sig, on.candidates])));
    byId.get(id)!.signatures = sorted.map((s) => ({ ...s, ...(examples.has(s.sig) ? { example: examples.get(s.sig)! } : {}) }));
  }
  for (const [id, s] of byId) {
    const patterns = (s.signatures ?? []).flatMap((x) => (x.example ? [x.example] : []));
    s.examples = diverseExamples(patterns, firstNodes.get(id) ?? []);
  }
  return [...byId.values()].sort(
    (a, b) => b.pointsLost - a.pointsLost || IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || (a.id < b.id ? -1 : 1),
  );
}

/**
 * The axe rule summaries the report will have, worst first, scored on the axe results alone (the
 * evidence pass plans its images from them while the probes still run).
 */
export function ruleSummaries(pages: PageAudit[], impactOf: ImpactOf = defaultImpactOf): RuleSummary[] {
  const result = scoreSite(pages, impactOf);
  return summarise(pages.filter((p) => p.status === 'ok'), (p) => p.violations, impactOf, result.pointsLost);
}

/** The origin of a frame address ('' when it has none). */
function originOf(url: string): string {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? '' : o;
  } catch {
    return '';
  }
}

/**
 * Scoring v8: colour contrast within this share of the ratio it needs (4.05:1 of 4.5:1, 2.7:1 of 3:1) is a
 * minor failure: a page where every failing element is that close costs MINOR of the weight there.
 */
export const CONTRAST_MINOR_SHARE = 0.9;

/** axe's colour-contrast failure summary: "…contrast of 4.48 (…). Expected contrast ratio of 4.5:1". */
function contrastMinor(summary: string | undefined): boolean {
  const m = /contrast of ([\d.]+)[\s\S]*?Expected contrast ratio of ([\d.]+):1/.exec(summary ?? '');
  if (!m) return false;
  const [got, need] = [Number(m[1]), Number(m[2])];
  return Number.isFinite(got) && Number.isFinite(need) && need > 0 && got >= CONTRAST_MINOR_SHARE * need && got < need;
}

/** The pages where a rule's failure is minor (scoring v8: colour contrast only), on its summary. */
function withMinorPages(rules: RuleSummary[], ok: readonly PageAudit[]): RuleSummary[] {
  return rules.map((r) => {
    if (r.id !== 'color-contrast') return r;
    const minor = ok.filter((p) => {
      const nodes = p.violations.filter((f) => f.id === r.id).flatMap((f) => f.nodes);
      return nodes.length > 0 && nodes.every((n) => contrastMinor(n.failureSummary));
    }).map((p) => p.url);
    return minor.length ? { ...r, minorPages: minor } : r;
  });
}

/**
 * Scoring v8: the site score and every "+N if fixed" from the report's own lists (criterionScore.ts),
 * so a stored report re-scores, and projects, the same. A report with no score is returned as it is.
 */
function scoreV8Into(report: SiteReport, pages: readonly PageAudit[], impactOf: ImpactOf): SiteReport {
  if (report.status !== 'scored') return report;
  // The axe rules as the pages' outcomes give them (as v7 did; the summaries come from the same results
  // in a scan), with the summaries' minor pages.
  const summary = new Map(report.rules.map((r) => [r.id, r]));
  const failing = new Map<string, string[]>();
  for (const p of pages) {
    if (p.status !== 'ok') continue;
    for (const [id, outcome] of Object.entries(p.rules)) if (outcome === 'fail') failing.set(id, [...(failing.get(id) ?? []), p.url]);
  }
  const rulesForScore = [...failing].map(([id, urls]) => ({
    ...(summary.get(id) ?? { id, impact: impactOf(id), help: '', helpUrl: '', elements: 0, pointsLost: 0, examples: [] }), pagesAffected: urls,
  }));
  const v8 = scoreReportV8({ ...report, rules: rulesForScore });
  if (!v8) return report;
  const pts = (k: string) => v8.pointsLost.get(k) ?? 0;
  const rules = report.rules.map((r) => ({ ...r, pointsLost: pts(`rule:${r.id}`) }))
    .sort((a, b) => b.pointsLost - a.pointsLost || IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || (a.id < b.id ? -1 : 1));
  const testIssues = report.testIssues?.map((t) => ({ ...t, pointsLost: pts(`criterion:${t.criterion}`) }))
    .sort((a, b) => b.pointsLost - a.pointsLost || compareCriteria(a.criterion, b.criterion));
  const aiChecks = report.aiChecks?.ran
    ? { ...report.aiChecks, issues: report.aiChecks.issues.map((i) => ({ ...i, pointsLost: pts(i.check && i.check !== 'altText' ? `ai:${i.check}:${i.criterion}` : `ai:${i.criterion}`) }))
      .sort((a, b) => b.pointsLost - a.pointsLost || compareCriteria(a.criterion, b.criterion)) }
    : report.aiChecks;
  // Each page's score with the same rules, from that page's results alone (criterionScore.ts `pageReportFor`).
  const pageScores = pageScoresV8({ ...report, rules: rulesForScore });
  const pagesOut = report.pages.map((p) => (p.status === 'ok' && pageScores.has(p.url) ? { ...p, score: roundScore(pageScores.get(p.url)!) } : p));
  // A scored non-interference failure on any page blocks Access Granted, whatever the score.
  const blockers = accessBlockers({ ...report, rules: rulesForScore });
  const { accessBlockedBy: _stale, ...rest } = report;
  return {
    ...rest, score: v8.score, letter: letterFor(v8.score), headline: accessGranted(v8.score, blockers) ? 'Access Granted' : 'Access Denied', pages: pagesOut,
    ...(blockers.length ? { accessBlockedBy: blockers } : {}),
    rules, ...(testIssues ? { testIssues } : {}), ...(aiChecks ? { aiChecks } : {}),
    ...(report.documentScore ? { documentScore: { ...report.documentScore, pointsLost: report.documentScore.scored ? pts('documents') : 0 } } : {}),
  };
}

/** axe failures inside frames from other sites (scoring v3), per origin and rule; never scored. */
function summariseThirdParty(pages: PageAudit[], impactOf: ImpactOf): ThirdPartyRuleSummary[] {
  const byKey = new Map<string, ThirdPartyRuleSummary>();
  for (const page of pages) {
    for (const frame of page.thirdParty ?? []) {
      const origin = originOf(frame.url);
      for (const f of frame.violations) {
        const key = `${origin}\n${f.id}`;
        let s = byKey.get(key);
        if (!s) byKey.set(key, (s = { origin, id: f.id, impact: impactOf(f.id), help: f.help, helpUrl: f.helpUrl, pagesAffected: [], elements: 0, examples: [] }));
        if (!s.pagesAffected.includes(page.url)) s.pagesAffected.push(page.url);
        s.elements += f.nodes.length;
        for (const n of f.nodes) {
          if (s.examples.length < 3) s.examples.push({ page: page.url, frame: frame.url, target: n.target, html: n.html.slice(0, 300) });
        }
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Criteria the core probes failed (scoring v3), with the points each costs: one entry per criterion,
 * most points first, then criterion order.
 */
function summariseTestIssues(
  runs: readonly ProbeRun[],
  checks: ReadonlyMap<string, ProbeChecks>,
  okUrls: ReadonlySet<string>,
  pointsLost: Record<string, number>,
): TestIssueSummary[] {
  const failedOn = new Map<string, string[]>();
  for (const [url, c] of checks) {
    if (!okUrls.has(url)) continue;
    for (const [criterion, outcome] of Object.entries(c)) {
      if (outcome === 'fail') failedOn.set(criterion, [...(failedOn.get(criterion) ?? []), url]);
    }
  }
  const order = [...okUrls];
  return [...failedOn.entries()].map(([criterion, urls]) => {
    const pagesAffected = order.filter((u) => urls.includes(u));
    const failures = runs.filter((r) => SCORED_PROBES.has(r.probe) && pagesAffected.includes(r.page))
      .flatMap((r) => r.findings.filter((f) => f.criterion === criterion && f.status === 'failed' && !f.coveredBy).map((f) => ({ probe: r.probe, page: r.page, f })));
    // Batch 19: one line per page first, clear failures first, never the same line twice (src/report/pickEvidence.ts).
    const evidence: CriterionEvidence[] = pickEvidence(failures.map(({ page, f }) => ({ page, ...(f.target ? { target: f.target } : {}), detail: f.detail, ...(f.minor ? { minor: true } : {}) })), 3);
    return {
      criterion,
      title: CRITERIA.find((d) => d.criterion === criterion)?.title ?? criterion,
      probes: [...new Set(failures.map((x) => x.probe))],
      pagesAffected,
      pointsLost: pointsLost[criterion] ?? 0,
      evidence,
    };
  }).sort((a, b) => b.pointsLost - a.pointsLost || compareCriteria(a.criterion, b.criterion));
}

/** axe rules that apply only when a page has form fields (text fields, text areas, drop-down lists). */
export const FORM_FIELD_RULES = ['label', 'select-name', 'aria-input-field-name'] as const;
/** The axe rule that applies only when a page has embedded frames. */
export const FRAME_RULES = ['frame-title'] as const;

/**
 * Page features that decide which criteria apply (form criteria need form fields), read from axe
 * rule applicability: a rule whose outcome is anything but 'inapplicable' found at least one
 * element it applies to.
 */
export function scanInventory(pages: readonly PageAudit[]): ScanInventory {
  const has = (p: PageAudit, rules: readonly string[]) => rules.some((id) => p.rules[id] !== undefined && p.rules[id] !== 'inapplicable');
  const ok = pages.filter((p) => p.status === 'ok');
  return {
    formPages: ok.filter((p) => has(p, FORM_FIELD_RULES)).map((p) => p.url),
    framePages: ok.filter((p) => has(p, FRAME_RULES)).map((p) => p.url),
  };
}

/**
 * Pages that loaded in the audit but whose own load for a core test was answered with a bot challenge
 * (HTTP 202, `CHALLENGE_PAGE`): the scanner could not see the page the tests need, so the page did not
 * load (docs/scoring.md, v7), as it does when the audit's own load gets the challenge. Its axe results
 * leave the score and the enough-pages rule applies; it is never graded from part of its work.
 */
export function challengedPages(pages: readonly PageAudit[], runs: readonly ProbeRun[]): PageAudit[] {
  const challenged = new Set(runs.filter((r) => r.findings.some((f) => f.loadFailure === 'challenge')).map((r) => r.page));
  if (!challenged.size) return [...pages];
  return pages.map((p) => (p.status === 'ok' && challenged.has(p.url)
    ? { url: p.url, status: 'failed', reason: CHALLENGE_PAGE, rules: {}, violations: [], incomplete: [], links: [] }
    : p));
}

/**
 * No score while the browser closed under the scan and work could not be done again in a new one
 * (`BROWSER_LOST_PAGE` or `BROWSER_CLOSED_PAGE`, `BROWSER_LOST` on a scored core test): a score without that work could be
 * higher than the site's, so the scan is incomplete and says why.
 */
export function browserLost<R extends ReturnType<typeof scoreSite>>(result: R, pages: readonly PageAudit[], runs: readonly ProbeRun[]): R {
  // Lost after its redo (BROWSER_LOST_PAGE) or before one could run (BROWSER_CLOSED_PAGE): either way not checked.
  const lostPages = pages.filter((p) => p.status === 'failed' && isPageLost(p.reason)).length;
  // Keyed on the runner's code; a report made before the code (stored, rendered again) has only the text.
  const lostRuns = runs.filter((r) => SCORED_PROBES.has(r.probe) && r.findings.some((f) => f.loadFailure === 'browser-lost' || (f.loadFailure === undefined && f.detail === BROWSER_LOST))).length;
  if (!lostPages && !lostRuns) return result;
  const what = [
    ...(lostPages ? [`${lostPages} ${lostPages === 1 ? 'page' : 'pages'}`] : []),
    ...(lostRuns ? [`${lostRuns} automated ${lostRuns === 1 ? 'test run' : 'test runs'}`] : []),
  ].join(' and ');
  // First among the reasons: a page count that fell short because of it is not the site's doing.
  return {
    ...result, status: 'incomplete', score: null, letter: null, headline: 'Scan incomplete', pointsLost: {}, probePointsLost: {}, aiPointsLost: {}, documentPointsLost: 0,
    reasons: [`The browser the scan ran in closed, and ${what} could not be redone in a new one, so no score is given. Scanning again usually works.`, ...result.reasons],
  };
}

/**
 * The site's platform from the platform collector's facts on the first pages only (generator, markers,
 * the addresses of what the pages loaded): never page addresses, links or failing-element HTML.
 */
function platformOf(ok: readonly PageAudit[], site: string): NonNullable<SiteReport['platform']> {
  const generator: string[] = [];
  const assets: string[] = [];
  const markers: string[] = [];
  for (const p of ok) {
    const f = collectedValue(p, platformCollector);
    if (!f || typeof f !== 'object') continue;
    if (Array.isArray(f.generator)) generator.push(...f.generator);
    if (Array.isArray(f.assets)) assets.push(...f.assets);
    if (Array.isArray(f.markers)) markers.push(...f.markers);
  }
  return platformSummary({ site, generator, assets, markers });
}

/** Said when a scan left documents out of the score (scoring v7, CLI --no-document-score). */
export const DOCUMENT_SCORE_OFF = 'Documents are not in this score: the document score was turned off for this scan.';

/**
 * A page's score from its audit alone (axe, with its minor contrast pages, and the frames from other
 * sites on it), computed as the report computes page scores (scoring v8, `pageReportFor`): the live
 * scan's page-done score. The tests, media and cross-page rules come later, with the report.
 */
export function auditPageScore(page: PageAudit, impactOf?: ImpactOf): number | null {
  if (page.status !== 'ok') return null;
  const r = buildReport({ site: page.url, pages: [page], documents: [], skipped: [], startedAt: '', finishedAt: '', userAgent: '', ...(impactOf ? { impactOf } : {}) });
  return r.pages[0]?.score ?? null;
}

/** Said on a scored probe's row of a criterion no page could be tested for (scoring v6). */
export const UNTESTED_NOTE = 'Not in the score: no page could be tested for it.';

function withUntestedNote<R extends CriterionExtra>(r: R, untested: readonly string[]): R {
  if (!untested.includes(r.criterion) || !SCORED_PROBES.has(r.method.id) || r.method.status !== 'not_testable') return r;
  const note = r.method.note ? `${r.method.note.replace(/[.\s]+$/, '')}. ${UNTESTED_NOTE}` : UNTESTED_NOTE;
  return { ...r, method: { ...r.method, note } };
}

export function buildReport(input: {
  site: string;
  pages: PageAudit[];
  /** Long scans: cross-page consistency compares the first this-many pages (it is not scored). */
  consistencyPages?: number;
  documents: string[];
  /** Detection and quick PDF checks per document (scored since v7, unless `documentScore` is false). */
  documentChecks?: DocumentCheck[];
  /** Scoring v7: the checked PDFs' problems count (default true); false leaves them out of the score. */
  scoreDocuments?: boolean;
  /** Video and audio inventory with rules-based findings (unscored). */
  media?: MediaItem[];
  /** "What a screen reader hears" (unscored; `screenReaderSection`). */
  screenReader?: ScreenReaderSection;
  skipped: { url: string; reason: string }[];
  startedAt: string;
  finishedAt: string;
  userAgent: string;
  impactOf?: ImpactOf;
  /** The AI review, if one ran: reported and scored only with `extension`, else left out (the open engine has none). */
  ai?: AiReport;
  /** The closed AI package's scoring of `ai` (`AiScanPlan.report`, `ReportExtension`). */
  extension?: ReportExtension;
  /** Results of other automated methods (probes) for the criteria table; see `buildCriteria`. */
  criteriaExtra?: readonly CriterionExtra[];
  /**
   * Probe runs (Plan 4), in runner order. The core probes' (`SCORED_PROBES`) failed results are
   * failing checks (scoring v4, share over the pages they tested); deep probes are reported only.
   */
  probeRuns?: ProbeRun[];
  /** Evidence images (report v2): metadata only, from the scan's evidence recorder. */
  evidence?: EvidenceShot[];
  /** Rule pictures the evidence pass could not take, and why. */
  evidenceMissed?: { rule: string; page: string; reason: string }[];
  /** How the scan slowed down for the site (absent when it did not). */
  pace?: ScanPace;
  /** Monitoring scans (docs/monitoring.md): pages checked again and pages carried forward unchanged. */
  incremental?: IncrementalSummary;
  /** Work after the pages that was stopped or skipped for want of time (`SiteReport.notChecked`). */
  notChecked?: SiteReport['notChecked'];
}): SiteReport {
  // 2.3.1: where the frames of the screen decided a page, the animation and media check gives way.
  if (input.probeRuns) input = { ...input, probeRuns: flashPrecedence(input.probeRuns) };
  // The review's second look: the failures the closed AI package moves to Needs review (`ReportExtension.demotions`,
  // src/report/secondLook.ts), before anything is scored. Without the package, or without a second look, none move.
  const demoted = input.ai && input.extension?.demotions ? input.extension.demotions(input.ai) : [];
  if (demoted.length) input = applySecondLook(input, demoted);
  const impactOf = input.impactOf ?? defaultImpactOf;
  // A page a core test's own load found to be a bot challenge (HTTP 202) did not load (v7).
  const pages = challengedPages(input.pages, input.probeRuns ?? []);
  const ok = pages.filter((p) => p.status === 'ok');
  // One problem and one cost per element across methods (src/crossDedupe.ts): a test's failure of an element
  // an axe rule fails for the same criterion is listed with the rule; an AI finding of an element axe or a
  // scored test fails is listed with that problem.
  const axe = axeElements(ok);
  if (input.probeRuns) input = { ...input, probeRuns: coverProbeRuns(input.probeRuns, axe) };
  const checks = probeChecksFrom(input.probeRuns ?? [], (id) => SCORED_PROBES.has(id));
  // The AI review counts as the closed package that ran it says (`ReportExtension`): which confirmed answers count,
  // their weights, one cost per element (an AI finding of an element an automated method fails counts there). Without
  // the package there is no review in the report and nothing of it is scored.
  const scoredAi = input.ai && input.extension
    ? input.extension.score({ ai: input.ai, pages: ok.map((p) => p.url), automated: [...axe, ...probeElements(input.probeRuns ?? [], new Set(ok.map((p) => p.url)))], scoring: SCORING_VERSION })
    : undefined;
  const ai = scoredAi?.ai;
  // Scoring v7: the checked PDFs with a problem, one check (unless the caller turned it off).
  // Scoring v10: a checked PDF with a confirmed AI document problem fails too.
  const docs = documentOutcome(input.documentChecks, ai && aiDocumentsCount(SCORING_VERSION) ? confirmedDocumentProblems(ai) : undefined);
  const docsScored = input.scoreDocuments !== false;
  // The scoring v8 pass below (`scoreV8Into`) sets the score and every "+N if fixed", the AI review's included.
  const result = browserLost(scoreSite(pages, impactOf, checks, [], docsScored ? docs : null), pages, input.probeRuns ?? []);
  const aiIssues: AiIssueSummary[] = scoredAi?.ran ? scoredAi.issues.map((i) => ({ ...i, pointsLost: 0 })) : [];
  const thirdParty = summariseThirdParty(ok, impactOf);
  // Scoring v6: scored criteria no loaded page could be tested for (not in the score; the table says so).
  const untested = untestedCriteria(ok, checks);
  const report: SiteReport = {
    schemaVersion: 2,
    site: input.site,
    status: result.status,
    score: result.score,
    letter: result.letter,
    headline: result.headline,
    reasons: result.reasons,
    pages: pages.map((p) => {
      const s = result.pageScores.get(p.url);
      return {
        url: p.url,
        status: p.status,
        score: s == null ? null : roundScore(s),
        violations: p.violations.reduce((n, f) => n + f.nodes.length, 0),
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.untestedFrames?.length ? { untestedFrames: p.untestedFrames } : {}),
        ...(p.animationsUnsettled ? { animationsUnsettled: true as const } : {}),
        ...(p.unchangedSince ? { unchangedSince: p.unchangedSince } : {}),
      };
    }),
    rules: withMinorPages(summarise(ok, (p) => p.violations, impactOf, result.pointsLost, true), ok),
    ...(input.probeRuns ? { testIssues: summariseTestIssues(input.probeRuns, checks, new Set(ok.map((p) => p.url)), result.probePointsLost) } : {}),
    ...(untested.length ? { untestedCriteria: untested } : {}),
    needsReview: summarise(ok, (p) => p.incomplete, impactOf, {}).map((r) => ({ ...r, pointsLost: 0 })),
    ...(thirdParty.length ? { thirdParty } : {}),
    documents: [...input.documents].sort(),
    ...(input.documentChecks ? { documentChecks: [...input.documentChecks].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)) } : {}),
    platform: platformOf(ok, input.site),
    documentScore: docsScored
      ? { scored: true, checked: docs.checked, failed: docs.failed, pointsLost: result.documentPointsLost }
      : { scored: false, checked: docs.checked, failed: docs.failed, pointsLost: 0, note: DOCUMENT_SCORE_OFF },
    ...(input.media ? { media: input.media } : {}),
    ...(input.screenReader?.pages.length ? { screenReader: input.screenReader } : {}),
    inventory: scanInventory(ok),
    skipped: input.skipped,
    ...(ai ? { ai } : {}),
    aiChecks: scoredAi?.ran
      ? { ran: true, issues: aiIssues, gates: scoredAi.gates }
      : { ran: false, issues: [], note: AI_NOT_RUN_NOTE, ...(scoredAi ? { gates: scoredAi.gates } : {}) },
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.evidenceMissed?.length ? { evidenceMissed: input.evidenceMissed } : {}),
    ...(input.probeRuns ? { probes: { runs: input.probeRuns } } : {}),
    ...(input.pace ? { pace: input.pace } : {}),
    ...(input.incremental ? { incremental: input.incremental } : {}),
    ...(input.notChecked?.length ? { notChecked: input.notChecked.map((x) => ({ ...x })) } : {}),
    meta: {
      engine: ENGINE_VERSION,
      axe: AXE_VERSION,
      scoring: SCORING_VERSION,
      viewports: VIEWPORTS,
      tags: [...AXE_TAGS],
      enabledRules: [...AXE_ENABLED_RULES],
      userAgent: input.userAgent,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      pageList: input.pages.map((p) => p.url),
    },
  };
  // The criteria table is derived from everything above; it sits before `meta` in the JSON.
  const { meta, ...rest } = report;
  // Probe results join the criteria table as automated methods (interaction, render, pixels).
  const extra = [...(input.criteriaExtra ?? []), ...(input.probeRuns ? probeCriteriaResults(input.probeRuns).map((r) => withUntestedNote(r, untested)) : [])];
  // The cross-page comparison rules, from the pages' collected facts (unscored); the criteria table
  // reads them from the report, so an older report still renders the same.
  const withConsistency: SiteReport = scoreV8Into({ ...rest, consistency: analyzeConsistency(input.consistencyPages !== undefined ? input.pages.slice(0, input.consistencyPages) : input.pages, input.site).results, meta }, pages, impactOf);
  const { meta: _meta, ...body } = withConsistency;
  const complete: SiteReport = { ...body, criteria: buildCriteria(withConsistency, extra), meta };
  return { ...complete, repair: buildJobs(complete), coverage: reportCoverage(complete) };
}
