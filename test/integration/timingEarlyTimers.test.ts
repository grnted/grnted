// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.1: timers another test already ran early (out/specs/2026-11-08-timing-early-fired-timers.md, round 2:
// out/sol/timing-r1/rulings.md). On the shared motion page the motion test runs every timer of 1 to 20 s
// early before the timing test, so a time limit's warning or redirect is spent before timing looks. When
// any timer was run early there, the runner gives timing a fresh load of the page (`PageProbe.freshAfterFiredTimers`).
// A 15 s time limit shown as a warning in the page, or a redirect it makes after a promise or from a 0 ms
// timer it sets, fails 2.2.1 on the motion page as on its own page. Look-alikes stay clean: harmless
// timers, an adjustable warning, a cookie notice about session cookies a timer changes, a transparent
// "Your session has expired", and a user's click that navigates right after a timer ran early. A timer
// that submits a form into a named iframe after a promise (Sol 7) fails too. A fresh load that cannot be
// had leaves 2.2.1 not testable.
//
// The precondition is checked, not assumed (Sol 11): a probe placed just before timing reads `kit.fired`,
// so each motion-page case proves the motion test (or the click case's user) ran the timer early, which
// also proves it had not fired by itself first (a timer that fired is no longer pending, and `kit.fire`
// records only pending ones). The timers wait 15 s, not the spec's 2.5 s, so the probes before motion
// never race them (the lab keeps 5 s cases).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { motionActuationProbe } from '../../src/probes/actuation.js';
import { audioProbe } from '../../src/probes/audio.js';
import type { Kit } from '../../src/probes/kit.js';
import { MOTION_CONTEXT, kitReady } from '../../src/probes/motionShared.js';
import { motionProbe } from '../../src/probes/motion.js';
import { timingProbe } from '../../src/probes/timing.js';
import type { PageProbe, ProbeFinding, ProbeRun } from '../../src/probes/types.js';
import { motionSite, type MotionSite } from '../helpers/motionProbes.js';

const FAIL = ['timing-early-warning.html', 'timing-early-async.html', 'timing-early-nested.html', 'timing-early-short-warning.html'] as const;
/** Round 2 (Sol 2, 3, 4): warnings the visible-words check and the cookie exception must keep, with the words each finding quotes. */
// Each page's warning is found (its words are in the finding). Batch 17's 2.2.1 audit: it fails only when it says the
// time HAS run out ("has expired") and the page took the visitor's fields away (Sol r1 S1: these pages take none, so
// not testable) and the page is no quiz or exam; a warning that it will run out shows no limit
// running out (not testable), and on a page titled "Quiz" the essential exception may hold (not testable).
const KEEP = [
  ['timing-early-inline.html', 'a word across an inline element ("ex<b>pire</b>")', 'Your session will expire soon.', 'not_testable'],
  ['timing-early-contents.html', 'a warning in a display:contents span', 'Your session has expired', 'not_testable'],
  ['timing-early-fade.html', 'a warning a CSS animation keeps at opacity 0 for 1 s, then fades in', 'Time is up: your session has expired.', 'not_testable'],
  ['timing-early-live.html', 'an expiry message in a live region at opacity 0 (announced)', 'Your session has expired', 'not_testable'],
  ['timing-early-cookie-timed.html', 'a session cookie that "expires in two minutes"', 'Your session cookie expires in two minutes.', 'not_testable'],
] as const;
const CLEAN = ['timing-early-harmless.html', 'timing-early-extend.html', 'timing-early-extend-30s.html', 'timing-early-cookies.html', 'timing-early-transparent.html'] as const;
const CLICK = 'timing-early-click.html';
const SUBMIT = 'timing-early-iframe-submit.html';
const PAGES = [...FAIL, ...KEEP.map((k) => k[0]), ...CLEAN, SUBMIT];

interface Before { fired: { handle: number; delay: number }[]; at: number }
/** Reads (only) what timers were run early on the page so far: the precondition, just before timing. */
const firedBefore: PageProbe = {
  id: 'fired-before-timing', criteria: [], kind: 'interaction', tier: 'core', timeoutMs: 5000, contextOptions: MOTION_CONTEXT,
  async run(ctx) {
    await kitReady(ctx.page);
    ctx.setData?.(await ctx.page.evaluate(() => {
      const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
      return { fired: kit.fired.slice(), at: Math.round(performance.now()) };
    }, undefined));
    return [];
  },
};
/** A user on the click page: runs the 25 s timer early, then clicks Help (a navigation) in the same moment. */
const userClick: PageProbe = {
  id: 'user-click', criteria: [], kind: 'interaction', tier: 'core', timeoutMs: 5000, contextOptions: MOTION_CONTEXT,
  async run(ctx) {
    await kitReady(ctx.page);
    ctx.setData?.(await ctx.page.evaluate(() => {
      const kit = (window as unknown as { __grntedKit: Kit }).__grntedKit;
      kit.trap(true);
      const t0 = performance.now();
      for (const p of kit.pending()) kit.fire(p.handle);
      (document.getElementById('help') as HTMLButtonElement).click();
      const ms = performance.now() - t0;
      const navs = kit.navs.map((n) => n.url);
      kit.trap(false);
      return { ms, navs };
    }, undefined));
    return [];
  },
};
/** The core probes that share the motion page, in the registry's order (timing last), and the precondition. */
const MOTION_PAGE = [audioProbe, motionProbe, motionActuationProbe, firedBefore, timingProbe];

let site: MotionSite;
let own: Record<string, ProbeRun[]>;
let shared: Record<string, ProbeRun[]>;
let click: Record<string, ProbeRun[]>;
beforeAll(async () => {
  site = await motionSite();
  own = await site.run([timingProbe], [...PAGES, CLICK], { concurrency: 3 });
  shared = await site.run(MOTION_PAGE, PAGES, { concurrency: 3 });
  click = await site.run([audioProbe, motionProbe, motionActuationProbe, userClick, firedBefore, timingProbe], [CLICK], { concurrency: 1 });
}, 300_000);
afterAll(async () => { await site?.close(); });

const timing = (runs: Record<string, ProbeRun[]>, page: string): ProbeFinding[] =>
  runs[page]!.find((r) => r.probe === 'timing')!.findings.filter((f) => f.criterion === '2.2.1');
const before = (runs: Record<string, ProbeRun[]>, page: string): Before => runs[page]!.find((r) => r.probe === 'fired-before-timing')!.data as Before;

describe('precondition: on the motion page the timers were run early before timing ran', () => {
  it.each([...FAIL, ...KEEP.map((k) => k[0]), ...CLEAN.filter((p) => p !== 'timing-early-extend-30s.html'), SUBMIT])('%s: the motion test ran its 15 s timer early', (page) => {
    const b = before(shared, page);
    expect(b.fired.some((f) => f.delay === 15000), JSON.stringify(b)).toBe(true);
  });
  it('the 30 s warning is beyond the motion test (20 s): nothing was run early', () => {
    expect(before(shared, 'timing-early-extend-30s.html').fired).toEqual([]);
  });
  it('the click page: the user ran the 25 s timer early and clicked Help within 250 ms', () => {
    const b = before(click, CLICK);
    expect(b.fired.some((f) => f.delay === 25000), JSON.stringify(b)).toBe(true);
    const u = click[CLICK]!.find((r) => r.probe === 'user-click')!.data as { ms: number; navs: string[] };
    expect(u.ms).toBeLessThan(250);
    expect(u.navs.some((n) => n.endsWith('/help.html')), JSON.stringify(u)).toBe(true);
  });
});

describe.each([['on its own page', () => own], ['on the motion page (the motion test runs the timers first)', () => shared]] as const)('2.2.1, timers run early, %s', (_where, runs) => {
  it('a 15 s "Your session has expired" in the page that takes no field away: found, not testable (Sol r1 S1)', () => {
    const found = timing(runs(), 'timing-early-warning.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('Your session has expired') })]);
  });

  it('a 15 s timer that redirects after a promise fails', () => {
    const found = timing(runs(), 'timing-early-async.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^the page sends the user to .*\/logged-out\.html /) })]);
  });

  it.each(KEEP.map((k) => [k[1], k[0], k[2], k[3]] as const))('finds the warning in %s', (_what, page, words, status) => {
    const found = timing(runs(), page);
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status, detail: expect.stringContaining(words) })]);
  });

  it('a 15 s timer whose warning comes from an 800 ms timer it sets is found (not testable: no field taken away, Sol r1 S1)', () => {
    const found = timing(runs(), 'timing-early-short-warning.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('Your session has expired') })]);
  });

  it('a 15 s timer that redirects from a 0 ms timer it sets fails', () => {
    const found = timing(runs(), 'timing-early-nested.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringMatching(/^the page sends the user to .*\/logged-out\.html /) })]);
  });

  it('harmless timers (a notice, a tip after a promise, a 0 ms hash change) find no time limit', () => {
    const found = timing(runs(), 'timing-early-harmless.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') })]);
  });

  it('a warning with "Stay signed in" (after 15 s or after 30 s) gives no failure', () => {
    for (const page of ['timing-early-extend.html', 'timing-early-extend-30s.html']) {
      const found = timing(runs(), page);
      expect.soft(found, `${page}: ${JSON.stringify(found)}`).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('"Stay signed in"') })]);
    }
  });

  it('a cookie notice about session cookies that expire when the browser closes, changed or shown by a timer, is not a time limit (Sol 3)', () => {
    const found = timing(runs(), 'timing-early-cookies.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') })]);
  });

  it('a "Your session has expired" a timer adds fully transparent is never shown, so not a time limit (Sol 4)', () => {
    const found = timing(runs(), 'timing-early-transparent.html');
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') })]);
  });

  it('a 15 s timer that submits a form into a named iframe after a promise is seen (Sol 7: timing runs the timer itself, so the call is in its window)', () => {
    const found = timing(runs(), SUBMIT);
    // Batch 17: the page stays as it was (the form goes into a frame), which a draft saved in the background does
    // too: seen and named, not failed.
    expect(found, JSON.stringify(found)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringMatching(/the page submits a form by itself .*, into a frame or another window; the page stayed as it was/) })]);
  });
});

describe('a form a timer submits into a named iframe is never sent (round 2, Sol 1)', () => {
  it('the fixture server never gets the submission, on its own page or on the motion page', () => {
    expect(site.requests.filter((r) => r.includes('quiz-result'))).toEqual([]);
  });
});

describe('the fresh load, when it cannot be had, leaves 2.2.1 not testable (never clean)', () => {
  const second = async (opts: Parameters<typeof motionSite>[0]): Promise<ProbeRun[]> => {
    const s = await motionSite(opts);
    try {
      return (await s.run(MOTION_PAGE, ['timing-early-warning.html'], { concurrency: 1 }))['timing-early-warning.html']!;
    } finally {
      await s.close();
    }
  };

  it('a second load that never comes within the time box: timed out', async () => {
    let n = 0;
    const runs = await second({ delayMs: (path) => (path.endsWith('timing-early-warning.html') && ++n > 1 ? 25_000 : 0) });
    const t = runs.find((r) => r.probe === 'timing')!;
    expect(t.status, JSON.stringify(t)).toBe('timeout');
    expect(t.findings).toEqual([expect.objectContaining({ criterion: '2.2.1', status: 'not_testable', detail: expect.stringMatching(/^timed out after 10 s \(loaded again for this test, because an earlier test on this page had already run its timers early\)$/) })]);
    expect(t.ms).toBeLessThan(12_000);
  }, 120_000);

  it('a slow second load (about 7.6 s) leaves no time for an 800 ms warning the timer starts: not testable, never clean (Sol 5)', async () => {
    let n = 0;
    const s = await motionSite({ delayMs: (path) => (path.endsWith('timing-early-short-warning.html') && ++n > 1 ? 6600 : 0) });
    try {
      const runs = (await s.run(MOTION_PAGE, ['timing-early-short-warning.html'], { concurrency: 1 }))['timing-early-short-warning.html']!;
      const t = runs.find((r) => r.probe === 'timing')!;
      expect(t.findings, JSON.stringify(t)).toEqual([expect.objectContaining({ criterion: '2.2.1', status: 'not_testable', detail: expect.stringContaining('the time for this test ran out while the page still had work its timers started (1 short timer)') })]);
      expect(t.ms).toBeLessThan(10_500);
    } finally {
      await s.close();
    }
  }, 120_000);

  it('a second load that fails: not testable with the load\'s reason', async () => {
    let contexts = 0;
    const runs = await second({
      onPage: (page) => {
        if (++contexts < 2) return;
        page.goto = (() => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'))) as typeof page.goto;
      },
    });
    const t = runs.find((r) => r.probe === 'timing')!;
    expect(t.findings, JSON.stringify(t)).toEqual([expect.objectContaining({ criterion: '2.2.1', status: 'not_testable', detail: expect.stringMatching(/^the page did not load for this test: .*ERR_CONNECTION_REFUSED.* \(loaded again for this test, because an earlier test on this page had already run its timers early\)$/) })]);
  }, 120_000);
});

describe('a user click that navigates within 250 ms of a timer run early (Sol 1)', () => {
  it('is not a time limit, on its own page or after the user', () => {
    for (const [where, runs] of [['own', own], ['after the user', click]] as const) {
      const found = timing(runs, CLICK);
      expect.soft(found, `${where}: ${JSON.stringify(found)}`).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('no time limit found') })]);
    }
  });
});
