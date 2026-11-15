// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.11 (non-text contrast) and 1.4.1 (links told apart by colour only) on a page that puts its content in
// after it loads (an app that mounts 2 s later), in real Chromium. The layout tests wait for such a page
// (`waitFor.content`); these two did not, looked at the empty shell, and said there was nothing to measure
// (the simulation lab's 8 non-text-contrast misses were all late-mounting pages).
// Look-alike: the same late page with a clear border and an underlined link has no failure.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const late = (css: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Library card</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } input { font: inherit; padding: 8px; width: 280px; background: #fff; } ${css}</style></head>
<body><main id="app"></main><script>
setTimeout(function () {
  document.getElementById('app').innerHTML = '<h1>Library card</h1>'
    + '<p>You can renew a card at any branch. Before you come, read the <a id="rules" href="/rules">borrowing rules</a> for this year and bring proof of address.</p>'
    + '<label for="card">Card number</label><br><input id="card" name="card">';
}, 2000);
</script></body></html>`;

async function run(html: string): Promise<ProbeRun[]> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    return await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [nonTextContrastProbe, linkColorProbe], { userAgent: 'grnted-test', full: true });
  } finally {
    await sim.close();
  }
}
const of = (runs: ProbeRun[], probe: string) => runs.find((r) => r.probe === probe)!;

describe('contrast tests on a page that mounts its content late', () => {
  it('fails the field with a faint border (1.4.11) and the link told apart by colour only (1.4.1) once they are there', async () => {
    const runs = await run(late('input { border: 1px solid #d9d9d9; } a { color: #3d5a80; text-decoration: none; }'));
    expect(of(runs, 'non-text-contrast').findings, JSON.stringify(of(runs, 'non-text-contrast').findings)).toEqual([expect.objectContaining({ status: 'failed', target: expect.stringContaining('#card') })]);
    expect(of(runs, 'link-color').findings, JSON.stringify(of(runs, 'link-color').findings)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('borrowing rules') })]);
  }, 90_000);

  it('look-alike: the same late page with a clear border and an underlined link has no failure', async () => {
    const runs = await run(late('input { border: 1px solid #555; } a { color: #3d5a80; text-decoration: underline; }'));
    expect(of(runs, 'non-text-contrast').findings.filter((f) => f.status === 'failed'), JSON.stringify(of(runs, 'non-text-contrast').findings)).toEqual([]);
    expect(of(runs, 'link-color').findings.filter((f) => f.status === 'failed'), JSON.stringify(of(runs, 'link-color').findings)).toEqual([]);
  }, 90_000);
});
