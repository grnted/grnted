// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The title after a client-side page change (2.4.2) in real Chromium, over one small app
// (test/fixtures/routes/app.html) served at /good/, /stale/, /mixed/ and /loads/.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeTitlesProbe } from '../../src/probes/routeTitles.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer, type FixtureRoutes } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];

beforeAll(async () => {
  const routes: FixtureRoutes = {};
  for (const app of ['good', 'stale', 'mixed', 'loads', 'saves', 'slow', 'portal', 'pictures']) for (const page of ['', 'rates', 'board']) routes[`/${app}/${page}`] = { type: 'text/html; charset=utf-8', file: 'app.html' };
  routes['/api/drafts/store'] = { type: 'application/json', body: '{"saved":true}' };
  for (const pic of ['home', 'rates', 'board']) routes[`/pics/${pic}.svg`] = { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#1d4d3f"/></svg>' };
  server = await startFixtureServer('routes', routes, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = async (path: string): Promise<ProbeRun> => {
  const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}${path}`, index: 0 }], [routeTitlesProbe], { userAgent: 'grnted-test', full: true });
  return r!;
};
const result = (r: ProbeRun) => r.findings.map((f) => [f.status, f.detail]);
const T = 60_000;

describe('2.4.2: the title after a client-side page change', () => {
  it('fails a page that keeps the last page\'s title when a visitor comes back to it, in an app that gives its views titles of their own', async () => {
    const r = await run('/mixed/rates');
    expect(r.status).toBe('ok');
    expect(result(r)).toEqual([['failed', 'The site changes pages without loading them and gives them titles of their own, but this page\'s title does not come back with it: after following “Home” (/mixed) and going back, the title is still “Home | Town”; loaded by its address, this page\'s title is “Rates | Town”.']]);
  }, T);

  it('a view that shows a picture: the picture is refused like every request, and the stale title is still read and failed', async () => {
    const start = requests.length;
    const r = await run('/pictures/rates');
    expect(r.findings.map((f) => f.status)).toEqual(['failed']);
    expect(r.findings[0]!.detail).toContain('the title is still “Home | Town”');
    // Only the page's own load and its first picture were asked for: the picture of the view the link showed never left the browser.
    expect(requests.slice(start).filter((x) => x.includes('/pics/'))).toEqual(['GET /pics/rates.svg']);
  }, T);

  // Review r1, finding 11: an application's name may describe every one of its views (Understanding 2.4.2).
  it('an app that keeps one title across its views is not failed: whether that title describes them is not judged', async () => {
    const portal = await run('/portal/rates');
    expect(result(portal)).toEqual([['not_testable', 'the site shows other pages without loading them and keeps one title (“Town service request portal”) across the 2 views followed; whether that one title describes each of them is a judgement this test does not make']]);
    // The same for a site whose one title is the first page's own.
    expect((await run('/stale/board')).findings.map((f) => f.status)).toEqual(['not_testable']);
  }, T);

  // Review r1, finding 12: one quiet look is no proof that the view has finished.
  it('a router that puts the heading back at once and the title 600 ms later is not stale: the view is read after a full quiet second', async () => {
    expect(result(await run('/slow/rates'))).toEqual([['no_failures_found', 'the title changes with the page on the client-side page change followed, and is this page\'s own again after going back']]);
  }, T);

  it('look-alikes: an app that changes the title with every page; a page of the mixed app whose own title does come back', async () => {
    expect(result(await run('/good/'))).toEqual([['no_failures_found', 'the title changes with the page on the client-side page change followed, and is this page\'s own again after going back']]);
    expect((await run('/mixed/board')).findings.map((f) => f.status)).toEqual(['no_failures_found']);
  }, T);

  it('not applicable where links load a new page (the load is held, never made) and where no script handles clicks', async () => {
    const start = requests.length;
    const r = await run('/loads/');
    expect(result(r)).toEqual([['not_applicable', 'the links followed on this page load a new page, which has the title it loads with']]);
    // Only the scan's own load of the page reached the server.
    expect(requests.slice(start).filter((x) => /\/loads\/(rates|board)/.test(x))).toEqual([]);
    expect((await run('/plain.html')).findings.map((f) => f.status)).toEqual(['not_applicable']);
  }, T);

  // Review r1, finding 1: a link's address says nothing about what its click handler does. Nothing the page asks
  // for while the test follows links may reach the server (the strict guard, as for every test that presses things).
  it('a link whose handler saves a draft before it changes the page: the request never leaves, and nothing is judged from what it could not load', async () => {
    const start = requests.length;
    const r = await run('/saves/rates');
    expect(r.status).toBe('ok');
    expect(requests.slice(start).filter((x) => x.includes('/api/drafts/'))).toEqual([]);
    expect(r.findings.map((f) => f.status)).toEqual(['not_testable']);
    expect(r.findings[0]!.detail).toContain('the test sends nothing');
  }, T);
});
