// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.11 Non-text contrast at the phone width, in real Chromium. The test measured the controls of the
// desktop layout only, so a control that exists only on a narrow screen (a menu button), and an icon a media
// query recolours there, were never looked at. WCAG's requirement holds at every width a user can have: "The
// visual presentation of User Interface Components … [has] a contrast ratio of at least 3:1 against adjacent
// color(s)" (SC 1.4.11; technique G207 for icons). The second look is at 390×844, the audit's phone width, and
// measures only what is new or looks different there.
// Look-alikes: a narrow-screen control with a clear icon, a recolour that stays clear, a control that already
// failed at the desktop width (reported once), and a narrow-screen control parked off the side of the screen in
// a closed sliding panel (not shown there: never failed, and the page stays decided).
// What is found at the phone width and cannot be measured is never dropped (review r1, finding 10): it is
// reported as not measured at the phone width; when the phone width is not looked at at all the result says so;
// and more controls of a kind than the test measures is reported too.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NON_TEXT_TIMING, nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const BARS = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" fill="none" stroke="currentColor" stroke-width="3"/></svg>';
const PLUS = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" stroke-width="4"/></svg>';
const BASE = `body { font: 16px/1.5 sans-serif; margin: 0; background: #fff; color: #1b1b1b; } header { display: flex; align-items: center; gap: 16px; padding: 12px 16px; }
button.icon { width: 44px; height: 44px; padding: 0; border: 0; background: none; display: inline-flex; align-items: center; justify-content: center; color: #12343b; }
main { padding: 16px; }`;
const doc = (css: string, header: string, main = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Branch library</title>
<style>${BASE} ${css}</style></head><body><header><strong>Branch library</strong>${header}</header><main><h1>Branch library</h1><p>Opening hours, events and how to join.</p>${main}</main></body></html>`;

async function run(html: string, probe = nonTextContrastProbe): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true });
    return runs.find((r) => r.probe === 'non-text-contrast')!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');
const text = (r: ProbeRun) => JSON.stringify(r.findings);

describe('non-text contrast (1.4.11): the phone-width look\'s debug timing', () => {
  it('is off by default, and reports each phone-width look with its page when a listener is set (results unchanged)', async () => {
    expect(NON_TEXT_TIMING.phone).toBeUndefined();
    const page = doc('#menu { display: none; color: #cfd8dc; } @media (max-width: 600px) { #menu { display: inline-flex; } }', `<button id="menu" class="icon" aria-label="Menu">${BARS}</button>`);
    const off = await run(page);
    const seen: { url: string; ms: number; measured: number }[] = [];
    NON_TEXT_TIMING.phone = (e) => { seen.push(e); };
    let on: ProbeRun;
    try {
      on = await run(page);
    } finally {
      delete NON_TEXT_TIMING.phone;
    }
    expect(seen).toEqual([{ url: expect.stringMatching(/\/$/), ms: expect.any(Number), measured: 1 }]);
    expect(seen[0]!.ms).toBeGreaterThanOrEqual(400 + 200);
    expect(failed(on).map((f) => f.target)).toEqual(failed(off).map((f) => f.target));
  }, 90_000);
});

describe('non-text contrast (1.4.11): controls of the phone-width layout', () => {
  it('fails a faint menu button that is shown only on a narrow screen', async () => {
    const r = await run(doc('#menu { display: none; color: #cfd8dc; } @media (max-width: 600px) { #menu { display: inline-flex; } }', `<button id="menu" class="icon" aria-label="Menu">${BARS}</button>`));
    expect(failed(r), text(r)).toEqual([expect.objectContaining({ criterion: '1.4.11', target: '#menu', detail: expect.stringMatching(/^At the phone width \(390 px\): the icon of an icon-only control \(svg\) has 1\.\d:1 contrast .*“Menu”$/) })]);
  }, 90_000);

  it('fails an icon that a media query makes faint on a narrow screen, though it is clear at the desktop width', async () => {
    const r = await run(doc('@media (max-width: 480px) { #add { color: #ccd9d3; } }', `<button id="add" class="icon" aria-label="Add a session">${PLUS}</button>`));
    expect(failed(r), text(r)).toEqual([expect.objectContaining({ target: '#add', detail: expect.stringMatching(/^At the phone width \(390 px\): the icon of an icon-only control .*“Add a session”$/) })]);
  }, 90_000);

  it('fails a field whose border a media query makes faint on a narrow screen', async () => {
    const r = await run(doc('input { font: inherit; padding: 8px; width: 240px; background: #fff; border: 1px solid #555; } @media (max-width: 480px) { input { border-color: #dcdcdc; } }', '',
      '<label for="card">Card number</label><br><input id="card" name="card">'));
    expect(failed(r), text(r)).toEqual([expect.objectContaining({ target: '#card', detail: expect.stringMatching(/^At the phone width \(390 px\): a form field’s boundary has 1\.\d:1 contrast/) })]);
  }, 90_000);

  it('look-alike: a clear menu button shown only on a narrow screen, and a recolour that stays clear, have no failure', async () => {
    const r = await run(doc('#menu { display: none; } @media (max-width: 600px) { #menu { display: inline-flex; } #add { color: #7a1f1f; } }',
      `<button id="menu" class="icon" aria-label="Menu">${BARS}</button><button id="add" class="icon" aria-label="Add a session">${PLUS}</button>`));
    expect(r.findings, text(r)).toEqual([]);
    expect(r.status).toBe('ok');
  }, 90_000);

  it('look-alike: a control that is faint at every width is reported once, as at the desktop width', async () => {
    const r = await run(doc('#add { color: #ccd9d3; } @media (max-width: 480px) { #add { color: #d5dfda; } }', `<button id="add" class="icon" aria-label="Add a session">${PLUS}</button>`));
    expect(failed(r), text(r)).toEqual([expect.objectContaining({ target: '#add', detail: expect.stringMatching(/^The icon of an icon-only control/) })]);
  }, 90_000);

  it('look-alike: a faint close button inside a sliding menu parked off the side of a narrow screen is not shown there: not failed, and the page stays decided', async () => {
    const r = await run(doc(`#panel { display: none; } @media (max-width: 600px) { #panel { display: block; position: fixed; top: 0; left: 0; width: 280px; height: 100%; background: #fff; transform: translateX(-100%); } }
#close { color: #cfd8dc; }`, '', `<div id="panel"><button id="close" class="icon" aria-label="Close menu">${PLUS}</button><a href="/hours">Hours</a></div>`));
    expect(r.findings.filter((f) => f.status !== 'not_applicable'), text(r)).toEqual([]);
  }, 90_000);

  // Review r1, finding 10.
  it('reports a phone-only icon it cannot measure (the colors behind it keep changing) as not measured at the phone width, never as clean', async () => {
    const r = await run(doc(`#menu { display: none; color: #cfd8dc; } @media (max-width: 600px) { #menu { display: inline-flex; animation: pulse 0.2s linear infinite alternate; } }
@keyframes pulse { from { background: #ffffff; } to { background: #10202a; } } input { font: inherit; padding: 8px; border: 1px solid #555; background: #fff; }`,
      `<button id="menu" class="icon" aria-label="Menu">${BARS}</button>`, '<label for="q">Search the catalogue</label><br><input id="q" name="q">'));
    expect(failed(r), text(r)).toEqual([]);
    expect(r.findings, text(r)).toEqual([expect.objectContaining({ criterion: '1.4.11', status: 'not_testable', target: '#menu', detail: expect.stringMatching(/^1 control of 2 could not be measured: 1 because .* \(at the phone width\)$/) })]);
  }, 90_000);

  it('says so when the phone width was not looked at for lack of time: "Not tested at the phone width", never clean', async () => {
    const html = doc('#menu { display: none; color: #cfd8dc; } @media (max-width: 600px) { #menu { display: inline-flex; } }', `<button id="menu" class="icon" aria-label="Menu">${BARS}</button>`);
    // With 4 s in all, less than the 5 s the phone-width look needs is left.
    const r = await run(html, { ...nonTextContrastProbe, timeoutMs: 4000 });
    expect(r.findings, text(r)).toEqual([expect.objectContaining({ criterion: '1.4.11', status: 'not_testable', detail: 'Not tested at the phone width: the time for this test ran out first' })]);
  }, 90_000);

  it('reports more icon-only controls than it measures as not measured; a page within the limit is decided', async () => {
    const many = (n: number) => doc('', Array.from({ length: n }, (_, i) => `<button class="icon" aria-label="Shelf ${i + 1}">${PLUS}</button>`).join(''));
    const over = await run(many(44));
    expect(failed(over), text(over)).toEqual([]);
    expect(over.findings, text(over)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('4 because the page has more controls of that kind than the test measures') })]);
    const within = await run(many(12));
    expect(within.findings, text(within)).toEqual([]);
  }, 120_000);

  it('look-alike: a faint narrow-screen icon cut off by a strip that scrolls sideways is measured or reported, never dropped', async () => {
    const r = await run(doc(`.strip { display: none; } @media (max-width: 600px) { .strip { display: block; width: 200px; overflow-x: auto; white-space: nowrap; } .strip span { display: inline-block; width: 220px; } }`,
      '', `<div class="strip"><span>Opening hours this week</span><button id="far" class="icon" aria-label="More branches" style="color:#cfd8dc">${PLUS}</button></div>`));
    expect(r.findings.some((f) => (f.status === 'failed' && f.target === '#far') || (f.status === 'not_testable' && /at the phone width/.test(f.detail))), text(r)).toBe(true);
  }, 90_000);
});
