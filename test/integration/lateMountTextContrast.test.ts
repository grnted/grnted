// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 on a page that puts its content in after it loads (an app that mounts 2 s later), in real Chromium.
// axe looks at such a page again once it has mounted and leaves text over a gradient undecided; the text-contrast
// test, which measures what axe leaves undecided, looked at the page as it loaded (an empty shell), found none of
// that text there and left the page untested. It now waits for the page like the layout tests (`waitFor.content`,
// bounded), so the text is measured.
// Look-alike: the same late page with dark text over the same gradient is measured and passes.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const late = (color: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recycling centre</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } #over { padding: 24px; background: linear-gradient(90deg, #f6f9f8, #dfe9e6); color: ${color}; }</style></head>
<body><main id="app"></main><script>
setTimeout(function () {
  document.getElementById('app').innerHTML = '<h1>Recycling centre</h1><p>Bring proof of address on your first visit.</p>'
    + '<p id="over">Opening hours change on public holidays.</p>';
}, 2000);
</script></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const report = await scanSite(`${sim.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [textContrastProbe], documents: false });
    return (report.probes?.runs ?? []).find((r) => r.probe === 'text-contrast')!;
  } finally {
    await sim.close();
  }
}

describe('text contrast (1.4.3) on a page that mounts its content late', () => {
  it('measures and fails faint text over a gradient that the page puts in 2 s after load', async () => {
    const r = await run(late('#a9b8b4'));
    expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r)).toEqual([expect.objectContaining({ criterion: '1.4.3', target: '#over', detail: expect.stringMatching(/^Text contrast is [12]\.\d:1 /) })]);
  }, 120_000);

  it('look-alike: the same late page with dark text over the gradient is measured and has no failure', async () => {
    const r = await run(late('#1d2a2e'));
    expect(r.status, JSON.stringify(r)).toBe('ok');
    expect(r.findings.filter((f) => f.status !== 'no_failures_found'), JSON.stringify(r.findings)).toEqual([]);
  }, 120_000);
});
