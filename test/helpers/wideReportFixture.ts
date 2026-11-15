// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The widest report the renderer can produce, for the print-scale guard (reportPrintScale.test.ts): the
// heat table at its caps (25 pages by 20 problems), long unbroken URLs and page names everywhere a site
// controls one, the interaction table at its page cap, long code samples and selectors, a wide documents
// table, media, an AI review with long unbroken values, and very wide and very tall pictures. Synthetic
// content only: never a real site's.
import { buildReport } from '../../src/report/build.js';
import { carryAi } from './carryAi.js';
import type { AiFinding, DocumentCheck, EvidenceShot, Finding, PageAudit, ProbeRun, SiteReport } from '../../src/types.js';

const E = 'https://www.averyveryverylongschooldistrictname-and-more-words-joined.example';
/** A path segment with no place to break. */
const unbroken = (n: number, seed: string) => `${seed}${'abcdefghij'.repeat(n)}`;
export const WIDE_URLS = Array.from({ length: 25 }, (_, i) => `${E}/${i ? `${unbroken(10, `section${i}`)}/${unbroken(6, 'page')}?id=${unbroken(4, 'q')}` : ''}`);

const RULES: [string, string][] = [
  ['image-alt', 'Images must have alternate text'], ['link-name', 'Links must have discernible text'],
  ['color-contrast', 'Elements must meet minimum color contrast ratio thresholds'], ['button-name', 'Buttons must have discernible text'],
  ['label-content-name-mismatch', 'Ensure that elements labelled through their content have their visible text as part of their accessible name'],
  ['aria-allowed-attr', 'Elements must only use supported ARIA attributes'], ['heading-order', 'Heading levels should only increase by one'],
  ['list', 'Lists must only directly contain li, script or template elements'], ['listitem', 'li elements must be contained in a ul or ol'],
  ['landmark-one-main', 'Document should have one main landmark'], ['region', 'All page content should be contained by landmarks'],
  ['empty-heading', 'Headings should not be empty'], ['target-size', 'All touch targets must be 24px large, or leave sufficient space'],
  ['link-in-text-block', 'Links must be distinguishable without relying on color'], ['html-has-lang', '<html> element must have a lang attribute'],
  ['document-title', 'Documents must have <title> element to aid in navigation'], ['frame-title', 'Frames must have an accessible name'],
  ['input-image-alt', 'Image buttons must have alternate text'], ['select-name', 'Select element must have an accessible name'],
  ['label', 'Form elements must have labels'], ['aria-required-attr', 'Required ARIA attributes must be provided'],
  ['meta-viewport', 'Zooming and scaling must not be disabled'], ['bypass', 'Page must have means to bypass repeated blocks'],
];

const node = (rule: string, i: number) => ({
  target: `main>section.${unbroken(8, 'grid')}:nth-child(${i + 2})>div.${unbroken(6, `card-${rule}`)}>a.card__link:nth-child(${i + 1})`,
  html: `<a class="${unbroken(6, 'cls')}" href="/${unbroken(30, rule)}" data-track="${unbroken(10, 'trk')}"><img src="/${unbroken(20, 'media')}.jpg"></a>`,
  viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[],
});

const pages: PageAudit[] = WIDE_URLS.map((url, p) => ({
  url, status: 'ok', rules: { label: 'pass' },
  violations: RULES.map(([id, help], r): Finding => ({ id, help, helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`, nodes: Array.from({ length: 1 + ((p + r) % 3) }, (_, i) => node(id, i)) })),
  incomplete: p % 3 === 0 ? ['color-contrast', 'aria-hidden-focus', 'video-caption'].map((id) => ({ id, help: `axe could not decide ${id}`, helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`, nodes: [node(id, 0)] })) : [],
  links: [],
}));

const probeRuns: ProbeRun[] = WIDE_URLS.flatMap((page, p): ProbeRun[] => [
  { probe: 'reflow', kind: 'render', page, criteria: ['1.4.10'], status: 'ok', ms: 5,
    findings: [{ criterion: '1.4.10', status: p % 2 ? 'failed' : 'no_failures_found', target: `table.${unbroken(8, 'schedule')}`, detail: `Content scrolls sideways at 320 px: ${unbroken(12, 'table')} is 712 px wide.` }] },
  { probe: 'keyboard', kind: 'interaction', page, criteria: ['2.4.7', '2.4.11', '2.1.2'], status: 'ok', ms: 5,
    findings: [
      { criterion: '2.4.7', status: p % 3 ? 'failed' : 'no_failures_found', target: `nav.${unbroken(8, 'main')} a:nth-child(3)`, detail: `The link “${unbroken(8, 'Schools')}” shows no focus indicator.` },
      { criterion: '2.4.11', status: p % 4 ? 'failed' : 'no_failures_found', target: `footer a.${unbroken(8, 'social')}`, detail: 'After Shift+Tab the link is hidden under the sticky header (96 px).', data: { coverHeight: 96 } },
      { criterion: '2.1.2', status: p % 5 ? 'no_failures_found' : 'failed', target: `div.${unbroken(8, 'trap')}`, detail: `Focus stays inside ${unbroken(10, 'widget')}.` },
    ] },
  { probe: 'hover-content', kind: 'interaction', page, criteria: ['1.4.13'], status: 'ok', ms: 5,
    findings: [{ criterion: '1.4.13', status: p % 2 ? 'failed' : 'no_failures_found', target: `li.${unbroken(8, 'menu')}`, detail: `The submenu ${unbroken(10, 'menu')} closes when the pointer moves onto it.` }] },
]);

const docs: DocumentCheck[] = Array.from({ length: 14 }, (_, i) => ({
  url: `${E}/${unbroken(12, 'documents')}/minutes-${unbroken(8, `meeting${i}`)}.pdf`, type: 'pdf', detectedBy: 'extension', linkedFrom: [WIDE_URLS[i % 25]!],
  checks: { pages: 4 + i, pagesChecked: 4 + i, tagged: i % 2 === 0, hasLanguage: false, hasTitle: i % 3 === 0, showsTitle: false, imageOnly: i === 5, figuresWithoutAlt: i },
}));

const finding = (i: number, over: Partial<AiFinding> = {}): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: WIDE_URLS[i % 25]!, target: `${E}/${unbroken(14, 'media')}/photo-${i}.jpg`, verdict: 'insufficient',
  label: 'Description is missing information', flagged: true, confidence: 'high',
  observed: `A banner reading ${unbroken(12, 'SpringConcert')} behind the stage.`, issue: `The alt text leaves out ${unbroken(10, 'details')}.`,
  suggestion: unbroken(14, 'Suggestion'), current: { label: 'Current alt text', value: unbroken(16, 'alt') }, source: 'ai', ...over,
});

const ai = {
  disclaimer: 'This section is an automated AI opinion.',
  runs: [
    { check: 'altText' as const, title: 'Image descriptions (alt text)', summary: 'Checks alt text against the image.', model: 'm', promptVersion: 'altText@1', tier: 'core' as const,
      inputs: 20, reviewed: 20, cached: 0, notReviewed: 0, findings: Array.from({ length: 10 }, (_, i) => finding(i)) },
    { check: 'pageText' as const, title: 'Page text: titles, links, headings and instructions', summary: 'Checks page text.', model: 'm', promptVersion: 'pageText@1', tier: 'core' as const,
      inputs: 10, reviewed: 10, cached: 0, notReviewed: 0,
      findings: Array.from({ length: 6 }, (_, i) => finding(i, { check: 'pageText', criterion: '2.4.4', target: `${E}/${unbroken(14, 'news')}`, verdict: 'unclear_purpose', label: 'Link purpose is unclear',
        current: { label: 'Link text', value: unbroken(12, 'Readmore') } })) },
  ],
};

const shot = (over: Partial<EvidenceShot> & Pick<EvidenceShot, 'id' | 'for'>): EvidenceShot => ({
  page: WIDE_URLS[0]!, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 1280, height: 600,
  boxes: [{ x: 100, y: 100, width: 300, height: 120, kind: 'fail', problem: 'axe:image-alt' }], alt: 'A screenshot', ...over,
});

/** The start shots, a very wide and a very tall rule picture, a pair. */
export const wideEvidence: EvidenceShot[] = [
  shot({ id: 'w1', for: { rule: '$start' }, width: 1280, height: 900, alt: 'Home page on a desktop screen' }),
  shot({ id: 'w2', for: { rule: '$start' }, viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, width: 390, height: 844, alt: 'Home page on a phone' }),
  shot({ id: 'w3', for: { rule: 'image-alt' }, width: 3200, height: 260, alt: 'A very wide picture' }),
  shot({ id: 'w4', for: { rule: 'link-name' }, width: 390, height: 4000, alt: 'A very tall picture' }),
  shot({ id: 'w5', for: { criterion: '2.4.11', probe: 'keyboard' }, group: 'f', groupLabel: unbroken(6, 'Found'), width: 2400, height: 300 }),
  shot({ id: 'w6', for: { criterion: '2.4.11', probe: 'keyboard' }, group: 'f', groupLabel: unbroken(6, 'Expected'), width: 2400, height: 300 }),
];

/** The wide report, with its evidence metadata. */
export function wideReport(): SiteReport {
  const report = buildReport({
    site: WIDE_URLS[0]!, pages, documents: docs.map((d) => d.url), documentChecks: docs, skipped: [{ url: `${E}/${unbroken(20, 'skipped')}`, reason: 'Outside the site' }],
    startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:03:00.000Z', userAgent: 'UA', ai, extension: carryAi, probeRuns,
  });
  return { ...report, evidence: wideEvidence };
}
