// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D13 and D14 (docs/atlas/visual.md): WCAG 1.4.3 for text shown after load. Faint text a timer
// shows 4 s after load, and faint text in a menu a button opens (also one a single-page app renders at the end of the
// page), fail. Look-alikes keep passing: a later text and an opened menu with enough contrast, and a menu whose closed
// styles are pale while its opened styles are dark (only the opened state is judged).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { stateTextProbe } from '../../src/probes/stateText.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
let axeSource: string;
beforeAll(async () => { browser = await chromium.launch(); axeSource = await defaultAxeSource(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alerts</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 24px; color: #222; background: #fff; } .menu { list-style: none; padding: 8px; border: 1px solid #888; background: #fff; } ${css}</style></head>
<body><main><h1>Service alerts</h1><p>Check this page for water and road notices.</p>${body}</main><script>${script}</script></body></html>`;
const MENU = '<button id="m" aria-expanded="false" aria-controls="menu">Services</button><ul id="menu" class="menu" hidden><li><a href="/water">Water and sewer</a></li><li><a href="/roads">Roads</a></li></ul>';
const TOGGLE = "document.getElementById('m').addEventListener('click', (e) => { const b = e.currentTarget; const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); document.getElementById('menu').hidden = !open; }); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById('m').setAttribute('aria-expanded', 'false'); document.getElementById('menu').hidden = true; } });";

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [stateTextProbe], { userAgent: 'grnted-test', full: true, axeSource });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('D13 and D14: text shown after load', () => {
  it('fails faint text a timer shows 4 s after load', async () => {
    const r = await run(page('#late { color: #aaaaaa; }', '<p id="late" hidden>Crews will finish the repair by Friday afternoon.</p>', "setTimeout(() => { document.getElementById('late').hidden = false; }, 4000);"));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#late']);
    expect(failed(r)[0]!.detail).toMatch(/a few seconds after it loads/);
  }, 60_000);

  it('fails faint text in a menu a button opens, and in a menu rendered at the end of the page', async () => {
    const r = await run(page('.menu a { color: #b0b0b0; }', MENU, TOGGLE));
    expect(failed(r).map((f) => f.detail), JSON.stringify(r.findings)).toEqual([expect.stringMatching(/when "Services" is opened/), expect.stringMatching(/when "Services" is opened/)]);
    const portal = await run(page('.portal a { color: #b5b5b5; } .portal { position: absolute; top: 60px; left: 24px; background: #fff; border: 1px solid #888; padding: 8px; }', '<button id="p" aria-expanded="false" aria-haspopup="menu">Account</button>',
      "document.getElementById('p').addEventListener('click', (e) => { e.currentTarget.setAttribute('aria-expanded', 'true'); const d = document.createElement('div'); d.className = 'portal'; d.innerHTML = '<a href=\"/sign-in\">Sign in to pay a bill</a>'; document.body.appendChild(d); });"));
    expect(failed(portal).map((f) => f.detail), JSON.stringify(portal.findings)).toEqual([expect.stringMatching(/when "Account" is opened/)]);
  }, 90_000);

  it('look-alikes pass: later text and an opened menu with enough contrast, and a menu pale only while closed', async () => {
    for (const c of [
      page('#late { color: #333; }', '<p id="late" hidden>Crews will finish the repair by Friday afternoon.</p>', "setTimeout(() => { document.getElementById('late').hidden = false; }, 4000);"),
      page('.menu a { color: #1a4f8b; }', MENU, TOGGLE),
      page('.menu a { color: #cccccc; } .menu:not([hidden]) a { color: #1a4f8b; }', MENU, TOGGLE),
    ]) {
      const r = await run(c);
      expect(failed(r), JSON.stringify(r.findings)).toEqual([]);
    }
  }, 120_000);
});
