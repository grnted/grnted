// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Task 4.4 probes are registered once, in the right tier, and the criteria table declares them.
import { describe, expect, it } from 'vitest';
import { PROBES } from '../../src/probes/registry.js';
import { groupProbes } from '../../src/probes/runner.js';
import { buildReport } from '../../src/report/build.js';
import { CRITERIA } from '../../src/report/criteria.js';

const TASK_44: Record<string, { criteria: string[]; tier: 'core' | 'deep'; declared: boolean }> = {
  timing: { criteria: ['2.2.1'], tier: 'core', declared: true },
  audio: { criteria: ['1.4.2'], tier: 'core', declared: true },
  motion: { criteria: ['2.2.2'], tier: 'core', declared: true },
  'motion-actuation': { criteria: ['2.5.4'], tier: 'core', declared: true },
  flash: { criteria: ['2.3.1'], tier: 'deep', declared: true },
  // Not declared: a core scan would otherwise show 2.2.1 as not tested (see src/report/criteria.ts).
  'timing-watch': { criteria: ['2.2.1'], tier: 'deep', declared: false },
};

describe('Task 4.4 probes in the registry and the criteria table', () => {
  it('registers each probe once with its criteria and tier', () => {
    const ids = PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [id, want] of Object.entries(TASK_44)) {
      const p = PROBES.find((x) => x.id === id);
      expect(p, id).toBeDefined();
      expect(p).toMatchObject({ criteria: want.criteria, tier: want.tier });
    }
  });

  it('declares probe:<id> in each criterion row it reports on', () => {
    for (const [id, want] of Object.entries(TASK_44)) {
      for (const criterion of want.criteria) {
        const row = CRITERIA.find((c) => c.criterion === criterion)!;
        expect(row.methods.includes(`probe:${id}`), `${criterion} ${id}`).toBe(want.declared);
      }
    }
  });

  it('runs the four core probes on one shared page, timing last (it runs every timer early); deep ones on their own', () => {
    const groups = groupProbes(PROBES.filter((p) => TASK_44[p.id]));
    const shared = groups.find((g) => g.probes.length > 1)!;
    expect(shared.probes.map((p) => p.id)).toEqual(['audio', 'motion', 'motion-actuation', 'timing']);
    expect(shared.contextOptions.reducedMotion).toBe('no-preference');
    for (const id of ['flash', 'timing-watch']) expect(groups.find((g) => g.probes.length === 1 && g.probes[0]!.id === id), id).toBeDefined();
  });
});

describe('a clean core 2.2.1 result says what the core test does not watch', () => {
  it('adds the timing probe\'s note to its method when it found no failures, not when it failed', () => {
    const report = (status: 'no_failures_found' | 'failed') => buildReport({
      site: 'https://e.org/', pages: [{ url: 'https://e.org/', status: 'ok', rules: {}, violations: [], incomplete: [], links: [] }], documents: [], media: [], skipped: [],
      startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA',
      criteriaExtra: [{ criterion: '2.2.1', method: { id: 'timing', kind: 'interaction', status, pages: 1 }, evidence: [] }],
    });
    const method = (status: 'no_failures_found' | 'failed') => report(status).criteria!.find((c) => c.criterion === '2.2.1')!.methods.find((m) => m.id === 'timing')!;
    expect(method('no_failures_found').note).toMatch(/does not watch timers under 1 s, animation frames or workers \(a deep test watches them for 20 s\)/);
    expect(method('failed').note).toBeUndefined();
  });
});
