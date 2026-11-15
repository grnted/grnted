// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The forced-colours probe (plan item C13) in real Chromium: what disappears when Windows shows a page
// in a contrast theme. Chromium emulates forced colours with a light and a dark system palette.
// Fixture site: test/fixtures/forced-colors/ (planted failures and clean look-alikes, synthetic).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvidenceRecorder } from '../../src/evidence/recorder.js';
import { forcedColorsProbe } from '../../src/probes/forcedColors.js';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('forced-colors');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const runOn = async (path: string): Promise<ProbeRun> =>
  (await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [forcedColorsProbe], OPTS))[0]!;
const failed = (r: ProbeRun, criterion: string) => r.findings.filter((f) => f.criterion === criterion && f.status === 'failed').map((f) => f.target);
/** Batch 19 (the lead's D3 ruling): a disappearance in a contrast theme is a recommendation (the 1.4.11 exception for
 * what the user agent draws), never a failure: its findings are no_failures_found with `advice`. */
const advised = (r: ProbeRun, criterion: string) => r.findings.filter((f) => f.criterion === criterion && f.advice).map((f) => f.target);
const detail = (r: ProbeRun, target: string) => r.findings.find((f) => f.target === target)!.detail;

describe('forced colors (Windows contrast themes)', () => {
  it('controls whose icon or edge disappears are recommendations under 1.4.11, never failures (a black picture icon on the dark theme too); icons in the text color, fixed for forced colors or ringed stay', async () => {
    const t0 = Date.now();
    const r = await runOn('/controls.html');
    console.log(`forced-colors controls page: ${Date.now() - t0} ms (page load included)`);
    expect(r.status).toBe('ok');
    expect(failed(r, '1.4.11')).toEqual([]);
    expect(advised(r, '1.4.11').sort()).toEqual(['#c-bg-black', '#c-black-svg', '#c-box-fill', '#c-field-fill', '#c-mask', '#c-white-svg']);
    expect(detail(r, '#c-white-svg')).toMatch(/^An icon-only control \(svg\) disappears in a light contrast theme \(forced colors\).*“Search”$/);
    expect(detail(r, '#c-black-svg')).toMatch(/disappears in a dark contrast theme/);
    expect(detail(r, '#c-bg-black')).toMatch(/^An icon-only control \(background image\) disappears in a dark contrast theme/);
    expect(detail(r, '#c-box-fill')).toMatch(/^A custom checkbox or radio button disappears in light and dark contrast themes/);
    expect(r.findings.some((f) => f.status === 'not_testable')).toBe(false);
  }, 60_000);

  it('text that keeps its own color over a picture disappears on the theme\'s backplate (1.4.3, a recommendation); text the theme recolours stays readable', async () => {
    const r = await runOn('/text.html');
    expect(r.status).toBe('ok');
    expect(failed(r, '1.4.3')).toEqual([]);
    expect(advised(r, '1.4.3')).toEqual(['#t-keep']);
    expect(detail(r, '#t-keep')).toMatch(/^Text disappears in a light contrast theme \(forced colors\).*“Spring open house on May 4”$/);
  }, 60_000);

  // W3C precision lane (2026-11-11): a recommendation, never a 2.4.7 failure: the indicator in normal colors is "a mode of
  // operation where the keyboard focus indicator is visible".
  it('a focus indicator drawn only with a shadow or a background color disappears (2.4.7): a recommendation, never a failure; outlines, transparent outlines and text fields give none', async () => {
    const t0 = Date.now();
    const r = await runOn('/focus.html');
    console.log(`forced-colors focus page: ${Date.now() - t0} ms (page load included)`);
    expect(r.status).toBe('ok');
    expect(failed(r, '2.4.7')).toEqual([]);
    const advice = r.findings.filter((f) => f.criterion === '2.4.7' && f.advice);
    expect(advice.map((f) => [f.target, f.status])).toEqual([['#f-shadow', 'no_failures_found'], ['#f-fill', 'no_failures_found']]);
    expect(detail(r, '#f-shadow')).toMatch(/^In a dark contrast theme \(Windows High Contrast, forced colors\) the focus indicator disappears: .*in normal colors it shows, which meets 2\.4\.7\. .*: “Calendar”$/);
    expect(probeCriteriaResults([r]).find((c) => c.criterion === '2.4.7')?.method.status).toBe('no_failures_found');
  }, 60_000);

  it('a page with none of it is not applicable, never a failure', async () => {
    const r = await runOn('/empty.html');
    expect(r.status).toBe('ok');
    expect(r.findings.map((f) => [f.criterion, f.status]).sort()).toEqual([['1.4.11', 'not_applicable'], ['1.4.3', 'not_applicable'], ['2.4.7', 'not_applicable']]);
  }, 60_000);

  it('a page that loads another page on focus is not testable, never a clean result', async () => {
    const r = await runOn('/focus-nav.html');
    expect(r.findings.filter((f) => f.criterion === '2.4.7').map((f) => f.status)).toEqual(['not_testable']);
  }, 60_000);

  it('a huge, deeply nested page with hundreds of pictures and icon links finishes well inside its time box', async () => {
    const t0 = Date.now();
    const r = await runOn('/heavy.html');
    const ms = Date.now() - t0;
    console.log(`forced-colors heavy page: ${ms} ms (page load included)`);
    expect(r.status).toBe('ok');
    expect(ms).toBeLessThan(forcedColorsProbe.timeoutMs);
  }, 90_000);

  it('a disappearance (a recommendation) gets no picture, with the same results as without the recorder', async () => {
    // The focus indicator's disappearance is a recommendation since the W3C precision lane: no picture (the report keeps
    // pictures of failures only), and the same results as without the recorder.
    const recFocus = createEvidenceRecorder({ sink: () => {} });
    const [withRec] = await runProbes(B(), [{ url: `${server.origin}/focus.html`, index: 0 }], [forcedColorsProbe], { ...OPTS, evidence: recFocus });
    expect(withRec!.findings).toEqual((await runOn('/focus.html')).findings);
    expect(recFocus.shots().filter((x) => 'criterion' in x.for && x.for.criterion === '2.4.7')).toEqual([]);
    // Batch 19 (the lead's D3 ruling): a control's disappearance is a recommendation too, so it gets no picture either;
    // the results are the same with and without the recorder.
    for (const [path, criterion] of [['/controls.html', '1.4.11'], ['/text.html', '1.4.3']] as const) {
      const rec = createEvidenceRecorder({ sink: () => {} });
      const [r] = await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [forcedColorsProbe], { ...OPTS, evidence: rec });
      const plain = await runOn(path);
      expect(r!.findings).toEqual(plain.findings);
      expect(rec.shots().filter((x) => 'criterion' in x.for && x.for.criterion === criterion)).toEqual([]);
    }
  }, 90_000);
});
