// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The 2.2.1 probes (timing core, timing-watch deep) in real Chromium on test/fixtures/motion/timing-*.html.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timingProbe, timingWatchProbe } from '../../src/probes/timing.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, only, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
beforeAll(async () => { site = await motionSite({ delayMs: (path) => (path.startsWith('/slow/') ? 1400 : 0) }); }, 30_000);
afterAll(async () => { await site?.close(); });

describe('timing probe (2.2.1, core)', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([timingProbe], [
      'timing-redirect.html', 'timing-session.html', 'timing-alert.html', 'timing-confirm.html', 'timing-refresh-off.html',
      'timing-logout-post.html', 'timing-analytics.html', 'timing-long.html', 'static.html', 'timing-hang.html', 'carousel-auto.html', 'timing-popup.html',
      'timing-turnoff-signout.html', 'timing-signout-only.html', 'timing-chained.html', 'timing-chained-async.html',
      'timing-help-link.html', 'timing-disability-link.html', 'timing-session-recording.html', 'timing-turnoff-account.html',
      'timing-turnoff-disabled.html', 'timing-double-promise.html', 'timing-bridge.html',
      'timing-order-timer.html', 'timing-countdown-link.html', 'timing-two-bridges.html', 'timing-slow-fetch.html',
    ], { concurrency: 4 });
  }, 120_000);
  const f = (page: string) => only(runs[page]![0]!);

  it('fails time limits with no way to extend or turn them off', () => {
    expect(f('timing-redirect.html')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*static\.html after 30 s/) });
    expect(f('timing-alert.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('Your session has expired') });
    expect(f('timing-alert.html').detail).toContain('reloads itself');
  });

  it('accepts a warning with an extend control, a confirm dialog and a turn-off control', () => {
    expect(f('timing-session.html')).toMatchObject({ status: 'no_failures_found', target: '#warn', detail: expect.stringContaining('"Stay signed in"') });
    expect(f('timing-confirm.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('confirm dialog asks whether to continue') });
    expect(f('timing-refresh-off.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Turn off auto refresh"') });
  });

  it('accepts a turn-off control named in more than four words, with the limit\'s own sign-out words', () => {
    expect(f('timing-turnoff-signout.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Turn off automatic sign-out"') });
  });

  it('does not take a sign-out button, or a turn-off control for something else, as a way to turn the limit off', () => {
    expect(f('timing-signout-only.html')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*static\.html after 30 s/) });
  });

  it('runs a timer that a timer started (an app mounted from a timer sets its time limit), also after a promise', () => {
    expect(f('timing-chained.html')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*static\.html after 60 s/) });
    expect(f('timing-chained-async.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reloads itself after 60 s') });
  });

  it('review round 1: a link about the limit, "Disability support sessions" and "Stop session recording" are not the control', () => {
    for (const page of ['timing-help-link.html', 'timing-disability-link.html', 'timing-session-recording.html']) {
      expect(f(page), page).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*\/login after 30 s/) });
    }
  });

  it('review round 1: a working "… for this account" button counts; disabled buttons do not', () => {
    expect(f('timing-turnoff-account.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Turn off automatic sign-out for this ac…"') });
    expect(f('timing-turnoff-disabled.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing on the page turns this time limit off') });
  });

  it('review round 1: follows two promise gaps and a 500 ms bridge timer to the time limit', () => {
    expect(f('timing-double-promise.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reloads itself after 60 s') });
    expect(f('timing-bridge.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reloads itself') });
  });

  it('review round 2: "Stop the order timer" and a "Stop countdown" link are not the control', () => {
    for (const page of ['timing-order-timer.html', 'timing-countdown-link.html']) {
      expect.soft(f(page), page).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*\/login after 30 s/) });
    }
  });

  it('review round 2: follows two 800 ms bridges, and a response that arrives 1.4 s later, to the time limit', () => {
    expect.soft(f('timing-two-bridges.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reloads itself') });
    expect.soft(f('timing-slow-fetch.html')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*\/login/) });
  });

  it('finds no time limit on pages whose timers do something else, or wait 20 h or more', () => {
    for (const page of ['timing-analytics.html', 'static.html', 'carousel-auto.html']) {
      expect(f(page), page).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') });
    }
    expect(f('timing-long.html').detail).toContain('1 of 20 h or more exempt');
  });

  it('gives no clean result when a timer opened a popup the guard closed', () => {
    expect(f('timing-popup.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('opened a new window') });
  });

  it('gives no clean result when the guard stopped a request to the site, or the page hangs', () => {
    expect(f('timing-logout-post.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('POST request') });
    expect(runs['timing-hang.html']![0]).toMatchObject({ status: 'timeout' });
    expect(f('timing-hang.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('timed out') });
  });
});

describe('timing-watch probe (2.2.1, deep)', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([timingWatchProbe], ['timing-meta.html', 'timing-countdown.html', 'static.html', 'timing-session.html'], { concurrency: 4 });
  }, 120_000);
  const f = (page: string) => only(runs[page]![0]!);

  it('fails a meta refresh and a countdown redirect made of short timers', () => {
    expect(f('timing-meta.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reloads itself within 20 s') });
    expect(f('timing-countdown.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('static.html') });
  });

  it('finds nothing on pages without a limit in 20 s', () => {
    for (const page of ['static.html', 'timing-session.html']) expect(f(page), page).toMatchObject({ status: 'no_failures_found' });
  });
});
