// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.2.2 Pause, Stop, Hide in real Chromium: three things the 2026-11 red-team sites showed the motion
// test deciding wrongly, each on a fresh fixture (test/fixtures/motion/) with its look-alike.
// - A control for how often content updates (the SC allows it for auto-updating content), when the select sits
//   inside its label: it was failed, because the label's text was read glued to the options.
// - Motion that starts by itself some seconds after the page opened: it was called clean.
// - A pause that does not hold. WCAG defines "paused" as "stopped by user request and not resumed until
//   requested by user"; technique G4's test is that it "has stopped and does not restart by itself". A Pause
//   that ends when focus moves on, or a Hide that brings the content back after some seconds, is neither.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdCheck, motionProbe } from '../../src/probes/motion.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe, ProbeRun } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('motion');
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function probeOn(probe: PageProbe, paths: string[]): Promise<Record<string, ProbeRun>> {
  const runs = await runProbes(browser as unknown as BrowserLike, paths.map((p, index) => ({ url: `${server.origin}/${p}`, index })), [probe], OPTS);
  return Object.fromEntries(runs.map((r) => [new URL(r.page).pathname.slice(1), r]));
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('motion (2.2.2): a control for how often content updates', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['frequency-wrapped.html', 'frequency-slower-only.html', 'frequency-lookalike.html', 'scores-frequency.html', 'frequency-restarts.html']);
  }, 180_000);

  it('a select inside its label ("Update frequency" + its options) is found, and its "Manual only" setting is tried and stops the updates', () => {
    expect(runs['frequency-wrapped.html']!.findings).toEqual([expect.objectContaining({
      status: 'no_failures_found', target: '#board', detail: expect.stringContaining('the control "Update frequency" set to "Manual only" stops it'),
    })]);
    // The same for a label beside its select, whose last option is "never".
    expect(runs['scores-frequency.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('"Update scores every" set to "never" stops it') })]);
  });

  // Review r1, finding 14: a setting that stops the updates is credited only when they stay stopped.
  it('does not credit a "Manual only" setting that the page undoes by itself 3 s later: not decided, never passed', () => {
    const r = runs['frequency-restarts.html']!;
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      status: 'not_testable', target: '#board',
      detail: expect.stringMatching(/controls that did not keep it stopped: "Update frequency: Manual only": it stopped, then started again by itself \(a timer the page set when the control was used brings it back within 3 s\)/),
    })]);
  });

  it('with no setting that stops the updates it is still not decided, never failed', () => {
    expect(runs['frequency-slower-only.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('"Update frequency" may set how often it updates') })]);
  });

  it('look-alike: a select about something else, with an option that only sounds like it ("Frequent lines", "None"), still fails', () => {
    expect(failed(runs['frequency-lookalike.html']!)).toEqual([expect.objectContaining({ target: '#board', detail: expect.stringContaining('no pause, stop or hide control was found') })]);
  });
});

describe('motion (2.2.2): motion that starts by itself some seconds after the page opened', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['delayed-ticker.html', 'delayed-updates.html', 'delayed-ticker-pause.html', 'delayed-short.html']);
  }, 180_000);

  it('fails a notice that starts an endless scroll 6 s after load, and times that start to update every 4.5 s after 11 s', () => {
    expect(failed(runs['delayed-ticker.html']!)).toEqual([expect.objectContaining({ target: '#note', detail: expect.stringMatching(/CSS animation "slide" on p, started by a timer the page set starts by itself and runs with no end; nothing on the page pauses, stops or hides it/) })]);
    expect(failed(runs['delayed-updates.html']!)).toEqual([expect.objectContaining({ target: '#board', detail: expect.stringContaining('content that the page changes by itself every 4.5 s') })]);
  });

  it('look-alike: the same late scroll with a Pause that works passes; a late 3 s movement and a line added once are not motion', () => {
    expect(runs['delayed-ticker-pause.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('the control "Pause" stops it') })]);
    expect(runs['delayed-short.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('nothing moved, blinked or updated by itself for more than 5 s') })]);
  });
});

describe('motion (2.2.2): a pause that does not hold is not a pause', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['pause-until-blur.html', 'pause-holds-after-blur.html', 'hide-comes-back.html', 'hide-with-show.html']);
  }, 180_000);

  it('fails a Pause that ends when keyboard focus leaves the button', () => {
    expect(failed(runs['pause-until-blur.html']!)).toEqual([expect.objectContaining({
      target: '#board', detail: expect.stringContaining('controls that did not keep it stopped: "Pause updates": it stopped, then started again by itself when keyboard focus left the control'),
    })]);
  });

  it('fails a Hide whose content the page brings back, moving, 6 s later', () => {
    expect(failed(runs['hide-comes-back.html']!)).toEqual([expect.objectContaining({
      target: '#note', detail: expect.stringContaining('"Hide notice": it stopped, then started again by itself (a timer the page set when the control was used brings it back within 6 s)'),
    })]);
  });

  it('look-alike: a Pause that stays paused when focus moves on, and a Hide undone only by its Show button (with an unrelated 4 s timer), pass', () => {
    expect(runs['pause-holds-after-blur.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('the control "Pause updates" stops it') })]);
    expect(runs['hide-with-show.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('the control "Hide notice" stops it') })]);
  });
});

describe('motion (2.2.2): a hold that was not checked is not a hold', () => {
  // Review r2, finding 10: stopping while focus is inside it is a pause only when it holds once focus has left.
  it('does not credit a ticker that stops only while it has keyboard focus: not decided, never passed; one that stays stopped passes', async () => {
    const focus = await probeOn(motionProbe, ['focus-only-pause.html', 'focus-stops-for-good.html']);
    expect(focus['focus-only-pause.html']!.findings, JSON.stringify(focus['focus-only-pause.html']!.findings)).toEqual([expect.objectContaining({
      criterion: '2.2.2', status: 'not_testable', detail: expect.stringContaining('it stops only while keyboard focus is inside it (it stopped, then started again by itself when keyboard focus left it)'),
    })]);
    expect(focus['focus-stops-for-good.html']!.findings, JSON.stringify(focus['focus-stops-for-good.html']!.findings)).toEqual([expect.objectContaining({
      criterion: '2.2.2', status: 'no_failures_found', detail: expect.stringContaining('it stops while keyboard focus is inside it, and stays stopped when focus moves on'),
    })]);
  }, 120_000);

  it('answers "unverified", never "held", when no time is left to look (and does not touch the page)', async () => {
    const page = new Proxy({}, { get: () => () => { throw new Error('the page must not be used'); } });
    const hold = await holdCheck({ page, deadline: Date.now() + 2000, signal: new AbortController().signal } as never, { el: { id: 1, path: '#x', tag: 'div' } } as never, []);
    expect(hold).toEqual({ kind: 'unverified' });
  });
});
