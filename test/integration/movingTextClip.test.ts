// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.4, 1.4.10 and 1.4.12: text that an animation carries through a window that clips it (a ticker), in
// real Chromium. At any one instant part of such a line is outside its window, so the layout tests read it as
// "cut off by its container" or not depending on where the animation happened to be when they looked: the same
// page failed on one run and passed on the next. Nothing is lost when the animation shows every part of the line
// in turn (WCAG 1.4.4: "without loss of content or functionality"; whether it may keep moving is 2.2.2's
// question), so the test now follows the running animation through one cycle and counts the text as cut off only
// when some part of it is never shown.
// The first page fails on every run without that (the line fits its window at the desktop width at every
// moment, and never fits it at 200%).
// Look-alikes that still fail: the same line moved only a few pixels (its end is never shown), and the same
// animation paused (the text is judged as it stands). Text that SEVERAL animations move at once is not followed:
// each has its own clock, so points taken along each say nothing about where the text is (review r2, finding 3);
// it is not testable. A line that runs in from one side and out at the other,
// and a <marquee>, are not failed either. Animations and transitions that change only colours (colour, background,
// border, outline, a shadow's colour, an opacity that stays above nothing) move no text: they make nothing
// "moved by several animations" (batch 15b gold hazard hazard-focus-hover-transition: every keyframe carries an
// `offset` key, which the moving-property pattern took for the motion-path property).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAYOUT_LIMITS, textLayout } from '../../src/probes/layout.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { runProbes } from '../../src/probes/runner.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

// 61 characters in a monospace face at 20 px: about 735 px on every machine. That fits the window at the desktop
// width (1230 px), and is wider than it at 200% (590 px) by less than half: a track more than one and a half
// times its window is taken for a carousel and was never counted.
const LINE = 'High water at the east quay is 14:20; ferries run until dusk.';
const doc = (css: string, strip = `<div class="strip" id="strip"><p class="line" id="line">${LINE}</p></div>`) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbour notices</title>
<style>body { font: 16px/24px sans-serif; margin: 24px; } .strip { overflow: hidden; border: 1px solid #555; } .line, marquee { font: 20px/28px monospace; } .line { position: relative; margin: 0; padding: 8px 0; width: max-content; white-space: nowrap; } ${css}</style></head>
<body><main><h1>Harbour notices</h1>${strip}<p>Notices are updated by the harbour office each morning.</p></main></body></html>`;

const PAGES: Record<string, string> = {
  // Slides between the left and the right edge of its window: every part of the line is shown in turn.
  pingpong: doc('.line { animation: slide 6s linear infinite alternate; } @keyframes slide { from { left: 0; transform: translateX(0); } to { left: 100%; transform: translateX(-100%); } }'),
  // Runs in from the right and out at the left.
  through: doc('.line { animation: run 8s linear infinite; } @keyframes run { from { left: 100%; transform: translateX(0); } to { left: 0; transform: translateX(-100%); } }'),
  marquee: doc('marquee { padding: 8px 0; display: block; }', `<marquee id="strip">${LINE}</marquee>`),
  // Moves six pixels to and fro: at 200% the end of the line is never shown.
  wiggle: doc('.line { animation: nudge 2s linear infinite alternate; } @keyframes nudge { from { transform: translateX(0); } to { transform: translateX(-6px); } }'),
  // Review r2, finding 3: two wrappers sway the same distance in opposite directions (the inner one a half cycle
  // behind), so the line never moves. Followed one by one, the two animations would seem to show every part of it.
  cancel: doc('.half { width: 46vw; } .sway { animation: sway 2s linear infinite; } .sway.inner { animation-delay: -1s; } @keyframes sway { 0% { transform: translateX(-150px); } 50% { transform: translateX(150px); } 100% { transform: translateX(-150px); } }',
    '<div class="strip half" id="strip"><div class="sway"><div class="sway inner"><p class="line" id="line">Ferries run until dusk today.</p></div></div></div>'),
  paused: doc('.line { animation: slide 6s linear infinite alternate paused; } @keyframes slide { from { left: 0; transform: translateX(0); } to { left: 100%; transform: translateX(-100%); } }'),
  // The same still line under two animations that change only colours (the line's ink, its window's paper): at 200%
  // its end is cut off and never shown, as on a still page.
  colours: doc('.line { animation: ink 3s linear infinite alternate; } .strip { animation: paper 3s linear infinite alternate; } @keyframes ink { from { color: #1b1b1b; } to { color: #3a3a3a; } } @keyframes paper { from { background-color: #ffffff; } to { background-color: #f2f2f2; } }'),
};

let runs: Record<string, ProbeRun[]>;
beforeAll(async () => {
  const sim = await startSimServer({ files: Object.fromEntries(Object.entries(PAGES).map(([name, html]) => [`/${name}`, html])) });
  try {
    const all = await runProbes(browser as unknown as BrowserLike, Object.keys(PAGES).map((name, index) => ({ url: `${sim.origin}/${name}`, index })), [reflowProbe, resizeTextProbe, textSpacingProbe], { userAgent: 'grnted-test', full: true });
    runs = {};
    for (const r of all) (runs[new URL(r.page).pathname.slice(1)] ??= []).push(r);
  } finally {
    await sim.close();
  }
}, 240_000);
const failedOn = (name: string) => runs[name]!.flatMap((r) => r.findings.filter((f) => f.status === 'failed').map((f) => `${f.criterion} ${f.target ?? ''}`)).sort();
const text = (name: string) => JSON.stringify(runs[name]!.map((r) => [r.probe, r.status, r.findings]));

describe('layout tests: text an animation carries through its window', () => {
  it('does not fail a line that slides to and fro in its window and shows every part of itself in turn', () => {
    expect(failedOn('pingpong'), text('pingpong')).toEqual([]);
  });

  it('does not fail a line that runs in at one side and out at the other, nor a <marquee>', () => {
    expect(failedOn('through'), text('through')).toEqual([]);
    expect(failedOn('marquee'), text('marquee')).toEqual([]);
  });

  it('look-alike: the same line moved only six pixels still fails (its end is never shown at 200%)', () => {
    expect(failedOn('wiggle'), text('wiggle')).toEqual(expect.arrayContaining([expect.stringMatching(/^1\.4\.4 /)]));
  });

  it('does not take text that two animations move at once for shown in turn: 1.4.4 is not testable there, never clean and never failed', () => {
    expect(failedOn('cancel'), text('cancel')).toEqual([]);
    const undecided = runs.cancel!.flatMap((r) => r.findings.filter((f) => f.status === 'not_testable').map((f) => `${f.criterion}: ${f.detail}`));
    expect(undecided, text('cancel')).toEqual(expect.arrayContaining([expect.stringMatching(/^1\.4\.4: At 200% browser zoom .*text that several animations move at the same time is cut off by its container/)]));
  });

  it('animations that change only colours move no text: the still line is judged as it stands and fails 1.4.4, never "not testable"', () => {
    expect(failedOn('colours'), text('colours')).toEqual(expect.arrayContaining([expect.stringMatching(/^1\.4\.4 /)]));
    const undecided = runs.colours!.flatMap((r) => r.findings.filter((f) => f.status === 'not_testable' && /several animations/.test(f.detail)).map((f) => `${f.criterion}: ${f.detail}`));
    expect(undecided, text('colours')).toEqual([]);
  });

  it('transitions under way that change only colours (and an opacity that stays) leave a cut line measured as cut, not "moved by several animations"', async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 450 } });
    try {
      await page.setContent(doc('.line, .strip { transition: color 60s linear, background-color 60s linear, border-color 60s linear, outline-color 60s linear, box-shadow 60s linear, opacity 60s linear; outline: 2px solid #ffffff; box-shadow: 0 0 0 1px #ffffff; } .on .line, .on.strip { color: #3a3a3a; background-color: #f2f2f2; border-color: #222222; outline-color: #222222; box-shadow: 0 0 0 1px #222222; opacity: 0.9; }'));
      // Start every transition, then let them get under way.
      const running = await page.evaluate(async () => {
        document.getElementById('strip')!.classList.add('on');
        await new Promise((r) => setTimeout(r, 100));
        return document.getAnimations().filter((a) => a.playState === 'running').length;
      });
      expect(running).toBeGreaterThanOrEqual(4);
      const layout = await page.evaluate(textLayout, { phase: 'start' as const, ...LAYOUT_LIMITS });
      const i = [...layout.kinds].findIndex((k, n) => k === 't' && layout.before.items[n]!.fs === 20);
      expect(layout.before.items[i]).toMatchObject({ v: 1, cut: 1 });
      expect(layout.before.items[i]!.mv).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 60_000);

  it('look-alike: the same sliding animation, paused, is judged as it stands and still fails', () => {
    expect(failedOn('paused'), text('paused')).toEqual(expect.arrayContaining([expect.stringMatching(/^1\.4\.4 /)]));
  });

  it('reads the line as not cut off at any moment of its cycle, and leaves the animation running where it was', async () => {
    const sim = await startSimServer({ files: { '/pingpong': PAGES.pingpong!, '/wiggle': PAGES.wiggle! } });
    const context = await browser.newContext({ viewport: { width: 640, height: 450 } });
    try {
      const page = await context.newPage();
      const lineOf = async (name: string, atMs: number) => {
        await page.goto(`${sim.origin}/${name}`);
        // Put the animation at a chosen moment, then measure.
        const before = await page.evaluate((t) => { const a = document.getAnimations()[0]!; a.currentTime = t; return Number(a.currentTime); }, atMs);
        const layout = await page.evaluate(textLayout, { phase: 'start' as const, ...LAYOUT_LIMITS });
        const after = await page.evaluate(() => { const a = document.getAnimations()[0]!; return { t: Number(a.currentTime), state: a.playState }; });
        const i = [...layout.kinds].findIndex((k, n) => k === 't' && layout.before.items[n]!.fs === 20);
        return { item: layout.before.items[i]!, before, after };
      };
      for (const at of [0, 700, 2900, 5300]) {
        const { item, before, after } = await lineOf('pingpong', at);
        expect(item, `at ${at} ms`).toMatchObject({ v: 1, cut: 0, mv: 1 });
        expect(after.state).toBe('running');
        // Only the time the measurement itself took has passed.
        expect(after.t - before, `at ${at} ms`).toBeGreaterThanOrEqual(0);
        expect(after.t - before, `at ${at} ms`).toBeLessThan(1500);
      }
      const still = await lineOf('wiggle', 300);
      expect(still.item).toMatchObject({ v: 1, cut: 1 });
      expect(still.item.mv).toBeUndefined();
    } finally {
      await context.close();
      await sim.close();
    }
  }, 60_000);

  it('gives the same result on a second run (it does not depend on where the animation is)', async () => {
    const sim = await startSimServer({ files: { '/pingpong': PAGES.pingpong!, '/through': PAGES.through! } });
    try {
      const again = await runProbes(browser as unknown as BrowserLike, ['pingpong', 'through'].map((name, index) => ({ url: `${sim.origin}/${name}`, index })), [reflowProbe, resizeTextProbe, textSpacingProbe], { userAgent: 'grnted-test', full: true });
      expect(again.flatMap((r) => r.findings.filter((f) => f.status === 'failed')), JSON.stringify(again.map((r) => r.findings))).toEqual([]);
    } finally {
      await sim.close();
    }
  }, 120_000);
});
