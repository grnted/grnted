// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Core-test evidence (report v2 follow-up): the probe evidence pool holds every probe picture until
// the probes end, keeps only failures the final runs report, and shares the room fairly (one picture
// per criterion before any gets a second); the start page's failing elements come out as marks.
import { describe, expect, it } from 'vitest';
import { createEvidenceRecorder, type EvidenceRecorder } from '../../src/evidence/recorder.js';
import { createProbeEvidencePool, POOL_PER_KEY, type PoolUnit } from '../../src/evidence/probePool.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe, ProbeEvidenceShot } from '../../src/probes/types.js';
import type { EvidenceShot, ProbeRun } from '../../src/types.js';
import { fakeJpeg, fakeProbeBrowser } from '../helpers/probes.js';

const OPTS = { userAgent: 'test-agent' };
const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
const meta = (criterion: string, page: string): Omit<EvidenceShot, 'id'> => ({
  page, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 100, height: 50,
  boxes: [{ x: 1, y: 1, width: 10, height: 10, kind: 'fail' }], alt: 'x', for: { criterion, probe: 'p' },
});
const unit = (criterion: string, index: number, extra: Partial<PoolUnit> = {}): PoolUnit => ({
  criterion, page: `https://e.org/p${index}`, index, probe: 'p', shots: [{ meta: meta(criterion, `https://e.org/p${index}`), bytes: jpeg }], ...extra,
});
const run = (page: number, failed: string[], extra: Partial<ProbeRun> = {}): ProbeRun => ({
  probe: 'p', kind: 'render', page: `https://e.org/p${page}`, criteria: failed, status: 'ok', ms: 1,
  findings: failed.map((criterion) => ({ criterion, status: 'failed' as const, detail: 'bad' })), ...extra,
});
const rec = (maxImages: number): EvidenceRecorder => createEvidenceRecorder({ sink: () => {}, maxImages });
const crit = (r: EvidenceRecorder) => r.shots().map((s) => ('criterion' in s.for ? s.for.criterion : '?'));

describe('probe evidence pool', () => {
  it('one picture per criterion before any criterion gets a second (the widest failure first)', async () => {
    const pool = createProbeEvidencePool();
    // 1.4.3 fails on three pages and offered three pictures; 1.3.1 and 3.3.2 one each.
    for (const [c, i] of [['1.4.3', 0], ['1.4.3', 1], ['1.4.3', 2], ['1.3.1', 1], ['3.3.2', 2]] as const) {
      const t = pool.take(c, String(i));
      expect(t).not.toBeNull();
      pool.offer(unit(c, i), t!);
    }
    const r = rec(6); // probe share 3
    await pool.commit([run(0, ['1.4.3']), run(1, ['1.4.3', '1.3.1']), run(2, ['1.4.3', '3.3.2'])], r);
    expect(crit(r)).toEqual(['1.4.3', '1.3.1', '3.3.2']);
  });

  it('first pictures may use room the axe pass left; second pictures stay in the probes’ share', async () => {
    const pool = createProbeEvidencePool();
    for (const [c, i] of [['1.4.3', 0], ['1.4.3', 1], ['1.3.1', 0], ['2.4.6', 0], ['3.3.2', 0]] as const) pool.offer(unit(c, i), pool.take(c, String(i))!);
    const r = rec(6); // probe share 3, total 6
    await pool.commit([run(0, ['1.4.3', '1.3.1', '2.4.6', '3.3.2']), run(1, ['1.4.3'])], r);
    expect(crit(r).sort()).toEqual(['1.3.1', '1.4.3', '2.4.6', '3.3.2']);
    expect(r.room('pass')).toBe(2);
  });

  it('keeps only pictures of failures the final runs report (a `when` test for cross-page failures)', async () => {
    const pool = createProbeEvidencePool();
    pool.offer(unit('2.4.6', 1, { when: (f) => f.detail.startsWith('The main heading') }), pool.take('2.4.6', 'template')!);
    pool.offer(unit('2.4.6', 2, { when: (f) => f.detail.startsWith('The main heading') }), pool.take('2.4.6', 'template')!);
    pool.offer(unit('1.3.1', 3), pool.take('1.3.1')!);
    const r = rec(16);
    await pool.commit([
      { ...run(1, []), findings: [{ criterion: '2.4.6', status: 'failed', detail: 'The main heading “Acme” is the same on nearly every page' }] },
      { ...run(2, []), findings: [{ criterion: '2.4.6', status: 'failed', detail: 'A level-3 heading has no text' }] },
      run(3, ['1.3.1'], { status: 'timeout' }),
    ], r);
    expect(r.shots().map((s) => s.page)).toEqual(['https://e.org/p1']);
  });

  it('at most two pictures per criterion, whatever kinds of failure they show', async () => {
    const pool = createProbeEvidencePool();
    for (const [v, i] of [['a', 0], ['a', 1], ['b', 2], ['b', 3]] as const) pool.offer(unit('2.4.6', i), pool.take('2.4.6', v)!);
    const r = rec(40);
    await pool.commit([0, 1, 2, 3].map((i) => run(i, ['2.4.6'])), r);
    expect(r.shots().map((s) => s.page)).toEqual(['https://e.org/p0', 'https://e.org/p1']);
  });

  it('a pair goes in whole or not at all', async () => {
    const pool = createProbeEvidencePool();
    const pair = unit('1.4.4', 0);
    pair.shots.push({ ...pair.shots[0]! });
    pool.offer(pair, pool.take('1.4.4')!);
    const r = rec(1);
    await pool.commit([run(0, ['1.4.4'])], r);
    expect(r.shots()).toEqual([]);
  });

  it('stops giving slots once a criterion has its pictures; a released slot can be taken again', () => {
    const pool = createProbeEvidencePool();
    const t = Array.from({ length: POOL_PER_KEY }, () => pool.take('1.4.3'));
    expect(t.every(Boolean)).toBe(true);
    expect(pool.wants('1.4.3')).toBe(false);
    expect(pool.take('1.4.3')).toBeNull();
    expect(pool.wants('1.4.3', 'other')).toBe(true);
    t[0]!.release();
    t[0]!.release();
    expect(pool.take('1.4.3')).not.toBeNull();
    expect(pool.take('1.4.3')).toBeNull();
  });

  it('returns the start page’s marks for criteria it still fails there, keyed by problem', async () => {
    const pool = createProbeEvidencePool();
    const rects = [{ x: 10, y: 20, width: 30, height: 40 }];
    pool.home({ criterion: '1.3.1', page: 'https://e.org/p0', probe: 'p', rects });
    pool.home({ criterion: '1.4.3', page: 'https://e.org/p0', probe: 'p', rects });
    pool.home({ criterion: '1.3.1', page: 'https://e.org/p1', probe: 'p', rects });
    const marks = await pool.commit([run(0, ['1.3.1']), run(1, ['1.3.1'])], rec(16), 'https://e.org/p0');
    expect(marks).toEqual([{ problem: 'criterion:1.3.1', rects }]);
  });
});

describe('probe evidence pool: with the axe pass\'s pictures', () => {
  const pass = (n: number) => ({
    start: [0, 1].map((i) => ({ shot: { ...meta('x', 'https://e.org/p0'), for: { rule: '$start' } }, jpeg: new Uint8Array([i]) })),
    rules: Array.from({ length: n }, (_, i) => ({ shot: { ...meta('x', `https://e.org/p${i}`), for: { rule: `rule-${i}` } }, jpeg })),
  });
  const what = (r: EvidenceRecorder) => r.shots().map((s) => ('rule' in s.for ? s.for.rule : 'criterion' in s.for ? s.for.criterion : '?'));

  it('every problem, axe rule or core test, gets one picture before any gets a second, within the cap', async () => {
    const pool = createProbeEvidencePool();
    // Four criteria with two pictures each, eight axe rules: 2 start shots + 12 first pictures = 14 of 16.
    for (const c of ['1.4.3', '1.3.1', '2.4.6', '3.3.2']) for (const i of [0, 1]) pool.offer(unit(c, i), pool.take(c, String(i))!);
    const r = rec(16);
    await pool.commit([run(0, ['1.4.3', '1.3.1', '2.4.6', '3.3.2']), run(1, ['1.4.3', '1.3.1', '2.4.6', '3.3.2'])], r, undefined, pass(8));
    const got = what(r);
    expect(got.slice(0, 2)).toEqual(['$start', '$start']);
    for (let i = 0; i < 8; i++) expect(got).toContain(`rule-${i}`);
    for (const c of ['1.4.3', '1.3.1', '2.4.6', '3.3.2']) expect(got.filter((x) => x === c).length).toBeGreaterThanOrEqual(1);
    expect(got).toHaveLength(16);
    // The two seconds come only after all twelve firsts.
    const firstsEnd = Math.max(...[...Array(8).keys()].map((i) => got.indexOf(`rule-${i}`)), ...['1.4.3', '1.3.1', '2.4.6', '3.3.2'].map((c) => got.indexOf(c)));
    expect(firstsEnd).toBe(13);
  });

  it('when the firsts do not all fit, axe rules and core tests share what there is', async () => {
    const pool = createProbeEvidencePool();
    for (const c of ['1.4.3', '1.3.1', '2.4.6']) pool.offer(unit(c, 0), pool.take(c)!);
    const r = rec(8);
    await pool.commit([run(0, ['1.4.3', '1.3.1', '2.4.6'])], r, undefined, pass(6));
    const got = what(r);
    expect(got).toHaveLength(8);
    expect(got.filter((x) => x.startsWith('rule-')).length).toBe(3);
    expect(got.filter((x) => /^\d/.test(x)).length).toBe(3);
  });
});

describe('recorder: boxes added to a recorded shot', () => {
  it('appends boxes to the shot with that id and keeps the rest', async () => {
    const r = rec(4);
    await r.add({ ...meta('1.3.1', 'a'), for: { rule: '$start' } }, jpeg, 'pass');
    expect(r.addBoxes('e1', [{ x: 5, y: 5, width: 5, height: 5, kind: 'fail', problem: 'criterion:1.3.1' }])).toBe(true);
    expect(r.addBoxes('e9', [])).toBe(false);
    expect(r.shots()[0]!.boxes).toHaveLength(2);
  });
});

describe('runner: core-test pictures through the pool', () => {
  const probe = (run: PageProbe['run'], extra: Partial<PageProbe> = {}): PageProbe =>
    ({ id: 'pics', criteria: ['1.4.3', '1.3.1', '2.4.6'], kind: 'render', tier: 'core', timeoutMs: 2000, run, ...extra });
  const shot = (criterion: string, extra: Partial<ProbeEvidenceShot> = {}): ProbeEvidenceShot =>
    ({ criterion, boxes: [{ x: 10, y: 20, width: 100, height: 40, kind: 'fail' }], alt: 'Text outlined.', ...extra });
  const pages = [0, 1, 2, 3, 4, 5].map((index) => ({ url: `https://e.org/p${index}`, index }));

  it('a criterion that fails on every page takes pictures on a few pages only, and the other criteria still get theirs', async () => {
    const fake = fakeProbeBrowser({ screenshot: () => fakeJpeg(1280, 900) });
    const r = rec(4); // probe share 2
    await runProbes(fake.browser, pages, [probe(async (ctx) => {
      const out = [{ criterion: '1.4.3', status: 'failed' as const, detail: 'low' }];
      if (ctx.evidenceWanted?.('1.4.3')) await ctx.evidence!(shot('1.4.3'));
      if (ctx.pageIndex === 5) {
        out.push({ criterion: '1.3.1', status: 'failed', detail: 'skip' });
        if (ctx.evidenceWanted?.('1.3.1')) await ctx.evidence!(shot('1.3.1'));
      }
      return out;
    })], { ...OPTS, evidence: r, concurrency: 1 });
    expect(fake.screenshots.length).toBeLessThanOrEqual(POOL_PER_KEY + 1);
    expect(crit(r).sort()).toEqual(['1.3.1', '1.4.3']);
  });

  it('a shot with no box (the first screen) is kept when it says it is bare and has a caption', async () => {
    const r = rec(16);
    await runProbes(fakeProbeBrowser({ screenshot: () => fakeJpeg(1280, 900) }).browser, [pages[1]!], [probe(async (ctx) => {
      expect(await ctx.evidence!(shot('2.4.6', { boxes: [], bare: true, caption: 'No level-1 heading on this page' }))).toBe(true);
      expect(await ctx.evidence!(shot('1.3.1', { boxes: [], bare: true }))).toBe(false);
      return [{ criterion: '2.4.6', status: 'failed', detail: 'no h1' }, { criterion: '1.3.1', status: 'failed', detail: 'skip' }];
    })], { ...OPTS, evidence: r });
    expect(r.shots().map((s) => [s.boxes.length, s.caption])).toEqual([[0, 'No level-1 heading on this page']]);
  });

  it('start page marks: recorded on the start page at the desktop width only, and only for failures', async () => {
    const pool = createProbeEvidencePool();
    const r = rec(16);
    const runs = await runProbes(fakeProbeBrowser().browser, [pages[0]!, pages[1]!], [probe(async (ctx) => {
      ctx.evidenceHome?.('1.3.1', [{ x: 1, y: 2, width: 3, height: 4 }]);
      ctx.evidenceHome?.('1.4.3', [{ x: 1, y: 2, width: 3, height: 4 }]);
      return [{ criterion: '1.3.1', status: 'failed', detail: 'skip' }];
    })], { ...OPTS, evidence: r, evidencePool: pool });
    expect(r.shots()).toEqual([]);
    const marks = await pool.commit(runs, r, 'https://e.org/p0');
    expect(marks).toEqual([{ problem: 'criterion:1.3.1', rects: [{ x: 1, y: 2, width: 3, height: 4 }] }]);
  });

  it('failed findings that name their element become start page marks (desktop start page only; the probe\'s own marks win)', async () => {
    const pool = createProbeEvidencePool();
    const r = rec(16);
    const asked: unknown[] = [];
    const browser = fakeProbeBrowser({
      evaluate: (name, path, arg) => {
        if (name !== 'elementRects') return undefined;
        asked.push([path, arg]);
        return { sx: 0, sy: 0, vw: 1280, vh: 900, title: 't', boxes: [], home: [{ x: 10, y: 20, width: 30, height: 40 }, null, { x: 5, y: 6, width: 7, height: 8 }] };
      },
    }).browser;
    const runs = await runProbes(browser, [pages[0]!, pages[1]!], [probe(async (ctx) => {
      ctx.evidenceHome?.('1.3.1', [{ x: 1, y: 2, width: 3, height: 4 }]);
      return [
        { criterion: '1.3.1', status: 'failed', target: '#own', detail: 'skip' },
        { criterion: '1.4.3', status: 'failed', target: '#a', detail: 'low' },
        { criterion: '1.4.3', status: 'failed', target: '#b', detail: 'low' },
        { criterion: '2.4.6', status: 'failed', target: '#c', detail: 'vague' },
        { criterion: '2.4.6', status: 'no_failures_found', target: '#d', detail: 'fine' },
      ];
    })], { ...OPTS, evidence: r, evidencePool: pool });
    // One measurement, on the start page only, for the criteria the probe did not mark itself.
    expect(asked).toEqual([['/p0', { handles: [{ sel: '#a' }, { sel: '#b' }, { sel: '#c' }], align: 'none', home: true }]]);
    const marks = await pool.commit(runs, r, 'https://e.org/p0');
    expect(marks).toEqual([
      { problem: 'criterion:1.3.1', rects: [{ x: 1, y: 2, width: 3, height: 4 }] },
      { problem: 'criterion:1.4.3', rects: [{ x: 10, y: 20, width: 30, height: 40 }] },
      { problem: 'criterion:2.4.6', rects: [{ x: 5, y: 6, width: 7, height: 8 }] },
    ]);
  });
});

// An unscored test's failure of a criterion a scored test also fails is a problem of its own (report:
// `criterion:<n>/listed`), so its pictures never compete with the scored tests' for that criterion.
describe('probe evidence pool: unscored tests\' pictures', () => {
  it('RED (e2e): the scored tests\' two pictures of a criterion leave room for an unscored test\'s first one', async () => {
    const pool = createProbeEvidencePool();
    pool.offer(unit('1.4.11', 0), pool.take('1.4.11')!);
    pool.offer(unit('1.4.11', 1), pool.take('1.4.11')!);
    const t = pool.take('1.4.11', 'listed');
    expect(t).not.toBeNull();
    pool.offer(unit('1.4.11', 2, { probe: 'fc', listed: true }), t!);
    const r = rec(40);
    await pool.commit([run(0, ['1.4.11']), run(1, ['1.4.11']), { ...run(2, ['1.4.11']), probe: 'fc' }], r);
    expect(r.shots().map((s) => s.page)).toEqual(['https://e.org/p0', 'https://e.org/p2', 'https://e.org/p1']);
  });

  it('RED (e2e): unscored tests\' pictures only use the room the scored problems leave (they come after them in the report)', async () => {
    const pool = createProbeEvidencePool();
    // The unscored test fails on three pages (the widest spread), the scored ones on one page each.
    for (const i of [0, 1, 2]) pool.offer(unit('1.4.11', i, { probe: 'fc', listed: true }), pool.take('1.4.11', `listed:${i}`)!);
    pool.offer(unit('1.4.3', 3), pool.take('1.4.3')!);
    pool.offer(unit('2.4.3', 4), pool.take('2.4.3')!);
    const r = rec(2); // room for two pictures
    await pool.commit([...[0, 1, 2].map((i) => ({ ...run(i, ['1.4.11']), probe: 'fc' })), run(3, ['1.4.3']), run(4, ['2.4.3'])], r);
    expect(crit(r).sort()).toEqual(['1.4.3', '2.4.3']);
    const more = rec(3);
    const pool2 = createProbeEvidencePool();
    for (const i of [0, 1, 2]) pool2.offer(unit('1.4.11', i, { probe: 'fc', listed: true }), pool2.take('1.4.11', `listed:${i}`)!);
    pool2.offer(unit('1.4.3', 3), pool2.take('1.4.3')!);
    pool2.offer(unit('2.4.3', 4), pool2.take('2.4.3')!);
    await pool2.commit([...[0, 1, 2].map((i) => ({ ...run(i, ['1.4.11']), probe: 'fc' })), run(3, ['1.4.3']), run(4, ['2.4.3'])], more);
    expect(crit(more).sort()).toEqual(['1.4.11', '1.4.3', '2.4.3']);
  });

  it('RED (e2e): through the runner, an unscored probe still takes its picture after a scored one took the criterion\'s', async () => {
    const fake = fakeProbeBrowser({ screenshot: () => fakeJpeg(1280, 900) });
    const r = rec(12);
    const shot = (criterion: string): ProbeEvidenceShot => ({ criterion, boxes: [{ x: 10, y: 20, width: 100, height: 40, kind: 'fail' }], alt: 'Outlined.' });
    // The scored test fails every page (its two pictures go to the first pages); the unscored one only the last.
    const failing = (id: string, extra: Partial<PageProbe> = {}, only?: number): PageProbe => ({
      id, criteria: ['1.4.11'], kind: 'render', tier: 'core', timeoutMs: 2000, ...extra,
      async run(ctx) {
        if (only !== undefined && ctx.pageIndex !== only) return [{ criterion: '1.4.11', status: 'no_failures_found' as const, detail: 'ok' }];
        if (ctx.evidenceWanted?.('1.4.11')) await ctx.evidence!(shot('1.4.11'));
        return [{ criterion: '1.4.11', status: 'failed' as const, detail: id }];
      },
    });
    await runProbes(fake.browser, [0, 1, 2].map((index) => ({ url: `https://e.org/p${index}`, index })),
      [failing('scored-one'), failing('unscored-one', { scored: false }, 2)], { ...OPTS, evidence: r, concurrency: 1 });
    expect(r.shots().filter((s) => 'probe' in s.for && s.for.probe === 'unscored-one')).toHaveLength(1);
  });
});
