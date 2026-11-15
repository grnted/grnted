// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, forms lane, Phase 2 ("break it yourself", out/specs/b18-common.md): 20 variants and 20 look-alikes the lane
// did not build for (other platforms' markup, other techniques), run through the probes as a scan runs them. This file
// REPORTS (it writes a table when B18_BREAKIT_OUT names a file); it asserts only that every page was judged, so that
// escapes and false alarms are counted honestly instead of being tuned away.
import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { controlsProbe } from '../../src/probes/controls/index.js';
import { formFieldsProbe, formsProbe } from '../../src/probes/forms.js';
import { orientationProbe } from '../../src/probes/orientation.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

/** Page, criterion, and the expected verdict ('fail' for a variant, 'pass' for a look-alike). */
const CASES: [string, string, 'fail' | 'pass'][] = [
  ['v01-elementor-screen-only', '3.3.2', 'fail'], ['v02-hubspot-no-autocomplete', '1.3.5', 'fail'], ['v03-vue-untied-error', '3.3.1', 'fail'],
  ['v04-nav-language-jump', '3.2.2', 'fail'], ['v05-checkbox-filter-count', '4.1.3', 'fail'], ['v06-card-frame-pay', '3.3.4', 'fail'],
  ['v07-security-answer-cleared', '3.3.8', 'fail'], ['v08-dialog-step', '3.3.7', 'fail'], ['v09-stepper-back', '3.3.7', 'fail'],
  ['v10-tooltip-error', '3.3.1', 'fail'], ['v11-pattern-empty-title', '3.3.3', 'fail'], ['v12-wrong-date', '3.3.3', 'fail'],
  ['v13-formstack-collective', '3.3.2', 'fail'], ['v14-js-orientation-wall', '1.3.4', 'fail'], ['v15-labels-display-none-mobile', '3.3.2', 'fail'],
  ['v16-lookup-action-only', '3.3.2', 'fail'], ['v17-spanish-phone', '1.3.5', 'fail'], ['v18-add-to-cart-badge', '4.1.3', 'fail'],
  ['v19-rendered-phone-other-words', '3.3.7', 'fail'], ['v20-radio-submits', '3.2.2', 'fail'],
  ['l01-elementor-visible', '3.3.2', 'pass'], ['l02-hubspot-autocomplete', '1.3.5', 'pass'], ['l03-vue-tied-error', '3.3.1', 'pass'],
  ['l04-language-go', '3.2.2', 'pass'], ['l05-filter-live', '4.1.3', 'pass'], ['l06-card-frame-review', '3.3.4', 'pass'],
  ['l07-security-answer-paste-ok', '3.3.8', 'pass'], ['l08-dialog-step-prefilled', '3.3.7', 'pass'], ['l09-stepper-summary', '3.3.7', 'pass'],
  ['l10-error-text-and-tooltip', '3.3.1', 'pass'], ['l11-pattern-titled', '3.3.3', 'pass'], ['l12-wrong-date-hinted', '3.3.3', 'pass'],
  ['l13-asterisk-legend', '3.3.2', 'pass'], ['l14-orientation-columns', '1.3.4', 'pass'], ['l15-floating-mui', '3.3.2', 'pass'],
  ['l16-lookup-names-field', '3.3.2', 'pass'], ['l17-spanish-emergency', '1.3.5', 'pass'], ['l18-add-to-cart-status', '4.1.3', 'pass'],
  ['l19-rendered-landlord', '3.3.7', 'pass'], ['l20-radio-reveals', '3.2.2', 'pass'],
];

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const runs = new Map<string, ProbeRun[]>();

beforeAll(async () => {
  server = await startFixtureServer('b18-breakit');
  browser = await chromium.launch();
  const pages = [...new Set(CASES.map(([p]) => p))];
  const out = await runProbes(browser as unknown as BrowserLike, pages.map((p, index) => ({ url: `${server.origin}/${p}.html`, index })),
    [formFieldsProbe, formsProbe, controlsProbe, orientationProbe], { userAgent: 'grnted-test', settleMs: 200, full: true });
  for (const r of out) {
    const key = new URL(r.page).pathname.slice(1, -5);
    runs.set(key, [...(runs.get(key) ?? []), r]);
  }
}, 600_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

it('Phase 2: every break-it page is judged; the table of outcomes is written for the READY report', () => {
  const rows = CASES.map(([page, criterion, want]) => {
    const fs = (runs.get(page) ?? []).flatMap((r) => r.findings.filter((f) => f.criterion === criterion).map((f) => ({ ...f, probe: r.probe })));
    const got = fs.some((f) => f.status === 'failed') ? 'fail' : fs.some((f) => f.status === 'not_testable') ? 'not_testable' : fs.length ? 'pass' : 'no result';
    const ok = want === 'fail' ? got === 'fail' : got !== 'fail';
    const note = (fs.find((f) => (want === 'fail' ? f.status !== 'failed' : f.status === 'failed')) ?? fs[0])?.detail ?? '';
    return { page, criterion, want, got, ok, note: note.slice(0, 160) };
  });
  const table = ['| page | criterion | expected | Granted | right | note |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.page} | ${r.criterion} | ${r.want} | ${r.got} | ${r.ok ? 'yes' : 'NO'} | ${r.note.replace(/\|/g, '/')} |`)].join('\n');
  const v = rows.filter((r) => r.want === 'fail');
  const l = rows.filter((r) => r.want === 'pass');
  const summary = `variants caught ${v.filter((r) => r.ok).length}/${v.length}; look-alikes clean ${l.filter((r) => r.ok).length}/${l.length}`;
  if (process.env.B18_BREAKIT_OUT) writeFileSync(process.env.B18_BREAKIT_OUT, `${summary}\n\n${table}\n`);
  console.log(summary);
  expect(rows.every((r) => runs.has(r.page))).toBe(true);
});
