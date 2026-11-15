// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.10 Reflow: the reflow probe and the overlays probe (320 px and 390 px), read from the criteria
// table. The answer by construction, at 320 CSS px wide (1280 px at 400%):
// - a block of justified text (its lines reach its right edge), a row of buttons (labels set right), a text field or a
//   line that does not wrap is given a fixed width around the line (300, 316, 320, 328, 340, 400,
//   480 px, no page margin), so content reaches past the 320 px edge exactly when it is wider: the page
//   scrolls sideways onto it, or a block that clips (overflow: hidden) loses its text; both fail (328 px
//   and up leave 8 px or more of real content past the edge, never only empty padding);
// - two-dimensional content is exempt at any width: a wide image (a map), a wide data table in its own
//   scrolling region, a wide code block in its own scrolling region;
// - floating content: a chat bubble (small) passes; a fixed panel that covers most of the screen with
//   no way to close it fails; a sticky header up to a quarter of the screen height passes.
import { overlaysProbe } from '../../../src/probes/overlays.js';
import { reflowProbe } from '../../../src/probes/reflow.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
export const REFLOW_WIDTHS = [300, 316, 320, 328, 340, 400, 480] as const;
export const REFLOW_KINDS = ['text-block', 'button-row', 'field', 'nowrap-line', 'image', 'clipped-text', 'table-scroll', 'code-scroll'] as const;
type Kind = (typeof REFLOW_KINDS)[number];

export function reflowCase(kind: Kind, w: number, hazard: Hazard, seed: number): SimCase {
  const id = `reflow/${kind}/${w}px/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css = ['main { padding: 0 !important; } main > h1, main > p { padding: 0 8px; margin-left: 0; margin-right: 0; } body { margin: 0; }'];
  let subject = '';
  switch (kind) {
    case 'text-block':
      subject = `<div class="subject"><p>${filler(r, 1, 30).replace(/<\/?p>/g, '')}</p></div>`;
      css.push(`.subject { width: ${w}px; box-sizing: border-box; padding: 0; } .subject p { margin: 0; text-align: justify; }`);
      break;
    case 'button-row':
      subject = `<div class="subject">${['Pay a bill', 'Report a problem', 'Find a park'].map((t) => `<button type="button">${t}</button>`).join('')}</div>`;
      css.push(`.subject { width: ${w}px; display: flex; flex-wrap: nowrap; box-sizing: border-box; } .subject button { flex: 1 1 0; min-width: 0; overflow: hidden; white-space: nowrap; text-align: right; font: 14px Arial; padding: 8px 0; color: #000; background: #fff; border: 1px solid #000; }`);
      break;
    case 'field':
      // In a div: main's paragraphs have 8 px of padding, which would move the field past the edge.
      subject = '<div><label for="addr">Street address</label><br><input id="addr" class="subject" type="text" autocomplete="street-address" value="1200 North Main Street, Apartment 4"></div>';
      css.push(`.subject { width: ${w}px; box-sizing: border-box; font: 16px Arial; padding: 6px; border: 2px solid #1b1b1b; margin: 0; }`);
      break;
    case 'nowrap-line':
      subject = `<div class="subject"><p>${filler(r, 1, 14).replace(/<\/?p>/g, '')}</p></div>`;
      css.push(`.subject { width: ${w}px; overflow: visible; } .subject p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: clip; width: ${w}px; }`);
      break;
    case 'image':
      subject = `<img class="subject" src="/photo.svg" alt="A map of the city's parks" width="${w}" height="120">`;
      css.push(`.subject { display: block; width: ${w}px; max-width: none; height: 120px; }`);
      break;
    case 'clipped-text':
      subject = `<div class="clip"><p class="subject">${filler(r, 1, 24).replace(/<\/?p>/g, '')}</p></div>`;
      css.push(`.clip { width: 100%; overflow: hidden; } .subject { width: ${w}px; margin: 0; padding: 0; box-sizing: border-box; white-space: normal; text-align: justify; }`);
      break;
    case 'table-scroll':
      subject = `<div class="scroller" role="region" aria-label="Budget table" tabindex="0"><table><caption>Budget by year</caption><thead><tr>${['Year', 'Parks', 'Streets', 'Water', 'Library', 'Transit', 'Police', 'Fire'].map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${[2023, 2024, 2025].map((y) => `<tr><th scope="row">${y}</th>${Array.from({ length: 7 }, () => `<td>${Math.round(r() * 900 + 100)}k</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      css.push(`.scroller { overflow-x: auto; max-width: 100%; } table { width: ${Math.max(w, 600)}px; border-collapse: collapse; font: 14px Arial; } th, td { border: 1px solid #555; padding: 4px; }`);
      break;
    case 'code-scroll':
      subject = `<pre class="scroller" tabindex="0" aria-label="Example request"><code>curl -s https://data.example.gov/api/v1/permits?status=open&amp;ward=4&amp;fields=id,address,type,issued_at,${'x'.repeat(Math.max(0, w / 8 - 60))}</code></pre>`;
      css.push('.scroller { overflow-x: auto; max-width: 100%; margin: 8px; font: 14px monospace; background: #f4f4f4; color: #000; padding: 8px; }');
      break;
  }
  const files: Record<string, string> = {};
  if (kind === 'image') files['/photo.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="120" viewBox="0 0 ${w} 120"><rect width="${w}" height="120" fill="#cfe3c8"/><circle cx="${w / 2}" cy="60" r="40" fill="#2f6b2f"/></svg>`;
  const pg = parts('City services', `<p>What the city does for you.</p>${subject}${filler(r, 3)}`, css);
  Object.assign(pg.files, files);
  applyHazard(pg, hazard, r);
  const exempt = kind === 'table-scroll' || kind === 'code-scroll' || kind === 'image';
  // The block plus nothing else: wider than the 320 px viewport fails (text lost when clipped).
  const fails = !exempt && w > 320;
  return {
    id, test: 'reflow', hazard, params: { kind, width: w },
    site: render(pg),
    expect: { '1.4.10': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: exempt ? `${kind}: two-dimensional content (exempt)` : `${kind} ${w} px wide at a 320 px viewport${fails ? (kind === 'clipped-text' ? ' (text cut off)' : ' (scrolls sideways)') : ' (fits)'}`,
  };
}

/** Floating content at 320 px: a chat bubble, a sticky header of a quarter of the height, a panel that covers most of it. */
// 2026-11-07 ruling (Understanding 1.4.10: dismissing is the remedy for sticky or fixed content): a panel that can be
// closed by keyboard passes at any size; one whose Close does nothing, or that only a mouse can close, still fails.
export function floatCase(kind: 'bubble' | 'short-header' | 'cover-panel' | 'cover-panel-closable' | 'cover-panel-close-broken' | 'cover-panel-close-mouse-only', hazard: Hazard, seed: number): SimCase {
  const id = `reflow/float/${kind}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = [];
  let html = '';
  switch (kind) {
    case 'bubble':
      html = '<a class="float" href="#chat" aria-label="Chat with us">?</a>';
      css.push('.float { position: fixed; right: 16px; bottom: 16px; width: 48px; height: 48px; border-radius: 24px; background: #00376d; color: #fff; text-align: center; line-height: 48px; z-index: 20; }');
      break;
    case 'short-header':
      html = '<div class="float" role="banner"><a href="#main">City</a></div>';
      css.push('.float { position: fixed; top: 0; left: 0; right: 0; height: 48px; background: #fff; border-bottom: 1px solid #000; z-index: 20; } body { padding-top: 48px; }');
      break;
    case 'cover-panel':
    case 'cover-panel-closable':
    case 'cover-panel-close-broken':
    case 'cover-panel-close-mouse-only': {
      const close = kind === 'cover-panel-closable' ? '<button type="button" onclick="this.parentNode.remove()">Close</button>'
        // A button that does nothing.
        : kind === 'cover-panel-close-broken' ? '<button type="button">Close</button>'
          // A "button" only a mouse can press: a span with a click handler, not in the Tab order.
          : kind === 'cover-panel-close-mouse-only' ? '<span class="x" onclick="this.parentNode.remove()">Close</span>' : '';
      html = `<div class="float" role="region" aria-label="Survey"><p>Tell us how we are doing. Take our short survey about city services this spring.</p>${close}</div>`;
      css.push('.float { position: fixed; left: 0; right: 0; bottom: 0; height: 75vh; box-sizing: border-box; padding: 16px; background: #1b1b1b; color: #fff; z-index: 20; } .float p { color: #fff; } .float button, .float .x { font: 16px Arial; } .float .x { cursor: pointer; text-decoration: underline; }');
      break;
    }
  }
  const pg = parts('City services', `<p>What the city does for you.</p>${filler(r, 6)}<p><a href="#a">Pay a bill</a> <a href="#b">Report a problem</a></p>${filler(r, 4)}`, css);
  pg.before.push(html);
  applyHazard(pg, hazard, r);
  const fails = kind === 'cover-panel' || kind === 'cover-panel-close-broken' || kind === 'cover-panel-close-mouse-only';
  return {
    id, test: 'reflow', hazard, params: { float: kind }, site: render(pg),
    expect: { '1.4.10': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `a fixed panel covers three quarters of the 320 px screen and cannot be closed${kind === 'cover-panel' ? '' : kind === 'cover-panel-close-broken' ? ' (its Close button does nothing)' : ' (only a mouse can close it)'}` : `${kind}: floating content that leaves the page usable`,
  };
}

export function reflowCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of REFLOW_KINDS) for (const w of REFLOW_WIDTHS) for (const rep of [0, 1, 2]) {
    out.push(reflowCase(kind, w, HAZARDS[(i++ + rep * 3) % HAZARDS.length]!, seed));
  }
  // A page-load pop-up over the page (the 2026-11-07 audit's cause 6): the page behind it decides.
  for (const kind of REFLOW_KINDS) for (const w of [316, 340]) out.push(reflowCase(kind, w, 'load-popup', seed));
  for (const kind of ['bubble', 'short-header', 'cover-panel', 'cover-panel-closable', 'cover-panel-close-broken', 'cover-panel-close-mouse-only'] as const) {
    for (const h of ['none', 'smooth-scroll', 'late-mount', 'font-swap'] as const) out.push(floatCase(kind, h, seed));
  }
  return dedupe(out);
}

const dedupe = (cs: SimCase[]) => [...new Map(cs.map((c) => [c.id, c])).values()];

export const reflowTest: SimTest = {
  id: 'reflow',
  criteria: ['1.4.10'],
  probes: () => [reflowProbe, overlaysProbe],
  full: false,
  read: 'criterion',
  capMs: 150_000,
  cases: reflowCases,
};
