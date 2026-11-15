// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane (gold hazard-load-animation, under load on Linux): a page whose blocks fade and rise in once as
// it loads (3.6 s in all) has its controls measured for 1.4.11 when they rest, at the desktop and the phone width,
// whenever the test runs after the load: never not testable because the area around them was still moving, never a
// failure measured mid-fade. An endless animation (a spinner) is not waited for.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const RISE = '@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}main>*{animation:rise 1.2s ease-out both}'
  + 'main>*:nth-child(2){animation-delay:.4s}main>*:nth-child(3){animation-delay:.8s}main>*:nth-child(4){animation-delay:1.2s}main>*:nth-child(5){animation-delay:1.6s}main>*:nth-child(n+6){animation-delay:2.4s}';
const page = (css: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Contact</title>
<style>body{font:18px/1.6 Georgia,serif;margin:0;color:#1a1a1a;background:#fff} main{max-width:60rem;margin:0 auto;padding:16px}
label{display:block;font-weight:bold;margin:12px 0 4px} input,textarea{font:inherit;border:2px solid #595959;padding:8px;background:#fff;color:#1a1a1a} ${css}</style></head>
<body><main><h1>Contact us</h1><p>Send the office a question.</p><div><label for="n">Name</label><input id="n" name="n"></div>
<div><label for="e">Email</label><input id="e" name="e" type="email"></div><div><label for="m">Message</label><textarea id="m" name="m"></textarea></div>
<p>We answer within two working days.</p><p>Office hours are 8 a.m. to 4 p.m.</p></main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [nonTextContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const notClean = (r: ProbeRun) => r.findings.filter((f) => f.criterion === '1.4.11' && (f.status === 'failed' || f.status === 'not_testable'));

describe('controls measured at rest after an entrance animation (1.4.11)', () => {
  it('fields that fade and rise in for 3.6 s as the page loads are measured once they rest: clean', async () => {
    const r = await run(page(RISE));
    expect(notClean(r), JSON.stringify(r.findings)).toEqual([]);
  }, 90_000);

  it('a faint field border is still failed after the entrance, and an endless spinner does not hold the test', async () => {
    const faint = await run(page(`${RISE} #e{border-color:#d8d8d8}`));
    expect(faint.findings.filter((f) => f.status === 'failed').map((f) => f.target), JSON.stringify(faint.findings)).toEqual(['#e']);
    const t0 = Date.now();
    const spin = await run(page('@keyframes spin{to{transform:rotate(1turn)}} h1::after{content:"";display:inline-block;width:12px;height:12px;border:2px solid #333;animation:spin 1s linear infinite}'));
    expect(notClean(spin), JSON.stringify(spin.findings)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 120_000);
});
