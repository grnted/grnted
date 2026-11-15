// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A click listener alone never proves a control (2026-11-12, fix round 1 after review; the keyboard walk's 2.1.1 rule,
// probe `keyboard`). The walk presses nothing. The answer by construction (what a careful auditor says of the page):
// - fail, declared: the page declares the element a control and it takes no focus: a widget role (button, radio,
//   menuitemcheckbox, treeitem, switch), or a pointer cursor of its own (a div; the regions of an svg map, each with
//   its listener or under one listener on the svg; list items under a delegated listener; a chart legend's label).
//   The walk must fail these;
// - fail, a drawing that a click works: a canvas seat plan (with a pointer cursor, with its handler written on it,
//   with neither), a chart's wrapper that opens it larger, an element with the image role that a click opens. No
//   cursor, role or handler alone fails a drawing (a charting library puts the same on a chart that does nothing),
//   and the walk presses nothing: it must list these as not testable (undecided by design), never drop them;
// - pass, drawings: charts with the listeners their library adds by default, whatever a click does: real Chart.js
//   and Apache ECharts (vendored, test only), pages wired as Highcharts, Google Charts and d3-zoom wire a default
//   chart, a hand-drawn canvas and an svg in a wrapper with the same listeners, a Chart.js chart inside a block
//   with a pointer cursor, a canvas with an empty handler written on it. Never failed; listed as not testable;
// - pass, listed: a click counter on a block of text, a panel that only stops clicks, a counted line that inherits a
//   pointer cursor, a block with an empty handler written on it: nothing a person does there. Never failed;
// - fail, missed by design: a line of text that a click opens, with the default cursor and no role (its listener
//   added by a script, or written on the element). Nothing declares a control, so the walk lists it (not testable):
//   the cost of never failing on a listener alone. The controls test, which presses, fails it with the effect shown.
import { readFileSync } from 'node:fs';
import { keyboardProbe } from '../../../src/probes/keyboard/index.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'late-mount', 'cookie-banner', 'font-swap', 'smooth-scroll'];

const DECLARED = ['svg-direct', 'svg-delegated', 'list-delegated', 'role-button', 'div-pointer', 'legend-part', 'role-radio', 'role-menuitemcheckbox', 'role-treeitem', 'role-switch'] as const;
const DRAWN = ['canvas-pointer', 'canvas-inline', 'canvas-default', 'wrapper-pointer', 'img-role-pointer'] as const;
const SURFACES = ['chartjs-bar', 'chartjs-line', 'chartjs-doughnut', 'echarts-line', 'echarts-bar', 'highcharts-like', 'gcharts-like', 'd3-zoom-like', 'canvas-plain', 'svg-wrapper', 'chartjs-pointer-block', 'canvas-void-handler'] as const;
const LISTED = ['analytics-wrapper', 'stop-propagation', 'inherited-pointer', 'void-handler'] as const;
const MISSED = ['text-listener-only', 'text-inline-handler'] as const;
// Fix round 2 (2026-11-12; out/reviews/chartfix-r2-sol-r1.md): one group per new decision path, each at least 10 kinds
// over the six hazards (60 or more pages a path). `fail` = the auditor's failure (the walk must fail the declared ones;
// the drawings and unread ones a click works are undecided by design, so they count as missed), `pass` = never failed.
/** S1/S2 and closed roots: shadow roots and slots read as the page shows them. */
const SHADOW_FAIL = ['shadow-own-pointer', 'shadow-role-button', 'shadow-host-control', 'closed-host-text'] as const;
const SHADOW_PASS = ['shadow-chart-host', 'shadow-nested-chart', 'shadow-slot-canvas', 'shadow-fallback-text', 'shadow-inherited-pointer', 'shadow-slotted-pointer', 'shadow-card-slotted-link', 'shadow-slotted-in-button', 'closed-host-button'] as const;
/** S3: drawings never dropped (the whole screen, a press listener alone); press-only declared controls still fail. */
const DROP_FAIL = ['canvas-full-viewport', 'canvas-press-only', 'svg-press-only-map', 'div-press-pointer', 'span-press-role-pointer'] as const;
const DROP_PASS = ['canvas-full-viewport-plain', 'canvas-press-plain', 'svg-press-plain', 'svg-full-viewport-plain', 'wrapper-full-viewport-plain'] as const;
/** S4: one widget-role predicate (carousel parts, delegated members, composites in any case). */
const ROLE_FAIL = ['carousel-role-radio', 'carousel-role-button', 'carousel-role-tab-case', 'delegated-role-button', 'delegated-role-case', 'delegated-role-option', 'delegated-role-menuitem'] as const;
const ROLE_PASS = ['carousel-slides-plain', 'carousel-roledescription-plain', 'delegated-plain-members', 'composite-roving-case'] as const;
/** S5: an undecided part (an icon drawing) never stands in for the declared control around it. */
const ICON_FAIL = ['icon-role-button-svg', 'icon-role-button-canvas', 'icon-link-nohref-svg', 'icon-role-tab-svg', 'icon-role-menuitem-svg', 'icon-role-link-svg', 'icon-role-switch-svg'] as const;
const ICON_PASS = ['icon-plain-counter', 'icon-in-button', 'icon-role-button-focusable'] as const;
/** S7: handlers written on elements in shadow roots. */
const INLINE_FAIL = ['shadow-inline-nohref', 'shadow-inline-role-button', 'shadow-inline-own-pointer', 'shadow-inline-nested', 'shadow-inline-button-out', 'shadow-inline-canvas', 'shadow-inline-text'] as const;
const INLINE_PASS = ['shadow-inline-void-canvas', 'shadow-inline-void-text', 'shadow-inline-button'] as const;
const ROUND2_FAIL = [...SHADOW_FAIL, ...DROP_FAIL, ...ROLE_FAIL, ...ICON_FAIL, ...INLINE_FAIL] as const;
const ROUND2_PASS = [...SHADOW_PASS, ...DROP_PASS, ...ROLE_PASS, ...ICON_PASS, ...INLINE_PASS] as const;
/** The decision path each round-2 kind measures (`params.path`). */
export const ROUND2_PATHS: Readonly<Record<string, readonly string[]>> = {
  'S1/S2 shadow and slots': [...SHADOW_FAIL, ...SHADOW_PASS], 'S3 drawings kept': [...DROP_FAIL, ...DROP_PASS], 'S4 role predicate': [...ROLE_FAIL, ...ROLE_PASS],
  'S5 declared parent': [...ICON_FAIL, ...ICON_PASS], 'S7 shadow inline handlers': [...INLINE_FAIL, ...INLINE_PASS],
};
// Round 4 (the cut round; out/hotfix/CHART-R4-RULINGS.md): its four new decision paths, 10 or more kinds each.
/** S1: a part of a drawing (an svg element, or inside a drawing root) is listed, never failed (a working map region: listed by design). */
const PART_FAIL = ['svg-regions-working', 'svg-markers-working', 'html-label-in-chart', 'button-role-beside-chart'] as const;
const PART_PASS = ['svg-regions-noop-delegated', 'svg-regions-noop-direct', 'd3-groups-noop', 'chart-points-proxies', 'legend-noop', 'map-markers-noop'] as const;
/** S2: a read that reaches its bound is undecided (both sides of each bound). */
const BOUND_FAIL = ['elements-under', 'scopes-under'] as const;
const BOUND_PASS = ['text-under', 'text-over', 'svgtext-over', 'drawings-under', 'drawings-over', 'slots-under', 'slots-over', 'focusable-under', 'focusable-over'] as const;
/** S3: a custom element with no open shadow root is unread. */
const CUSTOM_FAIL = ['custom-no-shadow-toggle', 'declarative-closed-text-toggle', 'custom-open-text-toggle', 'div-in-custom-wrapper', 'custom-open-role-button'] as const;
const CUSTOM_PASS = ['declarative-closed-chart', 'declarative-closed-button', 'custom-no-shadow-counter', 'custom-open-chart', 'script-closed-button'] as const;
/** S6: bare text in a shadow root or a slot is shown text. */
const TEXT_FAIL = ['shadow-svg-bare-label', 'slotted-bare-label', 'shadow-svg-span-label', 'shadow-text-only-control', 'slotted-element-label'] as const;
const TEXT_PASS = ['shadow-svg-hidden-label', 'shadow-svg-no-label', 'slotted-unassigned-text', 'shadow-svg-label-in-svg', 'shadow-svg-text-below'] as const;
/** The round-4 check's cuts (out/reviews/chartfix-r4-sol-r1.md): unread descendants, drawing-unknown ancestors, hidden bare text. */
const CHECK_FAIL = ['card-nested-custom-toggle', 'overlay-working-after-icons', 'visible-shadow-label-control', 'visible-slot-label-control', 'icon-heavy-toggle', 'big-page-toggle'] as const;
const CHECK_PASS = ['card-nested-closed-button', 'card-nested-closed-chart', 'overlay-noop-after-icons', 'overlay-noop-under-bound', 'hidden-shadow-label', 'hidden-slot-label'] as const;
const ROUND4_FAIL = [...PART_FAIL, ...BOUND_FAIL, ...CUSTOM_FAIL, ...TEXT_FAIL, ...CHECK_FAIL] as const;
const ROUND4_PASS = [...PART_PASS, ...BOUND_PASS, ...CUSTOM_PASS, ...TEXT_PASS, ...CHECK_PASS] as const;
export const ROUND4_PATHS: Readonly<Record<string, readonly string[]>> = {
  'R4 S1 drawing parts': [...PART_FAIL, ...PART_PASS], 'R4 S2 bounds': [...BOUND_FAIL, ...BOUND_PASS],
  'R4 S3 custom elements': [...CUSTOM_FAIL, ...CUSTOM_PASS], 'R4 S6 shadow text': [...TEXT_FAIL, ...TEXT_PASS],
  'R4 check cuts': [...CHECK_FAIL, ...CHECK_PASS],
};
type Round4Kind = (typeof ROUND4_FAIL)[number] | (typeof ROUND4_PASS)[number];
type Kind = (typeof DECLARED)[number] | (typeof DRAWN)[number] | (typeof SURFACES)[number] | (typeof LISTED)[number] | (typeof MISSED)[number] | (typeof ROUND2_FAIL)[number] | (typeof ROUND2_PASS)[number] | Round4Kind;

/**
 * A custom element `tag` whose shadow root (open, or closed) holds `html`; `then` runs after with `host` and `root`.
 * Self-contained page script (round 2 cases).
 */
const defineEl = (tag: string, html: string, then = '', mode: 'open' | 'closed' = 'open') =>
  `customElements.define('${tag}', class extends HTMLElement { connectedCallback() { if (this.simDone) return; this.simDone = true; var host = this, root = this.attachShadow({ mode: '${mode}' }); root.innerHTML = ${JSON.stringify(html)}; ${then} } });`;
/** Toggles the element after `el` (in its own tree): what the round-2 controls open. */
const TOGGLE = "window.simToggle = function (el) { var h = el.getRootNode().getElementById('hours') || document.getElementById('hours'); if (h) h.hidden = !h.hidden; };";
const HOURS = '<p id="hours" hidden>8 am to 4 pm on weekdays.</p>';
const ICON = (style = 'cursor:pointer') => `<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" style="${style}" focusable="false"><path d="M10 1a6 6 0 0 0-6 6c0 5 6 12 6 12s6-7 6-12a6 6 0 0 0-6-6z" fill="#0b4fb3"/></svg>`;
const BARS = "var g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 600, 240); [41, 18, 9].forEach(function (v, i) { g.fillStyle = '#2c6fbb'; g.fillRect(60 + i * 180, 220 - v * 5, 120, v * 5); });";
const COUNT = "window.dataLayer = window.dataLayer || [];";

const vendor = new Map<string, string>();
/** A vendored library's source (test/fixtures/listener-alone/vendor: unmodified, test only). */
function lib(path: string): string {
  let s = vendor.get(path);
  if (s === undefined) vendor.set(path, (s = readFileSync(new URL(`../../fixtures/listener-alone/vendor/${path}`, import.meta.url), 'utf8')));
  return s;
}

const TABLE = '<table class="data"><caption>The same numbers</caption><thead><tr><th scope="col">Item</th><th scope="col">Count</th></tr></thead><tbody><tr><td>First</td><td>41</td></tr><tr><td>Second</td><td>18</td></tr><tr><td>Third</td><td>9</td></tr></tbody></table>';
const CSS = ['.data { border-collapse: collapse; margin: 12px 0; } .data th, .data td { border: 1px solid #595959; padding: 4px 10px; text-align: left; } .chart { width: 600px; max-width: 100%; } a { color: #0b4fb3; }'];
const COLUMNS = '<rect width="600" height="300" fill="#ffffff"/><g class="series"><rect x="80" y="20" width="110" height="240" fill="#2c6fbb"/><rect x="240" y="150" width="110" height="110" fill="#2c6fbb"/><rect x="400" y="205" width="110" height="55" fill="#2c6fbb"/></g><g><text x="135" y="282" text-anchor="middle" font-size="12" fill="#333333">First</text><text x="295" y="282" text-anchor="middle" font-size="12" fill="#333333">Second</text><text x="455" y="282" text-anchor="middle" font-size="12" fill="#333333">Third</text></g>';
const WARDS = [1, 2, 3, 4].map((n) => `<path id="ward-${n}" class="ward" d="M${20 + (n - 1) * 145},20 h135 v180 h-135 z" fill="${['#9ecae1', '#6baed6', '#4292c6', '#2171b5'][n - 1]}"><title>Ward ${n}</title></path>`).join('');
const DRAW_SEATS = "var c = document.getElementById('seats'), g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 600, 180); for (var i = 0; i < 7; i++) { g.fillStyle = '#0b4fb3'; g.fillRect(20 + i * 80, 50, 64, 80); g.fillStyle = '#ffffff'; g.font = '16px sans-serif'; g.fillText('A' + (i + 1), 40 + i * 80, 96); }";
const PICK = "var n = Math.floor((e.offsetX - 20) / 80) + 1; if (n >= 1 && n <= 7) document.getElementById('out').textContent = 'Seat A' + n + ' is free for the 7 pm show.';";
const CHARTJS = (type: string, data: string) => `new Chart(document.getElementById('chart'), { type: '${type}', data: ${data} });`;

interface Built { body: string; init: string[]; css?: string[]; head?: string[]; files?: Record<string, string>; why: string }

function build(kind: Kind): Built {
  const out = '<p id="out">Nothing chosen yet.</p>';
  switch (kind) {
    // ---- The page itself marks it as a control -----------------------------------------------
    case 'canvas-pointer':
      return { body: `<p>Choose a seat on the plan.</p><canvas id="seats" width="600" height="180" style="cursor:pointer" aria-label="Seat plan, row A"></canvas>${out}`, init: [`${DRAW_SEATS} c.addEventListener('click', function (e) { ${PICK} });`], why: 'a canvas with a pointer cursor that a click acts on' };
    case 'canvas-inline':
      return { body: `<p>Choose a seat on the plan.</p><canvas id="seats" width="600" height="180" aria-label="Seat plan, row A" onclick="simPick(event)"></canvas>${out}`, init: [`window.simPick = function (e) { ${PICK} }; ${DRAW_SEATS}`], why: 'a canvas with a click handler written on the element' };
    case 'svg-direct':
      return { body: `<p>Choose your ward on the map.</p><svg id="wards" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the four wards">${WARDS}</svg>${out}`, css: ['.ward { cursor: pointer; }'], init: ["[].forEach.call(document.querySelectorAll('.ward'), function (w) { w.addEventListener('click', function () { document.getElementById('out').textContent = 'Ward ' + w.id.slice(5) + ': room 30' + w.id.slice(5) + '.'; }); });"], why: 'the regions of an svg map each listen for a click and show a pointer cursor' };
    case 'svg-delegated':
      return { body: `<p>Choose your ward on the map.</p><svg id="wards" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the four wards">${WARDS}</svg>${out}`, css: ['.ward { cursor: pointer; }'], init: ["document.getElementById('wards').addEventListener('click', function (e) { var w = e.target.closest('.ward'); if (w) document.getElementById('out').textContent = 'Ward ' + w.id.slice(5) + ': room 30' + w.id.slice(5) + '.'; });"], why: 'an svg map with one click listener on the svg whose regions show a pointer cursor' };
    case 'list-delegated':
      return { body: `<p>Choose a month.</p><ul id="months"><li class="month">March</li><li class="month">April</li><li class="month">May</li></ul>${out}`, css: ['#months { list-style: none; padding: 0; display: flex; gap: 8px; } .month { cursor: pointer; padding: 6px 12px; border: 1px solid #595959; }'], init: ["document.getElementById('months').addEventListener('click', function (e) { var m = e.target.closest('.month'); if (m) document.getElementById('out').textContent = m.textContent + ': the board meets on the second Tuesday.'; });"], why: 'list items with a pointer cursor under a delegated click listener' };
    case 'role-button':
      return { body: `<div id="toggle" role="button">Show office hours</div><p id="hours" hidden>8 am to 4 pm on weekdays.</p>`, init: ["document.getElementById('toggle').addEventListener('click', function () { var h = document.getElementById('hours'); h.hidden = !h.hidden; });"], why: 'a div with role=button and a click listener that takes no focus' };
    case 'wrapper-pointer':
      return { body: `<p>Choose the chart to see it larger.</p><div id="thumb" class="chart" style="width:300px;cursor:pointer"><svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 600 300" role="img" aria-label="Column chart: three items">${COLUMNS}</svg></div><div id="large" hidden>${TABLE}</div>`, init: ["document.getElementById('thumb').addEventListener('click', function () { document.getElementById('large').hidden = false; });"], why: 'a chart wrapper with a pointer cursor that a click opens' };
    case 'div-pointer':
      return { body: `<div id="toggle" style="cursor:pointer;color:#0b4fb3;text-decoration:underline">Show office hours</div><p id="hours" hidden>8 am to 4 pm on weekdays.</p>`, init: ["document.getElementById('toggle').addEventListener('click', function () { var h = document.getElementById('hours'); h.hidden = !h.hidden; });"], why: 'a div with a pointer cursor and a click listener' };
    case 'img-role-pointer':
      return { body: `<div id="plan" role="img" aria-label="Floor plan of the library" style="cursor:pointer;width:300px;height:160px;background:#dfe9f5;border:1px solid #595959"></div><p id="hours" hidden>The reading room is on the second floor.</p>`, init: ["document.getElementById('plan').addEventListener('click', function () { document.getElementById('hours').hidden = false; });"], why: 'an element with the image role, a pointer cursor and a click listener' };
    case 'legend-part':
      return { body: `<div id="box" class="chart" style="height:320px;position:relative"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="320" viewBox="0 0 600 320" role="img" aria-label="Column chart: three items">${COLUMNS}<g id="legend"><rect x="270" y="296" width="12" height="12" fill="#2c6fbb"/><text x="288" y="307" font-size="12" fill="#333333" style="cursor:pointer">Count</text></g></svg></div>${TABLE}`, init: ["var noop = function () {}, box = document.getElementById('box'); box.onclick = noop; box.onmousedown = noop; box.onmousemove = noop; document.getElementById('legend').addEventListener('click', function () { var s = box.querySelector('.series'); s.style.display = s.style.display === 'none' ? '' : 'none'; });"], why: "a chart legend entry with its own click listener whose label shows a pointer cursor (the chart's container does not fail)" };
    case 'canvas-default':
      return { body: `<p>Choose a seat on the plan.</p><canvas id="seats" width="600" height="180" aria-label="Seat plan, row A"></canvas>${out}`, init: [`${DRAW_SEATS} c.addEventListener('click', function (e) { ${PICK} });`], why: 'a canvas with the default cursor that a click acts on (nothing declares it; the walk presses nothing)' };
    case 'role-radio':
      return { body: `<div role="radiogroup" aria-label="Fare type"><div id="adult" role="radio" aria-checked="true">Adult</div><div id="youth" role="Radio" aria-checked="false">Youth</div></div>${out}`, init: ["['adult', 'youth'].forEach(function (id) { document.getElementById(id).addEventListener('click', function () { document.getElementById('out').textContent = 'Fare: ' + this.textContent + '.'; }); });"], why: 'radio roles that take no focus, each with a click listener' };
    case 'role-menuitemcheckbox':
      return { body: `<div role="menu" aria-label="Map layers"><div id="stops" role="menuitemcheckbox" aria-checked="true">Stops</div><div id="lines" role="menuitemradio" aria-checked="false">Lines only</div></div>${out}`, init: ["['stops', 'lines'].forEach(function (id) { document.getElementById(id).addEventListener('click', function () { document.getElementById('out').textContent = 'Layer: ' + this.textContent + '.'; }); });"], why: 'menuitemcheckbox and menuitemradio roles that take no focus, each with a click listener' };
    case 'role-treeitem':
      return { body: `<div role="tree" aria-label="Routes by area"><div id="north" role="treeitem" aria-expanded="false">North area</div></div><p id="hours" hidden>Routes 12, 14 and 24.</p>`, init: ["document.getElementById('north').addEventListener('click', function () { var h = document.getElementById('hours'); h.hidden = !h.hidden; this.setAttribute('aria-expanded', String(!h.hidden)); });"], why: 'a treeitem role that takes no focus, with a click listener' };
    case 'role-switch':
      return { body: `<div id="alerts" role="switch" aria-checked="false">Service alerts</div>${out}`, init: ["document.getElementById('alerts').addEventListener('dblclick', function () { this.setAttribute('aria-checked', 'true'); document.getElementById('out').textContent = 'Alerts are on.'; });"], why: 'a switch role that takes no focus, with a double-click listener' };
    // ---- Surfaces that only draw ------------------------------------------------------------------
    case 'chartjs-pointer-block':
      return { body: `<div class="chart" style="cursor:pointer"><canvas id="chart" role="img" aria-label="Chart of three items: 41, 18 and 9">Three items: 41, 18 and 9.</canvas></div>${TABLE}`, head: ['<script src="/vendor/chart.umd.js"></script>'], files: { '/vendor/chart.umd.js': lib('chartjs/chart.umd.js') }, init: [CHARTJS('bar', "{ labels: ['First', 'Second', 'Third'], datasets: [{ label: 'Count', data: [41, 18, 9] }] }")], why: 'a real Chart.js bar chart inside a block with a pointer cursor, which the canvas inherits' };
    case 'canvas-void-handler':
      return { body: `<canvas id="seats" width="600" height="180" role="img" aria-label="Seats sold in row A: 5 of 7" onclick="void 0"></canvas><p>Five of the seven seats in row A are sold.</p>`, init: [DRAW_SEATS], why: 'a canvas with an empty handler written on it (onclick="void 0")' };
    case 'chartjs-bar':
    case 'chartjs-line':
    case 'chartjs-doughnut': {
      const type = kind.slice(8);
      const data = type === 'doughnut' ? "{ labels: ['First', 'Second', 'Third'], datasets: [{ data: [41, 18, 9] }] }" : "{ labels: ['First', 'Second', 'Third'], datasets: [{ label: 'Count', data: [41, 18, 9] }] }";
      const attrs = type === 'line' ? '' : ' role="img" aria-label="Chart of three items: 41, 18 and 9"';
      return { body: `<div class="chart"${type === 'doughnut' ? ' style="width:320px"' : ''}><canvas id="chart"${attrs}>Three items: 41, 18 and 9.</canvas></div>${TABLE}`, head: ['<script src="/vendor/chart.umd.js"></script>'], files: { '/vendor/chart.umd.js': lib('chartjs/chart.umd.js') }, init: [CHARTJS(type, data)], why: `a real Chart.js ${type} chart with default options (the library listens for click, mousemove and touch on its canvas)` };
    }
    case 'echarts-line':
    case 'echarts-bar': {
      const type = kind.slice(8);
      return { body: `<div id="chart" class="chart" style="height:320px"${type === 'line' ? ' role="img" aria-label="Chart of three items: 41, 18 and 9"' : ''}></div>${TABLE}`, head: ['<script src="/vendor/echarts.js"></script>'], files: { '/vendor/echarts.js': lib('echarts/echarts.simple.min.js') }, init: [`echarts.init(document.getElementById('chart')).setOption({ xAxis: { type: 'category', data: ['First', 'Second', 'Third'] }, yAxis: { type: 'value' }, series: [{ type: '${type}', data: [41, 18, 9] }] });`], why: `a real Apache ECharts ${type} chart with default options (the library listens for click and dblclick on a wrapper of its canvas)` };
    }
    case 'highcharts-like':
      return { body: `<div id="box" class="chart" style="height:300px;position:relative;overflow:hidden"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300" role="img" aria-label="Column chart: three items">${COLUMNS}</svg></div>${TABLE}`, init: ["var noop = function () {}, box = document.getElementById('box'); box.onclick = noop; box.onmousedown = noop; box.onmousemove = noop; ['mouseenter', 'mouseleave', 'touchstart', 'touchmove'].forEach(function (t) { box.addEventListener(t, noop, { passive: true }); }); ['mouseover', 'mouseout', 'touchstart'].forEach(function (t) { box.querySelector('.series').addEventListener(t, noop, { passive: true }); });"], why: "the listeners Highcharts puts on a default chart's container (click, mousedown and mousemove handler properties)" };
    case 'gcharts-like':
      return { body: `<div class="chart" style="height:300px"><div style="position:relative"><div id="outer" dir="ltr" style="position:relative;width:600px;height:300px"><div id="inner" style="position:absolute;left:0;top:0;width:100%;height:100%"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300" aria-label="A chart.">${COLUMNS}</svg><div aria-label="A tabular representation of the data in the chart." style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><table><tbody><tr><td>First</td><td>41</td></tr><tr><td>Second</td><td>18</td></tr></tbody></table></div></div></div></div></div>${TABLE}`, init: ["var noop = function () {}, types = ['mouseover', 'mouseout', 'mousemove', 'mouseup', 'mousedown', 'click', 'contextmenu', 'dblclick'], svg = document.querySelector('#inner svg'); types.forEach(function (t) { svg.addEventListener(t, noop); document.getElementById('outer').addEventListener(t, noop); }); document.getElementById('inner').addEventListener('mousewheel', noop, { passive: true });"], why: "the listeners Google Charts puts on a default chart's svg and wrapper (click and dblclick among them), with its off-screen data table" };
    case 'd3-zoom-like':
      return { body: `<svg id="area" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" role="img" aria-label="Drawing of the four wards"><g id="zoomed">${WARDS.replace(/ class="ward"/g, '')}</g></svg><ul><li>Ward 1: 4,100 people</li><li>Ward 2: 6,300 people</li></ul>`, init: ["var svg = document.getElementById('area'), k = 1, noop = function () {}; svg.addEventListener('wheel', noop, { passive: true }); svg.addEventListener('mousedown', noop); svg.addEventListener('dblclick', function () { k = Math.min(4, k * 2); document.getElementById('zoomed').setAttribute('transform', 'scale(' + k + ')'); }); svg.addEventListener('touchstart', noop, { passive: true });"], why: "the listeners d3-zoom puts on an svg (dblclick zooms the drawing; nothing a keyboard user lacks is shown)" };
    case 'canvas-plain':
      return { body: `<canvas id="seats" width="600" height="180" role="img" aria-label="Seats sold in row A: 5 of 7"></canvas><p>Five of the seven seats in row A are sold.</p>`, init: [`${DRAW_SEATS} var noop = function () {}; ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove'].forEach(function (t) { c.addEventListener(t, noop); });`], why: 'a hand-drawn canvas picture with the listeners a charting library adds, the default cursor and nothing a click does' };
    case 'svg-wrapper':
      return { body: `<div id="box" class="chart" style="height:300px"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="300" viewBox="0 0 600 300" role="img" aria-label="Column chart: three items">${COLUMNS}</svg></div>${TABLE}`, init: ["var noop = function () {}, box = document.getElementById('box'); ['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseout', 'wheel', 'contextmenu'].forEach(function (t) { box.addEventListener(t, noop); });"], why: 'an svg chart in a wrapper that carries a renderer\'s listeners (click and dblclick among them)' };
    // ---- A script listens, and nothing a person does is there -------------------------------------
    case 'analytics-wrapper':
      return { body: '<section id="notice"><h2>Winter service</h2><p>Routes 12 and 24 run every 20 minutes on weekdays.</p></section>', init: ["window.dataLayer = []; document.getElementById('notice').addEventListener('click', function () { window.dataLayer.push({ event: 'notice_click' }); });"], why: 'a click counter on a block of text: nothing a person can see or do' };
    case 'stop-propagation':
      return { body: '<div id="panel" style="border:1px solid #595959;padding:8px 12px"><p>Office hours: 8 am to 4 pm on weekdays.</p></div>', init: ["document.getElementById('panel').addEventListener('click', function (e) { e.stopPropagation(); });"], why: 'a panel that only stops clicks from reaching the page' };
    case 'inherited-pointer':
      return { body: '<section id="card" style="cursor:pointer"><h2>Winter service</h2><p id="line">Routes 12 and 24 run every 20 minutes on weekdays.</p></section>', init: ["window.dataLayer = []; document.getElementById('line').addEventListener('click', function () { window.dataLayer.push({ event: 'line_click' }); });"], why: 'a click counter on a line that inherits a pointer cursor from its block' };
    case 'void-handler':
      return { body: '<div id="promo" onclick="void 0">Weekend service is unchanged this winter.</div>', init: [], why: 'a block of text with an empty handler written on it (onclick="void 0")' };
    // ---- Fix round 2: shadow roots and slots (S1, S2, closed roots) ---------------------------------
    case 'shadow-own-pointer':
      return { body: `<hours-card id="card" style="display:block;border:1px solid #595959;padding:8px 12px"></hours-card>`, init: [TOGGLE, defineEl('hours-card', `<p id="toggle" style="cursor:pointer;color:#0b4fb3;text-decoration:underline">Show office hours</p>${HOURS}`, "root.getElementById('toggle').addEventListener('click', function () { simToggle(this); });")], why: 'a toggle in a shadow root with a pointer cursor of its own (its host has none) and a click listener' };
    case 'shadow-role-button':
      return { body: `<hours-card id="card" style="display:block"></hours-card>`, init: [TOGGLE, defineEl('hours-card', `<div id="toggle" role="button">Show office hours</div>${HOURS}`, "root.getElementById('toggle').addEventListener('click', function () { simToggle(this); });")], why: 'a div with role=button in a shadow root that takes no focus, with a click listener' };
    case 'shadow-host-control':
      return { body: `<hours-toggle id="toggle" style="display:inline-block;cursor:pointer;color:#0b4fb3;text-decoration:underline"></hours-toggle>${HOURS}`, init: [TOGGLE, defineEl('hours-toggle', '<span>Show office hours</span>', "host.addEventListener('click', function () { simToggle(host); });")], why: 'a custom element that shows text from its open shadow root, with a pointer cursor of its own and a click listener' };
    case 'closed-host-text':
      return { body: `<hours-toggle id="toggle" style="display:inline-block;cursor:pointer;color:#0b4fb3;text-decoration:underline"></hours-toggle>${HOURS}`, init: [TOGGLE, defineEl('hours-toggle', '<span>Show office hours</span>', "host.addEventListener('click', function () { simToggle(host); });", 'closed')], why: 'the same custom element with a closed shadow root: what it shows cannot be read, so the walk lists it (undecided by design)' };
    case 'shadow-chart-host':
      return { body: `<budget-chart id="budget" role="presentation" style="display:block;width:600px;height:240px;cursor:pointer"></budget-chart>${TABLE}`, init: [defineEl('budget-chart', '<canvas width="600" height="240" role="img" aria-label="Chart of three items: 41, 18 and 9"></canvas>', `var cv = root.querySelector('canvas'); ${BARS} host.addEventListener('click', function () {}); host.addEventListener('mousemove', function () {});`)], why: 'a chart element whose canvas is in its open shadow root; the host has a pointer cursor and the listeners of a chart' };
    case 'shadow-nested-chart':
      return { body: `<budget-dash id="dash" style="display:block;width:600px;cursor:pointer"></budget-dash>${TABLE}`, init: [defineEl('budget-bars', '<canvas width="600" height="240" role="img" aria-label="Chart of three items: 41, 18 and 9"></canvas>', `var cv = root.querySelector('canvas'); ${BARS}`), defineEl('budget-dash', '<budget-bars style="display:block;width:600px;height:240px"></budget-bars>', "host.addEventListener('click', function () {});")], why: 'a dashboard element whose chart element draws on a canvas two shadow roots down; the dashboard has a pointer cursor and a click listener' };
    case 'shadow-slot-canvas':
      return { body: `<chart-frame id="frame"><canvas id="seats" width="600" height="180" role="img" aria-label="Seats sold in row A: 5 of 7"></canvas></chart-frame><p>Five of the seven seats in row A are sold.</p>`, init: [DRAW_SEATS, defineEl('chart-frame', '<div id="box" style="display:inline-block;cursor:pointer"><slot></slot></div>', "root.getElementById('box').addEventListener('click', function () {});")], why: "a frame element whose box (a pointer cursor, a click listener) shows the page's canvas through its slot" };
    case 'shadow-fallback-text':
      return { body: `<budget-chart id="budget" style="display:block;width:600px;height:240px;cursor:pointer">Chart of three items: 41, 18 and 9.</budget-chart>${TABLE}`, init: [defineEl('budget-chart', '<canvas width="600" height="240" role="img" aria-label="Chart of three items: 41, 18 and 9"></canvas>', `var cv = root.querySelector('canvas'); ${BARS} host.addEventListener('click', function () {});`)], why: 'a chart element with fallback text its shadow root does not show (no slot), a pointer cursor and a click listener' };
    case 'shadow-inherited-pointer':
      return { body: '<service-card id="card" style="display:block;cursor:pointer;border:1px solid #595959;padding:8px 12px"></service-card>', init: [COUNT, defineEl('service-card', '<p id="line">Routes 12 and 24 run every 20 minutes on weekdays.</p>', "root.getElementById('line').addEventListener('click', function () { dataLayer.push({ event: 'line_click' }); });")], why: 'a counted line at the top of a shadow root that inherits its pointer cursor from the host' };
    case 'shadow-slotted-pointer':
      return { body: '<notice-card id="card" style="display:block;border:1px solid #595959;padding:8px 12px"><p id="line">Routes 12 and 24 run every 20 minutes on weekdays.</p></notice-card>', init: [COUNT, defineEl('notice-card', '<div style="cursor:pointer"><slot></slot></div>'), "document.getElementById('line').addEventListener('click', function () { dataLayer.push({ event: 'line_click' }); });"], why: 'a counted line the page put in a slot whose box has a pointer cursor: the line inherits it' };
    case 'shadow-card-slotted-link':
      return { body: '<news-card id="card" style="display:block;max-width:32rem"><h2>Library hours change in March</h2><p>The main library opens at 9 am from March 2.</p><a href="/reports">Read the notice</a></news-card>', init: [defineEl('news-card', '<div id="frame" style="cursor:pointer;border:1px solid #595959;padding:8px 12px"><slot></slot></div>', "var link = host.querySelector('a'); root.getElementById('frame').addEventListener('click', function (e) { if (e.target !== link) link.click(); });")], why: "a card element's clickable box that follows the page's own link, which its slot shows (the link is the keyboard way)" };
    case 'shadow-slotted-in-button':
      return { body: `<fare-button id="adult"><span class="fare"><span class="fare-text"><span id="adult-label" style="cursor:pointer">Adult fare, $2</span></span></span></fare-button>${out}`, init: [defineEl('fare-button', '<button type="button" style="cursor:default;font:inherit"><slot></slot></button>'), "document.getElementById('adult-label').addEventListener('click', function () { document.getElementById('out').textContent = 'Chosen: adult fare.'; });"], why: "a label (a pointer cursor of its own, a click listener) the page put in a button element's slot: it is inside that button" };
    case 'closed-host-button':
      return { body: `<hours-button id="hours-button" style="display:inline-block;cursor:pointer">Show office hours</hours-button>${HOURS}`, init: [TOGGLE, defineEl('hours-button', '<button type="button"><slot></slot></button>', "host.addEventListener('click', function () { simToggle(host); });", 'closed')], why: 'a custom element whose closed shadow root holds a real button; its host has a pointer cursor and the click listener' };
    // ---- Fix round 2: drawings never dropped (S3) --------------------------------------------------------
    case 'canvas-full-viewport':
      return { body: `<p>Choose a seat on the plan.</p><canvas id="seats" width="600" height="180" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:-1" aria-label="Seat plan, row A"></canvas>${out}`, init: [`${DRAW_SEATS} c.addEventListener('click', function (e) { ${PICK} });`], why: 'a seat plan on a canvas that fills the screen, which a click works (undecided by design: nothing presses a canvas)' };
    case 'canvas-press-only':
      return { body: `<p>Choose a seat on the plan.</p><canvas id="seats" width="600" height="180" aria-label="Seat plan, row A"></canvas>${out}`, init: [`${DRAW_SEATS} c.addEventListener('pointerdown', function (e) { ${PICK} });`], why: 'a seat plan on a canvas with only a pointerdown listener and the default cursor, which a press works (undecided by design)' };
    case 'svg-press-only-map':
      return { body: `<p>Choose your ward on the map.</p><svg id="wards" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the four wards">${WARDS}</svg>${out}`, init: ["document.getElementById('wards').addEventListener('mousedown', function (e) { var w = e.target.closest('.ward'); if (w) document.getElementById('out').textContent = 'Ward ' + w.id.slice(5) + ': room 30' + w.id.slice(5) + '.'; });"], why: 'an svg ward map with only a mousedown listener on the svg and the default cursor, which a press works (undecided by design)' };
    case 'div-press-pointer':
      return { body: `<div id="toggle" style="cursor:pointer;color:#0b4fb3;text-decoration:underline">Show office hours</div>${HOURS}`, init: [TOGGLE, "document.getElementById('toggle').addEventListener('mousedown', function () { simToggle(this); });"], why: 'a div with a pointer cursor of its own and only a mousedown listener' };
    case 'span-press-role-pointer':
      return { body: `<span id="toggle" role="button" style="cursor:pointer;color:#0b4fb3;text-decoration:underline">Show office hours</span>${HOURS}`, init: [TOGGLE, "document.getElementById('toggle').addEventListener('pointerdown', function () { simToggle(this); });"], why: 'a span with role=button, a pointer cursor of its own and only a pointerdown listener' };
    case 'canvas-full-viewport-plain':
      return { body: '<canvas id="bg" width="1200" height="800" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:-1" aria-hidden="false" role="presentation"></canvas><p style="position:relative">Routes 12 and 24 run every 20 minutes on weekdays.</p>', init: ["var c = document.getElementById('bg'), g = c.getContext('2d'); g.fillStyle = '#f4f7fb'; g.fillRect(0, 0, 1200, 800); for (var i = 0; i < 60; i++) { g.fillStyle = '#dbe5f1'; g.beginPath(); g.arc((i * 97) % 1200, (i * 53) % 800, 3, 0, 7); g.fill(); } var noop = function () {}; ['click', 'mousemove', 'mouseleave'].forEach(function (t) { c.addEventListener(t, noop); });"], why: 'a background canvas that fills the screen with the listeners of a particle effect (click and mousemove do nothing a person needs)' };
    case 'canvas-press-plain':
      return { body: `<canvas id="seats" width="600" height="180" role="img" aria-label="Seats sold in row A: 5 of 7"></canvas><p>Five of the seven seats in row A are sold.</p>`, init: [`${DRAW_SEATS} var noop = function () {}; ['pointerdown', 'pointerup', 'mousedown', 'mousemove'].forEach(function (t) { c.addEventListener(t, noop); });`], why: 'a canvas picture with press listeners a drawing library adds and nothing a press does' };
    case 'svg-press-plain':
      return { body: `<svg id="area" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" role="img" aria-label="Drawing of the four wards"><g id="zoomed">${WARDS.replace(/ class="ward"/g, '')}</g></svg><ul><li>Ward 1: 4,100 people</li><li>Ward 2: 6,300 people</li></ul>`, init: ["var svg = document.getElementById('area'), noop = function () {}; svg.addEventListener('wheel', noop, { passive: true }); svg.addEventListener('mousedown', noop); svg.addEventListener('touchstart', noop, { passive: true });"], why: 'an svg drawing with the press and wheel listeners d3-zoom adds (no double-click), and nothing a press does a keyboard user lacks' };
    case 'svg-full-viewport-plain':
      return { body: '<svg id="bg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:-1"><rect width="100" height="100" fill="#f4f7fb"/><path d="M0 80 Q50 60 100 80 V100 H0 z" fill="#dbe5f1"/></svg><p style="position:relative">Weekend service is unchanged this winter.</p>', init: ["document.getElementById('bg').addEventListener('click', function () {});"], why: 'a decorative svg that fills the screen behind the page, with a click listener that does nothing' };
    case 'wrapper-full-viewport-plain':
      return { body: '<div id="stage" style="position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:-1"><canvas id="bg" width="1200" height="800" style="width:100%;height:100%"></canvas></div><p style="position:relative">The library opens late on Thursdays.</p>', init: ["var c = document.getElementById('bg'), g = c.getContext('2d'); g.fillStyle = '#f4f7fb'; g.fillRect(0, 0, 1200, 800); var noop = function () {}; ['click', 'mousedown', 'mousemove'].forEach(function (t) { document.getElementById('stage').addEventListener(t, noop); });"], why: 'a wrapper that fills the screen and shows one background canvas, with click and press listeners that do nothing' };
    // ---- Fix round 2: one widget-role predicate (S4) ----------------------------------------------------
    case 'carousel-role-radio':
      return { body: `<div class="slick-slider" role="radiogroup" aria-label="Bus passes"><div class="slick-list"><div class="slick-track"><div class="slick-slide" role="radio" aria-checked="false" style="display:inline-block;width:180px;padding:8px;border:1px solid #595959">Day pass, $5</div><div class="slick-slide" role="radio" aria-checked="false" style="display:inline-block;width:180px;padding:8px;border:1px solid #595959">Month pass, $60</div></div></div></div>${out}`, init: ["[].forEach.call(document.querySelectorAll('.slick-slide'), function (s) { s.addEventListener('click', function () { document.getElementById('out').textContent = 'Chosen: ' + s.textContent + '.'; }); });"], why: "a carousel's slides with the radio role and a working click listener, none takes focus" };
    case 'carousel-role-button':
      return { body: `<div class="swiper"><div class="swiper-wrapper" style="display:flex;gap:8px"><div class="swiper-slide" role="button" style="width:200px;padding:8px;border:1px solid #595959">Spring events</div><div class="swiper-slide" role="button" style="width:200px;padding:8px;border:1px solid #595959">Summer events</div></div></div>${out}`, init: ["[].forEach.call(document.querySelectorAll('.swiper-slide'), function (s) { s.addEventListener('click', function () { document.getElementById('out').textContent = s.textContent + ': the list opens below.'; }); });"], why: "a carousel's slides with the button role that open a list, none takes focus" };
    case 'carousel-role-tab-case':
      return { body: `<div class="owl-carousel" role="tablist" aria-label="Departments" style="display:flex;gap:8px"><div class="owl-item" role="Tab" style="padding:8px;border:1px solid #595959">Parks</div><div class="owl-item" role="Tab" style="padding:8px;border:1px solid #595959">Roads</div></div>${out}`, init: ["[].forEach.call(document.querySelectorAll('.owl-item'), function (s) { s.addEventListener('click', function () { document.getElementById('out').textContent = s.textContent + ': phone 555-0100.'; }); });"], why: "a carousel's items with the tab role written in capitals, in a tab list where nothing takes focus" };
    case 'delegated-role-button':
    case 'delegated-role-case': {
      const role = kind === 'delegated-role-case' ? 'Button' : 'button';
      return { body: `<p>Choose a month.</p><ul id="months" style="list-style:none;padding:0;display:flex;gap:8px"><li role="${role}" class="month" style="padding:6px 12px;border:1px solid #595959">March</li><li role="${role}" class="month" style="padding:6px 12px;border:1px solid #595959">April</li></ul>${out}`, init: ["document.getElementById('months').addEventListener('click', function (e) { var m = e.target.closest('.month'); if (m) document.getElementById('out').textContent = m.textContent + ': the board meets on the second Tuesday.'; });"], why: `list items with the ${role} role under a delegated click listener, none takes focus` };
    }
    case 'delegated-role-option':
      return { body: `<p>Choose your stop.</p><ul id="stops" role="listbox" aria-label="Stops" style="list-style:none;padding:0"><li role="option" style="padding:4px 8px">Main and 5th</li><li role="option" style="padding:4px 8px">Civic Center</li></ul>${out}`, init: ["document.getElementById('stops').addEventListener('click', function (e) { var o = e.target.closest('[role=option]'); if (o) document.getElementById('out').textContent = 'Next bus at ' + o.textContent + ': 7:05.'; });"], why: 'options of a list box under a delegated click listener, where nothing takes focus' };
    case 'delegated-role-menuitem':
      return { body: `<div id="menu" role="menu" aria-label="Map layers" style="border:1px solid #595959;padding:4px;width:220px"><div role="menuitem" style="padding:4px 8px">Bus stops</div><div role="menuitem" style="padding:4px 8px">Bike lanes</div></div>${out}`, init: ["document.getElementById('menu').addEventListener('click', function (e) { var m = e.target.closest('[role=menuitem]'); if (m) document.getElementById('out').textContent = 'Layer: ' + m.textContent + '.'; });"], why: 'menu items under a delegated click listener on the menu, where nothing takes focus' };
    case 'carousel-slides-plain':
      return { body: '<div class="slick-slider"><div class="slick-list"><div class="slick-track"><div class="slick-slide" role="group" aria-label="1 of 2" style="display:inline-block;width:180px;padding:8px;border:1px solid #595959">The library opens late on Thursdays.</div><div class="slick-slide" role="group" aria-label="2 of 2" style="display:inline-block;width:180px;padding:8px;border:1px solid #595959">Bus routes 12 and 24 change in March.</div></div></div></div><p><button type="button">Previous</button> <button type="button">Next</button></p>', init: ["var drag = function () {}; [].forEach.call(document.querySelectorAll('.slick-slide'), function (s) { s.addEventListener('click', drag); s.addEventListener('mousedown', drag); }); document.querySelector('.slick-track').addEventListener('click', drag);"], why: "a carousel's own slides (group role) with the library's drag listeners, and its Previous and Next buttons" };
    case 'carousel-roledescription-plain':
      return { body: '<section aria-roledescription="carousel" aria-label="News"><div id="slides" style="display:flex;gap:8px"><div aria-roledescription="slide" role="group" style="width:200px;padding:8px;border:1px solid #595959">Spring cleanup is April 12.</div><div aria-roledescription="slide" role="group" style="width:200px;padding:8px;border:1px solid #595959">Pools open June 1.</div></div><button type="button">Pause</button></section>', init: ["var swipe = function () {}; [].forEach.call(document.querySelectorAll('[aria-roledescription=slide]'), function (s) { s.addEventListener('pointerdown', swipe); s.addEventListener('click', swipe); });"], why: "a carousel in ARIA's pattern whose slides carry the swipe listeners, with its Pause button" };
    case 'delegated-plain-members':
      return { body: '<p>The board meets on the second Tuesday of these months.</p><ul id="months" style="list-style:none;padding:0;display:flex;gap:8px"><li role="listitem" style="padding:6px 12px;border:1px solid #595959">March</li><li style="padding:6px 12px;border:1px solid #595959">April</li><li role="presentation" style="padding:6px 12px;border:1px solid #595959">May</li></ul>', init: [COUNT, "document.getElementById('months').addEventListener('click', function () { dataLayer.push({ event: 'months_click' }); });"], why: 'list items with no widget role under a listener that only counts clicks' };
    case 'composite-roving-case':
      return { body: `<div role="Toolbar" aria-label="Map tools" id="tools" style="display:flex;gap:8px;align-items:center"><button type="button" tabindex="0">Zoom in</button><button type="button" tabindex="-1">Zoom out</button><div class="group"><div class="inner"><span id="legend" role="button" tabindex="-1" style="padding:4px 8px;border:1px solid #595959">Legend</span></div></div></div>${out}`, init: ["var tools = [].slice.call(document.querySelectorAll('#tools button, #tools [role=button]')); tools.forEach(function (t, i) { t.addEventListener('keydown', function (e) { var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (!d) return; e.preventDefault(); var n = tools[(i + d + tools.length) % tools.length]; tools.forEach(function (o) { o.tabIndex = o === n ? 0 : -1; }); n.focus(); }); }); var lg = document.getElementById('legend'); lg.addEventListener('click', function () { document.getElementById('out').textContent = 'Legend shown.'; }); lg.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } });"], why: 'a roving toolbar (its role written in capitals): Tab reaches its first tool and the arrow keys reach the legend' };
    // ---- Fix round 2: an undecided part never stands in for its declared control (S5) -------------------
    case 'icon-role-button-svg':
    case 'icon-role-link-svg':
    case 'icon-role-switch-svg': {
      const role = kind.split('-')[2]!;
      return { body: `<div id="map-toggle" role="${role}"${role === 'switch' ? ' aria-checked="false"' : ''} style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Show the office on the map</span></div>${HOURS}`, init: [TOGGLE, "document.getElementById('map-toggle').addEventListener('click', function () { simToggle(this); });"], why: `a div with role=${role} around an icon with a pointer cursor of its own and a label, which opens content and takes no focus` };
    }
    case 'icon-role-button-canvas':
      return { body: `<div id="map-toggle" role="button" style="display:inline-flex;gap:6px;align-items:center"><canvas class="icon" width="20" height="20" style="cursor:pointer"></canvas><span>Show the office on the map</span></div>${HOURS}`, init: [TOGGLE, "var ic = document.querySelector('canvas.icon').getContext('2d'); ic.fillStyle = '#0b4fb3'; ic.fillRect(4, 2, 12, 16); document.getElementById('map-toggle').addEventListener('click', function () { simToggle(this); });"], why: 'a div with role=button around a canvas icon with a pointer cursor of its own and a label, which takes no focus' };
    case 'icon-link-nohref-svg':
      return { body: `<a id="map-toggle" style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Show the office on the map</span></a>${HOURS}`, init: [TOGGLE, "document.getElementById('map-toggle').addEventListener('click', function () { simToggle(this); });"], why: 'a link element with no href around an icon with a pointer cursor of its own and a label' };
    case 'icon-role-tab-svg':
    case 'icon-role-menuitem-svg': {
      const [box, role] = kind === 'icon-role-tab-svg' ? ['tablist', 'tab'] : ['menu', 'menuitem'];
      return { body: `<div role="${box}" aria-label="Office" style="display:flex;gap:8px"><div id="map-toggle" role="${role}" style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Map</span></div><div role="${role}" style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Phone</span></div></div>${HOURS}`, init: [TOGGLE, `[].forEach.call(document.querySelectorAll('[role=${role}]'), function (t) { t.addEventListener('click', function () { simToggle(this); }); });`], why: `${role} roles with an icon (a pointer cursor of its own) and a label, in a ${box} where nothing takes focus` };
    }
    case 'icon-plain-counter':
      return { body: `<div id="where" style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Civic Center, 555 Main Street, room 210</span></div>`, init: [COUNT, "document.getElementById('where').addEventListener('click', function () { dataLayer.push({ event: 'where_click' }); });"], why: 'an icon with a pointer cursor of its own in a block that only counts clicks (nothing declared)' };
    case 'icon-in-button':
      return { body: `<button type="button" id="map-toggle" style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Show the office on the map</span></button>${HOURS}`, init: [TOGGLE, "document.getElementById('map-toggle').addEventListener('click', function () { simToggle(this); });"], why: 'a real button around an icon with a pointer cursor of its own' };
    case 'icon-role-button-focusable':
      return { body: `<div id="map-toggle" role="button" tabindex="0" style="display:inline-flex;gap:6px;align-items:center">${ICON()}<span>Show the office on the map</span></div>${HOURS}`, init: [TOGGLE, "var t = document.getElementById('map-toggle'); t.addEventListener('click', function () { simToggle(this); }); t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } });"], why: 'a focusable div with role=button (Enter and Space work) around an icon with a pointer cursor of its own' };
    // ---- Fix round 2: handlers written on elements in shadow roots (S7) ----------------------------------
    case 'shadow-inline-nohref':
      return { body: '<hours-box id="box" style="display:block"></hours-box>', init: [TOGGLE, defineEl('hours-box', `<a id="more" onclick="simToggle(this)">Show office hours</a>${HOURS}`)], why: 'a link element with no href and only onclick written on it, in a shadow root' };
    case 'shadow-inline-role-button':
      return { body: '<hours-box id="box" style="display:block"></hours-box>', init: [TOGGLE, defineEl('hours-box', `<div id="more" role="button" onclick="simToggle(this)">Show office hours</div>${HOURS}`)], why: 'a div with role=button and only onclick written on it, in a shadow root' };
    case 'shadow-inline-own-pointer':
      return { body: '<hours-box id="box" style="display:block"></hours-box>', init: [TOGGLE, defineEl('hours-box', `<span id="more" style="cursor:pointer;color:#0b4fb3;text-decoration:underline" onclick="simToggle(this)">Show office hours</span>${HOURS}`)], why: 'a span with a pointer cursor of its own and only onclick written on it, in a shadow root' };
    case 'shadow-inline-nested':
      return { body: '<office-panel id="panel" style="display:block"></office-panel>', init: [TOGGLE, defineEl('hours-box', `<div id="more" role="button" onclick="simToggle(this)">Show office hours</div>${HOURS}`), defineEl('office-panel', '<section><hours-box style="display:block"></hours-box></section>')], why: 'a div with role=button and only onclick written on it, two shadow roots down' };
    case 'shadow-inline-button-out':
      return { body: '<hours-box id="box" style="display:block"></hours-box>', init: [TOGGLE, defineEl('hours-box', `<button type="button" id="more" tabindex="-1" onclick="simToggle(this)">Show office hours</button>${HOURS}`)], why: 'a button taken out of the tab order with only onclick written on it, in a shadow root' };
    case 'shadow-inline-canvas':
      return { body: `<p>Choose a seat on the plan.</p><seat-plan id="plan" style="display:block;width:600px;height:180px"></seat-plan>${out}`, init: [`window.simPick = function (e) { ${PICK} };`, defineEl('seat-plan', '<canvas id="seats" width="600" height="180" aria-label="Seat plan, row A" onclick="simPick(event)"></canvas>', `var c = root.getElementById('seats'), g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 600, 180); for (var i = 0; i < 7; i++) { g.fillStyle = '#0b4fb3'; g.fillRect(20 + i * 80, 50, 64, 80); }`)], why: 'a seat plan canvas in a shadow root with only onclick written on it, which a click works (undecided by design)' };
    case 'shadow-inline-text':
      return { body: '<hours-box id="box" style="display:block"></hours-box>', init: [TOGGLE, defineEl('hours-box', `<p id="more" onclick="simToggle(this)">Office hours this week</p>${HOURS}`)], why: 'a line of text in a shadow root that onclick written on it opens, default cursor, no role (undecided by design)' };
    case 'shadow-inline-void-canvas':
      return { body: `<seat-plan id="plan" style="display:block;width:600px;height:180px"></seat-plan><p>Five of the seven seats in row A are sold.</p>`, init: [defineEl('seat-plan', '<canvas id="seats" width="600" height="180" role="img" aria-label="Seats sold in row A: 5 of 7" onclick="void 0"></canvas>', `var c = root.getElementById('seats'), g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 600, 180); for (var i = 0; i < 7; i++) { g.fillStyle = i < 5 ? '#595959' : '#0b4fb3'; g.fillRect(20 + i * 80, 50, 64, 80); }`)], why: 'a canvas picture in a shadow root with an empty handler written on it' };
    case 'shadow-inline-void-text':
      return { body: '<notice-box id="box" style="display:block"></notice-box>', init: [defineEl('notice-box', '<p id="line" onclick="void 0">Weekend service is unchanged this winter.</p>')], why: 'a line of text in a shadow root with an empty handler written on it' };
    case 'shadow-inline-button':
      return { body: '<hours-box id="box" style="display:block"></hours-box>', init: [TOGGLE, defineEl('hours-box', `<button type="button" id="more" onclick="simToggle(this)">Show office hours</button>${HOURS}`)], why: 'a real button with onclick written on it, in a shadow root' };
    // ---- A real control with no sign but the listener ---------------------------------------------
    case 'text-inline-handler':
      return { body: '<div id="toggle" onclick="var h = document.getElementById(\'hours\'); h.hidden = !h.hidden;">Office hours this week</div><p id="hours" hidden>8 am to 4 pm on weekdays.</p>', init: [], why: 'a line of text a click opens (its handler written on the element), with the default cursor and no role' };
    default:
      return { body: '<div id="toggle">Office hours this week</div><p id="hours" hidden>8 am to 4 pm on weekdays.</p>', init: ["document.getElementById('toggle').addEventListener('click', function () { var h = document.getElementById('hours'); h.hidden = !h.hidden; });"], why: 'a line of text a click opens, with the default cursor, no role and no handler on the element: only the script\'s listener says control (listed by the walk, by design; the controls test fails it)' };
  }
}


const BIG = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="vertical-align:middle"><rect width="${w}" height="${h}" fill="#dbe8f7"/></svg>`;
const repeat = (s: string, n: number) => Array.from({ length: n }, () => s).join('');
/** Round 4's kinds (one page each; `Built` as above). */
function build4(kind: Round4Kind): Built {
  const say = "document.getElementById('out').textContent = ";
  const out = '<p id="out">Nothing chosen yet.</p>';
  switch (kind) {
    // ---- S1: parts of a drawing ---------------------------------------------------------------------
    case 'svg-regions-working':
      return { body: `<svg id="wards" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the four wards">${WARDS}</svg>${out}`, css: ['.ward { cursor: pointer; }'], init: [`document.getElementById('wards').addEventListener('click', function (e) { var w = e.target.closest('.ward'); if (w) ${say}'Ward ' + w.id.slice(5) + ': room 30' + w.id.slice(5) + '.'; });`], why: 'svg map regions a click works (listed by design: parts of a drawing are never failed by this rule)' };
    case 'svg-markers-working':
      return { body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the stops"><rect width="600" height="220" fill="#eef3f8"/>${[60, 240, 420].map((x, i) => `<circle class="stop" cx="${x}" cy="110" r="14" fill="#0b4fb3" style="cursor:pointer" data-n="${i + 1}"/>`).join('')}</svg>${out}`, init: [`[].forEach.call(document.querySelectorAll('.stop'), function (c) { c.addEventListener('click', function () { ${say}'Stop ' + c.getAttribute('data-n') + ': next bus in 4 minutes.'; }); });`], why: 'svg map markers each with a click that works (listed by design)' };
    case 'html-label-in-chart':
      return { body: `<div id="chart" style="position:relative;width:600px">${BIG(600, 240)}<span id="hint" style="position:absolute;left:10px;top:10px;cursor:pointer;color:#1b1b1b">Details</span></div>${out}`, init: [`document.getElementById('hint').addEventListener('click', function () { ${say}'General fund: 41 million.'; });`], why: 'an HTML label with a pointer cursor of its own over a chart, which a click works: its wrapper shows text, so it is no wrapper of one drawing, and the label fails' };
    case 'button-role-beside-chart':
      return { body: `<div class="chart">${BIG(600, 240)}</div><div id="toggle" role="button">Show the numbers</div>${HOURS}`, init: [TOGGLE, "document.getElementById('toggle').addEventListener('click', function () { simToggle(this); });"], why: 'a div with role=button next to a chart, not inside it: still fails' };
    case 'svg-regions-noop-delegated':
      return { body: `<svg id="wards" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the four wards">${WARDS}</svg><p>Ward 1 is the west end.</p>`, css: ['.ward { cursor: pointer; }'], init: [`${COUNT} document.getElementById('wards').addEventListener('click', function () { dataLayer.push({ event: 'ward' }); });`], why: 'svg regions with a pointer cursor whose only listener counts clicks' };
    case 'svg-regions-noop-direct':
      return { body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the four wards">${WARDS}</svg><p>Ward 1 is the west end.</p>`, css: ['.ward { cursor: pointer; }'], init: ["var noop = function () {}; [].forEach.call(document.querySelectorAll('.ward'), function (w) { w.addEventListener('click', noop); });"], why: 'svg regions with a pointer cursor each with a listener that does nothing (a hit test)' };
    case 'd3-groups-noop':
      return { body: `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" role="img" aria-label="Bubbles of three items">${[100, 300, 500].map((x) => `<g class="node" style="cursor:pointer"><circle cx="${x}" cy="110" r="60" fill="#9ecae1"/><text x="${x}" y="114" text-anchor="middle" font-size="14">Item</text></g>`).join('')}</svg>${TABLE}`, init: ["var noop = function () {}; [].forEach.call(document.querySelectorAll('.node'), function (g) { g.addEventListener('click', noop); g.addEventListener('mouseover', noop); });"], why: 'd3-style groups with a pointer cursor and a hit-test listener each' };
    case 'chart-points-proxies':
      return { body: `<div class="chart" style="position:relative"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="240" viewBox="0 0 600 240" role="img" aria-label="Spending by fund"><g class="series">${[0, 1, 2].map((i) => `<rect class="pt" x="${60 + i * 180}" y="${[15, 130, 175][i]}" width="120" height="${[205, 90, 45][i]}" fill="#2c6fbb" style="cursor:pointer"/>`).join('')}</g></svg><p>${[0, 1, 2].map((i) => `<button type="button" class="key" data-i="${i}">${['General', 'Roads', 'Parks'][i]}</button>`).join(' ')}</p></div>${out}`, init: [`var v = ['General: 41', 'Roads: 18', 'Parks: 9']; [].forEach.call(document.querySelectorAll('.pt'), function (p, i) { p.addEventListener('click', function () { ${say}v[i]; }); }); [].forEach.call(document.querySelectorAll('.key'), function (b) { b.addEventListener('click', function () { ${say}v[Number(b.getAttribute('data-i'))]; }); });`], why: 'chart points with a pointer cursor and a click each, with a button per point (the keyboard route)' };
    case 'legend-noop':
      return { body: `<div id="box" class="chart"><svg xmlns="http://www.w3.org/2000/svg" width="600" height="320" viewBox="0 0 600 320" role="img" aria-label="Column chart: three items">${COLUMNS}<g id="legend"><rect x="270" y="296" width="12" height="12" fill="#2c6fbb"/><text x="288" y="307" font-size="12" fill="#333333" style="cursor:pointer">Count</text></g></svg></div>${TABLE}`, init: ["document.getElementById('legend').addEventListener('click', function () {});"], why: "a chart legend label with a pointer cursor whose listener does nothing" };
    case 'map-markers-noop':
      return { body: `<svg id="map" xmlns="http://www.w3.org/2000/svg" width="600" height="220" viewBox="0 0 600 220" aria-label="Map of the stops"><rect width="600" height="220" fill="#eef3f8"/>${[60, 240, 420].map((x) => `<circle cx="${x}" cy="110" r="14" fill="#0b4fb3" style="cursor:pointer"/>`).join('')}</svg><p>Three stops on Main Street.</p>`, init: ["document.getElementById('map').addEventListener('click', function () {});"], why: 'map markers with a pointer cursor under a map-level listener that only hit-tests' };
    // ---- S2: bounds -----------------------------------------------------------------------------------
    case 'text-under':
    case 'text-over':
      return { body: `<div id="subject" style="cursor:pointer;width:400px">${BIG(400, 200)}<div style="position:absolute;left:-10000px">${repeat('<span>t</span>', kind === 'text-under' ? 400 : 401)}</div></div>`, init: ["document.getElementById('subject').addEventListener('click', function () {});"], why: `a drawing wrapper with ${kind === 'text-under' ? 400 : 401} off-screen texts: never failed (listed as a drawing, or unread)` };
    case 'svgtext-over':
      return { body: `<div id="subject" style="cursor:pointer;width:400px"><svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#2c6fbb"/>${repeat('<text x="5" y="15" font-size="10" fill="#ffffff">1</text>', 401)}</svg></div>`, init: ["document.getElementById('subject').addEventListener('click', function () {});"], why: 'a drawing wrapper whose svg holds 401 labels: a drawing, never failed' };
    case 'drawings-under':
    case 'drawings-over':
      return { body: `<div id="subject" style="cursor:pointer;width:400px">${repeat('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>', kind === 'drawings-under' ? 39 : 40)}${BIG(400, 200)}</div>`, init: ["document.getElementById('subject').addEventListener('click', function () {});"], why: 'a drawing wrapper with many small drawings before the one that fills it: never failed' };
    case 'slots-under':
    case 'slots-over': {
      const n = kind === 'slots-under' ? 50 : 51;
      return { body: `<chart-slots id="frame"><canvas slot="s${n}" width="400" height="200"></canvas></chart-slots>`, init: [defineEl('chart-slots', `<div id="box" style="display:inline-block;cursor:pointer">${Array.from({ length: n }, (_, i) => `<slot name="s${i + 1}"></slot>`).join('')}</div>`, "root.getElementById('box').addEventListener('click', function () {});")], why: `a frame element whose box shows the page's canvas through its ${n}th slot: never failed` };
    }
    case 'focusable-under':
    case 'focusable-over':
      return { body: `<div id="subject" role="button">Show the hours ${repeat('<span tabindex="-1"></span>', kind === 'focusable-under' ? 299 : 300)}<button type="button" id="real">Show</button></div>${HOURS}`, init: [TOGGLE, "document.getElementById('subject').addEventListener('click', function () { simToggle(this); });"], why: 'a button role around many script-focusable elements and a real button: the button is the keyboard way, never failed' };
    case 'elements-under':
      return { body: `<div id="subject" role="button">Show the hours<span hidden>${repeat('<i></i>', 2999)}</span></div>${HOURS}`, init: [TOGGLE, "document.getElementById('subject').addEventListener('click', function () { simToggle(this); });"], why: 'a button role around 3000 plain elements (all read): it fails' };
    case 'scopes-under':
      return { body: `<div id="subject" role="button">Show the hours<span hidden>${repeat('<span class="host"></span>', 49)}</span></div>${HOURS}`, init: [TOGGLE, "[].forEach.call(document.querySelectorAll('#subject .host'), function (b) { b.attachShadow({ mode: 'open' }).innerHTML = '<i></i>'; }); document.getElementById('subject').addEventListener('click', function () { simToggle(this); });"], why: 'a button role around 49 shadow roots (all read): it fails' };
    // ---- S3: custom elements --------------------------------------------------------------------------
    case 'custom-no-shadow-toggle':
      return { body: `<app-tile id="tile" style="display:inline-block;cursor:pointer;color:#0b4fb3;text-decoration:underline">Show office hours</app-tile>${HOURS}`, init: [TOGGLE, "document.getElementById('tile').addEventListener('click', function () { simToggle(this); });"], why: 'a custom element with no shadow root (a framework component tag), a pointer cursor and a toggle: unread by the cut ruling (missed by design)' };
    case 'declarative-closed-text-toggle':
      return { body: `<hours-tile id="tile" style="display:inline-block;cursor:pointer"><template shadowrootmode="closed"><span style="color:#0b4fb3;text-decoration:underline">Show office hours</span></template></hours-tile>${HOURS}`, init: [TOGGLE, "document.getElementById('tile').addEventListener('click', function () { simToggle(this); });"], why: 'a custom element whose closed markup root shows text, with a toggle: unread (missed by design)' };
    case 'custom-open-text-toggle':
      return { body: `<hours-toggle id="tile" style="display:inline-block;cursor:pointer;color:#0b4fb3;text-decoration:underline"></hours-toggle>${HOURS}`, init: [TOGGLE, defineEl('hours-toggle', '<span>Show office hours</span>', "host.addEventListener('click', function () { simToggle(host); });")], why: 'a custom element with an open root showing text, a pointer cursor of its own and a toggle: fails' };
    case 'div-in-custom-wrapper':
      return { body: `<app-panel><div id="toggle" role="button">Show office hours</div></app-panel>${HOURS}`, init: [TOGGLE, "document.getElementById('toggle').addEventListener('click', function () { simToggle(this); });"], why: 'a div with role=button inside a custom element wrapper with no shadow root: fails (the wrapper is not the candidate)' };
    case 'custom-open-role-button':
      return { body: `<hours-toggle id="tile" role="button" style="display:inline-block"></hours-toggle>${HOURS}`, init: [TOGGLE, defineEl('hours-toggle', '<span>Show office hours</span>', "host.addEventListener('click', function () { simToggle(host); });")], why: 'a custom element with an open root, role=button and a toggle: fails' };
    case 'declarative-closed-chart':
      return { body: `<budget-chart id="budget" style="display:block;width:600px;height:240px;cursor:pointer"><template shadowrootmode="closed"><canvas width="600" height="240" role="img" aria-label="Chart of three items: 41, 18 and 9"></canvas></template></budget-chart>${TABLE}`, init: ["document.getElementById('budget').addEventListener('click', function () {});"], why: 'a chart element whose closed markup root draws on a canvas: never failed' };
    case 'declarative-closed-button':
      return { body: `<hours-button id="hb" style="display:inline-block;cursor:pointer"><template shadowrootmode="closed"><button type="button"><slot></slot></button></template>Show office hours</hours-button>${HOURS}`, init: [TOGGLE, "document.getElementById('hb').addEventListener('click', function () { simToggle(this); });"], why: 'a button element whose closed markup root holds a native button: never failed' };
    case 'custom-no-shadow-counter':
      return { body: '<app-notice id="notice" style="display:block;cursor:pointer;border:1px solid #595959;padding:8px">Routes 12 and 24 run every 20 minutes.</app-notice>', init: [`${COUNT} document.getElementById('notice').addEventListener('click', function () { dataLayer.push({ event: 'notice' }); });`], why: 'a custom element with no shadow root and a click counter: never failed' };
    case 'custom-open-chart':
      return { body: `<budget-chart id="budget" style="display:block;width:600px;height:240px;cursor:pointer"></budget-chart>${TABLE}`, init: [defineEl('budget-chart', '<canvas width="600" height="240" role="img" aria-label="Chart of three items: 41, 18 and 9"></canvas>', `var cv = root.querySelector('canvas'); ${BARS} host.addEventListener('click', function () {});`)], why: 'a chart element whose open root draws on a canvas: a drawing, never failed' };
    case 'script-closed-button':
      return { body: `<hours-button id="hb" style="display:inline-block;cursor:pointer">Show office hours</hours-button>${HOURS}`, init: [TOGGLE, defineEl('hours-button', '<button type="button"><slot></slot></button>', "host.addEventListener('click', function () { simToggle(host); });", 'closed')], why: 'a button element whose script-made closed root holds a native button: never failed' };
    // ---- S6: text in shadow roots and slots ------------------------------------------------------------
    case 'shadow-svg-bare-label':
      return { body: `<map-toggle id="mt" role="button" style="display:inline-block;width:480px;height:60px"></map-toggle>${HOURS}`, init: [TOGGLE, defineEl('map-toggle', `${BIG(300, 60)}Show the office`, "host.addEventListener('click', function () { simToggle(host); });")], why: 'a button element whose shadow root shows a large icon and a bare label: fails' };
    case 'slotted-bare-label':
      return { body: `<map-button id="mb">Show the office</map-button>${HOURS}`, init: [TOGGLE, defineEl('map-button', `<div id="inner" role="button" style="display:inline-block;width:480px;height:60px">${BIG(300, 60)}<slot></slot></div>`, "root.getElementById('inner').addEventListener('click', function () { simToggle(host); });")], why: 'a button role in a shadow root with a large icon and the bare label the page put in its slot: fails' };
    case 'shadow-svg-span-label':
      return { body: `<map-toggle id="mt" role="button" style="display:inline-block;width:480px;height:60px"></map-toggle>${HOURS}`, init: [TOGGLE, defineEl('map-toggle', `${BIG(300, 60)}<span>Show the office</span>`, "host.addEventListener('click', function () { simToggle(host); });")], why: 'the same with the label in a span: fails' };
    case 'shadow-text-only-control':
      return { body: `<map-toggle id="mt" role="button" style="display:inline-block"></map-toggle>${HOURS}`, init: [TOGGLE, defineEl('map-toggle', 'Show the office', "host.addEventListener('click', function () { simToggle(host); });")], why: 'a button element whose shadow root is only a bare label: fails' };
    case 'slotted-element-label':
      return { body: `<map-button id="mb"><span>Show the office</span></map-button>${HOURS}`, init: [TOGGLE, defineEl('map-button', `<div id="inner" role="button" style="display:inline-block;width:480px;height:60px">${BIG(300, 60)}<slot></slot></div>`, "root.getElementById('inner').addEventListener('click', function () { simToggle(host); });")], why: 'a button role in a shadow root with a large icon and a slotted span label: fails' };
    case 'shadow-svg-hidden-label':
      return { body: `<chart-tile id="ct" style="display:inline-block;width:480px;height:60px;cursor:pointer"></chart-tile>${TABLE}`, init: [defineEl('chart-tile', `${BIG(480, 60)}<span style="position:absolute;left:-10000px">Chart of three items</span>`, "host.addEventListener('click', function () {});")], why: 'a chart element whose only text is kept off screen: a drawing, never failed' };
    case 'shadow-svg-no-label':
      return { body: `<chart-tile id="ct" style="display:inline-block;width:480px;height:60px;cursor:pointer"></chart-tile>${TABLE}`, init: [defineEl('chart-tile', BIG(480, 60), "host.addEventListener('click', function () {});")], why: 'a chart element that only draws, a pointer cursor and a listener that does nothing: never failed' };
    case 'slotted-unassigned-text':
      return { body: `<chart-tile id="ct" style="display:inline-block;width:480px;height:60px;cursor:pointer">Chart of three items: 41, 18 and 9.</chart-tile>${TABLE}`, init: [defineEl('chart-tile', BIG(480, 60), "host.addEventListener('click', function () {});")], why: 'a chart element with fallback text no slot shows: a drawing, never failed' };
    case 'shadow-svg-label-in-svg':
      return { body: `<chart-tile id="ct" style="display:inline-block;width:480px;height:60px;cursor:pointer"></chart-tile>${TABLE}`, init: [defineEl('chart-tile', '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="60" viewBox="0 0 480 60"><rect width="480" height="60" fill="#dbe8f7"/><text x="10" y="35" font-size="14">Spending by fund</text></svg>', "host.addEventListener('click', function () {});")], why: 'a chart element whose label is part of its svg: a drawing, never failed' };
    // ---- The round-4 check's cuts ----------------------------------------------------------------------
    case 'card-nested-closed-button':
      return { body: `<div id="card" style="cursor:pointer;border:1px solid #595959;padding:8px 12px"><p>The office is in room 210.</p><hours-button><template shadowrootmode="closed"><button type="button"><slot></slot></button></template>Show office hours</hours-button></div>${HOURS}`, init: [TOGGLE, "document.getElementById('card').addEventListener('click', function () { simToggle(this); });"], why: 'a card with a pointer cursor around a button element whose closed markup root holds a native button (the keyboard way): never failed' };
    case 'card-nested-closed-chart':
      return { body: `<div id="card" style="cursor:pointer;border:1px solid #595959;padding:8px 12px"><p>Spending by fund.</p><budget-chart style="display:block;width:300px;height:120px"><template shadowrootmode="closed"><canvas width="300" height="120"></canvas></template></budget-chart></div>${TABLE}`, init: [`${COUNT} document.getElementById('card').addEventListener('click', function () { dataLayer.push({ event: 'card' }); });`], why: 'a counted card with a pointer cursor around a chart element with a closed markup root: never failed' };
    // S2 holds only where the drawing read leaves the answer open (the lead's watch on 2.1.1 recall): a declared control
    // on a page whose wrapper shows text of its own still fails, after 45 inline icons or past the 3000-element bound.
    case 'icon-heavy-toggle':
      return { body: `<ul style="list-style:none;padding:0">${Array.from({ length: 45 }, (_, i) => `<li><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6" fill="#0b4fb3"/></svg> Service ${i + 1}</li>`).join('')}</ul><div id="card" style="cursor:pointer;color:#0b4fb3;text-decoration:underline;display:inline-block;padding:8px 0">Show office hours</div>${HOURS}`, init: [TOGGLE, "document.getElementById('card').addEventListener('click', function () { simToggle(this); });"], why: 'a click-only toggle with a pointer cursor of its own on a page with 45 inline icons: fails' };
    case 'big-page-toggle':
      return { body: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" role="img" aria-label="City seal"><circle cx="20" cy="20" r="18" fill="#0b4fb3"/></svg><div id="card" style="cursor:pointer;color:#0b4fb3;text-decoration:underline;display:inline-block;padding:8px 0">Show office hours</div>${HOURS}<table><caption>Permits issued</caption><tbody>${Array.from({ length: 800 }, (_, i) => `<tr><td>Permit ${i + 1}</td><td><span>Issued</span></td><td><span>2026</span></td></tr>`).join('')}</tbody></table>`, init: [TOGGLE, "document.getElementById('card').addEventListener('click', function () { simToggle(this); });"], why: 'a click-only toggle with a pointer cursor of its own on a page of more than 3000 elements with a logo: fails' };
    case 'card-nested-custom-toggle':
      return { body: `<div id="card" style="cursor:pointer;border:1px solid #595959;padding:8px 12px"><app-icon></app-icon> Show office hours</div>${HOURS}`, init: [TOGGLE, "document.getElementById('card').addEventListener('click', function () { simToggle(this); });"], why: 'a card with a pointer cursor and a toggle around a custom element tag with no shadow root: unread by the cut (missed by design)' };
    case 'overlay-noop-after-icons':
    case 'overlay-working-after-icons':
    case 'overlay-noop-under-bound': {
      const n = kind === 'overlay-noop-under-bound' ? 39 : 40;
      const act = kind === 'overlay-working-after-icons' ? 'simToggle(this);' : '';
      return { body: `<div id="chart" style="position:relative;width:400px;height:200px">${repeat('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>', n)}<canvas id="plan" width="400" height="200" style="position:absolute;left:0;top:0"></canvas><div id="overlay" style="position:absolute;left:10px;top:10px;width:120px;height:40px;cursor:pointer"></div></div>${HOURS}`, init: [TOGGLE, `var g = document.getElementById('plan').getContext('2d'); g.fillStyle = '#dbe8f7'; g.fillRect(0, 0, 400, 200); document.getElementById('overlay').addEventListener('click', function () { ${act} });`], why: kind === 'overlay-working-after-icons' ? 'an overlay a click works, in a wrapper whose drawing read stops at 40 icons: unread (missed by design)' : `an overlay with a listener that does nothing, in a wrapper with ${n} icons before its canvas: never failed` };
    }
    case 'hidden-shadow-label':
      return { body: `<div id="chart" style="position:relative;width:480px;height:120px;cursor:pointer">${BIG(480, 120)}<chart-label style="position:absolute;left:10px;top:10px;visibility:hidden"></chart-label></div>${TABLE}`, init: [defineEl('chart-label', 'Spending by fund'), "document.getElementById('chart').addEventListener('click', function () {});"], why: 'a chart wrapper whose only label is bare text in a hidden element\'s shadow root: never failed' };
    case 'hidden-slot-label':
      return { body: `<chart-box id="box">Spending by fund</chart-box>${TABLE}`, init: [defineEl('chart-box', `<div id="frame" style="position:relative;display:inline-block;width:480px;height:120px;cursor:pointer">${BIG(480, 120)}<span style="position:absolute;left:10px;top:10px;visibility:hidden"><slot></slot></span></div>`, "root.getElementById('frame').addEventListener('click', function () {});")], why: 'a chart box whose only label is slotted text it keeps hidden: never failed' };
    case 'visible-shadow-label-control':
      return { body: `<map-toggle id="mt" role="button" style="display:inline-block;width:480px;height:60px"></map-toggle>${HOURS}`, init: [TOGGLE, defineEl('map-toggle', `${BIG(300, 60)}Show the office`, "host.addEventListener('click', function () { simToggle(host); });")], why: 'a button element with a visible bare label next to its large icon: fails' };
    case 'visible-slot-label-control':
      return { body: `<map-button id="mb">Show the office</map-button>${HOURS}`, init: [TOGGLE, defineEl('map-button', `<div id="inner" role="button" style="display:inline-block;width:480px;height:60px">${BIG(300, 60)}<span><slot></slot></span></div>`, "root.getElementById('inner').addEventListener('click', function () { simToggle(host); });")], why: 'a button role with a visible slotted label next to its large icon: fails' };
    case 'shadow-svg-text-below':
      return { body: `<chart-tile id="ct" style="display:block;width:480px;height:60px;cursor:pointer;overflow:hidden"></chart-tile><p>Spending by fund this year.</p>${TABLE}`, init: [defineEl('chart-tile', `${BIG(480, 60)}<div style="height:200px"></div>`, "host.addEventListener('click', function () {});")], why: 'a chart element that only draws (an empty block after it): never failed' };
  }
}

export function listenerCase(kind: Kind, hazard: Hazard, seed: number): SimCase {
  const id = `keyboard-listeners/${kind}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const b = (ROUND4_FAIL as readonly string[]).includes(kind) || (ROUND4_PASS as readonly string[]).includes(kind) ? build4(kind as Round4Kind) : build(kind);
  const pg = parts('District report', `${filler(r, 1)}${b.body}${filler(r, 1)}<p><a href="/reports">All reports</a></p>`, [...CSS, ...(b.css ?? [])], [...b.init]);
  pg.head.push(...(b.head ?? []));
  Object.assign(pg.files, b.files ?? {});
  applyHazard(pg, hazard, r);
  const fails = ([...DECLARED, ...DRAWN, ...MISSED, ...ROUND2_FAIL, ...ROUND4_FAIL] as readonly string[]).includes(kind);
  const path = Object.entries({ ...ROUND2_PATHS, ...ROUND4_PATHS }).find(([, kinds]) => kinds.includes(kind))?.[0];
  return {
    id, test: 'keyboard-listeners', hazard, params: { kind, ...(path ? { path } : {}) },
    site: render(pg),
    expect: { '2.1.1': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: b.why,
  };
}

export function listenerCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  // 102 failing pages (60 the page declares as controls, 30 drawings a click works, 12 with no sign but a listener or
  // a handler) and 96 passing ones (72 drawings that only draw, 24 with a listener nobody uses); fix round 2: 180
  // failing and 144 passing pages over its five decision paths (`ROUND2_PATHS`, 60 or more pages each).
  // Round 4: 96 failing and 150 passing pages over its four decision paths (`ROUND4_PATHS`, 60 or more pages each).
  for (const kind of [...DECLARED, ...DRAWN, ...MISSED, ...SURFACES, ...LISTED, ...ROUND2_FAIL, ...ROUND2_PASS, ...ROUND4_FAIL, ...ROUND4_PASS]) for (const hazard of HAZARDS) out.push(listenerCase(kind, hazard, seed));
  return out;
}

export const keyboardListenersTest: SimTest = {
  id: 'keyboard-listeners', criteria: ['2.1.1'], probes: () => [keyboardProbe], full: false, read: 'probe', readProbes: ['keyboard'], capMs: 90_000, cases: listenerCases,
};
