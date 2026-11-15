// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The live view's progress after the pages (audit 2026-11-04, the live scan page): staging scans sent the
// same "Running the automated tests: N%" line hundreds of times (389 of 410 stage events on one 25-page
// scan, out/scan-page/audit.md), so the stage progress cap ran out before the AI review said anything.
// A stage's progress goes out only when it changes, and the tests and AI stages carry real counts of
// whole checks (`units`).
import { describe, expect, it } from 'vitest';
import type { PageProbe } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { AiProgress, AiScanPlan, ScanEvent } from '../../src/types.js';
import { fakeProbeBrowser } from '../helpers/probes.js';

const PATHS = Array.from({ length: 12 }, (_, i) => (i ? `/p${i}` : '/'));
const LINKS = PATHS.filter((p) => p !== '/').map((p) => `https://e.org${p}`);
const notFound = (async () => new Response('', { status: 404 })) as typeof fetch;
const site = () => fakeProbeBrowser({
  delayFor: () => 1,
  evaluate: (name, path) => {
    if (name === '' || name === 'collectLinks') return path === '/' ? LINKS : [];
    if (name === 'pageShape') return `header:1 main:1 h2-6:${PATHS.indexOf(path) + 1}`;
    return undefined;
  },
});
const probe = (id: string, ms: number): PageProbe => ({
  id, criteria: ['1.4.12'], kind: 'render', tier: 'core', timeoutMs: 2000,
  run: async () => { await new Promise((r) => setTimeout(r, ms)); return [{ criterion: '1.4.12', status: 'no_failures_found', detail: 'ok' }]; },
});
const ai: AiScanPlan = {
  collectors: [], onPageAudited: () => {},
  async finish(ctx) {
    const tell = (p: AiProgress) => ctx.onProgress?.(p);
    tell({ checksDone: 0, checks: 3, check: 'Alt text', reviewed: 1, sample: 2 });
    tell({ checksDone: 0, checks: 3, check: 'Alt text', reviewed: 1, sample: 2 });
    tell({ checksDone: 1, checks: 3, check: 'Alt text' });
    tell({ checksDone: 2, checks: 3, check: 'Page text' });
    tell({ checksDone: 3, checks: 3, check: 'Vision' });
    return { runs: [], disclaimer: '' };
  },
};

type Stage = Extract<ScanEvent, { type: 'stage' }>;
async function scan() {
  const events: ScanEvent[] = [];
  await scanSite('https://e.org/', { browser: site().browser, fetchFn: notFound, axeSource: '', concurrency: 3, probes: [probe('a', 30), probe('b', 60)], ai, onEvent: (e) => events.push(e) });
  return events.filter((e): e is Stage => e.type === 'stage');
}

describe('stage progress', () => {
  it('goes out only when it changes', async () => {
    const stages = await scan();
    for (const name of ['tests', 'ai'] as const) {
      const p = stages.filter((e) => e.stage === name && e.step === 'progress').map((e) => JSON.stringify([e.detail, e.done, e.total, e.units, e.now]));
      expect(p.length, name).toBeGreaterThan(0);
      expect(p.filter((x, i) => x === p[i - 1]), name).toEqual([]);
    }
  });

  it('the tests stage counts whole tests: those finished on every page they were given, of the tests in the scan', async () => {
    const tests = (await scan()).filter((e) => e.stage === 'tests');
    for (const e of tests) {
      expect(e.units, e.step).toBeDefined();
      expect(e.units!.total).toBe(2);
      expect(e.units!.done).toBeLessThanOrEqual(2);
    }
    expect(tests.at(-1)!.units).toEqual({ done: 2, total: 2 });
  });

  it('the AI stage counts the review\'s checks', async () => {
    const ai = (await scan()).filter((e) => e.stage === 'ai' && e.step !== 'start');
    expect(ai.map((e) => e.units)).toEqual([{ done: 0, total: 3 }, { done: 1, total: 3 }, { done: 2, total: 3 }, { done: 3, total: 3 }, { done: 3, total: 3 }]);
  });

  // The "Now" line (Paul, 2026-11-05): the test that just started and its page; the AI check by its title.
  it('names what just started: the test and its page, the AI check; never a count of runs or a sample', async () => {
    const stages = await scan();
    const now = stages.filter((e) => e.stage === 'tests' && e.now).map((e) => e.now!);
    expect(now.length).toBeGreaterThan(0);
    for (const n of now) {
      expect(['a', 'b']).toContain(n.check);
      expect(n.page).toBeGreaterThanOrEqual(0);
      expect(Object.keys(n).sort()).toEqual(['check', 'page']);
    }
    expect(stages.filter((e) => e.stage === 'ai' && e.now).map((e) => e.now!.check)).toEqual(['Alt text', 'Alt text', 'Page text', 'Vision']);
  });
});
