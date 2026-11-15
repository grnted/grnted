// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The ARIA state conflicts test (4.1.2) in real Chromium: the page reader on small pages. Its rules on
// what the reader reports: test/unit/ariaStates.test.ts.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARIA_STATES_LIMITS, readAriaStates, type AriaStatesRead } from '../../src/probes/ariaStates.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function readOn(body: string): Promise<AriaStatesRead> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`, { waitUntil: 'load' });
    return await page.evaluate(readAriaStates, ARIA_STATES_LIMITS);
  } finally {
    await page.close();
  }
}
const kinds = async (body: string) => (await readOn(body)).conflicts.map((c) => c.kind);

describe('readAriaStates', () => {
  it('finds nothing when every state matches what is shown', async () => {
    expect(await kinds(`
      <button aria-expanded="false" aria-controls="m1">Menu</button><ul id="m1" hidden><li>A</li></ul>
      <button aria-expanded="true" aria-controls="m2">Open</button><ul id="m2"><li>Shown</li></ul>
      <div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1">One</button><button role="tab" aria-selected="false" aria-controls="p2">Two</button></div>
      <div role="tabpanel" id="p1">Panel one</div><div role="tabpanel" id="p2" hidden>Panel two</div>
      <input required aria-required="true" aria-label="Email">
      <details open><summary aria-expanded="true">More</summary>Text</details>`)).toEqual([]);
  });

  it('finds a control that says it is expanded while what it controls is hidden', async () => {
    const r = await readOn('<button aria-expanded="true" aria-controls="m">Menu</button><ul id="m" style="display:none"><li>A</li></ul>');
    expect(r.conflicts).toEqual([expect.objectContaining({ kind: 'expanded-hidden', name: 'Menu' })]);
  });

  it('finds a visible control that says it is collapsed while what it controls is shown', async () => {
    expect(await kinds('<button aria-expanded="false" aria-controls="m">Menu</button><ul id="m"><li>Shown item</li></ul>')).toEqual(['collapsed-shown']);
  });

  it('does not judge what it cannot be sure of: hidden toggles, clipped or off-screen panels, missing targets', async () => {
    expect(await kinds(`
      <button aria-expanded="false" aria-controls="a" style="display:none">Hidden toggle</button><ul id="a"><li>Desktop menu</li></ul>
      <button aria-expanded="false" aria-controls="b">Off screen</button><ul id="b" style="position:absolute;left:-9999px"><li>x</li></ul>
      <button aria-expanded="false" aria-controls="c">Clipped</button><div style="height:0;overflow:hidden"><ul id="c"><li>x</li></ul></div>
      <button aria-expanded="false" aria-controls="d">Faded</button><ul id="d" style="opacity:0"><li>x</li></ul>
      <button aria-expanded="true" aria-controls="nowhere">No target</button>
      <div id="e"><button aria-expanded="false" aria-controls="e">Toggle inside its own panel</button>Panel</div>`)).toEqual([]);
  });

  it('finds more than one selected item in a single-selection tab list, list box or radio group', async () => {
    expect(await kinds(`
      <div role="tablist"><span role="tab" aria-selected="true">One</span><span role="tab" aria-selected="true">Two</span></div>
      <div role="listbox" aria-label="Pick"><div role="option" aria-selected="true">A</div><div role="option" aria-selected="true">B</div></div>
      <div role="radiogroup" aria-label="Size"><span role="radio" aria-checked="true">S</span><span role="radio" aria-checked="true">M</span></div>
      <div role="listbox" aria-multiselectable="true" aria-label="Many"><div role="option" aria-selected="true">A</div><div role="option" aria-selected="true">B</div></div>`))
      .toEqual(['multiple-selected', 'multiple-selected', 'multiple-selected']);
  });

  it('finds a selected tab whose panel is hidden', async () => {
    expect(await kinds('<div role="tablist"><button role="tab" aria-selected="true" aria-controls="p">One</button></div><div role="tabpanel" id="p" hidden>One</div>')).toEqual(['selected-panel-hidden']);
  });

  it('finds ARIA states that contradict the element\'s own HTML state', async () => {
    const r = await readOn(`
      <input required aria-required="false" aria-label="Email">
      <button disabled aria-disabled="false">Send</button>
      <textarea readonly aria-readonly="false" aria-label="Notes"></textarea>
      <input type="radio" name="r" checked aria-checked="false" aria-label="Yes">
      <details><summary aria-expanded="true">More</summary>Text</details>
      <select aria-label="Pick"><option selected aria-selected="false">A</option><option>B</option></select>`);
    expect(r.conflicts.map((c) => [c.kind, c.attribute])).toEqual([
      ['native-mismatch', 'aria-required'], ['native-mismatch', 'aria-disabled'], ['native-mismatch', 'aria-readonly'],
      ['native-mismatch', 'aria-checked'], ['native-mismatch', 'aria-expanded'], ['native-mismatch', 'aria-selected'],
    ]);
  });

  it('skips everything hidden from assistive technology', async () => {
    expect(await kinds('<div aria-hidden="true"><button tabindex="-1" aria-expanded="true" aria-controls="m">Menu</button></div><ul id="m" hidden></ul><div style="display:none"><input required aria-required="false"></div>')).toEqual([]);
  });
});
