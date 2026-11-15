// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.13 Content on Hover or Focus, "dismissible", batch 17 (motion-pointer; a training-site false alarm): a
// tooltip whose Escape handler sits on its trigger's wrapper hides on Escape while keyboard focus is in the trigger,
// and not while only the pointer rests on it (focus elsewhere: the key goes to the page, not to the wrapper). The
// test failed it ("pressing Escape does not hide it"). Whether that Escape is a way to dismiss it without moving the
// pointer or focus is a judgement this test does not make: now not testable, saying why. Guards: no Escape at all
// still fails; Escape on the whole page passes.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hoverContentProbe } from '../../src/probes/hoverContent.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (script: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Travel safely</title>
<style>body { font: 16px/1.5 sans-serif; margin: 40px; } .wrap { position: relative; display: inline-block; } .tip { display: none; position: absolute; left: 0; top: 100%; width: 280px; padding: 12px; background: #173e38; color: #fff; z-index: 2; } .wrap:hover .tip, .wrap:focus-within .tip { display: block; } .wrap.dismissed .tip { display: none; }</style></head>
<body><main><h1>Travel safely</h1><h2>Emergency equipment</h2>
<span class="wrap" id="wrap"><button type="button" aria-describedby="tip">Where is the emergency exit?</button><span class="tip" id="tip" role="tooltip">Exit instructions are posted above each emergency window. Ask the operator if you need help.</span></span>
<p>Follow the operator's instructions during an evacuation. Keep the aisle clear and hold a rail while standing.</p><p><a href="/contact">Contact us</a></p></main>${script ? `<script>${script}</script>` : ''}</body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [hoverContentProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const ON_WRAPPER = "(function () { var w = document.getElementById('wrap'); w.addEventListener('keydown', function (e) { if (e.key === 'Escape') { w.classList.add('dismissed'); e.preventDefault(); } }); w.addEventListener('mouseleave', function () { if (!w.contains(document.activeElement)) w.classList.remove('dismissed'); }); w.addEventListener('focusin', function () { w.classList.remove('dismissed'); }); w.addEventListener('focusout', function (e) { if (!w.contains(e.relatedTarget)) w.classList.remove('dismissed'); }); })();";
const ON_PAGE = "(function () { var w = document.getElementById('wrap'); document.addEventListener('keydown', function (e) { if (e.key === 'Escape') w.classList.add('dismissed'); }); w.addEventListener('mouseleave', function () { w.classList.remove('dismissed'); }); w.addEventListener('focusout', function () { w.classList.remove('dismissed'); }); })();";

describe('hover content (1.4.13): Escape that works only with keyboard focus in the trigger', () => {
  it('RED: a tooltip whose Escape handler is on its wrapper is not failed: not testable, saying why', async () => {
    const r = await run(page(ON_WRAPPER));
    expect(r.findings.filter((f) => f.criterion === '1.4.13'), JSON.stringify(r.findings)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('it does hide on Escape once keyboard focus is in its trigger') })]);
  }, 90_000);

  it('(guard) the same tooltip with no Escape at all still fails', async () => {
    const r = await run(page(''));
    const failed = r.findings.filter((f) => f.status === 'failed');
    expect(failed.length, JSON.stringify(r.findings)).toBeGreaterThan(0);
    for (const f of failed) expect(f, JSON.stringify(r.findings)).toEqual(expect.objectContaining({ criterion: '1.4.13', detail: expect.stringContaining('pressing Escape does not hide it') }));
  }, 90_000);

  it('(guard) the same tooltip with Escape on the whole page passes', async () => {
    const r = await run(page(ON_PAGE));
    expect(r.findings.filter((f) => f.status === 'failed' || f.status === 'not_testable'), JSON.stringify(r.findings)).toEqual([]);
  }, 90_000);
});
