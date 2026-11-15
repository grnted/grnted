// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The heading structure probe's rules (1.3.1, 2.4.6), on what the page reader reports. The reader
// itself runs in Chromium: test/integration/headings.test.ts.
import { describe, expect, it } from 'vitest';
import { headingFindings, readsAsParagraph, headingsProbe, templateH1Findings, type HeadingRead, type HeadingsRead } from '../../src/probes/headings.js';
import { PROBES, SCORED_PROBES } from '../../src/probes/registry.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { ProbeRun } from '../../src/types.js';

const h = (level: number, text: string, target = `#h-${text || level}`): HeadingRead => ({ level, text, target });
const read = (headings: HeadingRead[], extra: Partial<HeadingsRead> = {}): HeadingsRead => ({
  title: 'Page', headings, truncated: false, frameH1: false, bigUnreadableFrame: false, ...extra,
});
const kinds = (r: HeadingsRead) => headingFindings(r).map((f) => [f.criterion, f.status, f.target ?? '']);

describe('headingFindings', () => {
  it('finds nothing in a well-formed outline, going back up any number of levels', () => {
    expect(headingFindings(read([h(1, 'Page')]))).toEqual([]);
    expect(headingFindings(read([h(1, 'Page'), h(2, 'A'), h(3, 'B'), h(4, 'C'), h(2, 'D'), h(3, 'E')]))).toEqual([]);
    // Several level-1 headings are allowed.
    expect(headingFindings(read([h(1, 'Site'), h(1, 'Page'), h(2, 'A')]))).toEqual([]);
    // A level-1 heading in a same-origin frame names the page.
    expect(headingFindings(read([h(2, 'A')], { frameH1: true }))).toEqual([]);
  });

  // Real-site audit 2026-11-07 (12 Oregon sites): 32 skipped-level and 5 no-level-1 failures were all FALSE.
  // WCAG requires neither (H42 is sufficient with any levels; 2.4.6 asks only that headings describe).
  it('lists a page with no level-1 heading as a recommendation, never a failure', () => {
    const [none] = headingFindings(read([]));
    expect(none).toMatchObject({ criterion: '2.4.6', status: 'no_failures_found', advice: true });
    expect(none!.detail).toMatch(/no headings/);
    // As on oakridge-sd:028 ("Latest News" at level 2) and albany:036.
    const [first] = headingFindings(read([h(2, 'Latest News', '#w'), h(3, 'News')]));
    expect(first).toMatchObject({ criterion: '2.4.6', status: 'no_failures_found', advice: true, target: '#w' });
    expect(first!.detail).toContain('“Latest News” at level 2');
    expect(headingFindings(read([h(2, 'A')])).some((f) => f.status === 'failed')).toBe(false);
  });

  // Batch 19, the lead's ruling: an empty heading is Needs review under 1.3.1 ('flagged'), not a failure (ACT ffd0e9
  // now maps to ARIA 1.2 only; axe's empty-heading is a best practice).
  it('flags 1.3.1 for review for each heading with no text, an empty level-1 heading too', () => {
    expect(kinds(read([h(1, 'Page'), h(2, '', '#e1'), h(2, 'B'), h(3, '', '#e2')]))).toEqual([['1.3.1', 'flagged', '#e1'], ['1.3.1', 'flagged', '#e2']]);
    const only = headingFindings(read([h(1, '', '#empty-h1'), h(2, 'A')]));
    expect(only.filter((f) => f.status === 'flagged')).toEqual([expect.objectContaining({ criterion: '1.3.1', status: 'flagged', target: '#empty-h1' })]);
    expect(only.find((f) => f.status === 'flagged')!.detail).toMatch(/level-1 heading has no text/);
    // Lists a few per page, then counts the rest.
    const many = headingFindings(read([h(1, 'Page'), ...Array.from({ length: 8 }, (_, i) => h(2, '', `#e${i}`))]));
    expect(many).toHaveLength(5);
    expect(many[4]!.detail).toMatch(/3 more/);
  });

  it('fails 1.3.1 for a paragraph marked up as a heading (F43), as beaverton-sd:006:b and :010', () => {
    // Two sentences (F43). One sentence with a full stop is a title (Grok round 2).
    const text = 'The Beaverton School District includes 34 elementary schools, nine middle schools, six high schools and several option schools. They serve more than 35,000 students and families across a large part of Washington County every year.';
    const f = headingFindings(read([h(1, 'About us'), { level: 2, text: `${text.slice(0, 119)}…`, chars: text.length, own: text, target: '#p' }]));
    expect(f).toEqual([expect.objectContaining({ criterion: '1.3.1', status: 'failed', target: '#p' })]);
    expect(f[0]!.detail).toMatch(new RegExp(`paragraph is marked up as a level-2 heading \\(${text.length} characters\\)`));
    // Grok round 1 (2026-11-07): a 210-character one-clause title is a title (failed on 55f79a60).
    const title = 'The Beaverton School District Board of Directors will hold a special meeting to consider the proposed boundary changes for the new elementary school and to take public comment on the 2026 facilities plan';
    expect(title.length).toBeGreaterThanOrEqual(200);
    expect(headingFindings(read([h(1, 'Page'), { level: 2, text: `${title.slice(0, 119)}…`, chars: title.length, own: title, target: '#t' }]))).toEqual([]);
    // Grok round 2: the same title with a final period, and one ending in "Inc.", are titles (failed on 8cb45f8e).
    expect(headingFindings(read([h(1, 'Page'), { level: 2, text: title.slice(0, 119), chars: title.length + 1, own: `${title}.`, target: '#t' }]))).toEqual([]);
    expect(readsAsParagraph('Annual report of the Fernwood Valley School District Facilities Committee to the board and the community on the 2026 bond projects, prepared with the help of the architects and engineers of Northwest Design Partners Inc.')).toBe(false);
    // Judged on its own seen text: a title padded past 200 by a visually hidden suffix is still a title.
    expect(headingFindings(read([h(1, 'Page'), { level: 2, text: 'Board meeting', chars: 230, own: 'Board meeting', target: '#t2' }]))).toEqual([]);
    // Two sentences (F43), with abbreviations that end no sentence.
    expect(readsAsParagraph('Calendar is subject to change based on contract negotiations and resource availability across every school in the district this year. In the event of inclement weather the district may add make-up days at the end')).toBe(true);
    expect(readsAsParagraph('Meeting of the St. Helens School District Board of Directors and the Columbia County Commission on the joint use of the Mt. Hood Community College campus and the new library building on Main Street in 2026')).toBe(false);
    // A long but real heading (a full article title) is fine.
    expect(headingFindings(read([h(1, 'Passing knowledge through generations: how Russian-speaking families in Portland keep their language alive')]))).toEqual([]);
  });

  it('lists levels that skip downwards by two or more as recommendations, never failures', () => {
    const f = headingFindings(read([h(1, 'Page'), h(2, 'News', '#news'), h(4, 'Event', '#event'), h(2, 'Back up'), h(5, 'Deep', '#deep')]));
    expect(f.map((x) => [x.criterion, x.status, x.advice, x.target])).toEqual([['1.3.1', 'no_failures_found', true, '#event'], ['1.3.1', 'no_failures_found', true, '#deep']]);
    expect(f[0]!.detail).toMatch(/from 2 to 4.*“Event”.*“News”/);
    // As on beaverton-sd:007 (h5 "Accountability" under h2 "A").
    expect(headingFindings(read([h(1, 'Departments'), h(2, 'A'), h(5, 'Accountability', '#s')])).filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('makes no recommendation about the main heading on a large page or one inside another site\'s frame', () => {
    expect(kinds(read([h(2, 'A')], { bigUnreadableFrame: true }))).toEqual([]);
    expect(kinds(read([], { truncated: true }))).toEqual([]);
    expect(headingFindings(read([h(1, 'Page')], { truncated: true }))).toEqual([]);
  });
});

/** A run of the headings probe on `path` with the data its run keeps. */
const run = (path: string, title: string, h1: string[], extra: Partial<ProbeRun> = {}) => ({
  probe: 'headings', kind: 'render' as const, page: `https://e.org${path}`, criteria: ['1.3.1', '2.4.6'], status: 'ok' as const, findings: [], ms: 1,
  data: { title, h1: h1.map((text, i) => ({ text, target: `h1:nth-of-type(${i + 1})` })) }, ...extra,
});
const site = (rows: ReturnType<typeof run>[]) => rows.map((r, index) => ({ run: r as ProbeRun, index }));
const flagged = (m: Map<string, unknown>) => [...m.keys()].map((u) => new URL(u).pathname);

describe('templateH1Findings (the site name as every page\'s main heading)', () => {
  it('fails every page but the start page whose only main heading is the shared one, when titles differ', () => {
    const m = templateH1Findings(site([
      run('/', 'Riverside Library', ['Riverside Library']),
      run('/a', 'A | Riverside', ['riverside LIBRARY']),
      run('/b', 'B | Riverside', ['Riverside Library']),
      run('/c', 'C | Riverside', ['Riverside Library', 'Riverside Library']),
      run('/d', 'D | Riverside', ['Riverside Library', 'Page D']),
    ]));
    // /d also has a heading of its own; the start page is exempt.
    expect(flagged(m)).toEqual(['/a', '/b', '/c']);
    const [f] = m.get('https://e.org/a')!;
    expect(f).toMatchObject({ criterion: '2.4.6', status: 'failed', target: 'h1:nth-of-type(1)' });
    expect(f!.detail).toMatch(/“riverside LIBRARY”.*same on nearly every page.*5 of the 5.*“A \| Riverside”/);
  });

  it('needs at least 3 pages and 80% of the pages with a level-1 heading', () => {
    expect(templateH1Findings(site([run('/', 'Home', ['Site']), run('/a', 'A', ['Site'])])).size).toBe(0);
    expect(flagged(templateH1Findings(site([run('/', 'Home', ['Site']), run('/a', 'A', ['Site']), run('/b', 'B', ['Site'])])))).toEqual(['/a', '/b']);
    // 4 of 5 is 80%; 3 of 5 is not.
    const four = [run('/', 'H', ['Site']), run('/a', 'A', ['Site']), run('/b', 'B', ['Site']), run('/c', 'C', ['Site']), run('/d', 'D', ['Own'])];
    expect(flagged(templateH1Findings(site(four)))).toEqual(['/a', '/b', '/c']);
    const three = [run('/', 'H', ['Site']), run('/a', 'A', ['Site']), run('/b', 'B', ['Site']), run('/c', 'C', ['Own C']), run('/d', 'D', ['Own D'])];
    expect(templateH1Findings(site(three)).size).toBe(0);
    // Pages with no level-1 heading do not count against the share.
    expect(flagged(templateH1Findings(site([...four.slice(0, 4), run('/e', 'E', []), run('/f', 'F', [])])))).toEqual(['/a', '/b', '/c']);
  });

  it('finds nothing when the pages share their title too, or the same page is scanned under several addresses', () => {
    expect(templateH1Findings(site([run('/', 'Home', ['Site']), run('/a', 'Home', ['Site']), run('/b', 'home ', ['Site'])])).size).toBe(0);
  });

  it('leaves out runs that did not end ok, lack data or could not be tested', () => {
    const rows = [
      run('/', 'H', ['Site']), run('/a', 'A', ['Site']), run('/b', 'B', ['Site']),
      run('/t', 'T', ['Site'], { status: 'timeout' }),
      run('/n', 'N', ['Site'], { findings: [{ criterion: '2.4.6', status: 'not_testable', detail: 'x' }] }),
      run('/x', 'X', ['Site'], { data: undefined }),
    ];
    expect(flagged(templateH1Findings(site(rows)))).toEqual(['/a', '/b']);
    // Only two usable pages: nothing.
    expect(templateH1Findings(site(rows.filter((r) => r.page !== 'https://e.org/b'))).size).toBe(0);
  });

  it('is the same whatever order the runs come in', () => {
    const rows = site([run('/', 'H', ['Site']), run('/a', 'A', ['Site']), run('/b', 'B', ['Site']), run('/c', 'C', ['Site'])]);
    expect([...templateH1Findings([...rows].reverse())].sort()).toEqual([...templateH1Findings(rows)].sort());
  });
});

describe('registry', () => {
  it('scores the headings probe and runs it and text contrast on every page', () => {
    expect(PROBES).toContain(headingsProbe);
    expect(SCORED_PROBES.has('headings')).toBe(true);
    expect(headingsProbe).toMatchObject({ tier: 'core', everyPage: true, criteria: ['1.3.1', '2.4.6'] });
    expect(textContrastProbe.everyPage).toBe(true);
    // Only cheap core probes run on every page: since 2026-11-10 also the render and pixel tests that share
    // their page load and together take about 2 s (red-team, coverage lane), and the semantics lane's
    // language-parts and names reads; since batch 17 the picture test (it reads SVG pictures' words: 11 ms a page).
    expect(PROBES.filter((p) => p.everyPage).map((p) => p.id).sort()).toEqual(['aria-states', 'headings', 'language-parts', 'link-color', 'link-purpose', 'media-alternatives', 'media-files', 'names', 'non-text-contrast', 'page-titles', 'picture-text', 'reflow', 'resize-text', 'text-contrast', 'text-spacing']);
    expect(PROBES.filter((p) => p.everyPage).every((p) => p.tier === 'core' && !p.isolate && !p.initScript && !p.sendsNothing && !p.contextOptions && !p.viewport)).toBe(true);
  });
});
