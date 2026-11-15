// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A time limit on what a visitor enters (2.2.1, src/probes/timingEntry.ts) in real Chromium, over one small
// page (test/fixtures/timing-entry/draft.html?m=<mode>): each mode is one hand-written pattern.
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

const run = async (path: string): Promise<ProbeRun> => {
  const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}${path}`, index: 0 }], [timingEntryProbe], { userAgent: 'grnted-test', full: true });
  return r!;
};
const mode = (m: string) => run(`/draft.html?m=${m}`);
const result = (r: ProbeRun) => r.findings.map((f) => [f.status, f.detail]);
const statuses = (r: ProbeRun) => r.findings.map((f) => f.status);
const T = 60_000;
const NOTE = '“What is the gathering for?”';

describe('2.2.1: a time limit on what a visitor enters', () => {
  it('fails a timer set when the page loads that clears what was typed, with no warning and no way to extend', async () => {
    const r = await mode('load-clear');
    expect(r.status).toBe('ok');
    expect(result(r)).toEqual([['failed', `30 s after the page loads, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
    expect(r.findings[0]!.target).toBe('#note');
    expect(result(await mode('load-remove'))).toEqual([['failed', `45 s after the page loads, the page takes away ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
  }, T);

  it('fails a limit that starts when the visitor types, and one that starts with a button', async () => {
    expect(result(await mode('typing-lock'))).toEqual([['failed', `30 s after typing starts, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
    expect(result(await mode('press-lock'))).toEqual([['failed', `40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
  }, T);

  it('fails a countdown built from a repeating timer (run tick by tick)', async () => {
    expect(result(await mode('press-countdown'))).toEqual([['failed', `40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
  }, T);

  it('fails a countdown that reads the clock (the page\'s clock is moved forward with each tick), and a limit on a number field', async () => {
    // A countdown read tick by tick ends on a tick: the limit is the 40 s it was set for, or one tick more.
    const clock = await mode('press-clock');
    expect(statuses(clock)).toEqual(['failed']);
    expect(clock.findings[0]!.detail).toMatch(/^4[01] s after “Start a request” is pressed, the page clears what was typed into “What is the gathering for\?”; nothing on the page turns this time limit off, adjusts it or extends it$/);
    expect(result(await mode('number'))).toEqual([['failed', `30 s after the page loads, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
  }, T);

  it('ticks under 1 s that were running before the test started: the clock is moved in steps and the page\'s own ticks end the limit', async () => {
    // The limit is known between two steps; with a button to extend on the way it is not a failure.
    expect(result(await mode('load-clock'))).toEqual([['failed', `between 30 s and 2 min after the page loads, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
    expect(result(await mode('load-clock-extend'))).toEqual([['no_failures_found', `time limit found (between 30 s and 2 min after the page loads, the page clears what was typed into ${NOTE}); the page offers “Extend”`]]);
    // A short timeout that re-arms itself is on the test's list from its next run: run at its times, the limit is exact.
    const chain = await mode('load-chain');
    expect(statuses(chain)).toEqual(['failed']);
    expect(chain.findings[0]!.detail).toMatch(/^4[01] s after the page loads, the page clears what was typed into/);
  }, T);

  it('a countdown that shows "Extend" on the way: fails with 10 seconds left to press it, clean with 25', async () => {
    const short = await mode('clock-warn-short');
    expect(statuses(short)).toEqual(['failed']);
    expect(short.findings[0]!.detail).toMatch(/“Extend” shows (9|10|11) s before that, which is all the time there is to press it/);
    const long = await mode('clock-warn-long');
    expect(statuses(long)).toEqual(['no_failures_found']);
    expect(long.findings[0]!.detail).toMatch(/the page offers “Extend”, with 2[456] s to press it$/);
  }, T);

  it('fails a warning that leaves less than 20 seconds to extend, whether the limit\'s timer is set by the warning or beside it', async () => {
    expect(result(await mode('warn-short'))).toEqual([['failed', `40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}. “Extend” shows 10 s before that, which is all the time there is to press it: a visitor has to be given at least 20 seconds to extend a limit. Nothing else turns this time limit off, adjusts it or extends it`]]);
    const beside = await mode('warn-beside');
    expect(statuses(beside)).toEqual(['failed']);
    expect(beside.findings[0]!.detail).toContain('“Stay signed in” shows 8 s before that');
  }, T);

  it('fails a limit that can be adjusted to less than ten times its default', async () => {
    expect(result(await mode('adjust-short'))).toEqual([['failed', `40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}. the limit can be set (“Time limit”) to at most 6 min, 9 times the default 40 s: an adjustable limit has to reach at least ten times the default. Nothing else turns this time limit off, adjusts it or extends it`]]);
  }, T);

  it('look-alikes: a warning with 25 seconds to extend, a "No time limit" switch, and a limit adjustable to ten times its default', async () => {
    expect(result(await mode('warn-long'))).toEqual([['no_failures_found', `time limit found (40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}); the page offers “Extend”, with 25 s to press it`]]);
    expect(result(await mode('off-switch'))).toEqual([['no_failures_found', `time limit found (40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}); the page lets the visitor turn it off (“No time limit”)`]]);
    expect(result(await mode('adjust-wide'))).toEqual([['no_failures_found', `time limit found (40 s after “Start a request” is pressed, the page clears what was typed into ${NOTE}); the visitor can set it up to 6.7 min (“Time limit”), at least ten times the default`]]);
  }, T);

  it('look-alikes: timers that never take what was typed; a refresh on a repeating timer; a start-up script; a panel that folds away', async () => {
    for (const m of ['none', 'busy', 'refresh', 'startup', 'fold']) expect(statuses(await mode(m)), m).toEqual(['no_failures_found']);
  }, 120_000);

  it('a page with no text field is not applicable, and nothing the page sends when its limit runs out leaves the browser', async () => {
    expect(statuses(await run('/plain.html'))).toEqual(['not_applicable']);
    const start = requests.length;
    expect(statuses(await mode('press-fetch'))).toEqual(['failed']);
    expect(requests.slice(start).filter((x) => /\/api\/|\/send/.test(x))).toEqual([]);
  }, T);

  // Review r1, finding 3: the timers are run in sweeps, and a repeating timer's ticks must go on from one sweep
  // to the next, not start again.
  it('a 60 s countdown of one tick a second with "Extend" for its last 20 seconds passes (the ticks are never replayed)', async () => {
    const r = await mode('load-ticks-extend');
    expect(statuses(r)).toEqual(['no_failures_found']);
    expect(r.findings[0]!.detail).toMatch(/^time limit found \((60|61) s after the page loads, the page clears what was typed into “What is the gathering for\?”\); the page offers “Extend”, with (19|20|21) s to press it$/);
  }, T);

  // Finding 4: 2.2.1 has exceptions (a real-time event, an essential limit). Where the page shows a sign of one,
  // the limit is not failed: the test cannot tell.
  it('a bid field that closes with a live auction, and a typing-speed test: not testable, never failed', async () => {
    const auction = await mode('auction');
    expect(statuses(auction)).toEqual(['not_testable']);
    expect(auction.findings[0]!.detail).toContain('the page says “Live auction”');
    const typing = await mode('typing-test');
    expect(statuses(typing)).toEqual(['not_testable']);
    expect(typing.findings[0]!.detail).toContain('the page says “Typing speed”');
  }, T);

  // Finding 5: a field the page swaps for a new one is found again; only what is really lost counts.
  it('a field replaced by a new one that keeps the text, the focus and the caret is no time limit; one replaced empty is', async () => {
    expect(statuses(await mode('replace-keep'))).toEqual(['no_failures_found']);
    expect(result(await mode('replace-empty'))).toEqual([['failed', `10 s after the page loads, the page clears what was typed into ${NOTE}; nothing on the page turns this time limit off, adjusts it or extends it`]]);
  }, T);

  // Review r2, finding 3: the sign may be anywhere in the page's visible text, and gone again when the limit ends.
  it('"Live auction — bids close in two minutes" in a paragraph outside the field\'s form, taken away at closing: not testable', async () => {
    const r = await mode('auction-apart');
    expect(statuses(r)).toEqual(['not_testable']);
    expect(r.findings[0]!.detail).toContain('the page says “Live auction”');
  }, T);

  // Review r2, finding 4: a replacement is found by its accessible name too; a same-valued field with no name is a doubt.
  it('a field named by aria-label, replaced elsewhere on the page with its text kept: no time limit; with no name at all: not testable', async () => {
    expect(statuses(await mode('replace-aria'))).toEqual(['no_failures_found']);
    const unnamed = await mode('replace-unnamed');
    expect(statuses(unnamed)).toEqual(['not_testable']);
    expect(unnamed.findings[0]!.detail).toContain('another field on the page now holds the same text');
  }, T);

  // Finding 13: when the test cannot run all the page's timers, it has not shown that there is no limit.
  it('more timer runs than the test makes before a late limit: not testable, never "none of the timers cleared the entry"', async () => {
    const r = await mode('flood');
    expect(statuses(r)).toEqual(['not_testable']);
    expect(r.findings[0]!.detail).toContain('could not be run to the end');
  }, T);

  // Review r1, finding 2: the button the test presses can save a file without any request.
  it('a button that saves what was typed as a file: pressed, and no file is ever saved', async () => {
    const downloads: { failure(): Promise<string | null> }[] = [];
    const watched = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const c = await browser.newContext(o);
        c.on('page', (p) => p.on('download', (d) => downloads.push(d)));
        return c;
      },
    } as unknown as BrowserLike;
    const [r] = await runProbes(watched, [{ url: `${server.origin}/draft.html?m=export`, index: 0 }], [timingEntryProbe], { userAgent: 'grnted-test', full: true });
    expect(r!.findings.map((f) => f.status)).toEqual(['no_failures_found']);
    expect(r!.findings[0]!.detail).toContain('pressed 1 button');
    expect(downloads).toEqual([]);
  }, T);
});
