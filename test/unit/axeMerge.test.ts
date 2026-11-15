// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { mergeViewportRuns } from '../../src/axeMerge.js';
import type { AxeRun } from '../../src/types.js';

const empty: AxeRun = { violations: [], incomplete: [], passes: [], inapplicable: [] };
const v = (id: string, ...targets: string[]) => ({
  id, impact: 'serious' as const, help: `${id} help`, helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
  nodes: targets.map((t) => ({ target: t, html: `<x id="${t}">` })),
});

describe('mergeViewportRuns', () => {
  it('fails a rule that fails at either width', () => {
    const r = mergeViewportRuns([
      { viewport: 'desktop', run: { ...empty, passes: ['image-alt'] } },
      { viewport: 'mobile', run: { ...empty, violations: [v('image-alt', '#a')] } },
    ]);
    expect(r.rules['image-alt']).toBe('fail');
  });
  it('passes a rule that passed somewhere and failed nowhere', () => {
    const r = mergeViewportRuns([
      { viewport: 'desktop', run: { ...empty, passes: ['label'] } },
      { viewport: 'mobile', run: { ...empty, inapplicable: ['label'] } },
    ]);
    expect(r.rules['label']).toBe('pass');
  });
  it('marks incomplete-only and inapplicable-only rules', () => {
    const r = mergeViewportRuns([
      { viewport: 'desktop', run: { ...empty, incomplete: [v('color-contrast', '#h')], inapplicable: ['video-caption'] } },
      { viewport: 'mobile', run: { ...empty, inapplicable: ['video-caption'] } },
    ]);
    expect(r.rules['color-contrast']).toBe('incomplete');
    expect(r.rules['video-caption']).toBe('inapplicable');
    expect(r.incomplete[0]?.nodes).toHaveLength(1);
  });
  it('dedupes the same element across widths and records both widths', () => {
    const r = mergeViewportRuns([
      { viewport: 'desktop', run: { ...empty, violations: [v('image-alt', '#a', '#b')] } },
      { viewport: 'mobile', run: { ...empty, violations: [v('image-alt', '#a', '#c')] } },
    ]);
    const nodes = r.violations[0]!.nodes;
    expect(nodes.map((n) => n.target)).toEqual(['#a', '#b', '#c']);
    expect(nodes[0]!.viewports).toEqual(['desktop', 'mobile']);
    expect(nodes[1]!.viewports).toEqual(['desktop']);
  });
  it('sorts findings by rule id for stable output', () => {
    const r = mergeViewportRuns([{ viewport: 'desktop', run: { ...empty, violations: [v('z-rule', '#1'), v('a-rule', '#2')] } }]);
    expect(r.violations.map((f) => f.id)).toEqual(['a-rule', 'z-rule']);
  });
});
