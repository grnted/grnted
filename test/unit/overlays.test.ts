// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The overlays probe's decisions (pure): which floating boxes fail 1.4.10 and 2.4.11 and how the
// findings read, and the report copy the problem gets.
import { describe, expect, it } from 'vitest';
import { agreedSweep, judgeSweeps, pressTab, countsForArea, countsForCover, overlayFindings, overlayShortName, OVERLAY_LIMITS, reflowAdvice, reflowProblems, type OverlayWidth, type OvCover, type OvRoot, type OvSweep } from '../../src/probes/overlays.js';
import { buildReport } from '../../src/report/build.js';
import { copyForCriterion } from '../../src/report/copy/index.js';
import { buildProblems } from '../../src/report/problems.js';
import type { EvidenceShot, PageAudit, ProbeRun, SiteReport, TestIssueSummary } from '../../src/types.js';

const root = (ref: number, over: Partial<OvRoot> = {}): OvRoot => ({
  ref, path: `#r${ref}`, name: 'English', kind: 'translate', pos: 'fixed', rect: { x: 206, y: 6, w: 110, h: 40 }, share: 0.05,
  bar: false, dialog: false, skip: false, paint: 0.05, paintAt: 0, ...over,
});
const cover = (r: number, control: number, over: Partial<OvCover> = {}): OvCover => ({
  root: r, control, path: `#c${control}`, name: `Link ${control}`, role: 'link', at: 0, rect: { x: 220, y: 10, w: 90, h: 30 },
  rootRect: { x: 206, y: 6, w: 110, h: 40 }, reachable: false, ...over,
});
const sweep = (roots: OvRoot[], covers: OvCover[]): OvSweep => ({ ok: true, vw: 320, vh: 256, maxScroll: 900, steps: 5, roots, covers, title: 't', text: 500, cut: false, layout: '900x320', layoutEnd: '900x320' });
const zoom = (roots: OvRoot[], covers: OvCover[], hidden: OverlayWidth['hidden'] = []): OverlayWidth => ({ width: 320, height: 256, label: 'zoom', sweep: sweep(roots, covers), hidden, stops: 10 });
const phone = (roots: OvRoot[], covers: OvCover[], hidden: OverlayWidth['hidden'] = []): OverlayWidth => ({ width: 390, height: 844, label: 'phone', sweep: sweep(roots, covers), hidden, stops: 10 });

describe('overlays: 1.4.10 decisions', () => {
  // Scoring v11 (review r1 of fix/redteam-visual, finding 7): 1.4.10 fails when something is LOST at 320 px. A
  // control covered only on the first screen, which scrolling brings clear, and a box over more than 40% of the
  // screen with nothing lost under it are recommendations, never failures.
  it('fails a box covering a control no scroll position shows clear; one covered only on the first screen is a recommendation; one passed over while scrolling is neither', () => {
    expect(reflowProblems(zoom([root(0)], [cover(0, 1, { at: 300 })]))).toHaveLength(1);
    expect(reflowProblems(zoom([root(0)], [cover(0, 1, { at: 0, reachable: true })]))).toEqual([]);
    expect(reflowAdvice(zoom([root(0)], [cover(0, 1, { at: 0, reachable: true })]))).toHaveLength(1);
    expect(reflowProblems(zoom([root(0)], [cover(0, 1, { at: 300, reachable: true })]))).toEqual([]);
    expect(reflowAdvice(zoom([root(0)], [cover(0, 1, { at: 300, reachable: true })]))).toEqual([]);
  });

  it('a control nobody can scroll clear fails; one covered only on the first screen is not counted with it, and alone it is a recommendation', () => {
    const f = overlayFindings([zoom([root(0)], [cover(0, 1, { reachable: true }), cover(0, 2, { at: 500 })])]);
    expect(f.map((x) => [x.status, x.target])).toEqual([['failed', '#c2']]);
    expect(f[0]!.detail).toMatch(/covers the link “Link 2” wherever the page is scrolled\.$/);
    const g = overlayFindings([phone([root(0)], [cover(0, 1, { reachable: true })])]);
    expect(g).toEqual([{
      criterion: '1.4.10', status: 'no_failures_found', advice: true, target: '#c1',
      detail: 'On a phone-sized screen (390 px wide), a box that stays on screen while the page scrolls (“English”, a translate widget) covers the link “Link 1” on the first screen, as the page opens; scrolling the page brings it clear. Recommended: keep the first screen’s links, buttons and fields clear of it.',
    }]);
  });

  // 2026-11-07 real-site audit: a box covering 35% (boise) was not remarked on; 54% and 61% boxes were.
  it('more than 40% of the screen at 320 px is a recommendation; it fails only when text stays under it wherever the page is scrolled', () => {
    expect(OVERLAY_LIMITS.areaShare).toBe(0.4);
    expect(reflowProblems(zoom([root(0, { paint: 0.54 })], []))).toEqual([]);
    expect(reflowAdvice(zoom([root(0, { paint: OVERLAY_LIMITS.areaShare })], []))).toEqual([]);
    expect(reflowAdvice(zoom([root(0, { paint: 0.35 })], []))).toEqual([]);
    expect(reflowAdvice(zoom([root(0, { paint: 0.54 })], []))[0]!.area).toBe(0.54);
    expect(reflowAdvice(phone([root(0, { paint: 0.6 })], []))).toEqual([]);
    // Text that never comes clear of a fixed box is lost: a failure from a fifth of the screen.
    expect(reflowProblems(zoom([root(0, { paint: 0.54, stuck: 3 })], []))[0]!.area).toBe(0.54);
    expect(reflowProblems(zoom([root(0, { paint: 0.25, stuck: 1 })], []))[0]!.area).toBe(0.25);
    expect(reflowProblems(zoom([root(0, { paint: 0.15, stuck: 1 })], []))).toEqual([]);
    expect(reflowAdvice(zoom([root(0, { paint: 0.54, stuck: 3 })], []))).toEqual([]);
  });

  it('does not count the page header or footer bar or a skip link', () => {
    for (const ex of [{ bar: true }, { skip: true }]) {
      expect(countsForCover(root(0, ex))).toBe(false);
      expect(countsForArea(root(0, ex))).toBe(false);
      expect(reflowProblems(zoom([root(0, { ...ex, paint: 0.5 })], [cover(0, 1)]))).toEqual([]);
    }
  });

  it('a dialog with a close button is never excused for covering a control; its area excuse is per scroll position (in paint)', () => {
    // The kit leaves the positions where a dialog paints under half the screen out of `paint`:
    // a dialog whose paint stays at 0 there passes the area rule, one with a counted share fails it.
    const excused = root(0, { dialog: true, kind: 'chat', paint: 0 });
    expect(countsForCover(excused)).toBe(true);
    expect(countsForArea(excused)).toBe(true);
    expect(reflowProblems(zoom([excused], []))).toEqual([]);
    const p = reflowProblems(zoom([excused], [cover(0, 1)]));
    expect(p).toHaveLength(1);
    expect(p[0]!.area).toBe(0);
    expect(reflowAdvice(zoom([root(0, { dialog: true, kind: 'chat', paint: 0.7 })], []))[0]!.area).toBe(0.7);
    expect(reflowProblems(zoom([root(0, { dialog: true, kind: 'chat', paint: 0.7, stuck: 2 })], []))[0]!.area).toBe(0.7);
  });

  it('a control the sweep did not check is unknown: never a failure, and never clean', () => {
    expect(reflowProblems(zoom([root(0)], [cover(0, 1, { at: 300, reachable: null })]))).toEqual([]);
    const f = overlayFindings([zoom([root(0)], [cover(0, 1, { at: 0, reachable: null })])]);
    expect(f).toEqual([{ criterion: '1.4.10', status: 'not_testable', detail: 'a covered link, button or field could not be checked at every scroll position at 320 px wide, so whether it can be scrolled clear is not known' }]);
    // A checked, unreachable control fails beside an unchecked one.
    const g = overlayFindings([zoom([root(0)], [cover(0, 1, { at: 0, reachable: null }), cover(0, 2, { at: 400 })])]);
    expect(g.map((x) => [x.status, x.target])).toEqual([['failed', '#c2']]);
  });

  it('an unfinished sweep leaves 1.4.10 unproven unless a checked failure stands', () => {
    const cut = (w: OverlayWidth, why: 'time' | 'verify'): OverlayWidth => ({ ...w, sweep: { ...w.sweep, cut: why } });
    expect(overlayFindings([cut(zoom([root(0)], [cover(0, 1, { at: 300, reachable: null })]), 'time')])).toEqual([
      { criterion: '1.4.10', status: 'not_testable', detail: 'the page took too long to check every covered link, button or field at 320 px wide' },
    ]);
    expect(overlayFindings([phone([root(0)], []), cut(zoom([root(0)], []), 'verify')])).toEqual([
      { criterion: '1.4.10', status: 'not_testable', detail: `more links, buttons or fields are covered than the test checks one by one (${OVERLAY_LIMITS.verify}) at 320 px wide` },
    ]);
    const f = overlayFindings([cut(zoom([root(0)], [cover(0, 1, { at: 300, reachable: false }), cover(0, 2, { at: 600, reachable: null })]), 'time')]);
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([['1.4.10', 'failed', '#c1']]);
  });

  it('one finding per box, merged across widths, naming the box and the first control', () => {
    const f = overlayFindings([zoom([root(0)], [cover(0, 1), cover(0, 2)]), phone([root(0)], [cover(0, 1), cover(0, 3)])]);
    expect(f).toEqual([{
      criterion: '1.4.10', status: 'failed', target: '#c1',
      detail: 'At 320 px wide and on a phone-sized screen (390 px wide), a box that stays on screen while the page scrolls (“English”, a translate widget) covers the link “Link 1” wherever the page is scrolled; 2 more links, buttons or fields are covered too.',
      data: { width: 320, overlay: '206,6,110,40', control: '220,10,90,30', scrollY: 0 },
    }]);
  });

  // 2026-11-07 ruling: a box the test closed by keyboard passes 1.4.10 at any size; otherwise the reason is in the finding.
  it('a box proven closable passes; one that is not says why', () => {
    const w = zoom([root(0, { paint: 0.75, paintAt: 0 })], [cover(0, 1, { reachable: false })]);
    expect(overlayFindings([w], new Map([[0, { closedBy: 'Close' }]])).filter((f) => f.status === 'failed')).toEqual([]);
    const [f] = overlayFindings([w], new Map([[0, { why: 'pressing Enter on its “Close” control does not close it' }]]));
    expect(f!.detail).toMatch(/ It cannot be closed: pressing Enter on its “Close” control does not close it\.$/);
  });

  it('a box over most of the screen: a recommendation naming the share, a failure when text stays under it; at most four boxes', () => {
    const roots = [0, 1, 2, 3, 4].map((i) => root(i, { name: '', kind: 'chat', paint: 0.6, paintAt: 40 }));
    const f = overlayFindings([zoom(roots, [])]);
    expect(f).toHaveLength(OVERLAY_LIMITS.maxFindings);
    expect(f[0]).toEqual({
      criterion: '1.4.10', status: 'no_failures_found', advice: true, target: '#r0',
      detail: 'At 320 px wide, a box that stays on screen while the page scrolls (a chat button) covers 60% of the screen; the content can be scrolled clear of it. Recommended: make it smaller on small screens, or let it be closed.',
    });
    const lost = overlayFindings([zoom([root(0, { name: '', kind: 'chat', paint: 0.6, paintAt: 40, stuck: 4 })], [])]);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ status: 'failed', target: '#r0', detail: 'At 320 px wide, a box that stays on screen while the page scrolls (a chat button) covers 60% of the screen, and some of the page\'s text stays under it wherever the page is scrolled.', data: { share: 60, scrollY: 40 } });
  });
});

describe('overlays: 2.4.11 findings', () => {
  it('one per covering box, merged across widths, with the cover height for the fix', () => {
    const bar = root(5, { name: 'Emergency closure information', kind: 'notice', rect: { x: 0, y: 196, w: 320, h: 60 }, bar: true });
    const stop = (control: number) => ({ control, path: `#s${control}`, name: `Story ${control}`, role: 'link' as const, box: { x: 0, y: 220, w: 80, h: 24 } });
    const f = overlayFindings([zoom([bar], [], [{ stop: stop(1), root: bar, dir: 'forward' }, { stop: stop(2), root: bar, dir: 'forward' }]), phone([bar], [], [{ stop: stop(1), root: bar, dir: 'forward' }])]);
    expect(f).toEqual([{
      criterion: '2.4.11', status: 'failed', target: '#s1',
      detail: 'At 320 px wide and on a phone-sized screen (390 px wide), the link “Story 1” is entirely hidden behind a box that stays on screen while the page scrolls (“Emergency closure information”, a notice or promotion) when it receives keyboard focus; so is 1 more focus stop.',
      data: { coverHeight: 60, width: 320, overlay: '0,196,320,60', focus: '0,220,80,24' },
    }]);
  });

  it('short names for captions', () => {
    expect(overlayShortName(root(0))).toBe('“English” translate widget');
    expect(overlayShortName(root(0, { name: '', kind: '' }))).toBe('floating box');
    expect(overlayShortName(root(0, { name: 'Summer meals', kind: '' }))).toBe('“Summer meals” box');
  });
});

describe('overlays in the report', () => {
  const page = (url: string): PageAudit => ({ url, status: 'ok', rules: {}, violations: [], incomplete: [], links: [] });
  const A = 'https://e.org/';
  const base = buildReport({ documents: [], skipped: [], startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z', userAgent: 'UA', site: A, pages: [page(A), page(`${A}b`)] });
  const issue: TestIssueSummary = { criterion: '1.4.10', title: 'Reflow', probes: ['overlays'], pagesAffected: [A], pointsLost: 2, evidence: [{ page: A, target: '#c1', detail: 'covered' }] };
  const run = (probe: string): ProbeRun => ({ probe, kind: 'render', page: A, criteria: ['1.4.10'], status: 'ok', ms: 1, findings: [{ criterion: '1.4.10', status: 'failed', target: '#c1', detail: 'x' }] });
  const shot = (id: string, probe: string): EvidenceShot => ({ id, page: A, viewport: { width: 320, height: 256, deviceScaleFactor: 1 }, width: 320, height: 256, boxes: [], alt: id, for: { criterion: '1.4.10', probe } });

  it('reads as the floating-widget problem, with its pictures, when only this test failed the criterion', () => {
    const r: SiteReport = { ...base, testIssues: [issue], probes: { runs: [run('overlays')] }, evidence: [shot('e1', 'overlays')] };
    const p = buildProblems(r)[0]!;
    expect(p.copy.title).toBe('Floating buttons or banners cover the page on phones and when zoomed');
    expect(p.evidence.map((s) => s.id)).toEqual(['e1']);
  });

  it('keeps the reflow wording, and reflow\'s pictures, when the reflow test failed it too', () => {
    const r: SiteReport = { ...base, testIssues: [issue], probes: { runs: [run('overlays'), run('reflow')] }, evidence: [shot('e1', 'overlays'), shot('e2', 'reflow')] };
    const p = buildProblems(r)[0]!;
    expect(p.copy).toBe(copyForCriterion('1.4.10'));
    expect(p.evidence.map((s) => s.id)).toEqual(['e2']);
  });
});

describe('overlays: two sweeps of a width, combined (agreedSweep)', () => {
  it('two equal sweeps agree and give the same sweep', () => {
    const a = sweep([root(0)], [cover(0, 1)]);
    expect(agreedSweep(a, { ...a })).toEqual({ sweep: a, agreed: true });
  });

  it('a box at another place, a box in one sweep only, or a failure in one only: left out, and the width is unstable', () => {
    const a = sweep([root(0)], [cover(0, 1)]);
    const moved = agreedSweep(a, sweep([root(0, { rect: { x: 100, y: 6, w: 110, h: 40 } })], [cover(0, 1)]));
    expect(moved.agreed).toBe(false);
    expect(moved.sweep.roots).toEqual([]);
    expect(moved.sweep.covers).toEqual([]);
    expect(moved.sweep.cut).toBe('unstable');
    const late = agreedSweep(sweep([], []), a);
    expect([late.agreed, late.sweep.covers, late.sweep.cut]).toEqual([false, [], 'unstable']);
    // The same box, but the control was seen clear in one sweep: no failure either way.
    const clear = agreedSweep(a, sweep([root(0)], [cover(0, 1, { at: 300, reachable: true })]));
    expect([clear.agreed, clear.sweep.covers, reflowProblems({ ...zoom([], []), sweep: clear.sweep })]).toEqual([false, [], []]);
    expect(overlayFindings([{ ...zoom([], []), sweep: clear.sweep }])).toEqual([{ criterion: '1.4.10', status: 'not_testable', detail: expect.stringMatching(/kept changing while the test checked it at 320 px wide/) }]);
  });

  it('a page that grew while it was swept is never agreed on: content added past where a sweep looked was never checked (review r1)', () => {
    const grows = (from: number, to: number) => ({ ...sweep([root(0)], [cover(0, 1)]), layout: `${from}x320`, layoutEnd: `${to}x320` });
    // Infinite scroll: each sweep adds content at the end, past the end it computed; 1.4.10 stays not tested there.
    expect(agreedSweep(grows(900, 1200), grows(1200, 1500))).toMatchObject({ agreed: false, sweep: { cut: 'unstable' } });
    expect(agreedSweep(grows(900, 1200), grows(1350, 1500)).agreed).toBe(false);
    // A page that grew once and then held still for two sweeps is agreed on (a feed that ends).
    expect(agreedSweep(grows(1500, 1500), grows(1500, 1500)).agreed).toBe(true);
  });

  it('the area rule takes the smaller share of the two sweeps, and two sweeps that disagree about lost text are unstable', () => {
    const big = (paint: number, stuck = 0) => sweep([root(0, { paint, paintAt: 0, stuck })], []);
    expect(agreedSweep(big(0.7), big(0.6)).sweep.roots[0]!.paint).toBe(0.6);
    // Over 40% in one sweep only is a recommendation either way: nothing to disagree on.
    expect(agreedSweep(big(0.7), big(0.3)).agreed).toBe(true);
    expect(agreedSweep(big(0.7, 2), big(0.15, 2))).toMatchObject({ agreed: false, sweep: { cut: 'unstable' } });
  });
});

describe('overlays: a Tab sent as CDP key events', () => {
  const page = () => {
    const pressed: string[] = [];
    return { pressed, ctx: { page: { keyboard: { async press(k: string) { pressed.push(k); } } } } as never };
  };
  it('one batch of events; Playwright only when no event reached the page, never after some did', async () => {
    const sent: string[] = [];
    const ok = { async send(_m: string, e: { type: string; key: string }) { sent.push(`${e.type} ${e.key}`); return {}; }, on() {} };
    const a = page();
    await pressTab(a.ctx, ok, true);
    expect(sent).toEqual(['rawKeyDown Shift', 'rawKeyDown Tab', 'keyUp Tab', 'keyUp Shift']);
    expect(a.pressed).toEqual([]);
    // The session is gone: nothing was delivered, so the key is pressed with Playwright.
    const b = page();
    await pressTab(b.ctx, { async send() { throw new Error('closed'); }, on() {} }, false);
    expect(b.pressed).toEqual(['Tab']);
    // The last event failed: Tab already moved focus, so it is not pressed again (Shift is released).
    const c = page();
    const partial: string[] = [];
    let n = 0;
    await pressTab(c.ctx, { async send(_m: string, e: { type: string; key: string }) { if (++n === 4) throw new Error('x'); partial.push(`${e.type} ${e.key}`); return {}; }, on() {} }, true);
    expect(c.pressed).toEqual([]);
    expect(partial.at(-1)).toBe('keyUp Shift');
  });
});

describe('overlays: a width judged from its finished sweeps only (judgeSweeps)', () => {
  const failing = () => sweep([root(0)], [cover(0, 1, { at: 300, reachable: false })]);
  const cutShort = () => ({ ...sweep([root(0)], [cover(0, 1, { at: 300, reachable: null })]), cut: 'time' as const });
  it('a sweep cut for time takes no confirmed failure away, wherever it comes', () => {
    for (const all of [[failing(), cutShort()], [cutShort(), failing()], [failing(), failing(), cutShort()]]) {
      expect(reflowProblems({ ...zoom([], []), sweep: judgeSweeps(all) }).map((p) => p.covered.map((c) => c.path))).toEqual([['#c1']]);
    }
  });
  it('one finished sweep: its failures stand, a clean result is unproven; none finished: the first as it is', () => {
    const clean = sweep([root(0)], []);
    expect(judgeSweeps([clean, cutShort()]).cut).toBe('time');
    expect(overlayFindings([{ ...zoom([], []), sweep: judgeSweeps([clean, cutShort()]) }]).map((f) => f.status)).toEqual(['not_testable']);
    const first = cutShort();
    expect(judgeSweeps([first, cutShort()])).toBe(first);
  });
  it('two finished sweeps that disagree are unstable; the last two decide after a third', () => {
    const moved = sweep([root(0, { rect: { x: 100, y: 6, w: 110, h: 40 } })], [cover(0, 1)]);
    expect(judgeSweeps([failing(), moved]).cut).toBe('unstable');
    expect(judgeSweeps([moved, failing(), failing()]).cut).toBe(false);
  });
});
