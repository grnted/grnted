// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The link purpose test's rules (2.4.4) on what the page reader reports. The reader itself runs in
// Chromium: test/integration/linkPurpose.test.ts.
import { describe, expect, it } from 'vitest';
import { LINK_PURPOSE_PROBE_ID, VAGUE_LINK_PHRASES, isVagueLinkName, linkPurposeFindings, linkPurposeProbe, normalizeLinkName, type LinkRead } from '../../src/probes/linkPurpose.js';
import { PROBES, SCORED_PROBES } from '../../src/probes/registry.js';

const link = (name: string, href: string, context = '', from: LinkRead['contextFrom'] = context ? 'heading' : 'none', target = `a[href="${href}"]`): LinkRead => ({
  name, text: name, href, target, context, contextFrom: from,
});
const read = (links: LinkRead[]) => ({ links, truncated: false });

describe('vague link names', () => {
  it('normalizes case, spacing, arrows and trailing punctuation', () => {
    expect(normalizeLinkName('  Read   More » ')).toBe('read more');
    expect(normalizeLinkName('CLICK HERE!')).toBe('click here');
    expect(normalizeLinkName('Learn more…')).toBe('learn more');
    expect(normalizeLinkName('> More')).toBe('more');
    expect(normalizeLinkName('Leer más')).toBe('leer más');
  });

  it('matches only whole generic names', () => {
    for (const n of ['click here', 'Here', 'Read more', 'learn more', 'More', 'more info', 'details', 'Continue reading', 'Leer más']) expect(isVagueLinkName(n)).toBe(true);
    for (const n of ['Read more about the concert', 'Board meeting', 'Here is the menu', 'Learn more about enrollment', '', 'Home']) expect(isVagueLinkName(n)).toBe(false);
    // The list is stored normalized.
    for (const p of VAGUE_LINK_PHRASES) expect(normalizeLinkName(p)).toBe(p);
  });
});

describe('linkPurposeFindings', () => {
  it('finds nothing for generic links with their own context', () => {
    expect(linkPurposeFindings(read([]))).toEqual([]);
    expect(linkPurposeFindings(read([link('read more', '/a', 'The concert is on May 3.', 'sentence'), link('read more', '/b', 'Book fair', 'heading')]))).toEqual([]);
    // Same name, same heading, same destination: not ambiguous.
    expect(linkPurposeFindings(read([link('read more', '/a', 'News'), link('read more', '/a', 'News')]))).toEqual([]);
  });

  it('fails each generic link with no context, and lists at most five', () => {
    const f = linkPurposeFindings(read([link('learn more', '/a')]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ criterion: '2.4.4', status: 'failed', target: 'a[href="/a"]' });
    expect(f[0]!.detail).toBe('The link “learn more” has nothing around it that says where it goes: no sentence, list item, table cell or heading before it gives its purpose');
    const many = linkPurposeFindings(read(Array.from({ length: 8 }, (_, i) => link('click here', `/x${i}`))));
    expect(many).toHaveLength(5);
    expect(many[4]!.detail).toMatch(/3 more/);
  });

  it('fails links of one name and one context that go to different places, once per group', () => {
    const f = linkPurposeFindings(read([link('read more', '/1', 'Latest news'), link('read more', '/2', 'Latest news'), link('read more', '/3', 'Latest news'), link('read more', '/9', 'Events')]));
    expect(f).toHaveLength(1);
    expect(f[0]!.target).toBe('a[href="/1"]');
    expect(f[0]!.detail).toBe('3 links named “read more” after the heading “Latest news” go to different pages, so their names and context do not say which is which');
    // Links with their own sentence, list item or cell are never grouped (each sentence says it).
    expect(linkPurposeFindings(read([link('here', '/1', 'Forms for lunch and bus.', 'sentence'), link('here', '/2', 'Forms for lunch and bus.', 'sentence')]))).toEqual([]);
    // A link with no destination of its own (role="link") is not counted as different.
    expect(linkPurposeFindings(read([link('more', '', 'News'), link('more', '/a', 'News')]))).toEqual([]);
  });
});

describe('linkPurposeFindings: a few words of its own (W3C precision lane, 2026-11-11)', () => {
  const partial = (name: string, href: string, words: string): LinkRead => ({ ...link(name, href), partial: words });
  it('is undecided (one not_testable finding for the page), never failed', () => {
    const f = linkPurposeFindings(read([partial('read more', '/wai', 'about the W3C WAI'), link('read more', '/i18n', 'about the W3C internationalization', 'sentence')]));
    expect(f).toEqual([{ criterion: '2.4.4', status: 'not_testable', target: 'a[href="/wai"]',
      detail: 'the link “read more” has only a few words of its own around it (“about the W3C WAI”), too few to tell whether they say where it goes' }]);
    const two = linkPurposeFindings(read([partial('view', '/a', 'Agenda'), partial('view', '/m', 'Minutes')]));
    expect(two.map((x) => x.status)).toEqual(['not_testable']);
    expect(two[0]!.detail).toMatch(/^2 links with a generic name \(the first “view”\) have only a few words of their own around them \(“Agenda”\)/);
  });
  // Fable review F4: the same own words do not tell two links apart.
  it('links of one name with the same own words that go to different places fail, after a heading or with none', () => {
    const f = linkPurposeFindings(read([{ ...link('open', '/a.pdf', 'Board papers for this year'), partial: 'PDF icon' }, { ...link('open', '/b.pdf', 'Board papers for this year'), partial: 'PDF  icon.' }]));
    expect(f.map((x) => [x.status, x.target, x.detail])).toEqual([['failed', 'a[href="/a.pdf"]', '2 links named “open” after the heading “Board papers for this year”, each beside the same words “PDF icon”, go to different pages, so their names and context do not say which is which']]);
    expect(linkPurposeFindings(read([partial('open', '/a.pdf', 'Agenda'), partial('open', '/b.pdf', 'Agenda')])).map((x) => x.status)).toEqual(['failed']);
    expect(linkPurposeFindings(read([partial('read more', '/a', 'Parks'), partial('read more', '/b', 'Parks')])).map((x) => x.status)).toEqual(['failed', 'not_testable']);
    // The same place twice is not ambiguous.
    expect(linkPurposeFindings(read([partial('open', '/a.pdf', 'Agenda'), partial('open', '/a.pdf', 'Agenda')]))).toEqual([]);
  });
  it('is compared with no link of other own words, kind-only names included; a link with nothing around it still fails beside it', () => {
    expect(linkPurposeFindings(read([partial('open', '/b.pdf', 'Budget'), partial('open', '/m.pdf', 'Minutes')]))).toEqual([]);
    // After one heading too: their own words tell them apart.
    expect(linkPurposeFindings(read([{ ...link('open', '/b.pdf', 'Board papers'), partial: 'Budget' }, { ...link('open', '/m.pdf', 'Board papers'), partial: 'Minutes' }]))).toEqual([]);
    const f = linkPurposeFindings(read([partial('read more', '/a', 'Parking'), link('read more', '/b')]));
    expect(f.map((x) => [x.status, x.target])).toEqual([['failed', 'a[href="/b"]'], ['not_testable', 'a[href="/a"]']]);
  });
});

describe('the link-purpose probe', () => {
  it('is a core test on every page, for 2.4.4 only, registered once', () => {
    expect(linkPurposeProbe).toMatchObject({ id: LINK_PURPOSE_PROBE_ID, criteria: ['2.4.4'], tier: 'core', everyPage: true, kind: 'render' });
    expect(PROBES.filter((p) => p.id === LINK_PURPOSE_PROBE_ID)).toHaveLength(1);
  });

  it('runs on every scan and is scored since v8: the gold standard verified it (docs/scoring.md)', () => {
    expect(SCORED_PROBES.has(LINK_PURPOSE_PROBE_ID)).toBe(true);
  });
});
