// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Review rounds 1-2 (fix/deny-guard): the waits for late content and a moving layout are for the tests that
// misread such a page (headings, orientation, floating content, forced colours). The tests that judge what
// a page does by itself must never wait them out: a short flash right after load and a loading screen that
// traps focus are real failures, and are found.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flashProbe } from '../../src/probes/flash.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

/** The layout shifts 4 times in the first 2 s (a late picture, a font swap, a banner, spacing). */
const SHIFTS = "addEventListener('load',function(){[800,1200,1600,2000].forEach(function(t,i){setTimeout(function(){var d=document.createElement('p');d.textContent='Notice '+(i+1)+'.';document.getElementById('top').appendChild(d);},t);});});";
// An 8 Hz black and white flash over most of the first screen for 2.8 s after load, then still.
const FLASH = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Intro</title><style>body{margin:0;font:18px Georgia,serif}#f{width:100%;height:600px;background:#000}</style></head>
<body><main><div id="top"><h1>Welcome</h1></div><div id="f"></div><p>School news and events.</p></main>
<script>${SHIFTS}addEventListener('load',function(){var f=document.getElementById('f'),on=false,t0=Date.now(),id=setInterval(function(){if(Date.now()-t0>2800){clearInterval(id);f.style.background='#000';return;}on=!on;f.style.background=on?'#fff':'#000';},62);});</script></body></html>`;
// A loading screen (the body is aria-busy) whose field keeps Tab until it is removed 2.5 s after load.
const LOADING_TRAP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Account</title></head>
<body aria-busy="true"><main><div id="top"><h1>Your account</h1></div>
<div id="loading"><p>Loading your account</p><label for="spin">Account number</label> <input id="spin" type="text"></div>
<p><a href="/a">Settings</a> <a href="/b">Orders</a> <a href="/c">Help</a></p></main>
<script>${SHIFTS}var b=document.getElementById('spin');b.addEventListener('keydown',function(e){if(e.key==='Tab'){e.preventDefault();b.focus();}});
addEventListener('load',function(){setTimeout(function(){document.getElementById('loading').remove();document.body.removeAttribute('aria-busy');},2500);});</script></body></html>`;

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;

beforeAll(async () => {
  server = await startFixtureServer('site', {
    '/intro-flash.html': { type: 'text/html', body: FLASH },
    '/loading-trap.html': { type: 'text/html', body: LOADING_TRAP },
  });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const failed = async (path: string, probe: typeof flashProbe, criterion: string) => (await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true }))
  .flatMap((r) => r.findings).filter((f) => f.criterion === criterion && f.status === 'failed');

describe('the tests that judge what a page does by itself never wait for it to settle', () => {
  it('an 8 Hz flash during the first 2.8 s after load, on a page whose layout keeps shifting, fails 2.3.1', async () => {
    expect((await failed('/intro-flash.html', flashProbe, '2.3.1')).length).toBeGreaterThan(0);
  }, 120_000);

  it('a loading screen (aria-busy) that keeps Tab for 2.5 s after load fails 2.1.2', async () => {
    const runs = await runProbes(B(), [{ url: `${server.origin}/loading-trap.html`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test' });
    expect(runs.flatMap((r) => r.findings).filter((f) => f.criterion === '2.1.2').map((f) => f.status)).toEqual(['failed']);
  }, 120_000);
});
