// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The scoring formula (docs/scoring.md, SCORING_VERSION v7). Engine core: no Node-only imports.
//
//   total      = Σ over failing checks c of w(c) × √share(c)
//   site score = round(100 − FORMULA_SCALE × ln(1 + total ÷ FORMULA_KNEE)), clamped to 0..100
//
// A failing check is site-level: an axe rule that failed on at least one page that loaded, a WCAG
// criterion a scored core probe failed on at least one page, or (v5) an AI-reviewed image check with a
// confirmed failure, or (v7) the documents check: checked PDFs with a quick-check problem. Diminishing
// returns: each further problem costs fewer points. The documents check is one check (share at most 1),
// so documents alone cost at most its weight.
import { officeProblems } from './documents/office.js';
import { pdfCriteria } from './documents/pdf.js';
import { compareCriteria, worstStatus } from './probes/criteria.js';
import { RULE_IMPACTS } from './ruleImpacts.js';
import { combineChecks, combineCriteria, roundScore, ruleCriterion, ruleWeight, type CriterionCost, type WeightedCheck } from './scoreCore.js';
import type { AiCheckId, CriterionStatus, DocumentCheck, Impact, PageAudit, ProbeRun, RuleOutcome, SiteReport } from './types.js';

export { GROUP_WEIGHTS, RULE_GROUPS, ruleGroupOf, type RuleGroup } from './ruleGroups.js';
export {
  FORMULA_KNEE, FORMULA_SCALE, IN_CRITERION, RULE_WEIGHT_FACTORS, axeSiteScore, checksTotal, combineChecks, combineCriteria, criterionTotal, roundScore, ruleCriterion, ruleWeight,
  type AxePageResult, type CriterionCost, type WeightedCheck,
} from './scoreCore.js';

/**
 * Order of axe impacts, worst first, for sorting lists (rules, problems, wireframe hits). Not a score
 * weight: since scoring v4 the weight comes from the rule's group (`ruleWeight`).
 */
export const IMPACT_RANK: Readonly<Record<Impact, number>> = { critical: 4, serious: 3, moderate: 2, minor: 1 };

/** Weight of one failing core probe criterion, every core test alike (headings and overlays included). */
export const PROBE_CHECK_WEIGHT = 4;

/**
 * Per-criterion weights that replace PROBE_CHECK_WEIGHT (scoring v8, fitted to the gold standard's
 * declared severity order; docs/scoring.md, "Scoring v8").
 */
export const PROBE_WEIGHT_OVERRIDES: Readonly<Record<string, number>> = Object.freeze({
  '2.1.2': 15.25, '2.1.1': 9, // blockers: a keyboard trap, a control keyboard users cannot use
  // Blocker: flashing that can cause seizures. 10 since the 2026-11-04 gold run that showed its severity
  // had rested on the motion test also seeing the flashing (a "may also" result, not always there).
  '2.3.1': 10,
  // Blocker: sound that plays by itself. The listening test carries the same weight as the media rule
  // (MEDIA_WEIGHTS): they judge one failure (a one-verdict criterion), and the method that hears it is
  // never the cheap one.
  '1.4.2': 14,
  // Blocker: a video with speech and no captions, shown by measuring its sound and its picture (the media-files
  // test, scoring v13). The media rules' weight for the same failure (MEDIA_WEIGHTS): a one-verdict criterion.
  '1.2.2': 5,
  '1.4.3': 6.75, '2.2.2': 5, '2.4.7': 4.75, '3.3.2': 4.75, '1.4.1': 3.5, // serious
  '1.3.5': 1, // minor: autofill
});

/**
 * Weight of each AI-reviewed image check (scoring v5), by criterion: 1.1.1 "information only in a
 * picture" and 1.4.5 "pictures of text", at half the weight of the matching automated check (visible 9,
 * core test 4): the weight the calibration panel chose for AI findings.
 */
export const AI_CHECK_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({ '1.1.1': 4.5, '1.4.5': 2 });

/**
 * Weight of the documents check (scoring v7): checked PDFs with a quick-check problem. The weight of a
 * core test criterion, the weight that fitted the calibration panel best without making it worse
 * (docs/scoring.md, "Calibration"). One check however many PDFs fail: documents alone cost at most this
 * much of the total (a site whose only problems are its documents scores 94, Access Granted).
 */
export const DOCUMENT_CHECK_WEIGHT = 4;

/**
 * The documents check's input (scoring v7): the documents it counts (`checked`), those that fail
 * (`failed`, minor ones included) and, of those, the minor ones (`minor`, scoring v8). See `documentOutcome`.
 */
export interface DocumentOutcome {
  checked: number;
  failed: number;
  minor: number;
}

/**
 * One document's part in the documents check (`documentStanding`): not counted, clean, a minor failure
 * (scoring v8: its only problem is its title) or a failure.
 */
export type DocumentStanding = 'not_counted' | 'clean' | 'minor' | 'failed';

/** The criterion of a PDF's title problems, the documents check's only minor one (scoring v8). */
const TITLE_ONLY_CRITERION = '2.4.2';

/**
 * The documents check's one rule, for every kind of document it counts (scoring v7 to v10). Today that is
 * a PDF the quick checks read (`checks` present, including a PDF that needs a password, which fails) and,
 * since v10, a Word, Excel or PowerPoint file they read (`officeChecks`, rules below); a new kind of
 * document joins the check here, and only here. A counted PDF:
 * - fails when a quick check found a problem other than its title (`pdfCriteria`), or (scoring v10) the AI
 *   document review confirmed a problem in it (`confirmed`: the confirmed problems by address, empty for
 *   a report scored with v9 or earlier; `reportDocumentProblems` in src/aiScore.ts);
 * - is a minor failure when its only problems are its title (none, or the reader is told to show the file
 *   name) and nothing was confirmed in it;
 * - is clean otherwise.
 * Documents that could not be read or were not checked, and other file types, are not counted.
 */
export function documentStanding(d: DocumentCheck | undefined, confirmed?: ReadonlyMap<string, unknown>): DocumentStanding {
  // Scoring v10: a Word, Excel or PowerPoint file the quick checks read fails on one of the five problem findings
  // (`officeProblems`: password, alt, tableHeader, slideTitle, language, title; hints never count), is a minor
  // failure when its title is its only problem, and is clean otherwise. A file over the Office cap, a legacy,
  // unreadable or unread one has no `officeChecks` and is not counted. (A report scored before v10 never hands
  // its Office files here: `countedDocuments` in src/documents/officeScore.ts.)
  if (d && d.type !== 'pdf' && d.officeChecks && typeof d.officeChecks === 'object') {
    const found = officeProblems(d.officeChecks);
    if (!found.length) return 'clean';
    return found.every((f) => f.key === 'title') ? 'minor' : 'failed';
  }
  if (!d || d.type !== 'pdf' || !d.checks) return 'not_counted';
  if (confirmed?.has(d.url)) return 'failed';
  const criteria = pdfCriteria(d.checks);
  if (!criteria.length) return 'clean';
  return criteria.every((c) => c === TITLE_ONLY_CRITERION) ? 'minor' : 'failed';
}

/**
 * The criteria one counted document fails, by the same rule as `documentStanding`: its quick checks'
 * (`pdfCriteria`) and (scoring v10) those the AI document review confirmed in it. [] for a document the
 * check does not count. The conformance table and EN 301 549 clause 10 rate each criterion by these.
 */
export function documentCriteria(d: DocumentCheck | undefined, confirmed?: ReadonlyMap<string, { readonly criteria: readonly string[] }>): string[] {
  if (!d?.checks || documentStanding(d, confirmed) === 'not_counted') return [];
  return [...new Set([...pdfCriteria(d.checks), ...(confirmed?.get(d.url)?.criteria ?? [])])];
}

/**
 * The documents check's input from the document inventory: every document's `documentStanding`, counted.
 * `failed` includes the minor failures (the v7 share counts them in full; v8 at the minor factor).
 */
export function documentOutcome(checks: readonly DocumentCheck[] | undefined, confirmed?: ReadonlyMap<string, unknown>): DocumentOutcome {
  const out: DocumentOutcome = { checked: 0, failed: 0, minor: 0 };
  for (const d of checks ?? []) {
    const standing = documentStanding(d, confirmed);
    if (standing === 'not_counted') continue;
    out.checked++;
    if (standing === 'clean') continue;
    out.failed++;
    if (standing === 'minor') out.minor++;
  }
  return out;
}

/**
 * One AI-reviewed image check's result over the site (scoring v5): pages with a confirmed failing image,
 * and pages with at least one image the AI answered for (the share's denominator; the closed AI package counts them).
 */
export interface AiCheckOutcome {
  /** The AI check (v8; absent: altText). */
  check?: AiCheckId;
  criterion: string;
  failedPages: number;
  testedPages: number;
}

/**
 * One page's core probe results by criterion (scoring v4, 'untested' since v6): 'fail' (a scored probe
 * found it failed), 'pass' (the scored probes found no failures), 'ran' (a scored probe tested it there
 * with another result: flagged, not applicable, or not testable while another scored probe tested it),
 * 'untested' (every scored result for it there is not testable: the run timed out or broke, the
 * browser closed, the time box ran out). Only 'fail' costs points; 'pass' and 'fail' make a page's
 * score applicable; every entry but 'untested' counts toward the criterion's share denominator (v6).
 */
export type ProbeOutcome = 'pass' | 'fail' | 'ran' | 'untested';
export type ProbeChecks = Readonly<Record<string, ProbeOutcome>>;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Core probe results per page, from the probe runs. A criterion's status on a page is the worst over
 * the scored probes' findings for it there (a scored probe that ran and found nothing for it counts as
 * no failures found): failed → 'fail', no_failures_found → 'pass', not testable by every scored probe
 * that ran for it there → 'untested' (scoring v6), anything else → 'ran'. Runs of other probes (deep,
 * custom) are ignored.
 */
/**
 * Tests that only ever prove a failure (scoring v13): the media-files test fails a video for missing captions
 * when it has shown speech, no captions of any kind and a picture that cannot carry them. Any other result of
 * such a test says the failure was not shown, not that the page was tested and passed: it counts for nothing
 * in the score (it neither clears the page for a one-verdict criterion nor joins a share), and the report
 * still lists it.
 */
export const PROOF_ONLY_PROBES: ReadonlySet<string> = new Set(['media-files']);

export function probeChecksFrom(runs: readonly ProbeRun[], scored: (probeId: string) => boolean): Map<string, Record<string, ProbeOutcome>> {
  const statuses = new Map<string, Map<string, CriterionStatus>>();
  // page → criteria some scored probe tested there (a result other than not testable).
  const testedOn = new Map<string, Set<string>>();
  for (const run of runs) {
    // A coverage run (`ProbeRun.coverage`) is a test, or a targeted check (`ProbeRun.checked`), on a page
    // scoring v10 did not run the test on: what it measured is listed there and counts in the WCAG table,
    // never in the score until a scoring version is calibrated with it (its shares stay over the pages v10 tested).
    if (!scored(run.probe) || run.coverage || run.checked) continue;
    let byCriterion = statuses.get(run.page);
    if (!byCriterion) statuses.set(run.page, (byCriterion = new Map()));
    let tested = testedOn.get(run.page);
    if (!tested) testedOn.set(run.page, (tested = new Set()));
    for (const criterion of run.criteria) {
      // A failure an axe rule already counts for the same element (`coveredBy`) is not this test's to count.
      const found = run.findings.filter((f) => f.criterion === criterion && !f.coveredBy).map((f) => f.status);
      const status = found.length ? worstStatus(found) : 'no_failures_found';
      if (PROOF_ONLY_PROBES.has(run.probe) && status !== 'failed') continue;
      if (status !== 'not_testable') tested.add(criterion);
      const prev = byCriterion.get(criterion);
      byCriterion.set(criterion, prev ? worstStatus([prev, status]) : status);
    }
  }
  const out = new Map<string, Record<string, ProbeOutcome>>();
  for (const [page, byCriterion] of statuses) {
    const checks: Record<string, ProbeOutcome> = {};
    for (const [criterion, status] of [...byCriterion.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      checks[criterion] = status === 'failed' ? 'fail' : status === 'no_failures_found' ? 'pass' : testedOn.get(page)!.has(criterion) ? 'ran' : 'untested';
    }
    if (Object.keys(checks).length) out.set(page, checks);
  }
  return out;
}

export type ImpactOf = (ruleId: string) => Impact;
export const defaultImpactOf: ImpactOf = (id) => (own(RULE_IMPACTS, id) ? RULE_IMPACTS[id]! : 'moderate');

/** A failing core probe criterion's weight: PROBE_CHECK_WEIGHT unless overridden. */
export function probeWeight(criterion: string): number {
  return own(PROBE_WEIGHT_OVERRIDES, criterion) ? PROBE_WEIGHT_OVERRIDES[criterion]! : PROBE_CHECK_WEIGHT;
}

/**
 * Scored criteria a core test ran for on the pages that loaded but could test on none of them
 * (scoring v6): they cost nothing, and the report says they are not in the score. Criterion order.
 */
export function untestedCriteria(pages: readonly PageAudit[], probes: ProbeCheckMap): string[] {
  const seen = new Set<string>();
  const tested = new Set<string>();
  for (const p of pages) {
    if (p.status !== 'ok') continue;
    for (const [criterion, outcome] of Object.entries(probes.get(p.url) ?? {})) {
      seen.add(criterion);
      if (outcome !== 'untested') tested.add(criterion);
    }
  }
  return [...seen].filter((c) => !tested.has(c)).sort(compareCriteria);
}

/**
 * A page's score (scoring v5): the formula applied to that page alone, so each check that failed on it
 * counts at share 1. Applicable checks are the axe rules that passed or failed and the core probe
 * criteria with a 'pass' or 'fail' result; null when there are none. Unrounded.
 */
export function pageScore(rules: Record<string, RuleOutcome>, impactOf: ImpactOf = defaultImpactOf, probes: ProbeChecks = {}): number | null {
  let applicable = false;
  const failing: CriterionCost[] = [];
  for (const id of Object.keys(rules).sort()) {
    const outcome = rules[id];
    if (outcome !== 'pass' && outcome !== 'fail') continue;
    applicable = true;
    if (outcome === 'fail') failing.push({ criterion: ruleCriterion(id), weight: ruleWeight(id, impactOf(id)), share: 1 });
  }
  for (const criterion of Object.keys(probes).sort()) {
    const outcome = probes[criterion];
    if (outcome !== 'pass' && outcome !== 'fail') continue;
    applicable = true;
    if (outcome === 'fail') failing.push({ criterion, weight: probeWeight(criterion), share: 1 });
  }
  // Scoring v8: one combined cost per criterion (combineCriteria).
  return applicable ? combineCriteria(failing) : null;
}

export function letterFor(score: number): NonNullable<SiteReport['letter']> {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

type ProbeCheckMap = ReadonlyMap<string, ProbeChecks>;
const NO_CHECKS: ProbeCheckMap = new Map();

interface SiteCheck extends WeightedCheck {
  kind: 'rule' | 'criterion' | 'ai' | 'documents';
  id: string;
}

/** The AI checks that failed (scoring v5), in criterion order; a criterion with no weight never counts. */
function aiSiteChecks(ai: readonly AiCheckOutcome[]): SiteCheck[] {
  return ai.filter((o) => own(AI_CHECK_WEIGHTS, o.criterion) && o.failedPages > 0 && o.testedPages > 0)
    .map((o): SiteCheck => ({ kind: 'ai', id: o.criterion, weight: AI_CHECK_WEIGHTS[o.criterion]!, share: Math.min(1, o.failedPages / o.testedPages) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The site's failing checks, in a fixed order (rules by id, then criteria by id) so the total never
 * depends on page or rule order (floating-point sums are order-sensitive in the last bit).
 * - An axe rule's share: pages that loaded where it failed ÷ pages that loaded.
 * - A core probe criterion's share: pages where it failed ÷ pages where a scored core probe tested it
 *   (any result but 'untested': scoring v6 leaves out pages where it could not be tested), per
 *   criterion: the every-page probes' criteria (headings, text contrast) count every page that loaded,
 *   the others the template-sample pages they were tested on.
 */
function siteChecks(ok: readonly PageAudit[], impactOf: ImpactOf, probes: ProbeCheckMap): SiteCheck[] {
  const ruleFails = new Map<string, number>();
  for (const p of ok) {
    for (const [id, outcome] of Object.entries(p.rules)) if (outcome === 'fail') ruleFails.set(id, (ruleFails.get(id) ?? 0) + 1);
  }
  const tested = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const p of ok) {
    const checks = probes.get(p.url);
    if (!checks) continue;
    for (const [criterion, outcome] of Object.entries(checks)) {
      if (outcome === 'untested') continue;
      tested.set(criterion, (tested.get(criterion) ?? 0) + 1);
      if (outcome === 'fail') failed.set(criterion, (failed.get(criterion) ?? 0) + 1);
    }
  }
  const byId = <T>(a: [string, T], b: [string, T]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return [
    ...[...ruleFails].sort(byId).map(([id, n]): SiteCheck => ({ kind: 'rule', id, weight: ruleWeight(id, impactOf(id)), share: n / ok.length })),
    ...[...failed].sort(byId).map(([id, n]): SiteCheck => ({ kind: 'criterion', id, weight: probeWeight(id), share: n / tested.get(id)! })),
  ];
}

export interface ScoreResult {
  status: SiteReport['status'];
  score: number | null;
  letter: SiteReport['letter'];
  headline: SiteReport['headline'];
  reasons: string[];
  /** Each page's score (`pageScore`, unrounded; null for a page that did not load or had nothing applicable). */
  pageScores: Map<string, number | null>;
  /** rule id → points the site gains if that rule is fixed on every page. */
  pointsLost: Record<string, number>;
  /** criterion → points the site gains if no core probe fails it on any page. */
  probePointsLost: Record<string, number>;
  /** criterion → points the site gains if the AI image check for it found no failure (scoring v5). */
  aiPointsLost: Record<string, number>;
  /** Points the site gains if no checked PDF had a problem (scoring v7); 0 when documents cost nothing. */
  documentPointsLost: number;
}

/** The documents check (scoring v7), when a checked PDF has a problem. */
function documentSiteChecks(d: Pick<DocumentOutcome, 'checked' | 'failed'> | null | undefined): SiteCheck[] {
  if (!d || !(d.checked > 0) || !(d.failed > 0)) return [];
  return [{ kind: 'documents', id: 'documents', weight: DOCUMENT_CHECK_WEIGHT, share: Math.min(1, d.failed / d.checked) }];
}

/**
 * The site's score. `probes`: each page's core probe results by page address (`probeChecksFrom`);
 * pages without an entry are scored on their axe rules alone. `ai`: the AI-reviewed image checks
 * (scoring v5, `aiImageChecks`); none when the AI review did not run. Page scores never include them
 * (the AI reviews a sample of images, not every page). `documents`: the documents check (scoring v7,
 * `documentOutcome`); none leaves documents out (the CLI's --no-document-score). Page scores never
 * include it either (a PDF is not a page).
 */
/**
 * The minimum for a score: at least half of the pages checked loaded, and at least 3 of them when 3 or
 * more were checked. The one rule, used by the score and by a host that decides from stored pages
 * whether a scan that ran out of time can still be scored (docs/scoring.md).
 */
export function minimumPagesLoaded(checked: number): number {
  return Math.max(Math.ceil(checked / 2), checked >= 3 ? 3 : 0);
}

export const enoughPagesLoaded = (loaded: number, checked: number): boolean => checked > 0 && loaded >= minimumPagesLoaded(checked);

export function scoreSite(
  pages: PageAudit[], impactOf: ImpactOf = defaultImpactOf, probes: ProbeCheckMap = NO_CHECKS, ai: readonly AiCheckOutcome[] = [],
  documents: Pick<DocumentOutcome, 'checked' | 'failed'> | null = null,
): ScoreResult {
  const ok = pages.filter((p) => p.status === 'ok');
  const pageScores = new Map(pages.map((p) => [p.url, p.status === 'ok' ? pageScore(p.rules, impactOf, probes.get(p.url)) : null]));
  const incomplete = (reason: string): ScoreResult => ({
    status: 'incomplete', score: null, letter: null, headline: 'Scan incomplete',
    reasons: [reason], pageScores, pointsLost: {}, probePointsLost: {}, aiPointsLost: {}, documentPointsLost: 0,
  });

  const selected = pages.length;
  if (selected === 0) return incomplete('No pages could be selected for scanning.');
  if (!enoughPagesLoaded(ok.length, selected)) {
    return incomplete(`Only ${ok.length} of ${selected} ${selected === 1 ? 'page' : 'pages'} loaded, too few for a reliable score.`);
  }
  if (!ok.some((p) => pageScores.get(p.url) != null)) return incomplete('No accessibility rules applied to the pages that loaded.');

  const checks = [...siteChecks(ok, impactOf, probes), ...aiSiteChecks(ai), ...documentSiteChecks(documents)];
  const score = roundScore(combineChecks(checks));
  // "+N if fixed": the score with that one check gone, minus the score.
  const pointsLost: Record<string, number> = {};
  const probePointsLost: Record<string, number> = {};
  const aiPointsLost: Record<string, number> = {};
  let documentPointsLost = 0;
  checks.forEach((c, i) => {
    const gain = roundScore(combineChecks(checks.filter((_, j) => j !== i))) - score;
    if (c.kind === 'rule') pointsLost[c.id] = gain;
    else if (c.kind === 'criterion') probePointsLost[c.id] = gain;
    else if (c.kind === 'ai') aiPointsLost[c.id] = gain;
    else documentPointsLost = gain;
  });

  return {
    status: 'scored',
    score,
    letter: letterFor(score),
    headline: score >= 90 ? 'Access Granted' : 'Access Denied',
    reasons: [],
    pageScores,
    pointsLost,
    probePointsLost,
    aiPointsLost,
    documentPointsLost,
  };
}
