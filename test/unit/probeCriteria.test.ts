// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { PROBE_EVIDENCE_CAP, compareCriteria, probeCriteriaResults, worstStatus } from '../../src/probes/criteria.js';
import type { ProbeFinding, ProbeRun } from '../../src/types.js';

const run = (probe: string, page: string, criteria: string[], findings: ProbeFinding[], extra: Partial<ProbeRun> = {}): ProbeRun =>
  ({ probe, kind: 'interaction', page: `https://e.org${page}`, criteria, status: 'ok', findings, ms: 10, ...extra });

describe('probe results by criterion', () => {
  it('orders statuses worst first and criteria by number', () => {
    expect(worstStatus(['no_failures_found', 'not_applicable'])).toBe('no_failures_found');
    expect(worstStatus(['no_failures_found', 'not_testable'])).toBe('not_testable');
    expect(worstStatus(['not_testable', 'flagged'])).toBe('flagged');
    expect(worstStatus(['flagged', 'failed', 'not_applicable'])).toBe('failed');
    expect(worstStatus([])).toBe('not_applicable');
    expect(['1.4.10', '2.1.1', '1.4.4', '1.3.1', '2.4.11', '2.4.3'].sort(compareCriteria)).toEqual(['1.3.1', '1.4.4', '1.4.10', '2.1.1', '2.4.3', '2.4.11']);
  });

  it('aggregates per criterion and probe: worst over pages, page count, notes and evidence', () => {
    const runs = [
      run('keyboard', '/', ['2.1.1', '2.1.2'], [
        { criterion: '2.1.1', status: 'failed', target: '#menu', detail: 'Clickable but not reachable with Tab' },
        { criterion: '2.1.1', status: 'no_failures_found', detail: '40 stops' },
      ]),
      run('reflow', '/', ['1.4.10'], [], { kind: 'render' }),
      run('keyboard', '/about', ['2.1.1', '2.1.2'], [], { status: 'timeout', findings: [
        { criterion: '2.1.1', status: 'not_testable', detail: 'timed out after 8 s' },
        { criterion: '2.1.2', status: 'not_testable', detail: 'timed out after 8 s' },
      ] }),
      run('reflow', '/about', ['1.4.10'], [{ criterion: '1.4.10', status: 'not_applicable', detail: 'nothing to test' }], { kind: 'render' }),
      run('keyboard', '/news/1', ['2.1.1', '2.1.2'], [{ criterion: '2.1.2', status: 'not_applicable', detail: 'no focusable elements' }]),
      run('reflow', '/news/1', ['1.4.10'], [], { kind: 'render' }),
    ];
    expect(probeCriteriaResults(runs)).toEqual([
      {
        criterion: '1.4.10',
        method: { id: 'reflow', kind: 'render', status: 'no_failures_found', pages: 3 },
        evidence: [],
      },
      {
        criterion: '2.1.1',
        method: { id: 'keyboard', kind: 'interaction', status: 'failed', pages: 3, note: 'could not be tested automatically on 1 of 3 pages: timed out after 8 s' },
        evidence: [
          { page: 'https://e.org/', target: '#menu', detail: 'Clickable but not reachable with Tab' },
          { page: 'https://e.org/about', detail: 'timed out after 8 s' },
        ],
      },
      {
        criterion: '2.1.2',
        // Tested and passed on /, but /about timed out (the test may have met what it could not judge
        // there): not testable, with the reason (round 1 review).
        method: { id: 'keyboard', kind: 'interaction', status: 'not_testable', pages: 3, note: 'timed out after 8 s (1 of 3 pages)' },
        evidence: [{ page: 'https://e.org/about', detail: 'timed out after 8 s' }],
      },
    ]);
  });

  it('gives not_applicable only when every page was not applicable, with the reasons', () => {
    const runs = [
      run('forms', '/', ['3.3.1'], [{ criterion: '3.3.1', status: 'not_applicable', detail: 'no forms on the page' }]),
      run('forms', '/about', ['3.3.1'], [{ criterion: '3.3.1', status: 'not_applicable', detail: 'no forms on the page' }]),
    ];
    expect(probeCriteriaResults(runs)[0]!.method).toEqual({ id: 'forms', kind: 'interaction', status: 'not_applicable', pages: 2, note: 'no forms on the page' });
  });

  it('keeps one entry per probe for a shared criterion, in the order the probes first appear', () => {
    const runs = [
      run('b', '/', ['2.4.7'], [{ criterion: '2.4.7', status: 'flagged', detail: 'x' }], { kind: 'pixels' }),
      run('a', '/', ['2.4.7'], []),
    ];
    expect(probeCriteriaResults(runs).map((r) => [r.criterion, r.method.id, r.method.kind, r.method.status])).toEqual([
      ['2.4.7', 'b', 'pixels', 'flagged'],
      ['2.4.7', 'a', 'interaction', 'no_failures_found'],
    ]);
  });

  it('caps evidence, failures first', () => {
    const findings: ProbeFinding[] = [
      ...Array.from({ length: 15 }, (_, i) => ({ criterion: '2.1.1', status: 'not_testable' as const, detail: `n${i}` })),
      ...Array.from({ length: 30 }, (_, i) => ({ criterion: '2.1.1', status: 'failed' as const, detail: `f${i}` })),
    ];
    const [r] = probeCriteriaResults([run('k', '/', ['2.1.1'], findings)]);
    expect(r!.evidence).toHaveLength(PROBE_EVIDENCE_CAP);
    expect(r!.evidence.every((e) => e.detail.startsWith('f'))).toBe(true);
    expect(r!.evidence[0]!.detail).toBe('f0');
  });

  it('does not depend on anything but the order of the runs', () => {
    const runs = [run('k', '/', ['2.1.1'], []), run('k', '/a', ['2.1.1'], [{ criterion: '2.1.1', status: 'failed', detail: 'x' }])];
    expect(probeCriteriaResults(runs)).toEqual(probeCriteriaResults(structuredClone(runs)));
    expect(probeCriteriaResults([])).toEqual([]);
  });
});
