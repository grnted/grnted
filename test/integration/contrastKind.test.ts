// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness: each 1.4.3 failure of the text-contrast test says what kind of evidence it is
// (`data.kind`), so the report's title and fix follow it (test/unit/contrastCopyKind.test.ts). General fixtures:
// header links that turn dark on a dark band when the pointer is on them (a hover state), a field whose placeholder is
// too pale (placeholder), and white text over a pale grey gradient (the backdrop measured from screenshots).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Library</title>
<style>body { font: 16px/1.5 sans-serif; margin: 0; background: #fff; color: #1b1b1b; } main { padding: 24px; } ${css}</style></head>
<body>${body}</body></html>`;

// A whole scan (axe first, so the test gets the text axe left undecided), one page, the text-contrast test only.
async function run(html: string): Promise<ProbeRun[]> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const r = await scanSite(`${sim.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: [textContrastProbe], documents: false });
    return r.probes?.runs ?? [];
  } finally {
    await sim.close();
  }
}
const kinds = (runs: ProbeRun[]) => [...new Set(runs.flatMap((r) => r.findings.filter((f) => f.status === 'failed' && f.criterion === '1.4.3').map((f) => `${f.target} ${f.data?.kind}`)))].map((x) => x.split(' ').pop());

describe('1.4.3 failures name their kind of evidence', () => {
  it('header links that turn dark navy on a navy band when the pointer is on them: state', async () => {
    const r = await run(page('header { background: #14284b; padding: 12px 24px; } header a { color: #fff; margin-right: 16px; } header a:hover { color: #1a2f57; }',
      '<header><nav aria-label="Main"><a href="/a">Visit</a><a href="/b">Events</a><a href="/c">Services</a></nav></header><main><h1>Library</h1><p>Open every day.</p></main>'));
    expect(kinds(r), JSON.stringify(r.map((x) => x.findings))).toEqual(['state', 'state', 'state']);
  }, 60_000);
  it('a search field whose placeholder is too pale: placeholder', async () => {
    const r = await run(page('input::placeholder { color: #d0d0d0; } input { border: 1px solid #555; padding: 6px; }',
      '<main><h1>Library</h1><form role="search"><label for="q">Search the catalog</label> <input id="q" placeholder="Title, author or subject"></form></main>'));
    expect(kinds(r), JSON.stringify(r.map((x) => x.findings))).toEqual(['placeholder']);
  }, 60_000);
  it('white text over a pale grey gradient: backdrop', async () => {
    const r = await run(page('.band { background: linear-gradient(90deg, #dddddd, #bbbbbb); padding: 24px; } .band p { color: #ffffff; }',
      '<main><h1>Library</h1><div class="band"><p>Holiday hours: closed on the 25th.</p></div></main>'));
    expect(kinds(r), JSON.stringify(r.map((x) => x.findings))).toEqual(['backdrop']);
  }, 90_000);
});
