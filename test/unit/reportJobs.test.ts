// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/build.js';
import { carryAi } from '../helpers/carryAi.js';
import { buildJobs, elementFingerprint, reportCoverage } from '../../src/report/jobs.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { PageAudit, SiteReport } from '../../src/types.js';

it.each([true, false])('keeps v10 AI-confirmed PDF findings in canonical repairs (document score: %s)', (scoreDocuments) => {
  const url = 'https://e.org/registration.pdf';
  const label = 'Reading order jumps between columns';
  const report = buildReport({
    site: 'https://e.org/', pages: [{ url: 'https://e.org/', status: 'ok', rules: {}, violations: [], incomplete: [], links: [] }],
    documents: [url], skipped: [], startedAt: '', finishedAt: '', userAgent: 'test', scoreDocuments,
    documentChecks: [{ url, type: 'pdf', detectedBy: 'extension', linkedFrom: ['https://e.org/'], checks: {
      pages: 1, pagesChecked: 1, tagged: true, hasLanguage: true, hasTitle: true, showsTitle: true, imageOnly: false, figuresWithoutAlt: 0,
    } }],
    extension: carryAi,
    ai: { disclaimer: '', runs: [{ check: 'document', title: 'PDF review', summary: '', model: 'test', promptVersion: 'document@2', tier: 'deep', inputs: 1, reviewed: 1, cached: 0, notReviewed: 0,
      findings: [{ check: 'document', criterion: '1.3.2, 4.1.2', page: url, target: 'Page 1', verdict: 'order_jumps', label,
        flagged: true, confidence: 'high', observed: label, issue: label, suggestion: 'Correct the tagged reading order.', source: 'ai', scored: true, scoreTested: ['1.3.2'] }],
    }] },
  });
  const problem = buildJobs(report).problems.find((p) => p.sourceKey === 'documents')!;
  expect(problem).toMatchObject({ criteria: ['1.3.2'], scored: scoreDocuments });
});

function site(paths = ['/', '/news/a', '/news/b']): SiteReport {
  const pages: PageAudit[] = paths.map((path) => ({
    url: `https://agency.example${path}`, status: 'ok', rules: { 'button-name': 'fail' }, incomplete: [], links: [],
    violations: [{ id: 'button-name', help: 'Buttons need names', helpUrl: 'https://example.org/rule', nodes: [
      { target: 'header.site-header > button.menu', html: '<button class="menu"></button>', viewports: ['desktop'] },
    ] }],
  }));
  return buildReport({ site: 'https://agency.example/', pages, documents: [], skipped: [], userAgent: 'test', startedAt: '2026-11-08T18:00:00Z', finishedAt: '2026-11-08T18:01:00Z' });
}

describe('jobs grouped by cause and observed reach', () => {
  it('one shared defect is one problem on N pages, assigned to one job', () => {
    const model = buildJobs(site());
    expect(model.problems).toHaveLength(1);
    expect(model.problems[0]!.pages).toHaveLength(3);
    expect(model.jobs).toHaveLength(1);
    expect(model.jobs[0]!.kind).toBe('template');
    expect(model.jobs[0]!.problems).toEqual([model.problems[0]!.code]);
  });

  it('same-looking controls in different templates stay separate', () => {
    expect(elementFingerprint('button-name', 'header.city > button.menu', '<button class="menu"></button>'))
      .not.toBe(elementFingerprint('button-name', 'header.school > button.menu', '<button class="menu"></button>'));
    const r = site();
    delete r.rules[0]!.causes;
    r.rules[0]!.occurrences![1]!.target = 'header.other-template > button.menu';
    expect(buildJobs(r).problems).toHaveLength(2);
  });

  it('different failures on the same element remain separate', () => {
    const r = site();
    r.rules.push({ ...r.rules[0]!, id: 'aria-allowed-attr' });
    expect(buildJobs(r).problems).toHaveLength(2);
    expect(new Set(buildJobs(r).problems.map((p) => p.code)).size).toBe(2);
  });

  it('codes survive page order, score changes, changed reach and unrelated new problems', () => {
    const r = site();
    const original = buildJobs(r).problems[0]!;
    r.pages.reverse(); r.score = 1; r.rules[0]!.pointsLost = 99;
    r.rules[0]!.occurrences!.pop(); r.rules[0]!.causes![0]!.pages.pop();
    r.rules.push({ ...r.rules[0]!, id: 'image-alt' });
    expect(buildJobs(r).problems.find((p) => p.sourceKey === 'rule:button-name')!.code).toBe(original.code);
  });

  it('harm and service importance precede reach and effort, never points', () => {
    const r = site();
    r.testIssues = [{ criterion: '2.1.2', title: 'Keyboard trap', probes: ['keyboard'], pointsLost: 0, pagesAffected: ['https://agency.example/contact'], evidence: [{ page: 'https://agency.example/contact', target: '#message', detail: 'Focus stays in the message field.' }] }];
    r.accessBlockedBy = [{ criterion: '2.1.2', title: 'No keyboard trap', pages: ['https://agency.example/contact'], keys: ['criterion:2.1.2'] }];
    const model = buildJobs(r);
    expect(model.jobs[0]!.urgent).toBe(true);
    expect(model.jobs[0]!.pages).toContain('https://agency.example/contact');
    expect(model.problems.every((p) => model.jobs.filter((j) => j.problems.includes(p.code)).length === 1)).toBe(true);
  });

  it('serialized reports carry jobs and coverage without changing the score', () => {
    const r = site();
    expect(r.repair?.problems).toHaveLength(1);
    expect(r.coverage?.rulePages).toHaveLength(3);
    const copy = JSON.parse(JSON.stringify(r)) as SiteReport;
    expect(buildJobs(copy)).toEqual(r.repair);
  });
});

describe('round two identity and occurrence regressions', () => {
  it('keeps both sibling selectors beneath their one barrier', () => {
    const r = site(['/']);
    const base = r.rules[0]!;
    delete base.causes;
    base.occurrences = [1, 2].map((n) => ({ page: r.site, target: `main > button:nth-child(${n})` }));
    const model = buildJobs(r);
    expect(model.problems).toHaveLength(1);
    expect(model.problems[0]!.locations.map((l) => l.target)).toEqual(base.occurrences.map((o) => o.target));
  });

  it('retains every sibling selector when collecting fresh audits', () => {
    const audit: PageAudit = { url: 'https://agency.example/', status: 'ok', rules: { 'button-name': 'fail' }, incomplete: [], links: [], violations: [{ id: 'button-name', help: 'Name buttons', helpUrl: '', nodes: [1, 2].map((n) => ({ target: `main > button:nth-child(${n})`, html: '<button></button>', viewports: ['desktop'] })) }] };
    const r = buildReport({ site: audit.url, pages: [audit], documents: [], skipped: [], userAgent: 'test', startedAt: '', finishedAt: '' });
    expect(r.repair!.problems[0]!.locations.map((l) => l.target)).toEqual(audit.violations[0]!.nodes.map((n) => n.target));
  });

  it('carries short codes across legacy/fresh records and presentation changes, without recycling closed codes', () => {
    const r = site();
    const before = buildJobs(r);
    expect(before.problems[0]!.code).toMatch(/^P\d+$/);
    expect(before.jobs[0]!.code).toMatch(/^J\d+$/);
    delete r.rules[0]!.causes;
    r.repair = before;
    r.rules[0]!.examples[0]!.html = '<button class="menu presentation"></button>';
    r.rules.push({ ...r.rules[0]!, id: 'image-alt' });
    const after = buildJobs(r);
    expect(after.problems.find((p) => p.sourceKey === 'rule:button-name')!.code).toBe(before.problems[0]!.code);
    expect(after.problems.find((p) => p.sourceKey === 'rule:image-alt')!.code).toBe('P2');
    expect(JSON.parse(JSON.stringify(after)).codeMap.problems).toHaveLength(2);
    r.repair = after; r.rules = [];
    r.repair = buildJobs(r);
    r.rules = [{ ...site().rules[0]!, id: 'link-name' }];
    expect(buildJobs(r).problems[0]!.code).toBe('P3');
  });

  it('uses one sound barrier for the player and its file, while retaining both observations', () => {
    const r: SiteReport = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/print/e2e-fixture-report.json.gz', import.meta.url))).toString());
    const model = buildJobs(r);
    expect(new Set(model.problems.map((p) => p.code)).size).toBe(model.problems.length);
    for (const p of model.problems) expect(model.jobs.filter((j) => j.problems.includes(p.code))).toHaveLength(1);
    const audio = model.problems.filter((p) => p.criteria.includes('1.4.2'));
    expect(audio).toHaveLength(1);
    expect(audio[0]!.locations.map((l) => l.target)).toEqual(expect.arrayContaining(['#main > audio', 'https://fixture.example/media/tone.wav']));
    const heading = buildJobs(r).problems.find((p) => p.locations.some((l) => l.target === '#main > h4'))!;
    expect(heading.title).toContain('1 to 4');
    expect(heading.action).toContain('appropriate level');
    const calendar = buildJobs(r).problems.find((p) => p.locations.some((l) => l.page.endsWith('/calendar.pdf')))!;
    expect(calendar.action).toMatch(/picture description/i);
    const form = buildJobs(r).problems.find((p) => p.locations.some((l) => l.page.endsWith('/enrollment-form.pdf')))!;
    expect(form.action).toContain('XFA');
    expect(form.action).toMatch(/field.*name|name.*field/i);
  });

  it('matches an accessible name after the selector changes, and keeps unrelated pages separate', () => {
    const r = site(['/']);
    r.rules[0]!.id = 'aria-allowed-attr';
    r.rules[0]!.causes = [{ fingerprint: 'old selector', pages: [r.site], target: '#old-menu', html: '<button aria-label="Open menu">', occurrences: 1 }];
    r.rules[0]!.examples = [{ page: r.site, target: '#old-menu', html: '<button aria-label="Open menu">' }];
    delete r.repair;
    const before = buildJobs(r);
    r.repair = before;
    r.rules[0]!.causes![0]!.target = '#new-menu';
    r.rules[0]!.examples[0]!.target = '#new-menu';
    expect(buildJobs(r).problems[0]!.code).toBe(before.problems[0]!.code);
    r.rules[0]!.causes![0]!.pages = ['https://agency.example/unrelated'];
    r.rules[0]!.examples[0]!.page = 'https://agency.example/unrelated';
    expect(buildJobs(r).problems[0]!.code).not.toBe(before.problems[0]!.code);
  });

  it('retains a legacy internal alias and an existing short job code during migration', () => {
    const r = site();
    const old = buildJobs(r);
    old.problems[0]!.code = 'P-legacy-internal-hash';
    old.jobs[0]!.code = 'J3';
    r.repair = JSON.parse(JSON.stringify({ ...old, codeMap: undefined, problems: old.problems.map((p) => ({ ...p, observations: undefined })) }));
    const migrated = buildJobs(r);
    expect(migrated.problems[0]!.code).toBe('P1');
    expect(migrated.jobs[0]!.code).toBe('J3');
    expect(migrated.codeMap.problems[0]!.aliases).toContain('P-legacy-internal-hash');
  });

  it('uses file volume and service importance in initial effort estimates', () => {
    const r = site();
    const doc = (n: number) => ({ url: `https://agency.example/${n}.pdf`, type: 'pdf' as const, detectedBy: 'extension' as const, linkedFrom: [r.site], checks: { pages: 1, pagesChecked: 1, tagged: false } });
    r.documentChecks = [doc(1), doc(2)];
    const effort = () => buildJobs(r).jobs.find((j) => j.kind === 'documents')!.effort;
    expect(effort()).toBe('M');
    r.documentChecks.forEach((d) => { d.linkedFrom = ['https://agency.example/contact']; });
    expect(effort()).toBe('L');
    r.documentChecks = Array.from({ length: 5 }, (_, i) => doc(i));
    expect(effort()).toBe('L');
  });
});

describe('coverage', () => {
  it('marks sampled interaction tests even when the union of other tests reaches every page', () => {
    const r = site();
    r.probes = { runs: [
      ...r.pages.map((p) => ({ probe: 'headings', kind: 'render' as const, page: p.url, criteria: ['2.4.6'], status: 'ok' as const, ms: 1, findings: [] })),
      { probe: 'keyboard', kind: 'interaction', page: r.site, criteria: ['2.1.2'], status: 'ok', ms: 1, findings: [] },
    ] };
    expect(reportCoverage(r).interactionPages).toHaveLength(3);
    expect(reportCoverage(r).sampled).toBe(true);
  });

  it('names sampled pages, exclusions, unsuccessful tests and the additional 2.2 criteria', () => {
    const r = site();
    r.probes = { runs: [{ probe: 'keyboard', kind: 'interaction', page: r.site, criteria: ['2.1.2'], status: 'timeout', ms: 10, findings: [{ criterion: '2.1.2', status: 'not_testable', detail: 'Timed out' }] }] };
    r.skipped = [{ url: 'https://agency.example/private', reason: 'Blocked by robots.txt' }];
    const c = reportCoverage(r);
    expect(c.interactionPages).toEqual([r.site]);
    expect(c.sampled).toBe(true);
    expect(c.excluded).toEqual(r.skipped);
    expect(c.unsuccessfulTests[0]!.reason).toContain('Timed out');
    expect(c.standards.additional22).toEqual(['2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8']);
    expect(c.standards.wcag21).toHaveLength(49);
  });
});

it('keeps each document’s own criterion references instead of assigning the bundle to every file', () => {
  const r = site();
  r.documentChecks = [
    { url: 'https://agency.example/a.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [r.site], checks: { pages: 1, pagesChecked: 1, tagged: false, hasTitle: true, hasLanguage: true, imageOnly: false } },
    { url: 'https://agency.example/b.pdf', type: 'pdf', detectedBy: 'extension', linkedFrom: [r.site], checks: { pages: 1, pagesChecked: 1, tagged: true, hasTitle: false, hasLanguage: true, imageOnly: false } },
  ];
  const docs = buildJobs(r).problems.filter((p) => p.sourceKey === 'documents');
  expect(docs.find((p) => p.locations[0]!.page.endsWith('/a.pdf'))!.criteria).not.toContain('2.4.2');
  expect(docs.find((p) => p.locations[0]!.page.endsWith('/b.pdf'))!.criteria).toEqual(['2.4.2']);
});

it('retains unresolved methods even when another method already failed the criterion', () => {
  const r = site();
  const row = r.criteria!.find((c) => c.criterion === '2.1.2')!;
  row.status = 'failed';
  row.methods = [
    { id: 'probe:keyboard', kind: 'interaction', status: 'failed', pages: 1 },
    { id: 'probe:other', kind: 'interaction', status: 'not_testable', pages: 1, note: 'The other task could not be checked.' },
  ];
  expect(reportCoverage(r).unresolved.some((c) => c.criterion === '2.1.2')).toBe(true);
});

it('keeps a problem code when a related scored failure is repaired and the unscored problem stands alone', () => {
  const r = site();
  r.testIssues = [{ criterion: '2.4.7', title: 'Visible focus', probes: ['keyboard'], pointsLost: 0, pagesAffected: [r.site], evidence: [] }];
  r.probes = { runs: [
    { probe: 'keyboard', kind: 'interaction', page: r.site, criteria: ['2.4.7'], status: 'ok', ms: 1, findings: [{ criterion: '2.4.7', status: 'failed', target: 'nav a:nth-child(1)', detail: 'No focus outline.' }] },
    { probe: 'forced-colors', kind: 'render', page: r.site, criteria: ['2.4.7'], status: 'ok', ms: 1, findings: [{ criterion: '2.4.7', status: 'failed', target: 'nav a:nth-child(2)', detail: 'No outline in high contrast.' }] },
  ] };
  const previous = buildJobs(r);
  const before = previous.problems.find((p) => p.sourceKey === 'criterion:2.4.7/listed')!;
  r.repair = previous;
  const entries = previous.codeMap.problems.filter((entry) => previous.problems.some((p) => p.code === entry.code && p.criteria.includes('2.4.7')));
  expect(entries).toHaveLength(2);
  expect(entries[0]!.matches.filter((match) => entries[1]!.matches.includes(match))).toEqual([]);
  expect(before).toBeDefined();
  r.testIssues = [];
  r.probes.runs[0]!.findings[0]!.status = 'no_failures_found';
  const after = buildJobs(r).problems.find((p) => p.sourceKey === 'criterion:2.4.7')!;
  expect(after.code).toBe(before.code);
});

it('gives separate media assets their own problems and a shared publishing job', () => {
  const r = site();
  r.media = ['first', 'second'].map((name) => ({ kind: 'video', content: 'video', url: `https://agency.example/${name}.mp4`, foundOn: [r.site], captions: 'none', issues: [{ criterion: '1.2.2', level: 'problem', rule: 'no-captions-track', message: 'This video has no captions track.' }] }));
  const model = buildJobs(r);
  const media = model.problems.filter((p) => p.sourceKey === 'media:1.2.2');
  expect(media).toHaveLength(2);
  expect(media.every((p) => p.title === 'Videos have no captions')).toBe(true);
  expect(new Set(media.map((p) => p.code)).size).toBe(2);
  expect(new Set(media.map((p) => p.job)).size).toBe(1);
  expect(model.jobs.find((j) => j.kind === 'media')!.volume).toContain('2 affected media assets');
});


describe('round three sibling identity', () => {
  const audit = (controls: { name: string; position: number; presentation?: boolean }[]): SiteReport => {
    const page: PageAudit = { url: 'https://agency.example/', status: 'ok', rules: { 'aria-allowed-attr': 'fail' }, incomplete: [], links: [], violations: [{
      id: 'aria-allowed-attr', help: 'Use supported ARIA attributes', helpUrl: '', nodes: controls.map(({ name, position, presentation }) => ({
        target: `main > button:nth-child(${position})`, html: `<button aria-label="${name}"${presentation ? ' class="presentation"' : ''} aria-checked="true">${name}</button>`, viewports: ['desktop'],
      })),
    }] };
    return buildReport({ site: page.url, pages: [page], documents: [], skipped: [], userAgent: 'test', startedAt: '', finishedAt: '' });
  };

  it('keeps Alpha’s code, reserves fixed Beta’s code and gives New a new code with only its own evidence', () => {
    const first = audit([{ name: 'Alpha', position: 1 }, { name: 'Beta', position: 2 }]);
    const before = buildJobs(first);
    const owner = (model: ReturnType<typeof buildJobs>, name: string) => model.problems.find((p) => p.observations.some((o) => o.html?.includes(`aria-label="${name}"`)))!;
    expect(owner(before, 'Alpha').code).toBe('P1');
    expect(owner(before, 'Beta').code).toBe('P2');
    for (const name of ['Alpha', 'Beta']) expect(owner(before, name).observations.filter((o) => o.html).every((o) => o.html!.includes(`aria-label="${name}"`))).toBe(true);
    const next = audit([{ name: 'Alpha', position: 1, presentation: true }, { name: 'New', position: 3 }]);
    const after = buildJobs(next, undefined, before.codeMap);
    expect(owner(after, 'Alpha').code).toBe('P1');
    expect(owner(after, 'New').code).toBe('P3');
    expect(after.problems.some((p) => p.code === 'P2')).toBe(false);
    for (const name of ['Alpha', 'New']) expect(owner(after, name).observations.filter((o) => o.html).every((o) => o.html!.includes(`aria-label="${name}"`))).toBe(true);
    expect(after.codeMap.problems.map((p) => p.code)).toEqual(['P1', 'P2', 'P3']);
  });

  it('does not consume an ambiguous historical normalized selector, even when another sibling has matched', () => {
    const before = buildJobs(audit([{ name: 'Alpha', position: 1 }, { name: 'Beta', position: 2 }]));
    const after = buildJobs(audit([{ name: 'Alpha', position: 1, presentation: true }, { name: 'New', position: 3 }]), undefined, {
      ...before.codeMap, problems: before.codeMap.problems.map((p) => ({ ...p, matches: p.matches.filter((m) => !m.startsWith('exact:')) })),
    });
    expect(after.problems.find((p) => p.locations[0]!.target.endsWith('(3)'))!.code).toBe('P3');
  });
});

describe('round four stable selector identity', () => {
  const audit = (controls: { target: string; name: string }[]): SiteReport => {
    const page: PageAudit = { url: 'https://agency.example/', status: 'ok', rules: { 'aria-allowed-attr': 'fail' }, incomplete: [], links: [], violations: [{
      id: 'aria-allowed-attr', help: 'Use supported ARIA attributes', helpUrl: '', nodes: controls.map(({ target, name }) => {
        const tag = target.startsWith('a[') ? 'a' : target.startsWith('label[') ? 'label' : 'button';
        return { target, html: `<${tag} aria-label="${name}" aria-checked="true">${name}</${tag}>`, viewports: ['desktop'] };
      }),
    }] };
    return buildReport({ site: page.url, pages: [page], documents: [], skipped: [], userAgent: 'test', startedAt: '', finishedAt: '' });
  };
  const before = buildJobs(audit([{ target: '#save', name: 'Save' }]));

  it.each(['main > button', 'main > section > button', 'main > button:nth-child(1)', 'button.primary', 'button[id]', 'button[data-label="#save"]', 'button[href="/save"]'])('reserves Beta’s code when New replaces it at the selector without persistent identity %s', (target) => {
    const first = buildJobs(audit([{ target: '#alpha', name: 'Alpha' }, { target, name: 'Beta' }]));
    const alpha = first.problems.find((p) => p.locations[0]!.target === '#alpha')!.code;
    if (target === 'main > button') {
      expect(alpha).toBe('P1');
      expect(first.problems.find((p) => p.locations[0]!.target === target)!.code).toBe('P2');
    }
    const after = buildJobs(audit([{ target: '#alpha', name: 'Alpha' }, { target, name: 'New' }]), undefined, first.codeMap);
    expect(after.problems.find((p) => p.locations[0]!.target === '#alpha')!.code).toBe(alpha);
    expect(after.problems.find((p) => p.locations[0]!.target === target)!.code).toBe('P3');
    expect(after.codeMap.problems.map((p) => p.code)).toEqual(['P1', 'P2', 'P3']);
  });

  it.each(['button[id="save"]', '[data-testid="save"]', '[data-test="save"]', '[data-id="save"]', 'button[name="save"]', 'label[for="save"]', 'a[href="/save"]', '#save > button:nth-child(1)'])('keeps a renamed control’s code with the persistent selector %s', (target) => {
    const first = buildJobs(audit([{ target, name: 'Save' }]));
    const after = buildJobs(audit([{ target, name: 'Save changes' }]), undefined, first.codeMap);
    expect(after.problems[0]!.code).toBe('P1');
  });

  it.each(['#\\31 23', '#保存'])('an escaped or non-ASCII id (%s) keeps its code when renamed, and a new #new-save named Save gets P2', (target) => {
    const first = buildJobs(audit([{ target, name: 'Save' }]));
    const controls = [{ target, name: 'Save changes' }, { target: '#new-save', name: 'Save' }];
    for (const order of [controls, [...controls].reverse()]) {
      const after = buildJobs(audit(order), undefined, first.codeMap);
      expect(after.problems.find((p) => p.locations[0]!.target === target)!.code).toBe('P1');
      expect(after.problems.find((p) => p.locations[0]!.target === '#new-save')!.code).toBe('P2');
    }
  });

  it('keeps P1 on #save after its label changes to Save changes', () => {
    expect(before.problems[0]!.code).toBe('P1');
    const after = buildJobs(audit([{ target: '#save', name: 'Save changes' }]), undefined, before.codeMap);
    expect(after.problems[0]!.code).toBe('P1');
  });

  it('resolves #save before a new #new-save named Save can claim P1, in either input order', () => {
    const controls = [{ target: '#save', name: 'Save changes' }, { target: '#new-save', name: 'Save' }];
    for (const order of [controls, [...controls].reverse()]) {
      const after = buildJobs(audit(order), undefined, before.codeMap);
      expect(after.problems.find((p) => p.locations[0]!.target === '#save')!.code).toBe('P1');
      expect(after.problems.find((p) => p.locations[0]!.target === '#new-save')!.code).toBe('P2');
      const again = buildJobs(audit(order), undefined, after.codeMap);
      expect(again).toEqual(after);
    }
  });
});

describe('round three job numbering', () => {
  it('assigns J1 through J8 from top to bottom on the fixture’s first scan', () => {
    const r: SiteReport = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/print/e2e-fixture-report.json.gz', import.meta.url))).toString());
    delete r.repair;
    expect(buildJobs(r).jobs.map((j) => j.code)).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8']);
  });

  it('carries existing job codes unchanged when their priority order moves', () => {
    const r = site(['/']);
    delete r.repair;
    r.rules[0]!.impact = 'serious';
    r.rules.push({ ...r.rules[0]!, id: 'image-alt', impact: 'moderate' });
    const before = buildJobs(r);
    expect(before.jobs.map((j) => j.kind)).toEqual(['settings', 'content']);
    r.repair = before;
    r.rules[1]!.impact = 'critical';
    const after = buildJobs(r);
    expect(after.jobs.map((j) => j.kind)).toEqual(['content', 'settings']);
    expect(after.jobs.map((j) => j.code)).toEqual(['J2', 'J1']);
    for (const job of after.jobs) expect(job.code).toBe(before.jobs.find((j) => j.kind === job.kind)!.code);
  });
});

it('reserves a fixed named sibling’s code when a differently named control replaces it at the exact selector', () => {
  const r = site(['/']);
  delete r.repair;
  r.rules[0]!.id = 'aria-allowed-attr';
  r.rules[0]!.causes = ['Alpha', 'Beta'].map((name, i) => ({ fingerprint: `rule:aria-allowed-attr\nmain > button:nth(*)\n<button aria-label="${name}">`, pages: [r.site], target: `main > button:nth-child(${i + 1})`, html: `<button aria-label="${name}">`, occurrences: 1 }));
  r.rules[0]!.examples = r.rules[0]!.causes.map((c) => ({ page: r.site, target: c.target, html: c.html }));
  const before = buildJobs(r);
  r.repair = before;
  r.rules[0]!.causes[1]!.fingerprint = r.rules[0]!.causes[1]!.fingerprint.replace('Beta', 'New');
  r.rules[0]!.causes[1]!.html = '<button aria-label="New">';
  r.rules[0]!.examples[1]!.html = '<button aria-label="New">';
  const after = buildJobs(r);
  expect(after.problems.find((p) => p.locations[0]!.target.endsWith('(2)'))!.code).toBe('P3');
});
