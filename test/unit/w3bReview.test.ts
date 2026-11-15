// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// W3b review r1 (Grok): what the report does with a core test that met a bot challenge (r1-1), and
// that the listed-only tests (link-purpose, aria-states) never change the score, the grade, the
// projection or the conformance level (r1-T1).
import { describe, expect, it } from 'vitest';
import { CHALLENGE_PAGE } from '../../src/challenge.js';
import { buildReport } from '../../src/report/build.js';
import type { PageAudit, ProbeFinding, ProbeRun } from '../../src/types.js';

const urls = ['https://e.org/', 'https://e.org/a', 'https://e.org/b', 'https://e.org/c'];
const page = (url: string): PageAudit => ({ url, status: 'ok', rules: { 'color-contrast': 'pass' }, violations: [], incomplete: [], links: [] });
const run = (probe: string, url: string, criteria: string[], findings: ProbeFinding[], extra: Partial<ProbeRun> = {}): ProbeRun =>
  ({ probe, kind: 'render', page: url, criteria, status: 'ok', findings, ms: 5, ...extra });
const base = { site: 'https://e.org/', pages: urls.map(page), documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-03T00:00:00Z', userAgent: 'ua' };
const challenge = (url: string) => run('headings', url, ['1.3.1', '2.4.6'], [
  { criterion: '1.3.1', status: 'not_testable', detail: `the page did not load for this test: ${CHALLENGE_PAGE}`, loadFailure: 'challenge' },
  { criterion: '2.4.6', status: 'not_testable', detail: `the page did not load for this test: ${CHALLENGE_PAGE}`, loadFailure: 'challenge' },
], { status: 'error' });

describe('r1-1: a page whose core test load got a bot challenge did not load', () => {
  it('counts as not loaded with the challenge reason, so its axe results leave the score and the enough-pages rule applies', () => {
    const one = buildReport({ ...base, probeRuns: [run('headings', urls[0]!, ['1.3.1', '2.4.6'], []), challenge(urls[1]!)] });
    expect(one.pages.find((p) => p.url === urls[1])).toMatchObject({ status: 'failed', reason: CHALLENGE_PAGE });
    expect(one.pages.filter((p) => p.status === 'ok')).toHaveLength(3);
    // Every page challenged: no score, never 100.
    const all = buildReport({ ...base, probeRuns: urls.map(challenge) });
    expect(all.status).not.toBe('scored');
    expect(all.score).toBeNull();
  });
});
