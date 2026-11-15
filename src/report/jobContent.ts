// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 (stage 2, 2026-11-09): the content of each repair job page, as data. A specific title written
// from the job's causes and reach ("Stop the flashing, the sound and the slideshow on the Events page"),
// one sentence on what changes, short numbered steps and a code change built from the site's own HTML, and
// per problem its steps and code. Deterministic: the same report gives the same words. Words come from the
// copy library (copy/fixes.ts, copy/jobs.ts); this module only chooses and joins them. Presentation only:
// nothing here changes a score. Engine core: no Node-only imports.
import { officeProblems } from '../documents/office.js';
import { reportDocumentProblems } from '../aiScore.js';
import type { DocumentCheck, SiteReport } from '../types.js';
import { codeFor, DOCUMENT_STEP, fixFor, type CodeFix, type FixInput } from './copy/fixes.js';
import { CRITERION_ACTS, FAMILY_ACTS, FIX_ACTS, OFFICE_FEATURE, PDF_FEATURE, type Act, type Family } from './copy/jobs.js';
import type { RepairJob, RepairProblem } from './jobs.js';

/** A code change, with the problem it was built from. */
export interface JobCode extends CodeFix {
  /** The public problem code (P12) whose element the change was built from. */
  problem: string;
}

export interface ProblemFix {
  /** The library entries this problem's fix comes from ('rule:image-alt', 'probe:keyboard:2.4.7', 'pdf:tagged'…). */
  keys: string[];
  /** 2 to 4 short numbered steps. */
  steps: string[];
  code?: JobCode;
}

export interface JobContent {
  title: string;
  /** One sentence: what is different once the job is done. */
  whatChanges: string;
  /** Short numbered steps for the whole job. */
  steps: string[];
  /** The job's lead code change, from its most important problem that has one. */
  code?: JobCode;
}

/** A job title is at most this long (two lines of the job page's display face). */
export const MAX_JOB_TITLE = 64;
/** Steps on a job page. */
export const MAX_JOB_STEPS = 5;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const unique = <T>(xs: readonly T[]) => [...new Set(xs)];
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const list = (xs: readonly string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };
/** A path segment decoded for reading, or as written when it isn't valid percent-encoding ("/100%-complete"). */
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const fileName = (url: string) => decoded(pathOf(url).split('/').filter(Boolean).pop() ?? url);

/** A page's plain name from its address: "/" is the homepage, "/lunch-menu" the Lunch menu page. */
export function pageName(url: string): string {
  const segments = pathOf(url).split('/').filter(Boolean);
  // A directory's own page ("/safety/index.html") is named by its directory: never "the Index page".
  while (segments.length && /^(?:index|default|home|welcome)(?:\.[a-z0-9]{1,5})?$/i.test(decoded(segments.at(-1)!))) segments.pop();
  if (!segments.length) return 'the homepage';
  const last = decoded(segments[segments.length - 1]!).replace(/\.(?:html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim();
  if (!last || last.length > 32 || /^\d+$/.test(last) || /[^\p{L}\p{N} '&]/u.test(last)) return `the ${decoded(pathOf(url))} page`;
  return `the ${upper(last)} page`;
}

// ---------------------------------------------------------------- per problem

/** The PDF quick checks a document fails, by `PdfChecks` field (the order of `pdfProblems`). */
function pdfFields(d: DocumentCheck | undefined): string[] {
  const c = d?.checks;
  if (!c) return [];
  return [
    c.blocksAssistiveTech ? 'blocksAssistiveTech' : '', c.xfa ? 'xfa' : '', c.imageOnly ? 'imageOnly' : '', c.tagged === false ? 'tagged' : '',
    c.figuresWithoutAlt ? 'figuresWithoutAlt' : '', c.untitledFormFields ? 'untitledFormFields' : '', c.hasLanguage === false ? 'hasLanguage' : '',
    // No title and no shown title are two repairs (PDF18: the metadata title and DisplayDocTitle); the projection repairs both.
    c.hasTitle === false ? 'hasTitle' : '', c.showsTitle === false ? 'showsTitle' : '',
  ].filter(Boolean);
}

const NON_PROBE_TEST = /^(?:rule:|criterion:|media:|ai:|consistency:|third-party:|documents$|office$|Quick PDF|AI review)/;

/** The copy-library keys a problem's fix comes from (copy/fixes.ts). */
export function fixKeysOf(p: RepairProblem, report: SiteReport): string[] {
  const key = p.sourceKey;
  if (key.startsWith('rule:') || key.startsWith('third-party:') || key.startsWith('consistency:')) return [key];
  if (key.startsWith('criterion:')) {
    const criterion = key.slice(10).replace(/\/listed$/, '');
    if (/^Heading level skips/.test(p.title)) return [`probe:heading-levels:${criterion}`];
    const tests = unique(p.observations.map((o) => o.test).filter((t) => t && !NON_PROBE_TEST.test(t)));
    return [tests.length ? `probe:${tests[0]}:${criterion}` : `criterion:${criterion}`];
  }
  if (key.startsWith('ai:')) {
    const parts = key.split(':');
    return [parts.length === 2 ? `ai:altText:${parts[1]}` : key];
  }
  if (key.startsWith('media:')) {
    const rule = p.observations.map((o) => o.test).find((t) => /^media:[a-z-]+$/.test(t) && fixFor(t).resolved === t);
    return [rule ?? key];
  }
  const url = p.locations[0]?.page ?? '';
  const d = report.documentChecks?.find((x) => x.url === url);
  if (key === 'documents') {
    const ai = reportDocumentProblems(report).get(url)?.criteria ?? [];
    return [...pdfFields(d).map((f) => `pdf:${f}`), ...ai.map((c) => `pdf-ai:${c}`)];
  }
  if (key === 'office') return d?.officeChecks ? unique(officeProblems(d.officeChecks).map((f) => `office:${f.key}`)) : [];
  return [key];
}

/**
 * Steps for a document, or for a job's documents (`scanned`: the scanned files among several, which need
 * text recognition before anything else), from the checks they fail.
 */
function documentSteps(keys: readonly string[], office: boolean, scanned?: readonly string[]): string[] {
  const rest = unique(keys.filter((k) => k !== 'pdf:imageOnly'));
  const ocr = fixFor('pdf:imageOnly').copy.steps[0]!;
  const several = scanned !== undefined;
  const first = office ? [`Open ${several ? 'each file' : 'the file'} in Word, Excel or PowerPoint.`]
    : keys.includes('pdf:imageOnly') && !several ? [ocr]
    : [`Open ${several ? 'each PDF’s source file' : 'the file the PDF was made from'} (Word, InDesign or similar), not the PDF.`];
  const phrases = (group: 'source' | 'settings') => unique(rest.filter((k) => DOCUMENT_STEP[k]?.group === group).map((k) => DOCUMENT_STEP[k]!.text));
  const middle = rest.length <= 2 ? rest.map((k) => fixFor(k).copy.steps[0]!) : [
    ...(phrases('source').length ? [`In the ${office ? 'file' : 'source file'}: ${list(phrases('source'))}.`] : []),
    ...(phrases('settings').length ? [`Set ${list(phrases('settings'))}.`] : []),
  ];
  const last = office ? [`Run Check Accessibility (Review tab), fix what it lists, and publish ${several ? 'each file' : 'the file'} again at the same address.`]
    : [`Export ${several ? 'each one' : 'it'} again as a tagged PDF and replace the file at the same address.`];
  const scans = several && scanned!.length ? [`For ${list(scanned!)}: ${lower(ocr)}`] : [];
  return [...first, ...middle, ...last, ...scans];
}

/** The host of embedded content, from the test's "In a frame from https://…" note. */
function frameHost(p: RepairProblem): string {
  const url = p.observations.map((o) => /In a frame from (https?:\/\/[^\s)]+)/.exec(o.detail)?.[1]).find(Boolean);
  try { return url ? new URL(url).hostname.replace(/^www\./, '') : 'its provider'; } catch { return 'its provider'; }
}

/** What a code builder gets from the problem: its first observation with HTML (else its first), and a media file's address. */
function fixInput(p: RepairProblem): FixInput {
  const o = p.observations.find((x) => x.html) ?? p.observations.find((x) => x.data) ?? p.observations[0];
  const asset = p.locations.map((l) => l.target).find((t) => /^https?:\/\//.test(t));
  return { ...(o?.html ? { html: o.html } : {}), target: o?.target ?? p.locations[0]?.target ?? '', detail: o?.detail ?? '', ...(o?.data ? { data: o.data } : {}), ...(asset ? { asset } : {}) };
}

/** Steps and code for one problem. */
export function problemFix(p: RepairProblem, report: SiteReport): ProblemFix {
  const keys = fixKeysOf(p, report);
  if (p.sourceKey === 'documents' || p.sourceKey === 'office') return { keys, steps: documentSteps(keys, p.sourceKey === 'office') };
  const key = keys[0] ?? p.sourceKey;
  const { copy } = fixFor(key);
  if (key.startsWith('third-party:')) {
    const host = frameHost(p);
    return { keys, steps: [
      `Ask ${host} to fix its embedded content (it can’t be changed in your own pages): ${lower(copy.steps[0]!)}`,
      'If they can’t, use their accessible embed option, or link to the content instead of embedding it.',
    ] };
  }
  const code = codeFor(key, fixInput(p));
  return { keys, steps: observedFirst(p, key, copy.steps), ...(code ? { code: { ...code, problem: p.code } } : {}) };
}

/**
 * Steps with the one for what the scan observed first. WCAG 2.2.2 treats content that updates by itself (a
 * region a timer changes: a ticker, a scoreboard, a rotating notice) apart from content that moves for more
 * than 5 seconds; a job lists each problem's first step, so an updating region leads with its own repair.
 */
function observedFirst(p: RepairProblem, key: string, steps: readonly string[]): string[] {
  const out = [...steps];
  if (!/(?:^|:)2\.2\.2$/.test(key) && !p.criteria.includes('2.2.2')) return out;
  const updating = p.observations.some((o) => /changes by itself every|updat(?:es|ing) by itself|updating region/i.test(o.detail));
  const moving = p.observations.some((o) => /keeps moving|moves?,? blinks?|scrolls? by itself|more than 5 s/i.test(o.detail));
  const update = out.findIndex((x) => /updates? by itself/i.test(x));
  if (updating && !moving && update > 0) out.unshift(...out.splice(update, 1));
  return out;
}

// ---------------------------------------------------------------- per job

/** Problems in the order a job page lists its work: the most harmful first, then scored, then by code. */
export function jobOrder(problems: readonly RepairProblem[]): RepairProblem[] {
  const n = (code: string) => Number(/^P(\d+)$/.exec(code)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return [...problems].sort((a, b) => b.harm - a.harm || Number(b.urgent) - Number(a.urgent) || Number(b.scored) - Number(a.scored) || n(a.code) - n(b.code));
}

const GENERIC_ACT: Act = Object.freeze({ verb: 'fix', one: 'the remaining problem', many: 'the remaining problems', family: 'names' as Family, outcome: 'the remaining problems found are fixed' });

/** The act a problem's fix is named by in titles. */
function actOf(p: RepairProblem, key: string): Act {
  if (own(FIX_ACTS, key)) return FIX_ACTS[key]!;
  if (key.startsWith('third-party:')) return FIX_ACTS['third-party']!;
  const resolved = fixFor(key).resolved;
  if (own(FIX_ACTS, resolved)) return FIX_ACTS[resolved]!;
  const criterion = p.criteria[0];
  return criterion && own(CRITERION_ACTS, criterion) ? CRITERION_ACTS[criterion]! : GENERIC_ACT;
}

/** The moving thing a 2.2.2 problem is about, in words, when the scan's evidence names it. */
function movingThing(problems: readonly RepairProblem[]): string | null {
  const text = problems.flatMap((p) => [...p.locations.map((l) => l.target), ...p.observations.map((o) => `${o.target} ${o.html ?? ''} ${o.detail}`)]).join(' ');
  if (/carousel|slide ?show|slider|#slides|\.slides?\b/i.test(text)) return 'the slideshow';
  if (/ticker|marquee/i.test(text)) return 'the ticker';
  return null;
}

interface Chosen { act: Act; count: number; object: string }

/** The acts a job is named by: each fix once, most harmful and most frequent first; grouped when there are more than three. */
function chooseActs(ordered: readonly RepairProblem[], fixes: ReadonlyMap<string, ProblemFix>): { shown: Chosen[]; ranked: { act: Act; problems: RepairProblem[] }[] } {
  const byAct = new Map<Act, { count: number; first: number; harm: number; problems: RepairProblem[] }>();
  ordered.forEach((p, i) => {
    const act = actOf(p, fixes.get(p.code)?.keys[0] ?? p.sourceKey);
    const e = byAct.get(act) ?? { count: 0, first: i, harm: p.harm, problems: [] };
    e.count++; e.problems.push(p); e.harm = Math.max(e.harm, p.harm);
    byAct.set(act, e);
  });
  const rank = [...byAct.entries()].sort(([, x], [, y]) => y.harm - x.harm || y.count - x.count || x.first - y.first);
  const objectOf = (act: Act, count: number, problems: readonly RepairProblem[]) =>
    act === CRITERION_ACTS['2.2.2'] ? movingThing(problems) ?? (count > 1 ? act.many : act.one) : count > 1 ? act.many : act.one;
  const ranked = rank.map(([act, e]) => ({ act, problems: e.problems }));
  if (rank.length <= 3) return { shown: rank.map(([act, e]) => ({ act, count: e.count, object: objectOf(act, e.count, e.problems) })), ranked };
  // More than three kinds of fix: name the groups, the most harmful and biggest first; a group of one keeps its own words.
  const byFamily = new Map<Family, { acts: [Act, { count: number; harm: number; problems: RepairProblem[] }][]; count: number; harm: number; first: number }>();
  rank.forEach(([act, e], i) => {
    const f = byFamily.get(act.family) ?? { acts: [], count: 0, harm: 0, first: i };
    f.acts.push([act, e]); f.count += e.count; f.harm = Math.max(f.harm, e.harm);
    byFamily.set(act.family, f);
  });
  const families = [...byFamily.entries()].sort(([, x], [, y]) => y.harm - x.harm || y.count - x.count || x.first - y.first);
  const shown = families.slice(0, 3).map(([family, f]) => {
    if (f.acts.length === 1) { const [act, e] = f.acts[0]!; return { act, count: e.count, object: objectOf(act, e.count, e.problems) }; }
    const act = FAMILY_ACTS[family];
    const pages = unique(f.acts.flatMap(([, e]) => e.problems.flatMap((p) => p.pages))).length;
    return { act, count: f.count, object: family === 'form' && pages <= 1 ? act.one : act.many };
  });
  return { shown, ranked };
}

/** "Stop the flashing, the sound and the slideshow": one verb per run of acts that share it. */
function phrase(chosen: readonly Chosen[]): string {
  const groups: { verb: string; objects: string[] }[] = [];
  for (const c of chosen) {
    const last = groups[groups.length - 1];
    if (last && last.verb === c.act.verb && !c.object.includes(' and ') && !last.objects.some((o) => o.includes(' and '))) last.objects.push(c.object);
    else groups.push({ verb: c.act.verb, objects: [c.object] });
  }
  const parts = groups.map((g) => `${g.verb} ${list(g.objects)}`);
  if (parts.length <= 1) return upper(parts.join(''));
  // A comma before the last "and" when a part has its own "and" keeps the parts apart.
  const glue = parts.slice(0, -1).some((x) => x.includes(' and ')) ? ', and ' : ' and ';
  return upper(`${parts.slice(0, -1).join(', ')}${glue}${parts[parts.length - 1]}`);
}

const LANDMARKS: readonly [RegExp, string][] = [
  [/(?:^|[\s>])header(?:[.#\s>:[]|$)|role=["']?banner/i, 'header'],
  [/(?:^|[\s>])nav(?:[.#\s>:[]|$)|role=["']?navigation/i, 'menu'],
  [/(?:^|[\s>])footer(?:[.#\s>:[]|$)|role=["']?contentinfo/i, 'footer'],
];

/** Where the job happens, for its title and sentence. */
function reachOf(job: RepairJob, problems: readonly RepairProblem[]): { title: string; prefix: string; shared: boolean } {
  if (job.pages.length === 1) {
    const name = pageName(job.pages[0]!);
    return { title: ` on ${name}`, prefix: `On ${name}, `, shared: false };
  }
  const targets = problems.flatMap((p) => p.locations.map((l) => l.target));
  const inLandmark = targets.filter((t) => LANDMARKS.some(([re]) => re.test(t)));
  if (targets.length && inLandmark.length * 2 > targets.length && problems.every((p) => p.shared || p.pages.length > 1)) {
    const where = list(LANDMARKS.filter(([re]) => inLandmark.some((t) => re.test(t))).map(([, w]) => w));
    return { title: ` in the ${where}`, prefix: `In the shared ${where}, `, shared: true };
  }
  return { title: '', prefix: `Across ${plural(job.pages.length, 'scanned page')}, `, shared: false };
}

/**
 * The title: at most MAX_JOB_TITLE characters. A shared header, menu or footer keeps its reach first (it tells the
 * reader the job is one shared change), dropping the least important parts; a single page keeps its parts first
 * (the page is on the job's tag row too) and drops the reach.
 */
function fitTitle(chosen: readonly Chosen[], suffix: string, reachFirst: boolean): string {
  const tries: [number, string][] = [];
  if (reachFirst) for (let n = chosen.length; n >= 1; n--) tries.push([n, suffix]);
  else tries.push([chosen.length, suffix]);
  for (let n = chosen.length; n >= 1; n--) tries.push([n, '']);
  for (const [n, end] of tries) {
    const t = `${phrase(chosen.slice(0, n))}${end}`;
    if (t.length <= MAX_JOB_TITLE) return t;
  }
  const t = phrase(chosen.slice(0, 1));
  return `${t.slice(0, MAX_JOB_TITLE - 1)}…`;
}

function documentsContent(job: RepairJob, ordered: readonly RepairProblem[], fixes: ReadonlyMap<string, ProblemFix>): JobContent {
  const pdfs = ordered.filter((p) => p.sourceKey === 'documents');
  const office = ordered.filter((p) => p.sourceKey === 'office');
  const counts = new Map<string, number>();
  for (const p of pdfs) for (const k of fixes.get(p.code)?.keys ?? []) {
    const field = k.startsWith('pdf-ai:') ? 'ai' : k.slice(4);
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  const features = [...counts.entries()].filter(([f]) => own(PDF_FEATURE, f)).sort(([fa, a], [fb, b]) => b - a || Object.keys(PDF_FEATURE).indexOf(fa) - Object.keys(PDF_FEATURE).indexOf(fb)).map(([f]) => PDF_FEATURE[f]!)
    .filter((f, i, all) => all.findIndex((x) => x.with === f.with) === i); // no title and no shown title: "titles" once
  const one = (p: RepairProblem) => fileName(p.locations[0]?.page ?? '');
  let title: string;
  let what: string;
  if (pdfs.length && !office.length) {
    const subject = pdfs.length === 1 ? one(pdfs[0]!) : pdfs.length === 2 ? 'both PDFs' : `the ${pdfs.length} PDFs`;
    title = (features.length ? [3, 2, 1] : []).map((n) => `Re-export ${subject} with ${list(features.slice(0, n).map((f) => f.with))}`).find((t) => t.length <= MAX_JOB_TITLE)
      ?? `Re-export ${subject} as accessible PDFs`;
    what = `${pdfs.length === 1 ? 'The PDF' : pdfs.length === 2 ? 'Both PDFs' : `All ${pdfs.length} PDFs`} can be read with a screen reader${features.length ? ': ' : ''}${list(features.slice(0, 3).map((f) => f.outcome))}${features.length > 3 ? `, plus ${plural(features.length - 3, 'more fix', 'more fixes')}` : ''}.`;
  } else if (office.length && !pdfs.length) {
    title = office.length === 1 ? `Fix ${one(office[0]!)} at the source` : `Fix the ${office.length} Word, Excel and PowerPoint files`;
    const done = unique(office.flatMap((p) => fixes.get(p.code)?.keys ?? []).map((k) => OFFICE_FEATURE[k.slice(7)] ?? '').filter(Boolean));
    what = `${office.length === 1 ? 'The file' : office.length === 2 ? 'Both files' : `All ${office.length} files`} can be read with a screen reader${done.length ? `: ${list(done)}` : ''}.`;
  } else {
    title = `Repair ${plural(pdfs.length, 'PDF')} and ${plural(office.length, 'Office file')} at the source`;
    what = `Every linked document can be read with a screen reader${features.length ? `: ${list(features.slice(0, 3).map((f) => f.outcome))}` : ''}.`;
  }
  if (title.length > MAX_JOB_TITLE) title = `${title.slice(0, MAX_JOB_TITLE - 1)}…`;
  const keys = unique(ordered.flatMap((p) => fixes.get(p.code)?.keys ?? []));
  const pdfKeys = keys.filter((k) => !k.startsWith('office:'));
  const officeKeys = keys.filter((k) => k.startsWith('office:'));
  const scanned = pdfs.filter((p) => fixes.get(p.code)?.keys.includes('pdf:imageOnly')).map(one);
  const steps = pdfs.length && office.length
    ? [...documentSteps(pdfKeys, false, scanned), 'For the Office files: run Check Accessibility (Review tab), fix what it lists, and publish them again.']
    : pdfs.length ? documentSteps(pdfKeys, false, pdfs.length > 1 ? scanned : undefined) : documentSteps(officeKeys, true, office.length > 1 ? [] : undefined);
  return { title, whatChanges: what, steps };
}

/** Title, what changes, steps and the lead code change for one job. `problems` are the job's own. */
export function jobContent(job: RepairJob, problems: readonly RepairProblem[], fixes: ReadonlyMap<string, ProblemFix>): JobContent {
  const ordered = jobOrder(problems);
  if (job.kind === 'documents') return documentsContent(job, ordered, fixes);
  const { shown, ranked } = chooseActs(ordered, fixes);
  const reach = reachOf(job, ordered);
  const title = fitTitle(shown, reach.title, reach.shared);
  // What changes: the three most important fixes' outcomes, and how many more.
  const outcomes = unique(ranked.map((r) => r.act.outcome));
  const whatChanges = `${reach.prefix}${list(outcomes.slice(0, 3))}${outcomes.length > 3 ? `, plus ${plural(outcomes.length - 3, 'more fix', 'more fixes')}` : ''}.`;

  // Steps, in the same order: one kind of fix, its own steps; several, the first step of each, at most MAX_JOB_STEPS.
  const byRank = ranked.flatMap((r) => r.problems);
  // One step list per kind of fix (the first problem of each act speaks for it); embedded content from other providers is one step.
  const lists: string[][] = [];
  for (const r of ranked) {
    const f = fixes.get(r.problems[0]!.code);
    if (!f) continue;
    if (f.keys[0]?.startsWith('third-party:')) {
      const hosts = unique(r.problems.map(frameHost));
      lists.push([`Ask ${list(hosts)} to fix the problems found in ${hosts.length === 1 ? 'its' : 'their'} embedded content, or link to the content instead of embedding it.`]);
    } else {
      lists.push(f.steps);
      // The same kind of fix observed differently (moving content and an updating region): each one's own lead step.
      for (const q of r.problems.slice(1)) { const g = fixes.get(q.code); if (g && g.steps[0] && !lists.some((x) => x[0] === g.steps[0])) lists.push(g.steps); }
    }
  }
  let steps: string[];
  // One kind of fix: the first problem's own steps in full.
  if (ranked.length === 1 && lists.length <= 1) steps = [...(fixes.get(ranked[0]!.problems[0]!.code)?.steps ?? lists[0] ?? [])];
  else if (lists.length === 1) steps = [...lists[0]!];
  else {
    const firsts = unique(lists.map((x) => x[0]!));
    steps = firsts.length > MAX_JOB_STEPS ? [...firsts.slice(0, MAX_JOB_STEPS - 1), `Then fix the other ${plural(firsts.length - MAX_JOB_STEPS + 1, 'kind', 'kinds')} of problem listed for this job, one by one.`] : firsts;
  }
  // The lead code change: from the most important fix that has one, a change built from the site's own HTML before an example.
  const actRank = new Map(ranked.flatMap((r, i) => r.problems.map((p) => [p, i] as const)));
  const withCode = byRank.map((p, i) => ({ i, code: fixes.get(p.code)?.code, act: actRank.get(p) ?? ranked.length }))
    .filter((x): x is { i: number; code: JobCode; act: number } => !!x.code)
    .sort((x, y) => x.act - y.act || Number(y.code.source === 'page') - Number(x.code.source === 'page') || x.i - y.i);
  const code = withCode[0]?.code;
  return { title, whatChanges: upper(whatChanges), steps, ...(code ? { code } : {}) };
}
