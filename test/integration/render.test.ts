// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The render probes (Plan 4 Task 4.2) in real Chromium: reflow (1.4.10), text spacing (1.4.12),
// resize text (1.4.4), orientation (1.3.4) and hover or focus content (1.4.13). Fixture site:
// test/fixtures/render/ (planted failures, and a page with none).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hoverContentProbe } from '../../src/probes/hoverContent.js';
import { orientationProbe } from '../../src/probes/orientation.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { PROBES } from '../../src/probes/registry.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { runProbes } from '../../src/probes/runner.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ProbeRun, SiteReport } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('render');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = async (probe: PageProbe, ...paths: string[]): Promise<ProbeRun[]> =>
  runProbes(B(), paths.map((p, index) => ({ url: `${server.origin}${p}`, index })), [probe], OPTS);
const summary = (r: ProbeRun) => r.findings.map((f) => [f.status, f.target ?? '']);

describe('reflow (1.4.10)', () => {
  it('fails a fixed-width container, but not the data table or the code block next to it; finds nothing on the clean page', async () => {
    const [planted, clean] = await run(reflowProbe, '/reflow.html', '/');
    expect(planted!.status).toBe('ok');
    expect(summary(planted!)).toEqual([['failed', '#fixed-box']]);
    expect(planted!.findings[0]!.detail).toMatch(/^At 320 px wide, a 1000 px wide container does not fit and its text needs scrolling sideways \(the page is \d+ px wide\): “This container is one thousand/);
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 60_000);
});

describe('text spacing (1.4.12)', () => {
  it('fails text that the WCAG spacing cuts off or makes overlap; finds nothing on the clean page', async () => {
    const [planted, clean] = await run(textSpacingProbe, '/spacing.html', '/');
    expect(planted!.status).toBe('ok');
    expect(summary(planted!)).toEqual([['failed', '#clip-box'], ['failed', '#overlap-box']]);
    expect(planted!.findings[0]!.detail).toMatch(/^With the WCAG text spacing applied \(line height 1\.5.*\), text is cut off by its container \(288×60 px, overflow hidden\): “/);
    expect(planted!.findings[1]!.detail).toMatch(/text overlaps other text: “.+” runs into “This paragraph comes right after/);
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 60_000);

  it('leaves no change on the page (the spacing is applied and removed within one task)', async () => {
    let state: unknown[] = [];
    const after: PageProbe = {
      id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000,
      async run(ctx) {
        state = await ctx.page.evaluate(() => [
          getComputedStyle(document.querySelector('#clip-box')!).lineHeight, document.adoptedStyleSheets.length,
          document.querySelectorAll('style').length, 'grntedLayout' in window || '__grntedLayout' in window, innerWidth,
        ], undefined);
        return [];
      },
    };
    await runProbes(B(), [{ url: `${server.origin}/spacing.html`, index: 0 }], [textSpacingProbe, resizeTextProbe, reflowProbe, after], OPTS);
    expect(state).toEqual(['20px', 0, 1, false, 1280]);
  }, 60_000);
});

describe('resize text (1.4.4)', () => {
  // 2026-11-07: tested at real 200% browser zoom only (G142). The fixed-height button with a rem label is
  // cut off only by text-only enlargement: at 200% zoom its box grows with it, so it is no failure.
  it('fails content pushed out of reach and text in viewport units at 200% zoom; not a box that only text-only enlargement cuts', async () => {
    const [planted, clean] = await run(resizeTextProbe, '/resize.html', '/');
    expect(planted!.status).toBe('ok');
    expect(summary(planted!)).toEqual([['failed', '#nowrap-nav'], ['failed', '#vw-title']]);
    const [reach, zoom] = planted!.findings.map((f) => f.detail);
    expect(reach).toMatch(/^At 200% browser zoom \(the page laid out at 640×450 px\), content is pushed off the side of the page where it cannot be scrolled to: “/);
    expect(zoom).toMatch(/^At 200% browser zoom \(the page laid out at 640×450 px\), this text stays the same size on screen \(51 px → 51 px\): “Viewport units”/);
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 60_000);
});

describe('orientation (1.3.4)', () => {
  it('fails pages locked to one orientation (by CSS and by a script); finds nothing on the clean page', async () => {
    const [css, script, clean] = await run(orientationProbe, '/orientation.html', '/orientation-js.html', '/');
    expect(css!.status).toBe('ok');
    expect(css!.findings).toHaveLength(1);
    expect(css!.findings[0]).toMatchObject({ status: 'failed', target: '#rotate-msg' });
    expect(css!.findings[0]!.detail).toMatch(/^On a phone in portrait \(390×844 px\), most of its text is hidden .*; it shows “Please turn your phone on its side to read this page\.” over 100% of the screen, so the content only works in landscape$/);
    expect(script!.findings).toHaveLength(1);
    expect(script!.findings[0]).toMatchObject({ status: 'failed', target: '#lock' });
    expect(script!.findings[0]!.detail).toMatch(/^On a phone in landscape \(844×390 px\), .*Turn your phone to portrait/);
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 60_000);
});

describe('content on hover or focus (1.4.13)', () => {
  it('fails a tooltip that cannot be dismissed or hovered, and one that hides itself; finds nothing on the clean page', async () => {
    const [planted, clean] = await run(hoverContentProbe, '/hover.html', '/');
    expect(planted!.status).toBe('ok');
    expect(summary(planted!)).toEqual([['failed', '#info-btn'], ['failed', '#bus-wrap']]);
    expect(planted!.findings[0]!.detail).toBe('Content shown on hover (“Office hours are 8 am to 4 pm on school days.”): '
      + 'pressing Escape does not hide it although it covers other content; it disappears when the pointer moves onto it');
    expect(planted!.findings[1]!.detail).toBe('Content shown on hover (“Routes change on early release days.”): it disappears by itself within 2 s while the pointer stays on its trigger');
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 120_000);
});

const blocked = (url: string) => `the test would have sent data to the live site (POST request to ${url}), so it was stopped`;
const dmap = (r: ProbeRun) => r.findings.map((f) => f.detail);

describe('reflow (1.4.10): failure modes', () => {
  it('real-world patterns that are allowed find nothing: off-canvas menu, skip link, snap carousel, scrolling link row, wrapped table, toolbar, diagram, fixed notice, closed sheet', async () => {
    const [clean] = await run(reflowProbe, '/reflow-clean.html');
    expect(clean!.status).toBe('ok');
    expect(clean!.findings).toEqual([]);
  }, 60_000);

  it('fails content lost past the edge, a fixed-width form field, a line that scrolls sideways in its own region, and a fixed banner taller than the screen', async () => {
    const [planted] = await run(reflowProbe, '/reflow-more.html');
    expect(summary(planted!)).toEqual([['failed', '#lost-row'], ['failed', '#wide-input'], ['failed', '#scroll-strip'], ['failed', '#cookie']]);
    const [lost, field, strip, cookie] = dmap(planted!);
    expect(cookie).toMatch(/^At 320 px wide, a box fixed to the screen runs past its 256 px height, so this text cannot be scrolled to: “This site uses cookies/);
    expect(lost).toMatch(/^At 320 px wide, content does not fit in its container and its text is cut off at the edge of the screen \(the page cannot scroll sideways\): “Second notice/);
    expect(field).toMatch(/^At 320 px wide, a 600 px wide form control does not fit and is cut off at the edge of the screen \(the page cannot scroll sideways\): “Search the site”$/);
    expect(strip).toMatch(/^At 320 px wide, a line of text is wider than the region it scrolls in \(\d+ px wide\), so reading it means scrolling sideways: “This whole announcement/);
  }, 60_000);

  it('a page that re-renders itself when it gets narrow is measured on what it shows then, not reported clean', async () => {
    const [spa] = await run(reflowProbe, '/reflow-spa.html');
    expect(summary(spa!)).toEqual([['failed', '#mobile-card']]);
    expect(spa!.findings[0]!.detail).toMatch(/^At 320 px wide, a 900 px wide container does not fit and its text needs scrolling sideways .*: “The mobile layout/);
  }, 60_000);

  it('an app layout that scrolls a wrapper instead of the page is measured like a page (not exempt as a scrolling region)', async () => {
    const [app] = await run(reflowProbe, '/reflow-app.html');
    expect(summary(app!)).toEqual([['failed', '#wide-panel']]);
    expect(app!.findings[0]!.detail).toMatch(/^At 320 px wide, a 900 px wide container does not fit and its text needs scrolling sideways \(the page is \d+ px wide\): “Book the library/);
  }, 60_000);

  it('a page that goes to another address when it gets narrow could not be tested (never a clean result)', async () => {
    const [redirect] = await run(reflowProbe, '/reflow-redirect.html');
    expect(redirect!.status).toBe('ok');
    expect(redirect!.findings).toEqual([{
      criterion: '1.4.10', status: 'not_testable',
      detail: `the page tried to go to another address during the test (${server.origin}/mobile.html); the test holds such navigations, so the page could not be measured`,
    }]);
  }, 60_000);

  it('a page that hangs when resized times out: not testable, and the context is closed', async () => {
    const quick: PageProbe = { ...reflowProbe, timeoutMs: 1500 };
    const t = Date.now();
    const [hung] = await run(quick, '/reflow-hang.html');
    expect(hung!.status).toBe('timeout');
    expect(hung!.findings).toEqual([{ criterion: '1.4.10', status: 'not_testable', detail: 'timed out after 1.5 s' }]);
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(browser.contexts()).toHaveLength(0);
  }, 60_000);
});

describe('text spacing (1.4.12) and resize text (1.4.4): failure modes', () => {
  it('text spacing: fails a label cut off sideways by letter and word spacing, not the one with an ellipsis on purpose or an icon-font glyph', async () => {
    const [planted] = await run(textSpacingProbe, '/spacing-more.html');
    expect(summary(planted!)).toEqual([['failed', '#tab-btn']]);
    expect(planted!.findings[0]!.detail).toMatch(/text is cut off by its container \(200×\d+ px, overflow hidden\): “Upcoming events list”/);
  }, 60_000);

  it('resize text: fails text in pixels cut off at 200% zoom; not a field only text-only enlargement pushes out of its box, nor the nav that becomes an off-canvas menu', async () => {
    const [planted] = await run(resizeTextProbe, '/resize-zoom.html');
    expect(summary(planted!)).toEqual([['failed', '#alert-bar']]);
    const [bar] = dmap(planted!);
    expect(bar).toMatch(/^At 200% browser zoom \(the page laid out at 640×450 px\), text is cut off by its container \(\d+×24 px, overflow hidden\): “Weather notice/);
  }, 60_000);
});

describe('orientation (1.3.4): failure modes', () => {
  it('fails a page turned a quarter turn by CSS in portrait; a layout that differs per orientation with a small hint is fine', async () => {
    const [rotated, responsive] = await run(orientationProbe, '/orientation-rotate.html', '/orientation-responsive.html');
    expect(summary(rotated!)).toEqual([['failed', '#page']]);
    expect(rotated!.findings[0]!.detail).toMatch(/^On a phone in portrait \(390×844 px\), the page is turned 90° with a CSS transform, so the content only works in landscape$/);
    expect(responsive!.status).toBe('ok');
    expect(responsive!.findings).toEqual([]);
  }, 60_000);

  it('fails a lock a script applies 800 ms after the page is turned (landscape is read until it settles)', async () => {
    const [late] = await run(orientationProbe, '/orientation-late-lock.html');
    expect(late!.findings).toHaveLength(1);
    expect(late!.findings[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('On a phone in landscape') });
  }, 60_000);

  it('review round 2: fails a lock a script applies 1.5 s after the page is turned', async () => {
    const [late] = await run(orientationProbe, '/orientation-late-lock-1500.html');
    expect(late!.findings).toHaveLength(1);
    expect(late!.findings[0]).toMatchObject({ status: 'failed', detail: expect.stringContaining('On a phone in landscape') });
  }, 60_000);
});

describe('content on hover or focus (1.4.13): failure modes', () => {
  it('fails a hint shown on focus that Escape does not hide; a tooltip in empty space may stay', async () => {
    const [planted] = await run(hoverContentProbe, '/hover-more.html');
    expect(summary(planted!)).toEqual([['failed', '#email']]);
    expect(planted!.findings[0]!.detail).toBe('Content shown on focus (“We send one email a week, on Friday afternoon.”): pressing Escape does not hide it although it covers other content');
  }, 60_000);

  it('moves onto a wide tooltip the shortest way, as a person does: passes it; still fails one that hides off its trigger, or across a gap', async () => {
    // The pointer used to go straight to the middle of the tooltip, leaving the small trigger (and its
    // wrapper) on the diagonal before it reached the tooltip, which hid a hoverable tooltip (sim lab, 51 of 56).
    const [r] = await run(hoverContentProbe, '/hover-wide.html');
    expect(summary(r!)).toEqual([['failed', '#hours'], ['failed', '#map-wrap']]);
    for (const f of r!.findings) expect(f.detail).toMatch(/: it disappears when the pointer moves onto it$/);
  }, 60_000);

  it('a narrow menu touching the bottom of a wide trigger: the pointer goes inside the trigger to the point above the menu first, never cutting the corner; passes', async () => {
    // Review r1: the straight line from the trigger's middle to the nearest point of the menu left both
    // boxes at the corner, and a mouseleave script hid the menu.
    const [r] = await run(hoverContentProbe, '/hover-corner.html');
    expect(r!.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, 60_000);

  it('a tooltip that needs a request the guard blocks could not be tested (never "not applicable")', async () => {
    const [r] = await run(hoverContentProbe, '/hover-blocked.html');
    expect(r!.findings).toEqual([{ criterion: '1.4.13', status: 'not_testable', detail: blocked(`${server.origin}/tooltip`) }]);
  }, 60_000);

  it('a trigger the pointer cannot reach could not be tested', async () => {
    const [r] = await run(hoverContentProbe, '/hover-covered.html');
    expect(r!.findings).toEqual([{ criterion: '1.4.13', status: 'not_testable', detail: 'the pointer could not reach the hover triggers on this page (1 of 1 is covered by other content)' }]);
  }, 60_000);
});

describe('scanSite with the render probes', () => {
  let report: SiteReport;
  beforeAll(async () => {
    report = await scanSite(`${server.origin}/`, { browser: B(), maxPages: 2, full: true });
  }, 180_000);

  it('runs the registry probes and shows them in the criteria rows', () => {
    expect(report.meta.pageList.map((u) => new URL(u).pathname)).toEqual(['/', '/hover.html']);
    const ids = PROBES.map((p) => p.id);
    expect([...new Set(report.probes!.runs.map((r) => r.probe))].sort()).toEqual([...ids].sort());
    expect(report.probes!.runs.every((r) => r.status === 'ok')).toBe(true);
    const methods = (c: string) => report.criteria!.find((r) => r.criterion === c)!.methods.map((m) => [m.id, m.kind, m.status]);
    expect(methods('1.3.4')).toEqual([['axe', 'axe', 'no_failures_found'], ['orientation', 'render', 'no_failures_found']]);
    expect(methods('1.4.4')).toEqual([['axe', 'axe', 'no_failures_found'], ['resize-text', 'render', 'no_failures_found']]);
    expect(methods('1.4.10')).toEqual([['reflow', 'render', 'no_failures_found'], ['overlays', 'render', 'no_failures_found']]);
    expect(methods('1.4.12')).toEqual([['axe', 'axe', 'no_failures_found'], ['text-spacing', 'render', 'no_failures_found']]);
    expect(methods('1.4.13')).toEqual([['hover-content', 'interaction', 'failed']]);
    const hover = report.criteria!.find((r) => r.criterion === '1.4.13')!;
    expect(hover.status).toBe('failed');
    expect(hover.evidence.map((e) => [new URL(e.page).pathname, e.target])).toEqual([['/hover.html', '#info-btn'], ['/hover.html', '#bus-wrap']]);
  });
});
