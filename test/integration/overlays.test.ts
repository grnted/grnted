// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The overlays probe (scoring v5 part B) in real Chromium: boxes that stay on screen while the page
// scrolls and cover links, buttons and fields or much of the screen (1.4.10), or hide the focused
// control (2.4.11), at 320 px wide and at a phone's width. Fixture site: test/fixtures/overlays/.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvidenceRecorder } from '../../src/evidence/recorder.js';
import { installOverlayKit, OVERLAY_LIMITS, overlaysProbe } from '../../src/probes/overlays.js';
import { PROBES } from '../../src/probes/registry.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, EvidenceShot, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test' };

beforeAll(async () => {
  server = await startFixtureServer('overlays');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = async (...paths: string[]): Promise<ProbeRun[]> =>
  runProbes(B(), paths.map((p, index) => ({ url: `${server.origin}${p}`, index })), [overlaysProbe], OPTS);
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target ?? '']);

describe('overlays (1.4.10, 2.4.11)', () => {
  it('is a scored core test in the registry, on a page of its own (it scrolls and tabs through the page)', () => {
    expect(PROBES).toContain(overlaysProbe);
    expect(overlaysProbe.tier).toBe('core');
    expect(overlaysProbe.viewport).toBeUndefined();
    expect(overlaysProbe.isolate).toBe(true);
  });

  it('fails a fixed translate widget over a link at 320 px and on a phone, naming both', async () => {
    const [r] = await run('/translate.html');
    expect(r!.status, JSON.stringify(r)).toBe('ok');
    const f = r!.findings.find((x) => x.criterion === '1.4.10')!;
    expect(f).toMatchObject({ status: 'failed', target: '#registration' });
    expect(f.detail).toMatch(/^At 320 px wide and on a phone-sized screen \(390 px wide\), a box that stays on screen while the page scrolls \(“English”, a translate widget\) covers the link “Registration” wherever the page is scrolled/);
    expect(f.data).toMatchObject({ width: 320 });
    expect(String(f.data!.overlay)).toMatch(/^\d+,\d+,110,40$/);
  }, 60_000);

  it('fails a widget over a link on the first screen, even though scrolling shows that link later', async () => {
    const [r] = await run('/first-screen.html');
    expect(r!.status).toBe('ok');
    const f = r!.findings.filter((x) => x.criterion === '1.4.10');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatch(/^At 320 px wide and on a phone-sized screen \(390 px wide\), a box that stays on screen while the page scrolls \(“Summer camp”, a notice or promotion\) covers the link “Page \d+” on the first screen, as the page opens/);
  }, 60_000);

  it('judges the page as it ends up, whenever a script that makes room for the widget runs (same result every time)', async () => {
    // The page makes room under its last link for a floating widget only once a script marks the
    // widget as running, `late` ms after load: before that the widget covers the link wherever the
    // page is scrolled. Before the probe waited for the page to settle, the result depended on when
    // that script ran relative to the sweep (it passed for late=1500 and failed for late=1800).
    const results: string[] = [];
    for (const late of [0, 1500, 1800, 2200]) {
      const [r] = await run(`/late-padding.html?late=${late}`);
      expect(r!.status, `late=${late}`).toBe('ok');
      results.push(JSON.stringify(failed(r!)));
    }
    expect(results).toEqual(Array(4).fill('[]'));
    // Without the script the link stays covered: it fails, so the test can tell the two apart.
    const [never] = await run('/late-padding.html?late=60000');
    expect(failed(never!)).toEqual([['1.4.10', '#powered']]);
  }, 120_000);

  it('a page that never stands still is still judged, the same every run, on the floating box both sweeps agree on', async () => {
    // A ticker changes the page every 150 ms (the wait for the page to stand still always runs out).
    const stable = await run('/ticker.html?widget=stable&run=1', '/ticker.html?widget=stable&run=2');
    expect(stable).toHaveLength(2);
    for (const r of stable) expect(failed(r).filter(([c]) => c === '1.4.10'), JSON.stringify(r.findings)).toEqual([['1.4.10', expect.stringContaining('a')]]);
    expect(failed(stable[0]!)).toEqual(failed(stable[1]!));
    // A widget that arrives 3.5 s after load (after the first wait ran out): judged once the sweeps
    // agree on it, and never clean.
    const late = await run('/ticker.html?widget=late&late=3500&run=1', '/ticker.html?widget=late&late=3500&run=2');
    for (const r of late) expect(r.findings.filter((f) => f.criterion === '1.4.10').map((f) => f.status)).not.toEqual([]);
    expect(late.map((r) => r.findings.filter((f) => f.criterion === '1.4.10').map((f) => f.status))).toEqual([['failed'], ['failed']]);
  }, 180_000);

  it('a floating box that never stays at one place is not judged: 1.4.10 is not testable, every run', async () => {
    const runs = await run('/ticker.html?widget=moving&run=1', '/ticker.html?widget=moving&run=2');
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r.status).toBe('ok');
      expect(r.findings.filter((f) => f.criterion === '1.4.10')).toEqual([{ criterion: '1.4.10', status: 'not_testable', detail: expect.stringMatching(/kept changing while the test checked it/) }]);
    }
  }, 180_000);

  it('a tab walk its time box cuts short leaves 2.4.11 not testable, never clean', async () => {
    // 250 ms per focus change: 2 × 50 stops do not fit in a 15 s time box; the sweeps (1.4.10) do.
    const [r] = await runProbes(B(), [{ url: `${server.origin}/tab-slow.html`, index: 0 }], [{ ...overlaysProbe, timeoutMs: 15_000 }], OPTS);
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.criterion === '2.4.11')).toEqual([{ criterion: '2.4.11', status: 'not_testable', detail: expect.stringMatching(/^the page took too long to tab through at 320 px wide/) }]);
    expect(r!.findings.filter((f) => f.criterion === '1.4.10')).toEqual([]);
  }, 60_000);

  it('measures with its own kit even when the page defines one with the same name', async () => {
    const [r] = await run('/spoof.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings.find((x) => x.criterion === '1.4.10')).toMatchObject({ status: 'failed', target: '#registration' });
  }, 60_000);

  it('passes a chat bubble that covers no control and little of the screen', async () => {
    const [r] = await run('/chat.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  // Scoring v11 (review r1 of fix/redteam-visual, finding 7): a large box the content scrolls clear of loses nothing,
  // so it is a recommendation, never a 1.4.10 failure.
  it('does not fail a sticky header that takes more than half the screen at 320 px (the page scrolls clear of it): a recommendation', async () => {
    const [r] = await run('/sticky-header.html');
    expect(r!.status).toBe('ok');
    expect(failed(r!)).toEqual([]);
    expect(r!.findings, JSON.stringify(r!.findings)).toEqual([expect.objectContaining({
      criterion: '1.4.10', status: 'no_failures_found', advice: true, target: '#site-header',
      detail: expect.stringMatching(/^At 320 px wide, a box that stays on screen while the page scrolls \(“Valley School District Learning for life”\) covers (5\d|6\d)% of the screen; the content can be scrolled clear of it\. Recommended: make it smaller on small screens, or let it be closed\. It cannot be closed now: nothing in it that closes it can be reached with the keyboard\.$/),
    })]);
  }, 60_000);

  it('passes a cookie dialog with a close button reachable by keyboard that covers no control', async () => {
    const [r] = await run('/cookie-dialog.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  it('fails a fixed bar that hides the focused link while tabbing (2.4.11), not 1.4.10 (a footer bar)', async () => {
    const [r] = await run('/focus-bar.html');
    expect(r!.status).toBe('ok');
    const f = failed(r!);
    expect(f.map((x) => x[0])).toEqual(['2.4.11']);
    const d = r!.findings.find((x) => x.criterion === '2.4.11')!;
    expect(d.detail).toMatch(/is entirely hidden behind a box that stays on screen while the page scrolls \(“Emergency closure information”.*\) when it receives keyboard focus/);
    expect(d.data).toMatchObject({ coverHeight: 60 });
  }, 60_000);

  it('fails a promotion that covers a link in the fixed header (never reachable by scrolling)', async () => {
    const [r] = await run('/pileup.html');
    expect(r!.status).toBe('ok');
    const f = r!.findings.find((x) => x.criterion === '1.4.10')!;
    expect(f).toMatchObject({ status: 'failed', target: '#enroll' });
    expect(f.detail).toMatch(/\(“Summer meals”, a notice or promotion\) covers the link “Enroll” wherever the page is scrolled\. It cannot be closed: .+\.$/);
  }, 60_000);

  it('finds nothing on a normal page (sticky header bar, skip link)', async () => {
    const [r] = await run('/');
    expect(r!.status).toBe('ok');
    expect(r!.findings).toEqual([]);
  }, 60_000);

  it('is deterministic: three runs give the same findings', async () => {
    const a = await run('/translate.html', '/pileup.html', '/focus-bar.html');
    const b = await run('/translate.html', '/pileup.html', '/focus-bar.html');
    const c = await run('/translate.html', '/pileup.html', '/focus-bar.html');
    const strip = (rs: ProbeRun[]) => rs.map((r) => r.findings);
    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).toEqual(strip(a));
  }, 120_000);

  it('restores what it changes: viewport, scroll, focus, markup, no kit (when it shares a page)', async () => {
    const read = () => [document.documentElement.outerHTML.length, innerWidth, innerHeight, scrollY, document.activeElement === document.body, '__grntedOverlay' in window, document.body.getAttribute('tabindex')];
    let pre: unknown[] = [];
    let post: unknown[] = [];
    const before: PageProbe = { id: 'before', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000, async run(ctx) { pre = await ctx.page.evaluate(read, undefined); return []; } };
    const after: PageProbe = { id: 'after', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000, async run(ctx) { post = await ctx.page.evaluate(read, undefined); return []; } };
    // Its content wait off: a test that waits would run after `after` on a shared page (runner `waitersLater`).
    await runProbes(B(), [{ url: `${server.origin}/translate.html`, index: 0 }], [before, { ...overlaysProbe, isolate: false, waitFor: undefined }, after], OPTS);
    expect(pre[1]).toBe(1280);
    expect(post).toEqual(pre);
  }, 60_000);

  it('leaves no change for the next test: content added on scroll and a panel opened by focus stay on its own page', async () => {
    let seen: unknown[] = [];
    const next: PageProbe = {
      id: 'next', criteria: ['0.0.1'], kind: 'render', tier: 'core', timeoutMs: 5000,
      async run(ctx) { seen = await ctx.page.evaluate(() => [document.querySelectorAll('.more').length, document.getElementById('panel')!.hidden, scrollY, innerWidth], undefined); return []; },
    };
    // The page grows when scrolled to its end and opens a panel when its link is focused: the probe does both.
    // (Its content wait off, so it runs before `next` as in registry order: runner `waitersLater`.)
    const [own] = await runProbes(B(), [{ url: `${server.origin}/grows.html`, index: 0 }], [{ ...overlaysProbe, isolate: false, waitFor: undefined }, next], OPTS);
    expect(own!.status).toBe('ok');
    expect(seen.slice(0, 2), 'the fixture changes when the probe shares the page').not.toEqual([0, true]);
    await runProbes(B(), [{ url: `${server.origin}/grows.html`, index: 0 }], [overlaysProbe, next], OPTS);
    expect(seen).toEqual([0, true, 0, 1280]);
  }, 60_000);
});

describe('overlays: an unfinished sweep never fails a control it did not check (1.4.10)', () => {
  type Arg = { maxSteps: number; verify: number; maxControls: number; area: boolean; grid: readonly [number, number]; budgetMs: number; until: number; sentAt: number };
  type Cov = { control: number; path: string; at: number; reachable: boolean | null };
  type Sw = { covers: Cov[]; cut: unknown; steps: number };
  const sweepOn = async (path: string, arg: (now: number) => Partial<Arg>): Promise<{ sweep: Sw; ms: number }> => {
    const context = await browser.newContext({ viewport: { width: 320, height: 256 } });
    try {
      const page = await context.newPage();
      await page.goto(`${server.origin}${path}`);
      await page.waitForTimeout(300);
      expect(await page.evaluate(installOverlayKit, { opaque: 0.9, barHeight: 1 / 3, barWidth: 0.9, dialogShare: 0.5, areaLow: 0.2 })).toBe(true);
      const t0 = Date.now();
      const full: Arg = { maxSteps: 16, verify: OVERLAY_LIMITS.verify, maxControls: 3000, area: true, grid: [16, 12], budgetMs: 60_000, until: t0 + 60_000, sentAt: t0, ...arg(t0) };
      const sweep = await page.evaluate((a) => (window as unknown as { __grntedOverlay: { sweep(x: unknown): Promise<Sw> } }).__grntedOverlay.sweep(a), full);
      return { sweep, ms: Date.now() - t0 };
    } finally {
      await context.close();
    }
  };
  const fails = (c: Cov) => c.at === 0 || c.reachable === false;

  it('a confirming sweep that runs out of time takes nothing away: a slow run reports the failure a fast run does', async () => {
    // The widget covers the page's last link wherever it is scrolled (the page never makes room for
    // it): only the re-check after the sweep shows it is never clear, so a sweep cut for time cannot
    // confirm it. Fast: both sweeps finish.
    const [fast] = await run('/late-padding.html?late=60000&run=fast');
    expect(failed(fast!)).toEqual([['1.4.10', '#powered']]);
    // How many scroll events one sweep at 320 px makes on this page; after that many every scroll
    // takes 1.5 s, so the probe's second sweep (and every one after) runs out of time.
    const context = await browser.newContext({ viewport: { width: 320, height: 256 } });
    let count = 0;
    try {
      const page = await context.newPage();
      await page.goto(`${server.origin}/late-padding.html?late=60000`);
      await page.waitForTimeout(300);
      await page.evaluate(installOverlayKit, { opaque: 0.9, barHeight: 1 / 3, barWidth: 0.9, dialogShare: 0.5, areaLow: 0.2 });
      const t0 = Date.now();
      const full: Arg = { maxSteps: 16, verify: OVERLAY_LIMITS.verify, maxControls: 3000, area: true, grid: [16, 12], budgetMs: 60_000, until: t0 + 60_000, sentAt: t0 };
      const one = await page.evaluate((a) => (window as unknown as { __grntedOverlay: { sweep(x: unknown): Promise<Sw> } }).__grntedOverlay.sweep(a), full);
      expect(one.cut).toBe(false);
      count = await page.evaluate(() => (window as unknown as { __scrolls: number }).__scrolls);
    } finally {
      await context.close();
    }
    expect(count).toBeGreaterThan(3);
    const [slow] = await run(`/late-padding.html?late=60000&slowafter=${count}&slow=1500`);
    expect(slow!.status, JSON.stringify(slow!.findings)).toBe('ok');
    expect(failed(slow!)).toEqual([['1.4.10', '#powered']]);
  }, 120_000);

  it('checks every covered link that it can within its limits: many links scrolled clear are not failures', async () => {
    const [r] = await run('/many-covered.html');
    expect(r!.status, JSON.stringify(r)).toBe('ok');
    expect(r!.findings.filter((f) => f.criterion === '1.4.10')).toEqual([]);
  }, 60_000);

  it('a link that is never clear still fails, alone', async () => {
    const [r] = await run('/many-covered.html?trap=1');
    expect(r!.status).toBe('ok');
    const f = r!.findings.filter((x) => x.criterion === '1.4.10');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: 'failed', target: '#donate' });
    expect(f[0]!.detail).toMatch(/covers the link “Donate” wherever the page is scrolled\. It cannot be closed: nothing in it that closes it can be reached with the keyboard\.$/);
  }, 60_000);

  it('a slow page gives the same verified results or unknown, never a different failure', async () => {
    const fast = await sweepOn('/many-covered.html?trap=1', () => ({}));
    expect(fast.sweep.cut).toBeFalsy();
    const fastFails = new Set(fast.sweep.covers.filter(fails).map((c) => c.path));
    expect([...fastFails]).toEqual(['#donate']);
    // Every scroll takes 250 ms: the sweep runs out of time part way.
    const slow = await sweepOn('/many-covered.html?trap=1&slow=250', (now) => ({ budgetMs: 1500, until: now + 2500 }));
    expect(slow.sweep.cut).toBeTruthy();
    for (const c of slow.sweep.covers) {
      const same = fast.sweep.covers.find((x) => x.path === c.path);
      if (c.reachable !== null) expect(c.reachable, c.path).toBe(same?.reachable);
      if (fails(c)) expect(fastFails.has(c.path), c.path).toBe(true);
    }
  }, 60_000);

  it('the probe gives not_testable, not a failure, when a slow page cuts the sweep', async () => {
    const [r] = await run('/many-covered.html?slow=400');
    const f = r!.findings.filter((x) => x.criterion === '1.4.10');
    expect(f.map((x) => x.status)).not.toContain('failed');
    if (r!.status === 'ok') expect(f.map((x) => x.status)).toEqual(['not_testable']);
  }, 90_000);

  it('stops itself at its deadline, also inside one scroll position (slow hit tests)', async () => {
    // 10 links on the first screen and 120 ms per hit test: one scroll position takes over 6 s.
    const { sweep, ms } = await sweepOn('/many-covered.html?top=10&slowhit=120', (now) => ({ until: now + 400 }));
    expect(sweep.cut).toBeTruthy();
    expect(ms).toBeLessThan(2000);
  }, 60_000);

  it('stops in time on a page that fakes its clock', async () => {
    const { sweep, ms } = await sweepOn('/many-covered.html?top=10&slowhit=120&clock=1', (now) => ({ until: now + 400 }));
    expect(sweep.cut).toBeTruthy();
    expect(ms).toBeLessThan(2000);
  }, 60_000);
});

describe('overlays: a dialog does not excuse covering a control (1.4.10)', () => {
  it('fails a chat widget marked up as a dialog, with a close button, that covers a link at 320 px', async () => {
    const [r] = await run('/chat-dialog.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings.find((x) => x.criterion === '1.4.10')).toMatchObject({ status: 'failed', target: '#apply' });
  }, 60_000);
});

describe('overlays: controls the screen cannot hold whole (1.4.10)', () => {
  const sweepAt = async (path: string) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 256 } });
    try {
      const page = await context.newPage();
      await page.goto(`${server.origin}${path}`);
      await page.waitForTimeout(300);
      expect(await page.evaluate(installOverlayKit, { opaque: 0.9, barHeight: 1 / 3, barWidth: 0.9, dialogShare: 0.5, areaLow: 0.2 })).toBe(true);
      const t0 = Date.now();
      const arg = { maxSteps: 16, verify: OVERLAY_LIMITS.verify, maxControls: 3000, area: true, grid: [16, 12], budgetMs: 60_000, until: t0 + 60_000, sentAt: t0 };
      type Sw = { covers: { path: string; at: number; reachable: boolean | null }[]; cut: unknown };
      return await page.evaluate((a) => (window as unknown as { __grntedOverlay: { sweep(x: unknown): Promise<Sw> } }).__grntedOverlay.sweep(a), arg);
    } finally {
      await context.close();
    }
  };

  it('a link taller than the 320×256 screen whose covered corner scrolls clear is not a failure', async () => {
    const sw = await sweepAt('/tall-link.html');
    // Its corners under the chat button are no cover at all now (a corner leaves it readable and usable); any cover recorded is reachable.
    const tile = sw.covers.filter((c) => c.path === '#tile');
    expect(tile.every((c) => c.reachable === true), JSON.stringify(sw)).toBe(true);
    const [r] = await run('/tall-link.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.criterion === '1.4.10')).toEqual([]);
  }, 60_000);

  // 2026-11-07 real-site audit (beaverton-sd:013/014): a box over a corner or one side of a link leaves it readable and usable.
  it('a tall link whose right edge a narrow panel covers wherever the page is scrolled is not a failure: its middle shows', async () => {
    const [r] = await run('/tall-link.html?side=1');
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((x) => x.criterion === '1.4.10' && x.status === 'failed'), JSON.stringify(r!.findings)).toEqual([]);
  }, 60_000);

  it('a link the window cannot scroll onto the screen (inside a box that scrolls by itself) is unknown, not a failure', async () => {
    const sw = await sweepAt('/scroll-panel.html');
    const news = sw.covers.filter((c) => c.path === '#news');
    expect(news.length, JSON.stringify(sw)).toBeGreaterThan(0);
    expect(news.every((c) => c.at > 0 && c.reachable === null), JSON.stringify(news)).toBe(true);
    const [r] = await run('/scroll-panel.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.criterion === '1.4.10' && f.status === 'failed')).toEqual([]);
  }, 60_000);
  it('a link clipped by the box it scrolls in, so no try can hit it, is unknown, not a failure', async () => {
    const sw = await sweepAt('/clip-panel.html');
    const news = sw.covers.filter((c) => c.path === '#news');
    expect(news.length, JSON.stringify(sw)).toBeGreaterThan(0);
    expect(news.every((c) => c.at > 0 && c.reachable === null), JSON.stringify(news)).toBe(true);
    const [r] = await run('/clip-panel.html');
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.criterion === '1.4.10' && f.status === 'failed')).toEqual([]);
  }, 60_000);
});

// Scoring v11 (review r1 of fix/redteam-visual, finding 7): WCAG 1.4.10 fails content that is lost or needs
// scrolling in two directions at 320 px. A control covered as the page opens that scrolling brings clear, and a
// fixed header over much of the screen with the content reachable below it, lose nothing.
describe('overlays (1.4.10): only what is lost at 320 px fails', () => {
  it('does not fail a floating button over a link that scrolling brings clear: a recommendation', async () => {
    const [r] = await run('/float-over-link.html');
    expect(r!.status).toBe('ok');
    expect(failed(r!).filter(([c]) => c === '1.4.10'), JSON.stringify(r!.findings)).toEqual([]);
    expect(r!.findings.filter((f) => f.criterion === '1.4.10'), JSON.stringify(r!.findings)).toEqual([expect.objectContaining({
      status: 'no_failures_found', advice: true, target: '#buy', detail: expect.stringMatching(/covers the link “Buy a day ticket” on the first screen, as the page opens; scrolling the page brings it clear\. Recommended: /),
    })]);
  }, 60_000);

  it('does not fail a 120 px fixed header (about half of a 320×256 screen) with the content padded below it and all of it reachable: a recommendation', async () => {
    const [r] = await run('/fixed-header-padded.html');
    expect(r!.status).toBe('ok');
    expect(failed(r!).filter(([c]) => c === '1.4.10'), JSON.stringify(r!.findings)).toEqual([]);
    expect(r!.findings.filter((f) => f.criterion === '1.4.10'), JSON.stringify(r!.findings)).toEqual([expect.objectContaining({
      status: 'no_failures_found', advice: true, target: '#bar', detail: expect.stringMatching(/covers (4\d|5\d)% of the screen; the content can be scrolled clear of it\./),
    })]);
  }, 60_000);

  it('look-alikes still fail: the same button over a link fixed under it, and the same header over text on a page that cannot scroll', async () => {
    const [link, text] = await run('/float-over-fixed-link.html', '/fixed-header-over-text.html');
    expect(failed(link!).filter(([c]) => c === '1.4.10'), JSON.stringify(link!.findings)).toEqual([['1.4.10', '#buy']]);
    expect(link!.findings.find((f) => f.status === 'failed' && f.criterion === '1.4.10')!.detail).toMatch(/covers the link “Buy a day ticket” wherever the page is scrolled/);
    expect(failed(text!).filter(([c]) => c === '1.4.10'), JSON.stringify(text!.findings)).toEqual([['1.4.10', '#bar']]);
    expect(text!.findings.find((f) => f.status === 'failed' && f.criterion === '1.4.10')!.detail).toMatch(/covers (4\d|5\d)% of the screen, and some of the page's text stays under it wherever the page is scrolled/);
  }, 90_000);
});

// 2026-11-07 ruling (Understanding 1.4.10: dismissing is the remedy for sticky or fixed content): a box the test
// closes by keyboard, and that stays closed, passes at any size; the reason it cannot be closed is in the finding.
describe('overlays: a floating box passes 1.4.10 once the test closes it by keyboard', () => {
  it('a panel over three quarters of the screen whose Close button works passes, with no remark', async () => {
    const [r] = await run('/close-proof.html?mode=works');
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((x) => x.criterion === '1.4.10' && (x.status === 'failed' || x.advice)), JSON.stringify(r!.findings)).toEqual([]);
  }, 60_000);

  // Scoring v11: the panel leaves a strip the content scrolls through, so nothing is lost: no 1.4.10 failure. The
  // recommendation says why it cannot be closed.
  for (const [mode, why] of [['broken', /does not close it/], ['mouse', /nothing in it that closes it can be reached with the keyboard/], ['returns', /comes back right after it is closed/]] as const) {
    it(`a panel that cannot be closed (${mode}) is a recommendation with the reason, not a 1.4.10 failure`, async () => {
      const [r] = await run(`/close-proof.html?mode=${mode}`);
      expect(r!.status).toBe('ok');
      expect(r!.findings.filter((x) => x.criterion === '1.4.10' && x.status === 'failed'), JSON.stringify(r!.findings)).toEqual([]);
      const f = r!.findings.find((x) => x.criterion === '1.4.10' && x.advice);
      expect(f, JSON.stringify(r!.findings)).toBeDefined();
      expect(f!.detail).toMatch(/covers \d\d% of the screen; the content can be scrolled clear of it\./);
      expect(f!.detail).toMatch(why);
    }, 60_000);
  }
});

describe('overlays: one rule for every box, dialogs included: closed by keyboard or measured (1.4.10)', () => {
  // 2026-11-07: the area rule is more than 40% of the screen; the old excuse for a dialog under half the screen is
  // gone (a box that the test closes by keyboard passes at any size). These promotions' Close buttons do nothing.
  it('a promotion painting about 40% of the screen, whose OK or Close button does nothing, is judged by its size alone', async () => {
    for (const q of ['', '?self=1']) {
      const [r] = await run(`/promo-dialog.html${q}`);
      expect(r!.status).toBe('ok');
      expect(r!.findings.filter((x) => x.criterion === '1.4.10' && x.status === 'failed'), q).toEqual([]);
      const f = r!.findings.filter((x) => x.criterion === '1.4.10' && x.advice && /% of the screen/.test(x.detail));
      for (const x of f) expect(x.detail, q).toMatch(/covers (4\d)% of the screen; the content can be scrolled clear of it\. Recommended: .* It cannot be closed now: pressing Enter or Space on its “(Close|OK)” control does not close it\.$/);
    }
  }, 60_000);

  it('a dialog first painting 40% that grows to 70% fails at 70%: text of the page stays under it wherever the page is scrolled', async () => {
    const [r] = await run('/promo-dialog.html?self=1&grow=1');
    expect(r!.status).toBe('ok');
    const f = r!.findings.find((x) => x.criterion === '1.4.10');
    expect(f, JSON.stringify(r!.findings)).toMatchObject({ status: 'failed', target: '#promo' });
    expect(f!.detail).toMatch(/covers (6\d|7\d)% of the screen, and some of the page's text stays under it wherever the page is scrolled\. It cannot be closed: .+\.$/);
  }, 60_000);
});

describe('overlays evidence', () => {
  type ShotOpts = { type?: string; clip?: { x: number; y: number; width: number; height: number } };
  function spy() {
    const pngs: { jpeg: Uint8Array; png: Uint8Array }[] = [];
    const wrapped = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const context = await browser.newContext(o);
        const newPage = context.newPage.bind(context);
        return Object.assign(context, {
          async newPage() {
            const page = await newPage();
            const real = page.screenshot.bind(page);
            return Object.assign(page, {
              async screenshot(opts?: ShotOpts) {
                const out = await real(opts as Parameters<Page['screenshot']>[0]);
                if (opts?.type === 'jpeg') pngs.push({ jpeg: out, png: await real({ type: 'png', ...(opts.clip ? { clip: opts.clip } : {}) }) });
                return out;
              },
            });
          },
        });
      },
    };
    return { browser: wrapped as unknown as BrowserLike, pngFor: (jpeg: Uint8Array) => pngs.find((x) => Buffer.from(x.jpeg).equals(Buffer.from(jpeg)))?.png };
  }

  it('pictures the translate widget boxed and the covered link boxed, at 320 px wide', async () => {
    const { decodePng } = await import('../../src/probes/pixels.js');
    const bytes = new Map<string, Uint8Array>();
    const rec = createEvidenceRecorder({ sink: (id, b) => { bytes.set(id, b); } });
    const s = spy();
    const runs = await runProbes(s.browser, [{ url: `${server.origin}/translate.html`, index: 2 }], [overlaysProbe], { userAgent: 'grnted-test', evidence: rec });
    expect(runs[0]!.findings.some((f) => f.criterion === '1.4.10' && f.status === 'failed')).toBe(true);
    const shots: EvidenceShot[] = rec.shots().filter((x) => 'criterion' in x.for && x.for.criterion === '1.4.10');
    expect(shots).toHaveLength(1);
    const shot = shots[0]!;
    expect([shot.width, shot.height]).toEqual([320, 256]);
    expect(shot.caption).toBe('A floating “English” translate widget covers the link “Registration” at 320 px wide');
    expect(shot.boxes.map((b) => b.kind)).toEqual(['fail', 'ghost']);
    expect(shot.for).toMatchObject({ criterion: '1.4.10', probe: 'overlays', target: '#registration' });
    // The fail box is on the magenta widget.
    const img = await decodePng(s.pngFor(bytes.get(shot.id)!)!);
    const b = shot.boxes[0]!;
    let yes = 0;
    let all = 0;
    for (let y = Math.ceil(b.y) + 2; y < Math.floor(b.y + b.height) - 2; y++) {
      for (let x = Math.ceil(b.x) + 2; x < Math.floor(b.x + b.width) - 2; x++) {
        const i = (y * img.width + x) * 4;
        all++;
        if (img.data[i]! > 220 && img.data[i + 1]! < 60 && img.data[i + 2]! > 220) yes++;
      }
    }
    expect(yes / all).toBeGreaterThan(0.5);
    // The covered link sits inside the widget's box.
    const g = shot.boxes[1]!;
    expect(g.x).toBeGreaterThanOrEqual(b.x - 1);
    expect(g.x + g.width).toBeLessThanOrEqual(b.x + b.width + 1);
  }, 60_000);
});
