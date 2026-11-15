// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Which pages the probes run on during a scan: the template sample (src/sample/templates.ts), the
// same choice the vision check makes; probes with `everyPage` also run on every other page that
// loaded, and deep probes with `alsoOn` on the pages they ask for. Since 2026-11-10 (red-team, coverage
// lane) the slow tests also go, as optional runs, to the pages that hold something no page tested so far
// has (`NOVELTY_GROUPS`), and, once every other run is in, an element of a kind that a slow test measured
// failing is measured on the other pages that carry it (`componentChecks`, src/probes/components.ts).
// Engine core: no Node-only or AI imports.
import { collectedValue } from '../collect/index.js';
import { componentChecks, findingKey, kindsOfPage, noveltyPlanner, withKinds, type KindPage, type NoveltyFeature, type PageChecks } from './components.js';
import { CHECK_KEY, keyboardCheckProbe } from './componentCheck.js';
import { kindsOfTargets, readKinds, KINDS_LIMITS } from '../collect/kinds.js';
import type { PageProbe } from './types.js';
import { shapeCollector } from '../collect/shape.js';
import { visionCollector } from '../collect/vision.js';
import { VIEWPORTS } from '../report/build.js';
import { samplePages, type TemplatePage } from '../sample/templates.js';
import type { PageAudit, PageLike, ProbeFinding, ProbeRun } from '../types.js';
import type { OptionalUnit, ProbeRunner, ProbeRunnerOptions } from './runner.js';

/** Pages in the probes' template sample (as for the vision check). */
export const PROBE_SAMPLE_SIZE = 5;

/**
 * Pages per scan on which a deep probe with `alsoOn` runs besides the template sample: the first ones
 * in scan order it asks for (sampled pages count too).
 */
export const ALSO_ON_PAGE_CAP = 10;

/** The page's DOM-shape key from the shape collector, else from the vision collector; '' when unknown. */
export function pageShapeOf(page: PageAudit): string {
  return collectedValue(page, shapeCollector) ?? collectedValue(page, visionCollector)?.shape ?? '';
}

export interface TemplateProbes {
  /** Call as each page's audit finishes, in any order. Never throws. */
  pageAudited(page: PageAudit, index: number): void;
  /**
   * True when the AI review hears of this run (`AiScanPlan.onProbeRun`): a run on a page of the template
   * sample, or of one of the tests it always heard on every page. The runs added for coverage (the wider
   * every-page set, the novelty groups) are not its evidence, so its samples and cost stay what they were.
   */
  aiHears(run: ProbeRun): boolean;
  /**
   * An audit worker has no pages left: the probes may use its room in the browser (a context per
   * audit width, src/audit.ts). Never throws.
   */
  auditWorkerDone(): void;
  /** Settles the sample (every page is audited by now) and waits for the runs. Never rejects. */
  finish(): Promise<ProbeRun[]>;
  /** Test runs queued so far and finished of those (`ProbeRunner.counts`). Never throws. */
  counts(): { queued: number; done: number };
  /** Whole tests queued so far and finished of those (`ProbeRunner.tests`). Never throws. */
  tests(): { queued: number; done: number };
  /** The queued runs with none in `finished` (`ProbeRunner.unfinished`). Never throws. */
  unfinished(finished: readonly ProbeRun[]): ProbeRun[];
  /**
   * For a scan past its time limit: `finish`'s result from the runs that did finish (the runner's
   * `partial`: cross-page findings computed, unfinished runs marked), with the carried every-page runs
   * and the page cap's not-tested runs, in page order. Never throws.
   */
  partial(finished: readonly ProbeRun[]): ProbeRun[];
}

/**
 * Feeds the template sample to the runner while the audit is still running. A page's probes start
 * once it and every page before it in the scan order are audited: its place in the sample is then
 * final (it depends only on earlier pages), so the sample never depends on which page finished first
 * and nothing started is dropped later.
 */
/**
 * Long scans (more than 50 pages, wide.ts): the core tests that run on every page that loaded
 * (`PageProbe.everyPage`) run on the first this-many such pages in page order, so their cost stays
 * bounded at 250 or 5,000 pages. Scans of up to 50 pages run them on every page, as before.
 */
export const EVERY_PAGE_CAP_LONG = 100;

/**
 * The slow tests, by what they look at on a page (`PageKinds.f`, src/collect/kinds.ts): a page outside the
 * template sample gets a group's tests when it holds a key of one of the group's features that no page given
 * the group so far has, in scan order (a sampled page counts as given every group). So the keyboard test goes
 * to the page with the only date picker, and not to the ninth news story; the screen-reader test (tables,
 * lists and groups as assistive technology is given them, and the order content is read in) to pages with
 * a new kind of those, or with content CSS shows in another order. The 20-second timing watch, the
 * forced-colours test (not scored) and the media test (it has its own rule, `alsoOn`) stay on the sample.
 */
export const NOVELTY_GROUPS: readonly {
  id: string;
  probes: readonly string[];
  features: readonly NoveltyFeature[];
  /**
   * Features whose presence alone sends the group to a page, new or not: for what is rare, differs page by
   * page in what it means, and is cheap to test.
   */
  always?: readonly NoveltyFeature[];
  /**
   * The group's tests cost less than a page load of their own (perf/split-tests, 2026-11-10): on a page outside
   * the sample they go on on the page the every-page tests loaded, as a rider (`OptionalUnit.rider`), instead of
   * loading it again. Tests of the group in another context (an isolated test) still load the page for themselves.
   */
  rides?: true;
}[] = [
  { id: 'keyboard', probes: ['keyboard', 'key-shortcuts', 'keyboard-deep', 'pointer-cancellation', 'pointer-gestures', 'hover-content'], features: ['focus'] },
  // Form fields 0.7 s, status messages 1.1 s (train sites, browser time per page): less than a load.
  // Batch 18 (forms lane): every page with a field, new or not. Whether a field is labelled, marked as required,
  // checked and answered is the page's own doing: one form builder renders twenty different forms from the same kinds
  // of fields (red-team train sites: two keyed 3.3.2 failures on pages whose field kinds an earlier page had). A field
  // in a frame or an open shadow root counts (`PageKinds.f.form`).
  { id: 'forms', probes: ['form-fields', 'forms'], features: ['form'], always: ['form'], rides: true },
  { id: 'live', probes: ['screen-reader-live'], features: ['focus', 'form'], rides: true },
  // What changes by itself is often a script's timer, which no element shows: the same live-updates panel, built
  // from one template, can update every few seconds with a working pause on one page and with none on the next
  // (red-team train sites, 2026-11-11: such pages never got the test). So every page with a script, or with
  // something that says it moves, gets the motion tests (about 4 s with their load); a page with neither has
  // nothing that changes by itself.
  { id: 'motion', probes: ['flash-motion', 'audio', 'motion', 'motion-actuation', 'timing'], features: ['motion', 'ids', 'js'], always: ['motion', 'js'] },
  // The act-and-watch tests (2026-11-11, act-watch lane): `controls` presses the page's own controls and judges
  // what each press shows (a status message nobody announces, 4.1.3, among others); `timing-entry` types into its
  // fields, presses its plain buttons and runs its timers early (a time limit on what was typed, 2.2.1). What a
  // press or a timer does is the page's script's own doing, which the page's structure does not show: the same
  // save button, built from one template, can announce its message on one page and not on the next, and the same
  // draft field can be cleared after a timeout on one page and kept on another (red-team train sites: most such
  // failures were on pages outside the sample). Every page with something to press or a field gets them (about
  // 2 s each with the page load; nothing is sent).
  // The keyboard-op lane (2026-11-11) sends the same test, by novelty, where a kind of control is new, and where
  // something that looks operable with the pointer is new without being a control at all (`operable`: a `div` with a
  // pointer cursor and a script's click handler, a draggable list), which the keyboard walk's group does not follow:
  // a control that takes focus and does nothing on Enter or Space, and what a press opens, are found only by
  // pressing. Batch 16 merged the two lanes' groups into one: every page with something to press or a field
  // (`always`), and every page with a new kind of control or of operable element (novelty).
  { id: 'act', probes: ['controls'], features: ['focus', 'operable', 'press', 'form'], always: ['press', 'form'] },
  { id: 'entry', probes: ['timing-entry'], features: ['form'], always: ['form'] },
  // The flash test films the page on a page of its own (about 5 s with its load): only where something the
  // page itself says moves, plays or draws is new (an animation, a video, a canvas, an animated picture),
  // not for every new id (on one red-team train site ids alone sent it to 45 of 52 pages, and it found nothing).
  { id: 'flash', probes: ['flash'], features: ['motion'] },
  // Batch 18, visual lane: text a timer shows and text in a region a control opens (state-text-contrast, deep, listed):
  // where a kind of control or of script is new, as the menus and notices that hold such text differ by template.
  { id: 'state-text', probes: ['state-text-contrast'], features: ['press', 'js'] },
  // Reading order (1.3.2, failure F1): content CSS shows in another order is a different sequence on each
  // page that has it, and the test is cheap (0.6 s on the every-page load): every such page gets it.
  { id: 'reader', probes: ['screen-reader'], features: ['struct', 'reorder'], always: ['reorder'], rides: true },
  // Floating content (about 13 s with its load): where a kind of box that stays on screen is new. (Tried
  // 2026-11-10: also wherever such a box sits over controls no tested page has, for focus hidden under it.
  // On two red-team train sites that was about 45 more pages each; the test found none of the 9 keyed
  // hidden-focus failures it then reached, and its 1.4.10 result on a shared sticky header added 2 false
  // alarms. Reverted: the gain has to come from the test first.)
  { id: 'overlays', probes: ['overlays'], features: ['fixed'] },
  // About 8 s with its load: where a stylesheet styles an element by orientation that no page given the test has, and
  // (batch 18, forms lane) every page where an orientation or aspect-ratio rule hides, collapses or turns something, or
  // whose own script reads the orientation (`orientLock`): one template's rotate wall on five pages is five failures,
  // and the earlier novelty rule tested only the first (red-team train sites, four keyed 1.3.4 failures).
  { id: 'orientation', probes: ['orientation'], features: ['orient', 'orientLock'], always: ['orientLock'] },
];

/**
 * Long scans (more than 50 pages): how many novelty-group pages each group may go to among the pages the wider
 * coverage reaches (`COVERAGE_PAGES_LONG`): no cap (a cap of 40 left the last pages of a 60-page site to shared
 * runs, red-team 2026-11-10). Scans of up to 50 pages: every page with something new for a group gets it.
 * Always within the scan's time: the runs are optional.
 */
export const NOVELTY_PAGE_CAP_LONG = Number.POSITIVE_INFINITY;

/**
 * Long scans: the first this-many pages (in page order) the wider coverage reaches (perf/split-tests,
 * 2026-11-10; it was the first 100, the pages scoring v10's every-page tests run on): their element kinds are
 * read and kept, the slow tests go to those with something new, the five newer every-page tests run on them,
 * and a measured failure's targeted check goes to them. Pages 101 to this one get only that, all optional work
 * (listed, never scored); scoring v10's every-page tests stay on the first `EVERY_PAGE_CAP_LONG`, so a long
 * scan's score is what it was. The number is set by the measured budget (docs/redteam-triage-coverage.md,
 * "Scan-time cost"): what a long scan's last segment has left for optional work after the required tests, and
 * what the kinds of that many pages hold in memory. Past it a page gets the axe rules and nothing else, as before.
 */
export const COVERAGE_PAGES_LONG = 250;

/**
 * The every-page tests of scoring v10. Their runs on every page are scored, and the AI review hears them
 * (`AiScanPlan.onProbeRun`). Every other test's run on a page outside the template sample is the wider
 * coverage of 2026-11-10 (`ProbeRun.coverage`): listed, not scored, and not the AI review's evidence, so
 * scores, the review's samples and its cost are what they were.
 */
export const EVERY_PAGE_V10: ReadonlySet<string> = new Set(['headings', 'link-purpose', 'aria-states', 'text-contrast']);
/**
 * Batch 18 (lane media): the AI review also hears the two media tests on every page they run on. Their runs are the
 * evidence of the media checks, which bound their own cost by recordings, never by pages (a recording is reviewed
 * once, whatever page it is on), so hearing more of them changes what those checks know, not what they spend; no
 * other check reads them. Scores are untouched: this only says which runs reach `AiScanPlan.onProbeRun`.
 */
const AI_HEARS_EVERYWHERE: ReadonlySet<string> = new Set([...EVERY_PAGE_V10, 'media-files', 'media-players']);

/**
 * The every-page tests whose runs on every page are scored: scoring v10's four and, since scoring v13, the
 * media-files test (a video it has shown to have speech and no captions counts on whatever page it is; its other
 * results count for nothing, `PROOF_ONLY_PROBES` in src/score.ts). They are required work on every page, also when
 * the wider coverage is off. The AI review hears scoring v10's four and the media tests (`AI_HEARS_EVERYWHERE`).
 */
export const EVERY_PAGE_SCORED: ReadonlySet<string> = new Set([...EVERY_PAGE_V10, 'media-files']);

/**
 * The element kinds of a scan's failing elements (src/probes/components.ts): the runner's hooks fill it
 * (`hooks`), the template probes read it when the runs are in.
 */
export interface ComponentKinds {
  /** The runner options that keep each loaded page's kinds and name each failed finding's element. */
  hooks: Pick<ProbeRunnerOptions, 'onPageOpened' | 'onFindings'>;
  /** The kind of a failed finding's element (`findingKey`). */
  kindOf(key: string): string | undefined;
}

/** Selectors asked per run (a run with more failing elements names the first ones). */
const KIND_TARGETS = 60;

export function componentKinds(): ComponentKinds {
  const kinds = new Map<string, string>();
  return {
    hooks: {
      async onPageOpened(page: PageLike) {
        await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
      },
      async onFindings(page: PageLike, probe: PageProbe, target: { url: string }, findings: readonly ProbeFinding[]) {
        const wanted: { criterion: string; target: string }[] = [];
        for (const f of findings) {
          if (wanted.length >= KIND_TARGETS) break;
          if (!f || f.status !== 'failed' || typeof f.target !== 'string' || !f.target.trim() || f.target.length > 200 || typeof f.criterion !== 'string') continue;
          if (!wanted.some((w) => w.criterion === f.criterion && w.target === f.target)) wanted.push({ criterion: f.criterion, target: f.target });
        }
        if (!wanted.length) return;
        const selectors = wanted.map((w) => w.target);
        let found = await page.evaluate(kindsOfTargets, selectors);
        // The test loaded the page again (the keyboard test does): its kinds are read from the new document.
        if (found === null) {
          await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
          found = await page.evaluate(kindsOfTargets, selectors);
        }
        if (!Array.isArray(found)) return;
        wanted.forEach((w, i) => {
          const k = found[i];
          if (typeof k === 'string' && k) kinds.set(findingKey(target.url, probe.id, w.criterion, w.target), k);
        });
      },
    },
    kindOf: (key) => kinds.get(key),
  };
}

export function templateProbes(
  runner: ProbeRunner, size = PROBE_SAMPLE_SIZE, everyPageCap = Number.POSITIVE_INFINITY,
  /**
   * The scan's element kinds, the cap on pages a novelty group goes to, and the runner the targeted checks
   * run on (`keyboardCheckProbe` and the cheap tests of `CHECKS`; without it no check is sent). Without
   * `coverage`: no extra pages, no checks.
   */
  coverage?: {
    kinds: ComponentKinds; pageCap?: number; checker?: ProbeRunner;
    /**
     * The first pages in page order the wider coverage reaches (`COVERAGE_PAGES_LONG`): past `everyPageCap` and up
     * to it a page gets only optional work (the five newer every-page tests and the novelty groups). Default
     * `everyPageCap`.
     */
    reach?: number;
  },
): TemplateProbes {
  const audited = new Set<number>();
  const candidates: (TemplatePage & Pick<PageAudit, 'collected' | 'incomplete'>)[] = [];
  let decidedBefore = 0;
  // Deep probes that also run on other pages (every page with a video player, say), decided in scan
  // order so the choice never depends on which page finished first.
  const extra = (runner.probes ?? []).filter((p) => p.alsoOn);
  // Core probes that run on every page that loaded (`PageProbe.everyPage`), queued together so the
  // ones that share a page group share one page load. Without `coverage` (the host's switch,
  // `ScanOptions.coverage: false`) only scoring v10's four leave the sample: the scan's schedule is exactly
  // what it was before the wider coverage, with no optional work at all.
  const everyPage = (runner.probes ?? []).filter((p) => p.everyPage && p.tier === 'core' && (coverage || EVERY_PAGE_SCORED.has(p.id))).map((p) => p.id);
  /** Per probe: the pages it asked for beyond the cap that the sample does not cover either. */
  const left = new Map<string, (typeof candidates)[number][]>();
  /**
   * Monitoring scans (W6, r1-8b): a page whose audit was carried forward brings the every-page runs of
   * the scan that checked it; those pages are not opened for the every-page probes (the sample still
   * runs every probe on its pages).
   */
  const carried = new Map<number, ProbeRun[]>();
  let lastSample = new Set<number>();
  const reused = new Set<number>();
  // The novelty groups whose tests this scan runs, with those tests (a group none of whose tests run is left out).
  const have = new Set((runner.probes ?? []).map((p) => p.id));
  const groups = coverage ? NOVELTY_GROUPS.map((g) => ({ ...g, probes: g.probes.filter((id) => have.has(id) && !everyPage.includes(id)) })).filter((g) => g.probes.length) : [];
  /** The every-page tests scoring v10 did not run on every page: outside the sample their runs are the wider coverage. */
  const newEveryPage = everyPage.filter((id) => !EVERY_PAGE_SCORED.has(id));
  /**
   * The tests of the groups that go to a page whatever the pages before it held (`always`): for a page that has the
   * feature they are every-page tests, so a page whose audit was carried forward brings their runs too, from the
   * scan that checked it (act-watch lane, 2026-11-11; it is not opened for them).
   */
  const alwaysProbes = new Set(groups.filter((g) => g.always?.length).flatMap((g) => g.probes));
  const carriedAlways = new Map<number, ProbeRun[]>();
  const planner = noveltyPlanner();
  const groupPages = new Map<string, number>();
  const pageCap = coverage?.pageCap ?? Number.POSITIVE_INFINITY;
  /** Pages (by index) whose novelty is decided: each page once, in scan order. */
  const noveltyDecided = new Set<number>();
  /**
   * The tests a page outside the sample gets beyond the every-page ones, decided once per page in scan order, and
   * how they run: each group a job of its own (`OptionalUnit`), the cheap ones going on on the page's every-page
   * load (`rides`).
   */
  const extraFor = (c: (typeof candidates)[number], sampled: ReadonlySet<number>, within: boolean): { ids: string[]; units: OptionalUnit[] } => {
    const none = { ids: [], units: [] };
    if (!groups.length || noveltyDecided.has(c.index)) return none;
    noveltyDecided.add(c.index);
    const kinds = kindsOfPage(c);
    if (sampled.has(c.index)) {
      for (const g of groups) planner.cover(g.id, g.features, kinds);
      return none;
    }
    // A page whose audit was carried forward is not opened for more than the every-page tests.
    if (!within || carried.has(c.index)) return none;
    const ids: string[] = [];
    const units: OptionalUnit[] = [];
    for (const g of groups) {
      if ((groupPages.get(g.id) ?? 0) >= pageCap) continue;
      if (!planner.fresh(g.id, g.features, kinds) && !(g.always && planner.has(g.always, kinds))) continue;
      planner.cover(g.id, g.features, kinds);
      groupPages.set(g.id, (groupPages.get(g.id) ?? 0) + 1);
      ids.push(...g.probes);
      units.push({ probes: g.probes, ...(g.rides ? { rider: true } : {}) });
    }
    return { ids, units };
  };
  const target = (p: (typeof candidates)[number]) => ({ url: p.page, index: p.index, incomplete: p.incomplete, ...(p.collected ? { collected: p.collected } : {}) });
  const launch = (before: number) => {
    const sample = samplePages(candidates, size, before).sample;
    for (const p of sample) runner.add(target(p));
    const sampled = new Set(sample.map((p) => p.index));
    lastSample = sampled;
    if (!extra.length && !everyPage.length && !groups.length) return;
    const ordered = candidates.filter((c) => c.index < before).sort((a, b) => a.index - b.index);
    // The sample's pages were added above with every probe: `add` runs each probe once per address.
    if (everyPage.length || groups.length) {
      ordered.forEach((c, at) => {
        const within = at < everyPageCap;
        const reach = within || at < (coverage?.reach ?? everyPageCap);
        // Novelty is decided for every page in turn (a sampled page covers its kinds for the pages after it).
        const more = extraFor(c, sampled, reach);
        if (!reach) return;
        if (!within) {
          // Past the pages scoring v10's every-page tests run on: the wider coverage only, all of it optional (a
          // sampled page has every test already; a carried page is not opened for more).
          if (sampled.has(c.index) || carried.has(c.index)) return;
          const optional = [...newEveryPage, ...more.ids];
          const units: OptionalUnit[] = [...(newEveryPage.length ? [{ probes: newEveryPage, rider: true }] : []), ...more.units];
          if (optional.length) runner.add(target(c), optional, { optional, units });
          return;
        }
        const kept = carried.get(c.index);
        if (!sampled.has(c.index) && kept && everyPage.every((id) => kept.some((r) => r.probe === id))) {
          reused.add(c.index);
          return;
        }
        // One call. Outside the sample everything but scoring v10's every-page tests is the wider coverage, and
        // optional: under time pressure the page keeps the tests the score counts and drops the rest without a
        // trace. The newer every-page tests (about 2 s together) and the cheap groups go on on the every-page
        // tests' page load; each other group is a job of its own, which any free tab can take.
        const optional = sampled.has(c.index) ? more.ids : [...newEveryPage, ...more.ids];
        const units: OptionalUnit[] = sampled.has(c.index) ? [] : [...(newEveryPage.length ? [{ probes: newEveryPage, rider: true }] : []), ...more.units];
        if (everyPage.length || more.ids.length) runner.add(target(c), [...everyPage, ...more.ids], optional.length ? { optional, ...(units.length ? { units } : {}) } : undefined);
      });
    }
    for (const probe of extra) {
      let count = 0;
      const skipped: (typeof candidates)[number][] = [];
      for (const c of ordered) {
        let wanted = false;
        try {
          wanted = probe.alsoOn!(c.collected);
        } catch {
          wanted = false;
        }
        if (!wanted) continue;
        if (count >= ALSO_ON_PAGE_CAP) {
          if (!sampled.has(c.index)) skipped.push(c);
          continue;
        }
        count++;
        runner.add(target(c), [probe.id]);
      }
      left.set(probe.id, skipped);
    }
  };
  /**
   * One `not_testable` run per probe for the pages it asked for past the cap, on the first of them,
   * so its criteria say that content on those pages was not tested (never read as clean or "none").
   */
  const leftRuns = (): ProbeRun[] => extra.flatMap((probe) => {
    const skipped = left.get(probe.id) ?? [];
    if (!skipped.length) return [];
    const n = skipped.length;
    const detail = `${n} more scanned ${n === 1 ? 'page' : 'pages'} with content for this test ${n === 1 ? 'was' : 'were'} not opened: this deep test runs on at most ${ALSO_ON_PAGE_CAP} pages a scan`;
    // A criterion the test speaks to only through what it measured says nothing for pages it did not open (`PageProbe.measuredOnly`).
    const criteria = probe.criteria.filter((c) => !probe.measuredOnly?.includes(c));
    return [{
      probe: probe.id, kind: probe.kind, page: skipped[0]!.page, criteria, status: 'ok' as const,
      findings: criteria.map((criterion) => ({ criterion, status: 'not_testable' as const, detail, limit: true as const })), ms: 0,
    }];
  });
  /**
   * The targeted checks, once every other run is in (`componentChecks`): a page that carries an element of a
   * kind a slow test measured failing elsewhere, and was not given that test, has that element measured. All
   * of it is optional work on the checks' own runner, so it starts after every required test of the scan has
   * finished, stops at the optional cutoff, and leaves no trace where it did not happen. What comes back:
   * - from the element check, the failures it measured on the page's own elements and nothing else (a check
   *   that found nothing wrong says nothing: the page was not given the whole test);
   * - from a cheap test sent whole, its run.
   */
  const verify = async (measured: readonly ProbeRun[]): Promise<ProbeRun[]> => {
    const checker = coverage?.checker;
    if (!coverage || !checker) return [];
    try {
      const pages: KindPage[] = candidates.flatMap((c) => {
        const kinds = kindsOfPage(c);
        return kinds ? [{ url: c.page, index: c.index, kinds }] : [];
      });
      const byUrl = new Map(candidates.map((c) => [c.page, c]));
      const can = new Set(checker.probes.map((p) => p.id));
      const sent = new Map<string, PageChecks>();
      for (const check of componentChecks({ pages, runs: measured, kindOf: coverage.kinds.kindOf })) {
        const c = byUrl.get(check.url);
        // A page whose audit was carried forward is not opened for more than the every-page tests.
        if (!c || carried.has(c.index)) continue;
        const ids = [...(check.elements.length ? [keyboardCheckProbe.id] : []), ...check.tests].filter((id) => can.has(id));
        if (!ids.length) continue;
        sent.set(check.url, check);
        checker.add({ ...target(c), collected: { ...(c.collected ?? {}), [CHECK_KEY]: check.elements } }, ids, { optional: ids });
      }
      if (!sent.size) return [];
      return (await checker.finish()).flatMap((run): ProbeRun[] => {
        const check = sent.get(run.page);
        if (!check || run.status !== 'ok') return [];
        if (run.probe !== keyboardCheckProbe.id) return [run];
        const findings = run.findings.filter((f) => f.status === 'failed');
        if (!findings.length) return [];
        return [{ ...run, criteria: [...new Set(findings.map((f) => f.criterion))], findings, coverage: true as const, checked: { from: check.from } }];
      });
    } catch {
      return [];
    }
  };
  /** The tests whose runs outside the sample are the wider coverage: the newer every-page tests and the novelty groups'. */
  const coverageProbes = new Set([...newEveryPage, ...NOVELTY_GROUPS.flatMap((g) => g.probes)]);
  /**
   * A run of the wider coverage is marked (`ProbeRun.coverage`: listed, not scored): a test scoring v10
   * ran on the template sample only, on a page outside the final sample.
   */
  const asCoverage = (run: ProbeRun): ProbeRun => {
    if (run.coverage || !coverageProbes.has(run.probe)) return run;
    const c = candidates.find((x) => x.page === run.page);
    return !c || lastSample.has(c.index) ? run : { ...run, coverage: true as const };
  };
  /** The runner's runs with the carried every-page runs and the page cap's not-tested runs, in page order. */
  const assemble = (fresh: ProbeRun[], checks = 0): ProbeRun[] => {
    // Carried every-page runs, for the pages that reused them (never a page in the final sample).
    const kept = [...reused].filter((i) => !lastSample.has(i)).sort((a, b) => a - b).flatMap((i) => carried.get(i) ?? []);
    // Carried runs of the always-groups' tests, for the carried pages outside the final sample that did not run them now.
    for (const [i, list] of [...carriedAlways].sort((a, b) => a[0] - b[0])) {
      if (lastSample.has(i)) continue;
      kept.push(...list.filter((r) => !fresh.some((f) => f.page === r.page && f.probe === r.probe)));
    }
    const all = (kept.length ? [...fresh, ...kept] : fresh).map(asCoverage);
    // Each failing element's kind goes on its finding (what sends a check of it to other pages).
    const runs = coverage ? withKinds(all, coverage.kinds.kindOf) : all;
    const extraRuns = leftRuns();
    if (!extraRuns.length && !kept.length && !checks) return runs;
    // In page order with the rest (runs are ordered by page index, then registry order).
    const indexOf = new Map(candidates.map((c) => [c.page, c.index]));
    return [...runs, ...extraRuns].map((run, i) => ({ run, i, at: indexOf.get(run.page) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.run);
  };
  return {
    pageAudited(page, index) {
      try {
        audited.add(index);
        while (audited.has(decidedBefore)) decidedBefore++;
        if (page.status === 'ok') candidates.push({ page: page.url, index, shape: pageShapeOf(page), incomplete: page.incomplete, ...(page.collected ? { collected: page.collected } : {}) });
        // Never a targeted check (single elements measured, not a test of the page).
        if (page.status === 'ok' && page.unchangedSince && page.probeRuns?.length) {
          carried.set(index, page.probeRuns.filter((r) => everyPage.includes(r.probe) && r.page === page.url && !r.checked));
          const always = page.probeRuns.filter((r) => alwaysProbes.has(r.probe) && r.page === page.url && !r.checked);
          if (always.length) carriedAlways.set(index, always);
        }
        launch(decidedBefore);
      } catch {
        // The probes must never break the audit.
      }
    },
    aiHears(run) {
      if (AI_HEARS_EVERYWHERE.has(run.probe)) return true;
      const c = candidates.find((x) => x.page === run.page);
      return !c || lastSample.has(c.index);
    },
    counts() {
      try {
        return runner.counts();
      } catch {
        return { queued: 0, done: 0 };
      }
    },
    tests() {
      try {
        return runner.tests();
      } catch {
        return { queued: 0, done: 0 };
      }
    },
    unfinished(finished) {
      try {
        return runner.unfinished(finished);
      } catch {
        return [];
      }
    },
    auditWorkerDone() {
      try {
        runner.lend(VIEWPORTS.length);
      } catch {
        // The probes must never break the audit.
      }
    },
    async finish() {
      try {
        // A page whose event was lost must not block the sample.
        launch(Number.POSITIVE_INFINITY);
        const measured = await runner.finish();
        const checked = await verify(measured);
        return assemble(checked.length ? [...measured, ...checked] : measured, checked.length);
      } catch {
        return [];
      }
    },
    partial(finished) {
      try {
        return assemble(runner.partial(finished));
      } catch {
        return [];
      }
    },
  };
}
