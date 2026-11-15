// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.13 Content on Hover or Focus, "hoverable", in real Chromium: additional content that does not take
// the pointer at all (pointer-events: none) and goes when the pointer leaves its trigger. F95 (content shown on
// hover not being hoverable). The test used to look for a point of the content that takes the pointer before it
// moved there, found none, and skipped the check. Look-alikes that must keep passing: the same content when it
// takes the pointer, and content that lets the pointer through but stays until it is dismissed.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hoverContentProbe } from '../../src/probes/hoverContent.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bike repair evening</title>
<style>body { font: 16px/1.5 sans-serif; margin: 40px; } .wrap { position: relative; display: inline-block; } .tip { position: absolute; left: 0; top: 100%; width: 280px; padding: 12px; background: #123; color: #fff; display: none; z-index: 2; } ${css}</style></head>
<body><main><h1>Bike repair evening</h1><p>Bring your bike to the yard behind the hall on Thursday.</p>
<span class="wrap" id="wrap"><button type="button" id="what" aria-describedby="tip">What to bring</button><span class="tip" id="tip" role="tooltip">Bring your own inner tubes. Tools and a stand are on the bench by the door.</span></span>
<p>Volunteers can help with brakes, gears and punctures. The yard is lit until nine.</p><p>Tea is on the table by the gate.</p></main>${script ? `<script>${script}</script>` : ''}</body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [hoverContentProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const ESC = "document.addEventListener('keydown', function (e) { if (e.key === 'Escape') document.getElementById('tip').style.display = 'none'; });";

describe('hover content (1.4.13): content that does not take the pointer', () => {
  it('fails a tooltip with pointer-events: none that goes when the pointer leaves its trigger (F95)', async () => {
    const r = await run(page('.tip { pointer-events: none; } #what:hover + .tip, #what:focus + .tip { display: block; }', ESC));
    expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r.findings)).toEqual([expect.objectContaining({ detail: expect.stringContaining('it disappears when the pointer moves onto it') })]);
  }, 90_000);

  it('look-alike: the same tooltip that takes the pointer (it stays while the pointer is on it) passes', async () => {
    const r = await run(page('.wrap:hover .tip, .wrap:focus-within .tip { display: block; }', ESC));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  }, 90_000);

  it('look-alike: a tooltip that lets the pointer through but stays until Escape passes', async () => {
    const r = await run(page('.tip { pointer-events: none; }',
      "var tip = document.getElementById('tip'); document.getElementById('what').addEventListener('mouseenter', function () { tip.style.display = 'block'; }); document.addEventListener('keydown', function (e) { if (e.key === 'Escape') tip.style.display = 'none'; });"));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  }, 90_000);
});
