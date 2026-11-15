// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { accessibleAlternatives, isAlternativeLink, namesAlternative } from '../../src/documents/alternatives.js';
import type { DocumentLink } from '../../src/types.js';

const SITE = 'https://e.org/';
const L = (href: string, text: string, group?: number, before?: string): DocumentLink =>
  ({ href: new URL(href, SITE).href, text, ...(group !== undefined ? { group } : {}), ...(before ? { before } : {}) });
const pairs = (links: DocumentLink[]) => Object.fromEntries([...accessibleAlternatives(links, SITE)].map(([k, v]) => [new URL(k).pathname, new URL(v).pathname]));

describe('which wording names an accessible version', () => {
  it('accepts the usual labels', () => {
    for (const text of ['View accessible PDF', 'Accessible version', 'accessible format', 'Accessible Word version', 'Accessible', 'View accessible',
      'HTML version', 'Text version', 'Text-only version', 'Large print', 'Large-print PDF', 'Plain text', 'Plain text version (TXT)']) {
      expect(namesAlternative(text), text).toBe(true);
    }
  });
  it('rejects documents that are only about accessibility, and other links', () => {
    for (const text of ['accessible parking map.pdf', 'Accessible Parking Map (PDF)', 'Accessibility statement', 'Accessible playgrounds guide',
      'View original PDF', 'Agenda (PDF)', 'Print version', 'HTML', 'Text us', '']) {
      expect(namesAlternative(text), text).toBe(false);
    }
  });
  it('reads a label written just before the link, but not one further back', () => {
    expect(isAlternativeLink({ text: 'Agenda', before: 'October agenda: PDF · Accessible version:' })).toBe(true);
    expect(isAlternativeLink({ text: 'web page', before: 'Large print:' })).toBe(true);
    expect(isAlternativeLink({ text: 'Minutes', before: 'Large print copies are at the front desk. Download the agenda (PDF) or' })).toBe(false);
    expect(isAlternativeLink({ text: 'View page', before: 'Accessible parking map: PDF' })).toBe(false);
  });
});

describe('pairing a document with an accessible version linked next to it', () => {
  it('pairs an original with the alternative in the same container (another document or a web page)', () => {
    expect(pairs([
      L('/docs/agenda.pdf', 'View original PDF', 1), L('/docs/agenda-accessible.pdf', 'View accessible PDF', 1, 'October agenda: View original PDF'),
      L('/docs/minutes.pdf', 'Minutes (PDF)', 2), L('/docs/minutes.html', 'HTML version', 2, 'Minutes (PDF)'),
      L('/docs/menu.pdf', 'Lunch menu', 3), L('/docs/menu-lp.pdf', 'download', 3, 'Lunch menu · Large print:'),
    ])).toEqual({ '/docs/agenda.pdf': '/docs/agenda-accessible.pdf', '/docs/minutes.pdf': '/docs/minutes.html', '/docs/menu.pdf': '/docs/menu-lp.pdf' });
  });

  it('never pairs links in different containers, links without a container, or a link with itself', () => {
    expect(pairs([
      L('/a.pdf', 'Agenda (PDF)', 1), L('/a-accessible.pdf', 'Accessible version', 2),
      L('/b.pdf', 'Budget (PDF)'), L('/b.html', 'HTML version'),
      L('/c.pdf', 'Calendar (PDF)', 3), L('/c.pdf#page=1', 'Accessible version', 3),
    ])).toEqual({});
  });

  it('a document about accessible parking is not taken for an accessible version', () => {
    expect(pairs([L('/maps/parking.pdf', 'Campus map (PDF)', 1), L('/maps/accessible-parking.pdf', 'accessible parking map.pdf', 1, 'Campus map (PDF)')])).toEqual({});
    // ...and the parking map itself is an original when a real alternative sits next to it.
    expect(pairs([L('/maps/accessible-parking.pdf', 'Accessible parking map (PDF)', 1), L('/maps/accessible-parking.html', 'Text version', 1)]))
      .toEqual({ '/maps/accessible-parking.pdf': '/maps/accessible-parking.html' });
  });

  it('the accessible version itself is never an original, and the first alternative in page order wins', () => {
    expect(pairs([
      L('/r.pdf', 'Report', 1), L('/r-a.pdf', 'Accessible PDF', 1), L('/r-lp.pdf', 'Large print', 1),
    ])).toEqual({ '/r.pdf': '/r-a.pdf' });
  });
});
