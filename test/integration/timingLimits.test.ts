// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.1, the core timing test: a FAILED has to show a time limit on what the visitor is doing that cannot be turned
// off, adjusted or extended (batch 17, 2026-11-12, the lead's precision audit). Real Chromium on
// test/fixtures/motion/timing-b17-*.html. Every "RED" page failed 2.2.1 before; the planted pages still do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timingProbe } from '../../src/probes/timing.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, only, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
let runs: Record<string, ProbeRun[]>;
const PAGES = [
  'warning-only', 'rotating-notice', 'keepalive', 'autosave', 'frame-save', 'refresh-setting', 'refresh-select', 'refresh-adjust', 'auction',
  'extend-then-expired', 'warning-stay-connected', 'warning-then-logout', 'expired-inline', 'warning-logout-only', 'refresh-other-setting', 'form-time-up',
  'body-slider', 'bids-page',
].map((n) => `timing-b17-${n}.html`);
beforeAll(async () => {
  site = await motionSite();
  runs = await site.run([timingProbe], PAGES, { concurrency: 2 });
}, 180_000);
afterAll(async () => { await site?.close(); });
const f = (name: string) => only(runs[`timing-b17-${name}.html`]![0]!);

describe('2.2.1 core: what shows no limit on the visitor is not failed', () => {
  it('RED: a notice that the session will expire, and nothing else happening: the warning alone shows no limit', () => {
    expect(f('warning-only')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(/a warning appears when its timers run: ".*Your session will expire in 5 minutes\."; the test saw the warning only, not the limit running out/) });
  });

  it('RED: a rotating notice whose words read like a time limit ("session sign-up expires Friday") is content taking turns', () => {
    expect(f('rotating-notice')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') });
  });

  it('RED: a hidden keep-alive form sent into a hidden frame takes nothing from the visitor', () => {
    expect(f('keepalive')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') });
  });

  it('RED: a draft saved by a submit the page handles itself sends nothing away', () => {
    expect(f('autosave')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') });
  });

  it('RED: the form the visitor fills in, sent into a hidden frame while the page stays: a save or a time limit, not told apart', () => {
    expect(f('frame-save')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(/the page submits a form by itself when its timers run, into a frame or another window; the page stayed as it was, so this may be a draft saved in the background or the end of the time to fill the form in/) });
  });

  it('RED: a page that reloads itself with a check box that turns the reload off (Turn off)', () => {
    expect(f('refresh-setting')).toMatchObject({ status: 'no_failures_found', detail: expect.stringMatching(/the page reloads itself after 60 s\); the page has a setting that turns it off \("Auto-refresh this page"\)/) });
  });

  it('RED: a list of refresh times with "Off" (Turn off), and one that reaches ten times the limit (Adjust)', () => {
    expect(f('refresh-select')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('the page has a setting that turns it off ("Refresh every")') });
    expect(f('refresh-adjust')).toMatchObject({ status: 'no_failures_found', detail: expect.stringMatching(/the visitor can set it up to 5 min \("Refresh every"\), at least ten times the limit/) });
  });

  it('RED: an auction that closes for everyone at one moment may be the real-time exception: no verdict', () => {
    expect(f('auction')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(/sends the user to .*static\.html after 10 min.* But the page says "auction": a time limit that is part of a real-time event or essential to the activity is allowed/) });
  });

  it('RED: a warning with "Stay signed in" that the page later replaces with "Your session has expired": the extension was offered', () => {
    expect(f('extend-then-expired')).toMatchObject({ status: 'no_failures_found', detail: expect.stringMatching(/Your session has expired.*; when its timer of 13 min ran the page offered "Stay signed in"/) });
  });

  it('RED: a warning with a button the test does not know ("Stay connected") beside "Log out": not pressed, so no verdict', () => {
    expect(f('warning-stay-connected')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(/sends the user to .*static\.html after 20 min.*The warning has a button \("Stay connected"\) that the test does not press: whether it extends the time limit could not be told/) });
  });
});

describe('2.2.1 core: planted limits still fail', () => {
  it('a warning with no button, then the sign-out two minutes later', () => {
    expect(f('warning-then-logout')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*static\.html after 20 min; a warning appears.*nothing on the page turns this time limit off, adjusts it or extends it/) });
  });

  it('"Your session has expired" put in place of the page, with only a link to sign in again', () => {
    expect(f('expired-inline')).toMatchObject({ status: 'failed', detail: expect.stringContaining('Your session has expired') });
  });

  it('a warning whose only button is "Log out now"', () => {
    expect(f('warning-logout-only')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing on the page turns this time limit off') });
  });

  it('a page that reloads itself beside a check box about something else', () => {
    expect(f('refresh-other-setting')).toMatchObject({ status: 'failed', detail: expect.stringContaining('the page reloads itself after 60 s') });
  });

  it('"Your session has expired" on a page whose theme puts a slider class on the body: still the page\'s own message (only the warning\'s near ancestors say it takes turns)', () => {
    expect(f('body-slider')).toMatchObject({ status: 'failed', detail: expect.stringContaining('Your session has expired') });
  });

  it('a sign-out on a vendor registration form whose menu says "Open bids" and "Property assessments": no sign of a timed activity (only the title, the main heading and the limit\'s own text count)', () => {
    expect(f('bids-page')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/sends the user to .*static\.html after 20 min.*nothing on the page turns this time limit off/) });
  });

  it('the form the visitor fills in, sent by a timer into this window', () => {
    expect(f('form-time-up')).toMatchObject({ status: 'failed', detail: expect.stringContaining('the page submits a form by itself') });
  });

  it('nothing but GET requests reached the server, and no form was sent', () => {
    expect(site.requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
    expect(site.requests.filter((r) => /\/(ping|draft|comment|apply|bid|note)\b/.test(r))).toEqual([]);
  });
});
