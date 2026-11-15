// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Literal eligibility counterexamples from Sol popup-r9 and the lead's round-10 rulings.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { PageProbe } from '../../src/probes/types.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, Finding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let frameServer: Awaited<ReturnType<typeof startFixtureServer>>;
let axeSource: string;
const html = (body: string) => ({ type: 'text/html; charset=utf-8', body });
const pageHtml = (body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Branch hours</title>
<style>body{font:16px/1.5 Arial;color:#222;background:white}.copy{color:#aaa;background:white}</style>
<main><h1>Library news</h1><p>${'The library is open on weekdays. Visit the front desk for books, maps and local information. '.repeat(8)}</p></main>
${body}</html>`;
const close = '<button onclick="this.parentElement.remove()">Close</button>';
const popup = (body: string) => `<div id="pop" role="dialog" aria-modal="true" style="position:fixed;top:100px;left:500px;background:white;padding:20px">${body}${close}</div>`;
const undecided = (target: string, markup: string): Finding[] => [{
  id: 'color-contrast', help: 'contrast', helpUrl: '', nodes: [{ target, html: markup, viewports: ['desktop'] }],
}];
const run = async (path: string, incomplete: Finding[]) => {
  const [result] = await runProbes(browser as unknown as BrowserLike,
    [{ url: `${server.origin}/${path}`, index: 0, incomplete }], [textContrastProbe], { userAgent: 'grnted-test', axeSource });
  expect(result!.status).toBe('ok');
  expect((result!.data as { popup?: unknown } | undefined)?.popup, JSON.stringify(result!.findings)).toMatchObject({ setAside: true });
  return result!;
};

beforeAll(async () => {
  frameServer = await startFixtureServer('popup-aside', {
    '/notice': html('<!doctype html><html lang="en"><title>Notice</title><p id="own-text" style="background:linear-gradient(white,#eee)">Branch hours</p></html>'),
  });
  const frame = `<iframe id="frame" title="Notice" src="${frameServer.origin}/notice" width="240" height="80"></iframe>`;
  server = await startFixtureServer('popup-aside', {
    '/ambiguous': html(pageHtml(`${popup('<p id="inside-new" class="copy">Branch hours</p>')}<p id="outside-new" class="copy">Branch hours</p>`)),
    '/ambiguous-missing': html(pageHtml(`${popup('<p id="inside-new" class="copy">Branch hours</p>').replace('this.parentElement.remove()', "document.getElementById('outside-new').textContent='Updated branch hours';this.parentElement.remove()")}<p id="outside-new" class="copy">Branch hours</p>`)),
    '/unique-inside': html(pageHtml(popup('<p id="inside-new" class="copy">Branch hours</p>'))),
    '/inside-frame': html(pageHtml(popup(frame))),
    '/outside-frame': html(pageHtml(`${frame}${popup('<p>Branch hours</p>')}`)),
    '/incidental': html(pageHtml(`${popup('<p>Branch hours</p>')}
      <p id="t-same" style="color:#e8e8e8;background:#e8e8e8">keywords: council, minutes, agenda</p>
      <button id="t-glyph" aria-label="Next page" style="font:16px Arial;color:#6e6e6e;background:#111">&raquo;</button>
      <a id="t-digit" href="#p4" aria-label="Page 4" style="color:#808080;background:#eee">4</a>
      <span id="t-lone" style="color:#808080;background:#eee">7</span>
      <p id="t-near" style="color:#e8e8e8;background:white">Faint text that can still be seen.</p>`)),
  });
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
});
afterAll(async () => { await browser?.close(); await server?.close(); await frameServer?.close(); });

describe('round 10 inside-box eligibility', () => {
  it('batch 15b: the cleared-page look keeps the ACT incidental-text and icon exclusions, and still fails their look-alikes', async () => {
    const r = await run('incidental', ['#t-same', '#t-glyph', '#t-digit', '#t-lone', '#t-near'].flatMap((target) => undecided(target, '<span>')));
    expect(r.findings.filter((f) => f.status === 'failed').map((f) => f.target).sort()).toEqual(['#t-digit', '#t-lone', '#t-near']);
    const items = Object.fromEntries((r.data as { items: { target: string; result: string }[] }).items.map((i) => [i.target, i.result]));
    expect(items).toMatchObject({ '#t-same': 'unshown: invisible', '#t-glyph': 'unshown: glyph' });
  }, 60_000);

  it('batch 15b: dismissal retires the page before other probes and preserves a pending late pass’s first failure', async () => {
    let lateCalls = 0;
    const first = { criterion: '2.2.2', status: 'failed' as const, detail: 'first pass before dismissal' };
    const mover: PageProbe = {
      id: 'mover', criteria: ['2.2.2'], tier: 'core', kind: 'interaction', timeoutMs: 2000,
      async run() { return [first]; },
      late: { timeoutMs: 2000, async run() { lateCalls++; return []; } },
    };
    const next: PageProbe = {
      id: 'after-dismissal', criteria: ['2.2.1'], tier: 'core', kind: 'interaction', timeoutMs: 2000,
      async run(ctx) {
        expect(await ctx.page.evaluate(() => !!document.querySelector('#pop'), undefined)).toBe(true);
        return [];
      },
    };
    const runs = await runProbes(browser as unknown as BrowserLike,
      [{ url: `${server.origin}/unique-inside`, index: 0, incomplete: undecided('#inside-new', '<p>Branch hours</p>') }],
      [mover, textContrastProbe, next], { userAgent: 'grnted-test', axeSource });
    expect(runs.every((r) => r.status === 'ok')).toBe(true);
    expect(runs.find((r) => r.probe === 'text-contrast')!.data).toMatchObject({ popup: { setAside: true } });
    expect(runs.find((r) => r.probe === 'after-dismissal')!.findings).toEqual([]);
    expect(runs.find((r) => r.probe === 'mover')!.findings).toEqual([first]);
    expect(lateCalls).toBe(0);
  }, 60_000);

  it('P1: ambiguous inside/outside recovery keeps the persistent outside failure eligible', async () => {
    const r = await run('ambiguous', undecided('#outside-old', '<p id="outside-old" class="copy">Branch hours</p>'));
    expect(r.findings.filter((f) => f.status === 'failed').map((f) => f.target)).toEqual(['#outside-new']);
    expect(r.findings.some((f) => f.status === 'no_failures_found')).toBe(false);
  }, 60_000);

  it('P2: an inaccessible leaf in a cross-origin frame inside the box is excluded', async () => {
    const r = await run('inside-frame', undecided('#frame >>> #own-text', '<p id="own-text">Branch hours</p>'));
    expect(r.findings.map((f) => f.status)).toEqual(['no_failures_found']);
  }, 60_000);

  it('P1 look-alike: ambiguous recovery preserves uncertainty if the outside text changes on dismissal', async () => {
    const r = await run('ambiguous-missing', undecided('#outside-old', '<p id="outside-old" class="copy">Branch hours</p>'));
    expect(r.findings).toEqual([{
      criterion: '1.4.3', status: 'not_testable', target: '#outside-old',
      detail: expect.stringMatching(/could not be found.*second look/),
    }]);
  }, 60_000);

  it('P1 look-alike: a unique recovered inside target is still excluded', async () => {
    const r = await run('unique-inside', undecided('#inside-old', '<p id="inside-old" class="copy">Branch hours</p>'));
    expect(r.findings.map((f) => f.status)).toEqual(['no_failures_found']);
  }, 60_000);

  it('P1 look-alike: a direct inside selector stays excluded despite matching outside markup', async () => {
    const r = await run('ambiguous', undecided('#inside-new', '<p id="inside-new" class="copy">Branch hours</p>'));
    expect(r.findings.map((f) => f.status)).toEqual(['no_failures_found']);
  }, 60_000);

  it('P2 look-alike: an inaccessible leaf in an outside frame keeps its uncertainty', async () => {
    const r = await run('outside-frame', undecided('#frame >>> #own-text', '<p id="own-text">Branch hours</p>'));
    expect(r.findings).toContainEqual({
      criterion: '1.4.3', status: 'not_testable', target: '#frame >>> #own-text',
      detail: expect.stringMatching(/could not be found.*second look/),
    });
    expect(r.findings.some((f) => f.status === 'no_failures_found')).toBe(false);
  }, 60_000);
});
