// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.4 Resize text: the viewport setting read as the browser reads it, in real Chromium. The test for zoom
// being turned off in `<meta name="viewport">` reads the setting the way browsers do (src/probes/metaViewport.ts):
// `user-scalable=false` turns zoom off (an unknown word reads as 0) although the axe rule `meta-viewport` passes
// it; `maximum-scale=5;user-scalable=false` does NOT (a ";" is no separator: the browser reads maximum-scale 5
// and never sets user-scalable), and a split on ";" called it off. ACT rule b4f0c3.
// Look-alikes: the words and numbers that allow zoom, no setting at all, and the values axe already fails
// (`user-scalable=no`, `maximum-scale=1`), which this test leaves to axe so nothing is reported twice. A setting
// the reader cannot be sure of leaves the page undecided, never failed and never clean.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const doc = (viewport: string | null) => `<!doctype html><html lang="en"><head><meta charset="utf-8">${viewport === null ? '' : `<meta name="viewport" content="${viewport}">`}<title>Swim times</title></head>
<body><main><h1>Swim times</h1><p>The pool opens at six on weekdays and at eight at the weekend.</p></main></body></html>`;

async function pages(values: Record<string, string | null>): Promise<Record<string, ProbeRun>> {
  const sim = await startSimServer({ files: Object.fromEntries(Object.entries(values).map(([name, v]) => [`/${name}`, doc(v)])) });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, Object.keys(values).map((name, index) => ({ url: `${sim.origin}/${name}`, index })), [resizeTextProbe], { userAgent: 'grnted-test', full: true });
    return Object.fromEntries(runs.map((r) => [new URL(r.page).pathname.slice(1), r]));
  } finally {
    await sim.close();
  }
}

describe('resize text (1.4.4): zoom turned off by a word in the viewport setting', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await pages({
      'scalable-false': 'width=device-width, initial-scale=1, user-scalable=false',
      'max-none': 'width=device-width; maximum-scale=none',
      'semicolon': 'width=device-width, maximum-scale=5;user-scalable=false',
      'semicolon-no': 'width=device-width, maximum-scale=5;user-scalable=no',
      'word-after-space': 'width=device-width, user-scalable none',
      'odd': 'width=device-width, maximum-scale=infinity',
      'scalable-yes': 'width=device-width, initial-scale=1, user-scalable=yes',
      'scalable-width': 'width=device-width, user-scalable=device-width',
      'scalable-1': 'width=device-width, user-scalable=1',
      'max-5': 'width=device-width, maximum-scale=5',
      'max-width': 'width=device-width, maximum-scale=device-width',
      plain: 'width=device-width, initial-scale=1',
      none: null,
      'axe-no': 'width=device-width, user-scalable=no',
      'axe-max-1': 'width=device-width, maximum-scale=1',
    });
  }, 240_000);

  it('fails user-scalable=false, maximum-scale=none and a user-scalable whose value the parser passes over', () => {
    expect(runs['scalable-false']!.findings, JSON.stringify(runs['scalable-false']!.findings)).toEqual([expect.objectContaining({
      criterion: '1.4.4', status: 'failed', target: 'meta[name="viewport"]', detail: 'The page turns zoom off on phones: its viewport setting has user-scalable=false, which the browser reads as “no”',
    })]);
    expect(runs['max-none']!.findings, JSON.stringify(runs['max-none']!.findings)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('maximum-scale=none, which the browser reads as 0.1, below the 2 that 200% zoom needs') })]);
    expect(runs['word-after-space']!.findings, JSON.stringify(runs['word-after-space']!.findings)).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('user-scalable=(no value), which the browser reads as “no”') })]);
  });

  it('does not fail "maximum-scale=5;user-scalable=false": the browser reads maximum-scale 5 and never turns zoom off', () => {
    expect(runs['semicolon']!.findings, JSON.stringify(runs['semicolon']!.findings)).toEqual([]);
    expect(runs['semicolon']!.status).toBe('ok');
  });

  it('leaves a setting it cannot be sure of undecided: never failed, never clean', () => {
    expect(runs['odd']!.findings, JSON.stringify(runs['odd']!.findings)).toEqual([expect.objectContaining({ criterion: '1.4.4', status: 'not_testable', detail: expect.stringContaining('Whether the page lets a phone zoom to 200% could not be told') })]);
  });

  it('look-alikes: words and numbers that allow zoom, no setting, and the values the axe rule already fails add nothing here', () => {
    for (const name of ['scalable-yes', 'scalable-width', 'scalable-1', 'max-5', 'max-width', 'plain', 'none', 'axe-no', 'axe-max-1', 'semicolon-no']) {
      expect(runs[name]!.findings.filter((f) => f.status === 'failed' || f.status === 'not_testable'), `${name}: ${JSON.stringify(runs[name]!.findings)}`).toEqual([]);
    }
  });
});
