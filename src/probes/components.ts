// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared components (red-team 2026-11-10, coverage lane): what the scan knows about a page's elements from
// its audit (src/collect/kinds.ts), put to two uses. Both decide **where a test goes**; neither is a result.
//
// 1. **Where a measured failure is looked for again.** A test that is too slow to run on every page measures
//    a footer link with no focus indicator on the sampled pages that carry it; the footer is on 45 pages.
//    `componentChecks` names, for each other page that carries an element of the same kind, what to measure
//    there: that element alone with the test's own measurement (src/probes/componentCheck.ts), or the whole
//    test when it is cheap. Only what is then measured on the page is reported for it.
// 2. **Where the slow tests go.** `noveltyPlanner` says which pages hold something no page tested so far has
//    (a new kind of control, form field, moving part, sticky box, id or code), in scan order.
//
// Review r1 (2026-11-10), the lead's ruling: a pattern (a kind, an address, a schedule) may trigger a check,
// never stand in for one. The first version reported a failure on a page from its kinds and its shared
// stylesheets alone; two elements of one kind can differ in everything a test measures (a name, a CSS
// variable set on the page, the colour behind it, an attribute a script reads on an ancestor), so that is
// gone, and with it the environment classes it leaned on. Engine core: no Node-only imports.
import { pageKindsOf, type PageKinds } from '../collect/kinds.js';
import type { PageAudit, ProbeRun } from '../types.js';
import { CHECK_CRITERIA, type CheckWanted } from './componentCheck.js';
import { runCriterionStatus } from './criteria.js';

/**
 * What a failure a test measured on an element sends to the pages that carry an element of the same kind and
 * were not given that test. Only criteria about the element **by itself** (its focus indicator and that
 * indicator's contrast, what focusing it does, whether the keyboard reaches it, its name and role): never
 * those that depend on what else the page offers (content that moves beside a pause control, hover content,
 * hidden focus, forms, how text fits).
 * - `elements`: the page's own element of that kind is measured alone, with the keyboard test's own
 *   measurement (`keyboardCheckProbe`);
 * - `test`: the test runs whole on the page (the screen-reader test is cheap, about half a second; the controls
 *   test, about 2.5 s, is the only way a press can be measured). A test sent whole decides every result on the
 *   page itself, so a controls failure about what the control opens (a focus loop, a panel the Tab order skips,
 *   focus left hidden) sends it too: on another page the same control may open the same thing.
 */
export const CHECKS: Readonly<Record<string, { criteria: readonly string[]; send: 'elements' | 'test' }>> = {
  keyboard: { criteria: CHECK_CRITERIA, send: 'elements' },
  'keyboard-deep': { criteria: CHECK_CRITERIA.filter((c) => c !== '2.1.1'), send: 'elements' },
  'screen-reader': { criteria: ['4.1.2'], send: 'test' },
  // The controls test is sent whole (about 2.5 s with its load): what a control does when it is pressed is
  // measured by pressing it on the page itself, never carried over from another page (keyboard-op lane,
  // 2026-11-11). Only failures about the control and what it opens send it; a status message does not.
  controls: { criteria: ['2.1.1', '2.1.2', '2.4.3', '2.4.11'], send: 'test' },
  // The titles a site gives its views when it changes pages without loading them (structure lane, batch 17). No
  // element kind sends it (no criteria here): it is sent whole to the scan's other pages by `SITE_SENDS`, below.
  'route-titles': { criteria: [], send: 'test' },
};

/** A route-titles run that followed a link of the page and saw the site change pages without loading them. */
function sawClientSidePageChange(run: ProbeRun): boolean {
  const hops = (run.data as { hops?: unknown } | undefined)?.hops;
  return Array.isArray(hops) && hops.some((h) => !!h && typeof h === 'object' && (h as { blocked?: unknown }).blocked !== true);
}

/**
 * What a test measured about the SITE on one page that sends it, whole, to the scan's other pages (batch 17). Not
 * a result: it only decides where the test goes, as optional work after every required test (`componentChecks`).
 * - `route-titles`: a run followed one of the page's own links and the site showed another page without loading
 *   it (a single-page app). On such a site the title a visitor gets on ANY page, after coming to it through the
 *   site's links, is known only by following a link on that page and coming back; a scan that loads every page by
 *   its address never sees it. A site that loads its pages (the test's "not applicable") sends nothing, and neither
 *   does a run whose every page change asked the server for something (not testable there either).
 */
export const SITE_SENDS: Readonly<Record<string, (run: ProbeRun) => boolean>> = {
  'route-titles': sawClientSidePageChange,
};

/** Pages one site-level send reaches at most, in page order (the runs are optional work, each about a page load and a few seconds). */
export const SITE_SEND_PAGES = 100;

export const CHECK_LIMITS = {
  /** Element kinds sent to one page (the first measured failures, in page order). */
  kindsPerPage: 12,
  /** Pages named in `ProbeRun.checked.from`. */
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

/** What one page is sent: element kinds to measure alone, cheap tests to run whole, and the pages that sent them. */
export interface PageChecks {
  url: string;
  index: number;
  elements: CheckWanted[];
  tests: string[];
  from: string[];
}

export interface ChecksInput {
  /** The pages that loaded and have kinds. */
  pages: readonly KindPage[];
  /** The measured runs. */
  runs: readonly ProbeRun[];
  /** The kind of a failed finding's element (`findingKey`), when the runner could name it. */
  kindOf: (key: string) => string | undefined;
}

/**
 * The checks a scan's measured failures send out (`CHECKS`), per page, in page order. A page gets one when
 * - (a site-level send, `SITE_SENDS`) a test measured on another page something about the site that every page may
 *   share, and has no run on this page; or
 * - it carries an element kind (as its audit read it) that a test measured failing on another page, for a
 *   criterion that test can be sent for, and
 * - the test gave that criterion no result of its own on the page: it did not run there, or it ran and
 *   could not judge it (its walk was cut short, it timed out). A page where the whole test decided the
 *   criterion, clean or failed, keeps that result. A cheap test sent whole goes only where it has no run.
 * Deterministic: from the runs in their final order, whatever order they came in.
 */
export function componentChecks(input: ChecksInput): PageChecks[] {
  // kind → what failed on it, in the order measured.
  interface Failing { kind: string; send: 'elements' | 'test'; probe: string; criteria: Set<string>; from: string[] }
  const failing = new Map<string, Failing>();
  /** The pages each test (the keyboard test for both of its tiers) ran on. */
  const ranOn = new Map<string, Set<string>>();
  /** Test and criterion → the pages where a run of the test decided the criterion (any result but "not testable"). */
  const decided = new Map<string, Set<string>>();
  const testOf = (probe: string) => (CHECKS[probe]?.send === 'elements' ? 'keyboard' : probe);
  for (const run of input.runs) {
    const check = CHECKS[run.probe];
    if (!check) continue;
    const test = testOf(run.probe);
    let pages = ranOn.get(test);
    if (!pages) ranOn.set(test, (pages = new Set()));
    pages.add(run.page);
    if (run.status !== 'ok' || run.checked) continue;
    for (const criterion of check.criteria) {
      const status = runCriterionStatus(run, criterion);
      if (status === undefined || status === 'not_testable') continue;
      const key = `${test}\n${criterion}`;
      decided.set(key, (decided.get(key) ?? new Set()).add(run.page));
    }
    for (const f of run.findings) {
      if (f.status !== 'failed' || f.advice || typeof f.target !== 'string' || !check.criteria.includes(f.criterion)) continue;
      const kind = input.kindOf(findingKey(run.page, run.probe, f.criterion, f.target));
      if (!kind) continue;
      const key = `${test}\n${kind}`;
      let m = failing.get(key);
      if (!m) failing.set(key, (m = { kind, send: check.send, probe: test, criteria: new Set(), from: [] }));
      m.criteria.add(f.criterion);
      if (!m.from.includes(run.page)) m.from.push(run.page);
    }
  }
  // Site-level sends (`SITE_SENDS`): the test, and the pages whose runs measured what sends it.
  const siteSends = new Map<string, string[]>();
  for (const run of input.runs) {
    const sends = SITE_SENDS[run.probe];
    if (!sends || run.status !== 'ok' || run.checked) continue;
    let measured = false;
    try { measured = sends(run); } catch { measured = false; }
    if (!measured) continue;
    const from = siteSends.get(run.probe) ?? [];
    if (!from.includes(run.page)) from.push(run.page);
    siteSends.set(run.probe, from);
  }
  if (!failing.size && !siteSends.size) return [];
  const byKind = new Map<string, Failing[]>();
  for (const m of failing.values()) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  const out: PageChecks[] = [];
  const siteSent = new Map<string, number>();
  for (const p of [...input.pages].sort((a, b) => a.index - b.index)) {
    const elements: CheckWanted[] = [];
    const tests = new Set<string>();
    const from = new Set<string>();
    for (const [probe, pages] of siteSends) {
      if (ranOn.get(probe)?.has(p.url) || (siteSent.get(probe) ?? 0) >= SITE_SEND_PAGES) continue;
      siteSent.set(probe, (siteSent.get(probe) ?? 0) + 1);
      tests.add(probe);
      for (const u of pages) if (from.size < CHECK_LIMITS.named) from.add(u);
    }
    for (const kind of p.kinds.k) {
      for (const m of byKind.get(kind) ?? []) {
        if (m.send === 'test') {
          if (ranOn.get(m.probe)?.has(p.url)) continue;
          tests.add(m.probe);
        } else {
          // The criteria the test left open on this page.
          const open = [...m.criteria].filter((c) => !decided.get(`${m.probe}\n${c}`)?.has(p.url)).sort();
          if (!open.length || elements.length >= CHECK_LIMITS.kindsPerPage) continue;
          elements.push({ kind, criteria: open, from: m.from[0]! });
        }
        for (const u of m.from) if (from.size < CHECK_LIMITS.named) from.add(u);
      }
    }
    if (elements.length || tests.size) out.push({ url: p.url, index: p.index, elements, tests: [...tests].sort(), from: [...from] });
  }
  return out;
}

/** The measured runs with each failed finding's element kind on it (`ProbeFinding.kind`), where the runner named one. */
export function withKinds(runs: readonly ProbeRun[], kindOf: (key: string) => string | undefined): ProbeRun[] {
  return runs.map((run) => {
    if (run.checked || !run.findings.some((f) => f.status === 'failed' && typeof f.target === 'string')) return run;
    let changed = false;
    const findings = run.findings.map((f) => {
      if (f.status !== 'failed' || typeof f.target !== 'string' || f.kind) return f;
      const kind = kindOf(findingKey(run.page, run.probe, f.criterion, f.target));
      if (!kind) return f;
      changed = true;
      return { ...f, kind };
    });
    return changed ? { ...run, findings } : run;
  });
}

// ---------------------------------------------------------------------------------------------
// Where the slow tests go.

/** The features a group of tests looks for novelty in (`PageKinds.f` keys; `css`/`js`: new stylesheets or scripts). */
export type NoveltyFeature = keyof PageKinds['f'] | 'css' | 'js';

function featureKeys(kinds: PageKinds, feature: NoveltyFeature): readonly string[] {
  if (feature === 'css') return kinds.env.filter((t) => t.startsWith('c:'));
  if (feature === 'js') return kinds.env.filter((t) => t.startsWith('j:'));
  const list = kinds.f[feature];
  return Array.isArray(list) ? list : [];
}

/**
 * Novelty, per group of tests, in scan order: `fresh(group, features, kinds)` is true when the page holds
 * a key of one of the features that no page given to `cover` for that group has; `cover` then adds the
 * page's keys. A page without kinds is never fresh (nothing is known about it).
 */
export function noveltyPlanner(): {
  fresh(group: string, features: readonly NoveltyFeature[], kinds: PageKinds | undefined): boolean;
  cover(group: string, features: readonly NoveltyFeature[], kinds: PageKinds | undefined): void;
  /** The page holds at least one key of one of the features (new or not). */
  has(features: readonly NoveltyFeature[], kinds: PageKinds | undefined): boolean;
} {
  const seen = new Map<string, Set<string>>();
  const setOf = (group: string) => {
    let s = seen.get(group);
    if (!s) seen.set(group, (s = new Set()));
    return s;
  };
  const keys = (features: readonly NoveltyFeature[], kinds: PageKinds) => features.flatMap((f) => featureKeys(kinds, f).map((k) => `${f}:${k}`));
  return {
    fresh(group, features, kinds) {
      if (!kinds) return false;
      const s = setOf(group);
      return keys(features, kinds).some((k) => !s.has(k));
    },
    cover(group, features, kinds) {
      if (!kinds) return;
      const s = setOf(group);
      for (const k of keys(features, kinds)) s.add(k);
    },
    has: (features, kinds) => !!kinds && features.some((f) => featureKeys(kinds, f).length > 0),
  };
}

/** A page's kinds from its audit, when the collector ran. */
export function kindsOfPage(page: Pick<PageAudit, 'collected'>): PageKinds | undefined {
  return pageKindsOf(page.collected);
}
