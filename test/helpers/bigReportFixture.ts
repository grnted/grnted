// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A large synthetic report modelled on a 25-page scan of a school district site (Plan 5 Task 5.10's
// phone-height budget): 14 failing axe rules with several examples each, core probe failures with
// text evidence on many pages, items axe could not decide, AI review findings, PDFs and 16 evidence
// images. Synthetic content only: never a real site's.
import { buildReport } from '../../src/report/build.js';
import { carryAi } from './carryAi.js';
import type { AiFinding, DocumentCheck, EvidenceShot, Finding, PageAudit, ProbeRun, SiteReport } from '../../src/types.js';

const E = 'https://district.example';
const PATHS = ['/', '/schools', '/schools/lincoln', '/schools/jefferson', '/schools/roosevelt', '/calendar', '/news', '/news/2026/budget',
  '/news/2026/concert', '/board', '/board/meetings', '/board/policies', '/departments', '/departments/transport', '/departments/nutrition',
  '/enroll', '/staff', '/staff/directory', '/contact', '/jobs', '/athletics', '/athletics/schedule', '/parents', '/students', '/about'];
const URLS = PATHS.map((p) => `${E}${p}`);

const RULES: [string, string, number][] = [
  ['image-alt', 'Images must have alternate text', 3],
  ['link-name', 'Links must have discernible text', 4],
  ['color-contrast', 'Elements must meet minimum color contrast ratio thresholds', 6],
  ['label-content-name-mismatch', 'Ensure that elements labelled through their content have their visible text as part of their accessible name', 3],
  ['button-name', 'Buttons must have discernible text', 2],
  ['aria-allowed-attr', 'Elements must only use supported ARIA attributes', 1],
  ['heading-order', 'Heading levels should only increase by one', 1],
  ['list', 'Lists must only directly contain li, script or template elements', 2],
  ['listitem', 'li elements must be contained in a ul or ol', 2],
  ['landmark-one-main', 'Document should have one main landmark', 1],
  ['region', 'All page content should be contained by landmarks', 5],
  ['empty-heading', 'Headings should not be empty', 1],
  ['target-size', 'All touch targets must be 24px large, or leave sufficient space', 4],
  ['link-in-text-block', 'Links must be distinguishable without relying on color', 2],
];

const node = (rule: string, i: number) => ({
  target: `main > section.grid:nth-child(${i + 2}) > div.card-${rule} > a.card__link:nth-child(${i + 1})`,
  html: `<a class="card__link card__link--feature" href="/schools/lincoln/news/2026/10/${rule}-${i}" data-track="home-feature-${i}"><img src="/media/cards/${rule}-${i}.jpg" class="card__img"></a>`,
  viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[],
});

const pages: PageAudit[] = URLS.map((url, p) => ({
  url, status: 'ok', rules: { label: 'pass', 'frame-title': 'inapplicable' },
  // Most rules repeat across the template; a few are page-specific.
  violations: RULES.filter(([, , n], r) => r < 6 || (p + r) % 3 === 0 || n > 3).map(([id, help, n]): Finding => ({
    id, help, helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`, nodes: Array.from({ length: n }, (_, i) => node(id, i)),
  })),
  incomplete: p % 2 === 0 ? ['color-contrast', 'aria-hidden-focus', 'video-caption', 'td-has-header', 'scrollable-region-focusable', 'nested-interactive', 'frame-tested', 'aria-valid-attr-value'].map((id) => ({
    id, help: `axe could not decide ${id}`, helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${id}`, nodes: [node(id, 0), node(id, 1)],
  })) : [],
  links: [],
}));

const probeRuns: ProbeRun[] = URLS.flatMap((page, p): ProbeRun[] => [
  { probe: 'reflow', kind: 'render', page, criteria: ['1.4.10'], status: 'ok', ms: 5,
    findings: [{ criterion: '1.4.10', status: p % 2 ? 'failed' : 'no_failures_found', target: 'table.schedule', detail: 'Content needs a sideways scroll at 320 px: the schedule table is 712 px wide.' }] },
  { probe: 'resize-text', kind: 'render', page, criteria: ['1.4.4'], status: 'ok', ms: 5,
    findings: [{ criterion: '1.4.4', status: 'failed', target: 'h1.hero__title', detail: 'Smaller on screen at 200%: 113 px → 72 px.' }] },
  { probe: 'keyboard', kind: 'interaction', page, criteria: ['2.4.7', '2.4.11'], status: 'ok', ms: 5,
    findings: [
      { criterion: '2.4.7', status: p % 3 ? 'failed' : 'no_failures_found', target: 'nav.main a:nth-child(3)', detail: 'The link “Schools” shows no focus indicator when it has keyboard focus.' },
      { criterion: '2.4.11', status: p % 4 ? 'failed' : 'no_failures_found', target: 'footer a.social', detail: 'After Shift+Tab the link “Facebook” is hidden under the sticky header (96 px).', data: { coverHeight: 96 } },
    ] },
]);

const docs: DocumentCheck[] = Array.from({ length: 8 }, (_, i) => ({
  url: `${E}/board/minutes-2026-0${i + 1}.pdf`, type: 'pdf', detectedBy: 'extension', linkedFrom: [`${E}/board/meetings`],
  checks: { pages: 4 + i, pagesChecked: 4 + i, tagged: i % 2 === 0, hasLanguage: false, hasTitle: i % 3 === 0, showsTitle: false, imageOnly: i === 5, figuresWithoutAlt: 0 },
}));

const finding = (i: number, over: Partial<AiFinding> = {}): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: URLS[i % URLS.length]!, target: `${E}/media/photos/event-${i}.jpg`, verdict: 'insufficient',
  label: 'Description is missing information', flagged: true, confidence: 'high',
  observed: `Students on stage at the spring concert, a banner reading “Spring Concert ${2020 + (i % 6)}” behind them.`,
  issue: 'The alt text names the event but leaves out the date and place shown on the banner.', suggestion: 'Spring concert on stage, May 3 at 7 pm',
  current: { label: 'Current alt text', value: `concert photo ${i}` }, source: 'ai', ...over,
});

const ai = {
  disclaimer: 'This section is an automated AI opinion.',
  runs: [
    { check: 'altText' as const, title: 'Image descriptions (alt text)', summary: 'Checks alt text against the image.', model: 'm', promptVersion: 'altText@1', tier: 'core' as const,
      inputs: 60, reviewed: 40, cached: 0, notReviewed: 0,
      findings: [...Array.from({ length: 18 }, (_, i) => finding(i)), ...Array.from({ length: 12 }, (_, i) => finding(100 + i, { flagged: false, verdict: 'accurate', label: 'Looks right', issue: '' }))] },
    { check: 'pageText' as const, title: 'Page text: titles, links, headings and instructions', summary: 'Checks page text.', model: 'm', promptVersion: 'pageText@1', tier: 'core' as const,
      inputs: 30, reviewed: 30, cached: 0, notReviewed: 0,
      findings: Array.from({ length: 12 }, (_, i) => finding(i, { check: 'pageText', criterion: '2.4.4', target: `${E}/news/${i}`, verdict: 'unclear_purpose', label: 'Link purpose is unclear',
        current: { label: 'Link text', value: 'Read more' }, suggestion: 'Read more about the spring concert', observed: 'A “Read more” link under a news teaser.', issue: 'Several links on the page say only “Read more”.' })) },
  ],
};

const shot = (over: Partial<EvidenceShot> & Pick<EvidenceShot, 'id' | 'for'>): EvidenceShot => ({
  page: `${E}/`, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 1280, height: 600, boxes: [{ x: 100, y: 100, width: 300, height: 120, kind: 'fail' }], alt: 'A screenshot', ...over,
});

/** 16 images: the two start shots, ten rule pictures, two probe pairs. */
export const bigEvidence: EvidenceShot[] = [
  shot({ id: 'e1', for: { rule: '$start' }, width: 1280, height: 900, boxes: [], alt: 'Home page on a desktop screen' }),
  shot({ id: 'e2', for: { rule: '$start' }, viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, width: 390, height: 844, boxes: [], alt: 'Home page on a phone' }),
  ...RULES.slice(0, 10).map(([id], i) => shot({ id: `e${i + 3}`, for: { rule: id }, height: 300 + i * 40, alt: `Page /: elements outlined that fail ${id}` })),
  shot({ id: 'e13', for: { criterion: '1.4.4', probe: 'resize-text' }, group: 'z', groupLabel: 'Browser zoom 100%', height: 500 }),
  shot({ id: 'e14', for: { criterion: '1.4.4', probe: 'resize-text' }, group: 'z', groupLabel: 'Browser zoom 200%', height: 500 }),
  shot({ id: 'e15', for: { criterion: '2.4.11', probe: 'keyboard' }, group: 'f', groupLabel: 'Found: focus hidden', width: 700, height: 300 }),
  shot({ id: 'e16', for: { criterion: '2.4.11', probe: 'keyboard' }, group: 'f', groupLabel: 'Expected: focus in view', width: 700, height: 300 }),
];

/** The large report, with its evidence metadata. */
export function bigReport(): SiteReport {
  const report = buildReport({
    site: `${E}/`, pages, documents: docs.map((d) => d.url), documentChecks: docs, skipped: [],
    startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:03:00.000Z', userAgent: 'UA', ai, extension: carryAi, probeRuns,
  });
  return { ...report, evidence: bigEvidence };
}
