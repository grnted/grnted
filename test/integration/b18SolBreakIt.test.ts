// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, forms lane, fix round: Sol's break-it pages (out/reviews/b18-forms-sol-r1.md; copied here as the fixture
// site b18-breakit) run through the lane's probes as a scan runs them. The ten
// look-alikes must stay clean (the lead's READY bar for the fix round): a failure on any of them fails this test. The
// ten variants are reported only (several need the AI checks or reach the test does not have yet).
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
  ['sol-variant-01', '3.3.2', 'fail'], ['sol-variant-02', '3.2.2', 'fail'], ['sol-variant-03', '3.3.1', 'fail'], ['sol-variant-04', '3.3.3', 'fail'],
  ['sol-variant-05', '3.3.7', 'fail'], ['sol-variant-06', '3.3.7', 'fail'], ['sol-variant-07', '3.3.7', 'fail'], ['sol-variant-08', '1.3.5', 'fail'],
  ['sol-variant-09', '3.3.2', 'fail'], ['sol-variant-10', '4.1.3', 'fail'],
  ['sol-lookalike-01', '3.3.2', 'pass'], ['sol-lookalike-02', '3.3.7', 'pass'], ['sol-lookalike-03', '1.3.5', 'pass'], ['sol-lookalike-04', '3.3.4', 'pass'],
  ['sol-lookalike-05', '3.3.8', 'pass'], ['sol-lookalike-06', '4.1.3', 'pass'], ['sol-lookalike-07', '4.1.3', 'pass'], ['sol-lookalike-08', '3.3.3', 'pass'],
  ['sol-lookalike-09', '3.3.8', 'pass'], ['sol-lookalike-10', '1.3.4', 'pass'],
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

it('Sol r1 break-it: every look-alike stays clean; the variants are reported', () => {
  const rows = CASES.map(([page, criterion, want]) => {
    const fs = (runs.get(page) ?? []).flatMap((r) => r.findings.filter((f) => f.criterion === criterion).map((f) => ({ ...f, probe: r.probe })));
    const got = fs.some((f) => f.status === 'failed') ? 'fail' : fs.some((f) => f.status === 'not_testable') ? 'not_testable' : fs.length ? 'pass' : 'no result';
    const ok = want === 'fail' ? got === 'fail' : got !== 'fail';
    const note = (fs.find((f) => (want === 'fail' ? f.status !== 'failed' : f.status === 'failed')) ?? fs[0])?.detail ?? '';
    return { page, criterion, want, got, ok, note: note.slice(0, 200), all: fs };
  });
  const table = ['| page | criterion | expected | Granted | right | note |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.page} | ${r.criterion} | ${r.want} | ${r.got} | ${r.ok ? 'yes' : 'NO'} | ${r.note.replace(/\|/g, '/')} |`)].join('\n');
  const v = rows.filter((r) => r.want === 'fail');
  const l = rows.filter((r) => r.want === 'pass');
  const summary = `variants caught ${v.filter((r) => r.ok).length}/${v.length}; look-alikes clean ${l.filter((r) => r.ok).length}/${l.length}`;
  if (process.env.B18_BREAKIT_OUT) writeFileSync(process.env.B18_BREAKIT_OUT, `${summary}\n\n${table}\n`);
  console.log(`${summary}\n${table}`);
  if (process.env.B18_DEBUG) for (const r of rows) console.log(r.page, JSON.stringify(r.all.map((f) => [f.probe, f.status, f.target, f.detail])));
  expect(rows.every((r) => runs.has(r.page))).toBe(true);
  expect(l.filter((r) => !r.ok).map((r) => r.page)).toEqual([]);
});
