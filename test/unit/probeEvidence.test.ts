// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Probe evidence (report v2, Plan 5 Task 5.2): the runner's `ctx.evidence`, clip and box validation,
// the 2-call cap, the time box, and what reaches the scan's recorder.
import { describe, expect, it } from 'vitest';
import { createEvidenceRecorder, type EvidenceRecorder } from '../../src/evidence/recorder.js';
import { cleanFindingData, cleanText, jpegSize, validBoxes, validClip } from '../../src/probes/evidence.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe, ProbeEvidenceShot } from '../../src/probes/types.js';
import type { EvidenceBox } from '../../src/types.js';
import { fakeJpeg, fakeProbeBrowser } from '../helpers/probes.js';

const OPTS = { userAgent: 'test-agent' };
const page = (index: number) => ({ url: `https://e.org/p${index}`, index });
const VIEW = { width: 1280, height: 900 };

function probe(run: PageProbe['run'], extra: Partial<PageProbe> = {}): PageProbe {
  return { id: 'pics', criteria: ['2.4.11', '2.4.7'], kind: 'interaction', tier: 'core', timeoutMs: 2000, run, ...extra };
}
const failed = (criterion = '2.4.11') => ({ criterion, status: 'failed' as const, detail: 'hidden' });
const shot = (extra: Partial<ProbeEvidenceShot> = {}): ProbeEvidenceShot => ({
  criterion: '2.4.11', boxes: [{ x: 10, y: 20, width: 100, height: 40, kind: 'fail' }], alt: 'The focused link is hidden under the header.', ...extra,
});
function recorder(maxImages = 16): { rec: EvidenceRecorder; sunk: string[] } {
  const sunk: string[] = [];
  return { rec: createEvidenceRecorder({ sink: (id) => { sunk.push(id); }, maxImages }), sunk };
}
const jpegBrowser = (w = 1280, h = 900) => fakeProbeBrowser({ screenshot: () => fakeJpeg(w, h) });

describe('clip and box validation', () => {
  it('rounds a clip outwards and clamps it inside the viewport and the size limits', () => {
    expect(validClip({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, VIEW)).toEqual({ x: 10, y: 20, width: 101, height: 51 });
    expect(validClip({ x: -50, y: -10, width: 200, height: 100 }, VIEW)).toEqual({ x: 0, y: 0, width: 150, height: 90 });
    expect(validClip({ x: 1200, y: 850, width: 400, height: 400 }, VIEW)).toEqual({ x: 1200, y: 850, width: 80, height: 50 });
    expect(validClip({ x: 0, y: 0, width: 5000, height: 5000 }, { width: 3000, height: 3000 })).toEqual({ x: 0, y: 0, width: 1280, height: 900 });
  });

  it('refuses clips that are not finite, have no size or lie outside the viewport', () => {
    for (const bad of [
      null, undefined, 'x', [], { x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: Infinity, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: -5 }, { x: 2000, y: 0, width: 10, height: 10 },
      { x: 0, y: -100, width: 10, height: 50 }, { x: '1', y: 0, width: 10, height: 10 },
    ]) expect(validClip(bad, VIEW), JSON.stringify(bad)).toBeNull();
  });

  it('clamps boxes inside the image, drops empty, outside and malformed ones, and shifts them with the clip', () => {
    const boxes = [
      { x: -10, y: 5, width: 50, height: 20, kind: 'fail' },
      { x: 90, y: 90, width: 50, height: 50, kind: 'ghost', label: 'ok' },
      { x: 200, y: 10, width: 10, height: 10, kind: 'fail' },
      { x: 10, y: 10, width: 0, height: 10, kind: 'fail' },
      { x: 10, y: 10, width: 10, height: NaN, kind: 'fail' },
      { x: 10, y: 10, width: 10, height: 10, kind: 'bogus' },
      'nope', null,
    ];
    expect(validBoxes(boxes, { width: 100, height: 100 })).toEqual([
      { x: 0, y: 5, width: 40, height: 20, kind: 'fail' },
      { x: 90, y: 90, width: 10, height: 10, kind: 'ghost', label: 'ok' },
    ]);
    // A clip moved 5 px right by clamping: boxes relative to the requested clip move 5 px left.
    expect(validBoxes([{ x: 10, y: 10, width: 10, height: 10, kind: 'expected' }], { width: 100, height: 100 }, { x: -5, y: 0 })).toEqual([
      { x: 5, y: 10, width: 10, height: 10, kind: 'expected' },
    ]);
    expect(validBoxes('x', { width: 100, height: 100 })).toEqual([]);
  });

  it('caps the number of boxes and cleans labels (control and direction characters, 24 characters)', () => {
    const many: EvidenceBox[] = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 0, width: 5, height: 5, kind: 'fail' }));
    expect(validBoxes(many, { width: 100, height: 100 })).toHaveLength(8);
    const [b] = validBoxes([{ x: 0, y: 0, width: 5, height: 5, kind: 'fail', label: '\u202e<b>\n113 px</b> and a very long tail' }], { width: 100, height: 100 });
    expect(b!.label).toBe('<b> 113 px</b> and a ve…');
    expect(b!.label!.length).toBeLessThanOrEqual(24);
    expect(validBoxes([{ x: 0, y: 0, width: 5, height: 5, kind: 'fail', label: '  \u0000 ' }], { width: 100, height: 100 })[0]).not.toHaveProperty('label');
  });

  it('cleanText strips control characters and clips', () => {
    expect(cleanText('a\u0007b\r\nc', 10)).toBe('a b c');
    expect(cleanText(42, 10)).toBe('');
    expect(cleanText('abcdefghij', 5)).toBe('abcd…');
  });

  it('reads a JPEG size and refuses other bytes', () => {
    expect(jpegSize(fakeJpeg(640, 450))).toEqual({ width: 640, height: 450 });
    expect(jpegSize(new Uint8Array())).toBeNull();
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00]))).toBeNull();
  });

  it('keeps small measured values on findings: up to 5 keys, numbers and strings only', () => {
    expect(cleanFindingData({ coverHeight: 92 })).toEqual({ coverHeight: 92 });
    expect(cleanFindingData({ a: 1, b: 'x', c: NaN, d: {}, e: [1], f: true, g: 2, h: 3, i: 4, j: 5 })).toEqual({ a: 1, b: 'x', g: 2, h: 3, i: 4 });
    expect(cleanFindingData([1, 2])).toBeUndefined();
    expect(cleanFindingData({ c: Infinity })).toBeUndefined();
    expect(cleanFindingData('x')).toBeUndefined();
    expect((cleanFindingData({ s: 'y'.repeat(500) }) as { s: string }).s.length).toBeLessThanOrEqual(200);
  });
});

describe('ctx.evidence in the runner', () => {
  it('is absent without a recorder, so no screenshot is ever taken', async () => {
    const fake = jpegBrowser();
    let had: boolean | undefined;
    const runs = await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      had = typeof ctx.evidence === 'function';
      await ctx.evidence?.(shot());
      return [failed()];
    })], OPTS);
    expect(runs[0]!.status).toBe('ok');
    expect(had).toBe(false);
    expect(fake.screenshots).toEqual([]);
  });

  it('takes a JPEG at quality 72 now and records the shot when the run ends ok with that failure', async () => {
    const fake = jpegBrowser();
    const { rec, sunk } = recorder();
    const answers: boolean[] = [];
    const runs = await runProbes(fake.browser, [page(3)], [probe(async (ctx) => {
      answers.push(await ctx.evidence!(shot({ group: 'focus-obscured', groupLabel: 'Found: focus hidden', caption: 'Shift+Tab' })));
      // Not yet in the recorder while the run is going on.
      answers.push(rec.shots().length === 0);
      return [failed()];
    })], { ...OPTS, evidence: rec });
    expect(runs[0]!.status).toBe('ok');
    expect(answers).toEqual([true, true]);
    expect(fake.screenshots).toEqual([{ type: 'jpeg', quality: 72 }]);
    expect(sunk).toEqual(['e1']);
    expect(rec.shots()).toEqual([{
      id: 'e1', page: 'https://e.org/p3', viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 1280, height: 900,
      boxes: [{ x: 10, y: 20, width: 100, height: 40, kind: 'fail' }], alt: 'The focused link is hidden under the header.', caption: 'Shift+Tab',
      for: { criterion: '2.4.11', probe: 'pics' }, group: 'pics:3:focus-obscured', groupLabel: 'Found: focus hidden',
    }]);
  });

  it('a clip: clamped to the viewport, sized from the image, boxes relative to the clip', async () => {
    const fake = fakeProbeBrowser({ screenshot: (o) => { const c = (o as { clip: { width: number; height: number } }).clip; return fakeJpeg(c.width * 2, c.height * 2); } });
    const { rec } = recorder();
    await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      await ctx.evidence!(shot({ clip: { x: -20, y: 100, width: 300, height: 200 }, boxes: [{ x: 30, y: 10, width: 50, height: 20, kind: 'fail' }] }));
      return [failed()];
    }, { contextOptions: { deviceScaleFactor: 2 } })], { ...OPTS, evidence: rec });
    expect(fake.screenshots).toEqual([{ type: 'jpeg', quality: 72, clip: { x: 0, y: 100, width: 280, height: 200 } }]);
    const [s] = rec.shots();
    expect(s).toMatchObject({ viewport: { width: 1280, height: 900, deviceScaleFactor: 2 }, width: 280, height: 200, boxes: [{ x: 10, y: 10, width: 50, height: 20, kind: 'fail' }] });
  });

  it('at most 2 successful calls per run; a failed capture does not use one', async () => {
    let n = 0;
    const fake = fakeProbeBrowser({ screenshot: () => { if (n++ === 0) throw new Error('screenshot failed'); return fakeJpeg(1280, 900); } });
    const { rec } = recorder();
    const answers: boolean[] = [];
    await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      for (let i = 0; i < 4; i++) answers.push(await ctx.evidence!(shot()));
      return [failed()];
    })], { ...OPTS, evidence: rec });
    expect(answers).toEqual([false, true, true, false]);
    expect(fake.screenshots).toHaveLength(3);
    expect(rec.shots()).toHaveLength(2);
  });

  it('parallel calls never overshoot the cap', async () => {
    const fake = fakeProbeBrowser({ screenshot: async () => { await new Promise((r) => setTimeout(r, 10)); return fakeJpeg(1280, 900); } });
    const { rec } = recorder();
    let answers: boolean[] = [];
    await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      answers = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.evidence!(shot())));
      return [failed()];
    })], { ...OPTS, evidence: rec });
    expect(answers.filter(Boolean)).toHaveLength(2);
    expect(fake.screenshots).toHaveLength(2);
    expect(rec.shots()).toHaveLength(2);
  });

  it('refuses a criterion the probe does not report on, empty alt text, bytes that are not a JPEG, and shots whose boxes all fall outside', async () => {
    const fake = fakeProbeBrowser({ screenshot: (o) => ((o as { quality?: number }).quality === 72 && calls++ === 0 ? new Uint8Array([1, 2, 3]) : fakeJpeg(1280, 900)) });
    let calls = 0;
    const { rec } = recorder();
    const answers: boolean[] = [];
    await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      answers.push(await ctx.evidence!(shot({ criterion: '1.4.4' })));
      answers.push(await ctx.evidence!(shot({ alt: ' \u0000 ' })));
      answers.push(await ctx.evidence!(shot()));
      answers.push(await ctx.evidence!(shot({ boxes: [{ x: 5000, y: 0, width: 10, height: 10, kind: 'fail' }] })));
      return [failed()];
    })], { ...OPTS, evidence: rec });
    expect(answers).toEqual([false, false, false, false]);
    expect(fake.screenshots).toHaveLength(2);
    expect(rec.shots()).toEqual([]);
  });

  it('cleans text from the page in alt, caption and group labels (the renderer escapes it)', async () => {
    const { rec } = recorder();
    await runProbes(jpegBrowser().browser, [page(0)], [probe(async (ctx) => {
      await ctx.evidence!(shot({ alt: '\u202eThe link \u201c<img src=x onerror=alert(1)>\u201d\n is hidden', caption: 'x'.repeat(500), group: 'g\u0000', groupLabel: '\u2066Found\u2069' }));
      return [failed()];
    })], { ...OPTS, evidence: rec });
    const [s] = rec.shots();
    expect(s!.alt).toBe('The link \u201c<img src=x onerror=alert(1)>\u201d is hidden');
    expect(s!.caption!.length).toBe(200);
    expect(s!.group).toBe('pics:0:g');
    expect(s!.groupLabel).toBe('Found');
  });

  it('records only shots for criteria the run failed', async () => {
    const fake = jpegBrowser();
    const { rec } = recorder();
    await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      await ctx.evidence!(shot({ criterion: '2.4.7' }));
      await ctx.evidence!(shot({ criterion: '2.4.11' }));
      return [failed('2.4.11'), { criterion: '2.4.7', status: 'no_failures_found', detail: 'fine' }];
    })], { ...OPTS, evidence: rec });
    expect(rec.shots().map((s) => s.for)).toEqual([{ criterion: '2.4.11', probe: 'pics' }]);
  });

  it('a run that times out or errors records nothing, and calls made after the time box resolve false without a screenshot', async () => {
    const fake = jpegBrowser();
    const { rec } = recorder();
    let late: Promise<boolean> | undefined;
    const runs = await runProbes(fake.browser, [page(0)], [
      probe(async (ctx) => {
        await ctx.evidence!(shot());
        await new Promise((r) => setTimeout(r, 500));
        late = ctx.evidence!(shot());
        return new Promise(() => {});
      }, { id: 'hangs', timeoutMs: 400 }),
      probe(async (ctx) => {
        await ctx.evidence!(shot());
        throw new Error('boom');
      }, { id: 'throws' }),
    ], { ...OPTS, evidence: rec });
    expect(runs.map((r) => [r.probe, r.status])).toEqual([['hangs', 'timeout'], ['throws', 'error']]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await late).toBe(false);
    expect(fake.screenshots).toHaveLength(2);
    expect(rec.shots()).toEqual([]);
  });

  it('a screenshot that hangs resolves false at the end of the time box (the probe is not held)', async () => {
    const fake = fakeProbeBrowser({ screenshot: () => new Promise<Uint8Array>(() => {}) });
    const { rec } = recorder();
    let answer: boolean | undefined;
    const runs = await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      answer = await ctx.evidence!(shot());
      return [failed()];
    }, { timeoutMs: 400 })], { ...OPTS, evidence: rec });
    expect(answer).toBe(false);
    expect(runs[0]!.status).toBe('ok');
    expect(rec.shots()).toEqual([]);
  });

  it('a full probe pool: resolves false without a screenshot', async () => {
    const fake = jpegBrowser();
    const { rec } = recorder(1);
    let answer: boolean | undefined;
    await runProbes(fake.browser, [page(0)], [probe(async (ctx) => {
      answer = await ctx.evidence!(shot());
      return [failed()];
    })], { ...OPTS, evidence: rec });
    expect(answer).toBe(false);
    expect(fake.screenshots).toEqual([]);
  });

  it('keeps ProbeFinding.data (cleaned) through the runner', async () => {
    const runs = await runProbes(jpegBrowser().browser, [page(0)], [probe(async () => [
      // A hostile or buggy probe's data, as the runner gets it.
      { ...failed(), data: { coverHeight: 92, junk: { a: 1 } } as unknown as Record<string, number> },
      { ...failed('2.4.7'), data: 'nope' as unknown as Record<string, number> },
    ])], OPTS);
    expect(runs[0]!.findings).toEqual([{ ...failed(), data: { coverHeight: 92 } }, failed('2.4.7')]);
  });
});
