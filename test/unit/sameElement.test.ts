// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// One defect on one element is one problem (trust review 2026-11-05, item 2): the axe rule, the
// screen-reader test and its links list all report a link with no name, and the report listed it three
// times. The report model merges them by element and criterion, keeps every source's evidence on the one
// problem, and never changes the score. And one report never says two things about one problem: the fix
// plan's element count and owner come from the same values as the problem's (item 1).
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { buildProblems } from '../../src/report/problems.js';
import { screenReaderFindings, buildTree, type AxNode } from '../../src/probes/screenReader/index.js';
import type { PageAudit, ProbeRun, SiteReport } from '../../src/types.js';

const U = (i: number) => `https://e.org/p${i}`;
const node = (html: string, target: string) => ({ target, html, viewports: ['desktop' as const] });
const SEARCH = '<a href="/search"><img src="/search.svg"></a>';

/** Four pages. The header's search link has no name on every page (axe link-name, the screen-reader test hears it twice). */
function site(over: { extraImage?: boolean; srExtra?: boolean } = {}): SiteReport {
  const pages: PageAudit[] = Array.from({ length: 4 }, (_, i) => {
    const violations = [
      { id: 'link-name', help: 'Links', helpUrl: 'https://x', nodes: [node(SEARCH, 'a[href$="search"]')] },
      { id: 'image-alt', help: 'Images', helpUrl: 'https://x', nodes: [node('<img src="/logo.svg">', 'header img'), ...(over.extraImage && i === 0 ? [node('<img src="/photo.jpg">', 'main img')] : [])] },
    ];
    return { url: U(i), status: 'ok', links: [], incomplete: [], violations, rules: Object.fromEntries([...violations.map((v) => [v.id, 'fail'] as const), ['label', 'pass'] as const]) };
  });
  const sr = (i: number): ProbeRun => ({
    probe: 'screen-reader', kind: 'render', page: U(i), criteria: ['1.3.1', '1.3.2', '2.4.4', '2.4.6', '4.1.2'], status: 'ok', ms: 1,
    findings: [
      { criterion: '4.1.2', status: 'failed', target: 'html > body > header > a:nth-of-type(2)', detail: 'A link has no name: screen readers announce only “link”', data: { role: 'link' } },
      { criterion: '2.4.4', status: 'failed', target: 'html > body > header > a:nth-of-type(2)', detail: 'A link has no name, so the links list shows an empty entry and nothing says where it goes', data: { role: 'link' } },
      // A second nameless control the axe rules did not report on this page: a different element, kept.
      ...(over.srExtra && i === 1 ? [{ criterion: '4.1.2', status: 'failed' as const, target: 'main > div[role=button]', detail: 'A button has no name: screen readers announce only “button”', data: { role: 'button' } }] : []),
    ],
  });
  return buildReport({ site: U(0), pages, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-01T00:00:00Z', userAgent: 'ua', probeRuns: Array.from({ length: 4 }, (_, i) => sr(i)) });
}

describe('one defect on one element is one problem', () => {

  it('a nameless control the axe rules did not report stays its own problem', () => {
    const ps = buildProblems(site({ srExtra: true }));
    const sr = ps.find((p) => p.key === 'criterion:4.1.2');
    expect(sr).toBeDefined();
    expect(sr!.pages).toEqual([U(1)]);
    expect(sr!.textEvidence.map((e) => e.detail)).toEqual(['A button has no name: screen readers announce only “button”']);
    expect(ps.some((p) => p.key === 'criterion:2.4.4')).toBe(false);
  });

  it('changes the report, never the score or a problem’s points', () => {
    const r = site();
    const before = { score: r.score, letter: r.letter, headline: r.headline };
    const ps = buildProblems(r);
    expect({ score: r.score, letter: r.letter, headline: r.headline }).toEqual(before);
    expect(ps.find((p) => p.key === 'rule:link-name')!.pointsLost).toBe(r.rules.find((x) => x.id === 'link-name')!.pointsLost);
  });

  it('the screen-reader test names the role of each nameless control, so the report can match it', () => {
    const n = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({
      nodeId, role: { type: 'role', value: role }, name: { type: 'computedString', value: name }, childIds, ...extra,
    });
    const tree = buildTree([n('1', 'RootWebArea', 'T', ['2', '3']), n('2', 'link', '', [], { parentId: '1' }), n('3', 'button', '', [], { parentId: '1' })], null);
    const { findings } = screenReaderFindings(tree);
    expect(findings.filter((f) => f.criterion === '4.1.2').map((f) => f.data?.role)).toEqual(['link', 'button']);
    expect(findings.filter((f) => f.criterion === '2.4.4').map((f) => f.data?.role)).toEqual(['link']);
  });
});
