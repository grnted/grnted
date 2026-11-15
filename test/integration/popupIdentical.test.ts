// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page-load pop-ups, rule 6 (src/probes/popupAside.ts): a page with no qualifying box is measured by text contrast,
// non-text contrast and reflow exactly as on `hosted/integration` before the pop-up work. The expected findings
// (test/fixtures/popup-aside/identical.json) were written by this file run on `hosted/integration` @ c9c0592b
// (`WRITE_IDENTICAL=1`); a scan of each fixture page, one page at a time, must give the same findings, byte for byte.
// Batch 15b: render/reflow-clean.html's text-contrast row is from the reviewed ACT runtime @ 42be18f7,
// verified on the same fixture: content marked as a graphic is excluded from text contrast.
// Batch 19: excerpts in details end on a whole word (src/clip.ts); the file was rewritten for that alone (WRITE_IDENTICAL=1
// on the Mac; statuses, targets and measurements unchanged).
// One deliberate difference is not listed here: a reflow look that read only part of the page (its caps) is no
// longer clean (Sol popup-r3 8; test/integration/popupAside.test.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

const FILE = new URL('../fixtures/popup-aside/identical.json', import.meta.url);
/** Fixture pages with no pop-up, by fixture directory: the contrast, render and pop-up tests' own pages. */
const PAGES: Record<string, string[]> = {
  contrast: ['/text.html', '/text-covered.html', '/text-faded.html', '/text-mobile.html', '/text-unmeasured.html', '/controls.html', '/controls-unmeasured.html', '/links.html'],
  render: ['/reflow.html', '/reflow-clean.html', '/reflow-app.html', '/reflow-more.html', '/reflow-spa.html'],
  'popup-aside': ['/?nopop=1', '/?nopop=1&lowpage=1&ghost=1', '/?nopop=1&wide=1&hidden=1', '/cases.html?case=notice', '/cases.html?case=pane', '/shell.html'],
};

let browser: Browser;
const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) await s.close();
});

type Row = { probe: string; status: string; findings: { criterion: string; status: string; target?: string; detail?: string }[] };

describe('a page with no page-load pop-up is measured exactly as before (rule 6)', () => {
  it('text contrast, non-text contrast and reflow give integration\'s findings on every fixture page without one', async () => {
    const got: Record<string, Row[]> = {};
    for (const [dir, paths] of Object.entries(PAGES)) {
      const server = await startFixtureServer(dir);
      servers.push(server);
      for (const path of paths) {
        const report = await scanSite(`${server.origin}${path}`, {
          browser: browser as unknown as BrowserLike, maxPages: 1, concurrency: 1, startConcurrency: 1, documentScore: false,
          probes: [textContrastProbe, nonTextContrastProbe, reflowProbe],
        });
        const runs = (report.probes?.runs ?? []).map((r) => ({
          probe: r.probe, status: r.status,
          findings: r.findings.map((f) => ({ criterion: f.criterion, status: f.status, ...(f.target ? { target: f.target } : {}), ...(f.detail ? { detail: f.detail } : {}) })),
          popup: (r.data as { popup?: unknown } | undefined)?.popup,
        }));
        // No pop-up was found: the page took the path it took before the pop-up work.
        for (const r of runs) expect(r.popup, `${dir}${path} ${r.probe}`).toBeUndefined();
        got[`${dir}${path}`] = runs.map(({ popup: _p, ...r }) => r).sort((a, b) => (a.probe < b.probe ? -1 : 1));
      }
    }
    if (process.env.WRITE_IDENTICAL) {
      writeFileSync(FILE, `${JSON.stringify(got, null, 1)}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Row[]>;
    expect(Object.keys(got)).toEqual(Object.keys(want));
    // text-covered.html makes ids from the clock on each load (`gen-<time>`, its regenerated-id case): the only part that may differ.
    const same = (x: unknown) => JSON.stringify(x).replace(/gen-\d+/g, 'gen-N');
    expect(Object.keys(want).filter((k) => same(got[k]) !== same(want[k])).map((k) => `${k}\n  got:  ${same(got[k])}\n  want: ${same(want[k])}`)).toEqual([]);
  }, 600_000);
});
