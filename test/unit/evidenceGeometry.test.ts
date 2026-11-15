// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { boxesIn, BOX_TARGET_MAX, pageLabel, startBoxes } from '../../src/evidence/capture.js';

describe('evidence boxes relative to the clip', () => {
  const clip = { x: 100, y: 50, width: 400, height: 300 };

  it('moves rectangles into clip coordinates and numbers them when there are several', () => {
    expect(boxesIn([{ x: 124, y: 74, width: 160, height: 70 }], clip)).toEqual([{ x: 24, y: 24, width: 160, height: 70, kind: 'fail' }]);
    expect(boxesIn([{ x: 124, y: 74, width: 10, height: 10 }, { x: 200, y: 100, width: 20, height: 20 }], clip).map((b) => b.label)).toEqual(['1', '2']);
  });

  it('cuts boxes to the clip, rounds inwards and drops what falls outside or has no size', () => {
    expect(boxesIn([{ x: 80, y: 40, width: 50, height: 30 }], clip)).toEqual([{ x: 0, y: 0, width: 30, height: 20, kind: 'fail' }]);
    expect(boxesIn([{ x: 124.5, y: 74.5, width: 10, height: 10 }], clip)).toEqual([{ x: 25, y: 25, width: 9, height: 9, kind: 'fail' }]);
    expect(boxesIn([{ x: 600, y: 74, width: 10, height: 10 }, { x: 150, y: 60, width: 0.4, height: 10 }], clip)).toEqual([]);
  });
});

describe('each box names the element it outlines (report v3 pins)', () => {
  const clip = { x: 100, y: 50, width: 400, height: 300 };

  it('keeps the selector a rule crop measured, beside the numbered label', () => {
    const boxes = boxesIn([{ x: 124, y: 74, width: 10, height: 10, target: '#a' }, { x: 200, y: 100, width: 20, height: 20, target: 'main > img' }], clip);
    expect(boxes.map((b) => [b.label, b.target])).toEqual([['1', '#a'], ['2', 'main > img']]);
  });

  it('keeps the selector on the start shot, with the problem it belongs to', () => {
    const boxes = startBoxes([{ problem: 'rule:image-alt', targets: ['#hero', '#logo'] }], [[{ x: 10, y: 10, width: 50, height: 40, target: '#hero' }, { x: 70, y: 10, width: 20, height: 20, target: '#logo' }]], { width: 1280, height: 900 });
    expect(boxes).toEqual([
      { x: 10, y: 10, width: 50, height: 40, kind: 'fail', problem: 'rule:image-alt', target: '#hero' },
      { x: 70, y: 10, width: 20, height: 20, kind: 'fail', problem: 'rule:image-alt', target: '#logo' },
    ]);
  });

  it('leaves the selector off when it is missing, not a string or too long: never a cut selector', () => {
    const long = `div${' > div'.repeat(60)}`;
    expect(long.length).toBeGreaterThan(BOX_TARGET_MAX);
    const boxes = boxesIn([{ x: 124, y: 74, width: 10, height: 10, target: long }, { x: 200, y: 100, width: 20, height: 20 }, { x: 300, y: 100, width: 20, height: 20, target: 7 as unknown as string }], clip);
    expect(boxes.map((b) => 'target' in b)).toEqual([false, false, false]);
    expect(startBoxes([{ problem: 'p', targets: [long] }], [[{ x: 1, y: 1, width: 5, height: 5, target: long }]], { width: 100, height: 100 })[0]).not.toHaveProperty('target');
  });
});

describe('page labels in alt text', () => {
  it('names the home page and shows other pages by path', () => {
    expect(pageLabel('https://e.org/')).toBe('Home page');
    expect(pageLabel('https://e.org/about/staff%20list')).toBe('Page /about/staff list');
    expect(pageLabel(`https://e.org/${'a'.repeat(200)}`)).toHaveLength(85);
    expect(pageLabel('https://e.org/%E0%A4%A')).toBe('Page /%E0%A4%A');
  });
});
