// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Independently authored literal counterexamples from Sol's review, with working look-alikes.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { motionProbe } from '../../src/probes/motion.js';
import { keyShortcutsProbe } from '../../src/probes/keyboard/shortcuts.js';
import { audioProbe } from '../../src/probes/audio.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { motionActuationProbe } from '../../src/probes/actuation.js';
import { runProbes } from '../../src/probes/runner.js';
import { scanSite } from '../../src/scan.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function probe(html: string, check: PageProbe, media = 'audio-delayed-r2.webm') {
  const server = await startFixtureServer('motion', { '/case.html': { type: 'text/html', body: html }, '/intro.webm': { type: 'video/webm', file: media } });
  try {
    const incomplete = check.id === 'text-contrast' ? [{ id: 'color-contrast', help: 'Text contrast', helpUrl: 'https://example.test', nodes: [{ target: '#n', viewports: ['desktop' as const], html: '<span id="n">7</span>', failureSummary: 'Background image could not be measured' }] }] : undefined;
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/case.html`, index: 0, incomplete }], [check], { userAgent: 'grnted-test', full: true, concurrency: 1 });
    expect(run!.status, JSON.stringify(run)).toBe('ok');
    return run!.findings;
  } finally { await server.close(); }
}

const focusPause = `<style>
@keyframes move { to { transform:translateX(40px) } }
#ticker { width:200px;height:40px;animation:move 8s infinite alternate }
body:has(#panel:focus-within) #ticker { animation-play-state:paused }
</style>
<p>Read this article.</p>
<button onclick="document.getElementById('panel').hidden=false">Settings</button>
<div id="panel" hidden><button>Pause updates</button></div>
<div id="ticker">Latest news</div>`;

it('R1: a disclosure pause must persist after focus leaves; a working pause still passes', async () => {
  expect(await probe(focusPause, motionProbe)).toContainEqual(expect.objectContaining({ status: 'failed', target: '#ticker' }));
  const working = focusPause.replace('<button>Pause updates', `<button onclick="document.getElementById('ticker').style.animationPlayState='paused'">Pause updates`);
  expect(await probe(working, motionProbe)).toContainEqual(expect.objectContaining({ status: 'no_failures_found', target: '#ticker' }));
}, 90_000);

it('R8: try advised keys in either word order, and keep unparsed exits uncertain', async () => {
  const html = `<section aria-label="Picker"><p>To leave the picker, press Alt+Q.</p>
<button id="trap">Show hours</button>
</section><a id="after" href="#next">Continue</a>
<script>
let held=true;
trap.onblur=()=>{
  if(held) setTimeout(()=>{if(held) trap.focus()},20);
};
addEventListener("keydown",e=>{
  if(e.altKey && e.key.toLowerCase()==="q"){
    held=false;
    after.focus();
  }
});
</script>`;
  const traps = async (h: string) => (await probe(h, keyboardProbe)).filter((f) => f.criterion === '2.1.2');
  expect(await traps(html)).toEqual([]);
  expect(await traps(html.replace('To leave the picker, press Alt+Q.', 'Press Alt+Q to exit the picker.'))).toEqual([]);
  expect(await traps(html.replace('Alt+Q', 'Q').replace('e.altKey && ', ''))).toEqual([]);
  expect(await traps(html.replace('Alt+Q', 'Ctrl+F6').replace('e.altKey', 'e.ctrlKey').replace('==="q"', '==="f6"'))).toEqual([]);
  expect(await traps(html.replace('Alt+Q', 'the special key').replace('id="trap"', 'type="button" id="trap"')))
    .toContainEqual(expect.objectContaining({ status: 'not_testable' }));
  const noAdvice = html.replace('<p>To leave the picker, press Alt+Q.</p>', '');
  expect(await traps(noAdvice)).toContainEqual(expect.objectContaining({ status: 'failed' }));
  expect(await traps(noAdvice.replace('id="trap"', 'type="button" id="trap"'))).toContainEqual(expect.objectContaining({ status: 'failed' }));
}, 180_000);

it('R9: an alternative must change the motion target, rather than its own state inside the region', async () => {
  const html = `<section style="width:300px;height:100px">
  <span id="n" style="display:inline-block;width:8px;height:8px">1</span>
  <button onclick="this.dataset.used='1'">Increase</button>
  <button onclick="off=true">Turn motion off</button>
</section>
<script>
let off=false;
addEventListener("deviceorientation",()=>{
  if(!off) n.textContent=Number(n.textContent)+1;
});
</script>`;
  expect(await probe(html, motionActuationProbe)).toContainEqual(expect.objectContaining({ status: 'failed' }));
  const working = html.replace("this.dataset.used='1'", 'n.textContent=Number(n.textContent)+1');
  expect(await probe(working, motionActuationProbe)).toContainEqual(expect.objectContaining({ status: 'no_failures_found' }));
  expect(await probe(html.replace('<button onclick="this.dataset.used=\'1\'">Increase</button>', ''), motionActuationProbe))
    .toContainEqual(expect.objectContaining({ status: 'failed' }));
  const value = working.replace('<span id="n" style="display:inline-block;width:8px;height:8px">1</span>', '<input id="n" value="1" aria-label="Level">').replaceAll('n.textContent', 'n.value');
  expect(await probe(value, motionActuationProbe)).toContainEqual(expect.objectContaining({ status: 'no_failures_found' }));
}, 90_000);

it('R4: a quiet opening never proves absence of audio; confirmed video-only playback passes', async () => {
  // audio-delayed-r2.webm: 30 s, 20 s silent prefix followed by 10 s of synthetic speech.
  const html = `<video id="v" src="/intro.webm"></video>
<script>v.play();</script>`;
  expect(await probe(html, audioProbe)).toContainEqual(expect.objectContaining({ status: 'not_testable', target: '#v' }));
  expect(await probe(html, audioProbe, 'clip.webm')).toContainEqual(expect.objectContaining({ status: 'no_failures_found' }));
}, 60_000);

it('R4: a full scan keeps quiet autoplay uncertain through the media inventory and criterion table', async () => {
  const server = await startFixtureServer('motion', {
    '/case.html': { type: 'text/html', body: '<!doctype html><html lang="en"><title>Quiet opening</title><h1>Welcome</h1><video id="v" autoplay src="/intro.webm"></video></html>' },
    '/intro.webm': { type: 'video/webm', file: 'audio-delayed-r2.webm' },
  });
  try {
    const report = await scanSite(`${server.origin}/case.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, userAgent: 'grnted-test' });
    expect(report.probes!.runs.find((r) => r.probe === 'audio')!.findings).toContainEqual(expect.objectContaining({ status: 'not_testable' }));
    expect(report.criteria!.find((c) => c.criterion === '1.4.2')!.status).toBe('not_testable');
  } finally { await server.close(); }
}, 90_000);

it('R6: a named group leaves its digit as text; a differently named single-character control is graphic', async () => {
  const html = `<div role="group" aria-label="Passenger age"
     style="background:linear-gradient(white,white)">
  <span id="n" style="color:#aaa">7</span>
</div>`;
  expect(await probe(html, textContrastProbe)).toContainEqual(expect.objectContaining({ status: 'failed', target: '#n' }));
  expect(await probe(`<button id="n" aria-label="Seven" style="color:#aaa;background:linear-gradient(white,white)">7</button>`, textContrastProbe))
    .toContainEqual(expect.objectContaining({ status: 'no_failures_found' }));
  expect(await probe(html.replace('id="n"', 'id="n" aria-hidden="true"'), textContrastProbe)).toContainEqual(expect.objectContaining({ status: 'no_failures_found' }));
  expect(await probe(html.replace('color:#aaa', 'color:#111'), textContrastProbe)).toEqual([]);
}, 90_000);

it('R3: a remap label triggers verification; disabled and no-op controls get no credit', async () => {
  const html = `<button disabled>Use the Alt key with "J"</button>
<output id="count">0</output>
<script>
addEventListener("keydown",e=>{
  if(e.key==="j") count.textContent=Number(count.textContent)+1;
});
</script>`;
  expect(await probe(html, keyShortcutsProbe)).toContainEqual(expect.objectContaining({ status: 'failed' }));
  expect(await probe(html.replace(' disabled', ''), keyShortcutsProbe)).toContainEqual(expect.objectContaining({ status: 'failed' }));
  const working = html.replace(' disabled', ' onclick="window.remapped=true"').replace('Use the Alt key with "J"', 'Use Alt with J').replace('if(e.key===', 'if(!window.remapped && e.key===');
  expect(await probe(working, keyShortcutsProbe)).toEqual([]);
}, 90_000);

it('R2: updating regions count as other content for each other; a lone region remains exempt', async () => {
  const html = `<div id="a">Stock A: 0</div>
<div id="b">Stock B: 0</div>
<script>
let i=0, j=0;
setInterval(()=>a.textContent="Stock A: "+(++i),1000);
setInterval(()=>b.textContent="Stock B: "+(++j),1000);
</script>`;
  expect((await probe(html, motionProbe)).some((f) => f.status === 'failed')).toBe(true);
  expect(await probe(html.replace('<div id="b">Stock B: 0</div>', '').replace('setInterval(()=>b.textContent="Stock B: "+(++j),1000);', ''), motionProbe))
    .toContainEqual(expect.objectContaining({ status: 'not_applicable' }));
  const nested = `<section style="width:300px;height:100px">Stationary description <span id="n" style="display:inline-block;width:8px;height:8px">0</span></section>
<script>let i=0;setInterval(()=>n.textContent=++i,1000)</script>`;
  expect((await probe(nested, motionProbe)).some((f) => f.status === 'failed')).toBe(true);
  const replaced = nested.replace('n.textContent=++i', `n.outerHTML='<span id="n" style="display:inline-block;width:8px;height:8px">'+(++i)+'</span>'`);
  expect((await probe(replaced, motionProbe)).some((f) => f.status === 'failed')).toBe(true);
}, 90_000);

it('R2: independent tiny updates sharing an expanded container cannot borrow the only-content exception', async () => {
  const html = `<section id="board" style="width:300px;height:100px">
<span id="a" style="display:inline-block;width:8px;height:8px">0</span>
<span id="b" style="display:inline-block;width:8px;height:8px">0</span>
</section><script>
let i=0,j=0;
setInterval(()=>a.textContent=++i,1000);
setInterval(()=>b.textContent=++j,1000);
</script>`;
  expect((await probe(html, motionProbe)).some((f) => f.status === 'failed' || f.status === 'not_testable')).toBe(true);
}, 60_000);

it('R3: clicking a shortcut settings text field does not verify its mechanism', async () => {
  const html = `<label>Keyboard shortcut key <input id="setting" value="j"></label>
<output id="count">0</output><script>
addEventListener('keydown',e=>{if(e.key===setting.value) count.textContent=Number(count.textContent)+1});
</script>`;
  expect(await probe(html, keyShortcutsProbe)).toContainEqual(expect.objectContaining({ status: 'not_testable' }));
}, 60_000);

it('R6: an icon-font family name alone is unverified; explicit graphic context and readable text remain clean', async () => {
  const html = `<div style="background:linear-gradient(white,white)"><span id="n" style="font-family:FontAwesome-r2-does-not-exist,Arial;color:#aaa">7</span></div>`;
  expect(await probe(html, textContrastProbe)).toContainEqual(expect.objectContaining({ status: 'not_testable' }));
  expect(await probe(html.replace('color:#aaa', 'color:#111'), textContrastProbe)).toEqual([]);
  expect(await probe(html.replace('<div style=', '<div role="img" aria-label="Age symbol" style='), textContrastProbe))
    .toContainEqual(expect.objectContaining({ status: 'no_failures_found' }));
}, 60_000);

it('R8: sibling and announced instructions inside a shadow root are tried', async () => {
  const html = `<x-picker id="picker" aria-label="Picker"></x-picker><a id="after" href="#next">Continue</a>
<script>
const root=picker.attachShadow({mode:'open'});
root.innerHTML='<p id="help">To leave the picker, press Alt+Q.</p><button type="button" id="trap">Show hours</button>';
const trap=root.getElementById('trap');let held=true;
trap.onblur=()=>{if(held)setTimeout(()=>{if(held)trap.focus()},20)};
addEventListener('keydown',e=>{if(e.altKey&&e.key.toLowerCase()==='q'){held=false;after.focus()}});
</script>`;
  const traps = async (h: string) => (await probe(h, keyboardProbe)).filter((f) => f.criterion === '2.1.2');
  expect(await traps(html)).toEqual([]);
  expect(await traps(html.replace('<p id="help">', '<p id="help" hidden>').replace('type="button" id="trap"', 'type="button" aria-describedby="help" id="trap"'))).toEqual([]);
}, 90_000);

const structuralPicker = `<p>To leave the picker, press Alt+Q.</p><section aria-label="Picker"><button type="button" id="trap">Show hours</button></section><a id="after" href="#next">Continue</a>
<script>let held=true;trap.onblur=()=>{if(held)setTimeout(()=>{if(held)trap.focus()},20)};
addEventListener('keydown',e=>{if(e.altKey&&e.key.toLowerCase()==='q'){held=false;after.focus()}});</script>`;

it('R8: a parsed key in nearby instructions is still verified outside a structural widget', async () => {
  expect((await probe(structuralPicker, keyboardProbe)).filter((f) => f.criterion === '2.1.2')).toEqual([]);
}, 60_000);

it('R8: prose modifier wording is tried; an unparsed chord stays uncertain', async () => {
  const inside = structuralPicker.replace('<p>', '<section aria-label="Picker"><p>').replace('</p><section aria-label="Picker">', '</p>');
  const prose = inside.replace('Alt+Q', 'Control and Q').replace('e.altKey', 'e.ctrlKey');
  const traps = async (h: string) => (await probe(h, keyboardProbe)).filter((f) => f.criterion === '2.1.2');
  expect(await traps(prose)).toEqual([]);
  expect(await traps(inside.replace('Alt+Q', 'Hyper+Q'))).toContainEqual(expect.objectContaining({ status: 'not_testable' }));
}, 90_000);
