// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, lane images: the names test's two exact 1.1.1 paths (the lead's rulings 1 and 2), read from the names
// probe's own findings (`read: 'probe'`), generated across the atlas's variant space (docs/atlas/images.md, V02, V03,
// V32-V37 and their look-alikes K37-K46) on the markup real platforms write: WordPress, Drupal, Squarespace, school
// and city CMS themes, React and Vue icon components, carousels, accordions.
//
// Source of truth. SC 1.1.1: "All non-text content that is presented to the user has a text alternative that serves
// the equivalent purpose", with "Controls, Input: If non-text content is a control or accepts user input, then it has
// a name that describes its purpose." F65 (no alt or other text alternative on an img), H30 (link text for a linked
// image), H36 (alt on image buttons). F30: "text alternatives that are not alternatives (e.g., filenames or
// placeholder text)".
//
// The answer by construction:
// - picture-control-unnamed: fail when a shown control's only content is pictures with no text alternative (an img
//   with no alt attribute, an svg with no name source or kept from assistive technology, a CSS background or mask
//   picture) and nothing names it; pass when anything names it (aria-label, aria-labelledby, title, text kept for
//   screen readers, visible text, an svg title, an img alt), when it is not shown, or when it holds no picture at all.
//   Not counted here (the AI review's, ruling 1): an img with alt="" as a control's only content, an icon font.
// - picture-alt-own-file: fail when the alternative is the picture's own file name with its extension, or its
//   address (in full or as written), in any letter case, decoded or not; pass for a description, a link to the
//   picture's own file or a download link, a picture kept from assistive technology, alt="". Not counted (the AI
//   review's, ruling 2): a name that only resembles a file name ("fall-festival-flyer"), another file's name.
import { namesProbe } from '../../../src/probes/names.js';
import { applyHazard, filler, hash, parts, render, rng, solidPng } from '../page.js';
import type { Expectation, Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'load-popup'];
const P: Expectation = { verdict: 'pass' };
const F: Expectation = { verdict: 'fail', count: 1 };

const ICON = (w = 20) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>`;
const ICON_HIDDEN = (w = 20) => ICON(w).replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
const SVG_FILE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 3h18v18H3z" fill="#0b4f6c"/></svg>';
const CSS = [
  '.ic { display: inline-block; width: 24px; height: 24px; vertical-align: middle; }',
  '.btn { font: 16px sans-serif; padding: 6px; border: 2px solid #1b1b1b; background: #fff; color: #1b1b1b; } .btn:focus-visible, a:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; }',
  '.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }',
  'img.thumb { width: 160px; height: 100px; }',
  'figure { margin: 16px 0; } .card { border: 1px solid #767676; padding: 12px; margin: 12px 0; max-width: 360px; }',
];

// ---- picture-control-unnamed ----------------------------------------------------------------------------------

export const CONTROL_KINDS = [
  'react-svg-button', 'social-svg-link', 'sprite-use-link', 'wp-thumb-link-no-alt', 'img-button-no-alt', 'css-background-button',
  'css-background-child-link', 'css-mask-button', 'div-role-button-background', 'carousel-arrow-buttons', 'picture-link-no-alt',
  'nested-span-svg-link', 'tab-img-no-alt',
  'named-aria-label', 'named-labelledby', 'named-title', 'sr-only-text', 'visible-text-and-icon', 'svg-title', 'img-alt-in-link',
  'not-shown', 'kept-from-at', 'colour-box-no-picture', 'img-alt-in-button', 'card-link-alt-empty-with-headline', 'icon-font-sr-text',
  'sprite-aria-label', 'background-icon-with-label',
] as const;
type ControlKind = (typeof CONTROL_KINDS)[number];

const CONTROL_EXPECT: Record<ControlKind, [Expectation, string]> = {
  'react-svg-button': [F, 'a React icon component (aria-hidden svg) as a button\'s only content, no name (F65)'],
  'social-svg-link': [F, 'a social link whose only content is an inline svg with no title or name'],
  'sprite-use-link': [F, 'a link whose only content is an svg sprite <use>, no name'],
  'wp-thumb-link-no-alt': [F, 'a WordPress thumbnail link: an img with no alt attribute is the link\'s only content (F65, H30)'],
  'img-button-no-alt': [F, 'a button holding only an img with no alt attribute (H36)'],
  'css-background-button': [F, 'a search toggle drawn as the button\'s own CSS background, no name'],
  'css-background-child-link': [F, 'a calendar link whose only content is a span with a CSS background icon'],
  'css-mask-button': [F, 'a button whose icon is a CSS mask picture, no name'],
  'div-role-button-background': [F, 'a div with role=button holding only a background-image icon'],
  'carousel-arrow-buttons': [{ verdict: 'fail', count: 2 }, 'a carousel\'s previous and next buttons, each only an aria-hidden svg arrow'],
  'picture-link-no-alt': [F, 'a link whose only content is a <picture> whose img has no alt attribute'],
  'nested-span-svg-link': [F, 'a search link: an svg wrapped in two spans is its only content'],
  'tab-img-no-alt': [F, 'a view switcher tab whose only content is an img with no alt attribute'],
  'named-aria-label': [P, 'an icon button named by aria-label'],
  'named-labelledby': [P, 'an icon link named by aria-labelledby to visible text'],
  'named-title': [P, 'an icon link named by its title'],
  'sr-only-text': [P, 'an icon button with text kept for screen readers'],
  'visible-text-and-icon': [P, 'an icon beside visible words in the link'],
  'svg-title': [P, 'an icon button whose svg has a title'],
  'img-alt-in-link': [P, 'a linked picture whose alt names the destination'],
  'not-shown': [P, 'an icon button that is not shown (display:none): not presented'],
  'kept-from-at': [P, 'an icon link inside aria-hidden, out of the tab order (a carousel clone): not presented to assistive technology'],
  'colour-box-no-picture': [P, 'a link drawn as a coloured box: no non-text content (its missing name is 2.4.4 and 4.1.2)'],
  'img-alt-in-button': [P, 'a button holding an img whose alt says what it does'],
  'card-link-alt-empty-with-headline': [P, 'a card link: a decorative img (alt="") and the headline text'],
  'icon-font-sr-text': [P, 'an icon font glyph beside text kept for screen readers'],
  'sprite-aria-label': [P, 'an svg sprite icon in a button named by aria-label'],
  'background-icon-with-label': [P, 'a background-image icon beside the visible word "Calendar"'],
};

function controlMarkup(kind: ControlKind, files: Record<string, string | Uint8Array>): string {
  const png = (path: string) => { files[path] = solidPng(24, 24, [11, 79, 108]); return path; };
  const svgFile = (path: string) => { files[path] = SVG_FILE; return path; };
  switch (kind) {
    case 'react-svg-button': return `<div class="toolbar"><button type="button" class="btn icon-button">${ICON_HIDDEN()}</button></div>`;
    case 'social-svg-link': return `<ul class="wp-block-social-links"><li class="wp-social-link"><a href="https://social.example/district" class="wp-block-social-link-anchor"><svg width="24" height="24" viewBox="0 0 24 24" version="1.1"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/></svg></a></li></ul>`;
    case 'sprite-use-link': return `<svg style="display:none" xmlns="http://www.w3.org/2000/svg"><symbol id="i-video" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></symbol></svg><a href="https://video.example/channel" class="social"><svg class="ic"><use href="#i-video"/></svg></a>`;
    case 'wp-thumb-link-no-alt': return `<article class="post"><a href="/news/levy-results" class="post-thumbnail"><img class="thumb" src="${png('/wp-content/uploads/2026/11/levy-results-300x200.png')}"></a><p>Posted November 4.</p></article>`;
    case 'img-button-no-alt': return `<form action="/search"><label for="q">Search</label> <input id="q" name="q" type="search"> <button type="submit" class="btn"><img class="ic" src="${png('/themes/district/images/go.png')}"></button></form>`;
    case 'css-background-button': return `<button type="button" class="btn ic search-toggle" style="background:#fff url(${svgFile('/sites/all/themes/city/img/search.svg')}) center / 18px no-repeat"></button>`;
    case 'css-background-child-link': return `<a href="/calendar" class="quick-link"><span class="ic" style="background-image:url(${png('/static/icons/calendar.png')});background-size:contain"></span></a>`;
    case 'css-mask-button': return `<button type="button" class="btn ic" style="background:#0b4f6c;-webkit-mask:url(${svgFile('/assets/icons/menu.svg')}) center / contain no-repeat;mask:url(/assets/icons/menu.svg) center / contain no-repeat"></button>`;
    case 'div-role-button-background': return `<div class="nav-toggle" role="button" tabindex="0"><span class="ic" style="background:url(${png('/fs/resource-manager/view/menu.png')}) center / contain no-repeat"></span></div>`;
    case 'carousel-arrow-buttons': return `<div class="slider"><div class="slide"><p>Fall sports sign-ups are open.</p></div><button class="slick-prev btn" type="button">${ICON_HIDDEN(16)}</button><button class="slick-next btn" type="button">${ICON_HIDDEN(16)}</button></div>`;
    case 'picture-link-no-alt': return `<a href="/gallery/harvest"><picture><source srcset="${png('/media/harvest.webp')}" type="image/webp"><img class="thumb" src="${png('/media/harvest.png')}"></picture></a>`;
    case 'nested-span-svg-link': return `<a href="/search" class="header-search"><span class="icon"><span class="icon__inner">${ICON_HIDDEN()}</span></span></a>`;
    case 'tab-img-no-alt': return `<div role="tablist" aria-label="View"><button role="tab" aria-selected="true" class="btn"><img class="ic" src="${png('/apps/calendar/grid.png')}"></button><button role="tab" aria-selected="false" class="btn">List</button></div>`;
    case 'named-aria-label': return `<button type="button" class="btn" aria-label="Search the site">${ICON_HIDDEN()}</button>`;
    case 'named-labelledby': return `<span id="cal-label">Events calendar</span> <a href="/calendar" aria-labelledby="cal-label">${ICON()}</a>`;
    case 'named-title': return `<a href="/print" title="Print this page"><img class="ic" src="${png('/icons/print.png')}"></a>`;
    case 'sr-only-text': return `<button type="button" class="btn">${ICON_HIDDEN()}<span class="vh">Open the menu</span></button>`;
    case 'visible-text-and-icon': return `<a href="/contact">${ICON_HIDDEN(16)} Contact us</a>`;
    case 'svg-title': return `<button type="button" class="btn"><svg width="20" height="20" viewBox="0 0 24 24" role="img"><title>Close the alert</title><path d="M4 4l16 16M20 4L4 20" stroke="#000"/></svg></button>`;
    case 'img-alt-in-link': return `<a href="/news/levy-results"><img class="thumb" src="${png('/wp-content/uploads/levy.png')}" alt="Levy results: read the story"></a>`;
    case 'not-shown': return `<button type="button" class="btn" style="display:none">${ICON()}</button><p>Menu</p>`;
    case 'kept-from-at': return `<div class="slick-cloned" aria-hidden="true"><a href="/slide/2" tabindex="-1">${ICON()}</a></div>`;
    case 'colour-box-no-picture': return `<p><a href="/documents" style="display:inline-block;width:32px;height:32px;background:#0b4fb3"></a></p>`;
    case 'img-alt-in-button': return `<button type="submit" class="btn"><img class="ic" src="${png('/img/search.png')}" alt="Search"></button>`;
    case 'card-link-alt-empty-with-headline': return `<div class="card"><a href="/news/board"><img class="thumb" src="${png('/img/board.png')}" alt=""><h3>Board meets Thursday</h3></a></div>`;
    case 'icon-font-sr-text': return `<style>.fa-phone::before{content:"\\260E"}</style><a href="tel:5415550100"><i class="fa-phone" aria-hidden="true"></i><span class="vh">Call the office</span></a>`;
    case 'sprite-aria-label': return `<svg style="display:none" xmlns="http://www.w3.org/2000/svg"><symbol id="i-x" viewBox="0 0 24 24"><path d="M4 4l16 16"/></symbol></svg><button type="button" class="btn" aria-label="Dismiss"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>`;
    case 'background-icon-with-label': return `<a href="/calendar"><span class="ic" style="background:url(${png('/static/icons/cal.png')}) center / contain no-repeat"></span> Calendar</a>`;
  }
}

export function controlCase(kind: ControlKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `picture-control-unnamed/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const files: Record<string, string | Uint8Array> = {};
  const subject = controlMarkup(kind, files);
  const pg = parts('Community news', `${filler(r, 1)}<div id="subject">${subject}</div>${filler(r, 1)}`, [...CSS]);
  Object.assign(pg.files, files);
  applyHazard(pg, hazard, r);
  const [e, why] = CONTROL_EXPECT[kind];
  return { id, test: 'picture-control-unnamed', hazard, params: { kind }, site: render(pg), expect: { '1.1.1': e }, why };
}

export function controlCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of CONTROL_KINDS) for (let rep = 0; rep < 5; rep++) out.push(controlCase(kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

// ---- picture-alt-own-file -------------------------------------------------------------------------------------

export const OWN_FILE_KINDS = [
  'wp-upload-basename', 'drupal-style-with-query', 'encoded-space', 'letter-case', 'full-address', 'address-as-written', 'image-button',
  'linked-thumbnail', 'aria-label-file-name', 'cdn-path-with-format', 'svg-map-file',
  'description', 'link-to-own-file', 'download-link', 'kept-from-at', 'presentation-role', 'decorative-empty', 'heading-words', 'description-in-own-file-link',
] as const;
type OwnFileKind = (typeof OWN_FILE_KINDS)[number];

const OWN_FILE_EXPECT: Record<OwnFileKind, [Expectation, string]> = {
  'wp-upload-basename': [F, 'a WordPress upload whose alt is its file name, extension included (F30)'],
  'drupal-style-with-query': [F, 'a Drupal image style (address with ?itok=) whose alt is the file name'],
  'encoded-space': [F, 'a file name with spaces (%20 in the address) given as the alt, decoded'],
  'letter-case': [F, 'the file name as the alt in another letter case'],
  'full-address': [F, 'the picture\'s full address as its alt'],
  'address-as-written': [F, 'the picture\'s address as written in src, as its alt'],
  'image-button': [F, 'an image button whose alt is its own file name'],
  'linked-thumbnail': [F, 'a news thumbnail link whose picture\'s alt is its file name'],
  'aria-label-file-name': [F, 'an aria-label that is the picture\'s file name (it is the name screen readers read)'],
  'cdn-path-with-format': [F, 'a hosted-builder address with a format query, the file name as alt'],
  'svg-map-file': [F, 'an SVG map whose alt is its file name (training PC-154\'s shape)'],
  description: [P, 'an alt that describes the picture, on a file named like it'],
  'link-to-own-file': [P, 'a link to the picture\'s own file: its name is the link\'s destination'],
  'download-link': [P, 'a download link: the file is named on purpose'],
  'kept-from-at': [P, 'a picture kept from assistive technology (aria-hidden)'],
  'presentation-role': [P, 'a picture with role="presentation": not exposed'],
  'decorative-empty': [P, 'a decorative divider with alt=""'],
  'heading-words': [P, 'an alt with the words of the file name and no extension, written as words'],
  'description-in-own-file-link': [P, 'a description in a link to the picture\'s own full-size file'],
};

function ownFileMarkup(kind: OwnFileKind, files: Record<string, string | Uint8Array>, r: () => number): string {
  const put = (path: string) => { files[path.split('?')[0]!] = path.endsWith('.svg') ? SVG_FILE : solidPng(32, 20, [60 + Math.floor(r() * 60), 90, 120]); return path; };
  switch (kind) {
    case 'wp-upload-basename': return `<figure class="wp-block-image size-large"><img class="thumb" src="${put('/wp-content/uploads/2026/10/fall-festival-flyer.jpg')}" alt="fall-festival-flyer.jpg"></figure>`;
    case 'drupal-style-with-query': return `<div class="field field--name-field-image"><img class="thumb" src="${put('/sites/default/files/styles/large/public/2026-11/detour-map.png')}?itok=Qx9aZ" alt="detour-map.png"></div>`;
    case 'encoded-space': return `<p><img class="thumb" src="${put('/files/Board%20Meeting%20Notice.png')}" alt="Board Meeting Notice.png"></p>`;
    case 'letter-case': return `<p><img class="thumb" src="${put('/images/Pool-Hours.PNG')}" alt="pool-hours.png"></p>`;
    // The full address depends on the lab server's port: the page's own script writes it, as a CMS template would.
    case 'full-address': return `<p><img class="thumb own-address" src="${put('/uploads/library-hours.webp')}" alt="library hours"></p>`;
    case 'address-as-written': return `<p><img class="thumb" src="${put('/assets/img/gate-map.svg')}" alt="/assets/img/gate-map.svg"></p>`;
    case 'image-button': return `<form action="/search"><label for="q">Search</label> <input id="q" name="q" type="search"> <input type="image" class="ic" src="${put('/buttons/go-search.gif')}" alt="go-search.gif"></form>`;
    case 'linked-thumbnail': return `<div class="card"><a href="/news/levy"><img class="thumb" src="${put('/uploads/levy-thumb.webp')}" alt="levy-thumb.webp"></a><p>Levy results are in.</p></div>`;
    case 'aria-label-file-name': return `<p><img class="thumb" src="${put('/media/new-library-photo.jpg')}" alt="The new library" aria-label="new-library-photo.jpg"></p>`;
    case 'cdn-path-with-format': return `<div class="sqs-block image-block"><img class="thumb" src="${put('/content/v1/5f2a/lunch-menu.jpg')}?format=1500w" alt="lunch-menu.jpg"></div>`;
    case 'svg-map-file': return `<figure><img class="thumb" src="${put('/assets/arrival-gate-map.svg')}" alt="arrival-gate-map.svg"><figcaption>Arrival</figcaption></figure>`;
    case 'description': return `<figure class="wp-block-image"><img class="thumb" src="${put('/wp-content/uploads/2026/10/fall-festival-flyer.jpg')}" alt="Fall festival: Saturday, October 18, 10 a.m. to 2 p.m., in the school field"></figure>`;
    case 'link-to-own-file': { const p = put('/files/flyer.jpg'); return `<p><a href="${p}"><img class="thumb" src="${p}" alt="flyer.jpg"></a></p>`; }
    case 'download-link': return `<p><a href="/downloads/poster" download><img class="thumb" src="${put('/assets/poster.png')}" alt="poster.png"></a></p>`;
    case 'kept-from-at': return `<p><img class="thumb" src="${put('/assets/leaf.png')}" alt="leaf.png" aria-hidden="true"> Spring clean-up starts Monday.</p>`;
    case 'presentation-role': return `<p><img class="thumb" src="${put('/assets/rule.png')}" alt="rule.png" role="presentation"></p>`;
    case 'decorative-empty': return `<p><img class="thumb" src="${put('/assets/divider.png')}" alt=""></p>`;
    case 'heading-words': return `<p><img class="thumb" src="${put('/assets/spring-cleanup.jpg')}" alt="Spring cleanup"></p>`;
    case 'description-in-own-file-link': { const p = put('/files/council-photo.jpg'); return `<p><a href="${p}"><img class="thumb" src="${p}" alt="Council members at the ribbon cutting, full size"></a></p>`; }
  }
}

export function ownFileCase(kind: OwnFileKind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `picture-alt-own-file/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const files: Record<string, string | Uint8Array> = {};
  const subject = ownFileMarkup(kind, files, r);
  const pg = parts('Community news', `${filler(r, 1)}<div id="subject">${subject}</div>${filler(r, 1)}`, [...CSS]);
  if (kind === 'full-address') pg.init.push("document.querySelectorAll('img.own-address').forEach(function (i) { i.alt = i.src; });");
  Object.assign(pg.files, files);
  applyHazard(pg, hazard, r);
  const [e, why] = OWN_FILE_EXPECT[kind];
  return { id, test: 'picture-alt-own-file', hazard, params: { kind }, site: render(pg), expect: { '1.1.1': e }, why };
}

export function ownFileCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of OWN_FILE_KINDS) {
    const reps = OWN_FILE_EXPECT[kind][0].verdict === 'fail' ? 6 : 8;
    for (let rep = 0; rep < reps; rep++) out.push(ownFileCase(kind, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  return out;
}

const common = { probes: () => [namesProbe], full: false, read: 'probe' as const, readProbes: ['names'], capMs: 60_000 };
export const pictureControlTest: SimTest = { id: 'picture-control-unnamed', criteria: ['1.1.1'], ...common, cases: controlCases };
export const pictureOwnFileTest: SimTest = { id: 'picture-alt-own-file', criteria: ['1.1.1'], ...common, cases: ownFileCases };
