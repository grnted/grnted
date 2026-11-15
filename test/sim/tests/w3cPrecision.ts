// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// W3C precision lane (2026-11-11): the five decision paths the W3C ACT test cases showed failing what the scan had not
// shown to fail, each as a lab of generated pages whose answer is known by construction (at least 59 counted cases per
// path, real-site-like ones included). Every page is independently written here: no ACT page, class, string or
// structure is copied.
//
// - aria-defaults (4.1.2; axe and the ARIA states test): a required ARIA state with a resting default the browser uses
//   (aria-checked, a heading's aria-level, a combobox's aria-expanded) and an invalid aria-hidden misstate nothing: pass.
//   A missing value (slider, scrollbar, meter, focusable separator), an expanded combobox with no aria-controls and any
//   other invalid value still fail (F68-like: the state or value cannot be determined).
// - table-caption (1.3.1; axe): a header cell across the first row over the column headers is a column group header:
//   pass. A data cell across the first row used as the table's title fails (its title is not programmatically the
//   table's). A header cell across the first row that only titles the table: 'any' (a caption is better; whether it
//   fails is an auditor's call).
// - link-context (2.4.4; the link-purpose test): a generic link with no word of its own around it fails; one in a
//   sentence that names its destination passes; one with a few words of its own ("about the EU", "Agenda:") passes for
//   a careful auditor (the engine may say not tested, which is never a failure); kind-only names ("Open") each with a
//   label of their own pass, two after one heading with only a file's type and size around them fail.
// - skip-control (2.4.1; the keyboard test): pages with no main landmark and no headings. A skip button whose script
//   puts focus on the content, or sets the fragment to it, passes; one that does nothing, only scrolls, or focuses a
//   place before the navigation fails; a skip-named submit button in a form is never pressed and is no skip control
//   (the page still fails: nothing bypasses its blocks). Pages with a main landmark pass.
// - forced-focus (2.4.7; the keyboard test and the deep forced-colours test): an indicator drawn with a box shadow, a
//   background or a border colour shows in normal colours: pass (a contrast theme removing it is a recommendation).
//   No indicator at all fails.
import { forcedColorsProbe } from '../../../src/probes/forcedColors.js';
import { keyboardProbe } from '../../../src/probes/keyboard/index.js';
import { linkPurposeProbe } from '../../../src/probes/linkPurpose.js';
import { ariaStatesProbe } from '../../../src/probes/ariaStates.js';
import { formFieldsProbe } from '../../../src/probes/forms.js';
import { headingsProbe } from '../../../src/probes/headings.js';
import { namesProbe } from '../../../src/probes/names.js';
import { screenReaderLiveProbe, screenReaderProbe } from '../../../src/probes/screenReader/index.js';
import { hash, rng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';

const P: Expectation = { verdict: 'pass' };
const F: Expectation = { verdict: 'fail', count: 1 };
const A: Expectation = { verdict: 'any' };

/** The hazards these labs use (each keeps the answer): none, a late mount, a cookie banner, a web-font-like reflow, a busy page. */
const HAZARDS: readonly Hazard[] = ['none', 'late-mount', 'cookie-banner', 'font-swap', 'animation-in-flight'];

const BASE_CSS = 'body { margin: 0; font: 16px/1.5 sans-serif; color: #1b1b1b; background: #fff; } .wrap { padding: 0 24px; } a { color: #00376d; } a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; } button { font: inherit; padding: 6px 12px; color: #fff; background: #00376d; border: 2px solid #00376d; } .topbar a { display: inline-block; margin-right: 12px; padding: 8px 4px; }';

/**
 * A whole page. `landmarks`: wrap the content in <main> with an h1 (most cases); without, the page has no main landmark
 * and no headings (bypass cases). The hazard is applied here, never touching the subject's answer.
 */
function page(opts: { title: string; body: string; css?: string; script?: string; landmarks?: boolean; before?: string; hazard: Hazard; seed: number }): string {
  const r = rng(opts.seed);
  let body = opts.body;
  let script = opts.script ?? '';
  const css = [BASE_CSS, opts.css ?? ''];
  let after = '';
  let before = opts.before ?? '';
  switch (opts.hazard) {
    case 'late-mount': {
      const ms = Math.round(800 + r() * 900);
      after += `<template id="late">${body}</template>`;
      body = '<div id="app"><p>Loading…</p></div>';
      script = `setTimeout(function () { document.getElementById('app').innerHTML = document.getElementById('late').innerHTML; ${script} }, ${ms});`;
      break;
    }
    case 'cookie-banner':
      after += '<div class="cookies" role="region" aria-label="Cookie notice"><p>This site uses cookies to remember your choices.</p><button type="button" onclick="this.parentNode.remove()">Accept</button></div>';
      css.push('.cookies { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 24px; display: flex; gap: 16px; align-items: center; background: #1b1b1b; color: #fff; } .cookies p { margin: 0; color: #fff; } .cookies button { background: #fff; color: #000; border-color: #fff; } .cookies button:focus-visible { outline: 3px solid #ffbf47; } body { padding-bottom: 80px; }');
      break;
    case 'font-swap':
      css.push('body { letter-spacing: 0.01em; } .wrap { max-width: 56rem; }');
      before = `<p class="notice">Office hours change on holidays.</p>${before}`;
      break;
    case 'animation-in-flight':
      after += '<div class="strip" aria-hidden="true"></div>';
      css.push('.strip { height: 12px; width: 40%; background: #2b5797; animation: slide 2s ease-out both; } @keyframes slide { from { transform: translateX(-100%); } to { transform: none; } }');
      break;
    default:
      break;
  }
  const content = opts.landmarks === false
    ? `${before}${body}`
    : `${before}<main id="main" class="wrap"><h1>${opts.title}</h1>\n${body}\n</main>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${opts.title}</title>
<style>${css.join('\n')}</style></head>
<body>
${content}
${after}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

function make(test: string, kind: string, rep: number, hazard: Hazard, seed: number, html: string, expect: Record<string, Expectation>, why: string, params: Record<string, string | number | boolean> = {}): SimCase {
  return { id: `${test}/${kind}/${rep}/${hazard}`, test, params: { kind, ...params }, hazard, site: { files: { '/': html } }, expect, why };
}

/** Spread `reps` repeats of each kind over the hazards. */
function spread<K extends string>(test: string, kinds: readonly K[], reps: (k: K) => number, build: (k: K, rep: number, hazard: Hazard, seed: number) => SimCase, seed: number, hazards: readonly Hazard[] = HAZARDS): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const k of kinds) for (let rep = 0; rep < reps(k); rep++) out.push(build(k, rep, hazards[i++ % hazards.length]!, seed));
  return out;
}
/** The keyboard labs' hazards: the pages load at once (a late mount is the same page once it loads). */
const STILL_HAZARDS: readonly Hazard[] = ['none', 'cookie-banner', 'font-swap', 'animation-in-flight'];

const LABELS = ['Email me the agenda', 'Include weekend events', 'Show closed facilities', 'Large print', 'Notify me of changes', 'Only open branches'];

// ---------------------------------------------------------------------------------------------------------------
// aria-defaults (4.1.2)

const ARIA_KINDS = [
  // pass: a resting default, nothing misstated
  'checkbox-no-checked', 'checkbox-toggles-later', 'radio-no-checked', 'switch-no-checked', 'menuitemcheckbox-no-checked', 'menuitemradio-no-checked',
  'heading-no-level', 'combobox-collapsed-no-expanded', 'combobox-disabled-no-expanded', 'aria-hidden-yes-icon', 'aria-hidden-1-decoration', 'aria-hidden-hidden-text',
  'checkbox-with-checked', 'combobox-full',
  // fail: no value, or a value misstated
  'slider-no-value', 'scrollbar-no-value', 'meter-no-value', 'separator-no-value', 'combobox-expanded-no-controls', 'expanded-invalid', 'pressed-invalid', 'checked-invalid', 'hidden-and-invalid-other',
] as const;
type AriaKind = (typeof ARIA_KINDS)[number];

const ARIA_EXPECT: Record<AriaKind, [Expectation, string]> = {
  'checkbox-no-checked': [P, 'role=checkbox with no aria-checked, shown unchecked: reads as not checked, which it is'],
  'checkbox-toggles-later': [P, 'role=checkbox with no aria-checked at rest; its script sets aria-checked when pressed'],
  'radio-no-checked': [P, 'radios with no aria-checked, none shown selected'],
  'switch-no-checked': [P, 'role=switch with no aria-checked, shown off'],
  'menuitemcheckbox-no-checked': [P, 'a checkable menu item with no aria-checked, shown unticked'],
  'menuitemradio-no-checked': [P, 'a radio menu item with no aria-checked, shown unselected'],
  'heading-no-level': [P, 'role=heading with no aria-level: level 2, under the page h1'],
  'combobox-collapsed-no-expanded': [P, 'a combobox with no aria-expanded and no popup shown: collapsed'],
  'combobox-disabled-no-expanded': [P, 'a disabled combobox showing a fixed value, no aria-expanded'],
  'aria-hidden-yes-icon': [P, 'aria-hidden="yes" on a decorative icon: the browser exposes it as shown'],
  'aria-hidden-1-decoration': [P, 'aria-hidden="1" (a framework boolean) on a decorative glyph'],
  'aria-hidden-hidden-text': [P, 'aria-hidden="hidden" on a visible tagline'],
  'checkbox-with-checked': [P, 'a custom checkbox with aria-checked="false"'],
  'combobox-full': [P, 'a combobox with aria-expanded="false" and aria-controls'],
  'slider-no-value': [F, 'role=slider with no aria-valuenow: no value to determine'],
  'scrollbar-no-value': [F, 'role=scrollbar with aria-controls but no aria-valuenow'],
  'meter-no-value': [F, 'role=meter with no aria-valuenow'],
  'separator-no-value': [F, 'a focusable role=separator (a splitter) with no aria-valuenow'],
  'combobox-expanded-no-controls': [F, 'a combobox that says it is expanded with no aria-controls to its list'],
  'expanded-invalid': [F, 'aria-expanded="yes" on a disclosure button: no state is exposed'],
  'pressed-invalid': [F, 'aria-pressed="maybe" on a toggle button'],
  'checked-invalid': [F, 'aria-checked="yes" on a custom checkbox'],
  'hidden-and-invalid-other': [F, 'aria-hidden="yes" and aria-expanded="nope" on one button'],
};

function ariaSubject(kind: AriaKind, r: () => number): { html: string; script?: string; css?: string } {
  const label = LABELS[Math.floor(r() * LABELS.length)]!;
  const box = '.cb { display: inline-block; width: 24px; height: 24px; border: 2px solid #1b1b1b; vertical-align: middle; margin-right: 8px; } .cb[aria-checked=true]::before { content: "\\2713"; display: block; text-align: center; line-height: 20px; }';
  switch (kind) {
    case 'checkbox-no-checked': return { html: `<p><span class="cb" role="checkbox" tabindex="0" aria-labelledby="l1"></span><span id="l1">${label}</span></p>`, css: box };
    case 'checkbox-toggles-later': return {
      html: `<form action="/prefs" method="get"><p><span class="cb" id="cb" role="checkbox" tabindex="0" aria-labelledby="l1"></span><span id="l1">${label}</span></p></form>`, css: box,
      script: "var cb=document.getElementById('cb');function t(){cb.setAttribute('aria-checked',cb.getAttribute('aria-checked')==='true'?'false':'true');}cb.addEventListener('click',t);cb.addEventListener('keydown',function(e){if(e.key===' '){e.preventDefault();t();}});",
    };
    case 'radio-no-checked': return { html: '<div role="radiogroup" aria-labelledby="g"><p id="g">Pickup</p><span class="cb" role="radio" tabindex="0" aria-label="Curbside"></span> Curbside <span class="cb" role="radio" tabindex="-1" aria-label="At the desk"></span> At the desk</div>', css: box };
    case 'switch-no-checked': return { html: `<p><span class="cb" role="switch" tabindex="0" aria-label="${label}"></span>${label}</p>`, css: box };
    case 'menuitemcheckbox-no-checked': return { html: '<div role="menu" aria-label="View"><div role="menuitemcheckbox" tabindex="0">Show weekends</div><div role="menuitem" tabindex="-1">Print</div></div>' };
    case 'menuitemradio-no-checked': return { html: '<div role="menu" aria-label="Calendar view"><div role="menuitemradio" tabindex="0">Month</div><div role="menuitemradio" tabindex="-1">Week</div></div>' };
    case 'heading-no-level': return { html: '<div role="heading" class="sub">Council agenda</div><p>The council meets on the first Tuesday of the month in the chambers at City Hall.</p>', css: '.sub { font-size: 22px; font-weight: bold; }' };
    case 'combobox-collapsed-no-expanded': return { html: '<label id="bl">Branch</label> <div role="combobox" tabindex="0" aria-labelledby="bl" class="sel">North</div>', css: '.sel { display: inline-block; min-width: 160px; padding: 6px; border: 2px solid #595959; }' };
    case 'combobox-disabled-no-expanded': return { html: '<label id="bl">Region</label> <div role="combobox" aria-disabled="true" aria-labelledby="bl" class="sel">East</div>', css: '.sel { display: inline-block; min-width: 160px; padding: 6px; border: 2px solid #767676; color: #4a4a4a; }' };
    case 'aria-hidden-yes-icon': return { html: '<p><span aria-hidden="yes">☎</span> Call the front desk at 555-0144.</p>' };
    case 'aria-hidden-1-decoration': return { html: '<ul class="facts"><li><span class="dot" aria-hidden="1">•</span> Open seven days a week</li><li><span class="dot" aria-hidden="1">•</span> Free parking</li></ul>', css: '.facts { list-style: none; padding: 0; }' };
    case 'aria-hidden-hidden-text': return { html: '<p class="tag" aria-hidden="hidden">Serving the valley since 1952</p><p>Welcome to the district office.</p>' };
    case 'checkbox-with-checked': return { html: `<p><span class="cb" role="checkbox" tabindex="0" aria-checked="false" aria-labelledby="l1"></span><span id="l1">${label}</span></p>`, css: box };
    case 'combobox-full': return { html: '<label id="bl">Branch</label> <div role="combobox" tabindex="0" aria-labelledby="bl" aria-expanded="false" aria-controls="bl-list" class="sel">North</div><ul id="bl-list" role="listbox" aria-label="Branches" hidden><li role="option">North</li><li role="option">South</li></ul>', css: '.sel { display: inline-block; min-width: 160px; padding: 6px; border: 2px solid #595959; }' };
    case 'slider-no-value': return { html: '<p id="vl">Text size</p><div role="slider" tabindex="0" aria-labelledby="vl" class="track"></div>', css: '.track { width: 240px; height: 24px; border: 2px solid #595959; }' };
    case 'scrollbar-no-value': return { html: '<div id="pane" class="pane"><p>Minutes of the meeting, item one through twelve.</p></div><div role="scrollbar" aria-controls="pane" aria-label="Scroll the minutes" aria-orientation="vertical" class="bar"></div>', css: '.pane { height: 80px; overflow: hidden; border: 1px solid #767676; } .bar { width: 16px; height: 80px; background: #ddd; }' };
    case 'meter-no-value': return { html: '<p id="ml">Storage used</p><div role="meter" aria-labelledby="ml" class="meter"><span style="display:block;width:60%;height:100%;background:#00376d"></span></div>', css: '.meter { width: 240px; height: 16px; border: 1px solid #1b1b1b; }' };
    case 'separator-no-value': return { html: '<div class="split"><div class="side">Filters</div><div role="separator" tabindex="0" aria-label="Resize the filters" aria-orientation="vertical" class="handle"></div><div class="side">Results</div></div>', css: '.split { display: flex; } .side { padding: 8px; } .handle { width: 8px; background: #595959; }' };
    case 'combobox-expanded-no-controls': return { html: '<label id="bl">Library</label> <div role="combobox" tabindex="0" aria-labelledby="bl" aria-expanded="true" class="sel">Main</div><ul role="listbox" aria-label="Libraries"><li role="option">Main</li><li role="option">East</li></ul>', css: '.sel { display: inline-block; min-width: 160px; padding: 6px; border: 2px solid #595959; }' };
    case 'expanded-invalid': return { html: '<button type="button" aria-expanded="yes" aria-controls="faq">Parking questions</button><div id="faq"><p>Parking is free after 6 pm.</p></div>' };
    case 'pressed-invalid': return { html: '<button type="button" aria-pressed="maybe">Large print</button>' };
    case 'checked-invalid': return { html: `<p><span class="cb" role="checkbox" tabindex="0" aria-checked="yes" aria-labelledby="l1"></span><span id="l1">${label}</span></p>`, css: box };
    case 'hidden-and-invalid-other': return { html: '<button type="button" aria-hidden="yes" aria-expanded="nope" aria-controls="m">Menu</button><ul id="m"><li><a href="/a">Agendas</a></li></ul>' };
  }
}

function ariaCase(kind: AriaKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `aria-defaults/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const s = ariaSubject(kind, r);
  // Real-site-like surroundings: a form, a card or a toolbar around the subject, and ordinary content.
  const wraps = [(h: string) => `<section class="card"><h2>Preferences</h2>${h}</section>`, (h: string) => `<div class="toolbar">${h}</div>`, (h: string) => h];
  const body = `<p>Find services, hours and contacts for the district.</p>\n${wraps[rep % wraps.length]!(s.html)}\n<p><a href="/contact">Contact the office</a></p>`;
  const html = page({ title: 'Settings', body, css: `${s.css ?? ''} .card { border: 1px solid #767676; padding: 12px; } .card h2 { margin: 0 0 8px; font-size: 20px; }`, ...(s.script ? { script: s.script } : {}), hazard, seed: hash(id) });
  const [e, why] = ARIA_EXPECT[kind];
  return make('aria-defaults', kind, rep, hazard, seed, html, { '4.1.2': e }, why);
}

export const ariaDefaultsTest: SimTest = {
  // Every test of 4.1.2 a core scan runs, read as the customer sees the criterion.
  id: 'aria-defaults', criteria: ['4.1.2'], probes: () => [headingsProbe, ariaStatesProbe, namesProbe, screenReaderProbe, formFieldsProbe, screenReaderLiveProbe], full: false, read: 'criterion', capMs: 90_000,
  cases: (seed) => spread('aria-defaults', ARIA_KINDS, (k) => (ARIA_EXPECT[k][0].verdict === 'fail' ? 6 : 4), ariaCase, seed),
};

// ---------------------------------------------------------------------------------------------------------------
// table-caption (1.3.1)

const TABLE_KINDS = [
  'group-header-scope', 'group-header-headers', 'group-header-thead', 'two-groups-row', 'normal-header-row', 'caption-and-group',
  'th-title-only', 'th-title-with-caption',
  'td-title-bold', 'td-title-strong', 'td-title-class', 'th-role-cell-title', 'td-title-tbody',
] as const;
type TableKind = (typeof TABLE_KINDS)[number];
const TABLE_EXPECT: Record<TableKind, [Expectation, string]> = {
  'group-header-scope': [P, 'a th scope=colgroup across the first row over the column headers'],
  'group-header-headers': [P, 'a th across the first row named by the headers attributes of the cells below'],
  'group-header-thead': [P, 'a th across the first row of a thead over a second header row'],
  'two-groups-row': [P, 'a first row of two group headers (not one cell across the table)'],
  'normal-header-row': [P, 'an ordinary header row'],
  'caption-and-group': [P, 'a caption, then a th across the first row grouping the columns'],
  'th-title-only': [A, 'a th across the first row that only titles the table (a caption would be better)'],
  'th-title-with-caption': [A, 'a caption and a th title row repeating it'],
  'td-title-bold': [F, 'a bold td across the first row as the table title, header row below'],
  'td-title-strong': [F, 'a td with strong text across the first row as the title'],
  'td-title-class': [F, 'a td styled as a title (class) across the first row'],
  'th-role-cell-title': [F, 'a th given role=cell across the first row as the title'],
  'td-title-tbody': [F, 'a td title row in the tbody, header cells in the second row'],
};

function tableCase(kind: TableKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `table-caption/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const cols = 2 + Math.floor(r() * 3);
  const heads = ['Item', 'Fee', 'Due', 'Notes', 'Office'].slice(0, cols);
  const rows = [['Permit', '$40', 'May', 'Online', 'Planning'], ['Renewal', '$20', 'June', 'In person', 'Clerk'], ['Inspection', '$65', 'July', 'Call ahead', 'Building']]
    .map((row) => `<tr>${row.slice(0, cols).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  const headRow = `<tr>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}</tr>`;
  const title = ['Fees for 2026', 'Permit schedule', 'Summer rates'][rep % 3]!;
  let table = '';
  switch (kind) {
    case 'group-header-scope': table = `<table><thead><tr><th scope="colgroup" colspan="${cols}">Charges this year</th></tr>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'group-header-headers': table = `<table><tr><th id="g" colspan="${cols}">Charges</th></tr><tr>${heads.map((h, i) => `<th id="h${i}" headers="g">${h}</th>`).join('')}</tr>${rows.replace(/<td>/g, '<td>')}</table>`; break;
    case 'group-header-thead': table = `<table><thead><tr><th colspan="${cols}">Charges this year</th></tr>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'two-groups-row': table = `<table><thead><tr><th colspan="1">Service</th><th colspan="${cols - 1}">Charges</th></tr>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'normal-header-row': table = `<table><thead>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'caption-and-group': table = `<table><caption>${title}</caption><thead><tr><th scope="colgroup" colspan="${cols}">Charges</th></tr>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'th-title-only': table = `<table><thead><tr><th colspan="${cols}">${title}</th></tr>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'th-title-with-caption': table = `<table><caption>${title}</caption><tr><th colspan="${cols}">${title}</th></tr>${headRow}${rows}</table>`; break;
    case 'td-title-bold': table = `<table><thead><tr><td colspan="${cols}"><b>${title}</b></td></tr>${headRow}</thead><tbody>${rows}</tbody></table>`; break;
    case 'td-title-strong': table = `<table><tr><td colspan="${cols}"><strong>${title}</strong></td></tr>${headRow}${rows}</table>`; break;
    case 'td-title-class': table = `<table><tr><td colspan="${cols}" class="ttl">${title}</td></tr>${headRow}${rows}</table>`; break;
    case 'th-role-cell-title': table = `<table><tr><th role="cell" colspan="${cols}">${title}</th></tr>${headRow}${rows}</table>`; break;
    case 'td-title-tbody': table = `<table><tbody><tr><td colspan="${cols}"><b>${title}</b></td></tr>${headRow}${rows}</tbody></table>`; break;
  }
  const body = `<p>What the city charges for common requests.</p>\n${table}\n<p>Fees are due when you apply.</p>`;
  const html = page({ title: 'Fees', body, css: 'table { border-collapse: collapse; } th, td { border: 1px solid #767676; padding: 4px 8px; text-align: left; } .ttl { font-weight: bold; font-size: 18px; } caption { text-align: left; font-weight: bold; }', hazard, seed: hash(id) });
  const [e, why] = TABLE_EXPECT[kind];
  return make('table-caption', kind, rep, hazard, seed, html, { '1.3.1': e }, why, { cols });
}

export const tableCaptionTest: SimTest = {
  // Every test of 1.3.1 a core scan runs, read as the customer sees the criterion.
  id: 'table-caption', criteria: ['1.3.1'], probes: () => [headingsProbe, ariaStatesProbe, namesProbe, screenReaderProbe, formFieldsProbe, screenReaderLiveProbe], full: false, read: 'criterion', capMs: 90_000,
  cases: (seed) => spread('table-caption', TABLE_KINDS, (k) => ({ any: 2, fail: 11, pass: 9, na: 9 })[TABLE_EXPECT[k][0].verdict], tableCase, seed),
};

// ---------------------------------------------------------------------------------------------------------------
// link-context (2.4.4)

const LINK_KINDS = [
  // pass for a careful auditor (the engine: pass, or not tested)
  'sentence-names-it', 'few-words-acronym', 'few-words-one', 'list-label-view', 'cell-label-download', 'description-one-word',
  'kind-labelled-blocks', 'kind-labelled-after-heading', 'heading-then-sentence', 'aria-label',
  // fail: no word of its own
  'alone-in-div', 'arrow-only', 'generic-words-only', 'number-only', 'date-only', 'two-kind-filesize-after-heading', 'separator-pair', 'card-title-block-apart',
] as const;
type LinkKind = (typeof LINK_KINDS)[number];
const LINK_EXPECT: Record<LinkKind, [Expectation, string]> = {
  'sentence-names-it': [P, 'a "Read more" in a sentence that names the destination'],
  'few-words-acronym': [P, '"Read more about the ADA" in a div: the words of its own say where it goes'],
  'few-words-one': [P, '"Learn more about recycling" in a block'],
  'list-label-view': [P, 'a list of documents: "Agenda: View", "Minutes: View"'],
  'cell-label-download': [P, 'a table of forms: each "Download" in a row whose first cell names the form in one word'],
  'description-one-word': [P, 'a "Details" link described by a one-word label (aria-describedby)'],
  'kind-labelled-blocks': [P, 'two "Open" links, each after its own one-word label'],
  'kind-labelled-after-heading': [P, 'two "Open" links after one heading, each after its own one-word label'],
  'heading-then-sentence': [P, 'a heading that names the topic, then a "Read more" link alone'],
  'aria-label': [P, 'a "Read more" whose aria-label names its destination'],
  'alone-in-div': [F, 'a "Read more" alone in its own div, its title in a separate block'],
  'arrow-only': [F, 'a "Read more" with only an arrow beside it'],
  'generic-words-only': [F, 'a "Click here" followed by "to see more"'],
  'number-only': [F, 'a "More" with only a count beside it'],
  'date-only': [F, 'a "Read more" with only a date beside it, under a one-word heading'],
  'two-kind-filesize-after-heading': [F, 'two "Download" links after one heading, each beside only "(PDF, n MB)", to different files'],
  'separator-pair': [F, 'two "Click here" links separated by a dot, nothing else'],
  'card-title-block-apart': [F, 'news cards: the link in a footer div, the title in another div (not a heading)'],
};

function linkCase(kind: LinkKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `link-context/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const topic = ['recycling', 'parking', 'composting', 'permits', 'transit'][Math.floor(r() * 5)]!;
  let html = '';
  switch (kind) {
    case 'sentence-names-it': html = `<p>The council adopted the new ${topic} plan on Tuesday after a public hearing. <a href="/news/${topic}">Read more</a></p>`; break;
    case 'few-words-acronym': html = `<div><a href="/ada">Read more</a> about the ADA</div><div><a href="/eu">Read more</a> about the EU</div>`; break;
    case 'few-words-one': html = `<div class="teaser"><a href="/${topic}">Learn more</a> about ${topic}</div>`; break;
    case 'list-label-view': html = '<ul class="docs"><li>Agenda: <a href="/files/agenda.pdf">View</a></li><li>Minutes: <a href="/files/minutes.pdf">View</a></li><li>Budget: <a href="/files/budget.pdf">View</a></li></ul>'; break;
    case 'cell-label-download': html = '<table><tr><th scope="col">Form</th><th scope="col">File</th></tr><tr><td>Registration</td><td><a href="/f/reg.pdf">Download</a></td></tr><tr><td>Waiver</td><td><a href="/f/waiver.pdf">Download</a></td></tr></table>'; break;
    case 'description-one-word': html = `<div><span id="d1">${topic[0]!.toUpperCase()}${topic.slice(1)}</span> <a href="/${topic}" aria-describedby="d1">Details</a></div>`; break;
    case 'kind-labelled-blocks': html = '<p class="file">Menus: <a href="/menus">Open</a></p><p class="file">Handbooks: <a href="/handbooks">Open</a></p>'; break;
    case 'kind-labelled-after-heading': html = '<h2>Board papers for this year</h2><div>Budget <a href="/b.pdf">Open</a></div><div>Minutes <a href="/m.pdf">Open</a></div>'; break;
    case 'heading-then-sentence': html = `<h2>Spring ${topic} drive</h2><div><a href="/${topic}">Read more</a></div>`; break;
    case 'aria-label': html = `<div><a href="/${topic}" aria-label="Read more about ${topic} in the city">Read more</a></div>`; break;
    case 'alone-in-div': html = `<div class="card"><div class="t">${topic} update</div><div class="foot"><a href="/${topic}">Read more</a></div></div>`; break;
    case 'arrow-only': html = `<div class="more"><a href="/${topic}">Read more</a> »</div>`; break;
    case 'generic-words-only': html = `<div><a href="/${topic}">Click here</a> to see more</div>`; break;
    case 'number-only': html = `<p><a href="/${topic}">More</a> (12)</p>`; break;
    case 'date-only': html = `<h2>News</h2><div>Nov 3 <a href="/${topic}">Read more</a></div>`; break;
    case 'two-kind-filesize-after-heading': html = '<h2>Board papers for this year</h2><p><a href="/a.pdf">Download</a> (PDF, 1 MB)</p><p><a href="/b.pdf">Download</a> (PDF, 2 MB)</p>'; break;
    case 'separator-pair': html = '<p><a href="/map">Click here</a> · <a href="/timetable">Click here</a></p>'; break;
    case 'card-title-block-apart': html = `<div class="cards"><div class="card"><div class="t">Road work on Main Street</div><div class="foot"><a href="/n/1">Read more</a></div></div><div class="card"><div class="t">${topic} survey opens</div><div class="foot"><a href="/n/2">Read more</a></div></div></div>`; break;
  }
  const body = `<p>The latest from city departments and programs.</p>\n${html}\n<p>Questions? <a href="/contact">Contact the city clerk</a> during office hours.</p>`;
  const page2 = page({ title: 'City updates', body, css: '.card { border: 1px solid #767676; padding: 8px; margin: 8px 0; } .t { font-weight: bold; } table { border-collapse: collapse; } th, td { border: 1px solid #767676; padding: 4px 8px; }', hazard, seed: hash(id) });
  const [e, why] = LINK_EXPECT[kind];
  return make('link-context', kind, rep, hazard, seed, page2, { '2.4.4': e }, why);
}

export const linkContextTest: SimTest = {
  id: 'link-context', criteria: ['2.4.4'], probes: () => [linkPurposeProbe, screenReaderProbe], full: false, read: 'criterion', capMs: 90_000,
  cases: (seed) => spread('link-context', LINK_KINDS, (k) => (LINK_EXPECT[k][0].verdict === 'fail' ? 7 : 6), linkCase, seed),
};

// ---------------------------------------------------------------------------------------------------------------
// skip-control (2.4.1)

const SKIP_KINDS = [
  'button-focuses-content', 'button-sets-hash', 'role-button-sets-hash', 'input-button-focuses', 'button-with-main', 'skip-intro-with-main', 'link-and-button',
  'button-does-nothing', 'button-scrolls-only', 'button-focuses-nav', 'button-submit-in-form', 'no-bypass-at-all',
] as const;
type SkipKind = (typeof SKIP_KINDS)[number];
const SKIP_EXPECT: Record<SkipKind, [Expectation, string]> = {
  'button-focuses-content': [P, 'a "Skip to main content" button whose script focuses the content (tabindex=-1)'],
  'button-sets-hash': [P, 'a skip button whose script sets the fragment to the content'],
  'role-button-sets-hash': [P, 'a role=button skip control (Enter and Space) that sets the fragment'],
  'input-button-focuses': [P, 'an input type=button "Skip navigation" that focuses the content'],
  'button-with-main': [P, 'a working skip button on a page that also has a main landmark'],
  'skip-intro-with-main': [P, 'a "Skip intro" button that does nothing, on a page with a main landmark and headings'],
  'link-and-button': [P, 'a skip button that does nothing and a working skip link'],
  'button-does-nothing': [F, 'a "Skip to main content" button with no script, nothing else to bypass the blocks'],
  'button-scrolls-only': [F, 'a skip button that only scrolls the content into view: keyboard focus stays in the navigation'],
  'button-focuses-nav': [F, 'a skip button that focuses the navigation, before the repeated links'],
  'button-submit-in-form': [F, 'a skip-named submit button in a form (never pressed), nothing else to bypass the blocks'],
  'no-bypass-at-all': [F, 'no skip control, no main landmark, no headings'],
};

function skipCase(kind: SkipKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `skip-control/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const n = 4 + Math.floor(r() * 4);
  const nav = `<div class="topbar" id="nav">${['Home', 'Services', 'Parks', 'Permits', 'News', 'Events', 'Jobs', 'Contact'].slice(0, n).map((x) => `<a href="/${x.toLowerCase()}">${x}</a>`).join('')}</div>`;
  const content = '<div id="content" tabindex="-1" class="wrap"><div class="big">Trash and recycling</div><p>Carts go to the curb by 7 in the morning on your pickup day. Holiday weeks move pickup one day later.</p><p>See the <a href="/recycling/guide">sorting guide</a> for what goes where.</p></div>';
  const hidden = 'style="position:absolute;left:-999px" onfocus="this.style.position=\'static\'" onblur="this.style.position=\'absolute\'"';
  let before = '';
  let landmarks = false;
  let script = '';
  let body = `${nav}\n${content}`;
  switch (kind) {
    case 'button-focuses-content': before = `<button type="button" id="skip" ${rep % 2 ? hidden : ''}>Skip to main content</button>`; script = "document.getElementById('skip').addEventListener('click',function(){document.getElementById('content').focus();});"; break;
    case 'button-sets-hash': before = '<button type="button" id="skip">Skip to content</button>'; script = "document.getElementById('skip').addEventListener('click',function(){location.hash='content';});"; break;
    case 'role-button-sets-hash': before = '<span role="button" tabindex="0" id="skip" class="sk">Skip navigation</span>'; script = "var s=document.getElementById('skip');function go(){location.hash='content';}s.addEventListener('click',go);s.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});"; break;
    case 'input-button-focuses': before = '<input type="button" id="skip" value="Skip navigation">'; script = "document.getElementById('skip').addEventListener('click',function(){document.getElementById('content').focus();});"; break;
    case 'button-with-main': before = '<button type="button" id="skip">Skip to main content</button>'; body = `${nav}\n<main id="main" tabindex="-1">${content}</main>`; script = "document.getElementById('skip').addEventListener('click',function(){document.getElementById('main').focus();});"; break;
    case 'skip-intro-with-main': before = '<button type="button" id="intro">Skip intro</button>'; body = `${nav}\n<main><h1>Trash and recycling</h1>${content}</main>`; landmarks = false; break;
    case 'link-and-button': before = '<button type="button">Skip tour</button><a href="#content" class="sl">Skip to main content</a>'; break;
    case 'button-does-nothing': before = '<button type="button" id="skip">Skip to main content</button>'; break;
    case 'button-scrolls-only': before = '<button type="button" id="skip">Skip to main content</button>'; script = "document.getElementById('skip').addEventListener('click',function(){document.getElementById('content').scrollIntoView();});"; break;
    case 'button-focuses-nav': before = '<button type="button" id="skip">Skip to main content</button>'; script = "document.getElementById('skip').addEventListener('click',function(){document.querySelector('#nav a').focus();});"; break;
    case 'button-submit-in-form': before = '<form action="/survey" method="post" class="survey"><button id="skip">Skip this step</button></form>'; break;
    case 'no-bypass-at-all': break;
  }
  const html = page({ title: 'Trash and recycling', body, before, script, landmarks, css: '.big { font-size: 24px; font-weight: bold; } .sk { display: inline-block; padding: 6px 12px; border: 2px solid #00376d; } .sl { display: inline-block; padding: 6px; }', hazard, seed: hash(id) });
  const [e, why] = SKIP_EXPECT[kind];
  return make('skip-control', kind, rep, hazard, seed, html, { '2.4.1': e }, why, { links: n });
}

export const skipControlTest: SimTest = {
  id: 'skip-control', criteria: ['2.4.1'], probes: () => [keyboardProbe], full: false, read: 'criterion', capMs: 90_000,
  cases: (seed) => spread('skip-control', SKIP_KINDS, (k) => (SKIP_EXPECT[k][0].verdict === 'fail' ? 11 : 8), skipCase, seed, STILL_HAZARDS),
};

// ---------------------------------------------------------------------------------------------------------------
// forced-focus (2.4.7, deep)

const FOCUS_KINDS = ['shadow-ring', 'shadow-inset', 'background-change', 'border-color', 'underline-and-color', 'outline-solid', 'outline-transparent-shadow', 'no-indicator', 'no-indicator-buttons', 'no-indicator-custom'] as const;
type FocusKind = (typeof FOCUS_KINDS)[number];
const FOCUS_EXPECT: Record<FocusKind, [Expectation, string]> = {
  'shadow-ring': [P, 'outline none, a 3 px box-shadow ring: visible in normal colours (a contrast theme removes it: a recommendation)'],
  'shadow-inset': [P, 'outline none, an inset box-shadow of 3 px'],
  'background-change': [P, 'outline none, the colours swap on focus (a dark fill on a link, a white fill on a dark button)'],
  'border-color': [P, 'outline none, a 3 px border that turns dark on focus'],
  'underline-and-color': [P, 'outline none, a thick underline and a dark background on focus'],
  'outline-solid': [P, 'a solid 3 px outline'],
  'outline-transparent-shadow': [P, 'a transparent outline and a box-shadow ring (a contrast theme draws the outline)'],
  'no-indicator': [F, 'outline none on links, nothing else changes on focus'],
  'no-indicator-buttons': [F, 'outline none on the buttons (the links keep theirs), nothing else changes on focus'],
  'no-indicator-custom': [F, 'custom controls (role=button, tabindex=0) with outline none and nothing else on focus'],
};

function focusCase(kind: FocusKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `forced-focus/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const color = ['#00376d', '#6b0099', '#7a1f00'][Math.floor(r() * 3)]!;
  // Only the page's own content is styled (#main): a hazard's own controls (a cookie banner's button) keep their indicator.
  const tags = kind === 'no-indicator-buttons' ? ['button'] : rep % 2 ? ['a', 'button'] : ['a'];
  const sel = (suffix = '') => tags.map((t) => `#main ${t}${suffix}`).join(', ');
  const off = `${sel()} { outline: none !important; } ${sel(':focus')}, ${sel(':focus-visible')} { outline: none !important; }`;
  // A colour change that differs from each element's own look: links on white get a dark fill, buttons (dark) a white one.
  const fill = tags.map((t) => (t === 'a' ? `#main a:focus-visible { background: ${color}; color: #fff; }` : `#main button:focus-visible { background: #fff; color: ${color}; }`)).join(' ');
  let css = '';
  switch (kind) {
    case 'shadow-ring': css = `${off} ${sel(':focus-visible')} { box-shadow: 0 0 0 3px ${color}; }`; break;
    case 'shadow-inset': css = `${off} ${sel(':focus-visible')} { box-shadow: inset 0 0 0 3px ${color}; }`; break;
    case 'background-change': css = `${off} ${fill}`; break;
    case 'border-color': css = `${off} #main a, #main button { border: 3px solid transparent; } ${sel(':focus-visible')} { border-color: ${color}; }`; break;
    case 'underline-and-color': css = `${off} ${sel(':focus-visible')} { background: #ffe066; color: #1b1b1b; text-decoration-thickness: 3px; }`; break;
    case 'outline-solid': css = `${sel(':focus-visible')} { outline: 3px solid ${color} !important; outline-offset: 2px; }`; break;
    case 'outline-transparent-shadow': css = `${sel(':focus-visible')} { outline: 3px solid transparent !important; box-shadow: 0 0 0 3px ${color}; }`; break;
    case 'no-indicator': css = '#main a, #main button { outline: none !important; } #main a:focus, #main a:focus-visible, #main button:focus-visible { outline: none !important; }'; break;
    case 'no-indicator-buttons': css = '#main button { outline: none !important; } #main button:focus-visible { outline: none !important; }'; break;
    case 'no-indicator-custom': css = '#main a, #main button, #main [tabindex] { outline: none !important; } #main a:focus-visible, #main button:focus-visible, #main [tabindex]:focus-visible { outline: none !important; }'; break;
  }
  const body = `<nav aria-label="Main" class="topbar"><a href="/a">Agendas</a><a href="/b">Budget</a><a href="/c">Calendar</a></nav>
<p>The board meets twice a month. <a href="/meetings">Meeting times</a> are posted a week ahead.</p>
<p><button type="button">Print this page</button> <button type="button">Share</button></p>${kind === 'no-indicator-custom' ? '\n<p><span role="button" tabindex="0" class="chip">Subscribe</span> <span role="button" tabindex="0" class="chip">Map</span></p>' : ''}`;
  const html = page({ title: 'Board meetings', body, css: `#main a, #main button { padding: 4px 8px; } ${css}`, hazard, seed: hash(id) });
  const [e, why] = FOCUS_EXPECT[kind];
  return make('forced-focus', kind, rep, hazard, seed, html, { '2.4.7': e }, why);
}

export const forcedFocusTest: SimTest = {
  id: 'forced-focus', criteria: ['2.4.7'], probes: () => [keyboardProbe, forcedColorsProbe], full: true, read: 'criterion', capMs: 120_000,
  cases: (seed) => spread('forced-focus', FOCUS_KINDS, (k) => (FOCUS_EXPECT[k][0].verdict === 'fail' ? 18 : 8), focusCase, seed, STILL_HAZARDS),
};
