// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D12b (docs/atlas/visual.md): WCAG 1.4.11 for a switch whose track and knob are both faint
// against the page, and for the bar that alone marks the selected tab. Look-alikes keep passing: a switch with a
// 3:1 border, a switch with a dark knob, a switch with its state in words, a disabled switch, a selected tab with a
// dark bar, and a tab that is also bold.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settings</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 32px; background: #fff; color: #222; }
.sw { position: relative; width: 44px; height: 24px; border-radius: 12px; border: 0; padding: 0; background: #e6e6e6; }
.sw::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 9px; background: #fff; }
[role=tablist] { display: flex; gap: 8px; } [role=tab] { border: 0; background: none; font: inherit; color: #222; padding: 8px; }
${css}</style></head><body><main><h1>Settings</h1>${body}</main></body></html>`;
const SW = '<p><span id="lbl">Email alerts</span> <button class="sw" id="sw" role="switch" aria-checked="false" aria-labelledby="lbl"></button></p>';
const TABS = '<div role="tablist"><button role="tab" aria-selected="false">Summer</button><button role="tab" id="sel" aria-selected="true">Fall</button></div>';

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [nonTextContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('D12b: switches and tab bars', () => {
  it('fails a pale switch with a white knob, and a selected tab marked only by a pale bar', async () => {
    const r = await run(page('[role=tab][aria-selected=true] { box-shadow: inset 0 -3px 0 #cfe3ff; }', `${SW}${TABS}`));
    expect(failed(r).map((f) => f.target).sort(), JSON.stringify(r.findings)).toEqual(['#sel', '#sw']);
  }, 60_000);

  it('look-alikes pass: a 3:1 border, a dark knob, words in the switch, a disabled switch, a dark bar, a bold tab', async () => {
    for (const [css, body] of [
      ['.sw { border: 2px solid #767676; }', SW],
      ['.sw::after { background: #1f4e79; }', SW],
      ['', '<p><span id="lbl">Email alerts</span> <button class="sw" id="sw" role="switch" aria-checked="false" aria-labelledby="lbl">Off</button></p>'],
      ['', SW.replace('aria-checked="false"', 'aria-checked="false" disabled')],
      ['[role=tab][aria-selected=true] { box-shadow: inset 0 -3px 0 #1d3557; }', TABS],
      ['[role=tab][aria-selected=true] { box-shadow: inset 0 -3px 0 #cfe3ff; font-weight: 700; }', TABS],
    ] as const) {
      const r = await run(page(css, body));
      expect(failed(r), `${css} ${body.slice(0, 60)}: ${JSON.stringify(r.findings)}`).toEqual([]);
    }
  }, 150_000);
});
