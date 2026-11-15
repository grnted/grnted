// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Fresh round-four fixtures, independently authored without ACT markup.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function trapFindings(html: string) {
  const server = await startFixtureServer('keyboard', { '/case.html': { type: 'text/html', body: html } });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/case.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test', full: true, concurrency: 1 });
    for (const run of runs) expect(run.status, JSON.stringify(run)).toBe('ok');
    return runs.flatMap((run) => run.findings).filter((f) => f.criterion === '2.1.2');
  } finally { await server.close(); }
}

const preview = (release: boolean, type = '') => `<!doctype html><html lang="en">
<title>Book preview</title><h1>Read a sample</h1>
<section aria-label="Book preview"><button id="held" ${type}>Close</button></section>
<a id="more" href="#details">Book details</a><p id="details">More about this book.</p>
<script>
let locked=true;
held.onblur=()=>{if(locked)setTimeout(()=>{if(locked)held.focus()},20)};
held.onclick=()=>{${release ? 'locked=false;more.focus();' : ''}};
</script></html>`;

it('R8: a trap containing only a formless default button fails after its exit is tried', async () => {
  expect(await trapFindings(preview(false))).toEqual([expect.objectContaining({
    status: 'failed', detail: expect.stringContaining('nor pressing "Close"'),
  })]);
}, 60_000);

it('R8: the look-alike passes when its formless default button really frees focus', async () => {
  expect(await trapFindings(preview(true))).toEqual([]);
}, 60_000);

for (const owner of ['ancestor', 'form attribute']) {
  it(`R8: a default button with a form owner through its ${owner} is never activated`, async () => {
    const html = owner === 'ancestor'
      ? preview(true).replace('<section', '<form action="/submitted"><section').replace('</section>', '</section></form>')
      : preview(true, 'form="order"').replace('<section', '<form id="order" action="/submitted"></form><section');
    expect(await trapFindings(html)).toEqual([expect.objectContaining({
      status: 'not_testable', detail: expect.stringContaining('submit a form ("Close")'),
    })]);
  }, 60_000);
}
