// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { selectPages, spreadOrder } from '../../src/select.js';

const START = 'https://www.e.org/';

describe('selectPages', () => {
  it('starts with the start URL, then sorts by depth then path', () => {
    const r = selectPages(START, ['/z', '/a/b/c', '/a', 'https://e.org/m/n'], 10);
    expect(r.pages).toEqual(['https://www.e.org/', 'https://www.e.org/a', 'https://www.e.org/z', 'https://e.org/m/n', 'https://www.e.org/a/b/c']);
  });
  it('is identical regardless of candidate order', () => {
    const c = ['/b', '/a', '/c/d', '/a#x', '/a?utm_source=q'];
    expect(selectPages(START, c, 10).pages).toEqual(selectPages(START, [...c].reverse(), 10).pages);
  });
  it('dedupes by page identity and caps at max', () => {
    const r = selectPages(START, ['/a', 'http://e.org/a', '/a/', '/b', '/c'], 3);
    expect(r.pages).toEqual(['https://www.e.org/', 'https://www.e.org/a', 'https://www.e.org/b']);
  });
  it('drops other sites and non-page assets', () => {
    const r = selectPages(START, ['https://other.org/x', '/logo.png', '/style.css', '/ok'], 10);
    expect(r.pages).toEqual(['https://www.e.org/', 'https://www.e.org/ok']);
  });
  it('collects documents from any host into the inventory', () => {
    const r = selectPages(START, ['/board.pdf', 'https://docs.example.com/menu.docx', '/ok'], 10);
    expect(r.documents).toEqual(['https://docs.example.com/menu.docx', 'https://www.e.org/board.pdf']);
    expect(r.pages).not.toContain('https://www.e.org/board.pdf');
  });
  it('skips robots-disallowed pages and reports them', () => {
    const r = selectPages(START, ['/private/x', '/ok'], 10, (u) => !new URL(u).pathname.startsWith('/private'));
    expect(r.pages).toEqual(['https://www.e.org/', 'https://www.e.org/ok']);
    expect(r.skipped).toEqual([{ url: 'https://www.e.org/private/x', reason: 'Blocked by robots.txt' }]);
  });
});

// Scoring v3 page sampling: every top-level section first (round-robin by first path segment,
// shallowest first within a section), then by depth.
describe('selectPages: section spread (scoring v3)', () => {
  const news = Array.from({ length: 60 }, (_, i) => `/news/2026/story-${String(i).padStart(2, '0')}`);
  const deep = [
    '/resources/forms/enrollment', '/resources/forms/lunch', '/resources/handbook',
    '/policies/board/100/policy-101', '/policies/board/200/policy-201',
    '/calendar/2026/10/31/halloween', '/calendar/2026/11/01/board-meeting',
  ];
  const shallow = ['/about', '/contact', '/news'];
  const candidates = [...news, ...shallow, ...deep];
  const path = (u: string) => new URL(u).pathname;

  it('takes a page from every top-level section before a second page from any', () => {
    const r = selectPages(START, candidates, 7).pages.map(path);
    // Round 1, ordered by depth then path: /about, /contact, /news (depth 1), /resources/handbook
    // (2), /policies/board/100/policy-101 (4), /calendar/2026/10/31/halloween (5).
    expect(r).toEqual(['/', '/about', '/contact', '/news', '/resources/handbook', '/policies/board/100/policy-101', '/calendar/2026/10/31/halloween']);
  });

  it('then goes round again, shallowest first within each section', () => {
    const r = selectPages(START, candidates, 12).pages.map(path);
    // Round 2: news story (3), resources/forms/enrollment (3), policies 201 (4), calendar board meeting (5).
    expect(r.slice(7)).toEqual(['/news/2026/story-00', '/resources/forms/enrollment', '/policies/board/200/policy-201', '/calendar/2026/11/01/board-meeting',
      // Round 3: the sections with pages left.
      '/news/2026/story-01']);
  });

  it('never lets a big section crowd out the others', () => {
    const r = selectPages(START, candidates, 25).pages.map(path);
    for (const s of ['/about', '/contact', '/news', '/resources', '/policies', '/calendar']) expect(r.some((p) => p.startsWith(s))).toBe(true);
    expect(r.filter((p) => p.startsWith('/news/')).length).toBeLessThanOrEqual(25 - 1 - 3 - 6);
  });

  it('is deterministic: the same selection whatever the candidate order', () => {
    const a = selectPages(START, candidates, 15).pages;
    expect(selectPages(START, [...candidates].reverse(), 15).pages).toEqual(a);
    const shuffled = [...candidates].sort((x, y) => (x.length * 7919 + x.charCodeAt(x.length - 1)) % 13 - (y.length * 7919 + y.charCodeAt(y.length - 1)) % 13);
    expect(selectPages(START, shuffled, 15).pages).toEqual(a);
  });

  it('pages at the root with only a query string form their own section', () => {
    const r = selectPages(START, ['/?page=2', '/a/b', '/a/c'], 10).pages.map((u) => new URL(u).pathname + new URL(u).search);
    expect(r).toEqual(['/', '/?page=2', '/a/b', '/a/c']);
  });
});

describe('spreadOrder', () => {
  it('orders a whole list by section spread, so a cap keeps every section', () => {
    const urls = ['/news/a', '/news/b', '/news/c', '/x/y/z', '/about'].map((p) => `https://e.org${p}`);
    expect(spreadOrder(urls).map((u) => new URL(u).pathname)).toEqual(['/about', '/news/a', '/x/y/z', '/news/b', '/news/c']);
  });
});
