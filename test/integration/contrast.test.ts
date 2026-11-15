// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The contrast probes (Plan 4 Task 4.3) in real Chromium: text contrast axe could not decide
// (1.4.3), non-text contrast of form fields and icons (1.4.11) and links told apart only by colour
// (1.4.1). Fixture site: test/fixtures/contrast/ (planted failures and clean controls, synthetic).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNCONFIRMED, runProbes } from '../../src/probes/runner.js';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, Finding, ProbeRun, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('contrast');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** axe's undecided color-contrast results for these targets (the probe measures only these). */
const undecided = (targets: string[], viewports: ('desktop' | 'mobile')[] = ['desktop'], html: Record<string, string> = {}): Finding[] => [{
  id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x/color-contrast',
  nodes: targets.map((target) => ({ target, html: html[target] ?? '<p>', viewports, failureSummary: "Element's background color could not be determined due to a background image" })),
}];
const statuses = (r: ProbeRun) => r.findings.map((f) => f.status);
/** The run's per-element results (`ctx.setData`). */
const results = (r: ProbeRun) => Object.fromEntries((r.data as { items: { target: string; result: string }[] }).items.map((i) => [i.target, i.result]));

const runOn = async (probe: PageProbe, path: string, incomplete?: Finding[]): Promise<ProbeRun> =>
  (await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0, ...(incomplete ? { incomplete } : {}) }], [probe], OPTS))[0]!;
const summary = (r: ProbeRun) => r.findings.map((f) => [f.status, f.target ?? '']);

describe('text contrast axe could not decide (1.4.3)', () => {
  it('fails text below 4.5:1 on images, gradients and pseudo-elements; not text with enough contrast or nobody sees', async () => {
    const fail = ['#t-fail-image', '#t-fail-gradient', '#t-fail-pseudo', '#t-fail-half', '#t-fail-thin', '#t-fail-opacity', 'grn-card >>> #inner'];
    const ok = ['#t-ok-image', '#t-ok-gradient', '#t-ok-large', '#t-ok-thin', '#t-ok-opacity', '#t-ok-dark', '#t-offscreen'];
    const r = await runOn(textContrastProbe, '/text.html', undecided([...fail, ...ok]));
    expect(r.status).toBe('ok');
    expect(summary(r)).toEqual(fail.map((t) => ['failed', t]));
    const detail = (t: string) => r.findings.find((f) => f.target === t)!.detail;
    // light.svg: #fbfbfb with a #f2f2f2 band over 35% of each 40 px tile, so about a third of the letter pixels
    // sit on #f2f2f2 (the measured fifth) and most on #fbfbfb, whatever the system's Arial is (Arial on macOS,
    // Liberation Sans on Linux). Its old circle put close to half the letter pixels on each colour, so the
    // median ("mostly") flipped between the two with the glyph shapes.
    expect(detail('#t-fail-image')).toBe('Text contrast is 2.0:1 where it sits on a background image (text #aaaaaa on #f2f2f2, mostly #fbfbfb); 16 px text needs at least 4.5:1: “Light grey text on a light picture is hard to read for many people.”');
    // Half the text is on black: the white half fails (the lowest fifth of the letters is measured).
    expect(detail('#t-fail-half')).toMatch(/^Text contrast is 1\.0:1 .* \(text #ffffff on #ffffff, mostly #000000\)/);
    expect(detail('#t-fail-opacity')).toMatch(/^Text contrast is 2\.0:1 .* \(text #b3b3b3 on #ffffff/);
    // Large text needs 3:1 (white on #767676–#707070 is about 4.5:1).
    expect(r.findings.some((f) => f.target === '#t-ok-large')).toBe(false);
  }, 60_000);

  // Equal foreground/background colours can be incidental. Only a control's entire single character
  // with a verified, differently worded accessible name is graphic; page numbers stay text.
  it('measures page numbers as text, while exempting named control graphics and text invisible to everyone', async () => {
    // axe's own reasons: the colours are equal, the content is a single character, else a background it could not read.
    const why: Record<string, string> = {
      '#t-same': 'Element has a 1:1 contrast ratio with the background',
      '#t-near': 'Element has a 1:1 contrast ratio with the background',
      '#t-glyph': 'Element content is too short to determine if it is actual text content',
      '#t-digit': 'Element content is too short to determine if it is actual text content',
      '#t-lone': 'Element content is too short to determine if it is actual text content',
    };
    const found = undecided(Object.keys(why));
    for (const n of found[0]!.nodes) n.failureSummary = why[n.target];
    const r = await runOn(textContrastProbe, '/text-incidental.html', found);
    expect(r.status).toBe('ok');
    expect(summary(r).filter(([s]) => s === 'failed').sort()).toEqual([['failed', '#t-digit'], ['failed', '#t-lone'], ['failed', '#t-near']]);
    expect(results(r)).toMatchObject({ '#t-same': 'unshown: invisible' });
  }, 60_000);

  it('a run cut by its time box drops kept failures when final document identity cannot be confirmed', async () => {
    const quick = { ...textContrastProbe, timeoutMs: 8000 };
    const r = await runOn(quick, '/text-stall.html', undecided(['#t-stall-fail', '#t-stall-late']));
    expect(r.status).toBe('timeout');
    expect(r.findings.map((f) => [f.status, f.target ?? ''])).toEqual([['not_testable', '#t-stall-fail']]);
    expect(r.findings[0]!.detail).toBe(UNCONFIRMED);
  }, 60_000);

  it('failures kept from a timed-out run go through the same checks as a finished run: a held navigation or a refused stylesheet voids them', async () => {
    const quick = { ...textContrastProbe, timeoutMs: 8000 };
    const nav = await runOn(quick, '/text-stall.html?nav=1', undecided(['#t-stall-fail', '#t-stall-late']));
    expect(nav.status).toBe('timeout');
    expect(statuses(nav)).toEqual(['not_testable']);
    const refusing = await startFixtureServer('contrast', {}, { respond: (_req, path) => (path === '/refused.css' ? { status: 429, type: 'text/css', body: '' } : undefined) });
    try {
      const [css] = await runProbes(B(), [{ url: `${refusing.origin}/text-stall.html?css=1`, index: 0, incomplete: undecided(['#t-stall-fail', '#t-stall-late']) }], [quick], OPTS);
      expect(css!.status).toBe('timeout');
      expect(statuses(css!)).toEqual(['not_testable']);
    } finally {
      await refusing.close();
    }
  }, 90_000);

  it('waits for a lazy picture behind the text to load before measuring (not the placeholder)', async () => {
    // The picture is set when the box is scrolled into view and the server takes 1.2 s to send it.
    const slow = await startFixtureServer('contrast', { '/slow-dark.svg': { type: 'image/svg+xml', file: 'dark.svg' } }, { delayMs: (path) => (path === '/slow-dark.svg' ? 1200 : 0) });
    try {
      const r = (await runProbes(B(), [{ url: `${slow.origin}/text-lazy.html`, index: 0, incomplete: undecided(['#t-lazy-hero']) }], [textContrastProbe], OPTS))[0]!;
      expect(r.status).toBe('ok');
      expect(statuses(r)).toEqual([]);
      expect(results(r)).toEqual({ '#t-lazy-hero': expect.stringMatching(/^ok /) });
    } finally {
      await slow.close();
    }
  }, 60_000);

  it('measures text in a same-origin frame, and text that fades in on scrolling at its opacity then', async () => {
    const r = await runOn(textContrastProbe, '/text-more.html', undecided(['#frame >>> #inner-text', '#t-reveal']));
    expect(summary(r)).toEqual([['failed', '#frame >>> #inner-text']]);
    expect(r.findings[0]!.detail).toMatch(/^Text contrast is 1\.\d:1 .*\(text #aaaaaa on #e/);
    // At opacity 0 until it scrolls into view: shown (and measured) once it is there.
    expect(results(r)['#t-reveal']).toMatch(/^ok /);
  }, 60_000);

  it('requests the guard blocks while it measures (a POST, third-party analytics, a beacon) cannot change a screenshot: the result stands', async () => {
    const r = await runOn(textContrastProbe, '/text-guard.html', undecided(['#t-lazy']));
    expect(r.status).toBe('ok');
    expect(statuses(r)).toEqual([]);
    expect(results(r)).toEqual({ '#t-lazy': expect.stringMatching(/^ok /) });
    const painted = await runOn(textContrastProbe, '/text-guard.html', undecided(['#t-painted']));
    expect(painted.findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', target: '#t-painted', detail: expect.stringMatching(/background-clip: text/) }]);
  }, 60_000);

  it('a page that goes to another address while it measures is still not testable', async () => {
    const r = await runOn(textContrastProbe, '/text-navigate.html', undecided(['#t-leave']));
    expect(r.findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', detail: expect.stringMatching(/tried to go to another address/) }]);
  }, 60_000);

  it('white text over a light looping background video fails: the video is paused on its first frame and measured', async () => {
    const r = await runOn(textContrastProbe, '/text-video.html', undecided(['#t-video']));
    expect(statuses(r)).toEqual(['failed']);
    expect(r.findings[0]).toMatchObject({ target: '#t-video', detail: expect.stringMatching(/^Text contrast is 1\.\d:1 /) });
  }, 60_000);

  it('text in a cycling carousel over an animated background is measured on the slide shown, the same way on every run', async () => {
    const runs: ProbeRun[] = [];
    for (let i = 0; i < 3; i++) runs.push(await runOn(textContrastProbe, '/text-carousel.html', undecided(['#t-slide-1', '#t-slide-2', '#t-slide-3'])));
    for (const r of runs) {
      // One slide shown and measured (its white text on a pale background fails); the two others are out of view.
      expect(statuses(r)).toEqual(['failed']);
      expect(Object.values(results(r)).sort()).toEqual([expect.stringMatching(/^failed 1\.\d:1$/), 'unshown: clipped', 'unshown: clipped']);
    }
  }, 120_000);

  it('text nobody can see (covered, transparent) is not counted; ids a script generates on each load are found by the markup', async () => {
    const r = await runOn(textContrastProbe, '/text-covered.html', undecided(['#t-shown', '#t-covered', '#t-clear']));
    expect(statuses(r)).toEqual(['no_failures_found']);
    expect(results(r)).toEqual({ '#t-shown': expect.stringMatching(/^ok /), '#t-covered': 'unshown: covered', '#t-clear': 'unshown: covered' });
    // The page's own important colours, and words in a span with a colour of their own, are measured.
    const own = await runOn(textContrastProbe, '/text-covered.html', undecided(['#t-important', '#t-span']));
    expect(own.findings.map((f) => [f.status, f.target])).toEqual([['failed', '#t-important'], ['failed', '#t-span']]);
    // axe's selector names the id the audit's load generated; this load has another one.
    const menu = await runOn(textContrastProbe, '/text-covered.html', undecided(['#gen-1793557186896-1 > span', '#gen-1793557186896-2 > span'], ['desktop'], {
      '#gen-1793557186896-1 > span': '<span>Schools</span>', '#gen-1793557186896-2 > span': '<span>Cafeteria</span>',
    }));
    expect(menu.findings.map((f) => [f.status, f.target])).toEqual([['failed', '#gen-1793557186896-1 > span']]);
    const stamped = await runOn(textContrastProbe, '/text-covered.html', undecided(['ul[data-menu-id="1793557186896"] > li > a'], ['desktop'], {
      'ul[data-menu-id="1793557186896"] > li > a': '<a href="#news">News</a>',
    }));
    expect(stamped.findings.map((f) => f.status)).toEqual(['failed']);
    // An element that is not on the page as loaded for the test is not counted.
    expect(results(menu)['#gen-1793557186896-2 > span']).toBe('unshown: missing');
  }, 60_000);

  it('text it cannot settle (a background that keeps changing, outlined by a shadow) makes the page not testable when it is over a third of the text shown', async () => {
    // #t-shadow is outlined by a crisp 1 px black ring (and a blur): its strongest halo pixels are near black, far
    // past 4.5:1 against white on any rasterizer. A blur alone left them at about 4.2:1 on Linux (Liberation
    // Sans), on the threshold's other side from macOS.
    const r = await runOn(textContrastProbe, '/text-unmeasured.html', undecided(['#t-moving', '#t-covered', '#t-shadow', '#t-slide-1', '#t-slide-2']));
    expect(r.findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', target: '#t-moving', detail: expect.stringMatching(/^axe could not decide the contrast of 5 text elements here; 1 measured/) }]);
    expect(results(r)).toEqual({
      '#t-moving': 'unmeasured: moving', '#t-covered': 'unshown: covered', '#t-shadow': 'unmeasured: shadow', '#t-slide-1': expect.stringMatching(/^ok /), '#t-slide-2': 'unshown: clipped',
    });
    // One unmeasured element among three shown ones is not over a third: no failures found (with the counts).
    const some = await runOn(textContrastProbe, '/text-unmeasured.html', undecided(['#t-shadow', '#t-slide-1', 'h1']));
    expect(statuses(some)).toEqual(['no_failures_found']);
    expect(statuses(await runOn(textContrastProbe, '/text-unmeasured.html', undecided(['#t-shadow', '#t-slide-1'])))).toEqual(['not_testable']);
  }, 60_000);

  it('text on slides faded out (opacity 0, also through an ancestor) is not shown, so it is not counted as unmeasured', async () => {
    const faded = ['#t-faded-1', '#t-faded-2', '#t-faded-3', '#t-faded-4', '#t-faded-5', '#t-faded-6'];
    const r = await runOn(textContrastProbe, '/text-faded.html', undecided(['#t-ok-1', '#t-ok-2', '#t-ok-3', ...faded]));
    expect(statuses(r)).toEqual(['no_failures_found']);
    expect(results(r)).toEqual({
      '#t-ok-1': expect.stringMatching(/^ok /), '#t-ok-2': expect.stringMatching(/^ok /), '#t-ok-3': expect.stringMatching(/^ok /),
      ...Object.fromEntries(faded.map((t) => [t, 'unshown: hidden'])),
    });
    expect(r.findings[0]!.detail).toMatch(/6 elements not shown when measured, so not counted/);
  }, 60_000);

  it('measures text axe found only at the phone width at that width, then restores the viewport', async () => {
    let width = 0;
    const after: PageProbe = { id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000, async run(ctx) { width = await ctx.page.evaluate(() => innerWidth, undefined); return []; } };
    const runs = await runProbes(B(), [{ url: `${server.origin}/text-mobile.html`, index: 0, incomplete: undecided(['#m-only'], ['mobile']) }], [textContrastProbe, after], OPTS);
    expect(summary(runs[0]!)).toEqual([['failed', '#m-only']]);
    expect(runs[0]!.findings[0]!.detail).toMatch(/^Text contrast is 1\.\d:1 at the phone width where/);
    expect(width).toBe(1280);
  }, 60_000);

  it('no failures found (checked) when axe decided every text element; not testable without the audit\'s results', async () => {
    expect((await runOn(textContrastProbe, '/text.html', [])).findings).toEqual([{ criterion: '1.4.3', status: 'no_failures_found', detail: 'axe decided the contrast of all text on this page' }]);
    expect((await runOn(textContrastProbe, '/text.html')).findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', detail: 'the audit’s undecided axe results were not available to this test' }]);
    // Targets nowhere on screen are not counted: nothing is left to fail.
    expect((await runOn(textContrastProbe, '/text.html', undecided(['#t-offscreen']))).findings)
      .toEqual([{ criterion: '1.4.3', status: 'no_failures_found', detail: 'the text axe could not decide is not shown on the page' }]);
    // None of the elements found at all: not testable. One not found among others shown is not counted.
    expect((await runOn(textContrastProbe, '/text.html', undecided(['#no-such-element']))).findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', target: '#no-such-element', detail: expect.stringMatching(/was on the page as loaded for the test$/) }]);
    expect(statuses(await runOn(textContrastProbe, '/text.html', undecided(['#no-such-element', '#t-ok-image'])))).toEqual(['no_failures_found']);
  }, 60_000);

  it('leaves the page as it was: no marks, no style sheets, no store', async () => {
    let state: unknown[] = [];
    const after: PageProbe = {
      id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        state = await ctx.page.evaluate(() => [
          document.querySelectorAll('[data-grnted-px]').length, document.adoptedStyleSheets.length,
          document.querySelector('grn-card')!.shadowRoot!.adoptedStyleSheets.length, '__grntedShots' in window, getComputedStyle(document.querySelector('#t-fail-image')!).color,
        ], undefined);
        return [];
      },
    };
    await runProbes(B(), [{ url: `${server.origin}/text.html`, index: 0, incomplete: undecided(['#t-fail-image', 'grn-card >>> #inner']) }], [textContrastProbe, after], OPTS);
    expect(state).toEqual([0, 0, 0, false, 'rgb(170, 170, 170)']);
  }, 60_000);
});

describe('the page is held still only while the text is measured', () => {
  it('the next probe finds the video playing, the animations running and the carousel advancing again', async () => {
    const seen: unknown[] = [];
    const after: PageProbe = {
      id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 8000,
      async run(ctx) {
        const read = () => ctx.page.evaluate(() => [
          (document.querySelector('video') as HTMLVideoElement | null)?.paused ?? null,
          document.getAnimations().filter((a) => a.playState === 'running').length,
          getComputedStyle(document.body).transitionDuration,
          (document.getElementById('slides') as HTMLElement | null)?.style.transform ?? null,
          '__grntedFrozen' in window,
        ], undefined);
        const first = await read();
        await ctx.page.waitForTimeout(2600);
        seen.push(first, await read());
        return [];
      },
    };
    await runProbes(B(), [{ url: `${server.origin}/text-video.html`, index: 0, incomplete: undecided(['#t-video']) }], [textContrastProbe, after], OPTS);
    expect(seen[0]).toEqual([false, 0, '0s', null, false]);
    seen.length = 0;
    await runProbes(B(), [{ url: `${server.origin}/text-carousel.html`, index: 0, incomplete: undecided(['#t-slide-1', '#t-slide-2', '#t-slide-3']) }], [textContrastProbe, after], OPTS);
    const [before, later] = seen as [unknown[], unknown[]];
    expect(before[1]).toBe(3);
    expect(before[4]).toBe(false);
    // Its 1.2 s timer runs again: the slides have moved on 2.6 s later.
    expect(later[3]).not.toBe(before[3]);
  }, 60_000);
});

describe('non-text contrast of form fields and icons (1.4.11)', () => {
  it('fails styled fields and icons under 3:1; not browser-default, disabled, unmarked or well-marked controls', async () => {
    const r = await runOn(nonTextContrastProbe, '/controls.html');
    expect(r.status).toBe('ok');
    expect(summary(r)).toEqual([
      ['failed', '#f-light-border'], ['failed', '#f-bootstrap'], ['failed', '#f-fill-fail'], ['failed', '#f-select-fail'], ['failed', '#f-check-fail'],
      ['failed', '#i-svg-fail'], ['failed', '#i-font-fail'], ['failed', '#i-mask-fail'],
    ]);
  }, 60_000);

  it('words the evidence with the colors measured', async () => {
    const r = await runOn(nonTextContrastProbe, '/controls.html');
    const detail = (t: string) => r.findings.find((f) => f.target === t)!.detail;
    expect(detail('#f-bootstrap')).toBe('A form field’s boundary has 1.4:1 contrast with the colors next to it (edge #ced4da between #ffffff outside and #ffffff inside); at least 3:1 is needed to see the control: “Email”');
    expect(detail('#f-fill-fail')).toBe('A form field’s boundary has 1.1:1 contrast with the colors next to it (fill #eeeeee on #ffffff); at least 3:1 is needed to see the control: “Search”');
    expect(detail('#i-svg-fail')).toBe('The icon of an icon-only control (svg) has 1.6:1 contrast with the color behind it (#cccccc on #ffffff); at least 3:1 is needed to make it out: “Close”');
  }, 60_000);

  it('controls it cannot settle (busy surroundings, moving background, an icon it cannot hide) are not_testable with the reasons', async () => {
    const r = await runOn(nonTextContrastProbe, '/controls-unmeasured.html');
    expect(r.findings).toEqual([{
      criterion: '1.4.11', status: 'not_testable', target: '#u-busy',
      detail: '3 controls of 3 could not be measured: 1 because the colors around it vary too much to compare with (an image or other content right next to it); '
        + '1 because the area around it kept changing (video, animation or loading content); 1 because its icon could not be separated from its background in the screenshots',
    }]);
  }, 60_000);

  it('not applicable on a page without styled fields or icon-only controls', async () => {
    const r = await runOn(nonTextContrastProbe, '/text.html');
    expect(r.findings).toEqual([{ criterion: '1.4.11', status: 'not_applicable', detail: 'no form fields or icon-only controls on the page' }]);
  }, 60_000);
});

describe('links told apart only by color (1.4.1)', () => {
  it('fails a link under 3:1 from the text with no cue on hover or on focus; not one with both, or one 3:1 apart', async () => {
    const r = await runOn(linkColorProbe, '/links.html');
    expect(r.status).toBe('ok');
    expect(summary(r)).toEqual([
      ['failed', 'link “opening hours”'], ['failed', 'link “school calendar”'], ['failed', 'link “results table”'], ['not_testable', 'link “meeting notes”'],
    ]);
    // A hover transition running back is not mistaken for a focus cue.
    expect(r.findings[2]!.detail).toMatch(/, and focusing it adds no other cue: “results table”/);
    expect(r.findings[3]!.detail).toBe('1 of 6 links told apart only by a color close to the text could not be tested: 1 because the pointer could not reach it (covered by other content)');
    expect(r.findings[0]!.detail).toBe('A link differs from the text around it only by color (#4d4d4d against #333333, 1.4:1; at least 3:1 is needed), and neither pointing at it nor focusing it adds another cue: “opening hours” in “Our office is open on weekdays. Read the opening hours before you visit, and bring your card.”');
    expect(r.findings[1]!.detail).toMatch(/, and focusing it adds no other cue: “school calendar”/);
  }, 60_000);
});

describe('scanSite with the contrast probes', () => {
  let report: SiteReport;
  beforeAll(async () => {
    report = await scanSite(`${server.origin}/`, { browser: B(), maxPages: 4 });
  }, 180_000);

  it('runs on the template sample with axe’s undecided results, and fills the criteria rows', () => {
    const path = (u: string) => new URL(u).pathname;
    const ids = ['text-contrast', 'non-text-contrast', 'link-color'];
    const runs = report.probes!.runs.filter((r) => ids.includes(r.probe));
    expect(new Set(runs.map((r) => path(r.page)))).toEqual(new Set(['/', '/text.html', '/controls.html', '/links.html']));
    expect(runs.every((r) => r.status === 'ok')).toBe(true);
    const on = (probe: string, page: string) => runs.find((r) => r.probe === probe && path(r.page) === page)!.findings;
    // The clean page: axe could not decide its text on a picture and a gradient; the pixels settle it
    // with no failure.
    expect(report.needsReview.find((r) => r.id === 'color-contrast')!.pagesAffected.map(path)).toContain('/');
    expect([on('text-contrast', '/'), on('non-text-contrast', '/'), on('link-color', '/')]).toEqual([[], [], []]);
    // Real axe output feeds the probe, shadow DOM targets included.
    expect(on('text-contrast', '/text.html').map((f) => [f.status, f.target])).toEqual(
      ['#t-fail-image', '#t-fail-gradient', '#t-fail-pseudo', '#t-fail-half', '#t-fail-thin', '#t-fail-opacity', '#card >>> #inner'].map((t) => ['failed', t]),
    );
    const methods = (c: string) => report.criteria!.find((r) => r.criterion === c)!.methods.map((m) => [m.id, m.kind, m.status]);
    expect(methods('1.4.1')).toEqual([['axe', 'axe', 'failed'], ['link-color', 'interaction', 'failed']]);
    expect(methods('1.4.3')).toEqual([['axe', 'axe', 'failed'], ['text-contrast', 'pixels', 'failed']]);
    // The keyboard probe's focus-ring part of 1.4.11 (Task 4.10): these fixture pages style no focus ring.
    expect(methods('1.4.11')).toEqual([['non-text-contrast', 'pixels', 'failed'], ['keyboard', 'interaction', 'not_applicable']]);
    expect(report.criteria!.find((r) => r.criterion === '1.4.11')!.evidence[0]).toMatchObject({ target: '#f-light-border' });
  });
});
