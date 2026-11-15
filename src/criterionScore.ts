// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v8 (docs/scoring.md): one combined result per WCAG criterion from every scored method, read
// from the report itself, so the report's score, its "+N if fixed", the projection and any re-scoring
// of a stored report are one computation. Engine core: no Node-only imports.
//
//   cost(criterion) = the largest w × √share among its failing checks
//                     + IN_CRITERION × (the sum of the others)
//   total           = Σ cost(criterion)          (documents: one check of their own, as in v7)
//   site score      = round(100 − FORMULA_SCALE × ln(1 + total ÷ FORMULA_KNEE))
//
// A failing check is one method's failure of one criterion over the site: an axe rule (under its first
// criterion), a scored test's criterion, a third-party frame's axe rule (reduced weight), a cross-page
// rule, a media rule, a gated AI check's confirmed answers, the documents check. Its share is the pages
// it failed on over the pages it tested. A "minor" failure (axe colour contrast within 10% of the
// threshold on every failing element of a page; a required field whose only problem is that nothing
// says it is required) costs MINOR_FACTOR of its weight on that page.
import { reportDocumentProblems } from './aiScore.js';
import { LEGACY_AI_WEIGHTS } from './aiLegacy.js';
import { SCORED_PROBES } from './probes/registry.js';
import { CONSISTENCY_WEIGHTS, MEDIA_WEIGHTS, MINOR_FACTOR, NON_INTERFERENCE_CRITERIA, ONE_VERDICT_CRITERIA, THIRD_PARTY_FACTOR, combineCriteria, criterionTotal as coreTotal, IN_CRITERION, roundScore, ruleCriterion, ruleWeight } from './scoreCore.js';
import { DOCUMENT_CHECK_WEIGHT, PROBE_CHECK_WEIGHT, PROBE_WEIGHT_OVERRIDES, documentOutcome, probeChecksFrom } from './score.js';
import { CRITERIA } from './report/criteria.js';
import { countedDocuments } from './documents/officeScore.js';
import type { AccessBlocker, AiCheckId, Impact, SiteReport } from './types.js';

/** One failing check of the site, under the criterion it fails. */
export interface CriterionCheck {
  /** 'rule:<id>', 'criterion:<n>', 'third-party:<id>', 'consistency:<n>', 'media:<n>', 'ai:<n>' (altText), 'ai:<check>:<n>', 'documents'. */
  key: string;
  /** WCAG criterion ('documents' for the documents check). */
  criterion: string;
  weight: number;
  share: number;
  /** Only minor failures (its weight is already MINOR_FACTOR of the check's). A key has one check. */
  minor?: true;
  /** `ONE_VERDICT_CRITERIA` only: the pages it fails on, and the criterion's judged pages (scoreCore `CriterionCost`). */
  pages?: string[];
  of?: number;
}

/** Scoring v8's weights and constants (docs/scoring.md, "Scoring v8"). */
export interface V8Params {
  /** Share of each further failing check's cost within one criterion (0: only the worst counts). */
  inCriterion: number;
  /** Weight per scored test criterion (core and deep tests); others weigh `probeDefault`. */
  probe: Readonly<Record<string, number>>;
  probeDefault: number;
  /** Multiplier per axe rule on its group weight (absent: 1). */
  ruleFactor: Readonly<Record<string, number>>;
  /** Third-party frames: a rule's weight times this. */
  thirdParty: number;
  /** Cross-page rules, per criterion. */
  consistency: Readonly<Record<string, number>>;
  /** Media rules, per criterion. */
  media: Readonly<Record<string, number>>;
  /**
   * A failing AI check's weight when the report does not carry one (`AiIssueSummary.weight`: a report made before the
   * AI engine left the open engine), per check and criterion (src/aiLegacy.ts).
   */
  ai: Readonly<Partial<Record<AiCheckId, Readonly<Record<string, number>>>>>;
  /** The documents check (one check, as in v7). */
  documents: number;
  /** A minor failure's share of the weight. */
  minor: number;
}

export { CONSISTENCY_WEIGHTS, MEDIA_WEIGHTS, MINOR_FACTOR, NON_INTERFERENCE_CRITERIA, THIRD_PARTY_FACTOR } from './scoreCore.js';

export const V8: V8Params = Object.freeze({
  inCriterion: IN_CRITERION,
  probe: PROBE_WEIGHT_OVERRIDES,
  probeDefault: PROBE_CHECK_WEIGHT,
  ruleFactor: Object.freeze({}),
  thirdParty: THIRD_PARTY_FACTOR,
  consistency: CONSISTENCY_WEIGHTS,
  media: MEDIA_WEIGHTS,
  ai: LEGACY_AI_WEIGHTS,
  documents: DOCUMENT_CHECK_WEIGHT,
  minor: MINOR_FACTOR,
});

/** axe rule → its first WCAG criterion (the criterion its failure counts under). */
export const primaryCriterion = ruleCriterion;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const byKey = (a: CriterionCheck, b: CriterionCheck) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.weight - b.weight || a.share - b.share;

/**
 * One check for a key whose failures are `full` full and `minor` minor out of `n`. Only full: weight w,
 * share full ÷ n. Only minor: weight w × minorFactor, share minor ÷ n (flagged minor). Both: ONE check
 * of weight w whose cost is the two parts' costs added, w × (√(full ÷ n) + minorFactor × √(minor ÷ n)),
 * never more than w: share = min(1, (√(full ÷ n) + minorFactor × √(minor ÷ n))²). So no key ever costs
 * more than its weight, the same as a key that fails everywhere in full.
 */
export function withMinor(key: string, criterion: string, w: number, minorFactor: number, full: number, minor: number, n: number): CriterionCheck | null {
  if (!(n > 0) || (!(full > 0) && !(minor > 0))) return null;
  const a = Math.min(1, Math.max(0, full) / n);
  const b = Math.min(1, Math.max(0, minor) / n);
  if (!(b > 0)) return { key, criterion, weight: w, share: a };
  if (!(a > 0)) return { key, criterion, weight: w * minorFactor, share: b, minor: true };
  return { key, criterion, weight: w, share: Math.min(1, (Math.sqrt(a) + minorFactor * Math.sqrt(b)) ** 2) };
}

/** Σ over criteria of (largest cost + inCriterion × the others), in a fixed order (scoreCore). */
export function criterionTotal(checks: readonly CriterionCheck[], inCriterion = IN_CRITERION): number {
  return coreTotal(checks, inCriterion);
}

/** The unrounded score from the failing checks (100 with none), clamped to 0..100. */
export function criterionScore(checks: readonly CriterionCheck[], p: V8Params = V8): number {
  return combineCriteria(checks, p.inCriterion);
}

/** Weight of a scored test criterion. */
export function v8ProbeWeight(criterion: string, p: V8Params = V8): number {
  return own(p.probe, criterion) ? p.probe[criterion]! : p.probeDefault;
}

/** Weight of an axe rule (ruleWeight: group, halved for moderate or minor, times its v8 factor), times `ruleFactor` (calibration). */
export function v8RuleWeight(id: string, impact: Impact, p: V8Params = V8): number {
  return ruleWeight(id, impact) * (own(p.ruleFactor, id) ? p.ruleFactor[id]! : 1);
}

/**
 * The site's failing checks from the report, in a fixed order; null when no page loaded. `scored`
 * decides which tests count (the registry's `SCORED_PROBES` by default).
 */
export function reportCriterionChecks(report: SiteReport, p: V8Params = V8, scored: (probe: string) => boolean = (id) => SCORED_PROBES.has(id)): CriterionCheck[] | null {
  const ok = (report.pages ?? []).filter((x) => x.status === 'ok').map((x) => x.url);
  const okSet = new Set(ok);
  if (!okSet.size) return null;
  const out: CriterionCheck[] = [];
  const n = okSet.size;
  const runs = report.probes?.runs ?? [];
  const probeChecks = probeChecksFrom(runs, scored);
  // One verdict per page for a media criterion (1.2.2, 1.4.2; ONE_VERDICT_CRITERIA): the audio test,
  // the media rules and axe can judge the same clip. A page a scored test tested and found no failure
  // on (it plays the page and listens: a working pause or stop control, or no sound) costs nothing for
  // it, whatever the media rules or axe say there. Where they agree it fails, the criterion costs its
  // costliest check only (scoreCore criterionTotal), never the three added up.
  const cleared = new Map<string, Set<string>>(); // criterion -> pages a scored test found no failure on
  for (const [url, checks] of probeChecks) {
    for (const [criterion, outcome] of Object.entries(checks)) {
      if ((outcome === 'pass' || outcome === 'ran') && ONE_VERDICT_CRITERIA.has(criterion)) (cleared.get(criterion) ?? cleared.set(criterion, new Set()).get(criterion)!).add(url);
    }
  }
  const mediaProblemPages = new Map<string, Set<string>>();
  for (const m of report.media ?? []) {
    for (const i of m.issues) {
      if (i.level !== 'problem' || !own(p.media, i.criterion)) continue;
      const s = mediaProblemPages.get(i.criterion) ?? new Set<string>();
      for (const u of m.foundOn) if (okSet.has(u) && !cleared.get(i.criterion)?.has(u)) s.add(u);
      mediaProblemPages.set(i.criterion, s);
    }
  }
  // axe rules: share = pages failed ÷ pages loaded; pages listed as minor cost `minor` of the weight.
  for (const r of report.rules ?? []) {
    const yields = cleared.get(primaryCriterion(r.id));
    const pages = new Set(r.pagesAffected.filter((u) => okSet.has(u) && !yields?.has(u)));
    const minor = new Set((r.minorPages ?? []).filter((u) => pages.has(u)));
    const full = [...pages].filter((u) => !minor.has(u)).length;
    const w = v8RuleWeight(r.id, r.impact, p);
    const criterion = primaryCriterion(r.id);
    const c = withMinor(`rule:${r.id}`, criterion, w, p.minor, full, minor.size, n);
    if (c) out.push(c);
  }
  // Scored tests: share = pages failed ÷ pages where a scored test tested the criterion (v6).
  const tested = new Map<string, number>();
  const failed = new Map<string, Set<string>>();
  for (const [url, checks] of probeChecks) {
    if (!okSet.has(url)) continue;
    for (const [criterion, outcome] of Object.entries(checks)) {
      if (outcome === 'untested') continue;
      tested.set(criterion, (tested.get(criterion) ?? 0) + 1);
      if (outcome === 'fail') failed.set(criterion, (failed.get(criterion) ?? new Set()).add(url));
    }
  }
  // A page's failure of a criterion is minor when every failed finding for it there is marked minor.
  const notMinor = new Set<string>();
  for (const run of runs) {
    if (!scored(run.probe)) continue;
    for (const f of run.findings) if (f.status === 'failed' && !f.minor) notMinor.add(`${f.criterion}\n${run.page}`);
  }
  for (const [criterion, urls] of failed) {
    const t = tested.get(criterion)!;
    const minor = [...urls].filter((u) => !notMinor.has(`${criterion}\n${u}`)).length;
    const full = urls.size - minor;
    const w = v8ProbeWeight(criterion, p);
    const c = withMinor(`criterion:${criterion}`, criterion, w, p.minor, full, minor, t);
    if (c) out.push(c);
  }
  // Third-party frames: the rule's weight times `thirdParty`, share = pages with a frame failing it ÷ pages loaded.
  const third = new Map<string, { impact: Impact; pages: Set<string> }>();
  for (const t of report.thirdParty ?? []) {
    const x = third.get(t.id) ?? { impact: t.impact, pages: new Set<string>() };
    for (const u of t.pagesAffected) if (okSet.has(u)) x.pages.add(u);
    third.set(t.id, x);
  }
  if (p.thirdParty > 0) {
    for (const [id, x] of third) if (x.pages.size) out.push({ key: `third-party:${id}`, criterion: primaryCriterion(id), weight: v8RuleWeight(id, x.impact, p) * p.thirdParty, share: x.pages.size / n });
  }
  // Cross-page rules: share = pages failing ÷ pages loaded.
  for (const c of report.consistency ?? []) {
    if (c.method.status !== 'failed' || !own(p.consistency, c.criterion)) continue;
    const pages = new Set(c.evidence.map((e) => e.page).filter((u) => okSet.has(u))).size || c.method.pages;
    if (pages > 0) out.push({ key: `consistency:${c.criterion}`, criterion: c.criterion, weight: p.consistency[c.criterion]!, share: Math.min(1, pages / n) });
  }
  // Media rules: share = pages with a failing item (that no scored test cleared) ÷ pages with video or audio.
  const withMedia = new Set<string>();
  // A link to a video's page on YouTube (plan C14) is not media on the page: it never widens the share.
  for (const m of report.media ?? []) if (!(m.kind === 'link' && m.player)) for (const u of m.foundOn) if (okSet.has(u)) withMedia.add(u);
  for (const [criterion, pages] of mediaProblemPages) if (pages.size && withMedia.size) out.push({ key: `media:${criterion}`, criterion, weight: p.media[criterion]!, share: Math.min(1, pages.size / withMedia.size) });
  // Gated AI checks: confirmed answers only, share = pages with one ÷ pages the check answered for. The weight is
  // the one the package that scored the review gave it; a report made before carries none (its version's, `p.ai`).
  for (const i of report.aiChecks?.ran ? report.aiChecks.issues : []) {
    const check = (i.check ?? 'altText') as AiCheckId;
    const weights = p.ai[check];
    const weight = typeof i.weight === 'number' && Number.isFinite(i.weight) && i.weight >= 0 ? i.weight : weights && own(weights, i.criterion) ? weights[i.criterion]! : undefined;
    if (weight === undefined || !i.pagesAffected.length || !(i.pagesTested > 0)) continue;
    out.push({ key: check === 'altText' ? `ai:${i.criterion}` : `ai:${check}:${i.criterion}`, criterion: i.criterion, weight, share: Math.min(1, i.pagesAffected.length / i.pagesTested) });
  }
  // Documents: one check (v7), share = documents with a problem ÷ documents checked; a title-only one is
  // a minor failure (v8); a confirmed AI document problem fails one (v10), and so does an Office file with one
  // of the five problems (v10; a report scored before v10 never counts its Office files). One rule: `documentStanding`.
  if (report.documentScore?.scored !== false) {
    const d = documentOutcome(countedDocuments(report), reportDocumentProblems(report));
    if (d.checked > 0 && d.failed > 0) {
      const c = withMinor('documents', 'documents', p.documents, p.minor, d.failed - d.minor, d.minor, d.checked);
      if (c) out.push(c);
    }
  }
  // One verdict per media criterion: every check of it carries its failing pages and the criterion's
  // judged pages (scored tests that passed or failed it, pages with video or audio, and the failing
  // pages themselves), so criterionTotal takes one share over their union, at the costliest weight.
  for (const criterion of ONE_VERDICT_CRITERIA) {
    const mine = out.filter((c) => c.criterion === criterion);
    if (!mine.length) continue;
    const pagesOf = (c: CriterionCheck): string[] => {
      if (c.key.startsWith('rule:')) return (report.rules ?? []).find((r) => `rule:${r.id}` === c.key)?.pagesAffected.filter((u) => okSet.has(u) && !cleared.get(criterion)?.has(u)) ?? [];
      if (c.key.startsWith('third-party:')) return [...(third.get(c.key.slice(12))?.pages ?? [])];
      if (c.key.startsWith('media:')) return [...(mediaProblemPages.get(criterion) ?? [])];
      if (c.key.startsWith('criterion:')) return [...(failed.get(criterion) ?? [])];
      // A gated AI check (scoring v9: media 1.2.2): the pages with a confirmed answer.
      if (c.key.startsWith('ai:')) {
        const i = (report.aiChecks?.issues ?? []).find((x) => `ai:${x.check ?? 'altText'}:${x.criterion}` === c.key);
        return i?.pagesAffected.filter((u) => okSet.has(u) && !cleared.get(criterion)?.has(u)) ?? [];
      }
      return [];
    };
    const judged = new Set<string>(own(p.media, criterion) ? withMedia : []);
    for (const [url, checks] of probeChecks) if (okSet.has(url) && (checks[criterion] === 'pass' || checks[criterion] === 'fail')) judged.add(url);
    const withPages = mine.map((c) => ({ c, pages: pagesOf(c) }));
    for (const { pages } of withPages) for (const u of pages) judged.add(u);
    for (const { c, pages } of withPages) {
      c.pages = pages;
      c.of = judged.size;
    }
  }
  return out.sort(byKey);
}

/**
 * The report as if `url` were the only page scanned: every failure, test result, frame, media item,
 * cross-page finding and confirmed AI answer on that page, nothing from other pages. The documents
 * are left out (a PDF is not part of a page). A page's score is the v8 score of this.
 */
export function pageReportFor(report: SiteReport, url: string): SiteReport {
  const on = (list: readonly string[] | undefined) => !!list?.includes(url);
  return {
    ...report,
    pages: (report.pages ?? []).filter((x) => x.url === url),
    rules: (report.rules ?? []).filter((r) => on(r.pagesAffected)).map((r) => ({ ...r, pagesAffected: [url], ...(r.minorPages ? { minorPages: on(r.minorPages) ? [url] : [] } : {}) })),
    ...(report.probes ? { probes: { ...report.probes, runs: report.probes.runs.filter((r) => r.page === url) } } : {}),
    ...(report.thirdParty ? { thirdParty: report.thirdParty.filter((t) => on(t.pagesAffected)).map((t) => ({ ...t, pagesAffected: [url] })) } : {}),
    ...(report.media ? { media: report.media.filter((m) => on(m.foundOn)).map((m) => ({ ...m, foundOn: [url] })) } : {}),
    ...(report.consistency ? { consistency: report.consistency.flatMap((c) => {
      if (c.method.status !== 'failed') return [c];
      const evidence = c.evidence.filter((e) => e.page === url);
      return evidence.length ? [{ ...c, method: { ...c.method, pages: 1 }, evidence }] : [];
    }) } : {}),
    ...(report.aiChecks ? { aiChecks: { ...report.aiChecks, issues: report.aiChecks.issues.filter((i) => on(i.pagesAffected)).map((i) => ({ ...i, pagesAffected: [url], pagesTested: 1 })) } } : {}),
    documentChecks: [],
  };
}

/** Each loaded page's unrounded v8 score (`pageReportFor`), by URL. */
export function pageScoresV8(report: SiteReport, p: V8Params = V8, scored?: (probe: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const page of report.pages ?? []) {
    if (page.status !== 'ok') continue;
    const checks = reportCriterionChecks(pageReportFor(report, page.url), p, scored);
    if (checks) out.set(page.url, criterionScore(checks, p));
  }
  return out;
}

export type { AccessBlocker } from './types.js';

const nonInterference = (c: CriterionCheck) => NON_INTERFERENCE_CRITERIA.includes(c.criterion) && c.weight > 0 && c.share > 0;

/** The verdict: a score of 90 or more and no blocking non-interference failure. */
export function accessGranted(score: number, blockers: readonly unknown[]): boolean {
  return score >= 90 && blockers.length === 0;
}

/** Whether failing checks leave Access Granted possible: no non-interference failure among them. */
export function noBlocker(checks: readonly CriterionCheck[]): boolean {
  return !checks.some(nonInterference);
}

/**
 * The non-interference criteria (`NON_INTERFERENCE_CRITERIA`) that block Access Granted: a check that
 * costs points under v8 (third-party frames included) fails one of them. A result that could not be
 * tested, or that the time limit cut short, never costs points, so it never blocks. In criterion order.
 */
export function accessBlockers(report: SiteReport, p: V8Params = V8, scored?: (probe: string) => boolean): AccessBlocker[] {
  const checks = (reportCriterionChecks(report, p, scored) ?? []).filter(nonInterference);
  const out: AccessBlocker[] = [];
  for (const criterion of NON_INTERFERENCE_CRITERIA) {
    const keys = [...new Set(checks.filter((c) => c.criterion === criterion).map((c) => c.key))];
    if (!keys.length) continue;
    const pages = (report.pages ?? []).filter((pg) => pg.status === 'ok'
      && (reportCriterionChecks(pageReportFor(report, pg.url), p, scored) ?? []).some((c) => c.criterion === criterion && nonInterference(c))).map((pg) => pg.url);
    out.push({ criterion, title: CRITERIA.find((d) => d.criterion === criterion)?.title ?? criterion, pages, keys });
  }
  return out;
}

/** The score and each check's "+N if fixed" (by key), from the report; null when no page loaded. */
export function scoreReportV8(report: SiteReport, p: V8Params = V8, scored?: (probe: string) => boolean): { score: number; pointsLost: Map<string, number>; checks: CriterionCheck[] } | null {
  const checks = reportCriterionChecks(report, p, scored);
  if (!checks) return null;
  const score = roundScore(criterionScore(checks, p));
  const pointsLost = new Map<string, number>();
  for (const key of new Set(checks.map((c) => c.key))) pointsLost.set(key, roundScore(criterionScore(checks.filter((c) => c.key !== key), p)) - score);
  return { score, pointsLost, checks };
}
