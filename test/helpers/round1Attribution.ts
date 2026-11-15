// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Round 1's attribution of a measured failure to pages it was not measured on, kept as it was at 6cb9d07d
// (src/probes/components.ts `sharedRuns`, with its `SHARED` rules, `environments` and `sharedFinding`): the logic
// is unchanged, only names and two types differ. Round 2 removed it from the engine (a pattern may trigger a check,
// never stand in for one). It lives on here so the counterexamples of review r1 are checked against the real thing:
// test/integration/attributionCounterexamples.test.ts shows that it reports failures on pages where the same tests,
// run whole, measure none, and that the engine no longer does.
//
// `round1Env` is round 1's reading of a page's environment (src/collect/kinds.ts at 6cb9d07d): a stylesheet's or a
// script's address WITHOUT its query, style blocks, inline scripts, and the ids, classes and data attributes of
// html and body. The kinds themselves are computed exactly as in round 1 (the hash was never changed), so the
// engine's own `readKinds` gives them.
import type { PageKinds } from '../../src/collect/kinds.js';
import { runCriterionStatus } from '../../src/probes/criteria.js';
import type { ProbeFinding, ProbeRun } from '../../src/types.js';

/** A run round 1 added for a page the test did not run on (`ProbeRun.shared`, removed from the type in round 2). */
export type Round1SharedRun = ProbeRun & { shared: { from: string[]; pages: number } };

/** Runs inside the page: round 1's environment tokens, as plain strings (they are only ever compared). */
export function round1Env(): string[] {
  const filePart = (v: string): string => v.split('#')[0]!.split('?')[0]!;
  const env = new Set<string>();
  const addEnv = (kind: string, v: string) => { if (v && env.size < 120) env.add(`${kind}:${v}`); };
  for (const l of Array.from(document.querySelectorAll('link[rel~="stylesheet" i][href]'))) addEnv('c', filePart((l as HTMLLinkElement).href));
  for (const s of Array.from(document.querySelectorAll('style'))) addEnv('c', (s.textContent ?? '').replace(/\s+/g, ' ').trim());
  for (const s of Array.from(document.querySelectorAll('script'))) {
    const type = (s.getAttribute('type') ?? '').toLowerCase();
    if (type && !/javascript|ecmascript|module/.test(type)) continue;
    const src = (s as HTMLScriptElement).src;
    addEnv('j', src ? filePart(src) : (s.textContent ?? '').replace(/\s+/g, ' ').trim());
  }
  for (const root of [document.documentElement, document.body]) {
    if (!root) continue;
    if (root.id) addEnv('b', `#${root.id}`);
    for (const c of (root.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) addEnv('b', `.${c}`);
    for (const a of Array.from(root.attributes)) if (a.name.startsWith('data-')) addEnv('b', `${a.name}=${a.value}`);
  }
  return [...env].sort();
}

// ---- Below: round 1's code.

export const ROUND1_SHARED = {
  /**
   * The criteria a failure is reported elsewhere for: those that are about the element **by itself**. Its
   * focus indicator (2.4.7) and that indicator's or its own contrast (1.4.11), what moving focus to it does
   * (3.2.1), whether the keyboard operates it (2.1.1), its name, role and state (4.1.2). An element of the
   * same kind, under the same ancestors, with the same styles and scripts, has these the same way.
   *
   * Never the criteria that depend on what else the page offers: content that moves or updates (2.2.2:
   * another page may put a working pause control beside the same element; red-team 2026-11-10, two false
   * alarms on a single-page application whose routes share the widget), sound (1.4.2), time limits (2.2.1),
   * flashes (2.3.1), content on hover (1.4.13), focus hidden under other content (2.4.11), traps (2.1.2),
   * forms and their messages (3.3.x), spacing between targets (2.5.8), and how content fits (1.4.4,
   * 1.4.10, 1.4.12: it depends on the words).
   */
  criteria: ['2.4.7', '1.4.11', '3.2.1', '2.1.1', '4.1.2'] as readonly string[],
  /** Pages a failure must have been measured on, on the same element kind, before it is reported elsewhere. */
  minMeasured: 2,
  /** Attributed findings kept per run (a page's run of one test). */
  perRun: 12,
  /** Pages named in `ProbeRun.shared.from`. */
  named: 3,
} as const;

/** What the scan keeps of a page for this: its address and its kinds, by scan order. */
export interface KindPage {
  url: string;
  index: number;
  kinds: PageKinds;
}

/** The key a failing element's kind is kept under between the runner and the scan. */
export function findingKey(page: string, probe: string, criterion: string, target: string): string {
  return `${page}\n${probe}\n${criterion}\n${target}`;
}

/** The kinds of environment token (`PageKinds.env`): stylesheets and style blocks, scripts, classes and ids of html and body. */
const ENV_TYPES = ['c', 'j', 'b'] as const;

/**
 * Each page's environment: its **class** (the tokens at least one other page has too, as one key) and
 * the types of the tokens **only it** has (`own`: its own stylesheet, its own inline script, a class
 * naming the page).
 */
export function environments(pages: readonly KindPage[]): Map<string, { cls: string; own: ReadonlySet<string> }> {
  const df = new Map<string, number>();
  for (const p of pages) for (const t of new Set(p.kinds.env)) df.set(t, (df.get(t) ?? 0) + 1);
  return new Map(pages.map((p) => {
    const tokens = [...new Set(p.kinds.env)];
    return [p.url, {
      cls: tokens.filter((t) => (df.get(t) ?? 0) >= 2).sort().join(' '),
      own: new Set(tokens.filter((t) => (df.get(t) ?? 0) < 2).map((t) => t.slice(0, 1))),
    }];
  }));
}

/** Each page's environment class (`environments`). */
export function envClasses(pages: readonly KindPage[]): Map<string, string> {
  return new Map([...environments(pages)].map(([url, e]) => [url, e.cls]));
}

export interface SharedInput {
  /** The pages that loaded and have kinds. */
  pages: readonly KindPage[];
  /** The measured runs (never earlier shared ones). */
  runs: readonly ProbeRun[];
  /** The kind of a failed finding's element (`findingKey`), when the runner could name it. */
  kindOf: (key: string) => string | undefined;
}

/**
 * The shared runs: for each test and page it did not test a criterion on, the failures of that criterion it
 * measured on the same element kind elsewhere. Rules, per test, criterion and kind:
 * - the criterion is about the element by itself (`ROUND1_SHARED.criteria`);
 * - measured failing on at least `ROUND1_SHARED.minMeasured` pages;
 * - on more pages than carry the kind and came out without that failure where the test did test the
 *   criterion (a test that reads only part of a long page leaves such pages behind; a majority of them says
 *   the failure is the page's own);
 * - the untested page carries the kind (as its audit read it) and is in the environment class of a page
 *   where the failure was measured;
 * - a stylesheet, script or body class that only the untested page has could be what makes it differ (a
 *   landing page's own stylesheet that restores the outline): it is only overlooked when every page the
 *   failure was measured on has page-only tokens of that type too (a site whose every page carries a class
 *   naming it, or its own inline settings script), so the failure is known to hold across them.
 * One run per test and page, in page order then the order of `runs`; deterministic.
 */
export function round1SharedRuns(input: SharedInput): Round1SharedRun[] {
  const byUrl = new Map(input.pages.map((p) => [p.url, p]));
  if (byUrl.size < 3) return [];
  // probe → criterion → kind → the measured failures, first finding per page.
  interface Measured { probe: string; kind: ProbeRun['kind']; criterion: string; elementKind: string; at: Map<string, ProbeFinding> }
  const measured = new Map<string, Measured>();
  // probe → criterion → pages where the test gave the criterion a result of its own.
  const tested = new Map<string, Set<string>>();
  for (const run of input.runs) {
    if ((run as Partial<Round1SharedRun>).shared || run.status !== 'ok') continue;
    for (const criterion of run.criteria) {
      const status = runCriterionStatus(run, criterion);
      if (status === undefined || status === 'not_testable') continue;
      const key = `${run.probe}\n${criterion}`;
      let set = tested.get(key);
      if (!set) tested.set(key, (set = new Set()));
      set.add(run.page);
    }
    for (const f of run.findings) {
      if (f.status !== 'failed' || f.advice || typeof f.target !== 'string' || !ROUND1_SHARED.criteria.includes(f.criterion)) continue;
      const elementKind = input.kindOf(findingKey(run.page, run.probe, f.criterion, f.target));
      if (!elementKind) continue;
      const key = `${run.probe}\n${f.criterion}\n${elementKind}`;
      let m = measured.get(key);
      if (!m) measured.set(key, (m = { probe: run.probe, kind: run.kind, criterion: f.criterion, elementKind, at: new Map() }));
      if (!m.at.has(run.page)) m.at.set(run.page, f);
    }
  }
  const candidates = [...measured.values()].filter((m) => m.at.size >= ROUND1_SHARED.minMeasured);
  if (!candidates.length) return [];
  const wanted = new Set(candidates.map((m) => m.elementKind));
  const carriers = new Map<string, string[]>();
  for (const p of input.pages) {
    for (const k of p.kinds.k) {
      if (!wanted.has(k)) continue;
      const list = carriers.get(k);
      if (list) list.push(p.url);
      else carriers.set(k, [p.url]);
    }
  }
  const envOf = environments(input.pages);
  // page → probe → the attributed findings.
  const out = new Map<string, Map<string, { kind: ProbeRun['kind']; findings: ProbeFinding[]; from: Set<string>; pages: number }>>();
  for (const m of candidates) {
    const did = tested.get(`${m.probe}\n${m.criterion}`) ?? new Set<string>();
    const carrying = carriers.get(m.elementKind) ?? [];
    const clean = carrying.filter((u) => did.has(u) && !m.at.has(u)).length;
    if (m.at.size <= clean) continue;
    const measuredEnv = [...m.at.keys()].map((u) => envOf.get(u)).filter((e): e is NonNullable<typeof e> => e !== undefined);
    if (measuredEnv.length < m.at.size) continue;
    const classes = new Set(measuredEnv.map((e) => e.cls));
    // Token types every measured page has page-only tokens of: such tokens are known not to matter here.
    const overlooked = new Set(ENV_TYPES.filter((t) => measuredEnv.every((e) => e.own.has(t))));
    const [firstPage, first] = [...m.at.entries()][0]!;
    for (const url of carrying) {
      if (did.has(url) || m.at.has(url)) continue;
      const env = envOf.get(url);
      if (!env || !classes.has(env.cls) || [...env.own].some((t) => !overlooked.has(t as (typeof ENV_TYPES)[number]))) continue;
      let byProbe = out.get(url);
      if (!byProbe) out.set(url, (byProbe = new Map()));
      let acc = byProbe.get(m.probe);
      if (!acc) byProbe.set(m.probe, (acc = { kind: m.kind, findings: [], from: new Set(), pages: 0 }));
      if (acc.findings.length >= ROUND1_SHARED.perRun) continue;
      acc.pages = Math.max(acc.pages, m.at.size);
      for (const u of m.at.keys()) if (acc.from.size < ROUND1_SHARED.named) acc.from.add(u);
      acc.findings.push(sharedFinding(first, firstPage, m.at.size, m.elementKind));
    }
  }
  const runs: Round1SharedRun[] = [];
  for (const p of [...input.pages].sort((a, b) => a.index - b.index)) {
    const byProbe = out.get(p.url);
    if (!byProbe) continue;
    for (const [probe, acc] of byProbe) {
      runs.push({
        probe, kind: acc.kind, page: p.url, criteria: [...new Set(acc.findings.map((f) => f.criterion))], status: 'ok',
        findings: acc.findings, ms: 0, shared: { from: [...acc.from], pages: acc.pages },
      });
    }
  }
  return runs;
}

/** The note a shared finding's detail ends with (the report shows details as they are). */
export const ROUND1_SHARED_NOTE = 'Not measured on this page: the same element, with the same styles and scripts, failed on';

function sharedFinding(f: ProbeFinding, page: string, pages: number, kind: string): ProbeFinding {
  const note = ` (${ROUND1_SHARED_NOTE} ${pages} pages it was measured on, ${pathOf(page)} among them)`;
  const room = Math.max(0, 500 - note.length);
  const detail = `${f.detail.length > room ? `${f.detail.slice(0, Math.max(0, room - 1))}…` : f.detail}${note}`;
  return {
    criterion: f.criterion, status: 'failed', ...(f.minor ? { minor: true as const } : {}),
    ...(f.target ? { target: f.target } : {}), ...(f.elements ? { elements: [...f.elements] } : {}), detail,
    ...(f.data ? { data: { ...f.data } } : {}), kind,
  };
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    return p.length > 60 ? `${p.slice(0, 59)}…` : p;
  } catch {
    return url.slice(0, 60);
  }
}
