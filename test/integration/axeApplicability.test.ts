// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What the engine re-checks in the page after axe (src/axeRun.ts, keepNode), in real Chromium:
// - 1.4.12: ACT 24afc2 / 9e45ec / 78fd32 apply only to an element with visible text node children;
//   axe's avoid-inline-spacing also fails a wrapper whose text is all in its children.
// - 2.5.8: the Equivalent exception is not applied (cut in review round 2); axe's nodes stand.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAxe } from '../../src/axeRun.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { AxeRun, PageLike } from '../../src/types.js';

let browser: Browser;
let axeSource: string;

beforeAll(async () => {
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
}, 60_000);
afterAll(async () => { await browser?.close(); });

const doc = (body: string, css = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test page</title><style>body { font: 16px Arial; } ${css}</style></head><body><main><h1>Test page</h1>${body}</main></body></html>`;

async function axeOn(html: string): Promise<AxeRun> {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return (await runAxe(page as unknown as PageLike, axeSource)).run;
  } finally {
    await page.close();
  }
}

const targets = (run: AxeRun, id: string) => run.violations.find((v) => v.id === id)?.nodes.map((n) => n.target) ?? [];

describe('avoid-inline-spacing (1.4.12): only elements with text of their own', () => {
  it('passes an !important spacing on a wrapper whose text is in its children (ACT 24afc2 does not apply)', async () => {
    const run = await axeOn(doc('<div id="wrap" style="letter-spacing: 0.05em !important"><p>Council meets on Thursday.</p><p>All are welcome.</p></div>'));
    expect(targets(run, 'avoid-inline-spacing')).toEqual([]);
    expect(run.passes).toContain('avoid-inline-spacing');
  });

  it('still fails the same declaration on an element with its own text, and keeps only that node next to a wrapper', async () => {
    const run = await axeOn(doc(`<div id="wrap" style="word-spacing: 2px !important"><p>Wrapped text.</p></div>
<p id="own" style="letter-spacing: 0.05em !important">Council meets on Thursday.</p>`));
    expect(targets(run, 'avoid-inline-spacing')).toEqual(['#own']);
    expect(run.passes).not.toContain('avoid-inline-spacing');
  });

  it('counts text beside child elements as the element\'s own, and ignores whitespace-only text', async () => {
    const run = await axeOn(doc(`<p id="mixed" style="letter-spacing: 0.05em !important">Read the <a href="#x">agenda</a> today.</p>
<div id="ws" style="letter-spacing: 0.05em !important">
  <span>Only in a child.</span>
</div>`));
    expect(targets(run, 'avoid-inline-spacing')).toEqual(['#mixed']);
  });

  it('applies the same rule inside a same-origin frame', async () => {
    const inner = '<div id="w" style="letter-spacing: 0.05em !important"><p>In a child.</p></div><p id="t" style="letter-spacing: 0.05em !important">Own text.</p>';
    const run = await axeOn(doc(`<iframe id="f" title="Frame" srcdoc='${inner.replace(/'/g, '&#39;')}' width="400" height="200"></iframe>`));
    expect(targets(run, 'avoid-inline-spacing')).toEqual(['#f >>> #t']);
  });
});

const ICON = '<svg width="12" height="12" aria-hidden="true"><rect width="12" height="12"/></svg>';
const SMALL = '.ic { width: 16px; height: 16px; padding: 0; border: 0; background: #fff; line-height: 0; display: inline-block; } .tb { display: flex; gap: 0; } .full { font: 16px Arial; min-height: 44px; padding: 8px 16px; }';
// Review round 1 (Grok, pf2-r1): each input below was wrong on a2617b42.
describe('review round 1: avoid-inline-spacing keeps a node whose selector is not unique', () => {
  it('keeps both #x nodes when a duplicate id makes the selector name a wrapper and a paragraph', async () => {
    // axe picks unique selectors when it runs; a duplicate id arrives before the frames' results are
    // finished (between runPartial in the frame and finishRun in the page), so "#f >>> #x" then names
    // a wrapper first and the paragraph second.
    const page = await browser.newPage();
    try {
      await page.setContent(doc(`<iframe id="f" title="Frame" width="400" height="200" srcdoc='<p id="x" style="letter-spacing: 0.05em !important">Locked own text.</p>'></iframe>`));
      await page.waitForFunction(() => !!(document.getElementById('f') as HTMLIFrameElement).contentDocument?.getElementById('x'));
      const main = page.mainFrame();
      const evaluate = main.evaluate.bind(main) as (fn: unknown, arg?: unknown) => Promise<unknown>;
      (main as unknown as { evaluate: typeof evaluate }).evaluate = async (fn, arg) => {
        if ((arg as { step?: string } | undefined)?.step === 'finish') {
          await evaluate(() => {
            (document.getElementById('f') as HTMLIFrameElement).contentDocument!.body
              .insertAdjacentHTML('afterbegin', '<div id="x" style="letter-spacing: 0.05em !important"><p>Only in a child.</p></div>');
          });
        }
        return evaluate(fn, arg);
      };
      const run = (await runAxe(page as unknown as PageLike, axeSource)).run;
      expect(targets(run, 'avoid-inline-spacing')).toEqual(['#f >>> #x']);
      expect(run.passes).not.toContain('avoid-inline-spacing');
    } finally {
      await page.close();
    }
  });
});

describe('review round 2: avoid-inline-spacing keeps text that is not a light-DOM text node', () => {
  // axe-core 4.14 does not apply avoid-inline-spacing to these two (inapplicable: its visible-text
  // matcher does not read a field's value or ::before content), so nothing is reported and nothing is
  // dropped; ownText would keep them if axe reported them. Recorded so a change in axe shows here.
  it('a field whose value is shown, and a button whose only label is ::before content: axe does not report them', async () => {
    const field = await axeOn(doc('<label>Search <input id="q" style="letter-spacing: 0 !important" value="Search"></label>'));
    expect(field.inapplicable).toContain('avoid-inline-spacing');
    const pseudo = await axeOn(doc('<button type="button" id="nx" style="letter-spacing: 0 !important"></button>', '#nx::before { content: "Next"; }'));
    expect(pseudo.inapplicable).toContain('avoid-inline-spacing');
  });

  it('a custom element with the style on the host and the words in its shadow tree', async () => {
    const run = await axeOn(doc(`<word-box id="wb" style="letter-spacing: 0 !important"></word-box>
<script>
  customElements.define('word-box', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<style>:host { display: block; }</style><span>Council meets on Thursday.</span>'; }
  });
</script>`));
    expect(targets(run, 'avoid-inline-spacing')).toEqual(['#wb']);
  });
});

describe('target-size (2.5.8): the Equivalent exception is not applied', () => {
  it('an icon toolbar whose functions are also full-size buttons on the page still fails (a known false failure)', async () => {
    const run = await axeOn(doc(`<div class="tb" role="toolbar" aria-label="Format">${['Bold', 'Italic', 'Underline'].map((n) => `<button type="button" aria-label="${n}" class="ic">${ICON}</button>`).join('')}</div>
<p>${['Bold', 'Italic', 'Underline'].map((n) => `<button type="button" class="full">${n}</button>`).join(' ')}</p>`, SMALL));
    expect(targets(run, 'target-size')).toHaveLength(3);
  });
});

// 2026-11-09 benchmark review. frame-focusable-content (2.1.1) fails a frame with focusable content that is taken out
// of the Tab order. A frame behind an open modal dialog (or inside an inert region) is out of the Tab order for every
// element anyway: the page leaves it there while the dialog is open, so its tabindex=-1 removes nothing.
describe('frame-focusable-content (2.1.1): not while a modal dialog makes the frame inert', () => {
  const frame = `<iframe id="f" title="Opening hours" srcdoc="<a href='/hours'>All opening hours</a>" width="300" height="80"></iframe>`;
  it('passes a frame given tabindex=-1 while a modal dialog is open, and one inside an inert region', async () => {
    const modal = await axeOn(doc(`${frame}<dialog id="d"><p>Accept the terms?</p><button>OK</button></dialog>
<script>document.getElementById('d').showModal(); document.getElementById('f').tabIndex = -1;</script>`));
    expect(targets(modal, 'frame-focusable-content')).toEqual([]);
    const inert = await axeOn(doc(`<div inert>${frame.replace('id="f"', 'id="f" tabindex="-1"')}</div>`));
    expect(targets(inert, 'frame-focusable-content')).toEqual([]);
  });

  it('still fails the same frame with tabindex=-1 when no dialog is open, and a frame inside the open dialog', async () => {
    const plain = await axeOn(doc(frame.replace('id="f"', 'id="f" tabindex="-1"')));
    expect(targets(plain, 'frame-focusable-content')).toEqual(['#f >>> html']);
    const inDialog = await axeOn(doc(`<dialog id="d"><p>Map</p>${frame.replace('id="f"', 'id="f" tabindex="-1"')}<button>Close</button></dialog>
<script>document.getElementById('d').showModal();</script>`));
    expect(targets(inDialog, 'frame-focusable-content')).toEqual(['#f >>> html']);
  });
});

it('R5: browser focus preserves modal exceptions to inertness and the topmost dialog', async () => {
  // Supply axe's reported node so this exercises Granted's filtering even when axe itself skips
  // an inert ancestor. Focus and modal behavior are still measured by real Chromium.
  const recorded = async (html: string, target: (string | string[])[] = ['#f', 'html']) => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const source = `window.axe={utils:{getFrameContexts:()=>[]},run:async()=>({violations:[{id:'frame-focusable-content',help:'Frame focus',helpUrl:'https://example.test',nodes:[{target:${JSON.stringify(target)},html:'<html>'}]}],incomplete:[],passes:[],inapplicable:[]})}`;
      return (await runAxe({ evaluate: page.evaluate.bind(page), addScriptTag: page.addScriptTag.bind(page) } as unknown as PageLike, source)).run;
    } finally { await page.close(); }
  };
  const frame = `<iframe id="f" tabindex="-1" title="Help" srcdoc="<a href='/help'>Open help</a>"></iframe>`;
  const escaped = await recorded(`<div inert><dialog id="d">${frame}</dialog></div><script>d.showModal();</script>`);
  expect(targets(escaped, 'frame-focusable-content')).toEqual(['#f >>> html']);
  const topmost = await recorded(`<dialog id="first"><button>First</button></dialog><dialog id="second">${frame}</dialog>
<script>first.showModal();second.showModal();</script>`);
  expect(targets(topmost, 'frame-focusable-content')).toEqual(['#f >>> html']);
  const inactive = await recorded(`<dialog id="first">${frame}</dialog><dialog id="second"><button>Second</button></dialog>
<script>first.showModal();second.showModal();</script>`);
  expect(targets(inactive, 'frame-focusable-content')).toEqual([]);
  const shadow = `<x-help id="host"></x-help><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(frame)};</script>`;
  expect(targets(await recorded(shadow, [['#host', '#f'], 'html']), 'frame-focusable-content')).toEqual(['#host >>> #f >>> html']);
  expect(targets(await recorded(shadow.replace('id="host"', 'id="host" inert'), [['#host', '#f'], 'html']), 'frame-focusable-content')).toEqual([]);
});

describe('4.1.2 benchmark review: names do not replace required roles and states', () => {
  it('keeps duplicate frame names for review, and still fails a frame with no name', async () => {
    const run = await axeOn(doc(`<iframe id="hours" title="Community information" srcdoc="<p>Open on weekdays.</p>"></iframe>
<iframe id="fees" title="Community information" srcdoc="<p>Admission costs five dollars.</p>"></iframe>
<iframe id="unnamed" srcdoc="<p>Directions to the entrance.</p>"></iframe>`));
    expect(targets(run, 'frame-title-unique')).toEqual([]);
    expect(run.incomplete.find((r) => r.id === 'frame-title-unique')?.nodes.map((n) => n.target).sort()).toEqual(['#fees', '#hours']);
    expect(targets(run, 'frame-title')).toEqual(['#unnamed']);
  });

  // W3C precision lane (2026-11-11): a missing state with a resting default no longer fails by itself (below,
  // 'states with a default value'); the 2026-11-09 review had kept #unchecked and #unexpanded failing.
  it('accepts named custom controls with required state, and keeps their missing-state look-alikes for review', async () => {
    const run = await axeOn(doc(`<div id="plain" aria-label="Reading total">12</div>
<div id="checked" role="checkbox" aria-label="Include weekends" aria-checked="false" tabindex="0"></div>
<div id="unchecked" role="checkbox" aria-label="Include holidays" tabindex="0"></div>
<div id="expanded" role="combobox" aria-label="Branch" aria-disabled="true" aria-expanded="false">North</div>
<div id="unexpanded" role="combobox" aria-label="District" aria-disabled="true">East</div>`));
    expect(targets(run, 'aria-input-field-name')).toEqual([]);
    expect(targets(run, 'aria-required-attr')).toEqual([]);
    expect(reviewTargets(run, 'aria-required-attr')).toEqual(['#unchecked', '#unexpanded']);
  });
});

const reviewTargets = (run: AxeRun, id: string) => run.incomplete.find((v) => v.id === id)?.nodes.map((n) => n.target).sort() ?? [];

// W3C precision lane (2026-11-11). Three axe checks are stricter than the WCAG criterion they stand for where the page's
// own answer is a default the browser gives: their nodes there move to "needs a human check" (incomplete), never dropped
// and never scored; everything else they report still fails.
describe('states with a default value (4.1.2): for review, not failures', () => {
  it('a checkbox, radio, switch and menu items with no aria-checked, a heading with no aria-level, a combobox with no aria-expanded', async () => {
    const run = await axeOn(doc(`<div id="cb" role="checkbox" tabindex="0">Email me the agenda</div>
<div role="radiogroup" aria-label="Pickup"><span id="rd" role="radio" tabindex="0">Curbside</span></div>
<span id="sw" role="switch" tabindex="0" aria-label="Dark mode"></span>
<div role="menu" aria-label="View"><div id="mc" role="menuitemcheckbox" tabindex="-1">Show weekends</div><div id="mr" role="menuitemradio" tabindex="-1">Month</div></div>
<div id="hd" role="heading">Council agenda</div>
<div id="co" role="combobox" aria-label="Branch" tabindex="0">North</div>`));
    expect(targets(run, 'aria-required-attr')).toEqual([]);
    expect(reviewTargets(run, 'aria-required-attr')).toEqual(['#cb', '#co', '#hd', '#mc', '#mr', '#rd', '#sw']);
    const nodes = run.incomplete.find((v) => v.id === 'aria-required-attr')!.nodes;
    expect(nodes.find((n) => n.target === '#cb')!.failureSummary).toMatch(/^Not counted as a failure: the missing aria-checked reads as not checked/);
    // Fable review F1: a checked or expanded state left to the default is unknown (its criterion reads not tested); a level is not.
    expect(nodes.filter((n) => n.unknownState).map((n) => n.target).sort()).toEqual(['#cb', '#co', '#mc', '#mr', '#rd', '#sw']);
  });

  it('still fails a missing value (slider, scrollbar, meter, focusable separator) and an expanded combobox with no aria-controls', async () => {
    const run = await axeOn(doc(`<div id="sl" role="slider" tabindex="0" aria-label="Volume"></div>
<div id="sb" role="scrollbar" aria-controls="pane" aria-label="Scroll"></div><div id="pane">Text</div>
<div id="me" role="meter" aria-label="Storage"></div>
<div id="se" role="separator" tabindex="0" aria-label="Resize"></div>
<div id="cx" role="combobox" aria-label="Library" aria-expanded="true" tabindex="0">Main</div><ul role="listbox" aria-label="Libraries"><li role="option">Main</li></ul>`));
    expect(targets(run, 'aria-required-attr').sort()).toEqual(['#cx', '#me', '#sb', '#se', '#sl']);
    expect(reviewTargets(run, 'aria-required-attr')).toEqual([]);
  });

  it('a page with both keeps the proven node failing and the default one for review', async () => {
    const run = await axeOn(doc('<div id="cb" role="checkbox" tabindex="0">Accept the terms</div><div id="sl" role="slider" tabindex="0" aria-label="Volume"></div>'));
    expect(targets(run, 'aria-required-attr')).toEqual(['#sl']);
    expect(reviewTargets(run, 'aria-required-attr')).toEqual(['#cb']);
  });

  it('an invalid aria-hidden value is for review; any other invalid value still fails, also beside one', async () => {
    const run = await axeOn(doc(`<div id="ah" aria-hidden="yes"><p>Office hours: weekdays.</p></div>
<span id="ic" class="icon" aria-hidden="1">★</span>
<button id="bt" type="button" aria-expanded="yes">Menu</button>
<button id="both" type="button" aria-hidden="hidden" aria-pressed="maybe">Bold</button>`));
    expect(targets(run, 'aria-valid-attr-value').sort()).toEqual(['#both', '#bt']);
    expect(reviewTargets(run, 'aria-valid-attr-value')).toEqual(['#ah', '#ic']);
  });
});

describe('table-fake-caption (1.3.1): a header cell across the first row is for review, a data cell still fails', () => {
  it('a column group header (th across the table, named by the headers below it) and a th title row are for review', async () => {
    const run = await axeOn(doc(`<table id="group"><tr><th id="nm" colspan="2">Name</th></tr><tr><th headers="nm">First name</th><th headers="nm">Last name</th></tr><tr><td>Ada</td><td>Lovelace</td></tr></table>
<table id="title"><thead><tr><th colspan="3">Fees for 2026</th></tr><tr><th>Item</th><th>Fee</th><th>Due</th></tr></thead><tbody><tr><td>Permit</td><td>$40</td><td>May</td></tr><tr><td>Renewal</td><td>$20</td><td>June</td></tr></tbody></table>`));
    expect(targets(run, 'table-fake-caption')).toEqual([]);
    expect(reviewTargets(run, 'table-fake-caption')).toEqual(['#group', '#title']);
  });

  it('still fails a data cell across the first row, and a th given another role', async () => {
    const run = await axeOn(doc(`<table id="td"><tr><td colspan="3"><b>Fees for 2026</b></td></tr><tr><th>Item</th><th>Fee</th><th>Due</th></tr><tr><td>Permit</td><td>$40</td><td>May</td></tr><tr><td>Renewal</td><td>$20</td><td>June</td></tr></table>
<table id="cellrole"><tr><th role="cell" colspan="3">Fees for 2026</th></tr><tr><th>Item</th><th>Fee</th><th>Due</th></tr><tr><td>Permit</td><td>$40</td><td>May</td></tr><tr><td>Renewal</td><td>$20</td><td>June</td></tr></table>`));
    expect(targets(run, 'table-fake-caption').sort()).toEqual(['#cellrole', '#td']);
    expect(reviewTargets(run, 'table-fake-caption')).toEqual([]);
  });
});
