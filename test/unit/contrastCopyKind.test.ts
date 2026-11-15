// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness: every 1.4.3 failure of Granted's own tests was titled "Text over images or patterned
// backgrounds is hard to read" with the fix "Put a solid or darkened backing behind the text", whatever the test found.
// A header link that turns dark on a dark band when the pointer is on it sent a developer looking for hero images. The
// title and the fix now follow the kind of evidence (the finding's `data.kind`): text over a picture or pattern, a hover
// or focus state, placeholder text, text the page shows later or in an opened menu, the dark colour scheme, or plain
// text in its own colours; several kinds (or a report from before kinds) get the general copy.
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { buildProblems } from '../../src/report/problems.js';
import type { PageAudit, ProbeFinding, ProbeRun } from '../../src/types.js';

const U = (p: string) => `https://e.org${p}`;
const P = ['/', '/a', '/b'];
const clean = (p: string): PageAudit => ({ url: U(p), status: 'ok', rules: { 'image-alt': 'pass' }, violations: [], incomplete: [], links: [] });
const base = { site: U('/'), documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-04T00:00:00Z', userAgent: 'ua' };
const run = (page: string, findings: ProbeFinding[], probe = 'text-contrast'): ProbeRun => ({ probe, kind: 'render', page: U(page), criteria: ['1.4.3'], status: 'ok', ms: 1, findings });
const fail = (kind?: string, detail = 'Text contrast is 1.1:1'): ProbeFinding => ({ criterion: '1.4.3', status: 'failed', target: 'a', detail, ...(kind ? { data: { kind } } : {}) });
const contrast = (runs: ProbeRun[]) => {
  const report = buildReport({ ...base, pages: P.map(clean), probeRuns: runs });
  return buildProblems(report).find((p) => p.criteria.some((c) => c.criterion === '1.4.3'))!;
};

describe('1.4.3: the title and the fix follow the kind of evidence', () => {
  it('a hover or focus state: names the state and the :hover / :focus styles, never a backing behind the text', () => {
    const p = contrast(P.map((x) => run(x, [fail('state', 'Text contrast drops to 1.1:1 when the pointer is on it')])));
    expect(p.copy.title).toBe('Text is hard to read when the pointer is on it or it has keyboard focus');
    expect(p.copy.fix).toMatch(/:hover/);
    expect(p.copy.fix).not.toMatch(/backing/);
  });
  it('text over a picture, a gradient or overlapping content: the backing advice', () => {
    const p = contrast(P.map((x) => run(x, [fail('backdrop')])));
    expect(p.copy.title).toBe('Text over images or patterned backgrounds is hard to read');
    expect(p.copy.fix).toMatch(/backing/);
  });
  it('placeholder text', () => {
    const p = contrast(P.map((x) => run(x, [fail('placeholder')])));
    expect(p.copy.title).toBe('Placeholder text in form fields is too faint');
    expect(p.copy.fix).toMatch(/::placeholder/);
  });
  it('text shown later or in an opened menu or panel', () => {
    const p = contrast(P.map((x) => run(x, [fail('shown')])));
    expect(p.copy.title).toBe('Text in menus, panels and messages that open later is hard to read');
  });
  it('the dark colour scheme', () => {
    const p = contrast(P.map((x) => run(x, [fail('dark')])));
    expect(p.copy.title).toBe('Text is hard to read in dark mode');
    expect(p.copy.fix).toMatch(/prefers-color-scheme: dark/);
  });
  it('plain text in its own colours', () => {
    const p = contrast(P.map((x) => run(x, [fail('plain')])));
    expect(p.copy.title).toBe('Some text is too faint to read');
  });
  it('several kinds, or failures without a kind (a report from before kinds): the general copy, no single cause', () => {
    for (const runs of [[run('/', [fail('state')]), run('/a', [fail('backdrop')])], P.map((x) => run(x, [fail()]))]) {
      const p = contrast(runs);
      expect(p.copy.title).toBe('Some text is hard to read against what is behind it');
      expect(p.copy.fix).toMatch(/4\.5 to 1/);
      expect(p.copy.fix).toMatch(/pointer|focus/);
    }
  });
});
