// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The open engine's plain HTML report (src/report/plain.ts; `grnted --html`, `--format html`): one simple,
// accessible, unbranded page with the site, the date, the engine and scoring versions, the score, each
// criterion's result and every problem with its pages, elements, evidence and the fix brief's line. Its
// score on Granted itself: test/integration/plainDogfood.test.ts.
import { describe, expect, it } from 'vitest';
import { ACCESS_GRANTED_RULE, verdictLine } from '../../src/report/blocked.js';
import { fixPrompt } from '../../src/report/fixPrompt.js';
import { PLAIN_EVIDENCE_MAX, PLAIN_PAGES_MAX, renderPlainHtml, sourceOf } from '../../src/report/plain.js';
import { buildReport } from '../../src/report/build.js';
import type { PageAudit, ProbeFinding, ProbeRun } from '../../src/types.js';
import { bigReport } from '../helpers/bigReportFixture.js';
import { buildProblems } from '../../src/report/problems.js';
import { CRITERIA, STATUS_LABEL } from '../../src/report/criteria.js';
import { esc } from '../../src/report/escape.js';
import { ENGINE_VERSION } from '../../src/version.js';
import type { SiteReport } from '../../src/types.js';
import { fixPromptReport } from '../helpers/fixPromptFixture.js';
import { breakout, fullReport, hostile } from '../helpers/reportFixture.js';

const ids = (doc: string) => [...doc.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);

describe('the plain HTML report', () => {
  const report = fullReport();
  const html = renderPlainHtml(report);

  it('is one self-contained page: no script, no external file, no picture, no inline handler', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).not.toMatch(/<script\b|<img\b|<link\b|<iframe\b|\bsrc=|\son[a-z]+=/i);
    expect(html).not.toMatch(/url\(/);
    // Unbranded: no logo, no brand fonts, no colour theme of the hosted report.
    expect(html).not.toMatch(/Archivo|Granted Mono|<svg\b/);
  });

  it('names the site, the date, the engine and scoring versions and the score', () => {
    expect(html).toContain('<title>Accessibility report: school.example</title>');
    expect(html).toContain('<h1>Accessibility report: school.example</h1>');
    expect(html).toContain('<dt>Site</dt><dd><a href="https://school.example/">https://school.example/</a></dd>');
    expect(html).toContain('<dt>Scanned</dt><dd>October 30, 2026 (Pacific time)</dd>');
    expect(html).toContain(`<dt>Engine</dt><dd>grnted ${esc(report.meta.engine)}, scoring ${report.meta.scoring}</dd>`);
    // Batch 19: the verdict with its reason (verdictLine), never a bare "Access Denied".
    expect(html).toContain(`<dt>Score</dt><dd><strong>${report.score} out of 100</strong>, grade ${report.letter}: ${verdictLine(report)!.split(' · ').slice(2).join(' · ')}</dd>`);
    expect(html).toContain(`<p>Made with the Granted engine, grnted ${ENGINE_VERSION}.</p>`);
  });

  it('lists every WCAG 2.2 A and AA criterion with its result', () => {
    const rows = [...html.matchAll(/<tr><th scope="row">([\d.]+) [^<]*<\/th><td>(A|AA)<\/td><td>([^<]+)<\/td><\/tr>/g)];
    expect(rows.map((m) => m[1])).toEqual(CRITERIA.map((c) => c.criterion));
    for (const m of rows) {
      const row = report.criteria!.find((c) => c.criterion === m[1])!;
      expect(m[3]).toBe(esc(STATUS_LABEL[row.status]));
    }
    expect(html).toContain('<caption>Each WCAG 2.2 Level A and AA criterion and what the automated tests found</caption>');
  });

  it('every problem, in the report\'s order, with its criteria, what is wrong, the fix brief\'s line and where', () => {
    const problems = buildProblems(report);
    expect(problems.length).toBeGreaterThan(3);
    const titles = [...html.matchAll(/<h3 id="problem-(\d+)">\d+\. ([^<]*)<\/h3>/g)];
    expect(titles.map((m) => m[2])).toEqual(problems.map((p) => esc(p.copy.title)));
    const brief = fixPrompt(report, { audience: 'developer' }) + fixPrompt(report, { audience: 'content' });
    for (const p of problems) {
      expect(html).toContain(`<p><strong>What is wrong:</strong> ${esc(p.copy.who)}</p>`);
      expect(html).toContain(`<p><strong>How to fix it:</strong> ${esc(p.copy.fix)}</p>`);
      // The same words the fix brief gives the assistant.
      expect(brief).toContain(`- How to fix it (the report's guidance): ${p.copy.fix}`);
      for (const c of p.criteria) expect(html).toContain(`${c.criterion} (Level ${c.level})`);
    }
  });

  it('evidence: the page, the element and the HTML the rules saw, escaped', () => {
    expect(html).toContain('<a href="https://school.example/">/</a>, element <code>#image-alt-0</code>: <code>&lt;div&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/div&gt;</code>');
    // A test's evidence: where it failed and what it measured, escaped.
    const tested = buildProblems(report).find((p) => p.textEvidence.length)!;
    const e = tested.textEvidence[0]!;
    expect(html).toContain(`${e.target ? `, element <code>${esc(e.target)}</code>` : ''}: ${esc(e.detail)}`);
    expect(html).not.toContain(hostile);
    expect(html).not.toContain(breakout);
    for (const list of html.match(/<ul class="ev">[\s\S]*?<\/ul>/g) ?? []) expect((list.match(/<li>/g) ?? []).length).toBeLessThanOrEqual(PLAIN_EVIDENCE_MAX);
  });

  it('the AI review\'s flagged issues are listed apart, with their fix, as not in the score', () => {
    expect(html).toContain('<h2 id="ai">AI review: flagged issues, not in the score</h2>');
    expect(html).toMatch(/<strong>How to fix it:<\/strong> [^<]+<\/li>/);
  });

  it('every id is unique, every in-page link and every labelled region points at an id that exists', () => {
    const all = ids(html);
    expect(new Set(all).size).toBe(all.length);
    for (const t of [...html.matchAll(/(?:href="#|aria-labelledby=")([^"]+)"/g)].map((m) => m[1]!)) expect(all).toContain(t);
  });

  it('never claims a result it did not find', () => {
    expect(html).not.toMatch(/\b(passes|passed|compliant|certified)\b/i);
  });

  it('an unscored scan: no score, the reasons, and every criterion still listed', () => {
    const incomplete: SiteReport = { ...report, status: 'incomplete', score: null, letter: null, reasons: ['Only 1 of 4 pages loaded'] } as unknown as SiteReport;
    const doc = renderPlainHtml(incomplete);
    expect(doc).toContain('<dt>Score</dt><dd><strong>No score</strong>: the scan did not finish</dd>');
    expect(doc).toContain('<li>Only 1 of 4 pages loaded</li>');
    expect([...doc.matchAll(/<tr><th scope="row">/g)]).toHaveLength(CRITERIA.length);
  });

  it('Access Denied says why, in the same line as the terminal and the fix brief', () => {
    const denied = { ...report, headline: 'Access Denied', accessBlockedBy: [{ criterion: '2.1.2', title: 'No keyboard trap', pages: ['https://school.example/'] }] } as SiteReport;
    // Batch 19: the reason sits in the Score line itself, and the page says what Access Granted means.
    const line = verdictLine(denied)!.split(' · ').slice(2).join(' · ');
    // Both reasons when both hold (this report scores 89).
    expect(line).toBe('Access Denied: 89 is below the 90 needed for Access Granted, and a page fails WCAG 2.1.2 No keyboard trap, which blocks Access Granted whatever the score');
    expect(renderPlainHtml(denied)).toContain(`grade ${denied.letter}: ${line}</dd>`);
    expect(renderPlainHtml(denied)).toContain(`<p>${ACCESS_GRANTED_RULE}</p>`);
    expect(renderPlainHtml(fixPromptReport())).toContain('<title>Accessibility report: www.riverside-sd.example</title>');
  });

  it('the fix brief closes the page: both audiences, the same text as fixPrompt, escaped', () => {
    expect(html).toContain('<h2 id="fix-brief">Fix brief for an AI assistant</h2>');
    for (const a of ['developer', 'content'] as const) expect(html).toContain(`<pre>${esc(fixPrompt(report, { audience: a }))}</pre>`);
  });

  it('is deterministic: the same report gives the same bytes', () => {
    expect(renderPlainHtml(fullReport())).toBe(html);
  });
});

/** One problem's article from a plain report. */
const article = (doc: string, title: string) => {
  const i = doc.indexOf(`. ${title}</h3>`);
  return doc.slice(i, doc.indexOf('</article>', i));
};

describe('every affected page and every measured page, whatever the evidence samples (Sol r1 S5)', () => {
  it('a rule failing on 25 pages lists all 25, though its examples come from 3 of them', () => {
    const r = bigReport();
    const p = buildProblems(r).find((x) => x.key === 'rule:image-alt')!;
    expect(p.pages.length).toBe(25);
    const rule = r.rules.find((x) => x.id === 'image-alt')!;
    // Batch 19: the examples come from different pages (were the first 3 elements, all on one page).
    expect(new Set(rule.examples.map((e) => e.page)).size).toBe(3);
    const a = article(renderPlainHtml(r), esc(p.copy.title));
    expect(a).toContain('<strong>Pages (25):</strong>');
    for (const u of p.pages) expect(a).toContain(`href="${esc(u)}"`);
    expect(a).not.toContain('more page');
  });

  it('more pages than the cap: the first PLAIN_PAGES_MAX, then "and N more pages"', () => {
    const r = bigReport();
    const p = buildProblems(r).find((x) => x.key === 'rule:image-alt')!;
    const extra = Array.from({ length: 30 }, (_, i) => `https://district.example/extra-${i}`);
    const wide = { ...r, rules: r.rules.map((x) => (x.id === 'image-alt' ? { ...x, pagesAffected: [...x.pagesAffected, ...extra] } : x)) } as SiteReport;
    const q = buildProblems(wide).find((x) => x.key === 'rule:image-alt')!;
    expect(q.pages.length).toBe(p.pages.length + 30);
    const a = article(renderPlainHtml(wide), esc(q.copy.title));
    expect(a).toContain(`<strong>Pages (${q.pages.length}):</strong>`);
    expect(a).toContain(`, and ${q.pages.length - PLAIN_PAGES_MAX} more pages</p>`);
  });

  it('pages measured outside the score are listed with how, and which count', () => {
    const SITE = 'https://e.org/';
    const url = (x: string) => `https://e.org${x}`;
    const page = (x: string): PageAudit => ({ url: url(x), status: 'ok', rules: {}, violations: [], incomplete: [], links: [] });
    const noRing = (target: string): ProbeFinding => ({ criterion: '2.4.7', status: 'failed', target, detail: `No visible focus indicator (${target}).` });
    const keyboard = (x: string, findings: ProbeFinding[], more: Partial<ProbeRun> = {}): ProbeRun => ({ probe: 'keyboard', kind: 'interaction', page: url(x), criteria: ['2.4.7'], status: 'ok', findings, ms: 1, ...more });
    const r = buildReport({
      site: SITE, documents: [], skipped: [], startedAt: 't', finishedAt: '2026-11-10T00:00:00Z', userAgent: 'ua', pages: ['/', '/a', '/b', '/c', '/d'].map(page),
      probeRuns: [keyboard('/', [noRing('footer > a.top')]), keyboard('/d', [{ criterion: '2.4.7', status: 'no_failures_found', detail: 'ok' }]),
        keyboard('/a', [noRing('#foot > a')], { coverage: true }), keyboard('/b', [noRing('footer > a')], { coverage: true, checked: { from: [url('/')] } })],
    });
    const p = buildProblems(r).find((x) => x.key === 'criterion:2.4.7')!;
    expect(p.measured?.length).toBe(3);
    const a = article(renderPlainHtml(r), esc(p.copy.title));
    expect(a).toContain('<strong>Measured on 3 pages</strong> (1 counts in the score):');
    for (const m of p.measured!) expect(a).toContain(`>${esc(new URL(m.page).pathname)}</a>: ${esc(m.method)}; ${m.scored ? 'counts in the score' : 'not in the score'}</li>`);
  });
});

describe('who found each problem (Sol r1 S6)', () => {
  it('every problem-key family has its own label, and an unknown one a generic label', () => {
    expect(sourceOf('rule:image-alt')).toBe('axe-core rule <code>image-alt</code>');
    expect(sourceOf('third-party:image-alt')).toBe('axe-core rule <code>image-alt</code>, inside content from another site');
    expect(sourceOf('criterion:2.4.7')).toBe('Granted’s automated tests');
    expect(sourceOf('criterion:2.4.7/listed')).toBe('Granted’s automated tests');
    expect(sourceOf('ai:1.1.1')).toBe('the AI review, double-checked');
    expect(sourceOf('ai:media:2')).toBe('the AI review, double-checked');
    expect(sourceOf('consistency:3')).toBe('the comparison of the same components across pages');
    expect(sourceOf('media:1')).toBe('the video and audio rules');
    expect(sourceOf('documents')).toBe('the PDF checks');
    expect(sourceOf('office')).toBe('the Word, Excel and PowerPoint checks');
    expect(sourceOf('something-new')).toBe('Granted’s checks');
    expect(sourceOf('rule:<b>')).toBe('axe-core rule <code>&lt;b&gt;</code>');
  });
});
