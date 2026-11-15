// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, round 3 (break-it pages written from the atlas text found two more assumptions):
// - a focus ring is drawn by the element itself (an outline, a shadow, a border): a ring a ::before or ::after draws is
//   measured on its own box the same way (1.4.11);
// - a box named or built like a carousel only ever moves slides into view: wrapped prose wider than such a box is read
//   by scrolling sideways line by line, whatever the box is called (1.4.10);
// - a link cue a pseudo-element draws counts only when it shows at rest: a bar cut away by clip-path is no cue (1.4.1;
//   round 2 counted it, so such a link went unreported);
// - (precision, found by the labs) SVG text whose fill is read from its style is measured with that colour, as other
//   text is: a fill of 4.5:1 over a drawn backdrop is not failed from its anti-aliased pixels (1.4.3).
// One failing page and the look-alikes per assumption.
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
const page = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Town services</title>
<style>*,*::before,*::after{box-sizing:border-box} body{font:16px/1.5 Arial,sans-serif;margin:0;color:#222;background:#fff} main{max-width:60rem;margin:0 auto;padding:16px}
a{color:#0b4f8a;text-decoration:underline} :focus-visible{outline:3px solid #1a1a1a;outline-offset:2px} ${css}</style></head>
<body><main><h1>Town services</h1><p>Find permits, parks and library hours for residents and visitors of the town.</p>${body}</main></body></html>`;

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

describe('visual round 3: wider assumptions', () => {
  it('1.4.11: a focus ring drawn by a pseudo-element fails when faint; a strong one, or one next to a fill change, does not', async () => {
    const card = (rule: string, also = '') => page(
      `.tile{position:relative;display:block;max-width:24rem;padding:1.25rem;border:1px solid #6b7280;border-radius:8px;color:#1f2933;text-decoration:none}.tile:focus{outline:none;${also}}.tile:focus${rule}`,
      '<section><h2>Licenses</h2><a class="tile" href="/dog-license/"><b>Renew a dog license</b> Online, about five minutes</a></section>');
    const wrong = await verdicts([
      ['after border, faint', '1.4.11', 'fail', card('::after{content:"";position:absolute;inset:4px;border:2px solid #e4e4e4;border-radius:5px}')],
      ['before spread shadow, faint', '1.4.11', 'fail', card('::before{content:"";position:absolute;inset:0;box-shadow:0 0 0 3px #d6d6d6;border-radius:8px}')],
      ['after border, strong', '1.4.11', 'pass', card('::after{content:"";position:absolute;inset:4px;border:2px solid #595959;border-radius:5px}')],
      ['after border, faint, the fill changes too', '1.4.11', 'pass', card('::after{content:"";position:absolute;inset:4px;border:2px solid #e4e4e4}', 'background:#1a3d6b;color:#fff')],
    ]);
    expect(wrong).toEqual([]);
  }, 240_000);

  it('1.4.10: wrapped prose wider than a box named like a scroller or a slider fails; slides that fit and a ticker line do not', async () => {
    const prose = '<p>Call the school office before 9 a.m. on any day your student will be absent; absences without a call are marked unexcused after two days.</p>';
    const box = (cls: string, inner: string, extra = '') => page(`.${cls}{overflow-x:auto;border:1px solid #767676;padding:12px;${extra}}`, `<h2>Attendance</h2><div class="${cls}" tabindex="0" role="region" aria-label="Attendance">${inner}</div>`);
    const wrong = await verdicts([
      ['named scroller, two 20rem columns', '1.4.10', 'fail', box('notice-scroller', `<div style="display:grid;grid-template-columns:repeat(2,20rem);gap:16px"><div>${prose}</div><div>${prose}</div></div>`)],
      ['named slider, one 24rem column', '1.4.10', 'fail', box('card-slider', `<div style="width:24rem">${prose}</div>`)],
      ['snap track, slides that fit', '1.4.10', 'pass', box('slides', `<div style="flex:0 0 100%;scroll-snap-align:start">${prose}</div><div style="flex:0 0 100%;scroll-snap-align:start">${prose}</div>`, 'display:flex;gap:16px;scroll-snap-type:x mandatory')],
      ['named ticker, one line', '1.4.10', 'pass', box('news-ticker', '<span>Ash Street is closed at the river bridge while the deck is replaced; use Mill Street until the spring.</span>', 'white-space:nowrap')],
    ]);
    expect(wrong).toEqual([]);
  }, 240_000);

  it('1.4.1: a link whose underline bar is cut away by clip-path at rest fails; a bar that shows passes', async () => {
    const link = (bar: string) => page(`.notice a{color:#1f5f9e;text-decoration:none;position:relative}.notice a::before{content:"";position:absolute;left:0;right:0;bottom:-2px;height:2px;background:currentColor;${bar}}.notice{color:#2b2b2b}`,
      '<p class="notice">Bulk pickup runs the first week of each month. <a href="/bulk">See what we collect</a> before you put items at the curb.</p>');
    expect(await verdicts([['bar cut away', '1.4.1', 'fail', link('clip-path:inset(0 100% 0 0)')], ['bar shows', '1.4.1', 'pass', link('clip-path:inset(0)')]])).toEqual([]);
  }, 120_000);

  it('1.4.3: SVG text over a drawn backdrop is measured with its fill: #767676 (4.5:1) passes, #b0b0b0 fails', async () => {
    const svg = (fill: string) => page('', `<svg width="460" height="68" viewBox="0 0 460 68"><rect width="460" height="68" fill="#ffffff"/><text x="10" y="36" font-size="16" style="fill:${fill}">Weekday riders rose four percent this spring.</text></svg>`);
    expect(await verdicts([['svg text #767676', '1.4.3', 'pass', svg('#767676')], ['svg text #b0b0b0', '1.4.3', 'fail', svg('#b0b0b0')]])).toEqual([]);
  }, 120_000);
});
