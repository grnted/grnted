// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Where the slow tests go (red-team 2026-11-10, coverage lane; src/probes/sample.ts): before, every test but
// four ran on the 5-page template sample only, so a page with the site's only date picker was never given
// the keyboard test. Now a page outside the sample gets a group of slow tests when it holds something no
// page given that group so far has, as optional runs; and once those are in, an element of a kind that a
// slow test measured failing is measured on the other pages that carry it (the checks' own runner).
import { describe, expect, it } from 'vitest';
import type { PageKinds } from '../../src/collect/kinds.js';
import { CHECK_KEY, keyboardCheckProbe } from '../../src/probes/componentCheck.js';
import { findingKey } from '../../src/probes/components.js';
import { probeCriteriaResults } from '../../src/probes/criteria.js';
import { NOVELTY_GROUPS, templateProbes, type ComponentKinds } from '../../src/probes/sample.js';
import { probeChecksFrom } from '../../src/score.js';
import type { ProbeRunner } from '../../src/probes/runner.js';
import type { PageAudit, ProbeFinding, ProbeRun } from '../../src/types.js';

const probes = [
  { id: 'headings', tier: 'core', everyPage: true, criteria: ['1.3.1'] },
  { id: 'reflow', tier: 'core', everyPage: true, criteria: ['1.4.10'] },
  { id: 'keyboard', tier: 'core', criteria: ['2.4.7'] },
  { id: 'form-fields', tier: 'core', criteria: ['3.3.2'] },
  { id: 'motion', tier: 'core', criteria: ['2.2.2'] },
  { id: 'timing-watch', tier: 'deep', criteria: ['2.2.1'] },
] as unknown as ProbeRunner['probes'];

interface Added { url: string; only?: readonly string[]; optional?: readonly string[] }
function fakeRunner(findingsFor: (url: string, probe: string) => ProbeFinding[] = () => [], list: ProbeRunner['probes'] = probes) {
  const probes = list;
  const added: (Added & { collected?: Record<string, unknown> })[] = [];
  const runner: ProbeRunner = {
    probes,
    add: (t, only, more) => { added.push({ url: t.url, ...(only ? { only } : {}), ...(more?.optional ? { optional: more.optional } : {}), ...(t.collected?.[CHECK_KEY] ? { collected: t.collected } : {}) }); },
    lend: () => {},
    finish: async () => {
      const order = [...new Set(added.map((a) => a.url))];
      const seen = new Set<string>();
      return added.flatMap((a) => (a.only ?? probes.map((p) => p.id)).map((probe) => ({ probe, url: a.url })))
        .filter((x) => !seen.has(`${x.url} ${x.probe}`) && seen.add(`${x.url} ${x.probe}`))
        .sort((x, y) => order.indexOf(x.url) - order.indexOf(y.url) || probes.findIndex((p) => p.id === x.probe) - probes.findIndex((p) => p.id === y.probe))
        .map(({ probe, url }): ProbeRun => ({ probe, kind: 'render', page: url, criteria: [...probes.find((p) => p.id === probe)!.criteria], status: 'ok', findings: findingsFor(url, probe), ms: 1 }));
    },
    counts: () => ({ queued: added.length, done: 0 }),
    tests: () => ({ queued: 0, done: 0 }),
    unfinished: () => [],
    partial: (f: readonly unknown[]) => [...f] as never,
  };
  return { runner, added };
}

const E = 'https://e.org';
// Pages without a script by default: a page with one gets the motion tests whatever else it holds (the act-watch
// lane's rule, tested on its own below).
const kinds = (f: Partial<PageKinds['f']>, k: string[] = [], env: string[] = ['c:site']): PageKinds => ({ k, env, f: { focus: [], form: [], motion: [], fixed: [], ids: [], struct: [], orient: [], reorder: [], ...f } });
const page = (path: string, shape: string, k?: PageKinds, extra: Partial<PageAudit> = {}): PageAudit => ({ url: `${E}${path}`, status: 'ok', rules: {}, violations: [], incomplete: [], links: [], collected: { shape, ...(k ? { kinds: k } : {}) }, ...extra });
const noKinds: ComponentKinds = { hooks: {}, kindOf: () => undefined };
const NAV = ['a.nav', 'button.menu'];
/** The slow tests a page was given (its optional tests but the newer every-page one, which every page outside the sample has). */
const optionalOf = (added: Added[], path: string) => [...new Set(added.filter((a) => a.url === `${E}${path}`).flatMap((a) => a.optional ?? []))].filter((id) => id !== 'reflow').sort();

describe('novelty: the slow tests go where a page has something new', () => {
  it('a page with a control no tested page has gets the keyboard test, as an optional run queued with the page\'s every-page tests', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/news/a', 'home', kinds({ focus: NAV })), 1);
    t.pageAudited(page('/apply', 'home', kinds({ focus: [...NAV, 'div.date-picker'] })), 2);
    await t.finish();
    // (The runner runs each test once per address, however often a page is added: the first call decides.)
    const calls = (path: string) => [...new Set(added.filter((a) => a.url === `${E}${path}`).map((a) => JSON.stringify(a)))].map((x) => JSON.parse(x) as Added);
    // Look-alike: the page built from the same parts as the sampled one gets the every-page tests only. The newer
    // every-page test is optional there (scoring v10 did not run it outside the sample); the older one never is.
    expect(calls('/news/a')).toEqual([{ url: `${E}/news/a`, only: ['headings', 'reflow'], optional: ['reflow'] }]);
    // The page with the date picker: its first call holds all three (one page load for the tests that share a page).
    expect(calls('/apply')[0]).toEqual({ url: `${E}/apply`, only: ['headings', 'reflow', 'keyboard'], optional: ['reflow', 'keyboard'] });
    // On the sample nothing is optional.
    expect(added.filter((a) => a.url === `${E}/`).every((a) => !a.optional)).toBe(true);
  });

  it('each group follows its own features: new form fields bring the form test, a new id or script the motion test', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, ids: ['div#top'] })), 0);
    t.pageAudited(page('/contact', 'home', kinds({ focus: NAV, form: ['input.name'], ids: ['div#top'] })), 1);
    t.pageAudited(page('/alerts', 'home', kinds({ focus: NAV, ids: ['div#top', 'div#ticker'] })), 2);
    t.pageAudited(page('/map', 'home', kinds({ focus: NAV, ids: ['div#top'] }, [], ['c:site', 'j:map'])), 3);
    await t.finish();
    expect(optionalOf(added, '/contact')).toEqual(['form-fields']);
    expect(optionalOf(added, '/alerts')).toEqual(['motion']);
    expect(optionalOf(added, '/map')).toEqual(['motion']);
  });

  it('the floating-content test follows a new kind of box that stays on screen, not new controls under a shared one', async () => {
    const withOverlays = [{ id: 'overlays', tier: 'core', criteria: ['1.4.10', '2.4.11'] }, ...probes] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner();
    const t = templateProbes({ ...runner, probes: withOverlays }, 1, undefined, { kinds: noKinds });
    const STICKY = ['header.sticky'];
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, fixed: STICKY })), 0);
    // Look-alike: the shared sticky header over a new control brings the keyboard test, not the floating-content test.
    t.pageAudited(page('/apply', 'home', kinds({ focus: [...NAV, 'div.date-picker'], fixed: STICKY })), 1);
    t.pageAudited(page('/chat', 'home', kinds({ focus: NAV, fixed: [...STICKY, 'div.chat-bubble'] })), 2);
    await t.finish();
    expect(optionalOf(added, '/apply')).toEqual(['keyboard']);
    expect(optionalOf(added, '/chat')).toEqual(['overlays']);
  });

  it('the controls test follows a new kind of control and, unlike the keyboard walk, something new that only looks operable with the pointer (keyboard-op lane)', async () => {
    const withControls = [...probes, { id: 'controls', tier: 'deep', criteria: ['2.1.1', '2.1.2', '2.4.3', '2.4.11', '4.1.3'] }] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner();
    const t = templateProbes({ ...runner, probes: withControls }, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    // A new kind of control (a tab list): the keyboard walk's group and the controls test.
    t.pageAudited(page('/results', 'home', kinds({ focus: [...NAV, 'div.tabs'] })), 1);
    // A div with a pointer cursor and a script's click handler, which is no control in the HTML: the controls test only.
    t.pageAudited(page('/depot', 'home', kinds({ focus: NAV, operable: ['div#service-expand.faux-button'] })), 2);
    // Look-alike: the same pointer-only div again is nothing new.
    t.pageAudited(page('/depot/again', 'home', kinds({ focus: NAV, operable: ['div#service-expand.faux-button'] })), 3);
    // Look-alike: a page built from the sampled page's parts.
    t.pageAudited(page('/news/a', 'home', kinds({ focus: NAV })), 4);
    await t.finish();
    expect(optionalOf(added, '/results')).toEqual(['controls', 'keyboard']);
    expect(optionalOf(added, '/depot')).toEqual(['controls']);
    expect(optionalOf(added, '/depot/again')).toEqual([]);
    expect(optionalOf(added, '/news/a')).toEqual([]);
    // Without the deep tests (a core scan) the group has no test to run, and the operable feature sends nothing.
    const core = fakeRunner();
    const u = templateProbes(core.runner, 1, undefined, { kinds: noKinds });
    u.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    u.pageAudited(page('/depot', 'home', kinds({ focus: NAV, operable: ['div#service-expand.faux-button'] })), 1);
    await u.finish();
    expect(optionalOf(core.added, '/depot')).toEqual([]);
  });

  it('the screen-reader test goes to every page with content CSS shows in another order, new or not', async () => {
    const withReader = [{ id: 'screen-reader', tier: 'core', criteria: ['1.3.2'] }, ...probes] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner();
    const t = templateProbes({ ...runner, probes: withReader }, 1, undefined, { kinds: noKinds });
    const STEPS = ['p.step'];
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, struct: ['ul'] })), 0);
    t.pageAudited(page('/apply', 'home', kinds({ focus: NAV, struct: ['ul'], reorder: STEPS })), 1);
    // The same kind of reordered steps on another page is another sequence: tested again.
    t.pageAudited(page('/renew', 'home', kinds({ focus: NAV, struct: ['ul'], reorder: STEPS })), 2);
    // Look-alike: the same lists, nothing reordered.
    t.pageAudited(page('/news/a', 'home', kinds({ focus: NAV, struct: ['ul'] })), 3);
    await t.finish();
    expect(optionalOf(added, '/apply')).toEqual(['screen-reader']);
    expect(optionalOf(added, '/renew')).toEqual(['screen-reader']);
    expect(optionalOf(added, '/news/a')).toEqual([]);
  });

  it('the orientation test goes where a stylesheet styles an element by orientation that no tested page has, not for a new stylesheet alone', async () => {
    const withOrientation = [{ id: 'orientation', tier: 'core', criteria: ['1.3.4'] }, ...probes] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner();
    const t = templateProbes({ ...runner, probes: withOrientation }, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/visit', 'home', kinds({ focus: NAV, orient: ['div.visit-options'] })), 1);
    t.pageAudited(page('/visit/again', 'home', kinds({ focus: NAV, orient: ['div.visit-options'] })), 2);
    // Look-alike: its own stylesheet, with nothing styled by orientation.
    t.pageAudited(page('/landing', 'home', kinds({ focus: NAV }, [], ['c:site', 'c:landing'])), 3);
    await t.finish();
    expect(optionalOf(added, '/visit')).toEqual(['orientation']);
    expect(optionalOf(added, '/visit/again')).toEqual([]);
    expect(optionalOf(added, '/landing')).toEqual([]);
  });

  it('what an earlier page brought is not new on a later one; a sampled page covers its kinds for the pages after it', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 2, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/a', 'home', kinds({ focus: [...NAV, 'div.tabs'] })), 1);
    t.pageAudited(page('/b', 'home', kinds({ focus: [...NAV, 'div.tabs'] })), 2);
    // A second template: sampled (every test), so its accordion is covered for the page after it.
    t.pageAudited(page('/events/2026-open-house', 'event', kinds({ focus: [...NAV, 'details.accordion'] })), 3);
    t.pageAudited(page('/c', 'home', kinds({ focus: [...NAV, 'details.accordion'] })), 4);
    await t.finish();
    expect(optionalOf(added, '/a')).toEqual(['keyboard']);
    expect(optionalOf(added, '/b')).toEqual([]);
    expect(added.some((a) => a.url === `${E}/events/2026-open-house` && !a.only)).toBe(true);
    expect(optionalOf(added, '/c')).toEqual([]);
  });

  it('the choice does not depend on the order the audits finish in', async () => {
    const pages: [string, PageKinds][] = [['/', kinds({ focus: NAV })], ['/a', kinds({ focus: [...NAV, 'x'] })], ['/b', kinds({ focus: [...NAV, 'x'] })], ['/c', kinds({ focus: [...NAV, 'y'] })]];
    const scan = async (order: number[]) => {
      const { runner, added } = fakeRunner();
      const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
      for (const i of order) t.pageAudited(page(pages[i]![0], 'home', pages[i]![1]), i);
      await t.finish();
      return pages.map(([p]) => `${p}:${optionalOf(added, p).join()}`);
    };
    expect(await scan([3, 1, 2, 0])).toEqual(await scan([0, 1, 2, 3]));
    expect(await scan([0, 1, 2, 3])).toEqual(['/:', '/a:keyboard', '/b:', '/c:keyboard']);
  });

  it('batch 18: every page with a field gets the form tests, new or not; every page with an orientation lock the orientation test', async () => {
    const list = [{ id: 'forms', tier: 'deep', criteria: ['3.3.7'] }, { id: 'orientation', tier: 'core', criteria: ['1.3.4'] }, ...probes] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner(undefined, list);
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    const FIELD = ['input|'];
    const WALL = ['div.orientation-content'];
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, form: FIELD, orient: WALL, orientLock: WALL })), 0);
    // The same kinds of field and the same rotate wall as the sampled page: a form's labels and a wall are per page.
    t.pageAudited(page('/hours', 'home', kinds({ focus: NAV, form: FIELD, orient: WALL, orientLock: WALL })), 1);
    // Look-alikes: a page without fields, and one whose orientation rules only restyle (no lock).
    t.pageAudited(page('/about', 'home', kinds({ focus: NAV })), 2);
    t.pageAudited(page('/map', 'home', kinds({ focus: NAV, orient: WALL })), 3);
    await t.finish();
    expect(optionalOf(added, '/hours')).toEqual(['form-fields', 'forms', 'orientation']);
    expect(optionalOf(added, '/about')).toEqual([]);
    expect(optionalOf(added, '/map')).toEqual([]);
  });

  it('act-watch: every page with something to press or a field gets the controls test, and every page with a field the timing-entry test, new or not', async () => {
    const act = [{ id: 'controls', tier: 'deep', criteria: ['4.1.3'] }, { id: 'timing-entry', tier: 'deep', criteria: ['2.2.1'] }, ...probes] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner(undefined, act);
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    const SAVE = ['button#save'];
    const DRAFT = ['textarea#note'];
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, press: SAVE, form: DRAFT })), 0);
    // The same save button and the same draft field as the sampled page: what a press or a timer does
    // there is the page's script's own doing, so both tests go there again.
    t.pageAudited(page('/guide/b', 'home', kinds({ focus: NAV, press: SAVE, form: DRAFT })), 1);
    t.pageAudited(page('/fares', 'home', kinds({ focus: NAV, press: SAVE })), 2);
    // Look-alikes: a page of links only gets neither; kinds read before 2026-11-11 (no press list) get the
    // controls test only where the page has a field.
    t.pageAudited(page('/sitemap', 'home', kinds({ focus: ['a.nav'] })), 3);
    const old = kinds({ focus: NAV });
    delete (old.f as Partial<PageKinds['f']>).press;
    t.pageAudited(page('/old', 'home', old), 4);
    await t.finish();
    // Batch 18: a page with a field gets the form tests too, new or not (its own test above).
    expect(optionalOf(added, '/guide/b')).toEqual(['controls', 'form-fields', 'timing-entry']);
    expect(optionalOf(added, '/fares')).toEqual(['controls']);
    expect(optionalOf(added, '/sitemap')).toEqual([]);
    expect(optionalOf(added, '/old')).toEqual([]);
  });

  it('the motion tests go to every page with a script or with something that says it moves; a page with neither gets none', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, ids: ['div#live-panel'] }, [], ['c:site', 'j:app'])), 0);
    // The same script and the same panel as the sampled page: a timer in the script may update it here and not there.
    t.pageAudited(page('/guide/c', 'home', kinds({ focus: NAV, ids: ['div#live-panel'] }, [], ['c:site', 'j:app'])), 1);
    // No script, but an animation the page runs (read as a moving part).
    t.pageAudited(page('/promo', 'home', kinds({ focus: NAV, motion: ['p.ticker'] })), 2);
    // Look-alike: no script and nothing that moves.
    t.pageAudited(page('/terms', 'home', kinds({ focus: NAV })), 3);
    await t.finish();
    expect(optionalOf(added, '/guide/c')).toEqual(['motion']);
    expect(optionalOf(added, '/promo')).toEqual(['motion']);
    expect(optionalOf(added, '/terms')).toEqual([]);
  });

  it('look-alikes that get nothing more: a page whose kinds are not known, a scan without coverage, the tests that stay on the sample', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/unknown', 'home'), 1);
    await t.finish();
    expect(optionalOf(added, '/unknown')).toEqual([]);
    const plain = fakeRunner();
    const u = templateProbes(plain.runner, 1);
    u.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    u.pageAudited(page('/apply', 'home', kinds({ focus: [...NAV, 'div.date-picker'] })), 1);
    await u.finish();
    // (Only the newer every-page test is optional there, as on any page outside the sample.)
    expect(plain.added.every((a) => !a.optional || a.optional.join() === 'reflow')).toBe(true);
    // The 20-second timing watch is in no group.
    expect(NOVELTY_GROUPS.flatMap((g) => g.probes)).not.toContain('timing-watch');
    expect(NOVELTY_GROUPS.flatMap((g) => g.probes)).not.toContain('media-players');
    // The flash test films a page of its own: only a new moving part brings it, never a new id alone.
    expect(NOVELTY_GROUPS.find((g) => g.probes.includes('flash'))!.features).toEqual(['motion']);
    // No test is in two groups.
    const all = NOVELTY_GROUPS.flatMap((g) => g.probes);
    expect(new Set(all).size).toBe(all.length);
  });

  it('long scans: a group goes to at most its cap of pages outside the sample, among the pages the every-page tests run on', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, 4, { kinds: noKinds, pageCap: 2 });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    for (let i = 1; i <= 6; i++) t.pageAudited(page(`/p${i}`, 'home', kinds({ focus: [...NAV, `widget-${i}`] })), i);
    await t.finish();
    expect([1, 2, 3, 4, 5, 6].map((i) => optionalOf(added, `/p${i}`).join())).toEqual(['keyboard', 'keyboard', '', '', '', '']);
  });

  it('long scans: past the every-page tests\' pages and up to the coverage\'s reach, a page gets the wider coverage only, all optional', async () => {
    const { runner, added } = fakeRunner();
    // Scoring v10's every-page tests on the first 3 pages; the wider coverage reaches the first 5.
    const t = templateProbes(runner, 1, 3, { kinds: noKinds, reach: 5 });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    for (let i = 1; i <= 6; i++) t.pageAudited(page(`/p${i}`, 'home', kinds({ focus: i === 4 ? [...NAV, 'div.date-picker'] : NAV })), i);
    await t.finish();
    // (Each audit adds the pages decided so far again; the runner runs each test once per address: the first call decides.)
    const calls = (i: number) => [...new Set(added.filter((a) => a.url === `${E}/p${i}`).map((a) => JSON.stringify({ only: a.only, optional: a.optional })))].map((x) => JSON.parse(x) as Added);
    // Within the every-page tests' pages, as before: the scored one required, the newer one optional.
    expect(calls(2)[0]).toEqual({ only: ['headings', 'reflow'], optional: ['reflow'] });
    // Past them: no scored test (the score stays what it was), the newer every-page test and the novelty optional.
    expect(calls(3)[0]).toEqual({ only: ['reflow'], optional: ['reflow'] });
    expect(calls(4)[0]).toEqual({ only: ['reflow', 'keyboard'], optional: ['reflow', 'keyboard'] });
    expect(added.filter((a) => /\/p[34]$/.test(a.url)).every((a) => !a.only?.includes('headings'))).toBe(true);
    // Past the reach: nothing, as before.
    expect(calls(5)).toEqual([]);
    expect(calls(6)).toEqual([]);
  });

  it('long scans: without a reach given, the wider coverage stops where the every-page tests stop (as before)', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, 3, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    for (let i = 1; i <= 5; i++) t.pageAudited(page(`/p${i}`, 'home', kinds({ focus: [...NAV, `w${i}`] })), i);
    await t.finish();
    expect([3, 4, 5].flatMap((i) => added.filter((a) => a.url === `${E}/p${i}`))).toEqual([]);
  });

  it('act-watch: a carried page brings the runs of the always-groups\' tests from the scan that checked it, and is not opened for them', async () => {
    const act = [{ id: 'controls', tier: 'deep', criteria: ['4.1.3'] }, ...probes] as unknown as ProbeRunner['probes'];
    const { runner, added } = fakeRunner(undefined, act);
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    const stored = (url: string): ProbeRun[] => ['headings', 'reflow', 'controls', 'motion', 'keyboard'].map((probe) => ({ probe, kind: 'render', page: url, criteria: ['4.1.3'], status: 'ok', findings: [], ms: 1, coverage: true as const }));
    t.pageAudited(page('/', 'home', kinds({ focus: NAV, press: ['button#save'] }, [], ['c:site', 'j:app'])), 0);
    t.pageAudited(page('/guide/b', 'home', kinds({ focus: NAV, press: ['button#save'] }, [], ['c:site', 'j:app']), { unchangedSince: '2026-11-01T00:00:00.000Z', probeRuns: stored(`${E}/guide/b`) }), 1);
    const runs = await t.finish();
    // Not opened: the carried page gets no run of its own.
    expect(added.some((a) => a.url === `${E}/guide/b`)).toBe(false);
    // Its every-page runs and its always-group runs (controls, motion) come from the earlier scan; the keyboard test,
    // a novelty group's, does not (it went there only because the page was new to it then).
    expect(runs.filter((r) => r.page === `${E}/guide/b`).map((r) => r.probe).sort()).toEqual(['controls', 'headings', 'motion', 'reflow']);
  });

  it('a page whose audit was carried forward (a monitoring scan) is not opened for the slow tests', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    const kept = (url: string): ProbeRun[] => ['headings', 'reflow'].map((probe) => ({ probe, kind: 'render', page: url, criteria: ['1.3.1'], status: 'ok', findings: [], ms: 1 }));
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/apply', 'home', kinds({ focus: [...NAV, 'div.date-picker'] }), { unchangedSince: '2026-10-01T00:00:00.000Z', probeRuns: kept(`${E}/apply`) }), 1);
    await t.finish();
    expect([...new Set(added.map((a) => a.url))]).toEqual([`${E}/`]);
  });
});

describe('targeted checks in a scan\'s results', () => {
  const noFocus: ProbeFinding = { criterion: '2.4.7', status: 'failed', target: 'footer > a.top', detail: 'No visible focus indicator on "Back to top"' };
  const footerKinds: ComponentKinds = { hooks: {}, kindOf: (key) => (key.endsWith('\nfooter > a.top') ? 'F' : undefined) };
  const site = (t: ReturnType<typeof templateProbes>) => {
    // Three templates are sampled; the three news stories after them are not, and two carry the footer too.
    t.pageAudited(page('/', 'home', kinds({ focus: NAV }, ['H', 'F'])), 0);
    t.pageAudited(page('/events/2026-open-house', 'event', kinds({ focus: NAV }, ['E', 'F'])), 1);
    t.pageAudited(page('/staff/123', 'staff', kinds({ focus: NAV }, ['S', 'F'])), 2);
    t.pageAudited(page('/news/a', 'home', kinds({ focus: NAV }, ['N', 'F'])), 3);
    t.pageAudited(page('/news/b', 'home', kinds({ focus: NAV }, ['N', 'F'])), 4);
    t.pageAudited(page('/print', 'home', kinds({ focus: NAV }, ['N'])), 5);
  };
  /** The checks' runner: the check measures the footer link failing on /news/a, and finds nothing wrong on /news/b. */
  const checkRunner = () => fakeRunner(
    (url) => (url.endsWith('/news/a') ? [{ criterion: '2.4.7', status: 'failed', target: 'body > footer > a', detail: 'No visible focus indicator, measured here' }] : [{ criterion: '2.4.7', status: 'no_failures_found', detail: 'nothing wrong' }]),
    [{ id: keyboardCheckProbe.id, tier: 'core', criteria: ['1.4.11', '2.1.1', '2.4.7', '3.2.1'] }] as unknown as ProbeRunner['probes'],
  );

  it('a failure the keyboard test measured on the sampled pages sends a check to the other pages that carry the element, as optional work', async () => {
    const { runner } = fakeRunner((_url, probe) => (probe === 'keyboard' ? [noFocus] : []));
    const checker = checkRunner();
    const t = templateProbes(runner, 3, undefined, { kinds: footerKinds, checker: checker.runner });
    site(t);
    const runs = await t.finish();
    // The two stories that carry the footer, each told which kind to measure and for what; never the page without it.
    expect(checker.added.map((a) => [new URL(a.url).pathname, a.only, a.optional, a.collected?.[CHECK_KEY]])).toEqual([
      ['/news/a', ['keyboard'], ['keyboard'], [{ kind: 'F', criteria: ['2.4.7'], from: `${E}/` }]],
      ['/news/b', ['keyboard'], ['keyboard'], [{ kind: 'F', criteria: ['2.4.7'], from: `${E}/` }]],
    ]);
    // Only what a check measured failing is in the results: on the page's own element, marked as a check.
    const checked = runs.filter((r) => r.checked);
    expect(checked.map((r) => `${new URL(r.page).pathname} ${r.probe} ${r.criteria.join()} ${r.findings.map((f) => f.target).join()}`)).toEqual(['/news/a keyboard 2.4.7 body > footer > a']);
    expect(checked[0]).toMatchObject({ coverage: true, checked: { from: [`${E}/`, `${E}/events/2026-open-house`, `${E}/staff/123`] } });
    // The page where the check found nothing wrong has no keyboard run at all: it was not given the test.
    expect(runs.some((r) => r.probe === 'keyboard' && r.page === `${E}/news/b`)).toBe(false);
    // The measured failures say which element kind they are.
    expect(runs.filter((r) => r.probe === 'keyboard' && !r.checked).flatMap((r) => r.findings.map((f) => f.kind))).toEqual(['F', 'F', 'F']);
    // In page order with the rest: a page's check comes with its own runs.
    const order = runs.map((r) => new URL(r.page).pathname);
    expect(order).toEqual([...order].sort((a, b) => ['/', '/events/2026-open-house', '/staff/123', '/news/a', '/news/b', '/print'].indexOf(a) - ['/', '/events/2026-open-house', '/staff/123', '/news/a', '/news/b', '/print'].indexOf(b)));
    expect(findingKey(`${E}/`, 'keyboard', '2.4.7', 'footer > a.top').endsWith('\nfooter > a.top')).toBe(true);
  });

  it('look-alike: nothing is ever reported on a page from its kinds alone: without a runner for the checks the stories have no keyboard result', async () => {
    const { runner } = fakeRunner((_url, probe) => (probe === 'keyboard' ? [noFocus] : []));
    const t = templateProbes(runner, 3, undefined, { kinds: footerKinds });
    site(t);
    const runs = await t.finish();
    expect(runs.filter((r) => r.probe === 'keyboard').map((r) => new URL(r.page).pathname)).toEqual(['/', '/events/2026-open-house', '/staff/123']);
    expect(runs.some((r) => r.checked)).toBe(false);
  });

  it('look-alike: a check that did not run, or broke, adds nothing', async () => {
    const { runner } = fakeRunner((_url, probe) => (probe === 'keyboard' ? [noFocus] : []));
    const broken = checkRunner();
    broken.runner.finish = async () => [{ probe: 'keyboard', kind: 'interaction', page: `${E}/news/a`, criteria: ['2.4.7'], status: 'error', findings: [{ criterion: '2.4.7', status: 'not_testable', detail: 'the test could not run' }], ms: 0 }];
    const t = templateProbes(runner, 3, undefined, { kinds: footerKinds, checker: broken.runner });
    site(t);
    expect((await t.finish()).filter((r) => r.page === `${E}/news/a`).map((r) => r.probe)).not.toContain('keyboard');
    // A cut-short scan (`partial`) never has checks: they run after every other test.
    const { runner: again } = fakeRunner((_url, probe) => (probe === 'keyboard' ? [noFocus] : []));
    const t2 = templateProbes(again, 3, undefined, { kinds: footerKinds, checker: checkRunner().runner });
    site(t2);
    expect(t2.partial([]).some((r) => r.checked)).toBe(false);
  });

  it('the wider coverage is marked, and never scored: a criterion\'s share stays over the pages scoring v10 tested', async () => {
    const reflow: ProbeFinding = { criterion: '1.4.10', status: 'failed', target: '#wide', detail: 'needs scrolling sideways' };
    const { runner } = fakeRunner((url, probe) => (probe === 'keyboard' ? [noFocus] : probe === 'reflow' && url.endsWith('/news/a') ? [reflow] : []));
    const t = templateProbes(runner, 3, undefined, { kinds: { hooks: {}, kindOf: () => undefined } });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/events/2026-open-house', 'event', kinds({ focus: NAV })), 1);
    t.pageAudited(page('/staff/123', 'staff', kinds({ focus: NAV })), 2);
    t.pageAudited(page('/news/a', 'home', kinds({ focus: [...NAV, 'div.date-picker'] })), 3);
    const runs = await t.finish();
    const mark = (path: string, probe: string) => runs.find((r) => r.page === `${E}${path}` && r.probe === probe)?.coverage;
    // On the sample every run is scored, as before.
    expect([mark('/', 'keyboard'), mark('/', 'reflow'), mark('/', 'headings')]).toEqual([undefined, undefined, undefined]);
    // Outside it: the older every-page test is scored; the newer every-page test and the slow test are coverage.
    expect([mark('/news/a', 'headings'), mark('/news/a', 'reflow'), mark('/news/a', 'keyboard')]).toEqual([undefined, true, true]);
    const checks = probeChecksFrom(runs, () => true);
    // The page outside the sample has the older test's result only: its reflow and keyboard failures are listed, not scored.
    expect(checks.get(`${E}/news/a`)).toEqual({ '1.3.1': 'pass' });
    expect(checks.get(`${E}/`)).toEqual({ '1.3.1': 'pass', '1.4.10': 'pass', '2.2.1': 'pass', '2.2.2': 'pass', '2.4.7': 'fail', '3.3.2': 'pass' });
    // The report still says them: the criterion fails with the page in its list.
    const row = probeCriteriaResults(runs).find((r) => r.criterion === '1.4.10')!;
    expect(row.method).toMatchObject({ id: 'reflow', status: 'failed', pages: 4 });
  });

  it('the host\'s switch turns all of it off: only scoring v10\'s every-page tests leave the sample, and nothing is optional', async () => {
    const { runner, added } = fakeRunner();
    const t = templateProbes(runner, 1);
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/apply', 'home', kinds({ focus: [...NAV, 'div.date-picker'] })), 1);
    await t.finish();
    // The page outside the sample gets the older every-page test alone, as a required run: no second load, no
    // optional work, whatever the page holds. (The newer every-page test stays on the sample.)
    // (The page is offered again as later audits end; the runner runs each test once per address.)
    expect([...new Set(added.filter((a) => a.url === `${E}/apply`).map((a) => JSON.stringify(a)))]).toEqual([JSON.stringify({ url: `${E}/apply`, only: ['headings'] })]);
    expect(added.some((a) => a.optional?.length)).toBe(false);
  });

  it('look-alike: without coverage (kinds not collected) no check is sent, and the runs are as before', async () => {
    const { runner } = fakeRunner((_url, probe) => (probe === 'keyboard' ? [noFocus] : []));
    const t = templateProbes(runner, 3);
    site(t);
    expect((await t.finish()).some((r) => r.checked)).toBe(false);
  });

  it('the AI review hears the runs it always heard: the sample\'s, four tests\' on every page, and the media tests\'', async () => {
    const { runner } = fakeRunner();
    const t = templateProbes(runner, 1, undefined, { kinds: noKinds });
    t.pageAudited(page('/', 'home', kinds({ focus: NAV })), 0);
    t.pageAudited(page('/apply', 'home', kinds({ focus: [...NAV, 'div.date-picker'] })), 1);
    const run = (path: string, probe: string): ProbeRun => ({ probe, kind: 'render', page: `${E}${path}`, criteria: [], status: 'ok', findings: [], ms: 1 });
    expect(t.aiHears(run('/', 'keyboard'))).toBe(true);
    expect(t.aiHears(run('/apply', 'headings'))).toBe(true);
    expect(t.aiHears(run('/apply', 'keyboard'))).toBe(false);
    expect(t.aiHears(run('/apply', 'reflow'))).toBe(false);
    // Batch 18: the media tests' runs are the media checks' evidence on whatever page they run (bounded by recordings).
    expect(t.aiHears(run('/apply', 'media-files'))).toBe(true);
    expect(t.aiHears(run('/apply', 'media-players'))).toBe(true);
  });
});
