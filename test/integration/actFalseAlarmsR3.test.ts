// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Fresh, independently authored round-three counterexamples; no ACT fixture markup.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { motionActuationProbe } from '../../src/probes/actuation.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function probe(html: string, checks: PageProbe[]) {
  const server = await startFixtureServer('contrast', { '/case.html': { type: 'text/html', body: html } });
  try {
    const incomplete = [{ id: 'color-contrast', help: 'Text contrast', helpUrl: 'https://example.test', nodes: [{ target: '#symbol', viewports: ['desktop' as const], html: '<button id="symbol">X</button>', failureSummary: 'Element content is too short to determine if it is actual text content' }] }];
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/case.html`, index: 0, incomplete }], checks, { userAgent: 'grnted-test', full: true, concurrency: 1 });
    for (const run of runs) expect(run.status, JSON.stringify(run)).toBe('ok');
    return runs.flatMap((run) => run.findings);
  } finally { await server.close(); }
}

const icon = (color: string, label = 'aria-label="Close"', content = 'X') => `<style>
body { background:white; } #symbol { font:16px Arial; color:${color}; background:linear-gradient(white,white); border:0; width:40px; height:40px; }
</style><button id="symbol" ${label}>${content}</button>`;

it('R6: a visible X named Close at 3.6:1 is a graphic measured at 3:1', async () => {
  const findings = await probe(icon('#868686'), [textContrastProbe, nonTextContrastProbe]);
  expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.3', status: 'failed' }));
  expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'failed' }));
  expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'not_applicable' }));
}, 60_000);

it('R6: ordinary digits and a character that is its own accessible name stay text', async () => {
  for (const html of [
    icon('#868686', 'aria-label="X"'),
    icon('#868686', 'title="Close"'), // Contents win over title in the computed name.
    icon('#868686').replace('<button id="symbol" aria-label="Close">X</button>', '<p id="symbol">7</p>'),
    icon('#868686', 'aria-label="Page 7"', '7'),
    icon('#868686', 'aria-label="Close"', 'XX'),
  ]) {
    const findings = await probe(html, [textContrastProbe, nonTextContrastProbe]);
    expect(findings).toContainEqual(expect.objectContaining({ criterion: '1.4.3', status: 'failed', target: '#symbol' }));
    expect(findings).toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'not_applicable' }));
  }
}, 90_000);

it('R6: labelledby precedence, a descendant character and an effective title name are graphic evidence', async () => {
  for (const html of [
    `<span id="close" hidden>Close</span>${icon('#868686', 'aria-labelledby="close" aria-label="X"')}`,
    icon('#868686').replace('id="symbol" aria-label="Close">X', 'aria-label="Close"><span id="symbol">X</span>'),
    icon('#868686', 'role="slider" tabindex="0" title="Close"').replaceAll('button', 'div'),
  ]) {
    const findings = await probe(html, [textContrastProbe, nonTextContrastProbe]);
    expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.3', status: 'failed' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'not_applicable' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'not_testable' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'failed' }));
  }
}, 90_000);

it('R6: the same named graphic at 2.5:1 fails non-text contrast', async () => {
  const findings = await probe(icon('#a3a3a3'), [textContrastProbe, nonTextContrastProbe]);
  expect(findings).toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'failed', target: '#symbol' }));
  expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '1.4.3', status: 'failed' }));
}, 60_000);

it('R6: ordinary numbered controls do not consume the icon measurement limit', async () => {
  for (const label of ['', 'aria-label="Page 7"', 'aria-labelledby="number"', 'title="Page 7"']) {
    const numbers = `<button ${label} style="width:40px;height:40px">7</button>`.repeat(20);
    expect(await probe('<span id="number" hidden>7</span>' + numbers + icon('#a3a3a3'), [nonTextContrastProbe]))
      .toContainEqual(expect.objectContaining({ criterion: '1.4.11', status: 'failed', target: '#symbol' }));
  }
}, 60_000);

const trap = (before: string, inside = '', attributes = '') => `${before}
<section aria-label="Date picker"><p>${inside}</p><input id="held" aria-label="Appointment date" ${attributes}></section>
<a href="#next">Read the next article</a>
<script>held.onblur=()=>setTimeout(()=>held.focus(),20);</script>`;

for (const [name, before, inside] of [
  ['page prose outside the widget', '<p>Leave a rating after your visit.</p>', ''],
  ['a heading beside the widget', '<h2>Closing observations</h2>', ''],
  ['an unrelated section next to the widget', '<section><p>Exit interviews happen on Fridays.</p></section>', ''],
  ['an unrelated object inside the widget', '', 'Close your account through customer support.'],
  ['a generic leave word inside the widget', '', 'We are leaving soon.'],
]) {
  it(`R8: ${name} cannot make a definite trap uncertain`, async () => {
    const findings = await probe(trap(before!, inside), [keyboardProbe]);
    expect(findings).toContainEqual(expect.objectContaining({ criterion: '2.1.2', status: 'failed' }));
    expect(findings).not.toContainEqual(expect.objectContaining({ criterion: '2.1.2', status: 'not_testable' }));
  }, 90_000);
}

const motion = (handler: string) => `<section style="width:320px;height:120px">
<output id="level">20</output><button type="button" onclick="${handler}">Increase</button>
<button type="button" onclick="enabled=false">Turn motion off</button></section>
<script>let enabled=true; addEventListener('deviceorientation',()=>{if(enabled)level.textContent=Number(level.textContent)+2});</script>`;

for (const [name, handler] of [['a no-op candidate', ''], ['only its own state', "this.setAttribute('aria-pressed','true')"]]) {
  it(`R9: ${name} is no plausible alternative to the motion function`, async () => {
    expect(await probe(motion(handler!), [motionActuationProbe])).toContainEqual(expect.objectContaining({ criterion: '2.5.4', status: 'failed' }));
  }, 60_000);
}

it('R9: a known different target is no alternative, but replacing the motion target is a real unknown', async () => {
  const different = motion("other.textContent='Changed'").replace('<output id="level">', '<output id="other">Status</output><output id="level">');
  expect(await probe(different, [motionActuationProbe])).toContainEqual(expect.objectContaining({ criterion: '2.5.4', status: 'failed' }));
  const replaced = motion("level.outerHTML='<output id=level>25</output>'");
  expect(await probe(replaced, [motionActuationProbe])).toContainEqual(expect.objectContaining({ criterion: '2.5.4', status: 'not_testable' }));
  expect(await probe(motion('level.textContent=Number(level.textContent)+2'), [motionActuationProbe]))
    .toContainEqual(expect.objectContaining({ criterion: '2.5.4', status: 'no_failures_found' }));
}, 90_000);

it('R8: owned unknown exit advice stays uncertain, and a parsed but broken key fails', async () => {
  const unknown = trap('', 'To leave the date picker, use the special key.');
  expect(await probe(unknown, [keyboardProbe])).toContainEqual(expect.objectContaining({ criterion: '2.1.2', status: 'not_testable' }));
  expect(await probe(unknown.replace('the special key', 'Alt+W'), [keyboardProbe]))
    .toContainEqual(expect.objectContaining({ criterion: '2.1.2', status: 'failed' }));
}, 90_000);

it('R8: referenced and live exit advice is tried while focus belongs to the widget', async () => {
  const release = `<script>let heldInside=true;
held.onblur=()=>{if(heldInside)setTimeout(()=>{if(heldInside)held.focus()},20)};
addEventListener('keydown',e=>{if(e.altKey&&e.key.toLowerCase()==='w'){heldInside=false;document.querySelector('a').focus()}});</script>`;
  const described = trap('<p id="advice" hidden>Use Alt+W to leave the date picker.</p>', '', 'aria-describedby="advice"') + release;
  expect((await probe(described, [keyboardProbe])).filter((f) => f.criterion === '2.1.2')).toEqual([]);
  const live = trap('<p id="advice" aria-live="polite"></p>') + release
    + `<script>held.onfocus=()=>{advice.textContent='To leave the date picker, use Alt+W.'};</script>`;
  expect((await probe(live, [keyboardProbe])).filter((f) => f.criterion === '2.1.2')).toEqual([]);
}, 120_000);

for (const position of ['before', 'after']) {
  it(`R8: nearby parsed keys ${position} the widget are tried without broadening unknown advice`, async () => {
    const advice = position === 'before' ? '<p>To leave the date picker, press Alt+W.</p>' : '<h2>Press Alt+W to leave the date picker.</h2>';
    let html = trap(position === 'before' ? advice : '').replace('<input id="held" aria-label="Appointment date" >', '<button id="held">Browse days</button>');
    if (position === 'after') html = html.replace('</section>', `</section>${advice}`);
    html += `<script>let locked=true;
held.onblur=()=>{if(locked)setTimeout(()=>{if(locked)held.focus()},20)};
addEventListener('keydown',e=>{if(e.altKey&&e.key.toLowerCase()==='w'){locked=false;document.querySelector('a').focus()}});</script>`;
    expect((await probe(html, [keyboardProbe])).filter((f) => f.criterion === '2.1.2')).toEqual([]);
  }, 90_000);
}

it('R8: unparsed exit prose outside the widget does not create uncertainty', async () => {
  const html = trap('<h2>To leave the date picker, press Hyper+W.</h2>')
    .replace('<input id="held" aria-label="Appointment date" >', '<button type="button" id="held">Browse days</button>');
  expect(await probe(html, [keyboardProbe]))
    .toContainEqual(expect.objectContaining({ criterion: '2.1.2', status: 'failed' }));
}, 90_000);
