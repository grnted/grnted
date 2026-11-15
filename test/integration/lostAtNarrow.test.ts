// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D6 (docs/atlas/visual.md): WCAG 1.4.10 for prose removed at 320 CSS px (F102). A paragraph a
// width media rule hides below 700 px, with its information shown nowhere else and no control to show it, fails.
// Look-alikes keep passing: the same words in another layout, a mobile accordion with its button, a navigation
// collapsed behind a menu button, a decorative image hidden at mobile, and a header phone number repeated in the footer.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const NOTICE = 'The budget question session begins at 4:15 p.m. on December 9 in the district meeting room.';
const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Budget</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 0; color: #222; background: #fff; } main { padding: 0 16px; } .card { border: 1px solid #999; padding: 12px; margin: 12px 0; } ${css}</style></head>
<body><main><h1>Budget</h1><p>The proposed budget will be posted in May for public comment by residents.</p>${body}</main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [reflowProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('D6: prose removed at 320 px', () => {
  it('fails a unique paragraph a media rule hides below 700 px', async () => {
    const r = await run(page('@media (max-width: 700px) { .desk-only { display: none; } }', `<section class="card"><h2>Office arrangements</h2><p id="lost" class="desk-only">${NOTICE}</p></section>`));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#lost']);
    expect(failed(r)[0]!.detail).toMatch(/At 320 px wide this text is removed/);
  }, 60_000);

  it('a skip link to <main> does not hide lost prose; a :target rule on the block around it does (lab, sticky-header pages)', async () => {
    const skip = (css: string) => page(css, `<section class="card"><p id="lost" class="desk-only">${NOTICE}</p></section>`).replace('<body><main>', '<body><a href="#main">Skip to content</a><main id="main">');
    const r = await run(skip('@media (max-width: 700px) { .desk-only { display: none; } }'));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#lost']);
    // The page's styles show the block when <main> is the fragment target: the link may show it, never a failure.
    const t = await run(skip('@media (max-width: 700px) { .desk-only { display: none; } main:target .desk-only { display: block; } }'));
    expect(failed(t).filter((f) => /this text is removed/.test(f.detail ?? '')), JSON.stringify(t.findings)).toEqual([]);
  }, 120_000);

  it('look-alikes pass: the same words in another layout, an accordion with its button, a collapsed navigation, a hidden picture, a header number repeated in the footer', async () => {
    const cases = [
      page('.mobile { display: none; } @media (max-width: 700px) { .desk-only { display: none; } .mobile { display: block; } }', `<section class="card"><p class="desk-only">${NOTICE}</p><p class="mobile">${NOTICE}</p></section>`),
      page('@media (max-width: 700px) { #acc-panel { display: none; } }', `<section class="card"><h2><button aria-expanded="false" aria-controls="acc-panel">Office arrangements</button></h2><div id="acc-panel"><p>${NOTICE}</p></div></section>`),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title><style>body{font:16px Arial;margin:0} @media (max-width: 700px) { nav ul { display: none; } }</style></head><body><nav><button aria-expanded="false">Menu</button><ul><li><a href="/a">The district calendar for the whole of the school year and every holiday</a></li></ul></nav><main><h1>Budget</h1><p>The proposed budget will be posted in May for public comment by residents.</p></main></body></html>`,
      page('@media (max-width: 700px) { .art { display: none; } }', '<div class="art"><img alt="" src="data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2740%27 height=%2740%27/%3E"></div>'),
      page('@media (max-width: 700px) { .top-phone { display: none; } }', `<div class="top-phone"><p>Call the district office at 555-0100 on weekdays from 8 a.m. to 4 p.m. for help.</p></div><section class="card"><p>Call the district office at 555-0100 on weekdays from 8 a.m. to 4 p.m. for help.</p></section>`),
    ];
    for (const c of cases) {
      const r = await run(c);
      const mine = failed(r).filter((f) => /this text is removed/.test(f.detail ?? ''));
      expect(mine, `${c.slice(-260)}: ${JSON.stringify(r.findings)}`).toEqual([]);
    }
  }, 180_000);
});
