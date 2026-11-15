// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness (general fixtures, no site's data):
// - examples: a rule failing 64 elements in 9 patterns showed 3 examples, all of one repeated header element, and the
//   developer brief showed the same 3, so the clear one-page failures (a map link named for something else, board
//   member links) were in no output. Each pattern now has an example (rules[].signatures lists every pattern with
//   one), the 3 examples cover different patterns and pages, the brief and the plain HTML show one per pattern.
// - a test's evidence: 7 pages failing, all 3 examples from one page. Evidence now takes one per page first, clear
//   failures before minor ones, and never the same line twice (the same failure at both widths).
// - clipping: evidence cut mid-word ("fixed or sticky con…") and selectors cut mid-token ("a:nth-o..."): cut at a word
//   boundary with an ellipsis; a long selector keeps its start and its last steps (the element itself).
import { describe, expect, it } from 'vitest';
import { clipPath, clipWords } from '../../src/clip.js';
import { label } from '../../src/probes/keyboard/rules.js';
import { excerpt } from '../../src/probes/layout.js';
import { buildReport } from '../../src/report/build.js';
import { cleanItem, fixPrompt } from '../../src/report/fixPrompt.js';
import { renderPlainHtml } from '../../src/report/plain.js';
import { buildProblems } from '../../src/report/problems.js';
import type { PageAudit, ProbeFinding, ProbeRun } from '../../src/types.js';

const U = (p: string) => `https://e.org${p}`;
const PAGES = ['/', '/about', '/board', '/contact', '/news', '/schools', '/calendar'];
const base = { site: U('/'), documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-04T00:00:00Z', userAgent: 'ua' };
const node = (target: string, html: string) => ({ target, html, viewports: ['desktop' as const] });

// The header's logo link fails on every page (two patterns: header and footer copies); 8 one-page patterns elsewhere.
const ONE_PAGE: Record<string, [string, string][]> = {
  '/board': [['#m1', '<a class="member" href="/board/1">View member</a>'], ['#m2', '<a class="member" href="/board/2">View member</a>']],
  '/contact': [['#map', '<a class="map-link" href="https://maps.example/x">120 Alder Lane</a>']],
  '/news': [['#more', '<a class="more" href="/news/1">Read more</a>']],
  '/schools': [['#card1', '<a class="school-card" href="/s/1">Elementary</a>'], ['#card2', '<a class="school-card big" href="/s/2">Middle</a>']],
  '/calendar': [['#ics', '<a class="ics" href="/c.ics">Add</a>']],
  '/about': [['#pdf', '<a class="doc" href="/a.pdf">Plan</a>']],
};
function ruleReport() {
  const pages: PageAudit[] = PAGES.map((p) => {
    const nodes = [node('header > a.logo', '<a class="logo" href="/">Example District</a>'), node('footer > a.logo', '<a class="logo footer" href="/">Example District</a>'),
      ...(ONE_PAGE[p] ?? []).map(([t, h]) => node(t, h))];
    return { url: U(p), status: 'ok', rules: { 'link-name': 'fail' }, violations: [{ id: 'link-name', help: 'Links must have discernible text', helpUrl: 'https://x', nodes }], incomplete: [], links: [] } as PageAudit;
  });
  return buildReport({ ...base, pages });
}
const sigOf = (html: string) => html.replace(/ href="[^"]*"/, '').replace(/>.*$/, '>');

describe('a rule: every pattern has an example, and every output shows one per pattern', () => {
  const report = ruleReport();
  const rule = report.rules.find((r) => r.id === 'link-name')!;
  // 10 patterns: a signature keeps the address, so the two member links are two patterns.
  it('rules[].signatures lists every pattern (10, more than the old 5), each with an example', () => {
    expect(rule.signatures!.length).toBe(10);
    for (const s of rule.signatures!) {
      expect(s.example, s.sig).toBeDefined();
      expect(s.example!.html).toContain('<a');
      expect(PAGES.map(U)).toContain(s.example!.page);
    }
  });
  it('the 3 examples are of 3 different patterns on 3 different pages', () => {
    expect(rule.examples).toHaveLength(3);
    expect(new Set(rule.examples.map((e) => e.page)).size).toBe(3);
    expect(new Set(rule.examples.map((e) => sigOf(e.html))).size).toBe(3);
  });
  it('the developer brief shows an example of every pattern, the one-page ones included', () => {
    const brief = fixPrompt(report, { audience: 'developer' });
    for (const html of ['120 Alder Lane', 'View member', 'Read more', 'Elementary', 'Add</a>', 'Plan</a>']) expect(brief, html).toContain(html);
  });
  it('the plain HTML shows one item per pattern, and never the same element twice', () => {
    const html = renderPlainHtml(report);
    for (const t of ['120 Alder Lane', 'View member', 'Read more', 'Elementary', 'Middle']) expect(html, t).toContain(t);
    const items = [...html.matchAll(/<li>([^]*?)<\/li>/g)].map((m) => m[1]!).filter((li) => li.includes('logo'));
    expect(new Set(items).size, items.join('\n')).toBe(items.length);
    expect(html).not.toMatch(/Failing element: &lt;a class=&quot;logo/);
  });
});

const run = (page: string, findings: ProbeFinding[]): ProbeRun => ({ probe: 'keyboard', kind: 'interaction', page: U(page), criteria: ['2.4.7'], status: 'ok', ms: 1, findings });
const f = (target: string, detail: string, minor = false): ProbeFinding => ({ criterion: '2.4.7', status: 'failed', target, detail, ...(minor ? { minor: true as const } : {}) });

describe("a test's evidence: one per page first, clear failures first, no line twice", () => {
  it('7 failing pages: the 3 examples come from 3 different pages', () => {
    const runs = PAGES.map((p, i) => run(p, i === 0 ? [f('a.1', 'one'), f('a.2', 'two'), f('a.3', 'three')] : [f(`b.${i}`, `page ${i}`)]));
    const report = buildReport({ ...base, pages: PAGES.map((p) => ({ url: U(p), status: 'ok', rules: {}, violations: [], incomplete: [], links: [] } as PageAudit)), probeRuns: runs });
    const issue = report.testIssues!.find((t) => t.criterion === '2.4.7')!;
    expect(new Set(issue.evidence.map((e) => e.page)).size, JSON.stringify(issue.evidence)).toBe(3);
  });
  it('a clear failure before a minor one', () => {
    const runs = [run('/', [f('a.minor', 'minor one', true)]), run('/about', [f('a.clear', 'clear one')])];
    const report = buildReport({ ...base, pages: ['/', '/about'].map((p) => ({ url: U(p), status: 'ok', rules: {}, violations: [], incomplete: [], links: [] } as PageAudit)), probeRuns: runs });
    expect(report.testIssues!.find((t) => t.criterion === '2.4.7')!.evidence[0]!.target).toBe('a.clear');
  });
  it('the same failure at both widths is one line, in the report and in both briefs', () => {
    const same = 'A form field’s boundary has 1.7:1 contrast with the colors next to it';
    // Once from the desktop width and once from the phone width, in one run.
    const runs = [run('/board', [f('#q', same), f('#q', same)]), run('/calendar', [f('#d', 'Go to date: 1.7:1')])];
    const report = buildReport({ ...base, pages: ['/board', '/calendar'].map((p) => ({ url: U(p), status: 'ok', rules: {}, violations: [], incomplete: [], links: [] } as PageAudit)), probeRuns: runs });
    const p = buildProblems(report).find((x) => x.criteria.some((c) => c.criterion === '2.4.7'))!;
    expect(p.textEvidence.filter((e) => e.detail === same)).toHaveLength(1);
    for (const audience of ['developer', 'content'] as const) {
      const brief = fixPrompt(report, { audience });
      expect(brief.split(same).length - 1, audience).toBeLessThanOrEqual(1);
    }
  });
});

describe('clipping at a word boundary', () => {
  it('cuts after a whole word and adds an ellipsis; never mid-word', () => {
    const s = 'is entirely hidden behind html > body > header (fixed or sticky content) when it receives keyboard focus';
    const c = clipWords(s, 80);
    expect(c.length).toBeLessThanOrEqual(80);
    expect(c.endsWith('…')).toBe(true);
    expect(s.startsWith(c.slice(0, -1))).toBe(true);
    expect(s[c.length - 1]).toMatch(/\s|[,;:(]/);
    expect(clipWords('short', 80)).toBe('short');
    // HTML keeps its tags whole: a cut after "</li>" never leaves "</li".
    expect(clipWords('<ul> <li>Monday: soup</li> <li>Tuesday: pasta</li> <li>Wednesday: rice</li>', 40)).toBe('<ul> <li>Monday: soup</li> <li>Tuesday…');
    expect(clipWords('<ul> <li>Monday: soup</li> <li>Tuesday: pasta</li>', 34)).toBe('<ul> <li>Monday: soup</li>…');
  });
  it("the tests' text excerpts (a floating box's words) end on a whole word", () => {
    const e = excerpt('Riverbend School District Riverbend · Valley County About Board Contact Budget', 60);
    expect(e).toBe('Riverbend School District Riverbend · Valley County About…');
  });
  it('a selector keeps its first step and its last steps', () => {
    const path = '#section-6abfef92c4b4b1060c1cedde > section > div > div:nth-of-type(2) > p:nth-of-type(3) > a:nth-of-type(2)';
    const c = clipPath(path, 70);
    expect(c.length).toBeLessThanOrEqual(70);
    expect(c.startsWith('#section-6abfef92c4b4b1060c1cedde > ')).toBe(true);
    expect(c.endsWith(' > a:nth-of-type(2)')).toBe(true);
    expect(c).toContain('…');
  });
  it("the keyboard test's element label keeps the element's own step; the brief's items cut at a word", () => {
    const path = '#section-6abfef92c4b4b1060c1cedde > section > div > div:nth-of-type(2) > p:nth-of-type(3) > a:nth-of-type(2)';
    expect(label('call the district office', path)).toMatch(/a:nth-of-type\(2\)\)$/);
    const item = cleanItem('word '.repeat(80).trim(), 100);
    expect(item).toMatch(/^(word )+word…$/);
  });
});
