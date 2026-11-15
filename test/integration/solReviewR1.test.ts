// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane: the variants and look-alikes Sol wrote in its review round 1 ("break it"), run end to end in
// Chromium (test/fixtures/b18-sol-r1/). Failure variants the lane catches must fail; look-alikes must not. All twenty
// are run.
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { linkColorProbe } from '../../src/probes/linkColor.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { stateTextProbe } from '../../src/probes/stateText.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { PageProbe } from '../../src/probes/types.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
let axeSource: string;
beforeAll(async () => { browser = await chromium.launch(); axeSource = await defaultAxeSource(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const PROBES: Record<string, PageProbe[]> = {
  '1.4.3': [textContrastProbe, stateTextProbe], '1.4.11': [nonTextContrastProbe, keyboardProbe], '1.4.1': [linkColorProbe],
  '2.4.7': [keyboardProbe], '1.4.10': [reflowProbe], '1.4.12': [textSpacingProbe],
};
async function verdict(id: string, criterion: string): Promise<{ failed: boolean; findings: ProbeFinding[] }> {
  const html = readFileSync(new URL(`../fixtures/b18-sol-r1/${id}.html`, import.meta.url), 'utf8');
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], PROBES[criterion]!, { userAgent: 'grnted-test', full: true, axeSource });
    const findings = runs.flatMap((r) => r.findings).filter((f) => f.criterion === criterion);
    return { failed: findings.some((f) => f.status === 'failed'), findings };
  } finally {
    await sim.close();
  }
}

describe('Sol review round 1: variants', () => {
  it.each([['F1', '1.4.3'], ['F2', '1.4.3'], ['F3', '1.4.11'], ['F4', '1.4.11'], ['F5', '1.4.11'], ['F6', '1.4.11'], ['F7', '1.4.3'], ['F8', '1.4.1'], ['F9', '1.4.1'], ['F10', '1.4.12']])('%s fails %s', async (id, c) => {
    const v = await verdict(id, c);
    expect(v.failed, JSON.stringify(v.findings)).toBe(true);
  }, 90_000);
});

describe('Sol review round 1: look-alikes', () => {
  it.each([['L1', '1.4.11'], ['L2', '1.4.11'], ['L3', '1.4.1'], ['L4', '1.4.3'], ['L5', '1.4.11'], ['L6', '1.4.11'], ['L7', '1.4.12'], ['L8', '1.4.10'], ['L9', '1.4.3'], ['L10', '2.4.7']])('%s does not fail %s', async (id, c) => {
    const v = await verdict(id, c);
    expect(v.failed, JSON.stringify(v.findings.filter((f) => f.status === 'failed'))).toBe(false);
  }, 90_000);
});
