// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The elements a test's undecided and failing findings name (src/probes/elementFacts.ts, `ProbeRun.elements`), read in
// real Chromium: the start tag, text, box, computed facts, the text after it, its container and the controls in it;
// only for failed, not-testable and flagged findings with a CSS path; capped; never a request; a path into a shadow root;
// a path that matches nothing or is not CSS is described as found 0 or left out.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ELEMENT_FACTS_MAX, ELEMENT_FACTS_TEXT, elementFacts, factTargets } from '../../src/probes/elementFacts.js';
import type { PageLike, ProbeFinding } from '../../src/types.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const HTML = `<!doctype html><html lang="en"><head><title>T</title><style>
  .lead { font-size: 26px; font-weight: 700; color: #333; } .faint { color: #bbb; background: #fff; }
</style></head><body><main><h1>Water</h1>
  <section class="card"><p class="lead" id="hours">Hours and location</p><p>Open Monday to Thursday.</p>
    <a href="/map">Map</a> <button type="button">Print</button></section>
  <table id="fees"><tr><td>Date</td><td>Fee</td></tr><tr><td>Jan</td><td>$4</td></tr></table>
  <p class="faint" id="faint">${'long words '.repeat(80)}</p>
  <div id="host"></div>
</main><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id="inner">Inside</button>';</script></body></html>`;

const f = (status: ProbeFinding['status'], target: string | undefined, extra: Partial<ProbeFinding> = {}): ProbeFinding => ({ criterion: '1.3.1', status, detail: 'd', ...(target ? { target } : {}), ...extra });

async function on<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    await page.setContent(HTML, { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await page.close();
  }
}

describe('the elements a test names', () => {
  it('describes the targets of failed, not-testable and flagged findings only, each once, CSS paths only', () => {
    expect(factTargets([
      f('flagged', '#hours'), f('failed', '#fees'), f('not_testable', '#faint'), f('failed', '#hours'),
      f('no_failures_found', '#x'), f('not_testable', '#y', { timeLimit: true }), f('not_testable', '#z', { loadFailure: 'not-loaded' }),
      f('failed', 'Heard: “Customer Service”'), f('failed', undefined), f('not_testable', '#adv', { advice: true }),
    ])).toEqual(['#hours', '#fees', '#faint']);
    expect(factTargets(Array.from({ length: 40 }, (_, i) => f('failed', `#e${i}`)))).toHaveLength(ELEMENT_FACTS_MAX);
  });

  it('reads the element, the text after it, its container and the controls in it, and requests nothing', async () => {
    await on(async (page) => {
      let requests = 0;
      page.on('request', () => { requests++; });
      const facts = await elementFacts(page as unknown as PageLike, [f('flagged', '#hours'), f('failed', '#fees'), f('not_testable', '#nowhere'), f('failed', 'p:::bad')]);
      expect(requests).toBe(0);
      const hours = facts!.find((e) => e.target === '#hours')!;
      expect(hours).toMatchObject({ found: 1, tag: '<p class="lead" id="hours">', text: 'Hours and location', next: { tag: 'p', text: 'Open Monday to Thursday.' } });
      expect(hours.style).toMatchObject({ fontSize: '26px', fontWeight: '700', color: 'rgb(51, 51, 51)', display: 'block' });
      expect(hours.box![2]).toBeGreaterThan(0);
      expect(hours.container!.tag).toBe('<section class="card">');
      expect(hours.controls).toEqual([{ tag: '<a href="/map">', text: 'Map' }, { tag: '<button type="button">', text: 'Print' }]);
      expect(facts!.find((e) => e.target === '#fees')).toMatchObject({ found: 1, tag: '<table id="fees">' });
      expect(facts!.find((e) => e.target === '#nowhere')).toEqual({ target: '#nowhere', found: 0 });
      expect(facts!.find((e) => e.target === 'p:::bad')).toEqual({ target: 'p:::bad', found: 0 });
    });
  });

  it('cuts long text, goes into an open shadow root by the engine\'s path, and gives nothing when nothing is named', async () => {
    await on(async (page) => {
      const [faint, inner] = (await elementFacts(page as unknown as PageLike, [f('failed', '#faint'), f('failed', '#host >>> #inner')]))!;
      expect(faint!.text!.length).toBeLessThanOrEqual(ELEMENT_FACTS_TEXT);
      expect(faint!.text!.endsWith('…')).toBe(true);
      expect(inner).toMatchObject({ found: 1, tag: '<button id="inner">', text: 'Inside' });
      expect(await elementFacts(page as unknown as PageLike, [f('no_failures_found', '#hours')])).toBeUndefined();
    });
  });
});
