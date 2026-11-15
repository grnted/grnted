// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Act-watch review r1, F7: base code of 2.2.1 that this lane now runs on every page with a field or a script
// (src/probes/timingEntry.ts, src/probes/timing.ts). Three timers that are no time limit on the visitor, failed
// before; and the limits that must still fail beside them. Real Chromium, synthetic pages.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { isTimeWarning, timingProbe } from '../../src/probes/timing.js';
import { timingEntryProbe } from '../../src/probes/timingEntry.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('timing-entry');
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const entry = async (path: string): Promise<ProbeRun> => (await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [timingEntryProbe], OPTS))[0]!;
const of = (r: ProbeRun) => r.findings.filter((f) => f.criterion === '2.2.1').map((f) => [f.status, f.detail]);

describe('2.2.1, typed text: what is no limit on the visitor (review r1 F7)', () => {
  it('RED: a dialog that opens 8 s after the load and makes the page behind it inert does not "lock" the search field: no verdict', async () => {
    const r = await entry('/f7-inert-dialog.html');
    expect(of(r).map(([s]) => s)).toEqual(['not_testable']);
    expect(of(r)[0]![1]).toMatch(/the page locks “Search”, but only as part of the page made inert \(as under a dialog that is open\)/);
  }, 60_000);

  it('RED: text typed before "Send feedback", which thanks and closes the box 6 s later: no verdict', async () => {
    const r = await entry('/f7-helpful.html');
    expect(of(r).map(([s]) => s)).toEqual(['not_testable']);
    expect(of(r)[0]![1]).toMatch(/after “Send feedback” is pressed, the page takes away “Tell us more”, but the text was typed before “Send feedback” was pressed and the press took it/);
  }, 60_000);

  it('still failed: a press that only moves on to the next step ("Continue to the details") while a timer it started clears the first step\'s entry', async () => {
    const r = await entry('/f7-next-step.html');
    expect(of(r).map(([s]) => s)).toEqual(['failed']);
    expect(of(r)[0]![1]).toMatch(/30 s after “Continue to the details” is pressed, the page clears what was typed into “Group name”/);
  }, 60_000);

  it('still failed: a limit a press starts on text typed after it (the press only opened the form)', async () => {
    const r = await entry('/draft.html?m=press-lock');
    expect(of(r).map(([s]) => s)).toEqual(['failed']);
  }, 60_000);
});

describe('2.2.1, a countdown is a warning only when it is about the visitor (review r1 F7c)', () => {
  const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Festival</title></head><body><main><h1>Summer festival</h1>${body}</main>
<script>(function () { var n = 200000, t = document.getElementById('t'); setInterval(function () { n -= 1; t.textContent = Math.floor(n / 3600) + ':' + String(Math.floor(n / 60) % 60).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }, 1000); })();</script></body></html>`;
  const timing = async (html: string): Promise<ProbeRun> => {
    const sim = await startSimServer({ files: { '/': html } });
    try {
      return (await runProbes(B(), [{ url: `${sim.origin}/`, index: 0 }], [timingProbe], OPTS))[0]!;
    } finally { await sim.close(); }
  };

  it('RED: "Time remaining until the festival" ticking every second is no time-limit warning', async () => {
    const r = await timing(page('<p>The festival opens on Saturday at noon. Time remaining: <span id="t">55:33:20</span></p>'));
    expect(of(r).filter(([s]) => s === 'failed')).toEqual([]);
  }, 60_000);

  it('the same countdown about the visitor\'s session is a warning; alone it shows no limit running out: no verdict (batch 17)', async () => {
    // (Failed until batch 17: a warning by itself demonstrates no time limit on what the visitor is doing.)
    const r = await timing(page('<p>Your session ends soon. Time remaining: <span id="t">55:33:20</span></p>'));
    expect(of(r).map(([s]) => s)).toEqual(['not_testable']);
    expect(of(r)[0]![1]).toMatch(/a warning appears when its timers run: "Your session ends soon\. Time remaining: .*the test saw the warning only, not the limit running out/);
  }, 60_000);

  it('the words: countdown words alone are no warning; tied to the visitor\'s input or session, or a stated limit, they are', () => {
    for (const t of ['Time remaining until the festival: 2 days', 'Only 5 minutes left to see the fireworks', 'Time left in the auction: 3 hours']) expect(isTimeWarning(t), t).toBe(false);
    for (const t of ['Time remaining in your session: 2 minutes', '5 minutes left to save your changes', 'Time left: your answers are sent when it runs out. 2 minutes left to finish your form', 'Your session will expire in 2 minutes']) expect(isTimeWarning(t), t).toBe(true);
    // A countdown in a box with a form field (the page's own judgement, in `collect`) is tied to the input.
    expect(isTimeWarning('Time remaining: 4 minutes left', true)).toBe(true);
  });
});
