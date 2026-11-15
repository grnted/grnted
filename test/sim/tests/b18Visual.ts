// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane (docs/atlas/visual.md, section 8): the simulation lab's cases for the lane's new decision paths,
// generated across the atlas's variant and look-alike space (never around the training pages). The answer is decided
// by construction, from the colours, sizes and markup each case is built from:
// - b18-focus-truth (2.4.7; D7 to D9): an indicator drawn in the colour behind it, cut by clip-path, removed only in
//   one region (scoped by place, not by markup), or a stop under content laid over it fails; one that changes pixels
//   (also faintly: 2.4.7 asks for visible, 1.4.11 for contrast) passes;
// - b18-color-modes (1.4.3, 1.4.11; D0 to D2): text and field borders in the dark scheme or theme a page defines;
// - b18-colour-only (1.4.1; D10, D11): states told apart from their peers by colour alone, and link cues that paint;
// - b18-chart-marks (1.4.11; D12): the data of inline SVG charts;
// - b18-clip-sweep (1.4.4, 1.4.12; D4): boxes that lose text at some window widths only;
// - b18-lost-narrow (1.4.10; D6): prose removed at 320 px;
// - b18-state-text (1.4.3; D13, D14): text a timer shows and text in regions a control opens.
import { readFileSync } from 'node:fs';
import { keyboardProbe } from '../../../src/probes/keyboard/index.js';
import { textContrastProbe } from '../../../src/probes/textContrast.js';
import { nonTextContrastProbe } from '../../../src/probes/nonTextContrast.js';
import { linkColorProbe } from '../../../src/probes/linkColor.js';
import { resizeTextProbe } from '../../../src/probes/resizeText.js';
import { textSpacingProbe } from '../../../src/probes/textSpacing.js';
import { reflowProbe } from '../../../src/probes/reflow.js';
import { stateTextProbe } from '../../../src/probes/stateText.js';
import { hexOf, ratio, solve, type Rgb } from '../color.js';
import { applyHazard, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'late-mount', 'font-swap', 'sticky-header', 'smooth-scroll', 'none', 'lazy-images', 'cookie-banner'];
const hz = (i: number) => HAZARDS[i % HAZARDS.length]!;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function make(test: string, idParts: (string | number)[], hazard: Hazard, seed: number, body: string, css: string[], init: string[], expect: SimCase['expect'], why: string, extra?: (p: ReturnType<typeof parts>) => void): SimCase {
  const id = `${test}/${idParts.join('/')}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const pg = parts('Community services', body, css, init);
  extra?.(pg);
  applyHazard(pg, hazard, r);
  return { id, test, hazard, params: Object.fromEntries(idParts.map((v, i) => [`p${i}`, v])), site: render(pg), expect, why };
}

// ---------------------------------------------------------------------------------------------
// b18-focus-truth (2.4.7)

const INDICATORS = ['outline', 'offset-outline', 'shadow-ring', 'border', 'background', 'underline'] as const;
const BACKDROPS = ['same', 'near', 'strong'] as const;
const SCOPES = ['global', 'footer-reset'] as const;
const OBSTACLES = ['none', 'clip-path', 'laid-over'] as const;

function focusRule(ind: (typeof INDICATORS)[number], c: string): string {
  switch (ind) {
    case 'outline': return `outline: 2px solid ${c}; outline-offset: 0;`;
    case 'offset-outline': return `outline: 3px solid ${c}; outline-offset: 3px;`;
    case 'shadow-ring': return `outline: none; box-shadow: 0 0 0 3px ${c};`;
    case 'border': return `outline: none; border-color: ${c};`;
    case 'background': return `outline: none; background: ${c};`;
    case 'underline': return `outline: none; text-decoration: underline; text-decoration-color: ${c}; text-decoration-thickness: 3px;`;
  }
}

export function focusTruthCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const band: Rgb = [16, 40, 63];
  for (const ind of INDICATORS) for (const back of BACKDROPS) for (const scope of SCOPES) {
    // The ring colour against the white page: the same white, a near white (visible, faint), or a strong blue.
    const ring = back === 'same' ? '#ffffff' : back === 'near' ? '#dcdcdc' : '#0b4fb3';
    const css = [
      `a.sub, button.sub { color: #1a4f8b; background: #fff; border: 2px solid #fff; text-decoration: none; padding: 4px 8px; font: 16px Arial, sans-serif; }`,
      `a.sub:focus, button.sub:focus { ${focusRule(ind, ring)} }`,
      `footer { margin-top: 40px; border-top: 1px solid #999; padding: 12px 24px; }`,
      scope === 'footer-reset' ? 'footer a.sub:focus { outline: none; box-shadow: none; border-color: #fff; background: #fff; text-decoration: none; }' : '',
    ];
    const body = `<p><a class="sub" href="/one">Apply for a permit</a></p><p><a class="sub" href="/two">Pay a bill</a></p>`;
    const fails = back === 'same' || scope === 'footer-reset';
    out.push(make('b18-focus-truth', [ind, back, scope], hz(i++), seed, body, css, [], { '2.4.7': { verdict: fails ? 'fail' : 'pass' } },
      fails ? (scope === 'footer-reset' ? 'the footer link loses every focus cue (a reset scoped to the footer)' : 'the indicator is drawn in the colour behind it')
        : `the indicator changes pixels (${back === 'near' ? 'faintly' : 'clearly'})`,
      (p) => { p.after.push(`<footer><a class="sub" href="/privacy">Privacy</a> <a class="sub" href="/terms">Terms</a></footer>`); }));
  }
  // Obstacles: the ring cut by the element's own clip-path, or the control under a panel laid over it; a band look-alike.
  for (const ind of ['outline', 'offset-outline', 'shadow-ring', 'border'] as const) for (const ob of OBSTACLES) for (const onBand of [false, true]) {
    const ringColour = onBand ? '#ffffff' : '#0b4fb3';
    const bg = onBand ? hexOf(band) : '#ffffff';
    const css = [
      `.zone { background: ${bg}; padding: 24px; position: relative; min-height: 80px; }`,
      `.zone a.sub { color: ${onBand ? '#fff' : '#1a4f8b'}; padding: 4px 8px; font: 16px Arial, sans-serif; border: 2px solid ${bg}; ${ob === 'clip-path' ? 'display: inline-block; clip-path: inset(0);' : ''} }`,
      `.zone a.sub:focus { ${focusRule(ind, ringColour)} }`,
      ob === 'laid-over' ? `.panel { position: absolute; inset: 0; background: ${bg}; z-index: 2; padding: 24px; color: ${onBand ? '#fff' : '#222'}; }` : '',
    ];
    const body = `<div class="zone"><a class="sub" href="/a">Report a concern</a>${ob === 'laid-over' ? '<div class="panel">Service desk: answers within five days.</div>' : ''}</div>`;
    // An outline (even at offset 0) and a shadow ring lie outside the border box, which clip-path: inset(0) keeps; a border is inside it.
    const fails = ob !== 'none' && !(ob === 'clip-path' && ind === 'border');
    out.push(make('b18-focus-truth', [ind, `obstacle-${ob}`, onBand ? 'band' : 'white'], hz(i++), seed, body, css, [],
      { '2.4.7': { verdict: fails ? 'fail' : 'pass' } },
      ob === 'none' ? 'a ring that shows (a white ring on a dark band is visible)' : ob === 'laid-over' ? 'the control is entirely under content laid over it' : ind === 'border' ? 'a border lies inside the clip: still visible' : 'the ring lies outside the element\'s own clip-path'));
  }
  // Backdrops and elements: the same ring is drawn in the colour behind it (fails) or in a contrasting one (passes).
  for (const ind of INDICATORS) for (const el of ['link', 'button'] as const) for (const back of ['#ffffff', '#f0f0f0', '#10283f'] as const) for (const visible of [false, true]) {
    const dark = back === '#10283f';
    const ring = visible ? (dark ? '#ffffff' : '#0b4fb3') : back;
    const css = [
      `.zone { background: ${back}; padding: 24px; }`,
      `.zone .sub { color: ${dark ? '#ffffff' : '#1a4f8b'}; background: ${back}; border: 2px solid ${back}; padding: 4px 8px; font: 16px Arial, sans-serif; text-decoration: none; }`,
      `.zone .sub:focus { ${focusRule(ind, ring)} }`,
    ];
    const ctl = el === 'link' ? '<a class="sub" href="/apply">Apply online</a>' : '<button class="sub" type="button">Show the fees</button>';
    out.push(make('b18-focus-truth', [ind, 'backdrop', back.slice(1), el, visible ? 'contrasting' : 'same'], hz(i++), seed, `<div class="zone">${ctl}</div>`, css, [],
      { '2.4.7': { verdict: visible ? 'pass' : 'fail' } }, visible ? 'the indicator contrasts with the backdrop' : 'the indicator is drawn in the colour of the backdrop'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// b18-color-modes (1.4.3, 1.4.11)

const MODES = ['prefers-dark', 'toggle-attr', 'light-dark', 'theme-select', 'radio-has', 'none'] as const;
/** The control that switches a theme mode's page to dark, and the script behind it. */
const THEME_CTL: Record<string, { html: string; js: string[] }> = {
  'toggle-attr': { html: '<p><button id="theme" type="button">Dark mode</button></p>', js: ["document.getElementById('theme').addEventListener('click', () => { const d = document.documentElement; d.setAttribute('data-theme', d.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); });"] },
  'theme-select': { html: '<p><label for="theme-pick">Theme</label> <select id="theme-pick"><option value="light">Light</option><option value="dark">Dark</option></select></p>', js: ["document.getElementById('theme-pick').addEventListener('change', (e) => document.documentElement.setAttribute('data-theme', e.target.value));"] },
  'radio-has': { html: '<fieldset><legend>Theme</legend><input type="radio" name="th" id="th-light" checked><label for="th-light">Light</label> <input type="radio" name="th" id="th-dark"><label for="th-dark">Dark</label></fieldset>', js: [] },
};
/** A dark-theme rule set for the theme modes that switch by attribute or by a checked radio. */
const themed = (mode: string, css: string) => mode === 'radio-has'
  ? css.replace(/(^|\} )([^{}]+?) \{/g, (_m, a: string, sel: string) => `${a}${sel.split(',').map((x) => `:root:has(#th-dark:checked) ${x.trim()}`).join(', ')} {`)
  : css.replace(/(^|\} )([^{}]+?) \{/g, (_m, a: string, sel: string) => `${a}${sel.split(',').map((x) => `html[data-theme="dark"] ${x.trim()}`).join(', ')} {`);
const DARK_BG: Rgb = [30, 30, 30];

export function colorModesCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const mode of MODES) for (const size of [16, 26] as const) for (const target of [2.2, 2.6, 2.8, 3.5, 3.9, 4.2, 4.8, 5.5, 7] as const) {
    const large = size >= 24;
    const threshold = large ? 3 : 4.5;
    const nominal = large ? target * (3 / 4.5) : target;
    const c = solve(DARK_BG, DARK_BG, WHITE, nominal, nominal >= threshold ? 'above' : 'below');
    const fg = hexOf(c.color);
    const bg = hexOf(DARK_BG);
    const darkCss = `body { background: ${bg}; color: #eeeeee; } .note { color: ${fg}; }`;
    const css = [`.note { font-size: ${size}px; color: #333333; }`, `#theme { font: 14px Arial; }`,
      mode === 'prefers-dark' ? `@media (prefers-color-scheme: dark) { ${darkCss} }`
        : THEME_CTL[mode] ? themed(mode, darkCss)
          : mode === 'light-dark' ? `:root { color-scheme: light dark; } body { background: light-dark(#ffffff, ${bg}); color: light-dark(#1b1b1b, #eeeeee); } .note { color: light-dark(#333333, ${fg}); }`
            : ''];
    const toggle = THEME_CTL[mode]?.js ?? [];
    const body = `${THEME_CTL[mode]?.html ?? ''}<p>Library cards are free for residents.</p><p class="note" id="note">Holiday hours are posted one week ahead.</p>`;
    const fails = mode !== 'none' && c.ratio < threshold;
    out.push(make('b18-color-modes', ['text', mode, size, target], hz(i++), seed, body, css, toggle,
      { '1.4.3': { verdict: fails ? 'fail' : 'pass' } },
      mode === 'none' ? 'the page defines no other presentation' : `${fg} on ${bg} is ${c.ratio.toFixed(2)}:1 in the ${mode} presentation (threshold ${threshold})`));
  }
  for (const mode of ['prefers-dark', 'toggle-attr', 'light-dark', 'theme-select', 'radio-has'] as const) for (const target of [1.6, 2.2, 2.6, 2.9, 3.4, 5] as const) for (const kind of ['input', 'textarea', 'select'] as const) {
    const c = solve(DARK_BG, DARK_BG, WHITE, target, target >= 3 ? 'above' : 'below');
    const bd = hexOf(c.color);
    const bg = hexOf(DARK_BG);
    const field = `#f { background: ${bg}; color: #eee; border-color: ${bd}; } body { background: ${bg}; color: #eee; }`;
    const css = ['#f { border: 2px solid #595959; padding: 6px; background: #fff; color: #111; font: inherit; }',
      mode === 'prefers-dark' ? `@media (prefers-color-scheme: dark) { ${field} }`
        : THEME_CTL[mode] ? themed(mode, field)
          : `:root { color-scheme: light dark; } body { background: light-dark(#fff, ${bg}); color: light-dark(#111, #eee); } #f { background: light-dark(#fff, ${bg}); color: light-dark(#111, #eee); border-color: light-dark(#595959, ${bd}); }`];
    const toggle = THEME_CTL[mode]?.js ?? [];
    const ctl = kind === 'input' ? '<input id="f" name="card">' : kind === 'textarea' ? '<textarea id="f" name="card" rows="2"></textarea>' : '<select id="f" name="card"><option>North branch</option><option>South branch</option></select>';
    const body = `${THEME_CTL[mode]?.html ?? ''}<p><label for="f">Library card number</label> ${ctl}</p>`;
    const fails = c.ratio < 3;
    out.push(make('b18-color-modes', ['field', mode, target, kind], hz(i++), seed, body, css, toggle, { '1.4.11': { verdict: fails ? 'fail' : 'pass' } },
      `the field border ${bd} on ${bg} is ${c.ratio.toFixed(2)}:1 in the ${mode} presentation`));
  }
  // Look-alikes: a dark section in a light page; a "dark" control that restyles one widget only.
  for (let k = 0; k < 8; k++) {
    out.push(make('b18-color-modes', ['lookalike', k], hz(i++), seed,
      k % 2 ? '<p><button id="n" type="button">Night map</button></p><div class="map"><p>Branch locations</p></div><p>Open daily.</p><p>Closed on holidays.</p>'
        : '<div style="background:#10283f;color:#fff;padding:16px"><p>Open daily from 9 a.m.</p></div>',
      k % 2 ? ['.map.night { background: #111; color: #444; }'] : [],
      k % 2 ? ["document.getElementById('n').addEventListener('click', () => document.querySelector('.map').classList.toggle('night'));"] : [],
      { '1.4.3': { verdict: 'pass' } }, 'no page presentation with low contrast'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// b18-colour-only (1.4.1)

const STATES = ['current', 'tab', 'pressed'] as const;
const DIFFS = ['hue', 'lightness', 'underline', 'bold', 'bar', 'nothing'] as const;

export function colourOnlyCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const st of STATES) for (const d of DIFFS) for (const k of [0, 1, 2]) {
    const peer = '#333333';
    const colour = d === 'lightness' ? '#9a9a9a' : d === 'nothing' ? peer : ['#1a5fb4', '#0b6e99', '#7a2e8e'][k]!;
    const extra = d === 'underline' ? 'text-decoration: underline;' : d === 'bold' ? 'font-weight: 700;' : d === 'bar' ? `box-shadow: inset 0 -3px 0 ${colour};` : '';
    const sel = st === 'current' ? 'nav a[aria-current]' : st === 'tab' ? '[role=tab][aria-selected=true]' : '.chips [aria-pressed=true]';
    const css = [
      'nav ul { list-style: none; display: flex; gap: 16px; padding: 0; } nav a { color: #333; text-decoration: none; }',
      '[role=tablist], .chips { display: flex; gap: 8px; } [role=tab], .chips button { border: 0; background: none; font: 16px Arial; color: #333; padding: 6px; }',
      `${sel} { color: ${colour}; ${extra} }`,
    ];
    const body = st === 'current'
      ? '<nav aria-label="Main"><ul><li><a href="/a">Parks</a></li><li><a href="/b" aria-current="page">Programs</a></li><li><a href="/c">Rentals</a></li></ul></nav>'
      : st === 'tab'
        ? '<div role="tablist"><button role="tab" aria-selected="false">Summer</button><button role="tab" aria-selected="true">Fall</button><button role="tab" aria-selected="false">Winter</button></div>'
        : '<div class="chips"><button aria-pressed="false">Indoor</button><button aria-pressed="true">Outdoor</button><button aria-pressed="false">Free</button></div>';
    const fails = d === 'hue';
    out.push(make('b18-colour-only', ['state', st, d, k], hz(i++), seed, body, css, [], { '1.4.1': { verdict: fails ? 'fail' : 'pass' } },
      fails ? `${colour} against ${peer} (${ratio(parseHex(colour), parseHex(peer)).toFixed(2)}:1) is the only difference` : d === 'nothing' ? 'no visible state at all (not a colour-only cue)' : `a cue besides hue: ${d}`));
  }
  // More states told apart by hue alone (the listbox option too), across hues, and their bold look-alikes.
  const HUES = ['#1a5fb4', '#0b6e99', '#7a2e8e', '#2e6b30', '#8a4b00', '#1d3557'];
  for (const st of ['current', 'tab', 'pressed', 'option'] as const) for (const [h, hue] of HUES.entries()) for (const cue of ['none', 'none-again', 'bold'] as const) {
    const sel = st === 'current' ? 'nav a[aria-current]' : st === 'tab' ? '[role=tab][aria-selected=true]' : st === 'pressed' ? '.chips [aria-pressed=true]' : '[role=option][aria-selected=true]';
    const css = [
      'nav ul { list-style: none; display: flex; gap: 16px; padding: 0; } nav a { color: #333; text-decoration: none; }',
      '[role=tablist], .chips { display: flex; gap: 8px; } [role=tab], .chips button { border: 0; background: none; font: 16px Arial; color: #333; padding: 6px; } [role=option] { padding: 8px; color: #333; }',
      `${sel} { color: ${hue}; ${cue === 'bold' ? 'font-weight: 700;' : ''} }`,
    ];
    const body = st === 'current'
      ? '<nav aria-label="Main"><ul><li><a href="/a">Parks</a></li><li><a href="/b" aria-current="page">Programs</a></li><li><a href="/c">Rentals</a></li></ul></nav>'
      : st === 'tab'
        ? '<div role="tablist"><button role="tab" aria-selected="false">Summer</button><button role="tab" aria-selected="true">Fall</button><button role="tab" aria-selected="false">Winter</button></div>'
        : st === 'pressed'
          ? '<div class="chips"><button aria-pressed="false">Indoor</button><button aria-pressed="true">Outdoor</button><button aria-pressed="false">Free</button></div>'
          : '<div role="listbox" aria-label="Delivery"><div role="option" tabindex="0" aria-selected="true">Collection</div><div role="option" tabindex="-1" aria-selected="false">Courier</div><div role="option" tabindex="-1" aria-selected="false">Post</div></div>';
    const r = ratio(parseHex(hue), parseHex('#333333'));
    const fails = cue !== 'bold' && r < 3;
    out.push(make('b18-colour-only', ['hue', st, h, cue], hz(i++), seed, body, css, [], { '1.4.1': { verdict: fails ? 'fail' : 'pass' } },
      fails ? `${hue} against #333333 (${r.toFixed(2)}:1) is the only difference` : cue === 'bold' ? 'bold as well as colour' : 'colours 3:1 or more apart'));
  }
  // Segmented controls: radio buttons hidden, each shown by its label; the checked label by hue only fails.
  for (const cue of ['hue', 'hue-again', 'bold', 'lightness'] as const) for (const rep of [0, 1, 2]) {
    const css = ['.seg input { position: absolute; opacity: 0; } .seg label { padding: 6px 10px; color: #333; }',
      `.seg input:checked + label { color: ${cue === 'lightness' ? '#9a9a9a' : '#1a5fb4'}; ${cue === 'bold' ? 'font-weight: 700;' : ''} }`];
    const body = `<div class="seg"><input type="radio" name="v${rep}" id="a${rep}"><label for="a${rep}">List</label><input type="radio" name="v${rep}" id="b${rep}" checked><label for="b${rep}">Map</label><input type="radio" name="v${rep}" id="c${rep}"><label for="c${rep}">Calendar</label></div>`;
    const fails = cue === 'hue' || cue === 'hue-again';
    out.push(make('b18-colour-only', ['segment', cue, rep], hz(i++), seed, body, css, [], { '1.4.1': { verdict: fails ? 'fail' : 'pass' } },
      fails ? 'the checked label differs by hue only' : cue === 'bold' ? 'bold as well' : 'colours 3:1 apart'));
  }
  const CUES = ['transparent-underline', 'zero-background', 'transparent-border', 'painted-underline', 'hover-underline'] as const;
  for (const cue of CUES) for (const link of ['#2d6aa0', '#0a7a4a'] as const) {
    const css = [`p a { color: ${link}; ${{
      'transparent-underline': 'text-decoration: underline; text-decoration-color: transparent;',
      'zero-background': 'text-decoration: none; background: linear-gradient(currentColor, currentColor) 0 100% / 0 1px no-repeat;',
      'transparent-border': 'text-decoration: none; border-bottom: 1px solid transparent;',
      'painted-underline': 'text-decoration: underline;',
      'hover-underline': 'text-decoration: underline; text-decoration-color: transparent;',
    }[cue]} }`, cue === 'hover-underline' ? 'p a:hover, p a:focus { text-decoration-color: currentColor; }' : '', 'body { color: #333; }'];
    const fails = cue === 'transparent-underline' || cue === 'zero-background' || cue === 'transparent-border';
    out.push(make('b18-colour-only', ['link', cue, link], hz(i++), seed,
      '<p>Picnic shelters can be reserved up to six months ahead. <a href="/rules">Read the shelter rules</a> before you book a large group.</p>', css, [],
      { '1.4.1': { verdict: fails ? 'fail' : 'pass' } }, fails ? 'the cue paints nothing and the link is under 3:1 from the text' : 'a painted cue (at rest, or on hover and focus)'));
  }
  // Round 3: an underline bar a pseudo-element draws counts only when something of it shows at rest (not cut away by
  // clip-path, not scaled to nothing).
  const PSEUDO_CUES = ['clip-hidden', 'scale-hidden', 'clip-circle-zero', 'drawn', 'clip-shows', 'clip-rounded-shows'] as const;
  for (const cue of PSEUDO_CUES) for (const link of ['#2d6aa0', '#0a7a4a'] as const) for (const rep of [0, 1, 2]) {
    const bar = 'content: ""; position: absolute; left: 0; right: 0; bottom: -2px; height: 2px; background: currentColor;';
    const hide = {
      'clip-hidden': 'clip-path: inset(0 100% 0 0);', 'scale-hidden': 'transform: scaleX(0);', 'clip-circle-zero': 'clip-path: circle(0);',
      drawn: '', 'clip-shows': 'clip-path: inset(0);', 'clip-rounded-shows': 'clip-path: inset(0 0 0 0 round 1px);',
    }[cue];
    const p = rep === 1 ? '::after' : '::before';
    const css = [`p a { color: ${link}; text-decoration: none; position: relative; } p a${p} { ${bar} ${hide} }`, 'body { color: #333; }'];
    const fails = cue === 'clip-hidden' || cue === 'scale-hidden' || cue === 'clip-circle-zero';
    out.push(make('b18-colour-only', ['pseudo', cue, link, rep], hz(i++), seed,
      '<p>Picnic shelters can be reserved up to six months ahead. <a href="/rules">Read the shelter rules</a> before you book a large group.</p>', css, [],
      { '1.4.1': { verdict: fails ? 'fail' : 'pass' } }, fails ? 'the bar is cut away or scaled to nothing at rest and the link is under 3:1 from the text' : 'a bar that shows at rest'));
  }
  return out;
}

function parseHex(h: string): Rgb {
  const m = h.replace('#', '').match(/../g)!.map((x) => parseInt(x, 16));
  return [m[0]!, m[1]!, m[2]!];
}

// ---------------------------------------------------------------------------------------------
// b18-chart-marks (1.4.11)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const LINE = '60,120 135,80 210,100 285,40 360,70 435,30';
const VALUES = [42, 61, 55, 88, 70, 93];

export function chartCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const axes = `<line x1="40" y1="10" x2="40" y2="170" stroke="#333"/><line x1="40" y1="170" x2="460" y2="170" stroke="#333"/>${MONTHS.map((m, k) => `<text x="${60 + k * 75}" y="190" font-size="12" fill="#333">${m}</text>`).join('')}${[0, 50, 100].map((v, k) => `<text x="5" y="${170 - k * 70}" font-size="12" fill="#333">${v}</text>`).join('')}`;
  for (const kind of ['line', 'bars', 'area'] as const) for (const target of [1.4, 2.5, 3.3, 5] as const) for (const cue of ['none', 'labels', 'table', 'markers'] as const) for (const hue of (cue === 'none' ? [0, 1, 2] : [0]) as number[]) {
    const darks: Rgb[] = [BLACK, [0, 60, 120], [120, 20, 0]];
    const c = solve(WHITE, darks[hue]!, WHITE, target, target >= 3 ? 'above' : 'below');
    const col = hexOf(c.color);
    const marks = kind === 'line' ? `<polyline points="${LINE}" fill="none" stroke="${col}" stroke-width="2"/>`
      : kind === 'bars' ? [120, 80, 100, 40, 70, 30].map((y, k) => `<rect x="${50 + k * 75}" y="${y}" width="40" height="${170 - y}" fill="${col}"/>`).join('')
        : `<path d="M60 170 L60 120 L135 80 L210 100 L285 40 L360 70 L435 30 L435 170 Z" fill="${col}"/>`;
    const labels = cue === 'labels' ? LINE.split(' ').map((p, k) => { const [x, y] = p.split(','); return `<text x="${Number(x) - 8}" y="${Number(y) - 8}" font-size="11" fill="#222">${VALUES[k]}</text>`; }).join('') : '';
    const markers = cue === 'markers' && kind === 'line' ? LINE.split(' ').map((p) => { const [x, y] = p.split(','); return `<circle cx="${x}" cy="${y}" r="4" fill="#1f4e79"/>`; }).join('') : '';
    const table = cue === 'table' ? `<table><tr><th>Month</th><th>Use</th></tr>${MONTHS.map((m, k) => `<tr><td>${m}</td><td>${VALUES[k]}</td></tr>`).join('')}</table>` : '';
    const body = `<figure><figcaption>Monthly water use</figcaption><svg role="img" aria-label="Monthly water use" width="480" height="200" viewBox="0 0 480 200">${axes}${marks}${labels}${markers}</svg>${table}</figure>`;
    const cued = cue === 'labels' || cue === 'table' || (cue === 'markers' && kind === 'line');
    const fails = c.ratio < 3 && !cued;
    out.push(make('b18-chart-marks', [kind, target, cue, hue], hz(i++), seed, body, [], [], { '1.4.11': { verdict: fails ? 'fail' : 'pass' } },
      fails ? `the ${kind} is ${c.ratio.toFixed(2)}:1 on white with no values in text` : c.ratio >= 3 ? 'the data has 3:1' : `the values are given otherwise (${cue})`));
  }
  // More faint series (no values in text) across kinds, faintness and hues.
  for (const kind of ['line', 'bars', 'area'] as const) for (const target of [1.2, 1.8, 2.2, 2.8] as const) for (const hue of [0, 1, 2]) {
    const darks: Rgb[] = [BLACK, [0, 60, 120], [120, 20, 0]];
    const c = solve(WHITE, darks[hue]!, WHITE, target, 'below');
    const col = hexOf(c.color);
    const marks = kind === 'line' ? `<polyline points="${LINE}" fill="none" stroke="${col}" stroke-width="3"/>`
      : kind === 'bars' ? [110, 70, 90, 50, 60, 20].map((y, k) => `<rect x="${50 + k * 75}" y="${y}" width="40" height="${170 - y}" fill="${col}"/>`).join('')
        : `<path d="M60 170 L60 110 L135 70 L210 90 L285 50 L360 60 L435 20 L435 170 Z" fill="${col}"/>`;
    out.push(make('b18-chart-marks', ['more', kind, target, hue], hz(i++), seed,
      `<figure><figcaption>Lunch orders</figcaption><svg role="img" aria-label="Lunch orders" width="480" height="200" viewBox="0 0 480 200">${axes}${marks}</svg></figure>`, [], [],
      { '1.4.11': { verdict: 'fail' } }, `the ${kind} is ${c.ratio.toFixed(2)}:1 on white with no values in text`));
  }
  // Bars drawn as rectangular paths; a series that is faint only in the page's dark scheme.
  for (const variant of ['path-bars', 'dark-only'] as const) for (const faint of [true, false]) for (const rep of [0, 1, 2]) {
    const body = variant === 'path-bars'
      ? `<figure><figcaption>Visits</figcaption><svg role="img" aria-label="Visits" width="480" height="200" viewBox="0 0 480 200">${axes}${[120, 80, 100, 40, 70, 30].map((y, k) => `<path d="M${50 + k * 75} 170V${y}H${90 + k * 75}V170Z" fill="${faint ? '#e3e9ef' : '#1f4e79'}"/>`).join('')}</svg></figure>`
      : `<figure><figcaption>Riders</figcaption><svg role="img" aria-label="Riders" width="480" height="200" viewBox="0 0 480 200">${axes}<polyline class="s" points="${LINE}" fill="none" stroke="#1f4e79" stroke-width="2"/></svg></figure>`;
    const css = variant === 'dark-only' ? [`@media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #eee; } .s { stroke: ${faint ? '#2e2e2e' : '#9ec5ff'}; } svg line { stroke: #aaa; } svg text { fill: #eee; } }`] : [];
    out.push(make('b18-chart-marks', [variant, faint ? 'faint' : 'strong', rep], hz(i++), seed, body, css, [], { '1.4.11': { verdict: faint ? 'fail' : 'pass' } },
      faint ? (variant === 'path-bars' ? 'faint bars drawn as rectangular paths' : 'a series faint only in the dark scheme') : 'the data has 3:1'));
  }
  const DECOR = [
    '<svg aria-hidden="true" width="600" height="120" viewBox="0 0 600 120"><path d="M0 60 C 150 0, 300 120, 600 40" fill="none" stroke="#eef2f5" stroke-width="6"/></svg>',
    '<svg aria-hidden="true" width="300" height="200" viewBox="0 0 300 200"><path d="M40 100 C 40 20, 260 20, 260 100 S 40 180, 40 100 Z" fill="#f2f5f8"/></svg>',
    `<svg role="img" aria-label="Grid" width="480" height="200" viewBox="0 0 480 200">${axes}${[40, 80, 120].map((y) => `<line x1="40" y1="${y}" x2="460" y2="${y}" stroke="#eeeeee"/>`).join('')}<polyline points="${LINE}" fill="none" stroke="#1f4e79" stroke-width="2"/></svg>`,
    '<svg role="img" aria-label="How a permit moves" width="480" height="160" viewBox="0 0 480 160"><rect x="10" y="50" width="120" height="50" fill="#fff" stroke="#333"/><text x="20" y="80">Apply</text><path d="M130 75 C 170 40, 200 110, 240 75" fill="none" stroke="#dddddd"/><rect x="240" y="50" width="120" height="50" fill="#fff" stroke="#333"/><text x="250" y="80">Review</text></svg>',
  ];
  for (const [k, d] of DECOR.entries()) for (let rep = 0; rep < 3; rep++) {
    out.push(make('b18-chart-marks', ['lookalike', k, rep], hz(i++), seed, d, [], [], { '1.4.11': { verdict: 'pass' } }, 'decoration, gridlines or a diagram whose text carries it'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// b18-clip-sweep (1.4.4, 1.4.12)

const TEXT = 'Move parked vehicles before 8 a.m. and keep the block clear until the crew has removed its signs.';

export function clipSweepCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const base = 'main { max-width: 1100px; margin: 0 auto; } .box { height: 96px; overflow: hidden; padding: 0 8px; border: 1px solid #777; font-family: Arial, sans-serif; } .box p { margin: 0; line-height: 24px; }';
  // print-cut / print-whole: a Print button near the box (the resize test's rule: whole lines hidden in a box with a
  // control near it are never failed, a line cut through still is). Whole lines need a box two lines of 48 px tall.
  const ZOOM = ['band-720', 'band-480', 'band-580', 'band-800', 'band-960', 'none', 'scrolls', 'min-height', 'read-more', 'print-cut', 'print-whole'] as const;
  for (const z of ZOOM) for (const h of [96, 100] as const) for (const k of [0, 1, 2, 3, 4]) {
    if (z === 'print-whole' && h !== 96) continue;
    const band = z === 'band-720' || z === 'print-cut' ? '@media (min-width: 700px) and (max-width: 760px) { .box p { font-size: 22px; line-height: 40px; } }'
      : z === 'print-whole' ? '@media (min-width: 700px) and (max-width: 760px) { .box p { font-size: 22px; line-height: 48px; } }'
      : z === 'band-480' ? '@media (min-width: 460px) and (max-width: 500px) { .box p { font-size: 22px; line-height: 40px; } }'
        : z === 'band-580' ? '@media (min-width: 560px) and (max-width: 600px) { .box p { font-size: 22px; line-height: 40px; } }'
          : z === 'band-800' ? '@media (min-width: 780px) and (max-width: 820px) { .box p { font-size: 22px; line-height: 40px; } }'
            : z === 'band-960' ? '@media (min-width: 940px) and (max-width: 980px) { .box p { font-size: 22px; line-height: 40px; } }' : '';
    const style = z === 'scrolls' ? 'overflow: auto;' : z === 'min-height' ? 'height: auto; min-height: 96px;' : '';
    const pad = ['', ' Signs stay up until noon.', ' Bins go out after six.', '', ' Call ahead.'][k]!;
    // With no breakpoint the text is one sentence, which fits the box at every width from 400 px up; the others hold two,
    // which the box cannot hold at 200% in narrow windows, so they are kept for the cases where that is the point.
    const text = z === 'none' ? `${TEXT}${pad}` : `${TEXT} ${TEXT}${pad}`;
    const after = z === 'read-more' ? '<a href="/full">Read more</a>' : z.startsWith('print-') ? '<p><button type="button" onclick="print()">Print page</button></p>' : '';
    const body = `<aside class="box" style="height:${h}px;${style}"><p>${text}</p></aside>${after}`;
    const fails = z.startsWith('band-') || z === 'print-cut';
    out.push(make('b18-clip-sweep', ['zoom', z, h, k], hz(i++), seed, body, [base, band], [], { '1.4.4': { verdict: fails ? 'fail' : 'pass' } },
      fails ? 'a breakpoint between the tested widths makes the box too small at 200% zoom' : z === 'print-whole' ? 'only whole lines are hidden, in a box with a control near it' : `no width loses text (${z})`));
  }
  // narrow-at-1440: a breakpoint above the spacing test's own 1280 px makes the box narrow; max-height: the box's height
  // is a maximum, not a height.
  const SPACING = ['narrow-at-1024', 'narrow-at-1440', 'max-height', 'max-height-1440', 'fits', 'scrolls', 'tall'] as const;
  for (const s of SPACING) for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    const fails = s.startsWith('narrow-') || s.startsWith('max-height');
    const narrow = s.endsWith('1440') ? '@media (min-width: 1400px) { .note { width: 200px; } }' : s === 'fits' ? '' : '@media (max-width: 1100px) { .note { width: 200px; } }';
    const size = s.startsWith('max-height') ? 'height: auto; max-height: 108px;' : `height: ${s === 'tall' ? 220 : 108}px;`;
    const css = [base, `.note { width: 520px; ${size} ${s === 'scrolls' ? 'overflow: auto;' : ''} }`, narrow];
    // The failing variants hold the one sentence that fits a 200 px box without the spacing (a longer text is cut there
    // already, which is not the spacing's doing); the look-alikes vary their text.
    const body = `<section class="box note"><p>${TEXT}${fails ? '' : ['', ' Bins go out after six.', '', ' Call ahead.', ''][k % 5]}</p></section>`;
    out.push(make('b18-clip-sweep', ['spacing', s, k], hz(i++), seed, body, css, [], { '1.4.12': { verdict: fails ? 'fail' : 'pass' } },
      fails ? `the spacing cuts the box at ${s.endsWith('1440') ? 1440 : 1024} px wide (${s})` : `the text keeps fitting (${s})`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// b18-lost-narrow (1.4.10)

const NOTICE = 'The budget question session begins at 4:15 p.m. on December 9 in the district meeting room.';

export function lostNarrowCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const place of ['card', 'aside', 'header', 'nav'] as const) for (const eq of [false, true]) for (const control of [false, true]) for (const rep of [0, 1, 2, 3]) {
    if (place === 'nav' && rep > 1) continue;
    const block = `<p class="desk-only" id="desk${rep}">${NOTICE}</p>`;
    const wrapped = control ? `<h2><button aria-expanded="false" aria-controls="acc">Office arrangements</button></h2><div id="acc" class="desk-only">${block.replace(' class="desk-only"', '')}</div>` : block;
    const container = place === 'card' ? `<section class="card">${wrapped}</section>` : place === 'aside' ? `<aside class="card">${wrapped}</aside>` : place === 'header' ? `<header>${wrapped}</header>` : `<nav aria-label="Notices">${wrapped}</nav>`;
    const css = ['.card { border: 1px solid #999; padding: 12px; margin: 12px 0; }', '.mobile { display: none; }', '@media (max-width: 700px) { .desk-only { display: none; } .mobile { display: block; } }'];
    const body = `<p>The proposed budget will be posted in May for public comment by residents.</p>${container}${eq ? `<p class="mobile">${NOTICE}</p>` : ''}`;
    const fails = (place === 'card' || place === 'aside') && !eq && !control;
    out.push(make('b18-lost-narrow', [place, eq ? 'equivalent' : 'unique', control ? 'control' : 'no-control', rep], hz(i++), seed, body, css, [], { '1.4.10': { verdict: fails ? 'fail' : 'pass' } },
      fails ? 'unique prose removed below 700 px with no control' : `kept reachable (${place}${eq ? ', same words at 320 px' : ''}${control ? ', a button shows it' : ''})`));
  }
  // More removed prose: hidden on a wrapping block, on the section, or at a 600 px breakpoint; with and without an
  // unrelated link in the section (a link is not a control that shows it).
  for (const how of ['wrapper', 'section', 'bp600'] as const) for (const link of [false, true]) for (const rep of [0, 1, 2]) {
    const css = ['.card { border: 1px solid #999; padding: 12px; margin: 12px 0; }', how === 'bp600' ? '@media (max-width: 600px) { .gone { display: none; } }' : '@media (max-width: 700px) { .gone { display: none; } }'];
    const prose = `<p>${NOTICE} Bring a photo identification card to the front desk.</p>`;
    const inner = how === 'wrapper' ? `<div class="gone">${prose}</div>` : prose;
    const section = how === 'section' ? `<section class="card gone"><h2>Office arrangements</h2>${inner}</section>` : `<section class="card"><h2>Office arrangements</h2>${how === 'bp600' ? prose.replace('<p>', '<p class="gone">') : inner}${link ? '<p><a href="/contact">Contact the office</a></p>' : ''}</section>`;
    out.push(make('b18-lost-narrow', ['more', how, link ? 'link' : 'no-link', rep], hz(i++), seed, `<p>The proposed budget will be posted in May for public comment by residents.</p>${section}`, css, [],
      { '1.4.10': { verdict: 'fail' } }, `unique prose removed at 320 px (${how}${link ? ', an unrelated link beside it' : ''})`));
  }
  for (const holder of ['article', 'div', 'figure', 'main'] as const) for (const bp of [600, 700, 800] as const) for (const rep of [0, 1, 2]) {
    const css = ['.card { border: 1px solid #999; padding: 12px; margin: 12px 0; }', `@media (max-width: ${bp}px) { .gone${rep} { display: none; } }`];
    const prose = `<p class="gone${rep}">${NOTICE} Parking is free in the lot behind the hall.</p>`;
    const block = holder === 'main' ? prose : holder === 'figure' ? `<figure class="card"><figcaption>${prose.replace('<p', '<span').replace('</p>', '</span>')}</figcaption></figure>` : `<${holder} class="card">${prose}</${holder}>`;
    out.push(make('b18-lost-narrow', ['holder', holder, bp, rep], hz(i++), seed, `<p>The proposed budget will be posted in May for public comment by residents.</p>${block}`, css, [],
      { '1.4.10': { verdict: 'fail' } }, `unique prose removed below ${bp} px in a ${holder}`));
  }
  for (const how of ['visibility', 'visibility-height'] as const) for (const rep of [0, 1, 2]) {
    const css = ['.card { border: 1px solid #999; padding: 12px; margin: 12px 0; }', `@media (max-width: 700px) { .gone { visibility: hidden; ${how === 'visibility-height' ? 'height: 0; overflow: hidden;' : ''} } }`];
    out.push(make('b18-lost-narrow', ['vis', how, rep], hz(i++), seed, `<p>The proposed budget will be posted in May for public comment by residents.</p><section class="card"><p class="gone">${NOTICE} Seating is limited to forty people.</p></section>`, css, [],
      { '1.4.10': { verdict: 'fail' } }, 'unique prose hidden with visibility at 320 px'));
  }
  for (const k of [0, 1, 2]) for (const kind of ['links', 'picture']) {
    const css = ['@media (max-width: 700px) { .desk { display: none; } }'];
    const body = kind === 'links' ? '<ul class="desk"><li><a href="/a">Budget documents for the whole of this school year</a></li><li><a href="/b">Board meeting calendar and minutes archive</a></li></ul>'
      : '<div class="desk"><img alt="" width="120" height="80" src="data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27120%27 height=%2780%27/%3E"></div>';
    out.push(make('b18-lost-narrow', ['lookalike', kind, k], hz(i++), seed, `<p>The proposed budget will be posted in May for public comment by residents.</p>${body}`, css, [],
      { '1.4.10': { verdict: 'pass' } }, kind === 'links' ? 'links only (no prose)' : 'a picture, no text'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// b18-state-text (1.4.3, deep)

export function stateTextCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  const MENU = '<button id="m" aria-expanded="false" aria-controls="menu">Services</button><ul id="menu" class="menu" hidden><li><a href="/water">Water and sewer</a></li><li><a href="/roads">Roads</a></li></ul>';
  const TOGGLE = "document.getElementById('m').addEventListener('click', (e) => { const b = e.currentTarget; const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); document.getElementById('menu').hidden = !open; }); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById('m').setAttribute('aria-expanded', 'false'); document.getElementById('menu').hidden = true; } });";
  for (const reveal of ['timer-3s', 'timer-6s', 'timer-1.5s', 'timer-9s', 'nested', 'menu', 'portal', 'details', 'popover', 'dialog'] as const) for (const target of [2.2, 3.9, 5.2, 8] as const) for (const rep of [0, 1, 2]) {
    const c = solve(WHITE, BLACK, WHITE, target, target >= 4.5 ? 'above' : 'below');
    const col = hexOf(c.color);
    const css = ['.menu { list-style: none; padding: 8px; border: 1px solid #888; background: #fff; }', `.late, .menu a, .portal a, details p { color: ${col}; }`, '.portal { position: absolute; top: 80px; left: 24px; background: #fff; border: 1px solid #888; padding: 8px; }'];
    let body = '<p>Check this page for water and road notices.</p>';
    const init: string[] = [];
    if (reveal.startsWith('timer') || reveal === 'nested') {
      body += '<p class="late" id="late" hidden>Crews will finish the repair by Friday afternoon.</p>';
      const ms = ({ 'timer-3s': 3000, 'timer-6s': 6000, 'timer-1.5s': 1500, 'timer-9s': 9000, nested: 2000 } as Record<string, number>)[reveal];
      init.push(reveal === 'nested'
        ? "setTimeout(() => setTimeout(() => { document.getElementById('late').hidden = false; }, 2000), 2000);"
        : `setTimeout(() => { document.getElementById('late').hidden = false; }, ${ms});`);
    } else if (reveal === 'dialog') {
      body += '<button id="o" type="button">Contact details</button><dialog id="dl"><p>Call the office on weekdays.</p><button id="x" type="button">Close</button></dialog>';
      css.push('dialog p { color: ' + col + '; }');
      init.push("document.getElementById('o').onclick = () => document.getElementById('dl').showModal(); document.getElementById('x').onclick = () => document.getElementById('dl').close();");
    } else if (reveal === 'popover') {
      body += '<button popovertarget="pop">Hours</button><div id="pop" popover><p>Closed on the fourth Thursday of November.</p></div>';
      css.push('#pop p { color: ' + col + '; }');
    } else if (reveal === 'menu') {
      body += MENU;
      init.push(TOGGLE);
    } else if (reveal === 'portal') {
      body += '<button id="p" aria-expanded="false" aria-haspopup="menu">Account</button>';
      init.push("document.getElementById('p').addEventListener('click', (e) => { e.currentTarget.setAttribute('aria-expanded', 'true'); const d = document.createElement('div'); d.className = 'portal'; d.innerHTML = '<a href=\"/sign-in\">Sign in to pay a bill</a>'; document.body.appendChild(d); });");
    } else {
      body += '<details><summary>Holiday hours</summary><p>Closed on the fourth Thursday of November.</p></details>';
    }
    const fails = c.ratio < 4.5;
    out.push(make('b18-state-text', [reveal, target, rep], hz(i++ * 3 + rep), seed, body, css, init, { '1.4.3': { verdict: fails ? 'fail' : 'pass' } },
      `${col} on white is ${c.ratio.toFixed(2)}:1 in text shown ${reveal.startsWith('timer') || reveal === 'nested' ? 'later' : 'when opened'}`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Every case answers for every criterion of its test: the ones it is not about are 'any'. */
const filled = (criteria: readonly string[], gen: (seed: number) => SimCase[]) => (seed: number): SimCase[] =>
  gen(seed).map((c) => ({ ...c, expect: Object.fromEntries(criteria.map((k) => [k, c.expect[k] ?? { verdict: 'any' as const }])) }));

export const b18FocusTruthTest: SimTest = { id: 'b18-focus-truth', criteria: ['2.4.7'], probes: () => [keyboardProbe], full: false, read: 'probe', readProbes: ['keyboard'], capMs: 150_000, cases: focusTruthCases };
export const b18ColorModesTest: SimTest = { id: 'b18-color-modes', criteria: ['1.4.3', '1.4.11'], probes: () => [textContrastProbe, nonTextContrastProbe], full: false, read: 'probe', readProbes: ['text-contrast', 'non-text-contrast'], capMs: 150_000, cases: filled(['1.4.3', '1.4.11'], colorModesCases) };
export const b18ColourOnlyTest: SimTest = { id: 'b18-colour-only', criteria: ['1.4.1'], probes: () => [linkColorProbe], full: false, read: 'probe', readProbes: ['link-color'], capMs: 120_000, cases: colourOnlyCases };
export const b18ChartTest: SimTest = { id: 'b18-chart-marks', criteria: ['1.4.11'], probes: () => [nonTextContrastProbe], full: false, read: 'probe', readProbes: ['non-text-contrast'], capMs: 120_000, cases: chartCases };
export const b18ClipSweepTest: SimTest = { id: 'b18-clip-sweep', criteria: ['1.4.4', '1.4.12'], probes: () => [resizeTextProbe, textSpacingProbe], full: false, read: 'probe', readProbes: ['resize-text', 'text-spacing'], capMs: 150_000, cases: filled(['1.4.4', '1.4.12'], clipSweepCases) };
export const b18LostNarrowTest: SimTest = { id: 'b18-lost-narrow', criteria: ['1.4.10'], probes: () => [reflowProbe], full: false, read: 'probe', readProbes: ['reflow'], capMs: 120_000, cases: lostNarrowCases };
export const b18StateTextTest: SimTest = { id: 'b18-state-text', criteria: ['1.4.3'], probes: () => [stateTextProbe], full: true, read: 'probe', readProbes: ['state-text-contrast'], capMs: 150_000, cases: stateTextCases };

// ---------------------------------------------------------------------------------------------
// Round 2 (blind grade, 2026-11-13): b18-drawn-controls (1.4.11) and b18-wide-text (1.4.10, 1.4.3)

/**
 * A web component with an open shadow root: its element for the body, and the script that defines it for the case's init
 * scripts (round 3: a script inside the body never ran when the late-mount hazard inserts the body by innerHTML, so
 * those cases had no subject at all).
 */
const SHADOW = (tag: string, inner: string) => ({
  el: `<${tag}></${tag}>`,
  init: `customElements.get('${tag}') || customElements.define('${tag}', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(inner)}; } });`,
});
/** Faint colours on white (about 1.2:1 to 2.6:1) and strong ones (4.5:1 and more). */
const FAINT = ['#e6e6e6', '#d6d6d6', '#c4c4c4', '#a8a8a8'] as const;
const STRONG = ['#767676', '#595959', '#333333'] as const;
const DRAWN = ['shadow-field', 'dots', 'range', 'tab-after', 'label-svg'] as const;

function drawn(kind: (typeof DRAWN)[number], colour: string, k: number): { body: string; css: string; init?: string } {
  const names = [['Street address', 'Find a stop'], ['Library card', 'Renew items'], ['Permit number', 'Look up a permit']][k % 3]!;
  switch (kind) {
    case 'shadow-field': {
      const c = SHADOW(`town-field-${k}`, `<style>label{display:block;margin:8px 0 4px}input{font:inherit;padding:6px;background:#fff;color:#222;border:2px solid ${colour}}</style><label for="f">${names[0]}</label><input id="f" name="f">`);
      return { body: c.el, css: '', init: c.init };
    }
    case 'dots':
      return {
        body: `<p>${names[1]}: three slides.</p><div class="dots">${[0, 1, 2].map((i) => `<button type="button" aria-label="Slide ${i + 1}"${i === 0 ? ' aria-current="true"' : ''}></button>`).join('')}</div>`,
        css: `.dots{display:flex;gap:12px}.dots button{width:${12 + (k % 3) * 2}px;height:${12 + (k % 3) * 2}px;border-radius:50%;border:0;padding:0;background:${colour}}.dots button[aria-current]{background:#1a1a1a}`,
      };
    case 'range':
      return {
        body: `<label for="r">${names[0]} radius</label> <input type="range" id="r" min="1" max="20" value="${4 + k}">`,
        css: `#r{-webkit-appearance:none;appearance:none;width:${200 + k * 20}px;height:8px;background:${colour};border-radius:4px}#r::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:${colour}}`,
      };
    case 'tab-after':
      return {
        body: `<div role="tablist" aria-label="${names[1]}"><button role="tab" aria-selected="true" class="t">Routes</button><button role="tab" aria-selected="false" class="t">Fares</button><button role="tab" aria-selected="false" class="t">Maps</button></div>`,
        css: `.t{position:relative;font:inherit;border:0;background:none;padding:8px 12px;color:#222}.t[aria-selected=true]::after{content:"";position:absolute;left:0;right:0;bottom:0;height:${3 + (k % 2)}px;background:${colour}}`,
      };
    case 'label-svg':
      return {
        body: `<fieldset><legend>${names[1]}</legend>${[0, 1].map((i) => `<span class="c"><input type="checkbox" id="c${i}"><label for="c${i}"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="18" height="18" rx="3" fill="#fff" stroke="${colour}" stroke-width="2"/></svg>Option ${i + 1}</label></span>`).join(' ')}</fieldset>`,
        css: '.c input{position:absolute;opacity:0;width:1px;height:1px}.c label{display:inline-flex;gap:6px;align-items:center}',
      };
  }
}

export function drawnControlCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of DRAWN) for (const c of FAINT) for (const k of [0, 1, 2]) {
    const d = drawn(kind, c, k);
    out.push(make('b18-drawn-controls', [kind, c.slice(1), k], hz(i++), seed, d.body, [d.css], d.init ? [d.init] : [], { '1.4.11': { verdict: 'fail' } }, `${kind} drawn in ${c} on white (under 3:1)`));
  }
  for (const kind of DRAWN) for (const c of STRONG) for (const k of [0, 1, 2, 3]) {
    const d = drawn(kind, c, k);
    out.push(make('b18-drawn-controls', [kind, c.slice(1), k], hz(i++), seed, d.body, [d.css], d.init ? [d.init] : [], { '1.4.11': { verdict: 'pass' } }, `${kind} drawn in ${c} on white (3:1 or more)`));
  }
  return out;
}

const NOTE = 'Ash Street is closed at the river bridge while the deck is replaced; use Mill Street until the spring.';

export function wideTextCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  // 1.4.10: text in a shadow root, or an unwrapped text area, wider than a 320 px window; look-alikes reflow.
  for (const kind of ['shadow-card', 'textarea'] as const) for (const w of [480, 600, 760] as const) for (const k of [0, 1, 2, 3, 4]) {
    const card = SHADOW(`road-card-${k}`, `<div style="width:${w}px;border:1px solid #767676;padding:8px"><p>${NOTE}</p></div>`);
    const body = kind === 'shadow-card' ? card.el
      : `<label for="t">Terms of use</label><textarea id="t" wrap="off" style="width:${w}px;font:inherit" rows="3">${NOTE} ${NOTE}</textarea>`;
    out.push(make('b18-wide-text', ['wide', kind, w, k], hz(i++), seed, body, [], kind === 'shadow-card' ? [card.init] : [], { '1.4.10': { verdict: 'fail' }, '1.4.3': { verdict: 'any' } }, `${kind} ${w} px wide at 320 px`));
  }
  for (const kind of ['shadow-card', 'textarea'] as const) for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    const card = SHADOW(`road-card-${k}`, `<div style="max-width:100%;border:1px solid #767676;padding:8px"><p>${NOTE}</p></div>`);
    const body = kind === 'shadow-card' ? card.el
      : `<label for="t">Terms of use</label><textarea id="t" style="width:100%;max-width:30rem;font:inherit" rows="3">${NOTE}</textarea>`;
    out.push(make('b18-wide-text', ['fits', kind, k], hz(i++), seed, body, [], kind === 'shadow-card' ? [card.init] : [], { '1.4.10': { verdict: 'pass' }, '1.4.3': { verdict: 'any' } }, `${kind} that reflows at 320 px`));
  }
  // 1.4.3: text a mid-width breakpoint recolours, and SVG text by its fill.
  for (const kind of ['mid-width', 'svg-text'] as const) for (const c of ['#bdbdbd', '#c4c4c4', '#b0b0b0'] as const) for (const k of [0, 1, 2, 3, 4]) {
    const body = kind === 'mid-width'
      ? `<p class="note">${NOTE}</p>`
      : `<svg width="460" height="${60 + k * 4}" viewBox="0 0 460 ${60 + k * 4}"><rect width="460" height="${60 + k * 4}" fill="#ffffff"/><text x="10" y="36" font-size="16" style="fill:${c}">Weekday riders rose four percent this spring.</text></svg>`;
    const css = kind === 'mid-width' ? `@media (min-width:${700 + k * 10}px) and (max-width:${900 + k * 10}px){.note{color:${c}}}` : '';
    out.push(make('b18-wide-text', ['faint', kind, c.slice(1), k], hz(i++), seed, body, [css], [], { '1.4.3': { verdict: 'fail' }, '1.4.10': { verdict: 'any' } }, `${kind} in ${c} on white`));
  }
  for (const kind of ['mid-width', 'svg-text'] as const) for (const c of ['#595959', '#444444', '#767676'] as const) for (const k of [0, 1, 2, 3, 4]) {
    const body = kind === 'mid-width'
      ? `<p class="note">${NOTE}</p>`
      : `<svg width="460" height="${60 + k * 4}" viewBox="0 0 460 ${60 + k * 4}"><rect width="460" height="${60 + k * 4}" fill="#ffffff"/><text x="10" y="36" font-size="16" style="fill:${c}">Weekday riders rose four percent this spring.</text></svg>`;
    const css = kind === 'mid-width' ? `@media (min-width:${700 + k * 10}px) and (max-width:${900 + k * 10}px){.note{color:${c}}}` : '';
    out.push(make('b18-wide-text', ['strong', kind, c.slice(1), k], hz(i++), seed, body, [css], [], { '1.4.3': { verdict: 'pass' }, '1.4.10': { verdict: 'any' } }, `${kind} in ${c} on white`));
  }
  return out;
}

export const b18DrawnControlsTest: SimTest = { id: 'b18-drawn-controls', criteria: ['1.4.11'], probes: () => [nonTextContrastProbe], full: false, read: 'probe', readProbes: ['non-text-contrast'], capMs: 120_000, cases: drawnControlCases };
export const b18WideTextTest: SimTest = { id: 'b18-wide-text', criteria: ['1.4.10', '1.4.3'], probes: () => [reflowProbe, textContrastProbe], full: false, read: 'probe', readProbes: ['reflow', 'text-contrast'], capMs: 150_000, cases: wideTextCases };

// ---------------------------------------------------------------------------------------------
// Round 3 (2026-11-13): b18-pseudo-rings (1.4.11) and b18-scroll-lines (1.4.10)

const PSEUDO_RINGS = ['after-border', 'before-outline', 'after-shadow', 'before-inset-outline'] as const;

/** A focus ring a pseudo-element draws on a card link or a button: the only thing focus changes. */
function pseudoRing(kind: (typeof PSEUDO_RINGS)[number], colour: string, k: number): { body: string; css: string } {
  const p = kind.startsWith('after') ? '::after' : '::before';
  const draw = {
    'after-border': `inset:${3 + (k % 3)}px;border:${2 + (k % 2)}px solid ${colour};border-radius:4px`,
    'before-outline': `inset:${-2 - (k % 2)}px;outline:${2 + (k % 2)}px solid ${colour};outline-offset:${k % 2}px`,
    'after-shadow': `inset:0;box-shadow:0 0 0 ${3 + (k % 2)}px ${colour};border-radius:6px`,
    'before-inset-outline': `inset:0;outline:${2 + (k % 2)}px solid ${colour};outline-offset:-${4 + (k % 3)}px`,
  }[kind];
  const names = [['Renew a dog license', 'Online, about five minutes'], ['Report a pothole', 'Send a photo and the place'], ['Pay a parking ticket', 'Card or bank account']][k % 3]!;
  const button = k % 4 === 3;
  const body = button
    ? `<p>${names[1]}.</p><button type="button" class="pr">${names[0]}</button>`
    : `<a class="pr" href="#svc-${k}"><span class="pt">${names[0]}</span><span>${names[1]}</span></a>`;
  const css = `.pr{position:relative;display:${button ? 'inline-block' : 'block'};max-width:22rem;padding:1rem;border:1px solid #6b7280;border-radius:8px;color:#1f2933;background:#fff;font:inherit;text-decoration:none}`
    + `.pt{display:block;font-weight:700}.pr:focus{outline:none}.pr:focus${p}{content:"";position:absolute;${draw}}`;
  return { body, css };
}

export function pseudoRingCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of PSEUDO_RINGS) for (const c of FAINT) for (const k of [0, 1, 2, 3]) {
    const d = pseudoRing(kind, c, k);
    out.push(make('b18-pseudo-rings', [kind, c.slice(1), k], hz(i++), seed, d.body, [d.css], [], { '1.4.11': { verdict: 'fail' } }, `focus ring drawn by ${kind} in ${c} on white (under 3:1)`));
  }
  for (const kind of PSEUDO_RINGS) for (const c of STRONG) for (const k of [0, 1, 2, 3, 4]) {
    const d = pseudoRing(kind, c, k);
    out.push(make('b18-pseudo-rings', [kind, c.slice(1), k], hz(i++), seed, d.body, [d.css], [], { '1.4.11': { verdict: 'pass' } }, `focus ring drawn by ${kind} in ${c} on white (3:1 or more)`));
  }
  return out;
}

const PROSE = ['Call the school office before 9 a.m. on any day your student will be absent; absences without a call are marked unexcused after two days.',
  'Students who arrive after the bell sign in at the office, and three late arrivals in a month lead to a meeting with the family.'];

/** Prose in a sideways-scrolling box named or built like a carousel: wider than the box at 320 px, or fitting it. */
function scrollBox(kind: string, w: number, k: number): string {
  const name = ['news-scroller', 'card-slider', 'notice-carousel'][k % 3]!;
  const cols = PROSE.map((t, j) => `<div class="col"><h3>${['Absences', 'Late arrivals'][j]}</h3><p>${t}</p></div>`).join('');
  switch (kind) {
    case 'named-wide': return `<div class="${name}" style="overflow-x:auto;border:1px solid #767676;padding:12px" tabindex="0" role="region" aria-label="Attendance"><div style="display:grid;grid-template-columns:repeat(2,${w}px);gap:16px">${cols}</div></div>`;
    case 'snap-wide': return `<div style="display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;border:1px solid #767676;padding:12px" tabindex="0" role="region" aria-label="Attendance">${PROSE.map((t) => `<div style="flex:0 0 ${w}px;scroll-snap-align:start"><p>${t}</p></div>`).join('')}</div>`;
    case 'named-column': return `<div class="${name}" style="overflow-x:auto;max-height:${12 + k}em;border:1px solid #767676;padding:12px" tabindex="0" role="region" aria-label="Attendance"><div style="width:${w}px"><p>${PROSE[0]} ${PROSE[1]}</p></div></div>`;
    case 'snap-fits': return `<div style="display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;border:1px solid #767676;padding:12px" tabindex="0" role="region" aria-label="Attendance">${PROSE.map((t) => `<div style="flex:0 0 100%;box-sizing:border-box;scroll-snap-align:start"><p>${t}</p></div>`).join('')}</div>`;
    case 'named-fits': return `<div class="${name}" style="overflow-x:auto;border:1px solid #767676;padding:12px" tabindex="0" role="region" aria-label="Attendance"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,${w}px),1fr));gap:16px">${cols}</div></div>`;
    default: return `<div class="${['news-ticker', 'alert-marquee', 'headline-slider'][k % 3]}" style="overflow-x:auto;white-space:nowrap;border:1px solid #767676;padding:8px" tabindex="0" role="region" aria-label="Headlines"><span>${PROSE[0]}</span> <span>${PROSE[1]}</span></div>`;
  }
}

export function scrollLineCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of ['named-wide', 'snap-wide', 'named-column'] as const) for (const w of [320, 352, 416] as const) for (const k of [0, 1, 2, 3, 4, 5]) {
    out.push(make('b18-scroll-lines', [kind, w, k], hz(i++), seed, `<h2>Attendance rules</h2>${scrollBox(kind, w, k)}`, [], [], { '1.4.10': { verdict: 'fail' } }, `${kind}: wrapped prose ${w} px wide in a box that scrolls sideways at 320 px`));
  }
  for (const kind of ['snap-fits', 'named-fits', 'ticker'] as const) for (const w of [240, 280] as const) for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    out.push(make('b18-scroll-lines', [kind, w, k], hz(i++), seed, `<h2>Attendance rules</h2>${scrollBox(kind, w, k)}`, [], [], { '1.4.10': { verdict: 'pass' } }, `${kind}: slides or lines that fit the box, or a ticker's single line`));
  }
  return out;
}

export const b18PseudoRingsTest: SimTest = { id: 'b18-pseudo-rings', criteria: ['1.4.11'], probes: () => [keyboardProbe], full: false, read: 'probe', readProbes: ['keyboard'], capMs: 150_000, cases: pseudoRingCases };
export const b18ScrollLinesTest: SimTest = { id: 'b18-scroll-lines', criteria: ['1.4.10'], probes: () => [reflowProbe], full: false, read: 'probe', readProbes: ['reflow'], capMs: 120_000, cases: scrollLineCases };

// ---------------------------------------------------------------------------------------------
// Precision (lead's ruling after the round-2 blind grade): b18-focus-writer (1.4.11). Pages a fresh writer built from the
// class description alone (out/b18-visual-breakit4; never the detector code): 43 look-alikes (skip links that appear on
// focus, pale rings touching a dark fill, fill changes with a faint ring, two-tone and pseudo-element rings) and 17
// failures (a static element whose only change is a ring or glow under 3:1 against every colour next to it). Each page is
// served as written; the expectation is the writer's.

interface WriterEntry { file: string; row: string; criterion: string; expect: 'pass' | 'fail'; technique: string; why: string }

export function focusWriterCases(): SimCase[] {
  const dir = new URL('../fixtures/b18-focus-writer/', import.meta.url);
  const entries = readFileSync(new URL('manifest.jsonl', dir), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as WriterEntry);
  return entries.map((e) => {
    const name = e.file.replace(/^pages\//, '').replace(/\.html$/, '');
    return {
      id: `b18-focus-writer/${name}/none`, test: 'b18-focus-writer', hazard: 'none' as Hazard, params: { p0: name, p1: e.row },
      site: { files: { '/': readFileSync(new URL(`${name}.html`, dir), 'utf8') } },
      expect: { '1.4.11': { verdict: e.expect } }, why: `${e.technique}: ${e.why}`,
    };
  });
}

export const b18FocusWriterTest: SimTest = { id: 'b18-focus-writer', criteria: ['1.4.11'], probes: () => [keyboardProbe], full: false, read: 'probe', readProbes: ['keyboard'], capMs: 150_000, cases: focusWriterCases };
