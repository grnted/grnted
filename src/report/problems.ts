// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The report v2 problem model (docs/specs/2026-10-31-report-v2-design.md §5): "Fix these first".
// A pure function of the SiteReport: one problem per failing axe rule, per criterion a core probe
// failed and (scoring v5) per AI-reviewed image check with confirmed failures (all scored), one per
// criterion only deep or unscored probes failed (not scored), and one for the checked PDFs with problems
// (scored since v7, ranked by its points with the other scored problems; unscored and last when the scan
// left documents out of the score or the report is older). Engine core: no Node-only imports.
import { pickEvidence, type EvidenceCandidate } from './pickEvidence.js';
import { clipWords } from '../clip.js';
import { compareCriteria, METHOD_CHECKED, METHOD_FULL } from '../probes/criteria.js';
import { SCORED_PROBES } from '../probes/registry.js';
import { reportDocumentProblems } from '../aiScore.js';
import { IMPACT_RANK, documentCriteria } from '../score.js';
import type { AiIssueSummary, CriterionEvidence, DocumentCheck, EvidenceShot, ProbeFinding, ProbeRun, RuleSummary, SiteReport, TestIssueSummary } from '../types.js';
import { AI_COPY, COPY_KIND_CRITERIA, COPY_PROBE_CRITERIA, copyForAiCheck, copyForCriterion, copyForKindCriterion, copyForProbeCriterion, copyForRule, DOCUMENTS_COPY, OFFICE_COPY } from './copy/index.js';
import { reportChecks } from './projection.js';
import { officeProblems } from '../documents/office.js';
import { officeDocumentsCount } from '../documents/officeScore.js';
import { pdfProblems } from '../documents/pdf.js';
import { AXE_RULES, CRITERIA } from './criteria.js';
import { projectScore } from './projection.js';
import { costKeys } from './scoreScope.js';
import type { AiProblemImage, AlsoFound, DocumentProblemRow, MeasuredPage, OfficeProblemRow, OwnerId, Problem, ProblemCopy, Snippet, SnippetInput } from './model.js';

/** Text evidence kept per problem. */
export const MAX_TEXT_EVIDENCE = 3;
/** Batch 19: failures read per criterion before the evidence lines are picked from them. */
const MAX_OCCURRENCES_READ = 200;
/** A failing element repeats when it fails on at least half the loaded pages and on at least this many. */
export const MIN_REPEAT_PAGES = 3;

/** Rules whose failing elements are links (the count reads "links"). */
const LINK_RULES: ReadonlySet<string> = new Set(['link-name', 'link-in-text-block', 'area-alt']);

/**
 * The axe rules that fail on a control with no accessible name, by the control's role (the screen-reader
 * test's `data.role`). A nameless control the screen-reader test hears on a page where one of its role's
 * rules failed is that rule's element, so its findings merge into the rule's problem.
 */
export const SAME_ELEMENT_RULES: Readonly<Record<string, readonly string[]>> = {
  link: ['link-name', 'area-alt'],
  button: ['button-name', 'input-button-name', 'input-image-alt', 'aria-command-name', 'summary-name'],
  textbox: ['label', 'aria-input-field-name'], searchbox: ['label', 'aria-input-field-name'],
  combobox: ['select-name', 'label', 'aria-input-field-name'], listbox: ['select-name', 'aria-input-field-name'],
  spinbutton: ['label', 'aria-input-field-name'], slider: ['label', 'aria-input-field-name'],
  checkbox: ['label', 'aria-toggle-field-name'], radio: ['label', 'aria-toggle-field-name'], switch: ['label', 'aria-toggle-field-name'],
  menuitem: ['aria-command-name'], menuitemcheckbox: ['aria-toggle-field-name'], menuitemradio: ['aria-toggle-field-name'],
  tab: ['aria-command-name'], treeitem: ['aria-command-name'],
};
/** The probe whose nameless-control findings restate the axe name rules. */
const SAME_ELEMENT_PROBE = 'screen-reader';

const LEVELS = new Map(CRITERIA.map((d) => [d.criterion, d.level]));
/** axe rule → the criteria it is tagged with, in criterion order. */
const RULE_CRITERIA = (() => {
  const out = new Map<string, string[]>();
  for (const [criterion, rules] of Object.entries(AXE_RULES)) {
    for (const id of rules) out.set(id, [...(out.get(id) ?? []), criterion]);
  }
  for (const list of out.values()) list.sort(compareCriteria);
  return out;
})();

const withLevels = (criteria: readonly string[]): Problem['criteria'] =>
  criteria.filter((c) => LEVELS.has(c)).map((criterion) => ({ criterion, level: LEVELS.get(criterion)! }));

const shorten = (s: string, max = 200) => clipWords(s, max);

/** A snippet from the copy, never throwing (snippet builders read untrusted page content). */
function snippetOf(copy: ProblemCopy, ex: SnippetInput | undefined): Snippet | undefined {
  if (!copy.snippet || !ex) return undefined;
  try {
    return copy.snippet(ex) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A probe finding's measured values (ProbeFinding.data, report v2), when it is a plain object (a report read back from JSON may hold anything). */
function findingData(f: ProbeFinding): ProbeFinding['data'] {
  const data = f.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : undefined;
}

/** Evidence shots matching `match`, in id order, with each group's members together (at the first one). */
function shotsFor(all: readonly EvidenceShot[], match: (s: EvidenceShot) => boolean): EvidenceShot[] {
  const num = (id: unknown) => {
    const m = /^e(\d{1,9})$/.exec(String(id));
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const str = (id: unknown) => String(id);
  const sorted = all.filter((s) => {
    try {
      return !!s && typeof s.for === 'object' && s.for !== null && match(s);
    } catch {
      return false;
    }
  }).sort((a, b) => num(a.id) - num(b.id) || (str(a.id) < str(b.id) ? -1 : str(a.id) > str(b.id) ? 1 : 0));
  const out: EvidenceShot[] = [];
  const done = new Set<string>();
  for (const s of sorted) {
    if (s.group === undefined) out.push(s);
    else if (!done.has(s.group)) {
      done.add(s.group);
      out.push(...sorted.filter((x) => x.group === s.group));
    }
  }
  return out;
}

const forRule = (id: string) => (s: EvidenceShot) => 'rule' in s.for && s.for.rule === id && id !== '$start';
const forCriterion = (criterion: string) => (s: EvidenceShot) => 'criterion' in s.for && s.for.criterion === criterion;

/**
 * A criterion's pictures come from one probe: a core probe's when it took any (with --full the deep
 * keyboard walk can picture the same failure again), otherwise the first probe's in id order.
 */
function oneProbe(shots: EvidenceShot[], criterion: string, only?: string): EvidenceShot[] {
  const probeOf = (s: EvidenceShot) => ('probe' in s.for ? String(s.for.probe) : '');
  if (only) return shots.filter((s) => probeOf(s) === only);
  // With the criterion's own copy, pictures from a probe that has copy of its own would not match the title.
  const own = shots.filter((s) => !COPY_PROBE_CRITERIA.includes(`${probeOf(s)}:${criterion}`));
  const pool = own.length ? own : shots;
  const pick = pool.find((s) => SCORED_PROBES.has(probeOf(s))) ?? pool[0];
  return pick ? pool.filter((s) => probeOf(s) === probeOf(pick)) : pool;
}

/**
 * The probes that failed `criterion` on `pages` (scored ones only when `scored`). When one probe alone
 * failed it and the copy library has copy for that probe and criterion, the problem reads as that
 * probe's (a floating widget is not "sideways scrolling"), with its pictures only.
 */
function probeCopy(runs: readonly ProbeRun[], criterion: string, pages: ReadonlySet<string>, scored: boolean): { copy: ProblemCopy; probe?: string } {
  const probes = new Set<string>();
  // Batch 19: the kinds of evidence (`data.kind`); a failure without one counts as its own kind ('').
  const kinds = new Set<string>();
  for (const run of runs) {
    if (!pages.has(run.page) || (scored && !SCORED_PROBES.has(run.probe))) continue;
    const failed = run.findings.filter((f) => f.criterion === criterion && f.status === 'failed');
    if (failed.length) probes.add(run.probe);
    for (const f of failed) kinds.add(typeof f.data?.kind === 'string' ? f.data.kind : '');
  }
  const only = probes.size === 1 ? [...probes][0]! : undefined;
  const kind = kinds.size === 1 ? [...kinds][0]! : '';
  if (kind && COPY_KIND_CRITERIA.includes(`${criterion}:${kind}`)) return { copy: copyForKindCriterion(criterion, kind), ...(only ? { probe: only } : {}) };
  if (only && COPY_PROBE_CRITERIA.includes(`${only}:${criterion}`)) return { copy: copyForProbeCriterion(only, criterion), probe: only };
  return { copy: copyForCriterion(criterion) };
}

interface Ranked { problem: Problem; weight: number }

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

function compareRanked(a: Ranked, b: Ranked): number {
  const pa = a.problem;
  const pb = b.problem;
  return pb.pointsLost - pa.pointsLost || b.weight - a.weight || pb.pages.length - pa.pages.length || pb.count.n - pa.count.n
    || (pa.key < pb.key ? -1 : pa.key > pb.key ? 1 : 0);
}

function ruleProblem(r: RuleSummary, okPages: number, order: (pages: readonly string[]) => string[], evidence: readonly EvidenceShot[], missed: SiteReport['evidenceMissed']): Ranked {
  const copy = copyForRule(r.id);
  const best = Math.max(0, ...(r.signatures ?? []).map((s) => s.pages));
  const repeats = okPages > 0 && best >= MIN_REPEAT_PAGES && best >= Math.ceil(okPages / 2) ? { pages: Math.min(best, okPages), of: okPages } : undefined;
  const examples = r.examples ?? [];
  const first = examples[0];
  const snippet = snippetOf(copy, first ? { html: first.html, target: first.target } : undefined);
  const textEvidence: CriterionEvidence[] = examples.slice(0, MAX_TEXT_EVIDENCE).map((e) => {
    const html = (typeof e.html === 'string' ? e.html : '').replace(/\s+/g, ' ').trim();
    return { page: e.page, ...(e.target ? { target: e.target } : {}), detail: html ? `Failing element: ${shorten(html)}` : 'Failing element (no HTML recorded).' };
  });
  const shots = shotsFor(evidence, forRule(r.id));
  const miss = shots.length ? undefined : (Array.isArray(missed) ? missed : []).find((m) => m && m.rule === r.id && typeof m.reason === 'string');
  const note = miss ? shorten(`${miss.reason.trim()} (${typeof miss.page === 'string' ? miss.page : ''})`, 300) : undefined;
  return {
    weight: own(IMPACT_RANK, r.impact) ? IMPACT_RANK[r.impact] : IMPACT_RANK.moderate,
    problem: {
      key: `rule:${r.id}`,
      copy,
      owner: copy.owner,
      criteria: withLevels(RULE_CRITERIA.get(r.id) ?? []),
      scored: true,
      pointsLost: finite(r.pointsLost),
      pages: order(r.pagesAffected ?? []),
      count: { n: finite(r.elements), unit: LINK_RULES.has(r.id) ? 'link' : 'element' },
      ...(repeats ? { repeats } : {}),
      evidence: shots,
      ...(note ? { evidenceMissed: note } : {}),
      textEvidence,
      ...(snippet ? { snippet } : {}),
    },
  };
}

/**
 * The text evidence with the finding the first picture boxes in front (the card's one line then names
 * the element the picture shows): the matching entry moved up, or the failed finding with that page
 * and target taken from the runs when the cap left it out. Unchanged when the picture names nothing.
 */
function pictureFirst(text: readonly CriterionEvidence[], shots: readonly EvidenceShot[], criterion: string, runs: readonly ProbeRun[]): CriterionEvidence[] {
  const s = shots[0];
  const target = s && 'criterion' in s.for && typeof s.for.target === 'string' && s.for.target ? s.for.target : undefined;
  if (!s || !target) return [...text];
  const at = text.findIndex((e) => e && e.page === s.page && e.target === target);
  if (at === 0) return [...text];
  if (at > 0) return [text[at]!, ...text.filter((_, i) => i !== at)];
  for (const run of runs) {
    if (run.page !== s.page) continue;
    const f = run.findings.find((x) => x.criterion === criterion && x.status === 'failed' && x.target === target);
    if (f) return [{ page: run.page, target, detail: f.detail }, ...text].slice(0, MAX_TEXT_EVIDENCE);
  }
  return [...text];
}

/** The key of the problem listing unscored tests' failures of a criterion a scored test also fails. */
export const listedKey = (criterion: string) => `criterion:${criterion}/listed`;
/** The criterion of a 'criterion:' problem key (the scored one or its `listedKey`). */
export const keyCriterion = (key: string) => key.slice(10).replace(/\/listed$/, '');

function criterionProblem(input: {
  criterion: string; scored: boolean; pointsLost: number; pages: string[]; textEvidence: CriterionEvidence[];
  firstFailure?: ProbeFinding; evidence: readonly EvidenceShot[]; runs: readonly ProbeRun[]; key?: string; measured?: MeasuredPage[];
}): Ranked {
  const { copy, probe } = probeCopy(input.runs, input.criterion, new Set(input.pages), input.scored);
  const pictures = oneProbe(shotsFor(input.evidence, forCriterion(input.criterion)), input.criterion, probe);
  const f = input.firstFailure;
  const data = f ? findingData(f) : undefined;
  const snippet = snippetOf(copy, f ? { ...(f.target ? { target: f.target } : {}), ...(data ? { data } : {}) } : {});
  return {
    weight: IMPACT_RANK.serious, // tie-break order only: a criterion sorts with the serious axe rules
    problem: {
      key: input.key ?? `criterion:${input.criterion}`,
      copy,
      owner: copy.owner,
      criteria: withLevels([input.criterion]),
      scored: input.scored,
      pointsLost: input.scored ? finite(input.pointsLost) : 0,
      pages: input.pages,
      count: { n: input.pages.length, unit: 'page' },
      evidence: pictures,
      textEvidence: pictureFirst(input.textEvidence, pictures, input.criterion, input.runs).slice(0, MAX_TEXT_EVIDENCE),
      ...(snippet ? { snippet } : {}),
      ...(input.measured?.length ? { measured: input.measured } : {}),
    },
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * An AI-scored problem (scoring v5): one per criterion with confirmed failing images, with each image's
 * picture (the AI thumbnails of its images), the words the AI read and the current alt text.
 */
function aiProblem(issue: AiIssueSummary, order: (pages: readonly string[]) => string[], evidence: readonly EvidenceShot[]): Ranked | undefined {
  // A gated AI check other than altText (scoring v8) is a cost problem (costProblems), not an image problem.
  if (issue.check && issue.check !== 'altText') return undefined;
  if (issue.criterion !== '1.1.1' && issue.criterion !== '1.4.5') return undefined;
  const findings = Array.isArray(issue.findings) ? issue.findings.filter((f) => f && typeof f === 'object') : [];
  const images: AiProblemImage[] = findings.map((f) => ({
    page: text(f.page),
    src: text(f.target),
    ...(f.current && typeof f.current.value === 'string' ? { alt: f.current.value } : {}),
    essentialText: text(f.essentialText),
    observed: text(f.observed),
  }));
  const wanted = new Set(images.map((i) => `${i.page}\n${i.src}`));
  const shots = shotsFor(evidence, (s) => 'ai' in s.for && wanted.has(`${s.page}\n${String(s.for.ai)}`));
  return {
    weight: IMPACT_RANK.serious, // tie-break order only, like a core test criterion
    problem: {
      key: `ai:${issue.criterion}`,
      copy: AI_COPY[issue.criterion],
      owner: AI_COPY[issue.criterion].owner,
      criteria: withLevels([issue.criterion]),
      scored: true,
      pointsLost: finite(issue.pointsLost),
      pages: order(Array.isArray(issue.pagesAffected) ? issue.pagesAffected : []),
      count: { n: images.length, unit: 'image' },
      evidence: shots,
      textEvidence: images.slice(0, MAX_TEXT_EVIDENCE).map((i) => ({ page: i.page, target: i.src, detail: i.essentialText ? `Words in the picture: ${shorten(i.essentialText, 300)}` : 'A picture the AI review confirmed.' })),
      aiImages: images,
    },
  };
}

/** Short names for the quick-check problems outside the documents table's four columns. */
const OTHER_PDF_PROBLEMS: readonly { name: string; fails: (c: NonNullable<DocumentCheck['checks']>) => boolean }[] = [
  { name: 'Image alt text', fails: (c) => (c.figuresWithoutAlt ?? 0) > 0 },
  { name: 'Form field names', fails: (c) => (c.untitledFormFields ?? 0) > 0 },
  { name: 'XFA form', fails: (c) => c.xfa === true },
  { name: 'Security blocks screen readers', fails: (c) => c.blocksAssistiveTech === true },
  { name: 'Title not shown', fails: (c) => c.hasTitle === true && c.showsTitle === false },
];

/**
 * The checked PDFs with any quick-check problem (`pdfProblems`), the documents check's failures (scoring v7),
 * and (v10) those with a problem the AI document review confirmed: its problems are listed with the others.
 */
function documentRows(checks: readonly DocumentCheck[], confirmed: ReadonlyMap<string, { labels: string[]; criteria: string[] }> = new Map()): { rows: DocumentProblemRow[]; criteria: Set<string> } {
  const rows: DocumentProblemRow[] = [];
  const criteria = new Set<string>();
  for (const d of checks) {
    const c = d?.checks;
    if (!c || d.type !== 'pdf') continue;
    const ai = confirmed.get(d.url);
    // The AI review's confirmed problems read as the Documents section and the JSON show them (documentProblems).
    const aiProblems = (ai?.labels ?? []).map((l) => `${l} (AI review)`);
    const problems = [...pdfProblems(c), ...aiProblems];
    if (!problems.length) continue;
    for (const k of documentCriteria(d, confirmed)) criteria.add(k);
    rows.push({
      url: d.url,
      linkedFrom: [...d.linkedFrom],
      ...docNames(d),
      ...(typeof c.title === 'string' && c.title ? { title: c.title } : {}),
      ...(typeof c.pages === 'number' ? { pages: c.pages } : {}),
      untagged: c.tagged === false,
      noTitle: c.hasTitle === false,
      noLanguage: c.hasLanguage === false,
      imageOnly: c.imageOnly === true,
      problems,
      ...(aiProblems.length ? { aiProblems: aiProblems.length } : {}),
      other: [...OTHER_PDF_PROBLEMS.filter((o) => o.fails(c)).map((o) => o.name), ...aiProblems],
    });
  }
  return { rows, criteria };
}

/** Batch 19: a document's link words and served file name, when the report kept them. */
function docNames(d: DocumentCheck): { linkText?: string; fileName?: string } {
  return {
    ...(typeof d.linkText === 'string' && d.linkText ? { linkText: d.linkText } : {}),
    ...(typeof d.fileName === 'string' && d.fileName ? { fileName: d.fileName } : {}),
  };
}

/** The Office files whose quick checks found a problem (hints are left out). Never scored. */
function officeRows(checks: readonly DocumentCheck[]): { rows: OfficeProblemRow[]; criteria: Set<string> } {
  const rows: OfficeProblemRow[] = [];
  const criteria = new Set<string>();
  for (const d of checks) {
    const c = d?.officeChecks;
    if (!c) continue;
    const found = officeProblems(c);
    if (!found.length) continue;
    for (const f of found) criteria.add(f.criterion);
    rows.push({ url: d.url, linkedFrom: [...d.linkedFrom], ...docNames(d), format: c.format, problems: found.map((f) => f.text) });
  }
  return { rows, criteria };
}

/**
 * Problems for the failing checks no axe rule, test criterion, alt-text AI check or documents check
 * stands for: since scoring v8, third-party frames ('third-party:<id>'), the cross-page rules
 * ('consistency:<n>'), the media rules ('media:<n>') and the gated AI checks ('ai:<check>:<n>') cost
 * points too, so each is a problem in "Fix these first" and the fix plan. `costKeys`: the report's failing
 * checks (scoreScope.ts `costKeys`); `points(key)`: what fixing one adds. A key the report has no
 * details for is left out. Exported for tests; buildProblems uses it.
 */
export function costProblems(report: SiteReport, costKeys: ReadonlySet<string>, points: (key: string) => number, order: (pages: readonly string[]) => string[]): Ranked[] {
  const out: Ranked[] = [];
  const evidenceOf = (list: readonly CriterionEvidence[]) => list.slice(0, MAX_TEXT_EVIDENCE);
  for (const key of costKeys) {
    if (key.startsWith('third-party:')) {
      const id = key.slice(12);
      const rows = (report.thirdParty ?? []).filter((t) => t && t.id === id);
      if (!rows.length) continue;
      const base = copyForRule(id);
      const pages = order(rows.flatMap((r) => r.pagesAffected));
      const criteria = RULE_CRITERIA.get(id) ?? [];
      out.push({
        weight: IMPACT_RANK[rows[0]!.impact] ?? IMPACT_RANK.serious,
        problem: {
          key, copy: { ...base, title: `${shorten(base.title, 49)} (embedded content)` }, owner: base.owner, criteria: withLevels(criteria), scored: true, pointsLost: finite(points(key)),
          pages, count: { n: rows.reduce((n, r) => n + finite(r.elements), 0), unit: 'element' }, evidence: [],
          textEvidence: evidenceOf(rows.flatMap((r) => r.examples.map((e) => ({ page: e.page, target: e.target, detail: `In a frame from ${r.origin || 'another site'} (${e.frame})` })))),
        },
      });
    } else if (key.startsWith('consistency:') || key.startsWith('media:') || /^ai:[A-Za-z]+:/.test(key)) {
      const criterion = key.split(':').pop()!;
      let pages: string[] = [];
      let found: CriterionEvidence[] = [];
      if (key.startsWith('consistency:')) {
        const c = (report.consistency ?? []).find((x) => x && x.criterion === criterion);
        if (!c) continue;
        found = c.evidence;
        pages = c.evidence.map((e) => e.page);
      } else if (key.startsWith('media:')) {
        const items = (report.media ?? []).filter((m) => m && m.issues.some((i) => i.level === 'problem' && i.criterion === criterion));
        if (!items.length) continue;
        pages = items.flatMap((m) => m.foundOn);
        found = items.flatMap((m) => m.issues.filter((i) => i.level === 'problem' && i.criterion === criterion).map((i) => ({ page: m.foundOn[0] ?? report.site, ...(m.url ? { target: m.url } : {}), detail: i.message })));
      } else {
        const check = key.split(':')[1];
        const issue = (report.aiChecks?.issues ?? []).find((i) => i && i.criterion === criterion && (i as { check?: string }).check === check);
        if (!issue) continue;
        pages = issue.pagesAffected;
        found = (Array.isArray(issue.findings) ? issue.findings : []).map((f) => ({ page: text(f.page), ...(text(f.target) ? { target: text(f.target) } : {}), detail: text(f.observed) || 'Confirmed by the AI review.' }));
      }
      const ordered = order(pages);
      const aiCheck = /^ai:[A-Za-z]+:/.test(key) ? key.split(':')[1]! : undefined;
      out.push({
        weight: IMPACT_RANK.serious,
        problem: {
          key, copy: aiCheck ? copyForAiCheck(aiCheck, criterion) : copyForCriterion(criterion), owner: (aiCheck ? copyForAiCheck(aiCheck, criterion) : copyForCriterion(criterion)).owner,
          criteria: withLevels([criterion]), scored: true, pointsLost: finite(points(key)),
          pages: ordered, count: { n: ordered.length, unit: 'page' }, evidence: [], textEvidence: evidenceOf(found),
        },
      });
    }
  }
  return out;
}

/**
 * "Fix these first" (spec §5): scored problems by points lost, then axe impact (probe criteria
 * sort as serious), pages affected, elements and key; then the unscored ones in the same order;
 * the documents problem last.
 */
export function buildProblems(report: SiteReport): Problem[] {
  const pageIndex = new Map(report.pages.map((p, i) => [p.url, i]));
  // Scan order; pages the report doesn't list keep their own order after the rest.
  const order = (pages: readonly string[]) => [...new Set(pages)].sort((a, b) => (pageIndex.get(a) ?? pageIndex.size) - (pageIndex.get(b) ?? pageIndex.size));
  const failedPages = new Set(report.pages.filter((p) => p.status !== 'ok').map((p) => p.url));
  const okPages = report.pages.length - failedPages.size;
  const evidence = report.evidence ?? [];
  const runs: readonly ProbeRun[] = report.probes?.runs ?? [];

  const scored: Ranked[] = [];
  const unscored: Ranked[] = [];

  for (const r of report.rules ?? []) scored.push(ruleProblem(r, okPages, order, evidence, report.evidenceMissed));

  const firstFailure = (criterion: string, pages?: ReadonlySet<string>) => {
    for (const run of runs) {
      if (pages && !pages.has(run.page)) continue;
      const f = run.findings.find((x) => x.criterion === criterion && x.status === 'failed' && !x.coveredBy);
      if (f) return f;
    }
    return undefined;
  };

  // Review r1 (2026-11-10): every page where a failure was measured is in its problem, with how. A run of the
  // wider coverage (`ProbeRun.coverage`: the whole test on a page outside the score's own, or `checked`: one
  // element measured by itself) is listed, never scored.
  const fails = (run: ProbeRun, criterion: string) => run.findings.some((f) => f.criterion === criterion && f.status === 'failed' && !f.coveredBy);
  const methodOf = (list: readonly ProbeRun[]) => (list.some((run) => !run.checked) ? METHOD_FULL : METHOD_CHECKED);
  /** `measured` for a problem of `criterion` from these runs: undefined when every one is a full test the score counts. */
  const measuredBy = (criterion: string, from: readonly ProbeRun[], scoredPages: ReadonlySet<string>): MeasuredPage[] | undefined => {
    const byPage = new Map<string, ProbeRun[]>();
    for (const run of from) {
      if (failedPages.has(run.page) || !fails(run, criterion)) continue;
      byPage.set(run.page, [...(byPage.get(run.page) ?? []), run]);
    }
    if (![...byPage.values()].some((list) => list.some((run) => run.coverage || run.checked))) return undefined;
    return order([...byPage.keys()]).map((page) => {
      const counted = scoredPages.has(page);
      // A page of the score was measured by the whole test; elsewhere, by whatever ran there.
      return { page, method: counted ? METHOD_FULL : methodOf(byPage.get(page)!), scored: counted };
    });
  };
  const scoredRuns = runs.filter((run) => SCORED_PROBES.has(run.probe));

  const covered = new Set<string>();
  for (const t of report.testIssues ?? ([] as TestIssueSummary[])) {
    covered.add(t.criterion);
    const pages = order(t.pagesAffected);
    const measured = measuredBy(t.criterion, scoredRuns, new Set(pages));
    scored.push(criterionProblem({
      criterion: t.criterion, scored: true, pointsLost: t.pointsLost, pages, textEvidence: t.evidence,
      firstFailure: firstFailure(t.criterion, new Set(t.pagesAffected)), evidence, runs,
      ...(measured ? { measured } : {}),
    }));
  }

  // Scoring v5: the AI-reviewed image checks with confirmed failures.
  for (const issue of report.aiChecks?.issues ?? []) {
    const p = issue && typeof issue === 'object' ? aiProblem(issue, order, evidence) : undefined;
    if (p) scored.push(p);
  }

  // One defect on one element is one problem: a nameless control the screen-reader test heard on an element
  // an axe name rule already failed (same page, same criterion) merges into that rule's problem.
  const sameElement = sameElementMerger(report, scored);

  // Failures only unscored probes found: of criteria the scored tests don't cover, and of criteria they
  // do (listed as a problem of their own, never scored, unless a scored test failed the same element on
  // the same page).
  const scoredHits = new Set<string>();
  for (const run of runs) {
    if (!SCORED_PROBES.has(run.probe)) continue;
    for (const f of run.findings) if (f.status === 'failed' && !f.coveredBy) scoredHits.add(`${f.criterion}\n${run.page}\n${f.target ?? ''}`);
  }
  const other = new Map<string, { pages: string[]; evidence: EvidenceCandidate[]; first: ProbeFinding }>();
  const listed = new Map<string, { pages: string[]; evidence: EvidenceCandidate[]; first: ProbeFinding }>();
  for (const run of runs) {
    if (failedPages.has(run.page)) continue;
    for (const f of run.findings) {
      // A failure an axe rule also found on the same element is listed with the rule (alsoFound).
      if (f.status !== 'failed' || f.coveredBy) continue;
      if (covered.has(f.criterion) && (SCORED_PROBES.has(run.probe) || scoredHits.has(`${f.criterion}\n${run.page}\n${f.target ?? ''}`))) continue;
      if (sameElement(run, f)) continue;
      const into = covered.has(f.criterion) ? listed : other;
      let o = into.get(f.criterion);
      if (!o) into.set(f.criterion, (o = { pages: [], evidence: [], first: f }));
      o.pages.push(run.page);
      if (o.evidence.length < MAX_OCCURRENCES_READ) o.evidence.push({ page: run.page, ...(f.target ? { target: f.target } : {}), detail: f.detail, ...(f.minor ? { minor: true } : {}) });
    }
  }
  // Batch 19: one line per page first, clear failures first, never the same line twice.
  for (const o of [...other.values(), ...listed.values()]) o.evidence = pickEvidence(o.evidence, MAX_TEXT_EVIDENCE);
  const none = new Set<string>();
  for (const [criterion, o] of other) {
    const measured = measuredBy(criterion, runs, none)?.filter((m) => o.pages.includes(m.page));
    unscored.push(criterionProblem({ criterion, scored: false, pointsLost: 0, pages: order(o.pages), textEvidence: o.evidence, firstFailure: o.first, evidence, runs, ...(measured ? { measured } : {}) }));
  }
  for (const [criterion, o] of listed) {
    const pages = order(o.pages);
    const on = new Set(pages);
    // Its own pictures: the unscored tests' on its own pages.
    const own = evidence.filter((s) => on.has(s.page) && !('probe' in s.for && SCORED_PROBES.has(String(s.for.probe))));
    const unscoredRuns = runs.filter((x) => !SCORED_PROBES.has(x.probe));
    const measured = measuredBy(criterion, unscoredRuns, none)?.filter((m) => on.has(m.page));
    unscored.push(criterionProblem({ criterion, scored: false, pointsLost: 0, pages, textEvidence: o.evidence, firstFailure: o.first, evidence: own, runs: unscoredRuns, key: listedKey(criterion), ...(measured ? { measured } : {}) }));
  }

  // Scoring v8: every other failing check that costs points (third-party, cross-page, media, gated AI).
  const keys = costKeys(report);
  if ([...keys].some((k) => /^(third-party|consistency|media):|^ai:[A-Za-z]+:/.test(k))) {
    const now = typeof report.score === 'number' ? report.score : null;
    const points = (k: string) => {
      const p = now === null ? null : projectScore(report, [k]);
      return p === null || now === null ? 0 : Math.max(0, p - now);
    };
    scored.push(...costProblems(report, keys, points, order));
  }

  // Scoring v7: the documents check, scored when the report scored it; otherwise last, unscored.
  const docs = documentRows(report.documentChecks ?? [], reportDocumentProblems(report));
  const ds = report.documentScore;
  // Scoring v10: Office files with one of the five problem findings share the documents check with the PDFs,
  // so each kind's card shows what fixing that kind adds (the projection keeps the other kind's failures).
  const office = officeRows(report.documentChecks ?? []);
  const officeScored = ds?.scored === true && officeDocumentsCount(report.meta?.scoring) && office.rows.length > 0;
  const gain = (key: string, whole: number) => {
    if (!officeScored || typeof report.score !== 'number') return whole;
    const p = projectScore(report, [key]);
    return p === null ? whole : Math.max(0, p - report.score);
  };
  let documents: Problem | undefined;
  if (docs.rows.length) {
    const docScored = ds?.scored === true && ds.failed > 0;
    documents = {
      key: 'documents',
      copy: DOCUMENTS_COPY,
      owner: DOCUMENTS_COPY.owner,
      criteria: withLevels([...docs.criteria].sort(compareCriteria)),
      scored: docScored,
      pointsLost: docScored ? gain('documents', finite(ds!.pointsLost)) : 0,
      pages: order(docs.rows.flatMap((r) => r.linkedFrom)),
      count: { n: docs.rows.length, unit: 'document' },
      evidence: [],
      textEvidence: [],
      documents: docs.rows,
    };
    // Tie-break order only: the documents check sorts with the serious axe rules, like a core test.
    if (docScored) scored.push({ problem: documents, weight: IMPACT_RANK.serious });
  }
  // Word, Excel and PowerPoint files: scored with the documents check since v10; before that (or with the
  // document score off) evidence only, last.
  let officeProblem: Problem | undefined;
  if (office.rows.length) {
    officeProblem = {
      key: 'office',
      copy: OFFICE_COPY,
      owner: OFFICE_COPY.owner,
      criteria: withLevels([...office.criteria].sort(compareCriteria)),
      scored: officeScored,
      pointsLost: officeScored ? gain('office', 0) : 0,
      pages: order(office.rows.flatMap((r) => r.linkedFrom)),
      count: { n: office.rows.length, unit: 'file' },
      evidence: [],
      textEvidence: office.rows.slice(0, MAX_TEXT_EVIDENCE).map((r) => ({ page: r.linkedFrom[0] ?? r.url, target: r.url, detail: r.problems.join(' ') })),
      officeFiles: office.rows,
    };
    if (officeScored) scored.push({ problem: officeProblem, weight: IMPACT_RANK.serious });
  }

  // Every scored problem's points come from the real scorer (the score without it, minus the score), and a
  // problem counts only when the scorer counts its key (scoring v8: the projection's checks).
  const checks = reportChecks(report);
  if (checks) {
    const keys = new Set(checks.map((c) => c.key));
    for (const r of scored) {
      const p = r.problem;
      if (p.key === 'documents' || p.key === 'office') continue;
      if (!keys.has(p.key)) {
        if (p.key.startsWith('third-party:') || p.key.startsWith('consistency:') || p.key.startsWith('media:') || p.key.startsWith('ai:')) { p.scored = false; p.pointsLost = 0; }
        continue;
      }
      p.pointsLost = (projectScore(report, [p.key]) ?? report.score!) - report.score!;
    }
  } else {
    // An older report (or one whose checks do not rebuild): only what its own scoring version scored.
    for (const r of scored) if (/^(third-party|consistency|media):|^ai:[a-zA-Z]+:/.test(r.problem.key)) { r.problem.scored = false; r.problem.pointsLost = 0; }
  }
  attachAlsoFound([...scored, ...unscored].map((r) => r.problem), runs, report.ai);
  const moved = scored.filter((r) => !r.problem.scored);
  const kept = scored.filter((r) => r.problem.scored);
  // Scoring v8: a fix that a non-interference failure blocks Access Granted on comes first, whatever its points.
  const blocking = new Set((report.accessBlockedBy ?? []).flatMap((b) => b.keys ?? []));
  const blocks = (r: Ranked) => (blocking.has(r.problem.key) ? 0 : 1);
  const out = [...kept.sort((a, b) => blocks(a) - blocks(b) || compareRanked(a, b)), ...[...unscored, ...moved].sort(compareRanked)].map((r) => r.problem);
  if (documents && !documents.scored) out.push(documents);
  if (officeProblem && !officeProblem.scored) out.push(officeProblem);
  for (const p of out) p.owner = problemOwner(p);
  return out;
}

/** Elements another method also found, listed per problem. */
export const MAX_ALSO_FOUND = 5;

/**
 * Lists each element another method also found on the problem that counts it: a test's failure an axe
 * rule also found (`coveredBy`), an AI finding of an element axe, a test or a heavier AI check found
 * (`countedBy`). One problem per page, element and criterion; the others' evidence is on its card.
 */
export function attachAlsoFound(problems: readonly Problem[], runs: readonly ProbeRun[], ai: SiteReport['ai']): void {
  const byKey = new Map(problems.map((p) => [p.key, p]));
  const add = (key: string | undefined, a: AlsoFound) => {
    const p = key ? byKey.get(key) : undefined;
    if (!p) return;
    const list = (p.alsoFound ??= []);
    if (list.length < MAX_ALSO_FOUND && !list.some((x) => x.by === a.by && x.page === a.page && x.detail === a.detail)) list.push(a);
  };
  for (const run of runs) {
    for (const f of run.findings) {
      if (f.status === 'failed' && f.coveredBy) add(f.coveredBy, { by: 'test', page: run.page, ...(f.target ? { target: f.target } : {}), detail: f.detail });
    }
  }
  for (const run of ai?.runs ?? []) {
    for (const f of Array.isArray(run?.findings) ? run.findings : []) {
      if (!f || !f.flagged || typeof f.countedBy !== 'string') continue;
      const detail = String(f.issue || f.observed || f.label || '').trim();
      if (detail) add(f.countedBy, { by: 'ai', page: f.page, ...(f.target ? { target: f.target } : {}), detail });
    }
  }
}

/**
 * Who makes the change (`Problem.owner`): a rule's failing element repeated in the shared template is the
 * web developer's one change there (the fix plan's template fix, fixPlan.ts); otherwise the copy's owner.
 */
export function problemOwner(p: Pick<Problem, 'key' | 'repeats' | 'copy'>): OwnerId {
  return p.key.startsWith('rule:') && p.repeats ? 'developer' : p.copy.owner;
}

/**
 * The merge of one element's findings: returns a function that, for a probe finding, says whether it is
 * an element an axe name rule already failed on that page for the same criterion; if so its words go on
 * the rule's problem (`sameElement`) and the caller leaves it out. Each axe occurrence on a page takes one
 * finding per criterion, so a page with more nameless controls than the rule found keeps the rest.
 * Never touches the score or points: only which card shows the evidence.
 */
function sameElementMerger(report: SiteReport, scored: readonly Ranked[]): (run: ProbeRun, f: ProbeFinding) => boolean {
  const byRule = new Map<string, Problem>();
  for (const r of scored) if (r.problem.key.startsWith('rule:')) byRule.set(r.problem.key.slice(5), r.problem);
  const summaries = new Map((report.rules ?? []).map((r) => [r.id, r]));
  const used = new Map<string, number>();
  /** Elements the rule failed on `page`: the occurrences when the report kept them all, else unbounded on an affected page. */
  const capacity = (id: string, page: string): number => {
    const r = summaries.get(id);
    if (!r || !(r.pagesAffected ?? []).includes(page)) return 0;
    const occ = Array.isArray(r.occurrences) ? r.occurrences : [];
    const complete = occ.length > 0 && occ.length >= finite(r.elements);
    return complete ? occ.filter((o) => o && o.page === page).length : Number.POSITIVE_INFINITY;
  };
  return (run, f) => {
    if (run.probe !== SAME_ELEMENT_PROBE) return false;
    const role = typeof f.data?.role === 'string' ? f.data.role : undefined;
    const rules = role && own(SAME_ELEMENT_RULES, role) ? SAME_ELEMENT_RULES[role]! : [];
    for (const id of rules) {
      const p = byRule.get(id);
      if (!p || !(RULE_CRITERIA.get(id) ?? []).includes(f.criterion)) continue;
      const k = `${id}\n${run.page}\n${f.criterion}`;
      const n = used.get(k) ?? 0;
      if (n >= capacity(id, run.page)) continue;
      used.set(k, n + 1);
      const list = (p.sameElement ??= []);
      if (list.length < MAX_TEXT_EVIDENCE && !list.some((e) => e.page === run.page && e.detail === f.detail)) {
        list.push({ page: run.page, ...(f.target ? { target: f.target } : {}), detail: f.detail });
      }
      return true;
    }
    return false;
  };
}

/** Problems per owner ("Who fixes what"). */
export function ownerCounts(problems: readonly Problem[]): Record<OwnerId, number> {
  const out: Record<OwnerId, number> = { developer: 0, content: 0, documents: 0 };
  for (const p of problems) out[p.owner]++;
  return out;
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number) => WORDS[n] ?? String(n);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The verdict card's one-line lede: how many problems remain and how many repeat across the
 * template ("Four problems remain. Three repeat on every page, so one change in the shared template
 * can fix each of them."). Numbers up to ten are words. `okPages`: pages that loaded.
 */
export function problemsLede(problems: readonly Problem[], okPages: number): string {
  const n = problems.length;
  if (n === 0) return 'The automated tests found no problems to fix.';
  const first = n === 1 ? 'One problem remains.' : `${cap(word(n))} problems remain.`;
  const rep = problems.filter((p) => p.repeats);
  const r = rep.length;
  if (r === 0) return first;
  const every = okPages > 0 && rep.every((p) => p.repeats!.pages >= okPages);
  const where = every ? 'on every page' : 'across many pages';
  const subject = n === 1 ? 'It repeats' : r === 1 ? 'One repeats' : r === n ? (n === 2 ? 'Both repeat' : `All ${word(n)} repeat`) : `${cap(word(r))} repeat`;
  const tail = r === 1 ? 'so one change in the shared template can fix it.' : 'so one change in the shared template can fix each of them.';
  return `${first} ${subject} ${where}, ${tail}`;
}
