// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, round 2 (the blind grade found detectors reporting real failures clean): each detector's
// assumption about where text, colours, boundaries or focus come from, widened in general. One failing page and one
// look-alike per widened assumption:
// - controls, fields and placeholders inside open shadow roots (1.4.11, 1.4.3);
// - controls the page draws itself with no words or picture (dots, styled range sliders, label-drawn checkboxes; 1.4.11);
// - a selected tab whose bar is drawn by ::after (1.4.11);
// - a faint focus glow next to a border colour change, and an outline pulled inside the box (1.4.11);
// - a link's ::after icon drawn by a mask is a cue of its own (1.4.1, precision); filter chips told apart by colour (1.4.1);
// - text in SVG painted by its fill, and letters painted by a gradient of plain colours (1.4.3);
// - a text field whose caret cannot be seen is judged like any other focus stop (2.4.7);
// - content in the normal flow stacked over a focus stop (2.4.11);
// - boxes that clip only inside a width range (1.4.12, 1.4.4);
// - sideways scrolling at 320 px caused by text in a shadow root or an unwrapped text area (1.4.10);
// - text that only a mid-width breakpoint recolours, and text shown while the pointer is over an element a :hover rule
//   changes (1.4.3; the latter by the listed deep state-text test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBES } from '../../src/probes/registry.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const LANE = ['1.4.3', '1.4.11', '1.4.1', '2.4.7', '2.4.11', '1.4.10', '1.4.12', '1.4.4'];
const probes = PROBES.filter((p) => p.criteria.some((c) => LANE.includes(c)));
const page = (css: string, body: string, js = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Town services</title>
<style>*{box-sizing:border-box} body{font:16px/1.5 Arial,sans-serif;margin:0;color:#222;background:#fff} main{max-width:60rem;margin:0 auto;padding:16px}
a{color:#0b4f8a;text-decoration:underline} :focus-visible{outline:3px solid #1a1a1a;outline-offset:2px} ${css}</style></head>
<body><main><h1>Town services</h1><p>Find permits, parks and library hours for residents and visitors of the town.</p>${body}</main><script>${js}</script></body></html>`;

async function status(html: string, criterion: string): Promise<string> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const r = await scanSite(`${sim.origin}/`, { browser: browser as unknown as BrowserLike, maxPages: 1, concurrency: 1, startConcurrency: 1, full: true, documentScore: false, probes });
    return (r.criteria ?? []).find((c) => c.criterion === criterion)?.status ?? 'none';
  } finally {
    await sim.close();
  }
}
async function verdicts(cases: readonly [string, string, 'fail' | 'pass', string][]): Promise<string[]> {
  const wrong: string[] = [];
  for (const [name, criterion, want, html] of cases) {
    const s = await status(html, criterion);
    if ((want === 'fail') !== (s === 'failed')) wrong.push(`${name}: ${criterion} ${s}, wanted ${want}`);
  }
  return wrong;
}
const shadow = (tag: string, inner: string) => `<${tag}></${tag}><script>customElements.define('${tag}', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(inner)}; } });</script>`;

describe('visual round 2: wider assumptions', () => {
  it('1.4.11: controls in open shadow roots, drawn controls and pseudo tab bars fail when faint; strong ones pass', async () => {
    const field = (border: string) => shadow('town-search', `<style>input{font:inherit;border:2px solid ${border};padding:6px;background:#fff}</style><label>Search the site <input name="q"></label>`);
    const dots = (inactive: string) => `<div class="dots">${[0, 1, 2].map((i) => `<button aria-label="Slide ${i + 1}"${i === 0 ? ' aria-current="true"' : ''}></button>`).join('')}</div>`;
    const dotCss = (inactive: string) => `.dots{display:flex;gap:10px}.dots button{width:14px;height:14px;border-radius:50%;border:0;padding:0;background:${inactive}}.dots button[aria-current]{background:#1a1a1a}`;
    const range = (track: string) => `input[type=range]{-webkit-appearance:none;appearance:none;width:240px;height:8px;background:${track};border-radius:4px}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${track}}`;
    const tabs = (bar: string) => `<div role="tablist"><button role="tab" aria-selected="true" class="t">Routes</button><button role="tab" aria-selected="false" class="t">Fares</button></div>`
      + `<style>.t{position:relative;font:inherit;border:0;background:none;padding:8px 12px;color:#222}.t[aria-selected=true]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:${bar}}</style>`;
    const wrong = await verdicts([
      ['shadow field faint', '1.4.11', 'fail', page('', field('#dddddd'))],
      ['shadow field strong', '1.4.11', 'pass', page('', field('#595959'))],
      ['dots faint', '1.4.11', 'fail', page(dotCss('#e2e2e2'), dots('#e2e2e2'))],
      ['dots strong', '1.4.11', 'pass', page(dotCss('#6b6b6b'), dots('#6b6b6b'))],
      ['range faint', '1.4.11', 'fail', page(range('#e6e6e6'), '<label for="r">Distance</label> <input type="range" id="r">')],
      ['range strong', '1.4.11', 'pass', page(range('#5c5c5c'), '<label for="r">Distance</label> <input type="range" id="r">')],
      ['tab ::after bar faint', '1.4.11', 'fail', page('', tabs('#dde6f0'))],
      ['tab ::after bar strong', '1.4.11', 'pass', page('', tabs('#1a4f8b'))],
    ]);
    expect(wrong).toEqual([]);
  }, 600_000);

  it('1.4.11: a faint glow next to a faint border change fails; next to a strong border change it is not failed; an inset outline is measured', async () => {
    const btn = (border: string) => `<button class="b own">Pay a bill</button><style>.b{font:inherit;padding:8px 14px;background:#fff;color:#222;border:2px solid #767676;border-radius:6px}.b.own:focus{outline:0;border-color:${border};box-shadow:0 0 0 4px rgba(13,110,253,.18)}</style>`;
    const inset = (ring: string) => `<a class="tile" href="/pools">Pools and splash pads</a><style>.tile{display:inline-block;padding:16px;background:#f3f5f8;color:#222;text-decoration:none}.tile:focus,.tile:focus-visible{outline:3px solid ${ring};outline-offset:-6px}</style>`;
    const wrong = await verdicts([
      ['glow + faint border', '1.4.11', 'fail', page('', btn('#b9d3fb'))],
      ['glow + strong border', '1.4.11', 'pass', page('', btn('#0b3d91'))],
      ['inset outline faint', '1.4.11', 'fail', page('', inset('#dfe3e8'))],
      ['inset outline strong', '1.4.11', 'pass', page('', inset('#1a1a1a'))],
    ]);
    expect(wrong).toEqual([]);
  }, 600_000);

  it('1.4.1 and 1.4.3: a mask icon is a link cue; chips by colour alone fail; SVG text, shadow placeholders and mid-width colours are read', async () => {
    const icon = `p a{text-decoration:none;color:#1d5fa8}p a::after{content:"";display:inline-block;width:.8em;height:.8em;margin-left:.25em;background-color:currentColor;-webkit-mask:linear-gradient(#000,#000)}`;
    const linkP = '<p>Riders can transfer to the <a href="/bus">coast commuter bus</a> at Pier Street and to the harbor ferry at the waterfront.</p>';
    const chips = (on: string) => `<fieldset><legend>Show events for</legend>${['Kids', 'Teens', 'Adults'].map((t, i) => `<input type="checkbox" class="v" id="c${i}" name="aud"${i === 0 ? ' checked' : ''}><label for="c${i}">${t}</label>`).join(' ')}</fieldset>`
      + `<style>.v{position:absolute;opacity:0}.v+label{padding:4px 10px;border:1px solid #767676;border-radius:12px;color:#8a5300}.v:checked+label{color:${on}}</style>`;
    const svgText = (fill: string) => `<figure><svg width="420" height="120" viewBox="0 0 420 120"><rect width="420" height="120" fill="#ffffff"/><text x="10" y="60" font-size="16" style="fill:${fill}">Weekday riders rose four percent this spring.</text></svg></figure>`;
    const ph = (c: string) => shadow('town-find', `<style>input{font:inherit;border:2px solid #595959;padding:6px}input::placeholder{color:${c}}</style><label>Find a park <input placeholder="Park or street name"></label>`);
    const hoverTip = (c: string) => `.tip{position:relative;border-bottom:2px dotted #222}.pop{display:none;position:absolute;left:0;top:1.6em;width:16rem;background:#fff;border:1px solid #767676;padding:6px;color:${c}}.tip:hover .pop{display:block}`;
    const mid = (c: string) => `<p class="note">Holiday hours are posted one week ahead on this page and at every branch desk.</p><style>@media (min-width:700px) and (max-width:900px){.note{color:${c}}}</style>`;
    const wrong = await verdicts([
      ['mask icon link (look-alike)', '1.4.1', 'pass', page(icon, linkP)],
      ['chips by colour only', '1.4.1', 'fail', page('', chips('#1f6f43'))],
      ['chips with a check mark', '1.4.1', 'pass', page('.v:checked+label::before{content:"✓ "}', chips('#1f6f43'))],
      ['svg text faint', '1.4.3', 'fail', page('', svgText('#c0c6cc'))],
      ['svg text strong', '1.4.3', 'pass', page('', svgText('#333333'))],
      ['shadow placeholder faint', '1.4.3', 'fail', page('', ph('#b5b5b5'))],
      ['shadow placeholder strong', '1.4.3', 'pass', page('', ph('#595959'))],
      ['mid-width text faint', '1.4.3', 'fail', page('', mid('#bbbbbb'))],
      ['mid-width text strong', '1.4.3', 'pass', page('', mid('#444444'))],
      ['hover tip faint (listed deep test)', '1.4.3', 'fail', page(hoverTip('#bdbdbd'), '<p>Report a <span class="tip" tabindex="0">pothole<span class="pop">Photos help crews find it faster.</span></span> online.</p>')],
      ['hover tip strong (listed deep test)', '1.4.3', 'pass', page(hoverTip('#333333'), '<p>Report a <span class="tip" tabindex="0">pothole<span class="pop">Photos help crews find it faster.</span></span> online.</p>')],
      ['gradient text faint', '1.4.3', 'fail', page('.g{font:700 28px Arial;background:linear-gradient(90deg,#c8d6e4,#dfe8f1);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}', '<h2 class="g">Summer at the lakeshore</h2>')],
      ['gradient text strong', '1.4.3', 'pass', page('.g{font:700 28px Arial;background:linear-gradient(90deg,#1a3a5c,#3b2a5c);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}', '<h2 class="g">Summer at the lakeshore</h2>')],
    ]);
    expect(wrong).toEqual([]);
  }, 900_000);

  it('2.4.7, 2.4.11, 1.4.10, 1.4.12: hidden carets, stacked panels, shadow overflow at 320 and range-only clipping', async () => {
    const field = (caret: string) => `<label for="n">Card number</label> <input id="n" class="f"><style>.f{font:inherit;border:2px solid #595959;padding:6px;background:#fff;caret-color:${caret}}.f:focus,.f:focus-visible{outline:none}</style>`;
    const panels = `<div class="ps"><div class="p on"><p>Adult fares are $2 for two hours.</p><p><a href="#a">Buy an adult pass</a></p></div><div class="p"><p>Riders under 18 ride free.</p><p><a href="#y">Get a youth pass</a></p></div></div>`
      + '<style>.ps{display:grid}.p{grid-area:1/1;background:#fff}.p.on{z-index:1}</style>';
    const card = (w: string) => shadow('road-notice', `<div style="width:${w};border:1px solid #767676;padding:8px"><p>Ash Street is closed at the river bridge while the deck is replaced; use Mill Street.</p></div>`);
    const clip = (h: string) => `<section class="hrs"><p>Monday to Thursday 9 to 8.</p><p>Friday 9 to 6.</p><p>Saturday 10 to 5.</p><p>Sunday 1 to 5.</p></section><style>.hrs p{margin:0;line-height:20px}@media (min-width:900px) and (max-width:1100px){.hrs{height:${h};overflow:hidden;border:1px solid #767676}}</style>`;
    const wrong = await verdicts([
      ['caret transparent', '2.4.7', 'fail', page('', field('transparent'))],
      ['caret shows', '2.4.7', 'pass', page('', field('#222222'))],
      ['stacked panels', '2.4.11', 'fail', page('', panels)],
      ['shadow card wider than 320', '1.4.10', 'fail', page('', card('600px'))],
      ['shadow card that reflows', '1.4.10', 'pass', page('', card('auto'))],
      ['clip only at 900-1100 with spacing', '1.4.12', 'fail', page('', clip('82px'))],
      ['range box with room', '1.4.12', 'pass', page('', clip('220px'))],
    ]);
    expect(wrong).toEqual([]);
  }, 900_000);
});
