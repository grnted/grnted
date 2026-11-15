// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The page's own writes (test-everything A2, A3) in real Chromium: a request that would send data is
// never sent, whatever made the page send it; one the page makes by itself (an analytics beacon, a
// heartbeat) no longer ends a test, one the test's own action caused still does; and a gesture test
// is not stopped by a stylesheet, an image or a fetch with no query, nor by a fixed notice over its
// content. Fixture site: test/fixtures/background/. The server logs every request, so the tests show
// at the network level what was sent.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import { guardStop } from '../../src/probes/guard.js';
import { hoverContentProbe } from '../../src/probes/hoverContent.js';
import { motionProbe } from '../../src/probes/motion.js';
import { motionActuationProbe } from '../../src/probes/actuation.js';
import { overlaysProbe } from '../../src/probes/overlays.js';
import { pointerCancellationProbe } from '../../src/probes/pointerCancellation.js';
import { pointerGesturesProbe } from '../../src/probes/pointerGestures.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const log: { method: string; path: string }[] = [];
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };
const writes = (from: number) => log.slice(from).filter((r) => r.method !== 'GET' && r.method !== 'HEAD');

beforeAll(async () => {
  server = await startFixtureServer('background', {}, {
    onRequest: (req: IncomingMessage) => log.push({ method: req.method ?? '', path: req.url ?? '' }),
    // A page the site refuses to a fresh browser (as perrydaleschool.com did to 1 of 5 test loads).
    respond: (_req, path) => (path === '/refused.html' ? { status: 406, body: 'Not Acceptable', type: 'text/plain' } : undefined),
  });
  // Every host resolves to this machine: the fixtures name real analytics and CDN hosts, and nothing a
  // test does may reach them (the guard blocks those requests anyway).
  browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * 127.0.0.1'] });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = (probes: PageProbe[], path: string): Promise<ProbeRun[]> => runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], probes, OPTS);
const guardReasons = (r: ProbeRun) => r.findings.filter((f) => f.status === 'not_testable' && /sent data|request guard|made a request/.test(f.detail)).map((f) => f.detail);

describe('one page must not sink a criterion (A1)', () => {
  const REFUSED = 'could not be tested automatically on 1 of 5 pages: the page did not load for this test: HTTP 406';
  const fivePages = (path: string) => ['?a', '', '?b', '?c', '?d'].map((q, index) => ({ url: `${server.origin}${q ? `${path}${q}` : '/refused.html'}`, index }));

  it('1 of 5 pages failing to load for the test, the other 4 with nothing to test: not applicable on the 4, the page named (was not testable)', async () => {
    const runs = await runProbes(B(), fivePages('/plain.html'), [hoverContentProbe], OPTS);
    expect(runs.map((r) => r.status)).toEqual(['ok', 'error', 'ok', 'ok', 'ok']);
    const [row] = probeCriteriaResults(runs);
    expect(row!.method.status).toBe('not_applicable');
    expect(row!.method.note).toMatch(new RegExp(`^nothing to test on the 4 pages tested \\(.+\\); ${REFUSED}$`));
    expect(row!.evidence[0]).toEqual({ page: `${server.origin}/refused.html`, detail: 'the page did not load for this test: HTTP 406' });
  }, 120_000);

  it('the same with a tooltip tested on the 4: no failures found on the 4 pages tested', async () => {
    const runs = await runProbes(B(), fivePages('/tooltip.html'), [hoverContentProbe], OPTS);
    const [row] = probeCriteriaResults(runs);
    expect(row!.method).toEqual({ id: 'hover-content', kind: 'interaction', status: 'no_failures_found', pages: 5, note: `no failures found on the 4 pages tested; ${REFUSED}` });
  }, 120_000);
});

describe('a page with nothing to test with does not hold a criterion back (round 2)', () => {
  it('the runner keeps a probe\'s nothingToTest, so a pass on one page with a form is the criterion\'s result', async () => {
    const noForm = 'status messages are tested through the messages of a form, and this page has no form fields';
    const status: PageProbe = {
      id: 'status-like', criteria: ['4.1.3'], kind: 'interaction', tier: 'core', timeoutMs: 10_000,
      async run(ctx) {
        return ctx.url.includes('tooltip')
          ? [{ criterion: '4.1.3', status: 'no_failures_found', detail: 'error messages checked' }]
          : [{ criterion: '4.1.3', status: 'not_testable', detail: noForm, nothingToTest: true }];
      },
    };
    const runs = await runProbes(B(), ['/tooltip.html', '/plain.html'].map((p, index) => ({ url: `${server.origin}${p}`, index })), [status], OPTS);
    expect(runs[1]!.findings).toEqual([{ criterion: '4.1.3', status: 'not_testable', detail: noForm, nothingToTest: true }]);
    expect(probeCriteriaResults(runs)[0]!.method.status).toBe('no_failures_found');
  }, 60_000);
});

describe('the page\'s own writes (A2)', () => {
  it('a page that POSTs to analytics services every 2 s: the hover, motion and overlays tests complete; no POST is ever sent; the run logs them', async () => {
    const from = log.length;
    const runs = await run([hoverContentProbe, motionProbe, overlaysProbe], '/beacon.html');
    expect(runs.map((r) => r.probe)).toEqual(['hover-content', 'motion', 'overlays']);
    for (const r of runs) {
      expect({ probe: r.probe, stopped: guardReasons(r) }).toEqual({ probe: r.probe, stopped: [] });
      expect({ probe: r.probe, status: r.status }).toEqual({ probe: r.probe, status: 'ok' });
      expect(r.backgroundWrites?.count).toBeGreaterThan(0);
      expect(r.backgroundWrites!.hosts.length).toBeGreaterThan(0);
      for (const h of r.backgroundWrites!.hosts) expect(['us.i.posthog.com', 'www.google-analytics.com', 'api.segment.io', 'api-js.mixpanel.com', 'a.clarity.ms']).toContain(h);
    }
    // The clean tooltip is still tested (no failure), the page has no motion and no overlay problem.
    expect(runs[0]!.findings).toEqual([]);
    // Never sent: the server saw the page's GETs only.
    expect(writes(from)).toEqual([]);
  }, 180_000);

  it('a button whose click POSTs to the site (at once, or after a moment) stops the test; the analytics beacons do not', async () => {
    const from = log.length;
    const seen: Record<string, string | null> = {};
    const clicker: PageProbe = {
      id: 'clicker', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 30_000,
      async run(ctx) {
        const page = ctx.page as unknown as Page;
        // Nothing done: 2.5 s of the page's own beacons.
        let mark = ctx.guard.mark();
        await page.waitForTimeout(2500);
        await ctx.guard.settled?.(3000);
        seen.idle = guardStop(ctx.guard.since(mark));
        for (const id of ['save', 'later', 'plain']) {
          mark = ctx.guard.mark();
          await page.click(`#${id}`);
          await page.waitForTimeout(800);
          await ctx.guard.settled?.(3000);
          seen[id] = guardStop(ctx.guard.since(mark));
        }
        return [];
      },
    };
    const [r] = await run([clicker], '/click-post.html');
    expect(r!.status).toBe('ok');
    expect(seen.idle).toBeNull();
    expect(seen.save).toBe(`the test would have sent data to the live site (POST request to ${server.origin}/api/settings), so it was stopped`);
    expect(seen.later).toBe(`the test would have sent data to the live site (POST request to ${server.origin}/api/settings/later), so it was stopped`);
    expect(seen.plain).toBeNull();
    expect(r!.backgroundWrites?.count).toBeGreaterThan(0);
    expect(writes(from)).toEqual([]);
  }, 60_000);
});

describe('writes the test\'s own actions cause, to the scanned site (round 1 review): each still stops the test', () => {
  const STOP = (path: string) => `the test would have sent data to the live site (POST request to ${server.origin}${path}), so it was stopped`;
  /** One action, then what the guard stopped after it (null: nothing that ends a test). */
  const actor = (seen: Record<string, string | null>): PageProbe => ({
    id: 'actor', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 40_000,
    async run(ctx) {
      const page = ctx.page as unknown as Page;
      await page.waitForTimeout(1500);
      const acts: [string, () => Promise<unknown>][] = [
        ['flood', () => page.click('#flood')],
        ['frame', () => page.click('#frame-save')],
        ['hover', () => page.hover('#tip')],
        ['focus', () => page.focus('#field')],
        ['deferred', () => page.click('#deferred')],
      ];
      for (const [name, act] of acts) {
        const mark = ctx.guard.mark();
        await act();
        await page.waitForTimeout(900);
        await ctx.guard.settled?.(3000);
        seen[name] = guardStop(ctx.guard.since(mark));
        await page.mouse.move(1, 1);
      }
      return [];
    },
  });

  it('a click POST followed by a beacon flood, a POST through a same-origin frame, a hover or focus that POSTs from a timer, a deferred click POST to an address already POSTed on load', async () => {
    const from = log.length;
    const seen: Record<string, string | null> = {};
    const [r] = await run([actor(seen)], '/own-writes.html');
    expect(r!.status).toBe('ok');
    expect(seen).toEqual({
      flood: STOP('/api/save'),
      frame: STOP('/api/frame-save'),
      hover: STOP('/api/tooltip'),
      focus: STOP('/api/focus'),
      deferred: STOP('/api/settings'),
    });
    expect(r!.backgroundWrites).toBeUndefined();
    expect(writes(from)).toEqual([]);
  }, 90_000);
});

describe('round 2 review: a blocked request the test may have caused is never a pass (real probes)', () => {
  /** The probe's findings for a criterion, and the roll-up's status. */
  const verdict = (runs: ProbeRun[], criterion: string) => ({
    findings: runs.flatMap((r) => r.findings).filter((f) => f.criterion === criterion).map((f) => f.status),
    row: probeCriteriaResults(runs).find((x) => x.criterion === criterion)?.method.status,
  });
  const notTestable = { findings: ['not_testable'], row: 'not_testable' };

  it('#1 hover: a tooltip POSTed to an address the page already POSTed to on load stops the test (not "not applicable")', async () => {
    const from = log.length;
    const runs = await run([hoverContentProbe], '/repeat-tooltip.html');
    expect(verdict(runs, '1.4.13')).toEqual(notTestable);
    expect(runs[0]!.findings[0]!.detail).toContain('/api/tooltip');
    expect(writes(from)).toEqual([]);
  }, 60_000);

  it('#2 hover: a tooltip loaded by POST from another host (not an analytics service) stops the test', async () => {
    expect(verdict(await run([hoverContentProbe], '/offsite-hover.html'), '1.4.13')).toEqual(notTestable);
  }, 60_000);

  it('#2 pointer cancellation: a press that POSTs an order to another host is never a clean result', async () => {
    const from = log.length;
    expect(verdict(await run([pointerCancellationProbe], '/offsite-press.html'), '2.5.2')).toEqual(notTestable);
    expect(writes(from)).toEqual([]);
  }, 60_000);

  it('#2 motion actuation: a shake whose only effect is a POST to another host is never a clean result', async () => {
    expect(verdict(await run([motionActuationProbe], '/offsite-shake.html'), '2.5.4')).toEqual(notTestable);
  }, 60_000);

  it('#2 gestures: a swipe whose only effect is a POST to another host is never a clean result', async () => {
    expect(verdict(await run([pointerGesturesProbe], '/offsite-swipe.html'), '2.5.1')).toEqual(notTestable);
  }, 60_000);

  it('hover: a mouseover that GETs /bag/add?sku=1 sends nothing and stops the test (never clean)', async () => {
    const from = log.length;
    const runs = await run([hoverContentProbe], '/bag-hover.html');
    expect(verdict(runs, '1.4.13')).toEqual(notTestable);
    expect(runs[0]!.findings[0]!.detail).toContain('/bag/add?sku=1');
    expect(log.slice(from).map((x) => x.path).filter((p) => p.startsWith('/bag/'))).toEqual([]);
  }, 60_000);

  it('#3 gestures: a swipe whose only effect is images at /api/session/end, /api/logout.png and /pixel?down=1 is never a clean result; none is sent', async () => {
    const from = log.length;
    expect(verdict(await run([pointerGesturesProbe], '/swipe-image.html'), '2.5.1')).toEqual(notTestable);
    expect(log.slice(from).map((x) => x.path).filter((p) => p !== '/swipe-image.html')).toEqual([]);
  }, 60_000);
});

describe('gestures (A3)', () => {
  it('a stylesheet and a web font from Google\'s static servers during a drag: never sent, and the gesture test completes', async () => {
    const from = log.length;
    const [r] = await run([pointerGesturesProbe], '/drag-style.html');
    expect(guardReasons(r!)).toEqual([]);
    // The slider has Decrease and Increase buttons: no failure, and nothing left untested.
    // 2.1.1 (keyboard-op lane): the test reordered no list here.
    expect(r!.findings).toEqual([{ criterion: '2.5.1', status: 'not_applicable', detail: 'no swipe, pinch or other gesture handlers found on page content' }, { criterion: '2.1.1', status: 'not_applicable', detail: 'no list was measured reordering by dragging' }]);
    // Nothing the drag asked for reached the server: only the page's own load.
    expect(log.slice(from).map((x) => x.path).filter((p) => p !== '/drag-style.html')).toEqual([]);
  }, 60_000);

  it('a slider below the fold under a fixed cookie notice: scrolled into view and the notice hidden while it is tested, it is tested', async () => {
    const [r] = await run([pointerGesturesProbe], '/drag-covered.html');
    // 2.1.1 (keyboard-op lane): the test reordered no list here.
    expect(r!.findings).toEqual([{ criterion: '2.5.1', status: 'not_applicable', detail: 'no swipe, pinch or other gesture handlers found on page content' }, { criterion: '2.1.1', status: 'not_applicable', detail: 'no list was measured reordering by dragging' }]);
  }, 60_000);
});
