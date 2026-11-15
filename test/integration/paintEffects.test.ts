// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D17 (docs/atlas/visual.md): WCAG 1.4.3 for text whose look axe's colour rule does not model.
// Text faded by a filter on an ancestor, brightened by a filter, blended with a blend mode, or given a pale first line
// passes axe on its computed colours; measured from screenshots, it fails. Look-alikes keep passing: a filtered logo
// (logotype), dark text under a drop shadow, and a filter that leaves the text dark.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
let axeSource: string;
beforeAll(async () => { browser = await chromium.launch(); axeSource = await defaultAxeSource(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>News</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 32px; background: #fff; color: #222; } ${css}</style></head><body><main><h1>News</h1>${body}</main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [textContrastProbe], { userAgent: 'grnted-test', full: true, axeSource });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');
const P = 'The bridge reopens to traffic on Monday morning after the inspection.';

describe('D17: text under paint effects axe does not model', () => {
  it('fails text faded by a filter on its card, brightened by a filter, and a pale first line', async () => {
    for (const [css, body] of [
      ['.teaser { filter: opacity(0.3); }', `<div class="teaser"><p id="t">${P}</p></div>`],
      ['.teaser { filter: brightness(3.2); }', `<div class="teaser"><p id="t" style="color:#555">${P}</p></div>`],
      ['#t::first-line { color: #c8c8c8; }', `<p id="t" style="width:900px">${P}</p>`],
    ] as const) {
      const r = await run(page(css, body));
      expect(failed(r).map((f) => f.target), `${css}: ${JSON.stringify(r.findings)}`).toEqual(['#t']);
    }
  }, 150_000);

  it('text a blend mode washes out is not testable, never clean (its letters cannot be redrawn to be found)', async () => {
    const r = await run(page('#t { mix-blend-mode: screen; color: #444; } .bg { background: #fff; }', `<div class="bg"><p id="t">${P}</p></div>`));
    expect(r.findings.map((f) => [f.status, f.target]), JSON.stringify(r.findings)).toEqual([['not_testable', '#t']]);
  }, 60_000);

  it('look-alikes pass: a filtered logo, dark text under a drop shadow, a filter that leaves text dark', async () => {
    for (const [css, body] of [
      ['.site-logo { filter: grayscale(1) opacity(0.4); }', `<a class="site-logo" href="/">River City</a><p>${P}</p>`],
      ['#t { filter: drop-shadow(0 1px 1px #999); }', `<p id="t">${P}</p>`],
      ['.teaser { filter: contrast(1.2); }', `<div class="teaser"><p>${P}</p></div>`],
    ] as const) {
      const r = await run(page(css, body));
      expect(failed(r), `${css}: ${JSON.stringify(r.findings)}`).toEqual([]);
    }
  }, 150_000);
});
