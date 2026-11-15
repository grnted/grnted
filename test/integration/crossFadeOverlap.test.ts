// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.10: two slides of a slideshow in the middle of a cross-fade, in real Chromium. For the length of the
// fade both captions are on screen in the same place, and the reflow test read that as "text overlaps other
// text" at 320 px whenever its narrow measurement landed inside a fade: a failure that came and went with the
// moment of the measurement (on the engine's own fixture site it was there in two scans of three). The slide a
// running transition is taking to nothing is on its way out, not content laid over other content: it is now
// read as what it is becoming.
// The first page fails on every run without that: its slideshow moves on when the window is resized, with a
// slow fade, so the narrow measurement is always inside the fade.
// Look-alikes that still fail: the same slideshow when the outgoing slide stays half visible over the new one
// (the overlap lasts), and two labels that collide at 320 px with no fade at all.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reflowProbe } from '../../src/probes/reflow.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const SHOW = `<div class="show"><div class="slide on" id="s1"><p>Lifeboat day: the station opens its doors on Sunday.</p></div><div class="slide" id="s2"><p>Regatta week: entries close on the first of June.</p></div></div>`;
// The slideshow moves to its next slide when the window changes size.
const NEXT = `<script>addEventListener('resize', function () { var a = document.getElementById('s1'), b = document.getElementById('s2'); if (!a.classList.contains('on')) return; a.classList.remove('on'); a.classList.add('was'); b.classList.add('on'); });</script>`;
const doc = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbour events</title>
<style>body { font: 16px/24px sans-serif; margin: 24px; } .show { position: relative; height: 160px; border: 1px solid #555; } .slide { position: absolute; inset: 0; opacity: 0; transition: opacity 30s linear; } .slide.on { opacity: 1; } .slide p { position: absolute; left: 12px; right: 12px; bottom: 12px; margin: 0; } ${css}</style></head>
<body><main><h1>Harbour events</h1>${body}<p>The harbour office posts new events each Monday.</p></main></body></html>`;

const PAGES: Record<string, string> = {
  fade: doc('', SHOW + NEXT),
  // The slide that was shown stays half visible over the new one.
  half: doc('.slide.was { opacity: .5; }', SHOW + NEXT),
  // Two labels side by side that land on each other on a narrow screen.
  still: doc('.pair { position: relative; height: 60px; } .pair span { position: absolute; top: 8px; white-space: nowrap; } #one { left: 0; } #two { left: 50%; } @media (max-width: 400px) { #two { left: 24px; } }',
    '<div class="pair"><span id="one">Ferry tickets and day passes</span><span id="two">Mooring fees and berths</span></div>'),
  // Review r2, finding 4: a fade that has not begun (it waits an hour) hides nothing yet. The teaser is cut off at 320 px now.
  later: doc('.teaser { height: 24px; overflow: hidden; margin: 0; animation: leave 1s linear 3600s forwards; } @keyframes leave { from { opacity: 1; } to { opacity: 0; } }',
    '<p class="teaser" id="teaser">The harbour board agreed on Tuesday to rebuild the east quay steps before the summer ferry season, after two winters of storm damage.</p>'),
};

let runs: Record<string, ProbeRun>;
beforeAll(async () => {
  const sim = await startSimServer({ files: Object.fromEntries(Object.entries(PAGES).map(([name, html]) => [`/${name}`, html])) });
  try {
    const all = await runProbes(browser as unknown as BrowserLike, Object.keys(PAGES).map((name, index) => ({ url: `${sim.origin}/${name}`, index })), [reflowProbe], { userAgent: 'grnted-test', full: true });
    runs = Object.fromEntries(all.map((r) => [new URL(r.page).pathname.slice(1), r]));
  } finally {
    await sim.close();
  }
}, 120_000);
const failed = (name: string) => runs[name]!.findings.filter((f) => f.status === 'failed').map((f) => f.detail);
const text = (name: string) => JSON.stringify(runs[name]!.findings);

describe('reflow (1.4.10): slides in the middle of a cross-fade', () => {
  it('does not fail the caption of a slide that is fading out over the caption of the next', () => {
    expect(failed('fade'), text('fade')).toEqual([]);
    expect(runs.fade!.status).toBe('ok');
  });

  it('look-alike: an outgoing slide that stays half visible over the new one still fails (the overlap lasts)', () => {
    expect(failed('half'), text('half')).toEqual([expect.stringMatching(/^At 320 px wide, text overlaps other text/)]);
  });

  it('still measures content whose fade has not begun: a teaser cut off at 320 px fails although it will fade out in an hour', () => {
    expect(runs.later!.findings.filter((f) => f.status === 'failed').map((f) => f.target), text('later')).toEqual(['#teaser']);
  });

  it('look-alike: two labels that land on each other at 320 px, with no fade, still fail', () => {
    expect(failed('still'), text('still')).toEqual([expect.stringMatching(/^At 320 px wide, text overlaps other text/)]);
  });
});
