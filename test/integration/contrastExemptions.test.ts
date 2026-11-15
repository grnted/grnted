// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3's exceptions hold in every state the engine reads text in, in real Chromium: one shared predicate
// (src/probes/contrastExempt.ts) for axe's results at rest, placeholder text, hover and focus states, and text
// shown only on hover or focus. "Incidental: text … part of an inactive user interface component … [has] no
// contrast requirement. Logotypes: text that is part of a logo or brand name has no contrast requirement."
// Before: a disabled button in a menu shown on hover failed, and so did a text logo that turns pale on hover
// (although the same logo is exempt at rest).
// Look-alikes: the same button enabled, and a link that is not a logo, still fail.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canal boats</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } a { color: #14506b; } button { font: inherit; padding: 8px 14px; border: 1px solid #99a; background: #fff; color: #1b1b1b; }
nav ul { list-style: none; margin: 0; padding: 0; } nav > ul > li { position: relative; display: inline-block; margin-right: 24px; }
nav ul ul { display: none; position: absolute; left: 0; top: 100%; width: 240px; padding: 8px; background: #fff; border: 1px solid #99a; } nav li:hover > ul, nav li:focus-within > ul { display: block; } ${css}</style></head>
<body><main><h1>Canal boats</h1><p>Day boats leave the basin on the hour.</p>${body}</main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [textContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed').map((f) => f.target);
const MENU = (item: string) => `<nav aria-label="Trips"><ul><li><a href="/trips">Trips</a><ul><li>${item}</li></ul></li></ul></nav>`;

describe('text contrast (1.4.3): the exceptions hold in hover, focus and revealed states', () => {
  it('does not fail a disabled button, or a control marked aria-disabled, in a menu shown on hover', async () => {
    const off = await run(page('', MENU('<button type="button" disabled id="soon" style="color:#aaa;background:#fff">Evening trips: coming soon</button>')));
    expect(failed(off), JSON.stringify(off.findings)).toEqual([]);
    const aria = await run(page('', MENU('<a id="soon" href="/evening" aria-disabled="true" style="color:#aaa">Evening trips: coming soon</a>')));
    expect(failed(aria), JSON.stringify(aria.findings)).toEqual([]);
  }, 90_000);

  it('look-alike: the same faint button, enabled, in the same menu fails', async () => {
    const r = await run(page('', MENU('<button type="button" id="soon" style="color:#aaa;background:#fff">Evening trips: book now</button>')));
    expect(failed(r), JSON.stringify(r.findings)).toEqual(['#soon']);
  }, 90_000);

  it('does not fail a text logo that turns pale on hover; a plain link with the same hover colour fails', async () => {
    const r = await run(page('.site-logo:hover, #plain:hover { color: #b8c4c9; }', '<p><a class="site-logo" id="mark" href="/">Basin Boats</a></p><p><a id="plain" href="/prices">Prices and times</a></p>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual(['#plain']);
  }, 90_000);

  // Review r2, finding 9: HTML keeps the first legend of a disabled fieldset active.
  it('fails a link in the first legend of a disabled fieldset that turns pale on hover; a link elsewhere in that fieldset is inactive', async () => {
    const r = await run(page('#help:hover, #groups:hover { color: #b8c4c9; }',
      '<fieldset disabled><legend><a id="help" href="/help">Help with booking</a></legend><p><a id="groups" href="/groups">Group bookings</a></p><label for="n">Name</label> <input id="n" name="n"></fieldset>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual(['#help']);
  }, 90_000);

  it('does not fail the label of a disabled field that turns pale on hover, nor a disabled field’s placeholder', async () => {
    const r = await run(page('label:hover { color: #b8c4c9; } input { font: inherit; padding: 8px; background: #fff; } input::placeholder { color: #c2c2c2; }',
      '<p><label for="code" id="lab">Voucher code</label> <input id="code" name="code" placeholder="Not open yet" disabled></p>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([]);
  }, 90_000);
});
