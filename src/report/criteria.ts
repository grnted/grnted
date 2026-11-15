// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG results by criterion: one automated result for every WCAG 2.2 Level A and AA success
// criterion (55 rows; all but the six new in 2.2 are WCAG 2.1 AA), derived from the report (axe
// rules, the rules-based document and media inventories, the AI review) plus any results other
// automated methods pass in (`extra`, the Plan 4 probes). Status is the worst over the methods:
// failed > flagged > not_testable > no_failures_found > not_applicable. axe failures and, scoring v3,
// core probe results are scored (src/score.ts); this table itself changes nothing. Wording: never
// "passed", "compliant" or "certified". The HTML section is rendered by criteria-html.ts.
import { clipWords } from '../clip.js';
import { aiGates } from '../aiLegacy.js';
import { scoringScope } from './scope.js';
import { PDF_FIELDS, pdfProblems, TIME_LIMIT_REACHED } from '../documents/pdf.js';
import { PROBES, SCORED_PROBES } from '../probes/registry.js';
import { partlyTested } from '../probes/criteria.js';
import { probeChecksFrom, type ProbeOutcome } from '../score.js';
import type { AiCheckId, AiFinding, CriterionMethodResult, CriterionResult, CriterionStatus, MediaItem, PdfChecks, SiteReport } from '../types.js';
import { criteriaOf, findingId, isNotJudged, reportAi, runIds } from './ai.js';
import { documentRows } from './documents.js';

// The table ---------------------------------------------------------------------------------------

/**
 * Automated methods that can give a criterion a result today. A new check registers by adding its
 * id to a criterion's `methods` below (one line), or passes its results to `buildCriteria(report,
 * extra)` (the probe framework).
 * - `axe`: the axe-core rules tagged with the criterion (`AXE_RULES`); violations are scored.
 * - `pdf-checks`: the quick PDF structure checks of the document inventory (unscored).
 * - `media-rules`: the rules of the video and audio inventory (unscored).
 * - `ai:<check>`: an AI review check, only when it ran in the scan. An opinion, except altText's failures
 *   confirmed by two runs on 1.1.1 and 1.4.5, which are scored (scoring v5).
 * - `site:consistency`: the cross-page comparison rules (src/consistency/), unscored; `buildReport`
 *   computes them from the audited pages into `report.consistency`.
 */
/**
 * `probe:<id>` names a Plan 4 probe in `PROBES` (src/probes/registry.ts); its results arrive as `extra`.
 * A deep probe is declared only where no core probe covers the criterion (test/unit/criteria.test.ts).
 */
export type MethodId = 'axe' | 'pdf-checks' | 'media-rules' | `ai:${AiCheckId}` | `probe:${string}` | 'site:consistency';

/** Content a criterion only applies to: without it on the scanned pages, the result is "not applicable". */
export type CriterionScope = 'media' | 'forms';

export interface CriterionDef {
  criterion: string;
  level: 'A' | 'AA';
  wcag: '2.0' | '2.1' | '2.2';
  title: string;
  methods: readonly MethodId[];
  appliesTo?: CriterionScope;
}

const c = (criterion: string, level: 'A' | 'AA', wcag: '2.0' | '2.1' | '2.2', title: string, methods: MethodId[], appliesTo?: CriterionScope): CriterionDef =>
  ({ criterion, level, wcag, title, methods, ...(appliesTo ? { appliesTo } : {}) });

/** Every WCAG 2.2 Level A and AA success criterion, in order, with the automated methods that test it. */
export const CRITERIA: readonly CriterionDef[] = [
  c('1.1.1', 'A', '2.0', 'Non-text content', ['axe', 'probe:names', 'probe:picture-text', 'pdf-checks', 'ai:altText', 'ai:vision', 'ai:document', 'ai:listener']),
  // probe:media-players (deep) is left out of 1.2.1 and 1.2.2 on purpose, like timing-watch: the core
  // media rules test them, and a declared deep probe would make a core scan show them as not tested.
  // Its results still join these rows with --full. The every-page core media tests are declared: media-alternatives
  // (1.2.1) and media-files (1.2.2; batch 17).
  c('1.2.1', 'A', '2.0', 'Audio-only and video-only (prerecorded)', ['media-rules', 'probe:media-alternatives', 'ai:media'], 'media'),
  c('1.2.2', 'A', '2.0', 'Captions (prerecorded)', ['axe', 'media-rules', 'probe:media-files', 'ai:media'], 'media'),
  c('1.2.3', 'A', '2.0', 'Audio description or media alternative (prerecorded)', ['ai:media', 'probe:media-players'], 'media'),
  c('1.2.4', 'AA', '2.0', 'Captions (live)', ['probe:media-players'], 'media'),
  c('1.2.5', 'AA', '2.0', 'Audio description (prerecorded)', ['ai:media', 'probe:media-players'], 'media'),
  c('1.3.1', 'A', '2.0', 'Info and relationships', ['axe', 'probe:headings', 'probe:screen-reader', 'probe:form-fields', 'pdf-checks', 'ai:pageText', 'ai:document', 'ai:listener']),
  c('1.3.2', 'A', '2.0', 'Meaningful sequence', ['probe:screen-reader', 'ai:vision', 'ai:document', 'ai:listener']),
  c('1.3.3', 'A', '2.0', 'Sensory characteristics', ['ai:pageText']),
  c('1.3.4', 'AA', '2.1', 'Orientation', ['axe', 'probe:orientation']),
  c('1.3.5', 'AA', '2.1', 'Identify input purpose', ['axe', 'probe:form-fields', 'ai:forms'], 'forms'),
  c('1.4.1', 'A', '2.0', 'Use of color', ['axe', 'ai:vision', 'probe:link-color']),
  c('1.4.2', 'A', '2.0', 'Audio control', ['axe', 'media-rules', 'probe:audio'], 'media'),
  c('1.4.3', 'AA', '2.0', 'Contrast (minimum)', ['axe', 'probe:text-contrast']),
  c('1.4.4', 'AA', '2.0', 'Resize text', ['axe', 'probe:resize-text']),
  c('1.4.5', 'AA', '2.0', 'Images of text', ['probe:picture-text', 'ai:altText', 'ai:document']),
  c('1.4.10', 'AA', '2.1', 'Reflow', ['probe:reflow', 'probe:overlays']),
  c('1.4.11', 'AA', '2.1', 'Non-text contrast', ['probe:non-text-contrast', 'probe:keyboard']),
  c('1.4.12', 'AA', '2.1', 'Text spacing', ['axe', 'probe:text-spacing']),
  c('1.4.13', 'AA', '2.1', 'Content on hover or focus', ['probe:hover-content']),
  c('2.1.1', 'A', '2.0', 'Keyboard', ['axe', 'probe:keyboard']),
  c('2.1.2', 'A', '2.0', 'No keyboard trap', ['probe:keyboard']),
  c('2.1.4', 'A', '2.1', 'Character key shortcuts', ['probe:key-shortcuts']),
  // probe:timing-watch (deep) is left out on purpose: declared, a core scan would show 2.2.1 as not
  // tested although the core probe tested it. Its results still join this row with --full.
  c('2.2.1', 'A', '2.0', 'Timing adjustable', ['axe', 'probe:timing']),
  c('2.2.2', 'A', '2.0', 'Pause, stop, hide', ['axe', 'probe:motion']),
  c('2.3.1', 'A', '2.0', 'Three flashes or below threshold', ['probe:flash', 'probe:flash-motion']),
  c('2.4.1', 'A', '2.0', 'Bypass blocks', ['axe', 'probe:keyboard']),
  c('2.4.2', 'A', '2.0', 'Page titled', ['axe', 'probe:page-titles', 'pdf-checks', 'ai:pageText']),
  c('2.4.3', 'A', '2.0', 'Focus order', ['probe:keyboard', 'ai:focusOrder']),
  c('2.4.4', 'A', '2.0', 'Link purpose (in context)', ['axe', 'probe:link-purpose', 'probe:screen-reader', 'ai:pageText', 'ai:listener']),
  c('2.4.5', 'AA', '2.0', 'Multiple ways', ['site:consistency']),
  c('2.4.6', 'AA', '2.0', 'Headings and labels', ['probe:headings', 'ai:pageText', 'ai:listener']),
  c('2.4.7', 'AA', '2.0', 'Focus visible', ['probe:keyboard']),
  c('2.4.11', 'AA', '2.2', 'Focus not obscured (minimum)', ['probe:keyboard', 'probe:overlays']),
  c('2.5.1', 'A', '2.1', 'Pointer gestures', ['probe:pointer-gestures']),
  c('2.5.2', 'A', '2.1', 'Pointer cancellation', ['probe:pointer-cancellation']),
  c('2.5.3', 'A', '2.1', 'Label in name', ['axe', 'probe:names']),
  c('2.5.4', 'A', '2.1', 'Motion actuation', ['probe:motion-actuation']),
  c('2.5.7', 'AA', '2.2', 'Dragging movements', ['probe:pointer-gestures']),
  c('2.5.8', 'AA', '2.2', 'Target size (minimum)', ['axe']),
  c('3.1.1', 'A', '2.0', 'Language of page', ['axe', 'probe:language-parts', 'pdf-checks']),
  c('3.1.2', 'AA', '2.0', 'Language of parts', ['axe', 'probe:language-parts', 'ai:pageText']),
  c('3.2.1', 'A', '2.0', 'On focus', ['probe:keyboard']),
  c('3.2.2', 'A', '2.0', 'On input', ['probe:forms'], 'forms'),
  c('3.2.3', 'AA', '2.0', 'Consistent navigation', ['site:consistency']),
  c('3.2.4', 'AA', '2.0', 'Consistent identification', ['site:consistency', 'ai:consistency']),
  c('3.2.6', 'A', '2.2', 'Consistent help', ['site:consistency']),
  c('3.3.1', 'A', '2.0', 'Error identification', ['probe:forms', 'probe:screen-reader-live'], 'forms'),
  c('3.3.2', 'A', '2.0', 'Labels or instructions', ['axe', 'probe:form-fields', 'probe:forms', 'ai:pageText', 'ai:document']),
  c('3.3.3', 'AA', '2.0', 'Error suggestion', ['probe:forms', 'ai:forms'], 'forms'),
  c('3.3.4', 'AA', '2.0', 'Error prevention (legal, financial, data)', ['probe:form-fields', 'ai:forms'], 'forms'),
  c('3.3.7', 'A', '2.2', 'Redundant entry', ['probe:forms'], 'forms'),
  c('3.3.8', 'AA', '2.2', 'Accessible authentication (minimum)', ['probe:form-fields', 'ai:forms'], 'forms'),
  c('4.1.2', 'A', '2.0', 'Name, role, value', ['axe', 'probe:aria-states', 'probe:names', 'probe:screen-reader', 'probe:screen-reader-live', 'pdf-checks', 'ai:vision', 'ai:document', 'ai:listener']),
  c('4.1.3', 'AA', '2.1', 'Status messages', ['probe:forms', 'probe:screen-reader-live', 'ai:listener']),
];

/**
 * The axe-core rules the scan runs (scoring v2: the generated rule set in `ruleImpacts.ts`, i.e. tags
 * wcag2a/2aa/21a/21aa/22a/22aa plus the WCAG-tagged experimental rules enabled by id, minus deprecated
 * rules), by the WCAG criterion each is tagged with. A unit test checks this against the installed
 * axe-core and the generated rule set.
 */
export const AXE_RULES: Readonly<Record<string, readonly string[]>> = {
  '1.1.1': ['aria-meter-name', 'aria-progressbar-name', 'image-alt', 'input-image-alt', 'object-alt', 'role-img-alt', 'svg-img-alt'],
  '1.2.2': ['video-caption'],
  '1.3.1': [
    'aria-hidden-body', 'aria-required-children', 'aria-required-parent', 'definition-list', 'dlitem', 'list', 'listitem',
    'p-as-heading', 'table-fake-caption', 'td-has-header', 'td-headers-attr', 'th-has-data-cells',
  ],
  '1.3.4': ['css-orientation-lock'],
  '1.3.5': ['autocomplete-valid'],
  '1.4.1': ['link-in-text-block'],
  '1.4.2': ['no-autoplay-audio'],
  '1.4.3': ['color-contrast'],
  '1.4.4': ['meta-viewport'],
  '1.4.12': ['avoid-inline-spacing'],
  '2.1.1': ['frame-focusable-content', 'scrollable-region-focusable', 'server-side-image-map'],
  '2.2.1': ['meta-refresh'],
  '2.2.2': ['blink', 'marquee'],
  '2.4.1': ['bypass'],
  '2.4.2': ['document-title'],
  '2.4.4': ['area-alt', 'link-name'],
  '2.5.3': ['label-content-name-mismatch'],
  '2.5.8': ['target-size'],
  '3.1.1': ['html-has-lang', 'html-lang-valid', 'html-xml-lang-mismatch'],
  '3.1.2': ['valid-lang'],
  '3.3.2': ['form-field-multiple-labels'],
  '4.1.2': [
    'area-alt', 'aria-allowed-attr', 'aria-braille-equivalent', 'aria-command-name', 'aria-conditional-attr', 'aria-deprecated-role',
    'aria-hidden-body', 'aria-hidden-focus', 'aria-input-field-name', 'aria-prohibited-attr', 'aria-required-attr', 'aria-roles',
    'aria-tab-name', 'aria-toggle-field-name', 'aria-tooltip-name', 'aria-valid-attr', 'aria-valid-attr-value', 'button-name',
    'duplicate-id-aria', 'frame-title', 'frame-title-unique', 'input-button-name', 'input-image-alt', 'label', 'link-name',
    'nested-interactive', 'select-name', 'summary-name',
  ],
};

// The quick PDF checks behind each criterion live with the checks (src/documents/pdf.ts): the documents
// check's one rule (`documentStanding`, src/score.ts) reads them too.
export { PDF_FIELDS, pdfCriteria } from '../documents/pdf.js';

/**
 * Criteria the AI review is the main test of, with a test that adds only what it can measure by itself (1.4.5: the
 * picture test reads the words of SVG pictures; a photo or a scan it cannot read). When the AI review did not run the
 * row still says so ("needs the AI review") unless the test failed something: the test's "no failure found" never
 * stands for the bitmaps it did not read.
 */
export const AI_MAIN: Readonly<Record<string, readonly string[]>> = Object.freeze({ '1.4.5': ['picture-text'] });

/** In-page anchor of an axe rule's card in the HTML report (violations and undecided items). */
export const ruleAnchor = (id: string, needsReview = false) => `${needsReview ? 'review' : 'rule'}-${id.replace(/[^A-Za-z0-9_-]/g, '')}`;

// Deriving results --------------------------------------------------------------------------------

/** Another automated method's result for one criterion (the Plan 4 probe framework passes these). */
export interface CriterionExtra {
  criterion: string;
  method: CriterionMethodResult;
  evidence: CriterionResult['evidence'];
}

const ORDER: Record<CriterionStatus, number> = { failed: 4, flagged: 3, not_testable: 2, no_failures_found: 1, not_applicable: 0 };

/** The worst status: failed > flagged > not_testable > no_failures_found > not_applicable. */
export function worstStatus(statuses: readonly CriterionStatus[]): CriterionStatus {
  return statuses.reduce<CriterionStatus>((w, s) => (ORDER[s] > ORDER[w] ? s : w), 'not_applicable');
}

/** Evidence kept per criterion. */
export const MAX_EVIDENCE = 10;

/** The method for a criterion with no automated check yet. */
export const PENDING_METHOD: Readonly<CriterionMethodResult> = { id: 'pending', kind: 'rules', status: 'not_testable', pages: 0, note: 'automated check being built' };

type Derived = { method: CriterionMethodResult; evidence: CriterionResult['evidence'] };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shorten = (s: string, max = 160) => clipWords(s, max);

/** Batch 19: what makes a rule's node a person's call (`RuleSummary.flagged`), in the axe method's note. */
const FLAG_WHY: Readonly<Record<string, string>> = {
  'label-content-name-mismatch': 'whose names hold only part of the words shown, or hold them abbreviated',
  'link-in-text-block': 'in a navigation landmark or a breadcrumb trail, where colour may not be the only cue',
};

function axeMethod(def: CriterionDef, report: SiteReport): Derived | undefined {
  const rules = AXE_RULES[def.criterion];
  if (!rules?.length) return undefined;
  const loaded = report.pages.filter((p) => p.status === 'ok').length;
  const list = `rules ${rules.join(', ')}`;
  if (!loaded) return { method: { id: 'axe', kind: 'axe', status: 'not_testable', pages: 0, note: `no page loaded; ${list}` }, evidence: [] };
  const failed = report.rules.filter((r) => rules.includes(r.id));
  const undecided = report.needsReview.filter((r) => rules.includes(r.id));
  const evidence: CriterionResult['evidence'] = [
    ...failed.map((r) => ({ page: r.pagesAffected[0] ?? report.site, ...(r.examples[0] ? { target: r.examples[0].target } : {}),
      detail: `${r.help} (${r.id}: ${plural(r.elements, 'element')} on ${plural(r.pagesAffected.length, 'page')})`, anchor: ruleAnchor(r.id) })),
    ...undecided.map((r) => ({ page: r.pagesAffected[0] ?? report.site,
      detail: `${r.help} (${r.id}: ${plural(r.elements, 'element')} undecided by the rules; not in the score)`, anchor: ruleAnchor(r.id, true) })),
  ];
  const undecidedNote = undecided.length ? `; ${plural(undecided.reduce((n, r) => n + r.elements, 0), 'element')} undecided by the rules` : '';
  if (failed.length) {
    const pages = new Set(failed.flatMap((r) => r.pagesAffected)).size;
    return { method: { id: 'axe', kind: 'axe', status: 'failed', pages, note: `${list}${undecidedNote}` }, evidence };
  }
  // The review's second look doubted failures of these rules (`RuleSummary.secondLook`): Needs review, never "no
  // failures found".
  const doubted = undecided.filter((r) => r.secondLook);
  if (doubted.length) {
    const n = doubted.reduce((k, r) => k + (r.secondLook ?? 0), 0);
    return {
      method: { id: 'axe', kind: 'axe', status: 'flagged', pages: new Set(doubted.flatMap((r) => r.pagesAffected)).size,
        note: `${plural(n, 'element')} found by the rules and doubted on a second look: needs review; ${list}${undecidedNote}` },
      evidence,
    };
  }
  // Batch 19 (precision lane): elements the rules leave to a human (a label-in-name name that starts with the words shown
  // first and leaves out other text set apart inside the control): Needs review, never "no failures found".
  const flaggedUndecided = undecided.filter((r) => r.flagged);
  if (flaggedUndecided.length) {
    const n = flaggedUndecided.reduce((k, r) => k + (r.flagged ?? 0), 0);
    const why = flaggedUndecided.map((r) => FLAG_WHY[r.id] ?? 'that the rules leave to a person').filter((w, i, a) => a.indexOf(w) === i).join('; ');
    return {
      method: { id: 'axe', kind: 'axe', status: 'flagged', pages: new Set(flaggedUndecided.flatMap((r) => r.pagesAffected)).size,
        note: `${plural(n, 'element')} ${why}: needs review; ${list}${undecidedNote}` },
      evidence,
    };
  }
  // Fable review F1 (W3C precision lane): a control whose checked or expanded state the page leaves to the browser's
  // default may show another state, and nothing in the scan tells: not tested, never "no failures found".
  const unknown = undecided.reduce((n, r) => n + (r.unknownState ?? 0), 0);
  if (unknown) {
    return {
      method: { id: 'axe', kind: 'axe', status: 'not_testable', pages: loaded,
        note: `${plural(unknown, 'control')} leave${unknown === 1 ? 's' : ''} ${unknown === 1 ? 'its' : 'their'} checked or expanded state to the browser's default, which may not be the state shown; ${list}${undecidedNote}` },
      evidence,
    };
  }
  return { method: { id: 'axe', kind: 'axe', status: 'no_failures_found', pages: loaded, note: `${list}${undecidedNote}` }, evidence };
}

/** What a third-party method's note and remark say: where the failure is. */
export const THIRD_PARTY_NOTE = 'embedded content from another site';

/**
 * Failures inside frames from other sites (scoring v8 scores them, at a reduced weight): a criterion
 * one fails is failed, from embedded content, never "no failures found". Undefined when the report's
 * scorer does not count them (before v8) or none fails this criterion's rules.
 */
function thirdPartyMethod(def: CriterionDef, report: SiteReport): Derived | undefined {
  const rules = AXE_RULES[def.criterion];
  if (!rules?.length || !report.thirdParty?.length || !scoringScope(report).thirdParty) return undefined;
  const ok = new Set(report.pages.filter((p) => p.status === 'ok').map((p) => p.url));
  const failed = report.thirdParty.filter((t) => t && rules.includes(t.id) && t.pagesAffected.some((u) => ok.has(u)));
  if (!failed.length) return undefined;
  const pages = new Set(failed.flatMap((t) => t.pagesAffected.filter((u) => ok.has(u)))).size;
  const evidence = failed.map((t) => ({
    page: t.pagesAffected.find((u) => ok.has(u)) ?? report.site, ...(t.examples[0] ? { target: t.examples[0].target } : {}),
    detail: `${t.help} (${t.id}: ${plural(t.elements, 'element')} in a frame from ${t.origin || 'another site'}, on ${plural(t.pagesAffected.length, 'page')})`,
    anchor: `problem-third-party-${t.id.replace(/[^A-Za-z0-9_-]+/g, '-')}`,
  }));
  return { method: { id: 'third-party', kind: 'axe', status: 'failed', pages, note: `${THIRD_PARTY_NOTE}; rules ${[...new Set(failed.map((t) => t.id))].join(', ')}` }, evidence };
}

function pdfMethod(def: CriterionDef, report: SiteReport): Derived | undefined {
  const fields = PDF_FIELDS[def.criterion];
  if (!fields) return undefined;
  const pdfs = documentRows(report).filter((d) => d.type === 'pdf');
  const checked = pdfs.filter((d) => d.checks);
  const evidence: CriterionResult['evidence'] = [];
  let failing = 0;
  for (const d of checked) {
    const only = Object.fromEntries(fields.map((f) => [f, d.checks![f]])) as unknown as PdfChecks;
    const problems = pdfProblems(only);
    if (!problems.length) continue;
    failing++;
    const alt = d.accessibleAlternative ? ' (a version labeled accessible is linked next to it)' : '';
    for (const p of problems) evidence.push({ page: d.url, detail: `${p}${alt}`, anchor: 'docs' });
  }
  const id = 'pdf-checks';
  if (failing) return { method: { id, kind: 'rules', status: 'failed', pages: failing, note: `${plural(checked.length, 'PDF')} checked` }, evidence };
  // A PDF whose text-less pages have described figures that could not be shown to cover them (`scanUnmeasured`):
  // undecided for the scanned-image check's criterion, never "no failures found".
  const unsure = fields.includes('imageOnly') ? checked.filter((d) => d.checks!.scanUnmeasured === true) : [];
  if (unsure.length) {
    for (const d of unsure) evidence.push({ page: d.url, detail: 'Possible problem: a page with no text has figures with a text alternative, and whether they describe everything the page shows could not be measured.', anchor: 'docs' });
    return { method: { id, kind: 'rules', status: 'not_testable', pages: checked.length, note: `${plural(checked.length, 'PDF')} checked; in ${unsure.length} of them, whether the described figures cover the pages that have no text could not be measured` }, evidence };
  }
  // PDFs the time limit left unread: a criterion with no failure in the rest is partly tested, never "no failures found".
  const cut = pdfs.filter((d) => !d.checks && d.notChecked === TIME_LIMIT_REACHED).length;
  if (cut) return { method: { id, kind: 'rules', status: 'not_testable', pages: checked.length, note: partlyTested(checked.length, checked.length + cut, 'PDF') }, evidence };
  if (checked.length) return { method: { id, kind: 'rules', status: 'no_failures_found', pages: checked.length, note: `${plural(checked.length, 'PDF')} checked` }, evidence };
  if (pdfs.length) return { method: { id, kind: 'rules', status: 'not_testable', pages: 0, note: `${plural(pdfs.length, 'PDF')} found, none could be checked` }, evidence };
  return { method: { id, kind: 'rules', status: 'not_applicable', pages: 0, note: 'no PDFs found' }, evidence };
}

/** page -> the scored tests' outcome for `criterion`, on pages where one judged it (not untested). */
function testVerdicts(report: SiteReport, criterion: string): Map<string, ProbeOutcome> {
  const out = new Map<string, ProbeOutcome>();
  for (const [url, checks] of probeChecksFrom(report.probes?.runs ?? [], (pid) => SCORED_PROBES.has(pid))) {
    const o = checks[criterion];
    if (o && o !== 'untested') out.set(url, o);
  }
  return out;
}

function mediaMethod(def: CriterionDef, report: SiteReport): Derived | undefined {
  if (!report.media) return undefined;
  const items = report.media;
  const id = 'media-rules';
  if (!items.length) return { method: { id, kind: 'rules', status: 'not_applicable', pages: 0, note: 'no video or audio found' }, evidence: [] };
  const hits = items.flatMap((m) => m.issues.filter((i) => i.criterion === def.criterion).map((issue) => ({ m, issue })));
  const evidence = hits.map(({ m, issue }) => ({
    page: m.foundOn[0] ?? m.url, ...(m.url ? { target: m.url } : {}), detail: `${issue.level === 'problem' ? 'Problem' : 'Possible problem'}: ${issue.message}`, anchor: 'media',
  }));
  // A page a scored test tested and found no failure on is decided by the test, not the media rules
  // (the same rule as the score, criterionScore.ts): the rules' flag there costs nothing.
  const verdicts = testVerdicts(report, def.criterion);
  const ok = new Set(report.pages.filter((p) => p.status === 'ok').map((p) => p.url));
  const clearedPage = (u: string) => verdicts.get(u) === 'pass' || verdicts.get(u) === 'ran';
  const open = (m: MediaItem) => m.foundOn.filter((u) => (!ok.size || ok.has(u)) && !clearedPage(u));
  const unresolved = hits.filter((h) => open(h.m).length > 0 || !h.m.foundOn.length);
  const ruled = unresolved.filter((h) => h.issue.level === 'problem');
  if (ruled.length) {
    return { method: { id, kind: 'rules', status: 'failed', pages: new Set(ruled.flatMap((h) => (h.m.foundOn.length ? open(h.m) : [h.m.url]))).size, note: `${plural(items.length, 'item')} listed` }, evidence };
  }
  if (unresolved.length) {
    return { method: { id, kind: 'rules', status: 'not_testable', pages: unresolved.length, note: `the rules cannot decide ${plural(unresolved.length, 'item')} (for example captions inside embedded players)` }, evidence };
  }
  if (hits.length) {
    const pages = new Set(hits.flatMap((h) => h.m.foundOn)).size;
    return { method: { id, kind: 'rules', status: 'no_failures_found', pages, note: `${plural(items.length, 'item')} listed; on ${plural(pages, 'page')} the automated test of the page found no failure, and it decides this criterion there` }, evidence };
  }
  return { method: { id, kind: 'rules', status: 'no_failures_found', pages: items.length, note: `${plural(items.length, 'item')} listed` }, evidence };
}

/**
 * AI checks whose findings name only the criteria each item was judged on (see `aiMethod`). The listener
 * judges 1.1.1 only beside a screenshot and 4.1.3 only with the live pass's messages.
 */
const CRITERION_SCOPED_CHECKS: ReadonlySet<AiCheckId> = new Set<AiCheckId>(['forms', 'listener']);

/**
 * AI checks that add a judgment to a criterion another automated method already tests (the focus order
 * review reads the keyboard test's order): when the AI could not judge, they leave the criterion's
 * result as the other methods gave it, never "could not be tested".
 */
const ADDITIVE_CHECKS: ReadonlySet<AiCheckId> = new Set<AiCheckId>(['focusOrder']);

function consistencyMethod(def: CriterionDef, report: SiteReport): Derived {
  const r = report.consistency?.find((x) => x.criterion === def.criterion);
  if (!r) return { method: { id: 'consistency', kind: 'rules', status: 'not_testable', pages: 0, note: 'the pages were not compared for this report' }, evidence: [] };
  return { method: r.method, evidence: r.evidence };
}

function aiMethod(check: AiCheckId, def: CriterionDef, report: SiteReport, ids: readonly string[]): Derived | undefined {
  const r = report.ai?.runs.findIndex((run) => run.check === check) ?? -1;
  if (r < 0) return undefined;
  const run = report.ai!.runs[r]!;
  const matching = run.findings.map((f, i) => ({ f, i })).filter(({ f }) => criteriaOf(f).includes(def.criterion));
  // Scoring v5: confirmed image failures count toward the score; they are problems in "Fix these first".
  // A finding filed under several criteria ("1.2.3, 1.2.5") counts under the first (as the score counts it);
  // under the others it is an opinion.
  const countsHere = (f: AiFinding) => f.scored === true && String(f.criterion).split(',')[0]!.trim() === def.criterion;
  const scored = matching.filter(({ f }) => countsHere(f));
  const flagged = matching.filter(({ f }) => f.flagged && !countsHere(f));
  // The gated AI checks' criteria can count (the report's gates: src/aiLegacy.ts `aiGates`); there the note says what does.
  const scorable = (check === 'document' ? report.documentScore?.scored === true : report.aiChecks?.ran === true) && scoringScope(report).aiChecks.includes(check) && (aiGates(report)[check] ?? []).includes(def.criterion);
  const note = `${scorable ? 'AI review, only failures confirmed by two runs are in the score' : 'AI review, not in the score'}; ${run.reviewed} of ${plural(run.inputs, 'item')} reviewed`;
  const base = { id: check, kind: 'ai' as const };
  // The forms review files each item under the criteria it had input for (no error messages, no
  // 3.3.3): a criterion none of its items covered was not judged, so it says nothing about it.
  if (CRITERION_SCOPED_CHECKS.has(check) && run.inputs > 0 && !matching.length) {
    return { method: { ...base, status: 'not_applicable', pages: 0, note: 'nothing for this check to judge for this criterion on the scanned pages' }, evidence: [] };
  }
  if (scored.length) {
    // Keep the confirmed criterion result, but use the appendix's per-PDF eligibility for score wording.
    const eligible = check === 'document' ? reportAi(report)!.runs[r]!.findings : run.findings;
    const counted = scored.filter(({ i }) => eligible[i]?.scored).length;
    const scoreNote = counted === scored.length ? 'scored' : counted ? 'only checked PDFs in the score' : 'not in the score';
    // A confirmed PDF problem (scoring v10) counts in the documents check: it points at the Documents section.
    const anchor = check === 'document' ? 'docs' : `problem-ai-${def.criterion.replace(/[^0-9]+/g, '-')}`;
    const evidence = [
      ...scored.map(({ f }) => ({ page: f.page, target: f.target, detail: shorten(`${f.label}: found by the AI review, confirmed by two runs`, 240), anchor })),
      ...flagged.map(({ f, i }) => ({ page: f.page, target: f.target, detail: shorten(f.issue ? `${f.label}: ${f.issue}` : f.label, 240), anchor: findingId(ids[r]!, i) })),
    ];
    return {
      method: { ...base, status: 'failed', pages: new Set(scored.map(({ f }) => f.page)).size, note: `AI review, confirmed by two runs (${scoreNote}); ${run.reviewed} of ${plural(run.inputs, 'item')} reviewed` },
      evidence,
    };
  }
  if (flagged.length) {
    const evidence = flagged.map(({ f, i }) => ({
      page: f.page, target: f.target, detail: shorten(f.issue ? `${f.label}: ${f.issue}` : f.label, 240), anchor: findingId(ids[r]!, i),
    }));
    return { method: { ...base, status: 'flagged', pages: new Set(flagged.map(({ f }) => f.page)).size, note }, evidence };
  }
  if (run.inputs === 0) return { method: { ...base, status: 'not_applicable', pages: 0, note: 'nothing for this check on the scanned pages' }, evidence: [] };
  if (run.reviewed === 0 || (matching.length && matching.every(({ f }) => isNotJudged(f)))) {
    if (ADDITIVE_CHECKS.has(check)) return undefined;
    return { method: { ...base, status: 'not_testable', pages: 0, note: 'the AI could not judge the items, or they could not be sent' }, evidence: [] };
  }
  return { method: { ...base, status: 'no_failures_found', pages: new Set(run.findings.map((f) => f.page)).size, note }, evidence: [] };
}

function derive(id: MethodId, def: CriterionDef, report: SiteReport, ids: readonly string[]): Derived | undefined {
  if (id.startsWith('probe:')) return undefined; // results come from `extra` (see buildCriteria)
  if (id === 'site:consistency') return consistencyMethod(def, report);
  if (id === 'axe') return axeMethod(def, report);
  if (id === 'pdf-checks') return pdfMethod(def, report);
  if (id === 'media-rules') return mediaMethod(def, report);
  return aiMethod(id.slice(3) as AiCheckId, def, report, ids);
}

/** Why a scoped criterion does not apply to this scan, or undefined when it may apply (or the report cannot tell). */
function outOfScope(scope: CriterionScope | undefined, report: SiteReport): string | undefined {
  if (scope === 'media' && report.media && report.media.length === 0) return 'no video or audio found on the scanned pages';
  if (scope === 'forms' && report.inventory && report.inventory.formPages.length === 0) return 'no form fields found on the scanned pages';
  return undefined;
}

/**
 * The 55 criterion rows for a report. `extra` adds results from other automated methods (one
 * method and its evidence per entry). A criterion no method ran for gets `PENDING_METHOD`, or a
 * not-testable AI method when only the AI review (not run in this scan) could test it.
 */
export function buildCriteria(report: SiteReport, extra: readonly CriterionExtra[] = []): CriterionResult[] {
  const ids = report.ai ? runIds(report.ai) : [];
  return CRITERIA.map((def) => {
    const derived = def.methods.flatMap((m) => [derive(m, def, report, ids), ...(m === 'axe' ? [thirdPartyMethod(def, report)] : [])]).filter((d): d is Derived => d !== undefined);
    // Whether an AI check gave this criterion a result (the AI review ran), before the tests' results are added.
    const aiRan = derived.some((d) => d.method.kind === 'ai');
    const adds = AI_MAIN[def.criterion];
    const mine = extra.filter((e) => e.criterion === def.criterion);
    derived.push(...mine.map((e) => {
      // A probe's own caveat on a clean result (what it does not watch) goes with its method.
      const caveat = e.method.status === 'no_failures_found' ? PROBES.find((p) => p.id === e.method.id)?.note : undefined;
      const method = caveat ? { ...e.method, note: e.method.note ? `${e.method.note}; ${caveat}` : caveat } : e.method;
      return { method, evidence: e.evidence };
    }));
    // A declared probe with no result for this criterion still gets an automated status saying why.
    for (const m of def.methods) {
      if (!m.startsWith('probe:')) continue;
      const id = m.slice(6);
      if (mine.some((e) => e.method.id === id)) continue;
      const probe = PROBES.find((p) => p.id === id);
      const note = !probe ? 'automated check being built'
        : !report.probes ? 'the automated interaction and render tests were turned off for this scan'
        : report.notChecked?.some((x) => x.stage === (probe.tier === 'deep' ? 'deep-tests' : 'core-tests')) ? 'not run: the scan ran out of time'
        : probe.tier === 'deep' && !report.probes.runs.some((r) => r.probe === id) ? 'a deep automated test, not run in this scan'
        : 'the test did not run on the scanned pages';
      derived.push({ method: { id, kind: probe?.kind ?? 'interaction', status: 'not_testable', pages: 0, note }, evidence: [] });
    }
    // The AI review is this criterion's main test and did not run: said, whatever the adding test found clean.
    if (adds && !aiRan) derived.push({ method: { id: 'ai', kind: 'ai', status: 'not_testable', pages: 0, note: 'needs the AI review, which was not run in this scan' }, evidence: [] });
    if (!derived.length) {
      const aiOnly = def.methods.length > 0 && def.methods.every((m) => m.startsWith('ai:'));
      derived.push({
        method: aiOnly ? { id: 'ai', kind: 'ai', status: 'not_testable', pages: 0, note: 'needs the AI review, which was not run in this scan' } : { ...PENDING_METHOD },
        evidence: [],
      });
    }
    const scope = outOfScope(def.appliesTo, report);
    const methods = derived.map(({ method, evidence }) =>
      (scope && !evidence.length && method.status !== 'failed' && method.status !== 'flagged' ? { ...method, status: 'not_applicable' as const, note: scope } : method));
    return {
      criterion: def.criterion,
      level: def.level,
      wcag: def.wcag,
      title: def.title,
      status: worstStatus(methods.map((m) => m.status)),
      methods,
      evidence: derived.flatMap((d) => d.evidence).slice(0, MAX_EVIDENCE),
    };
  });
}

// Rendering ---------------------------------------------------------------------------------------

/**
 * Plain-language labels for each status. Never "passed". 'flagged' is Needs review (batch 19): the AI review flags a
 * likely problem, or a test leaves a decision to a human (a label-in-name name that starts with the words shown first);
 * neither is a failure, and the label must not say AI where no AI ran.
 */
export const STATUS_LABEL: Readonly<Record<CriterionStatus, string>> = {
  failed: 'Failed',
  flagged: 'Needs review',
  no_failures_found: 'No failures found by automated tests',
  not_applicable: 'Not applicable',
  not_testable: 'Could not be tested automatically on this site',
};

/** The same in running text (counts, method lines). */
const STATUS_TEXT: Readonly<Record<CriterionStatus, string>> = {
  failed: 'failed',
  flagged: 'need review',
  no_failures_found: 'no failures found by automated tests',
  not_applicable: 'not applicable',
  not_testable: 'could not be tested automatically',
};

const STATUS_ORDER: readonly CriterionStatus[] = ['failed', 'flagged', 'not_testable', 'no_failures_found', 'not_applicable'];

export function criteriaCounts(rows: readonly CriterionResult[]): Record<CriterionStatus, number> {
  const counts = { failed: 0, flagged: 0, no_failures_found: 0, not_applicable: 0, not_testable: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

/**
 * Evidence and reasons as the report shows them. A stored report (report.json) keeps what the scan
 * wrote, from before results-only reports too; the report never repeats the mechanism behind a
 * double-checked AI finding or a test's per-page and per-scan limits.
 */
export function shownText(s: string): string {
  return s
    .replace(/,? ?confirmed by two (independent )?runs/g, ', double-checked')
    // A test's own limits ("(the test checks 5 per page)", "this deep test runs on at most 40 pages a scan").
    .replace(/\s*\(the test [^()]*\)/g, '')
    .replace(/: this deep test runs on at most \d+ pages a scan/g, '');
}

/** "3 failed · 1 needs review · …" for the 55 rows. */
export function criteriaLine(rows: readonly CriterionResult[]): string {
  const n = criteriaCounts(rows);
  return STATUS_ORDER.map((s) => `${n[s]} ${s === 'flagged' && n[s] === 1 ? 'needs review' : STATUS_TEXT[s]}`).join(' · ');
}

/** One line for the terminal summary. */
export function criteriaTerminalLine(report: SiteReport): string {
  const rows = report.criteria ?? buildCriteria(report);
  return `WCAG 2.2 A/AA criteria (${rows.length}): ${criteriaLine(rows)}`;
}
