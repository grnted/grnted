// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { createEvidenceRecorder } from '../../src/evidence/recorder.js';
import type { EvidenceShot } from '../../src/types.js';

const meta = (page: string): Omit<EvidenceShot, 'id'> => ({
  page, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 100, height: 50, boxes: [], alt: 'x', for: { rule: 'image-alt' },
});
const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);

describe('evidence recorder', () => {
  it('assigns e1, e2… and sends the bytes to the sink', async () => {
    const got: string[] = [];
    const r = createEvidenceRecorder({ sink: (id) => { got.push(id); } });
    expect((await r.add(meta('a'), jpeg, 'pass'))?.id).toBe('e1');
    expect((await r.add(meta('b'), jpeg, 'probe'))?.id).toBe('e2');
    expect(got).toEqual(['e1', 'e2']);
    expect(r.shots().map((s) => s.page)).toEqual(['a', 'b']);
  });

  it('never exceeds the cap, even with parallel adds, and keeps room for the evidence pass', async () => {
    const r = createEvidenceRecorder({ sink: async () => { await new Promise((ok) => setTimeout(ok, 5)); }, maxImages: 4 });
    const probe = await Promise.all([1, 2, 3, 4].map(() => r.add(meta('p'), jpeg, 'probe')));
    expect(probe.filter(Boolean)).toHaveLength(2);
    const pass = await Promise.all([1, 2, 3, 4].map(() => r.add(meta('q'), jpeg, 'pass')));
    expect(pass.filter(Boolean)).toHaveLength(2);
    expect(r.room('pass')).toBe(0);
    expect(r.shots()).toHaveLength(4);
  });

  it('clamps maxImages to 1–40 and survives a throwing sink', async () => {
    expect(createEvidenceRecorder({ sink: () => {}, maxImages: 999 }).room('pass')).toBe(40);
    expect(createEvidenceRecorder({ sink: () => {}, maxImages: 0 }).room('pass')).toBe(1);
    const r = createEvidenceRecorder({ sink: () => { throw new Error('disk full'); } });
    expect(await r.add(meta('a'), jpeg, 'pass')).toBeNull();
    expect((await r.add(meta('b'), jpeg, 'pass'))).toBeNull();
    expect(r.shots()).toEqual([]);
  });
});

describe('the AI reserve (scoring v5)', () => {
  it('keeps slots only pictures of scored AI image failures can use', async () => {
    const { createEvidenceRecorder, AI_EVIDENCE_RESERVE } = await import('../../src/evidence/recorder.js');
    expect(AI_EVIDENCE_RESERVE).toBe(2);
    const shot = { page: 'https://e.org/', viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 10, height: 10, boxes: [], alt: 'x', for: { rule: 'r' } };
    const r = createEvidenceRecorder({ sink: () => {}, maxImages: 6 }, 0.5, 2);
    expect([r.room('pass'), r.room('probe'), r.room('ai')]).toEqual([4, 3, 6]);
    for (let i = 0; i < 4; i++) expect(await r.add(shot, new Uint8Array([1]), 'pass')).not.toBeNull();
    expect(await r.add(shot, new Uint8Array([1]), 'pass')).toBeNull();
    expect(r.room('ai')).toBe(2);
    expect(await r.add({ ...shot, for: { ai: 'https://e.org/f.png' } }, new Uint8Array([1]), 'ai')).not.toBeNull();
    expect(await r.add({ ...shot, for: { ai: 'https://e.org/g.png' } }, new Uint8Array([1]), 'ai')).not.toBeNull();
    expect(r.room('ai')).toBe(0);
    // Without a reserve nothing changes.
    const plain = createEvidenceRecorder({ sink: () => {}, maxImages: 6 });
    expect([plain.room('pass'), plain.room('probe'), plain.room('ai')]).toEqual([6, 3, 6]);
  });
});
