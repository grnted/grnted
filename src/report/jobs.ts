// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3: presentation only. The scoring checks and their costs are never changed here.
import { SCORED_PROBES } from '../probes/registry.js';
import { probeLabel } from '../probes/labels.js';
import type { PageAudit, ProbeRun, SiteReport } from '../types.js';
import { officeProblems } from '../documents/office.js';
import { reportDocumentProblems } from '../aiScore.js';
import { documentCriteria } from '../score.js';
import { CRITERIA } from './criteria.js';
import type { MeasuredPage, Problem } from './model.js';
import { buildProblems } from './problems.js';
import { jobContent, jobOrder, problemFix, type JobCode } from './jobContent.js';
import { milestones as planMilestones, projectJobs, type Milestone } from './jobScore.js';

/** An id selector, including CSS escapes (`#\\31 23` for id="123") and non-ASCII ids (`#保存`). */
const ID_SELECTOR = /#(?:[\w-]|\\[0-9a-fA-F]{1,6} ?|\\[^0-9a-fA-F\r\n]|[^\x00-\x7F])+/;

export interface RepairProblem {
  code: string;
  sourceKey: string;
  sourceKeys: string[];
  observations: RepairObservation[];
  shared: boolean;
  fingerprint: string;
  title: string;
  action: string;
  check: string;
  criteria: string[];
  pages: string[];
  locations: { page: string; target: string }[];
  occurrences: number;
  scored: boolean;
  /**
   * Batch 15b (`Problem.measured`): every page of this problem where its failure was measured, with how ("full test",
   * "checked on this page") and whether that page counts in the score. Absent: every page is a full test, as before.
   */
  measured?: MeasuredPage[];
  urgent: boolean;
  harm: number;
  service: number;
  job: string;
  relatedJobs: string[];
  /** Report v3: 2 to 4 short numbered steps that fix it (copy/fixes.ts). */
  steps: string[];
  /** Report v3: the code change, built from the element's own HTML where the scan kept it (absent: steps only). */
  codeFix?: JobCode;
}
export interface RepairJob {
  code: string;
  kind: 'template' | 'controls' | 'content' | 'settings' | 'documents' | 'media' | 'disruption';
  title: string;
  where: string;
  lead: string;
  dependency: string;
  pages: string[];
  problems: string[];
  relatedJobs: string[];
  urgent: boolean;
  harm: number;
  service: number;
  effort: 'S' | 'M' | 'L';
  volume: string;
  /** Report v3: one sentence on what is different once the job is done. (`title` is written from the job's causes and reach.) */
  whatChanges: string;
  /** Report v3: short numbered steps for the whole job. */
  steps: string[];
  /** Report v3: the job's lead code change (from its most important problem that has one). */
  codeFix?: JobCode;
  /**
   * Report v3: the score once this job and every earlier one in the plan is done, from the real scorer
   * (jobScore.ts); null when the report has no projection. `gain` is what this job adds; `grantedAfter`
   * whether the site would then be Access Granted (90 or more and no blocking failure left).
   */
  scoreAfter: number | null;
  gain: number | null;
  grantedAfter: boolean | null;
}
export interface RepairObservation { page: string; target: string; test: string; detail: string; html?: string; data?: Record<string, number | string> }
export interface RepairCodeMap {
  problems: { code: string; matches: string[]; aliases: string[] }[];
  jobs: { code: string; identity: string }[];
}
export interface RepairModel {
  problems: RepairProblem[];
  jobs: RepairJob[];
  codeMap: RepairCodeMap;
  /** Report v3: per standard, the job after which no automated failure of it is left (jobScore.ts). */
  milestones: Milestone[];
  /** Report v3: the job (its place in the plan, 1 = first) after which the site would be Access Granted; 0 already; null never in this plan or no projection. */
  grantedAfterJob: number | null;
}
export interface ReportCoverage {
  rulePages: string[];
  interactionPages: string[];
  keyboardPages: string[];
  sampled: boolean;
  tests: { test: string; pages: string[]; unsuccessful: number; unresolved: number }[];
  excluded: { url: string; reason: string }[];
  unsuccessfulTests: { page: string; test: string; reason: string }[];
  unresolved: { criterion: string; pages: string[]; reason: string }[];
  notChecked: { stage: string; detail: string }[];
  standards: { wcag21: string[]; additional22: string[] };
}

const unique = (values: readonly string[]) => [...new Set(values)].sort();
const matchPath = (url: string) => { try { const u = new URL(url); return `${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; } catch { return url; } };
const path = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
const shortLocation = (url: string) => { const s = path(url); return s.length > 80 ? `${s.slice(0, 79)}…` : s; };
/** Keep structural ancestors, classes and roles: similar controls in different templates never merge. */
export function elementFingerprint(failure: string, selector: string, html = ''): string {
  const target = selector.trim().replace(/:nth-(?:of-type|child)\(\d+\)/g, ':nth(*)').replace(/\s+/g, ' ');
  const shape = html.replace(/>[\s\S]*?</g, '><').replace(/\s(?:id|data-[\w-]+)=(?:"[^"]*"|'[^']*')/g, '').replace(/\s+/g, ' ').trim();
  return `${failure}\n${target}\n${shape}`;
}

/** Lossless cause distributions gathered before the old report's occurrence/example caps. */
export function ruleCauses(pages: readonly PageAudit[], id: string): NonNullable<SiteReport['rules'][number]['causes']> {
  const causes = new Map<string, { fingerprint: string; pages: string[]; target: string; html: string; occurrences: number; locations: RepairObservation[] }>();
  for (const page of pages) for (const rule of page.violations) {
    if (rule.id !== id) continue;
    for (const node of rule.nodes) {
      const fingerprint = elementFingerprint(`rule:${id}`, node.target, node.html);
      let c = causes.get(fingerprint);
      if (!c) { c = { fingerprint, pages: [], target: node.target, html: node.html.slice(0, 300), occurrences: 0, locations: [] }; causes.set(fingerprint, c); }
      if (!c.pages.includes(page.url)) c.pages.push(page.url);
      c.locations.push({ page: page.url, target: node.target, html: node.html, detail: node.failureSummary ?? rule.help, test: `rule:${id}` });
      c.occurrences++;
    }
  }
  return [...causes.values()];
}

function completion(criteria: readonly string[], key: string): string {
  if (key === 'documents' || key === 'office') return 'Open the repaired source export with a screen reader; check tags, reading order, names and text, then rescan.';
  if (criteria.includes('2.1.2')) return 'Tab and Shift+Tab through the entire form, including Send, and leave every field; then rescan.';
  if (criteria.includes('2.3.1')) return 'Remove the flashing effect; verify the repaired page has no unsafe flashing, then rescan.';
  if (criteria.includes('1.4.2')) return 'Reload with sound on; confirm sound stays off or a keyboard-accessible stop control works, then rescan.';
  if (criteria.includes('2.2.2')) return 'Start the page; pause each moving item with keyboard and pointer, then rescan.';
  if (criteria.some((c) => c.startsWith('1.2.'))) return 'Play the full asset; a person checks captions, transcript and description against the content, then rescan.';
  if (criteria.some((c) => /^(2\.1|2\.4\.(3|7|11)|3\.2\.1)/.test(c))) return 'Use Tab, Shift+Tab, Enter, Space and Escape; confirm access and visible focus, then rescan.';
  if (criteria.some((c) => c.startsWith('3.3.') || c === '4.1.3')) return 'Complete the task with keyboard and screen reader, including errors and success; rescan.';
  if (criteria.some((c) => c.startsWith('1.4.'))) return 'Check at phone width, zoom and high contrast against the required action; rescan.';
  return 'Verify the action with keyboard and screen reader; rescan.';
}

/**
 * A criterion problem's runs: those of its own kind of test (scored or not). Batch 15b's wider test coverage
 * (`ProbeRun.coverage`, `ProbeRun.checked`) runs scored tests outside the score: a problem only those runs found is
 * not scored (and not the listed one), and its runs are those wider runs. A report without them reads as before.
 */
const ownsRun = (p: Problem, run: ProbeRun) => p.scored === SCORED_PROBES.has(run.probe)
  || (!p.scored && !p.key.endsWith('/listed') && SCORED_PROBES.has(run.probe) && Boolean(run.coverage || run.checked));
/** The pages a problem's failure was measured on: its own, and those of the wider coverage (`Problem.measured`). */
const measuredOn = (p: Problem, page: string) => p.pages.includes(page) || (p.measured ?? []).some((m) => m.page === page);
const probeCauseTest = (probe: string, detail: string) => ['headings', 'screen-reader'].includes(probe) && /(?:levels? (?:skip|[0-9])|headings list jumps)/i.test(detail) ? 'heading-levels' : probe;

interface Cause { observations?: RepairObservation[]; fingerprint: string; pages: string[]; locations: { page: string; target: string }[]; occurrences: number }
function causesOf(p: Problem, report: SiteReport): Cause[] {
  if (p.key === 'documents' || p.key === 'office') {
    return (p.documents ?? p.officeFiles ?? []).map((d) => ({ fingerprint: `${p.key}\n${d.url}`, pages: unique(d.linkedFrom), locations: [{ page: d.url, target: '' }], occurrences: 1 }));
  }
  if (p.key.startsWith('rule:')) {
    const r = report.rules.find((r) => `rule:${r.id}` === p.key);
    if (r?.causes?.length) return r.causes.map((c) => ({ ...c, fingerprint: `${p.key}\n${c.fingerprint.split('\n').slice(1).join('\n')}`, pages: unique(c.pages), locations: c.locations ?? c.pages.map((page) => ({ page, target: c.target })), observations: c.locations }));
    const groups = new Map<string, Cause>();
    for (const o of r?.occurrences?.length ? r.occurrences : r?.examples ?? []) {
      const fingerprint = elementFingerprint(p.key, o.target); // old snapshots have no HTML for every occurrence
      let c = groups.get(fingerprint);
      if (!c) { c = { fingerprint, pages: [], locations: [], occurrences: 0 }; groups.set(fingerprint, c); }
      c.pages.push(o.page); c.locations.push(o); c.occurrences++;
    }
    if (groups.size) {
      const out = [...groups.values()].map((c) => ({ ...c, pages: unique(c.pages) }));
      // A capped legacy inventory is not proof that unlisted pages have this same cause.
      const missing = p.pages.filter((u) => !out.some((c) => c.pages.includes(u)));
      if (missing.length) out.push({ fingerprint: `${p.key}\nunlocated`, pages: unique(missing), locations: missing.map((page) => ({ page, target: 'Location not retained in this scan snapshot' })), occurrences: Math.max(missing.length, p.count.n - out.reduce((n, c) => n + c.occurrences, 0)) });
      return out;
    }
  }
  if (p.key.startsWith('media:')) {
    const criterion = p.key.slice(6);
    const assets: Cause[] = [];
    for (const item of report.media ?? []) {
      if (!item.issues.some((i) => i.level === 'problem' && i.criterion === criterion)) continue;
      const scopes = item.url ? [item.foundOn] : item.foundOn.map((page) => [page]);
      for (const scope of scopes) assets.push({
        fingerprint: `${p.key}\n${item.kind}\n${item.url || `${scope[0]}:${item.name ?? 'inline player'}`}`,
        pages: unique(scope), occurrences: Math.max(1, scope.length),
        locations: scope.length ? scope.map((page) => ({ page, target: item.url || item.name || `Inline ${item.kind}` })) : [{ page: item.url, target: '' }],
      });
    }
    if (assets.length) return assets;
  }
  // Preserve the probe's cause distinction. Repeated observations of one criterion and target merge;
  // a different probe or target is a different problem, even on the same element.
  const found = new Map<string, Cause>();
  if (p.key.startsWith('criterion:')) for (const run of report.probes?.runs ?? []) for (const f of run.findings) {
    if (!ownsRun(p, run) || f.status !== 'failed' || f.coveredBy || !measuredOn(p, run.page) || !p.criteria.some((c) => c.criterion === f.criterion)) continue;
    const method = probeCauseTest(run.probe, f.detail);
    const fingerprint = elementFingerprint(`${p.key.replace(/\/listed$/, '')}:${method}`, f.target ?? 'page');
    let c = found.get(fingerprint);
    if (!c) { c = { fingerprint, pages: [], locations: [], occurrences: 0 }; found.set(fingerprint, c); }
    c.pages.push(run.page); c.locations.push({ page: run.page, target: f.target ?? '' }); c.occurrences++;
  }
  if (found.size) return [...found.values()].map((c) => ({ ...c, pages: unique(c.pages) }));
  return [{ fingerprint: p.key.replace(/\/listed$/, ''), pages: unique(p.pages), locations: p.textEvidence.map((e) => ({ page: e.page, target: e.target ?? '' })), occurrences: p.count.n }];
}

const DISRUPTION = new Set(['1.4.2', '2.2.2', '2.3.1']);
const IMPORTANCE = /\b(contact|apply|application|enroll|pay|payment|emergency|register|registration|permit|sign-in|login)\b/i;
const IMPACT: Record<string, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 };
const TITLES: Record<RepairJob['kind'], string> = {
  disruption: 'Control sound, flashing and movement', template: 'Repair appearance, navigation and focus', controls: 'Repair page controls',
  documents: 'Repair documents in their source files', media: 'Provide media alternatives', content: 'Repair page content', settings: 'Repair page settings and remaining controls',
};

/** Compact internal matching signals keep mutable page markup out of rescan summaries. */
function signal(value: string): string {
  let a = 2166136261; let b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return `${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

/** Matching signals are scoped to a test and page path; mutable presentation HTML is not identity. */
function matchKeys(p: RepairProblem, kind: 'stable' | 'exact' | 'name' | 'normalized' | 'all' = 'all'): string[] {
  const selector = (s: string) => s.trim().replace(/:nth-(?:of-type|child)\(\d+\)/g, ':nth(*)').replace(/\s+/g, ' ');
  const sourcesAt = (page: string, target: string) => (p.sourceKeys ?? [p.sourceKey]).flatMap((source) => {
    const key = source.replace(/\/listed$/, '');
    if (!key.startsWith('criterion:')) return [key];
    const methods = unique((p.observations ?? []).filter((o) => o.page === page && o.target === target && !/^(?:criterion:|rule:|media:)/.test(o.test)).map((o) => o.test));
    return methods.length ? methods.map((method) => `${key}:${method}`) : [key];
  });
  const keys: string[] = [];
  for (const l of p.locations) for (const source of sourcesAt(l.page, l.target)) {
    const link = /(?:^|[\s>+~])a(?=[.#[:\s>+~]|$)/i.test(l.target) || (p.observations ?? []).some((o) => o.page === l.page && o.target === l.target && /^<a\b/i.test(o.html ?? ''));
    const attributes = [...l.target.matchAll(/\[\s*([\w-]+)\s*=\s*(?:"[^"]+"|'[^']+'|[^\s\]"']+)(?:\s+[is])?\s*\]/g)];
    const identified = ID_SELECTOR.test(l.target.replace(/\[[^\]]*\]/g, '')) || attributes.some((a) => /^(?:id|data-testid|data-test|data-id|name|for)$/i.test(a[1]!) || link && a[1]!.toLowerCase() === 'href');
    if (kind === 'all' || kind === 'exact' || kind === 'stable' && identified) keys.push(`exact:${signal(`${source}\n${matchPath(l.page)}\n${l.target.trim()}`)}`);
    if (kind === 'all' || kind === 'normalized') keys.push(signal(`${source}\n${matchPath(l.page)}\nselector:${selector(l.target)}`));
  }
  if (kind === 'all' || kind === 'name') for (const o of p.observations ?? []) {
    const name = /\baria-label=["']([^"']+)["']/.exec(o.html ?? '')?.[1] ?? (o.html ?? '').replace(/<[^>]*>/g, '').trim();
    if (name) for (const source of sourcesAt(o.page, o.target)) {
      const key = signal(`${source}\n${matchPath(o.page)}\nname:${name}`);
      keys.push(key, `name:${key}`); // The bare key also matches code maps from earlier scans.
    }
  }
  return unique(keys);
}

function observationsOf(p: Problem, cause: Cause, report: SiteReport): RepairObservation[] {
  const out: RepairObservation[] = [...cause.observations ?? []];
  const matches = (page: string, target = '') => cause.locations.some((l) => l.page === page && l.target === target);
  if (p.key.startsWith('rule:')) {
    const r = report.rules.find((r) => `rule:${r.id}` === p.key);
    for (const e of r?.examples ?? []) if (matches(e.page, e.target) && !out.some((o) => o.page === e.page && o.target === e.target && o.html === e.html)) out.push({ page: e.page, target: e.target, test: p.key, detail: r?.help ?? '', html: e.html });
  }
  for (const run of report.probes?.runs ?? []) for (const f of run.findings) {
    const ownsCriterion = p.key.startsWith('criterion:') && ownsRun(p, run) && f.status === 'failed' && !f.coveredBy && p.criteria.some((c) => c.criterion === f.criterion)
      && (cause.fingerprint.startsWith(`${p.key.replace(/\/listed$/, '')}:${probeCauseTest(run.probe, f.detail)}\n`) || cause.fingerprint === p.key.replace(/\/listed$/, ''));
    if ((f.coveredBy === p.key || ownsCriterion) && matches(run.page, f.target)) out.push({ page: run.page, target: f.target ?? '', test: run.probe, detail: f.detail, ...(f.data ? { data: f.data } : {}) });
  }
  if (!p.key.startsWith('criterion:') || !out.length) for (const e of p.textEvidence) if (matches(e.page, e.target) && !out.some((o) => o.page === e.page && o.target === (e.target ?? '') && o.detail === e.detail)) {
    const tests = p.key.startsWith('criterion:') ? report.testIssues?.find((t) => `criterion:${t.criterion}` === p.key)?.probes ?? [p.key] : [p.key];
    for (const test of tests) out.push({ page: e.page, target: e.target ?? '', test, detail: e.detail });
  }

  if (p.key.startsWith('media:')) for (const m of report.media ?? []) if (cause.locations.some((l) => l.target === m.url)) for (const issue of m.issues) if (`media:${issue.criterion}` === p.key) for (const page of m.foundOn) out.push({ page, target: m.url, test: `media:${issue.rule}`, detail: issue.message });
  const file = (p.documents ?? p.officeFiles ?? []).find((d) => cause.locations.some((l) => l.page === d.url));
  const ai = file && 'aiProblems' in file ? file.aiProblems ?? 0 : 0;
  const fileTest = p.key === 'documents' ? [file!.problems.length > ai ? 'Quick PDF checks' : '', ai ? 'AI review, double-checked' : ''].filter(Boolean).join('; ') : p.key;
  for (const detail of file?.problems ?? []) out.push({ page: file!.url, target: '', test: fileTest, detail });
  return [...new Map(out.map((o) => [JSON.stringify(o), o])).values()];
}

function repairInstructions(p: Problem, cause: Cause, report: SiteReport): { title: string; action: string; check?: string } {
  const observed = observationsOf(p, cause, report).map((o) => o.detail).join(' ');
  const heading = /(?:levels? skip(?:s)? from|list jumps from level) (\d) to (?:level )?(\d): [“"]([^”"]+)/i.exec(observed);
  if (heading) return { title: `Heading level skips from ${heading[1]} to ${heading[2]} — “${heading[3]}”`, action: 'Put this heading at the appropriate level in the page structure.', check: 'Check the heading list with a screen reader, then rescan.' };
  if (p.key === 'documents') {
    const d = report.documentChecks?.find((d) => d.url === cause.locations[0]?.page);
    const c = d?.checks;
    if (c) {
      const actions = [
        c.tagged === false ? 'Add semantic tags and correct reading order in the source export.' : '',
        c.hasTitle === false ? 'Set a descriptive document title.' : '',
        c.showsTitle === false ? 'Set the PDF viewer to display the document title.' : '',
        c.hasLanguage === false ? 'Set the document language.' : '',
        c.imageOnly ? 'Run text recognition (OCR), correct the text and tag the result.' : '',
        c.figuresWithoutAlt ? 'Write a meaningful picture description for each unlabeled figure.' : '',
        c.xfa ? 'Replace the XFA form with an accessible HTML form or a tagged PDF form.' : '',
        c.untitledFormFields ? 'Give every form field an accessible name and verify its label.' : '',
        c.blocksAssistiveTech ? 'Remove security restrictions that block assistive technology.' : '',
      ].filter(Boolean);
      const checks = [
        c.tagged === false ? 'Read headings, lists and tables in the correct order with a screen reader.' : '',
        c.hasTitle === false ? 'Confirm a descriptive title in document properties.' : '',
        c.showsTitle === false ? 'Confirm the reader displays the title instead of the file name.' : '',
        c.hasLanguage === false ? 'Confirm the document language and pronunciation.' : '',
        c.imageOnly ? 'Select and search the corrected text, then read it with a screen reader.' : '',
        c.figuresWithoutAlt ? 'Read each picture description with a screen reader.' : '',
        c.xfa ? 'Complete the replacement form with keyboard and screen reader.' : '',
        c.untitledFormFields ? 'Confirm every field is announced by name.' : '',
        c.blocksAssistiveTech ? 'Confirm assistive technology can read the file without a security restriction.' : '',
      ].filter(Boolean);
      return { title: `Repair ${cause.locations[0]!.page.split('/').pop()}`, action: actions.join(' ') || p.copy.fix,
        check: `${checks.join(' ')} Rerun the document checks.` };
    }
  }
  if (p.key === 'office') {
    const d = p.officeFiles?.find((d) => d.url === cause.locations[0]?.page);
    return { title: `Repair ${cause.locations[0]!.page.split('/').pop()}`, action: `In this file’s accessibility checker, repair: ${d?.problems.join(' ') ?? ''} Publish the corrected source export.`, check: 'Check each listed defect in this file with a screen reader, then rescan.' };
  }
  return { title: p.copy.title, action: p.copy.fix };
}

/** Batch 15b: the measured pages of this cause (`RepairProblem.measured`), when the problem has any. */
function measuredOf(p: Problem, cause: Cause): { measured?: MeasuredPage[] } {
  const list = (p.measured ?? []).filter((m) => cause.pages.includes(m.page));
  return list.length ? { measured: list } : {};
}

function mergeMediaObservations(problems: RepairProblem[], jobs: Map<string, RepairJob>, report: SiteReport): void {
  for (const asset of [...problems].filter((p) => p.sourceKey.startsWith('media:'))) {
    const criterion = asset.sourceKey.slice(6);
    const item = report.media?.find((m) => asset.locations.some((l) => l.target === m.url));
    if (!item) continue;
    const candidates = problems.filter((p) => p.sourceKey.startsWith(`criterion:${criterion}`) && p.pages.length === 1 && asset.pages.includes(p.pages[0]!) && p.locations.every((l) => new RegExp(`(?:^|[ >])${item.kind}(?:$|[.# :>])`).test(l.target)));
    // Do not infer a file/player relationship where more than one could match.
    if (candidates.length !== 1 || (report.media ?? []).filter((m) => m.kind === item.kind && m.foundOn.includes(candidates[0]!.pages[0]!) && m.issues.some((i) => i.criterion === criterion && i.level === 'problem')).length !== 1) continue;
    const player = candidates[0]!;
    player.sourceKeys = unique([...player.sourceKeys, ...asset.sourceKeys]);
    player.locations.push(...asset.locations); player.observations.push(...asset.observations);
    player.pages = unique([...player.pages, ...asset.pages]); player.scored ||= asset.scored;
    problems.splice(problems.indexOf(asset), 1);
    for (const [key, job] of jobs) {
      job.problems = job.problems.filter((c) => c !== asset.code);
      if (!job.problems.length) jobs.delete(key);
    }
  }
}

export function buildJobs(report: SiteReport, legacy = buildProblems(report), previous = report.repair?.codeMap): RepairModel {
  const problems: RepairProblem[] = [];
  const confirmedDocuments = reportDocumentProblems(report);
  const loadedPages = report.pages.filter((p) => p.status === 'ok');
  const loaded = loadedPages.length;
  const sectionCounts = new Map<string, number>();
  for (const p of loadedPages) { const section = path(p.url).split('/').filter(Boolean)[0] ?? ''; sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1); }
  const jobs = new Map<string, RepairJob>();

  for (const p of legacy) for (const cause of causesOf(p, report)) {
    // Batch 15b: pages measured outside the score are listed with the cause, but its kind, job and rank come from
    // the score's own pages (as before the wider coverage), so a rescan keeps its job codes. A cause found only
    // outside the score uses those pages, and is not scored.
    const inScore = p.measured ? cause.pages.filter((u) => p.pages.includes(u)) : cause.pages;
    const own = inScore.length ? inScore : cause.pages;
    const file = p.key === 'documents' || p.key === 'office' ? report.documentChecks?.find((d) => d.url === cause.locations[0]?.page) : undefined;
    const criteria = file?.checks ? documentCriteria(file, confirmedDocuments) : file?.officeChecks ? unique(officeProblems(file.officeChecks).map((p) => p.criterion)) : p.criteria.map((c) => c.criterion);
    const urgent = criteria.some((c) => ['1.4.2', '2.1.2', '2.2.2', '2.3.1'].includes(c));
    const landmarks = /(?:^|[\s>])(?:header|nav|footer|aside)(?:[.#\s>]|$)|\[role=["']?(?:banner|navigation|contentinfo)/i.test(cause.locations[0]?.target ?? '');
    const section = path(own[0] ?? '').split('/').filter(Boolean)[0] ?? '';
    const sectionPages = sectionCounts.get(section) ?? 0;
    const shared = own.length >= 2 && (landmarks || own.length >= Math.ceil(loaded / 2) || own.length >= Math.max(2, Math.ceil(sectionPages / 2)) && own.every((u) => path(u).split('/').filter(Boolean)[0] === section));
    const appearance = criteria.some((c) => ['1.4.3', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.3', '3.2.4', '3.2.6'].includes(c));
    const content = criteria.some((c) => ['1.1.1', '1.3.1', '1.3.2', '1.3.3', '1.4.1', '1.4.5', '2.4.4', '2.4.6', '3.1.2'].includes(c));
    const interactive = criteria.some((c) => /^(2\.1|2\.5|3\.3|4\.1|1\.3\.5)/.test(c));
    const kind: RepairJob['kind'] = p.key === 'documents' || p.key === 'office' ? 'documents'
      : criteria.some((c) => DISRUPTION.has(c)) ? 'disruption'
      : p.key.startsWith('media:') || criteria.some((c) => c.startsWith('1.2.')) ? 'media'
      : shared || appearance ? 'template'
      : criteria.some((c) => ['2.4.2', '3.1.1', '1.3.4', '1.4.4'].includes(c)) ? 'settings'
      : content || p.owner === 'content' ? 'content' : interactive && criteria.some((c) => /^(3\.3|1\.3\.5|2\.1\.[24]|2\.5\.[1247])/.test(c)) ? 'controls' : 'settings';
    // Work packages share a repair location, never a claim that their causes are one defect.
    const location = kind === 'controls' ? unique(own.map(matchPath)).join('|') : kind === 'template' ? 'appearance-navigation' : kind;
    const jobIdentity = `${kind}:${location}`;
    const jobCode = jobIdentity; // Public numbers are reconciled after grouping, independently of priority.
    const problemCode = cause.fingerprint;
    const service = own.some((u) => IMPORTANCE.test(path(u))) ? 2 : /form|input|button|select|textarea/i.test(cause.locations.map((l) => l.target).join(' ')) ? 1 : 0;
    const harm = urgent ? (criteria.includes('2.3.1') ? 6 : 5) : IMPACT[report.rules.find((r) => `rule:${r.id}` === p.key)?.impact ?? 'serious'] ?? 3;
    const instructions = repairInstructions(p, cause, report);
    problems.push({ code: problemCode, sourceKey: p.key, sourceKeys: [p.key], observations: observationsOf(p, cause, report), shared, fingerprint: signal(cause.fingerprint), title: instructions.title, action: instructions.action,
      check: instructions.check ?? completion(criteria, p.key), criteria, pages: cause.pages, locations: cause.locations, occurrences: cause.occurrences,
      scored: p.scored && (!p.measured || inScore.length > 0), ...measuredOf(p, cause), urgent, harm, service, job: jobCode, relatedJobs: [], steps: [] });
    let job = jobs.get(jobIdentity);
    if (!job) {
      const where = kind === 'documents' ? 'Linked files; repair their source documents' : kind === 'template' ? '' : kind === 'media' ? 'Named players and media assets' : kind === 'content' || kind === 'settings' ? 'Named pages in this job' : `${own.slice(0, 3).map(shortLocation).join(', ')}${own.length > 3 ? `; ${own.length - 3} more scanned pages in the web report` : ''}`;
      job = { code: jobCode, kind, title: `${TITLES[kind]}${kind === 'controls' && own.length === 1 ? `: ${shortLocation(own[0]!)}` : ''}`, where,
        lead: kind === 'documents' ? 'Document owner / accessibility specialist' : kind === 'content' || kind === 'media' ? 'Content editor' : 'Web developer / CMS vendor',
        dependency: kind === 'documents' ? 'Source files and document authoring access' : kind === 'content' || kind === 'media' ? kind === 'media' ? 'Publishing and captioning access; media specialist as needed' : 'Publishing access; CMS vendor for iframe titles, list markup and language attributes' : 'Vendor access if the component is locked',
        pages: [], problems: [], relatedJobs: [], urgent: false, harm: 0, service: 0, effort: kind === 'template' || kind === 'controls' ? 'L' : 'M', volume: '',
        whatChanges: '', steps: [], scoreAfter: null, gain: null, grantedAfter: null };
      jobs.set(jobIdentity, job);
    }
    job.pages = unique([...job.pages, ...cause.pages]); job.problems.push(problemCode); job.urgent ||= urgent;
    job.harm = Math.max(job.harm, harm); job.service = Math.max(job.service, service);
  }
  // An observed native player and the file it plays are evidence of one barrier. A legacy
  // snapshot can identify that pairing only when it has exactly one eligible player and asset.
  mergeMediaObservations(problems, jobs, report);
  for (const p of problems) p.locations = [...new Map(p.locations.map((l) => [`${l.page}\n${l.target}`, { page: l.page, target: l.target }])).values()];
  let migratedJob = 1 + (report.repair?.jobs ?? []).reduce((max, j) => Math.max(max, Number(/^J(\d+)$/.exec(j.code)?.[1] ?? 0)), 0);
  if (!previous && report.repair && !report.repair.codeMap) previous = {
    problems: report.repair.problems.map((p, i) => ({ code: `P${i + 1}`, matches: matchKeys(p), aliases: [p.code, signal(p.fingerprint)] })),
    jobs: report.repair.jobs.map((j) => ({ code: /^J\d+$/.test(j.code) ? j.code : `J${migratedJob++}`, identity: `${j.kind}:${j.kind === 'controls' ? unique(j.pages.map(matchPath)).join('|') : j.kind === 'template' ? 'appearance-navigation' : j.kind}` })),
  };
  const codeMap: RepairCodeMap = { problems: (previous?.problems ?? []).map((p) => ({ ...p, matches: [...p.matches], aliases: [...p.aliases] })), jobs: (previous?.jobs ?? []).map((j) => ({ ...j })) };
  const used = new Set<string>();
  let nextProblem = 1 + codeMap.problems.reduce((max, p) => Math.max(max, Number(/^P(\d+)$/.exec(p.code)?.[1] ?? 0)), 0);
  let nextJob = 1 + codeMap.jobs.reduce((max, j) => Math.max(max, Number(/^J(\d+)$/.exec(j.code)?.[1] ?? 0)), 0);
  const matchIndex = new Map<string, typeof codeMap.problems>();
  for (const entry of codeMap.problems) for (const match of entry.matches) matchIndex.set(match, [...matchIndex.get(match) ?? [], entry]);
  const replacements = new Map<string, string>();
  const carried = new Map<RepairProblem, RepairCodeMap['problems'][number]>();
  // Persistent identifiers outrank mutable names across the whole scan. Structural
  // selectors still require compatible names; a replacement must not take an old code.
  // Historical sibling ambiguity stays intact even after one sibling matches.
  for (const kind of ['stable', 'name', 'exact', 'normalized'] as const) {
    const candidates = new Map(problems.filter((p) => !carried.has(p)).map((p) => {
      const names = matchKeys(p, 'name');
      const entries = [...new Set(matchKeys(p, kind).flatMap((m) => matchIndex.get(m) ?? []))];
      return [p, entries.filter((entry) => {
        if (kind === 'stable' || kind === 'name' || !names.length) return true;
        // A newly named control cannot inherit a differently named control's location.
        if (entry.matches.some((m) => m.startsWith('name:'))) return names.some((name) => entry.matches.includes(name));
        return kind === 'exact' || names.some((name) => entry.matches.includes(name));
      })] as const;
    }));
    for (const [p, entries] of candidates) {
      if (entries.length !== 1) continue;
      const entry = entries[0]!;
      if (used.has(entry.code) || [...candidates.values()].filter((es) => es.includes(entry)).length !== 1) continue;
      carried.set(p, entry); used.add(entry.code);
    }
  }
  for (const p of [...problems].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))) {
    const matches = matchKeys(p);
    let entry = carried.get(p);
    if (!entry) { entry = { code: `P${nextProblem++}`, matches: [], aliases: [] }; codeMap.problems.push(entry); }
    entry.matches = unique([...entry.matches, ...matches]); entry.aliases = unique([...entry.aliases, p.fingerprint]);
    used.add(entry.code); replacements.set(p.code, entry.code); p.code = entry.code;
  }
  for (const job of jobs.values()) job.problems = unique(job.problems.map((c) => replacements.get(c)!).filter(Boolean));
  const byCode = new Map(problems.map((p) => [p.code, p]));
  const reach = new Map<string, number>();
  for (const job of jobs.values()) {
    job.problems.sort();
    const owned = job.problems.map((c) => byCode.get(c)!);
    const files = owned.filter((p) => p.sourceKey === 'documents' || p.sourceKey === 'office').length;
    const assets = job.kind === 'media' ? unique(owned.flatMap((p) => p.locations.map((l) => /^https?:/.test(l.target) ? l.target : `${l.page} ${l.target}`))).length : 0;
    reach.set(job.code, Math.max(job.pages.length, files, assets));
    job.volume = files ? `${files} files` : job.kind === 'media' ? `${assets} affected media ${assets === 1 ? 'asset' : 'assets'} · ${job.pages.length} scanned ${job.pages.length === 1 ? 'page' : 'pages'}` : `${job.pages.length} scanned ${job.pages.length === 1 ? 'page' : 'pages'} · ${job.problems.length} ${job.problems.length === 1 ? 'problem' : 'problems'}`;
    if (job.kind === 'template') job.where = owned.every((p) => p.shared)
      ? `Repeated appearance, navigation and focus repairs found on ${job.pages.length} scanned pages; confirm the shared component with your vendor`
      : `Appearance, navigation and focus repairs found on ${job.pages.length} scanned pages. These may require changes to several components.`;
    if (job.problems.length === 1 && job.kind === 'settings') job.effort = 'S';
    if (files) job.effort = files >= 5 || owned.some((p) => /XFA|text recognition|field.*name/i.test(p.action)) || job.service > 0 && files > 1 ? 'L' : 'M';
    if (assets >= 5 || job.problems.length >= 12 || job.service > 0 && job.problems.length >= 6) job.effort = 'L';
  }
  const effort = { S: 0, M: 1, L: 2 };
  const orderedJobs = [...jobs.values()].sort((a, b) => b.harm - a.harm || b.service - a.service || (reach.get(b.code) ?? 0) - (reach.get(a.code) ?? 0) || effort[a.effort] - effort[b.effort] || a.code.localeCompare(b.code));
  // Existing numbers are carried; new jobs receive numbers in their computed priority order.
  for (const job of orderedJobs) {
    const identity = job.code;
    let entry = codeMap.jobs.find((e) => e.identity === identity);
    if (!entry) { entry = { code: `J${nextJob++}`, identity }; codeMap.jobs.push(entry); }
    replacements.set(job.code, entry.code); job.code = entry.code;
  }
  for (const p of problems) p.job = replacements.get(p.job)!;
  // A problem has one accountable job; an index links other work at the same observed locations.
  const pageJobs = new Map<string, Set<string>>();
  for (const job of jobs.values()) for (const page of job.pages) {
    let codes = pageJobs.get(page);
    if (!codes) { codes = new Set(); pageJobs.set(page, codes); }
    codes.add(job.code);
  }
  for (const p of problems) p.relatedJobs = unique(p.pages.flatMap((page) => [...(pageJobs.get(page) ?? [])])).filter((c) => c !== p.job);
  for (const job of orderedJobs) job.relatedJobs = unique(job.problems.flatMap((c) => byCode.get(c)!.relatedJobs));
  // Report v3: each problem's steps and code, each job's title, sentence, steps and code, and the score after each job.
  const fixes = new Map(problems.map((p) => [p.code, problemFix(p, report)]));
  for (const p of problems) {
    const f = fixes.get(p.code)!;
    p.steps = f.steps;
    if (f.code) p.codeFix = f.code;
  }
  for (const job of orderedJobs) {
    const content = jobContent(job, jobOrder(job.problems.map((c) => byCode.get(c)!)), fixes);
    job.title = content.title; job.whatChanges = content.whatChanges; job.steps = content.steps;
    if (content.code) job.codeFix = content.code;
  }
  const projection = cachedProjection(report, orderedJobs, problems);
  orderedJobs.forEach((job, i) => Object.assign(job, projection?.scores[i] ?? { scoreAfter: null, gain: null, grantedAfter: null }));
  return {
    codeMap, problems: problems.sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1))), jobs: orderedJobs,
    milestones: planMilestones(report, orderedJobs, problems), grantedAfterJob: projection?.grantedAfterJob ?? null,
  };
}

/** The projection is the same for the same report and plan: one computation per report, however often the plan is built. */
const projections = new WeakMap<SiteReport, Map<string, ReturnType<typeof projectJobs>>>();
function cachedProjection(report: SiteReport, jobs: readonly RepairJob[], problems: readonly RepairProblem[]): ReturnType<typeof projectJobs> {
  const key = jobs.map((j) => `${j.code}:${j.problems.join(',')}`).join(';');
  let byPlan = projections.get(report);
  if (!byPlan) projections.set(report, (byPlan = new Map()));
  if (!byPlan.has(key)) byPlan.set(key, projectJobs(report, jobs, problems));
  return byPlan.get(key)!;
}

export function reportCoverage(report: SiteReport): ReportCoverage {
  const runs = report.probes?.runs ?? [];
  const rulePages = report.pages.filter((p) => p.status === 'ok').map((p) => p.url);
  const interactionPages = unique(runs.map((r) => r.page));
  return {
    rulePages, interactionPages, keyboardPages: unique(runs.filter((r) => r.probe === 'keyboard' && r.status === 'ok').map((r) => r.page)), sampled: interactionPages.length < rulePages.length || unique(runs.map((r) => r.probe)).some((test) => unique(runs.filter((r) => r.probe === test).map((r) => r.page)).length < rulePages.length),
    tests: unique(runs.map((r) => r.probe)).map((test) => ({ test, pages: unique(runs.filter((r) => r.probe === test).map((r) => r.page)), unsuccessful: runs.filter((r) => r.probe === test && r.status !== 'ok').length, unresolved: runs.filter((r) => r.probe === test).reduce((n, r) => n + r.findings.filter((f) => f.status === 'not_testable').length, 0) })),
    excluded: [...report.skipped, ...report.pages.filter((p) => p.status !== 'ok').map((p) => ({ url: p.url, reason: p.reason ?? 'Page could not be checked' })), ...report.pages.flatMap((p) => (p.untestedFrames ?? []).map((f) => ({ url: f.url, reason: f.reason }))), ...(report.documentChecks ?? []).filter((d) => d.notChecked).map((d) => ({ url: d.url, reason: d.notChecked! }))],
    unsuccessfulTests: runs.filter((r) => r.status !== 'ok').map((r) => ({ page: r.page, test: r.probe, reason: r.findings.find((f) => f.status === 'not_testable')?.detail ?? r.status })).concat((report.documentChecks ?? []).filter((d) => d.error).map((d) => ({ page: d.url, test: 'Document checks', reason: d.error! }))),
    unresolved: (report.criteria ?? []).filter((c) => c.status === 'not_testable' || c.status === 'flagged' || c.methods.some((m) => m.status === 'not_testable' || m.status === 'flagged')).map((c) => ({ criterion: c.criterion, pages: unique(c.evidence.map((e) => e.page)), reason: c.methods.filter((m) => m.status === 'not_testable' || m.status === 'flagged').map((m) => `${m.kind === 'ai' ? 'AI review' : probeLabel(m.id.replace(/^probe:/, ''))}: ${m.status === 'flagged' ? 'flagged for human review' : 'unresolved'}${m.note ? ` — ${m.note}` : ''}`).join('; ') })),
    notChecked: [...(report.notChecked ?? []), ...(report.documentChecks ?? []).filter((d) => d.checks?.pagesChecked !== undefined && d.checks.pagesChecked < d.checks.pages).map((d) => ({ stage: 'Document page sample', detail: `${d.url}: ${d.checks!.pagesChecked} of ${d.checks!.pages} pages checked; remaining pages need review.` }))],
    standards: { wcag21: CRITERIA.filter((c) => c.wcag !== '2.2').map((c) => c.criterion), additional22: CRITERIA.filter((c) => c.wcag === '2.2').map((c) => c.criterion) },
  };
}
