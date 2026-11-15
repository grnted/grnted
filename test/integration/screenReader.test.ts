// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The screen-reader pass in real Chromium: the accessibility tree read over CDP, the transcript and the
// findings on the fixture pages (test/fixtures/screen-reader/, synthetic), the request guard (the probe
// changes nothing and sends nothing), and hostile pages (50,000 nodes, deep nesting, a cyclic aria-owns).
// Transcripts are compared on structure (role, name, level, states, event), never on raw strings.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import {
  screenReaderLiveProbe, type SrLiveData,
  listenData, readTree, runScreenReader, screenReaderFindings, screenReaderProbe, SR_SHOT_PAGES, transcribe, type SrListenData, FULL_CAPS, SR_TREE_LIMITS, type SrReportData, type SrTree, type Utterance,
} from '../../src/probes/screenReader/index.js';
import type { BrowserLike, CDPSessionLike, ProbeRun } from '../../src/types.js';
import { runAttachment } from '../../src/probes/types.js';
import type { VisionFacts } from '../../src/collect/vision.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test' };

beforeAll(async () => {
  server = await startFixtureServer('screen-reader');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function treeOf(page: Page, deadlineMs = 15_000, limits: { nodes: number; snapshotNodes: number; name: number; callMs: number } = SR_TREE_LIMITS): Promise<SrTree> {
  const cdp = (await page.context().newCDPSession(page)) as unknown as CDPSessionLike;
  const tree = await readTree(cdp, Date.now() + deadlineMs, limits);
  if (!tree) throw new Error('no tree');
  return tree;
}

async function on<T>(fn: (page: Page) => Promise<T>, url?: string, html?: string): Promise<T> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    if (url) await page.goto(url);
    else await page.setContent(html ?? '', { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await page.close();
  }
}

const fixture = (name: string) => `${server.origin}/${name}.html`;
const shape = (us: Utterance[]) => us.map((u) => [u.event ?? 'item', u.role, u.name, ...(u.level ? [u.level] : []), ...(u.states?.length ? [u.states.join(' ')] : [])]);
const kinds = (tree: SrTree) => screenReaderFindings(tree).findings.map((f) => [f.criterion, f.status]);
const runOn = async (name: string): Promise<ProbeRun> => (await runProbes(B(), [{ url: fixture(name), index: 0 }], [screenReaderProbe], OPTS))[0]!;

describe('a native disclosure in real Chromium (details and summary)', () => {
  it('is heard as a control with its collapsed or expanded state, never as plain text; its panel is heard only when open', async () => {
    const html = '<!doctype html><html lang="en"><body><nav aria-label="Main"><ul>'
      + '<li><details><summary>Customer Service</summary><a href="/pay">Pay Your Bill</a></details></li>'
      + '<li><details open><summary>Water</summary><a href="/quality">Water Quality</a></details></li></ul></nav></body></html>';
    const tree = await on((p) => treeOf(p), undefined, html);
    const nvda = transcribe(tree, 'nvda', FULL_CAPS);
    expect(shape(nvda.readThrough).filter((r) => r[1] === 'disclosuretriangle' || r[1] === 'link')).toEqual([
      ['item', 'disclosuretriangle', 'Customer Service', 'collapsed'],
      ['item', 'disclosuretriangle', 'Water', 'expanded'],
      ['item', 'link', 'Water Quality'],
    ]);
    expect(nvda.readThrough.filter((u) => u.role === 'disclosuretriangle').map((u) => u.text)).toEqual(['button, Customer Service, collapsed', 'button, Water, expanded']);
    expect(nvda.readThrough.some((u) => u.role === 'statictext' && /Customer Service|Water$/.test(u.name))).toBe(false);
    expect(transcribe(tree, 'voiceover', FULL_CAPS).readThrough.filter((u) => u.role === 'disclosuretriangle').map((u) => u.text))
      .toEqual(['Customer Service, collapsed, disclosure triangle', 'Water, expanded, disclosure triangle']);
    expect(kinds(tree)).toEqual([]);
  });
});

describe('the transcript (structure, from the real tree)', () => {
  it('reads a correct page top to bottom with landmarks, lists, tables and fields, and finds nothing wrong', async () => {
    const tree = await on((p) => treeOf(p), fixture('clean'));
    const t = transcribe(tree, 'voiceover', FULL_CAPS);
    expect(kinds(tree)).toEqual([]);
    const read = shape(t.readThrough);
    expect(read.slice(0, 9)).toEqual([
      ['enter', 'banner', ''],
      ['item', 'link', 'Riverbend Library'],
      ['enter', 'navigation', 'Main'],
      ['enter', 'list', ''],
      ['item', 'link', 'Visit'],
      ['item', 'link', 'Events'],
      ['item', 'link', 'Contact'],
      ['exit', 'list', ''],
      ['exit', 'navigation', 'Main'],
    ]);
    expect(t.readThrough.find((u) => u.role === 'list')!.text).toBe('list, 3 items');
    expect(read).toContainEqual(['item', 'heading', 'Opening hours', 1]);
    expect(read).toContainEqual(['enter', 'form', 'Reminders']);
    expect(read).toContainEqual(['item', 'textbox', 'Email', 'required']);
    expect(read).toContainEqual(['item', 'checkbox', 'Weekly summary', 'checked']);
    expect(read).toContainEqual(['item', 'button', 'Print this page']);
    // The table is announced with its size, and data cells with their column header.
    const table = t.readThrough.find((u) => u.role === 'table' && u.event === 'enter')!;
    expect(table.text).toContain('4 rows, 3 columns');
    expect(t.readThrough.find((u) => u.role === 'cell' && u.name === '20:00')!.text).toMatch(/^Closes, /);
    // Every line in the main content says it is in the main landmark.
    expect(t.readThrough.find((u) => u.name === 'Opening hours' && u.role === 'heading')!.landmark).toBe('main');
    expect(shape(t.lists.headings)).toEqual([['item', 'heading', 'Opening hours', 1], ['item', 'heading', 'This week', 2], ['item', 'heading', 'Get reminders', 2], ['item', 'heading', 'Questions', 3]]);
    expect(t.lists.landmarks.map((u) => u.role)).toEqual(['banner', 'navigation', 'main', 'form', 'contentinfo']);
    expect(t.lists.links.map((u) => u.name)).toEqual(['Riverbend Library', 'Visit', 'Events', 'Contact', 'Holiday closures', 'write to us']);
    expect(t.lists.formControls.map((u) => u.name)).toEqual(['Email', 'Weekly summary', 'Subscribe', 'More services', 'Print this page']);
    expect(t.lists.tables).toHaveLength(1);
    // Tab stops: every link and control, in order.
    expect(t.tabStops.map((u) => u.name)).toEqual(['Riverbend Library', 'Visit', 'Events', 'Contact', 'Holiday closures', 'Email', 'Weekly summary', 'Subscribe', 'More services', 'write to us', 'Print this page']);
    // Every line points at its element.
    expect(t.readThrough.filter((u) => u.event !== 'exit' && !u.nodeRef)).toEqual([]);
  });

  it('says descriptions, announces articles, and reads a caption only as the table name (VoiceOver calibration)', async () => {
    const tree = await on((p) => treeOf(p), undefined, `<main><article><h2>Budget</h2><p>Approved.</p></article>
      <table><caption>Hours</caption><tr><th>Day</th><th>Open</th></tr><tr><th scope="row">Mon</th><td>9</td></tr></table>
      <label for="e">Email</label><input id="e" aria-describedby="h"><p id="h">We only use it to answer you.</p></main>`);
    const t = transcribe(tree, 'voiceover');
    expect(shape(t.readThrough).slice(0, 3)).toEqual([['enter', 'main', ''], ['enter', 'article', ''], ['item', 'heading', 'Budget', 2]]);
    expect(t.readThrough.filter((u) => u.role === 'statictext' && u.name === 'Hours')).toEqual([]);
    expect(t.readThrough.find((u) => u.role === 'table')!.name).toBe('Hours');
    expect(t.readThrough.find((u) => u.role === 'textbox')!.text).toBe('Email, We only use it to answer you., edit text');
    expect(t.readThrough.find((u) => u.role === 'rowheader')!.text).toBe('Day, Mon');
  });

  it('speaks NVDA role-first and VoiceOver name-first from the same tree', async () => {
    const tree = await on((p) => treeOf(p), fixture('clean'));
    const nvda = transcribe(tree, 'nvda').readThrough.find((u) => u.role === 'heading')!.text;
    const vo = transcribe(tree, 'voiceover').readThrough.find((u) => u.role === 'heading')!.text;
    expect(nvda).toBe('heading level 1, Opening hours');
    expect(vo).toBe('Opening hours, heading level 1');
  });

  // Patterns the 2026-11-07 accuracy audit found misread (docs/accuracy-audit-2026-11-07.md): the AI
  // listener scored them as role and structure problems because the transcript said them wrongly.
  describe('patterns from real sites, as NVDA says them', () => {
    const lines = async (voice: 'nvda' | 'voiceover' = 'nvda') => transcribe(await on((p) => treeOf(p), fixture('real-patterns')), voice).readThrough;

    it('says the link inside a heading (h2 > a): "heading level 2, link, Apply or file"', async () => {
      const read = await lines();
      expect(read.find((u) => u.role === 'heading' && u.name === 'Apply or file')!.text).toBe('heading level 2, link, Apply or file');
      expect(read.find((u) => u.role === 'heading' && u.name === 'Latest news and updates')!.text).toBe('heading level 2, Latest, link, news and updates');
      const vo = await lines('voiceover');
      expect(vo.find((u) => u.role === 'heading' && u.name === 'Apply or file')!.text).toBe('Apply or file, link, heading level 2');
    });

    it('says the heading inside a link (a > h2) and the rest of the link', async () => {
      const read = await lines();
      expect(read.find((u) => u.role === 'link' && u.name.startsWith('Utility Billing'))!.text).toBe('link, heading level 2, Utility Billing, Pay your water bill online.');
    });

    it('takes a cell\'s headers from its headers attribute when it has one', async () => {
      const read = await lines();
      const rowHeaders = read.filter((u) => u.role === 'rowheader' && u.name === 'Obelisks').map((u) => u.text);
      expect(rowHeaders).toEqual(['Adult, row header, Obelisks', 'Concession, row header, Obelisks']);
      expect(read.filter((u) => u.role === 'cell' && u.name === '$15.90').map((u) => u.text)).toEqual(['Concession, Front seats, Obelisks, $15.90']);
    });

    it('marks a frame from another origin as not read, and reads a same-origin frame in place', async () => {
      const read = await lines();
      // Another origin (localhost vs 127.0.0.1): its content is another site's, not read into the page's lines.
      const frame = read.findIndex((u) => u.role === 'iframe' && u.name === 'Submit an ADA concern');
      expect(read[frame]!.unread).toBe(true);
      expect(read.map((u) => u.text)).not.toContain('navigation landmark, Main');
      // Review round 1: a same-site frame's own document is read under its <iframe>, not marked unread.
      const at = read.findIndex((u) => u.role === 'iframe' && u.name === 'Opening hours');
      expect(read[at]!.unread).toBeUndefined();
      expect(read.slice(at + 1, at + 4).map((u) => u.text)).toContain('heading level 2, Opening hours');
      expect(read.slice(at + 1, at + 5).map((u) => u.text)).toContain('Monday to Friday, 9 to 5.');
    });

    const review = async () => transcribe(await on((p) => treeOf(p), fixture('review-patterns')), 'nvda').readThrough;

    it('says a heading named by aria-label by that name, even with a link inside', async () => {
      const read = await review();
      expect(read.find((u) => u.role === 'heading' && u.name === 'Permits and licences')!.text).toBe('heading level 2, Permits and licences');
    });

    it('keeps the header above a cell whose headers attribute names an id that is not in the table, and says so', async () => {
      const read = await review();
      const fee = read.find((u) => u.role === 'cell' && u.name === '$15')!;
      expect(fee.text).toBe('Fee, $15');
      expect(fee.headersUnresolved).toBe(true);
    });

    it('says a select by its name and value, and a landmark named by aria-labelledby with its name', async () => {
      const read = await lines();
      expect(read.find((u) => u.role === 'combobox')!.text).toBe('combo box, Language Translate Widget, Select Language');
      expect(read.find((u) => u.role === 'navigation' && u.event === 'enter' && u.name === 'Useful Links')!.text).toBe('navigation landmark, Useful Links');
    });

    it('marks a landmark\'s visible title as its label for the AI listener (label_of), like a field\'s label', async () => {
      const tree = await on((p) => treeOf(p), fixture('real-patterns'));
      const { lines } = listenData(tree, transcribe(tree, 'nvda'), 1_000_000);
      const nav = lines.findIndex((l) => l.t === 'navigation landmark, Useful Links');
      const title = lines.find((l, i) => i > nav && l.t === 'Useful Links')!;
      expect(title.l).toBe(nav + 1);
      // Review round 1: only a title that IS the landmark's name, from the element aria-labelledby names. A bold
      // "Account" inside a menu named "Customer account menu" is not its label (it may be a missing heading).
      const rt = await on((p) => treeOf(p), fixture('review-patterns'));
      const account = listenData(rt, transcribe(rt, 'nvda'), 1_000_000).lines.find((l) => l.t === 'Account')!;
      expect(account.l).toBeUndefined();
    });
  });
});

describe('text that changes by itself (batch 6: a rotating notice scored as heard but not shown)', () => {
  // The listener compared a transcript from one moment with a screenshot from another load: a notice rotating every
  // 500 ms read as heard but not shown. The pass now takes both from the same paused page.
  const facts = (run: ProbeRun) => runAttachment(run) as VisionFacts | undefined;
  it('takes the listener\'s screenshot and facts at the moment it reads the tree (5 runs, 500 ms rotation)', async () => {
    for (let k = 0; k < 5; k++) {
      const run = await runOn('rotating');
      const heard = (run.data as { listen: SrListenData }).listen.lines.find((l) => l.t.startsWith('Notice '))!.t;
      const f = facts(run)!;
      expect(f.screenshot!.length).toBeGreaterThan(1000);
      const shown = f.blocks.filter((b) => b.text.startsWith('Notice ')).map((b) => b.text);
      expect(shown).toEqual([heard]);
    }
  }, 120_000);

  it('stops the page\'s script while it reads, and lets it run on afterwards', async () => {
    await on(async (page) => {
      const sent: string[] = [];
      let stopped = 0;
      const cdp = async () => {
        const c = await page.context().newCDPSession(page);
        c.on('Debugger.paused', () => { stopped++; });
        return { send: (m: string, p?: Record<string, unknown>) => { sent.push(m); return c.send(m as never, p as never); }, on: c.on.bind(c) } as unknown as CDPSessionLike;
      };
      const ctx = { page, url: fixture('rotating'), pageIndex: 0, viewport: { width: 1280, height: 900 }, deadline: Date.now() + 15_000,
        signal: new AbortController().signal, guard: { mark: () => 0 }, cdp, setData: () => {}, attach: () => {} };
      await runScreenReader(ctx as never);
      expect(stopped).toBe(1);
      const at = (m: string) => sent.indexOf(m);
      expect(at('Debugger.pause')).toBeLessThan(at('Page.captureScreenshot'));
      expect(at('Page.captureScreenshot')).toBeLessThan(at('Accessibility.getFullAXTree'));
      expect(at('Accessibility.getFullAXTree')).toBeLessThan(at('Debugger.resume'));
      const seen = new Set<string>();
      for (let k = 0; k < 6; k++) { seen.add(await page.locator('#slides').innerText()); await page.waitForTimeout(300); }
      expect(seen.size).toBeGreaterThan(1);
    }, fixture('rotating'));
  }, 30_000);

  it('reads a page with no script running (it never stops in the debugger) and still takes the facts', async () => {
    const run = await runOn('clean');
    expect(run.status).toBe('ok');
    expect((run.data as { listen: SrListenData }).listen.lines.length).toBeGreaterThan(0);
    expect(facts(run)?.screenshot?.length).toBeGreaterThan(1000);
  }, 30_000);

  it('takes no screenshot past the pages the listener can sample', async () => {
    const [run] = await runProbes(B(), [{ url: fixture('clean'), index: SR_SHOT_PAGES }], [screenReaderProbe], OPTS);
    expect(runAttachment(run!)).toBeUndefined();
  }, 30_000);
});

describe('findings (only what the tree proves)', () => {
  it('an unnamed button: 4.1.2, the line is only its role', async () => {
    const tree = await on((p) => treeOf(p), fixture('unnamed-button'));
    expect(kinds(tree)).toEqual([['4.1.2', 'failed']]);
    expect(shape(transcribe(tree).readThrough)).toContainEqual(['item', 'button', '']);
  });

  it('an icon link with no name: 4.1.2 and 2.4.4', async () => {
    const tree = await on((p) => treeOf(p), fixture('icon-link'));
    expect(kinds(tree)).toEqual([['4.1.2', 'failed'], ['2.4.4', 'failed']]);
  });

  // 2026-11-07: WCAG requires no heading order (H42 with any levels): a skipped level is a note, never a failure.
  it('skipped heading levels: no failure', async () => {
    const tree = await on((p) => treeOf(p), fixture('skipped-headings'));
    expect(kinds(tree)).toEqual([]);
  });

  it('a data table with no header cells: 1.3.1; a layout table is not a table', async () => {
    expect(kinds(await on((p) => treeOf(p), fixture('table-no-headers')))).toEqual([['1.3.1', 'failed']]);
    const layout = await on((p) => treeOf(p), undefined, '<h1>T</h1><table><tr><td>Left column text</td><td>Right column text</td></tr><tr><td>a</td><td>b</td></tr></table>');
    expect(kinds(layout)).toEqual([]);
    expect(transcribe(layout).lists.tables).toEqual([]);
  });

  it('a CSS-reordered layout: 1.3.2 when the line read second is shown above the one read first', async () => {
    const tree = await on((p) => treeOf(p), fixture('css-reorder'));
    const f = screenReaderFindings(tree).findings;
    expect(f.map((x) => [x.criterion, x.status])).toEqual([['1.3.2', 'failed']]);
    expect(f[0]!.detail).toContain('Step 1');
  });

  it('is conservative on order: side-by-side columns, positioned elements and a sidebar placed first leave 1.3.2 alone', async () => {
    const tree = await on((p) => treeOf(p), undefined, `<main><h1>Page</h1>
      <div style="display:grid;grid-template-columns:200px 1fr"><p style="grid-column:2">Main text first in the code.</p><p style="grid-column:1;grid-row:1">Sidebar text shown on the left.</p></div>
      <div style="position:relative;height:200px"><p>Text read first, shown below.</p><p style="position:absolute;top:0">Badge shown on top</p></div>
      <div style="display:flex;flex-direction:row-reverse"><p>Right</p><p>Left</p></div>
      <div style="position:relative;padding-top:60px"><p>Price list read first.</p><p style="position:absolute;top:0;left:0">New badge</p></div>
      <div><p style="margin:0;line-height:40px">Overlap read first</p><p style="margin:-30px 0 0;line-height:40px">Pulled up a little</p></div></main>`);
    expect(kinds(tree)).toEqual([]);
  });

  // Batch 17 (reported from a default column chart of a charting library inside a role="img" container): the
  // labels along a chart's axis are drawn from the bottom up; inside a picture there is no reading order to compare.
  it('look-alikes: the labels of a chart drawn in an svg, inside a role="img" container or not, leave 1.3.2 alone', async () => {
    const chart = (attrs: string) => `<div ${attrs} style="width:420px"><div class="chart-box"><svg width="420" height="260" viewBox="0 0 420 260" xmlns="http://www.w3.org/2000/svg">
      <g class="grid"><path d="M 50 210 H 400" stroke="#767676"/><path d="M 50 160 H 400" stroke="#767676"/><path d="M 50 110 H 400" stroke="#767676"/><path d="M 50 60 H 400" stroke="#767676"/></g>
      <g class="bars"><rect x="80" y="110" width="60" height="100" fill="#0b4fb3"/><rect x="190" y="60" width="60" height="150" fill="#0b4fb3"/><rect x="300" y="160" width="60" height="50" fill="#0b4fb3"/></g>
      <g class="y-axis" text-anchor="end" font-size="13"><text x="42" y="214">0</text><text x="42" y="164">10</text><text x="42" y="114">20</text><text x="42" y="64">30</text></g>
      <g class="x-axis" text-anchor="middle" font-size="13"><text x="110" y="234">General fund</text><text x="220" y="234">Water fund</text><text x="330" y="234">Street fund</text></g>
      <g class="title" font-size="15"><text x="50" y="24">Adopted budget by fund, in millions</text></g></svg></div></div>`;
    for (const attrs of ['role="img" aria-label="Column chart: adopted budget by fund"', 'id="budget"', 'role="figure" aria-label="Adopted budget by fund"']) {
      const tree = await on((p) => treeOf(p), undefined, `<main><h1>Budget</h1><p>The council adopted the budget in June.</p>${chart(attrs)}<p>The figures are in millions of dollars.</p></main>`);
      expect(kinds(tree).filter((k) => k[0] === '1.3.2'), attrs).toEqual([]);
      // The same tree without the two facts that say "this is a picture" is what the rule saw before: it fails
      // there (the axis labels, read from the bottom up), so the page is a real case of the old false alarm.
      const before: SrTree = { ...tree, nodes: tree.nodes.map((n) => { const { graphic: _graphic, ...rest } = n; return { ...rest, role: n.role === 'img' ? 'generic' : n.role }; }) };
      expect(kinds(before).filter((k) => k[0] === '1.3.2'), `${attrs} (before)`).toEqual([['1.3.2', 'failed']]);
    }
    // The same labels as text of the page (no drawing), read from the bottom up and shown from the top down, still fail.
    const plain = await on((p) => treeOf(p), undefined, '<main><h1>Budget</h1><div style="display:flex;flex-direction:column-reverse"><p>First line of the notice, read first.</p><p>Second line of the notice, read second and shown above the first.</p></div></main>');
    expect(kinds(plain)).toEqual([['1.3.2', 'failed']]);
  });

  // Sol review of batch 17, S8: a drawing stops at its foreignObject. What that holds is HTML laid out by the flow of its
  // text (a document of its own, exposed as such): two instructions there, read in one order and shown in the other,
  // fail as they would anywhere on the page; a chart drawn inside it is a picture again.
  it('Sol S8: two instructions reversed with CSS inside an svg foreignObject fail 1.3.2; a chart drawn inside the foreignObject stays clean', async () => {
    const steps = '<div style="display:flex;flex-direction:column-reverse"><p>Then take the form to the front desk of the library before the end of the month.</p><p>First fill in the request form with your name and your card number.</p></div>';
    const fo = (inner: string) => `<main><h1>How to ask for a book</h1><svg width="520" height="260" viewBox="0 0 520 260" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="520" height="260" fill="#f4f4f4"/><foreignObject x="10" y="10" width="500" height="240"><div xmlns="http://www.w3.org/1999/xhtml">${inner}</div></foreignObject></svg></main>`;
    const tree = await on((p) => treeOf(p), undefined, fo(steps));
    expect(kinds(tree).filter((k) => k[0] === '1.3.2')).toEqual([['1.3.2', 'failed']]);
    // A chart drawn inside the foreignObject (an svg of its own, its axis labels from the bottom up): a picture again.
    const chart = '<svg width="300" height="200" viewBox="0 0 300 200"><g text-anchor="end" font-size="13"><text x="40" y="190">0</text><text x="40" y="130">10</text><text x="40" y="70">20</text><text x="40" y="14">30</text></g><rect x="60" y="60" width="40" height="130" fill="#0b4fb3"/></svg>';
    const inner = await on((p) => treeOf(p), undefined, fo(`<p>Books lent each month.</p>${chart}`));
    expect(kinds(inner).filter((k) => k[0] === '1.3.2')).toEqual([]);
    // The same instructions in the order they are shown: clean.
    const right = await on((p) => treeOf(p), undefined, fo('<div><p>First fill in the request form with your name and your card number.</p><p>Then take the form to the front desk of the library before the end of the month.</p></div>'));
    expect(kinds(right).filter((k) => k[0] === '1.3.2')).toEqual([]);
  });

  // Batch 19, the lead's ruling: an empty heading is Needs review under 1.3.1 (flagged), never a failure, never 2.4.6.
  it('empty headings are flagged under 1.3.1 (never failed, never 2.4.6); duplicate link names are flags, not failures', async () => {
    const tree = await on((p) => treeOf(p), undefined, '<main><h1>News</h1><h2></h2><p>a</p><a href="/a">Read more</a><a href="/b">Read more</a><a href="/c#x">Same</a><a href="/c">Same</a></main>');
    const r = screenReaderFindings(tree);
    expect(r.findings.map((x) => [x.criterion, x.status])).toEqual([['1.3.1', 'flagged']]);
    // The empty heading's own review flag sits beside the link flags (batch 19); the link flags are unchanged.
    expect(r.flags.filter((x) => x.criterion === '' && /links named/.test(x.note)).map((x) => x.note)).toEqual(['2 links named “Read more” go to different places', '2 links named “Read more” go to different places']);
  });
});

describe('the probe in the runner (guarded)', () => {
  it('changes nothing on the page and sends nothing: no guard event, the same DOM before and after', async () => {
    const before = await on((p) => p.evaluate(() => document.documentElement.outerHTML), fixture('clean'));
    let after = '';
    const spy = {
      ...screenReaderProbe, id: 'sr-spy',
      async run(ctx: Parameters<typeof screenReaderProbe.run>[0]) {
        const mark = ctx.guard.mark();
        const out = await screenReaderProbe.run(ctx);
        after = await ctx.page.evaluate(() => document.documentElement.outerHTML, undefined);
        expect(ctx.guard.since(mark)).toEqual([]);
        return out;
      },
    };
    const [run] = await runProbes(B(), [{ url: fixture('clean'), index: 0 }], [spy], OPTS);
    expect(run!.status).toBe('ok');
    expect(after).toBe(before);
  });

  it('reports findings with targets, and keeps a bounded excerpt with the flagged line marked', async () => {
    const run = await runOn('unnamed-button');
    expect(run.status).toBe('ok');
    expect(run.findings.filter((f) => f.status === 'failed').map((f) => f.criterion)).toEqual(['4.1.2']);
    expect(run.findings[0]!.target).toMatch(/button/);
    const data = run.data as SrReportData;
    expect(data.voice).toBe('nvda');
    const flagged = data.read.filter((l) => l.flag !== undefined);
    expect(flagged.map((l) => l.text)).toEqual(['button']);
    expect(data.flags[flagged[0]!.flag!]!.criterion).toBe('4.1.2');
    expect(data.lists.headings).toEqual(['heading level 1, Search the catalogue']);
    expect(JSON.stringify(data).length).toBeLessThan(20_000);
  });

  it('is clean on a correct page and declares itself unscored', async () => {
    const run = await runOn('clean');
    expect(run.findings.filter((f) => f.status !== 'no_failures_found')).toEqual([]);
    expect(screenReaderProbe.scored).toBe(false);
  });
});

describe('live announcements (menus and empty form submits, network shut)', () => {
  const live = async (name: string) => (await runProbes(B(), [{ url: fixture(name), index: 0 }], [screenReaderLiveProbe], OPTS))[0]!;
  const failedOf = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed').map((f) => f.criterion).sort();

  it('a correct page: the menu says expanded, the browser announces the empty required field, nothing fails', async () => {
    const r = await live('clean');
    expect(r.status).toBe('ok');
    expect(failedOf(r)).toEqual([]);
    const d = r.data as SrLiveData;
    expect(d.menus).toBe(1);
    expect(d.forms).toBe(1);
    expect(d.lines.find((l) => l.flow === 'menu')).toMatchObject({ heard: true, text: 'button, More services, expanded' });
    expect(d.lines.filter((l) => l.flow === 'form' && l.heard).length).toBeGreaterThan(0);
    expect(d.lines.some((l) => l.criterion)).toBe(false);
  });

  it('a visual-only status message: 4.1.3, and the line is marked as shown but not said', async () => {
    const r = await live('visual-status');
    expect(failedOf(r)).toEqual(['4.1.3']);
    const d = r.data as SrLiveData;
    expect(d.lines).toContainEqual(expect.objectContaining({ flow: 'form', heard: false, text: 'There is 1 error in this form', criterion: '4.1.3' }));
  });

  it('an unannounced form error that is not tied to its field: 3.3.1 and 4.1.3', async () => {
    const r = await live('form-error');
    expect(failedOf(r)).toEqual(['3.3.1', '4.1.3']);
    expect((r.data as SrLiveData).lines).toContainEqual(expect.objectContaining({ heard: false, text: 'This cannot be empty' }));
  });

  it('a field error tied to the field focus lands on is heard with it (its description), not listed as unheard', async () => {
    // grnted.co's free check: a summary alert, focus to the first field, each field naming its error (aria-describedby).
    const r = await live('form-errors-described');
    const d = r.data as SrLiveData;
    expect(d.lines).toContainEqual(expect.objectContaining({ heard: true, text: 'edit, Website address, invalid entry, Enter a full website address, like https://example.org' }));
    expect(d.lines).toContainEqual(expect.objectContaining({ heard: true, text: 'Please fix the details below.' }));
    expect(d.lines.some((l) => !l.heard && l.text.startsWith('Enter a full website address'))).toBe(false);
    // The second field's error is tied to its own field, which focus did not reach: said with that field, never a 3.3.1 failure.
    expect(d.lines).toContainEqual(expect.objectContaining({ heard: false, text: 'Enter an email address, like you@example.org.', withField: 'Email address' }));
    expect(failedOf(r)).not.toContain('3.3.1');
  });

  it('a menu button that opens its list but still says collapsed: 4.1.2', async () => {
    const r = await live('menu-state');
    expect(failedOf(r)).toEqual(['4.1.2']);
    expect((r.data as SrLiveData).lines[0]).toMatchObject({ flow: 'menu', text: 'button, All services, collapsed', criterion: '4.1.2' });
  });

  it('sends nothing: a form that posts and a menu that reports a click reach the server with nothing', async () => {
    const seen: string[] = [];
    const watched = await startFixtureServer('screen-reader', {}, { onRequest: (req) => seen.push(`${req.method} ${req.url}`) });
    try {
      const [r] = await runProbes(B(), [{ url: `${watched.origin}/sends.html`, index: 0 }], [screenReaderLiveProbe], OPTS);
      expect(r!.status).toBe('ok');
      expect((r!.data as SrLiveData).menus).toBe(1);
      expect(seen.filter((x) => !x.startsWith('GET /sends.html'))).toEqual([]);
    } finally {
      await watched.close();
    }
  });
});

describe('hostile pages', () => {
  it('the probe does not pull the tree of a page larger than its element cap (not testable, quickly)', async () => {
    const big = await startFixtureServer('screen-reader', { '/big.html': { type: 'text/html', body: `<!doctype html><html lang="en"><title>Big</title><main><h1>Big</h1>${'<p>x</p>'.repeat(9_000)}</main></html>` } });
    try {
      const [r] = await runProbes(B(), [{ url: `${big.origin}/big.html`, index: 0 }], [screenReaderProbe], OPTS);
      expect(r!.status).toBe('ok');
      expect([...new Set(r!.findings.map((f) => f.status))]).toEqual(['not_testable']);
      expect(r!.findings[0]!.detail).toMatch(/too large for the screen-reader test \(9\d{3} elements\)/);
      expect(r!.ms).toBeLessThan(2_000);
    } finally {
      await big.close();
    }
  });

  it('a 50,000-node page: read within the caps and the time box, marked truncated', async () => {
    const html = `<main><h1>Big</h1>${'<p>Line <a href="#">link</a></p>'.repeat(17_000)}</main>`;
    const t0 = Date.now();
    const tree = await on((p) => treeOf(p), undefined, html);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(tree.nodes.length).toBeLessThanOrEqual(SR_TREE_LIMITS.nodes);
    expect(tree.truncated).toBe(true);
    const t = transcribe(tree, 'nvda', { readThrough: 500, list: 50, tabStops: 50 });
    expect(t.readThrough.length).toBeLessThanOrEqual(500);
    expect(t.truncated).toBe(true);
  }, 60_000);

  it('deep nesting (3,000 levels) does not overflow the stack', async () => {
    const html = `<main><h1>Deep</h1>${'<div role="group" aria-label="g">'.repeat(3_000)}<button>Deepest</button>${'</div>'.repeat(3_000)}</main>`;
    const tree = await on((p) => treeOf(p), undefined, html);
    const t = transcribe(tree);
    expect(t.lists.formControls.map((u) => u.name)).toContain('Deepest');
    expect(() => screenReaderFindings(tree)).not.toThrow();
  }, 60_000);

  it('a cyclic aria-owns is read once, without looping', async () => {
    const html = '<main><h1>Cycle</h1><div id="a" role="group" aria-label="A" aria-owns="b"><p>in a</p></div><div id="b" role="group" aria-label="B" aria-owns="a"><p>in b</p></div></main>';
    const tree = await on((p) => treeOf(p), undefined, html);
    const t = transcribe(tree);
    expect(t.readThrough.filter((u) => u.name === 'in a')).toHaveLength(1);
    expect(t.readThrough.filter((u) => u.name === 'in b')).toHaveLength(1);
  });
});
