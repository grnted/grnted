// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The keyboard and focus probes (Plan 4 Task 4.1) in real Chromium, over the synthetic fixtures in
// test/fixtures/keyboard/: every planted failure is found with its criterion and evidence, every
// clean control reports no failure, hostile pages end in a result (never a hang or a false clean),
// and nothing but GET requests reaches the server.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyboardDeepProbe, keyboardProbe, keyShortcutsProbe } from '../../src/probes/keyboard/index.js';
import { kitQuiet } from '../../src/probes/keyboard/page.js';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import { settleFrames } from '../../src/probes/frameContext.js';
import type { BrowserLike, ProbeFinding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];
/** Probe time per fixture page (ms), printed at the end. */
const timing: Record<string, number> = {};

beforeAll(async () => {
  // A PDF served at an address that names no file type (a document viewer's), for the frames of fix round 1 (F2).
  server = await startFixtureServer('keyboard', { '/documents/view/12': { type: 'application/pdf', file: 'agenda.pdf' } }, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  // eslint-disable-next-line no-console
  console.log(`keyboard probe time per fixture page (ms): ${JSON.stringify(timing)}`);
});

/**
 * The real browser, except that the page's `nth` call of `method` (counting after the runner's page
 * load) first makes the page start loading another page (the guard holds it), then fails with
 * Playwright's `message`.
 */
function racing(method: 'goto' | 'evaluate', nth: number, message: string): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      return Object.assign(context, {
        async newPage() {
          const page = await newPage();
          const real = { goto: page.goto.bind(page), evaluate: page.evaluate.bind(page) } as Record<string, (...a: unknown[]) => Promise<unknown>>;
          let loaded = false;
          let calls = 0;
          const wrap = (name: 'goto' | 'evaluate') => async (...args: unknown[]) => {
            if (name === 'goto' && !loaded) {
              loaded = true;
              return real.goto!(...args);
            }
            if (name === method && loaded && ++calls === nth) {
              await real.evaluate!(() => { location.href = '/elsewhere.html'; });
              await page.waitForTimeout(100);
              throw new Error(message);
            }
            return real[name]!(...args);
          };
          return Object.assign(page, { goto: wrap('goto'), evaluate: wrap('evaluate') });
        },
      });
    },
  } as unknown as BrowserLike;
}

/** The real browser, with every request decision of the guard delayed by `ms` (a busy machine). */
function slowGuard(ms: number): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const route = context.route.bind(context);
      return Object.assign(context, {
        route(pattern: RegExp, handler: (r: unknown) => unknown) {
          return route(pattern, (r) => { setTimeout(() => { void handler(r); }, ms); });
        },
      });
    },
  } as unknown as BrowserLike;
}

/** The real browser with each page's CPU slowed down `rate` times (Chromium DevTools protocol; test only). */
function throttled(rate: number): BrowserLike {
  return {
    async newContext(o: Parameters<Browser['newContext']>[0]) {
      const context = await browser.newContext(o);
      const newPage = context.newPage.bind(context);
      return Object.assign(context, {
        async newPage() {
          const page = await newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate });
          return page;
        },
      });
    },
  } as unknown as BrowserLike;
}

async function probe(file: string, probes: PageProbe[] = [keyboardProbe], full = false): Promise<ProbeRun[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], probes, { userAgent: 'grnted-test', full });
  for (const r of runs) timing[`${file} ${r.probe}`] = r.ms;
  return runs;
}
async function findings(file: string, probes: PageProbe[] = [keyboardProbe]): Promise<ProbeFinding[]> {
  const runs = await probe(file, probes);
  for (const r of runs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  return runs.flatMap((r) => r.findings);
}
const failed = (list: ProbeFinding[], criterion?: string) => list.filter((f) => f.status === 'failed' && (!criterion || f.criterion === criterion));
const flagged = (list: ProbeFinding[], criterion?: string) => list.filter((f) => f.status === 'flagged' && (!criterion || f.criterion === criterion));
const notTestable = (list: ProbeFinding[], criterion?: string) => list.filter((f) => f.status === 'not_testable' && (!criterion || f.criterion === criterion));
/** No failure and nothing untestable: what a clean control must give. */
const clean = (list: ProbeFinding[], criterion?: string) => {
  expect(failed(list, criterion), JSON.stringify(failed(list, criterion))).toEqual([]);
  expect(notTestable(list, criterion), JSON.stringify(notTestable(list, criterion))).toEqual([]);
};

describe('clean controls', () => {
  it('an ordinary accessible page gives no failure for any criterion', async () => {
    const list = await findings('clean.html', [keyboardProbe, keyShortcutsProbe]);
    clean(list);
    expect(list).toEqual([
      // Every focus indicator on the page is the browser's own ring (exempt from 1.4.11).
      { criterion: '1.4.11', status: 'not_applicable', detail: expect.stringContaining("the browser's own focus ring is exempt") },
      { criterion: '2.1.4', status: 'not_applicable', detail: expect.stringContaining('no keyboard handlers') },
    ]);
  }, 30_000);

  it('a page that puts its content in after it loads (an app shell) is walked once the content is shown', async () => {
    // Walked while it still said "Loading…", the page had nothing to focus: "not applicable", and the link
    // with no focus indicator was never seen.
    const f = await findings('late-app.html');
    expect(f.filter((x) => x.status === 'not_applicable' && /nothing on this page takes keyboard focus/.test(x.detail))).toEqual([]);
    const failed = f.filter((x) => x.status === 'failed');
    expect(failed.map((x) => x.criterion)).toEqual(['2.4.7']);
    expect(failed[0]!.detail).toContain('South path');
  }, 30_000);

  it('look-alike: a page whose content is there and has nothing to focus is "not applicable" at once (no second walk)', async () => {
    const [run] = await probe('no-stops.html');
    expect(run!.status).toBe('ok');
    expect(run!.findings.filter((x) => x.criterion === '2.1.2')).toEqual([{ criterion: '2.1.2', status: 'not_applicable', detail: 'nothing on this page takes keyboard focus' }]);
    expect(run!.ms).toBeLessThan(4000);
  }, 30_000);

  it('worst case for time: 25 focus indicators measured by pixels on a page with many kinds of links', async () => {
    const [run] = await probe('busy.html');
    expect(run!.status).toBe('ok');
    clean(run!.findings);
    // 8 s, plus the 100 ms every stop waits for focus to stay put (about 100 stops; 2026-11-07, Grok round 2).
    expect(run!.ms).toBeLessThan(18_000);
  }, 30_000);

  it('a very long page: no failures, with a note on how many focus stops were checked (F1)', async () => {
    const [core] = await probe('huge.html');
    expect(core!.status).toBe('ok');
    clean(core!.findings);
    // 8 s, plus the 100 ms every stop waits for focus to stay put (about 100 stops).
    expect(core!.ms).toBeLessThan(18_000);
    const note = (run: ProbeRun, c: string) => run.findings.filter((f) => f.criterion === c && f.status === 'no_failures_found').map((f) => f.detail);
    // 1.4.11 too: the one kind of link has a strong ring (measured), with the same coverage note.
    for (const c of ['1.4.11', '2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) {
      // The stops actually followed (a Shift+Tab press can land on the page itself, not a stop).
      expect(note(core!, c), c).toEqual([expect.stringMatching(/^checked 60 focus stops forward and (39|40) backward of 1501 \(300 each way with --full\)$/)]);
    }
    const [deep] = await probe('huge.html', [keyboardDeepProbe], true);
    expect(deep!.status).toBe('ok');
    clean(deep!.findings);
    expect(deep!.findings.filter((f) => f.status === 'not_applicable')).toEqual([]);
    expect(note(deep!, '2.4.7')).toEqual([expect.stringMatching(/^checked 300 focus stops forward and (299|300) backward of 1501$/)]);
  }, 120_000);

  it('walks on after a dialog that closes with Esc, and does not stop in front of it (F1)', async () => {
    const list = await findings('modal-first.html');
    clean(list, '2.1.2');
    expect(failed(list, '2.4.7')).toEqual([expect.objectContaining({ target: '#behind' })]);
  }, 30_000);
});

describe('2.1.1 Keyboard', () => {
  it('fails mouse-only controls and leaves keyboard-usable ones alone', async () => {
    const list = await findings('clickable.html');
    const targets = failed(list, '2.1.1').map((f) => f.target);
    expect(targets).toEqual(expect.arrayContaining(['#tile', '#nohref', '#tabs > li:nth-of-type(1)']));
    expect(targets).toHaveLength(3);
    expect(failed(list, '2.1.1').find((f) => f.target === '#tabs > li:nth-of-type(1)')!.detail).toContain('and 2 more elements like it');
    for (const ok of ['#thumb', '#ok', '.deco']) expect(targets.join(' ')).not.toContain(ok);
  }, 30_000);

  // 2026-11-07 audit: a slideshow's slides (albany), a carousel's loop clone (ltd-transit), a custom element's own button (thprd-parks).
  it('leaves carousel slides, their clones and a custom element\'s shadow button alone, and still fails a click-only control', async () => {
    expect(failed(await findings('clickable-widgets.html'), '2.1.1').map((f) => f.target)).toEqual(['#hours']);
  }, 30_000);

  it('fails a click-only control directly in main: an unrelated link elsewhere in a landmark is not its keyboard equivalent', async () => {
    expect(failed(await findings('clickable-main.html'), '2.1.1')).toEqual([expect.objectContaining({ target: '#hours-toggle' })]);
  }, 30_000);

  it('fails a page where Tab cannot reach any control', async () => {
    const list = await findings('tabblock.html');
    expect(failed(list, '2.1.1')).toEqual([expect.objectContaining({ detail: expect.stringContaining('Tab') })]);
    for (const c of ['2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) expect(notTestable(list, c), c).toHaveLength(1);
  }, 30_000);
});

describe('2.1.2 No keyboard trap', () => {
  it('fails a widget that keeps focus', async () => {
    const list = await findings('trap.html');
    expect(failed(list, '2.1.2')).toEqual([expect.objectContaining({ target: '#widget', detail: expect.stringContaining('"Date picker"') })]);
  }, 30_000);

  // 2026-11-07, simulation lab: the stop is read once focus stays put, not right after Tab.
  it('fails a field that takes focus back 60 ms after Tab', async () => {
    expect(failed(await findings('trap-refocus.html'), '2.1.2')).toEqual([expect.objectContaining({ target: '#trap' })]);
  }, 30_000);

  it('fails a dialog with no way out', async () => {
    const list = await findings('modal-trap.html');
    expect(failed(list, '2.1.2')).toEqual([expect.objectContaining({ target: '#dialog', detail: expect.stringContaining('"Survey"') })]);
    expect(failed(list, '2.1.2')[0]!.detail).toContain('nor pressing "Close"');
  }, 30_000);

  it('accepts a dialog that holds focus but closes with Esc or its Close button', async () => {
    clean(await findings('modal.html'), '2.1.2');
    clean(await findings('modal-close.html'), '2.1.2');
  }, 30_000);

  it('presses only buttons with a dismissive name: other ways out are not tested, never failed (F5)', async () => {
    requests.length = 0;
    // "Accept all" may close it, but is not pressed.
    expect(notTestable(await findings('modal-buttons.html'), '2.1.2')).toEqual([expect.objectContaining({ detail: expect.stringContaining('"Accept all"') })]);
    expect(notTestable(await findings('modal-link.html'), '2.1.2')).toEqual([expect.objectContaining({ detail: expect.stringContaining('follow a link or submit a form') })]);
    const unsafe = await findings('modal-unsafe.html');
    expect(failed(unsafe, '2.1.2')).toEqual([]);
    expect(notTestable(unsafe, '2.1.2')).toHaveLength(1);
    // Reset, submit, image, link and area controls, and a button named OK, were never pressed.
    expect(requests.filter((r) => r.includes('/pressed') || r.includes('/settings') || r.includes('/age'))).toEqual([]);
  }, 60_000);

  it('a dialog closed by a press that also sent a request is not testable (F5)', async () => {
    const list = await findings('modal-ping.html');
    expect(failed(list, '2.1.2')).toEqual([]);
    expect(notTestable(list, '2.1.2')).toEqual([expect.objectContaining({ detail: expect.stringContaining('/closed') })]);
  }, 30_000);

  it('counts the controls outside a trap through shadow roots (F3)', async () => {
    expect(failed(await findings('shadow-trap.html'), '2.1.2')).toEqual([expect.objectContaining({ target: '#widget' })]);
  }, 30_000);

  it('focus held inside a frame is not testable for the traversal criteria (F3)', async () => {
    const list = await findings('frame-trap.html');
    for (const c of ['2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1']) {
      expect(notTestable(list, c).map((f) => f.detail), c).toEqual([expect.stringContaining('frame')]);
    }
  }, 30_000);

  it('is not testable when the way out needs a request the guard stops', async () => {
    const list = await findings('modal-post.html');
    expect(failed(list, '2.1.2')).toEqual([]);
    expect(notTestable(list, '2.1.2')).toEqual([expect.objectContaining({ detail: expect.stringContaining('/notice/seen') })]);
    expect(requests.some((r) => r.includes('/notice/seen'))).toBe(false);
  }, 30_000);

  it('Tab through frames is not a trap', async () => {
    clean(await findings('frames.html'), '2.1.2');
  }, 30_000);

  // 2026-11-10 revised ruling 8: a default button without a form owner cannot submit a form.
  it('fails a formless default button that traps focus', async () => {
    expect(failed(await findings('trap-button-refocus.html'), '2.1.2')).toEqual([expect.objectContaining({ target: '#trap' })]);
  }, 30_000);

  // WCAG 2.1.2: a way out that needs more than Tab, arrows or Esc is allowed when the user is told the method.
  it('accepts a trap that tells its way out (Alt+Q) when that key moves focus out; fails it when the key does nothing', async () => {
    clean(await findings('trap-advised-ok.html'), '2.1.2');
    expect(failed(await findings('trap-advised-broken.html'), '2.1.2')).toEqual([expect.objectContaining({ detail: expect.stringContaining('nor pressing "Alt+q"') })]);
  }, 60_000);

  // Found by the ACT re-measure of this branch: the named key puts focus on the stop after the loop, so no Tab
  // press ever lands on that stop. It was counted as a stop only through a false 3.2.1 failure ("took the focus
  // away", from focus the key had moved earlier); once that false alarm was gone the page read "not testable".
  it('a loop that hands focus on at once, with a named key that puts focus on the stop after it: clean, and every stop counts as reached', async () => {
    const f = await findings('trap-advised-off.html');
    expect(f.filter((x) => x.status === 'failed' || x.status === 'not_testable').map((x) => [x.criterion, x.status, x.detail.slice(0, 60)])).toEqual([]);
  }, 60_000);

  it('the same button inside a form would submit it: not testable, never failed', async () => {
    const list = await findings('trap-button-form.html');
    expect(failed(list, '2.1.2')).toEqual([]);
    expect(notTestable(list, '2.1.2')).toEqual([expect.objectContaining({ detail: expect.stringContaining('submit a form ("Search")') })]);
  }, 30_000);
});

describe('2.1.4 Character key shortcuts', () => {
  it('fails a single-key shortcut that cannot be turned off', async () => {
    const list = await findings('shortcut.html', [keyShortcutsProbe]);
    expect(list).toEqual([expect.objectContaining({ criterion: '2.1.4', status: 'failed', target: 'key "s"' })]);
  }, 30_000);

  it('accepts a shortcut with an off switch, and modifier-key shortcuts', async () => {
    expect(await findings('shortcut-off.html', [keyShortcutsProbe])).toEqual([]);
    expect(await findings('shortcut-modifier.html', [keyShortcutsProbe])).toEqual([]);
    // Navigation from a timer started by a key press is not a shortcut (focusing again does nothing new).
    expect(await findings('timer.html', [keyShortcutsProbe])).toEqual([]);
    // Repeated timer navigation is not testable; the reload checks may stop it before the shortcut
    // probe can distinguish what a key did from what the page did by itself.
    expect(await findings('timer-repeat.html', [keyShortcutsProbe])).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  }, 30_000);

  // 2026-11-09 benchmark review: WCAG 2.1.4's second option is a way to remap the shortcut to use a modifier key.
  it('accepts a shortcut with a setting that moves it onto a modifier key', async () => {
    expect(await findings('shortcut-remap.html', [keyShortcutsProbe])).toEqual([]);
  }, 30_000);

  it('still fails the shortcut when the only setting names a modifier key for something else', async () => {
    expect(await findings('shortcut-remap-unrelated.html', [keyShortcutsProbe])).toEqual([expect.objectContaining({ criterion: '2.1.4', status: 'failed', target: 'key "j"' })]);
  }, 30_000);

  it('is not testable when a key sends a request the guard stops', async () => {
    const list = await findings('shortcut-post.html', [keyShortcutsProbe]);
    expect(list).toEqual([expect.objectContaining({ criterion: '2.1.4', status: 'not_testable', detail: expect.stringContaining('/api/like') })]);
    expect(requests.some((r) => r.includes('/api/like'))).toBe(false);
  }, 30_000);
});

describe('2.4.1 Bypass blocks', () => {
  it('fails a page with nothing to bypass repeated content', async () => {
    expect(failed(await findings('nobypass.html'), '2.4.1')).toHaveLength(1);
  }, 30_000);

  // Batch 19 (precision lane): these pages also have a main landmark and headings (ARIA11, H69: a bypass of their own),
  // so the broken skip link is listed for a person to check (Needs review), never failed; without them it fails
  // (test/integration/b19RealSitePrecision.test.ts, skip-missing.html).
  it('lists a skip link to nowhere and one that does not move focus for review on a page with a main landmark and headings', async () => {
    expect(flagged(await findings('skip-broken.html'), '2.4.1')).toEqual([expect.objectContaining({ target: '#skip', detail: expect.stringContaining('does not exist') })]);
    expect(flagged(await findings('skip-dead.html'), '2.4.1')).toEqual([expect.objectContaining({ target: '#skip', detail: expect.stringContaining('does not move keyboard focus') })]);
    expect(failed(await findings('skip-dead.html'), '2.4.1')).toEqual([]);
  }, 30_000);

  it('accepts a working skip link, and landmarks with headings', async () => {
    clean(await findings('clean.html'), '2.4.1');
    clean(await findings('outline.html'), '2.4.1');
  }, 30_000);

  // W3C ACT cf77f2's passed examples (2026-11-07 audit: 10 false failures).
  it('accepts a skip link with nothing to focus after its target, content that comes first, and a toggle for the navigation', async () => {
    for (const f of ['bypass-skip-end.html', 'bypass-content-first.html', 'bypass-toggle.html']) expect(failed(await findings(f), '2.4.1'), f).toEqual([]);
  }, 60_000);

  // W3C precision lane (2026-11-11): a skip control made as a button (a router owns the fragment) is pressed and counts
  // when it moves the page to its content; it never makes a failure of its own.
  it('accepts a skip button that focuses the content, and a role=button control that sets the fragment', async () => {
    for (const f of ['bypass-skip-button.html', 'bypass-skip-button-hash.html']) {
      const list = await findings(f);
      expect(failed(list, '2.4.1'), f).toEqual([]);
      expect(notTestable(list, '2.4.1'), f).toEqual([]);
    }
  }, 60_000);

  // Fable review F2 and F3: skip links keep their places; a skip-named button is pressed only where it can change 2.4.1, and
  // only when its name names where it goes.
  it('two skip-named buttons ahead of a working skip link: the link is tested and works, the buttons are never pressed', async () => {
    const before = requests.length;
    const list = await findings('bypass-skip-buttons-before-link.html');
    expect(failed(list, '2.4.1')).toEqual([]);
    expect(notTestable(list, '2.4.1')).toEqual([]);
    expect(requests.slice(before).filter((r) => r.includes('/clicked-'))).toEqual([]);
  }, 60_000);

  it('never presses "Skip tour" beside a main landmark, or a "Skip this step" that names no destination (the page still fails)', async () => {
    const before = requests.length;
    clean(await findings('bypass-skip-tour-main.html'), '2.4.1');
    expect(failed(await findings('bypass-skip-this-step.html'), '2.4.1')).toEqual([expect.objectContaining({ detail: expect.stringContaining('No skip link among the first focus stops') })]);
    expect(requests.slice(before).filter((r) => r.includes('/clicked-'))).toEqual([]);
  }, 60_000);

  it('still fails a skip button that does nothing (and says so), never fails a skip-named button beside a main landmark, never presses a submit button in a form', async () => {
    expect(failed(await findings('bypass-skip-button-dead.html'), '2.4.1')).toEqual([expect.objectContaining({ target: '#skip', detail: expect.stringContaining('the button "Skip to main content" was pressed and did not move keyboard focus past the repeated content') })]);
    clean(await findings('bypass-skip-button-other.html'), '2.4.1');
    // A submit button in a form is never pressed and is no skip control (sending a form leaves the page): the page still fails.
    const before = requests.length;
    expect(failed(await findings('bypass-skip-button-form.html'), '2.4.1')).toEqual([expect.objectContaining({ detail: expect.stringContaining('No skip link among the first focus stops') })]);
    expect(requests.slice(before).filter((r) => !r.startsWith('GET '))).toEqual([]);
  }, 60_000);
});

describe('2.4.3 Focus order', () => {
  // 2026-11-10, accuracy round: the steps of one form sit in separate fieldsets, so they were never compared.
  it('fails a positive tabindex that sends focus backwards through the fieldsets of one form (F44)', async () => {
    const list = failed(await findings('order-fieldsets.html'), '2.4.3');
    expect(list).not.toEqual([]);
    expect(list[0]!.detail).toBe('Tab moves focus from "Review my details" (#review) back to "Delivery address, when it differs" (#mail), which comes before it on the page and in the HTML: tabindex="1" on the first puts it out of order.');
  }, 60_000);

  it('look-alikes: tabindex in the order of the form; a form around the whole page with tabindex on its search field', async () => {
    clean(await findings('order-fieldsets-ok.html'), '2.4.3');
    clean(await findings('order-page-form.html'), '2.4.3');
  }, 60_000);

  // Batch 19 (the lead's ruling): focus on hidden off-canvas links fails 2.4.7 (the indicator is not visible); the footer
  // reached before the main content is an order that is wrong, 2.4.3.
  it('fails focus on hidden off-canvas links (2.4.7) and a footer reached before the main content (2.4.3)', async () => {
    const f = await findings('order.html');
    const order = failed(f, '2.4.3');
    expect(order).toEqual([expect.objectContaining({ target: 'main', detail: expect.stringContaining('footer') })]);
    expect(failed(f, '2.4.7')).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: '#drawer', detail: expect.stringContaining('outside the visible page area') }),
    ]));
  }, 30_000);

  it('fails a positive tabindex that sends focus far against the visual order', async () => {
    expect(failed(await findings('tabindex.html'), '2.4.3')).toEqual([expect.objectContaining({ target: '#contact', detail: expect.stringContaining('tabindex') })]);
  }, 30_000);

  it('accepts a search box first and a sidebar after the main column', async () => {
    clean(await findings('tabindex-ok.html'), '2.4.3');
  }, 30_000);

  it('accepts an inline link that wraps across two lines (each line fragment is hit-tested, not their union box)', async () => {
    const list = await findings('wrapped-link.html');
    clean(list, '2.4.3');
    clean(list, '2.4.7');
  }, 30_000);
});

describe('2.4.7 Focus visible', () => {
  it('fails a removed outline and an outline cut off by its parent, measured by pixels', async () => {
    const list = failed(await findings('outline.html'), '2.4.7');
    expect(list.map((f) => f.target).sort()).toEqual(['#bare', '#clipped']);
    expect(list.find((f) => f.target === '#bare')!.detail).toMatch(/0 of \d+ pixels changed/);
  }, 30_000);

  it('accepts a ring on the parent (:focus-within) and a custom checkbox', async () => {
    clean(await findings('focus-within.html'), '2.4.7');
    clean(await findings('clean.html'), '2.4.7');
  }, 30_000);

  it('measures inside shadow roots and after frames and removed elements', async () => {
    expect(failed(await findings('shadow.html'), '2.4.7')).toEqual([expect.objectContaining({ target: expect.stringContaining('#shadow-bare') })]);
    expect(failed(await findings('frames.html'), '2.4.7')).toEqual([expect.objectContaining({ target: '#after-frames' })]);
    const removed = await findings('removed.html');
    expect(failed(removed, '2.4.7')).toEqual([expect.objectContaining({ target: '#end' })]);
  }, 60_000);
});

describe('1.4.11 Focus indicator contrast (Task 4.10)', () => {
  it('fails a thin pale ring, a see-through glow and a dark ring on a dark section; accepts strong, rounded, light-on-dark, fading and browser rings', async () => {
    const list = await findings('focus-contrast.html');
    const f = failed(list, '1.4.11');
    expect(f.map((x) => x.target).sort(), JSON.stringify(f)).toEqual(['#dim', '#glow', '#pale']);
    expect(f.find((x) => x.target === '#pale')!.detail).toMatch(/has a contrast of 1\.\d:1 against the colors next to it \(#dddddd on #ffffff\)/);
    expect(f.find((x) => x.target === '#dim')!.detail).toMatch(/\(#444444 on #222222\)/);
    expect(notTestable(list, '1.4.11')).toEqual([]);
    // Every ring is a visible indicator (2.4.7).
    clean(list, '2.4.7');
  }, 30_000);

  it('accepts rings of 3:1 or more (thin grey, double ring, a ring on a gradient), noting the highlight it does not measure', async () => {
    const list = await findings('focus-contrast-ok.html');
    clean(list, '1.4.11');
    expect(list.filter((f) => f.criterion === '1.4.11')).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('1 focus indicator was not measured') })]);
    clean(await findings('outline.html'), '1.4.11');
  }, 30_000);

  it('indicators inside the control, drop shadows and a pale ring next to another cue: never failed', async () => {
    const list = await findings('focus-contrast-other.html');
    // Batch 18, round 2: the outline pulled inside the button (white on the button's blue) is an inset ring and is
    // measured (it passes); the other four stay unmeasured and are noted.
    expect(list.filter((f) => f.criterion === '1.4.11')).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('4 focus indicators were not measured') })]);
  }, 30_000);
});

describe('2.4.11 Focus not obscured', () => {
  it('fails links hidden behind a sticky header and a fixed banner', async () => {
    const list = failed(await findings('sticky.html'), '2.4.11');
    expect(list.map((f) => f.detail).join('\n')).toContain('html > body > div');
    expect(list.map((f) => f.detail).join('\n')).toContain('header');
    expect(list).toHaveLength(2);
  }, 30_000);

  it('measures after a smooth scroll ends: no failure when the link ends clear of a fixed header', async () => {
    clean(await findings('smooth.html', [keyboardProbe, keyShortcutsProbe]), '2.4.11');
    clean(await findings('smooth-scroller.html', [keyboardProbe, keyShortcutsProbe]), '2.4.11');
    clean(await findings('smooth-js.html', [keyboardProbe, keyShortcutsProbe]), '2.4.11');
    const [deep] = await probe('smooth-scroller.html', [keyboardDeepProbe], true);
    clean(deep!.findings, '2.4.11');
  }, 60_000);

  it('a page that never stops scrolling: not testable, never failed', async () => {
    const list = await findings('smooth-forever.html');
    expect(failed(list, '2.4.11')).toEqual([]);
    expect(notTestable(list, '2.4.11')).toEqual([expect.objectContaining({ detail: expect.stringContaining('kept scrolling') })]);
  }, 30_000);

  it('still fails a link a fixed header covers after a smooth scroll', async () => {
    expect(failed(await findings('smooth-covered.html'), '2.4.11')).toEqual([expect.objectContaining({ detail: expect.stringContaining('header') })]);
  }, 30_000);

  // 2026-11-10, accuracy round: WCAG 2.4.11 says "author-created content", not only fixed or sticky content.
  it('fails a control entirely under a panel laid over it, and one whose panel opens when it takes focus', async () => {
    expect(failed(await findings('cover-panel.html'), '2.4.11')).toEqual([expect.objectContaining({
      target: '#copy', detail: '"Copy the reference" (#copy) is entirely hidden behind html > body > main > div > div (content laid over it) when it receives keyboard focus.',
    })]);
    expect(failed(await findings('cover-on-focus.html'), '2.4.11')).toEqual([expect.objectContaining({ target: '#pause', detail: expect.stringContaining('entirely hidden behind #help (content laid over it)') })]);
  }, 60_000);

  it('look-alikes: a panel over half the control; a control under its own skin (a styled check box, select or button face)', async () => {
    clean(await findings('cover-panel-half.html'), '2.4.11');
    const skins = await findings('cover-skin.html');
    clean(skins, '2.4.11');
    clean(skins, '2.4.3');
  }, 60_000);

  it('accepts scroll padding that keeps focus clear of them', async () => {
    clean(await findings('sticky-ok.html'), '2.4.11');
  }, 30_000);
});

describe('3.2.1 On focus', () => {
  it('fails navigation, focus taken away, an alert and a new window on focus; not a submenu', async () => {
    requests.length = 0;
    const list = failed(await findings('onfocus.html'), '3.2.1');
    // #logout: a navigation the guard blocks as an action still changes the context (F6).
    expect(list.map((f) => f.target).sort()).toEqual(['#alerter', '#jump', '#logout', '#lost', '#opener']);
    expect(list.find((f) => f.target === '#jump')!.detail).toContain('/clean.html');
    // The page never left: the navigation and the popup were held.
    expect(requests.filter((r) => /clean\.html|popup\.html/.test(r))).toEqual([]);
  }, 30_000);
});

describe('3.2.1 On focus: a dialog that opens when a control takes focus', () => {
  // WCAG's own example of a 3.2.1 failure (Understanding 3.2.1: a help dialog that opens when a field receives focus).
  it('fails a modal dialog opened by focus, closes it, and goes on with the walk behind it', async () => {
    const list = await findings('focus-dialog.html');
    expect(failed(list, '3.2.1')).toEqual([expect.objectContaining({
      target: '#subject',
      detail: 'Moving keyboard focus to "Subject" (#subject) opened a dialog (#guide) and moved keyboard focus into it, without the user activating anything.',
    })]);
    // The link after the field was reached once the dialog was closed.
    expect(failed(list, '2.4.7')).toEqual([expect.objectContaining({ target: '#plain' })]);
    expect(failed(list, '2.1.2')).toEqual([]);
  }, 60_000);

  it('fails a scripted dialog (role="dialog") opened by focus', async () => {
    expect(failed(await findings('focus-dialog-div.html'), '3.2.1')).toEqual([expect.objectContaining({ target: '#stop', detail: expect.stringContaining('opened a dialog (#tip)') })]);
  }, 60_000);

  it('look-alikes: focus guards inside a dialog that was already open; a dialog that opens by itself on a timer', async () => {
    expect(failed(await findings('focus-dialog-guard.html'), '3.2.1')).toEqual([]);
    expect(failed(await findings('focus-dialog-timer.html'), '3.2.1')).toEqual([]);
  }, 60_000);
});

describe('skip links, shadow roots, shortcuts, guarded pages (review round 1)', () => {
  it('a skip link inside a shadow root is activated and is listed for review when it does nothing (F2; the page has a main landmark)', async () => {
    expect(flagged(await findings('skip-shadow.html'), '2.4.1')).toEqual([expect.objectContaining({ detail: expect.stringContaining('does not move keyboard focus') })]);
  }, 30_000);

  it('a skip link that cannot be focused again is not testable, never "working" (F2)', async () => {
    const list = await findings('skip-refocus.html');
    expect(failed(list, '2.4.1')).toEqual([]);
    expect(notTestable(list, '2.4.1')).toEqual([expect.objectContaining({ detail: expect.stringContaining('could not be focused again') })]);
  }, 30_000);

  it('counts focus stops inside shadow roots, and fails mouse-only controls there (F3)', async () => {
    const [deep] = await probe('shadow-many.html', [keyboardDeepProbe], true);
    expect(deep!.status).toBe('ok');
    // The deep walk ran on the shadow-root page. (1.4.11 is not applicable there:
    // every focus indicator is the browser's own ring.)
    expect(deep!.findings.filter((f) => f.status === 'not_applicable')).toEqual([
      { criterion: '1.4.11', status: 'not_applicable', detail: expect.stringContaining("the browser's own focus ring is exempt") },
    ]);
    expect(failed(await findings('shadow.html'), '2.1.1')).toEqual([expect.objectContaining({ target: expect.stringContaining('#shadow-tile') })]);
  }, 60_000);

  it('never types the rest of a batch into a field a key focused (F4)', async () => {
    requests.length = 0;
    expect(await findings('shortcut-type.html', [keyShortcutsProbe])).toEqual([expect.objectContaining({ status: 'failed', target: 'key "/"' })]);
    expect(requests.filter((r) => r.includes('/typed'))).toEqual([]);
  }, 30_000);

  it('a field that takes focus back makes 2.1.4 not testable, and nothing is typed into it (F4)', async () => {
    requests.length = 0;
    expect(await findings('shortcut-sticky.html', [keyShortcutsProbe])).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('text field') })]);
    expect(requests.filter((r) => r.includes('/typed'))).toEqual([]);
  }, 30_000);

  it('a page whose address looks like an action is never loaded again (F6)', async () => {
    requests.length = 0;
    const list = await findings('unsubscribe.html', [keyboardProbe, keyShortcutsProbe]);
    expect(requests.filter((r) => r.startsWith('GET /unsubscribe.html'))).toHaveLength(1);
    expect(notTestable(list, '2.1.4')).toEqual([expect.objectContaining({ detail: expect.stringContaining('looks like an action') })]);
    expect(notTestable(list, '2.4.7')).toEqual([expect.objectContaining({ detail: expect.stringContaining('looks like an action') })]);
  }, 30_000);

  it('a full request log during load: the group is not testable, without measuring failures or applicability (F7)', async () => {
    const runs = await probe('flood.html', [keyboardProbe, keyShortcutsProbe]);
    expect(runs.map((r) => r.status)).toEqual(['error', 'error']);
    const list = runs.flatMap((r) => r.findings);
    expect(failed(list)).toEqual([]);
    for (const c of [...keyboardProbe.criteria, '2.1.4']) expect(notTestable(list, c).length, c).toBeGreaterThan(0);
    expect(list.every((f) => f.status === 'not_testable' && f.detail?.includes('could not finish checking the page load'))).toBe(true);
  }, 30_000);

  it('rings drawn by a pseudo-element or a tall :focus-within card are visible (F9)', async () => {
    clean(await findings('ring-far.html'), '2.4.7');
  }, 30_000);

  it('the walk leaves menus, details and dialogs it opened as they were (F10)', async () => {
    let state: unknown;
    const after: PageProbe = {
      id: 'after', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        state = await ctx.page.evaluate(() => ({
          menu: document.getElementById('menu')!.getAttribute('aria-expanded'),
          details: (document.getElementById('more') as HTMLDetailsElement).open,
          dialog: (document.getElementById('dlg') as HTMLDialogElement).open,
          keep: (document.getElementById('keep') as HTMLDialogElement).open,
        }), undefined);
        return [];
      },
    };
    const runs = await probe('opens.html', [keyboardProbe, after]);
    expect(runs.map((r) => r.status)).toEqual(['ok', 'ok']);
    // The menu ignores Esc: its saved aria-expanded is written back. No Esc is pressed page-wide, so a
    // dialog that was open from the start stays open (7).
    expect(state).toEqual({ menu: 'false', details: false, dialog: false, keep: true });
  }, 30_000);

  it('stopping the page\'s timers before a reload reaches timers of any age (F10)', async () => {
    let left = -1;
    const quiet: PageProbe = {
      id: 'quiet', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 10_000,
      async run(ctx) {
        await ctx.page.evaluate(() => {
          const w = window as unknown as { ticks: number };
          w.ticks = 0;
          setInterval(() => { w.ticks++; }, 5);
          for (let i = 0; i < 30_000; i++) setTimeout(() => {}, 1e9);
        }, undefined);
        await ctx.page.evaluate(kitQuiet, undefined);
        const t0 = await ctx.page.evaluate(() => (window as unknown as { ticks: number }).ticks, undefined);
        await ctx.page.waitForTimeout(100);
        left = (await ctx.page.evaluate(() => (window as unknown as { ticks: number }).ticks, undefined)) - t0;
        return [];
      },
    };
    await probe('clean.html', [quiet]);
    expect(left).toBe(0);
  }, 30_000);
});

describe('review round 2', () => {
  // 2026-11-10, accuracy round: after a focus loop the page is loaded again for the Shift+Tab walk, and its stops
  // got the same ids as the first walk's, so everything measured on them was dropped.
  it('what the Shift+Tab walk measures after a focus loop made the test load the page again still counts', async () => {
    const list = await findings('trap-then-footer.html');
    expect(failed(list, '2.1.2')).toEqual([expect.objectContaining({ target: '#widget' })]);
    expect(failed(list, '2.4.7')).toEqual([expect.objectContaining({ target: '#top-link', detail: expect.stringContaining('No visible focus indicator on "Back to top"') })]);
  }, 60_000);

  it('a trap that only the Shift+Tab walk reaches is found (1)', async () => {
    expect(failed(await findings('trap-late.html'), '2.1.2')).toEqual([expect.objectContaining({ target: '#widget' })]);
  }, 30_000);

  it('a second trap after a dialog closed with Esc is found (1)', async () => {
    expect(failed(await findings('trap-second.html'), '2.1.2')).toEqual([expect.objectContaining({ target: '#widget' })]);
  }, 30_000);

  it('a trap that stops the walk short of the page: the other walk criteria are not testable (1)', async () => {
    const list = await findings('modal-trap.html');
    expect(failed(list, '2.1.2')).toHaveLength(1);
    for (const c of ['2.4.3', '2.4.7', '2.4.11', '3.2.1']) expect(notTestable(list, c).map((f) => f.detail), c).toEqual([expect.stringContaining('focus loop')]);
  }, 30_000);

  it('Tab inside a date field, a time field or a player is not a focus loop', async () => {
    const list = await findings('inner-stops.html');
    for (const c of ['2.1.2', '2.4.3', '2.4.11', '3.2.1']) clean(list, c);
    // The walk got through the date field to the link after it.
    expect(failed(list, '2.4.7')).toEqual([expect.objectContaining({ target: '#between' })]);
  }, 30_000);

  it('counts controls outside a trap past any number of light-DOM matches (3)', async () => {
    expect(failed(await findings('shadow-cap.html'), '2.1.2')).toEqual([expect.objectContaining({ target: '#widget' })]);
  }, 30_000);

  it('the coverage note states the stops followed and reaches the criteria table (2)', async () => {
    const runs = await probe('huge.html');
    const [row] = probeCriteriaResults(runs).filter((r) => r.criterion === '2.4.7');
    expect(row!.method).toMatchObject({ status: 'no_failures_found', note: expect.stringMatching(/^checked 60 focus stops forward and (39|40) backward of 1501 \(300 each way with --full\)$/) });
  }, 60_000);

  it('presses no button whose name only starts like a dismissive one (4)', async () => {
    requests.length = 0;
    const list = await findings('modal-destructive.html');
    expect(failed(list, '2.1.2')).toEqual([]);
    expect(notTestable(list, '2.1.2')).toHaveLength(1);
    expect(requests.filter((r) => r.includes('/pressed'))).toEqual([]);
  }, 30_000);

  it('a frame document blocked for its address is not a change of context on focus (5)', async () => {
    clean(await findings('lazy-frame.html'), '3.2.1');
  }, 30_000);

  it('a log that fills while the way out is tried: not testable, never failed (6)', async () => {
    const list = await findings('log-fills.html');
    expect(failed(list, '2.1.2')).toEqual([]);
    expect(notTestable(list, '2.1.2').length).toBeGreaterThan(0);
  }, 30_000);

  it('a skip link that works but also sent a request is not testable (8)', async () => {
    const list = await findings('skip-ping.html');
    expect(failed(list, '2.4.1')).toEqual([]);
    expect(notTestable(list, '2.4.1')).toEqual([expect.objectContaining({ detail: expect.stringContaining('/skipped') })]);
  }, 30_000);

  it('stopping the page\'s timers also stops new ones for the rest of the document (7)', async () => {
    let fired = -1;
    const quiet: PageProbe = {
      id: 'quiet', criteria: ['0.0.1'], kind: 'interaction', tier: 'core', timeoutMs: 10_000,
      async run(ctx) {
        await ctx.page.evaluate(kitQuiet, undefined);
        await ctx.page.evaluate(() => {
          const w = window as unknown as { n: number };
          w.n = 0;
          setTimeout(() => { w.n++; }, 0);
          setInterval(() => { w.n++; }, 5);
          requestAnimationFrame(() => { w.n++; });
        }, undefined);
        await ctx.page.waitForTimeout(100);
        fired = await ctx.page.evaluate(() => (window as unknown as { n: number }).n, undefined);
        return [];
      },
    };
    await probe('clean.html', [quiet]);
    expect(fired).toBe(0);
  }, 30_000);
});

describe('hostile pages', () => {
  // A navigation racing a step. Seen once in the full suite under load on timer-repeat.html: the
  // reload in key-shortcuts never finished ("page.goto: Timeout 12673ms exceeded") because the page's
  // own location.href, held by the guard, cancelled it, and the run ended as an error. Injected here
  // at a fixed step, so no load or timing is needed.
  const BY_ITSELF = expect.stringContaining('by itself');
  it('a navigation that breaks a reload gives not_testable "by itself", never an error or a clean result', async () => {
    const goto = (file: string, p: PageProbe) =>
      runProbes(racing('goto', 1, 'page.goto: Timeout 5000ms exceeded.'), [{ url: `${server.origin}/${file}`, index: 0 }], [p], { userAgent: 'grnted-test' });
    // key-shortcuts reloads the page after a batch of keys did something.
    const [keys] = await goto('shortcut.html', keyShortcutsProbe);
    expect(keys).toMatchObject({ status: 'ok', findings: [{ criterion: '2.1.4', status: 'not_testable', detail: BY_ITSELF }] });
    // keyboard reloads after the trap test: the trap stands, what comes after it is not testable.
    const [kb] = await goto('trap.html', keyboardProbe);
    expect(kb!.status).toBe('ok');
    expect(kb!.findings.map((f) => [f.criterion, f.status])).toEqual([
      ['2.1.2', 'failed'], ['1.4.11', 'not_testable'], ['2.4.3', 'not_testable'], ['2.4.7', 'not_testable'], ['2.4.11', 'not_testable'], ['3.2.1', 'not_testable'],
    ]);
    for (const f of kb!.findings.filter((x) => x.status === 'not_testable')) expect(f.detail).toEqual(BY_ITSELF);
  }, 60_000);

  it('a navigation that breaks an in-page step gives not_testable "by itself", never an error or a clean result', async () => {
    for (const [file, p] of [['shortcut.html', keyShortcutsProbe], ['trap.html', keyboardProbe], ['huge.html', keyboardDeepProbe]] as const) {
      const message = 'page.evaluate: Execution context was destroyed, most likely because of a navigation';
      const [run] = await runProbes(racing('evaluate', 12, message), [{ url: `${server.origin}/${file}`, index: 0 }], [p], { userAgent: 'grnted-test', full: true });
      expect(run!.status, `${file} ${p.id}`).toBe('ok');
      expect(run!.findings.map((f) => [f.criterion, f.status]), `${file} ${p.id}`).toEqual(p.criteria.map((c) => [c, 'not_testable']));
      for (const f of run!.findings) expect(f.detail).toEqual(BY_ITSELF);
    }
  }, 60_000);

  it('a page that tries to leave every millisecond: both probes on one page end not_testable "by itself"', async () => {
    // 1 ms timer: fills the guard's log (500 events) and races every reload.
    for (let i = 0; i < 3; i++) {
      const runs = await probe('timer-storm-repeat.html', [keyboardProbe, keyShortcutsProbe]);
      expect(runs.map((r) => r.status), `run ${i}`).toEqual(['ok', 'ok']);
      const list = runs.flatMap((r) => r.findings);
      expect(failed(list), `run ${i}`).toEqual([]);
      for (const c of ['3.2.1', '2.1.4']) expect(notTestable(list, c).map((f) => f.detail), `run ${i} ${c}`).toEqual([expect.stringContaining('by itself')]);
    }
  }, 90_000);

  it('the same page with a slow request guard (300 ms per decision): not_testable "by itself", never clean', async () => {
    // Reproduces the clean result seen once under load: the guard's log of the page's navigation
    // attempts lagged behind every measuring window, so nothing was attributed.
    for (let i = 0; i < 2; i++) {
      const runs = await runProbes(slowGuard(300), [{ url: `${server.origin}/timer-storm-repeat.html`, index: 0 }], [keyboardProbe, keyShortcutsProbe], { userAgent: 'grnted-test' });
      expect(runs.map((r) => r.status), `run ${i}`).toEqual(['ok', 'ok']);
      const list = runs.flatMap((r) => r.findings);
      expect(failed(list), `run ${i}`).toEqual([]);
      for (const c of ['3.2.1', '2.1.4']) expect(notTestable(list, c).map((f) => f.detail), `run ${i} ${c}`).toEqual([expect.stringContaining('by itself')]);
    }
  }, 120_000);

  it('the same page on a slow machine (CPU throttled 6x): still not_testable "by itself", never clean', async () => {
    for (let i = 0; i < 3; i++) {
      const runs = await runProbes(throttled(6), [{ url: `${server.origin}/timer-storm-repeat.html`, index: 0 }], [keyboardProbe, keyShortcutsProbe], { userAgent: 'grnted-test' });
      expect(runs.map((r) => r.status), `run ${i}`).toEqual(['ok', 'ok']);
      const list = runs.flatMap((r) => r.findings);
      expect(failed(list), `run ${i}`).toEqual([]);
      for (const c of ['3.2.1', '2.1.4']) expect(notTestable(list, c).map((f) => f.detail), `run ${i} ${c}: ${JSON.stringify(list.filter((f) => f.criterion === c))}`).toEqual([expect.stringContaining('by itself')]);
    }
  }, 180_000);

  it('a page that hangs on focus times out as not testable, never clean', async () => {
    const quick = { ...keyboardProbe, timeoutMs: 4000 };
    const [run] = await probe('hang.html', [quick]);
    expect(run!.status).toBe('timeout');
    expect(run!.findings.map((f) => f.status)).toEqual(keyboardProbe.criteria.map(() => 'not_testable'));
  }, 60_000);

  it('only GET requests ever reached the server', () => {
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});

describe('2.1.1 inside the page\'s own frames (keyboard-op lane, 2026-11-11)', () => {
  it('fails an element inside a same-site frame that answers the mouse and cannot get focus, named through the frame', async () => {
    const list = await findings('frame-click.html');
    const f = failed(list, '2.1.1');
    expect(f.map((x) => x.target)).toEqual(['#calendar-frame >>> #d9']);
    expect(f[0]!.detail).toBe('Inside the embedded frame “Event calendar”: "9" (#d9) responds to the mouse (click handler) but is not focusable and has no focusable element inside or around it, so it cannot be used with the keyboard (and 2 more elements like it).');
  }, 30_000);

  it('look-alike: the same calendar made of buttons is clean', async () => {
    const list = await findings('frame-buttons.html');
    expect(failed(list, '2.1.1')).toEqual([]);
    expect(notTestable(list, '2.1.1')).toEqual([]);
  }, 30_000);

  it('look-alike: a control outside the frame that points at it may do the same: not testable, never failed', async () => {
    const list = await findings('frame-click-pointed.html');
    expect(failed(list, '2.1.1')).toEqual([]);
    expect(notTestable(list, '2.1.1').map((x) => x.target)).toEqual(['#calendar-frame >>> #d9']);
  }, 30_000);
});

describe('2.1.1 in a frame the page puts in late (keyboard-op lane, 2026-11-11, from the sim lab)', () => {
  it('a frame the request guard does not let load: 2.1.1 not testable for it, never failed or clean', async () => {
    const list = await findings('frame-click-late.html');
    expect(failed(list, '2.1.1')).toEqual([]);
    expect(notTestable(list, '2.1.1').map((x) => [x.target, x.detail.includes('the page put it in or changed its address after it loaded, and the test does not let such a frame load')])).toEqual([['#calendar-frame', true]]);
  }, 30_000);
});

describe('frames that cannot hold a control, a lazy frame, a frame that never answers (keyboard-op fix round 1, F2, F3)', () => {
  /** A probe that only waits for the page's frames as the keyboard walk does: how long it took, and the gaps it found. */
  const settle: PageProbe = {
    id: 'settle', criteria: ['2.1.1'], kind: 'interaction', tier: 'core', timeoutMs: 20_000,
    async run(ctx) {
      const t = Date.now();
      const gaps = await settleFrames(ctx.page, 3000, { guard: ctx.guard, deadline: ctx.deadline, scroll: true });
      return [{ criterion: '2.1.1', status: 'not_applicable', detail: JSON.stringify({ ms: Date.now() - t, gaps }) }];
    },
  };
  const settled = async (file: string) => JSON.parse((await findings(file, [settle]))[0]!.detail) as { ms: number; gaps: { path: string; why: string }[] };

  it('a same-site frame holding a PDF (at a .pdf address, and at one that names no file type) is no gap and costs no wait: the documents test\'s', async () => {
    const s = await settled('frame-documents.html');
    expect(s.gaps).toEqual([]);
    // Before fix round 1 each such frame was waited for the whole 3 s and then reported as not loaded.
    expect(s.ms).toBeLessThan(2000);
    const list = await findings('frame-documents.html');
    expect(notTestable(list, '2.1.1')).toEqual([]);
  }, 60_000);

  it('a javascript: frame, a frame of no size and a hidden frame (both never let load) are no gap and cost no wait', async () => {
    const s = await settled('frame-empty.html');
    expect(s.gaps).toEqual([]);
    expect(s.ms).toBeLessThan(2000);
    expect(notTestable(await findings('frame-empty.html'), '2.1.1')).toEqual([]);
  }, 60_000);

  it('a lazy frame far below the fold is scrolled to once and looked into (its click-only days fail); before, the walk waited on a frame that never answered', async () => {
    const list = await findings('frame-lazy.html');
    expect(failed(list, '2.1.1').map((x) => x.target)).toEqual(['#calendar-frame >>> #d9']);
    expect(notTestable(list, '2.1.1')).toEqual([]);
  }, 60_000);

  it('look-alike: a shown same-site frame the guard did not let load stays not testable (precision first), at once', async () => {
    const s = await settled('frame-click-late.html');
    expect(s.gaps.map((g) => g.path)).toEqual(['#calendar-frame']);
  }, 60_000);
});
