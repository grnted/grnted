// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// r1-8b (W6, docs/monitoring.md): on a monitoring scan, the every-page core tests (headings, text
// contrast) never open a page whose audit was carried forward: that page keeps the runs of the scan that
// checked it. The template sample is unchanged (it runs every probe on its pages, carried or not).
import { describe, expect, it } from 'vitest';
import { templateProbes } from '../../src/probes/sample.js';
import type { ProbeRunner } from '../../src/probes/runner.js';
import type { PageAudit, ProbeRun } from '../../src/types.js';

const probes = [
  { id: 'keyboard', tier: 'core', criteria: ['2.1.1'] },
  { id: 'headings', tier: 'core', everyPage: true, criteria: ['1.3.1'] },
] as unknown as ProbeRunner['probes'];

function fakeRunner() {
  const added: { url: string; only?: readonly string[] }[] = [];
  const runner: ProbeRunner = {
    probes,
    add: (t, only) => { added.push({ url: t.url, ...(only ? { only } : {}) }); },
    lend: () => {},
    // Like the real runner: each probe once per address; runs in page order, then registry order.
    finish: async () => {
      const order = [...new Set(added.map((a) => a.url))];
      const seen = new Set<string>();
      return added.flatMap((a) => (a.only ?? probes.map((p) => p.id)).map((probe) => ({ probe, url: a.url })))
        .filter((x) => !seen.has(`${x.url} ${x.probe}`) && seen.add(`${x.url} ${x.probe}`))
        .sort((x, y) => order.indexOf(x.url) - order.indexOf(y.url) || probes.findIndex((p) => p.id === x.probe) - probes.findIndex((p) => p.id === y.probe))
        .map(({ probe, url }): ProbeRun => ({ probe, kind: 'render', page: url, criteria: ['1.3.1'], status: 'ok', findings: [{ criterion: '1.3.1', status: 'no_failures_found', detail: 'fresh' }], ms: 1 }));
    },
    counts: () => ({ queued: added.length, done: 0 }),
    tests: () => ({ queued: 0, done: 0 }),
    unfinished: () => [],
    partial: (f: readonly unknown[]) => [...f] as never,
  };
  return { runner, added };
}

const page = (url: string, shape: string, extra: Partial<PageAudit> = {}): PageAudit => ({ url, status: 'ok', rules: {}, violations: [], incomplete: [], links: [], collected: { shape }, ...extra });
const carriedRun = (url: string): ProbeRun => ({ probe: 'headings', kind: 'render', page: url, criteria: ['1.3.1'], status: 'ok', findings: [{ criterion: '1.3.1', status: 'failed', detail: 'carried' }], ms: 1 });

describe('r1-8b: every-page probes on carried pages', () => {
  it('r1-8b: a carried page gets no probe navigation; its previous every-page runs are reported in page order', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner);
    t.pageAudited(page('https://e.org/', 'home'), 0);
    t.pageAudited(page('https://e.org/a', 'home', { unchangedSince: '2026-10-01T00:00:00.000Z', probeRuns: [carriedRun('https://e.org/a')] }), 1);
    t.pageAudited(page('https://e.org/b', 'home'), 2);
    const runs = await t.finish();
    expect(added.map((a) => a.url)).not.toContain('https://e.org/a');
    expect(runs.map((r) => [r.page, r.probe, r.findings[0]!.detail])).toEqual([
      ['https://e.org/', 'keyboard', 'fresh'], ['https://e.org/', 'headings', 'fresh'],
      ['https://e.org/a', 'headings', 'carried'],
      ['https://e.org/b', 'headings', 'fresh'],
    ]);
  });

  it('a carried page without kept runs is tested as usual; a carried page in the template sample runs every probe', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner);
    t.pageAudited(page('https://e.org/', 'home'), 0);
    t.pageAudited(page('https://e.org/a', 'home', { unchangedSince: '2026-10-01T00:00:00.000Z' }), 1);
    t.pageAudited(page('https://e.org/news/x', 'news', { unchangedSince: '2026-10-01T00:00:00.000Z', probeRuns: [carriedRun('https://e.org/news/x')] }), 2);
    const runs = await t.finish();
    expect([...new Set(added.filter((a) => a.url === 'https://e.org/a').map((a) => JSON.stringify(a.only)))]).toEqual(['["headings"]']);
    expect(added.some((a) => a.url === 'https://e.org/news/x' && !a.only)).toBe(true);
    expect(runs.filter((r) => r.page === 'https://e.org/news/x' && r.probe === 'headings').map((r) => r.findings[0]!.detail)).toEqual(['fresh']);
  });
});
