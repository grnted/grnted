// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Content that a script mounts after the page loaded (an app that hydrates 1 to 2 s late; gold harness
// hazard `hazard-late-mount`): the tests must judge the page once its content is there, never the empty
// shell. Before the fix the headings test read "no headings at all" (2.4.6) and the orientation test
// compared an empty portrait screen with a full landscape one (1.3.4 failed) on such a page.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forcedColorsProbe } from '../../src/probes/forcedColors.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { orientationProbe } from '../../src/probes/orientation.js';
import { LATE_CONTENT_MS, PROBE_DEFAULTS, runProbes } from '../../src/probes/runner.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

const CONTENT = '<h1>Events</h1><p>Upcoming events for families. All events are at the school; ask the school office about parking.</p><h2>Spring</h2><p>The spring open house is on April 9 at 5 pm.</p>';
const shell = (ms: number, busy: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Events</title></head>
<body><header><p>Fernwood Valley School</p><nav aria-label="Main"><a href="/">Home</a></nav></header>
<main id="main"${busy ? ' aria-busy="true"' : ''}><div id="app"></div></main><footer><p>100 Orchard Lane</p></footer>
<script>setTimeout(function(){document.getElementById('app').outerHTML=${JSON.stringify(CONTENT)};document.getElementById('main').removeAttribute('aria-busy');},${ms});</script></body></html>`;
// The page moves as it finishes loading, in stages: a picture without dimensions at 0.9 s, a web font swapped in
// at 1.1 s, the heading's spacing settling at 1.3 and 1.5 s.
const SHIFTS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Documents</title>
<style>body{font-family:Georgia,serif;font-size:18px}.fonts-loaded body{font-family:Verdana,sans-serif}button{color:#fff;background:#0b4fb3;border:2px solid #0b4fb3;padding:8px 16px}a{color:#0b4fb3}</style></head>
<body><main><h1>Documents</h1><img id="late" alt="The school garden"><p>Board documents and school handbooks. <a href="/a">School budget 2026</a> and <a href="/b">the family handbook</a>.</p>
<form role="search"><label for="q">Search the site</label> <input id="q" type="search" style="border:2px solid #595959;padding:8px"> <button type="submit">Search</button></form></main>
<script>addEventListener('load',function(){var at=Number(new URLSearchParams(location.search).get('at')||900);setTimeout(function(){document.getElementById('late').src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#2a6"/></svg>');},at);setTimeout(function(){document.documentElement.classList.add('fonts-loaded');},at+200);[at+400,at+600].forEach(function(t,i){setTimeout(function(){document.querySelector('h1').style.marginTop=(i+1)*12+'px';},t);});});</script></body></html>`;
const EMPTY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gallery</title></head><body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="A drawing of the school" width="200" height="100"></main></body></html>`;

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test' };

beforeAll(async () => {
  server = await startFixtureServer('site', {
    '/late-1900.html': { type: 'text/html', body: shell(1900, false) },
    '/late-1200-busy.html': { type: 'text/html', body: shell(1200, true) },
    '/picture-only.html': { type: 'text/html', body: EMPTY },
    '/shifts.html': { type: 'text/html', body: SHIFTS },
    // The same page as it ends up, standing still from the start.
    '/still.html': { type: 'text/html', body: SHIFTS.replace('<html lang="en">', '<html lang="en" class="fonts-loaded">').replace(/<script>[\s\S]*<\/script>/, '').replace('<h1>', '<h1 style="margin-top:24px">') },
  });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const failures = async (path: string) => (await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [headingsProbe, orientationProbe], OPTS))
  .flatMap((r) => r.findings.filter((f) => f.status === 'failed').map((f) => `${r.probe} ${f.criterion}: ${f.detail}`));

describe('content mounted late', () => {
  it('a main region that a script fills 1.9 s after load is judged with its content (no false 2.4.6 or 1.3.4)', async () => {
    expect(await failures('/late-1900.html')).toEqual([]);
  }, 60_000);

  it('a main region marked aria-busy until its content mounts is waited for too', async () => {
    expect(await failures('/late-1200-busy.html')).toEqual([]);
  }, 60_000);

  it('a page that still moves as it finishes loading (a late picture, a web font swap) is tested once it stands still (the forced-colours comparison)', async () => {
    const result = async (path: string) => (await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [forcedColorsProbe], { ...OPTS, full: true }))[0]!
      .findings.filter((f) => f.criterion === '1.4.11').map((f) => [f.status, f.detail]);
    const still = await result('/still.html');
    expect(still.some(([status]) => status === 'not_testable')).toBe(false);
    // The shifts run from 0.7 to 1.3 s after load, across the moment the tests would start (after the 1 s settle).
    expect(await result('/shifts.html?at=700')).toEqual(still);
  }, 60_000);

  it('the wait is bounded: a page whose main region holds only a picture is tested at once', async () => {
    let settle = Infinity;
    await runProbes(B(), [{ url: `${server.origin}/picture-only.html`, index: 0 }], [headingsProbe], { ...OPTS, onGroup: (g) => { settle = g.settleMs; } });
    expect(settle).toBeLessThan(PROBE_DEFAULTS.settleMs + LATE_CONTENT_MS / 2);
  }, 60_000);
});
