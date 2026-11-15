// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared by the Task 4.4 probe tests: one Chromium and the motion fixture site per test file.
import { chromium, type Browser, type Page } from 'playwright';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe, ProbeRun } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from './fixtureServer.js';

export interface MotionSite {
  origin: string;
  /** Every request the fixture server received ("METHOD /path?query"), in order. */
  requests: string[];
  /** Runs probes on fixture pages (paths relative to test/fixtures/motion/); path → runs, in probe order. */
  run(probes: PageProbe[], paths: string[], opts?: { concurrency?: number }): Promise<Record<string, ProbeRun[]>>;
  close(): Promise<void>;
}

/**
 * `onPage` sees each page the probes open (to make a browser feature fail, for example).
 * `guardDelayMs` delays every request decision of the guard (a busy machine, as in the keyboard tests).
 * `delayMs` holds the server's responses back by path (a slow response).
 */
export async function motionSite(opts: { onPage?: (page: Page) => void; guardDelayMs?: number; delayMs?: (path: string) => number } = {}): Promise<MotionSite> {
  const requests: string[] = [];
  const server = await startFixtureServer('motion', {}, {
    onRequest: (req) => { requests.push(`${req.method} ${req.url}`); },
    ...(opts.delayMs ? { delayMs: opts.delayMs } : {}),
  });
  const browser: Browser = await chromium.launch();
  if (opts.onPage || opts.guardDelayMs) {
    // Patch the real objects (a proxy would break the guard's page identity checks).
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (o) => {
      const context = await newContext(o);
      if (opts.onPage) {
        const newPage = context.newPage.bind(context);
        context.newPage = async () => { const page = await newPage(); opts.onPage!(page); return page; };
      }
      const delay = opts.guardDelayMs;
      if (delay) {
        const route = context.route.bind(context);
        context.route = ((pattern: Parameters<typeof route>[0], handler: (r: Parameters<Parameters<typeof route>[1]>[0]) => unknown) =>
          route(pattern, (r) => { setTimeout(() => { void handler(r); }, delay); })) as typeof context.route;
      }
      return context;
    };
  }
  return {
    origin: server.origin,
    requests,
    async run(probes, paths, opts = {}) {
      const runs = await runProbes(browser as unknown as BrowserLike, paths.map((p, index) => ({ url: `${server.origin}/${p}`, index })), probes,
        { userAgent: 'grnted-test', full: true, concurrency: opts.concurrency ?? 3 });
      const out: Record<string, ProbeRun[]> = {};
      for (const r of runs) (out[new URL(r.page).pathname.slice(1)] ??= []).push(r);
      return out;
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

export const statuses = (r: ProbeRun) => r.findings.map((f) => f.status);
export const only = (r: ProbeRun) => {
  if (r.findings.length !== 1) throw new Error(`expected one finding, got ${JSON.stringify(r.findings)}`);
  return r.findings[0]!;
};
