// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// One problem and one cost per page, element and criterion across axe, the scored tests and the AI checks
// (src/crossDedupe.ts): the element keys every method names elements by, and the automated side (a test failure of an
// element axe fails is listed with the rule). The AI side, with the staging e2e's two cases (2026-11-06, scoring v9), is
// the closed AI package's (its aiCrossDedupe.test.ts): "Click here" on /lunch-menu and "the contact page" on /accessibility.
import { describe, expect, it } from 'vitest';
import { axeNodeElements, probeFindingElements, sameElement } from '../../src/aiDedupe.js';
import { reportCriterionChecks } from '../../src/criterionScore.js';
import { linkColorFindings } from '../../src/probes/linkColor.js';
import { linkPurposeFindings } from '../../src/probes/linkPurpose.js';
import { buildReport } from '../../src/report/build.js';
import { buildProblems } from '../../src/report/problems.js';
import type { AiFinding, PageAudit, ProbeRun } from '../../src/types.js';

const SITE = 'https://e.org/';
const ACCESS = 'https://e.org/accessibility';
const base = { site: SITE, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-06T00:00:00Z', userAgent: 'ua' };
const page = (url: string, over: Partial<PageAudit> = {}): PageAudit => ({ url, status: 'ok', rules: {}, violations: [], incomplete: [], links: [], ...over });
const run = (probe: string, url: string, criteria: string[], findings: ProbeRun['findings']): ProbeRun => ({ probe, kind: 'interaction', page: url, criteria, status: 'ok', findings, ms: 1 });
const ai = (over: Partial<AiFinding>): AiFinding => ({
  check: 'pageText', criterion: '2.4.4', page: 'https://e.org/lunch-menu', target: 'https://e.org/documents', verdict: 'not_descriptive', label: 'Link text does not say where it goes',
  flagged: true, confidence: 'high', observed: 'The link says “Click here”.', issue: 'The link says “Click here” with no surrounding context.', suggestion: 's', source: 'ai', scored: true, ...over,
});

// Case 1: the link-purpose test (its real findings function) and the AI page text, on the same "Click here" link.
const purpose = linkPurposeFindings({ links: [{ name: 'click here', text: 'Click here', href: 'https://e.org/documents', target: '#main > p:nth-of-type(2) > a', context: '', contextFrom: 'none' }] });
const pageTextLink = ai({ scoreTested: ['2.4.4'], elements: ['text:click here', 'role:link'] });
// Case 2: axe link-in-text-block, the link-color test (its real findings function) and the AI vision, on "the contact page".
const contactHtml = '<a href="/contact">the contact page</a>';
const axeNode = { target: 'p:nth-child(4) > a[href$="contact"]', html: contactHtml, viewports: ['desktop' as const] };
const colour = linkColorFindings([{
  link: { text: 'the contact page', href: 'https://e.org/contact', context: 'Call 555-0100 or use the form on the contact page.', linkColor: '#33334d', textColor: '#1a1a1a', contrastWithText: 1.4, box: [10, 10, 100, 16], linkRgba: [51, 51, 77, 1], textRgba: [26, 26, 26, 1] },
  ratio: 1.4, outcome: { kind: 'failed', hoverCue: false, focusCue: false },
}], 1);
const visionLink = ai({
  check: 'vision', criterion: '1.4.1', page: ACCESS, target: 'Link "the contact page"', verdict: 'color_only', label: 'Meaning shown only by color',
  observed: 'The contact page link appears within the contact sentence without an underline.', issue: 'Links differ only by colour.', scoreTested: ['1.4.1', '1.3.2', '1.1.1', '4.1.2'],
  elements: ['box:10,10,100,16', 'text:the contact page', 'role:link'],
});
const costKeys = (r: ReturnType<typeof buildReport>) => (reportCriterionChecks(r) ?? []).map((c) => c.key).sort();
const problemsFor = (r: ReturnType<typeof buildReport>, criterion: string) => buildProblems(r).filter((p) => p.criteria.some((c) => c.criterion === criterion));

describe('the element keys across methods', () => {
  it('name the staging cases the same way: axe by selector, text and tag; the tests and the AI by name and role', () => {
    expect(axeNodeElements(axeNode)).toEqual(['sel:p:nth-child(4) > a[href$="contact"]', 'text:the contact page', 'role:link']);
    expect(probeFindingElements(colour[0]!)).toEqual(['text:the contact page', 'role:link']);
    expect(probeFindingElements(purpose[0]!)).toEqual(['sel:#main > p:nth-of-type(2) > a', 'text:click here', 'role:link']);
    expect(sameElement(axeNodeElements(axeNode), probeFindingElements(colour[0]!))).toBe(true);
    expect(sameElement(visionLink.elements!, axeNodeElements(axeNode))).toBe(true);
    expect(sameElement(pageTextLink.elements!, probeFindingElements(purpose[0]!))).toBe(true);
  });

  it('never match on a role alone, and a different role vetoes a shared name', () => {
    expect(sameElement(['text:contact', 'role:link'], ['text:contact', 'role:heading'])).toBe(false);
    expect(sameElement(['role:link'], ['role:link'])).toBe(false);
    expect(sameElement(['text:contact'], ['text:contact', 'role:heading'])).toBe(true);
    // A target read as role and name, or as a CSS path; free text names nothing.
    expect(probeFindingElements({ target: 'link “Read more”' })).toEqual(['text:read more', 'role:link']);
    expect(probeFindingElements({ target: '#main > a' })).toEqual(['sel:#main > a', 'tag:a']);
    expect(probeFindingElements({ target: 'the page as a whole' })).toEqual([]);
  });
});

describe('one element whose axe selector is a bare tag (unique on its page)', () => {
  it('is the same element as a test path ending in that tag: the table on /events, the html element on /accessibility', () => {
    expect(sameElement(axeNodeElements({ target: 'table', html: '<table>' }), probeFindingElements({ target: '#main > table' }))).toBe(true);
    expect(sameElement(axeNodeElements({ target: 'html', html: '<html lang="en">' }), probeFindingElements({ target: 'html' }))).toBe(true);
    // A path ending in a qualified compound, another tag, or a word that is not a path: no match.
    expect(sameElement(axeNodeElements({ target: 'table', html: '<table>' }), probeFindingElements({ target: '#main > table:nth-of-type(2)' }))).toBe(false);
    expect(sameElement(axeNodeElements({ target: 'table', html: '<table>' }), probeFindingElements({ target: '#main > ul' }))).toBe(false);
    expect(probeFindingElements({ target: 'button' })).toEqual([]);
    // Two tests' paths never meet on a tag alone (only axe's selector says the tag is unique).
    expect(sameElement(['tag:table'], ['text:fees'])).toBe(false);
  });

  it('a test failure of it is listed with the axe rule and costs nothing: orientation and css-orientation-lock (1.3.4)', () => {
    const r = buildReport({
      ...base, pages: [page(SITE), page(ACCESS, { rules: { 'css-orientation-lock': 'fail' }, violations: [{ id: 'css-orientation-lock', help: 'h', helpUrl: 'u', nodes: [{ target: 'html', html: '<html lang="en">', viewports: ['mobile' as const] }] }] })],
      probeRuns: [run('orientation', ACCESS, ['1.3.4'], [{ criterion: '1.3.4', status: 'failed', target: 'html', detail: 'On a phone in portrait the page is turned 90 degrees.' }])],
    });
    expect(problemsFor(r, '1.3.4').map((p) => p.key)).toEqual(['rule:css-orientation-lock']);
    expect(costKeys(r)).toEqual(['rule:css-orientation-lock']);
    expect(problemsFor(r, '1.3.4')[0]!.alsoFound?.map((a) => a.by)).toEqual(['test']);
  });
});

describe('a test failure of another element on /accessibility', () => {
  it('still counts next to the axe rule that keeps the contact page link', () => {
    const other = linkColorFindings([{
      link: { text: 'opening hours', href: 'https://e.org/hours', context: 'See the opening hours for this week.', linkColor: '#33334d', textColor: '#1a1a1a', contrastWithText: 1.4, box: [10, 40, 80, 16], linkRgba: [51, 51, 77, 1], textRgba: [26, 26, 26, 1] },
      ratio: 1.4, outcome: { kind: 'failed', hoverCue: false, focusCue: false },
    }], 1);
    const r = buildReport({
      ...base, pages: [page(SITE), page(ACCESS, { rules: { 'link-in-text-block': 'fail' }, violations: [{ id: 'link-in-text-block', help: 'h', helpUrl: 'u', nodes: [axeNode] }] })],
      probeRuns: [run('link-color', ACCESS, ['1.4.1'], [...colour, ...other])],
    });
    expect(costKeys(r)).toEqual(['criterion:1.4.1', 'rule:link-in-text-block']);
    expect(r.probes!.runs[0]!.findings.map((f) => f.coveredBy ?? null)).toEqual(['rule:link-in-text-block', null]);
  });
});
