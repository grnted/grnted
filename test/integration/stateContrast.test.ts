// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 in the hover and keyboard-focus states of text, in real Chromium. The SC has no exception for a
// state (its exceptions: inactive components, pure decoration, text nobody sees, logotypes), so a link that
// turns pale when the pointer is on it or when it has focus must still reach 4.5:1 (G18). axe reads the page
// at rest only. Decided from solid colours; a `minor` failure (the text reads at rest).
// Look-alikes that must keep passing: a state that keeps enough contrast (darker, or inverted on a dark fill),
// a state with no colour change, large text at 3:1, a state over a gradient (not decided here), and text that
// already fails at rest (reported there, not twice).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bin collections</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } a { color: #125969; } ul { padding: 0; list-style: none; } li { margin: 8px 0; } button { font: inherit; padding: 8px 16px; border: 0; } ${css}</style></head>
<body><main><h1>Bin collections</h1><p>Collections move one day later in the week of a public holiday.</p>${body}</main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [textContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('text contrast (1.4.3): hover and keyboard-focus states', () => {
  it('fails a link that turns pale on hover, one that turns pale on focus, and a button whose fill turns pale under white text', async () => {
    const r = await run(page(`#h:hover { color: #a7c4bf; } #f:focus { color: #b0b0b0; } #b { background: #1b6b3a; color: #fff; } #b:hover, #b:focus-visible { background: #bfe8cf; }`,
      '<ul><li><a id="h" href="/a">Find your collection day</a></li><li><a id="f" href="/b">Order a new bin</a></li></ul><button type="button" id="b">Report a missed bin</button>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([
      expect.objectContaining({ target: '#h', minor: true, detail: expect.stringMatching(/^Text contrast drops to 1\.\d:1 when the pointer is on it \(text #a7c4bf on #ffffff; 7\.\d:1 at rest\); 16 px text needs at least 4\.5:1: “Find your collection day”$/) }),
      expect.objectContaining({ target: '#f', minor: true, detail: expect.stringMatching(/^Text contrast drops to 2\.\d:1 when it has keyboard focus \(text #b0b0b0 on #ffffff/) }),
      expect.objectContaining({ target: '#b', minor: true, detail: expect.stringMatching(/^Text contrast drops to 1\.\d:1 when it has keyboard focus and when the pointer is on it \(text #ffffff on #bfe8cf/) }),
    ]);
  }, 60_000);

  it('look-alikes pass: darker on hover, inverted on a dark fill, underline only, large text at 3:1, a gradient fill, and text already failing at rest', async () => {
    const r = await run(page(`#a:hover { color: #0a3d47; }
#i:hover, #i:focus { color: #fff; background: #125969; }
#u:hover { text-decoration: underline; }
#l { font-size: 26px; } #l:hover { color: #8a8a8a; }
#g { color: #fff; background: #1b6b3a; } #g:hover { background: linear-gradient(#bfe8cf, #1b6b3a); }
#r { color: #b0b0b0; } #r:hover { color: #c8c8c8; }`,
      `<ul><li><a id="a" href="/a">Find your collection day</a></li><li><a id="i" href="/i">Order a new bin</a></li><li><a id="u" href="/u">Garden waste</a></li>
<li><a id="l" href="/l">Bulky items</a></li><li><a id="r" href="/r">Recycling centres</a></li></ul><button type="button" id="g">Report a missed bin</button>`));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([]);
  }, 60_000);

  it('look-alike: a skip link kept off screen until it has focus has no hover state anyone sees; its focus state is read as it shows', async () => {
    // The page's general link hover colour is the skip link's own dark fill: with the pointer "on" it off screen it would read 1:1.
    const r = await run(page('a:hover { color: #14141a; } .skip { position: absolute; left: 12px; top: -60px; background: #14141a; color: #fff; padding: 10px 14px; } .skip:focus { top: 12px; }',
      '<a class="skip" href="#main">Skip to the main content</a><ul><li><a href="/a">Find your collection day</a></li></ul>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([]);
    // The same skip link with a focus state that cannot be read is still caught there.
    const bad = await run(page('.skip { position: absolute; left: 12px; top: -60px; background: #14141a; color: #fff; padding: 10px 14px; } .skip:focus { top: 12px; color: #33333b; }',
      '<a class="skip" id="skip" href="#main">Skip to the main content</a><ul><li><a href="/a">Find your collection day</a></li></ul>'));
    expect(failed(bad), JSON.stringify(bad.findings)).toEqual([expect.objectContaining({ target: '#skip', detail: expect.stringMatching(/^Text shown only when “Skip to the main content” has keyboard focus has 1\.\d:1 contrast \(text #33333b on #14141a\)/) })]);
  }, 60_000);

  it('look-alike: a menu whose item turns dark under its link on hover (the pointer is on both) passes; the same link without the dark item fails', async () => {
    const menu = '<ul class="menu"><li><a id="m" href="/a">Find your collection day</a></li><li><a href="/b">Order a new bin</a></li></ul>';
    const ok = await run(page('.menu li:hover { background: #125969; } .menu a:hover { color: #fff; }', menu));
    expect(failed(ok), JSON.stringify(ok.findings)).toEqual([]);
    const bad = await run(page('.menu a:hover { color: #fff; }', menu));
    expect(failed(bad).map((f) => f.target), JSON.stringify(bad.findings)).toEqual(['#m', 'html > body > main > ul > li:nth-of-type(2) > a']);
  }, 60_000);

  it('fails a title that a rule on its card turns pale while the pointer is on it; a card that darkens its title passes', async () => {
    const card = (css: string) => page(`${css} .card { padding: 12px; border: 1px solid #555; }`, '<div class="card"><a class="t" id="t" href="/x">Christmas tree collections</a></div>');
    const bad = await run(card('.card:hover .t { color: #c8c8c8; }'));
    expect(failed(bad), JSON.stringify(bad.findings)).toEqual([expect.objectContaining({ target: '#t', minor: true, detail: expect.stringMatching(/^Text contrast drops to 1\.\d:1 when the pointer is on it \(text #c8c8c8 on #ffffff; 7\.\d:1 at rest\)/) })]);
    const ok = await run(card('.card:hover .t { color: #0a3d47; }'));
    expect(ok.findings.filter((f) => f.status !== 'no_failures_found'), JSON.stringify(ok.findings)).toEqual([]);
  }, 60_000);

  // Review r1, finding 4: one pointer is on one element and what contains it, never on two separate elements.
  it('never puts the pointer on two separate elements at once: "#a:hover ~ #b:hover" cannot happen and is not failed', async () => {
    const links = '<p><a id="a" href="/a">Find your collection day</a> <a id="b" href="/b">Order a new bin</a></p>';
    const r = await run(page('a:hover { color: #0a3d47; } #a:hover ~ #b:hover { color: #aaaaaa; }', links));
    expect(r.findings.filter((f) => f.status !== 'no_failures_found'), JSON.stringify(r.findings)).toEqual([]);
    // Look-alikes that can happen with one pointer still fail: the link's own hover, and a hover on the link inside a hovered item.
    const own = await run(page('#b:hover { color: #aaaaaa; }', links));
    expect(failed(own).map((f) => f.target), JSON.stringify(own.findings)).toEqual(['#b']);
    const nested = await run(page('ul { list-style: none; padding: 0; } li:hover > a:hover { color: #aaaaaa; }', '<ul><li><a id="n" href="/n">Garden waste</a></li></ul>'));
    expect(failed(nested).map((f) => f.target), JSON.stringify(nested.findings)).toEqual(['#n']);
  }, 90_000);

  it('reads every kind of restyled text, not a sample: two links with the same hover rule on different backgrounds are each read', async () => {
    const r = await run(page('.on-dark { background: #14141a; padding: 12px; } a.x { color: #d8dee0; } .on-light a.x { color: #14506b; } a.x:hover { color: #9fb0b5; }',
      '<div class="on-dark"><a class="x" id="d" href="/d">Recycling centres</a></div><div class="on-light"><a class="x" id="l" href="/l">Bulky items</a></div>'));
    // #9fb0b5 is fine on the dark panel and too pale on white.
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#l']);
  }, 60_000);
});
