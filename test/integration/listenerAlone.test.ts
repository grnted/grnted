// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A click listener alone never proves a control (2026-11-12; fix round 1 after review): the keyboard walk's 2.1.1
// rule in real Chromium, over test/fixtures/listener-alone/. The walk presses nothing, so:
// - Drawings (a canvas, an svg, an element with the image role, a wrapper of one drawing) are never failed and never
//   dropped: with a click listener they are listed as undecided (not testable). Real Chart.js and Apache ECharts
//   charts with default options (vendored, test only), pages that wire what Highcharts, Google Charts and d3-zoom put
//   on a default chart, a chart inside a block with a pointer cursor, a canvas with an empty handler written on it,
//   and a seat plan a click really works (with and without a pointer cursor): all undecided, none failed.
// - Any other element fails only when the page declares it a control: a widget role, or a pointer cursor of its own
//   (not an inherited one), or being written as one (a link element with no href, a button out of the tab order).
//   Planted: an svg map's regions, rows under a delegated listener, eight widget roles, a chart's legend entry and
//   credits line.
// - Without a declaration (a script's listener, a handler written on the element, an inherited cursor) the element
//   is listed as undecided, never failed; at most 3 a page, its frames included.
// Before 2026-11-12 every look-alike and candidate here failed 2.1.1 ("responds to the mouse (click handler)").
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlsProbe } from '../../src/probes/controls/index.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeFinding } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const requests: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer('listener-alone', {}, { onRequest: (req) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function findings(file: string, probes: PageProbe[] = [keyboardProbe]): Promise<ProbeFinding[]> {
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}`, index: 0 }], probes, { userAgent: 'grnted-test', full: true });
  for (const r of runs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  return runs.flatMap((r) => r.findings.map((f) => ({ ...f, probe: r.probe }) as ProbeFinding));
}
const of211 = (list: ProbeFinding[], status: string) => list.filter((f) => f.criterion === '2.1.1' && f.status === status);

const walk = (list: ProbeFinding[]) => list.filter((f) => (f as ProbeFinding & { probe: string }).probe === 'keyboard');
const DRAWING = /cannot get keyboard focus and a script listens for clicks on it \(.*\)\. It is a drawing .* this test presses nothing/;
const UNDECLARED = /cannot get keyboard focus and a script listens for clicks on it \(.*\), but the page does not declare it a control \(it is no link or button element, has no control role and no pointer cursor of its own\) and this test presses nothing/;
const UNREAD = /cannot get keyboard focus and a script listens for clicks on it \(.*\), but what it shows could not all be read \(a closed shadow root, a custom element's own content, or more than this test reads\), so whether it holds a control the keyboard reaches, or is only a drawing, could not be seen, and this test presses nothing/;
/** No 2.1.1 failure; the candidates listed, in order, each worded as `words`. */
async function listedOnly(file: string, targets: readonly string[], words: RegExp): Promise<ProbeFinding[]> {
  const list = await findings(file);
  expect(of211(list, 'failed'), JSON.stringify(of211(list, 'failed'))).toEqual([]);
  const listed = of211(list, 'not_testable');
  expect(listed.map((f) => f.target), JSON.stringify(listed)).toEqual([...targets]);
  for (const f of listed) expect(f.detail).toMatch(words);
  return listed;
}

describe('drawings: never failed, never dropped', () => {
  const CHARTS = [
    ['chartjs-img.html', 'Chart.js bar chart, role=img and aria-label', ['#enrollment']],
    ['chartjs-plain.html', 'Chart.js line chart, no role, fallback text', ['#calls']],
    ['chartjs-doughnut.html', 'Chart.js doughnut chart with its legend', ['#funds']],
    ['echarts-img.html', 'ECharts line chart in a role=img container', null],
    ['echarts-bar.html', 'ECharts bar chart in a plain container', null],
    ['highcharts-like.html', "Highcharts' default listeners on a container around an svg", null],
    ['gcharts-like.html', "Google Charts' default listeners on the svg and a wrapper, with its off-screen data table", null],
    ['d3-zoom-like.html', "d3-zoom's listeners on an svg (wheel, mousedown, dblclick)", null],
    ['chart-pointer-wrapper.html', 'S1: a Chart.js chart inside a block with a pointer cursor (the canvas inherits it)', ['#enrollment']],
    ['canvas-void-handler.html', 'S1: a canvas with onclick="void 0" written on it', ['#trend']],
    ['canvas-default-cursor.html', 'S2: a seat plan a click works, default cursor (nothing here presses a canvas)', ['#seats']],
    ['canvas-clickable.html', 'S1: the same seat plan with a pointer cursor of its own', ['#seats']],
    ['canvas-inline.html', 'S1: the same seat plan with its handler written on the canvas', ['#seats']],
    ['chart-thumb-clickable.html', 'S1: a chart in a wrapper with a pointer cursor that a click opens', ['#thumb']],
  ] as const;
  for (const [file, what, targets] of CHARTS) {
    it(`${what}: 2.1.1 not failed, and listed as undecided`, async () => {
      const list = await findings(file);
      expect(of211(list, 'failed'), JSON.stringify(of211(list, 'failed'))).toEqual([]);
      const listed = of211(list, 'not_testable');
      expect(listed.length, JSON.stringify(list)).toBeGreaterThanOrEqual(1);
      for (const f of listed) expect(f.detail).toMatch(DRAWING);
      if (targets) expect(listed.map((f) => f.target)).toEqual([...targets]);
    }, 60_000);
  }

  it('the libraries really did put their listeners there (the look-alikes are not empty)', async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => {
        const rec: { tag: string; type: string }[] = ((window as unknown as { __rec: { tag: string; type: string }[] }).__rec = []);
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
          if (this instanceof Element) rec.push({ tag: this.localName, type });
          return (add as (...a: unknown[]) => void).call(this, type, ...rest);
        } as typeof add;
      });
      const added = async (file: string) => {
        await page.goto(`${server.origin}/${file}`);
        await page.waitForTimeout(300);
        return page.evaluate(() => (window as unknown as { __rec: { tag: string; type: string }[] }).__rec.map((r) => `${r.tag}:${r.type}`));
      };
      expect(await added('chartjs-img.html')).toEqual(expect.arrayContaining(['canvas:click', 'canvas:mousemove']));
      expect(await added('echarts-img.html')).toEqual(expect.arrayContaining(['div:click', 'div:dblclick', 'div:mousemove']));
      // The canvas in the pointer-cursor block shows the pointer cursor, and it is the block's, not its own.
      await page.goto(`${server.origin}/chart-pointer-wrapper.html`);
      expect(await page.evaluate(() => [getComputedStyle(document.getElementById('enrollment')!).cursor, getComputedStyle(document.getElementById('block')!).cursor])).toEqual(['pointer', 'pointer']);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe('planted failures: the page itself declares the element a control', () => {
  // Round 4, S1 (the cut ruling): a part of a drawing (an svg region, a legend label) is never failed by this rule,
  // even with a pointer cursor of its own and a click that works: it is listed as a drawing until the scan can show
  // what a click does and that the keyboard has no way to do it. (These two failed through round 3.)
  it('round 4 S1: an svg map whose regions each listen and show a pointer cursor of their own: the regions are listed as a drawing', async () => {
    const list = await findings('svg-map-direct.html');
    expect(of211(list, 'failed')).toEqual([]);
    const listed = await listedOnly('svg-map-direct.html', ['#ward-1'], DRAWING);
    expect(listed[0]!.detail).toContain('3 more elements like it');
  }, 60_000);

  it('round 4 S1: an svg map with one listener on the svg: its regions are listed as a drawing, in the svg\'s place', async () => {
    const listed = await listedOnly('svg-map-delegated.html', ['#ward-1'], DRAWING);
    expect(listed[0]!.detail).toContain('pointer cursor, click handled by #wards');
    expect(listed[0]!.detail).toContain('3 more elements like it');
  }, 60_000);

  it('a delegated click handler on a real control (list items with a pointer cursor)', async () => {
    const failed = of211(await findings('delegated-control.html'), 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toContain('pointer cursor, click handled by #months');
  }, 60_000);

  it('a div with role=button that takes no focus', async () => {
    const failed = of211(await findings('role-button.html'), 'failed');
    expect(failed.map((f) => f.target)).toEqual(['#hours-toggle']);
  }, 60_000);

  it('S3: every widget role declares a control (radio, menuitemcheckbox, menuitemradio, treeitem, switch, combobox, gridcell; the role in any case)', async () => {
    const list = await findings('role-widgets.html');
    expect(of211(list, 'failed').map((f) => f.target).sort()).toEqual(['#alerts-on', '#area-north', '#dep-1', '#fare-adult', '#fare-youth', '#layer-lines', '#layer-stops', '#stop-box']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it('S3: a link element with no href and a button taken out of the tab order are written as controls: they fail', async () => {
    const list = await findings('native-controls.html');
    expect(of211(list, 'failed').map((f) => f.target).sort()).toEqual(['#more-link', '#next']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it("round 4 S1: a chart's legend entry and credits line (svg text with a pointer cursor of its own) are parts of the drawing: listed, with the container", async () => {
    const list = await findings('highcharts-like-legend.html', [keyboardProbe, controlsProbe]);
    expect(of211(walk(list), 'failed')).toEqual([]);
    const listed = of211(walk(list), 'not_testable');
    expect(listed.map((f) => f.target).sort(), JSON.stringify(listed)).toEqual(['#budget', '#credits', '#legend-millions > text']);
    for (const f of listed) expect(f.detail).toMatch(DRAWING);
    // The test that presses shows what the clicks do.
    const pressed = of211(list.filter((f) => (f as ProbeFinding & { probe: string }).probe === 'controls'), 'failed');
    expect(pressed.map((f) => f.target).sort()).toEqual(['#credits', '#legend-millions']);
    expect(pressed.find((f) => f.target === '#legend-millions')!.detail).toContain('answers a mouse click');
  }, 90_000);
});

describe('candidates: nothing the page says declares a control', () => {
  it('a line of text with a click listener and the default cursor is listed, not failed; the controls test shows its effect', async () => {
    const list = await findings('listener-only-text.html', [keyboardProbe, controlsProbe]);
    expect(of211(walk(list), 'failed')).toEqual([]);
    expect(of211(walk(list), 'not_testable')).toEqual([{ criterion: '2.1.1', status: 'not_testable', target: '#hours-line', probe: 'keyboard', detail: expect.stringMatching(UNDECLARED) }]);
    // What the click does is the controls test's to show: it presses the element and fails it with the effect.
    const pressed = of211(list.filter((f) => (f as ProbeFinding & { probe: string }).probe === 'controls'), 'failed');
    expect(pressed.map((f) => f.target)).toEqual(['#hours-line']);
    expect(pressed[0]!.detail).toContain('answers a mouse click');
  }, 90_000);

  it('a click counter on a block of text is listed, not failed, by either test', async () => {
    const list = await findings('analytics-wrapper.html', [keyboardProbe, controlsProbe]);
    expect(of211(list, 'failed'), JSON.stringify(of211(list, 'failed'))).toEqual([]);
    expect(of211(walk(list), 'not_testable').map((f) => f.target)).toEqual(['#notice']);
  }, 90_000);

  it('S1: an inherited pointer cursor and a handler written on the element declare nothing', async () => {
    const list = await findings('inherited-pointer-text.html');
    expect(of211(list, 'failed'), JSON.stringify(of211(list, 'failed'))).toEqual([]);
    const listed = of211(list, 'not_testable');
    expect(listed.map((f) => f.target).sort()).toEqual(['#line', '#promo']);
    for (const f of listed) expect(f.detail).toMatch(UNDECLARED);
  }, 60_000);

  it('S3: a double-click handler written on the element is a reason to look, never proof', async () => {
    const list = await findings('dblclick-inline.html');
    expect(of211(list, 'failed')).toEqual([]);
    expect(of211(list, 'not_testable')).toEqual([{ criterion: '2.1.1', status: 'not_testable', target: '#fact', probe: 'keyboard', detail: expect.stringMatching(/\(dblclick handler\), but the page does not declare it a control/) }]);
  }, 60_000);

  it('S4: candidates are capped over the page and its frames together (3), and a failure inside the frame is kept', async () => {
    const list = await findings('frame-candidates.html');
    const failed = of211(list, 'failed');
    expect(failed.map((f) => f.target)).toEqual(['#board >>> #in-toggle']);
    const listed = of211(list, 'not_testable');
    // Two in the page, four more kinds in the frame: three are listed in all.
    expect(listed.map((f) => f.target)).toEqual(['#note-a', '#note-b', '#board >>> #in-a']);
    for (const f of listed) expect(f.detail).toMatch(UNDECLARED);
  }, 60_000);
});

// Fix round 2 after review (out/reviews/chartfix-r2-sol-r1.md, S1-S7; 2026-11-12). Every case here but the guards
// marked "(guard)" gave a different answer on ab252945 (the commit before): a false failure, a dropped drawing, a
// missed declared control or more candidates than the cap.
describe('fix round 2: shadow roots and slots, read as the page shows them (S1, S2)', () => {
  it('S1: a chart element whose canvas is in its open shadow root (its host has a pointer cursor and a click listener) is a drawing: listed', async () => {
    await listedOnly('shadow-chart-host.html', ['#budget'], DRAWING);
  }, 60_000);

  it('S1: the canvas two shadow roots down (a dashboard element around a chart element) is read too', async () => {
    await listedOnly('shadow-nested-chart.html', ['#dash'], DRAWING);
  }, 60_000);

  it("S1: a frame element whose slot shows the page's canvas (the listener on the frame's own box) is a drawing", async () => {
    await listedOnly('shadow-slot-canvas.html', ['#frame >>> #box'], DRAWING);
  }, 60_000);

  it('S1: fallback text a shadow root does not show is no shown text: the chart element is still a drawing', async () => {
    await listedOnly('shadow-host-fallback-text.html', ['#budget'], DRAWING);
  }, 60_000);

  it('S2: a line at the top of a shadow root inherits its pointer cursor from the host: it declares nothing, listed', async () => {
    await listedOnly('shadow-inherited-pointer.html', ['#card >>> #line'], UNDECLARED);
  }, 60_000);

  it('S2: a line the page put in a slot inherits its pointer cursor from the slot: it declares nothing, listed', async () => {
    await listedOnly('shadow-slotted-pointer.html', ['#line'], UNDECLARED);
  }, 60_000);

  it("S2: a label the page put in a slot of a button element is inside that button (the composed tree): nothing to say", async () => {
    const list = await findings('shadow-slotted-in-button.html');
    expect(list.filter((f) => f.criterion === '2.1.1'), JSON.stringify(list.filter((f) => f.criterion === '2.1.1'))).toEqual([]);
  }, 60_000);

  it("S2: a card element's clickable box shows the page's own link through its slot: that link is its keyboard way, nothing to say", async () => {
    const list = await findings('shadow-card-slotted-link.html');
    expect(list.filter((f) => f.criterion === '2.1.1'), JSON.stringify(list.filter((f) => f.criterion === '2.1.1'))).toEqual([]);
  }, 60_000);

  it('a custom element inside an inert block is out of play, as the page is shown: nothing to say', async () => {
    const list = await findings('shadow-inert-host.html');
    expect(list.filter((f) => f.criterion === '2.1.1'), JSON.stringify(list.filter((f) => f.criterion === '2.1.1'))).toEqual([]);
  }, 60_000);

  it('a host whose shadow root is closed cannot be read: listed as undecided, never failed', async () => {
    await listedOnly('closed-host.html', ['#hours-button'], UNREAD);
  }, 60_000);

  it('(guard) a toggle in a shadow root with a pointer cursor of its own still fails, named through its host', async () => {
    const list = await findings('shadow-own-pointer.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#card >>> #toggle']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it('(guard) a custom element that shows text and has a pointer cursor of its own still fails', async () => {
    const list = await findings('shadow-control-host.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#hours-toggle']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);
});

describe('fix round 2: drawings are never dropped (S3)', () => {
  it('a seat plan on a canvas that fills the screen is listed (it is no page wrapper)', async () => {
    await listedOnly('canvas-full-viewport.html', ['#seats'], DRAWING);
  }, 60_000);

  it('a seat plan on a canvas with only a pointerdown listener and the default cursor is listed', async () => {
    const listed = await listedOnly('canvas-press-only.html', ['#seats'], DRAWING);
    expect(listed[0]!.detail).toContain('(pointerdown handler)');
  }, 60_000);
});

describe('fix round 2: one widget-role predicate (S4)', () => {
  it("a carousel's slides with the radio role and a working listener are declared controls: they fail", async () => {
    const list = await findings('carousel-role-radio.html');
    const failed = of211(list, 'failed');
    expect(failed.map((f) => f.target)).toEqual(['#pass-day']);
    expect(failed[0]!.detail).toContain('1 more element like it');
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it("(guard) a carousel's own slides (group role) with drag listeners say nothing", async () => {
    const list = await findings('carousel-slides-plain.html');
    expect(list.filter((f) => f.criterion === '2.1.1'), JSON.stringify(list.filter((f) => f.criterion === '2.1.1'))).toEqual([]);
  }, 60_000);

  it('members with the button role (in any case) under a delegated listener fail; the list itself is not listed', async () => {
    const list = await findings('delegated-role-members.html');
    const failed = of211(list, 'failed');
    expect(failed.map((f) => f.target)).toEqual(['#months > li:nth-of-type(1)', '#months > li:nth-of-type(2)']);
    expect(failed[0]!.detail).toContain('button role, click handled by #months');
    expect(failed[0]!.detail).toContain('1 more element like it');
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it('(guard) members with no widget role under a counting listener: the list is listed, never failed', async () => {
    await listedOnly('delegated-plain-members.html', ['#months'], UNDECLARED);
  }, 60_000);

  it('a roving toolbar declared with its role in capitals is a toolbar: its part that the arrow keys reach is not failed', async () => {
    const list = await findings('composite-role-case.html');
    expect(of211(list, 'failed'), JSON.stringify(of211(list, 'failed'))).toEqual([]);
  }, 60_000);
});

describe('fix round 2: an undecided part never stands in for its declared control (S5)', () => {
  it('a div with role=button around an icon with a pointer cursor of its own and a label fails; the icon is not listed', async () => {
    const list = await findings('icon-label-control.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#map-toggle']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it('(guard) the same icon in a block that only counts clicks (nothing declared): the icon is listed in its place', async () => {
    const listed = await listedOnly('icon-label-plain.html', ['#map-icon'], DRAWING);
    expect(listed[0]!.detail).toContain('pointer cursor, click handled by #where');
  }, 60_000);
});

describe('fix round 2: the candidate cap holds on every branch (S6)', () => {
  it('a frame a control outside points at: its candidates count toward the cap of 3 too', async () => {
    const list = await findings('frame-cap-pointed.html');
    expect(of211(list, 'failed')).toEqual([]);
    const listed = of211(list, 'not_testable');
    expect(listed.map((f) => f.target), JSON.stringify(listed)).toEqual(['#note-a', '#note-b', '#board >>> #in-a']);
    expect(listed[2]!.detail).toContain('a control outside the frame points at it');
  }, 60_000);

  it('two frames, one whose candidates are named like controls outside it: 3 candidates in all, the second frame none', async () => {
    const list = await findings('frame-cap-named.html');
    expect(of211(list, 'failed')).toEqual([]);
    const listed = of211(list, 'not_testable');
    expect(listed.map((f) => f.target), JSON.stringify(listed)).toEqual(['#note-a', '#named >>> #nm-a', '#named >>> #nm-b']);
    for (const f of listed.slice(1)) expect(f.detail).toContain('a control outside the frame has the same name');
  }, 60_000);
});

describe('fix round 2: handlers written on elements in shadow roots (S7)', () => {
  it('a canvas in a shadow root with only onclick written on it is listed as a drawing', async () => {
    const listed = await listedOnly('shadow-inline-canvas.html', ['#plan >>> #seats'], DRAWING);
    expect(listed[0]!.detail).toContain('(click handler)');
  }, 60_000);

  it('a link element with no href and only onclick written on it, in a shadow root, fails', async () => {
    const list = await findings('shadow-inline-control.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#box >>> #more']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);
});

// Chart fix round 4 (the cut round; out/reviews/chartfix-r3-sol-r1.md, rulings out/hotfix/CHART-R4-RULINGS.md). Every
// case here but the guards marked "(guard)" and the boundary's own side gave a different answer on 7b2abfe1.
const unread = (file: string, targets: readonly string[]) => listedOnly(file, targets, UNREAD);
describe('round 4, S1: parts of a drawing are listed, never failed', () => {
  it('svg regions with a pointer cursor whose only listener counts clicks: listed as a drawing', async () => {
    const listed = await listedOnly('svg-regions-noop.html', ['#ward-1'], DRAWING);
    expect(listed[0]!.detail).toContain('pointer cursor, click handled by #wards');
  }, 60_000);

  it('a chart\'s points with a pointer cursor and a listener each, beside the keyboard proxy buttons a chart library adds: listed', async () => {
    await listedOnly('chart-points-proxies.html', ['#pt-0'], DRAWING);
  }, 60_000);
});

describe('round 4, S2: a read that reaches its bound is incomplete, and undecided', () => {
  const bound = (k: string, n: number) => `bounds.html?k=${k}&n=${n}`;
  it('400 texts outside the drawing are read (a drawing); 401 reach the bound (unread)', async () => {
    await listedOnly(bound('text', 400), ['#subject'], DRAWING);
    await unread(bound('text', 401), ['#subject']);
  }, 90_000);

  it('the drawing\'s own texts are not counted: 401 labels inside an svg leave the wrapper a drawing', async () => {
    await listedOnly(bound('svgtext', 401), ['#subject'], DRAWING);
  }, 60_000);

  it('40 drawings are looked at: the one that fills the wrapper as the 40th makes a drawing, as the 41st it is unread', async () => {
    await listedOnly(bound('drawings', 39), ['#subject'], DRAWING);
    await unread(bound('drawings', 40), ['#subject']);
  }, 90_000);

  it('300 focusable elements are looked at: a real button as the 300th is found (nothing to say), as the 301st the control is unread', async () => {
    const found = await findings(bound('focusable', 299));
    expect(found.filter((f) => f.criterion === '2.1.1' && f.target === '#subject'), JSON.stringify(found)).toEqual([]);
    await unread(bound('focusable', 300), ['#subject']);
  }, 90_000);

  it('(guard) 3000 elements are read (the declared control fails); 3001 are not (unread)', async () => {
    expect(of211(await findings(bound('elements', 3000)), 'failed').map((f) => f.target)).toEqual(['#subject']);
    await unread(bound('elements', 3001), ['#subject']);
  }, 90_000);

  it('(guard) 49 shadow roots in a control are read (it fails); 50 reach the bound of 50 scopes (unread)', async () => {
    expect(of211(await findings(bound('scopes', 49)), 'failed').map((f) => f.target)).toEqual(['#subject']);
    await unread(bound('scopes', 50), ['#subject']);
  }, 90_000);

  it('50 slots are read (the canvas in the 50th makes a drawing); a 51st slot is not (unread)', async () => {
    await listedOnly(bound('slots', 50), ['#frame >>> #box'], DRAWING);
    await unread(bound('slots', 51), ['#frame >>> #box']);
  }, 90_000);
});

describe('round 4, S3: a custom element with no open shadow root is unread', () => {
  it('a chart element whose closed shadow root is written in its markup (declarative): listed as unread, never failed', async () => {
    await unread('declarative-closed-chart.html', ['#budget']);
  }, 60_000);

  it('a button element whose closed shadow root (in its markup) holds a native button: listed as unread, never failed', async () => {
    await unread('declarative-closed-button.html', ['#hours-button']);
  }, 60_000);
});

describe('round 4, S5: the cap counts every undecided note, after the final disposition', () => {
  it('declared controls in a frame a control outside points at: their notes count toward the cap of 3', async () => {
    const list = await findings('frame-cap-pointed-roles.html');
    expect(of211(list, 'failed')).toEqual([]);
    const listed = of211(list, 'not_testable');
    expect(listed.map((f) => f.target), JSON.stringify(listed)).toEqual(['#note-a', '#note-b', '#board >>> #in-a']);
    expect(listed[2]!.detail).toContain('a control outside the frame points at it');
  }, 60_000);

  it('declared controls named like controls outside their frame count too; the other frame\'s declared controls still fail, uncapped', async () => {
    const list = await findings('frame-cap-named-roles.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#plain >>> #pl-a', '#plain >>> #pl-b']);
    const listed = of211(list, 'not_testable');
    expect(listed.map((f) => f.target), JSON.stringify(listed)).toEqual(['#note-a', '#named >>> #nm-a', '#named >>> #nm-b']);
  }, 60_000);
});

describe('round 4, S6: bare text in a shadow root or a slot is shown text', () => {
  it('a button element whose shadow root shows a large icon and a bare label: no drawing, the declared control fails', async () => {
    const list = await findings('shadow-text-control.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#map-toggle']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);

  it('a button role in a shadow root showing a large icon and the bare label the page put in its slot: the declared control fails', async () => {
    const list = await findings('slotted-text-control.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#map-button >>> #inner']);
    expect(of211(list, 'not_testable')).toEqual([]);
  }, 60_000);
});

// Round 4 check (out/reviews/chartfix-r4-sol-r1.md; the lead's cuts, Job B's first item). Each gave a scored 2.1.1
// failure on 6537462f; each is now undecided (listed as unread).
describe('round 4 check: what cannot be read or is not known to show is undecided', () => {
  it('S1: a card with a pointer cursor and a listener around a button element whose closed root (in its markup) holds a native button: unread', async () => {
    await unread('card-nested-closed-button.html', ['#card']);
  }, 60_000);

  it('S2: an overlay with a pointer cursor inside a wrapper whose drawing read stopped at 40 small icons before its canvas: unread', async () => {
    await unread('drawing-bound-overlay.html', ['#overlay']);
  }, 60_000);

  it('S3: a chart wrapper whose only label is bare text in a hidden element\'s shadow root: unread, never failed', async () => {
    await unread('hidden-shadow-label.html', ['#chart']);
  }, 60_000);

  it('S3: a chart box whose only label is slotted text the box keeps hidden: unread, never failed', async () => {
    await unread('hidden-slot-label.html', ['#box >>> #frame']);
  }, 60_000);

  // S2 holds only where the drawing read leaves the answer open: an ancestor that shows text of its own outside its
  // drawings is no wrapper of one drawing, however many icons stop the read or however large it is (the lead's
  // 14:30 watch on 2.1.1 recall).
  it('(guard) S2: a click-only toggle on a page with 45 inline icons in its list of services still fails', async () => {
    const list = await findings('icon-heavy-toggle.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#hours-toggle']);
  }, 60_000);

  it('(guard) S2: a click-only toggle on a page of more than 3000 elements with a logo still fails', async () => {
    const list = await findings('big-page-toggle.html');
    expect(of211(list, 'failed').map((f) => f.target)).toEqual(['#hours-toggle']);
  }, 60_000);
});

describe('safety', () => {
  it('nothing but GET requests reached the server', () => {
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});
