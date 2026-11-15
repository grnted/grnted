// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Literal counterexamples from Sol popup-r5. No third-party content in these fixtures.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dismissCandidates, DISMISS_NAME } from '../../src/probes/dismiss.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { findOverlays, findPopups, POPUP_LIMITS } from '../../src/probes/popupAside.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { ProbeContext } from '../../src/probes/types.js';
import type { BrowserLike, Finding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let axeSource: string;
const pageHtml = (body: string, script = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Town news</title>
<style>body{margin:0;font:16px/1.5 Arial;color:#222;background:white}main{padding:24px}
.bg{position:fixed;inset:0;background:white;opacity:.8;z-index:20}
.pop{position:fixed;top:40px;left:40px;width:520px;padding:20px;background:black;color:white;z-index:10}
.pop p{margin:0;color:white;background:black}button{font:inherit}</style>
<main><h1>Town news</h1><p>The town hall is open on weekdays from eight to five. Permits and licences are handled at the front desk.</p></main>
${body}<script>${script}</script></html>`;
const close = '<button type="button" onclick="this.parentElement.remove()">Close</button>';
const lower = `<p id="low-text">Get the town newsletter every month.</p>${close}`;
const upper = `<div role="dialog" aria-modal="true" aria-label="Cookies" style="position:fixed;top:250px;left:600px;width:360px;padding:20px;background:white;color:black;z-index:21"><p>Cookies</p>${close}</div>`;
const undecided = (target: string): Finding[] => [{ id: 'color-contrast', help: 'contrast', helpUrl: '', nodes: [{ target, html: '<p>', viewports: ['desktop'] }] }];
const run = async (path: string, probes = [textContrastProbe], incomplete: Finding[] = []) => runProbes(
  browser as unknown as BrowserLike, [{ url: `${server.origin}/${path}`, index: 0, incomplete }], probes, { userAgent: 'grnted-test', axeSource },
);

beforeAll(async () => {
  const html = (body: string) => ({ type: 'text/html; charset=utf-8', body });
  server = await startFixtureServer('popup-aside', {
    '/child-backdrop': html(pageHtml(`<div id="lower" class="pop" role="dialog">${lower}<div class="bg"></div>${upper}</div>`)),
    '/sibling-backdrop': html(pageHtml(`<div id="lower" class="pop" role="dialog">${lower}</div><div class="bg"></div>`)),
    '/separate-backdrop': html(pageHtml(`<div class="bg" style="z-index:5"></div><div id="lower" class="pop" role="dialog">${lower}<input aria-label="Email" style="background:white;border:1px solid #ddd"><p style="white-space:nowrap">${'W'.repeat(80)}</p></div>`, "document.querySelector('main p').textContent='The town hall is open. '.repeat(200)")),
    ...Object.fromEntries(['plain', 'transparent'].map((mode) => [`/${mode}-popup`, html(pageHtml(`${mode === 'transparent' ? '<div class="bg" style="z-index:5;pointer-events:none"></div>' : ''}<div id="lower" class="pop" role="dialog">${lower.replace('id="low-text"', 'id="low-text" style="color:#333"')}<input aria-label="Email" style="background:white;border:1px solid #ddd"><p style="white-space:nowrap">${'W'.repeat(80)}</p></div>`, "document.querySelector('main p').textContent='The town hall is open. '.repeat(200)"))])),
    '/wrapper': html(pageHtml(`<div class="bg"></div><div id="wrapper" style="position:fixed;inset:0;z-index:21">${'<button type="button">Unrelated</button>'.repeat(80)}<div id="child" style="position:absolute;top:200px;left:200px;width:800px;height:600px;background:white;color:black"><p>Our hours change on Monday.</p>${close}</div></div>`, "document.querySelector('main p').textContent='The town hall is open. '.repeat(200)")),
    '/moved': html(pageHtml(`<p id="moved" style="white-space:nowrap">${'W'.repeat(40)}</p><div id="pop" role="dialog" aria-modal="true" style="position:fixed;inset:30px;background:white"><p>Notice</p>${close}</div>`, `addEventListener('resize',()=>{const p=document.getElementById('moved');if(p&&innerWidth===320)document.getElementById('pop')?.append(p)})`)),
    '/account': html(pageHtml('<div id="pop" role="dialog" aria-modal="true" style="position:fixed;top:100px;left:200px;width:400px;background:white;padding:20px"><p>Cookie settings.</p><button type="button" onclick="fetch(\'/account\',{method:\'POST\'})">Close account</button><button type="button" onclick="this.parentElement.remove()">Reject</button></div>', "document.querySelector('#pop button').focus()")),
    '/selector': html(pageHtml('<p id="generated-new" style="color:#aaa;background:white">An already reported paragraph.</p><div id="pop" role="dialog" aria-modal="true" style="position:fixed;top:100px;left:500px;width:400px;background:white;padding:20px"><p>Notice</p>'+close+'</div>')),
    '/selector-phone': html(pageHtml('<style>@media(max-width:600px){#generated-new{color:#aaa!important}}</style><p id="generated-new" style="color:#111;background:white">An already reported paragraph.</p><div id="pop" role="dialog" aria-modal="true" style="position:fixed;top:100px;left:500px;width:400px;background:white;padding:20px"><p>Notice</p>'+close+'</div>')),
    '/third-party': html(pageHtml('<iframe id="form" title="Form" style="display:none;width:500px;height:200px"></iframe><div id="pop" role="dialog" aria-modal="true" style="position:fixed;top:100px;left:500px;width:400px;background:white;padding:20px"><p>Notice</p><button type="button" onclick="document.getElementById(\'form\').style.display=\'block\';this.parentElement.remove()">Close</button></div>', `document.getElementById('form').src=location.origin.replace('127.0.0.1','localhost')+'/low-frame'`)),
    '/low-frame': html('<!doctype html><html lang="en"><title>Form</title><p style="color:#aaa;background:white">Low contrast text in an embedded form.</p></html>'),
    '/cap': html(pageHtml('', `for(let i=0;i<60;i++)document.body.appendChild(document.createElement('x-host')).attachShadow({mode:'open'})`)),
  });
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
}, 30_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe('round 6 literal inputs', () => {
  it('Sol 1: child backdrop and two dialogs keep no look-1 finding and press no dismissal key', async () => {
    const keys: string[] = [];
    const probes = [textContrastProbe, nonTextContrastProbe, reflowProbe].map((probe) => ({ ...probe, async run(ctx: ProbeContext) {
      const keyboard = ctx.page.keyboard!;
      const press = keyboard.press;
      keyboard.press = async (key) => { keys.push(key); return press.call(keyboard, key); };
      try { return await probe.run(ctx); } finally { keyboard.press = press; }
    } }));
    const runs = await run('child-backdrop', probes, undecided('#low-text'));
    expect(keys).toEqual([]);
    for (const r of runs) {
      expect(r.status).toBe('ok');
      expect(r.findings).toEqual([{ criterion: r.probe === 'text-contrast' ? '1.4.3' : r.probe === 'reflow' ? '1.4.10' : '1.4.11', status: 'not_testable', detail: expect.stringContaining('more than one pop-up covered the page') }]);
      expect((r.data as { popup?: unknown } | undefined)?.popup).toMatchObject({ boxes: 2, setAside: false, why: 'more than one pop-up covered the page' });
    }
  }, 60_000);

  it('Sol 2: a generated selector change adds no scored contrast failure', async () => {
    // The original audit already reported #generated-old; the fresh load gives it this new id.
    const [r] = await run('selector');
    expect(r!.findings.filter((f) => f.status === 'failed')).toEqual([]);
    expect(r!.findings.some((f) => /axe decided the contrast of all text/.test(f.detail ?? ''))).toBe(false);
  }, 60_000);

  it.each([false, true])('round 8: changed selectors lose no previously undecided failure (markup available: %s)', async (markup) => {
    const audit = undecided('#generated-old');
    if (markup) audit[0]!.nodes[0]!.html = '<p id="generated-old" style="color:#aaa;background:white">An already reported paragraph.</p>';
    const [r] = await run('selector', [textContrastProbe], audit);
    expect(r!.status).toBe('ok');
    expect((r!.data as { popup?: unknown } | undefined)?.popup).toMatchObject({ setAside: true });
    if (markup) expect(r!.findings.filter((f) => f.status === 'failed').map((f) => f.target)).toEqual(['#generated-new']);
    else {
      expect(r!.findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', target: '#generated-old', detail: expect.stringMatching(/could not be found.*second look/) }]);
    }
    expect(r!.findings.some((f) => f.status === 'no_failures_found')).toBe(false);
  }, 60_000);

  it('round 9: undecided text inside the dismissed box is excluded without changing the page status', async () => {
    const [ordinary] = await run('plain-popup');
    const [r] = await run('plain-popup', [textContrastProbe], undecided('#low-text'));
    expect(r!.status).toBe('ok');
    expect((r!.data as { popup?: unknown } | undefined)?.popup).toMatchObject({ setAside: true });
    expect(r!.findings).toEqual(ordinary!.findings);
    expect(r!.findings.map((f) => f.status)).toEqual(['no_failures_found']);
  }, 60_000);

  it('round 9: outside-box undecided text with an unlocatable changed selector stays not testable', async () => {
    const [r] = await run('selector', [textContrastProbe], undecided('#generated-old'));
    expect(r!.findings).toEqual([
      { criterion: '1.4.3', status: 'not_testable', target: '#generated-old', detail: expect.stringMatching(/could not be found.*second look/) },
    ]);
  }, 60_000);

  it('round 9: both inside-box and missing outside-box text give uncertainty for the outside target only', async () => {
    const audit = undecided('#pop > p');
    audit[0]!.nodes.push(...undecided('#generated-old')[0]!.nodes);
    const [r] = await run('selector', [textContrastProbe], audit);
    expect(r!.findings).toEqual([
      { criterion: '1.4.3', status: 'not_testable', target: '#generated-old', detail: expect.stringMatching(/could not be found.*second look/) },
    ]);
  }, 60_000);

  it('round 8: an unlocatable original target remains uncertain alongside a measured true failure', async () => {
    const audit = undecided('#generated-new');
    audit[0]!.nodes.push(...undecided('#missing-original')[0]!.nodes);
    const [r] = await run('selector', [textContrastProbe], audit);
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.status === 'failed').map((f) => f.target)).toEqual(['#generated-new']);
    expect(r!.findings.filter((f) => f.status === 'not_testable')).toEqual([
      { criterion: '1.4.3', status: 'not_testable', target: '#missing-original', detail: expect.stringMatching(/could not be found.*second look/) },
    ]);
  }, 60_000);

  it('round 8: recovering a generated selector preserves its failing phone viewport', async () => {
    const audit = undecided('#generated-old');
    audit[0]!.nodes[0]!.html = '<p id="generated-old" style="color:#111;background:white">An already reported paragraph.</p>';
    const [r] = await run('selector-phone', [textContrastProbe], audit);
    expect(r!.status).toBe('ok');
    expect(r!.findings).toEqual([
      // Batch 19: each 1.4.3 failure names its kind of evidence (text measured over what is behind it: 'backdrop').
      { criterion: '1.4.3', status: 'failed', target: '#generated-new', data: { kind: 'backdrop' }, detail: expect.stringMatching(/^Text contrast is [\d.]+:1 at the phone width /) },
    ]);
  }, 60_000);

  it('Sol 1: a single qualifying dialog beneath a sibling backdrop retains no contrast failure', async () => {
    const [r] = await run('sibling-backdrop', [textContrastProbe], undecided('#low-text'));
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.status === 'failed')).toEqual([]);
    expect((r!.data as { popup?: unknown } | undefined)?.popup).toMatchObject({ boxes: 1, setAside: true });
  }, 60_000);

  it.each(['plain-popup', 'transparent-popup', 'separate-backdrop'])('round 8: no look-1 finding is ever retained (%s), and dismissal and look 2 still run', async (path) => {
    const kept: unknown[] = [];
    const probes = [textContrastProbe, nonTextContrastProbe, reflowProbe].map((probe) => ({ ...probe, async run(ctx: ProbeContext) {
      return probe.run({ ...ctx, keep: (findings) => { kept.push(...findings); ctx.keep?.(findings); } });
    } }));
    const runs = await run(path, probes, undecided('#low-text'));
    expect(kept).toEqual([]);
    for (const r of runs) {
      expect(r.status).toBe('ok');
      expect(r.findings.some((f) => f.status === 'failed')).toBe(false);
      expect(r.findings.some((f) => f.status === 'not_testable')).toBe(false);
      expect((r.data as { popup?: unknown } | undefined)?.popup).toMatchObject({ boxes: 1, setAside: true });
    }
  }, 60_000);

  it('Sol 3: sixty sibling shadow hosts plus a nested root exhaust an enforced 60-root budget', async () => {
    const p = await browser.newPage();
    try {
      await p.setContent(pageHtml(''));
      await p.evaluate(() => {
        for (let i = 0; i < 60; i++) {
          const host = document.body.appendChild(document.createElement('x-host'));
          const root = host.attachShadow({ mode: 'open' });
          if (i === 0) root.appendChild(document.createElement('x-inner')).attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;top:100px;left:100px;width:200px;height:100px">Notice</div>';
        }
      });
      const t0 = Date.now();
      const found = await p.evaluate(findOverlays, { limits: POPUP_LIMITS });
      expect(found).toMatchObject({ boxes: [], discovery: { roots: 60, exhausted: 'root limit' } });
      expect(Date.now() - t0).toBeLessThan(2000);
      console.log('Sol 3 discovery wall ms', Date.now() - t0, found);
      const timed = await p.evaluate(findOverlays, { limits: POPUP_LIMITS, deadline: 0 });
      expect(timed).toMatchObject({ boxes: [], discovery: { roots: 1, exhausted: 'time limit' } });
      // Fifty-eight siblings plus the nested root fit exactly; queued nested roots must actually be visited.
      await p.evaluate(() => { document.querySelectorAll('x-host')[59]!.remove(); document.querySelectorAll('x-host')[58]!.remove(); });
      const complete = await p.evaluate(findOverlays, { limits: POPUP_LIMITS });
      expect(complete.discovery).toMatchObject({ roots: 60 });
      expect(complete.discovery.exhausted).toBeUndefined();
      expect(complete.boxes.map((b) => b.path)).toEqual([expect.stringContaining(' >>> ')]);
    } finally { await p.close(); }
  });

  it('Sol 4: a fixed wrapper with 80 unrelated buttons does not suppress its qualifying absolute child', async () => {
    const p = await browser.newPage();
    try {
      await p.goto(`${server.origin}/wrapper`);
      const found = await findPopups({ page: p, deadline: Date.now() + 5000 } as unknown as ProbeContext);
      expect(found.boxes.map((b) => b.path)).toEqual(['#child']);
    } finally { await p.close(); }
  });

  it('Sol 3: exhaustion uses ordinary probe behaviour and explains the discovery limit', async () => {
    const runs = await run('cap', [textContrastProbe, nonTextContrastProbe, reflowProbe]);
    for (const r of runs) {
      expect(r.status).toBe('ok');
      const details = r.findings.length ? r.findings.map((f) => f.detail) : [(r.data as { discovery?: { detail?: string } } | undefined)?.discovery?.detail];
      expect(details.every((d) => /pop-up discovery reached its root limit at 60 queued roots/.test(d ?? ''))).toBe(true);
      expect((r.data as { popup?: unknown } | undefined)?.popup).toBeUndefined();
    }
  }, 60_000);

  it('Sol 5: the paragraph moved at 320 px still fails when measured on the cleared page', async () => {
    const [r] = await run('moved', [reflowProbe]);
    expect(r!.status).toBe('ok');
    expect(r!.findings.filter((f) => f.status === 'failed').map((f) => f.target)).toContain('#moved');
  }, 60_000);

  it('Sol 6: an unmeasured fresh third-party contrast failure never becomes an all-text clean claim', async () => {
    const [r] = await run('third-party');
    expect(r!.status).toBe('ok');
    expect(r!.findings).toEqual([{ criterion: '1.4.3', status: 'not_testable', detail: expect.stringContaining('the second look did not finish') }]);
  }, 60_000);

  it('Sol 7: Reject closes before the request-sending Close account action is pressed', async () => {
    const [r] = await run('account', [nonTextContrastProbe]);
    expect((r!.data as { popup?: unknown } | undefined)?.popup).toMatchObject({ setAside: true, by: 'Enter on “Reject”' });
  }, 60_000);

  it('Sol 7: destructive names never receive dismissal priority in candidate discovery', async () => {
    const p = await browser.newPage();
    try {
      const names = ['Close account', 'Close and delete', 'Close and remove', 'Close and sign out', 'Close and log out', 'Close and unsubscribe', 'Close and cancel subscription'];
      await p.setContent(pageHtml(`<div id="pop">${names.map((n) => `<button>${n}</button>`).join('')}<button>Reject</button></div>`));
      const found = await p.evaluate(dismissCandidates, { box: '#pop', pattern: DISMISS_NAME.source, max: 20, peek: true });
      expect(found.candidates[0]!.name).toBe('Reject');
    } finally { await p.close(); }
  });
});
