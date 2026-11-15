// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A fully populated report for the HTML report tests (unit and dogfood): every section, every
// markup variant, hostile strings in every field the scanned site or a model controls, and
// evidence images (the start page at desktop and phone width, a single image, a pair, an AI thumbnail). Synthetic content
// only: never a real site's.
import { mediaIssues } from '../../src/media/index.js';
import { AI_DISCLAIMER } from '../../src/report/ai.js';
import { buildReport } from '../../src/report/build.js';
import { carryAi } from './carryAi.js';
import type { AiCheckRun, AiFinding, DocumentCheck, EvidenceShot, Finding, MediaItem, PageAudit, ProbeRun, SiteReport } from '../../src/types.js';

export const hostile = '<script>alert(1)</script>';
/** A string that would break out of an attribute or a style value if it were not escaped. */
export const breakout = `"'><img src=x onerror=alert(2)>`;
export const E = 'https://school.example';

const finding = (id: string, help: string, pageNodes = 1): Finding =>
  ({ id, help, helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
    nodes: Array.from({ length: pageNodes }, (_, i) => ({ target: `#${id}-${i}`, html: `<div>${hostile}</div>`, viewports: ['desktop', 'mobile'] as ('desktop' | 'mobile')[] })) });

const pages: PageAudit[] = [
  // No form fields anywhere, so the form criteria are "not applicable".
  { url: `${E}/`, status: 'ok', rules: { label: 'inapplicable', 'frame-title': 'pass' },
    violations: [finding('image-alt', `Images must have alternate text ${hostile}`), finding('link-name', 'Links must have discernible text')],
    incomplete: [finding('color-contrast', 'Elements must meet minimum color contrast ratio thresholds')], links: [],
    thirdParty: [{ url: `https://www.youtube.com/embed/aBcDeFgHiJ0?${hostile}`, violations: [finding('aria-allowed-attr', 'Elements must only use supported ARIA attributes')] }],
    untestedFrames: [{ url: 'javascript:alert(1)', reason: `The test could not run inside the frame: ${hostile}` }] },
  { url: `${E}/events`, status: 'ok', rules: { label: 'inapplicable' }, violations: [finding('link-name', 'Links must have discernible text', 2)], incomplete: [], links: [] },
  { url: `${E}/news?q=${breakout}`, status: 'ok', rules: { label: 'inapplicable' }, violations: [finding('link-name', 'Links must have discernible text')], incomplete: [], links: [] },
  { url: `${E}/broken`, status: 'failed', reason: `HTTP 500 ${hostile}`, rules: {}, violations: [], incomplete: [], links: [] },
];

const docs: DocumentCheck[] = [
  { url: `${E}/board/calendar.pdf`, type: 'pdf', detectedBy: 'extension', linkedFrom: [`${E}/`], accessibleAlternative: `${E}/board/calendar-accessible.pdf`,
    checks: { pages: 2, pagesChecked: 2, tagged: false, hasLanguage: false, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0 } },
  { url: `${E}/board/calendar-accessible.pdf`, type: 'pdf', detectedBy: 'extension', linkedFrom: [`${E}/`],
    checks: { pages: 2, pagesChecked: 2, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0 } },
  { url: `${E}/budget/${encodeURIComponent(hostile)}.pdf`, type: 'pdf', detectedBy: 'extension', linkedFrom: [`${E}/events`],
    checks: { pages: 96, pagesChecked: 20, tagged: false, hasLanguage: false, hasTitle: false, showsTitle: false, imageOnly: true, figuresWithoutAlt: 0 } },
  { url: `${E}/minutes.docx`, type: 'word', detectedBy: 'extension', linkedFrom: [], notChecked: 'Only PDFs are checked in this version' },
];

const withIssues = (m: Omit<MediaItem, 'issues'>): MediaItem => ({ ...m, issues: mediaIssues(m) });
const media: MediaItem[] = [
  withIssues({ kind: 'video', content: 'video', audio: 'present', url: `${E}/media/welcome.mp4`, foundOn: [`${E}/events`], tracks: [], autoplay: false, muted: false, controls: true, captions: 'none' }),
  withIssues({ kind: 'embed', content: 'video', url: 'https://www.youtube.com/embed/aBcDeFgHiJ0', foundOn: [`${E}/`], player: 'youtube', videoId: 'aBcDeFgHiJ0', captions: 'check-manually' }),
];

const f = (over: Partial<AiFinding>): AiFinding => ({
  check: 'altText', criterion: '1.1.1', page: `${E}/`, target: `${E}/images/flyer.png`, verdict: 'insufficient', label: `Description is missing information ${hostile}`,
  flagged: true, confidence: 'high', observed: `A flyer ${hostile}`, issue: `The alt text leaves out the date. ${hostile}`, suggestion: 'Spring concert, May 3 at 7 pm',
  current: { label: 'Current alt text', value: `flyer ${breakout}` }, source: 'ai', ...over,
});
const run = (check: AiCheckRun['check'], title: string, findings: AiFinding[], tier: AiCheckRun['tier'] = 'core'): AiCheckRun => ({
  check, title, summary: `What ${title} looks at.`, model: 'model-a', promptVersion: `${check}@1`, tier, inputs: findings.length + 2, reviewed: findings.length, cached: 1, notReviewed: 0, findings,
});
export const ai = { disclaimer: AI_DISCLAIMER, runs: [
  run('altText', 'Image descriptions (alt text)', [
    f({}),
    f({ verdict: 'image_of_text', criterion: '1.4.5', target: `${E}/images/poster.png`, label: 'Text shown as an image', suggestion: 'Put the text on the page and keep the image as a picture.' }),
    f({ verdict: 'should_be_decorative', label: 'Should be marked decorative', suggestion: '' }),
    f({ target: `${E}/images/logo.png`, verdict: 'accurate', label: 'Looks right', flagged: false, issue: '', suggestion: '' }),
    f({ target: 'inline image', verdict: 'suggested_alt', label: 'Suggested alt text for an image axe already reported', flagged: false, current: undefined }),
    f({ target: `${E}/images/blank.png`, verdict: 'cannot_judge', label: 'The AI could not tell', flagged: false, current: { label: 'Current alt text (marked decorative)', value: '' } }),
  ]),
  run('pageText', 'Page text: titles, links, headings and instructions', [
    f({ check: 'pageText', criterion: '2.4.4', target: `${E}/news/1`, verdict: 'unclear_purpose', label: 'Link purpose is unclear', current: { label: 'Link text', value: 'Read more' }, suggestion: 'Read more about the spring concert' }),
    f({ check: 'pageText', criterion: '2.4.2', target: 'Home', verdict: 'duplicate_title', label: 'Same page title on several pages', source: 'rules', current: { label: 'Page title', value: 'Home' }, suggestion: '' }),
    f({ check: 'pageText', criterion: '2.4.6', target: '12 of 12 headings', verdict: 'looked_fine', label: 'Looked fine', flagged: false, current: undefined }),
  ]),
  run('vision', 'Visual review (color, reading order, icons)', [
    f({ check: 'vision', criterion: '1.4.1', target: 'Link "calendar"', verdict: 'color_only_link', label: 'Link shown only by color', current: undefined, suggestion: '' }),
  ]),
  run('document', 'PDF documents: figures, headings, reading order and forms', [
    f({ check: 'document', page: `${E}/board/calendar.pdf`, target: 'Figure 1 on page 2', verdict: 'inaccurate', label: 'Figure description does not match the figure', suggestion: 'A map of the bus routes.' }),
    f({ check: 'document', page: `${E}/board/big.pdf`, target: 'Whole document (31 pages)', verdict: 'not_reviewed', label: 'Not reviewed', flagged: false, criterion: '1.1.1, 1.3.1',
      issue: 'Not sent: 31 pages, over the 30-page limit.', current: undefined }),
  ], 'deep'),
  run('media', 'Media review (captions and audio description)', [
    f({ check: 'media', criterion: '1.2.2', page: `${E}/events`, target: `${E}/media/intro.mp4`, verdict: 'captions_inaccurate', label: 'Captions do not match the speech', current: undefined, suggestion: '' }),
    f({ check: 'media', criterion: '1.2.3, 1.2.5', page: `${E}/events`, target: `${E}/media/intro.mp4`, verdict: 'visuals_covered_by_audio', label: 'What is shown is also said', flagged: false, current: undefined }),
  ], 'deep'),
] };

const shot = (over: Partial<EvidenceShot> & Pick<EvidenceShot, 'id' | 'for'>): EvidenceShot => ({
  page: `${E}/`, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 }, width: 640, height: 400, boxes: [], alt: `A screenshot ${hostile}`, ...over,
});

/** Evidence: the desktop start page, a rule image with three boxes, a 1.4.10 pair, an AI thumbnail, the phone start page. */
export const evidence: EvidenceShot[] = [
  // The start page at desktop and phone width ("Homepage, as checked"), boxes keyed by problem.
  shot({ id: 'e1', for: { rule: '$start' }, width: 1280, height: 900, alt: `The start page of the site ${hostile}`, caption: 'Start page',
    boxes: [{ x: 40, y: 20, width: 220, height: 60, kind: 'fail', problem: 'rule:link-name' }, { x: 700, y: 300, width: 400, height: 240, kind: 'fail', problem: 'rule:image-alt' },
      { x: 0, y: 0, width: 30, height: 30, kind: 'fail', problem: `rule:${breakout}` }] }),
  shot({ id: 'e2', for: { rule: 'link-name' }, alt: `Three cards; each card link is outlined ${breakout}`, caption: `Cards on the home page ${hostile}`,
    boxes: [
      { x: 64, y: 40, width: 160, height: 300, kind: 'fail', label: '1' },
      { x: 240, y: 40, width: 160, height: 300, kind: 'fail', label: `2${breakout}` },
      // Partly outside the image: clamped. Zero size and NaN: dropped.
      { x: 600, y: 360, width: 200, height: 100, kind: 'fail', label: '3' },
      { x: 10, y: 10, width: 0, height: 20, kind: 'fail' },
      { x: Number.NaN, y: 10, width: 10, height: 20, kind: 'fail' },
    ] }),
  shot({ id: 'e3', page: `${E}/events`, for: { criterion: '1.4.10', probe: 'reflow' }, group: 'g1', groupLabel: `Width 1280 px ${hostile}`, viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    alt: 'The events page at full width', boxes: [{ x: 20, y: 20, width: 300, height: 80, kind: 'expected', label: 'fits' }] }),
  shot({ id: 'e4', page: `${E}/events`, for: { criterion: '1.4.10', probe: 'reflow' }, group: 'g1', groupLabel: 'Width 320 px', viewport: { width: 320, height: 900, deviceScaleFactor: 1 },
    width: 320, height: 400, alt: 'The events page at 320 px: the table runs off the right edge', caption: 'The table needs a sideways scroll at 320 px.',
    boxes: [{ x: 10, y: 120, width: 300, height: 140, kind: 'fail', label: '412 px' }, { x: 10, y: 20, width: 80, height: 30, kind: 'ghost' }] }),
  shot({ id: 'e5', for: { ai: `${E}/images/flyer.png` }, width: 300, height: 200, alt: 'A flyer for the spring concert' }),
  shot({ id: 'e6', for: { rule: '$start' }, viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, width: 390, height: 844, alt: 'The start page on a phone screen',
    boxes: [{ x: 16, y: 400, width: 358, height: 200, kind: 'fail', problem: 'rule:image-alt' }, { x: 300, y: 10, width: 60, height: 40, kind: 'fail', problem: 'rule:link-name' }] }),
];

/** The fully populated report, with evidence. */
/** `extraProbeRuns`: test runs added to the report's own (for a test that needs a criterion's page test to have run). */
export function fullReport(opts: { extraProbeRuns?: ProbeRun[] } = {}): SiteReport {
  const report = buildReport({
    // A monitoring scan (docs/monitoring.md): /events had not changed, its audit carried forward.
    site: `${E}/`, pages: pages.map((p) => (p.url === `${E}/events` ? { ...p, unchangedSince: '2026-10-01T00:00:00.000Z' } : p)),
    incremental: { full: false, pages: pages.length, checked: pages.length - 1, unchanged: 1, skipped: { lastmod: 0, notModified: 1, sameHtml: 0 } },
    documents: docs.map((d) => d.url), documentChecks: docs, media, skipped: [{ url: `${E}/private`, reason: `Blocked by robots.txt ${hostile}` }],
    startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA', ai, extension: carryAi,
    criteriaExtra: [{ criterion: '2.1.2', method: { id: 'keyboard', kind: 'interaction', status: 'failed', pages: 1, note: 'Tab traversal' },
      evidence: [{ page: `${E}/`, target: '#date-picker', detail: `Focus is trapped in the date picker ${hostile}` }] }],
    screenReader: {
      voice: 'nvda', morePages: 1,
      pages: [
        {
          page: `${E}/`, failed: [{ criterion: '4.1.2', detail: `A button has no name ${hostile}` }],
          read: {
            v: 1, voice: 'nvda', truncated: false,
            read: [
              { n: 0, text: 'banner landmark' }, { n: 1, text: `link, Riverbend ${hostile}` }, { n: 2, text: 'heading level 1, Welcome' },
              { n: 3, text: 'button', flag: 0 }, { n: 40, text: 'link, Read more', flag: 1 },
            ],
            lists: { headings: ['heading level 1, Welcome'], landmarks: ['banner landmark', 'main landmark'], links: [`link, ${hostile}`, 'link, Read more'], formControls: ['button'], tables: [] },
            tab: ['link, Riverbend', 'button'],
            flags: [{ criterion: '4.1.2', note: 'button with no name' }, { criterion: '', note: `2 links named “Read more” go to different places ${hostile}` }],
            counts: { read: 120, headings: 1, landmarks: 2, links: 30, formControls: 1, tables: 0, tab: 2 },
          },
          live: {
            v: 1, voice: 'nvda', menus: 1, forms: 1,
            lines: [
              { flow: 'menu', action: 'pressed Menu', text: 'button, Menu, expanded', heard: true },
              { flow: 'form', action: `pressed Join ${hostile} with the fields empty`, text: 'There is 1 error in this form', heard: false, criterion: '4.1.3' },
            ],
          },
        },
        { page: `${E}/events`, failed: [{ criterion: '1.3.1', detail: 'Heading levels skip' }], read: {
          v: 1, voice: 'nvda', truncated: true, read: [{ n: 0, text: 'heading level 1, Events' }, { n: 1, text: 'heading level 4, Story time', flag: 0 }],
          lists: { headings: ['heading level 1, Events', 'heading level 4, Story time'], landmarks: [], links: [], formControls: [], tables: [] }, tab: [],
          flags: [{ criterion: '1.3.1', note: 'heading level 4 after level 1' }], counts: { read: 2, headings: 2, landmarks: 0, links: 0, formControls: 0, tables: 0, tab: 0 },
        } },
      ],
    },
    probeRuns: [{ probe: 'reflow', kind: 'render', page: `${E}/events`, criteria: ['1.4.10'], status: 'ok', ms: 5,
      findings: [{ criterion: '1.4.10', status: 'failed', target: `main ${hostile}`, detail: `Content scrolls sideways at 320 px ${hostile}` }] },
      ...(opts.extraProbeRuns ?? [])],
  });
  return { ...report, evidence };
}
