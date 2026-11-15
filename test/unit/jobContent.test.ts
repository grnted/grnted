// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 stage 2: each repair job's content as data (src/report/jobContent.ts): a specific title written
// from the job's causes and reach, one sentence on what changes, short steps and the lead code change; and per
// problem its steps and code. Deterministic, plain words, no jargon.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { jobContent, MAX_JOB_STEPS, MAX_JOB_TITLE, pageName, problemFix } from '../../src/report/jobContent.js';
import { buildJobs, type RepairJob, type RepairModel, type RepairProblem } from '../../src/report/jobs.js';
import { RULE_IMPACTS } from '../../src/ruleImpacts.js';
import type { PageAudit, SiteReport } from '../../src/types.js';
import { bigReport } from '../helpers/bigReportFixture.js';
import { fullReport } from '../helpers/reportFixture.js';
import { wideReport } from '../helpers/wideReportFixture.js';

const fixture = (): SiteReport => JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/print/e2e-fixture-report.json.gz', import.meta.url))).toString());
const E = 'https://agency.example';
const v = (id: string, target: string, html: string): PageAudit['violations'][number] => ({ id, help: id, helpUrl: 'https://example.org/rule', nodes: [{ target, html, viewports: ['desktop'] }] });
const site = (pages: [string, PageAudit['violations']][]) => buildReport({
  site: `${E}/`, documents: [], skipped: [], userAgent: 'test', startedAt: '2026-11-09T18:00:00Z', finishedAt: '2026-11-09T18:01:00Z',
  pages: pages.map(([p, violations]) => ({ url: `${E}${p}`, status: 'ok', rules: {}, incomplete: [], links: [], violations })),
});
const SIXTY = Array.from({ length: 60 }, (_, i) => `/page-${i}`);
const shell = [
  v('link-name', 'header > nav > ul > li:nth-child(3) > a.icon', '<a class="icon" href="/search"></a>'),
  v('color-contrast', 'footer > p.legal', '<p class="legal">© District</p>'),
  v('button-name', 'header > button.menu', '<button class="menu"></button>'),
  v('target-size', 'footer > ul.social > li > a', '<a href="/fb" style="width:16px;height:16px"></a>'),
  v('aria-allowed-attr', 'nav > ul', '<ul aria-checked="true">'),
];

/** Representative jobs: [what, report, job titles in plan order]. */
const TITLES: [string, () => SiteReport, string[]][] = [
  ['the e2e fixture (14 pages, 73 problems)', fixture, [
    'Stop the flashing, the slideshow and the sound',
    'Free the keyboard trap and fix the form on the Contact page',
    'Fix the page structure, describe the picture and fix link text',
    'Repair the controls and enlarge the small targets',
    'Fix keyboard focus and strengthen faint colors',
    'Re-export the 7 PDFs with tags, titles and a language',
    'Caption the video and add a text version of the recording',
    'Fix touch controls and single-key shortcuts',
  ]],
  ['one shared header button on every page', () => site(['/', '/a', '/b', '/c'].map((p) => [p, [v('button-name', 'header.site > button.menu', '<button class="menu"></button>')]])), ['Name the button in the header']],
  ['one picture on one page', () => site([['/about', [v('image-alt', '#hero', '<img id="hero" src="/h.png">')]], ['/', []]]), ['Describe the picture on the About page']],
  ['two different pictures on two pages', () => site([['/about', [v('image-alt', '#hero', '<img id="hero" src="/h.png">')]], ['/news', [v('image-alt', '#lead', '<img id="lead" src="/l.png">')]], ['/', []], ['/x', []]]), ['Describe the pictures']],
  ['a 60-page site whose header, menu and footer fail five rules', () => site(SIXTY.map((p) => [p, shell])), ['Repair the controls in the header, menu and footer']],
  ['a 25-page district report', bigReport, ['Repair the controls, describe the pictures and fix faint text', 'Fix the lists and underline links in text', 'Re-export the 8 PDFs with titles, a language and tags', 'Fix the remaining problems']],
  ['a 25-page report with long addresses', wideReport, ['Free the keyboard trap', 'Repair the controls, describe the pictures and fix the forms', 'Re-export the 14 PDFs with titles and a language']],
  // Scoring v11 (batch 15b, joined in 0.2.0): a video with no captions track is a possible problem, never a definite
  // one, so the fixture's Events video has no repair job of its own.
  ['a 4-page report with embedded video and documents', fullReport, ['Describe the picture and name the link with no text', 'Fit the page to narrow screens and name the link with no text', 'Re-export both PDFs with tags, a language and titles', 'Fix the embedded content on the homepage']],
];

describe('job titles', () => {
  it.each(TITLES)('%s', (_, report, titles) => {
    expect(buildJobs(report()).jobs.map((j) => j.title)).toEqual(titles);
  });

  it.each(TITLES)('%s: short, imperative, plain words (no rule ids, criterion numbers or jargon)', (_, report) => {
    const ids = Object.keys(RULE_IMPACTS).filter((r) => r.includes('-'));
    for (const j of buildJobs(report()).jobs) {
      expect(j.title.length, j.title).toBeLessThanOrEqual(MAX_JOB_TITLE);
      expect(j.title, j.title).toMatch(/^(?:Stop|Free|Fix|Name|Describe|Re-export|Caption|Darken|Show|Add|Underline|Set|Title|Strengthen|Enlarge|Label|Keep|Unhide|Rename|Fit|Allow|Turn on|Repair|Open|Announce|Replace|Explain|Unlock|Match|Simplify|Extend|Reword|Shrink|Free)\b/);
      expect(j.title).not.toMatch(/[.:;]$|\d\.\d|WCAG|ARIA|axe|—/);
      for (const id of ids) expect(j.title.toLowerCase()).not.toContain(id);
    }
  });

  it('caps every title at 64 characters (the plan rows and job headings are sized for it), dropping the least important words first', () => {
    expect(MAX_JOB_TITLE).toBe(64);
    // One page with three long kinds of fix and a long page name: the full title would be far over 64.
    const long = site([['/parks-and-recreation-department', [
      v('scrollable-region-focusable', '#schedule', '<div id="schedule" style="height:3em;overflow:auto">'),
      v('label-content-name-mismatch', '#main > a.more', '<a class="more" href="/x" aria-label="Go">Read the full parks schedule</a>'),
      v('autocomplete-valid', '#email', '<input id="email" autocomplete="mail">'),
    ]], ['/', []]]);
    const titles = buildJobs(long).jobs.map((j) => j.title);
    for (const t of titles) expect(t.length, t).toBeLessThanOrEqual(64);
    for (const [, r] of TITLES) for (const j of buildJobs(r()).jobs) expect(j.title.length, j.title).toBeLessThanOrEqual(64);
  });

  it('is deterministic: the same report gives the same words', () => {
    const a = buildJobs(fixture());
    const b = buildJobs(fixture());
    expect(b.jobs.map((j) => [j.title, j.whatChanges, j.steps, j.codeFix])).toEqual(a.jobs.map((j) => [j.title, j.whatChanges, j.steps, j.codeFix]));
  });
});

describe('what changes, steps and code', () => {
  const m = buildJobs(fixture());
  const job = (code: string) => m.jobs.find((j) => j.code === code)!;

  it('one sentence on what is different once the job is done, from the job\'s own fixes and reach', () => {
    expect(job('J1').whatChanges).toBe('On the Events page, nothing flashes, moving and updating content can be paused and no sound plays by itself.');
    expect(job('J2').whatChanges).toBe('On the Contact page, keyboard focus no longer gets stuck, form errors are described in words and password managers work at sign-in, plus 1 more fix.');
    expect(job('J6').whatChanges).toBe('All 7 PDFs can be read with a screen reader: headings, lists and tables are tagged, each one shows its title and the language is set, plus 4 more fixes.');
    expect(buildJobs(site(SIXTY.map((p) => [p, shell]))).jobs[0]!.whatChanges).toMatch(/^In the shared header, menu and footer, /);
    for (const x of [...m.jobs, ...TITLES.flatMap(([, r]) => buildJobs(r()).jobs)]) {
      expect(x.whatChanges, x.code).toMatch(/^[A-Z][^.]*\.$/); // one sentence
      expect(x.whatChanges.length, x.whatChanges).toBeLessThanOrEqual(200);
    }
  });

  it('steps: the job\'s kinds of fix, most important first, at most five', () => {
    expect(job('J1').steps).toEqual([
      'Remove the flashing, or slow it to no more than three flashes in any one second.',
      'Give anything that moves, blinks or scrolls by itself for more than 5 seconds a visible pause, stop or hide button.',
      // The slideshow is a region a timer changes (Sol r2 #4): its own repair, apart from the moving banner's.
      'Give anything that updates by itself a way to pause, stop or hide it, or to choose how often it updates.',
      'Don’t start sound by itself: remove autoplay.',
    ]);
    expect(job('J6').steps).toEqual([
      'Open each PDF’s source file (Word, InDesign or similar), not the PDF.',
      'In the source file: use real headings, lists and table header rows, replace the XFA form with a web form or a tagged PDF form, give every form field a name that matches its label and write alt text for each picture.',
      'Set the document language, a title in the file’s properties and the PDF to show its title instead of the file name.',
      'Export each one again as a tagged PDF and replace the file at the same address.',
      'For scanned-notice.pdf: run text recognition (OCR) on the scanned pages, correct the text it finds, then tag the result.',
    ]);
    expect(job('J5').steps.at(-1)).toMatch(/^Then fix the other \d+ kinds of problem listed for this job, one by one\.$/);
    for (const x of [...m.jobs, ...TITLES.flatMap(([, r]) => buildJobs(r()).jobs)]) {
      expect(x.steps.length, x.code).toBeGreaterThanOrEqual(1);
      expect(x.steps.length, x.code).toBeLessThanOrEqual(MAX_JOB_STEPS);
    }
    // A job of one kind of fix shows that fix's own steps in full.
    expect(buildJobs(site([['/about', [v('image-alt', '#hero', '<img id="hero" src="/h.png">')]], ['/', []]])).jobs[0]!.steps).toHaveLength(3);
  });

  it('code: the job\'s lead change, built from the site\'s own HTML where the scan kept it', () => {
    expect(job('J1').codeFix).toEqual({ source: 'page', language: 'html', before: ['<audio src="/media/tone.wav" autoplay loop></audio>'], after: ['<audio src="/media/tone.wav" controls></audio>'], techniques: ['G171', 'G170'], problem: 'P15' });
    expect(job('J3').codeFix).toMatchObject({ source: 'pattern', problem: 'P19', techniques: ['H51', 'H63'] });
    expect(job('J5').codeFix).toMatchObject({ source: 'page', language: 'css', after: ['#user { border-color: #929292; } /* 3.11:1 */'], problem: 'P9' });
    expect(job('J7').codeFix).toMatchObject({ source: 'page', problem: 'P63' });
    expect(job('J8').codeFix).toBeUndefined(); // pointer, shortcut and motion fixes: steps only
  });

  it('every problem has 2 to 4 steps (a document: its checks, up to 5), and a code change only where one is safe', () => {
    const all: RepairModel[] = [m, ...TITLES.map(([, r]) => buildJobs(r()))];
    for (const model of all) for (const p of model.problems) {
      expect(p.steps.length, `${p.code} ${p.sourceKey}`).toBeGreaterThanOrEqual(2);
      expect(p.steps.length, `${p.code} ${p.sourceKey}`).toBeLessThanOrEqual(p.sourceKey === 'documents' || p.sourceKey === 'office' ? 5 : 4);
      if (p.codeFix) expect(p.codeFix.problem).toBe(p.code);
    }
    const byCode = new Map(m.problems.map((p) => [p.code, p]));
    expect(byCode.get('P51')!.codeFix!.before).toEqual(['<img id="hero" src="/images/garden.png" width="480" height="240">']);
    expect(byCode.get('P56')!.codeFix!.after).toEqual(['<p lang="es">']);
    expect(byCode.get('P50')!.codeFix!.after).toEqual(['<h2>How to reach us</h2>']);
    expect(byCode.get('P72')!.codeFix).toBeUndefined(); // the keyboard trap: steps only
    expect(byCode.get('P20')!.steps[0]).toBe('Ask youtube.com to fix its embedded content (it can’t be changed in your own pages): remove the ARIA attribute the element’s role does not support.');
    expect(byCode.get('P36')!.steps[0]).toBe('Run text recognition (OCR) on the scanned pages, correct the text it finds, then tag the result.');
  });
});

describe('page names', () => {
  it.each([
    ['https://e.org/', 'the homepage'], ['https://e.org/index.html', 'the homepage'], ['https://e.org/contact', 'the Contact page'],
    ['https://e.org/lunch-menu', 'the Lunch menu page'], ['https://e.org/news/2026/budget_2026.html', 'the Budget 2026 page'],
    ['https://e.org/p/123', 'the /p/123 page'], ['https://e.org/a-very-long-page-name-that-goes-on-and-on-forever', 'the /a-very-long-page-name-that-goes-on-and-on-forever page'],
  ])('%s → %s', (url, name) => expect(pageName(url)).toBe(name));
});

describe('Sol review r1 (2026-11-09): the literal cases', () => {
  it('#1 a page address with a bad percent escape never breaks the plan: its path is kept as written', () => {
    expect(pageName('https://e.org/100%-complete')).toBe('the /100%-complete page');
    const r = site([['/100%-complete', [v('image-alt', '#hero', '<img id="hero" src="/h.png">')]], ['/', []]]);
    expect(() => buildJobs(r)).not.toThrow();
    expect(buildJobs(r).jobs[0]!.title).toBe('Describe the picture on the /100%-complete page');
    const docs = { ...r, documentChecks: [{ url: 'https://agency.example/files/100%-done.pdf', type: 'pdf' as const, detectedBy: 'extension' as const, linkedFrom: [`${E}/`],
      checks: { pages: 1, pagesChecked: 1, tagged: false, hasTitle: true, showsTitle: true, hasLanguage: true, imageOnly: false, figuresWithoutAlt: 0 } }] };
    const rebuilt = buildReport({ site: `${E}/`, pages: r.pages.map((p) => ({ url: p.url, status: 'ok', rules: {}, incomplete: [], links: [], violations: [] })), documents: [docs.documentChecks[0]!.url], skipped: [], userAgent: 'test', startedAt: '', finishedAt: '', documentChecks: docs.documentChecks });
    expect(() => buildJobs(rebuilt)).not.toThrow();
    expect(buildJobs(rebuilt).jobs.find((j) => j.kind === 'documents')!.title).toContain('100%-done.pdf');
  });

  it('#10 a color-only problem that is not a link is never titled as a link (1.4.1 covers far more than links)', () => {
    const p: RepairProblem = { code: 'P1', sourceKey: 'ai:vision:1.4.1', sourceKeys: ['ai:vision:1.4.1'], shared: false, fingerprint: 'x', title: 'Information shown by color alone', action: '', check: '',
      criteria: ['1.4.1'], pages: ['https://e.org/chart'], locations: [{ page: 'https://e.org/chart', target: 'img.chart' }], occurrences: 1, scored: true, urgent: false, harm: 3, service: 0, job: 'J1', relatedJobs: [], steps: [],
      observations: [{ page: 'https://e.org/chart', target: 'img.chart', test: 'ai:vision:1.4.1', detail: 'The chart tells its series apart by color only.' }] };
    const job = { code: 'J1', kind: 'content', pages: ['https://e.org/chart'], problems: ['P1'] } as unknown as RepairJob;
    const report = { site: 'https://e.org/', pages: [], rules: [] } as unknown as SiteReport;
    const c = jobContent(job, [p], new Map([['P1', problemFix(p, report)]]));
    expect(c.title).not.toMatch(/link/i);
    expect(c.title).toMatch(/color/i);
    expect(c.whatChanges).not.toMatch(/link/i);
    // Links themselves keep their own wording.
    expect(buildJobs(site([['/a', [v('link-in-text-block', 'p > a', '<a href="/c">the contact page</a>')]], ['/', []]])).jobs[0]!.title).toMatch(/link/i);
  });
});

describe('Sol review r2 (2026-11-09): the literal cases', () => {
  const problem = (code: string, criterion: string, test: string, detail: string, target: string): RepairProblem => ({ code, sourceKey: `criterion:${criterion}`, sourceKeys: [`criterion:${criterion}`], shared: false, fingerprint: code, title: criterion === '1.4.2' ? 'Sound starts on its own and keeps playing' : 'Moving content can’t be paused',
    action: '', check: '', criteria: [criterion], pages: ['https://e.org/events'], locations: [{ page: 'https://e.org/events', target }], occurrences: 1, scored: true, urgent: true, harm: 5, service: 0, job: 'J1', relatedJobs: [], steps: [],
    observations: [{ page: 'https://e.org/events', target, test, detail }] });
  const scoreboard = problem('P1', '2.2.2', 'motion', 'content that the page changes by itself every 3 s (a carousel, slideshow, ticker or updating region) starts by itself and runs with no end; nothing on the page pauses, stops or hides it', '#scores');
  const audio = problem('P2', '1.4.2', 'audio', 'an audio player (looping) plays sound by itself with no end; nothing on the page pauses, stops or mutes it', '#main > audio');
  const banner = problem('P3', '2.2.2', 'motion', 'content that keeps moving or changing on screen (still changing more than 5 s after the page loaded) starts by itself and runs with no end', '#flash');
  const report = { site: 'https://e.org/', pages: [], rules: [] } as unknown as SiteReport;
  const job = (ps: RepairProblem[]) => ({ code: 'J1', kind: 'disruption', pages: ['https://e.org/events'], problems: ps.map((p) => p.code) }) as unknown as RepairJob;
  const steps = (ps: RepairProblem[]) => jobContent(job(ps), ps, new Map(ps.map((p) => [p.code, problemFix(p, report)]))).steps;

  it('#4 an auto-updating scoreboard plus autoplay audio: a step pauses the updating content, and one stops the sound', () => {
    const s = steps([scoreboard, audio]);
    expect(s.some((x) => /updat/i.test(x) && /pause|stop|hide/i.test(x)), s.join(' | ')).toBe(true);
    expect(s.some((x) => /autoplay/i.test(x))).toBe(true);
    // The scoreboard's own steps start with its own repair, not the movement one.
    expect(problemFix(scoreboard, report).steps[0]).toMatch(/updat/i);
  });

  it('#4 moving content and updating content in one job: both repairs are steps', () => {
    const s = steps([banner, scoreboard, audio]);
    expect(s.some((x) => /5 seconds/.test(x)), s.join(' | ')).toBe(true);
    expect(s.some((x) => /updat/i.test(x))).toBe(true);
    expect(problemFix(banner, report).steps[0]).toMatch(/5 seconds/);
  });
});
