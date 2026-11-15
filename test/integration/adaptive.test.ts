// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Adaptive pages at once (src/pace.ts, the page gate) changes only when pages run, never what a scan
// finds: the same 25-page fixture site (test/fixtures/timing/, 300 ms per page like a real server)
// gives the same report at today's fixed 4 pages at once, adaptive from 4 up to 8, and a fixed 8.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaceAdapt } from '../../src/pace.js';
import { scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, SiteReport } from '../../src/types.js';
import { comparable } from '../helpers/comparable.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let chrome: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const NOW = () => new Date('2026-11-04T12:00:00.000Z');
const delayMs = (path: string) => (path.endsWith('.html') || path.endsWith('/') ? 300 : 40);

const opts = (extra: Partial<ScanOptions>): ScanOptions => ({
  browser: chrome as unknown as BrowserLike, maxPages: 25, now: NOW, documents: false,
  evidence: { sink: async () => {}, maxImages: 6 },
  ...extra,
});

let fixed4: SiteReport;
let adaptive: SiteReport;
let fixed8: SiteReport;
const changes: PaceAdapt[] = [];
const ms: Record<string, number> = {};

beforeAll(async () => {
  server = await startFixtureServer('timing', {}, { delayMs });
  chrome = await chromium.launch();
  // Compare the same content at each concurrency: a crossfade between measurements
  // can otherwise add a transient text overlap to only one of the three scans.
  const newContext = chrome.newContext.bind(chrome);
  chrome.newContext = async (options) => {
    const context = await newContext(options);
    await context.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => document.getElementById('pause')?.click(), { once: true });
    });
    return context;
  };
  const start = `${server.origin}/`;
  const timed = async (name: string, o: Partial<ScanOptions>) => {
    const t0 = Date.now();
    const r = await scanSite(start, opts(o));
    ms[name] = Date.now() - t0;
    return r;
  };
  fixed4 = await timed('fixed4', { concurrency: 4 });
  adaptive = await timed('adaptive', { concurrency: 8, startConcurrency: 4, onConcurrency: (e) => changes.push(e) });
  fixed8 = await timed('fixed8', { concurrency: 8 });
}, 900_000);

afterAll(async () => {
  await chrome?.close();
  await server?.close();
});

describe('adaptive pages at once', () => {
  it('the same report at 4 pages at once, adaptive up to 8, and 8', () => {
    // Timings for the record (a loaded machine makes them noisy; nothing is asserted on them).
    console.log(`adaptive pages at once, 25 pages: fixed 4 ${ms.fixed4} ms, adaptive ${ms.adaptive} ms (${changes.map((c) => `${c.from}->${c.to} ${c.why}`).join(', ') || 'no change'}), fixed 8 ${ms.fixed8} ms`);
    expect(fixed4.status).toBe('scored');
    expect(fixed4.pages.length).toBe(25);
    expect(fixed4.probes?.runs.length).toBeGreaterThan(0);
    expect(comparable(adaptive)).toEqual(comparable(fixed4));
    expect(comparable(fixed8)).toEqual(comparable(fixed4));
  });

  it('really goes up on the fast fixture: from 4, one step at a time, at least once', () => {
    // The first window at the start is its own baseline, so only a slow first byte or a refusal could
    // hold it at 4 here; a regression that never raises fails this.
    expect(changes[0]).toEqual({ from: 4, to: 5, why: 'comfortable' });
    expect(Math.max(...changes.map((c) => c.to))).toBeGreaterThan(4);
  });

  it('only ever raises one step at a time, and never past the ceiling', () => {
    for (const c of changes) {
      expect(Math.abs(c.to - c.from)).toBe(1);
      expect(c.to).toBeLessThanOrEqual(8);
      expect(c.to).toBeGreaterThanOrEqual(1);
    }
  });
});
