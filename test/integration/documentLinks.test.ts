// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The documentLinks collector in real Chromium: which links share a container (list item, table row,
// paragraph, small card) and the label written right before each, which the accessible-alternative
// pairing reads.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentLinksCollector } from '../../src/collect/documentLinks.js';
import { accessibleAlternatives } from '../../src/documents/alternatives.js';
import type { DocumentLink, PageLike } from '../../src/types.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
}, 30_000);
afterAll(async () => browser?.close());

const E = 'https://e.org';
const HTML = `<!doctype html><html lang="en"><body>
<nav><a href="${E}/">Home</a> <a href="${E}/about">About</a></nav>
<main>
<ul>
  <li>October agenda: <a href="${E}/a.pdf">View original PDF</a> <a href="${E}/a-accessible.pdf">View accessible PDF</a></li>
  <li><a href="${E}/alone.pdf">Alone</a></li>
  <li>Parking: <a href="${E}/accessible-parking.pdf">accessible parking map.pdf</a> · <a href="${E}/campus.pdf">Campus map</a></li>
</ul>
<table><tr><td>Budget</td><td><a href="${E}/b.pdf">PDF</a></td><td><a href="${E}/b.html">HTML version</a></td></tr></table>
<p>Minutes <a href="${E}/m.pdf">(PDF)</a>. Large print: <a href="${E}/m-large.pdf">download</a></p>
<div class="card"><h3>Lunch menu</h3><div><a href="${E}/menu.pdf">Menu (PDF)</a></div><div><a href="${E}/menu-lp.pdf">Large print</a></div></div>
<div><div><a href="${E}/1.pdf">1</a></div><div><a href="${E}/2.pdf">2</a></div><div><a href="${E}/3.pdf">3</a></div><div><a href="${E}/4.pdf">4</a></div>
<div><a href="${E}/5.pdf">5</a></div><div><a href="${E}/6.pdf">6</a></div><div><a href="${E}/7.pdf">Accessible version</a></div></div>
</main></body></html>`;

let links: DocumentLink[];
beforeAll(async () => {
  await page.setContent(HTML);
  links = await documentLinksCollector.collect(page as unknown as PageLike, { url: `${E}/`, viewport: 'desktop' });
});

const byPath = () => Object.fromEntries(links.map((l) => [new URL(l.href).pathname, l]));

describe('documentLinks collector: containers', () => {
  it('groups links that share a list item, table row, paragraph or small card, and records the text before them', () => {
    const l = byPath();
    expect(l['/a.pdf']!.group).toBeDefined();
    expect(l['/a-accessible.pdf']!.group).toBe(l['/a.pdf']!.group);
    expect(l['/a-accessible.pdf']!.before).toBe('October agenda: View original PDF');
    expect(l['/a.pdf']!.before).toBe('October agenda:');
    expect(l['/b.html']!.group).toBe(l['/b.pdf']!.group);
    expect(l['/m-large.pdf']!.group).toBe(l['/m.pdf']!.group);
    expect(l['/m-large.pdf']!.before).toBe('Minutes (PDF). Large print:');
    expect(l['/menu-lp.pdf']!.group).toBe(l['/menu.pdf']!.group);
    const groups = new Set([l['/a.pdf']!.group, l['/b.pdf']!.group, l['/m.pdf']!.group, l['/menu.pdf']!.group, l['/campus.pdf']!.group]);
    expect(groups.size).toBe(5);
  });

  it('leaves alone a link that is the only one in its container, menus, and large blocks of links', () => {
    const l = byPath();
    expect(l['/alone.pdf']!.group).toBeUndefined();
    expect(l['/about']!.group).toBeUndefined();
    expect(l['/1.pdf']!.group).toBeUndefined();
    expect(l['/7.pdf']!.group).toBeUndefined();
    expect(l['/alone.pdf']!.before).toBeUndefined();
  });

  it('feeds the pairing: originals get their accessible version, the parking map does not', () => {
    const pairs = Object.fromEntries([...accessibleAlternatives(links, `${E}/`)].map(([k, v]) => [new URL(k).pathname, new URL(v).pathname]));
    expect(pairs).toEqual({ '/a.pdf': '/a-accessible.pdf', '/b.pdf': '/b.html', '/m.pdf': '/m-large.pdf', '/menu.pdf': '/menu-lp.pdf' });
  });
});
