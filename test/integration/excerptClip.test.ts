// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.4, 1.4.10 and 1.4.12: an excerpt that is cut off, with a way to its full text right after it, in real
// Chromium. A one-line teaser that fits at the desktop width is cut at 200% zoom, at 320 px and with the WCAG
// text spacing. When the next thing on the page is a link that is VERIFIED to lead to the full text (its page on
// the same site holds it, or the element it points to on this page shows it) nothing is lost: ACT rule 59br37
// passes clipped text that is "available through another mechanism".
// A control that only has the right name proves nothing (review r1, finding 8): a button that may do nothing, a
// link to "#", a page without the text. That is not an exemption and not a failure: the criterion is not
// testable there. Nor does text that is merely present where the link leads (review r2, finding 7): the place
// or page must show all of it (not a one-line box, not hidden or cut off by the page's styles).
// Look-alikes that still fail: the same teaser with nothing after it, and with a link to something else.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reflowProbe } from '../../src/probes/reflow.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { runProbes } from '../../src/probes/runner.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const TEASER = 'The harbour board agreed on Tuesday to rebuild the east quay steps before the summer ferry season, after two winters of storm damage.';
const doc = (after: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbour news</title>
<style>body { font: 16px/24px sans-serif; margin: 24px; } .teaser { height: 24px; overflow: hidden; margin: 0; }</style></head>
<body><main><h1>Harbour news</h1><h2>East quay steps to be rebuilt</h2><p class="teaser" id="teaser">${TEASER}</p>${after}<p>More news follows each Friday.</p></main></body></html>`;
const article = (text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>East quay steps</title></head><body><main><h1>East quay steps to be rebuilt</h1><p>${text}</p><p>Work starts in March.</p></main></body></html>`;

async function pages(bodies: Record<string, string>): Promise<Record<string, ProbeRun[]>> {
  const sim = await startSimServer({ files: {
    ...Object.fromEntries(Object.entries(bodies).map(([name, after]) => [`/${name}`, doc(after)])),
    '/news/quay-steps': article(TEASER),
    '/news/other-story': article('The lifeboat station opens its doors to visitors on the first Sunday of June.'),
    // Review r2, finding 7: pages that hold the text in their markup and do not show it.
    '/news/quay-steps-hidden': article(TEASER).replace('<p>', '<p class="late">').replace('</head>', '<style>.late { display: none; }</style></head>'),
    '/news/quay-steps-cut': article(TEASER).replace('<p>', '<p class="cut">').replace('</head>', '<style>.cut { width: 200px; height: 24px; overflow: hidden; margin: 0; }</style></head>'),
  } });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, Object.keys(bodies).map((name, index) => ({ url: `${sim.origin}/${name}`, index })), [reflowProbe, resizeTextProbe, textSpacingProbe], { userAgent: 'grnted-test', full: true });
    const out: Record<string, ProbeRun[]> = {};
    for (const r of runs) (out[new URL(r.page).pathname.slice(1)] ??= []).push(r);
    return out;
  } finally {
    await sim.close();
  }
}
const failedOn = (runs: ProbeRun[]) => runs.flatMap((r) => r.findings.filter((f) => f.status === 'failed').map((f) => `${f.criterion} ${f.target ?? ''}`)).sort();

const undecidedOn = (runs: ProbeRun[]) => runs.flatMap((r) => r.findings.filter((f) => f.status === 'not_testable').map((f) => `${f.criterion} ${f.target ?? ''}`)).sort();

describe('layout tests: an excerpt cut off with a way to its full text right after it', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await pages({
      more: '<a href="/news/quay-steps">Read more</a>',
      full: '<p><a href="/news/quay-steps">Full text of the quay steps story</a></p>',
      below: `<a href="#whole">Read the full story below</a><p>Other notices come first.</p><p id="whole">${TEASER}</p>`,
      button: '<button type="button">Continue reading</button>',
      hash: '<a href="#">Read more</a>',
      wrong: '<a href="/news/other-story">Read more</a>',
      gone: '<a href="/news/no-such-page">Read more</a>',
      // Review r2, finding 7: the place or page the link leads to has the text but does not show all of it.
      clipbelow: `<a href="#whole">Read the full story below</a><p>Other notices come first.</p><p id="whole" style="width:200px;height:24px;overflow:hidden;margin:0">${TEASER}</p>`,
      hidden: '<a href="/news/quay-steps-hidden">Read more</a>',
      cut: '<a href="/news/quay-steps-cut">Read more</a>',
      bare: '',
      other: '<a href="/contact">Contact the harbour office</a>',
    });
  }, 400_000);

  it('does not fail the teaser when the link after it leads to a page, or to a place on this page, that holds the full text', () => {
    for (const name of ['more', 'full', 'below']) {
      expect(failedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual([]);
      expect(undecidedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual([]);
    }
  });

  it('is not testable, never exempt, when the control only has the right name: a button, a link to "#", a page without the text, a page that is not there', () => {
    for (const name of ['button', 'hash', 'wrong', 'gone']) {
      expect(failedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual([]);
      expect(undecidedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual(['1.4.10 #teaser', '1.4.12 #teaser', '1.4.4 #teaser']);
    }
    expect(runs['button']!.flatMap((r) => r.findings).find((f) => f.criterion === '1.4.12')!.detail).toMatch(/^With the WCAG text spacing, text is cut off by its container \(“The harbour board agreed.*”\) and a control named “Continue reading” follows it; whether that control gives the full text could not be verified$/);
  });

  it('is not testable, never exempt, when the link leads to the text without showing all of it: a one-line box on this page, a page whose styles hide it or cut it off', () => {
    for (const name of ['clipbelow', 'hidden', 'cut']) {
      expect(failedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual([]);
      expect(undecidedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual(['1.4.10 #teaser', '1.4.12 #teaser', '1.4.4 #teaser']);
    }
  });

  it('look-alikes: the same teaser with nothing after it, or with a link to something else, still fails all three', () => {
    for (const name of ['bare', 'other']) expect(failedOn(runs[name]!), `${name}: ${JSON.stringify(runs[name]!.map((r) => r.findings))}`).toEqual(['1.4.10 #teaser', '1.4.12 #teaser', '1.4.4 #teaser']);
  });
});
