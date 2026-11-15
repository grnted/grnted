// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Where a scan's time goes (docs/scan-time-budget.md): a debug-only measurement, off by default
// (`ScanOptions.onTimeBudget`, or GRNTED_TIME_BUDGET=1 for one line on the console). It only observes:
// the report is the same with or without it. Engine core: no Node-only imports.
//
// Every number but `wallMs` and `phases` is summed over everything that ran at once (browser-time, the
// way browser-hours are billed), so the parts add up to more than the wall clock.
import type { ViewportStep, ViewportSteps } from './audit.js';
import type { ProbeGroupTiming } from './probes/runner.js';
import type { BrowserLike, ContextLike, PageLike, RequestLike } from './types.js';

/** One load through the pace controller, or one page turn (`PaceOptions.onTiming`). */
export type PaceTiming =
  /** `waitMs`: waiting for the host's turn (a pause, the Crawl-delay gap, its limit); `runMs`: the load itself. */
  | { kind: 'load'; url: string; page: boolean; waitMs: number; runMs: number }
  /** A page's wait for its turn under the pages-at-once limit. */
  | { kind: 'turn'; waitMs: number };

export interface TimeBudget {
  /** Start to end of scanSite. */
  wallMs: number;
  /** Wall clock by phase: discovery, the page pass, the work after the pages (tests, documents, pictures, report). */
  phases: { discoverMs: number; pagesMs: number; afterMs: number };
  /** Pages in the scan, and the ones that loaded. */
  pages: number;
  pagesOk: number;
  /** Browser contexts opened and navigations asked for (`page.goto`), every try. */
  contexts: number;
  loads: number;
  /** Navigations per page address: how many times one page is loaded in a scan. */
  loadsPerPage: { median: number; max: number; pagesLoaded: number };
  /** Requests the pages made: all, the ones to the scanned site's host, and the documents among those. */
  requests: { all: number; site: number; siteDocuments: number };
  /** Browser-time inside contexts, by what it was spent on. */
  browser: {
    /** Open to closed, every context. */
    contextMs: number;
    /** newContext and newPage. */
    openMs: number;
    /** Inside `page.goto`: request start to the load event (what a copy of the site can answer). */
    loadMs: number;
    /** Inside `page.waitForTimeout`: the fixed waits the engine asks for (settling, a test watching the page). */
    timerMs: number;
    closeMs: number;
    /** The rest: scripts run in the page, waits inside the page, screenshots, round trips to the browser. */
    otherMs: number;
  };
  /** The pace controller: waits before page loads and plain fetches, and the fetches themselves. */
  pace: { pageLoads: number; pageWaitMs: number; fetches: number; fetchWaitMs: number; fetchMs: number };
  /** Waiting for room: a page's turn under the pages-at-once limit, and a test group's wait for a context. */
  queue: { pageTurnMs: number; testQueueMs: number };
  /** The page audits (both widths), by step (`ViewportSteps`). */
  audit: { widths: number; ms: Record<ViewportStep, number> };
  /** The tests: groups run, their opens, loads (waits for a turn and the pace included), settles and each test's own time. */
  tests: { groups: number; openMs: number; loadMs: number; settleMs: number; loads: number; probeMs: Record<string, number> };
}

export interface TimeBudgetRecorder {
  /** `browser` with its contexts, navigations and timers timed (the objects are the browser's own). */
  browser(browser: BrowserLike): BrowserLike;
  pace(e: PaceTiming): void;
  viewport(steps: ViewportSteps): void;
  group(t: ProbeGroupTiming): void;
  /** A phase ended now: discovery, then the page pass. */
  mark(phase: 'discovered' | 'pages'): void;
  summary(pages: { total: number; ok: number }): TimeBudget;
}

const stripHash = (url: string): string => {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};

const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function createTimeBudget(site: string, now: () => number = Date.now): TimeBudgetRecorder {
  const startedAt = now();
  const siteHost = hostOf(site);
  const marks: { discovered?: number; pages?: number } = {};
  const b = { contextMs: 0, openMs: 0, loadMs: 0, timerMs: 0, closeMs: 0 };
  let contexts = 0;
  let loads = 0;
  const perPage = new Map<string, number>();
  const requests = { all: 0, site: 0, siteDocuments: 0 };
  const pace = { pageLoads: 0, pageWaitMs: 0, fetches: 0, fetchWaitMs: 0, fetchMs: 0 };
  const queue = { pageTurnMs: 0, testQueueMs: 0 };
  const audit: TimeBudget['audit'] = { widths: 0, ms: {} as Record<ViewportStep, number> };
  const tests: TimeBudget['tests'] = { groups: 0, openMs: 0, loadMs: 0, settleMs: 0, loads: 0, probeMs: {} };

  const timePage = (page: PageLike): void => {
    const goto = page.goto.bind(page);
    const wait = page.waitForTimeout.bind(page);
    Object.assign(page, {
      async goto(url: string, o?: Parameters<PageLike['goto']>[1]) {
        const t0 = now();
        loads++;
        const key = stripHash(url);
        perPage.set(key, (perPage.get(key) ?? 0) + 1);
        try {
          return await goto(url, o);
        } finally {
          b.loadMs += now() - t0;
        }
      },
      async waitForTimeout(ms: number) {
        const t0 = now();
        try {
          return await wait(ms);
        } finally {
          b.timerMs += now() - t0;
        }
      },
    });
  };

  const timeContext = (ctx: ContextLike, openedAt: number): void => {
    contexts++;
    b.openMs += now() - openedAt;
    ctx.on?.('request', (r: RequestLike) => {
      try {
        requests.all++;
        if (hostOf(r.url()) !== siteHost) return;
        requests.site++;
        if (r.resourceType() === 'document') requests.siteDocuments++;
      } catch {
        // a request that cannot be read is not counted
      }
    });
    const newPage = ctx.newPage.bind(ctx);
    const close = ctx.close.bind(ctx);
    let closed = false;
    Object.assign(ctx, {
      async newPage() {
        const t0 = now();
        const page = await newPage();
        b.openMs += now() - t0;
        timePage(page);
        return page;
      },
      async close() {
        const t0 = now();
        try {
          await close();
        } finally {
          if (!closed) {
            closed = true;
            b.closeMs += now() - t0;
            b.contextMs += now() - openedAt;
          }
        }
      },
    });
  };

  return {
    browser(browser) {
      return new Proxy(browser, {
        get(target, prop, receiver) {
          if (prop === 'newContext') {
            return async (opts: Parameters<BrowserLike['newContext']>[0]) => {
              const t0 = now();
              const ctx = await target.newContext(opts);
              timeContext(ctx, t0);
              return ctx;
            };
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
    pace(e) {
      if (e.kind === 'turn') queue.pageTurnMs += e.waitMs;
      else if (e.page) {
        pace.pageLoads++;
        pace.pageWaitMs += e.waitMs;
      } else {
        pace.fetches++;
        pace.fetchWaitMs += e.waitMs;
        pace.fetchMs += e.runMs;
      }
    },
    viewport(s) {
      audit.widths++;
      for (const [k, v] of Object.entries(s.ms) as [ViewportStep, number][]) audit.ms[k] = (audit.ms[k] ?? 0) + v;
    },
    group(t) {
      tests.groups++;
      queue.testQueueMs += Math.max(0, t.startedAt - t.queuedAt);
      tests.openMs += t.openMs;
      tests.loadMs += t.loadMs;
      tests.settleMs += t.settleMs;
      tests.loads += t.loads;
      for (const [id, ms] of Object.entries(t.probeMs)) tests.probeMs[id] = (tests.probeMs[id] ?? 0) + ms;
    },
    mark(phase) {
      marks[phase] ??= now();
    },
    summary(pages) {
      const end = now();
      const discovered = marks.discovered ?? end;
      const paged = marks.pages ?? end;
      const counts = [...perPage.values()];
      const round = <T extends Record<string, number>>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])) as T;
      return {
        wallMs: end - startedAt,
        phases: { discoverMs: discovered - startedAt, pagesMs: Math.max(0, paged - discovered), afterMs: Math.max(0, end - paged) },
        pages: pages.total, pagesOk: pages.ok, contexts, loads,
        loadsPerPage: { median: median(counts), max: counts.length ? Math.max(...counts) : 0, pagesLoaded: counts.length },
        requests: { ...requests },
        browser: round({ ...b, otherMs: Math.max(0, b.contextMs - b.openMs - b.loadMs - b.timerMs - b.closeMs) }),
        pace: round(pace), queue: round(queue),
        audit: { widths: audit.widths, ms: round(audit.ms) },
        tests: { ...tests, probeMs: round(tests.probeMs) },
      };
    },
  };
}

/**
 * The measurement asked for from outside the code: GRNTED_TIME_BUDGET=1 prints one line,
 * `GRNTED_TIME_BUDGET {json}`, when the scan ends. Absent (the default) nothing is measured.
 */
export function envTimeBudget(): ((b: TimeBudget) => void) | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!ALWAYS_LOG && !env?.GRNTED_TIME_BUDGET) return undefined;
  return (b) => console.log(`GRNTED_TIME_BUDGET ${JSON.stringify(b)}`);
}

/** Measurement commits only (never merged): print the line without the environment variable. */
const ALWAYS_LOG = false;
