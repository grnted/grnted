// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Where a page width's time goes (`ScanOptions.onViewportSteps`, diagnostics for the hosted budget):
// one record per width of every page, each step timed, and observation only (the report is the same
// with or without it, even when the listener throws).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWPORT_STEPS, type ViewportSteps } from '../../src/audit.js';
import { scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { comparable } from '../helpers/comparable.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const NOW = () => new Date('2026-10-31T12:00:00.000Z');
const scan = (extra: Partial<ScanOptions> = {}) =>
  scanSite(`${server.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 10, probes: false, documents: false, now: NOW, ...extra });

let plain: SiteReport;
let timed: SiteReport;
let throwing: SiteReport;
const steps: ViewportSteps[] = [];

beforeAll(async () => {
  server = await startFixtureServer('events');
  browser = await chromium.launch();
  plain = await scan({ onEvent: () => {}, liveShots: { sink: async () => {} } });
  timed = await scan({ onEvent: () => {}, liveShots: { sink: async () => {} }, onViewportSteps: (s) => steps.push(s) });
  throwing = await scan({ onEvent: () => {}, liveShots: { sink: async () => {} }, onViewportSteps: () => { throw new Error('boom'); } });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('viewport step timings', () => {
  it('gives one record per width of every page, every step timed', () => {
    const ok = timed.pages.filter((p) => p.status === 'ok');
    expect(ok.length).toBeGreaterThan(1);
    for (const p of ok) {
      const mine = steps.filter((s) => s.url === p.url);
      expect(mine.map((s) => s.viewport).sort()).toEqual(['desktop', 'mobile']);
      for (const s of mine) {
        expect(s.status).toBe('ok');
        expect(s.loads).toBeGreaterThanOrEqual(1);
        for (const k of VIEWPORT_STEPS) expect(s.ms[k], k).toBeGreaterThanOrEqual(0);
        const sum = VIEWPORT_STEPS.reduce((t, k) => t + s.ms[k], 0);
        // The steps cover the width's time (a few ms of bookkeeping between them).
        expect(sum).toBeLessThanOrEqual(s.totalMs + 5);
        expect(sum).toBeGreaterThan(s.totalMs * 0.8);
        // The scroll pass and settle window: at least SETTLE_MS after load.
        expect(s.ms.settle).toBeGreaterThanOrEqual(1400);
        if (s.viewport === 'desktop') expect(Object.keys(s.collectorMs).length).toBeGreaterThan(0);
      }
    }
    // The failed page (HTTP 404 in the fixture) is timed too, with its status.
    for (const p of timed.pages.filter((x) => x.status === 'failed')) {
      expect(steps.filter((s) => s.url === p.url).every((s) => s.status === 'failed')).toBe(true);
    }
  });

  it('is observation only: the report is the same with it, and with a listener that throws', () => {
    expect(comparable(timed)).toEqual(comparable(plain));
    expect(comparable(throwing)).toEqual(comparable(plain));
  });
});
