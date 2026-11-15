// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Runs a test's cases: each case's site on its own local server, scanned by the real engine (scanSite,
// one page, the test's probes only, deep ones with `full`) in its own Chromium, so a case that runs
// past its time cap is stopped by closing that browser without touching the others. At most two cases
// at once (the Mac is shared); pixel tests that time frames ask for one.
import { chromium, type Browser } from 'playwright';
import { quietBrowser } from '../../src/analytics.js';
import { AXE_RULES } from '../../src/report/criteria.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startSimServer } from './server.js';
import type { CaseResult, Observed, SimCase, SimTest } from './types.js';

export const MAX_SIM_CONCURRENCY = 2;

const statusTo = (s: string | undefined): Observed => {
  switch (s) {
    case 'failed': return 'fail';
    case 'not_applicable': return 'na';
    case 'not_testable': return 'not_testable';
    case 'no_failures_found':
    case 'flagged':
      return 'pass';
    default: return 'na';
  }
};

const cap = (xs: string[], n = 6) => xs.slice(0, n).map((x) => x.slice(0, 400));

/** The engine's verdict for one criterion on the case's page, read as the test says. */
export function readVerdict(test: SimTest, report: SiteReport, criterion: string): { observed: Observed; count: number; details: string[] } {
  const runs = (report.probes?.runs ?? []).filter((r) => r.criteria.includes(criterion));
  const findings = runs.flatMap((r) => r.findings.filter((f) => f.criterion === criterion).map((f) => ({ ...f, probe: r.probe })));
  const axeIds = new Set(AXE_RULES[criterion] ?? []);
  const axe = (report.rules ?? []).filter((r) => axeIds.has(r.id) && r.pagesAffected.length > 0);
  const failedFindings = findings.filter((f) => f.status === 'failed');
  const details = cap([
    ...axe.map((r) => `axe:${r.id} ${r.elements} element(s): ${r.examples.map((e) => e.target).slice(0, 3).join(' | ')}`),
    ...findings.map((f) => `${f.probe}: ${f.status}${f.target ? ` ${f.target}` : ''}: ${f.detail ?? ''}`),
  ], 8);
  if (report.status !== 'scored' && !(report.pages ?? []).some((p) => p.status === 'ok')) {
    return { observed: 'error', count: 0, details: [`the page did not load: ${(report.pages ?? []).map((p) => p.reason ?? p.status).join('; ')}`] };
  }
  if (test.read === 'probe') {
    const mine = findings.filter((f) => test.readProbes?.includes(f.probe));
    const count = mine.filter((f) => f.status === 'failed').length;
    if (count) return { observed: 'fail', count, details };
    if (mine.some((f) => f.status === 'not_testable')) return { observed: 'not_testable', count: 0, details };
    if (!mine.length || mine.every((f) => f.status === 'not_applicable')) return { observed: mine.length ? 'na' : 'pass', count: 0, details };
    return { observed: 'pass', count: 0, details };
  }
  const row = (report.criteria ?? []).find((c) => c.criterion === criterion);
  const count = failedFindings.length + axe.reduce((t, r) => t + r.elements, 0);
  return { observed: statusTo(row?.status), count, details };
}

export async function runCase(test: SimTest, c: SimCase): Promise<CaseResult[]> {
  const t0 = Date.now();
  const server = await startSimServer(c.site);
  let browser: Browser | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const base = (criterion: string) => ({ id: c.id, test: c.test, criterion, hazard: c.hazard, params: c.params, expected: c.expect[criterion]!, why: c.why });
  try {
    browser = await chromium.launch();
    const scan = scanSite(`${server.origin}/`, {
      browser: quietBrowser(browser as unknown as BrowserLike), maxPages: test.maxPages ?? 1, concurrency: 1,
      probes: test.probes(), ...(test.full ? { full: true } : {}), documents: false,
    });
    scan.catch(() => {});
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), test.capMs); });
    const report = await Promise.race([scan, timeout]);
    const ms = Date.now() - t0;
    if (report === 'timeout') {
      return test.criteria.map((criterion) => ({ ...base(criterion), observed: 'timeout', observedCount: 0, details: [`stopped at the ${test.capMs} ms cap`], ms }));
    }
    return test.criteria.map((criterion) => {
      const v = readVerdict(test, report, criterion);
      return { ...base(criterion), observed: v.observed, observedCount: v.count, details: v.details, ms };
    });
  } catch (e) {
    const ms = Date.now() - t0;
    return test.criteria.map((criterion) => ({ ...base(criterion), observed: 'error', observedCount: 0, details: [String((e as Error)?.stack ?? e).slice(0, 600)], ms }));
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export interface RunTestOptions {
  concurrency?: number;
  /** Only cases whose id matches. */
  filter?: RegExp;
  /** At most this many cases (evenly spread over the case list). */
  limit?: number;
  onCase?: (results: CaseResult[], done: number, total: number) => void;
}

/** Every case of a test (or a spread-out subset), at most `MAX_SIM_CONCURRENCY` at once. */
export async function runTest(test: SimTest, seed: number, opts: RunTestOptions = {}): Promise<CaseResult[]> {
  let cases = test.cases(seed);
  if (opts.filter) cases = cases.filter((c) => opts.filter!.test(c.id));
  if (opts.limit && opts.limit < cases.length) {
    const step = cases.length / opts.limit;
    cases = Array.from({ length: opts.limit }, (_, i) => cases[Math.floor(i * step)]!);
  }
  const n = Math.max(1, Math.min(opts.concurrency ?? MAX_SIM_CONCURRENCY, MAX_SIM_CONCURRENCY, test.maxConcurrency ?? MAX_SIM_CONCURRENCY));
  const queue = [...cases];
  const out: CaseResult[] = [];
  let done = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const rs = await runCase(test, c);
      out.push(...rs);
      opts.onCase?.(rs, ++done, cases.length);
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  const order = new Map(cases.map((c, i) => [c.id, i]));
  return out.sort((a, b) => order.get(a.id)! - order.get(b.id)! || (a.criterion < b.criterion ? -1 : 1));
}
