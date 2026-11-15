// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A criterion a test passed on one page and could not test on the others (4.1.3 with --full: only
// /contact has a form) rolls up to "no failures found", and the tested page is in the evidence.
import { describe, expect, it } from 'vitest';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import type { ProbeRun } from '../../src/types.js';

const U = (p: string) => `https://e.org${p}`;
const forms = (page: string, status: 'no_failures_found' | 'not_testable' | 'failed', detail: string, extra: Record<string, unknown> = {}): ProbeRun => ({
  probe: 'forms', kind: 'interaction', page: U(page), criteria: ['4.1.3'], status: 'ok', ms: 1,
  findings: [{ criterion: '4.1.3', status, detail, ...(detail === NO_FORM ? { nothingToTest: true } : {}), ...extra }],
});
const NO_FORM = 'status messages are tested through the messages of a form, and this page has no form fields';

describe('the roll-up of one test over pages', () => {
  it('tested and passed on one page beats "could not be tested" on the others', () => {
    const [r] = probeCriteriaResults([forms('/', 'not_testable', NO_FORM), forms('/contact', 'no_failures_found', 'error messages checked'), forms('/news', 'not_testable', NO_FORM)]);
    expect(r!.method.status).toBe('no_failures_found');
    expect(r!.method.note).toBe(`no failures found on the 1 page tested (error messages checked); could not be tested automatically on 2 of 3 pages: ${NO_FORM}`);
    expect(r!.evidence).toContainEqual({ page: U('/contact'), detail: 'No failures found: error messages checked' });
  });
  it('a failure anywhere still fails; a page cut short by the time limit still reads "Partly tested"', () => {
    expect(probeCriteriaResults([forms('/', 'failed', 'x'), forms('/contact', 'no_failures_found', 'ok'), forms('/b', 'not_testable', NO_FORM)])[0]!.method.status).toBe('failed');
    const cut = probeCriteriaResults([forms('/', 'no_failures_found', 'ok'), forms('/b', 'not_testable', 'late', { timeLimit: true })])[0]!;
    expect(cut.method.status).toBe('not_testable');
    expect(cut.method.note).toMatch(/^Partly tested: 1 of 2 pages/);
  });
  it('content the scan\'s page cap left untested keeps it not testable', () => {
    const capped = probeCriteriaResults([forms('/', 'no_failures_found', 'ok'), forms('/b', 'not_testable', '2 more scanned pages were not opened', { limit: true })])[0]!;
    expect(capped.method.status).toBe('not_testable');
  });
  it('1 of 5 pages failing to load still gives the result of the other 4 (the copy says how many it ran on)', () => {
    const LOAD = 'the page did not load for this test: HTTP 406';
    const na = (page: string): ProbeRun => ({ probe: 'media-players', kind: 'interaction', page: U(page), criteria: ['1.2.2'], status: 'ok', ms: 1, findings: [{ criterion: '1.2.2', status: 'not_applicable', detail: 'no video on this page' }] });
    const down = (page: string): ProbeRun => ({ probe: 'media-players', kind: 'interaction', page: U(page), criteria: ['1.2.2'], status: 'error', ms: 1, findings: [{ criterion: '1.2.2', status: 'not_testable', detail: LOAD, loadFailure: 'not-loaded' }] });
    const n = probeCriteriaResults([na('/'), down('/athletics'), na('/events'), na('/minutes'), na('/budget')])[0]!;
    expect(n.method.status).toBe('not_applicable');
    expect(n.method.note).toBe(`nothing to test on the 4 pages tested (no video on this page); could not be tested automatically on 1 of 5 pages: ${LOAD}`);
    // Pages that ran with no failure: "no failures found on the N pages tested", the untested page listed.
    const clean = probeCriteriaResults([forms('/', 'no_failures_found', 'ok'), { ...forms('/b', 'not_testable', LOAD, { loadFailure: 'not-loaded' }), status: 'error' }, forms('/c', 'no_failures_found', 'ok'), forms('/d', 'no_failures_found', 'ok'), forms('/e', 'no_failures_found', 'ok')])[0]!;
    expect(clean.method.status).toBe('no_failures_found');
    expect(clean.method.note).toBe(`no failures found on the 4 pages tested (ok); could not be tested automatically on 1 of 5 pages: ${LOAD}`);
    expect(clean.evidence[0]).toEqual({ page: U('/b'), detail: LOAD });
    // The same page timing out or breaking is not "could not run": the test may have found what it could
    // not judge there, so the criterion stays not testable.
    expect(probeCriteriaResults([forms('/', 'no_failures_found', 'ok'), { ...forms('/b', 'not_testable', 'timed out after 45 s'), status: 'timeout' }])[0]!.method.status).toBe('not_testable');
    // Nothing to test on 4 pages, but on the 5th the test ran and could not judge what it found
    // (server-only error messages): the criterion applies there, so it stays not testable.
    const blind = (page: string): ProbeRun => ({ ...na(page), findings: [{ criterion: '1.2.2', status: 'not_testable', detail: 'the player could not be read' }] });
    expect(probeCriteriaResults([na('/'), blind('/athletics'), na('/events'), na('/minutes'), na('/budget')])[0]!.method.status).toBe('not_testable');
    // Passed on one page, but on another the test ran and could not judge what it found: not testable
    // (a clean page beside one that could not be judged is no pass).
    const pass = (page: string): ProbeRun => ({ ...na(page), findings: [{ criterion: '1.2.2', status: 'no_failures_found', detail: 'captions checked' }] });
    expect(probeCriteriaResults([pass('/'), blind('/athletics')])[0]!.method.status).toBe('not_testable');
    // A test that started and lost the browser did not judge that page: not testable (round 2 review #4).
    // Only a load that never started (not loaded, a challenge) is set aside.
    const lost = (page: string): ProbeRun => ({ ...na(page), status: 'error', findings: [{ criterion: '1.2.2', status: 'not_testable', detail: 'the browser closed while this test ran and it could not be run again', loadFailure: 'browser-lost' }] });
    expect(probeCriteriaResults([pass('/'), lost('/team')])[0]!.method.status).toBe('not_testable');
    const challenged = (page: string): ProbeRun => ({ ...lost(page), findings: [{ criterion: '1.2.2', status: 'not_testable', detail: 'the site answered with a bot challenge (HTTP 202) instead of the page', loadFailure: 'challenge' }] });
    expect(probeCriteriaResults([pass('/'), challenged('/team')])[0]!.method.status).toBe('no_failures_found');
    // A failure on a page that ran is failed, whatever the page that could not run.
    expect(probeCriteriaResults([forms('/', 'failed', 'x'), { ...forms('/b', 'not_testable', LOAD), status: 'error' }])[0]!.method.status).toBe('failed');
  });
  it('untested everywhere stays not testable', () => {
    expect(probeCriteriaResults([forms('/', 'not_testable', NO_FORM), forms('/b', 'not_testable', NO_FORM)])[0]!.method.status).toBe('not_testable');
  });
});
