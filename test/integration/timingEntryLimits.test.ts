// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.1, a time limit on what a visitor enters (the timing-entry test): what takes typed text away without being a
// limit on the visitor is not failed (batch 17, 2026-11-12, the lead's precision audit). Real Chromium on
// test/fixtures/timing-entry/b17-*.html. Every "RED" page failed 2.2.1 before; the planted pages still do.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { timingEntryProbe } from '../../src/probes/timingEntry.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer('timing-entry', {}, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = async (name: string): Promise<[string, string][]> => {
  const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/b17-${name}.html`, index: 0 }], [timingEntryProbe], { userAgent: 'grnted-test', full: true });
  expect(r!.status, name).toBe('ok');
  return r!.findings.filter((f) => f.criterion === '2.2.1').map((f) => [f.status, f.detail]);
};
const T = 60_000;

describe('2.2.1 typed text: what is no limit on the visitor', () => {
  it('RED: a CAPTCHA\'s answer goes with its picture when a new one comes: the field is never typed into', async () => {
    const got = await run('captcha');
    expect(got.map(([s]) => s)).toEqual(['no_failures_found']);
    expect(got[0]![1]).toMatch(/typed into 1 text field/);
  }, T);

  it('RED: "Are you still there?" switches the form off behind a dialog that a button answers: no verdict', async () => {
    const got = await run('still-there');
    expect(got.map(([s]) => s)).toEqual(['not_testable']);
    expect(got[0]![1]).toMatch(/10 min after typing starts, the page locks “What is the gathering for\?”, but only while a dialog with a button to answer it is showing/);
  }, T);

  it('RED: a board that draws itself again every 30 s (a timeout that sets the next), its filter field included, is a refresh', async () => {
    expect((await run('chain-refresh')).map(([s]) => s)).toEqual(['no_failures_found']);
  }, T);

  it('RED: a desk that closes at a time of day ("closes at 14:15 today") is no limit counted from the visit: no verdict', async () => {
    const got = await run('office-hours');
    expect(got.map(([s]) => s)).toEqual(['not_testable']);
    expect(got[0]![1]).toMatch(/the page locks “Your question”, but .*: this may be a time of day \(opening hours, a closing time, a deadline\)/);
  }, T);

  it('RED: a field made read-only for a moment while a draft is saved is given back: no limit', async () => {
    expect((await run('autosave-lock')).map(([s]) => s)).toEqual(['no_failures_found']);
  }, T);

  it('RED: a page made inert under a sign-up box that has no dialog role: no verdict', async () => {
    const got = await run('inert-overlay');
    expect(got.map(([s]) => s)).toEqual(['not_testable']);
    expect(got[0]![1]).toMatch(/the page locks “Search”, but only as part of the page made inert/);
  }, T);

  it('RED: a board that draws itself again on a later check of a timer that goes on: no verdict', async () => {
    const got = await run('interval-goes-on');
    expect(got.map(([s]) => s)).toEqual(['not_testable']);
    expect(got[0]![1]).toMatch(/60 s after the page loads, the page clears what was typed into “Filter by route”, but the timer that did it repeats and went on running afterwards/);
  }, T);
});

describe('2.2.1 typed text: planted limits still fail', () => {
  it('a form switched off for good 15 minutes after typing starts', async () => {
    const got = await run('session-lock');
    expect(got.map(([s]) => s)).toEqual(['failed']);
    expect(got[0]![1]).toMatch(/15 min after typing starts, the page locks “What is the gathering for\?”; nothing on the page turns this time limit off/);
  }, T);

  it('the same behind a dialog whose only button signs in again', async () => {
    const got = await run('expired-dialog');
    expect(got.map(([s]) => s)).toEqual(['failed']);
    expect(got[0]![1]).toMatch(/15 min after typing starts, the page locks/);
  }, T);

  it('a 45 s countdown that clears the entry and ends itself', async () => {
    const got = await run('countdown-clear');
    expect(got.map(([s]) => s)).toEqual(['failed']);
    expect(got[0]![1]).toMatch(/45 s after the page loads, the page clears what was typed into “What is the gathering for\?”/);
  }, T);

  it('nothing but GET requests reached the server', () => {
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});
