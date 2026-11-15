// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { MAX_AI_IMAGES, MAX_CANDIDATES, MAX_TARGETS, selectEvidence, type EvidenceItem } from '../../src/evidence/select.js';
import type { AiReport, Impact, PageAudit, RuleSummary, Viewport } from '../../src/types.js';

type Node = { target: string; viewports?: Viewport['name'][] };
const page = (url: string, violations: Record<string, Node[]> = {}, status: 'ok' | 'failed' = 'ok'): PageAudit => ({
  url, status, rules: Object.fromEntries(Object.keys(violations).map((id) => [id, 'fail' as const])), links: [], incomplete: [],
  violations: Object.entries(violations).map(([id, nodes]) => ({
    id, help: `${id} help`, helpUrl: '', nodes: nodes.map((n) => ({ target: n.target, html: '<x>', viewports: n.viewports ?? ['desktop', 'mobile'] })),
  })),
});
const rule = (id: string, impact: Impact, pointsLost: number, pagesAffected: string[], elements = 1): RuleSummary => ({
  id, impact, help: `${id} help`, helpUrl: '', pagesAffected, elements, pointsLost,
  examples: pagesAffected.map((p) => ({ page: p, target: '#x', html: '<x>' })),
});
const ruleIds = (items: EvidenceItem[]) => items.filter((i) => i.kind === 'rule').map((i) => (i.kind === 'rule' ? i.rule : ''));

const A = 'https://e.org/';
const B = 'https://e.org/b';
const C = 'https://e.org/c';

describe('selectEvidence', () => {
  it('starts with the start page overview, then the rules in problem order (points, impact, pages, elements)', () => {
    const pages = [page(A, { r1: [{ target: '#a' }], r2: [{ target: '#b' }], r3: [{ target: '#c' }], r4: [{ target: '#d' }], r5: [{ target: '#e' }] }), page(B, { r4: [{ target: '#d' }] })];
    const rules = [
      rule('r5', 'minor', 0, [A], 9),
      rule('r1', 'serious', 0, [A], 1),
      rule('r2', 'serious', 0, [A], 4),
      rule('r3', 'critical', 0, [A]),
      rule('r4', 'serious', 0, [A, B]),
      rule('r0', 'minor', 2, [A]),
    ];
    pages[0]!.violations.push({ id: 'r0', help: '', helpUrl: '', nodes: [{ target: '#z', html: '', viewports: ['desktop'] }] });
    const items = selectEvidence({ pages, rules, room: 16 });
    // The start page at desktop and at phone width (Task 5.10), each with its failures to outline.
    expect(items[0]).toMatchObject({ kind: 'start', page: A, viewport: 'desktop' });
    expect(items[1]).toMatchObject({ kind: 'start', page: A, viewport: 'mobile' });
    // Scored points first, then impact weight, then pages affected, then elements, then id.
    expect(ruleIds(items)).toEqual(['r0', 'r3', 'r4', 'r2', 'r1', 'r5']);
  });

  it('takes at most one image per rule and up to 8 desktop, main-frame candidate targets on its first page with any (the capture boxes at most 3)', () => {
    const pages = [
      page(A, { r: [{ target: '#m', viewports: ['mobile'] }, { target: 'iframe >>> #f' }] }),
      page(B, { r: [{ target: '#1' }, { target: '#2' }, { target: '#2' }, { target: '#3' }, { target: '#4' }, ...[5, 6, 7, 8, 9].map((n) => ({ target: `#${n}` }))] }),
      page(C, { r: [{ target: '#c' }] }),
    ];
    const items = selectEvidence({ pages, rules: [rule('r', 'serious', 3, [A, B, C], 7)], room: 16 });
    const r = items.filter((i) => i.kind === 'rule');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'rule', rule: 'r', page: B, targets: ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8'], help: 'r help', viewport: 'desktop' });
    expect(MAX_TARGETS).toBe(3);
    expect(MAX_CANDIDATES).toBe(8);
  });

  it('skips a rule with no usable target and never picks a failed page', () => {
    const pages = [page(A, { r: [{ target: 'a >>> b' }] }), page(B, { r: [{ target: '#b' }] }, 'failed')];
    const items = selectEvidence({ pages, rules: [rule('r', 'serious', 1, [A, B])], room: 16 });
    expect(ruleIds(items)).toEqual([]);
  });

  it('has no start shot when the start page did not load, and respects the room', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(2, '0')}`);
    const pages = [page(A, {}, 'failed'), page(B, Object.fromEntries(ids.map((id) => [id, [{ target: `#${id}` }]])))];
    const rules = ids.map((id) => rule(id, 'serious', 1, [B]));
    const items = selectEvidence({ pages, rules, room: 5 });
    expect(items.some((i) => i.kind === 'start')).toBe(false);
    expect(items).toHaveLength(5);
    expect(selectEvidence({ pages, rules, room: 0 })).toEqual([]);
    expect(selectEvidence({ pages, rules, room: -3 })).toEqual([]);
    expect(selectEvidence({ pages: [page(A, { r: [{ target: '#a' }] })], rules: [rule('r', 'serious', 1, [A])], room: 1 }))
      .toEqual([{ kind: 'start', page: A, viewport: 'desktop', marks: [{ problem: 'rule:r', targets: ['#a'] }] }]);
  });

  it('can leave out the start shot and the rules (the AI part runs later)', () => {
    const pages = [page(A, { r: [{ target: '#a' }] })];
    expect(selectEvidence({ pages, rules: [rule('r', 'serious', 1, [A])], start: false, room: 16 }).map((i) => i.kind)).toEqual(['rule']);
  });

  it('picks at most 6 flagged alt-text findings about image URLs, once each, within the room', () => {
    const finding = (target: string, flagged = true, check: 'altText' | 'pageText' = 'altText', pageUrl = A) => ({
      check, criterion: '1.1.1', page: pageUrl, target, verdict: 'insufficient', label: 'Alt text', flagged, confidence: 'high' as const,
      observed: '', issue: '', suggestion: '', source: 'ai' as const,
    });
    const ai: AiReport = {
      disclaimer: '',
      runs: [{
        check: 'altText', title: '', summary: '', model: '', promptVersion: '', tier: 'core', inputs: 0, reviewed: 0, cached: 0, notReviewed: 0,
        findings: [
          finding('https://e.org/1.png'), finding('https://e.org/1.png'), finding('inline image'), finding('https://e.org/ok.png', false),
          finding('https://e.org/t.png', true, 'pageText'), finding('javascript:alert(1)'), finding('https://e.org/x.png', true, 'altText', 'not a url'),
          ...[2, 3, 4, 5, 6, 7, 8].map((n) => finding(`https://e.org/${n}.png`)),
        ],
      }],
    };
    const pages = [page(A)];
    const items = selectEvidence({ pages, ai, start: false, room: 16 });
    expect(MAX_AI_IMAGES).toBe(6);
    expect(items.map((i) => (i.kind === 'ai' ? i.target : i.kind))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `https://e.org/${n}.png`));
    expect(selectEvidence({ pages, ai, start: false, room: 2 })).toHaveLength(2);
    // An AI finding on a page the scan did not load is skipped.
    expect(selectEvidence({ pages: [page(A, {}, 'failed')], ai, start: false, room: 16 })).toEqual([]);
    // What the AI saw travels with the item (for the thumbnail's alt text); an empty one does not.
    expect(items[0]).toEqual({ kind: 'ai', page: A, check: 'altText', target: 'https://e.org/1.png' });
    const seen: AiReport = { disclaimer: '', runs: [{ ...ai.runs[0]!, findings: [{ ...ai.runs[0]!.findings[0]!, observed: 'A bus at a stop.' }] }] };
    expect(selectEvidence({ pages, ai: seen, start: false, room: 16 })).toEqual([{ kind: 'ai', page: A, check: 'altText', target: 'https://e.org/1.png', observed: 'A bus at a stop.' }]);
  });
});
