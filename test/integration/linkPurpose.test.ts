// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The link purpose test (2.4.4) in real Chromium: the page reader on small pages. Its rules on what
// the reader reports: test/unit/linkPurpose.test.ts.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LINK_PURPOSE_LIMITS, linkPurposeFindings, normalizeLinkName, readLinkPurpose, type LinkPurposeRead } from '../../src/probes/linkPurpose.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

async function readOn(body: string): Promise<LinkPurposeRead> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`, { waitUntil: 'load' });
    return await page.evaluate(readLinkPurpose, LINK_PURPOSE_LIMITS);
  } finally {
    await page.close();
  }
}
const failed = async (body: string) => linkPurposeFindings(await readOn(body)).filter((f) => f.status === 'failed');

describe('readLinkPurpose', () => {
  it('finds nothing on links whose own names say where they go', async () => {
    const r = await readOn('<a href="/a">Board meeting agenda</a> <a href="/b">Lunch menu</a> <a href="/c"><img src="x.png" alt="District home"></a>');
    expect(r.links).toEqual([]);
    expect(await failed('<a href="/a">Board meeting agenda</a>')).toEqual([]);
  });

  it('reports generic link names, normalized as the Node side normalizes them', async () => {
    const r = await readOn(`
      <div><a href="/1">Read More »</a></div>
      <div><a href="/2">CLICK HERE!</a></div>
      <div><a href="/3"> learn&nbsp;more… </a></div>
      <div><a href="/4"><span>More</span> <svg aria-hidden="true"></svg></a></div>`);
    expect(r.links.map((l) => l.name)).toEqual(['read more', 'click here', 'learn more', 'more']);
    expect(r.links.map((l) => l.text)).toEqual(['Read More »', 'CLICK HERE!', 'learn more…', 'More']);
    for (const raw of ['Read More »', 'CLICK HERE!', ' learn more… ', 'More']) expect(r.links.map((l) => l.name)).toContain(normalizeLinkName(raw));
  });

  it('fails a generic link with no context at all', async () => {
    const f = await failed('<div class="card"><div class="title">Spring concert</div><a href="/concert">Learn more</a></div>');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ criterion: '2.4.4', status: 'failed' });
    expect(f[0]!.detail).toContain('“Learn more”');
  });

  it('accepts the sentence, paragraph, list item or table cell around the link (WCAG 2.4.4 in context)', async () => {
    expect(await failed('<p>The spring concert is on May 3. <a href="/c">Read more</a></p>')).toEqual([]);
    expect(await failed('<ul><li>Spring concert, May 3 <a href="/c">details</a></li><li>Book fair, April 14 <a href="/b">details</a></li></ul>')).toEqual([]);
    expect(await failed('<table><tr><th>Agenda</th><td>May 3 meeting</td><td><a href="/m">View</a></td></tr></table>')).toEqual([]);
    // Two links in one paragraph each have their own sentence: never ambiguous.
    expect(await failed('<h2>Forms</h2><p>For the lunch form click <a href="/lunch">here</a>. For the bus form click <a href="/bus">here</a>.</p>')).toEqual([]);
  });

  it('accepts an accessible name or description that says where the link goes', async () => {
    expect(await failed('<div><a href="/c" aria-label="Read more about the spring concert">Read more</a></div>')).toEqual([]);
    expect(await failed('<div><span id="t">Spring concert</span><a href="/c" aria-labelledby="l t" id="l">Read more</a></div>')).toEqual([]);
    expect(await failed('<div><span id="d">about the spring concert</span><a href="/c" aria-describedby="d">Read more</a></div>')).toEqual([]);
    expect(await failed('<div><a href="/c" title="Spring concert">Read more</a></div>')).toEqual([]);
  });

  it('accepts the heading before the link, unless links of the same name after it go to different places', async () => {
    expect(await failed('<h2>Spring concert</h2><div><a href="/c">Read more</a></div>')).toEqual([]);
    // The same destination twice under one heading is not ambiguous.
    expect(await failed('<h2>Spring concert</h2><div><a href="/c">Read more</a></div><div><a href="/c">Read more</a></div>')).toEqual([]);
    const f = await failed(`<h2>Latest news</h2>
      <div><div class="t">Concert</div><a href="/n/1">Read more</a></div>
      <div><div class="t">Book fair</div><a href="/n/2">Read more</a></div>
      <div><div class="t">Bus routes</div><a href="/n/3">Read more</a></div>`);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatch(/3 links named “Read more”.*“Latest news”.*different/);
  });

  it('takes the heading before a heading the link is in, never the link\'s own text as its context', async () => {
    const f = await failed('<h2>Arts and music</h2><h2><a href="/a">Learn More</a></h2><h2><a href="/b">Learn More</a></h2>');
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatch(/after the heading “Arts and music”/);
    expect(await failed('<h2><a href="/a">Learn More</a></h2>')).toHaveLength(1);
  });

  it('r1-2: context counts only when it carries purpose (2+ words, about 8 letters, once the link text and generic words are gone); a page-level h1 never does', async () => {
    expect(await failed('<h1>Home</h1><p>See <a href="/budget">here</a>.</p>')).toHaveLength(1);
    expect(await failed('<h1>Riverside School District</h1><div><a href="/x">Read more</a></div>')).toHaveLength(1);
    expect(await failed('<h2>News</h2><div><a href="/n">Read more</a></div>')).toHaveLength(1);
    expect(await failed('<p>Click <a href="/budget">here</a> for the 2026 budget.</p>')).toEqual([]);
    expect(await failed('<h1>Site</h1><h2>Spring concert</h2><div><a href="/c">Read more</a></div>')).toEqual([]);
  });

  it('r1-3: ARIA paragraphs, list items, cells, rows and headers are context like their native equivalents', async () => {
    expect(await failed(`<div role="table"><div role="row"><div role="rowheader">Annual budget</div><div role="cell"><a href="/budget.pdf">View</a></div></div>
      <div role="row"><div role="rowheader">Board minutes</div><div role="cell"><a href="/minutes.pdf">View</a></div></div></div>`)).toEqual([]);
    expect(await failed('<div role="list"><div role="listitem">Spring concert on May 3 <a href="/c">details</a></div></div>')).toEqual([]);
    expect(await failed('<div role="paragraph">The spring concert is on May 3. <a href="/c">Read more</a></div>')).toEqual([]);
    expect(await failed('<div role="grid"><div role="row"><div role="columnheader">Lunch menus</div><div role="gridcell"><a href="/m">View</a></div></div></div>')).toEqual([]);
  });

  it('r1-4: the title of an image inside the link is its description', async () => {
    expect(await failed('<div><a href="/fees"><img src="x.png" alt="View" title="Fee schedule for 2026"></a></div>')).toEqual([]);
  });

  it('r1-5: the rest of the heading a link sits in is its context', async () => {
    expect(await failed('<h2><a href="/concert">Learn more</a> about the spring concert on May 3</h2>')).toEqual([]);
  });

  it('r1-6: generic phrases in French and German too', async () => {
    for (const t of ['Lire la suite', 'En savoir plus', 'Cliquez ici', 'Mehr erfahren', 'Weiterlesen', 'Hier klicken']) {
      expect((await readOn(`<div><a href="/x">${t}</a></div>`)).links, t).toHaveLength(1);
    }
  });

  it('names that say only what kind of thing a link opens ("Open", "File", "Download") are generic too', async () => {
    // Two of one name after the same heading that open different files: name and context cannot tell them apart.
    const f = await failed('<div><h2>Budget papers for the board</h2><a id="a" href="/files/draft-budget.xlsx">Open</a><br><a href="/files/staff-report.docx">Open</a></div>');
    expect(f.map((x) => x.target)).toEqual(['#a']);
    expect(f[0]!.detail).toContain('2 links named “Open” after the heading “Budget papers for the board” go to different pages');
    expect(await failed('<h2>Trail work this month</h2><p>Crews are regrading the creek path.</p><nav aria-label="Attachments"><a href="/files/map.pdf">File</a> <a href="/files/fees.pdf">File</a></nav>')).toHaveLength(1);
    // With nothing at all around them, two that go to different files fail together; one alone does not (a page's
    // own "Download PDF" or "Open" is clear to everyone: 2.4.4's exception).
    expect((await failed('<div><a href="/files/form-12.pdf">Download</a></div><div><a href="/files/form-14.pdf">Download</a></div>')).map((x) => x.detail)).toEqual([expect.stringContaining('2 links named “Download” with nothing around them')]);
    expect(await failed('<aside><a href="/this-page.pdf">Download PDF</a> <a href="/print">Print</a></aside>')).toEqual([]);
    // Look-alikes: each in its own list item or table row that names the file; the same file twice; a name that says what it opens.
    expect(await failed(`
      <h2>Budget papers for the board</h2>
      <ul><li>Draft budget for next year <a href="/files/draft-budget.xlsx">Open</a></li><li>Staff report on the draft <a href="/files/staff-report.docx">Open</a></li></ul>
      <table><tr><th>Paper</th><th>File</th></tr><tr><td>Minutes of the October meeting</td><td><a href="/files/minutes.pdf">Download</a></td></tr><tr><td>Agenda for November</td><td><a href="/files/agenda.pdf">Download</a></td></tr></table>
      <h2>Fee schedule for the season</h2><a href="/files/fees.pdf">Download</a> <a href="/files/fees.pdf">Download</a>
      <h2>Annual report of the district</h2><a href="/files/annual.pdf">Download the annual report</a> <a href="/files/summary.pdf">Open the two-page summary</a>`)).toEqual([]);
    // These names do not make their words meaningless as context: a "read more" link beside "Budget document" still has its context.
    expect(await failed('<ul><li>Budget document <a href="/b">Read more</a></li><li>Open file cabinet policy <a href="/c">Read more</a></li></ul>')).toEqual([]);
  });

  it('text and a link together in one plain block are a paragraph in all but its tag: the text is the link\'s context', async () => {
    expect(await failed(`
      <div>The council adopted the new parks plan on Tuesday. <a href="/a">Read more</a></div>
      <div><span class="t">Annual report for 2025</span> <a href="/files/annual.pdf">Download</a></div>
      <div><span class="t">Budget summary for 2026</span> <a href="/files/budget.pdf">Download</a></div>`)).toEqual([]);
    // Look-alikes that still fail: the link alone in its block, and a block that holds only generic links.
    expect((await failed('<div><div class="title">Annual report for 2025</div><div><a id="a" href="/annual">Read more</a></div></div>')).map((x) => x.target)).toEqual(['#a']);
    expect((await failed('<div><a id="b" href="/annual">Details</a> | <a id="c" href="/more">More</a></div>')).map((x) => x.target)).toEqual(['#b', '#c']);
  });

  // W3C precision lane (2026-11-11): words of its own, too few for a purpose (2 words, 8 letters), prove nothing either way.
  it('a few words of its own around the link (sentence, block, list item, description) are undecided, never a failure', async () => {
    const all = async (body: string) => linkPurposeFindings(await readOn(body));
    expect(await all(`<div><a id="w" href="https://www.w3.org/WAI/">Read more</a> about the W3C WAI</div>
      <div><a href="https://www.w3.org/International/">Read more</a> about the W3C internationalization</div>`)).toEqual([
      expect.objectContaining({ status: 'not_testable', target: '#w', detail: expect.stringContaining('(“about the W3C WAI”)') }),
    ]);
    for (const body of [
      '<div><a href="/recycling">Learn more</a> about recycling</div>',
      '<ul><li>Agenda <a href="/a.pdf">View</a></li><li>Minutes <a href="/m.pdf">View</a></li></ul>',
      '<div><span id="d">Parking</span> <a href="/p" aria-describedby="d">Read more</a></div><div>Text.</div>',
      '<p>EU <a href="/eu">details</a></p>',
    ]) {
      const f = await all(body);
      expect(f.filter((x) => x.status === 'failed'), body).toEqual([]);
      expect(f.map((x) => x.status), body).toEqual(['not_testable']);
    }
    // Kind-only names with words of their own are each their own: never compared, never failed, after one heading too.
    expect(await all('<div>Budget <a href="/b.pdf">Open</a></div><div>Minutes <a href="/m.pdf">Open</a></div>')).toEqual([]);
    expect(await all('<h2>Board papers for this year</h2><div>Budget <a href="/b.pdf">Open</a></div><div>Minutes <a href="/m.pdf">Open</a></div>')).toEqual([]);
    // Fable review F4: the same own words beside each ("PDF icon"): name, heading and words cannot tell them apart.
    expect((await failed('<h2>Board papers for this year</h2><ul><li><img src="p.png" alt="PDF icon"> <a id="o1" href="/a.pdf">Open</a></li><li><img src="p.png" alt="PDF icon"> <a href="/b.pdf">Open</a></li></ul>')).map((x) => [x.target, x.detail]))
      .toEqual([['#o1', '2 links named “Open” after the heading “Board papers for this year”, each beside the same words “PDF icon”, go to different pages, so their names and context do not say which is which']]);
  });

  it('look-alikes that still fail: no words of their own (separators, generic words, a digit, only a heading of one word before)', async () => {
    expect((await failed('<div><a id="x" href="/x">Read more</a> »</div>')).map((x) => x.target)).toEqual(['#x']);
    expect((await failed('<div><a id="y" href="/y">Click here</a> to see more</div>')).map((x) => x.target)).toEqual(['#y']);
    expect((await failed('<p><a id="z" href="/z">More</a> (3)</p>')).map((x) => x.target)).toEqual(['#z']);
    expect((await failed('<h2>News</h2><div><a id="n" href="/n">Read more</a></div>')).map((x) => x.target)).toEqual(['#n']);
    expect((await failed('<p id="p"><a href="/a.pdf">Open</a> · <a href="/b.pdf">Open</a></p>')).map((x) => x.detail)).toEqual([expect.stringContaining('2 links named “Open” with nothing around them')]);
    // Words that describe a file or a date are none of their own: a file's type and size, a date.
    expect((await failed('<h2>Board papers for this year</h2><p><a href="/a.pdf">Download</a> (PDF, 1 MB)</p><p><a href="/b.pdf">Download</a> (PDF, 2 MB)</p>')).map((x) => x.detail))
      .toEqual([expect.stringContaining('2 links named “Download” after the heading “Board papers for this year” go to different pages')]);
    expect((await failed('<h2>News</h2><div>Nov 3 <a id="d" href="/n1">Read more</a></div>')).map((x) => x.target)).toEqual(['#d']);
  });

  it('ignores links hidden from everyone, and counts screen-reader-only ones', async () => {
    expect((await readOn('<div style="display:none"><a href="/a">Read more</a></div><div aria-hidden="true"><a href="/b" tabindex="-1">more</a></div><a href="/c" hidden>here</a>')).links).toEqual([]);
    expect((await readOn('<a href="/a" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Click here</a>')).links).toHaveLength(1);
  });

  it('reads role="link" and links in open shadow roots', async () => {
    const r = await readOn(`<span role="link" tabindex="0">Click here</span><div id="host"></div>
      <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<a href="/s">Read more</a>';</script>`);
    expect(r.links.map((l) => l.name).sort()).toEqual(['click here', 'read more']);
  });

  it('treats page text as data: a link named with markup-like text is only matched as text', async () => {
    const r = await readOn('<div><a href="/x">&lt;b&gt;read more&lt;/b&gt;</a></div>');
    expect(r.links).toEqual([]);
  });
});
