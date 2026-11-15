// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Cross-page consistency rules (2.4.5, 3.2.3, 3.2.4, 3.2.6): order comparison, link identity, label
// normalisation, help detection and the page-set analysis, on synthetic collector facts.
import { describe, expect, it } from 'vitest';
import type { ConsistencyFacts, ConsistencyRegion } from '../../src/collect/consistency.js';
import { toConsistencyFacts } from '../../src/collect/consistency.js';
import {
  analyzeConsistency, compareLabels, helpType, isSitemapLink, linkKey, movedItems, normalizeLabel, orderConflicts, processStepReason,
} from '../../src/consistency/index.js';
import { buildReport } from '../../src/report/build.js';
import type { PageAudit } from '../../src/types.js';

const O = 'https://e.org';
const abs = (p: string) => (/^(https?|tel|mailto):/.test(p) ? p : `${O}${p}`);
type L = [href: string, name: string, as?: 'text' | 'graphic'];
const region = (kind: ConsistencyRegion['kind'], links: L[], extra: Partial<ConsistencyRegion> = {}): ConsistencyRegion => ({
  kind, label: '', place: kind === 'footer' ? 'after-main' : 'before-main', hidden: false,
  links: links.map(([href, name, as]) => ({ href: abs(href), name, as: as ?? 'text' })), icons: [], ...extra,
});
const facts = (o: Partial<ConsistencyFacts> = {}): ConsistencyFacts => ({
  lang: 'en', regions: [], help: [], search: [], contentLinks: [], sitemapLinks: [], tocLinks: [], step: false, truncated: false, ...o,
});
const page = (path: string, f: ConsistencyFacts | undefined, extra: Partial<PageAudit> = {}): PageAudit => ({
  url: abs(path), status: 'ok', rules: {}, violations: [], incomplete: [], links: [], ...(f ? { collected: { consistency: f } } : {}), ...extra,
});
const MAIN: L[] = [['/', 'Home'], ['/about', 'About'], ['/news', 'News'], ['/calendar', 'Calendar'], ['/contact', 'Contact']];
const res = (pages: PageAudit[], c: string) => analyzeConsistency(pages, `${O}/`).results.find((r) => r.criterion === c)!;
const site = (...navs: L[][]) => navs.map((links, i) => page(i === 0 ? '/' : `/p${i}`, facts({ regions: [region('nav', links)] })));

describe('orderConflicts and movedItems', () => {
  it('finds nothing when the shared items keep their order, whatever is added or removed', () => {
    expect(orderConflicts(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toEqual([]);
    expect(orderConflicts(['a', 'b', 'c', 'd'], ['a', 'x', 'b', 'd', 'y'])).toEqual([]);
    expect(orderConflicts(['a', 'b'], ['c', 'd'])).toEqual([]);
  });
  it('reports reversed pairs and the fewest moved items', () => {
    expect(orderConflicts(['a', 'b', 'c'], ['b', 'a', 'c'])).toEqual([{ first: 'a', second: 'b' }]);
    const c = orderConflicts(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']);
    expect(c).toHaveLength(3);
    expect(movedItems(c, ['b', 'c', 'd', 'a'])).toEqual(['a']);
  });
  it('a link repeated at the top and bottom of a menu is not a move', () => {
    expect(orderConflicts(['contact', 'about', 'news', 'contact'], ['about', 'news', 'contact'])).toEqual([]);
    expect(orderConflicts(['a', 'b', 'a'], ['b', 'a'])).toEqual([]);
  });
  it('compares a 300-item menu quickly', () => {
    const a = Array.from({ length: 300 }, (_, i) => `k${i}`);
    const b = [...a.slice(1), a[0]!];
    const t = performance.now();
    const c = orderConflicts(a, b);
    expect(movedItems(c, b)).toEqual(['k0']);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('linkKey', () => {
  it('ignores fragment, tracking parameters, parameter order, trailing slash, index files, www and scheme', () => {
    const k = linkKey('https://e.org/about');
    for (const v of ['https://e.org/about#team', 'http://www.e.org/about/', 'https://e.org/about?utm_source=x', 'https://e.org/about/index.html', 'https://E.org/about/']) {
      expect(linkKey(v)).toBe(k);
    }
    expect(linkKey('https://e.org/?b=2&a=1')).toBe(linkKey('https://e.org/?a=1&b=2'));
  });
  it('keeps the query that names a page, and reads phone and email addresses', () => {
    expect(linkKey('https://e.org/?page_id=12')).not.toBe(linkKey('https://e.org/?page_id=13'));
    expect(linkKey('tel:+1 (541) 555-0100')).toBe(linkKey('tel:541.555.0100'));
    expect(linkKey('mailto:Info@E.org?subject=Hi')).toBe('mailto:info@e.org');
    expect(linkKey('javascript:void(0)')).toBeUndefined();
    expect(linkKey('/x', 'https://e.org/a/')).toBe(linkKey('https://e.org/x'));
  });
});

describe('labels', () => {
  it('drops state notes, numbers and punctuation', () => {
    expect(normalizeLabel('Home (current)')).toBe('home');
    expect(normalizeLabel('About, current page')).toBe('about');
    expect(normalizeLabel('Cart (3)')).toBe('cart');
    expect(normalizeLabel('Forms – opens in a new window')).toBe('forms');
    expect(normalizeLabel('Événements')).toBe('événements');
  });
  it('compares names: same, different, ambiguous, unnamed', () => {
    expect(compareLabels(['Contact'], ['Contact us'])).toBe('same');
    expect(compareLabels(['Home (current)'], ['Home'])).toBe('same');
    expect(compareLabels(['Search'], ['Go'])).toBe('different');
    expect(compareLabels(['Calendar'], ['Events'])).toBe('different');
    expect(compareLabels(['News'], ['News & Events'])).toBe('ambiguous');
    expect(compareLabels([''], ['Search'])).toBe('unnamed');
    // A logo and a "Home" link to the same place on one page, only "Home" on the other: they share a name.
    expect(compareLabels(['Riverside District', 'Home'], ['Home'])).toBe('same');
  });
  it('detects help mechanisms', () => {
    expect(helpType('tel:5415550100', 'Call us')).toBe('phone');
    expect(helpType('mailto:a@e.org', 'Email')).toBe('email');
    expect(helpType('https://e.org/contact-us', 'Reach the office')).toBe('contact');
    expect(helpType('https://e.org/x', 'Contact')).toBe('contact');
    expect(helpType('https://e.org/faq', 'Questions')).toBe('help');
    expect(helpType('https://e.org/help/', 'Help center')).toBe('help');
    expect(helpType('https://e.org/chat', 'Live chat')).toBe('chat');
    expect(helpType('https://e.org/about', 'About')).toBeUndefined();
  });
  it('detects site maps and process steps', () => {
    expect(isSitemapLink('https://e.org/sitemap', 'Site map')).toBe(true);
    expect(isSitemapLink('https://e.org/site-index.html', 'Index')).toBe(true);
    expect(isSitemapLink('https://e.org/sitemap.xml', 'XML')).toBe(false);
    expect(processStepReason('https://e.org/search?q=pool', false)).toBe('it is a search results page');
    expect(processStepReason('https://e.org/apply/step-2', false)).toBe('it is a step in a process');
    expect(processStepReason('https://e.org/thank-you', false)).toBe('it is a confirmation page');
    expect(processStepReason('https://e.org/apply', true)).toBe('it marks a step in a process');
    expect(processStepReason('https://e.org/election-results', false)).toBeUndefined();
    expect(processStepReason('https://e.org/search', false)).toBeUndefined();
  });
});

describe('toConsistencyFacts', () => {
  it('keeps the declared shape whatever the page returned', () => {
    expect(toConsistencyFacts(null)).toEqual(facts({ lang: '' }));
    const f = toConsistencyFacts({ lang: 'en', regions: [{ kind: 'evil', links: [{ href: 'https://e.org/', name: 5, as: 'x' }, { name: 'no href' }], icons: [{ name: 'x' }] }], help: 'no', step: 'yes' });
    expect(f.regions).toEqual([{ kind: 'nav', label: '', place: 'unknown', hidden: false, links: [{ href: 'https://e.org/', name: '', as: 'text' }], icons: [] }]);
    expect(f.help).toEqual([]);
    expect(f.step).toBe(false);
  });
});

describe('3.2.3 consistent navigation', () => {
  it('no failures when the menu keeps its order; items added or removed are fine', () => {
    const r = res(site(MAIN, [...MAIN.slice(0, 2), ['/about/team', 'Team'], ...MAIN.slice(2)], MAIN.slice(1)), '3.2.3');
    expect(r.method).toMatchObject({ id: 'consistency', kind: 'rules', status: 'no_failures_found', pages: 3 });
  });
  it('fails a page whose shared menu items are in another order, naming the pages and items', () => {
    const swapped: L[] = [MAIN[0]!, MAIN[2]!, MAIN[1]!, MAIN[3]!, MAIN[4]!];
    const r = res(site(MAIN, MAIN, swapped), '3.2.3');
    expect(r.method).toMatchObject({ status: 'failed', pages: 1 });
    expect(r.evidence).toEqual([{ page: `${O}/p2`, target: 'navigation', detail: 'In the navigation, "News" comes before "About" on this page, but after it on /. It also differs from 1 other page.' }]);
  });
  it('names the page that differs from the rest, even when it is the start page', () => {
    const swapped: L[] = [MAIN[0]!, MAIN[2]!, MAIN[1]!, MAIN[3]!, MAIN[4]!];
    const r = res(site(swapped, MAIN, MAIN, MAIN), '3.2.3');
    expect(r.method).toMatchObject({ status: 'failed', pages: 1 });
    expect(r.evidence).toEqual([{ page: `${O}/`, target: 'navigation', detail: 'In the navigation, "News" comes before "About" on this page, but after it on /p1. It also differs from 2 other pages.' }]);
  });
  it('section sub-navigation (different per section) and an expanded current section are not failures', () => {
    const sub = (s: string): ConsistencyRegion => region('nav', [[`/${s}/1`, `${s} 1`], [`/${s}/2`, `${s} 2`]], { label: 'Section', place: 'in-main' });
    const pages = [
      page('/', facts({ regions: [region('nav', MAIN)] })),
      page('/about', facts({ regions: [region('nav', [...MAIN.slice(0, 2), ['/about/team', 'Team'], ...MAIN.slice(2)]), sub('about')] })),
      page('/news', facts({ regions: [region('nav', MAIN), sub('news')] })),
    ];
    expect(res(pages, '3.2.3').method.status).toBe('no_failures_found');
  });
  it('a hidden mobile copy of the menu in its own order is compared with its counterpart, not the desktop menu', () => {
    const mobile: L[] = [MAIN[4]!, ...MAIN.slice(0, 4)];
    const both = () => facts({ regions: [region('nav', MAIN), region('nav', mobile, { hidden: true })] });
    expect(res([page('/', both()), page('/a', both()), page('/b', both())], '3.2.3').method.status).toBe('no_failures_found');
  });
  it('query-string and fragment variants of the same address are the same item', () => {
    const variant: L[] = MAIN.map(([h, n]) => [h === '/' ? '/#top' : `${h}?utm_source=nav`, n]);
    expect(res(site(MAIN, variant), '3.2.3').method.status).toBe('no_failures_found');
  });
  it('a logo link and a "Home" link to the same address are different items', () => {
    const withLogo: L[] = [['/', 'Riverside', 'graphic'], ...MAIN.slice(1), ['/', 'Home']];
    expect(res(site(withLogo, [...MAIN.slice(1), ['/', 'Home']]), '3.2.3').method.status).toBe('no_failures_found');
  });
  it('two pages that each agree with the start page but not with each other are caught', () => {
    const base: L[] = [MAIN[0]!, MAIN[4]!];
    const one: L[] = [MAIN[0]!, MAIN[1]!, MAIN[2]!, MAIN[4]!];
    const two: L[] = [MAIN[0]!, MAIN[2]!, MAIN[1]!, MAIN[4]!];
    const r = res(site(base, one, two), '3.2.3');
    expect(r.method).toMatchObject({ status: 'failed', pages: 1 });
    expect(r.evidence[0]!.detail).toBe('In the navigation, "News" comes before "About" on this page, but after it on /p1.');
  });
  it('a small block that shares two links with the main menu, or a breadcrumb, is not the main menu reordered', () => {
    const quick = region('nav', [['/contact', 'Contact'], ['/calendar', 'Calendar']]);
    const crumbs = region('nav', [['/', 'Home'], ['/contact', 'Contact'], ['/news', 'News']], { label: 'Breadcrumb' });
    const pages = [
      page('/', facts({ regions: [region('nav', MAIN, { label: 'Main' })] })),
      page('/a', facts({ regions: [region('nav', MAIN, { label: 'Main' }), quick, crumbs] })),
    ];
    expect(res(pages, '3.2.3').method.status).toBe('no_failures_found');
  });
  it('a named menu with a large section expanded still matches, so a move in it is found', () => {
    const kids: L[] = Array.from({ length: 12 }, (_, i) => [`/about/${i}`, `Part ${i}`]);
    const expanded: L[] = [MAIN[0]!, MAIN[2]!, MAIN[1]!, ...kids, MAIN[3]!, MAIN[4]!];
    const pages = [page('/', facts({ regions: [region('nav', MAIN, { label: 'Main menu' })] })), page('/a', facts({ regions: [region('nav', expanded, { label: 'Main' })] }))];
    expect(res(pages, '3.2.3').method.status).toBe('failed');
  });
  it('pagination and a menu heading that links where its "Overview" item does are not failures', () => {
    const pager = (n: number): L[] => [...(n > 1 ? [[`/list?page=${n - 1}`, 'Previous'] as L] : []), ['/list?page=1', '1'], ['/list?page=2', '2'], ['/list?page=3', '3'], [`/list?page=${n + 1}`, 'Next']];
    const mega: L[] = [['/departments', 'Departments'], ['/departments', 'Overview'], ['/departments/parks', 'Parks'], ['/news', 'News']];
    const pages = [
      page('/list?page=1', facts({ regions: [region('nav', mega), region('nav', pager(1), { label: 'Pages' })] })),
      page('/list?page=2', facts({ regions: [region('nav', [mega[0]!, ...mega.slice(2)]), region('nav', pager(2), { label: 'Pages' })] })),
    ];
    const a = analyzeConsistency(pages, `${O}/list?page=1`);
    expect(a.results.filter((r) => r.criterion === '3.2.3' || r.criterion === '3.2.4').map((r) => r.method.status)).toEqual(['no_failures_found', 'no_failures_found']);
  });
  it('not applicable without repeated navigation; not testable with fewer than two pages', () => {
    const none = [page('/', facts()), page('/a', facts())];
    expect(res(none, '3.2.3').method).toMatchObject({ status: 'not_applicable', note: 'no navigation is repeated across the 2 compared pages' });
    const one = res([page('/', facts({ regions: [region('nav', MAIN)] }))], '3.2.3');
    expect(one.method).toMatchObject({ status: 'not_testable', note: 'only one page could be compared' });
  });
  it('leaves out pages that did not load or whose facts are missing, and says so', () => {
    const pages = [...site(MAIN, MAIN), page('/broken', undefined, { status: 'failed', reason: 'HTTP 500' }), page('/nofacts', undefined)];
    const r = res(pages, '3.2.3');
    expect(r.method.status).toBe('no_failures_found');
    expect(r.method.note).toContain('1 page did not load; the facts of 1 page could not be read');
    const failedOnly = res([page('/', undefined, { status: 'failed' }), page('/a', undefined, { status: 'failed' })], '3.2.3');
    expect(failedOnly.method).toMatchObject({ status: 'not_testable', note: 'no page loaded; 2 pages did not load' });
  });
});

describe('3.2.4 consistent identification', () => {
  it('fails a menu link or search button named with entirely different words on another page', () => {
    const renamed: L[] = MAIN.map(([h, n]) => [h, h === '/calendar' ? 'Events' : n]);
    const pages = [
      page('/', facts({ regions: [region('nav', MAIN)], search: [{ place: 'before-main', field: 'Search', button: 'Search', buttonAs: 'text' }] })),
      page('/a', facts({ regions: [region('nav', renamed)], search: [{ place: 'before-main', field: 'Search', button: 'Go', buttonAs: 'text' }] })),
      page('/b', facts({ regions: [region('nav', MAIN)] })),
    ];
    const r = res(pages, '3.2.4');
    // The odd page out is named: /a differs from both other pages.
    expect(r.method).toMatchObject({ status: 'failed', pages: 1 });
    expect(r.evidence.map((e) => [e.page, e.detail])).toEqual([
      [`${O}/a`, 'The link to /calendar in the navigation is named "Events" on this page and "Calendar" on /. It also differs from 1 other page.'],
      [`${O}/a`, 'The search button in the search form is named "Go" on this page and "Search" on /.'],
    ]);
  });
  it('names that share some words go to the AI; state notes and short forms are the same name', () => {
    const v: L[] = MAIN.map(([h, n]) => [h, h === '/news' ? 'News and events' : h === '/contact' ? 'Contact us' : h === '/' ? 'Home (current)' : n]);
    const a = analyzeConsistency(site(MAIN, v), `${O}/`);
    expect(a.results.find((r) => r.criterion === '3.2.4')!.method).toMatchObject({ status: 'no_failures_found' });
    expect(a.results.find((r) => r.criterion === '3.2.4')!.method.note).toContain('1 pair of similar but different names left to the AI review');
    expect(a.ambiguous).toEqual([{
      what: 'link', destination: `${O}/news`, where: 'navigation', pageA: `${O}/`, labelA: 'News', pageB: `${O}/p1`, labelB: 'News and events',
    }]);
  });
  it('does not compare names across languages, and sends a block where most names changed to the AI', () => {
    const es: L[] = [['/', 'Inicio'], ['/about', 'Acerca de'], ['/news', 'Noticias'], ['/calendar', 'Calendario'], ['/contact', 'Contacto']];
    const pages = [page('/', facts({ regions: [region('nav', MAIN)] })), page('/es', facts({ lang: 'es', regions: [region('nav', es)] }))];
    expect(res(pages, '3.2.4').method).toMatchObject({ status: 'not_applicable' });
    expect(res(pages, '3.2.4').method.note).toContain('different languages');
    expect(res(pages, '3.2.3').method.status).toBe('no_failures_found');
    const undeclared = [page('/', facts({ lang: '', regions: [region('nav', MAIN)] })), page('/es', facts({ lang: '', regions: [region('nav', es)] }))];
    const a = analyzeConsistency(undeclared, `${O}/`);
    expect(a.results.find((r) => r.criterion === '3.2.4')!.method.status).toBe('no_failures_found');
    expect(a.ambiguous.length).toBe(5);
  });
  it('compares icon buttons by the icon they show', () => {
    const icon = (name: string): ConsistencyRegion => region('header', [['/', 'Home'], ['/login', 'Sign in']], { icons: [{ sig: 'use:icon-search', name }] });
    const r = res([page('/', facts({ regions: [icon('Search')] })), page('/a', facts({ regions: [icon('Menu')] }))], '3.2.4');
    expect(r.method.status).toBe('failed');
    expect(r.evidence[0]!.detail).toBe('An icon button in the page header links is named "Menu" on this page and "Search" on /.');
  });
  it('a name missing on one page is left to the naming rules', () => {
    const unnamed: L[] = MAIN.map(([h, n]) => [h, h === '/news' ? '' : n]);
    expect(res(site(MAIN, unnamed), '3.2.4').method.status).toBe('no_failures_found');
  });
});

describe('3.2.6 consistent help', () => {
  const help = (...items: [string, string, ('before-main' | 'after-main' | 'in-main')?][]) =>
    items.map(([href, name, place]) => ({ href: abs(href), name, place: place ?? 'after-main' as const }));
  it('no failures when repeated help keeps its order and place', () => {
    const f = () => facts({ help: help(['/contact', 'Contact us'], ['tel:5415550100', '541-555-0100'], ['/faq', 'FAQ']) });
    expect(res([page('/', f()), page('/a', f())], '3.2.6').method).toMatchObject({ status: 'no_failures_found', pages: 2 });
  });
  it('fails help in a different order, or moved from the header to the footer', () => {
    const pages = [
      page('/', facts({ help: help(['/contact', 'Contact us', 'before-main'], ['tel:5415550100', 'Call 541-555-0100'], ['/faq', 'FAQ']) })),
      page('/a', facts({ help: help(['/contact', 'Contact us', 'before-main'], ['/faq', 'FAQ'], ['tel:5415550100', 'Call 541-555-0100']) })),
      page('/b', facts({ help: help(['/contact', 'Contact us'], ['tel:5415550100', 'Call 541-555-0100'], ['/faq', 'FAQ']) })),
    ];
    const r = res(pages, '3.2.6');
    expect(r.method).toMatchObject({ status: 'failed', pages: 2 });
    expect(r.evidence.map((e) => [e.page, e.detail])).toEqual([
      // Each page is compared with every other; the odd one out is named, not the pages that agree.
      [`${O}/a`, '"FAQ" comes before "Call 541-555-0100" on this page, but after it on /. It also differs from 1 other page.'],
      [`${O}/b`, '"Contact us" is after the main content on this page, but before the main content on /. It also differs from 1 other page.'],
    ]);
  });
  it('contact details inside the main content are page content, not a repeated help mechanism', () => {
    const pages = [
      page('/', facts({ help: help(['/contact', 'Contact', 'before-main']) })),
      page('/contact', facts({ help: help(['tel:5415550199', 'Front desk', 'in-main'], ['/contact', 'Contact', 'before-main']) })),
      page('/a', facts({ help: help(['tel:5415550199', 'Front desk', 'in-main'], ['/contact', 'Contact', 'before-main']) })),
    ];
    expect(res(pages, '3.2.6').method.status).toBe('no_failures_found');
  });
  it('not applicable without help on two pages', () => {
    expect(res(site(MAIN, MAIN), '3.2.6').method.status).toBe('not_applicable');
  });
});

describe('2.4.5 multiple ways', () => {
  const nav = () => region('nav', [['/', 'Home'], ['/about', 'About'], ['/news', 'News']]);
  it('fails pages found only through the navigation when the site has no search, site map or index', () => {
    const pages = [page('/', facts({ regions: [nav()], contentLinks: [abs('/news')] })), page('/about', facts({ regions: [nav()] })), page('/news', facts({ regions: [nav()] }))];
    const r = res(pages, '2.4.5');
    expect(r.method).toMatchObject({ status: 'failed', pages: 1 });
    expect(r.evidence).toEqual([{ page: `${O}/about`, target: 'Ways to reach this page', detail: 'Found only through navigation on the scanned pages; the site has no search form, site map or index.' }]);
  });
  it('a site search or site map plus one link is enough', () => {
    const withSearch = [page('/', facts({ regions: [nav()], search: [{ place: 'before-main', field: 'Search', button: 'Search', buttonAs: 'text' }] })), page('/about', facts({ regions: [nav()] }))];
    expect(res(withSearch, '2.4.5').method).toMatchObject({ status: 'no_failures_found', note: 'site-wide: search; 1 page checked' });
    const withMap = [page('/', facts({ regions: [nav()], sitemapLinks: [abs('/sitemap')] })), page('/about', facts({ regions: [nav()] }))];
    expect(res(withMap, '2.4.5').method.status).toBe('no_failures_found');
  });
  it('a search button or link that opens search on demand counts as search', () => {
    const opener = region('header', [['/', 'Home'], ['/login', 'Sign in']], { icons: [{ sig: 'use:magnifier', name: 'Search' }] });
    expect(res([page('/', facts({ regions: [nav(), opener] })), page('/about', facts({ regions: [nav(), opener] }))], '2.4.5').method.status).toBe('no_failures_found');
    const link = region('nav', [['/', 'Home'], ['/about', 'About'], ['/search', 'Find']]);
    expect(res([page('/', facts({ regions: [link] })), page('/about', facts({ regions: [link] }))], '2.4.5').method.status).toBe('no_failures_found');
  });
  it('process steps and pages linked only from unscanned pages are not counted', () => {
    const pages = [
      page('/', facts({ regions: [nav()] })),
      page('/search?q=pool', facts({ regions: [nav()] })),
      page('/apply', facts({ regions: [nav()], step: true })),
      page('/deep/article', facts({ regions: [nav()] })),
    ];
    const r = res(pages, '2.4.5');
    expect(r.method.status).toBe('not_testable');
    expect(r.method.note).toContain('2 pages in a process (search results, steps, confirmations) not counted; 1 page not linked from any scanned page, so not counted');
  });
  it('a one-page site is not applicable; a single loaded page of a larger site is not testable', () => {
    expect(res([page('/', facts())], '2.4.5').method.status).toBe('not_applicable');
    expect(res([page('/', facts(), { links: [abs('/about')] })], '2.4.5').method.status).toBe('not_testable');
  });
});

describe('cost', () => {
  it('compares 25 pages with 300-link menus and footers quickly, consistent or not', () => {
    const big = (n: number, rotate: number): L[] => {
      const l: L[] = Array.from({ length: n }, (_, i) => [`/s/${i}`, `Item ${i}`]);
      return [...l.slice(rotate), ...l.slice(0, rotate)];
    };
    const pages = (rot: (i: number) => number) => Array.from({ length: 25 }, (_, i) => page(i ? `/p${i}` : '/', facts({
      regions: [region('nav', big(300, rot(i)), { label: 'Main' }), region('footer', big(300, rot(i)).map(([h, n]) => [`${h}f`, n] as L))],
      help: [{ href: `${O}/contact`, name: 'Contact', place: 'after-main' }, { href: 'tel:5415550100', name: 'Call', place: 'after-main' }],
    })));
    for (const [label, rot] of [['consistent', () => 0], ['every page different', (i: number) => i * 7]] as const) {
      const t = performance.now();
      const r = analyzeConsistency(pages(rot), `${O}/`);
      const ms = performance.now() - t;
      console.log(`analysis of 25 pages x 600 links (${label}): ${ms.toFixed(0)} ms`);
      expect(r.results.find((x) => x.criterion === '3.2.3')!.method.status).toBe(label === 'consistent' ? 'no_failures_found' : 'failed');
      expect(ms).toBeLessThan(2000);
    }
  });
});

describe('buildReport', () => {
  it('puts the cross-page results in the criteria table (not scored)', () => {
    const swapped: L[] = [MAIN[1]!, MAIN[0]!, ...MAIN.slice(2)];
    const pages = site(MAIN, swapped);
    const r = buildReport({ site: `${O}/`, pages, documents: [], skipped: [], startedAt: 'a', finishedAt: 'b', userAgent: 'UA' });
    const row = r.criteria!.find((c) => c.criterion === '3.2.3')!;
    expect(row).toMatchObject({ status: 'failed', methods: [{ id: 'consistency', kind: 'rules', status: 'failed', pages: 1 }] });
    const ident = r.criteria!.find((c) => c.criterion === '3.2.4')!;
    expect(ident.methods.map((m) => m.id)).toEqual(['consistency']);
  });
});
