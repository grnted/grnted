// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D4 (docs/atlas/visual.md): text lost at some window widths only. A box with a fixed height and
// hidden overflow that fits at the widths the resize and spacing tests used to look at (1280, 640) and loses text at
// another width fails: 1.4.4 when 200% zoom in a window 2W wide cuts it and 100% there does not; 1.4.12 when the WCAG
// spacing cuts it at a desktop width. Look-alikes keep passing: a scrolling box, a box with a minimum height, a box
// with a "Read more" link, an ellipsis, and a fixed box whose text fits at every width.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import type { PageProbe } from '../../src/probes/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Street repair</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 0; color: #222; background: #fff; } main { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
.box { height: 96px; overflow: hidden; padding: 0 8px; border: 1px solid #777; } .box p { margin: 0; line-height: 24px; }
${css}</style></head><body><main><h1>Street repair</h1><p>Crews inspect reported hazards and schedule work.</p>${body}</main></body></html>`;
const TEXT = 'Move parked vehicles before 8 a.m. and keep the block clear until the crew has removed its signs.';

async function run(html: string, probe: PageProbe): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('D4: text lost at some window widths only', () => {
  it('1.4.4 with a control near the box (the resize test\'s rule): whole lines hidden are never failed, a line cut through still is', async () => {
    const sweep = (r: ProbeRun) => failed(r).filter((f) => /At 200% zoom in a window/.test(f.detail ?? ''));
    const PRINT = '<p><button type="button" onclick="print()">Print page</button></p>';
    // From 700 to 760 CSS px the lines grow to 48 px: the box shows two whole lines and hides the rest whole.
    const whole = '@media (min-width: 700px) and (max-width: 760px) { .box p { font-size: 22px; line-height: 48px; } }';
    const alone = await run(page(whole, `<aside class="box" id="brief"><p>${TEXT} ${TEXT}</p></aside>`), resizeTextProbe);
    expect(sweep(alone).map((f) => f.target), JSON.stringify(alone.findings)).toEqual(['#brief']);
    const near = await run(page(whole, `<aside class="box" id="brief"><p>${TEXT} ${TEXT}</p></aside>${PRINT}`), resizeTextProbe);
    expect(sweep(near), JSON.stringify(near.findings)).toEqual([]);
    // Lines of 40 px: the third is cut through by the box's edge, which no control can scroll away.
    const cut = await run(page('@media (min-width: 700px) and (max-width: 760px) { .box p { font-size: 22px; line-height: 40px; } }', `<aside class="box" id="brief"><p>${TEXT} ${TEXT}</p></aside>${PRINT}`), resizeTextProbe);
    expect(sweep(cut).map((f) => f.target), JSON.stringify(cut.findings)).toEqual(['#brief']);
  }, 180_000);

  it('1.4.4: fails a box that a breakpoint between the tested widths makes too small at 200% zoom', async () => {
    // Between 700 and 760 CSS px (200% in windows of 1400 to 1520 px) the text grows and needs a fifth line.
    const r = await run(page('@media (min-width: 700px) and (max-width: 760px) { .box p { font-size: 22px; line-height: 40px; } }', `<aside class="box" id="brief"><p>${TEXT} ${TEXT}</p></aside>`), resizeTextProbe);
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#brief']);
    // The first window width that cuts it is named (two sentences in a 96 px box are cut in narrow windows too).
    expect(failed(r)[0]!.detail).toMatch(/At 200% zoom in a window \d+ px wide/);
  }, 90_000);

  it('1.4.12: fails a box the spacing overflows at a laptop width, though it fits at 1280', async () => {
    const r = await run(page('.note { width: 520px; height: 108px; } @media (max-width: 1100px) { .note { width: 200px; } }', `<section class="box note" id="note"><p>${TEXT}</p></section>`), textSpacingProbe);
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#note']);
    expect(failed(r)[0]!.detail).toMatch(/window 1024 px wide/);
  }, 90_000);

  it('V95: 1.4.12 is measured through an author !important rule that would block the spacing (a person\'s own style wins)', async () => {
    const r = await run(page('.lock { height: 54px; width: 520px; } .lock p { line-height: 18px !important; letter-spacing: 0 !important; word-spacing: 0 !important; }', `<section class="box lock" id="lock"><p>${TEXT} ${TEXT}</p></section>`), textSpacingProbe);
    expect(failed(r).length, JSON.stringify(r.findings)).toBeGreaterThan(0);
    const ok = await run(page('.lock { height: 120px; width: 520px; } .lock p { line-height: 18px !important; letter-spacing: 0 !important; }', `<section class="box lock"><p>${TEXT}</p></section>`), textSpacingProbe);
    expect(failed(ok), JSON.stringify(ok.findings)).toEqual([]);
  }, 90_000);

  it('look-alikes pass: a scrolling box, a minimum height, a "Read more" link, an ellipsis, a box that fits everywhere', async () => {
    const bodies = [
      `<aside class="box" style="overflow:auto"><p>${TEXT} ${TEXT} ${TEXT}</p></aside>`,
      `<aside class="box" style="height:auto;min-height:96px"><p>${TEXT} ${TEXT} ${TEXT}</p></aside>`,
      `<aside class="box"><p>${TEXT} ${TEXT} ${TEXT}</p></aside><a href="/full">Read more</a>`,
      `<p style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:200px;height:24px">${TEXT}</p>`,
      `<aside class="box" style="height:200px"><p>${TEXT}</p></aside>`,
    ];
    for (const b of bodies) {
      for (const probe of [resizeTextProbe, textSpacingProbe]) {
        const r = await run(page('', b), probe);
        const mine = failed(r).filter((f) => /window \d+ px wide/.test(f.detail ?? ''));
        expect(mine, `${probe.id} ${b.slice(0, 80)}: ${JSON.stringify(r.findings)}`).toEqual([]);
      }
    }
  }, 240_000);
});
