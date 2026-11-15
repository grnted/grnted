// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.3.1 on a browser behind a network link, as the hosted checker runs it on Browser Rendering (80 ms
// round trip): the screencast must bring the frame rate above the 8 a second the analysis needs, so
// the flash test decides the page (screenshots one after the other managed about 1–2 a second). On a
// link too slow even for the screencast, the animation and media check decides instead.
// Fixtures: test/fixtures/motion/flash-*.html (synthetic patterns).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flashProbe } from '../../src/probes/flash.js';
import { flashMotionProbe, flashPrecedence } from '../../src/probes/flashMotion.js';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { remoteBrowser, type RemoteBrowser } from '../helpers/remoteBrowser.js';

/** Each way: an 80 ms round trip, about what a Worker sees to its Browser Rendering session. */
const DELAY_MS = 40;

let server: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => { server = await startFixtureServer('motion'); }, 30_000);
afterAll(async () => { await server?.close(); });

const PAGES = ['flash-4hz.html', 'flash-2hz.html', 'flash-small.html', 'flash-red.html', 'flash-fast.html', 'flash-gif.html', 'static.html'];

describe('the flash test on a remote browser (80 ms round trip)', () => {
  let remote: RemoteBrowser;
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    remote = await remoteBrowser(DELAY_MS);
    const out = await runProbes(remote.browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${server.origin}/${p}`, index })), [flashProbe],
      { userAgent: 'grnted-test', full: true, concurrency: 1 });
    runs = Object.fromEntries(out.map((r) => [new URL(r.page).pathname.slice(1), r]));
    for (const p of PAGES) console.log(`flash on a remote browser: ${p}: ${JSON.stringify(runs[p]!.data)} ${runs[p]!.findings.map((f) => f.status).join(',')} ${runs[p]!.ms} ms`);
  }, 240_000);
  afterAll(async () => { await remote?.close(); });
  const statuses = (page: string) => runs[page]!.findings.map((f) => f.status);

  it('gets more than 8 frames a second from the screencast on every page, inside its time box', () => {
    for (const p of PAGES) {
      expect(runs[p]!.data, p).toMatchObject({ method: 'screencast', fps: expect.toSatisfy((n: number) => n > 8) });
      expect(runs[p]!.ms, p).toBeLessThan(flashProbe.timeoutMs * 0.75);
    }
  });

  it('fails full-screen flashing at 4 a second, a red flash, a CSS animation at 5 a second and a GIF at 6 a second', () => {
    for (const p of ['flash-4hz.html', 'flash-red.html', 'flash-fast.html', 'flash-gif.html']) expect(statuses(p), JSON.stringify(runs[p]!.findings)).toEqual(['failed']);
    expect(runs['flash-red.html']!.findings[0]!.detail).toMatch(/^red flashing: /);
  });

  it('finds no failure for flashing at 2 a second, a small flashing dot and a still page', () => {
    for (const p of ['flash-2hz.html', 'flash-small.html', 'static.html']) expect(statuses(p), JSON.stringify(runs[p]!.findings)).toEqual(['no_failures_found']);
  });
});

describe('on a link too slow for the screencast (1.6 s round trip)', () => {
  it('the flash test cannot decide, and the animation and media check decides the page instead', async () => {
    const remote = await remoteBrowser(800);
    try {
      const pages = ['flash-fast.html', 'static.html'];
      const out = await runProbes(remote.browser as unknown as BrowserLike, pages.map((p, index) => ({ url: `${server.origin}/${p}`, index })), [flashProbe, flashMotionProbe],
        { userAgent: 'grnted-test', full: true, concurrency: 2 });
      const by = (probe: string, page: string) => out.find((r) => r.probe === probe && r.page.endsWith(page))!;
      expect(by('flash', 'flash-fast.html').findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringMatching(/frames per second .* the animation and media check judges this page instead$/) })]);
      const kept = flashPrecedence(out);
      expect(kept.find((r) => r.probe === 'flash-motion' && r.page.endsWith('flash-fast.html'))!.findings.map((f) => f.status)).toEqual(['failed']);
      expect(kept.find((r) => r.probe === 'flash-motion' && r.page.endsWith('static.html'))!.findings.map((f) => f.status)).toEqual(['no_failures_found']);
      const row = probeCriteriaResults(kept).filter((r) => r.criterion === '2.3.1').map((r) => `${r.method.id} ${r.method.status}`);
      expect(row).toEqual(['flash not_testable', 'flash-motion failed']);
    } finally {
      await remote.close();
    }
  }, 240_000);
});
