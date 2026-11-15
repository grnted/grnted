// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page titles that cannot describe their page (src/probes/pageTitles.ts): pure rules, no browser.
import { describe, expect, it } from 'vitest';
import { genericTitleFindings, isDefaultFileTitle, ownTitleFindings, pageTitlesProbe, pathHash, PLACEHOLDER_TITLE, sharesTopic, STALE_MIN_WORDS, titleFindingsAcross, titleParts, topicWords, type TitleData } from '../../src/probes/pageTitles.js';
import { withAcrossPages } from '../../src/probes/runner.js';
import type { ProbeRun } from '../../src/types.js';

const data = (title: string, h1: string): TitleData => ({ v: 1, title, h1 });
const run = (page: string, title: string, h1: string, index: number, findings: ProbeRun['findings'] = []) =>
  ({ index, run: { probe: 'page-titles', kind: 'render', page: `https://town.example${page}`, criteria: ['2.4.2'], status: 'ok', findings, ms: 1, data: data(title, h1) } as ProbeRun });
const on = (m: Map<string, ProbeRun['findings']>, status: string) => [...m].filter(([, f]) => f.some((x) => x.status === status)).map(([u]) => new URL(u).pathname).sort();
const failedOn = (m: Map<string, ProbeRun['findings']>) => on(m, 'failed');
const unsureOn = (m: Map<string, ProbeRun['findings']>) => on(m, 'not_testable');

describe('one page', () => {
  it('fails a known placeholder (F25)', () => {
    for (const t of ['Untitled', 'Untitled Document', 'Page', 'New Page', 'Document', 'Page Title', 'Insert title here', 'Sample Page', 'My Site']) {
      expect(PLACEHOLDER_TITLE.test(t), t).toBe(true);
      expect(ownTitleFindings(data(t, 'Plot rents'), 'https://town.example/plots', 3).map((f) => f.status), t).toEqual(['failed']);
    }
    expect(ownTitleFindings(data('Page', 'Water butts and hoses'), 'https://town.example/water', 5)[0]!.detail).toBe('The page\'s title is “Page”, which says nothing about the page (its main heading is “Water butts and hoses”).');
  });
  it('fails a file name that describes nothing: a default name, a number, a hash', () => {
    for (const t of ['index.html', 'default.aspx', 'page1.htm', 'untitled.html', 'new-page-2.html', '48213.html', 'a3f9c2e17b04.php', 'doc_0042.html']) {
      expect(isDefaultFileTitle(t), t).toBe(true);
      expect(ownTitleFindings(data(t, 'Plot rents'), 'https://town.example/plots', 3).map((f) => f.status), t).toEqual(['failed']);
    }
    expect(ownTitleFindings(data('index.html', 'Plot rents'), 'https://town.example/plots', 3)[0]!.detail).toBe('The page\'s title is “index.html”, a file name that says nothing about the page (its main heading is “Plot rents”).');
  });
  // Review r1, finding 10: F25 names file names "that are not descriptive in their own right", not every file name.
  // Review r2, finding 6: a short name can be the page's own ("HR", "CV"); its length proves nothing.
  it('a file name of fewer than three letters is a doubt, never a failure: "hr.html", "cv.html"', () => {
    for (const [title, h1] of [['hr.html', 'HR'], ['cv.html', 'CV']] as const) {
      const f = ownTitleFindings(data(title, h1), 'https://town.example/page', 3);
      expect(f.map((x) => x.status), title).toEqual(['not_testable']);
      expect(f[0]!.detail, title).toContain('too short for the test to tell');
    }
    // A short part beside a default one is a doubt too; a default name or a number alone still fails.
    expect(ownTitleFindings(data('page-a.html', 'Plot rents'), 'https://town.example/page', 3).map((x) => x.status)).toEqual(['not_testable']);
    for (const title of ['index.html', '48213.html', 'page1.htm']) expect(ownTitleFindings(data(title, 'Plot rents'), 'https://town.example/page', 3).map((x) => x.status), title).toEqual(['failed']);
  });

  it('look-alike: a file name that describes the page is not failed', () => {
    for (const t of ['public-meeting-agendas.html', 'plot-rents-2026.html', 'compost_bays.php', 'about.html', 'seed-swap.htm']) {
      expect(isDefaultFileTitle(t), t).toBe(false);
      expect(ownTitleFindings(data(t, 'Meeting agendas'), 'https://town.example/agendas', 3), t).toEqual([]);
    }
  });
  it('look-alikes: real titles that start like a placeholder, or name the page in words of their own', () => {
    for (const t of ['Page not found', 'Documents and forms', 'Title IX', 'New pages this month', 'Plot rents | Marsh Lane Allotments', 'Contact us']) {
      expect(ownTitleFindings(data(t, 'Get in touch'), 'https://town.example/contact', 3), t).toEqual([]);
    }
  });
  // Review r1, finding 9 and the ruling on it: only definite F25 cases fail. "Home" on another page is a doubt.
  it('"Home" on a page that is not the home page is not failed: a person has to judge it', () => {
    const f = ownTitleFindings(data('Home', 'Tool shed'), 'https://town.example/tools/', 4);
    expect(f.map((x) => [x.status, x.detail])).toEqual([['not_testable', 'The page\'s title is “Home”, though this is not the home page (its main heading is “Tool shed”); whether that title describes the page is for a person to judge.']]);
    expect(ownTitleFindings(data('Home | Marsh Lane Allotments', 'Frost warning'), 'https://town.example/news/frost', 4).map((x) => x.status)).toEqual(['not_testable']);
  });
  it('look-alikes: "Home" on the home page; a trail that also names the page; a page about a home', () => {
    expect(ownTitleFindings(data('Home', 'Welcome to the allotments'), 'https://town.example/', 0)).toEqual([]);
    expect(ownTitleFindings(data('Home', 'Welcome'), 'https://town.example/index.html', 7)).toEqual([]);
    expect(ownTitleFindings(data('Home » News » Frost warning', 'Frost warning'), 'https://town.example/news/frost', 4)).toEqual([]);
    expect(ownTitleFindings(data('Home | Housing', 'Home repair loans'), 'https://town.example/housing/home-repair', 4)).toEqual([]);
  });
});

describe('words in common', () => {
  it('compares by topic words, endings and stop words left out', () => {
    expect(sharesTopic('Rents', 'Rent bands and deposits')).toBe(true);
    expect(sharesTopic('Dig days', 'Dig day dates')).toBe(true);
    expect(sharesTopic('Marsh Lane Allotments', 'Plot rents')).toBe(false);
    expect(sharesTopic('About us', 'Our story')).toBe(false);
    expect(titleParts('Plots | Marsh Lane Allotments')).toEqual(['Plots', 'Marsh Lane Allotments']);
    expect(titleParts('Home » News » Frost')).toEqual(['Home', 'News', 'Frost']);
    expect(titleParts('Self-service portal')).toEqual(['Self-service portal']);
  });
});

describe('across the scanned pages: doubts, never failures', () => {
  it('the same title on pages about different things is "not testable" on each (never on the start page)', () => {
    const out = titleFindingsAcross([
      run('/', 'Marsh Lane Allotments', 'Marsh Lane Allotments', 0),
      run('/plots', 'Marsh Lane Allotments', 'Plot rents', 1),
      run('/wardens', 'Marsh Lane Allotments', 'Site wardens', 2),
      run('/about', 'About | Marsh Lane Allotments', 'About the allotments', 3),
    ]);
    expect(failedOn(out)).toEqual([]);
    expect(unsureOn(out)).toEqual(['/plots', '/wardens']);
    expect(out.get('https://town.example/plots')![0]!.detail).toBe('The page\'s title, “Marsh Lane Allotments”, is also the title of 2 other scanned pages about something else (/: “Marsh Lane Allotments”), and it shares no word with this page\'s main heading, “Plot rents”; whether it describes this page is for a person to judge.');
  });
  it('look-alikes: the same title on pages with the same main heading (a list and its second page); a shared title that names each page', () => {
    expect(titleFindingsAcross([run('/', 'Town', 'Welcome', 0), run('/news', 'News | Town', 'News', 1), run('/news?page=2', 'News | Town', 'News', 2)]).size).toBe(0);
    expect(titleFindingsAcross([run('/', 'Town', 'Welcome', 0), run('/parks', 'Parks and trails | Town', 'Our parks', 1), run('/trails', 'Parks and trails | Town', 'Trail maps', 2)]).size).toBe(0);
  });
  // Review r1, finding 9: a title that happens to be another page's main heading proves nothing about this page.
  it('a title that is another page\'s main heading says nothing: "Contact" on the contact page, beside a directory headed "Contact"', () => {
    expect(titleFindingsAcross([
      run('/', 'Town', 'Welcome', 0),
      run('/contact', 'Contact', 'Get in touch', 1),
      run('/directory', 'Staff directory | Town', 'Contact', 2),
    ]).size).toBe(0);
    expect(titleFindingsAcross([
      run('/', 'Town', 'Welcome', 0),
      run('/swap', 'Seed swap day | Town', 'Seed swap day', 1),
      run('/compost', 'Seed swap day', 'Compost bays', 2),
    ]).size).toBe(0);
  });
  it('the site\'s name alone on a page with a topic of its own is "not testable"', () => {
    const out = titleFindingsAcross([
      run('/', 'Grow your own in the marsh | Marsh Lane Allotments', 'Grow your own in the marsh', 0),
      run('/plots', 'Marsh Lane Allotments', 'Plot rents', 1),
      run('/wardens', 'Wardens | Marsh Lane Allotments', 'Site wardens', 2),
      run('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 3),
    ]);
    expect(failedOn(out)).toEqual([]);
    expect(unsureOn(out)).toEqual(['/plots']);
    expect(out.get('https://town.example/plots')![0]!.detail).toBe('The page\'s title, “Marsh Lane Allotments”, is the site\'s name alone (the part most of the site\'s titles share), and it shares no word with this page\'s main heading, “Plot rents”; whether it describes this page is for a person to judge.');
  });
  it('look-alikes: the site\'s name on a page about the site itself; a part only two titles share; a short scan', () => {
    expect(titleFindingsAcross([
      run('/', 'Grow your own in the marsh | Marsh Lane Allotments', 'Grow your own in the marsh', 0),
      run('/about', 'Marsh Lane Allotments', 'About the allotments', 1),
      run('/wardens', 'Wardens | Marsh Lane Allotments', 'Site wardens', 2),
      run('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 3),
    ]).size).toBe(0);
    expect(titleFindingsAcross([
      run('/', 'News | Town of Alder', 'Latest from the town', 0),
      run('/news', 'News', 'Updates', 1),
      run('/parks', 'Parks | Town of Alder', 'Our parks', 2),
      run('/roads', 'Roads | Town of Alder', 'Street work', 3),
      run('/permits', 'Permits | Town of Alder', 'Allotment rules', 4),
    ]).size).toBe(0);
    expect(titleFindingsAcross([run('/', 'Welcome | Marsh Lane Allotments', 'Welcome', 0), run('/plots', 'Marsh Lane Allotments', 'Plot rents', 1)]).size).toBe(0);
  });
  it('leaves out pages with no main heading, pages a one-page rule already settled, and a title in other words of its own', () => {
    expect(titleFindingsAcross([run('/', 'Town', 'Welcome', 0), run('/a', 'Town', '', 1), run('/b', 'Town', 'Permits', 2, [{ criterion: '2.4.2', status: 'failed', detail: 'x' }])]).size).toBe(0);
    expect(titleFindingsAcross([run('/', 'Town', 'Welcome', 0), run('/contact', 'Contact us | Town', 'Get in touch', 1), run('/staff', 'Staff | Town', 'People', 2)]).size).toBe(0);
  });
});

// Batch 17 (structure lane): the stale title. Two facts together: the title's own part is another scanned page's
// main heading word for word (and that page's own title names it), AND the page's own content, read in the
// browser (`TitleData.hits`), uses none of the title's words. Either alone decides nothing (review r1, finding 9).
describe('across the scanned pages: a title that names another page and nothing on this one (batch 17)', () => {
  // (`more`: what else the page's read reports. By default an English page: 300 words, 60 of them function words.)
  const read = (page: string, title: string, h1: string, index: number, hits: string[] | undefined, words = 120, more: Partial<TitleData> = {}) =>
    ({ index, run: { probe: 'page-titles', kind: 'render', page: `https://town.example${page}`, criteria: ['2.4.2'], status: 'ok', findings: [], ms: 1, data: { v: 1, title, h1, ...(hits ? { hits, read: words, words: 300, en: 60 } : {}), ...more } } as ProbeRun });
  const site = (stale: ReturnType<typeof read>) => [
    read('/', 'Grow your own | Marsh Lane Allotments', 'Grow your own', 0, []),
    read('/swap', 'Seed swap day | Marsh Lane Allotments', 'Seed swap day', 1, ['seed', 'swap', 'day']),
    read('/wardens', 'Wardens | Marsh Lane Allotments', 'Site wardens', 2, ['warden']),
    read('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 3, []),
    stale,
  ];

  // Sol review of batch 17, S3 (lead's ruling): the two facts together are a doubt for a person, never a failure: a page
  // can be about its title in other words.
  it('Sol S3: the page whose title is another page\'s main heading word for word while nothing on it uses any of the title\'s words is a doubt, never a failure', () => {
    const out = titleFindingsAcross(site(read('/compost', 'Seed swap day', 'Compost bays', 4, [])));
    expect(failedOn(out)).toEqual([]);
    expect(unsureOn(out)).toEqual(['/compost']);
    expect(out.get('https://town.example/compost')![0]!.detail).toBe('The page\'s title, “Seed swap day”, may describe another page: “Seed swap day” is, word for word, the main heading of /swap, and none of its words is on this page (not in its main heading, “Compost bays”, its other headings, its text, its description or its address; the site\'s menus, and a header and footer most of its pages share, are left out); whether it describes this page in other words is for a person to judge.');
    // "Water conservation" over "Save every drop": the page may be about water conservation in other words.
    const water = titleFindingsAcross([...site(read('/tips', 'Water conservation | Marsh Lane Allotments', 'Save every drop', 4, [])), read('/conservation', 'Water conservation | Marsh Lane Allotments', 'Water conservation', 5, ['water', 'conservation'])]);
    expect(failedOn(water)).toEqual([]);
    expect(unsureOn(water)).toEqual(['/tips']);
    // With the site's name after it, the same.
    expect(unsureOn(titleFindingsAcross(site(read('/compost', 'Seed swap day | Marsh Lane Allotments', 'Compost bays', 4, ['marsh', 'lane', 'allotment']))))).toEqual(['/compost']);
  });

  it('look-alikes that are never failed: the page uses one of the title\'s words, it was read before this rule, it has too little text, the name is one word, the other page\'s title names something else', () => {
    // One word of the title is in the page's own text: it may be about it.
    expect(failedOn(titleFindingsAcross(site(read('/compost', 'Seed swap day', 'Compost bays', 4, ['day']))))).toEqual([]);
    // No content read (a run from before the rule): nothing is concluded, as in review r1, finding 9.
    expect(titleFindingsAcross(site(read('/compost', 'Seed swap day', 'Compost bays', 4, undefined))).size).toBe(0);
    // A page with next to no text of its own.
    expect(failedOn(titleFindingsAcross(site(read('/compost', 'Seed swap day', 'Compost bays', 4, [], STALE_MIN_WORDS - 1))))).toEqual([]);
    // A one-word name ("Contact" on a page headed "Get in touch", beside a page headed and titled "Contact").
    expect(failedOn(titleFindingsAcross([
      read('/', 'Grow your own | Marsh Lane Allotments', 'Grow your own', 0, []),
      read('/contact', 'Contact', 'Get in touch', 1, []),
      read('/directory', 'Contact | Marsh Lane Allotments', 'Contact', 2, ['contact']),
      read('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 3, []),
    ]))).toEqual([]);
    // The other page is headed "Seed swap day" and titled for something else: its heading is not shown to be its name.
    expect(failedOn(titleFindingsAcross([
      read('/', 'Grow your own | Marsh Lane Allotments', 'Grow your own', 0, []),
      read('/events', 'What is on | Marsh Lane Allotments', 'Seed swap day', 1, []),
      read('/compost', 'Seed swap day', 'Compost bays', 2, []),
      read('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 3, []),
    ]))).toEqual([]);
    // The title's own words name this page too (it shares a word with its own main heading): never judged.
    expect(titleFindingsAcross(site(read('/swap2', 'Seed swap day', 'Swap rules', 4, []))).size).toBe(0);
    // Two own parts ("Events" and "Seed swap day"): the title is not one name.
    expect(failedOn(titleFindingsAcross(site(read('/compost', 'Events | Seed swap day', 'Compost bays', 4, []))))).toEqual([]);
  });

  // After the review of batch 17: the two facts fail a page only where nothing else explains the title. Each of
  // these has both facts, and stays a doubt (not testable), with the reason said.
  it('look-alikes with both facts that stay a doubt: a section\'s or a kind\'s name, the site\'s name, another language, a read that was cut short', () => {
    const doubtOf = (runs: ReturnType<typeof read>[], page = '/compost') => {
      const out = titleFindingsAcross(runs);
      expect(failedOn(out), page).toEqual([]);
      return out.get(`https://town.example${page}`)?.[0]?.detail ?? '';
    };
    const base = (other: ReturnType<typeof read>, stale: ReturnType<typeof read>, ...rest: ReturnType<typeof read>[]) => [
      read('/', 'Grow your own | Marsh Lane Allotments', 'Grow your own', 0, []),
      other,
      read('/wardens', 'Wardens | Marsh Lane Allotments', 'Site wardens', 2, ['warden']),
      read('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 3, []),
      stale,
      // (Enough other pages that a title three pages carry is not taken for the site's name.)
      read('/plots', 'Plot rents | Marsh Lane Allotments', 'Plot rents', 6, ['plot', 'rent']),
      read('/tools', 'Tool shed | Marsh Lane Allotments', 'Tool shed', 7, ['tool', 'shed']),
      ...rest,
    ];
    const swap = read('/swap', 'Seed swap day | Marsh Lane Allotments', 'Seed swap day', 1, ['seed', 'swap', 'day']);
    // The page lies under the page the title names: the title may name its section.
    expect(doubtOf(base(swap, read('/swap/rules', 'Seed swap day', 'What to bring', 4, [])), '/swap/rules')).toMatch(/this page lies under that page, so the title may name the section it is in/);
    expect(doubtOf(base(read('/swap/index.html', 'Seed swap day | Marsh Lane Allotments', 'Seed swap day', 1, ['seed']), read('/swap/rules.html', 'Seed swap day', 'What to bring', 4, [])), '/swap/rules.html')).toMatch(/lies under that page/);
    // The same address with another query (a step, a tab, a filter of one page).
    expect(doubtOf(base(swap, read('/swap?step=2', 'Seed swap day', 'What to bring', 4, [])), '/swap?step=2')).toMatch(/the two are one address/);
    // The page the title names leads to this page from its content (a section's first page lists its pages; a form
    // leads to its next step), or this page leads to it: the two may belong together.
    expect(doubtOf(base(read('/swap', 'Seed swap day | Marsh Lane Allotments', 'Seed swap day', 1, ['seed', 'swap', 'day'], 120, { out: [pathHash('/compost')] }), read('/compost', 'Seed swap day', 'Compost bays', 4, [])))).toMatch(/that page leads to this one from its content, so this page may belong to the section, or the task, that page heads/);
    expect(doubtOf(base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, [], 120, { out: [pathHash('/swap')] })))).toMatch(/this page leads to that page from its content, so the two may belong together/);
    // A third page carries the title too: a section's name, not one page's.
    expect(doubtOf(base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, []), read('/sheds', 'Seed swap day', 'Tool sheds', 5, ['day'])))).toMatch(/another scanned page carries that title too, so it may name a section of the site/);
    // Every word names a kind of page ("Frequently Asked Questions" over a page of questions on one subject).
    const faq = read('/faq', 'Frequently Asked Questions | Marsh Lane Allotments', 'Frequently Asked Questions', 1, ['frequently', 'ask', 'question']);
    expect(doubtOf(base(faq, read('/water', 'Frequently Asked Questions', 'Water on the plots', 4, [])), '/water')).toMatch(/its words name a kind of page, not one page/);
    // The title is the home page's main heading: the site's name.
    expect(doubtOf([
      read('/', 'Marsh Lane Allotments', 'Marsh Lane Allotments', 0, ['marsh', 'lane', 'allotment']),
      read('/wardens', 'Wardens', 'Site wardens', 1, ['warden']),
      read('/join', 'Join', 'Take on a plot', 2, []),
      read('/compost', 'Marsh Lane Allotments', 'Compost bays', 3, []),
    ])).toMatch(/that page is the site's home page, so the title may be the site's name/);
    // Another language: by the markup, by a translation link, by the words, or where the words could not tell.
    expect(doubtOf(base(read('/swap', 'Seed swap day | Marsh Lane Allotments', 'Seed swap day', 1, ['seed'], 120, { lang: 'en' }), read('/es/compost', 'Seed swap day', 'Compostaje', 4, [], 120, { lang: 'es' })), '/es/compost')).toMatch(/marked as being in different languages/);
    expect(doubtOf(base(swap, read('/trueque', 'Seed swap day', 'Trueque de semillas', 4, [], 120, { alts: ['/swap'] })), '/trueque')).toMatch(/marked as each other's translation/);
    expect(doubtOf(base(swap, read('/trueque', 'Seed swap day', 'Trueque de semillas', 4, [], 120, { words: 300, en: 2 })), '/trueque')).toMatch(/read as being in different languages/);
    expect(doubtOf(base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, [], 120, { words: 30, en: 6 })))).toMatch(/the language of one of the two pages could not be told from its words/);
    // (Between the two: a page in another language with English boilerplate in its content. Not told either.)
    expect(doubtOf(base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, [], 120, { words: 300, en: 12 })))).toMatch(/could not be told from its words/);
    // A word of the title in the page's own header or footer counts, unless most of the site's pages have that very
    // header and footer (the site's frame says nothing about one page).
    const framed = (frame: string, i: number) => read(['/a', '/b', '/c', '/d', '/e', '/f', '/g'][i]!, `Page ${i} | Marsh Lane Allotments`, `Page ${i}`, 10 + i, ['page'], 120, { frame });
    const sameFrame = [0, 1, 2, 3, 4, 5, 6].map((i) => framed('12:abc', i));
    expect(doubtOf([...base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, [], 120, { frameHits: ['seed'], frame: '12:abc' })), ...sameFrame])).toMatch(/may describe another page/);
    expect(titleFindingsAcross([...base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, [], 120, { frameHits: ['seed'], frame: '14:own' })), ...sameFrame]).has('https://town.example/compost')).toBe(false);
    // The read stopped before the end of the page: "no word of the title is on it" is not known. Nothing is said.
    expect(doubtOf(base(swap, read('/compost', 'Seed swap day', 'Compost bays', 4, [], 120, { partial: true })))).toBe('');
  });

  it('reads words as the comparison does: the in-page reader and topicWords agree (the reader is checked in a browser in the integration test)', () => {
    expect([...topicWords('Board Meeting Calendar')].sort()).toEqual(['board', 'calendar', 'meet']);
    expect([...topicWords('Employment Opportunities')].sort()).toEqual(['employment', 'opportunity']);
    expect([...topicWords('Café menus and prices')].sort()).toEqual(['caf', 'menu', 'pric']);
  });
});

describe('a title most of the site carries is the site\'s name, not a stale title', () => {
  it('when half of the scanned pages share the part, it is taken for the site\'s name and nothing is failed', () => {
    const mk = (page: string, title: string, h1: string, index: number) => ({ index, run: { probe: 'page-titles', kind: 'render', page: `https://town.example${page}`, criteria: ['2.4.2'], status: 'ok', findings: [], ms: 1, data: { v: 1, title, h1, hits: [], read: 100 } } as ProbeRun });
    const out = titleFindingsAcross([
      mk('/', 'Grow your own | Marsh Lane Allotments', 'Grow your own', 0),
      mk('/swap', 'Seed swap day', 'Seed swap day', 1),
      mk('/a', 'Seed swap day', 'Compost bays', 2),
      mk('/b', 'Seed swap day', 'Tool shed', 3),
      mk('/c', 'Seed swap day', 'Plot rents', 4),
    ]);
    expect(failedOn(out)).toEqual([]);
    expect(unsureOn(out)).toEqual(['/a', '/b', '/c']);
  });
});

// Batch 17: a title none of whose words the page uses, with nothing to say it names another page, is a doubt.
describe('across the scanned pages: a title that uses no word of its page (a doubt, never a failure)', () => {
  const mk = (page: string, title: string, h1: string, index: number, hits: string[] | undefined, read = 100) => ({ index, run: { probe: 'page-titles', kind: 'render', page: `https://town.example${page}`, criteria: ['2.4.2'], status: 'ok', findings: [], ms: 1, data: { v: 1, title, h1, ...(hits ? { hits, read } : {}) } } as ProbeRun });
  const site = (p: ReturnType<typeof mk>) => [
    mk('/', 'Grow your own | Marsh Lane Allotments', 'Grow your own', 0, ['grow', 'own']),
    mk('/wardens', 'Wardens | Marsh Lane Allotments', 'Site wardens', 1, ['warden']),
    mk('/join', 'Join | Marsh Lane Allotments', 'Take on a plot', 2, []),
    mk('/plots', 'Plot rents | Marsh Lane Allotments', 'Plot rents', 3, ['plot', 'rent']),
    p,
  ];
  it('raises the doubt for a title of two words or more that the page uses none of', () => {
    const out = titleFindingsAcross(site(mk('/hydrants', 'Order confirmation | Marsh Lane Allotments', 'Meet the board', 4, ['marsh', 'lane', 'allotment'])));
    expect(failedOn(out)).toEqual([]);
    expect(unsureOn(out)).toEqual(['/hydrants']);
    expect(out.get('https://town.example/hydrants')![0]!.detail).toBe('The page\'s title, “Order confirmation | Marsh Lane Allotments”, uses no word that this page uses: none of its words is in the page\'s main heading, “Meet the board”, its other headings, its text, its description or its address (the site\'s menus, and a header and footer most of its pages share, are left out); whether it describes this page is for a person to judge.');
  });
  it('look-alikes with no finding: the page uses a word of the title, a one-word title, a page read before this rule, next to no text', () => {
    expect(titleFindingsAcross(site(mk('/hydrants', 'Order confirmation | Marsh Lane Allotments', 'Meet the board', 4, ['order']))).size).toBe(0);
    expect(titleFindingsAcross(site(mk('/contact', 'Contact | Marsh Lane Allotments', 'Get in touch', 4, []))).size).toBe(0);
    expect(titleFindingsAcross(site(mk('/hydrants', 'Order confirmation | Marsh Lane Allotments', 'Meet the board', 4, undefined))).size).toBe(0);
    expect(titleFindingsAcross(site(mk('/hydrants', 'Order confirmation | Marsh Lane Allotments', 'Meet the board', 4, [], 5))).size).toBe(0);
  });
});

// Batch 17's fix round, the lead's ruling (c): a generic title ("Home", "Welcome"…) or the site's name alone fails 2.4.2
// only where the site's own pages demonstrate it. Data as the reader gives it now: the main heading is a level-1 heading
// with text of its own (`h1top`, `h1text`).
describe('across the scanned pages: a generic title or the site\'s name alone, demonstrated (ruling c)', () => {
  const mk = (page: string, title: string, h1: string, index: number, more: Partial<TitleData> = {}, findings: ProbeRun['findings'] = []) =>
    ({ index, run: { probe: 'page-titles', kind: 'render', page: `https://town.example${page}`, criteria: ['2.4.2'], status: 'ok', findings, ms: 1, data: { v: 1, title, h1, h1top: true, h1text: true, ...more } } as ProbeRun });
  const SITE = [
    mk('/', 'Home | Cedar Hollow Library', 'Welcome to Cedar Hollow Library', 0),
    mk('/catalogue', 'Catalogue | Cedar Hollow Library', 'Search the catalogue', 1),
    mk('/cards', 'Library cards | Cedar Hollow Library', 'Get a library card', 2),
    mk('/donate', 'Donate | Cedar Hollow Library', 'Give to the library', 3),
  ];
  const homeDoubt = (title: string, h1: string, path: string) => ownTitleFindings({ v: 1, title, h1 }, `https://town.example${path}`, 4);

  it('(A) fails a page that is not the home page, titled with a generic word and the site\'s name, whose own heading names something else', () => {
    for (const title of ['Home | Cedar Hollow Library', 'Home', 'Welcome', 'Index | Cedar Hollow Library', 'Main page', 'Home page | Cedar Hollow Library', 'Cedar Hollow Library | Home']) {
      const out = genericTitleFindings([...SITE, mk('/events', title, 'Story time and events', 4)]);
      expect(failedOn(out), title).toEqual(['/events']);
    }
    const out = genericTitleFindings([...SITE, mk('/events', 'Home | Cedar Hollow Library', 'Story time and events', 4)]);
    expect(out.get('https://town.example/events')![0]!.detail).toBe('The page\'s title, “Home | Cedar Hollow Library”, does not describe the page: it is the word “Home” and the site\'s name, while this is not the home page (/events) and its main heading, “Story time and events”, names what it is about.');
    // Through the cross-page rules, in place of any doubt; and it settles the page's own "Home" doubt.
    const own = homeDoubt('Home | Cedar Hollow Library', 'Story time and events', '/events');
    expect(own.map((f) => f.status)).toEqual(['not_testable']);
    const ran = withAcrossPages([pageTitlesProbe], [...SITE, mk('/events', 'Home | Cedar Hollow Library', 'Story time and events', 4, {}, own)]);
    expect(ran.find((r) => r.page.endsWith('/events'))!.findings.map((f) => f.status)).toEqual(['failed']);
  });

  it('(B) fails the site\'s name alone on two or more pages that are not the home page, headed otherwise', () => {
    const site = [
      mk('/', 'Cedar Hollow Library', 'Welcome to Cedar Hollow Library', 0),
      mk('/kids', 'Cedar Hollow Library', 'Books for children', 1),
      mk('/teens', 'Cedar Hollow Library', 'Teen corner', 2),
      mk('/cards', 'Library cards | Cedar Hollow Library', 'Get a library card', 3),
    ];
    const out = genericTitleFindings(site);
    expect(failedOn(out)).toEqual(['/kids', '/teens']);
    expect(out.get('https://town.example/kids')![0]!.detail).toBe('The page\'s title, “Cedar Hollow Library”, is the site\'s name alone, the title of another scanned page as well (/teens: “Teen corner”), so it does not tell this page from them; its main heading, “Books for children”, names what it is about.');
    // The site's name as the start page's one own part ("Home | Riverside Utilities").
    expect(failedOn(genericTitleFindings([mk('/', 'Home | Riverside Utilities', 'Welcome', 0), mk('/pay', 'Riverside Utilities', 'Pay a bill', 1), mk('/outage', 'Riverside Utilities', 'Report an outage', 2)]))).toEqual(['/outage', '/pay']);
    // And through the cross-page rules: the failure takes the place of the "same title" doubt.
    const across = titleFindingsAcross(site);
    expect(failedOn(across)).toEqual(['/kids', '/teens']);
    expect(unsureOn(across)).toEqual([]);
  });

  it('look-alikes that stay as they were: a one-page scan, a landing page that alone carries the site\'s name, a heading that is a picture or not level 1', () => {
    // One page only (no other page to tell the home page from): nothing here; the page's own "Home" doubt stays.
    expect(genericTitleFindings([mk('/events', 'Home | Cedar Hollow Library', 'Story time and events', 0)]).size).toBe(0);
    expect(genericTitleFindings([mk('/events', 'Home | Cedar Hollow Library', 'Story time and events', 3)]).size).toBe(0);
    // A landing page whose site name IS the topic: the only page besides the home page that carries the site's name.
    const landing = [mk('/', 'Cedar Hollow Library', 'Welcome to Cedar Hollow Library', 0), mk('/about', 'Cedar Hollow Library', 'Our story', 1), mk('/cards', 'Library cards | Cedar Hollow Library', 'Get a library card', 2)];
    expect(genericTitleFindings(landing).size).toBe(0);
    expect(failedOn(titleFindingsAcross(landing))).toEqual([]);
    // A heading that is a picture (its text is an image's alternative), or only a label; a heading that is not level 1.
    expect(genericTitleFindings([...SITE, mk('/rooms', 'Home | Cedar Hollow Library', 'Meeting rooms', 4, { h1text: false })]).size).toBe(0);
    expect(genericTitleFindings([...SITE, mk('/rooms', 'Home | Cedar Hollow Library', 'Meeting rooms', 4, { h1top: false })]).size).toBe(0);
    // Data read before this rule (no h1top / h1text): nothing.
    const old = mk('/rooms', 'Home | Cedar Hollow Library', 'Meeting rooms', 4);
    delete (old.run.data as Partial<TitleData>).h1top;
    expect(genericTitleFindings([...SITE, old]).size).toBe(0);
  });

  it('look-alikes: a home page by its address or in another language, a heading that names the site or the home page, a heading several pages share, a heading that shares a word with the title, another part in the title', () => {
    const none = (p: ReturnType<typeof mk>) => expect(genericTitleFindings([...SITE, p]).size, p.run.page).toBe(0);
    none(mk('/index.html', 'Home | Cedar Hollow Library', 'Library news', 4));
    none(mk('/es/', 'Home | Cedar Hollow Library', 'Bienvenidos a la biblioteca', 4));
    none(mk('/fr-ca/index.html', 'Home | Cedar Hollow Library', 'Bienvenue', 4));
    none(mk('/visit', 'Home | Cedar Hollow Library', 'Cedar Hollow Library', 4));
    none(mk('/welcome', 'Home', 'Welcome to Cedar Hollow', 4));
    none(mk('/housing', 'Home | Housing', 'Home repair loans', 4));
    none(mk('/parks', 'Home | Parks and trails', 'Swimming pools', 4));
    // The same heading on two pages (a heading of the template, or a list and its second page).
    expect(genericTitleFindings([...SITE, mk('/a', 'Home | Cedar Hollow Library', 'Latest news', 4), mk('/b', 'Home | Cedar Hollow Library', 'Latest news', 5)]).size).toBe(0);
    // A page a one-page rule already failed (a placeholder title): left out.
    expect(genericTitleFindings([...SITE, mk('/x', 'Home | Cedar Hollow Library', 'Story time', 4, {}, [{ criterion: '2.4.2', status: 'failed', target: 'title', detail: 'x' }])]).size).toBe(0);
    // Two pages titled with the site's name and the same heading: nothing (they may be one page and its second page).
    expect(genericTitleFindings([mk('/', 'Cedar Hollow Library', 'Welcome', 0), mk('/news', 'Cedar Hollow Library', 'News', 1), mk('/news?page=2', 'Cedar Hollow Library', 'News', 2)]).size).toBe(0);
    // No start page in the scan's results: the home page's words are not known.
    expect(genericTitleFindings([mk('/a', 'Home', 'Story time', 1), mk('/b', 'Catalogue', 'Search', 2)]).size).toBe(0);
    // A page in another language than the start page (by its markup, a translation link or its words): it may be that
    // language's home page ("/espanol/" titled "Home").
    none(mk('/espanol/', 'Home | Cedar Hollow Library', 'Bienvenidos a la biblioteca', 4, { lang: 'es' }));
    none(mk('/espanol/', 'Home | Cedar Hollow Library', 'Bienvenidos a la biblioteca', 4, { alts: ['/'] }));
    none(mk('/espanol/', 'Home | Cedar Hollow Library', 'Bienvenidos a la biblioteca', 4, { words: 300, en: 2 }));
    // A heading that holds the generic word itself: the title may be cut from it.
    none(mk('/energy', 'Home | Cedar Hollow Library', 'Home energy rebates', 4));
    none(mk('/residents', 'Welcome', 'Welcome new residents', 4));
    // (The same English page with an English heading still fails: the guards are no blanket.)
    expect(failedOn(genericTitleFindings([...SITE, mk('/events', 'Home | Cedar Hollow Library', 'Story time and events', 4, { lang: 'en', words: 300, en: 60 })]))).toEqual(['/events']);
  });
});
