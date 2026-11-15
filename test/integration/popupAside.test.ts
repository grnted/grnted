// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page-load pop-ups (src/probes/popupAside.ts, lead rulings round 9) in real Chromium. Look 1 discovers
// the single box and its dismissal without measuring contrast or reflow. Look 2 measures the cleared page.
// A pop-up that cannot be closed, or a second look that cannot finish, leaves the page not testable.
// Fixture: test/fixtures/popup-aside/ (synthetic).
// "Sol rN n": the input of Sol's review popup-rN, finding n (out/sol/popup-rN/result.md).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formFieldsProbe } from '../../src/probes/forms.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { findPagePopup } from '../../src/probes/popupAside.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { defaultAxeSource } from '../../src/scan.js';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, Finding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS: { userAgent: string; axeSource?: string } = { userAgent: 'grnted-test' };

beforeAll(async () => {
  server = await startFixtureServer('popup-aside');
  browser = await chromium.launch();
  // As a scan does: text contrast's look 2 runs axe's color-contrast rule again on the cleared page.
  OPTS.axeSource = await defaultAxeSource();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** axe's undecided color-contrast results for these targets (the probe measures only these). */
const undecided = (targets: string[]): Finding[] => [{
  id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
  nodes: targets.map((target) => ({ target, html: '<p>', viewports: ['desktop'], failureSummary: "Element's background color could not be determined because it's overlapped by another element" })),
}];
const TEXTS = ['#p1', '#band'];
const runOn = async (probes: PageProbe[], path: string, incomplete?: Finding[], opts = OPTS): Promise<ProbeRun[]> =>
  runProbes(B(), [{ url: `${server.origin}${path}`, index: 0, ...(incomplete ? { incomplete } : {}) }], probes, opts);
const one = async (probe: PageProbe, path: string, incomplete?: Finding[], opts = OPTS) => (await runOn([probe], path, incomplete, opts))[0]!;
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed').map((f) => f.target ?? '');
const statuses = (r: ProbeRun) => r.findings.map((f) => f.status);
const popupData = (r: ProbeRun) => (r.data as { popup?: { setAside: boolean; by?: string; why?: string } } | undefined)?.popup;
/** A finished run with no not_testable finding (a time-out or an unmeasured page is never a pass). */
const finished = (r: ProbeRun, label = '') => {
  expect(r.status, label).toBe('ok');
  expect(r.findings.filter((f) => f.status === 'not_testable'), label).toEqual([]);
};
/** Rule 5: a pop-up that stayed (or a second look that never ran): the rest of the page is not testable, never clean, and nothing outside the pop-up fails. */
const incompleteRun = (r: ProbeRun, label = '', notFailing: string[] = [], why: RegExp = /a pop-up covered the page and could not be closed/) => {
  expect(r.status, label).toBe('ok');
  expect(popupData(r)?.setAside ?? false, label).toBe(false);
  expect(r.findings.filter((f) => f.status === 'not_testable').map((f) => f.detail), label).toEqual([expect.stringMatching(why)]);
  expect(statuses(r).filter((s) => s === 'no_failures_found' || s === 'not_applicable'), label).toEqual([]);
  for (const t of notFailing) expect(failed(r), label).not.toContain(t);
};
/** A finished run that proved the dismissal (`by`: how). */
const setAside = (r: ProbeRun, label = '', by?: RegExp) => {
  finished(r, label);
  expect(popupData(r), label).toMatchObject({ setAside: true, ...(by ? { by: expect.stringMatching(by) } : {}) });
};
const textOn = (path: string, opts = OPTS) => one(textContrastProbe, path, undecided(TEXTS), opts);

describe('text contrast (1.4.3) with a page-load pop-up', () => {
  it('a pop-up closed by keyboard is set aside: the page it dimmed passes (a dialog, and a lightbox over a backdrop)', async () => {
    for (const q of ['', '&lb=1']) {
      const r = await textOn(`/?mode=button${q}`);
      setAside(r, q, /^Enter on/);
      expect(failed(r), q).toEqual([]);
    }
  }, 90_000);

  it('the page’s own low-contrast text still fails after dismissal (look 2)', async () => {
    const page = await textOn('/?mode=button&lowpage=1&lb=1');
    setAside(page);
    expect(failed(page)).toEqual(['#p1']);
  }, 60_000);

  it('Escape closes it when its Close takes only a pointer; an Escape that goes to another page is no dismissal (Sol r1 10)', async () => {
    const esc = await textOn('/?mode=escape');
    setAside(esc, 'escape', /^Escape/);
    expect(failed(esc)).toEqual([]);
    incompleteRun(await textOn('/?mode=escnav'), 'escnav', ['#band', '#p1']);
  }, 90_000);

  it('a Close the Tab key never reaches is not pressed: a focus trap that leaves it out keeps the pop-up (Sol r1 4)', async () => {
    incompleteRun(await textOn('/?mode=trap'), 'trap', ['#band', '#p1']);
  }, 60_000);

  it('a request made when Close gets focus means the pop-up stays (Sol r1 3)', async () => {
    const r = await textOn('/?mode=focuspost');
    expect(popupData(r)).toMatchObject({ setAside: false, why: expect.stringMatching(/sends a request|loads a page/) });
    incompleteRun(r, 'focuspost', ['#band', '#p1']);
  }, 60_000);

  it('a Close inside an open shadow root, or named only by aria-labelledby, sets it aside (Sol r1 11)', async () => {
    for (const mode of ['shadow', 'labelledby']) {
      const r = await textOn(`/?mode=${mode}`);
      setAside(r, mode, /^Enter on “Close”/);
      expect(failed(r), mode).toEqual([]);
    }
  }, 90_000);

  it('a pop-up only a pointer closes, or with nothing but Escape to try, stays: the page under it is not testable, never failed (Sol r2 1)', async () => {
    for (const mode of ['pointer', 'none']) incompleteRun(await textOn(`/?mode=${mode}`), mode, ['#band', '#p1']);
  }, 90_000);

  it('a javascript: or "#" close link is never pressed, and a close that changes the address is not a dismissal', async () => {
    for (const mode of ['js', 'hash', 'push']) incompleteRun(await textOn(`/?mode=${mode}`), mode, ['#band', '#p1']);
  }, 120_000);

  it('no look-1 failure stands when look 2 hangs (Sol r3 1, round-8 cut)', async () => {
    const own = await one({ ...textContrastProbe, timeoutMs: 15_000 }, '/?mode=button&own=1&hang=1&pe=1', undecided(TEXTS));
    expect(own.status).toBe('timeout');
    expect(failed(own)).toEqual([]);
  }, 120_000);
});

describe('text contrast\'s look 2 discovers afresh (Sol r2 6, r3 9, r3 10)', () => {
  it('runs axe again: text revealed by the dismissal is measured, also when look 1 had only the pop-up\'s text', async () => {
    for (const list of [['#pop-text'], TEXTS, []]) {
      const r = await one(textContrastProbe, '/?mode=button&reveal=1', undecided(list));
      setAside(r, String(list.length));
      expect(failed(r), String(list.length)).toEqual(['#revealed']);
    }
  }, 120_000);

  it('finds the text of a frame the dismissal revealed', async () => {
    const r = await one(textContrastProbe, '/?mode=button&revealframe=1', undecided(['#pop-text']));
    setAside(r);
    expect(failed(r)).toEqual([expect.stringMatching(/framed/)]);
  }, 60_000);

  it('a look 2 that cannot run axe is not testable, never clean, and never measures the old list again', async () => {
    const r = await one(textContrastProbe, '/?mode=button&own=1&reveal=1&nobg=1', undecided(TEXTS), { userAgent: 'grnted-test' });
    expect(r.status).toBe('ok');
    expect(failed(r)).toEqual([]);
    expect(r.findings.filter((f) => f.status === 'not_testable').map((f) => f.detail)).toEqual([expect.stringMatching(/^the second look did not finish/)]);
  }, 60_000);
});

describe('non-text contrast (1.4.11) with a page-load pop-up', () => {
  it('the page\'s field dimmed by the pop-up passes once the pop-up is set aside', async () => {
    const r = await one(nonTextContrastProbe, '/?mode=button');
    setAside(r);
    expect(failed(r)).toEqual([]);
  }, 60_000);

  it('the page\'s own low-contrast field still fails behind the pop-up, also when the pop-up made the page inert', async () => {
    for (const q of ['', '&inert=1']) {
      const r = await one(nonTextContrastProbe, `/?mode=button&lowpage=1${q}`);
      setAside(r, q);
      expect(failed(r), q).toEqual(['#page-q']);
    }
  }, 90_000);

  it('a page field under a pop-up\'s decoration never fails on the decoration\'s pixels (Sol r2 1)', async () => {
    incompleteRun(await one(nonTextContrastProbe, '/?mode=pointer&opaque=1&deco=1'), 'deco', ['#page-email']);
  }, 60_000);

  it('a field under an opaque backdrop is measured behind it once set aside, and is never clean while it stays (Sol r1 8)', async () => {
    const behind = await one(nonTextContrastProbe, '/?mode=button&opaque=1&lowpage=1');
    setAside(behind);
    expect(failed(behind)).toEqual(['#page-q']);
    incompleteRun(await one(nonTextContrastProbe, '/?mode=pointer&opaque=1&lowpage=1'), 'stays', ['#page-q']);
  }, 90_000);

  it('a nonqualifying box under the pop-up is measured in look 2 (Sol r2 5)', async () => {
    const r = await one(nonTextContrastProbe, '/?mode=button&two=1&stack=1');
    setAside(r);
    expect(failed(r)).toEqual(['#pop2-email']);
  }, 60_000);

  it('the known limit: content outside the single pop-up that its dismissal removes is never measured (Sol r1 6, with or without a Close of its own; Sol r2 4)', async () => {
    for (const q of ['&two=1', '&two=1&rel=1']) {
      const r = await one(nonTextContrastProbe, `/?mode=button${q}`);
      setAside(r, q);
      expect(failed(r), q).toEqual([]);
    }
  }, 90_000);

  it('a dialog nothing can close by keyboard is not a qualifying pop-up: the page is measured as it always was (Sol r2 3)', async () => {
    const r = await one(nonTextContrastProbe, '/?mode=pointeronly&opaque=1&lowpage=1');
    expect(r.status).toBe('ok');
    expect(popupData(r)).toBeUndefined();
  }, 60_000);

  it('with too little time left for look 2, the result is not testable, never clean (Sol r3 11)', async () => {
    const r = await one({ ...nonTextContrastProbe, timeoutMs: 7000 }, '/?mode=button&lowpage=1');
    incompleteRun(r, 'time', ['#page-q'], /^the second look did not finish/);
  }, 60_000);

  it('a layer that paints nothing over a failing field, on a page with no pop-up, never hides the failure (Sol r3 5)', async () => {
    const r = await one(nonTextContrastProbe, '/?nopop=1&lowpage=1&ghost=1');
    expect(popupData(r)).toBeUndefined();
    expect(failed(r)).toEqual(['#page-q']);
  }, 60_000);
});

describe('reflow (1.4.10) with a page-load pop-up', () => {
  it('a lightbox drawn over the header at 320 px is never an overlap: not testable while it stays, clean once set aside', async () => {
    incompleteRun(await one(reflowProbe, '/?mode=pointer&lb=1'), 'stays');
    for (const q of ['', '&lb=1']) {
      const r = await one(reflowProbe, `/?mode=button${q}`);
      setAside(r, q);
      expect(failed(r), q).toEqual([]);
    }
  }, 90_000);

  it('look 2 retains the page’s overlaps up to the reporting cap (Sol r1 7)', async () => {
    const r = await one(reflowProbe, '/?mode=button&many=1&nobg=1');
    setAside(r);
    const out = r.findings.filter((f) => f.status === 'failed');
    expect(out).toHaveLength(8);
    expect(out.every((f) => /text overlaps other text: “Branch news item/.test(f.detail ?? ''))).toBe(true);
  }, 60_000);

  it('a clean first look still gets the second: a section the pop-up hid is measured behind it (Sol r1 9)', async () => {
    const r = await one(reflowProbe, '/?mode=button&hidden=1');
    setAside(r);
    expect(r.findings.filter((f) => f.status === 'failed').map((f) => f.detail)).toEqual([expect.stringContaining('Opening hours for every branch')]);
  }, 60_000);

  it('a page with more text than the test reads is never clean or not applicable, pop-up or not (Sol r2 8, r3 8 A and B)', async () => {
    for (const q of ['?mode=button&own=1&big=1', '?nopop=1&big=1', '?mode=button&bighidden=1', '?nopop=1&bighidden=1']) {
      const r = await one(reflowProbe, `/${q}`);
      expect(r.status, q).toBe('ok');
      expect(statuses(r).some((s) => s === 'failed' || s === 'not_testable'), q).toBe(true);
      expect(statuses(r).filter((s) => s === 'no_failures_found' || s === 'not_applicable'), q).toEqual([]);
    }
  }, 120_000);

  it('no pop-up failure is retained when the second look hangs (Sol r1 13, round-8 cut)', async () => {
    const r = await one({ ...reflowProbe, timeoutMs: 15_000 }, '/?mode=button&own=1&hang=1&nobg=1');
    expect(r.status).toBe('timeout');
    expect(failed(r)).toEqual([]);
  }, 60_000);

  it('a page line that does not fit, under a pop-up that cannot be closed, is not testable, not failed (Sol r3 4)', async () => {
    incompleteRun(await one(reflowProbe, '/?mode=pointer&wide=1'), 'pointer');
    // Closed, the same line fails in look 2.
    const r = await one(reflowProbe, '/?mode=button&wide=1');
    setAside(r);
    expect(r.findings.filter((f) => f.status === 'failed').map((f) => f.detail)).toEqual([expect.stringContaining('Every branch lends laptops')]);
  }, 90_000);
});

describe('form fields are judged as one page, with or without a pop-up (Sol r1 1, 5: the aside is not used)', () => {
  it('a log-in dialog with a sum to solve is not a 3.3.8 failure when the page offers a plain log-in (Sol r1 1)', async () => {
    const r = await one(formFieldsProbe, '/forms-login.html');
    expect(r.status).toBe('ok');
    expect(r.findings.filter((f) => f.criterion === '3.3.8' && f.status === 'failed')).toEqual([]);
  }, 60_000);

  it('a sign-up frame inside a dialog keeps its 1.3.5 failure (Sol r1 5)', async () => {
    const r = await one(formFieldsProbe, '/forms-frame.html');
    expect(r.status).toBe('ok');
    expect(r.findings.filter((f) => f.criterion === '1.3.5' && f.status === 'failed').map((f) => f.target)).toEqual([expect.stringMatching(/^Email address .*embedded frame/)]);
  }, 60_000);
});

describe('what counts as a page-load pop-up', () => {
  it('a modal-like box with a close control proveDismiss would try, or a modal; never the page itself (Sol r1 12, r2 9, r3 13)', async () => {
    const got = new Map<string, unknown>();
    const CASES = ['wall', 'pane', 'menu', 'main', 'chat', 'over', 'notice', 'submit', 'hash', 'privacy', 'onlyh1', 'mainself', 'shellpop', 'shadowmodal', 'framemodal', 'portal', 'foreign'];
    const other = await startFixtureServer('popup-aside');
    const probe: PageProbe = {
      id: 'find-popup', criteria: ['1.4.10'], kind: 'render', tier: 'core', timeoutMs: 5000, isolate: true,
      async run(ctx) {
        const p = await findPagePopup(ctx);
        got.set(new URL(ctx.url).searchParams.get('case')!, p ? { why: p.why, name: p.name } : null);
        return [];
      },
    };
    await runProbes(B(), CASES.map((c, index) => ({ url: `${server.origin}/cases.html?case=${c}${c === 'foreign' ? `&src=${encodeURIComponent(`${other.origin.replace('127.0.0.1', 'localhost')}/shell.html`)}` : ''}`, index })), [probe], OPTS);
    await other.close();
    expect(Object.fromEntries(got)).toEqual({
      // The page itself (all its text and links, or its main), and boxes with nothing to try that are not modal.
      wall: null, main: null, pane: null, notice: null, mainself: null,
      // Modal: Escape is tried (the proof never presses their unsafe controls).
      submit: { why: 'modal', name: 'Sign up' }, hash: { why: 'modal', name: 'News' }, menu: { why: 'modal', name: 'Menu' },
      chat: { why: 'dialog', name: 'Chat' },
      over: { why: 'backdrop', name: 'Sign up for alerts. No thanks' },
      // A small privacy-links nav, or the page's only h1, inside a consent or newsletter modal does not make it the page.
      privacy: { why: 'modal', name: 'Cookies' }, onlyh1: { why: 'modal', name: 'Join our newsletter' },
      // A fixed pop-up inside a full-screen app shell that holds main: the shell is the page, the pop-up is a pop-up.
      shellpop: { why: 'fixed', name: expect.stringContaining('We have updated our terms of service') },
      // Round 5: in an open shadow root, in a same-origin frame (Sol r4 3); inside a wrapper of no size (Sol r4 4); a
      // frame from another site fixed over most of the screen (ruling 3).
      shadowmodal: { why: 'modal', name: 'Alert' }, framemodal: { why: 'modal', name: 'Alert' },
      portal: { why: 'backdrop', name: expect.stringContaining('Our hours change on Monday') },
      foreign: { why: 'frame', name: expect.any(String) },
    });
  }, 60_000);
});

describe('a modal inside a fixed wrapper keeps its Escape (Sol r2 2)', () => {
  it('the wrapper has nothing to try, the modal in it is closed with Escape', async () => {
    const r = await textOn('/?mode=nested');
    setAside(r, 'nested', /^Escape/);
    expect(failed(r)).toEqual([]);
  }, 60_000);
});

describe('the page itself is never a pop-up, and the next test gets the page as loaded', () => {
  it('a fixed full-screen app shell with a Skip (or a Close) control and no main is measured as the page', async () => {
    for (const q of ['', '?close=1']) {
      const r = await one(textContrastProbe, `/shell.html${q}`, undecided(['#shell-h1']));
      finished(r, q);
      expect(failed(r), q).toEqual(['#shell-h1']);
      expect(popupData(r), q).toBeUndefined();
    }
  }, 60_000);

  it('after a test touched the pop-up, the next one sees it open again, with focus, inert and scroll as loaded (Sol r1 2)', async () => {
    const seen: unknown[] = [];
    let n = 0;
    const look = (waitFor?: PageProbe['waitFor']): PageProbe => ({
      id: `look-${n++}`, criteria: ['1.4.10'], kind: 'render', tier: 'core', timeoutMs: 5000,
      ...(waitFor ? { waitFor } : {}),
      async run(ctx) {
        seen.push(await ctx.page.evaluate(() => ({
          pop: !!document.getElementById('pop'), focus: document.activeElement?.id ?? '', inert: document.getElementById('page')!.hasAttribute('inert'),
          hidden: document.getElementById('page')!.getAttribute('aria-hidden'), sy: scrollY, key: '__grntedPopup' in window,
        }), undefined));
        return [];
      },
    });
    // Reflow waits for content; its observer must wait with it to run after reflow, not before it. Since batch 15b
    // (the visual lane) text contrast and non-text contrast wait for content too, and so do their observers.
    const runs = await runOn([look(), nonTextContrastProbe, look(nonTextContrastProbe.waitFor), textContrastProbe, look(textContrastProbe.waitFor), reflowProbe, look(reflowProbe.waitFor)], '/?mode=button&inert=1&lb=1', undecided(TEXTS));
    expect(runs.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const first = { pop: true, focus: 'accept', inert: true, hidden: 'true', sy: 0, key: false };
    expect(seen).toEqual([first, first, first, first]);
    // A pop-up that focusing its Close removes, without a key pressed on it: the next test still gets a fresh page (Sol r1 2).
    seen.length = 0;
    const touched = await runOn([look(), textContrastProbe, look(textContrastProbe.waitFor)], '/?mode=focusremove&inert=1', undecided(TEXTS));
    expect(popupData(touched[1]!)?.setAside).toBe(false);
    expect(seen).toEqual([{ ...first, focus: '' }, { ...first, focus: '' }]);
    // A pop-up with no close control is still tried with Escape: the next test gets a fresh page too.
    seen.length = 0;
    await runOn([look(), textContrastProbe, look(textContrastProbe.waitFor)], '/?mode=none&inert=1', undecided(TEXTS));
    expect(seen).toEqual([{ ...first, focus: 'more' }, { ...first, focus: 'more' }]);
  }, 180_000);
});

describe('round 5 (Sol popup-r4)', () => {
  const stacked = undecided(['#low-text', '#up-text']);
  it('two pop-ups keep no look-1 failures and are not dismissed (Sol r4 1, round-6 ruling)', async () => {
    const text = await one(textContrastProbe, '/stacked.html', stacked);
    incompleteRun(text, 'text', ['#low-text'], /more than one pop-up covered the page/);
    expect(popupData(text)).toMatchObject({ setAside: false, why: expect.stringMatching(/more than one pop-up covered the page/) });
    incompleteRun(await one(nonTextContrastProbe, '/stacked.html'), 'non-text', ['#low-field'], /more than one pop-up covered the page/);
  }, 90_000);

  it('membership is judged at the layout measured: a line a script moves out of the pop-up at 320 px is the page\'s there (Sol r4 2)', async () => {
    const r = await one({ ...reflowProbe, timeoutMs: 15_000 }, '/?mode=button&moved=1&hang=1');
    expect(r.status).toBe('timeout');
    expect(r.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, 60_000);

  it('new display:none text is a known limit; fresh undecided text keeps its failing phone viewport (Sol r4 5 A and B, round-6 ruling)', async () => {
    const a = await one(textContrastProbe, '/?mode=button&revealplain=1', undecided(['#pop-text']));
    setAside(a, 'A');
    expect(failed(a)).toEqual([]);
    expect(a.findings.map((f) => f.detail).join(' ')).not.toMatch(/axe decided the contrast of all text/);
    const b = await one(textContrastProbe, '/?mode=button&phone=1', undecided(['#pop-text']));
    setAside(b, 'B');
    expect(b.findings.filter((f) => f.status === 'failed').map((f) => [f.target, f.detail])).toEqual([['#phone', expect.stringMatching(/^Text contrast is [\d.]+:1 at the phone width /)]]);
  }, 90_000);

  it('a second pop-up the dismissal reveals is never closed unmeasured: the rest is not testable, never not applicable or clean (Sol r4 6)', async () => {
    incompleteRun(await one(nonTextContrastProbe, '/?mode=button&second=1'), 'second', ['#second-field']);
  }, 60_000);

  it('a frame axe could not test in look 2 makes it incomplete: not testable, never clean (Sol r4 7)', async () => {
    const r = await one(textContrastProbe, '/?mode=button&manyframes=1', undecided(['#pop-text']));
    expect(r.status).toBe('ok');
    expect(r.findings.map((f) => [f.status, f.detail])).toEqual([['not_testable', expect.stringMatching(/^the second look did not finish/)]]);
  }, 90_000);

  it('a consent box is closed with Reject before Accept is ever pressed (Sol r4 8)', async () => {
    const r = await one(nonTextContrastProbe, '/?mode=consent');
    setAside(r, 'consent', /^Enter on “Reject all”/);
  }, 60_000);
});
