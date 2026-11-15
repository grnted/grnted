// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A page that is still putting its main content in when a waiting test's bounded wait ends (3 s), in real
// Chromium. The tests that wait for late content used to go ahead on the shell and call it clean or not
// applicable ("no form fields or icon-only controls on the page", "axe decided the contrast of all text"). What
// was not there to be measured is unknown, never clean: such a run is now not testable for each criterion it has
// no failure for. A failure found on the shell itself is evidence and stands.
// Look-alike: the same page mounting 1.5 s after load is waited for and measured as usual.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { runProbes, unmountedFindings } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (mountMs: number, header = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Allotments</title>
<style>body { font: 16px/1.5 sans-serif; margin: 0; background: #fff; color: #1b1b1b; } header, main { padding: 16px 32px; } input { font: inherit; padding: 8px; width: 240px; background: #fff; border: 1px solid #dedede; }</style></head>
<body><header><strong>Allotments</strong>${header}</header><main id="app" aria-busy="true"></main><script>
setTimeout(function () {
  var app = document.getElementById('app');
  app.innerHTML = '<h1>Allotments</h1><p>Plots are let for a year from the first of March.</p><label for="plot">Plot number</label><br><input id="plot" name="plot">';
  app.removeAttribute('aria-busy');
}, ${mountMs});
</script></body></html>`;

async function run(html: string): Promise<Record<string, ProbeRun>> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [nonTextContrastProbe, linkColorProbe, textContrastProbe], { userAgent: 'grnted-test', full: true });
    return Object.fromEntries(runs.map((r) => [r.probe, r]));
  } finally {
    await sim.close();
  }
}

describe('a waiting test on a page that has not mounted when its wait ends', () => {
  it('is not testable for each criterion: never "not applicable", never clean', async () => {
    const runs = await run(page(6000));
    for (const id of ['non-text-contrast', 'link-color', 'text-contrast']) {
      expect(runs[id]!.findings, `${id}: ${JSON.stringify(runs[id]!.findings)}`).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('had not finished putting its main content in') })]);
    }
  }, 120_000);

  it('keeps a failure found on the shell itself, and still says the rest was not judged', async () => {
    const runs = await run(page(6000, ' <label for="q">Search</label> <input id="q" name="q">'));
    expect(runs['non-text-contrast']!.findings, JSON.stringify(runs['non-text-contrast']!.findings)).toEqual([expect.objectContaining({ status: 'failed', target: '#q' })]);
    expect(runs['link-color']!.findings).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  }, 120_000);

  it('look-alike: the same page mounting 1.5 s after load is waited for and measured', async () => {
    const runs = await run(page(1500));
    expect(runs['non-text-contrast']!.findings, JSON.stringify(runs['non-text-contrast']!.findings)).toEqual([expect.objectContaining({ status: 'failed', target: '#plot' })]);
    expect(runs['link-color']!.findings).toEqual([expect.objectContaining({ status: 'not_applicable' })]);
  }, 120_000);
});

describe('unmountedFindings', () => {
  const probe = { criteria: ['1.4.11', '2.4.7'] };
  it('keeps failures and undecided findings, drops clean and not-applicable ones, and leaves every other criterion not testable', () => {
    expect(unmountedFindings(probe, [
      { criterion: '1.4.11', status: 'failed', detail: 'a faint field' },
      { criterion: '2.4.7', status: 'no_failures_found', detail: 'all focus indicators visible' },
    ], 'why')).toEqual([{ criterion: '1.4.11', status: 'failed', detail: 'a faint field' }, { criterion: '2.4.7', status: 'not_testable', detail: 'why' }]);
    expect(unmountedFindings(probe, [], 'why')).toEqual([{ criterion: '1.4.11', status: 'not_testable', detail: 'why' }, { criterion: '2.4.7', status: 'not_testable', detail: 'why' }]);
    expect(unmountedFindings(probe, [{ criterion: '1.4.11', status: 'not_applicable', detail: 'none' }, { criterion: '2.4.7', status: 'not_testable', detail: 'own reason' }], 'why'))
      .toEqual([{ criterion: '2.4.7', status: 'not_testable', detail: 'own reason' }, { criterion: '1.4.11', status: 'not_testable', detail: 'why' }]);
  });
});
