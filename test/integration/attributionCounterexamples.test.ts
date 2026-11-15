// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The attribution defect of round 1, proved on the real thing (round-2 review, finding 6; the lead's decision:
// "reconstruct the round-1 attribution and use two failing sources").
//
// Round 1 reported a failure a slow test had measured on an element on every untested page that carried the
// same kind of element and loaded the same stylesheets and scripts. Review r1 said a kind does not make two
// elements equal, and named the ways they differ. This file shows it, in real Chromium, on our own generic site:
//
// 1. Two source pages carry five failing controls; the real tests, run whole on both, measure the five failures
//    on each (two failing sources: round 1's own threshold).
// 2. Seven other pages carry the very same kinds of element and differ in one thing a kind does not see. The
//    real tests, run whole on each of them, measure NO such failure there: that is the ground truth.
// 3. Round 1's attribution (test/helpers/round1Attribution.ts: the round-1 code, with round 1's reading of the
//    environment) reports the failure on every one of the seven: the defect, reproduced.
// 4. The engine as it is now, scanning the same site, reports none of them, and still reports the failures on
//    the page that really is the same, measured there on its own elements.
//
// Parts 1 to 3 never touch the engine's scheduling; part 4 is the engine's own scan. Run against round 1's
// engine (6cb9d07d), part 4 fails on all seven pages.
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readKinds, KINDS_LIMITS } from '../../src/collect/kinds.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import { componentKinds } from '../../src/probes/sample.js';
import { screenReaderProbe } from '../../src/probes/screenReader/index.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, ProbeRun, SiteReport } from '../../src/types.js';
import { round1Env, round1SharedRuns, ROUND1_SHARED, ROUND1_SHARED_NOTE, type KindPage, type Round1SharedRun } from '../helpers/round1Attribution.js';

// One header on every page, with five controls that each fail one criterion on the two source pages. Each
// counterexample page carries the very same kinds of element and differs in one thing a kind does not see.
const CSS = `body{font:16px/1.5 sans-serif;margin:0;color:#111;background:#fff} a{color:#0b4fb3} main,header,footer{padding:16px} header div{padding:8px}
a:focus,button:focus,[tabindex]:focus{outline:3px solid #0b4fb3;outline-offset:2px}
.launch:focus{outline:var(--ring, none)}
[data-tone="dark"]{background:#111}
[data-compact] .launch{display:none}
.card{cursor:pointer}`;
const THEME: Record<string, string> = {
  broken: '.chat:focus{outline:3px solid #c9c9c9;outline-offset:2px}',
  accessible: '.chat:focus{outline:3px solid #0b4fb3;outline-offset:2px}',
};
const JS = `document.querySelectorAll('.zone').forEach(function (zone) {
  var safe = zone.getAttribute('data-mode') === 'safe';
  zone.querySelector('.jump').addEventListener('focus', function () { if (!safe) location.href = '/elsewhere'; });
});
document.querySelectorAll('.pay').forEach(function (pay) {
  var card = pay.querySelector('.card');
  var key = pay.querySelector('.pay-key');
  var paid = function () { card.textContent = 'Paid'; };
  card.addEventListener('click', paid);
  key.addEventListener('click', paid);
  if (pay.getAttribute('data-mode') === 'safe') key.hidden = false;
});`;
const SOURCES = ['/', '/src2'];
/** Each counterexample page, the one thing it differs in, and the failure that is therefore NOT on it. */
const COUNTER: { path: string; differs: string; probe: 'keyboard' | 'screen-reader'; criteria: string[] }[] = [
  { path: '/c-name', differs: 'the button has a name here (an aria-label value)', probe: 'screen-reader', criteria: ['4.1.2'] },
  { path: '/c-var', differs: 'a CSS variable on body restores the focus ring', probe: 'keyboard', criteria: ['2.4.7'] },
  { path: '/c-bg', differs: 'an ancestor\'s attribute darkens what is behind the pale ring', probe: 'keyboard', criteria: ['1.4.11'] },
  { path: '/c-mode', differs: 'an ancestor\'s attribute, read by the shared script: focus changes nothing, and a keyboard control is shown', probe: 'keyboard', criteria: ['3.2.1', '2.1.1'] },
  { path: '/c-hidden', differs: 'an ancestor\'s attribute hides the control', probe: 'keyboard', criteria: ['2.4.7'] },
  { path: '/c-css', differs: 'a stylesheet of its own restores the ring (each source has an unrelated one of its own)', probe: 'keyboard', criteria: ['2.4.7'] },
  { path: '/c-theme', differs: 'the shared stylesheet with another query', probe: 'keyboard', criteria: ['1.4.11'] },
];
const PATHS = [...SOURCES, '/same', ...COUNTER.map((c) => c.path)];
const html = (path: string): string => {
  const is = (p: string) => path === p;
  const links = PATHS.map((p) => `<a href="${p}">Page ${p === '/' ? 'home' : p.slice(1)}</a>`).join(' ');
  const own = is('/') ? '<link rel="stylesheet" href="/a.css">' : is('/src2') ? '<link rel="stylesheet" href="/b.css">' : is('/c-css') ? '<link rel="stylesheet" href="/c.css">' : '';
  // The second source holds a control and a table no other page has: the slow tests go there for them.
  const more = is('/src2') ? '<div id="picker" class="date-picker" role="button" tabindex="0">Choose a date</div><table><caption>Fees</caption><tr><th>Permit</th><th>Fee</th></tr><tr><td>Fence</td><td>20</td></tr></table>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>City services ${path}</title>
<link rel="stylesheet" href="/shared.css"><link rel="stylesheet" href="/theme.css?variant=${is('/c-theme') ? 'accessible' : 'broken'}">${own}</head>
<body${is('/c-var') ? ' style="--ring: 3px solid #0b4fb3"' : ''}>
<header>
<div class="home"><a href="/">City services</a></div>
<div class="tools"${is('/c-hidden') ? ' data-compact' : ''}><button class="launch" type="button">Open the map</button></div>
<div class="band"${is('/c-bg') ? ' data-tone="dark"' : ''}><button class="chat" type="button">Chat with us</button></div>
<div class="zone" data-mode="${is('/c-mode') ? 'safe' : 'live'}"><a class="jump" href="/same">Quick apply</a></div>
<div class="pay" data-mode="${is('/c-mode') ? 'safe' : 'live'}"><span class="card">Pay a bill</span> <button class="pay-key" type="button" hidden>Pay a bill</button></div>
<div class="more"><button class="icon" type="button" aria-label="${is('/c-name') ? 'Search the site' : ''}"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button></div>
</header>
<main><h1>City services</h1><p>What the city offers, and how to reach it.</p>${more}<nav aria-label="Pages">${links}</nav></main>
<script src="/shared.js"></script></body></html>`;
};

let browser: Browser;
let server: Server;
let origin: string;
const B = () => browser as unknown as BrowserLike;
const path = (url: string) => new URL(url).pathname;
const fails = (runs: readonly ProbeRun[], p: string, criterion: string, probe?: string) =>
  runs.some((r) => path(r.page) === p && (!probe || r.probe === probe) && r.findings.some((f) => f.criterion === criterion && f.status === 'failed'));

/** The real tests, run whole on the given pages (nothing of the scan's scheduling), with each failing element's kind. */
async function wholeTests(paths: readonly string[]): Promise<{ runs: ProbeRun[]; kindOf: (key: string) => string | undefined }> {
  const kinds = componentKinds();
  const runs = await runProbes(B(), paths.map((p, index) => ({ url: `${origin}${p}`, index })), [keyboardProbe, screenReaderProbe], { userAgent: 'grnted-test', ...kinds.hooks });
  return { runs, kindOf: kinds.kindOf };
}

let sources: Awaited<ReturnType<typeof wholeTests>>;
let truth: ProbeRun[];
let shared: Round1SharedRun[];
let report: SiteReport;

beforeAll(async () => {
  browser = await chromium.launch();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const css = (body: string) => { res.writeHead(200, { 'content-type': 'text/css' }).end(body); };
    if (url.pathname === '/shared.css') return css(CSS);
    if (url.pathname === '/theme.css') return css(THEME[url.searchParams.get('variant') ?? ''] ?? '');
    if (url.pathname === '/a.css' || url.pathname === '/b.css') return css('.unused{color:#111}');
    if (url.pathname === '/c.css') return css('.launch:focus{outline:3px solid #0b4fb3}');
    if (url.pathname === '/shared.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end(JS); return; }
    if (!PATHS.includes(url.pathname)) { res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(url.pathname));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // 1. The two sources, and 2. the ground truth on every other page: the real tests, whole.
  sources = await wholeTests(SOURCES);
  truth = (await wholeTests(['/same', ...COUNTER.map((c) => c.path)])).runs;
  // 3. Round 1's inputs: each page's kinds (the engine's own reader: the hash is round 1's) and round 1's environment.
  const pages: KindPage[] = [];
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    for (const [index, at] of PATHS.entries()) {
      await p.goto(`${origin}${at}`, { waitUntil: 'load' });
      const kinds = await p.evaluate(readKinds, { ...KINDS_LIMITS });
      pages.push({ url: `${origin}${at}`, index, kinds: { ...kinds, env: await p.evaluate(round1Env) } });
    }
  } finally {
    await p.close();
  }
  shared = round1SharedRuns({ pages, runs: sources.runs, kindOf: sources.kindOf });
  // 4. The engine as it is.
  report = await scanSite(`${origin}/`, { browser: B(), maxPages: 25, documents: false, probes: [headingsProbe, keyboardProbe, screenReaderProbe] });
}, 600_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(() => r(null)));
});

describe('1. two failing sources: the real tests, run whole, measure all five failures on both', () => {
  it.each(SOURCES)('%s', (source) => {
    for (const c of ['2.4.7', '1.4.11', '3.2.1', '2.1.1']) expect(fails(sources.runs, source, c, 'keyboard'), c).toBe(true);
    expect(fails(sources.runs, source, '4.1.2', 'screen-reader')).toBe(true);
    expect(ROUND1_SHARED.minMeasured).toBe(2);
  });
});

describe('2. the ground truth: run whole on a counterexample page, the test measures no such failure there', () => {
  it.each(COUNTER)('$path: $differs', ({ path: at, probe, criteria }) => {
    expect(truth.filter((r) => path(r.page) === at && r.probe === probe).map((r) => r.status)).toEqual(['ok']);
    for (const c of criteria) expect(fails(truth, at, c, probe), c).toBe(false);
  });
  it('look-alike: on the page that really is the same, it measures all five', () => {
    for (const c of ['2.4.7', '1.4.11', '3.2.1', '2.1.1']) expect(fails(truth, '/same', c, 'keyboard'), c).toBe(true);
    expect(fails(truth, '/same', '4.1.2', 'screen-reader')).toBe(true);
  });
});

describe('3. the defect: round 1\'s attribution reports the failure on every counterexample page', () => {
  it.each(COUNTER)('$path: reported, though it is not there', ({ path: at, probe, criteria }) => {
    for (const c of criteria) {
      const run = shared.find((r) => path(r.page) === at && r.probe === probe && r.findings.some((f) => f.criterion === c));
      expect(run, `${at} ${c}`).toBeDefined();
      const f = run!.findings.find((x) => x.criterion === c)!;
      expect(f.status).toBe('failed');
      expect(f.detail).toContain(ROUND1_SHARED_NOTE);
      // From two measured sources, as round 1's own rule asked.
      expect(run!.shared.pages).toBe(2);
      expect(run!.shared.from.map(path).sort()).toEqual([...SOURCES].sort());
      // The selector is a source page's, copied.
      expect(sources.runs.some((r) => r.findings.some((x) => x.criterion === c && x.status === 'failed' && x.target === f.target))).toBe(true);
    }
  });
  it('(it is right about the page that really is the same)', () => {
    for (const c of ['2.4.7', '1.4.11', '3.2.1', '2.1.1']) expect(fails(shared, '/same', c, 'keyboard'), c).toBe(true);
  });
});

describe('4. the engine now: nothing is reported on a page it was not measured on', () => {
  const runs = () => report.probes?.runs ?? [];
  /** A run of the whole test (round 1 marked its copies `shared`; the engine now marks its element checks `checked`). */
  const whole = (r: ProbeRun) => !(r as { checked?: unknown }).checked && !(r as { shared?: unknown }).shared;

  it('the scan gave the whole keyboard test to the two sources and to no other page', () => {
    expect(report.pages.map((p) => path(p.url)).sort()).toEqual([...PATHS].sort());
    expect(runs().filter((r) => r.probe === 'keyboard' && whole(r)).map((r) => path(r.page)).sort()).toEqual([...SOURCES].sort());
  });

  it.each(COUNTER)('$path: no such failure', ({ path: at, criteria }) => {
    for (const c of criteria) expect(fails(runs(), at, c), c).toBe(false);
  });

  it('look-alike: the page that really is the same has every failure, measured on its own elements', async () => {
    for (const c of ['2.4.7', '1.4.11', '3.2.1', '2.1.1']) expect(fails(runs(), '/same', c, 'keyboard'), c).toBe(true);
    expect(fails(runs(), '/same', '4.1.2', 'screen-reader')).toBe(true);
    const checked = runs().filter((r) => path(r.page) === '/same' && r.probe === 'keyboard');
    const p = await browser.newPage();
    try {
      await p.goto(`${origin}/same`);
      const cls = async (criterion: string) => p.locator(checked.flatMap((r) => r.findings).find((f) => f.criterion === criterion)!.target!).evaluate((el) => el.className);
      expect([await cls('2.4.7'), await cls('1.4.11'), await cls('3.2.1'), await cls('2.1.1')]).toEqual(['launch', 'chat', 'jump', 'card']);
    } finally {
      await p.close();
    }
    expect(checked.every((r) => r.findings.every((f) => !f.detail.includes(ROUND1_SHARED_NOTE)))).toBe(true);
  });

  it('and each counterexample page keeps the failures it does carry: only the one thing it differs in is clean', () => {
    expect(fails(runs(), '/c-var', '1.4.11')).toBe(true);
    expect(fails(runs(), '/c-bg', '2.4.7')).toBe(true);
    expect(fails(runs(), '/c-name', '2.4.7')).toBe(true);
    expect(fails(runs(), '/c-theme', '2.4.7')).toBe(true);
  });
});
