// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// fix/late-mount, review r2 (Sol 10): a replacement found by the late pass is the first pass's item only by a
// specific identity (the same timer, the same media file). Two separate unnamed divs with the same CSS
// animation are two items, and both are judged.
import { describe, expect, it } from 'vitest';
import { sameSource, type MovingItem } from '../../src/probes/motion.js';

const item = (o: Partial<MovingItem> & { id: number }): MovingItem => ({
  kind: 'animation', el: { id: o.id, path: `div:nth-of-type(${o.id})`, tag: 'div' }, box: { x: 0, y: o.id * 400, w: 200, h: 40 },
  what: 'a CSS animation "blink" on div', lastsMs: null, ...o,
});

describe('sameSource', () => {
  it('Sol 10: two unnamed divs with the same CSS animation are not the same source', () => {
    expect(sameSource(item({ id: 1 }), item({ id: 2 }))).toBe(false);
  });

  it('the same timer, or the same image file, is', () => {
    expect(sameSource(item({ id: 1, kind: 'timer', timers: [3] }), item({ id: 2, kind: 'timer', timers: [3, 4] }))).toBe(true);
    expect(sameSource(item({ id: 1, kind: 'image', src: '/a.gif' }), item({ id: 2, kind: 'image', src: '/a.gif' }))).toBe(true);
    expect(sameSource(item({ id: 1, kind: 'image', src: '/a.gif' }), item({ id: 2, kind: 'image', src: '/b.gif' }))).toBe(false);
  });
});
