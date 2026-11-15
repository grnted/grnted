// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D10 and D11 (docs/atlas/visual.md), WCAG 1.4.1 Use of color.
// D10: a state the page marks in its code (the current page, the selected tab, a pressed toggle) whose only visible
// difference from its peers is a colour under 3:1 from theirs fails; a shape, a weight, an icon, or colours 3:1 or
// more apart (Understanding 1.4.1's lightness note) pass. D11: a link cue counts only when it paints (an underline or
// border in a see-through colour or the colour behind it, or a background underline sized to nothing at rest, is no
// cue); an underline that turns visible on hover and focus is a cue there.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Parks</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 32px; background: #fff; color: #333; } nav ul { list-style: none; display: flex; gap: 16px; padding: 0; } nav a { text-decoration: none; color: #333; }
[role=tablist] { display: flex; gap: 8px; } [role=tab] { border: 0; background: none; font: inherit; color: #333; padding: 8px; }
${css}</style></head><body>${body}</body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [linkColorProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');
const NAV = '<nav aria-label="Main"><ul><li><a href="/a">Parks</a></li><li><a id="cur" href="/b" aria-current="page">Programs</a></li><li><a href="/c">Rentals</a></li></ul></nav>';
const TABS = '<div role="tablist"><button role="tab" aria-selected="false">Summer</button><button role="tab" id="sel" aria-selected="true">Fall</button><button role="tab" aria-selected="false">Winter</button></div>';

describe('D10: states told apart by colour alone', () => {
  it('fails the current page shown only by a blue a little darker than its peers, and a tab selected only by colour', async () => {
    const r = await run(page('nav a[aria-current] { color: #1a5fb4; } [role=tab][aria-selected=true] { color: #0b6e99; }', `${NAV}<main>${TABS}</main>`));
    expect(failed(r).map((f) => f.target).sort(), JSON.stringify(r.findings)).toEqual(['#cur', '#sel']);
    expect(failed(r).find((f) => f.target === '#cur')!.detail).toMatch(/current item only by its text colour/);
  }, 60_000);

  it('fails a pressed toggle shown only by a pale fill', async () => {
    const r = await run(page('.chips button { border: 1px solid #888; background: #fff; color: #222; padding: 4px 10px; font: inherit; } .chips [aria-pressed=true] { background: #e3eefc; }',
      '<main><div class="chips"><button aria-pressed="false">Indoor</button><button id="on" aria-pressed="true">Outdoor</button><button aria-pressed="false">Free</button></div></main>'));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#on']);
  }, 60_000);

  it('look-alikes pass: an underline bar, bold text, colours 3:1 apart, a fill 3:1 apart, and a state shown in no way at all', async () => {
    for (const css of [
      'nav a[aria-current] { color: #1a5fb4; box-shadow: inset 0 -3px 0 #1a5fb4; }',
      'nav a[aria-current] { color: #1a5fb4; font-weight: 700; }',
      'nav a[aria-current] { color: #9a9a9a; }',
      'nav a[aria-current] { background: #1d3557; color: #fff; }',
      '',
    ]) {
      const r = await run(page(css, NAV));
      expect(failed(r), `${css}: ${JSON.stringify(r.findings)}`).toEqual([]);
    }
  }, 120_000);
});

const PARA = (link: string) => `<main><p>Picnic shelters can be reserved up to six months ahead. ${link} before you book a large group.</p></main>`;

describe('D11: link cues that paint nothing', () => {
  it('fails links whose underline is transparent, whose border is invisible, or whose underline is sized to nothing at rest', async () => {
    for (const css of [
      'p a { color: #2d6aa0; text-decoration: underline; text-decoration-color: transparent; }',
      'p a { color: #2d6aa0; text-decoration: none; border-bottom: 1px solid transparent; }',
      'p a { color: #2d6aa0; text-decoration: none; background: linear-gradient(currentColor, currentColor) 0 100% / 0 1px no-repeat; }',
    ]) {
      const r = await run(page(css, PARA('<a id="rules" href="/rules">Read the shelter rules</a>')));
      expect(failed(r).map((f) => f.target), `${css}: ${JSON.stringify(r.findings)}`).toEqual(['link “Read the shelter rules”']);
    }
  }, 120_000);

  it('look-alikes pass: a painted thin underline, and an underline that turns visible on hover and focus', async () => {
    for (const css of [
      'p a { color: #2d6aa0; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }',
      'p a { color: #2d6aa0; text-decoration: underline; text-decoration-color: transparent; } p a:hover, p a:focus { text-decoration-color: currentColor; }',
      'p a { color: #2d6aa0; text-decoration: none; background: linear-gradient(currentColor, currentColor) 0 100% / 100% 1px no-repeat; }',
    ]) {
      const r = await run(page(css, PARA('<a id="rules" href="/rules">Read the shelter rules</a>')));
      expect(failed(r), `${css}: ${JSON.stringify(r.findings)}`).toEqual([]);
    }
  }, 120_000);
});
