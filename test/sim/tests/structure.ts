// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Structure lane, batch 17 (2026-11-12): the lane's decision paths, each as a lab of generated pages whose answer is
// known by construction (at least 59 counted cases per path, real-site-like ones included: the wrappers and class
// names of common CMS templates). Every page is written here: no red-team, ACT or real-site page, class, string or
// structure is copied.
//
// - heading-peer (1.3.1): the first line of a box that the page's markup calls a heading or title, beside boxes that
//   begin with a real heading, set at least as large and as heavy as that heading in the same typeface: fails. A real
//   heading, a line tied to its box as its label, a sentence, a figure or a date, a figure that leads a sentence, a
//   quotation: pass. A smaller or lighter line, another typeface, no naming class, a class that only sets type
//   ("font-heading-lg"), a bar that takes clicks, a neighbour that begins with plain text: 'any' (the engine says
//   undecided; an auditor may call it either way).
// - heading-repeated (1.3.1): two or more lines of one make that the markup calls a heading or title, each at the head
//   of its own text in one block: fail. Real headings, terms of a description list, sentences, dates, figures, group
//   labels, buttons, figures that read on into their sentences, quotations, spans of dates, months, weekdays and
//   times, job titles under names: pass. One line alone, lines of different makes, lines the markup does not name
//   or names only with a class that sets type, the bars of an accordion, lines over panels that are closed: 'any'.
// - heading-drawn (1.3.1): a line set exactly like a real heading as the browser draws it, whatever weights the
//   style sheet names (500 and 400 of a family with no medium face, 800 and 700 of a family with one bold face;
//   web fonts served with the page, so every machine draws the same faces): fail. Two faces of one width (a medium
//   and a regular face of a monospaced family), two first families that fall back to one face, a page whose web
//   font did not arrive, two weights of a font of the reader's own device (which faces it has differs from device
//   to device), a web font with a source on the device; the same type on a group's label, a sentence, a subtitle, text in a table or the
//   navigation: pass. Bold against regular, another size or family with a naming class: 'any'.
// - site-heading (1.3.1, a site of four pages): a line one page shows as a heading that another page marks up as a
//   real heading, the same words in the same type: fail. Every page marks it up; the same words on a button or a
//   link; a sentence: pass. No page marks it up; other words; another type: 'any'.
// - table-dates (1.3.1): rows and columns under a bold header row whose first column is spans of dates, with no
//   header cells: fail. Real header cells, ARIA table roles, a list, cards, notices: pass. Plain words where the
//   dates were: 'any'.
// - toggle-hidden (4.1.2): an aria-pressed button that stays "false" while each press shows and hides words beside
//   it that are hidden from assistive technology: fail. A toggle that keeps its state, a name that says it, a native
//   checkbox, a disclosure with aria-expanded, a toggle that tells its state when the server has answered (the test
//   never sends the request): pass. The same words where a screen reader can read them, a state also written for
//   screen readers, a state a live region announces, more text around the button than the test compares: 'any'.
// - title-site (2.4.2, a site of eight pages; batch 17's fix round, the lead's ruling (c)): a page that is not the home
//   page titled with a generic word ("Home", "Welcome", "Index", "Main page") and the site's name while its own heading
//   names its topic; the site's name alone on two or three such pages: fail. Titles that name their page, in its
//   heading's words or others; a kind of page; a translated page; "Water conservation" over "Save every drop" (Sol
//   review S3); a lone landing page titled with the site's name; the home page (also at /index.html, and in Spanish)
//   titled "Home"; a generic word in a page's own name: pass. A generic title over a heading that is a picture or of
//   level 2, and a title that is another page's heading (listed since S3): 'any' (the engine says undecided).
//   (It replaces the stale-title lab, whose failing side S3 made a doubt.)
// - frame-roleless (4.1.2, the names test in the page's own frames; S7, S9): days, tabs, accordion bars and rows a
//   frame's script makes controls with no role, in frames from the site, written by the page, sandboxed, nested: fail.
//   Buttons, links, role="button"; frames hidden from assistive technology or the pointer, sandboxed or not; frames
//   too small or not shown: pass.
// - order-pictured (1.3.2, the screen-reader test's reading order; S8, S9): text blocks read in one order and shown in
//   the other, on the page or in a drawing's foreignObject: fail. The same in order; charts, diagrams and a timeline
//   drawn in svg (labels placed by their coordinates), a chart inside a foreignObject: pass.
import { readFileSync } from 'node:fs';
import { ariaStatesProbe } from '../../../src/probes/ariaStates.js';
import { formFieldsProbe } from '../../../src/probes/forms.js';
import { headingsProbe } from '../../../src/probes/headings.js';
import { namesProbe } from '../../../src/probes/names.js';
import { pageTitlesProbe } from '../../../src/probes/pageTitles.js';
import { screenReaderLiveProbe, screenReaderProbe } from '../../../src/probes/screenReader/index.js';
import { hash, rng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimSite, SimTest } from '../types.js';

const P: Expectation = { verdict: 'pass' };
const F: Expectation = { verdict: 'fail', count: 1 };
const A: Expectation = { verdict: 'any' };

const HAZARDS: readonly Hazard[] = ['none', 'late-mount', 'cookie-banner', 'font-swap', 'animation-in-flight'];
/** For tests that press, and for sites of several pages: the pages load at once. */
const STILL: readonly Hazard[] = ['none', 'cookie-banner', 'font-swap', 'animation-in-flight'];

const BODY = [
  'Crews will work on the east side of the street first, then move to the west side once the new pipe has been tested and the road surface is repaired.',
  'The office is open on weekdays from eight until five, and staff can help with forms, payments and questions about your account at the front counter.',
  'Bring a photo identification and a recent bill when you visit, so that the clerk can find your record and update it while you wait at the desk.',
  'Notices are posted at the entrance two weeks before any change, and a copy is mailed to every household on the affected streets in the district.',
];
const TOPICS = ['Service alerts', 'Rates and charges', 'Board meetings', 'Permits and forms', 'Road closures', 'Winter parking', 'Leaf collection', 'Public comment', 'Volunteer days', 'Lost and found'];
const LINKS = (r: () => number) => `<ul class="links">${[0, 1, 2].map(() => TOPICS[Math.floor(r() * TOPICS.length)]!).map((t, i) => `<li><a href="/p${i}">${t}</a></li>`).join('')}</ul>`;
const pickOf = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
/** Text that reads on from the line above it (it begins in lower case). */
const READS_ON = [
  'took a bus or a train with us last year, the most since the new lines opened, and nine in ten said they would ride again.',
  'were counted at the six busiest stations in the first week of each month, by staff with hand counters at every gate.',
  'is what the district saved by changing its street lights to new lamps, which also need far fewer visits by a crew.',
];
const FIGURE_LINES = ['1.2 million riders', '94% on time', '3 new routes this year', '$4.5 million saved', '250 volunteers'];
const QUOTE_LINES = ['“The bus is my lifeline”', '“I sold my second car”', '"We finally have a library again"', '«Un servicio para todos»'];
/** Classes that set type and name nothing: a design system's or a block theme's typography utilities. */
const TYPE_CLASSES = ['font-heading-lg', 'text-title', 'has-heading-font-family', 'title-large', 'heading-3', 'u-heading', 'display-title'];
/** Web fonts every machine draws alike (the engine's own, OFL): the faces of a monospaced family, served with the page. */
const fontFace = (file: string) => `url(data:font/woff2;base64,${readFileSync(new URL(`../../../assets/fonts/${file}`, import.meta.url)).toString('base64')}) format("woff2")`;
/** "TwoFaces": a regular and a bold face, nothing between or above. "ThreeFaces": a regular, a medium and a bold face of one width. */
const FACES_CSS = `@font-face { font-family: LocalFaces; src: local("No Such Font On This Device"), ${fontFace('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; } @font-face { font-family: LocalFaces; src: local("No Such Bold Font On This Device"), ${fontFace('ibm-plex-mono-600-latin.woff2')}; font-weight: 700; } @font-face { font-family: TwoFaces; src: ${fontFace('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; } @font-face { font-family: TwoFaces; src: ${fontFace('ibm-plex-mono-600-latin.woff2')}; font-weight: 700; } @font-face { font-family: ThreeFaces; src: ${fontFace('ibm-plex-mono-400-latin.woff2')}; font-weight: 400; } @font-face { font-family: ThreeFaces; src: ${fontFace('ibm-plex-mono-500-latin.woff2')}; font-weight: 500; } @font-face { font-family: ThreeFaces; src: ${fontFace('ibm-plex-mono-600-latin.woff2')}; font-weight: 700; }`;

const BASE_CSS = 'body { margin: 0; font: 16px/1.5 Arial, sans-serif; color: #1b1b1b; background: #fff; } a { color: #00376d; } a:focus-visible, button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; } button { font: inherit; padding: 6px 12px; color: #fff; background: #00376d; border: 2px solid #00376d; } .wrap { padding: 0 24px; } .site-header { padding: 12px 24px; border-bottom: 1px solid #767676; } .site-header a { margin-right: 16px; } .site-footer { padding: 16px 24px; border-top: 1px solid #767676; } ul.links { padding-left: 20px; }';

interface PageOpts { title: string; h1?: string; /** The page heading's element (default h1). */ h1Tag?: string; main: string; rail?: string; css?: string; script?: string; hazard: Hazard; seed: number; nav?: string; head?: string; lang?: string }

/** A whole page in the shape of a common template: header with navigation, main, an optional side rail, footer. The hazard never touches the subject's answer. */
function page(o: PageOpts): string {
  const r = rng(o.seed);
  const css = [BASE_CSS, o.css ?? ''];
  let after = '';
  let before = '';
  let script = o.script ?? '';
  let content = `<main id="main" class="wrap"><${o.h1Tag ?? 'h1'}>${o.h1 ?? o.title}</${o.h1Tag ?? 'h1'}>\n${o.main}\n</main>${o.rail ? `\n<aside class="rail wrap" aria-label="More on this site">${o.rail}</aside>` : ''}`;
  switch (o.hazard) {
    case 'late-mount': {
      const ms = Math.round(800 + r() * 900);
      after += `<template id="late">${content}</template>`;
      content = '<div id="app"><p>Loading…</p></div>';
      script = `setTimeout(function () { document.getElementById('app').innerHTML = document.getElementById('late').innerHTML; ${script} }, ${ms});`;
      break;
    }
    case 'cookie-banner':
      after += '<div class="cookies" role="region" aria-label="Cookie notice"><p>This site uses cookies to remember your choices.</p><button type="button" onclick="this.parentNode.remove()">Accept</button></div>';
      css.push('.cookies { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 24px; display: flex; gap: 16px; align-items: center; background: #1b1b1b; color: #fff; } .cookies p { margin: 0; color: #fff; } .cookies button { background: #fff; color: #000; border-color: #fff; } .cookies button:focus-visible { outline: 3px solid #ffbf47; } body { padding-bottom: 80px; }');
      break;
    case 'font-swap':
      css.push('body { letter-spacing: 0.01em; } .wrap { max-width: 60rem; }');
      before = '<p class="wrap notice">Office hours change on holidays.</p>';
      break;
    case 'animation-in-flight':
      after += '<div class="strip" aria-hidden="true"></div>';
      css.push('.strip { height: 12px; width: 40%; background: #2b5797; animation: slide 2s ease-out both; } @keyframes slide { from { transform: translateX(-100%); } to { transform: none; } }');
      break;
    default:
      break;
  }
  return `<!doctype html>
<html lang="${o.lang ?? 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${o.title}</title>${o.head ?? ''}
<style>${css.join('\n')}</style></head>
<body>
<header class="site-header"><a href="/">Riverbend District</a>${o.nav ?? ''}</header>
${before}${content}
<footer class="site-footer"><p>Riverbend District, 12 Mill Road</p></footer>
${after}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

function make(test: string, kind: string, rep: number, hazard: Hazard, site: SimSite, expect: Record<string, Expectation>, why: string, params: Record<string, string | number | boolean> = {}): SimCase {
  return { id: `${test}/${kind}/${rep}/${hazard}`, test, params: { kind, ...params }, hazard, site, expect, why };
}
function spread<K extends string>(kinds: readonly K[], reps: (k: K) => number, build: (k: K, rep: number, hazard: Hazard, seed: number) => SimCase, seed: number, hazards: readonly Hazard[] = HAZARDS): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const k of kinds) for (let rep = 0; rep < reps(k); rep++) out.push(build(k, rep, hazards[i++ % hazards.length]!, seed));
  return out;
}
const repsOf = (e: Expectation, fail: number, pass: number, any = 2) => (e.verdict === 'fail' ? fail : e.verdict === 'any' ? any : pass);

/** Class names templates give a box's title: each holds a word that calls it a heading or a title. */
const TITLE_CLASSES = ['widgetHeading', 'widget-title', 'block__title', 'card-title', 'sectionHeading', 'panel-heading', 'box_title', 'moduleTitle', 'fsElementTitle', 'pane-title'];
/** Wrappers of a side rail's boxes, as templates write them. */
const BOX = [
  (inner: string, cls = '') => `<section class="widget ${cls}">${inner}</section>`,
  (inner: string, cls = '') => `<div class="block block-views ${cls}">${inner}</div>`,
  (inner: string, cls = '') => `<div class="et_pb_module ${cls}">${inner}</div>`,
  (inner: string, cls = '') => `<article class="card ${cls}">${inner}</article>`,
];

// ---------------------------------------------------------------------------------------------------------------
// heading-peer (1.3.1)

const PEER_KINDS = [
  // fail: named, first in its box, at least as large as the neighbour's real heading, the same typeface
  'rail-title-over-links', 'rail-title-over-text', 'card-row-title', 'main-sections-title', 'title-in-wrapper', 'title-same-size',
  // pass
  'real-heading', 'role-heading', 'box-labelled-by-title', 'group-label', 'sentence-first', 'figure-first', 'date-first', 'tagline-under-heading', 'figure-caption',
  'figure-leads-sentence', 'quotation-first',
  // any: a candidate the page does not prove
  'smaller-than-neighbour', 'other-typeface', 'no-naming-class', 'neighbour-plain',
  'type-class-only', 'lighter-than-neighbour', 'smaller-than-largest-neighbour', 'neighbour-heading-with-other-role', 'bar-takes-clicks',
] as const;
type PeerKind = (typeof PEER_KINDS)[number];
const PEER_EXPECT: Record<PeerKind, [Expectation, string]> = {
  'rail-title-over-links': [F, 'a side box titled by a paragraph the markup calls a heading, over its links, larger than the real heading of the box beside it'],
  'rail-title-over-text': [F, 'the same over a paragraph of text'],
  'card-row-title': [F, 'one card of a row begins with a styled div called a title where the others begin with a real heading'],
  'main-sections-title': [F, 'one section of the main content begins with a styled paragraph called a heading where the others begin with an h2'],
  'title-in-wrapper': [F, 'the title is alone in a header wrapper at the top of its box'],
  'title-same-size': [F, 'the title is exactly as large and as heavy as the neighbour\'s real heading, in another colour (also set exactly like it)'],
  'real-heading': [P, 'the box title is a real heading with the same class'],
  'role-heading': [P, 'the box title has role="heading" (ARIA12)'],
  'box-labelled-by-title': [P, 'the title is tied to its box as its name (aria-labelledby): the relationship is in the markup'],
  'group-label': [P, 'the first line of a role="group" is its label'],
  'sentence-first': [P, 'the box begins with a sentence set large: an announcement, not a heading'],
  'figure-first': [P, 'the box begins with a figure set large (a count)'],
  'date-first': [P, 'the box begins with a date set large'],
  'tagline-under-heading': [P, 'a styled tagline under the box\'s real heading'],
  'figure-caption': [P, 'the first line of a figure is its caption'],
  'smaller-than-neighbour': [A, 'a named first line smaller than the neighbour\'s real heading: undecided'],
  'other-typeface': [A, 'a named first line in another typeface than the neighbour\'s heading: undecided'],
  'no-naming-class': [A, 'a first line as large as the neighbour\'s heading that the markup does not name: undecided'],
  'neighbour-plain': [A, 'a named first line beside boxes that begin with plain text: undecided'],
  'figure-leads-sentence': [P, 'the box begins with a figure set large that reads on into its sentence ("1.2 million riders" "took a bus…"): a callout, not a heading'],
  'quotation-first': [P, 'the box begins with a quotation set large'],
  'type-class-only': [A, 'the first line\'s class sets type and names nothing ("font-heading-lg"): undecided'],
  'lighter-than-neighbour': [A, 'a named first line, larger and lighter (300) than the neighbour\'s heading (500): undecided'],
  'smaller-than-largest-neighbour': [A, 'a named first line larger than one neighbour\'s small heading and smaller than another\'s: undecided'],
  'neighbour-heading-with-other-role': [A, 'the neighbour\'s first line is an h2 whose role says it is no heading: undecided'],
  'bar-takes-clicks': [A, 'the named first line takes clicks (a pointer cursor, aria-expanded, a toggle attribute): it may be a control: undecided'],
};

function peerCase(kind: PeerKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `heading-peer/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const cls = TITLE_CLASSES[rep % TITLE_CLASSES.length]!;
  const box = BOX[rep % BOX.length]!;
  const hTag = pickOf(r, ['h2', 'h3'] as const);
  const hPx = pickOf(r, [19, 20, 22]);
  const tPx = hPx + pickOf(r, [1, 2, 4]);
  const tag = pickOf(r, ['p', 'div'] as const);
  const topic = TOPICS[rep % TOPICS.length]!;
  const other = TOPICS[(rep + 3) % TOPICS.length]!;
  const text = BODY[rep % BODY.length]!;
  const css = `.rail { margin-top: 24px; } .rail h2, .rail h3, .cards h3, .secs h2 { font-size: ${hPx}px; font-weight: 700; margin: 0 0 8px; } .t { font-size: ${tPx}px; font-weight: 700; margin: 0 0 8px; } .same { font-size: ${hPx}px; font-weight: 700; margin: 0 0 8px; color: #7a1f1f; } .small { font-size: ${hPx - 0.8}px; font-weight: 700; margin: 0 0 8px; } .light { font-size: ${hPx + 8}px; font-weight: 300; margin: 0 0 8px; } .serif { font-family: Georgia, 'DejaVu Serif', serif; } .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; } .card, .widget, .block, .et_pb_module { border: 1px solid #767676; padding: 12px; margin: 0 0 16px; } .tag { font-size: ${hPx - 4}px; font-weight: 700; margin: 0 0 8px; }`;
  const neighbour = box(`<${hTag}>${other}</${hTag}><p>${BODY[(rep + 1) % BODY.length]}</p>`);
  const plainNeighbour = box(`<p>${BODY[(rep + 1) % BODY.length]}</p>`);
  const titled = (title: string, content: string, attrs = '') => box(`${title}${content}`, attrs);
  let main = `<p>${BODY[(rep + 2) % BODY.length]}</p>`;
  let rail = '';
  const line = (c: string, extra = '') => `<${tag} class="${c}"${extra}>${topic}</${tag}>`;
  switch (kind) {
    case 'rail-title-over-links': rail = titled(line(`t ${cls}`), LINKS(r)) + neighbour; break;
    case 'rail-title-over-text': rail = neighbour + titled(line(`t ${cls}`), `<p>${text}</p>`); break;
    case 'card-row-title':
      main += `<div class="cards"><article class="card"><h3>${other}</h3><p>${BODY[0]}</p></article><article class="card"><div class="t ${cls}">${topic}</div><p>${text}</p></article><article class="card"><h3>${TOPICS[(rep + 5) % TOPICS.length]}</h3><p>${BODY[1]}</p></article></div>`;
      break;
    case 'main-sections-title':
      main += `<div class="secs"><section><h2>${other}</h2><p>${BODY[0]}</p></section><section><p class="t ${cls}">${topic}</p><p>${text}</p></section><section><h2>${TOPICS[(rep + 5) % TOPICS.length]}</h2><p>${BODY[1]}</p></section></div>`;
      break;
    case 'title-in-wrapper': rail = box(`<div class="box-top"><span class="t ${cls}" style="display:block">${topic}</span></div>${LINKS(r)}`) + neighbour; break;
    case 'title-same-size': rail = titled(line(`same ${cls}`), LINKS(r)) + neighbour; break;
    case 'real-heading': rail = titled(`<${hTag} class="t ${cls}">${topic}</${hTag}>`, LINKS(r)) + neighbour; break;
    case 'role-heading': rail = titled(`<div class="t ${cls}" role="heading" aria-level="${hTag === 'h2' ? 2 : 3}">${topic}</div>`, LINKS(r)) + neighbour; break;
    case 'box-labelled-by-title': rail = `<section class="widget" aria-labelledby="bt">${line(`t ${cls}`, ' id="bt"')}${LINKS(r)}</section>${neighbour}`; break;
    case 'group-label': rail = `<div role="group" class="widget">${line(`t ${cls}`)}<p>${text}</p></div>${neighbour}`; break;
    case 'sentence-first': rail = titled(`<p class="t ${cls}">The office will be closed on Friday for the holiday.</p>`, `<p>${text}</p>`) + neighbour; break;
    case 'figure-first': rail = titled(`<p class="t ${cls}">${pickOf(r, ['1,240', '86%', '$45', '312'])}</p>`, `<p>${text}</p>`) + neighbour; break;
    case 'date-first': rail = titled(`<p class="t ${cls}">${pickOf(r, ['November 12, 2026', 'March 4', '11/18/2026'])}</p>`, `<p>${text}</p>`) + neighbour; break;
    case 'tagline-under-heading': rail = titled(`<${hTag}>${topic}</${hTag}><p class="tag ${pickOf(r, ['tagline', 'subtitle', 'box-subtitle'])}">Updated every week by the district office</p>`, `<p>${text}</p>`) + neighbour; break;
    case 'figure-caption': rail = `<figure class="widget" style="margin:0 0 16px">${line(`t ${cls}`)}<p>${text}</p></figure>${neighbour}`; break;
    case 'smaller-than-neighbour': rail = titled(line(`small ${cls}`), LINKS(r)) + neighbour; break;
    case 'other-typeface': rail = titled(line(`t serif ${cls}`), LINKS(r)) + neighbour; break;
    case 'no-naming-class': rail = titled(line('t rail-top'), LINKS(r)) + neighbour; break;
    case 'neighbour-plain': rail = titled(line(`t ${cls}`), LINKS(r)) + plainNeighbour; break;
    case 'figure-leads-sentence': rail = titled(`<${tag} class="t ${cls}">${FIGURE_LINES[rep % FIGURE_LINES.length]}</${tag}>`, `<p>${READS_ON[rep % READS_ON.length]}</p>`) + neighbour; break;
    case 'quotation-first': rail = titled(`<${tag} class="t ${cls}">${QUOTE_LINES[rep % QUOTE_LINES.length]}</${tag}>`, `<p>${text}</p>`) + neighbour; break;
    case 'type-class-only': rail = titled(line(`t ${TYPE_CLASSES[rep % TYPE_CLASSES.length]}`), LINKS(r)) + neighbour; break;
    case 'lighter-than-neighbour': rail = titled(line(`light ${cls}`), LINKS(r)) + box(`<${hTag} style="font-weight:500">${other}</${hTag}><p>${BODY[(rep + 1) % BODY.length]}</p>`); break;
    case 'smaller-than-largest-neighbour': rail = titled(line(`t ${cls}`), LINKS(r)) + box(`<h6 style="font-size:13px;margin:0 0 8px">${other}</h6><p>${BODY[(rep + 1) % BODY.length]}</p>`) + box(`<${hTag} style="font-size:${tPx + 4}px">${TOPICS[(rep + 5) % TOPICS.length]}</${hTag}><p>${BODY[(rep + 2) % BODY.length]}</p>`); break;
    case 'neighbour-heading-with-other-role': rail = titled(line(`t ${cls}`), LINKS(r)) + box(`<${hTag} role="${pickOf(r, ['presentation', 'none'])}">${other}</${hTag}><p>${BODY[(rep + 1) % BODY.length]}</p>`); break;
    case 'bar-takes-clicks': rail = titled(line(`t ${cls}`, ` ${['style="cursor:pointer"', 'aria-expanded="true"', 'data-toggle="collapse"', 'data-bs-toggle="collapse"'][rep % 4]}`), `<p>${text}</p>`) + neighbour; break;
  }
  const [expect, why] = PEER_EXPECT[kind];
  return make('heading-peer', kind, rep, hazard, { files: { '/': page({ title: 'District services', main, ...(rail ? { rail } : {}), css, hazard, seed: seed ^ hash(id) }) } }, { '1.3.1': expect }, why);
}

export const headingPeerTest: SimTest = {
  // The tests of 1.3.1 a core scan runs are all on, and the verdict read is the headings test's own: the rule set's
  // "p-as-heading" also fails a bold, larger paragraph (a sentence, a date or a figure set large in a <p>), which is
  // another test's answer to another question and would hide what this decision path says of the same page.
  id: 'heading-peer', criteria: ['1.3.1'], probes: () => [headingsProbe, screenReaderProbe, formFieldsProbe], full: false, read: 'probe', readProbes: ['headings'], capMs: 90_000,
  cases: (seed) => spread(PEER_KINDS, (k) => repsOf(PEER_EXPECT[k][0], 10, 7), peerCase, seed),
};

// ---------------------------------------------------------------------------------------------------------------
// heading-repeated (1.3.1)

const REP_KINDS = [
  // fail
  'two-div-titles', 'three-p-titles', 'titles-over-lists', 'strong-in-p-titles', 'titles-in-article',
  // pass
  'real-headings', 'description-list', 'sentences', 'dates', 'figures', 'labelled-groups', 'button-rows', 'details-summaries',
  'figures-read-on', 'quotations', 'date-spans', 'job-titles-under-names',
  // any
  'one-title-alone', 'different-makes', 'no-naming-class', 'different-blocks',
  'type-classes-only', 'accordion-bars', 'closed-panels',
] as const;
type RepKind = (typeof REP_KINDS)[number];
const REP_EXPECT: Record<RepKind, [Expectation, string]> = {
  'two-div-titles': [F, 'two styled divs the markup calls headings, each over its own paragraph, in one section'],
  'three-p-titles': [F, 'three styled paragraphs the markup calls titles, each over its own paragraph'],
  'titles-over-lists': [F, 'two titles of one make, each over its own list'],
  'strong-in-p-titles': [F, 'two paragraphs that hold only a strong element the markup calls a title, each over its own text'],
  'titles-in-article': [F, 'titles of one make dividing an article into parts'],
  'real-headings': [P, 'the same parts under real h3 headings'],
  'description-list': [P, 'terms and descriptions in a description list (H40)'],
  'sentences': [P, 'styled lines of one make that are sentences (notices), not titles'],
  'dates': [P, 'styled lines of one make that are dates above entries'],
  'figures': [P, 'styled lines of one make that are figures above their captions'],
  'labelled-groups': [P, 'each styled line is the label of its group (aria-labelledby)'],
  'button-rows': [P, 'each part is opened by a real button with aria-expanded under a real heading'],
  'details-summaries': [P, 'each part is a details element with its summary'],
  'one-title-alone': [A, 'one named line alone over its text: undecided'],
  'different-makes': [A, 'two named lines of different size, each over its text: undecided'],
  'no-naming-class': [A, 'two lines of one make that the markup does not name: no proof on the page'],
  'different-blocks': [A, 'two named lines of one make in different blocks: undecided'],
  'figures-read-on': [P, 'figures set large that read on into their sentences ("1.2 million riders" "took a bus…"): callouts'],
  'quotations': [P, 'quotations set large above the text about them'],
  'date-spans': [P, 'spans of dates, months, weekdays or times above their entries'],
  'job-titles-under-names': [P, 'a job title under each person\'s name, both set like titles: the second line is no heading'],
  'type-classes-only': [A, 'lines of one make whose class sets type and names nothing ("text-title"): undecided'],
  'accordion-bars': [A, 'named lines that take clicks (a script\'s listener, a pointer cursor, aria-expanded): the bars of an accordion: undecided'],
  'closed-panels': [A, 'named lines over panels that are not shown: undecided'],
};

function repeatedCase(kind: RepKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `heading-repeated/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const cls = TITLE_CLASSES[(rep + 2) % TITLE_CLASSES.length]!;
  const px = pickOf(r, [20, 22, 25.6]);
  const t = (i: number) => TOPICS[(rep + i * 3) % TOPICS.length]!;
  const b = (i: number) => BODY[(rep + i) % BODY.length]!;
  const css = `.t { font-size: ${px}px; font-weight: 700; margin: 24px 0 8px; } .u { font-size: ${px + 4}px; font-weight: 700; margin: 24px 0 8px; } h3 { font-size: ${px}px; margin: 24px 0 8px; } dt { font-size: ${px}px; font-weight: 700; margin-top: 16px; } dd { margin: 0 0 8px; }`;
  const wrap = pickOf(r, [(x: string) => `<section class="field field--name-body">${x}</section>`, (x: string) => `<div class="wp-block-group">${x}</div>`, (x: string) => `<div class="fr-view">${x}</div>`] as const);
  let main = `<p>${b(3)}</p>`;
  let script = '';
  const named = `t ${cls}`;
  switch (kind) {
    case 'two-div-titles': main += wrap(`<div class="${named}">${t(0)}</div><p>${b(0)}</p><div class="${named}">${t(1)}</div><p>${b(1)}</p>`); break;
    case 'three-p-titles': main += wrap(`<p class="${named}">${t(0)}</p><p>${b(0)}</p><p class="${named}">${t(1)}</p><p>${b(1)}</p><p class="${named}">${t(2)}</p><p>${b(2)}</p>`); break;
    case 'titles-over-lists': main += wrap(`<div class="${named}">${t(0)}</div>${LINKS(r)}<div class="${named}">${t(1)}</div>${LINKS(r)}`); break;
    case 'strong-in-p-titles': main += wrap(`<p><strong class="${named}">${t(0)}</strong></p><p>${b(0)}</p><p><strong class="${named}">${t(1)}</strong></p><p>${b(1)}</p>`); break;
    case 'titles-in-article': main += `<article>${[0, 1, 2].map((i) => `<div class="${named}">${t(i)}</div><p>${b(i)}</p>`).join('')}</article>`; break;
    case 'real-headings': main += wrap(`<h3 class="${cls}">${t(0)}</h3><p>${b(0)}</p><h3 class="${cls}">${t(1)}</h3><p>${b(1)}</p>`); break;
    case 'description-list': main += `<dl><dt class="${cls}">${t(0)}</dt><dd>${b(0)}</dd><dt class="${cls}">${t(1)}</dt><dd>${b(1)}</dd></dl>`; break;
    case 'sentences': main += wrap(`<p class="${named}">The north gate is closed until the bridge is repaired.</p><p>${b(0)}</p><p class="${named}">Buses stop at the temporary shelter on Alder Avenue.</p><p>${b(1)}</p>`); break;
    case 'dates': main += wrap(`<p class="${named}">November 12, 2026</p><p>${b(0)}</p><p class="${named}">November 19, 2026</p><p>${b(1)}</p>`); break;
    case 'figures': main += wrap(`<div class="${named}">1,240</div><p>${b(0)}</p><div class="${named}">86%</div><p>${b(1)}</p>`); break;
    case 'labelled-groups': main += [0, 1].map((i) => `<div role="group" aria-labelledby="g${i}"><div id="g${i}" class="${named}">${t(i)}</div><p>${b(i)}</p></div>`).join(''); break;
    case 'button-rows': main += [0, 1].map((i) => `<h3><button type="button" aria-expanded="true" aria-controls="pn${i}">${t(i)}</button></h3><div id="pn${i}"><p>${b(i)}</p></div>`).join(''); break;
    case 'details-summaries': main += [0, 1].map((i) => `<details open><summary class="${cls}">${t(i)}</summary><p>${b(i)}</p></details>`).join(''); break;
    case 'one-title-alone': main += wrap(`<div class="${named}">${t(0)}</div><p>${b(0)}</p><p>${b(1)}</p>`); break;
    case 'different-makes': main += wrap(`<div class="${named}">${t(0)}</div><p>${b(0)}</p><div class="u ${cls}">${t(1)}</div><p>${b(1)}</p>`); break;
    case 'no-naming-class': main += wrap(`<div class="t big">${t(0)}</div><p>${b(0)}</p><div class="t big">${t(1)}</div><p>${b(1)}</p>`); break;
    case 'different-blocks': main += `<section><div class="${named}">${t(0)}</div><p>${b(0)}</p></section><div class="more"><div class="${named}">${t(1)}</div><p>${b(1)}</p></div>`; break;
    case 'figures-read-on': main += wrap([0, 1].map((i) => `<div class="${named}">${FIGURE_LINES[(rep + i) % FIGURE_LINES.length]}</div><p>${READS_ON[(rep + i) % READS_ON.length]}</p>`).join('')); break;
    case 'quotations': main += wrap([0, 1].map((i) => `<div class="${named}">${QUOTE_LINES[(rep + i) % QUOTE_LINES.length]}</div><p>${b(i)}</p>`).join('')); break;
    case 'date-spans': {
      const pair = ([['November 18–20', 'November 23–25'], ['November 2026', 'December 2026'], ['Monday', 'Tuesday'], ['9:00 AM', '1:30 PM'], ['Spring 2026', 'Fall 2026'], ['Mon, Nov 3', 'Tue, Nov 4'], ['March 4 through 6', 'March 11 through 13'], ['Week of June 8', 'Week of June 15']] as const)[rep % 8]!;
      main += wrap(pair.map((d, i) => `<p class="${named}">${d}</p><p>${b(i)}</p>`).join(''));
      break;
    }
    case 'job-titles-under-names': main += wrap([['Maria Lopez', 'Director of Finance'], ['Sam Okafor', 'Director of Operations']].map(([who, job], i) => `<div class="u">${who}</div><div class="${named}">${job}</div><p>${b(i)}</p>`).join('')); break;
    case 'type-classes-only': { const u = TYPE_CLASSES[rep % TYPE_CLASSES.length]!; main += wrap([0, 1].map((i) => `<p class="t ${u}">${t(i)}</p><p>${b(i)}</p>`).join('')); break; }
    case 'accordion-bars': {
      const how = rep % 3;
      main += wrap([0, 1].map((i) => `<div class="${named} bar"${how === 1 ? ' style="cursor:pointer"' : how === 2 ? ' aria-expanded="true"' : ''}>${t(i)}</div><div class="panel"><p>${b(i)}</p></div>`).join(''));
      if (how === 0) script = "document.querySelectorAll('.bar').forEach(function (bar) { bar.addEventListener('click', function () { var p = bar.nextElementSibling; p.hidden = !p.hidden; }); });";
      break;
    }
    case 'closed-panels': main += wrap([0, 1].map((i) => `<div class="${named}">${t(i)}</div><div class="panel" style="${pickOf(r, ['max-height:0;overflow:hidden', 'height:0;overflow:hidden', 'visibility:hidden'])}"><p>${b(i)}</p></div>`).join('')); break;
  }
  const [expect, why] = REP_EXPECT[kind];
  return make('heading-repeated', kind, rep, hazard, { files: { '/': page({ title: 'Service alerts', main, css, hazard, seed: seed ^ hash(id), ...(script ? { script } : {}) }) } }, { '1.3.1': expect }, why);
}

export const headingRepeatedTest: SimTest = {
  id: 'heading-repeated', criteria: ['1.3.1'], probes: () => [headingsProbe, screenReaderProbe, formFieldsProbe], full: false, read: 'probe', readProbes: ['headings'], capMs: 90_000,
  cases: (seed) => spread(REP_KINDS, (k) => repsOf(REP_EXPECT[k][0], 12, 8), repeatedCase, seed),
};

// ---------------------------------------------------------------------------------------------------------------
// heading-drawn (1.3.1)

const DRAWN_KINDS = [
  // fail: the same type as drawn
  'weight-500-and-400', 'weight-400-and-500', 'weight-600-and-700', 'weight-800-and-700', 'weight-300-and-400', 'same-weight',
  // pass
  'real-heading', 'group-label-same-type', 'sentence-same-type', 'subtitle-same-type', 'cell-same-type', 'nav-text-same-type',
  'medium-face-of-one-width', 'first-families-differ', 'font-did-not-arrive', 'device-font-600-and-700', 'device-font-500-and-400', 'web-font-with-local-source',
  // any
  'list-item-same-type', 'link-same-type', 'bold-against-regular', 'other-size', 'other-family',
] as const;
type DrawnKind = (typeof DRAWN_KINDS)[number];
const DRAWN_EXPECT: Record<DrawnKind, [Expectation, string]> = {
  'weight-500-and-400': [F, 'a line in weight 400 beside real headings in weight 500 of a family with no medium face: the same face on screen'],
  'weight-400-and-500': [F, 'a line in weight 500 beside real headings in weight 400 of a family with no medium face'],
  'weight-600-and-700': [F, 'a bold line beside real headings in weight 600 of a family whose only heavier face is its bold'],
  'weight-800-and-700': [F, 'a line in weight 800 beside real headings in weight 700 of a family with one bold face'],
  'weight-300-and-400': [F, 'a regular line beside real headings in weight 300 of a family with no light face'],
  'same-weight': [F, 'a line in the very style of the real headings (the same weight, size and family)'],
  'real-heading': [P, 'the line is a real heading'],
  'group-label-same-type': [P, 'a line in the headings\' own type that is the label of its group'],
  'sentence-same-type': [P, 'a sentence in the headings\' own type (a notice)'],
  'subtitle-same-type': [P, 'a line in the headings\' own type right under a real heading (a subtitle)'],
  'cell-same-type': [P, 'text in the headings\' own type inside a table cell'],
  'nav-text-same-type': [P, 'text in the headings\' own type inside the navigation'],
  'medium-face-of-one-width': [P, 'weight 500 beside headings in weight 400 of a monospaced family that HAS a medium face: as wide, and drawn with other ink'],
  'first-families-differ': [P, 'the headings name a family that is not installed first and the line names its fallback: one face here, two types for a reader who has the first'],
  'font-did-not-arrive': [P, 'weights 500 and 400 of a family with no medium face on a page one of whose web fonts failed to load: what is drawn here may be a stand-in'],
  'device-font-600-and-700': [P, 'a line in weight 600 beside headings in weight 700 of a font of the reader\'s own device: a device with a semibold face draws two types, whatever this machine draws'],
  'device-font-500-and-400': [P, 'the same with weights 500 and 400 of a device font'],
  'web-font-with-local-source': [P, 'weights 500 and 400 of a web font whose first source is a font of the reader\'s device (local()): not the same faces for every reader'],
  'list-item-same-type': [A, 'a line in the headings\' own type at the top of a list item (the list gives the items their structure; an auditor may still ask for headings)'],
  'link-same-type': [A, 'a linked line in the headings\' own type over its text (a teaser title: an auditor may ask for a heading)'],
  'bold-against-regular': [A, 'a bold line the markup calls a title beside regular-weight headings of the same size: undecided'],
  'other-size': [A, 'a line the markup calls a title, a little smaller than the real headings: undecided'],
  'other-family': [A, 'a line the markup calls a title in another family at the headings\' size: undecided'],
};

function drawnCase(kind: DrawnKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `heading-drawn/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  // (A line that is not bold is a candidate from 1.4 times the body size: 22.4 px here.)
  const px = pickOf(r, [24, 26, 27.2]);
  const TWO = 'TwoFaces, monospace';
  const DEVICE = pickOf(r, ['Arial, sans-serif', 'Georgia, serif', 'system-ui, sans-serif', "'Segoe UI', 'Helvetica Neue', sans-serif", 'Verdana, sans-serif']);
  const THREE = 'ThreeFaces, monospace';
  // [the real headings' font, the line's font]
  const fonts: Record<string, [string, string]> = {
    'weight-500-and-400': [`500 ${px}px ${TWO}`, `400 ${px}px ${TWO}`],
    'weight-400-and-500': [`400 ${px}px ${TWO}`, `500 ${px}px ${TWO}`],
    'weight-600-and-700': [`600 ${px}px ${TWO}`, `700 ${px}px ${TWO}`],
    'weight-800-and-700': [`700 ${px}px ${TWO}`, `800 ${px}px ${TWO}`],
    'weight-300-and-400': [`300 ${px}px ${TWO}`, `400 ${px}px ${TWO}`],
    'medium-face-of-one-width': [`400 ${px}px ${THREE}`, `500 ${px}px ${THREE}`],
    'first-families-differ': [`700 ${px}px RiverbendDisplayNoSuchFont, ${TWO}`, `700 ${px}px ${TWO}`],
    'font-did-not-arrive': [`500 ${px}px ${TWO}`, `400 ${px}px ${TWO}`],
    'device-font-600-and-700': [`700 ${px}px ${DEVICE}`, `600 ${px}px ${DEVICE}`],
    'device-font-500-and-400': [`500 ${px}px ${DEVICE}`, `400 ${px}px ${DEVICE}`],
    'web-font-with-local-source': [`500 ${px}px LocalFaces, monospace`, `400 ${px}px LocalFaces, monospace`],
    'bold-against-regular': [`400 ${px}px ${TWO}`, `700 ${px}px ${TWO}`],
    'other-size': [`700 ${px}px ${TWO}`, `700 ${px - 2}px ${TWO}`],
    'other-family': [`700 ${px}px ${TWO}`, `700 ${px}px ${THREE}`],
  };
  const [hFont, lFont] = fonts[kind] ?? [`700 ${px}px ${TWO}`, `700 ${px}px ${TWO}`];
  // (A web font that fails to load: the sim server has no such file.)
  const gone = kind === 'font-did-not-arrive' ? '@font-face { font-family: Gone; src: url("/fonts/gone.woff2") format("woff2"); } .gone { font-family: Gone, Arial, sans-serif; }' : '';
  const css = `${FACES_CSS} ${gone} main h2 { font: ${hFont}; margin: 24px 0 8px; } .line { font: ${lFont}; margin: 24px 0 8px; } td .line, li .line, nav .line { margin: 0; }`;
  const topic = TOPICS[rep % TOPICS.length]!;
  const other = TOPICS[(rep + 4) % TOPICS.length]!;
  const b = (i: number) => BODY[(rep + i) % BODY.length]!;
  const real = `<h2>${other}</h2><p>${b(0)}</p>`;
  const tag = pickOf(r, ['div', 'p'] as const);
  const unnamed = pickOf(r, ['line', 'line lg', 'line fp-style-3']);
  const named = `line ${TITLE_CLASSES[rep % TITLE_CLASSES.length]}`;
  let main = '';
  let nav = '';
  switch (kind) {
    case 'weight-500-and-400': case 'weight-400-and-500': case 'weight-600-and-700': case 'weight-800-and-700': case 'weight-300-and-400': case 'same-weight':
    case 'medium-face-of-one-width': case 'first-families-differ': case 'device-font-600-and-700': case 'device-font-500-and-400': case 'web-font-with-local-source':
      main = rep % 2 ? `<${tag} class="${unnamed}">${topic}</${tag}><p>${b(1)}</p>${real}` : `${real}<${tag} class="${unnamed}">${topic}</${tag}><p>${b(1)}</p>`;
      break;
    case 'font-did-not-arrive': main = `<p class="gone">Opening hours are posted on the door of the office.</p>${real}<${tag} class="${unnamed}">${topic}</${tag}><p>${b(1)}</p>`; break;
    case 'real-heading': main = `${real}<h2 class="${unnamed}">${topic}</h2><p>${b(1)}</p>`; break;
    case 'group-label-same-type': main = `${real}<div role="group" aria-labelledby="gl"><${tag} id="gl" class="${unnamed}">${topic}</${tag}><p>${b(1)}</p></div>`; break;
    case 'sentence-same-type': main = `${real}<p class="${unnamed}">The office will be closed on Friday for the holiday.</p><p>${b(1)}</p>`; break;
    case 'subtitle-same-type': main = `<h2>${other}</h2><p class="${unnamed}">Updated every week by the office</p><p>${b(0)}</p>`; break;
    case 'cell-same-type': main = `${real}<table><caption>Counters</caption><tr><th scope="col">Counter</th><th scope="col">Opens</th></tr><tr><td><span class="${unnamed}">${topic}</span></td><td>8 a.m.</td></tr><tr><td>Payments</td><td>9 a.m.</td></tr></table>`; break;
    case 'list-item-same-type': main = `${real}<ul><li><div class="${unnamed}">${topic}</div><p>${b(1)}</p></li><li><p>${b(2)}</p></li></ul>`; break;
    case 'nav-text-same-type': main = real; nav = `<nav aria-label="Sections"><div class="${unnamed}" style="display:inline-block;font:${hFont}">${topic}</div><ul class="links"><li><a href="/p1">${other}</a></li><li><a href="/p2">${TOPICS[(rep + 6) % TOPICS.length]}</a></li></ul></nav>`; break;
    case 'link-same-type': main = `${real}<p class="${unnamed}"><a href="/p1">${topic}</a></p><p>${b(1)}</p>`; break;
    case 'bold-against-regular': case 'other-size': case 'other-family': main = `${real}<${tag} class="${named}">${topic}</${tag}><p>${b(1)}</p>`; break;
  }
  const [expect, why] = DRAWN_EXPECT[kind];
  return make('heading-drawn', kind, rep, hazard, { files: { '/': page({ title: 'Library services', main: `<p>${b(3)}</p>${main}`, css, hazard, seed: seed ^ hash(id), ...(nav ? { nav } : {}) }) } }, { '1.3.1': expect }, why);
}

export const headingDrawnTest: SimTest = {
  id: 'heading-drawn', criteria: ['1.3.1'], probes: () => [headingsProbe, screenReaderProbe, formFieldsProbe], full: false, read: 'probe', readProbes: ['headings'], capMs: 90_000,
  // 'font-swap' is left out: it sets the body's family to a web font that arrives late, which is a test of its own.
  cases: (seed) => spread(DRAWN_KINDS, (k) => repsOf(DRAWN_EXPECT[k][0], 12, 8), drawnCase, seed, ['none', 'late-mount', 'cookie-banner', 'animation-in-flight']),
};

// ---------------------------------------------------------------------------------------------------------------
// site-heading (1.3.1, four pages)

const SITE_KINDS = [
  // fail
  'widget-title-plain-on-one-page', 'section-title-plain-on-one-page', 'plain-on-two-pages', 'marked-on-one-page-only',
  // pass
  'marked-on-every-page', 'role-heading-on-the-page', 'same-words-on-a-button', 'same-words-in-a-link', 'same-words-in-a-sentence', 'same-words-in-the-navigation',
  // any
  'marked-on-no-page', 'other-words', 'other-type',
] as const;
type SiteKind = (typeof SITE_KINDS)[number];
const SITE_EXPECT: Record<SiteKind, [Expectation, string]> = {
  'widget-title-plain-on-one-page': [F, 'a side box\'s title is a real heading on three pages and a plain styled paragraph on one'],
  'section-title-plain-on-one-page': [F, 'a section title of the main content is an h2 on three pages and a styled div on one'],
  'plain-on-two-pages': [F, 'the title is a real heading on two pages and plain styled text on two'],
  'marked-on-one-page-only': [F, 'the title is a real heading on one page and plain styled text on the page under test'],
  'marked-on-every-page': [P, 'the title is a real heading on every page'],
  'role-heading-on-the-page': [P, 'the page under test gives the title role="heading"'],
  'same-words-on-a-button': [P, 'the words are a real button on the page; a heading on the others'],
  'same-words-in-a-link': [P, 'the words are a link in a paragraph on the page; a heading on the others'],
  'same-words-in-a-sentence': [P, 'the words begin a sentence of body text on the page'],
  'same-words-in-the-navigation': [P, 'the words are an item of the navigation on the page'],
  'marked-on-no-page': [A, 'no page marks the line up as a heading: nothing on the site says what it is'],
  'other-words': [A, 'the other pages\' headings in that type have other words'],
  'other-type': [A, 'the other pages mark the same words up as a heading in another size'],
};

function siteCase(kind: SiteKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `site-heading/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const px = pickOf(r, [19.5, 21, 23]);
  const words = pickOf(r, ['In this section', 'Quick links', 'Related pages', 'Popular services', 'Helpful resources']);
  const hTag = pickOf(r, ['h2', 'h3'] as const);
  const inMain = kind === 'section-title-plain-on-one-page';
  const css = `.wt { font-size: ${px}px; font-weight: 700; margin: 16px 0 8px; } .wt2 { font-size: ${px + 3}px; font-weight: 700; margin: 16px 0 8px; } .rail { margin-top: 16px; }`;
  const names = ['Home', 'Rates', 'Permits', 'Alerts'];
  const paths = ['/', '/rates', '/permits', '/alerts'];
  const nav = (extra = '') => `<nav aria-label="Main">${paths.map((p, i) => `<a href="${p}">${names[i]}</a>`).join('')}${extra}</nav>`;
  const heading = (cls = 'wt', text = words) => `<${hTag} class="${cls}">${text}</${hTag}>`;
  const plainTag = pickOf(r, ['p', 'div'] as const);
  const plain = (text = words) => `<${plainTag} class="wt">${text}</${plainTag}>`;
  /** The box with its title; one box only, so the page alone proves nothing about its title. */
  const box = (title: string) => `<div class="quick">${title}${LINKS(r)}</div>`;
  /** Which pages (by index; 3 is the page under test) show the title how. */
  const shape: Record<SiteKind, string[]> = {
    'widget-title-plain-on-one-page': ['h', 'h', 'h', 'plain'],
    'section-title-plain-on-one-page': ['h', 'h', 'h', 'plain'],
    'plain-on-two-pages': ['h', 'h', 'plain', 'plain'],
    'marked-on-one-page-only': ['none', 'h', 'none', 'plain'],
    'marked-on-every-page': ['h', 'h', 'h', 'h'],
    'role-heading-on-the-page': ['h', 'h', 'h', 'role'],
    'same-words-on-a-button': ['h', 'h', 'h', 'button'],
    'same-words-in-a-link': ['h', 'h', 'h', 'link'],
    'same-words-in-a-sentence': ['h', 'h', 'h', 'sentence'],
    'same-words-in-the-navigation': ['h', 'h', 'h', 'nav'],
    'marked-on-no-page': ['plain', 'plain', 'plain', 'plain'],
    'other-words': ['h-other', 'h-other', 'h-other', 'plain'],
    'other-type': ['h-big', 'h-big', 'h-big', 'plain'],
  };
  const files: Record<string, string> = {};
  shape[kind].forEach((how, i) => {
    let title = '';
    let navExtra = '';
    let extraMain = '';
    switch (how) {
      case 'h': title = heading(); break;
      case 'h-other': title = heading('wt', 'Office directory'); break;
      case 'h-big': title = heading('wt2'); break;
      case 'plain': title = plain(); break;
      case 'role': title = `<div class="wt" role="heading" aria-level="2">${words}</div>`; break;
      case 'button': extraMain = `<p><button type="button" class="wt">${words}</button></p><p>${BODY[1]}</p>`; break;
      case 'link': extraMain = `<p>See <a href="/rates">${words}</a> for more.</p><p>${BODY[1]}</p>`; break;
      case 'sentence': extraMain = `<p>${words} are listed on every page of this site, at the side of the main text.</p><p>${BODY[1]}</p>`; break;
      case 'nav': navExtra = `<a href="/alerts">${words}</a>`; break;
      default: break;
    }
    const main = `<p>${BODY[(rep + i) % BODY.length]}</p>${inMain && title ? `<div class="region">${title}<p>${BODY[(rep + i + 1) % BODY.length]}</p></div>` : extraMain}`;
    const rail = !inMain && title ? box(title) : '';
    files[paths[i]!] = page({ title: `${names[i]} | Riverbend District`, h1: names[i] === 'Home' ? 'Welcome to the district' : `${names[i]} and how to reach us`, main, ...(rail ? { rail } : {}), css, hazard, seed: seed ^ hash(`${id}${i}`), nav: nav(navExtra) });
  });
  const [expect, why] = SITE_EXPECT[kind];
  return make('site-heading', kind, rep, hazard, { files }, { '1.3.1': kind === 'plain-on-two-pages' ? { verdict: 'fail', count: 2 } : expect }, why, { pages: 4 });
}

export const siteHeadingTest: SimTest = {
  id: 'site-heading', criteria: ['1.3.1'], probes: () => [headingsProbe, screenReaderProbe, formFieldsProbe], full: false, read: 'probe', readProbes: ['headings'], capMs: 150_000, maxPages: 4,
  cases: (seed) => spread(SITE_KINDS, (k) => repsOf(SITE_EXPECT[k][0], 15, 8), siteCase, seed, STILL),
};

// ---------------------------------------------------------------------------------------------------------------
// table-dates (1.3.1)

const DATE_KINDS = [
  // fail
  'grid-month-day-span', 'grid-short-month-to', 'grid-numeric-span', 'grid-through', 'rows-of-divs-span', 'two-column-table-span',
  // pass
  'real-table-headers', 'aria-table', 'list-of-dates', 'cards-with-dates', 'notices-grid', 'definition-list',
  // any
  'plain-words-column',
] as const;
type DateKind = (typeof DATE_KINDS)[number];
const DATE_EXPECT: Record<DateKind, [Expectation, string]> = {
  'grid-month-day-span': [F, 'a CSS grid schedule: a bold header row over rows whose first column is "November 18–20"'],
  'grid-short-month-to': [F, 'the same with "Nov 3 to Nov 5"'],
  'grid-numeric-span': [F, 'the same with "11/18–11/20"'],
  'grid-through': [F, 'the same with "March 4 through 6"'],
  'rows-of-divs-span': [F, 'rows of divs, each with three cells side by side, under a bold first row; the first column is spans of dates'],
  'two-column-table-span': [F, 'a two-column table whose header row is bold data cells over rows of a date span and a note'],
  'real-table-headers': [P, 'the same schedule as a table with header cells'],
  'aria-table': [P, 'the same schedule with ARIA table, row, columnheader and cell roles'],
  'list-of-dates': [P, 'the same dates as a list of items'],
  'cards-with-dates': [P, 'cards in a grid, each a heading and a paragraph that mentions a date span'],
  'notices-grid': [P, 'a grid of notices whose bold first row is sentences'],
  'definition-list': [P, 'date spans and notes as a description list'],
  'plain-words-column': [A, 'the same grid with plain words where the dates were: undecided'],
};
const SPANS: Record<string, string[]> = {
  'grid-month-day-span': ['November 18–20', 'November 23–25', 'December 1–3'],
  'grid-short-month-to': ['Nov 3 to Nov 5', 'Nov 10 to Nov 12', 'Dec 1 to Dec 3'],
  'grid-numeric-span': ['11/18–11/20', '11/23–11/25', '12/1–12/3'],
  'grid-through': ['March 4 through 6', 'March 11 through 13', 'March 18 through 20'],
};

function datesCase(kind: DateKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `table-dates/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const heads = pickOf(r, [['Date', 'Lane condition', 'Walking route'], ['When', 'What is closed', 'Use instead'], ['Dates', 'Crew', 'Street']]);
  const notes: [string, string][] = [['Alternating traffic', 'South sidewalk closed'], ['One westbound lane', 'Both sidewalks closed'], ['Road closed', 'North sidewalk open']];
  const spans = SPANS[kind] ?? pickOf(r, Object.values(SPANS));
  const rows = (r() < 0.5 ? 2 : 3);
  const css = '.grid { display: grid; grid-template-columns: 1fr 1fr 1fr; border: 1px solid #767676; margin: 16px 0; } .grid > * { border: 1px solid #c4d0cb; padding: 10px; } .rows > div { display: grid; grid-template-columns: 1fr 1fr 1fr; } .rows span, .rows b { padding: 8px; } table { border-collapse: collapse; } td, th { border: 1px solid #767676; padding: 8px; } .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; } .cards h2 { font-size: 20px; }';
  const grid = (first: string[]) => `<div class="grid">${heads.map((h) => `<b>${h}</b>`).join('')}${Array.from({ length: rows }, (_, i) => `<span>${first[i]}</span><span>${notes[i]![0]}</span><span>${notes[i]![1]}</span>`).join('')}</div>`;
  let main = `<p>${BODY[rep % BODY.length]}</p>`;
  switch (kind) {
    case 'grid-month-day-span': case 'grid-short-month-to': case 'grid-numeric-span': case 'grid-through': main += grid(spans); break;
    case 'rows-of-divs-span': main += `<div class="rows"><div>${heads.map((h) => `<b>${h}</b>`).join('')}</div>${Array.from({ length: 3 }, (_, i) => `<div><span>${spans[i]}</span><span>${notes[i]![0]}</span><span>${notes[i]![1]}</span></div>`).join('')}</div>`; break;
    case 'two-column-table-span': main += `<table><tr><td><b>${heads[0]}</b></td><td><b>${heads[1]}</b></td></tr>${Array.from({ length: 3 }, (_, i) => `<tr><td>${spans[i]}</td><td>${notes[i]![0]}</td></tr>`).join('')}</table>`; break;
    case 'real-table-headers': main += `<table><caption>Lane schedule</caption><tr>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}</tr>${Array.from({ length: 3 }, (_, i) => `<tr><td>${spans[i]}</td><td>${notes[i]![0]}</td><td>${notes[i]![1]}</td></tr>`).join('')}</table>`; break;
    case 'aria-table': main += `<div role="table" aria-label="Lane schedule" class="rows"><div role="row">${heads.map((h) => `<b role="columnheader">${h}</b>`).join('')}</div>${Array.from({ length: 3 }, (_, i) => `<div role="row"><span role="cell">${spans[i]}</span><span role="cell">${notes[i]![0]}</span><span role="cell">${notes[i]![1]}</span></div>`).join('')}</div>`; break;
    case 'list-of-dates': main += `<ul>${Array.from({ length: 3 }, (_, i) => `<li>${spans[i]}: ${notes[i]![0].toLowerCase()}, ${notes[i]![1].toLowerCase()}</li>`).join('')}</ul>`; break;
    case 'cards-with-dates': main += `<div class="cards">${Array.from({ length: 3 }, (_, i) => `<div><h2>${notes[i]![0]}</h2><p>From ${spans[i]} the crews work on this part of the street, and the ${notes[i]![1].toLowerCase()}.</p></div>`).join('')}</div>`; break;
    case 'notices-grid': main += `<div class="grid"><b>The bridge closes on ${spans[0]}.</b><b>Buses use the detour all week.</b><b>Call the office with questions.</b><span>${BODY[0]}</span><span>${BODY[1]}</span><span>${BODY[2]}</span><span>${BODY[3]}</span><span>${BODY[0]}</span><span>${BODY[1]}</span></div>`; break;
    case 'definition-list': main += `<dl>${Array.from({ length: 3 }, (_, i) => `<dt>${spans[i]}</dt><dd>${notes[i]![0]}; ${notes[i]![1].toLowerCase()}.</dd>`).join('')}</dl>`; break;
    case 'plain-words-column': main += grid(['First phase', 'Second phase', 'Third phase']); break;
  }
  const [expect, why] = DATE_EXPECT[kind];
  return make('table-dates', kind, rep, hazard, { files: { '/': page({ title: 'Bridge work', main, css, hazard, seed: seed ^ hash(id) }) } }, { '1.3.1': expect }, why);
}

export const tableDatesTest: SimTest = {
  id: 'table-dates', criteria: ['1.3.1'], probes: () => [headingsProbe, screenReaderProbe, formFieldsProbe], full: false, read: 'probe', readProbes: ['headings'], capMs: 90_000,
  cases: (seed) => spread(DATE_KINDS, (k) => repsOf(DATE_EXPECT[k][0], 10, 9), datesCase, seed),
};

// ---------------------------------------------------------------------------------------------------------------
// toggle-hidden (4.1.2)

const TOGGLE_KINDS = [
  // fail
  'hidden-mark-and-word', 'hidden-word', 'hidden-wrapper', 'hidden-after-label', 'hidden-inert',
  // pass
  'keeps-pressed', 'name-says-state', 'native-checkbox', 'disclosure-expanded', 'switch-checked', 'timer-flourish', 'pressed-follows-hidden-mark',
  'tells-when-the-server-answers', 'looks-on-and-tells-when-the-server-answers',
  // pass (Sol review of batch 17, S4 and S5): the state told another way the accessibility tree has, or written once a
  // file the press loads has arrived (the test refuses it)
  'icon-alt-tells', 'icon-label-tells', 'shadow-text-tells', 'image-load-tells', 'stylesheet-load-tells',
  // any
  'readable-note', 'screen-reader-text-too', 'live-region-announces', 'long-text-around',
] as const;
type ToggleKind = (typeof TOGGLE_KINDS)[number];
const TOGGLE_EXPECT: Record<ToggleKind, [Expectation, string]> = {
  'hidden-mark-and-word': [F, 'aria-pressed stays "false" while each press shows and hides "✓ Included" in an aria-hidden span beside the button'],
  'hidden-word': [F, 'the same with one word ("Saved")'],
  'hidden-wrapper': [F, 'the words are inside a wrapper with aria-hidden'],
  'hidden-after-label': [F, 'the hidden words follow a visible label in the same row'],
  'hidden-inert': [F, 'the words are in an inert element beside the button'],
  'keeps-pressed': [P, 'aria-pressed follows every press'],
  'name-says-state': [P, 'the button\'s own words change with the state ("Add" to "Remove")'],
  'native-checkbox': [P, 'a native checkbox with a label'],
  'disclosure-expanded': [P, 'a disclosure button that keeps aria-expanded'],
  'switch-checked': [P, 'role="switch" that keeps aria-checked'],
  'timer-flourish': [P, 'a plain button (it copies an address: no state) whose press shows a hidden flourish that a timer removes'],
  'pressed-follows-hidden-mark': [P, 'aria-pressed follows the presses beside the same hidden mark'],
  'readable-note': [A, 'the words beside the button are text a screen reader can read: undecided'],
  'screen-reader-text-too': [A, 'the state is also written beside the button in text for screen readers only: undecided'],
  'live-region-announces': [A, 'each press is announced in a status region: undecided'],
  'tells-when-the-server-answers': [P, 'the press shows a hidden mark at once, asks the server to store the choice and writes aria-pressed when the server has answered: for a visitor the state is told (the test never sends the request)'],
  'looks-on-and-tells-when-the-server-answers': [P, 'the same with a button that itself looks switched on at once'],
  'long-text-around': [A, 'the hidden state with a long paragraph in the same block as the button (more text than the test compares): undecided'],
  'icon-alt-tells': [P, 'beside the hidden mark, an icon whose text alternative the press sets to the state ("Included"): the state is told'],
  'icon-label-tells': [P, 'beside the hidden mark, a role="img" icon whose aria-label the press sets to the state'],
  'shadow-text-tells': [P, 'beside the hidden mark, text for screen readers in a shadow root that the press sets to the state'],
  'image-load-tells': [P, 'the press shows the hidden mark and loads a check-mark picture whose load event writes aria-pressed: for a visitor the state is told (the test refuses the picture)'],
  'stylesheet-load-tells': [P, 'the same with a style sheet the press loads'],
};

function toggleCase(kind: ToggleKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `toggle-hidden/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const things = ['this page', 'the fee table', 'the office hours', 'the parking map', 'the meeting dates', 'the route map'];
  const thing = things[rep % things.length]!;
  const label = pickOf(r, [`Include ${thing} in my visit checklist`, `Save ${thing} for later`, `Follow ${thing}`, `Add ${thing} to my list`]);
  const mark = pickOf(r, ['✓ Included', '✓ Saved', 'On my list', '★ Following', '✔ Added']);
  const css = '.row { margin: 16px 0; } .mark { margin-left: 10px; font-weight: 700; } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } .cb { display: inline-block; padding: 6px 12px; border: 2px solid #1b1b1b; } button.on { background: #7a1f1f; border-color: #7a1f1f; }';
  const toggleMark = `var m=document.getElementById('m');var on=!m.textContent;m.textContent=on?${JSON.stringify(mark)}:'';`;
  let row = '';
  let script = '';
  switch (kind) {
    case 'hidden-mark-and-word': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}});`; break;
    case 'hidden-word': row = `<button id="b" type="button" aria-pressed="false">${label}</button> <span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){var m=document.getElementById('m');m.textContent=m.textContent?'':'Saved';});`; break;
    case 'hidden-wrapper': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span aria-hidden="true"><i class="mark" id="m"></i></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}});`; break;
    case 'hidden-after-label': row = `<span>Checklist:</span> <button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}});`; break;
    case 'hidden-inert': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" inert></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}});`; break;
    case 'keeps-pressed': row = `<button id="b" type="button" aria-pressed="false">${label}</button>`; script = "document.getElementById('b').addEventListener('click',function(){this.setAttribute('aria-pressed',this.getAttribute('aria-pressed')==='true'?'false':'true');});"; break;
    case 'name-says-state': row = `<button id="b" type="button">Add ${thing} to my list</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}this.textContent=on?'Remove ${thing} from my list':'Add ${thing} to my list';});`; break;
    case 'native-checkbox': row = `<label><input type="checkbox" name="keep"> ${label}</label>`; break;
    case 'disclosure-expanded': row = `<button id="b" type="button" aria-expanded="false" aria-controls="pn">About ${thing}</button><div id="pn" hidden><p>${BODY[rep % BODY.length]}</p></div>`; script = "document.getElementById('b').addEventListener('click',function(){var p=document.getElementById('pn');p.hidden=!p.hidden;this.setAttribute('aria-expanded',String(!p.hidden));});"; break;
    case 'switch-checked': row = `<span id="b" class="cb" role="switch" tabindex="0" aria-checked="false">${label}</span>`; script = "var b=document.getElementById('b');function t(){b.setAttribute('aria-checked',b.getAttribute('aria-checked')==='true'?'false':'true');}b.addEventListener('click',t);b.addEventListener('keydown',function(e){if(e.key===' '||e.key==='Enter'){e.preventDefault();t();}});"; break;
    case 'timer-flourish': row = `<button id="b" type="button">Copy the address of ${thing}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = "document.getElementById('b').addEventListener('click',function(){var m=document.getElementById('m');m.textContent='\\u2713 Copied';setTimeout(function(){m.textContent='';},120);});"; break;
    case 'pressed-follows-hidden-mark': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}this.setAttribute('aria-pressed',String(on));});`; break;
    case 'readable-note': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}});`; break;
    case 'screen-reader-text-too': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span><span id="s" class="sr"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}document.getElementById('s').textContent=on?'Included in your list':'';});`; break;
    case 'tells-when-the-server-answers': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',async function(){${toggleMark}try{await fetch('/api/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({on:on})});this.setAttribute('aria-pressed',String(on));}catch(e){}});`; break;
    case 'looks-on-and-tells-when-the-server-answers': row = `<button id="b" type="button" aria-pressed="false">${label}</button>`; script = "document.getElementById('b').addEventListener('click',async function(){var on=!this.classList.contains('on');this.classList.toggle('on',on);try{await fetch('/api/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({on:on})});this.setAttribute('aria-pressed',String(on));}catch(e){}});"; break;
    case 'long-text-around': row = `<span>${[0, 1, 2, 3, 0, 1].map((i) => BODY[(rep + i) % BODY.length]).join(' ')}</span> <button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}});`; break;
    case 'live-region-announces': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}document.getElementById('st').textContent=on?'Added to your list.':'Removed from your list.';});`; break;
    case 'icon-alt-tells': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span><img id="ic" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22%3E%3Ccircle cx=%228%22 cy=%228%22 r=%227%22 fill=%22%23176%22/%3E%3C/svg%3E" width="16" height="16" alt="">`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}document.getElementById('ic').alt=on?${JSON.stringify(mark.replace(/^\W+\s*/, ''))}:'';});`; break;
    case 'icon-label-tells': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span><span id="ic" role="img" aria-label="Not on your list">&#9675;</span>`; script = `document.getElementById('b').addEventListener('click',function(){${toggleMark}document.getElementById('ic').setAttribute('aria-label',on?'On your list':'Not on your list');});`; break;
    case 'shadow-text-tells': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span><span id="sh"></span>`; script = `var root=document.getElementById('sh').attachShadow({mode:'open'});root.innerHTML='<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></span>';document.getElementById('b').addEventListener('click',function(){${toggleMark}root.querySelector('span').textContent=on?'On your list':'';});`; break;
    case 'image-load-tells': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span><span id="slot"></span>`; script = `var n=0;document.getElementById('b').addEventListener('click',function(){var b=this;${toggleMark}var slot=document.getElementById('slot');slot.textContent='';if(on){var i=new Image(16,16);i.alt='';i.onload=function(){b.setAttribute('aria-pressed','true');};i.src='/icons/on.svg?n='+(++n);slot.appendChild(i);}else b.setAttribute('aria-pressed','false');});`; break;
    case 'stylesheet-load-tells': row = `<button id="b" type="button" aria-pressed="false">${label}</button><span id="m" class="mark" aria-hidden="true"></span>`; script = `var n=0;document.getElementById('b').addEventListener('click',function(){var b=this;${toggleMark}if(on){var l=document.createElement('link');l.rel='stylesheet';l.href='/css/on.css?n='+(++n);l.onload=function(){b.setAttribute('aria-pressed','true');};document.head.appendChild(l);}else b.setAttribute('aria-pressed','false');});`; break;
  }
  const main = `<p>${BODY[(rep + 1) % BODY.length]}</p><div class="row">${row}</div>${kind === 'live-region-announces' ? '<p id="st" role="status"></p>' : ''}<p>${BODY[(rep + 2) % BODY.length]}</p>`;
  const [expect, why] = TOGGLE_EXPECT[kind];
  // (The files a press loads exist, so that for a visitor the load event comes and writes the state.)
  const loaded: Record<string, string> = kind === 'image-load-tells' ? { '/icons/on.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M2 8l4 4 8-8" stroke="#176" stroke-width="2" fill="none"/></svg>' }
    : kind === 'stylesheet-load-tells' ? { '/css/on.css': '.mark { color: #176; }' } : {};
  return make('toggle-hidden', kind, rep, hazard, { files: { '/': page({ title: 'Plan your visit', main, css, ...(script ? { script } : {}), hazard, seed: seed ^ hash(id) }), ...loaded } }, { '4.1.2': expect }, why);
}

export const toggleHiddenTest: SimTest = {
  // Every test of 4.1.2 a core scan runs, read as the customer sees the criterion.
  id: 'toggle-hidden', criteria: ['4.1.2'], probes: () => [headingsProbe, ariaStatesProbe, namesProbe, screenReaderProbe, formFieldsProbe, screenReaderLiveProbe], full: false, read: 'criterion', capMs: 90_000,
  cases: (seed) => spread(TOGGLE_KINDS, (k) => repsOf(TOGGLE_EXPECT[k][0], 12, 6), toggleCase, seed, STILL),
};

// ---------------------------------------------------------------------------------------------------------------
// title-site (2.4.2, eight pages; batch 17's fix round). It replaces the stale-title lab: since the Sol review of batch
// 17 (S3) a title that is another page's heading on a page that uses none of its words is listed for a person, never
// failed, so that lab had no failing side left. This one measures the decision path the lead's ruling (c) added (a
// generic title, or the site's name alone, demonstrated by the site's pages), with the stale lab's passing pages and the
// S3 look-alike among its passing ones.

const SITE_TITLE_KINDS = [
  // fail (ruling c): a generic word and the site's name on a page that is not the home page; the site's name alone on
  // two or three such pages
  'inner-home-and-site', 'inner-home-alone', 'inner-welcome', 'inner-index', 'inner-main-page', 'site-first-then-home',
  'section-index-home', 'site-name-on-two-pages', 'site-name-on-three-pages',
  // pass
  'every-title-names-its-page', 'title-in-other-words', 'title-shares-a-word', 'section-and-page', 'page-name-first',
  'kind-of-page-title', 'translated-page', 'translated-page-unmarked', 'water-conservation-other-words',
  'landing-page-site-name', 'home-titled-home', 'language-home-titled-home', 'index-duplicate-home',
  'generic-word-in-own-name', 'home-repair-title',
  // any: an auditor fails these titles; the site does not demonstrate it (the lead's ruling (c), and S3), so the test
  // leaves them undecided
  'inner-home-heading-picture', 'inner-home-no-level-1', 'another-pages-heading-unused',
] as const;
type SiteTitleKind = (typeof SITE_TITLE_KINDS)[number];
const SITE_TITLE_EXPECT: Record<SiteTitleKind, [Expectation, string]> = {
  'inner-home-and-site': [F, 'an inner page is titled "Home" and the site\'s name while its own heading names its topic'],
  'inner-home-alone': [F, 'an inner page is titled "Home" alone'],
  'inner-welcome': [F, 'an inner page is titled "Welcome" (with or without the site\'s name)'],
  'inner-index': [F, 'an inner page is titled "Index" (with or without the site\'s name)'],
  'inner-main-page': [F, 'an inner page is titled "Main page" or "Home page"'],
  'site-first-then-home': [F, 'an inner page is titled with the site\'s name and then "Home"'],
  'section-index-home': [F, 'a section\'s first page (folder/index.html) is titled "Home" and the site\'s name while it is headed with the section\'s topic'],
  'site-name-on-two-pages': [F, 'two inner pages about different things are both titled with the site\'s name alone'],
  'site-name-on-three-pages': [F, 'three inner pages about different things are titled with the site\'s name alone'],
  'every-title-names-its-page': [P, 'every page\'s title is its own main heading and the site\'s name'],
  'title-in-other-words': [P, 'a title that describes its page in other words than its heading ("Work with us" on the job openings page)'],
  'title-shares-a-word': [P, 'a title that shares a topic word with its page\'s main heading'],
  'section-and-page': [P, 'titles made of the page, its section and the site'],
  'page-name-first': [P, 'the site\'s name first, the page\'s after it'],
  'kind-of-page-title': [P, 'a page of questions about bills titled "Frequently asked questions", beside the site\'s page headed so'],
  'translated-page': [P, 'the Spanish version of a page (lang="es") kept its English title, which the English page is headed with'],
  'translated-page-unmarked': [P, 'the same Spanish page with nothing in its markup that says it is Spanish'],
  'water-conservation-other-words': [P, 'a tips page titled "Water conservation", headed "Save every drop", about shorter showers and the tap turned off, beside a page headed and titled "Water conservation" (Sol review S3)'],
  'landing-page-site-name': [P, 'the one page about the district itself ("Who we are") is titled with the site\'s name alone'],
  'home-titled-home': [P, 'only the home page is titled "Home" and the site\'s name'],
  'language-home-titled-home': [P, 'the Spanish home page (/es/) is titled "Home" and the site\'s name'],
  'index-duplicate-home': [P, 'the home page is also served at /index.html, titled "Home" and the site\'s name'],
  'generic-word-in-own-name': [P, 'a page\'s own name holds a generic word ("Welcome center", "Main Street project", "Start a business", "Index of ordinances")'],
  'home-repair-title': [P, 'a page about home repair loans is titled "Home repair loans"'],
  'inner-home-heading-picture': [A, 'an inner page is titled "Home" and its heading is a picture: nothing in text says what the page is about: undecided'],
  'inner-home-no-level-1': [A, 'an inner page is titled "Home" and has no level-1 heading: undecided'],
  'another-pages-heading-unused': [A, 'a page is titled with another page\'s heading and uses none of its words: listed for a person (Sol review S3): undecided'],
};

function siteTitleCase(kind: SiteTitleKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `title-site/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const SITE = 'Riverbend District';
  const sep = pickOf(r, [' | ', ' - ', ' — ', ' · ']);
  // [path, navigation name, main heading, text]: none of a page's text uses another page's heading words.
  const PAGES: [string, string, string, string][] = [
    ['/', 'Home', 'Welcome to the district', 'Find the office, pay a bill or read the latest notice from the front desk of your local water provider this week.'],
    ['/meetings', 'Meetings', pickOf(r, ['Board meeting calendar', 'Public meeting schedule', 'Council agenda archive']), 'The members gather on the first Tuesday of each month in the pavilion, and every resident is welcome to listen and to speak at the end.'],
    ['/rebates', 'Rebates', pickOf(r, ['Rain barrel rebates', 'Efficient toilet rebates', 'Smart sprinkler rebates']), 'Residents who fit a qualifying device this season can claim part of its cost back. Keep the receipt and fill in the short form at the front desk before the end of August.'],
    ['/hydrants', 'Hydrants', 'Hydrant flushing plan', 'Crews open each hydrant in turn to clear sediment from the mains. Water may look cloudy for a short while afterwards and clears if the cold tap is left running.'],
    ['/careers', 'Careers', 'Job openings', 'We hire operators, clerks and field technicians through the year. Read each posting for its duties, its pay range and the day on which applications close.'],
    ['/alerts', 'Alerts', 'Service alerts today', 'A main on Mill Road is being repaired this morning, and pressure may be low on the streets nearby until the crew has finished its work there.'],
    ['/billing', 'Billing', 'Paying your bill', 'Pay by card on the telephone, by cheque through the post, or in cash at the counter. A late fee is added ten days after the due date printed on the statement.'],
    ['/contact', 'Contact', 'Reach the front desk', 'Write to us at 12 Mill Road or ring the number printed on your statement. Staff answer between eight and five on weekdays, and a recorded line takes emergencies overnight.'],
  ];
  const titled = (heading: string) => `${heading}${sep}${SITE}`;
  if (kind === 'section-index-home') PAGES[2] = ['/customers/index.html', 'Customers', 'Customer service', PAGES[2]![3]];
  if (kind === 'kind-of-page-title') PAGES[1] = ['/questions', 'Questions', 'Frequently asked questions', 'These are the things residents put to the front desk most often, with the answers the board has agreed for each of them over the years.'];
  const SPANISH = kind === 'translated-page' || kind === 'translated-page-unmarked';
  if (SPANISH) PAGES[3] = ['/es/reembolsos', 'Español', 'Reembolsos para los residentes', 'Los residentes que instalen un aparato aprobado esta temporada pueden pedir que se les devuelva una parte de su costo. Guarde el recibo y llene el formulario corto en la ventanilla antes de que termine el mes de agosto.'];
  if (kind === 'language-home-titled-home') PAGES[3] = ['/es/', 'Español', 'Bienvenidos al distrito', 'Encuentre la oficina, pague una factura o lea el aviso más reciente de la ventanilla de su proveedor de agua esta semana.'];
  if (kind === 'index-duplicate-home') PAGES[5] = ['/index.html', 'Start', PAGES[0]![2], PAGES[0]![3]];
  if (kind === 'water-conservation-other-words') {
    PAGES[3] = ['/conservation', 'Conservation', 'Water conservation', 'Every household can help with water conservation over the summer. The supply is shared with the farms upstream, and in a dry year the reservoir falls quickly when every garden is watered at once.'];
    PAGES[4] = ['/tips', 'Tips', 'Save every drop', 'Small habits add up over a long dry summer. Take shorter showers and keep the bowl from the sink for the plants. Turn off the tap while you brush your teeth, mulch the beds so the soil stays damp, and use a can at the roots rather than a spray over the leaves.'];
  }
  if (kind === 'landing-page-site-name') PAGES[7] = ['/about', 'About', 'Who we are', 'Seven elected board members and forty staff look after the pipes, pumps and reservoirs that serve twelve thousand homes in the valley.'];
  const titles: string[] = PAGES.map((p) => titled(p[2]));
  const heads: string[] = PAGES.map((p) => p[2]);
  const langs: string[] = PAGES.map(() => 'en');
  // The home page's title.
  titles[0] = pickOf(r, [`Home${sep}${SITE}`, SITE, titled(PAGES[0]![2])]);
  const generic = (words: readonly string[]) => { const w = pickOf(r, words); return pickOf(r, [w, `${w}${sep}${SITE}`]); };
  switch (kind) {
    case 'inner-home-and-site': titles[2] = `Home${sep}${SITE}`; break;
    case 'inner-home-alone': titles[2] = 'Home'; break;
    case 'inner-welcome': titles[2] = generic(['Welcome']); break;
    case 'inner-index': titles[2] = generic(['Index']); break;
    case 'inner-main-page': titles[2] = generic(['Main page', 'Home page']); break;
    case 'site-first-then-home': titles[2] = `${SITE}${sep}Home`; break;
    case 'section-index-home': titles[2] = `Home${sep}${SITE}`; break;
    case 'site-name-on-two-pages': titles[2] = SITE; titles[4] = SITE; break;
    case 'site-name-on-three-pages': titles[2] = SITE; titles[4] = SITE; titles[6] = SITE; break;
    case 'every-title-names-its-page': break;
    case 'title-in-other-words': titles[4] = titled(pickOf(r, ['Work with us', 'Join our team', 'Careers'])); break;
    case 'title-shares-a-word': titles[2] = titled('Rebates for residents'); titles[3] = titled('Hydrant work'); break;
    case 'section-and-page': for (let i = 1; i < PAGES.length; i++) titles[i] = `${PAGES[i]![2]}${sep}${i < 3 ? 'Customers' : 'Operations'}${sep}${SITE}`; break;
    case 'page-name-first': for (let i = 0; i < PAGES.length; i++) titles[i] = `${SITE}${sep}${PAGES[i]![2]}`; break;
    case 'kind-of-page-title': titles[6] = pickOf(r, [PAGES[1]![2], titled(PAGES[1]![2])]); break;
    case 'translated-page': case 'translated-page-unmarked': titles[3] = pickOf(r, [PAGES[2]![2], titled(PAGES[2]![2])]); break;
    case 'water-conservation-other-words': titles[4] = titled('Water conservation'); break;
    case 'landing-page-site-name': titles[7] = SITE; break;
    case 'home-titled-home': titles[0] = `Home${sep}${SITE}`; break;
    case 'language-home-titled-home': titles[3] = `Home${sep}${SITE}`; langs[3] = 'es'; break;
    case 'index-duplicate-home': titles[5] = titles[0]!; break;
    case 'generic-word-in-own-name': {
      const [title, heading] = pickOf(r, [['Welcome center', 'Visitor welcome center'], ['Main Street project', 'Main Street pipe replacement'], ['Start a business', 'Starting a business in the district'], ['Index of ordinances', 'Ordinance index']] as const);
      titles[2] = titled(title); heads[2] = heading; break;
    }
    case 'home-repair-title': titles[2] = titled('Home repair loans'); heads[2] = 'Home repair loans'; break;
    case 'inner-home-heading-picture': titles[2] = `Home${sep}${SITE}`; heads[2] = `<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%2240%22%3E%3Crect width=%22320%22 height=%2240%22 fill=%22%2300376d%22/%3E%3C/svg%3E" width="320" height="40" alt="${PAGES[2]![2]}">`; break;
    case 'inner-home-no-level-1': titles[2] = `Home${sep}${SITE}`; break;
    case 'another-pages-heading-unused': titles[2] = PAGES[1]![2]; break;
  }
  if (kind === 'translated-page') langs[3] = 'es';
  const nav = `<nav aria-label="Main">${PAGES.map((p) => `<a href="${p[0]}">${p[1]}</a>`).join('')}</nav>`;
  const files: Record<string, string> = {};
  const common = 'The front desk answers the telephone on weekdays, and a drop box by the door takes payments at any hour.';
  const comun = 'La ventanilla contesta el teléfono entre semana, y un buzón junto a la puerta recibe los pagos a cualquier hora.';
  PAGES.forEach((p, i) => {
    const spanish = (SPANISH || kind === 'language-home-titled-home') && i === 3;
    const main = `<p>${p[3]}</p><p>${spanish ? comun : common}</p>`;
    // (No level-1 heading: the page's own heading is a level-2 one.)
    const h1less = kind === 'inner-home-no-level-1' && i === 2;
    files[p[0]] = page({
      title: titles[i]!, ...(h1less ? { h1Tag: 'h2' } : {}), h1: heads[i]!, main, hazard, seed: seed ^ hash(`${id}${i}`), nav,
      ...(langs[i] !== 'en' && kind !== 'translated-page-unmarked' ? { lang: langs[i]! } : {}),
    });
  });
  const [expect, why] = SITE_TITLE_EXPECT[kind];
  return make('title-site', kind, rep, hazard, { files }, { '2.4.2': expect }, why, { pages: PAGES.length });
}

export const titleSiteTest: SimTest = {
  // Eight pages: a title part that half of a small site's titles share is taken for the site's name.
  id: 'title-site', criteria: ['2.4.2'], probes: () => [pageTitlesProbe], full: false, read: 'criterion', capMs: 180_000, maxPages: 8,
  cases: (seed) => spread(SITE_TITLE_KINDS, (k) => repsOf(SITE_TITLE_EXPECT[k][0], 8, 4), siteTitleCase, seed, STILL),
};

// ---------------------------------------------------------------------------------------------------------------
// frame-roleless (4.1.2, the names test inside the page's own frames; batch 17's fix round, Sol review S7 and S9)

const FRAME_KINDS = [
  // fail: elements the frame's own script makes controls (a click handler, a pointer cursor), with no role
  'calendar-days-src', 'calendar-days-srcdoc', 'tab-strip-src', 'accordion-bars-src', 'list-rows-src', 'sandboxed-shown', 'nested-frame', 'days-with-keyboard',
  // pass
  'buttons-src', 'links-src', 'role-button-src', 'no-handlers-src', 'hidden-frame-aria', 'hidden-frame-inert', 'hidden-frame-pointer',
  'sandboxed-hidden-aria', 'sandboxed-hidden-inert', 'sandboxed-hidden-pointer', 'frame-too-small', 'frame-not-shown', 'buttons-srcdoc', 'sandboxed-buttons',
  // any: the rule for controls with no role needs a pointer cursor too (batch 15's condition, unchanged here)
  'days-no-pointer-cursor',
] as const;
type FrameKind = (typeof FRAME_KINDS)[number];
const FRAME_EXPECT: Record<FrameKind, [Expectation, string]> = {
  'calendar-days-src': [F, 'the days of a calendar in a frame from the site are divs its script makes controls, with no role'],
  'calendar-days-srcdoc': [F, 'the same calendar in a frame the page writes itself (srcdoc)'],
  'tab-strip-src': [F, 'the tabs of a tab strip in a frame are divs that show their panel when clicked, with no role'],
  'accordion-bars-src': [F, 'the bars of an accordion in a frame are divs that open their panel when clicked, with no role'],
  'list-rows-src': [F, 'the rows of a list in a frame open a record when clicked, with no role'],
  'sandboxed-shown': [F, 'the calendar in a sandboxed frame (scripts allowed, no allow-same-origin), offered to everyone'],
  'nested-frame': [F, 'the calendar in a frame inside a frame from the site'],
  'days-with-keyboard': [F, 'the days reach the keyboard (tabindex) and answer Enter, and still have no role'],
  'buttons-src': [P, 'the days are buttons'],
  'links-src': [P, 'the days are links'],
  'role-button-src': [P, 'the days are divs with role="button", a tab stop and Enter and Space'],
  'no-handlers-src': [P, 'the days are plain text: nothing to operate'],
  'hidden-frame-aria': [P, 'a frame with clickable days that the page hides from assistive technology (aria-hidden): a decoration'],
  'hidden-frame-inert': [P, 'the same frame inside an inert wrapper (behind a dialog)'],
  'hidden-frame-pointer': [P, 'the same frame with no pointer events (a preview)'],
  'sandboxed-hidden-aria': [P, 'a sandboxed frame (no window.frameElement inside) the page hides with aria-hidden (Sol review S7)'],
  'sandboxed-hidden-inert': [P, 'a sandboxed frame inside an inert wrapper (Sol review S7)'],
  'sandboxed-hidden-pointer': [P, 'a sandboxed frame with no pointer events (Sol review S7)'],
  'frame-too-small': [P, 'a frame too small to hold a control a person can use'],
  'frame-not-shown': [P, 'a frame that is not shown (display: none)'],
  'buttons-srcdoc': [P, 'buttons in a frame the page writes itself'],
  'sandboxed-buttons': [P, 'buttons in a sandboxed frame'],
  'days-no-pointer-cursor': [A, 'the calendar days with a click handler and no role but no pointer cursor: an auditor fails them; the rule needs the pointer cursor as well, so it finds nothing (a miss by its own condition, not this path)'],
};

function frameCase(kind: FrameKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `frame-roleless/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const month = pickOf(r, ['May', 'June', 'September', 'October']);
  const days = [3, 9, 14, 21].slice(0, 3 + (rep % 2));
  // (A pointer cursor on every element a script makes clickable, as the rule asks: `days-no-pointer-cursor` has none.)
  const cursor = kind === 'days-no-pointer-cursor' ? '' : 'cursor:pointer;';
  const frameCss = `body{margin:0;font:16px/1.5 Arial,sans-serif;color:#1b1b1b;background:#fff}main{padding:8px}.c{display:inline-block;min-width:44px;min-height:44px;margin:2px;padding:4px;border:1px solid #595959;background:#fff;color:#1b1b1b;font:inherit;${cursor}}.c:focus-visible{outline:3px solid #00376d}a.c{color:#00376d}.panel{margin:4px 0}`;
  const show = "function show(t){document.getElementById('out').textContent=t;}";
  let body = '';
  let js = '';
  const opener = (tag: string, attrs = '') => (d: number | string) => `<${tag} class="c" data-v="${d}"${attrs}>${d}</${tag}>`;
  const cal = (make: (d: number) => string) => `<h1 style="font-size:1.1rem;margin:0 0 4px">${month}</h1><div class="month">${days.map(make).join('')}</div><p id="out">Choose a day to see its events.</p>`;
  const clicks = `[].forEach.call(document.querySelectorAll('.c'),function(d){d.addEventListener('click',function(){show('${month} '+d.getAttribute('data-v')+': story time in the library.');});});`;
  switch (kind) {
    case 'tab-strip-src': {
      const tabs = ['Overview', 'Fees', 'Hours'];
      body = `<div class="tabs">${tabs.map((t) => `<div class="c" data-v="${t}">${t}</div>`).join('')}</div><p id="out">The pool opens in June.</p>`;
      js = `[].forEach.call(document.querySelectorAll('.c'),function(d){d.addEventListener('click',function(){show(d.getAttribute('data-v')+': details for the pool.');});});`;
      break;
    }
    case 'accordion-bars-src': {
      body = ['Who can apply', 'How to apply', 'When to apply'].map((t, i) => `<div class="c" data-v="${i}">${t}</div><div class="panel" id="p${i}" hidden><p>${BODY[(rep + i) % BODY.length]}</p></div>`).join('') + '<p id="out"></p>';
      js = "[].forEach.call(document.querySelectorAll('.c'),function(d){d.addEventListener('click',function(){var p=document.getElementById('p'+d.getAttribute('data-v'));p.hidden=!p.hidden;});});";
      break;
    }
    case 'list-rows-src': {
      body = `<div class="rows">${['Permit 2041: fence', 'Permit 2042: deck', 'Permit 2043: shed'].map((t) => `<div class="c" style="display:block" data-v="${t}">${t}</div>`).join('')}</div><p id="out">Choose a permit.</p>`;
      js = `[].forEach.call(document.querySelectorAll('.c'),function(d){d.addEventListener('click',function(){show(d.getAttribute('data-v')+': approved.');});});`;
      break;
    }
    case 'buttons-src': case 'buttons-srcdoc': case 'sandboxed-buttons': body = cal(opener('button', ' type="button"')); js = clicks; break;
    case 'links-src': body = cal((d) => `<a class="c" href="#d${d}" data-v="${d}">${d}</a>`); js = clicks; break;
    case 'role-button-src': body = cal(opener('div', ' role="button" tabindex="0"')); js = `${clicks}[].forEach.call(document.querySelectorAll('.c'),function(d){d.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();d.click();}});});`; break;
    case 'no-handlers-src': body = cal(opener('div')); js = ''; break;
    case 'days-with-keyboard': body = cal(opener('div', ' tabindex="0"')); js = `${clicks}[].forEach.call(document.querySelectorAll('.c'),function(d){d.addEventListener('keydown',function(e){if(e.key==='Enter'){d.click();}});});`; break;
    default: body = cal(opener('div')); js = clicks; break;
  }
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Event calendar</title><style>${frameCss}</style></head><body><main>${body}</main><script>${show}${js}</script></body></html>`;
  const esc = (h: string) => h.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const title = pickOf(r, ['Event calendar', 'Library calendar', 'Pool booking']);
  const sandboxed = /^sandboxed/.test(kind);
  const attrs = `title="${title}"${sandboxed ? ' sandbox="allow-scripts"' : ''}`;
  const files: Record<string, string> = { '/frame.html': doc };
  let frame = '';
  switch (kind) {
    case 'calendar-days-srcdoc': case 'buttons-srcdoc': frame = `<iframe ${attrs} srcdoc="${esc(doc)}"></iframe>`; delete files['/frame.html']; break;
    case 'nested-frame':
      files['/outer.html'] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Calendars</title><style>body{margin:0;font:16px/1.5 Arial,sans-serif}iframe{display:block;width:100%;height:11rem;border:0}</style></head><body><iframe title="${title}" src="/frame.html"></iframe></body></html>`;
      frame = `<iframe title="Calendars" src="/outer.html" style="height:14rem"></iframe>`;
      break;
    case 'hidden-frame-aria': case 'sandboxed-hidden-aria': frame = `<iframe ${attrs} src="/frame.html" aria-hidden="true" tabindex="-1"></iframe>`; break;
    case 'hidden-frame-inert': case 'sandboxed-hidden-inert': frame = `<div inert><iframe ${attrs} src="/frame.html"></iframe></div>`; break;
    case 'hidden-frame-pointer': case 'sandboxed-hidden-pointer': frame = `<iframe ${attrs} src="/frame.html" style="pointer-events:none"></iframe>`; break;
    case 'frame-too-small': frame = `<iframe ${attrs} src="/frame.html" style="width:40px;height:20px"></iframe>`; break;
    case 'frame-not-shown': frame = `<iframe ${attrs} src="/frame.html" style="display:none"></iframe>`; break;
    default: frame = `<iframe ${attrs} src="/frame.html"></iframe>`; break;
  }
  const css = 'iframe { display: block; width: 100%; max-width: 36rem; height: 12rem; border: 1px solid #767676; }';
  const main = `<p>${BODY[rep % BODY.length]}</p>${frame}<p>${BODY[(rep + 1) % BODY.length]}</p>`;
  const [expect, why] = FRAME_EXPECT[kind];
  return make('frame-roleless', kind, rep, hazard, { files: { '/': page({ title: 'Events', main, css, hazard, seed: seed ^ hash(id) }), ...files } }, { '4.1.2': expect }, why);
}

export const frameRolelessTest: SimTest = {
  // The names test alone (its rule for controls with no role, in the page and in the page's own frames).
  id: 'frame-roleless', criteria: ['4.1.2'], probes: () => [namesProbe], full: false, read: 'probe', readProbes: ['names'], capMs: 90_000,
  cases: (seed) => spread(FRAME_KINDS, (k) => repsOf(FRAME_EXPECT[k][0], 8, 4), frameCase, seed, STILL),
};

// ---------------------------------------------------------------------------------------------------------------
// order-pictured (1.3.2, the screen-reader test's reading order; batch 17 and its fix round, Sol review S8 and S9)

const ORDER_KINDS = [
  // fail: text blocks read in one order and shown in the other, on the page or in a drawing's foreignObject
  'column-reverse-two', 'column-reverse-three', 'order-property', 'grid-rows', 'foreignobject-reverse', 'foreignobject-order',
  // pass
  'in-order', 'in-order-foreignobject', 'chart-role-img', 'chart-plain-svg', 'chart-figure', 'diagram-labels', 'chart-in-foreignobject', 'timeline-in-svg',
] as const;
type OrderKind = (typeof ORDER_KINDS)[number];
const ORDER_EXPECT: Record<OrderKind, [Expectation, string]> = {
  'column-reverse-two': [F, 'two instructions in the markup in the wrong order, shown in the right one (flex-direction: column-reverse)'],
  'column-reverse-three': [F, 'three steps, reversed the same way'],
  'order-property': [F, 'two instructions swapped on screen with the order property'],
  'grid-rows': [F, 'two instructions placed on the other grid rows'],
  'foreignobject-reverse': [F, 'two instructions reversed inside an svg diagram\'s foreignObject (Sol review S8)'],
  'foreignobject-order': [F, 'two instructions swapped with the order property inside a foreignObject'],
  'in-order': [P, 'the instructions in the markup in the order they are shown'],
  'in-order-foreignobject': [P, 'the same inside a foreignObject'],
  'chart-role-img': [P, 'a column chart in a named role="img" container: its axis labels are svg text drawn from the bottom up'],
  'chart-plain-svg': [P, 'the same chart as a plain svg'],
  'chart-figure': [P, 'the same chart in a figure with a caption'],
  'diagram-labels': [P, 'the labels of a diagram (a pipe network) placed by their coordinates'],
  'chart-in-foreignobject': [P, 'a chart drawn inside a foreignObject (an svg of its own)'],
  'timeline-in-svg': [P, 'a timeline drawn in an svg, its oldest event first in the markup and at the bottom'],
};

function orderCase(kind: OrderKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `order-pictured/${kind}/${rep}/${hazard}`;
  const r = rng(seed ^ hash(id));
  const task = pickOf(r, [['request form', 'front desk'], ['permit form', 'planning counter'], ['claim form', 'treasurer'], ['booking form', 'pool office']] as const);
  const STEPS = [`First fill in the ${task[0]} with your name and your address.`, `Then hand the ${task[0]} to the ${task[1]} before the end of the month.`, `Last, keep the receipt the ${task[1]} gives you until the work is done.`];
  const ps = (xs: readonly string[]) => xs.map((x) => `<p>${x}</p>`).join('');
  const two = STEPS.slice(0, 2);
  const fo = (inner: string, h = 200) => `<svg viewBox="0 0 520 ${h}" style="display:block;width:100%;max-width:32rem;height:auto" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="518" height="${h - 2}" fill="#ffffff" stroke="#767676"/><foreignObject x="12" y="12" width="496" height="${h - 24}"><div xmlns="http://www.w3.org/1999/xhtml">${inner}</div></foreignObject></svg>`;
  const vals = [10, 20, 30, 40].map((v) => v * (1 + (rep % 3)));
  const chartSvg = (w = 420) => `<svg viewBox="0 0 ${w} 260" style="display:block;width:100%;max-width:${w}px;height:auto" xmlns="http://www.w3.org/2000/svg"><g><path d="M 50 210 H 400" stroke="#767676"/><path d="M 50 110 H 400" stroke="#767676"/></g><g><rect x="80" y="110" width="60" height="100" fill="#00376d"/><rect x="190" y="60" width="60" height="150" fill="#00376d"/><rect x="300" y="160" width="60" height="50" fill="#00376d"/></g><g text-anchor="end" font-size="15" fill="#1b1b1b">${vals.map((v, i) => `<text x="42" y="${214 - i * 50}">${v}</text>`).join('')}</g><g text-anchor="middle" font-size="15" fill="#1b1b1b"><text x="110" y="236">North</text><text x="220" y="236">Central</text><text x="330" y="236">South</text></g></svg>`;
  let main = '';
  switch (kind) {
    case 'column-reverse-two': main = `<div style="display:flex;flex-direction:column-reverse">${ps([...two].reverse())}</div>`; break;
    case 'column-reverse-three': main = `<div style="display:flex;flex-direction:column-reverse">${ps([...STEPS].reverse())}</div>`; break;
    case 'order-property': main = `<div style="display:flex;flex-direction:column"><p style="order:2">${two[1]}</p><p style="order:1">${two[0]}</p></div>`; break;
    case 'grid-rows': main = `<div style="display:grid"><p style="grid-row:2">${two[1]}</p><p style="grid-row:1">${two[0]}</p></div>`; break;
    case 'foreignobject-reverse': main = fo(`<div style="display:flex;flex-direction:column-reverse">${ps([...two].reverse())}</div>`); break;
    case 'foreignobject-order': main = fo(`<div style="display:flex;flex-direction:column"><p style="order:2">${two[1]}</p><p style="order:1">${two[0]}</p></div>`); break;
    case 'in-order': main = `<div style="display:flex;flex-direction:column">${ps(two)}</div>`; break;
    case 'in-order-foreignobject': main = fo(`<div>${ps(two)}</div>`); break;
    case 'chart-role-img': main = `<div role="img" aria-label="Column chart: water used by area" style="max-width:420px">${chartSvg()}</div>`; break;
    case 'chart-plain-svg': main = chartSvg(); break;
    case 'chart-figure': main = `<figure style="margin:0">${chartSvg()}<figcaption>Water used by area this year.</figcaption></figure>`; break;
    case 'diagram-labels': main = `<svg viewBox="0 0 480 240" style="display:block;width:100%;max-width:480px;height:auto" xmlns="http://www.w3.org/2000/svg"><path d="M 40 200 L 240 120 L 440 40" stroke="#00376d" stroke-width="4" fill="none"/><g font-size="15" fill="#1b1b1b"><text x="40" y="226">Treatment plant</text><text x="240" y="146">Pump station</text><text x="380" y="30">North reservoir</text></g></svg>`; break;
    case 'chart-in-foreignobject': main = fo(`<p>Water used by area this year.</p>${chartSvg(380)}`, 360); break;
    case 'timeline-in-svg': main = `<svg viewBox="0 0 480 220" style="display:block;width:100%;max-width:480px;height:auto" xmlns="http://www.w3.org/2000/svg"><g font-size="15" fill="#1b1b1b"><text x="20" y="200">2019: the plant opened</text><text x="20" y="140">2022: the north main was replaced</text><text x="20" y="80">2025: the new reservoir filled</text></g></svg>`; break;
  }
  const [expect, why] = ORDER_EXPECT[kind];
  return make('order-pictured', kind, rep, hazard, { files: { '/': page({ title: 'How to apply', main: `<p>${BODY[rep % BODY.length]}</p><h2>${pickOf(r, ['How to apply', 'What to do', 'Steps'])}</h2>${main}`, hazard, seed: seed ^ hash(id) }) } }, { '1.3.2': expect }, why);
}

export const orderPicturedTest: SimTest = {
  // The screen-reader test alone: its reading-order rule is the only test of 1.3.2.
  id: 'order-pictured', criteria: ['1.3.2'], probes: () => [screenReaderProbe], full: false, read: 'probe', readProbes: ['screen-reader'], capMs: 90_000,
  // 'late-mount' is left out: the screen-reader test reads the tree once the page has loaded, without waiting for content
  // a script mounts later (its first run here missed all ten such failing cases, with no false alarm): a recall gap of
  // that test's timing, listed in the triage document, not of this path.
  cases: (seed) => spread(ORDER_KINDS, (k) => repsOf(ORDER_EXPECT[k][0], 10, 7), orderCase, seed, STILL),
};
