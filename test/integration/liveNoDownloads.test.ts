// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Safety: the live test presses toggle buttons on real sites, and a press must never save a file. A button
// whose handler downloads a file the page makes itself (a Blob behind a link it clicks) sends nothing over the
// network, so the request guard cannot stop it: the test's browser context refuses downloads, and the link's
// click is cancelled in the page. Fixture: test/fixtures/live-toggles/download.html (written for this test).
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { screenReaderLiveProbe } from '../../src/probes/screenReader/index.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let runs: ProbeRun[] = [];
const contexts: { acceptDownloads?: boolean }[] = [];
const downloads: string[] = [];
let pressed = '';

beforeAll(async () => {
  site = await startFixtureServer('live-toggles');
  browser = await chromium.launch();
  // The real browser, with every context's options and downloads recorded.
  const watched = new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === 'newContext') {
        return async (opts: { acceptDownloads?: boolean }) => {
          contexts.push({ ...(opts.acceptDownloads !== undefined ? { acceptDownloads: opts.acceptDownloads } : {}) });
          const ctx: BrowserContext = await target.newContext(opts);
          ctx.on('page', (page) => {
            page.on('download', (d) => { downloads.push(d.suggestedFilename()); });
            page.on('close', () => {});
          });
          // What the page says of itself when the run ends (the buttons' handlers ran).
          ctx.on('page', (page) => page.on('console', (m) => { if (m.text().startsWith('pressed:')) pressed = m.text(); }));
          return ctx;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  runs = await runProbes(watched as unknown as BrowserLike, [{ url: `${site.origin}/download.html`, index: 0 }], [screenReaderLiveProbe], { userAgent: 'grnted-test', settleMs: 200, concurrency: 1 });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe('safety: pressing a button never saves a file', () => {
  it('the live test ran and pressed the toggle buttons', () => {
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('ok');
    const data = runs[0]!.data as { menus?: number } | undefined;
    expect(data?.menus ?? 0).toBeGreaterThan(0);
  });

  it('every context of a test that presses is opened with downloads refused', () => {
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((c) => c.acceptDownloads === false)).toBe(true);
  });

  it('a file the page makes and downloads by clicking a link of its own is never started', () => {
    expect(downloads).toEqual([]);
  });
});
