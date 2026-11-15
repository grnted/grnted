// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A scan spread over several browser sessions (`ScanOptions.sessions`, the hosted checker's extra
// Browser Rendering sessions) finds exactly what the same scan in one session finds: same report apart
// from the clock, with the core tests in their own session while pages are audited, the navigation
// gate on in every session, and evidence pictures and probes as before. Fixture: test/fixtures/site/.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite, type ScanOptions } from '../../src/scan.js';
import type { BrowserLike, ContextLike, ScanEvent, SiteReport } from '../../src/types.js';
import { comparable } from '../helpers/comparable.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let chrome: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const NOW = () => new Date('2026-10-31T12:00:00.000Z');

interface Opened { session: string; probe: boolean; at: number }

/** One "session": the shared Chromium seen through a wrapper that records each context it opens. */
function session(name: string, log: Opened[]): { browser: BrowserLike; cdp: () => number } {
  let cdp = 0;
  const raw = chrome as unknown as BrowserLike;
  return {
    browser: {
      async newContext(o) {
        // Probe contexts block service workers (src/probes/runner.ts); audits and the evidence pass do not.
        log.push({ session: name, probe: o.serviceWorkers === 'block', at: Date.now() });
        return raw.newContext(o) as Promise<ContextLike>;
      },
      async newBrowserCDPSession() {
        cdp++;
        return raw.newBrowserCDPSession!();
      },
    },
    cdp: () => cdp,
  };
}

const opts = (extra: Partial<ScanOptions>): ScanOptions => ({
  browser: chrome as unknown as BrowserLike, maxPages: 10, now: NOW, documents: false,
  evidence: { sink: async () => {}, maxImages: 6 },
  ...extra,
});

let one: SiteReport;
let oneSerial: SiteReport;
let two: SiteReport;
let three: SiteReport;
let gatedOne: SiteReport;
let gatedTwo: SiteReport;
const twoLog: Opened[] = [];
const threeLog: Opened[] = [];
let pagesDoneAt = 0;
let gatedCdp: number[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
  chrome = await chromium.launch();
  const start = `${server.origin}/`;
  one = await scanSite(start, opts({}));
  oneSerial = await scanSite(start, opts({ concurrency: 1 }));
  {
    const [a, b] = [session('a', twoLog), session('b', twoLog)];
    let pages = 0;
    let total = 0;
    const onEvent = (e: ScanEvent) => {
      if (e.type === 'selected') total = e.pages.length;
      if (e.type === 'page-done' && ++pages === total) pagesDoneAt = Date.now();
    };
    // One page at a time, so the core tests start while later pages are still audited.
    two = await scanSite(start, opts({ browser: a.browser, sessions: [b.browser], onEvent, concurrency: 1 }));
  }
  {
    const s = ['a', 'b', 'c'].map((n) => session(n, threeLog));
    three = await scanSite(start, opts({ browser: s[0]!.browser, sessions: [s[1]!.browser, s[2]!.browser] }));
  }
  gatedOne = await scanSite(start, opts({ allowUrl: async () => true }));
  {
    const log: Opened[] = [];
    const [a, b] = [session('a', log), session('b', log)];
    gatedTwo = await scanSite(start, opts({ browser: a.browser, sessions: [b.browser], allowUrl: async () => true }));
    gatedCdp = [a.cdp(), b.cdp()];
  }
}, 300_000);

afterAll(async () => {
  await chrome?.close();
  await server?.close();
});

describe('a scan over several browser sessions', () => {
  it('is the same report as in one session (two or three sessions)', () => {
    expect(one.status).toBe('scored');
    expect(one.probes?.runs.length).toBeGreaterThan(0);
    expect(one.evidence?.length).toBeGreaterThan(0);
    // (The two-session scan audits one page at a time: the evidence pass's concurrency follows it.)
    expect(comparable(two)).toEqual(comparable(oneSerial));
    expect(comparable(three)).toEqual(comparable(one));
  });

  it('keeps the core tests to their own session while pages are audited; the audits use every session', () => {
    const during = twoLog.filter((o) => o.at < pagesDoneAt);
    expect(during.filter((o) => o.probe).length).toBeGreaterThan(0);
    expect(during.filter((o) => o.probe).every((o) => o.session === 'b')).toBe(true);
    expect(during.filter((o) => !o.probe).some((o) => o.session === 'a')).toBe(true);
    // Three sessions: the audits spread over all three, the core tests stay in the third while pages are audited.
    expect(new Set(threeLog.filter((o) => !o.probe).map((o) => o.session))).toEqual(new Set(['a', 'b', 'c']));
    expect(threeLog.filter((o) => o.probe).some((o) => o.session === 'c')).toBe(true);
  });

  it('gates every session on its own (each gets a browser-level CDP session), with the same result', () => {
    expect(gatedCdp[0]).toBeGreaterThan(0);
    expect(gatedCdp[1]).toBeGreaterThan(0);
    expect(comparable(gatedTwo)).toEqual(comparable(gatedOne));
    expect(comparable(gatedOne)).toEqual(comparable(one));
  });
});
