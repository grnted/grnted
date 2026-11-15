// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Shared components (red-team 2026-11-10, coverage lane; src/probes/components.ts). A failure a slow test
// measured on an element decides **where that kind of element is measured next** (`componentChecks`); it is
// never a result for another page (review r1: a pattern may trigger a check, never stand in for one). So
// these are routing rules: which page is sent what. What is then reported comes from the page itself
// (test/integration/sharedComponents.test.ts, in a real browser).
import { describe, expect, it } from 'vitest';
import type { PageKinds } from '../../src/collect/kinds.js';
import { CHECKS, CHECK_LIMITS, componentChecks, findingKey, noveltyPlanner, SITE_SEND_PAGES, SITE_SENDS, type KindPage } from '../../src/probes/components.js';
import { METHOD_CHECKED, METHOD_FULL, probeCriteriaResults } from '../../src/probes/criteria.js';
import { probeChecksFrom } from '../../src/score.js';
import type { ProbeFinding, ProbeRun } from '../../src/types.js';

const E = 'https://e.org';
const kinds = (k: string[], env: string[] = ['c:site', 'j:site'], f: Partial<PageKinds['f']> = {}): PageKinds => ({ k, env, f: { focus: [], form: [], motion: [], fixed: [], ids: [], struct: [], orient: [], reorder: [], ...f } });
const page = (path: string, index: number, k: string[], env?: string[]): KindPage => ({ url: `${E}${path}`, index, kinds: kinds(k, env) });
const run = (path: string, findings: ProbeFinding[] = [], probe = 'keyboard', criteria = ['2.1.1', '2.4.7']): ProbeRun => ({ probe, kind: 'interaction', page: `${E}${path}`, criteria, status: 'ok', findings, ms: 5 });
const noFocus = (target = 'footer > a.top'): ProbeFinding => ({ criterion: '2.4.7', status: 'failed', target, detail: 'No visible focus indicator on "Back to top"' });
/** The runner's map: every failing `target` on every page is the kind named here. */
const kindOf = (map: Record<string, string>) => (key: string) => map[key.split('\n')[3]!];
const paths = (list: { url: string }[]) => list.map((c) => new URL(c.url).pathname);

// Six pages; five share a footer (kind F). The keyboard test ran on the first three.
const SITE = [page('/', 0, ['H', 'F']), page('/a', 1, ['A', 'F']), page('/b', 2, ['B', 'F']), page('/c', 3, ['C', 'F']), page('/d', 4, ['D', 'F']), page('/e', 5, ['E'])];
const F = kindOf({ 'footer > a.top': 'F' });

describe('componentChecks: where a measured failure is looked for again', () => {
  it('the pages that carry the kind and were not given the test are sent a check of that element, and no other page', () => {
    const runs = [run('/', [noFocus()]), run('/a', [noFocus()]), run('/b', [noFocus()])];
    const checks = componentChecks({ pages: SITE, runs, kindOf: F });
    expect(paths(checks)).toEqual(['/c', '/d']);
    expect(checks[0]).toEqual({ url: `${E}/c`, index: 3, elements: [{ kind: 'F', criteria: ['2.4.7'], from: `${E}/` }], tests: [], from: [`${E}/`, `${E}/a`, `${E}/b`] });
  });

  it('one measured failure is enough to send a check: the check measures, so nothing rides on how often it was seen', () => {
    const runs = [run('/', [noFocus()]), run('/a'), run('/b')];
    expect(paths(componentChecks({ pages: SITE, runs, kindOf: F }))).toEqual(['/c', '/d']);
  });

  it('look-alike: a page where the test decided the criterion keeps its own result, clean or failed, and gets no check', () => {
    const runs = [run('/', [noFocus()]), run('/a'), run('/b', [noFocus('#other')]), run('/c')];
    expect(paths(componentChecks({ pages: SITE, runs, kindOf: F }))).toEqual(['/d']);
  });

  it('a page where the test ran and could not judge the criterion gets the check, for that criterion only', () => {
    // Red-team train, 2026-11-10: the whole keyboard test went to a page (something new on it), a focus loop
    // cut its walk short, and the footer link that fails on every other page was never measured there.
    const blind: ProbeFinding = { criterion: '2.4.7', status: 'not_testable', detail: 'a focus loop kept the keyboard walk from the rest of the page' };
    const jumps: ProbeFinding = { criterion: '3.2.1', status: 'failed', target: 'footer > a.top', detail: 'Moving keyboard focus to it loads another page' };
    const three = ['2.1.1', '2.4.7', '3.2.1'];
    const runs = [run('/', [noFocus(), jumps], 'keyboard', three), run('/b', [blind], 'keyboard', three), { ...run('/c', [], 'keyboard', three), status: 'timeout' as const }];
    const checks = componentChecks({ pages: SITE, runs, kindOf: F });
    // /b: 3.2.1 was decided there (clean), 2.4.7 was not. /c: the test timed out, so nothing was decided.
    expect(checks.map((c) => [new URL(c.url).pathname, c.elements.map((e) => e.criteria.join())])).toEqual([
      ['/a', ['2.4.7,3.2.1']], ['/b', ['2.4.7']], ['/c', ['2.4.7,3.2.1']], ['/d', ['2.4.7,3.2.1']],
    ]);
    // Look-alike: a cheap test sent whole is never sent to a page it already ran on, decided or not.
    const nameless: ProbeFinding = { criterion: '4.1.2', status: 'failed', target: 'footer > a.top', detail: 'A link has no name' };
    const undecided: ProbeFinding = { criterion: '4.1.2', status: 'not_testable', detail: 'the tree could not be read' };
    const sr = [run('/', [nameless], 'screen-reader', ['4.1.2']), run('/b', [undecided], 'screen-reader', ['4.1.2'])];
    expect(componentChecks({ pages: SITE, runs: sr, kindOf: F }).filter((c) => c.tests.length).map((c) => new URL(c.url).pathname)).toEqual(['/a', '/c', '/d']);
  });

  it('look-alike: a page that does not carry the kind gets nothing, whatever stylesheets and scripts it shares', () => {
    const runs = [run('/', [noFocus()])];
    const checks = componentChecks({ pages: SITE, runs, kindOf: F });
    expect(paths(checks)).not.toContain('/e');
  });

  it('a page with a stylesheet or script of its own is checked like any other: its styles are measured, not guessed', () => {
    // (The first version read the environment to decide whether to report; a check needs no such rule.)
    const pages = [SITE[0]!, page('/c', 3, ['C', 'F'], ['c:site', 'j:site', 'c:landing']), page('/d', 4, ['D', 'F'], ['c:other'])];
    expect(paths(componentChecks({ pages, runs: [run('/', [noFocus()])], kindOf: F }))).toEqual(['/c', '/d']);
  });

  it('look-alike: a failing element whose kind the runner could not name sends nothing', () => {
    const runs = [run('/', [noFocus('Back to top (link)')]), run('/a', [noFocus('Back to top (link)')])];
    expect(componentChecks({ pages: SITE, runs, kindOf: () => undefined })).toEqual([]);
  });

  it('look-alike: a recommendation or a flagged finding sends nothing', () => {
    const advice: ProbeFinding = { criterion: '2.4.7', status: 'no_failures_found', advice: true, target: 'footer > a.top', detail: 'a recommendation' };
    const flagged: ProbeFinding = { criterion: '2.4.7', status: 'flagged', target: 'footer > a.top', detail: 'needs review' };
    expect(componentChecks({ pages: SITE, runs: [run('/', [advice, flagged])], kindOf: F })).toEqual([]);
  });

  it('look-alike: a failure that depends on what else the page offers sends nothing, and neither does a test with no check', () => {
    // Content that updates by itself (2.2.2): another page may put a working pause control beside the same
    // element. The same for sound, time limits, hover content, hidden focus, traps, forms and how content fits.
    const pages = SITE.map((p) => ({ ...p, kinds: { ...p.kinds, k: [...p.kinds.k, 'T'] } }));
    for (const criterion of ['2.2.2', '1.4.2', '2.2.1', '2.3.1', '1.4.13', '2.4.11', '2.1.2', '3.3.1', '3.3.2', '2.5.8', '1.4.10', '1.4.12', '1.4.4', '1.4.3', '2.4.3']) {
      const f: ProbeFinding = { criterion, status: 'failed', target: '#ticker', detail: 'fails' };
      expect(componentChecks({ pages, runs: [run('/', [f], 'keyboard', [criterion])], kindOf: kindOf({ '#ticker': 'T' }) }), criterion).toEqual([]);
    }
    const pale: ProbeFinding = { criterion: '1.4.11', status: 'failed', target: '#ticker', detail: 'pale' };
    expect(componentChecks({ pages, runs: [run('/', [pale], 'some-other-test', ['1.4.11'])], kindOf: kindOf({ '#ticker': 'T' }) })).toEqual([]);
    // (route-titles has no element criteria: it is sent by `SITE_SENDS`, below.)
    expect(Object.keys(CHECKS).sort()).toEqual(['controls', 'keyboard', 'keyboard-deep', 'route-titles', 'screen-reader']);
    // Single elements are measured only for what concerns the element by itself.
    expect([...new Set(Object.values(CHECKS).filter((c) => c.send === 'elements').flatMap((c) => c.criteria))].sort()).toEqual(['1.4.11', '2.1.1', '2.4.7', '3.2.1']);
  });

  it('the controls test is sent whole to the pages that carry a control it failed (keyboard-op lane): the press is measured on the page itself', () => {
    // "Save my choice" (kind S) answers the mouse only on /; the same control is on /c and /d.
    const pointerOnly: ProbeFinding = { criterion: '2.1.1', status: 'failed', target: '#save', detail: '“Save my choice” (#save) takes keyboard focus, but Enter and Space do nothing on it' };
    const pages = SITE.map((p) => (['/', '/a', '/c', '/d'].includes(new URL(p.url).pathname) ? { ...p, kinds: { ...p.kinds, k: [...p.kinds.k, 'S'] } } : p));
    const k = kindOf({ '#save': 'S' });
    const runs = [run('/', [pointerOnly], 'controls', ['2.1.1', '2.1.2', '2.4.3', '2.4.11', '4.1.3']), run('/a', [], 'controls', ['2.1.1'])];
    // /a had the test (clean there: it keeps that result); /b and /e do not carry the control.
    expect(componentChecks({ pages, runs, kindOf: k }).map((c) => [new URL(c.url).pathname, c.elements, c.tests])).toEqual([
      ['/c', [], ['controls']],
      ['/d', [], ['controls']],
    ]);
    // What a press opens is part of the control too: a focus loop in its dialog sends the test the same way.
    const trap: ProbeFinding = { criterion: '2.1.2', status: 'failed', target: '#save', detail: 'After “Save my choice” is pressed: Keyboard focus is trapped' };
    expect(componentChecks({ pages, runs: [run('/', [trap], 'controls', ['2.1.2'])], kindOf: k }).map((c) => c.tests)).toEqual([['controls'], ['controls'], ['controls']]);
    // Look-alike: an unannounced status message (it depends on the page's own live regions) sends nothing.
    const status: ProbeFinding = { criterion: '4.1.3', status: 'failed', target: '#save', detail: 'shows “Saved.” in no live region' };
    expect(componentChecks({ pages, runs: [run('/', [status], 'controls', ['4.1.3'])], kindOf: k })).toEqual([]);
  });

  it('a cheap test is sent whole; the keyboard test\'s two tiers count as one test', () => {
    const nameless: ProbeFinding = { criterion: '4.1.2', status: 'failed', target: '#launch', detail: 'A button has no name' };
    const pages = SITE.map((p) => ({ ...p, kinds: { ...p.kinds, k: [...p.kinds.k, 'L'] } }));
    const k = kindOf({ 'footer > a.top': 'F', '#launch': 'L' });
    const runs = [run('/', [nameless], 'screen-reader', ['4.1.2']), run('/a', [], 'screen-reader', ['4.1.2']), run('/', [noFocus()], 'keyboard-deep', ['2.4.7']), run('/b', [], 'keyboard')];
    const checks = componentChecks({ pages, runs, kindOf: k });
    // /a had the screen-reader test, /b the keyboard test: each is sent only what it was not given.
    expect(checks.map((c) => [new URL(c.url).pathname, c.elements.map((e) => e.kind), c.tests])).toEqual([
      ['/a', ['F'], []],
      ['/b', [], ['screen-reader']],
      ['/c', ['F'], ['screen-reader']],
      ['/d', ['F'], ['screen-reader']],
      ['/e', [], ['screen-reader']],
    ]);
  });

  it('at most a few kinds per page, the pages named are few, and the result is the same whatever order the pages came in', () => {
    const many = Array.from({ length: 30 }, (_, i) => `K${i}`);
    const pages = [page('/', 0, many), page('/x', 1, many)];
    const findings = many.map((k): ProbeFinding => ({ criterion: '2.4.7', status: 'failed', target: `#${k}`, detail: 'x' }));
    const k = (key: string) => key.split('\n')[3]!.slice(1);
    const checks = componentChecks({ pages, runs: [run('/', findings)], kindOf: k });
    expect(checks[0]!.elements).toHaveLength(CHECK_LIMITS.kindsPerPage);
    const runs = [run('/', [noFocus()]), run('/a', [noFocus()]), run('/b', [noFocus()])];
    const a = componentChecks({ pages: SITE, runs, kindOf: F });
    expect(componentChecks({ pages: [...SITE].reverse(), runs, kindOf: F })).toEqual(a);
    expect(a[0]!.from.length).toBeLessThanOrEqual(CHECK_LIMITS.named);
  });

  it('uses the key the runner writes', () => {
    expect(findingKey('p', 'keyboard', '2.4.7', 'footer > a')).toBe('p\nkeyboard\n2.4.7\nfooter > a');
  });
});

describe('a checked run (single elements measured on the page, not the whole test)', () => {
  const checked = (path: string): ProbeRun => ({ ...run(path, [noFocus('body > footer > a')], 'keyboard', ['2.4.7']), coverage: true, checked: { from: [`${E}/`] } });

  it('is never a result of the score: its page stays out of the criterion\'s share', () => {
    const runs = [run('/', [noFocus()]), run('/a', [noFocus()]), run('/b')];
    const checks = probeChecksFrom([...runs, checked('/c'), checked('/d')], () => true);
    expect([...checks.keys()].map((u) => new URL(u).pathname).sort()).toEqual(['/', '/a', '/b']);
    expect(checks.get(`${E}/`)!['2.4.7']).toBe('fail');
  });

  it('counts in the criterion\'s result, which says how each page was measured', () => {
    const runs = [run('/', [noFocus()]), run('/a', [noFocus()]), run('/b', [noFocus()])];
    const row = probeCriteriaResults([...runs, checked('/c'), checked('/d')]).find((r) => r.criterion === '2.4.7')!;
    expect(row.method).toMatchObject({ id: 'keyboard', status: 'failed', pages: 5, note: 'full test on 3 pages; on 2 more pages the element that failed was measured on that page by itself' });
    expect([METHOD_FULL, METHOD_CHECKED]).toEqual(['full test', 'checked on this page']);
    // Look-alike: without checked runs the note is as it was (none here).
    expect(probeCriteriaResults(runs).find((r) => r.criterion === '2.4.7')!.method.note).toBeUndefined();
    // The test's other criterion says nothing of the pages where single elements were checked.
    expect(probeCriteriaResults([...runs, checked('/c')]).find((r) => r.criterion === '2.1.1')!.method.pages).toBe(3);
  });
});

describe('noveltyPlanner', () => {
  const withFocus = (...focus: string[]) => kinds([], undefined, { focus });
  it('a page is fresh for a group only when it holds a key no covered page has', () => {
    const plan = noveltyPlanner();
    expect(plan.fresh('keyboard', ['focus'], withFocus('link', 'button'))).toBe(true);
    plan.cover('keyboard', ['focus'], withFocus('link', 'button'));
    // Look-alike: the ninth page built from the same parts.
    expect(plan.fresh('keyboard', ['focus'], withFocus('button', 'link'))).toBe(false);
    expect(plan.fresh('keyboard', ['focus'], withFocus('link', 'date-picker'))).toBe(true);
    // Each group has its own memory.
    expect(plan.fresh('live', ['focus'], withFocus('link'))).toBe(true);
  });
  it('a page whose kinds are not known is never fresh, and new stylesheets and scripts are features', () => {
    const plan = noveltyPlanner();
    expect(plan.fresh('keyboard', ['focus'], undefined)).toBe(false);
    plan.cover('motion', ['js', 'css'], kinds([], ['c:site', 'j:site']));
    expect(plan.fresh('motion', ['js'], kinds([], ['c:site', 'j:site', 'c:print']))).toBe(false);
    expect(plan.fresh('motion', ['js'], kinds([], ['c:site', 'j:site', 'j:carousel']))).toBe(true);
    expect(plan.fresh('motion', ['css'], kinds([], ['c:site', 'c:print']))).toBe(true);
  });
});

// Batch 17 (structure lane): a site-level send. The deep route-titles test runs on the template sample; where one
// of its runs followed a link and the site showed another page without loading it (a single-page app), the title a
// visitor gets on any page after a client-side page change is known only by following a link on that page, so the
// test goes whole to the scan's other pages, as optional work. It is routing only: nothing is reported for a page
// from another page's run.
describe('componentChecks: a test sent to the whole site by what one run measured about the site (SITE_SENDS)', () => {
  const hop = (o: object = {}) => ({ link: 'Fares', to: '/fares', title: 'Fares | Transit', h1: 'Fares', back: 'Home | Transit', ...o });
  const routes = (path: string, hops: object[] | undefined, extra: Partial<ProbeRun> = {}): ProbeRun =>
    ({ probe: 'route-titles', kind: 'interaction', page: `${E}${path}`, criteria: ['2.4.2'], status: 'ok', findings: [], ms: 5, ...(hops ? { data: { v: 1, start: { path, title: 'T' }, hops } } : {}), ...extra });
  const none = () => undefined;

  it('sends route-titles to every page it did not run on once a run saw the site change pages without loading them', () => {
    const checks = componentChecks({ pages: SITE, runs: [routes('/', [hop()]), routes('/a', [])], kindOf: none });
    expect(paths(checks)).toEqual(['/b', '/c', '/d', '/e']);
    expect(checks[0]).toEqual({ url: `${E}/b`, index: 2, elements: [], tests: ['route-titles'], from: [`${E}/`] });
    expect(CHECKS['route-titles']).toEqual({ criteria: [], send: 'test' });
    expect(Object.keys(SITE_SENDS)).toEqual(['route-titles']);
  });

  it('look-alikes send nothing: a site that loads its pages, a run with no link to follow, one whose every page change asked the server, a run that did not end ok, no run at all', () => {
    for (const runs of [
      [routes('/', []), routes('/a', [])],
      [routes('/', undefined)],
      [routes('/', [hop({ blocked: true })])],
      [routes('/', [hop()], { status: 'timeout' })],
      [routes('/', [hop()], { checked: { from: [`${E}/a`] } })],
      [run('/', [noFocus()])].map((r) => ({ ...r, findings: [] })),
    ]) expect(componentChecks({ pages: SITE, runs, kindOf: none }), JSON.stringify(runs[0]!.data ?? null)).toEqual([]);
  });

  it('reaches at most SITE_SEND_PAGES pages, in page order, and joins a page\'s other checks', () => {
    const many = Array.from({ length: SITE_SEND_PAGES + 20 }, (_, i) => page(`/p${i}`, i, ['F']));
    const sent = componentChecks({ pages: many, runs: [routes('/p0', [hop()])], kindOf: none });
    expect(sent.length).toBe(SITE_SEND_PAGES);
    expect(paths(sent).slice(0, 2)).toEqual(['/p1', '/p2']);
    // With a measured element failure too: one record per page, both asked for.
    const both = componentChecks({ pages: SITE, runs: [routes('/', [hop()]), run('/', [noFocus()]), run('/a'), run('/b')], kindOf: F });
    expect(both.find((c) => c.url === `${E}/c`)).toMatchObject({ elements: [{ kind: 'F', criteria: ['2.4.7'] }], tests: ['route-titles'] });
    expect(both.find((c) => c.url === `${E}/e`)).toMatchObject({ elements: [], tests: ['route-titles'] });
  });
});
